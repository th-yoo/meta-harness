import { test, expect } from "bun:test"
import { renderEvidence, type RepoEvidence } from "../src/evidence.ts"
import { aggregate, notable, type SensorLine } from "../src/scan.ts"
import type { CheckOutputRecord } from "../src/check-output.ts"

function line(overrides: Partial<SensorLine> = {}): SensorLine {
  return {
    ts: 1000,
    sessionID: "sess-1",
    check: "npm test",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 1500,
    host: "test-host",
    app: "claude-code",
    ...overrides,
  }
}

function repoEvidence(repo: string, lines: SensorLine[]): RepoEvidence {
  return { repo, newLines: lines, aggregate: aggregate(lines), notableLines: notable(lines, 5) }
}

test("renderEvidence: includes a header with the generatedAt timestamp", () => {
  const md = renderEvidence([], 0)
  expect(md).toContain("km-crank evidence")
  expect(md).toContain(new Date(0).toISOString())
})

test("renderEvidence: includes a section per repo, named by repo path", () => {
  const md = renderEvidence(
    [repoEvidence("~/z2/meta-harness", []), repoEvidence("~/z2/squad", [])],
    1000,
  )
  expect(md).toContain("## ~/z2/meta-harness")
  expect(md).toContain("## ~/z2/squad")
})

test("renderEvidence: renders per-repo aggregate numbers", () => {
  const lines = [
    line({ sessionID: "a", rounds: ["accepted"] }),
    line({ sessionID: "b", gateExhausted: true }),
    line({ sessionID: "c", interrupted: true }),
  ]
  const md = renderEvidence([repoEvidence("repo-x", lines)], 1000)
  expect(md).toContain("total new sensor lines: 3")
  expect(md).toContain("gate-exhausted: 1")
  expect(md).toContain("interrupted: 1")
})

test("renderEvidence: lists notable session ids and their flags", () => {
  const lines = [line({ sessionID: "exhausted-one", gateExhausted: true })]
  const md = renderEvidence([repoEvidence("repo-x", lines)], 1000)
  expect(md).toContain("exhausted-one")
  expect(md).toContain("EXHAUSTED")
})

test("renderEvidence: includes the raw notable lines as ndjson", () => {
  const l = line({ sessionID: "raw-line-check" })
  const md = renderEvidence([repoEvidence("repo-x", [l])], 1000)
  expect(md).toContain(JSON.stringify(l))
})

test("renderEvidence: (none) when a repo has no notable sessions", () => {
  const md = renderEvidence([repoEvidence("quiet-repo", [])], 1000)
  expect(md).toContain("(none)")
})

test("renderEvidence: includes a pointer note to ~/.claude/projects for CC transcripts", () => {
  const md = renderEvidence([], 1000)
  expect(md).toContain("~/.claude/projects/")
})

test("renderEvidence: is deterministic for the same inputs", () => {
  const lines = [line({ sessionID: "x" })]
  const a = renderEvidence([repoEvidence("repo", lines)], 5000)
  const b = renderEvidence([repoEvidence("repo", lines)], 5000)
  expect(a).toBe(b)
})

function checkRec(over: Partial<CheckOutputRecord>): CheckOutputRecord {
  return {
    ts: 1000, sessionID: "sess-1", round: 1, roundsMax: 2,
    check: "bun test", excerpt: "FAIL: expected await", ...over,
  }
}

test("renders up to 2 excerpts per notable session, latest first, tilde-fenced", () => {
  const l = line({ sessionID: "sess-1", gateExhausted: true, rounds: ["verify-failed", "verify-failed", "verify-failed"] })
  const md = renderEvidence(
    [{
      repo: "/r",
      newLines: [l],
      aggregate: aggregate([l]),
      notableLines: [l],
      excerptsBySession: new Map([[
        "sess-1",
        [checkRec({ ts: 30, round: 3, excerpt: "THIRD" }),
         checkRec({ ts: 20, round: 2, excerpt: "SECOND" }),
         checkRec({ ts: 10, round: 1, excerpt: "FIRST" })],
      ]]),
    }],
    0,
  )
  expect(md).toContain("THIRD")
  expect(md).toContain("SECOND")
  expect(md).not.toContain("FIRST") // budget: 2 per session
  expect(md).toContain("~~~") // tilde fence — check output may contain backticks
  expect(md.indexOf("THIRD")).toBeLessThan(md.indexOf("SECOND")) // latest first
})

test("render excerpt trimmed to head 300 + tail 900 chars with elision marker", () => {
  const long = "A".repeat(500) + "Z".repeat(1200)
  const l = line({ sessionID: "sess-1", gateExhausted: true, rounds: ["verify-failed"] })
  const md = renderEvidence(
    [{
      repo: "/r",
      newLines: [],
      aggregate: aggregate([]),
      notableLines: [l],
      excerptsBySession: new Map([["sess-1", [checkRec({ excerpt: long })]]]),
    }],
    0,
  )
  expect(md).toContain("A".repeat(300)) // head kept
  expect(md).toContain("Z".repeat(900)) // tail kept
  expect(md).toContain("[trimmed for render]") // trim marker
  expect(md).not.toContain("A".repeat(301)) // head cut
  expect(md).not.toContain("Z".repeat(901)) // middle cut
})

test("absent excerptsBySession renders byte-identical to pre-Phase-1 output", () => {
  const l = line({ sessionID: "sess-1" })
  const repo = {
    repo: "/r", newLines: [l], aggregate: aggregate([l]), notableLines: [l],
  }
  const withoutField = renderEvidence([repo], 0)
  const withEmptyMap = renderEvidence([{ ...repo, excerptsBySession: new Map() }], 0)
  const withUnmatchedSession = renderEvidence(
    [{ ...repo, excerptsBySession: new Map([["some-other-session", [checkRec({ sessionID: "some-other-session" })]]]) }],
    0,
  )
  expect(withoutField).toBe(withEmptyMap)
  expect(withEmptyMap).toBe(withUnmatchedSession)
})
