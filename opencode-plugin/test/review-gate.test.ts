import { test, expect } from "bun:test"
import { reviewAddedBullets, type BulletReviewOutcome } from "../src/review-gate.ts"
import type { HarnessHost } from "../src/host.ts"
import type { RejectedEntry } from "../src/harness-store.ts"

// Hermetic: no real LLM. The fake host is a scripted reply queue
// (`replies.shift()` per runTextAgent call) that also records every prompt
// it was given, mirroring test/propose-apply.test.ts:43-55's fakeHost shape.

const GOOD_BULLET =
  "When a check contradicts the specification, verify the artifact against it before declaring the task done."

const LONG_BULLET = "When " + Array(70).fill("word").join(" ")

const PASS_CHECKS = `ok
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":true,"command":""}},"confidence":0.8}`

const FAIL_CHECKS = `not quite
{"checks":{"category":{"pass":false,"category":"","quote":""},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":true,"command":""}},"confidence":0.4}`

const MECHANIZE_FAIL_CHECKS = `should be a check
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"},
"mechanize_instead":{"pass":false,"command":"bun test --filter migration-retry"}},"confidence":0.7}`

const REVISED_BULLET = "When you fail twice on the same approach, change your diagnosis before retrying."

const REVISE_REPLY_PASS = `{"action":"propose","reason":"tightened category framing","bullet":{"text":"${REVISED_BULLET}"}}`

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

function ledgerEntry(over: Partial<RejectedEntry> = {}): RejectedEntry {
  return {
    rejectedAt: "2026-07-20T00:00:00Z",
    scope: "project-role",
    version: "v3",
    bullet: "When a retry loop exceeds three attempts, escalate to a human.",
    violations: ["duplicate: matches existing harness line"],
    source: "review-gate",
    ...over,
  }
}

const BASE = {
  diagnosisReason: "Agent kept re-attempting the same failing fix without changing approach.",
  activeSystem: "# Playbook\n- When a test fails, re-read the assertion before editing.\n",
  scope: "project-role",
}

// 1. Layer-1 fail → staged=false WITHOUT any runTextAgent call.
test("layer-1 fail (over 60 words) free-fails without calling the LLM", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [LONG_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(false)
  expect(outcome!.violations.some((v) => v.includes("60 words"))).toBe(true)
  expect(rec.prompts.length).toBe(0)
})

// 2. Layer-1 pass + rubric pass → staged=true, bullet unchanged.
test("layer-1 pass + rubric pass stages the bullet unchanged", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [PASS_CHECKS])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(true)
  expect(outcome!.bullet).toBe(GOOD_BULLET)
  expect(outcome!.violations).toEqual([])
  expect(rec.prompts.length).toBe(1)
})

// 3. Rubric fail then revision passes → staged=true with REVISED text; trail length 2.
test("rubric fail then a passing revision stages the revised text", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [FAIL_CHECKS, REVISE_REPLY_PASS, PASS_CHECKS])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(true)
  expect(outcome!.bullet).toBe(REVISED_BULLET)
  expect(outcome!.trail.length).toBe(2)
  expect(outcome!.trail[0]!.verdict).toBe("fail")
  expect(outcome!.trail[1]!.verdict).toBe("pass")
  expect(rec.prompts.length).toBe(3)
})

// 4. Rubric fail + revision fail (still fails re-review) → staged=false, violations from final review.
test("rubric fail then a still-failing revision leaves it unstaged with final violations", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [FAIL_CHECKS, REVISE_REPLY_PASS, FAIL_CHECKS])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(false)
  expect(outcome!.violations.some((v) => v.includes("category"))).toBe(true)
  expect(outcome!.trail.length).toBe(2)
  expect(rec.prompts.length).toBe(3)
})

// 5. runTextAgent → null → staged=false with a violation containing "no parseable" (fail-closed).
test("LLM down (runTextAgent → null) fails closed with an unparseable violation", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [null, null])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(false)
  expect(outcome!.violations.some((v) => v.includes("no parseable"))).toBe(true)
})

// 6. Ledger text is embedded in the review prompt.
test("rejected ledger text is embedded in the review prompt", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [PASS_CHECKS])
  const entry = ledgerEntry()
  await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [entry], ...BASE,
  })
  expect(rec.prompts.length).toBe(1)
  expect(rec.prompts[0]!.includes(entry.bullet)).toBe(true)
})

// 8. mechanize_instead fail → immediate abstain, staged=false, only ONE
//    LLM call (revise seat never invoked), reason embeds the named command.
test("mechanize_instead fail routes to immediate abstain with the named command in the reason", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [MECHANIZE_FAIL_CHECKS])
  const [outcome] = await reviewAddedBullets({
    host, bullets: [GOOD_BULLET], ledger: [], ...BASE,
  })
  expect(outcome!.staged).toBe(false)
  expect(outcome!.violations.some((v) => v.includes("mechanize_instead") && v.includes("bun test --filter migration-retry"))).toBe(true)
  expect(outcome!.trail.length).toBe(1)
  expect(rec.prompts.length).toBe(1) // no revision-round LLM call
})

// 7. Empty bullets array → [], zero LLM calls.
test("empty bullets array short-circuits to [] with zero LLM calls", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [])
  const out: BulletReviewOutcome[] = await reviewAddedBullets({
    host, bullets: [], ledger: [], ...BASE,
  })
  expect(out).toEqual([])
  expect(rec.prompts.length).toBe(0)
})
