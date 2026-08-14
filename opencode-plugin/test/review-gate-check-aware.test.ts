import { test, expect } from "bun:test"
import { reviewAddedBullets } from "../src/review-gate.ts"
import { buildReviewPrompt, computeVerdict, type ReviewChecks } from "../../minimal/review.ts"
import type { HarnessHost } from "../src/host.ts"

// Check-aware review (a3 follow-up): a bullet that ARRIVES with a screen-passed
// check must never be rejected for "mechanize_instead" — it already mechanized.
// Hermetic fake host per review-gate.test.ts's scripted-reply-queue shape.

const CHECKED_BULLET =
  "When running or adding a package script in this repository, invoke it with the repo's pinned runner rather than ad-hoc tools."
const CHECK = { cmd: "bun test --silent", timeoutMs: 30000 }

const MECHANIZE_FAIL_CHECKS = `should be a check
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When running a SQL migration, use the pinned migrator."},
"behavior_level":{"pass":true,"restatement":"Agent uses the pinned runner."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":false,"command":"grep for ad-hoc runner usage"}},"confidence":0.7}`

const CATEGORY_FAIL_CHECKS = `not process-shaped
{"checks":{"category":{"pass":false,"category":"","quote":""},
"domain_swap":{"pass":true,"swapped_bullet":"When running a SQL migration, use the pinned migrator."},
"behavior_level":{"pass":true,"restatement":"Agent uses the pinned runner."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":false,"command":"grep for ad-hoc runner usage"}},"confidence":0.4}`

const ABSTAIN_REPLY = `{"action":"abstain","reason":"cannot reform"}`

// Category fail AND raw mechanize_instead fail — the 7b-finding-1 shape: a
// non-compliant judge fails item 5 despite the auto-pass instruction.
const CATEGORY_AND_MECHANIZE_FAIL_CHECKS = CATEGORY_FAIL_CHECKS

const PASS_CHECKS = `ok
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When running a SQL migration, use the pinned migrator."},
"behavior_level":{"pass":true,"restatement":"Agent uses the pinned runner."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":true,"command":""}},"confidence":0.8}`

const REVISED_TEXT = "When invoking any package script in this repository, use the repo's pinned runner."
const REVISE_PROPOSE_REPLY = `{"action":"propose","reason":"category tightened","bullet":{"text":"${REVISED_TEXT}"}}`

interface Rec { prompts: string[] }

function fakeHost(rec: Rec, replies: (string | null)[]): HarnessHost {
  return {
    platform: "test",
    projectRoot: "/tmp/wt",
    log: () => {},
    notify: () => {},
    showScorePrompt: async () => {},
    runTextAgent: async (opts) => {
      rec.prompts.push(opts.prompt)
      if (replies.length === 0) throw new Error("fakeHost: no more scripted replies")
      return replies.shift()!
    },
    runTaskAgent: async () => ({ id: "child-1" }),
    exec: async () => ({ stdout: "", exitCode: 0 }),
  } as HarnessHost
}

const BASE = {
  diagnosisReason: "Sessions used ad-hoc runners and broke lockfile discipline.",
  activeSystem: "# Playbook\n- When a test fails, re-read the assertion before editing.\n",
  ledger: [],
  scope: "project-global",
}

// ── computeVerdict: deterministic suppression ──────────────────────────────

const CHECKS_MECH_FAIL: ReviewChecks = {
  category: { pass: true, category: "iteration-discipline", quote: "q" },
  domain_swap: { pass: true, swapped_bullet: "s" },
  behavior_level: { pass: true, restatement: "r" },
  duplicate: { pass: true, match: "none" },
  mechanize_instead: { pass: false, command: "some cmd" },
}

test("computeVerdict: carriesCheck suppresses a mechanize_instead fail", () => {
  const { verdict, violations } = computeVerdict({ pass: true, violations: [] }, CHECKS_MECH_FAIL, {
    carriesCheck: true,
  })
  expect(verdict).toBe("pass")
  expect(violations).toEqual([])
})

test("computeVerdict: without carriesCheck the mechanize_instead fail still rejects (unchanged)", () => {
  const { verdict, violations } = computeVerdict({ pass: true, violations: [] }, CHECKS_MECH_FAIL)
  expect(verdict).toBe("fail")
  expect(violations.some((v) => v.startsWith("mechanize_instead"))).toBe(true)
})

test("computeVerdict: carriesCheck tolerates an omitted mechanize_instead key", () => {
  const { mechanize_instead: _omit, ...rest } = CHECKS_MECH_FAIL
  const { verdict } = computeVerdict({ pass: true, violations: [] }, rest as ReviewChecks, { carriesCheck: true })
  expect(verdict).toBe("pass")
})

// ── buildReviewPrompt: attached-check rendering ────────────────────────────

test("buildReviewPrompt: checkCmd renders the attached-check clause and the command", () => {
  const p = buildReviewPrompt({
    bullet: CHECKED_BULLET,
    reason: "r",
    harness: "h",
    rejected: "(none recorded)",
    taskId: "",
    checkCmd: CHECK.cmd,
  })
  expect(p).toContain("attached runnable check")
  expect(p).toContain(CHECK.cmd)
  expect(p).not.toContain("prose must never do a check's job")
})

test("buildReviewPrompt: without checkCmd the original item-5 wording stands", () => {
  const p = buildReviewPrompt({ bullet: CHECKED_BULLET, reason: "r", harness: "h", rejected: "x", taskId: "" })
  expect(p).toContain("prose must never do a check's job")
  expect(p).not.toContain("attached runnable check")
})

// ── reviewAddedBullets integration ─────────────────────────────────────────

test("checked bullet: judge's mechanize_instead fail does NOT reject — stages with liveEligible", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [MECHANIZE_FAIL_CHECKS])
  const [out] = await reviewAddedBullets({
    host,
    bullets: [{ text: CHECKED_BULLET, check: { ...CHECK } }],
    ...BASE,
  })
  expect(out!.staged).toBe(true)
  expect(out!.check).toBeDefined()
  expect(out!.check!.cmd).toBe(CHECK.cmd)
  expect(typeof out!.check!.liveEligible).toBe("boolean")
  // the judge prompt showed the attached check (ephemeral only — F2 governs
  // persisted artifacts, not the judge's input)
  expect(rec.prompts[0]).toContain(CHECK.cmd)
})

test("unchecked bullet: same judge reply still rejects on mechanize_instead (guard unchanged)", async () => {
  const rec: Rec = { prompts: [] }
  // review fail -> one revision round -> abstain -> rejected
  const host = fakeHost(rec, [MECHANIZE_FAIL_CHECKS, ABSTAIN_REPLY])
  const [out] = await reviewAddedBullets({
    host,
    bullets: [{ text: CHECKED_BULLET }],
    ...BASE,
  })
  expect(out!.staged).toBe(false)
  expect(out!.violations.some((v) => v.startsWith("mechanize_instead"))).toBe(true)
})

test("7b F1: raw mechanize fail must NOT deny a checked bullet its revision round", async () => {
  const rec: Rec = { prompts: [] }
  // category fails + judge non-compliantly fails raw mechanize_instead too.
  // Sanitation in reviewBullet must neutralize the raw key so reviewLoop's
  // fast-abstain does not fire: revise MUST be called (2nd prompt), and the
  // revised bullet is re-reviewed (3rd prompt) to a staged pass.
  const host = fakeHost(rec, [CATEGORY_AND_MECHANIZE_FAIL_CHECKS, REVISE_PROPOSE_REPLY, PASS_CHECKS])
  const [out] = await reviewAddedBullets({
    host,
    bullets: [{ text: CHECKED_BULLET, check: { ...CHECK } }],
    ...BASE,
  })
  expect(rec.prompts.length).toBe(3) // review, revise, re-review — revision NOT skipped
  expect(out!.staged).toBe(true)
  expect(out!.bullet).toBe(REVISED_TEXT)
  expect(out!.check).toBeDefined()
  expect(out!.check!.cmd).toBe(CHECK.cmd)
})

test("7b F2: the revision seat is shown the attached check with the stay-verified-or-abstain contract", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [CATEGORY_AND_MECHANIZE_FAIL_CHECKS, REVISE_PROPOSE_REPLY, PASS_CHECKS])
  await reviewAddedBullets({
    host,
    bullets: [{ text: CHECKED_BULLET, check: { ...CHECK } }],
    ...BASE,
  })
  const revision = rec.prompts[1]!
  expect(revision).toContain("REVISION round")
  expect(revision).toContain(CHECK.cmd)
  expect(revision).toContain("RIDES WITH")
  // unchecked bullet with a raw mechanize fail keeps the PRE-EXISTING
  // fast-abstain: no revision prompt is ever built (one prompt total)
  const rec2: Rec = { prompts: [] }
  const host2 = fakeHost(rec2, [CATEGORY_AND_MECHANIZE_FAIL_CHECKS])
  const [out2] = await reviewAddedBullets({ host: host2, bullets: [{ text: CHECKED_BULLET }], ...BASE })
  expect(rec2.prompts.length).toBe(1)
  expect(out2!.staged).toBe(false)
})

test("7b F3: no-checkCmd review prompt is byte-stable — bullet abuts the next section exactly as before", () => {
  const p = buildReviewPrompt({ bullet: CHECKED_BULLET, reason: "r", harness: "h", rejected: "x", taskId: "" })
  // the interpolation must contribute ZERO bytes when checkCmd is absent —
  // the bullet line abuts the next section header across one blank line,
  // exactly the pre-change rendering. (A pre-existing \n\n\n at the empty
  // Task-id section is old behavior on both sides; not asserted here.)
  expect(p).toContain(`${CHECKED_BULLET}\n\n## The proposer's stated diagnosis`)
  expect(p).not.toContain("Attached check")
})

test("checked bullet rejected on another axis: ledger text carries the F2-safe attached suffix, never the cmd", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [CATEGORY_FAIL_CHECKS, ABSTAIN_REPLY])
  const [out] = await reviewAddedBullets({
    host,
    bullets: [{ text: CHECKED_BULLET, check: { ...CHECK } }],
    ...BASE,
  })
  expect(out!.staged).toBe(false)
  expect(out!.bullet).toMatch(/\[check: attached \((bench|live)\)\]$/)
  expect(out!.bullet).not.toContain(CHECK.cmd)
  expect(out!.violations.some((v) => v.startsWith("category"))).toBe(true)
  expect(out!.violations.some((v) => v.startsWith("mechanize_instead"))).toBe(false)
})
