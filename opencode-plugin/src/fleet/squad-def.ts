/**
 * squad-def.ts — the squad's ONE evolvable artifact (spec §1.5, §6):
 * slot bindings + flow knobs + wire protocol, versioned like a layer
 * (candidates/vN + active pointer) under the account root.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accountMetaRoot, accountRoleRoot } from "../harness-store.ts"
import { die, writeJsonAtomic, writeTextAtomic } from "../bench/util.ts"

export type SlotBinding =
  | { kind: "agent"; role: string; platform: "opencode" | "claude-code"; model: string }
  | { kind: "squad"; type: string }

export interface SquadFlow {
  bounds: { R1: number; R2: number; R3: number; globalBudgetSteps: number }
  gatePolicy: { gate1: "human" | "auto"; gate2: "human" | "auto" }
  reentry: "delta" | "full"
}

export interface SquadDef {
  type: string
  slots: Record<"analyzer" | "designer" | "implementer" | "evaluator", SlotBinding>
  flow: SquadFlow
  wire: { headings: Record<string, string[][]>; verdictRe: string }
}

export const STANDARD_SQUAD: SquadDef = {
  type: "standard",
  slots: {
    analyzer:    { kind: "agent", role: "analyzer",    platform: "opencode", model: "anthropic/claude-haiku-4-5" },
    designer:    { kind: "agent", role: "designer",    platform: "opencode", model: "anthropic/claude-sonnet-4-6" },
    implementer: { kind: "agent", role: "implementer", platform: "opencode", model: "anthropic/claude-sonnet-4-6" },
    evaluator:   { kind: "agent", role: "evaluator",   platform: "opencode", model: "anthropic/claude-haiku-4-5" },
  },
  flow: {
    bounds: { R1: 2, R2: 1, R3: 3, globalBudgetSteps: 40 },
    gatePolicy: { gate1: "auto", gate2: "auto" },
    reentry: "delta",
  },
  wire: {
    headings: {
      analyzer:    [["## Use Cases", "## Functional Spec"], ["## Clarify"]],
      designer:    [["## Alternatives", "## Recommended"]],
      implementer: [["## Implementation Report"]],
      // Role-level contract (used by render.ts's persona-body lint, which
      // lints the whole persona by ROLE and must stay satisfied whichever
      // mode the body teaches): either mode's heading is acceptable.
      evaluator:   [["## Test Spec"], ["VERDICT:"]],
      // Phase-specific overrides (squad.ts's live-drive lint, task-9 fix):
      // the evaluator plays two MODES with different contracts — a
      // verdict-mode payload that re-emits a test spec (no VERDICT line)
      // must NOT lint-pass by satisfying the OTHER mode's OR-group.
      "evaluator-spec":    [["## Test Spec"]],
      "evaluator-verdict": [["VERDICT:"]],
    },
    verdictRe: "^VERDICT: (PASS|FAIL)(?: cause=(impl|design|intent))?\\s*$",
  },
}

export function squadRoot(type: string): string {
  return join(accountMetaRoot(), "squads", type)
}

/**
 * Guard rail (spec §8 nested squads, §5 claude-code leaves): both are
 * schema-legal (SlotBinding allows kind:"squad" and platform:"claude-code")
 * but have no runtime support yet. Applied on both write and read so a
 * hand-edited or externally-produced squad.json can't silently activate an
 * unsupported topology.
 */
function validateSlots(def: SquadDef): void {
  for (const slot of Object.values(def.slots)) {
    if (slot.kind === "squad") die("nested squads not yet supported (spec §8)")
    if (slot.kind === "agent" && slot.platform === "claude-code") {
      die("claude-code leaf not yet supported — CC persona probe pending (spec §5)")
    }
  }
}

export function writeSquadDefV1(def: SquadDef): void {
  validateSlots(def)
  const root = squadRoot(def.type)
  const activePath = join(root, "active", "squad.json")
  if (existsSync(activePath)) die(`squad def '${def.type}' already has an active version`)
  mkdirSync(join(root, "candidates", "v1"), { recursive: true })
  mkdirSync(join(root, "active"), { recursive: true })
  writeJsonAtomic(join(root, "candidates", "v1", "squad.json"), def)
  writeJsonAtomic(activePath, { ...def, __version: "v1" })
  syncWireContracts(def)
}

/**
 * Render the consumer-owned wire contract for one role (spec §1.5: the wire
 * is the consumer's contract; the generator — the proposer writing that
 * role's system.md — must be able to SEE it, not infer it). Includes the
 * role-level OR-groups plus any phase-specific overrides (e.g.
 * "evaluator-verdict"), and for the evaluator, the verdictRe pattern
 * verbatim plus a literal example line — this is exactly the detail a live
 * propose-loop demo found three generations converging blindly without
 * (verdictRe's uppercase requirement appeared nowhere in proposer evidence).
 */
function renderWireContract(def: SquadDef, role: string): string {
  const groups: string[][] = []
  const seen = new Set<string>()
  const addGroups = (gs: string[][] | undefined) => {
    if (!gs) return
    for (const g of gs) {
      const key = g.join(" ")
      if (seen.has(key)) continue
      seen.add(key)
      groups.push(g)
    }
  }
  addGroups(def.wire.headings[role])
  for (const [key, gs] of Object.entries(def.wire.headings)) {
    if (key !== role && key.startsWith(`${role}-`)) addGroups(gs)
  }

  const lines: string[] = [
    `# Consumer wire contract — ${role} (verbatim — outputs MUST satisfy this)`,
    "",
    "Your payload must satisfy EVERY heading in AT LEAST ONE of the following groups:",
    "",
    ...groups.map((g) => `- ${g.join(" + ")}`),
  ]

  if (role === "evaluator") {
    lines.push(
      "",
      "## Verdict line — required pattern (verbatim, matched case-insensitively)",
      "",
      "```",
      def.wire.verdictRe,
      "```",
      "",
      "Example lines:",
      "```",
      "VERDICT: PASS",
      "VERDICT: FAIL cause=impl",
      "```",
    )
  }

  return lines.join("\n") + "\n"
}

/**
 * Write <accountRoleRoot(mh-<role>)>/contract.md for every agent-kind slot in
 * `def` (generic, store-level — no propose.ts import here; propose.ts reads
 * contract.md back via buildProposerContext). Idempotent: safe to call on
 * every writeSquadDefV1 and on every squad-def-init CLI invocation, including
 * the already-active tolerated path, so an evolved squad def always keeps
 * its stores' contracts current.
 */
export function syncWireContracts(def: SquadDef): void {
  for (const slot of Object.values(def.slots)) {
    if (slot.kind !== "agent") continue
    const root = accountRoleRoot(`mh-${slot.role}`)
    writeTextAtomic(join(root, "contract.md"), renderWireContract(def, slot.role))
  }
}

export function readActiveSquadDef(type: string): SquadDef {
  const p = join(squadRoot(type), "active", "squad.json")
  if (!existsSync(p)) die(`no active squad def '${type}' — run: runner.ts squad-def-init`)
  const def = JSON.parse(readFileSync(p, "utf-8")) as SquadDef
  validateSlots(def)
  return def
}

/** OR-groups: payload passes if EVERY heading of AT LEAST ONE group is present. */
export function lintPayload(def: SquadDef, slot: string, payload: string): { ok: boolean; missing: string[] } {
  const groups = def.wire.headings[slot]
  if (!groups) return { ok: true, missing: [] }
  for (const group of groups) {
    if (group.every((h) => payload.includes(h))) return { ok: true, missing: [] }
  }
  return { ok: false, missing: groups.map((g) => g.join(" + ")) }
}

export type EscalationType = "Clarify" | "DesignDecision" | "Exhausted" | "Infeasible" | "Refused"

const ESCALATION_ORDER: EscalationType[] = ["Refused", "Infeasible", "Exhausted", "DesignDecision", "Clarify"]

export function detectEscalation(payload: string): { type: EscalationType; body: string } | null {
  for (const type of ESCALATION_ORDER) {
    const re = new RegExp(`^## ${type}\\s*$`, "m")
    const m = re.exec(payload)
    if (m) return { type, body: payload.slice(m.index) }
  }
  return null
}

export function parseVerdict(
  def: SquadDef,
  payload: string,
): { verdict: "PASS" } | { verdict: "FAIL"; cause: "impl" | "design" | "intent" } | null {
  // "mi" (not just "m"): the wire contract is invisible to the proposer (it
  // appears nowhere in the evidence it's shown), so generations converge on
  // plausible-but-wrong casing (e.g. "verdict: pass") — parse case-
  // insensitively and normalize the captures rather than rejecting them.
  const m = new RegExp(def.wire.verdictRe, "mi").exec(payload)
  if (!m) return null
  const verdict = m[1]!.toUpperCase() as "PASS" | "FAIL"
  if (verdict === "PASS") return { verdict: "PASS" }
  const cause = (m[2]?.toLowerCase() ?? "impl") as "impl" | "design" | "intent"
  return { verdict: "FAIL", cause }
}
