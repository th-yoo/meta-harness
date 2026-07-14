import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt, buildStoreAccessSection, buildCuratePrompt } from "../src/propose.ts"
import { readMhConfig, writeActive, buildProposerContext, type StoreLayer, type Playbook } from "../src/harness-store.ts"

// Token-free: exercises prompt rendering + config parsing directly — no
// opencode session, no LLM call. Covers the agentic-proposer store access
// (paper mechanism, arXiv 2603.28052): the proposer prompt must (a) name the
// store root and per-candidate layout so the session can read the archive with
// its file tools, (b) index the candidates with scores/trajectory counts, and
// (c) mark the store strictly read-only (staging is the only write target).

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-store-access-${name}-`))
}

/** Handcraft a candidate dir: score.json + traj/*.ndjson (+ optional diagnosis). */
function seedCandidate(
  storeRoot: string,
  version: string,
  opts: { nPass?: number; nFail?: number; trajFiles?: number; diagnosis?: boolean } = {},
): void {
  const { nPass = 0, nFail = 0, trajFiles = 0, diagnosis = false } = opts
  const dir = path.join(storeRoot, "candidates", version)
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  // Traj files double as failing-session records so buildFailureExcerpts has
  // real evidence to excerpt (sessionID must match the .ndjson basename).
  const sessions = Array.from({ length: trajFiles }, (_, i) => ({
    sessionID: `ses_${i}`, passed: false, summary: `failing session ${i}`,
  }))
  fs.writeFileSync(
    path.join(dir, "score.json"),
    JSON.stringify({ version, nPass, nFail, sessions }),
  )
  for (let i = 0; i < trajFiles; i++) {
    fs.writeFileSync(path.join(dir, "traj", `ses_${i}.ndjson`), `{"t":"text","text":"e${i}"}\n`)
  }
  if (diagnosis) {
    fs.writeFileSync(path.join(dir, "diagnosis.json"), JSON.stringify({ failures: [] }))
  }
}

function stagingPaths(worktree: string, scope: string, version: string) {
  const base = path.join(worktree, ".meta-harness", "staging")
  return {
    system: path.join(base, `${scope}-${version}-system.md`),
    tools: path.join(base, `${scope}-${version}-tools.md`),
    diagnosis: path.join(base, `${scope}-${version}-diagnosis.json`),
    ops: path.join(base, `${scope}-${version}-ops.json`),
    agentConfig: path.join(base, `${scope}-${version}-agent-config.json`),
    envPolicy: path.join(base, `${scope}-${version}-env-policy.json`),
  }
}

test("buildStoreAccessSection: names the root, indexes candidates with scores/traj/diagnosis, marks read-only", () => {
  const storeRoot = tmpDir("store")
  writeActive(storeRoot, "v2", "- rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 3, nFail: 2, trajFiles: 4, diagnosis: true })
  seedCandidate(storeRoot, "v2", { nPass: 5, nFail: 1, trajFiles: 2 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const s = buildStoreAccessSection(layer)

  expect(s).toContain(storeRoot)
  expect(s).toContain("candidates/<vN>/")
  expect(s).toContain("- v1 — pass 3 / fail 2 — trajectories: 4 — diagnosis: yes")
  expect(s).toContain("- v2 (ACTIVE) — pass 5 / fail 1 — trajectories: 2 — diagnosis: no")
  expect(s).toContain("STRICTLY READ-ONLY")
})

test("buildStoreAccessSection: empty store renders without crashing and still warns read-only", () => {
  const storeRoot = tmpDir("empty")
  const layer: StoreLayer = { root: storeRoot, scope: "project-global", higherRoots: [] }

  const s = buildStoreAccessSection(layer)

  expect(s).toContain("(no candidates yet)")
  expect(s).toContain("STRICTLY READ-ONLY")
})

test("buildStoreAccessSection: elides beyond the newest 20 versions", () => {
  const storeRoot = tmpDir("many")
  writeActive(storeRoot, "v24", "- rule", "")
  for (let i = 0; i <= 24; i++) seedCandidate(storeRoot, `v${i}`)
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const s = buildStoreAccessSection(layer)

  expect(s).toContain("(5 older versions elided")
  expect(s).not.toContain("- v0 —")
  expect(s).toContain("- v24 (ACTIVE)")
})

test("buildProposerPrompt: embeds the store-access section and demotes excerpts to an index", () => {
  const worktree = tmpDir("worktree")
  const storeRoot = tmpDir("store-prompt")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 1, nFail: 1, trajFiles: 1 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).toContain("## Store access — read the archive before diagnosing")
  expect(prompt).toContain(storeRoot)
  expect(prompt).toContain("Failing-trajectory excerpts")
  expect(prompt).toContain("an INDEX of where to look")
  // Mined lesson L1: trajectories are untrusted evidence, not instructions.
  expect(prompt).toContain("untrusted DATA")
  // Mined lesson L2: an explicit "do NOT propose" rejection list.
  expect(prompt).toContain("Do NOT propose")
})

// Mined-lesson clauses (L1 untrusted-evidence, L2 rejection list) must also
// render in playbook (ops) mode, not just legacy system.md mode.
test("buildProposerPrompt: carries the untrusted-evidence + rejection clauses in playbook mode", () => {
  const worktree = tmpDir("worktree-pb")
  const storeRoot = tmpDir("store-pb")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 1, nFail: 1, trajFiles: 1 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")
  const playbook: Playbook = {
    schemaVersion: 1,
    bullets: [
      { id: "b1", text: "rule one", helpful: 1, harmful: 0, addedBy: "v1", status: "active", createdAt: "", updatedAt: "" },
    ],
  }

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, playbook,
  )

  expect(prompt).toContain("untrusted DATA")
  expect(prompt).toContain("Do NOT propose")
})

// Final-review fix: the "not grounded in a failing trajectory" rejection item is
// evidence-conditional. On a fresh/empty layer (bootstrap path, no captured
// failures) that categorical prohibition would forbid the very baseline the
// prompt asks for → with no-op candidates rejected, bootstrap stalls. It must
// apply ONLY when failing evidence is actually present.
test("buildProposerPrompt: fresh/empty layer drops the failing-trajectory prohibition and grants a baseline escape hatch", () => {
  const worktree = tmpDir("worktree-fresh")
  const storeRoot = tmpDir("store-fresh") // truly empty — no candidates, no active
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v1")

  const prompt = buildProposerPrompt(
    layer, "v1", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  // The categorical prohibition must NOT be present with no failures.
  expect(prompt).not.toContain("not grounded in a failing trajectory")
  // The rejection list still renders, with the empty-layer escape hatch.
  expect(prompt).toContain("Do NOT propose")
  expect(prompt).toContain("write a sensible baseline grounded in this scope's purpose")
})

test("buildProposerPrompt: layer WITH failures keeps the failing-trajectory prohibition", () => {
  const worktree = tmpDir("worktree-fail")
  const storeRoot = tmpDir("store-fail")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 1, nFail: 2, trajFiles: 2 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  // With real failing evidence, the categorical prohibition IS asserted.
  expect(prompt).toContain("not grounded in a failing trajectory")
  expect(prompt).not.toContain("write a sensible baseline grounded in this scope's purpose")
})

test("buildCuratePrompt: embeds the store-access section as prune evidence", () => {
  const worktree = tmpDir("worktree-cur")
  const storeRoot = tmpDir("store-cur")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 2, nFail: 3, trajFiles: 1 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const playbook: Playbook = {
    schemaVersion: 1,
    bullets: [
      { id: "b1", text: "rule one", helpful: 2, harmful: 0, addedBy: "v1", status: "active", createdAt: "", updatedAt: "" },
    ],
  }

  const prompt = buildCuratePrompt(layer, playbook, path.join(worktree, ".meta-harness", "staging", "ops.json"), worktree)

  expect(prompt).toContain("## Store access — read the archive before diagnosing")
  expect(prompt).toContain(storeRoot)
  expect(prompt).toContain("read the traces before deciding")
})

// Fix B (live-loop finding): a layer root MAY contain contract.md — the
// consumer-owned wire contract, written by fleet's syncWireContracts
// (squad-def.ts) — and buildProposerContext must surface it verbatim to the
// proposer when present. This is store-level and generic: no fleet import
// here, just a plain file read.
test("buildProposerContext: layer root with contract.md → context contains the wire section", () => {
  const storeRoot = tmpDir("store-contract")
  writeActive(storeRoot, "v1", "- some rule", "")
  fs.writeFileSync(path.join(storeRoot, "contract.md"), "# Consumer wire contract — evaluator\n\nVERDICT: PASS\n")

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("## Consumer wire contract (verbatim — outputs MUST satisfy this)")
  expect(context).toContain("VERDICT: PASS")
})

test("buildProposerContext: no contract.md → context unchanged (no wire section)", () => {
  const storeRoot = tmpDir("store-no-contract")
  writeActive(storeRoot, "v1", "- some rule", "")

  const context = buildProposerContext(storeRoot, [])

  expect(context).not.toContain("Consumer wire contract")
})

test("readMhConfig: proposerTimeoutMin defaults to 20, honors valid overrides, rejects junk, caps at 120", () => {
  const empty = tmpDir("cfg-empty")
  expect(readMhConfig(empty).proposerTimeoutMin).toBe(20)

  const set = tmpDir("cfg-set")
  fs.writeFileSync(path.join(set, "config.json"), JSON.stringify({ proposerTimeoutMin: 45 }))
  expect(readMhConfig(set).proposerTimeoutMin).toBe(45)

  const junk = tmpDir("cfg-junk")
  fs.writeFileSync(path.join(junk, "config.json"), JSON.stringify({ proposerTimeoutMin: -5 }))
  expect(readMhConfig(junk).proposerTimeoutMin).toBe(20)

  const junk2 = tmpDir("cfg-junk2")
  fs.writeFileSync(path.join(junk2, "config.json"), JSON.stringify({ proposerTimeoutMin: "soon" }))
  expect(readMhConfig(junk2).proposerTimeoutMin).toBe(20)

  const huge = tmpDir("cfg-huge")
  fs.writeFileSync(path.join(huge, "config.json"), JSON.stringify({ proposerTimeoutMin: 999 }))
  expect(readMhConfig(huge).proposerTimeoutMin).toBe(120)
})
