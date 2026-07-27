import { test, expect } from "bun:test"
import { renderEvidence, type RepoEvidence } from "../src/evidence.ts"
import { aggregate, notable, type SensorLine } from "../src/scan.ts"

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
