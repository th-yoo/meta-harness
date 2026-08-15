import { describe, expect, test } from "bun:test"
import { applyPlaybookOps, type Playbook, type PlaybookBullet, type PlaybookOp } from "../src/harness-store"

const HR = {
  event: "PreToolUse" as const,
  toolMatcher: "Bash" as const,
  inputPattern: "^docker ",
  feedback: "use podman",
  mode: "shadow" as const,
}

function base(): Playbook {
  const b: PlaybookBullet = {
    id: "b1",
    text: "When containerizing, use podman.",
    helpful: 0,
    harmful: 0,
    addedBy: "test",
    status: "active",
    createdAt: "2026-08-15T00:00:00.000Z",
    updatedAt: "2026-08-15T00:00:00.000Z",
    hookRule: { ...HR },
  }
  return { schemaVersion: 1, nextId: 2, bullets: [b] }
}

describe("hookRule tri-state on playbook ops", () => {
  test("add op carries hookRule; mode is forced to shadow regardless of input", () => {
    const op = {
      op: "add",
      text: "When installing, use bun.",
      hookRule: { ...HR, inputPattern: "^npm ", mode: "deny" },
    } as unknown as PlaybookOp
    const p = applyPlaybookOps(base(), [op])
    const added = p.bullets.find((b) => b.text.includes("use bun"))!
    expect(added.hookRule).toBeDefined()
    expect(added.hookRule!.inputPattern).toBe("^npm ")
    expect(added.hookRule!.mode).toBe("shadow")
  })

  test("update op omitting hookRule keeps it, including current store-owned mode", () => {
    const seeded = base()
    seeded.bullets[0]!.hookRule!.mode = "warn"
    const p = applyPlaybookOps(seeded, [
      { op: "update", id: "b1", text: "When containerizing, always use podman." },
    ])
    const b = p.bullets[0]!
    expect(b.hookRule).toBeDefined()
    expect(b.hookRule!.inputPattern).toBe("^docker ")
    expect(b.hookRule!.mode).toBe("warn")
  })

  test("update op with hookRule:null drops it", () => {
    const op = { op: "update", id: "b1", text: "When containerizing, use podman.", hookRule: null } as unknown as PlaybookOp
    const p = applyPlaybookOps(base(), [op])
    expect(p.bullets[0]!.hookRule).toBeUndefined()
  })

  test("update op replacing hookRule restarts ramp to shadow", () => {
    const seeded = base()
    seeded.bullets[0]!.hookRule!.mode = "deny"
    const op = {
      op: "update",
      id: "b1",
      text: "When containerizing, use podman.",
      hookRule: { ...HR, inputPattern: "^docker run ", mode: "deny" },
    } as unknown as PlaybookOp
    const p = applyPlaybookOps(seeded, [op])
    const b = p.bullets[0]!
    expect(b.hookRule!.inputPattern).toBe("^docker run ")
    expect(b.hookRule!.mode).toBe("shadow")
  })

  test("hookRule and check coexist independently on one bullet through an update", () => {
    const seeded = base()
    seeded.bullets[0]!.check = { cmd: "true", timeoutMs: 1000, state: "shadow" }
    const p = applyPlaybookOps(seeded, [
      { op: "update", id: "b1", text: "When containerizing, use podman only.", check: null },
    ])
    const b = p.bullets[0]!
    expect(b.check).toBeUndefined()
    expect(b.hookRule).toBeDefined()
    expect(b.hookRule!.inputPattern).toBe("^docker ")
  })
})
