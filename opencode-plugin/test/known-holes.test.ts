import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"
import { recordToStores } from "../src/bench/record.ts"

// KNOWN-HOLE(MH-1) — census: docs/loop-probes/debt-instrument-20260822/census.md.
// Single-layer exporters are last-writer-wins: a transition on a layer with no
// checks/rules (project-global here) wipes the .km tables another layer
// (mh-build) just populated. Unskip when exports become union-across-layers or
// otherwise clobber-safe; this test then pins the fix.
test.skip("KNOWN-HOLE(MH-1): project-global export preserves another layer's .km tables", () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh1-"))
  const mkStore = (bullets: unknown[]) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh1-store-"))
    fs.mkdirSync(path.join(root, "active"), { recursive: true })
    fs.writeFileSync(path.join(root, "active", "playbook.json"),
      JSON.stringify({ schemaVersion: 1, nextId: 99, bullets }))
    return root
  }
  const mhBuild = mkStore([{ id: "b1", text: "When X, do Y.", helpful: 0, harmful: 0,
    addedBy: "v1", status: "active", createdAt: "2026-08-22T00:00:00Z",
    check: { cmd: "true", timeoutMs: 1000, state: "shadow", liveEligible: true } }])
  const pg = mkStore([]) // project-global: no checks, no rules — the wiping layer
  exportRuleChecks(repo, mhBuild)
  const before = JSON.parse(fs.readFileSync(path.join(repo, ".km", "rule-checks.json"), "utf8"))
  expect(before.rules).toHaveLength(1)
  // the transition event on the other layer:
  exportRuleChecks(repo, pg)
  exportHookRules(repo, pg)
  const after = JSON.parse(fs.readFileSync(path.join(repo, ".km", "rule-checks.json"), "utf8"))
  expect(after.rules).toHaveLength(1) // DESIRED: mh-build's check survives
})

// Recursively finds every *.ndjson file under any "traj" directory below `root`.
function findTrajFiles(root: string): string[] {
  const found: string[] = []
  const walk = (dir: string) => {
    let entries: fs.Dirent[]
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const e of entries) {
      const p = path.join(dir, e.name)
      if (e.isDirectory()) {
        walk(p)
      } else if (e.isFile() && dir.endsWith(`${path.sep}traj`) && e.name.endsWith(".ndjson")) {
        found.push(p)
      }
    }
  }
  walk(root)
  return found
}

// KNOWN-HOLE(MH-3) — census row MH-3; measured 2026-08-20 (resume.md warning
// block): layers="none" makes layerStoreRoots return [], so the traj write
// inside the store loop never executes — --save-all-traj silently no-ops and
// mechanism evidence is unrecoverable. Unskip when record.ts persists
// trajectories independently of layer stores (or refuses the combination
// loudly); this test then pins the fix.
test.skip("KNOWN-HOLE(MH-3): layers=none with saveAllTraj still persists the trajectory somewhere", () => {
  const metaRoot = fs.mkdtempSync(path.join(os.tmpdir(), "mh-hole-mh3-"))
  const events = [{ t: "text" as const, text: "hi" }]

  let threwLoudly = false
  try {
    recordToStores("t", "sess-mh3", true, 2, {}, "m", "", "none", metaRoot, false, "", {}, {}, events, true)
  } catch {
    threwLoudly = true
  }

  const trajFilesFound = findTrajFiles(metaRoot).length
  expect(trajFilesFound > 0 || threwLoudly).toBe(true)
})
