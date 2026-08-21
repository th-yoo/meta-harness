import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { applyAuthoredOps, checkStorePrecondition } from "../scripts/authored-ops.ts"
import { SEED_OPS } from "../scripts/seed-hook-rules.ts"

function store(): { root: string; repo: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-store-"))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-repo-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "playbook.json"),
    JSON.stringify({ schemaVersion: 1, nextId: 1, bullets: [] }))
  return { root, repo }
}

test("screen-failing hookRule op refuses the WHOLE batch, store untouched", () => {
  const { root, repo } = store()
  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [
      { op: "add", text: "When A, do B." },
      { op: "add", text: "When C, do D.", hookRule: { event: "PreToolUse", toolMatcher: "Bash",
        inputPattern: "(a+)+", feedback: "nope" } }, // backtracking risk → screen refusal
    ] })
  expect(r.applied).toBe(false)
  expect(r.refusals.length).toBeGreaterThan(0)
  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets).toHaveLength(0)
})

test("fresh store with no active/ dir yet: clean ops apply and create the path", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-store-fresh-"))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-repo-fresh-"))
  // deliberately no mkdirSync(active) and no playbook.json — simulates a
  // brand-new store the Task 6 seed script may target
  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [{ op: "add", text: "When G, do H." }] })
  expect(r.applied).toBe(true)
  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets).toHaveLength(1)
})

test("clean ops apply, stamp shadow, and export both tables", () => {
  const { root, repo } = store()
  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [{ op: "add", text: "When E, do F.", hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^rm .*(kkamak|candidates/)", feedback: "read target first" } }] })
  expect(r.applied).toBe(true)
  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets[0].hookRule.mode).toBe("shadow")
  const table = JSON.parse(fs.readFileSync(path.join(repo, ".km", "hook-rules.json"), "utf8"))
  expect(table.rules).toHaveLength(1)
  expect(table.rules[0].mode).toBe("shadow")
})

test("duplicate hookRule op (same toolMatcher+inputPattern) against an active bullet is refused, store unchanged", () => {
  const { root, repo } = store()
  const hookRule = { event: "PreToolUse" as const, toolMatcher: "Bash" as const,
    inputPattern: "^rm .*(kkamak|candidates/)", feedback: "read target first" }
  const first = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [{ op: "add", text: "When E, do F.", hookRule }] })
  expect(first.applied).toBe(true)

  const second = applyAuthoredOps({ storeRoot: root, repoRoot: repo, provenance: "test",
    ops: [{ op: "add", text: "When E, do F again.", hookRule }] })
  expect(second.applied).toBe(false)
  expect(second.refusals.some((r) => r.includes("hook-screen:duplicate-rule"))).toBe(true)

  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(pb.bullets).toHaveLength(1)
})

test("seeding SEED_OPS twice is idempotent: second run refused, store unchanged", () => {
  const { root, repo } = store()
  const first = applyAuthoredOps({ storeRoot: root, repoRoot: repo, ops: SEED_OPS, provenance: "test" })
  expect(first.applied).toBe(true)
  const afterFirst = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(afterFirst.bullets).toHaveLength(4)

  const second = applyAuthoredOps({ storeRoot: root, repoRoot: repo, ops: SEED_OPS, provenance: "test" })
  expect(second.applied).toBe(false)
  expect(second.refusals).toHaveLength(4) // all 4 rules already present → all 4 duplicate-refused
  const afterSecond = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  expect(afterSecond).toEqual(afterFirst)
})

test("checkStorePrecondition: null when active/playbook.json exists", () => {
  const { root } = store()
  expect(checkStorePrecondition(root)).toBeNull()
})

test("checkStorePrecondition: an error message when it does not (wrong cwd / brand-new dir)", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-authored-store-nostore-"))
  const msg = checkStorePrecondition(root)
  expect(msg).not.toBeNull()
  expect(msg).toContain("active")
  expect(msg).toContain("playbook.json")
})
