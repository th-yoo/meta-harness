import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { writeActive, type StoreLayer } from "../src/harness-store.ts"

// Token-free: exercises buildProposerPrompt's rendering directly — no opencode
// session, no LLM call. Confirms the agent-config staging section (Task B3)
// renders ONLY for project-scoped layers, never for account-scoped ones (an
// account-layer candidate is validated by bench `ab`, which runs the default
// `build` agent where the plugin is inert — an evolved agent-config there
// can never be measured).

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-proposer-agentcfg-${name}-`))
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

test("buildProposerPrompt: project-role layer renders the agent-config section with schema + bounds", () => {
  const worktree = tmpDir("worktree-proj")
  const storeRoot = tmpDir("store-proj")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("Optional: agent-config.json")
  expect(prompt).toContain("fastTimeoutMs")
  expect(prompt).toContain("[500, 30000]")
  expect(prompt).toContain("extraFastCommands")
  expect(prompt).toContain("extraSlowCommands")
  expect(prompt).toContain("20 entries")
  expect(prompt).toContain("[a-z0-9._+-]{1,32}")
  expect(prompt).toContain("timeout / tool-latency problem")
  expect(prompt).toContain("none") // no current effective config seeded for this store

  const sp = stagingPaths(worktree, layer.scope, "v2")
  expect(prompt).toContain(path.relative(worktree, sp.agentConfig))
})

test("buildProposerPrompt: project-global layer shows the current effective agent-config when present", () => {
  const worktree = tmpDir("worktree-proj2")
  const storeRoot = tmpDir("store-proj2")
  writeActive(storeRoot, "v1", "- some rule", "", undefined, { schemaVersion: 1, fastTimeoutMs: 2000 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("Optional: agent-config.json")
  expect(prompt).toContain(`"fastTimeoutMs": 2000`)
})

test("buildProposerPrompt: account-global layer OMITS the agent-config section entirely", () => {
  const worktree = tmpDir("worktree-acct")
  const storeRoot = tmpDir("store-acct")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).not.toContain("agent-config.json")
  expect(prompt).not.toContain("fastTimeoutMs")
  expect(prompt).not.toContain("timeout / tool-latency problem")
})

test("buildProposerPrompt: account-role layer OMITS the agent-config section entirely", () => {
  const worktree = tmpDir("worktree-acct2")
  const storeRoot = tmpDir("store-acct2")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).not.toContain("agent-config.json")
  expect(prompt).not.toContain("fastTimeoutMs")
})
