import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"
import { recordToStores } from "../src/bench/record.ts"
import { parseRevalBlock } from "../src/bench/convention-audit.ts"

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

// KNOWN-HOLE(MH-21) — F3 2026-08-20: prompt-conformant cells carry
// units/derivations; parser demands bare numerics. Unskip when prompt and
// parser agree on one cell grammar.
//
// Cell quoted VERBATIM (via `rawAudit`) from
// docs/loop-probes/f3-cell-contract-20260820/out-O3-r2.json — one of the "4
// UNPARSED cells" the probe's verdict.md documents: `O3 emits five columns;
// parseRevalBlock requires exactly four, so the shipped parser rejects it by
// construction.` The O3 prompt is the one that told the model to show its
// derivation (with units, e.g. "nm^-1") in its own column — this cell is
// fully conformant to that prompt, and the parser still rejects it.
test.skip("KNOWN-HOLE(MH-21): a prompt-conformant derivation cell parses instead of going malformed", () => {
  const recordedCell = "REVALIDATION:\nTRANSFORM: reciprocal\nCONSTANT: 5320000\nDELTA: 5\n| input | computed | canonical | derivation | discriminates |\n|---|---|---|---|---|\n| 5808.6 | 1580.4 | 1580 | 1/532 - 1/580.86 = 0.00187970 - 0.00172170 = 0.00015800 nm^-1; x1e7 = 1580.0 | MisreadingA_rawÅasCM1_falsified |\n| 6212.3 | 2699.9 | 2700 | 1/532 - 1/621.23 = 0.00187970 - 0.00160970 = 0.00027000 nm^-1; x1e7 = 2700.0 | MisreadingB_treatAsNM_falsified |"

  const parsed = parseRevalBlock(recordedCell)

  // DESIRED: the prompt told the model to emit exactly this shape (a
  // derivation column carrying its own units); the parser should read it as
  // a claim, not reject it as malformed.
  expect(parsed.kind).toBe("claim")
})
