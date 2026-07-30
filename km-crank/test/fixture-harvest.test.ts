import { describe, expect, test } from "bun:test"
import { extractPromptContext, joinFixture, parseFixtureRefRecords } from "../src/fixture-harvest"
import { parseCheckOutputRecords } from "../src/check-output"

const REF = { ts: 100, sessionID: "s1", round: 2, check: "bun test", headSha: "h", treeSha: "t", ref: "refs/kkamak/fixtures/100-s1-r2" }

describe("parseFixtureRefRecords", () => {
  test("parses valid lines, skips malformed + bailed-shape-invalid silently", () => {
    const text = JSON.stringify(REF) + "\n" + "not json\n" + JSON.stringify({ ts: 1 }) + "\n"
    const recs = parseFixtureRefRecords(text)
    expect(recs.length).toBe(1)
    expect(recs[0]!.treeSha).toBe("t")
  })
  test("keeps bail records (observability) — caller filters", () => {
    const bailed = { ...REF, treeSha: "", ref: "", bail: "rebase-merge" }
    expect(parseFixtureRefRecords(JSON.stringify(bailed) + "\n")[0]!.bail).toBe("rebase-merge")
  })
})

describe("joinFixture", () => {
  test("matches sidecar record on exact (sessionID, ts, round)", () => {
    const sidecar = parseCheckOutputRecords(
      JSON.stringify({ ts: 100, sessionID: "s1", round: 2, roundsMax: 3, check: "bun test", excerpt: "FAIL x" }) + "\n" +
      JSON.stringify({ ts: 99, sessionID: "s1", round: 1, roundsMax: 3, check: "bun test", excerpt: "older" }) + "\n")
    const j = joinFixture(REF, sidecar)
    expect(j.excerpt).toBe("FAIL x")
  })
  test("no match → excerpt undefined (fixture still harvestable)", () => {
    expect(joinFixture(REF, []).excerpt).toBeUndefined()
  })
})

describe("extractPromptContext", () => {
  // Claude Code transcript JSONL: parse DEFENSIVELY — only lines with
  // type:"user" and a string-or-blocks message.content survive.
  const line = (ts: string, role: string, content: unknown) =>
    JSON.stringify({ type: role, timestamp: ts, message: { role, content } }) + "\n"
  test("first + last user text before cutoff", () => {
    const jsonl =
      line("2026-07-31T01:00:00Z", "user", "make the tests pass") +
      line("2026-07-31T01:01:00Z", "assistant", [{ type: "text", text: "ok" }]) +
      line("2026-07-31T01:02:00Z", "user", [{ type: "text", text: "also fix lint" }]) +
      line("2026-07-31T09:00:00Z", "user", "AFTER CUTOFF — must be ignored")
    const ctx = extractPromptContext(jsonl, Date.parse("2026-07-31T02:00:00Z"))
    expect(ctx.firstUser).toBe("make the tests pass")
    expect(ctx.lastUser).toBe("also fix lint")
  })
  test("tool_result-only user lines are skipped; garbage lines skipped", () => {
    const jsonl =
      line("2026-07-31T01:00:00Z", "user", "real ask") +
      line("2026-07-31T01:03:00Z", "user", [{ type: "tool_result", content: "..." }]) +
      "garbage\n"
    const ctx = extractPromptContext(jsonl, Date.parse("2026-07-31T02:00:00Z"))
    expect(ctx.lastUser).toBe("real ask")
  })
  test("empty/unreadable transcript → both undefined", () => {
    expect(extractPromptContext("", 1).firstUser).toBeUndefined()
  })
})
