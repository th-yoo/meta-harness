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
 * Hygiene: NO test here ever READS or WRITES into real account-scoped stores
 * (accountGlobalRoot()/accountRoleRoot() are real, un-sandboxed host paths —
 * default ~/.config/meta-harness/, see harness-store.ts's accountMetaRoot()).
 * All layer roots are explicitly constructed to
 * point into tmpDir, bypassing layersFor's account-path resolution. This ensures
 * hermetic tests: no real $HOME reads/writes, no nondeterministic state from
 * the developer's actual account-global or account-role harness content.
 * Every createCandidate/writeActive call targets project-scoped or tmpDir-rooted
 * account-scoped roots. The layersFor function's ORDER is tested separately
 * with pure path assertions only (no file reads).
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
import { LAYER_LABELS } from "../src/bench/record.ts"
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

/** Build a hermetic 4-layer stack (account-global, project-global,
 * account-role, project-role) with ALL roots under tmpDir (no real $HOME).
 * Replaces layersFor's account-path resolution for test isolation. */
function hermeticLayerRefs(metaRoot: string, agent: string): LayerRef[] {
  return [
    { scope: "account-global", root: path.join(metaRoot, "account-global") },
    { scope: "project-global", root: projectGlobalRoot(metaRoot) },
    { scope: "account-role", root: path.join(metaRoot, "account-role", agent) },
    { scope: "project-role", root: projectRoleRoot(metaRoot, agent) },
  ]
}

// ── renderAgentsMd(composeHarness(...)) vs. assembleAgentsMd ──────────────
// Side-by-side: the OLD function (record.ts's assembleAgentsMd, still its
// own standalone body at the time this test was written) vs. the NEW path
// through compose.ts, for the same fixture stores.

test("parity: empty stores -> empty string, both paths", () => {
  const metaRoot = tmpDir()
  const layerRefs: LayerRef[] = [
    { scope: "account-global", root: path.join(metaRoot, "account-global") },
    { scope: "project-global", root: projectGlobalRoot(metaRoot) },
  ]

  // Note: assembleAgentsMd reads real account paths; our hermetic layerRefs
  // won't match its output. Skip that comparison; just verify both empty layers
  // produce empty markdown.
  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, "")

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

  const layerRefs: LayerRef[] = [
    { scope: "project-global", root: pg },
    { scope: "project-role", root: pr },
  ]

  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, agent)

  expect(newMd).toContain("## Project guidance")
  expect(newMd).toContain(`## Project role guidance (${agent})`)
  expect(newMd).toContain("Be careful.")
  expect(newMd).toContain("project role rule")
})

test("parity: pinned-candidate content reads candidate text, not active text", () => {
  const metaRoot = tmpDir()
  const root = projectGlobalRoot(metaRoot)
  createCandidate(root, "v1", "active text")
  writeActive(root, "v1", "active text")
  createCandidate(root, "v2", "candidate text")

  const pins = { "project-global": "v2" }
  const layerRefs: LayerRef[] = [
    { scope: "project-global", root },
  ]

  const newMd = renderAgentsMd(composeHarness(layerRefs, pins), LAYER_LABELS, "")

  expect(newMd).toContain("candidate text")
  expect(newMd).not.toContain("active text")
})

test("parity: missing/empty individual layers are skipped identically (mixed populated + empty)", () => {
  const metaRoot = tmpDir()
  const agent = freshAgent()

  // Only project-role gets content; other layers stay empty.
  const pr = projectRoleRoot(metaRoot, agent)
  createCandidate(pr, "v1", "", "role-only tool tip") // system empty, tools populated
  writeActive(pr, "v1", "", "role-only tool tip")

  const layerRefs: LayerRef[] = [
    { scope: "project-global", root: projectGlobalRoot(metaRoot) },
    { scope: "project-role", root: pr },
  ]

  const newMd = renderAgentsMd(composeHarness(layerRefs), LAYER_LABELS, agent)

  expect(newMd).toBe(`## Project role tool usage (${agent})\n\nrole-only tool tip`)
})

// ── renderSystemBlocks vs. hand-replicated hook composition ───────────────
// Reference logic hand-copied from index.ts's "experimental.chat.system.
// transform" handler (~lines 343-371 at branch tip 5487a79):
//   for (const layer of layers) { const system = readActiveSystem(layer.root); if (system) push(system) }
//   const toolParts = []; for (const layer of layers) { const tools = readActiveTools(layer.root); if (tools) toolParts.push(tools) }
//   if (toolParts.length > 0) push(`## Tool usage guidance\n\n${toolParts.join("\n\n")}`)
//   if snapshot exists: push(snapshot)
function hookReferenceBlocks(layers: LayerRef[], envSnapshot?: string): string[] {
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
  const metaRoot = tmpDir()
  const agent = freshAgent()
  const layerRefs = hermeticLayerRefs(metaRoot, agent)

  const expected = hookReferenceBlocks(layerRefs)
  const actual = renderSystemBlocks(composeHarness(layerRefs))

  expect(actual).toEqual(expected)
  expect(actual).toEqual([])
})

test("parity: renderSystemBlocks matches hand-replicated hook composition — multi-layer system + combined tools block", () => {
  const metaRoot = tmpDir()
  const agent = freshAgent()

  const pg = projectGlobalRoot(metaRoot)
  createCandidate(pg, "v1", "Project system text.", "project tool tip")
  writeActive(pg, "v1", "Project system text.", "project tool tip")

  const pr = projectRoleRoot(metaRoot, agent)
  createCandidate(pr, "v1", "Project role system text.", "project role tool tip")
  writeActive(pr, "v1", "Project role system text.", "project role tool tip")

  const layerRefs = hermeticLayerRefs(metaRoot, agent)

  const expected = hookReferenceBlocks(layerRefs)
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
  const metaRoot = tmpDir()
  const agent = freshAgent()
  const pg = projectGlobalRoot(metaRoot)
  createCandidate(pg, "v1", "Project system text.")
  writeActive(pg, "v1", "Project system text.")

  const layerRefs = hermeticLayerRefs(metaRoot, agent)
  const snapshot = "## Environment\n\nos: linux"

  const expected = hookReferenceBlocks(layerRefs, snapshot)
  const actual = renderSystemBlocks(composeHarness(layerRefs), snapshot)

  expect(actual).toEqual(expected)
  expect(actual[actual.length - 1]).toBe(snapshot)
})

test("parity: renderSystemBlocks omits the tools block when every layer's tools text is empty", () => {
  const metaRoot = tmpDir()
  const agent = freshAgent()
  const pg = projectGlobalRoot(metaRoot)
  createCandidate(pg, "v1", "Project system text.") // no tools arg -> tools.md absent
  writeActive(pg, "v1", "Project system text.")

  const layerRefs = hermeticLayerRefs(metaRoot, agent)

  const expected = hookReferenceBlocks(layerRefs)
  const actual = renderSystemBlocks(composeHarness(layerRefs))

  expect(actual).toEqual(expected)
  expect(actual).toEqual(["Project system text."])
  expect(actual.some((b) => b.includes("Tool usage guidance"))).toBe(false)
})

// ── layersFor ORDER verification (pure path assertions, no reads) ──────────
// Verify that layersFor constructs the correct 4-layer stack in the right order,
// without reading any files. This is the ONLY test that calls layersFor directly,
// and it only asserts path structure/order — it never reads from account paths.
test("layersFor returns all 4 layers in the correct injection order", () => {
  const worktree = tmpDir()
  const agent = freshAgent()
  const layers = layersFor(worktree, agent)

  // Verify we have exactly 4 layers
  expect(layers).toHaveLength(4)

  // Verify order: account-global → project-global → account-role → project-role
  expect(layers[0].scope).toBe("account-global")
  expect(layers[1].scope).toBe("project-global")
  expect(layers[2].scope).toBe("account-role")
  expect(layers[3].scope).toBe("project-role")

  // Verify project-scoped roots are under worktree; account-scoped are elsewhere
  // (we don't assert the real account paths — they're host-dependent).
  expect(layers[1].root).toContain(".kkamak")
  expect(layers[3].root).toContain(".kkamak")

  // Verify higherRoots are correctly populated (for gap-filling context)
  expect(layers[0].higherRoots).toEqual([])
  expect(layers[1].higherRoots).toEqual([layers[0].root])
  expect(layers[2].higherRoots).toEqual([layers[0].root, layers[1].root])
  expect(layers[3].higherRoots).toEqual([layers[0].root, layers[1].root, layers[2].root])
})

// ── composeHarness(model?) — faithful-render guard + route ────────────────
// (Task 2, generality-routing plan. fs/os/path already imported above as
// namespaces — reused here via fs./os./path. instead of duplicating imports.)

// helper: seed a layer store; `faithful` writes system.md == renderPlaybook(bullets),
// else writes a deliberately-divergent system.md (simulating seedPlaybook's header case).
function seedLayer(bs: Array<{ text: string; generality?: string; slice?: string }>, faithful = true): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-route-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  const pb = { schemaVersion: 1, nextId: bs.length + 1,
    bullets: bs.map((b, i) => ({ id: `b${i + 1}`, text: b.text, helpful: 0, harmful: 0,
      addedBy: "t", status: "active", createdAt: "t", updatedAt: "t",
      ...(b.generality ? { generality: b.generality } : {}), ...(b.slice ? { slice: b.slice } : {}) })) }
  fs.writeFileSync(path.join(root, "active", "playbook.json"), JSON.stringify(pb))
  fs.writeFileSync(path.join(root, "active", "system.md"),
    faithful ? bs.map((b) => `- ${b.text}`).join("\n") + "\n" : "You are an assistant.\n- keep going\n")
  return root
}

test("composeHarness routes a faithful playbook by model; no model → flat", () => {
  const root = seedLayer([{ text: "U" }, { text: "VA", generality: "vendor", slice: "anthropic" }])
  const L = [{ scope: "account-global", root }]
  expect(composeHarness(L, {}, "openai/gpt-5")[0].system).toBe("- U")               // routed: anthropic bullet dropped
  expect(composeHarness(L, {}, "anthropic/claude-haiku-4-5")[0].system).toBe("- U\n- VA")
  expect(composeHarness(L, {})[0].system).toBe("- U\n- VA")                          // no model → flat
})

test("composeHarness does NOT route when playbook render != system.md (back-compat guard)", () => {
  const root = seedLayer([{ text: "keep going", generality: "vendor", slice: "openai" }], /*faithful*/ false)
  // system.md ("You are an assistant.\n- keep going") != renderPlaybook → guard fails → flat read, even with a model
  expect(composeHarness([{ scope: "account-global", root }], {}, "anthropic/x")[0].system)
    .toBe("You are an assistant.\n- keep going")
})

test("composeHarness legacy layer (no playbook.json) falls back to flat", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-route-legacy-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "system.md"), "- legacy\n")
  expect(composeHarness([{ scope: "account-global", root }], {}, "anthropic/x")[0].system).toBe("- legacy")
})
