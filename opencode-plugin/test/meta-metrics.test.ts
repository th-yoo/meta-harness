import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { appendMetaMetric } from "../src/harness-store.ts"

test("appendMetaMetric writes JSONL to the .kkamak root", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-metrics-"))
  const storeRoot = path.join(tmp, ".kkamak", "roles", "mh-build")
  fs.mkdirSync(storeRoot, { recursive: true })
  appendMetaMetric(storeRoot, { event: "trial", action: "confirmed", trial: "v2" })
  appendMetaMetric(storeRoot, { event: "activate", version: "v2" })
  const sink = path.join(tmp, ".kkamak", "meta-metrics.jsonl")
  const lines = fs.readFileSync(sink, "utf-8").trim().split("\n")
  expect(lines.length).toBe(2)
  const e0 = JSON.parse(lines[0])
  expect(e0.event).toBe("trial")
  expect(typeof e0.ts).toBe("string")
})
