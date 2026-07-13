/**
 * squad-def.ts — the squad's ONE evolvable artifact (spec §1.5, §6):
 * slot bindings + flow knobs + wire protocol, versioned like a layer
 * (candidates/vN + active pointer) under the account root.
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { accountMetaRoot } from "../harness-store.ts"
import { die, writeJsonAtomic } from "../bench/util.ts"

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
      evaluator:   [["## Test Spec"], ["VERDICT:"]],
    },
    verdictRe: "^VERDICT: (PASS|FAIL)(?: cause=(impl|design|intent))?\\s*$",
  },
}

export function squadRoot(type: string): string {
  return join(accountMetaRoot(), "squads", type)
}

export function writeSquadDefV1(def: SquadDef): void {
  const root = squadRoot(def.type)
  const activePath = join(root, "active", "squad.json")
  if (existsSync(activePath)) die(`squad def '${def.type}' already has an active version`)
  mkdirSync(join(root, "candidates", "v1"), { recursive: true })
  mkdirSync(join(root, "active"), { recursive: true })
  writeJsonAtomic(join(root, "candidates", "v1", "squad.json"), def)
  writeJsonAtomic(activePath, { ...def, __version: "v1" })
}

export function readActiveSquadDef(type: string): SquadDef {
  const p = join(squadRoot(type), "active", "squad.json")
  if (!existsSync(p)) die(`no active squad def '${type}' — run: runner.ts squad-def-init`)
  return JSON.parse(readFileSync(p, "utf-8")) as SquadDef
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
  const m = new RegExp(def.wire.verdictRe, "m").exec(payload)
  if (!m) return null
  if (m[1] === "PASS") return { verdict: "PASS" }
  return { verdict: "FAIL", cause: (m[2] as "impl" | "design" | "intent") ?? "impl" }
}
