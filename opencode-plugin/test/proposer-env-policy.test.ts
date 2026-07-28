import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { writeActive, type StoreLayer } from "../src/harness-store.ts"

// Token-free: exercises buildProposerPrompt's rendering directly — no opencode
// session, no LLM call. Confirms the env-policy staging section (Task C3)
// renders ONLY for project-scoped layers, never for account-scoped ones (an
// account-layer candidate is validated by bench `ab`, which runs the default
// `build` agent where the plugin is inert — an evolved env-policy there
// can never be measured).

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-proposer-envpolicy-${name}-`))
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

test("buildProposerPrompt: project-role layer renders the env-policy section with schema + bounds", () => {
  const worktree = tmpDir("worktree-proj")
  const storeRoot = tmpDir("store-proj")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  // Discriminating assertions — unique to the env-policy section, not generic
  // words (like "none") that also appear elsewhere in the prompt.
  expect(prompt).toContain("env-policy.json")
  expect(prompt).toContain("maxLsEntries")
  expect(prompt).toContain("[5, 100]")
  expect(prompt).toContain("lsPath")
  expect(prompt).toContain("languageProbes")
  expect(prompt).toContain(`["python3","gcc","g++","node","java","rustc","go"]`)
  expect(prompt).toContain("missing/incorrect ENVIRONMENT CONTEXT")

  const sp = stagingPaths(worktree, layer.scope, "v2")
  expect(prompt).toContain(path.relative(worktree, sp.envPolicy))
})

test("buildProposerPrompt: project-global layer shows the current effective env-policy when present", () => {
  const worktree = tmpDir("worktree-proj2")
  const storeRoot = tmpDir("store-proj2")
  writeActive(storeRoot, "v1", "- some rule", "", undefined, undefined, { schemaVersion: 1, maxLsEntries: 40 })
  const layer: StoreLayer = { root: storeRoot, scope: "project-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("env-policy.json")
  expect(prompt).toContain(`"maxLsEntries": 40`)
})

test("buildProposerPrompt: account-global layer OMITS the env-policy section entirely", () => {
  const worktree = tmpDir("worktree-acct")
  const storeRoot = tmpDir("store-acct")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).not.toContain("env-policy.json")
  expect(prompt).not.toContain("maxLsEntries")
  expect(prompt).not.toContain("missing/incorrect ENVIRONMENT CONTEXT")
})

test("buildProposerPrompt: account-role layer OMITS the env-policy section entirely", () => {
  const worktree = tmpDir("worktree-acct2")
  const storeRoot = tmpDir("store-acct2")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "account-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).not.toContain("env-policy.json")
  expect(prompt).not.toContain("maxLsEntries")
})
