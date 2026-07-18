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

// Loop-3 T4: a timedOut session must render distinctly from a generic FAIL
// in buildProposerContext's per-session trace line, carrying the elapsed vs
// budget numbers (T3's `elapsed`/`env.maxAgentTimeout` fields) — otherwise
// the proposer can't tell a resource-limit failure apart from any other fail.
test("buildProposerContext: timedOut session renders a distinct TIMEOUT marker with elapsed/budget", () => {
  const storeRoot = tmpDir("store-timeout")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 0, nFail: 1,
    sessions: [{
      sessionID: "ses_timeout", passed: false, turnCount: 0, timedOut: true, elapsed: 638.4,
      env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "timed out",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("TIMEOUT")
  expect(context).toContain("638.4")
  expect(context).toContain("600")
})

// Loop-3 pre-flip fix #1: the TIMEOUT marker's denominator must be the REAL
// per-task agent timeout (`session.agentTimeout`, taskTimeouts()'s resolved
// per-task budget), NOT the run-level `env.maxAgentTimeout` cap — those two
// diverge whenever a task.toml override sits below the run's --max-agent-
// timeout (or the run cap sits above the 900s task.toml default). Rendering
// the run-level cap in that case understates the wall the task actually hit,
// undercutting the resource-limit diagnosis this marker exists for.
test("buildProposerContext: timedOut session with per-task agentTimeout renders THAT budget, not the run-level env.maxAgentTimeout", () => {
  const storeRoot = tmpDir("store-timeout-pertask")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 0, nFail: 1,
    sessions: [{
      sessionID: "ses_timeout", passed: false, turnCount: 0, timedOut: true, elapsed: 290.1,
      agentTimeout: 300, env: { maxAgentTimeout: 900 }, model: "m", variant: "", toolUsage: {}, summary: "timed out",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("TIMEOUT")
  expect(context).toContain("290.1")
  expect(context).toContain("300")
  expect(context).not.toContain("900")
})

// Back-compat: a record with no `agentTimeout` field (every pre-fix record)
// must still render — falling back to the run-level env.maxAgentTimeout,
// exactly as before this fix.
test("buildProposerContext: timedOut session with no agentTimeout falls back to env.maxAgentTimeout (back-compat)", () => {
  const storeRoot = tmpDir("store-timeout-fallback")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 0, nFail: 1,
    sessions: [{
      sessionID: "ses_timeout", passed: false, turnCount: 0, timedOut: true, elapsed: 638.4,
      env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "timed out",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("TIMEOUT")
  expect(context).toContain("638.4")
  expect(context).toContain("600")
})

// Back-compat: a session with no `timedOut` field (every pre-Loop-3 record,
// and any ordinary agent-loss fail) must render exactly as before — no
// TIMEOUT marker leaking onto a non-timeout FAIL.
test("buildProposerContext: ordinary FAIL without timedOut renders unchanged, no TIMEOUT marker", () => {
  const storeRoot = tmpDir("store-nofail-timeout")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 0, nFail: 1, trajFiles: 1 })

  const context = buildProposerContext(storeRoot, [])

  expect(context).not.toContain("TIMEOUT")
})

// Loop-3 T4: the proposer must be explicitly steered to diagnose a recorded
// timeout as `resource-limit` (FAILURE_TAXONOMY) rather than missing it
// entirely — timeouts have events:[] so they appear in NO failing-trajectory
// excerpt (buildFailureExcerpts scans events); this note is the only place
// the signal surfaces as actionable guidance rather than a terse trace line.
test("buildProposerPrompt: timed-out sessions present -> 'Timed-out sessions' note naming resource-limit", () => {
  const worktree = tmpDir("worktree-to")
  const storeRoot = tmpDir("store-to")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 0, nFail: 1,
    sessions: [{
      sessionID: "ses_timeout", passed: false, turnCount: 0, timedOut: true, elapsed: 638.4,
      env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "timed out",
      note: "", timestamp: "",
    }],
  }))
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).toContain("Timed-out sessions")
  expect(prompt).toContain("resource-limit")
})

// Negative case: no timedOut sessions in the store -> note must be absent
// entirely, not just empty-bodied — keeps the prompt additive-only.
test("buildProposerPrompt: no timed-out sessions -> 'Timed-out sessions' note omitted", () => {
  const worktree = tmpDir("worktree-noto")
  const storeRoot = tmpDir("store-noto")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 1, nFail: 1, trajFiles: 1 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).not.toContain("Timed-out sessions")
})

// Loop-3 pre-flip fix #2: the timed-out steer note points at agent-config.json
// / env-policy.json timeout-bump ops that are offered ONLY at PROJECT layers
// (see agentConfigSection/envPolicySection — account layers don't stage those
// ops files at all). At account-global/account-role scope the note misdirects
// the proposer at ops it can't actually use here. Gate the note to
// layer.scope.startsWith("project").
function seedTimedOutStore(storeRoot: string): void {
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 0, nFail: 1,
    sessions: [{
      sessionID: "ses_timeout", passed: false, turnCount: 0, timedOut: true, elapsed: 638.4,
      env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "timed out",
      note: "", timestamp: "",
    }],
  }))
}

test("buildProposerPrompt: account-global scope -> 'Timed-out sessions' note is OMITTED even with timed-out sessions", () => {
  const worktree = tmpDir("worktree-to-acct")
  const storeRoot = tmpDir("store-to-acct")
  seedTimedOutStore(storeRoot)
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).not.toContain("Timed-out sessions")
})

test("buildProposerPrompt: account-role scope -> 'Timed-out sessions' note is OMITTED even with timed-out sessions", () => {
  const worktree = tmpDir("worktree-to-acct-role")
  const storeRoot = tmpDir("store-to-acct-role")
  seedTimedOutStore(storeRoot)
  const layer: StoreLayer = { root: storeRoot, scope: "account-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).not.toContain("Timed-out sessions")
})

test("buildProposerPrompt: project-global scope -> 'Timed-out sessions' note IS present (project layers keep it)", () => {
  const worktree = tmpDir("worktree-to-proj")
  const storeRoot = tmpDir("store-to-proj")
  seedTimedOutStore(storeRoot)
  const layer: StoreLayer = { root: storeRoot, scope: "project-global", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).toContain("Timed-out sessions")
  expect(prompt).toContain("resource-limit")
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

// ── W1b: slow-pass visibility — SLOW-PASS marker on trace lines ──────────────

test("buildProposerContext: passing session with elapsed >= 0.5 * budget renders SLOW-PASS marker", () => {
  const storeRoot = tmpDir("store-slowpass")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 1, nFail: 0,
    sessions: [{
      sessionID: "ses_slowpass", passed: true, turnCount: 5, elapsed: 350.5,
      agentTimeout: 600, env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "slow pass",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("SLOW-PASS")
  expect(context).toContain("350.5")
  expect(context).toContain("600")
})

// Negative case: passed but elapsed < 0.5 * budget → no SLOW-PASS marker
test("buildProposerContext: passing session with elapsed < 0.5 * budget renders unchanged, no SLOW-PASS marker", () => {
  const storeRoot = tmpDir("store-no-slowpass")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 1, nFail: 0,
    sessions: [{
      sessionID: "ses_quickpass", passed: true, turnCount: 3, elapsed: 100.0,
      agentTimeout: 600, env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "quick pass",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).not.toContain("SLOW-PASS")
})

// Back-compat: passed session with no elapsed field → no SLOW-PASS marker (graceful fallback)
test("buildProposerContext: passing session with no elapsed field renders unchanged, no SLOW-PASS marker", () => {
  const storeRoot = tmpDir("store-no-elapsed")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 1, nFail: 0,
    sessions: [{
      sessionID: "ses_no_elapsed", passed: true, turnCount: 3,
      agentTimeout: 600, env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "no elapsed",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).not.toContain("SLOW-PASS")
})

// Loop-3 pre-flip fix #1 (extended to SLOW-PASS): SLOW-PASS marker's denominator must be the REAL per-task agent timeout (agentTimeout), not run-level env.maxAgentTimeout
test("buildProposerContext: SLOW-PASS marker with per-task agentTimeout renders THAT budget, not the run-level env.maxAgentTimeout", () => {
  const storeRoot = tmpDir("store-slowpass-pertask")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 1, nFail: 0,
    sessions: [{
      sessionID: "ses_slowpass", passed: true, turnCount: 5, elapsed: 180.5,
      agentTimeout: 300, env: { maxAgentTimeout: 900 }, model: "m", variant: "", toolUsage: {}, summary: "slow pass",
      note: "", timestamp: "",
    }],
  }))

  const context = buildProposerContext(storeRoot, [])

  expect(context).toContain("SLOW-PASS")
  expect(context).toContain("180.5")
  expect(context).toContain("300")
  expect(context).not.toContain("900")
})

// ── W1b: slow-pass visibility — slowPassSection in proposer prompt ──────────

test("buildProposerPrompt: slow-pass sessions present -> 'Slow-pass sessions' section with top-5 sorted by elapsed", () => {
  const worktree = tmpDir("worktree-slowpass")
  const storeRoot = tmpDir("store-slowpass-section")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })

  // Six slow-pass sessions (all >= 0.5 * 600s budget), seeded in SHUFFLED
  // order so the section must actually sort by elapsed descending. The
  // slowest five must render in order; the sixth-slowest must be cut by the
  // .slice(0, 5) cap.
  const sessions = [
    { sessionID: "ses_sp_d", passed: true, turnCount: 5, elapsed: 440.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } },
    { sessionID: "ses_sp_a", passed: true, turnCount: 5, elapsed: 590.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } },
    { sessionID: "ses_sp_f", passed: true, turnCount: 5, elapsed: 320.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } }, // 6th-slowest — must be cut
    { sessionID: "ses_sp_b", passed: true, turnCount: 5, elapsed: 550.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } },
    { sessionID: "ses_sp_e", passed: true, turnCount: 5, elapsed: 380.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } },
    { sessionID: "ses_sp_c", passed: true, turnCount: 5, elapsed: 500.5, agentTimeout: 600, env: { maxAgentTimeout: 600 } },
  ]
  fs.writeFileSync(
    path.join(dir, "score.json"),
    JSON.stringify({
      version: "v1", nPass: 6, nFail: 0,
      sessions: sessions.map((s) => ({
        ...s,
        model: "m", variant: "", toolUsage: {}, summary: "slow pass",
        note: "", timestamp: "",
      })),
    }),
  )

  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).toContain("Slow-pass sessions")
  // Relative order: elapsed descending (a=590.5 > b=550.5 > c=500.5 > d=440.5 > e=380.5)
  const iA = prompt.indexOf("ses_sp_a")
  const iB = prompt.indexOf("ses_sp_b")
  const iC = prompt.indexOf("ses_sp_c")
  const iD = prompt.indexOf("ses_sp_d")
  const iE = prompt.indexOf("ses_sp_e")
  expect(iA).toBeGreaterThan(-1)
  expect(iB).toBeGreaterThan(iA)
  expect(iC).toBeGreaterThan(iB)
  expect(iD).toBeGreaterThan(iC)
  expect(iE).toBeGreaterThan(iD)
  expect(prompt).toContain("590.5")
  // Top-5 cap: the 6th-slowest session must be absent
  expect(prompt).not.toContain("ses_sp_f")
})

// Negative case: no slow-pass sessions → section must be absent entirely
test("buildProposerPrompt: no slow-pass sessions -> 'Slow-pass sessions' section omitted", () => {
  const worktree = tmpDir("worktree-noslowpass")
  const storeRoot = tmpDir("store-noslowpass")
  writeActive(storeRoot, "v1", "- some rule", "")
  seedCandidate(storeRoot, "v1", { nPass: 1, nFail: 1, trajFiles: 1 })

  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).not.toContain("Slow-pass sessions")
})

// The section itself is NOT project-gated, but the agent-config/env-policy ops
// pointer inside it IS — those op sections are offered only at project layers,
// so at account scope the sentence would dangle at ops the proposer can't use
// (the same misdirection timedOutSection's project gate exists to avoid).
test("buildProposerPrompt: slow-pass section at account scope renders WITHOUT the agent-config/env-policy ops pointer", () => {
  const worktree = tmpDir("worktree-slowpass-acct")
  const storeRoot = tmpDir("store-slowpass-acct")
  writeActive(storeRoot, "v1", "- some rule", "")
  const dir = path.join(storeRoot, "candidates", "v1")
  fs.mkdirSync(path.join(dir, "traj"), { recursive: true })
  fs.writeFileSync(path.join(dir, "score.json"), JSON.stringify({
    version: "v1", nPass: 1, nFail: 0,
    sessions: [{
      sessionID: "ses_sp_acct", passed: true, turnCount: 5, elapsed: 550.5,
      agentTimeout: 600, env: { maxAgentTimeout: 600 }, model: "m", variant: "", toolUsage: {}, summary: "slow pass",
      note: "", timestamp: "",
    }],
  }))

  const layer: StoreLayer = { root: storeRoot, scope: "account-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, worktree, null,
  )

  expect(prompt).toContain("Slow-pass sessions") // section not gated
  expect(prompt).toContain("ses_sp_acct")
  expect(prompt).not.toContain("agent-config.json") // ops pointer gated off
  expect(prompt).not.toContain("env-policy.json")
})
