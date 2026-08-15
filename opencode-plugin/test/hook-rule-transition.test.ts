import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  hookRuleTransition,
  readPlaybook,
  type HookRuleTransitionEvidence,
  type Playbook,
} from "../src/harness-store"

let storeRoot: string

const EV: HookRuleTransitionEvidence = {
  matchedSessions: 6,
  matchedObs: 24,
  fpRate: 0.17,
  sessionIDs: ["s1", "s2", "s3", "s4", "s5", "s6"],
}

function seedActive(mode: "shadow" | "warn" | "deny", status: "active" | "pruned" = "active"): void {
  const pb: Playbook = {
    schemaVersion: 1,
    nextId: 2,
    bullets: [
      {
        id: "b1",
        text: "when containerizing use podman",
        helpful: 0,
        harmful: 0,
        addedBy: "test",
        status,
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        hookRule: { event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^docker ", feedback: "use podman", mode },
      },
    ],
  }
  mkdirSync(join(storeRoot, "active"), { recursive: true })
  writeFileSync(join(storeRoot, "active", "playbook.json"), JSON.stringify(pb))
}

function ledgerLines(): Array<Record<string, unknown>> {
  const p = join(storeRoot, "hook-rule-transitions.jsonl")
  if (!existsSync(p)) return []
  return readFileSync(p, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

beforeEach(() => {
  storeRoot = mkdtempSync(join(tmpdir(), "hrt-"))
})
afterEach(() => {
  rmSync(storeRoot, { recursive: true, force: true })
})

describe("hookRuleTransition", () => {
  test("shadow->warn: mode updated in active playbook, ledger line with evidence + thresholds", () => {
    seedActive("shadow")
    const ok = hookRuleTransition(storeRoot, "b1", "shadow", "warn", EV)
    expect(ok).toBe(true)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("warn")
    const lines = ledgerLines()
    expect(lines.length).toBe(1)
    expect(lines[0]!.bulletId).toBe("b1")
    expect(lines[0]!.from).toBe("shadow")
    expect(lines[0]!.to).toBe("warn")
    expect((lines[0]!.evidence as Record<string, unknown>).fpRate).toBe(0.17)
    expect(lines[0]!.thresholds).toBeDefined()
  })

  test("precondition miss: current mode differs from `from` -> false, no writes", () => {
    seedActive("warn")
    expect(hookRuleTransition(storeRoot, "b1", "shadow", "warn", EV)).toBe(false)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("warn")
    expect(ledgerLines().length).toBe(0)
  })

  test("absent bullet / absent hookRule / pruned bullet -> false", () => {
    seedActive("shadow", "pruned")
    expect(hookRuleTransition(storeRoot, "b1", "shadow", "warn", EV)).toBe(false)
    expect(hookRuleTransition(storeRoot, "b9", "shadow", "warn", EV)).toBe(false)
    expect(ledgerLines().length).toBe(0)
  })

  test("no active playbook -> false, never throws", () => {
    expect(hookRuleTransition(storeRoot, "b1", "shadow", "warn", EV)).toBe(false)
  })

  test("ledger accumulates; F2 — no pattern/feedback text on ledger lines", () => {
    seedActive("shadow")
    hookRuleTransition(storeRoot, "b1", "shadow", "warn", EV)
    hookRuleTransition(storeRoot, "b1", "warn", "shadow", { ...EV, fpRate: 0.6 })
    const lines = ledgerLines()
    expect(lines.length).toBe(2)
    const raw = readFileSync(join(storeRoot, "hook-rule-transitions.jsonl"), "utf-8")
    expect(raw).not.toContain("docker")
    expect(raw).not.toContain("podman")
  })
})
