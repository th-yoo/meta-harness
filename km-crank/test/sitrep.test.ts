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

// §4.3 trial-* actions (plan Task 6): every kind renders, and detail shows
// the per-arm N_eff triplet + per-host coverage note (spec §3/§7).
const trialDetail = {
  perArm: {
    baseline: { cycleCount: 25, sessionCount: 25, sessionsWithGateCycle: 23 },
    trial: { cycleCount: 26, sessionCount: 24, sessionsWithGateCycle: 21 },
  },
  hosts: ["office", "macbook"],
}

test("formatSitrep: TRIAL-KEEP renders trial/scope, the not-better caveat, N_eff triplet, and host coverage", () => {
  const text = formatSitrep(
    outcome({ action: { kind: "trial-keep", scope: "project-global @ ~/z2/squad", trial: "v7", detail: trialDetail } }),
  )
  expect(text).toContain("TRIAL-KEEP")
  expect(text).toContain("v7")
  expect(text).toContain("project-global @ ~/z2/squad")
  expect(text).toContain('never "better"')
  expect(text).toContain("cycles 25 · sessions 25 · sessions-with-gate-cycle 23")
  expect(text).toContain("cycles 26 · sessions 24 · sessions-with-gate-cycle 21")
  expect(text).toContain("host coverage: office, macbook")
})

test("formatSitrep: TRIAL-ROLLBACK renders the reason and the re-proposable note", () => {
  const text = formatSitrep(
    outcome({
      action: {
        kind: "trial-rollback", scope: "project-global @ ~/z2/squad", trial: "v7",
        reason: "three-clause-rule: mCatch(T)=0.100 < mCatch(B)=0.200", detail: trialDetail,
      },
    }),
  )
  expect(text).toContain("TRIAL-ROLLBACK")
  expect(text).toContain("three-clause-rule")
  expect(text).toContain("re-proposable")
})

test("formatSitrep: TRIAL-DEFERRED renders the null-metric reason", () => {
  const text = formatSitrep(
    outcome({ action: { kind: "trial-deferred", scope: "project-global @ ~/z2/squad", reason: "null-metric: mCatch(B)" } }),
  )
  expect(text).toContain("TRIAL-DEFERRED")
  expect(text).toContain("null-metric: mCatch(B)")
})

test("formatSitrep: TRIAL-PENDING renders the futility projection", () => {
  const text = formatSitrep(
    outcome({
      action: {
        kind: "trial-pending", scope: "project-global @ ~/z2/squad",
        projection: "floors unmet — ~12.5d to floors at current rate", detail: trialDetail,
      },
    }),
  )
  expect(text).toContain("TRIAL-PENDING")
  expect(text).toContain("~12.5d")
})

test("formatSitrep: TRIAL-ABANDONED renders the reason", () => {
  const text = formatSitrep(
    outcome({ action: { kind: "trial-abandoned", scope: "project-global @ ~/z2/squad", reason: "exposure-divergence" } }),
  )
  expect(text).toContain("TRIAL-ABANDONED")
  expect(text).toContain("exposure-divergence")
})

test("formatSitrep: trial action without detail renders without N_eff lines and without 'undefined'", () => {
  const text = formatSitrep(
    outcome({ action: { kind: "trial-keep", scope: "project-global @ ~/z2/squad", trial: "v7" } }),
  )
  expect(text).toContain("TRIAL-KEEP")
  expect(text).not.toContain("per-arm N_eff")
  expect(text).not.toContain("undefined")
})

// §7 (deferred from TM6, built once evidence/kkamak-sensors/<host>/ exists,
// scripts/km-sensors-sync.sh): every verdict's SITREP prints per-host
// snapshot age so a stale or one-host-only committed snapshot is visible.
test("formatSitrep: trial detail with snapshotAges renders a per-host age line", () => {
  const text = formatSitrep(
    outcome({
      action: {
        kind: "trial-keep", scope: "project-global @ ~/z2/squad", trial: "v7",
        detail: { ...trialDetail, snapshotAges: [{ host: "macbook", ageDays: 1.2 }, { host: "office", ageDays: 10 }] },
      },
    }),
  )
  expect(text).toContain("snapshot age")
  expect(text).toContain("macbook: 1.2d")
  expect(text).toContain("office: 10.0d")
})

test("formatSitrep: trial detail with no snapshotAges (or an empty array) renders the absent-snapshot line", () => {
  const withoutField = formatSitrep(
    outcome({ action: { kind: "trial-keep", scope: "project-global @ ~/z2/squad", trial: "v7", detail: trialDetail } }),
  )
  expect(withoutField).toContain("no committed snapshot (evidence/kkamak-sensors absent for this repo)")

  const withEmptyArray = formatSitrep(
    outcome({
      action: {
        kind: "trial-keep", scope: "project-global @ ~/z2/squad", trial: "v7",
        detail: { ...trialDetail, snapshotAges: [] },
      },
    }),
  )
  expect(withEmptyArray).toContain("no committed snapshot (evidence/kkamak-sensors absent for this repo)")
})

test("formatSitrep: is a plain string, not JSON", () => {
  const text = formatSitrep(outcome())
  expect(typeof text).toBe("string")
  expect(() => JSON.parse(text)).toThrow()
})
