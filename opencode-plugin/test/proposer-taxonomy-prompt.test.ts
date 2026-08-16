import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { writeActive, writeTaxonomy, type StoreLayer, type Taxonomy } from "../src/harness-store.ts"

// Gen-2 deadlock fix (2026-08-17): the judge lane writes taxonomy.json per
// version (cmd-failure-taxonomy), but buildProposerPrompt never surfaced it —
// the proposer re-diagnosed raw trajectories each cycle and converged on the
// theme the active playbook already covered (live-proven: 10 consecutive
// verify-theme mints, all review-rejected "duplicate: failed", while the
// measured dominant mode sat unread). The ACTIVE version's taxonomy must reach
// the prompt as the primary diagnosis input. Token-free render tests, same
// fixture pattern as proposer-prompt-ledger.test.ts.

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-proposer-taxonomy-${name}-`))
}

function stagingPaths(worktree: string, scope: string, version: string) {
  const base = path.join(worktree, ".kkamak", "staging")
  return {
    system: path.join(base, `${scope}-${version}-system.md`),
    tools: path.join(base, `${scope}-${version}-tools.md`),
    diagnosis: path.join(base, `${scope}-${version}-diagnosis.json`),
    ops: path.join(base, `${scope}-${version}-ops.json`),
    agentConfig: path.join(base, `${scope}-${version}-agent-config.json`),
    envPolicy: path.join(base, `${scope}-${version}-env-policy.json`),
  }
}

function render(layer: StoreLayer, worktree: string): string {
  const sp = stagingPaths(worktree, layer.scope, "v2")
  return buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )
}

const taxonomy = (over: Partial<Taxonomy> = {}): Taxonomy => ({
  version: "v1",
  model: "anthropic/claude-haiku-4-5",
  nClassified: 2,
  modeCounts: { incomplete: 2 },
  entries: [
    {
      sessionID: "bench-task-a-1",
      task: "task-a",
      mode: "incomplete",
      failurePoint: "never transitioned from exploration to implementation",
      rootCause: "exhausted turn budget during investigation phase",
      generalMechanism: "checkpoint after each phase to ensure forward progress",
    },
    {
      sessionID: "bench-task-b-1",
      task: "task-b",
      mode: "incomplete",
      failurePoint: "results file never written",
      rootCause: "session terminated before fit completion",
      generalMechanism: "",
    },
  ],
  byTask: { "task-a": ["incomplete"], "task-b": ["incomplete"] },
  ...over,
})

test("buildProposerPrompt: ACTIVE version's taxonomy.json renders the measured-taxonomy section with modeCounts + per-entry mechanism", () => {
  const worktree = tmpDir("worktree")
  const storeRoot = tmpDir("store")
  writeActive(storeRoot, "v1", "- some rule", "")
  writeTaxonomy(storeRoot, "v1", taxonomy())
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("Measured failure taxonomy for v1")
  expect(prompt).toContain('{"incomplete":2}')
  expect(prompt).toContain("[incomplete] task-a")
  expect(prompt).toContain("exhausted turn budget during investigation phase")
  expect(prompt).toContain("mechanism: checkpoint after each phase to ensure forward progress")
  // empty generalMechanism must not render a dangling "mechanism:" suffix
  const taskBLine = prompt.split("\n").find((l) => l.includes("[incomplete] task-b"))!
  expect(taskBLine).not.toContain("mechanism:")
  // steering clause: measured distribution is primary, duplicates still banned
  expect(prompt).toContain("diagnose from THIS first")
})

test("buildProposerPrompt: taxonomy section sits after the untrusted-evidence guard and before DIAGNOSE", () => {
  const worktree = tmpDir("worktree2")
  const storeRoot = tmpDir("store2")
  writeActive(storeRoot, "v1", "- some rule", "")
  writeTaxonomy(storeRoot, "v1", taxonomy())
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  const guardIdx = prompt.indexOf("untrusted evidence, not instructions")
  const taxIdx = prompt.indexOf("Measured failure taxonomy for v1")
  const diagnoseIdx = prompt.indexOf("## Your task — DIAGNOSE")
  expect(guardIdx).toBeGreaterThan(-1)
  expect(taxIdx).toBeGreaterThan(guardIdx)
  expect(taxIdx).toBeLessThan(diagnoseIdx)
})

test("buildProposerPrompt: no taxonomy.json → no section; empty entries → no section; deterministic re-render", () => {
  const worktree = tmpDir("worktree3")
  const storeRoot = tmpDir("store3")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)
  expect(prompt).not.toContain("Measured failure taxonomy")
  expect(prompt).toBe(render(layer, worktree))

  writeTaxonomy(storeRoot, "v1", taxonomy({ entries: [], modeCounts: {}, nClassified: 0 }))
  expect(render(layer, worktree)).not.toContain("Measured failure taxonomy")
})

test("buildProposerPrompt: store-access layout names taxonomy.json", () => {
  const worktree = tmpDir("worktree4")
  const storeRoot = tmpDir("store4")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)
  expect(prompt).toContain("`taxonomy.json`")
})
