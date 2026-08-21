import { test, expect } from "bun:test"
import { reviewAddedBullets } from "../src/review-gate.ts"
import type { HarnessHost } from "../src/host.ts"

// review-gate screens a bullet's `check.failProbe.cmd` exactly like `check.cmd`
// (shadow-lane upstream fix, 2026-08-22): a screen-rejected probe rejects the
// WHOLE bullet before any LLM call, same reject-whole-and-ledger contract as
// the pre-existing check screen (see test/review-gate.test.ts's store-path case).

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
  diagnosisReason: "r",
  activeSystem: "",
  ledger: [],
  scope: "project-global",
}

test("checked bullet whose failProbe cmd hits a screen rejection is rejected whole, before any LLM call", async () => {
  const rec: Rec = { prompts: [] }
  const host = fakeHost(rec, [])
  const outcomes = await reviewAddedBullets({
    host,
    bullets: [{ text: "When X, do Y.", check: { cmd: "test -f out", timeoutMs: 5000,
      // rejected-tier probe: screenCheck refuses network commands
      failProbe: { cmd: "curl http://example.com", timeoutMs: 5000 } } as never }],
    ...BASE,
  })
  expect(outcomes[0]!.staged).toBe(false)
  expect(outcomes[0]!.violations[0]).toMatch(/^check-screen:failprobe-/)
  expect(rec.prompts.length).toBe(0)
})
