import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { exportRuleChecks } from "../src/rule-checks-export.ts"
import { exportHookRules } from "../src/hook-rules-export.ts"

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
