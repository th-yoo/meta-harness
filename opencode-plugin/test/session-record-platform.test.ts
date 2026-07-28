import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { createCandidate, recordSession, readScore, candidatePath, type SessionRecord } from "../src/harness-store.ts"

// Task L1: SessionRecord gains an OPTIONAL `platform` field so every recorded
// evolution-loop session says which coding-agent platform produced it. The
// live opencode loop (index.ts's session.idle pipeline) always stamps
// `platform: "opencode"` on the record it builds before calling
// recordSession — these tests pin the store-layer contract that pipeline
// depends on: the field round-trips through recordSession/readScore, and
// pre-L1 records (no `platform` key at all) still parse cleanly.

function tmpStore(): string {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "mh-session-record-platform-"))
  const storeRoot = path.join(tmp, ".kkamak", "roles", "mh-build")
  fs.mkdirSync(storeRoot, { recursive: true })
  return storeRoot
}

function session(overrides: Partial<SessionRecord>): SessionRecord {
  return {
    sessionID: "s1",
    passed: true,
    note: "",
    turnCount: 1,
    timestamp: new Date().toISOString(),
    summary: "",
    model: "anthropic/claude-x",
    variant: "",
    toolUsage: {},
    ...overrides,
  }
}

test("recordSession + readScore round-trip a live-loop-shaped record's platform: 'opencode'", () => {
  const root = tmpStore()
  createCandidate(root, "v0", "sys")

  recordSession(root, "v0", session({ sessionID: "sess-1", platform: "opencode" }))

  const score = readScore(root, "v0")
  expect(score.sessions[0]!.platform).toBe("opencode")
})

test("a pre-L1 SessionRecord with no 'platform' key at all still parses via readScore (backward compat)", () => {
  const root = tmpStore()
  createCandidate(root, "v0", "sys")

  // Write a raw score.json exactly as a pre-L1 build would have (no
  // `platform` key anywhere in the JSON — not merely `undefined`).
  const legacyRecord = {
    sessionID: "legacy-1",
    passed: true,
    note: "",
    turnCount: 2,
    timestamp: new Date().toISOString(),
    summary: "",
    model: "anthropic/claude-x",
    variant: "",
    toolUsage: {},
  }
  fs.writeFileSync(
    candidatePath(root, "v0", "score.json"),
    JSON.stringify({ version: "v0", nPass: 1, nFail: 0, sessions: [legacyRecord] }),
  )

  const score = readScore(root, "v0")
  expect(score.sessions).toHaveLength(1)
  expect(score.sessions[0]!.sessionID).toBe("legacy-1")
  expect(score.sessions[0]!.platform).toBeUndefined()
})
