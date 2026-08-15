// Token-free: pins the hookRule contract into the proposer prompt (both
// output modes) — the pipeline is inert unless the proposer is TAUGHT the
// op format, so this test is what keeps the teaching from regressing.
import { expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildProposerPrompt } from "../src/propose.ts"
import type { Playbook, StoreLayer } from "../src/harness-store.ts"

function tmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`))
}

function seedStore(storeRoot: string): void {
  mkdirSync(join(storeRoot, "active"), { recursive: true })
  writeFileSync(join(storeRoot, "active", "system.md"), "- some rule\n")
  writeFileSync(join(storeRoot, "active", ".version"), "v1")
}

const PB: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] }

function render(outputMode?: "staging-files" | "json-reply"): string {
  const worktree = tmpDir("hrp-worktree")
  const storeRoot = tmpDir("hrp-store")
  seedStore(storeRoot)
  const layer: StoreLayer = { root: storeRoot, scope: "project-global", higherRoots: [] }
  const base = join(worktree, ".kkamak", "staging")
  const sp = (f: string) => join(base, `project-global-v2-${f}`)
  return buildProposerPrompt(
    layer, "v2", "", sp("system.md"), sp("tools.md"), sp("diagnosis.json"), sp("ops.json"),
    sp("agent-config.json"), sp("env-policy.json"), worktree, PB, "", [],
    ...(outputMode ? [outputMode] : []),
  )
}

test("staging-files prompt teaches the hookRule op contract", () => {
  const p = render("staging-files")
  expect(p).toContain('"hookRule"')
  expect(p).toContain('"toolMatcher"')
  expect(p).toContain('"inputPattern"')
  expect(p).toContain("NEVER include a \"mode\" key")
  expect(p).toContain("portable subset")
})

test("json-reply prompt carries the same contract", () => {
  const p = render("json-reply")
  expect(p).toContain('"hookRule"')
  expect(p).toContain("NEVER include a \"mode\" key")
})
