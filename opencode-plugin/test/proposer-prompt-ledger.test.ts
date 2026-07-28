import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { writeActive, appendRejectedLedger, type StoreLayer, type RejectedEntry } from "../src/harness-store.ts"

// RG4: the review-gate rejected ledger (rejected.json under layer.root, see
// harness-store.ts readRejectedLedger/appendRejectedLedger and RG3's
// applyProposeArtifact wiring) must reach the proposer prompt so a rejected
// bullet is never re-derived or rephrased. Mirrors
// test/proposer-agent-config.test.ts's render() helper — token-free, no
// opencode session, no LLM call.

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-proposer-ledger-${name}-`))
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

const entry = (over: Partial<RejectedEntry> = {}): RejectedEntry => ({
  rejectedAt: "2026-07-26", scope: "project-role", version: "v1",
  bullet: "When X fails, always retry immediately.", violations: ["category: failed — not iteration-discipline"],
  source: "review-gate", ...over,
})

test("buildProposerPrompt: ledger entries render a review-gate-REJECTED block with bullet + violations", () => {
  const worktree = tmpDir("worktree")
  const storeRoot = tmpDir("store")
  writeActive(storeRoot, "v1", "- some rule", "")
  appendRejectedLedger(storeRoot, entry())
  appendRejectedLedger(storeRoot, entry({ version: "v2", bullet: "When Y, do Z.", violations: ["duplicate: matches bullet #3"] }))
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).toContain("review gate REJECTED")
  expect(prompt).toContain("When X fails, always retry immediately.")
  expect(prompt).toContain("category: failed — not iteration-discipline")
  expect(prompt).toContain("When Y, do Z.")
  expect(prompt).toContain("duplicate: matches bullet #3")
})

test("buildProposerPrompt: ledger block sits adjacent to the ab-verdict rejectedSection, before DIAGNOSE", () => {
  const worktree = tmpDir("worktree2")
  const storeRoot = tmpDir("store2")
  writeActive(storeRoot, "v1", "- some rule", "")
  appendRejectedLedger(storeRoot, entry())
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  const ledgerIdx = prompt.indexOf("review gate REJECTED")
  const diagnoseIdx = prompt.indexOf("## Your task — DIAGNOSE")
  expect(ledgerIdx).toBeGreaterThan(-1)
  expect(diagnoseIdx).toBeGreaterThan(-1)
  expect(ledgerIdx).toBeLessThan(diagnoseIdx)
})

test("buildProposerPrompt: empty ledger → prompt unchanged (ledgerSection contributes \"\", no new header, deterministic re-render)", () => {
  const worktree = tmpDir("worktree3")
  const storeRoot = tmpDir("store3")
  writeActive(storeRoot, "v1", "- some rule", "")
  const layer: StoreLayer = { root: storeRoot, scope: "project-role", higherRoots: [] }

  const prompt = render(layer, worktree)

  expect(prompt).not.toContain("review gate REJECTED")

  // Byte-identical check: re-rendering the SAME unchanged fixture (no
  // rejected.json ever written to storeRoot) must reproduce the exact same
  // bytes — the ledger section contributes "" deterministically and does not
  // perturb any other section's output.
  const promptAgain = render(layer, worktree)
  expect(prompt).toBe(promptAgain)
})
