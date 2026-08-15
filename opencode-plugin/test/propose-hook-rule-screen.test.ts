import { describe, expect, test } from "bun:test"
import { screenOpsHookRules } from "../src/propose"
import { reviewAddedBullets } from "../src/review-gate"
import type { Playbook, PlaybookOp } from "../src/harness-store"

const HR = { event: "PreToolUse" as const, toolMatcher: "Bash" as const, inputPattern: "^docker ", feedback: "use podman" }

function active(withPattern?: string): Playbook {
  return {
    schemaVersion: 1,
    nextId: 2,
    bullets: [
      {
        id: "b1",
        text: "existing",
        helpful: 0,
        harmful: 0,
        addedBy: "test",
        status: "active",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        ...(withPattern
          ? { hookRule: { ...HR, inputPattern: withPattern, mode: "shadow" as const } }
          : {}),
      },
    ],
  }
}

describe("screenOpsHookRules", () => {
  test("ops without hookRule pass untouched (incl. delete and null-drop)", () => {
    const ops: PlaybookOp[] = [
      { op: "add", text: "plain" },
      { op: "update", id: "b1", text: "t", hookRule: null },
      { op: "delete", id: "b1" },
    ]
    const r = screenOpsHookRules(ops, active())
    expect(r.ops.length).toBe(3)
    expect(r.rejections.length).toBe(0)
  })

  test("invalid hookRule rejects the op with the named violation", () => {
    const ops = [
      { op: "add", text: "x", hookRule: { ...HR, inputPattern: "^a\\s" } },
      { op: "add", text: "y", hookRule: { ...HR, mode: "deny" } },
    ] as unknown as PlaybookOp[]
    const r = screenOpsHookRules(ops, active())
    expect(r.ops.length).toBe(0)
    expect(r.rejections.map((x) => x.violation)).toEqual([
      "hook-screen:pattern-not-portable",
      "hook-screen:mode-not-proposer-set",
    ])
  })

  test("dedup: identical (toolMatcher, inputPattern) vs an active bullet rejects", () => {
    const ops = [{ op: "add", text: "dup", hookRule: { ...HR } }] as unknown as PlaybookOp[]
    const r = screenOpsHookRules(ops, active("^docker "))
    expect(r.ops.length).toBe(0)
    expect(r.rejections[0]!.violation).toBe("hook-screen:duplicate-rule")
  })

  test("update op replacing its OWN bullet's rule is not a self-duplicate", () => {
    const ops = [{ op: "update", id: "b1", text: "t", hookRule: { ...HR } }] as unknown as PlaybookOp[]
    const r = screenOpsHookRules(ops, active("^docker "))
    expect(r.ops.length).toBe(1)
    expect(r.rejections.length).toBe(0)
  })

  test("valid new rule passes", () => {
    const ops = [{ op: "add", text: "ok", hookRule: { ...HR, inputPattern: "^npm " } }] as unknown as PlaybookOp[]
    const r = screenOpsHookRules(ops, active("^docker "))
    expect(r.ops.length).toBe(1)
  })
})

describe("reviewAddedBullets hookRule screening", () => {
  const throwingHost = {
    runTextAgent: async () => {
      throw new Error("LLM must not be called for a screen rejection")
    },
    log: async () => {},
  } as never

  test("mode smuggle rejects whole bullet before any LLM call", async () => {
    const out = await reviewAddedBullets({
      host: throwingHost,
      bullets: [{ text: "smuggler", hookRule: { ...HR, mode: "deny" } }],
      diagnosisReason: "r",
      activeSystem: "",
      ledger: [],
      scope: "test",
    })
    expect(out.length).toBe(1)
    expect(out[0]!.staged).toBe(false)
    expect(out[0]!.violations).toEqual(["hook-screen:mode-not-proposer-set"])
    expect(out[0]!.bullet).toContain("[hookRule: screen-denied")
  })
})
