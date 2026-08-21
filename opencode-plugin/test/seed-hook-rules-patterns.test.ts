import { test, expect, describe } from "bun:test"
import { SEED_OPS } from "../scripts/seed-hook-rules.ts"
import { screenHookRule } from "../src/hook-rule-screen.ts"
import { evalHookRules } from "../src/adapters/claude-code/hook-rule-eval.ts"

// Brief's match/no-match table, in SEED_OPS order:
// rm/mv store | ndjson redirect | store-sync | force-push
const CASES: { must: string; mustNot: string }[] = [
  { must: "rm -rf .kkamak/global", mustNot: "rm -rf node_modules" },
  { must: "echo x > .km/gate-outcomes.ndjson", mustNot: "cat a.ndjson >> backup.ndjson" },
  { must: "term-bench2/store-sync.sh export", mustNot: "term-bench2/store-sync.sh import" },
  { must: "git push origin main --force", mustNot: "git push origin main" },
]

test("SEED_OPS has exactly the 4 structural rules", () => {
  expect(SEED_OPS).toHaveLength(4)
  for (const op of SEED_OPS) {
    expect(op.op).toBe("add")
    expect(op.hookRule).toBeDefined()
    // Proposer-facing shape: no `mode` — the store stamps it.
    expect("mode" in (op.hookRule as object)).toBe(false)
  }
})

describe.each(SEED_OPS.map((op, i) => [i, op] as const))("rule %i", (i, op) => {
  const hr = op.hookRule!

  test("screenHookRule accepts it (ok:true)", () => {
    const s = screenHookRule(hr)
    expect(s.ok).toBe(true)
  })

  test("evalHookRules matches the true-positive and not the near-miss", () => {
    // Table shape exactly as compileHookRulesTable emits (hook-rules-export.ts).
    const table = JSON.stringify({
      version: 1,
      writtenTs: 0,
      killSwitch: false,
      rules: [{
        id: "b1",
        event: hr.event,
        toolMatcher: hr.toolMatcher,
        inputPattern: hr.inputPattern,
        feedback: hr.feedback,
        mode: "shadow",
      }],
    })
    const { must, mustNot } = CASES[i]

    const hit = evalHookRules(table, hr.toolMatcher, { command: must })
    expect(hit.outcomes.some((o) => o.matched)).toBe(true)

    const miss = evalHookRules(table, hr.toolMatcher, { command: mustNot })
    expect(miss.outcomes.some((o) => o.matched)).toBe(false)
  })
})
