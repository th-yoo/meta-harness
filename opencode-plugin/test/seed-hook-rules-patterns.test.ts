import { test, expect, describe } from "bun:test"
import { SEED_OPS } from "../scripts/seed-hook-rules.ts"
import { screenHookRule } from "../src/hook-rule-screen.ts"
import { evalHookRules } from "../src/adapters/claude-code/hook-rule-eval.ts"

// Brief's match/no-match table PLUS compound-command probes (review
// 2026-08-22: bare `^pattern` was compound-command blind — `cd x && rm ...`,
// piped/redirected tails, etc. — which would silently degrade the shadow
// lane's denominator) and a mid-word decoy, in SEED_OPS order:
// rm/mv store | ndjson redirect | store-sync | force-push
const CASES: { mustMatch: string[]; mustNotMatch: string[] }[] = [
  {
    mustMatch: ["rm -rf .kkamak/global", "cd /tmp && rm -rf .kkamak/global"],
    // mid-word decoy: "confirm" contains the substring "rm" but has no
    // ;/&/| separator gating it — must NOT trip the compound-prefix branch.
    mustNotMatch: ["rm -rf node_modules", "echo confirm .kkamak/global"],
  },
  {
    mustMatch: ["echo x > .km/gate-outcomes.ndjson", "echo x > .km/gate-outcomes.ndjson && ls"],
    mustNotMatch: ["cat a.ndjson >> backup.ndjson"],
  },
  {
    mustMatch: ["term-bench2/store-sync.sh export", "store-sync.sh export 2>&1 | tail -5"],
    mustNotMatch: ["term-bench2/store-sync.sh import"],
  },
  {
    mustMatch: ["git push origin main --force", "cd repo && git push origin main --force"],
    mustNotMatch: ["git push origin main"],
  },
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

  test("evalHookRules matches every true-positive (incl. compound forms) and none of the near-misses", () => {
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
    const { mustMatch, mustNotMatch } = CASES[i]

    for (const command of mustMatch) {
      const hit = evalHookRules(table, hr.toolMatcher, { command })
      expect(hit.outcomes.some((o) => o.matched)).toBe(true)
    }

    for (const command of mustNotMatch) {
      const miss = evalHookRules(table, hr.toolMatcher, { command })
      expect(miss.outcomes.some((o) => o.matched)).toBe(false)
    }
  })
})
