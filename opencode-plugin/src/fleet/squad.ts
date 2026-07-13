/**
 * squad.ts — the deterministic squad runner (spec §2, §3): fixed A→D→I→E
 * state machine; flow knobs from SquadDef; every backward edge bounded;
 * exits done | gate | escalation only. Pure core: drive/score injected;
 * every step is `structuredClone`d off the input state (squadStep never
 * mutates its argument — pure transitions per rule 13).
 *
 * DriveFn key note: `drive(key, input, sliceId)` is called with the PHASE
 * itself ("analyzer" | "evaluator-spec" | "designer" | "implementer" |
 * "evaluator-verdict"), not the collapsed wire SLOT ("analyzer" | "designer"
 * | "implementer" | "evaluator"). The two evaluator-invoking phases share
 * one wire slot ("evaluator") for `lintPayload`/R1-counter purposes
 * (`wireSlotFor` below), but are driven as two distinct keys — this matches
 * the task-7 test fixture's `OK`/`scripted` maps (test/fleet-helpers.ts),
 * which are keyed by phase, not slot. The real CLI-layer DriveFn (Task 8) is
 * responsible for mapping a phase key back to the actual `mh-evaluator`
 * role/persona before calling `roleSpec`.
 */
import { detectEscalation, lintPayload, parseVerdict, type SquadDef } from "./squad-def.ts"

export type Phase =
  | "analyzer" | "gate1" | "evaluator-spec" | "designer" | "gate2"
  | "implementer" | "evaluator-verdict" | "done"

export interface SquadCounters {
  r1: Record<string, number>
  r2: number
  r3: number
  steps: number
}

export interface SquadState {
  sliceId: string
  slice: string
  phase: Phase
  artifacts: { spec?: string; testSpec?: string; alternatives?: string; design?: string; implReport?: string }
  counters: SquadCounters
  pendingGate?: { gate: "gate1" | "gate2"; payload: string }
  history: Array<{ phase: Phase; event: string; id?: string }>
  /** id of the most recent drive whose artifact is awaiting gate adjudication
   * or verdict scoring (analyzer's id while spec sits at gate1, designer's id
   * while alternatives sit at gate2, implementer's id while a report sits at
   * evaluator-verdict). Consumed by autoGate/answerGate (gate scoring) and
   * the PASS/FAIL-impl verdict branches (implementer scoring). */
  lastDriveId?: string
}

export type SquadOutcome =
  | { status: "done"; payload: string }
  | { status: "gate"; gate: "gate1" | "gate2"; payload: string }
  | { status: "escalation"; escalation: { type: string; body: string } }
  | { status: "running" } // internal — runSquad loops until non-running

export interface DriveResult { id: string; payload: string }
export type DriveFn = (slot: string, input: string, sliceId: string) => Promise<DriveResult>
export type ScoreFn = (id: string, verdict: "good" | "bad", gate: string) => Promise<void>

export function newSquadState(sliceId: string, slice: string): SquadState {
  return {
    sliceId,
    slice,
    phase: "analyzer",
    artifacts: {},
    counters: { r1: {}, r2: 0, r3: 0, steps: 0 },
    history: [],
  }
}

/** Pure input builder — never mutates state, never called for gate phases
 * (gates adjudicate; they don't drive). */
function inputFor(phase: Phase, state: SquadState, def: SquadDef): string {
  switch (phase) {
    case "analyzer":
      return `SLICE:\n${state.slice}`
    case "evaluator-spec":
      return `Author a test spec from this functional spec (never from code):\n${state.artifacts.spec}`
    case "designer":
      return `Functional spec:\n${state.artifacts.spec}\nEmit ## Alternatives and ## Recommended.`
    case "implementer":
      return `Decided design:\n${state.artifacts.design}\nImplement; emit ## Implementation Report.`
    case "evaluator-verdict":
      return `Test spec:\n${state.artifacts.testSpec}\nImplementation report:\n${state.artifacts.implReport}\nRun checks; emit VERDICT line.`
    default:
      return ""
  }
}

/** Collapsed wire slot each driving phase rolls up to for R1 redo-counter
 * purposes — evaluator-spec and evaluator-verdict share the "evaluator"
 * slot's counter even though (task-9 fix) they no longer share its LINT
 * key: squadStep looks up `def.wire.headings[phase]` first (the
 * phase-specific "evaluator-spec"/"evaluator-verdict" overrides) and only
 * falls back to this collapsed slot if the def doesn't teach one. `def.wire.
 * headings`'s role-level "evaluator" entry is the render-lint contract (see
 * squad-def.ts). gate1/gate2/done never reach this function (see
 * squadStep). */
function wireSlotFor(phase: Phase): string {
  switch (phase) {
    case "analyzer": return "analyzer"
    case "evaluator-spec": return "evaluator"
    case "designer": return "designer"
    case "implementer": return "implementer"
    case "evaluator-verdict": return "evaluator"
    default: return phase
  }
}

/** Builds an Exhausted escalation outcome; appends the terminal marker to
 * `state.history` (mutated in place — callers always pass a step-local
 * `structuredClone`) so the failure report reflects the whole run, per
 * "Exhausted escalations carry a failure report built from state.history". */
function esc(s: SquadState, reason: string): SquadOutcome {
  s.history.push({ phase: s.phase, event: `exhausted: ${reason}` })
  const lines = s.history.map((h) => `- [${h.phase}] ${h.event}${h.id ? ` (${h.id})` : ""}`).join("\n")
  const body = ["## Exhausted", reason, "", "### History", lines || "(no drives recorded)"].join("\n")
  return { status: "escalation", escalation: { type: "Exhausted", body } }
}

/** Gate 2 output: decided design.md = the chosen alternative (the
 * `## Recommended` section onward) plus the full alternatives doc as
 * context, per spec §1.5 wire note. */
function materializeDesign(alternatives: string): string {
  const idx = alternatives.indexOf("## Recommended")
  const recommended = idx >= 0 ? alternatives.slice(idx).trim() : alternatives.trim()
  return `${recommended}\n\n---\n## Alternatives Considered\n${alternatives.trim()}`
}

/** Auto gate1/gate2 adjudication: scores the producing drive (`lastDriveId`)
 * good under the gate's own name, advances exactly like a human `"approve"`
 * (see `answerGate`). Sequential v1 flow: gate1 → evaluator-spec (NOT
 * designer directly) → designer → gate2 → implementer. */
async function autoGate(s: SquadState, score: ScoreFn): Promise<{ state: SquadState; outcome: SquadOutcome }> {
  const gate = s.phase as "gate1" | "gate2"
  const id = s.lastDriveId!
  await score(id, "good", gate)
  s.history.push({ phase: gate, event: "auto-approve", id })
  if (gate === "gate1") {
    s.phase = "evaluator-spec"
  } else {
    s.artifacts.design = materializeDesign(s.artifacts.alternatives!)
    s.phase = "implementer"
  }
  return { state: s, outcome: { status: "running" } }
}

export async function squadStep(
  state: SquadState,
  def: SquadDef,
  drive: DriveFn,
  score: ScoreFn,
): Promise<{ state: SquadState; outcome: SquadOutcome }> {
  const s: SquadState = structuredClone(state)
  s.counters.steps++
  if (s.counters.steps > def.flow.bounds.globalBudgetSteps) {
    return { state: s, outcome: esc(s, `global budget (${def.flow.bounds.globalBudgetSteps} steps) exceeded`) }
  }

  // Gate phases don't drive — they adjudicate.
  if (s.phase === "gate1" || s.phase === "gate2") {
    const policy = s.phase === "gate1" ? def.flow.gatePolicy.gate1 : def.flow.gatePolicy.gate2
    if (policy === "human") {
      const payload = s.phase === "gate1" ? s.artifacts.spec! : s.artifacts.alternatives!
      s.pendingGate = { gate: s.phase, payload }
      return { state: s, outcome: { status: "gate", gate: s.phase, payload } }
    }
    return autoGate(s, score)
  }

  const wireSlot = wireSlotFor(s.phase)
  // Lint key: phase-specific override if the squad def teaches one (task-9
  // live-smoke fix — evaluator-spec/evaluator-verdict have different wire
  // contracts and must not lint-pass via each other's OR-group), else the
  // collapsed slot. R1 counters stay keyed by the collapsed slot below —
  // only the lint LOOKUP is phase-aware.
  const lintKey = def.wire.headings[s.phase] ? s.phase : wireSlot
  const { id, payload } = await drive(s.phase, inputFor(s.phase, s, def), s.sliceId)

  // detectEscalation FIRST — Refused/Infeasible/Exhausted/Clarify/
  // DesignDecision all bubble immediately; Refused in particular must NEVER
  // reach score() (spec §3.3.1 — constitutionally unscoreable).
  const escalation = detectEscalation(payload)
  if (escalation) {
    s.history.push({ phase: s.phase, event: `escalation: ${escalation.type}`, id })
    return { state: s, outcome: { status: "escalation", escalation } }
  }

  const lint = lintPayload(def, lintKey, payload)
  if (!lint.ok) {
    await score(id, "bad", "lint")
    s.history.push({ phase: s.phase, event: "lint-fail", id })
    const r1 = (s.counters.r1[wireSlot] = (s.counters.r1[wireSlot] ?? 0) + 1)
    if (r1 > def.flow.bounds.R1) {
      return { state: s, outcome: esc(s, `R1 exhausted at ${wireSlot} (missing: ${lint.missing.join(" | ")})`) }
    }
    return { state: s, outcome: { status: "running" } } // same phase re-drives next step
  }

  s.history.push({ phase: s.phase, event: "lint-ok", id })

  // Phase-specific advance (the D5 table, spec §6):
  switch (s.phase) {
    case "analyzer":
      s.artifacts.spec = payload
      s.lastDriveId = id
      s.phase = "gate1"
      return { state: s, outcome: { status: "running" } }

    case "evaluator-spec":
      s.artifacts.testSpec = payload
      await score(id, "good", "lint") // v1: well-formedness grade (spec §6 evaluator v1)
      s.phase = "designer"
      return { state: s, outcome: { status: "running" } }

    case "designer":
      s.artifacts.alternatives = payload
      s.lastDriveId = id
      s.phase = "gate2"
      return { state: s, outcome: { status: "running" } }

    case "implementer":
      s.artifacts.implReport = payload
      s.lastDriveId = id
      s.phase = "evaluator-verdict"
      return { state: s, outcome: { status: "running" } }

    case "evaluator-verdict": {
      const v = parseVerdict(def, payload)
      if (!v) {
        // Unparseable verdict payload: treat as an evaluator lint-fail (same
        // R1 counter as evaluator-spec — both share the "evaluator" slot).
        await score(id, "bad", "lint")
        const r1 = (s.counters.r1["evaluator"] = (s.counters.r1["evaluator"] ?? 0) + 1)
        if (r1 > def.flow.bounds.R1) {
          return { state: s, outcome: esc(s, "R1 exhausted at evaluator (unparseable verdict)") }
        }
        return { state: s, outcome: { status: "running" } }
      }
      if (v.verdict === "PASS") {
        await score(id, "good", "lint")
        await score(s.lastDriveId!, "good", "verdict") // implementer good
        s.phase = "done"
        return { state: s, outcome: { status: "done", payload: s.artifacts.implReport! } }
      }
      // FAIL — evaluator itself still graded good on well-formedness.
      await score(id, "good", "lint")
      if (v.cause === "impl") {
        await score(s.lastDriveId!, "bad", "verdict")
        s.counters.r3++
        if (s.counters.r3 > def.flow.bounds.R3) return { state: s, outcome: esc(s, "R3 exhausted") }
        s.phase = "implementer"
      } else if (v.cause === "design") {
        // implementer absolved — no score call.
        s.counters.r2++
        if (s.counters.r2 > def.flow.bounds.R2) return { state: s, outcome: esc(s, "R2 exhausted (design)") }
        s.phase = "designer"
      } else {
        // intent — invalidate the test spec; evaluator-spec must re-run
        // after the next gate1 pass (the sequential flow does this
        // naturally: analyzer → gate1 → evaluator-spec).
        s.counters.r2++
        if (s.counters.r2 > def.flow.bounds.R2) return { state: s, outcome: esc(s, "R2 exhausted (intent)") }
        s.artifacts.testSpec = undefined
        s.phase = "analyzer"
      }
      return { state: s, outcome: { status: "running" } }
    }
  }

  return { state: s, outcome: { status: "running" } } // unreachable: phase === "done"
}

export async function runSquad(
  state: SquadState,
  def: SquadDef,
  drive: DriveFn,
  score: ScoreFn,
): Promise<{ state: SquadState; outcome: SquadOutcome }> {
  let cur: { state: SquadState; outcome: SquadOutcome } = { state, outcome: { status: "running" } }
  while (cur.outcome.status === "running") {
    cur = await squadStep(cur.state, def, drive, score)
  }
  return cur
}

export function answerGate(state: SquadState, answer: "approve" | "revise" | string): SquadState {
  const s: SquadState = structuredClone(state)
  if (!s.pendingGate) throw new Error("answerGate: no pending gate on this state")
  const gate = s.pendingGate.gate
  s.pendingGate = undefined
  s.history.push({ phase: gate, event: `human-${answer === "revise" ? "revise" : "approve"}`, id: s.lastDriveId })
  if (answer === "revise") {
    // Human revise re-enters the producer phase WITHOUT touching machine
    // counters (spec §3.7-5 — a human gate's own counter is just "not
    // counted"). Gate scoring (bad, this gate's name) on the revise happens
    // in the CLI layer (Task 8), which owns the ScoreFn binding — this pure
    // function has no ScoreFn parameter at all.
    s.phase = gate === "gate1" ? "analyzer" : "designer"
  } else {
    s.phase = gate === "gate1" ? "evaluator-spec" : "implementer"
    if (gate === "gate2") s.artifacts.design = materializeDesign(s.artifacts.alternatives!)
  }
  return s
}
