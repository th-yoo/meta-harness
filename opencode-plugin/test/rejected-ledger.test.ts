import { test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readRejectedLedger, appendRejectedLedger, type RejectedEntry } from "../src/harness-store.ts"

let root: string
beforeEach(() => { root = mkdtempSync(join(tmpdir(), "ledger-")) })
afterEach(() => { rmSync(root, { recursive: true, force: true }) })

const entry = (over: Partial<RejectedEntry> = {}): RejectedEntry => ({
  rejectedAt: "2026-07-26", scope: "project-role", version: "v3",
  bullet: "When X, do Y.", violations: ["category: failed"], source: "review-gate", ...over,
})

test("read: missing file → []", () => expect(readRejectedLedger(root)).toEqual([]))
test("read: corrupt file → []", () => {
  writeFileSync(join(root, "rejected.json"), "{nope")
  expect(readRejectedLedger(root)).toEqual([])
})
test("append creates then accumulates", () => {
  appendRejectedLedger(root, entry())
  appendRejectedLedger(root, entry({ version: "v4", bullet: "When Z, do W." }))
  const got = readRejectedLedger(root)
  expect(got.length).toBe(2)
  expect(got[1]!.bullet).toBe("When Z, do W.")
  // file is a pretty JSON array (human-auditable like minimal/rejected.json)
  expect(readFileSync(join(root, "rejected.json"), "utf-8").trimStart().startsWith("[")).toBe(true)
})
