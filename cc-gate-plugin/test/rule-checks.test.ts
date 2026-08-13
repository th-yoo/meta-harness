import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { evaluateRuleChecks, RULE_CHECKS_MAX, RULE_CHECKS_BUDGET_MS } from "../src/rule-checks.ts"

let cwd: string
beforeEach(() => { cwd = mkdtempSync(join(tmpdir(), "rc-")) })
afterEach(() => { rmSync(cwd, { recursive: true, force: true }) })

function writeRules(rules: unknown): void {
  mkdirSync(join(cwd, ".km"), { recursive: true })
  writeFileSync(join(cwd, ".km", "rule-checks.json"), JSON.stringify({ version: 1, writtenTs: 1, rules }))
}

const okRun = (ms = 10) => async (_cmd: string, _cwd: string, _t: number) => ({ code: 0, out: "", ms })
const failRun = async () => ({ code: 1, out: "", ms: 5 })

describe("evaluateRuleChecks", () => {
  test("absent file -> undefined (byte-identity upstream)", async () => {
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("malformed JSON -> undefined, never throws", async () => {
    mkdirSync(join(cwd, ".km"), { recursive: true })
    writeFileSync(join(cwd, ".km", "rule-checks.json"), "{nope")
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("empty rules -> undefined (absent is the cleaner line)", async () => {
    writeRules([])
    expect(await evaluateRuleChecks(cwd, okRun())).toBeUndefined()
  })
  test("pass/fail outcomes with ms; F2 — no cmd text in outcomes", async () => {
    writeRules([
      { id: "pb-1", cmd: "echo F2CANARY", timeoutMs: 1000, state: "shadow" },
      { id: "pb-2", cmd: "false", timeoutMs: 1000, state: "shadow" },
    ])
    const runs: string[] = []
    const out = await evaluateRuleChecks(cwd, async (cmd, c, t) => { runs.push(cmd); return cmd === "echo F2CANARY" ? { code: 0, out: "", ms: 3 } : { code: 1, out: "", ms: 4 } })
    expect(out).toEqual([{ id: "pb-1", pass: true, ms: 3 }, { id: "pb-2", pass: false, ms: 4 }])
    expect(JSON.stringify(out)).not.toContain("F2CANARY") // ids/booleans only… see note below
    expect(runs).toEqual(["echo F2CANARY", "false"])
  })
  test("runtime guard screen: unsafe cmd recorded refused, never executed", async () => {
    writeRules([{ id: "pb-1", cmd: "rm -rf /", timeoutMs: 1000, state: "shadow" }])
    const runs: string[] = []
    const out = await evaluateRuleChecks(cwd, async (cmd) => { runs.push(cmd); return { code: 0, out: "", ms: 1 } })
    expect(out).toEqual([{ id: "pb-1", refused: true }])
    expect(runs).toEqual([])
  })
  test("count cap: rules beyond RULE_CHECKS_MAX recorded skipped, file order", async () => {
    writeRules(Array.from({ length: RULE_CHECKS_MAX + 2 }, (_, i) => ({ id: `pb-${i}`, cmd: "true", timeoutMs: 100, state: "shadow" })))
    const out = (await evaluateRuleChecks(cwd, okRun()))!
    expect(out).toHaveLength(RULE_CHECKS_MAX + 2)
    expect(out.slice(RULE_CHECKS_MAX)).toEqual([
      { id: `pb-${RULE_CHECKS_MAX}`, skipped: true },
      { id: `pb-${RULE_CHECKS_MAX + 1}`, skipped: true },
    ])
  })
  test("aggregate budget: per-check timeout = min(timeoutMs, remaining); exhausted -> skipped", async () => {
    writeRules([
      { id: "pb-1", cmd: "sleep-ish", timeoutMs: 60000, state: "shadow" },
      { id: "pb-2", cmd: "true", timeoutMs: 1000, state: "shadow" },
    ])
    const timeouts: number[] = []
    const out = await evaluateRuleChecks(cwd, async (_cmd, _c, t) => { timeouts.push(t); return { code: 0, out: "", ms: RULE_CHECKS_BUDGET_MS } })
    // first check clamped to full budget, consumed it all; second skipped
    expect(timeouts).toEqual([RULE_CHECKS_BUDGET_MS])
    expect(out).toEqual([{ id: "pb-1", pass: true, ms: RULE_CHECKS_BUDGET_MS }, { id: "pb-2", skipped: true }])
  })
  test("malformed individual rule (missing id/cmd) -> that rule skipped, rest evaluated", async () => {
    writeRules([{ nope: true }, { id: "pb-2", cmd: "true", timeoutMs: 1000, state: "shadow" }])
    const out = await evaluateRuleChecks(cwd, okRun())
    expect(out).toEqual([{ id: "unknown", skipped: true }, { id: "pb-2", pass: true, ms: 10 }])
  })
  test("runCheckFn rejection (spawn failure) -> that rule skipped, prior outcomes kept", async () => {
    writeRules([
      { id: "pb-1", cmd: "true", timeoutMs: 1000, state: "shadow" },
      { id: "pb-2", cmd: "boom", timeoutMs: 1000, state: "shadow" },
      { id: "pb-3", cmd: "true", timeoutMs: 1000, state: "shadow" },
    ])
    const out = await evaluateRuleChecks(cwd, async (cmd) => {
      if (cmd === "boom") throw new Error("spawn failed")
      return { code: 0, out: "", ms: 2 }
    })
    expect(out).toEqual([
      { id: "pb-1", pass: true, ms: 2 },
      { id: "pb-2", skipped: true },
      { id: "pb-3", pass: true, ms: 2 },
    ])
  })
})
