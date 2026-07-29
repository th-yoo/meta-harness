/**
 * sensor-union.test.ts — §7 cross-host union verdict input (final review
 * item 3). Exercises unionRawLines directly against a tmp evidence-root
 * fixture mirroring scripts/km-sensors-sync.sh's export layout
 * (evidence/kkamak-sensors/<host>/<basename-of-repo>.<kind>.ndjson).
 */
import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

import { unionRawLines } from "../src/sensor-union.ts"

function tmpEvidenceRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-sensor-union-"))
}

function writeSnapshot(evidenceRoot: string, host: string, base: string, kind: string, lines: string[]): void {
  const dir = path.join(evidenceRoot, host)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, `${base}.${kind}.ndjson`), lines.join("\n") + "\n", "utf-8")
}

test("no evidenceRoot at all: union is exactly the live lines, deduped against themselves (identical to pre-union behavior)", () => {
  const evidenceRoot = path.join(os.tmpdir(), "km-sensor-union-does-not-exist-" + Date.now())
  const live = '{"a":1}\n{"a":1}\n{"a":2}\n'
  const out = unionRawLines(evidenceRoot, "/repo/meta-harness", "gate-outcomes", live)
  expect(out).toEqual(['{"a":1}', '{"a":2}'])
})

test("other-host snapshot lines reach the union — new lines not present live are appended", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "meta-harness", "gate-outcomes", ['{"a":1}', '{"a":2}'])
  const live = '{"a":1}\n' // this host has only seen the first line locally
  const out = unionRawLines(evidenceRoot, "/some/path/meta-harness", "gate-outcomes", live)
  expect(out).toEqual(['{"a":1}', '{"a":2}'])
})

test("a line present in both the live file and a snapshot counts once (dedupe by full raw-line identity)", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "meta-harness", "gate-outcomes", ['{"a":1}', '{"a":2}'])
  const live = '{"a":1}\n{"a":3}\n'
  const out = unionRawLines(evidenceRoot, "/x/meta-harness", "gate-outcomes", live)
  expect(out).toEqual(['{"a":1}', '{"a":3}', '{"a":2}'])
  expect(out.filter((l) => l === '{"a":1}').length).toBe(1)
})

test("multiple hosts union together, each contributing distinct lines", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "meta-harness", "gate-outcomes", ['{"a":1}'])
  writeSnapshot(evidenceRoot, "macbook", "meta-harness", "gate-outcomes", ['{"a":2}'])
  const out = unionRawLines(evidenceRoot, "/x/meta-harness", "gate-outcomes", "")
  expect(new Set(out)).toEqual(new Set(['{"a":1}', '{"a":2}']))
})

test("repo basename scoping: a snapshot file for a DIFFERENT repo's basename is never pulled in", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "squad", "gate-outcomes", ['{"other":true}'])
  const out = unionRawLines(evidenceRoot, "/x/meta-harness", "gate-outcomes", "")
  expect(out).toEqual([])
})

test("kind scoping: trial-arms snapshot lines never leak into a gate-outcomes union", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "meta-harness", "trial-arms", ['{"row":true}'])
  const out = unionRawLines(evidenceRoot, "/x/meta-harness", "gate-outcomes", "")
  expect(out).toEqual([])
})

test("blank lines in both live text and snapshot files are ignored", () => {
  const evidenceRoot = tmpEvidenceRoot()
  writeSnapshot(evidenceRoot, "office", "meta-harness", "gate-outcomes", ["", '{"a":1}', "  ", ""])
  const out = unionRawLines(evidenceRoot, "/x/meta-harness", "gate-outcomes", "\n\n")
  expect(out).toEqual(['{"a":1}'])
})
