import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { readSnapshotAges } from "../src/snapshot-age.ts"

let dir: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-crank-snapshot-age-"))
})

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function write(host: string, file: string, lines: unknown[]): void {
  const hostDir = path.join(dir, host)
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(path.join(hostDir, file), lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
}

const DAY_MS = 24 * 60 * 60 * 1000
const NOW = 10_000 * DAY_MS // arbitrary large epoch so ageDays stays positive

test("readSnapshotAges: no evidence root at all -> []", () => {
  expect(readSnapshotAges(path.join(dir, "does-not-exist"), "~/z2/meta-harness", NOW)).toEqual([])
})

test("readSnapshotAges: evidence root exists but no host dirs -> []", () => {
  expect(readSnapshotAges(dir, "~/z2/meta-harness", NOW)).toEqual([])
})

test("readSnapshotAges: host dir exists but has no files for this repo's basename -> excluded", () => {
  write("office", "squad.gate-outcomes.ndjson", [{ ts: NOW - DAY_MS }])
  expect(readSnapshotAges(dir, "~/z2/meta-harness", NOW)).toEqual([])
})

test("readSnapshotAges: age computed from the MAX ts across both sensor files for the host", () => {
  write("office", "meta-harness.gate-outcomes.ndjson", [{ ts: NOW - 5 * DAY_MS }, { ts: NOW - 2 * DAY_MS }])
  write("office", "meta-harness.trial-arms.ndjson", [{ ts: NOW - 9 * DAY_MS }])
  const ages = readSnapshotAges(dir, "~/z2/meta-harness", NOW)
  expect(ages).toEqual([{ host: "office", ageDays: 2 }])
})

test("readSnapshotAges: only one sensor file present is still enough to compute an age", () => {
  write("office", "meta-harness.gate-outcomes.ndjson", [{ ts: NOW - 3 * DAY_MS }])
  const ages = readSnapshotAges(dir, "~/z2/meta-harness", NOW)
  expect(ages).toEqual([{ host: "office", ageDays: 3 }])
})

test("readSnapshotAges: multiple hosts, sorted by host name", () => {
  write("macbook", "meta-harness.gate-outcomes.ndjson", [{ ts: NOW - 1 * DAY_MS }])
  write("office", "meta-harness.gate-outcomes.ndjson", [{ ts: NOW - 4 * DAY_MS }])
  const ages = readSnapshotAges(dir, "~/z2/meta-harness", NOW)
  expect(ages).toEqual([
    { host: "macbook", ageDays: 1 },
    { host: "office", ageDays: 4 },
  ])
})

test("readSnapshotAges: malformed / missing-ts lines are skipped, never throw", () => {
  const hostDir = path.join(dir, "office")
  fs.mkdirSync(hostDir, { recursive: true })
  fs.writeFileSync(
    path.join(hostDir, "meta-harness.gate-outcomes.ndjson"),
    ["not json at all", JSON.stringify({ noTsField: true }), JSON.stringify({ ts: NOW - 6 * DAY_MS }), ""].join("\n"),
  )
  expect(() => readSnapshotAges(dir, "~/z2/meta-harness", NOW)).not.toThrow()
  expect(readSnapshotAges(dir, "~/z2/meta-harness", NOW)).toEqual([{ host: "office", ageDays: 6 }])
})

test("readSnapshotAges: uses NOW, not file mtime — an old mtime with a fresh ts still reads as fresh", () => {
  write("office", "meta-harness.gate-outcomes.ndjson", [{ ts: NOW - 0.5 * DAY_MS }])
  // Backdate the file's mtime far in the past to prove mtime is never consulted.
  const f = path.join(dir, "office", "meta-harness.gate-outcomes.ndjson")
  const longAgo = new Date(NOW - 400 * DAY_MS)
  fs.utimesSync(f, longAgo, longAgo)
  const ages = readSnapshotAges(dir, "~/z2/meta-harness", NOW)
  expect(ages).toEqual([{ host: "office", ageDays: 0.5 }])
})

test("readSnapshotAges: repo basename is derived from the repo path, not the full path", () => {
  write("office", "km-play.gate-outcomes.ndjson", [{ ts: NOW - 1 * DAY_MS }])
  expect(readSnapshotAges(dir, "/Users/yoo/z2/km-play", NOW)).toEqual([{ host: "office", ageDays: 1 }])
  expect(readSnapshotAges(dir, "~/z2/meta-harness", NOW)).toEqual([])
})
