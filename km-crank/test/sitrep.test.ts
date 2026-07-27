import { test, expect } from "bun:test"
import { formatSitrep, type SitrepOutcome, type RepoSummary } from "../src/sitrep.ts"

const repoSummary: RepoSummary = {
  repo: "~/z2/meta-harness",
  newLines: 12,
  cleanAccepts: 8,
  fixCycles: 3,
  exhausted: 1,
  interrupted: 0,
  medianDurationMs: 4500,
}

function outcome(overrides: Partial<SitrepOutcome> = {}): SitrepOutcome {
  return {
    generatedAt: 1_700_000_000_000,
    repos: [repoSummary],
    action: { kind: "no-op" },
    ...overrides,
  }
}

test("formatSitrep: includes the generatedAt timestamp", () => {
  const text = formatSitrep(outcome())
  expect(text).toContain(new Date(1_700_000_000_000).toISOString())
})

test("formatSitrep: renders per-repo aggregate line", () => {
  const text = formatSitrep(outcome())
  expect(text).toContain("~/z2/meta-harness")
  expect(text).toContain("12 new")
  expect(text).toContain("clean=8")
  expect(text).toContain("fix=3")
})

test("formatSitrep: marks the target repo", () => {
  const text = formatSitrep(outcome({ targetRepo: "~/z2/meta-harness" }))
  expect(text).toContain("← target")
})

test("formatSitrep: SKIPPED action", () => {
  const text = formatSitrep(outcome({ action: { kind: "skipped" } }))
  expect(text).toContain("SKIPPED")
})

test("formatSitrep: skip-trial action (FIX 1 — never posted by crank.ts, kept for formatting symmetry)", () => {
  const text = formatSitrep(outcome({ action: { kind: "skip-trial" } }))
  expect(text).toContain("SKIPPED")
  expect(text).toContain("trial")
})

test("formatSitrep: skip-inflight action (FIX 2 — never posted by crank.ts, kept for formatting symmetry)", () => {
  const text = formatSitrep(outcome({ action: { kind: "skip-inflight" } }))
  expect(text).toContain("SKIPPED")
  expect(text).toContain("in flight")
})

test("formatSitrep: PROPOSED+STAGED includes scope, version, bullet text, and falsify_if when present", () => {
  const text = formatSitrep(
    outcome({
      action: {
        kind: "proposed-staged",
        scope: "project-global",
        version: "v7",
        bulletText: "Always run the build before claiming done.",
        falsifyIf: "a regression slips through untested",
      },
    }),
  )
  expect(text).toContain("PROPOSED+STAGED")
  expect(text).toContain("project-global")
  expect(text).toContain("v7")
  expect(text).toContain("Always run the build before claiming done.")
  expect(text).toContain("falsify_if: a regression slips through untested")
})

test("formatSitrep: PROPOSED+STAGED omits falsify_if line when absent", () => {
  const text = formatSitrep(
    outcome({
      action: { kind: "proposed-staged", scope: "project-global", version: "v7", bulletText: "some bullet" },
    }),
  )
  expect(text).not.toContain("falsify_if:")
})

test("formatSitrep: PROPOSED+STAGED truncates a very long bullet text", () => {
  const long = "x".repeat(5000)
  const text = formatSitrep(
    outcome({ action: { kind: "proposed-staged", scope: "project-global", version: "v1", bulletText: long } }),
  )
  expect(text.length).toBeLessThan(long.length)
})

test("formatSitrep: REVIEW-REJECTED includes the reason", () => {
  const text = formatSitrep(outcome({ action: { kind: "review-rejected", reason: "scope-violation" } }))
  expect(text).toContain("REVIEW-REJECTED")
  expect(text).toContain("scope-violation")
})

test("formatSitrep: PROPOSER-TIMEOUT", () => {
  const text = formatSitrep(outcome({ action: { kind: "proposer-timeout" } }))
  expect(text).toContain("PROPOSER-TIMEOUT")
})

test("formatSitrep: NO-OP", () => {
  const text = formatSitrep(outcome({ action: { kind: "no-op" } }))
  expect(text).toContain("NO-OP")
})

test("formatSitrep: FAILURE includes the message and never contains a token-shaped string", () => {
  const text = formatSitrep(outcome({ action: { kind: "failure", message: "ECONNREFUSED talking to slack" } }))
  expect(text).toContain("FAILURE")
  expect(text).toContain("ECONNREFUSED talking to slack")
  expect(text).not.toMatch(/xoxb-/)
})

test("formatSitrep: handles zero repos (e.g. a top-level failure before scanning)", () => {
  const text = formatSitrep({ generatedAt: 1000, repos: [], action: { kind: "failure", message: "boom" } })
  expect(text).toContain("FAILURE")
  expect(text).not.toContain("undefined")
})

test("formatSitrep: is a plain string, not JSON", () => {
  const text = formatSitrep(outcome())
  expect(typeof text).toBe("string")
  expect(() => JSON.parse(text)).toThrow()
})
