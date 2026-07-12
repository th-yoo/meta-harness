/**
 * compose.test.ts — parity tests for src/compose.ts (Task L2).
 *
 * Two acceptance requirements from task-L2-brief.md:
 *  1. `renderAgentsMd(composeHarness(...))` is BYTE-IDENTICAL to bench/
 *     record.ts's `assembleAgentsMd` for multi-layer active content, pinned-
 *     candidate content, and empty/missing layers. Run side-by-side against
 *     the OLD assembleAgentsMd body (still un-refactored at the time these
 *     tests were first written — see task report) before it's made to
 *     delegate to compose.ts.
 *  2. `renderSystemBlocks` reproduces the exact array of strings index.ts's
 *     `experimental.chat.system.transform` hook pushes onto `output.system`
 *     today: each non-empty layer's system text (in layersFor order), then
 *     ONE combined "## Tool usage guidance" block from all non-empty layers'
 *     tools text, then (if present) a trailing env snapshot. Since the hook
 *     body is closure-bound to plugin input and can't be called directly,
 *     this file hand-replicates that composition (read straight from
 *     index.ts's "experimental.chat.system.transform" handler, lines
 *     ~343-371 as of branch tip 5487a79) as the reference, and asserts
 *     `renderSystemBlocks` matches it for the same fixture store.
 *
 * Hygiene: like bench-record.test.ts, no test here ever WRITES into an
 * account-scoped store (accountGlobalRoot()/accountRoleRoot() are real,
 * un-sandboxed host paths under ~/.config/opencode/ — writing there would
 * pollute the developer's real harness state). Every createCandidate/
 * writeActive call below targets a project-scoped root under a tmpDir.
 * Each test also uses a fresh random agent name so reading the (real,
 * host) account-role layer never collides with another agent's actual
 * data — layersFor's account-global/account-role reads are exercised for
 * real (unwritten) paths, which stay empty absent any real host state.
 */
import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import * as crypto from "node:crypto"
import {
  layersFor,
  createCandidate,
  writeActive,
  readActiveSystem,
  readActiveTools,
  projectGlobalRoot,
  projectRoleRoot,
} from "../src/harness-store.ts"
import { assembleAgentsMd, layerStoreRoots, LAYER_LABELS } from "../src/bench/record.ts"
import { composeHarness, renderAgentsMd, renderSystemBlocks, type LayerRef } from "../src/compose.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-compose-"))
}

/** A random per-test agent name, so layersFor's account-role read
 * (layersFor always includes it) never collides with any real host
 * account-role store — it's guaranteed to have no candidates/active dir. */
function freshAgent(): string {
  return `mh-compose-test-${crypto.randomBytes(6).toString("hex")}`
}

// ── renderAgentsMd(composeHarness(...)) vs. assembleAgentsMd ──────────────
// Side-by-side: the OLD function (record.ts's assembleAgentsMd, still its
// own standalone body at the time this test was written) vs. the NEW path
// through compose.ts, for the same fixture stores.

test("parity: empty stores -> empty string, both paths", () => {
  const metaRoot = tmpDir()
  const layerRefs: LayerRef[] = layerStoreRoots("project", "", metaRoot).map(([scope, root]) => ({ scope, root }))

  const oldMd = assembleAgentsMd("project", metaRoot)
  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, "")

  expect(newMd).toBe(oldMd)
  expect(newMd).toBe("")
})

test("parity: multi-layer active content (project-global + project-role), joined with labeled headings", () => {
  const metaRoot = tmpDir()
  const agent = freshAgent()

  const pg = projectGlobalRoot(metaRoot)
  createCandidate(pg, "v1", "Be careful.", "bash: use -e")
  writeActive(pg, "v1", "Be careful.", "bash: use -e")

  const pr = projectRoleRoot(metaRoot, agent)
  createCandidate(pr, "v1", "project role rule", "project role tool tip")
  writeActive(pr, "v1", "project role rule", "project role tool tip")

  const layerRefs: LayerRef[] = layerStoreRoots("project", agent, metaRoot).map(([scope, root]) => ({ scope, root }))

  const oldMd = assembleAgentsMd("project", metaRoot, agent)
  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, agent)

  expect(newMd).toBe(oldMd)
  expect(newMd).toContain("## Project guidance")
  expect(newMd).toContain(`## Project role guidance (${agent})`)
})

test("parity: pinned-candidate content reads candidate text, not active text", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v1", "active text")
  writeActive(root, "v1", "active text")
  createCandidate(root, "v2", "candidate text")

  const pins = { "project-global": "v2" }
  const layerRefs: LayerRef[] = layerStoreRoots("project", "", metaRoot).map(([scope, root]) => ({ scope, root }))

  const oldMd = assembleAgentsMd("project", metaRoot, "", pins)
  const newMd = renderAgentsMd(composeHarness(layerRefs, pins), LAYER_LABELS, "")

  expect(newMd).toBe(oldMd)
  expect(newMd).toContain("candidate text")
  expect(newMd).not.toContain("active text")
})

test("parity: missing/empty individual layers are skipped identically (mixed populated + empty)", () => {
  const metaRoot = tmpDir()
  const agent = freshAgent()

  // Only project-role gets content; account-global/project-global/account-role stay empty.
  const pr = projectRoleRoot(metaRoot, agent)
  createCandidate(pr, "v1", "", "role-only tool tip") // system empty, tools populated
  writeActive(pr, "v1", "", "role-only tool tip")

  const layerRefs: LayerRef[] = layerStoreRoots("global", agent, metaRoot).map(([scope, root]) => ({ scope, root }))

  const oldMd = assembleAgentsMd("global", metaRoot, agent)
  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, agent)

  expect(newMd).toBe(oldMd)
  expect(newMd).toBe(`## Project role tool usage (${agent})\n\nrole-only tool tip`)
})

// ── renderSystemBlocks vs. hand-replicated hook composition ───────────────
// Reference logic hand-copied from index.ts's "experimental.chat.system.
// transform" handler (~lines 343-371 at branch tip 5487a79):
//   for (const layer of layers) { const system = readActiveSystem(layer.root); if (system) push(system) }
//   const toolParts = []; for (const layer of layers) { const tools = readActiveTools(layer.root); if (tools) toolParts.push(tools) }
//   if (toolParts.length > 0) push(`## Tool usage guidance\n\n${toolParts.join("\n\n")}`)
//   if snapshot exists: push(snapshot)
function hookReferenceBlocks(worktree: string, agent: string, envSnapshot?: string): string[] {
  const layers = layersFor(worktree, agent)
  const blocks: string[] = []
  for (const layer of layers) {
    const system = readActiveSystem(layer.root)
    if (system) blocks.push(system)
  }
  const toolParts: string[] = []
  for (const layer of layers) {
    const tools = readActiveTools(layer.root)
    if (tools) toolParts.push(tools)
  }
  if (toolParts.length > 0) blocks.push(`## Tool usage guidance\n\n${toolParts.join("\n\n")}`)
  if (envSnapshot) blocks.push(envSnapshot)
  return blocks
}

test("parity: renderSystemBlocks matches hand-replicated hook composition — no content", () => {
  const worktree = tmpDir()
  const agent = freshAgent()
  const layerRefs: LayerRef[] = layersFor(worktree, agent).map((l) => ({ scope: l.scope, root: l.root }))

  const expected = hookReferenceBlocks(worktree, agent)
  const actual = renderSystemBlocks(composeHarness(layerRefs))

  expect(actual).toEqual(expected)
  expect(actual).toEqual([])
})

test("parity: renderSystemBlocks matches hand-replicated hook composition — multi-layer system + combined tools block", () => {
  const worktree = tmpDir()
  const agent = freshAgent()

  const pg = projectGlobalRoot(worktree)
  createCandidate(pg, "v1", "Project system text.", "project tool tip")
  writeActive(pg, "v1", "Project system text.", "project tool tip")

  const pr = projectRoleRoot(worktree, agent)
  createCandidate(pr, "v1", "Project role system text.", "project role tool tip")
  writeActive(pr, "v1", "Project role system text.", "project role tool tip")

  const layerRefs: LayerRef[] = layersFor(worktree, agent).map((l) => ({ scope: l.scope, root: l.root }))

  const expected = hookReferenceBlocks(worktree, agent)
  const actual = renderSystemBlocks(composeHarness(layerRefs))

  expect(actual).toEqual(expected)
  // Exact shape asserted directly (not just equality with the reference):
  // two system strings pushed in layer order, then ONE combined tools block.
  expect(actual).toEqual([
    "Project system text.",
    "Project role system text.",
    "## Tool usage guidance\n\nproject tool tip\n\nproject role tool tip",
  ])
})

test("parity: renderSystemBlocks appends the env snapshot last when present", () => {
  const worktree = tmpDir()
  const agent = freshAgent()
  const pg = projectGlobalRoot(worktree)
  createCandidate(pg, "v1", "Project system text.")
  writeActive(pg, "v1", "Project system text.")

  const layerRefs: LayerRef[] = layersFor(worktree, agent).map((l) => ({ scope: l.scope, root: l.root }))
  const snapshot = "## Environment\n\nos: linux"

  const expected = hookReferenceBlocks(worktree, agent, snapshot)
  const actual = renderSystemBlocks(composeHarness(layerRefs), snapshot)

  expect(actual).toEqual(expected)
  expect(actual[actual.length - 1]).toBe(snapshot)
})

test("parity: renderSystemBlocks omits the tools block when every layer's tools text is empty", () => {
  const worktree = tmpDir()
  const agent = freshAgent()
  const pg = projectGlobalRoot(worktree)
  createCandidate(pg, "v1", "Project system text.") // no tools arg -> tools.md absent
  writeActive(pg, "v1", "Project system text.")

  const layerRefs: LayerRef[] = layersFor(worktree, agent).map((l) => ({ scope: l.scope, root: l.root }))

  const expected = hookReferenceBlocks(worktree, agent)
  const actual = renderSystemBlocks(composeHarness(layerRefs))

  expect(actual).toEqual(expected)
  expect(actual).toEqual(["Project system text."])
  expect(actual.some((b) => b.includes("Tool usage guidance"))).toBe(false)
})
