import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  buildProposerPrompt,
  buildPromotePrompt,
  buildCuratePrompt,
  triggerPropose,
} from "../src/propose.ts"
import { writeActive, type StoreLayer, type Playbook } from "../src/harness-store.ts"
import type { HarnessHost, StagedArtifactDescriptor } from "../src/host.ts"

// Daemon carrier migration T5 — coverage for T1's json-reply outputMode fork
// (buildProposerPrompt/buildPromotePrompt/buildCuratePrompt in propose.ts) and
// T4's CC-path wiring (triggerPropose). NOT in scope: proposer-worker.ts's own
// cycle tests (a separate file/session owns test/proposer-worker.test.ts).
//
// Reply-format heading text, verbatim from propose.ts (jsonResultsTail /
// buildPromotePrompt / buildCuratePrompt) — asserted against this constant so
// a future rewording of the heading breaks exactly one place in this file.
const REPLY_FORMAT_HEADING = "## Reply format — respond with ONE JSON object and NOTHING else"
const STORE_ACCESS_HEADING = "## Store access — read the archive before diagnosing"
const HEREDOC_WRITE_HEADING = "## Write the results"

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-json-mode-${name}-`))
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

function fixturePlaybook(): Playbook {
  return {
    schemaVersion: 1,
    nextId: 2,
    bullets: [{
      id: "b1", text: "When a test fails, re-read the assertion.",
      helpful: 0, harmful: 0, addedBy: "v0", status: "active",
      createdAt: "2026-07-16T00:00:00Z", updatedAt: "2026-07-16T00:00:00Z",
    }],
  }
}

// ── 1. JSON-mode prompt goldens ──────────────────────────────────────────────

// buildProposerPrompt — legacy (non-playbook) mode.
test("buildProposerPrompt json-reply, non-playbook: reply-format section present with \"system\" REQUIRED field", () => {
  const worktree = tmpDir("wt-a1")
  const storeRoot = tmpDir("store-a1")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, null, "", [], "json-reply",
  )

  expect(prompt).toContain(REPLY_FORMAT_HEADING)
  expect(prompt).toContain(`"system"\` — REQUIRED: the improved`)
})

test("buildProposerPrompt json-reply, playbook mode: reply-format section present with \"ops\" REQUIRED field", () => {
  const worktree = tmpDir("wt-a2")
  const storeRoot = tmpDir("store-a2")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, fixturePlaybook(), "", [], "json-reply",
  )

  expect(prompt).toContain(REPLY_FORMAT_HEADING)
  expect(prompt).toContain(`"ops"\` — REQUIRED:`)
})

test("buildProposerPrompt json-reply: no bash heredoc blocks (no \"cat >\", no ENDOF markers), playbook + project-scope agent-config/env-policy sections included", () => {
  const worktree = tmpDir("wt-a3")
  const storeRoot = tmpDir("store-a3")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, fixturePlaybook(), "", [], "json-reply",
  )

  // Sanity: the optional agentConfig/envPolicy sections ARE present (they're
  // the sections most likely to still carry a heredoc if the fork missed a
  // branch), so the heredoc-absence assertion below is non-trivial.
  expect(prompt).toContain("agent-config.json")
  expect(prompt).toContain("env-policy.json")
  expect(prompt).not.toContain("cat >")
  expect(prompt).not.toContain("ENDOF")
})

test("buildProposerPrompt json-reply: \"## Store access\" section absent", () => {
  const worktree = tmpDir("wt-a4")
  const storeRoot = tmpDir("store-a4")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const prompt = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, null, "", [], "json-reply",
  )

  expect(prompt).not.toContain(STORE_ACCESS_HEADING)
  expect(prompt).not.toContain("## Store access")
})

test("buildProposerPrompt: staging-files output is byte-identical with an explicit \"staging-files\" arg vs. omitting outputMode entirely", () => {
  const worktree = tmpDir("wt-a5")
  const storeRoot = tmpDir("store-a5")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const sp = stagingPaths(worktree, layer.scope, "v2")

  const withDefault = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, fixturePlaybook(),
  )
  const explicit = buildProposerPrompt(
    layer, "v2", "", sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy,
    worktree, fixturePlaybook(), "", [], "staging-files",
  )

  expect(explicit).toBe(withDefault)
  expect(explicit).toContain(HEREDOC_WRITE_HEADING)
})

// buildPromotePrompt

test("buildPromotePrompt json-reply: reply-format section present with \"system\" REQUIRED field, no heredoc, no store-access", () => {
  const worktree = tmpDir("wt-b1")
  const srcRoot = tmpDir("store-b1-src")
  const tgtRoot = tmpDir("store-b1-tgt")
  writeActive(srcRoot, "v1", "- proven project rule", "")
  const source: StoreLayer = { root: srcRoot, scope: "project-role", higherRoots: [] }
  const target: StoreLayer = { root: tgtRoot, scope: "account-role", higherRoots: [] }
  const stagingSystem = path.join(worktree, ".kkamak", "staging", "promote-account-role-v1-system.md")
  const stagingTools = path.join(worktree, ".kkamak", "staging", "promote-account-role-v1-tools.md")

  const prompt = buildPromotePrompt(source, target, "v1", stagingSystem, stagingTools, worktree, "json-reply")

  expect(prompt).toContain(REPLY_FORMAT_HEADING)
  expect(prompt).toContain(`"system"\` — REQUIRED: the complete merged`)
  expect(prompt).not.toContain("cat >")
  expect(prompt).not.toContain("ENDOF")
  expect(prompt).not.toContain(STORE_ACCESS_HEADING)
})

test("buildPromotePrompt: staging-files output is byte-identical with an explicit arg vs. omitted outputMode", () => {
  const worktree = tmpDir("wt-b2")
  const srcRoot = tmpDir("store-b2-src")
  const tgtRoot = tmpDir("store-b2-tgt")
  writeActive(srcRoot, "v1", "- proven project rule", "")
  const source: StoreLayer = { root: srcRoot, scope: "project-role", higherRoots: [] }
  const target: StoreLayer = { root: tgtRoot, scope: "account-role", higherRoots: [] }
  const stagingSystem = path.join(worktree, ".kkamak", "staging", "promote-account-role-v1-system.md")
  const stagingTools = path.join(worktree, ".kkamak", "staging", "promote-account-role-v1-tools.md")

  const withDefault = buildPromotePrompt(source, target, "v1", stagingSystem, stagingTools, worktree)
  const explicit = buildPromotePrompt(source, target, "v1", stagingSystem, stagingTools, worktree, "staging-files")

  expect(explicit).toBe(withDefault)
  expect(explicit).toContain(HEREDOC_WRITE_HEADING)
})

// buildCuratePrompt

test("buildCuratePrompt json-reply: reply-format section present with ops shape, no heredoc, no store-access", () => {
  const worktree = tmpDir("wt-c1")
  const storeRoot = tmpDir("store-c1")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const stagingOps = path.join(worktree, ".kkamak", "staging", "curate-project-role-v2-ops.json")

  const prompt = buildCuratePrompt(layer, fixturePlaybook(), stagingOps, worktree, "json-reply")

  expect(prompt).toContain(REPLY_FORMAT_HEADING)
  // Curate's json shape example names the "ops" field directly (no separate
  // "REQUIRED" keyword in this builder — see buildCuratePrompt in propose.ts).
  expect(prompt).toContain(`{"ops":[`)
  expect(prompt).not.toContain("cat >")
  expect(prompt).not.toContain("ENDOF")
  expect(prompt).not.toContain(STORE_ACCESS_HEADING)
})

test("buildCuratePrompt: staging-files output is byte-identical with an explicit arg vs. omitted outputMode", () => {
  const worktree = tmpDir("wt-c2")
  const storeRoot = tmpDir("store-c2")
  writeActive(storeRoot, "v1", "- baseline", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }
  const stagingOps = path.join(worktree, ".kkamak", "staging", "curate-project-role-v2-ops.json")

  const withDefault = buildCuratePrompt(layer, fixturePlaybook(), stagingOps, worktree)
  const explicit = buildCuratePrompt(layer, fixturePlaybook(), stagingOps, worktree, "staging-files")

  expect(explicit).toBe(withDefault)
  expect(explicit).toContain(HEREDOC_WRITE_HEADING)
  // staging-files mode DOES call buildStoreAccessSection for curate (unlike
  // json-reply mode) — confirms the two branches genuinely diverge, not just
  // on the reply-format heading.
  expect(explicit).toContain(STORE_ACCESS_HEADING)
})

// ── 2/3. triggerPropose wiring: CC path vs. opencode path ──────────────────

let home: string
let worktree: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-json-mode-home-"))
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mh-json-mode-wt-"))
  process.env["META_HARNESS_HOME"] = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
})

interface Rec { notes: string[]; logs: string[] }
interface Captured {
  opts?: { title: string; prompt: string; model?: unknown; system?: string; stagingPaths?: unknown; timeoutMs?: number }
  promptFileExistedAtCallTime?: boolean
  promptFileContentsAtCallTime?: string
}

function baseHostFields(rec: Rec): Omit<HarnessHost, "runTaskAgent"> {
  return {
    platform: "test",
    projectRoot: worktree,
    log: (_l, m) => { rec.logs.push(m) },
    notify: (m) => { rec.notes.push(m) },
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  } as Omit<HarnessHost, "runTaskAgent">
}

/** The default proposerTimeoutMin (no config.json under the freshly-isolated
 * META_HARNESS_HOME) — see harness-store.ts's DEFAULT_PROPOSER_TIMEOUT_MIN. */
const DEFAULT_PROPOSER_TIMEOUT_MS = 20 * 60 * 1000

test("triggerPropose (CC path): runTaskAgent receives non-empty system, correctly-shaped absolute stagingPaths, and cfg-derived timeoutMs; prompt.md is staged BEFORE runTaskAgent resolves with matching content and the json reply-format section", async () => {
  const root = path.join(home, "stores", "cc-wiring")
  writeActive(root, "v1", "- baseline", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }
  const stagingDir = path.join(worktree, ".kkamak", "staging")
  fs.mkdirSync(stagingDir, { recursive: true })

  const cap: Captured = {}
  const rec: Rec = { notes: [], logs: [] }
  let staged: StagedArtifactDescriptor | undefined
  const host: HarnessHost = {
    ...baseHostFields(rec),
    stageArtifactApply: (d) => { staged = d },
    runTaskAgent: async (opts) => {
      cap.opts = opts
      // Capture the prompt.md staging state SYNCHRONOUSLY inside the call,
      // i.e. strictly before this promise resolves — triggerPropose writes
      // it just before invoking runTaskAgent (propose.ts, CC-path-only branch).
      const promptPath = path.join(stagingDir, `${layer.scope}-v1-prompt.md`)
      cap.promptFileExistedAtCallTime = fs.existsSync(promptPath)
      cap.promptFileContentsAtCallTime = cap.promptFileExistedAtCallTime
        ? fs.readFileSync(promptPath, "utf-8")
        : undefined
      return { id: "cc-child-1" }
    },
  } as HarnessHost

  await triggerPropose(host, worktree, layer)

  expect(cap.opts).toBeDefined()
  expect(cap.opts!.system).toBeTruthy()
  expect((cap.opts!.system as string).length).toBeGreaterThan(0)
  expect(cap.opts!.timeoutMs).toBe(DEFAULT_PROPOSER_TIMEOUT_MS)

  const sp = cap.opts!.stagingPaths as {
    kind: string; playbookMode: boolean
    system: string; tools: string; diagnosis: string; ops: string
    agentConfig: string; envPolicy: string; provenance: string
  }
  expect(sp.kind).toBe("propose")
  // writeActive seeds a non-empty active system.md, so seedPlaybook migrates
  // it into playbook mode — playbookMode must reflect that (true), not the
  // legacy default.
  expect(sp.playbookMode).toBe(true)
  for (const p of [sp.system, sp.tools, sp.diagnosis, sp.ops, sp.agentConfig, sp.envPolicy, sp.provenance]) {
    expect(path.isAbsolute(p)).toBe(true)
  }
  expect(sp.system).toBe(path.join(stagingDir, "project-role-v1-system.md"))
  expect(sp.ops).toBe(path.join(stagingDir, "project-role-v1-ops.json"))

  expect(cap.promptFileExistedAtCallTime).toBe(true)
  expect(cap.promptFileContentsAtCallTime).toBe(cap.opts!.prompt)
  expect(cap.opts!.prompt).toContain(REPLY_FORMAT_HEADING)

  // Sanity: CC path defers (stageArtifactApply present) — confirms this really
  // exercised the CC branch, not a fallback.
  expect(staged).toBeDefined()
  expect(staged!.kind).toBe("propose")
})

test("triggerPropose (opencode path, no stageArtifactApply): runTaskAgent's prompt carries the heredoc write section and NOT the json reply-format section; no prompt.md is written", async () => {
  const root = path.join(home, "stores", "oc-wiring")
  writeActive(root, "v1", "- baseline", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }
  const stagingDir = path.join(worktree, ".kkamak", "staging")
  fs.mkdirSync(stagingDir, { recursive: true })
  // Pre-seed the primary artifact (playbook mode → ops.json, seeded from the
  // non-empty baseline above) so triggerPropose's inline waitForFile returns
  // immediately instead of really waiting on cfg.proposerTimeoutMin.
  fs.writeFileSync(path.join(stagingDir, "project-role-v1-ops.json"), JSON.stringify({ ops: [] }))

  const cap: Captured = {}
  const rec: Rec = { notes: [], logs: [] }
  const host: HarnessHost = {
    ...baseHostFields(rec),
    // Deliberately NO stageArtifactApply / proposerInFlight — this is the
    // opencode-host shape; triggerPropose's isCC discriminator is false.
    runTaskAgent: async (opts) => {
      cap.opts = opts
      return { id: "oc-child-1" }
    },
  } as HarnessHost

  await triggerPropose(host, worktree, layer)

  expect(cap.opts).toBeDefined()
  expect(cap.opts!.prompt).toContain(HEREDOC_WRITE_HEADING)
  expect(cap.opts!.prompt).not.toContain(REPLY_FORMAT_HEADING)

  const promptPath = path.join(stagingDir, `${layer.scope}-v1-prompt.md`)
  expect(fs.existsSync(promptPath)).toBe(false)
})
