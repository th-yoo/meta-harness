import { test, expect } from "bun:test"
import { attributeOverreach } from "../src/narrowing.ts"

// Token-free: pure-function attribution of "mechanism certified, trigger
// overreach" from a reject verdict's per-task table + the candidate's own
// expect_improve predictions + the guard list (rule-8 exception plumbing —
// docs/superpowers/specs/2026-08-17-gen3-regression-gauntlet-design.md).

const TASKS = {
  "sanitize-git-repo": { candidate: [0, 0, 1, 1, 1], active: [0, 1, 0, 1, 0] },
  "db-wal-recovery": { candidate: [1, 1, 0, 0, 0], active: [0, 1, 1, 0, 0] },
  "polyglot-rust-c": { candidate: [0, 0, 0, 0, 0], active: [1, 0, 1, 1, 0] },
  "sam-cell-seg": { candidate: [0, 0, 0, 0, 0], active: [0, 0, 0, 0, 0] },
}

const GUARDS = [
  { task: "polyglot-rust-c", rate: 1.0, n: 5 },
  { task: "sam-cell-seg", rate: 0.8, n: 5 },
  { task: "db-wal-recovery", rate: 0.2, n: 5 }, // weak guard — must NOT count
]

test("attributeOverreach: certified mechanism + guard regression => invited", () => {
  const a = attributeOverreach({
    taskResults: TASKS,
    expectImprove: ["runway-death mode: sanitize-git-repo and db-wal-recovery recover"],
    guards: GUARDS,
  })
  // improve: sanitize +1 (3 vs 2), db-wal 0 (2 vs 2) => net +1 > 0
  // strong guards in table: polyglot -3, sam 0 => net -3 < 0
  expect(a.invited).toBe(true)
  expect(a.improveNet).toBe(1)
  expect(a.guardNet).toBe(-3)
  expect(a.matchedImprove).toEqual(["db-wal-recovery", "sanitize-git-repo"])
  expect(a.matchedGuards).toEqual(["polyglot-rust-c", "sam-cell-seg"])
  expect(a.mechanism).toContain("sanitize-git-repo")
  expect(a.mechanism).toContain("polyglot-rust-c")
})

test("attributeOverreach: no named improve task in the table => not invited", () => {
  const a = attributeOverreach({
    taskResults: TASKS,
    expectImprove: ["video-processing and raman-fitting stop dying of runway"],
    guards: GUARDS,
  })
  expect(a.invited).toBe(false)
  expect(a.matchedImprove).toEqual([])
})

test("attributeOverreach: guards not regressed => not invited (plain loss, no certification)", () => {
  const a = attributeOverreach({
    taskResults: {
      "sanitize-git-repo": TASKS["sanitize-git-repo"],
      "polyglot-rust-c": { candidate: [1, 0, 1, 1, 0], active: [1, 0, 1, 1, 0] },
    },
    expectImprove: ["sanitize-git-repo"],
    guards: GUARDS,
  })
  expect(a.invited).toBe(false)
  expect(a.guardNet).toBe(0)
})

test("attributeOverreach: improve net non-positive => not invited (mechanism NOT certified)", () => {
  const a = attributeOverreach({
    taskResults: {
      "sanitize-git-repo": { candidate: [0, 0, 0, 1, 0], active: [0, 1, 0, 1, 0] },
      "polyglot-rust-c": TASKS["polyglot-rust-c"],
    },
    expectImprove: ["sanitize-git-repo"],
    guards: GUARDS,
  })
  expect(a.invited).toBe(false)
  expect(a.improveNet).toBe(-1)
})
