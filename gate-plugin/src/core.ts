/**
 * gate-plugin/src/core.ts — standalone completion-gate plugin core
 * (design: docs/2026-07-25-daily-evolution-loop.md §4.1; engine-free).
 * Round semantics reused from minimal/complete-gate.ts. v1: mutants=0.
 * Marker default OFF (C2 verdict, HISTORY.md; overrides hygiene doc §4).
 */
import { runCompletionGate, type GateIO } from "../../minimal/complete-gate.ts"
import { HYGIENE_MARKER } from "../../minimal/session2.ts"

export interface GateConfig {
  check: string
  rounds: number
  marker: boolean
  sensor: string
}

export function parseGateConfig(raw: string): GateConfig | undefined {
  try {
    const j = JSON.parse(raw)
    if (typeof j.check !== "string" || !j.check) return undefined
    return {
      check: j.check,
      rounds: typeof j.rounds === "number" ? j.rounds : 2,
      marker: j.marker === true,
      sensor: typeof j.sensor === "string" ? j.sensor : ".km/gate-outcomes.ndjson",
    }
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// makeGateHooks — the full hook factory, pure and dependency-injected.
// ---------------------------------------------------------------------------

export interface GateDeps {
  readGateConfig(): string | undefined // gate.json content or undefined
  runCheck(cmd: string): Promise<{ code: number; out: string }>
  promptSession(sessionID: string, text: string): Promise<boolean>
  toast(message: string, variant: "info" | "success" | "warning" | "error"): Promise<void>
  appendSensor(relPath: string, line: string): void
  now(): number
  /** True for engine-spawned [meta-harness] child sessions (proposer/promote/
   * curate) — these get gated for free otherwise (cost, off-mission reinjects,
   * bogus sensor lines). Fail-open (false) on lookup error: better to gate a
   * child than skip a real session. */
  isExcludedSession(sessionID: string): Promise<boolean>
}

const EDIT_TOOLS = new Set(["write", "edit", "patch", "multiedit"])
const OUT_TAIL = 600

export function makeGateHooks(deps: GateDeps): {
  toolExecuteAfter(tool: string, sessionID: string): void
  chatMessage(sessionID: string): void
  sessionIdle(sessionID: string): Promise<void>
} {
  const edited = new Set<string>() // sessions with un-gated edits
  const gating = new Set<string>() // gate loop currently running
  const interrupted = new Set<string>() // human typed while gating
  // Sessions with a self-inject echo pending: promptSession (client.session.
  // prompt) causes opencode to fire chat.message for the prompt WE just sent,
  // so the gate's own chatMessage would otherwise see that echo as a human
  // interrupt (setting interrupted mid-gate on every reinject/marker). Add
  // the sessionID here immediately before each promptSession call; chatMessage
  // consumes (deletes) exactly one entry per echo and treats that as a no-op —
  // any FURTHER chatMessage call (a real human, not preceded by our own
  // promptSession call) falls through to the normal interrupt logic.
  const selfPrompt = new Set<string>()

  return {
    toolExecuteAfter(tool: string, sessionID: string): void {
      // Edits made by the reinjected agent during gating DO mark `edited`
      // here (no gating guard) — but the unconditional `edited.delete`
      // below at gate completion wipes them again, so a mid-gate edit can
      // never by itself trigger a second gate run (contract 11). That
      // unconditional delete is the actual no-infinite-re-gate mechanism.
      if (EDIT_TOOLS.has(tool)) edited.add(sessionID)
    },
    chatMessage(sessionID: string): void {
      if (selfPrompt.delete(sessionID)) return // our own reinject/marker echo — not a human interrupt
      if (gating.has(sessionID)) interrupted.add(sessionID) // contract 10
    },
    async sessionIdle(sessionID: string): Promise<void> {
      if (gating.has(sessionID)) return
      if (!edited.has(sessionID)) return
      // Claim the re-entrancy guard SYNCHRONOUSLY, before any `await` — the
      // isExcludedSession check below is the first await point in this
      // function; if `gating.add` happened after it, two concurrent
      // sessionIdle("s1") calls could both observe `gating.has(s1) === false`
      // and both pass the guard (the original bug this ordering prevents).
      gating.add(sessionID)
      try {
        if (await deps.isExcludedSession(sessionID)) {
          // [meta-harness] engine-spawned child session — never gate these.
          edited.delete(sessionID)
          return
        }
        const raw = deps.readGateConfig()
        if (!raw) return
        const cfg = parseGateConfig(raw)
        if (!cfg) return
        interrupted.delete(sessionID)
        const t0 = deps.now()
        const io: GateIO = {
          verifyExists: () => true,
          runVerify: async () => deps.runCheck(cfg.check),
          readArtifact: () => "", // v1: no mutation probe
          writeArtifact: () => false,
          restoreArtifact: () => true,
          syntaxOk: () => true,
          reinject: async (message: string) => {
            if (interrupted.has(sessionID)) return false
            await deps.toast(`gate: check failed — reinjecting evidence`, "warning")
            // Defensive cap on the reinject prompt size: complete-gate already
            // tails failing verify output to OUT_TAIL (600) chars, but the
            // surrounding explanatory text is unbounded, so cap the whole
            // message (4000 chars of context + the 600-char tail budget) to
            // keep a single reinject prompt from ballooning the session.
            selfPrompt.add(sessionID)
            return deps.promptSession(sessionID, message.slice(0, 4000 + OUT_TAIL))
          },
        }
        const result = await runCompletionGate(io, { rounds: cfg.rounds, mutants: 0 })
        deps.appendSensor(
          cfg.sensor,
          JSON.stringify({
            ts: deps.now(),
            sessionID,
            check: cfg.check,
            accepted: result.accepted,
            gateExhausted: result.gateExhausted,
            rounds: result.rounds.map((r) => r.outcome),
            interrupted: interrupted.has(sessionID),
            marker: cfg.marker,
            durationMs: deps.now() - t0,
          }),
        )
        if (result.gateExhausted) await deps.toast(`gate: rounds exhausted — accepting anyway`, "warning")
        else await deps.toast(`gate: check passed`, "success")
        if (cfg.marker && result.accepted && !result.gateExhausted) {
          selfPrompt.add(sessionID)
          await deps.promptSession(sessionID, HYGIENE_MARKER)
        }
        // Unconditional: clears both the pre-gate edit that armed this run
        // AND any edits the reinjected agent made mid-gate (toolExecuteAfter
        // no longer special-cases `gating`). This IS the no-infinite-re-gate
        // mechanism — see the comment on toolExecuteAfter above.
        edited.delete(sessionID)
      } finally {
        gating.delete(sessionID)
        interrupted.delete(sessionID)
        // Defensive: if a promptSession call's echo never arrived (error, or
        // a host that doesn't echo), don't let a stale entry silently
        // swallow the NEXT unrelated human chatMessage as a self-echo.
        selfPrompt.delete(sessionID)
      }
    },
  }
}
