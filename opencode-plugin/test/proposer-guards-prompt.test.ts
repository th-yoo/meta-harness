import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { writeActive, type StoreLayer } from "../src/harness-store.ts"

// Gen-2 regression fix (2026-08-17): v2's four regressions were all tasks the
// active version passed at 4-5/5, and the production proposer prompt never
// asked for a guard defense (bench lane's lesson-proposer always did). Guards
// come from guards.json under the layer root; when present the prompt must
// list them and require diagnosis.predictions.expect_unchanged_guards. Same
// token-free render pattern as proposer-taxonomy-prompt.test.ts.

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-proposer-guards-${name}-`))
}

function render(layer: StoreLayer, worktree: string): string {
  const base = path.join(worktree, ".kkamak", "staging")
  const sp = (n: string) => path.join(base, `${layer.scope}-v2-${n}`)
  return buildProposerPrompt(
    layer, "v2", "", sp("system.md"), sp("tools.md"), sp("diagnosis.json"),
    sp("ops.json"), sp("agent-config.json"), sp("env-policy.json"), worktree, null,
  )
}

const GUARDS = [
  { task: "sam-cell-seg", rate: 0.8, n: 5 },
  { task: "polyglot-rust-c", rate: 1.0, n: 5 },
  { task: "filter-js-from-html", rate: 0.0, n: 5 },
]

test("buildProposerPrompt: guards.json renders guard list + predictions requirement in diagnosis shape", () => {
  const worktree = tmpDir("worktree")
  const storeRoot = tmpDir("store")
  writeActive(storeRoot, "v1", "- some rule", "")
  fs.writeFileSync(path.join(storeRoot, "guards.json"), JSON.stringify(GUARDS))
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("## Guard tasks")
  expect(prompt).toContain("- sam-cell-seg: 80% pass (n=5)")
  expect(prompt).toContain("- polyglot-rust-c: 100% pass (n=5)")
  expect(prompt).toContain("expect_unchanged_guards")
  // predictions shape must reach the diagnosis skeleton the agent copies
  expect(prompt).toContain('"predictions":{"expect_improve"')
})

test("buildProposerPrompt: guards section sits before DIAGNOSE; no guards.json → no section, no predictions shape, byte-stable", () => {
  const worktree = tmpDir("worktree2")
  const storeRoot = tmpDir("store2")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const bare = render(layer, worktree)
  expect(bare).not.toContain("## Guard tasks")
  expect(bare).not.toContain('"predictions"')
  expect(bare).toBe(render(layer, worktree))

  fs.writeFileSync(path.join(storeRoot, "guards.json"), JSON.stringify(GUARDS))
  const withGuards = render(layer, worktree)
  const gIdx = withGuards.indexOf("## Guard tasks")
  const dIdx = withGuards.indexOf("## Your task — DIAGNOSE")
  expect(gIdx).toBeGreaterThan(-1)
  expect(gIdx).toBeLessThan(dIdx)
})

test("buildProposerPrompt: malformed guards.json fails open (no section)", () => {
  const worktree = tmpDir("worktree3")
  const storeRoot = tmpDir("store3")
  writeActive(storeRoot, "v1", "- some rule", "")
  fs.writeFileSync(path.join(storeRoot, "guards.json"), '{"not":"an array"}')
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }
  expect(render(layer, worktree)).not.toContain("## Guard tasks")
})
