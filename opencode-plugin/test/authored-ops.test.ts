import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { applyAuthoredOps } from "../scripts/authored-ops.ts"

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
