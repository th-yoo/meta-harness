// Scorecard over the sensor stream. Pre-registration:
// docs/superpowers/specs/2026-07-28-kkamak-scorecard-preregistration.md
//
// This is a MEASUREMENT tool: if it is wrong, every verdict built on it is
// wrong. The classification rules are the whole product, so they are pinned
// here line by line.
import { test, expect } from "bun:test"
import { classifyCycle, scoreLines, type SensorLineIn } from "../src/score.ts"

function line(over: Partial<SensorLineIn> = {}): SensorLineIn {
  return {
    ts: 1000,
    sessionID: "s",
    check: "bun test",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 100,
    host: "h",
    app: "claude-code",
    ...over,
  }
}

// ── classification ───────────────────────────────────────────────────────

test("clean: a single accepted round, nothing was wrong", () => {
  expect(classifyCycle(line())).toBe("clean")
})

test("catch: verify-failed then accepted — the value event", () => {
  expect(classifyCycle(line({ rounds: ["verify-failed", "accepted"] }))).toBe("catch")
  expect(classifyCycle(line({ rounds: ["verify-failed", "verify-failed", "accepted"] }))).toBe("catch")
})

test("exhausted: budget spent — accepted:true must NOT read as success", () => {
  const l = line({ accepted: true, gateExhausted: true, rounds: ["verify-failed", "verify-failed"] })
  expect(classifyCycle(l)).toBe("exhausted")
})

test("interrupted wins over every other class (precedence)", () => {
  // The preemption line carries accepted:true + gateExhausted:true for
  // schema parity with the opencode plugin — precedence must not be fooled.
  const l = line({ interrupted: true, accepted: true, gateExhausted: true, rounds: ["verify-failed"] })
  expect(classifyCycle(l)).toBe("interrupted")
})

test("gauge-only line (rounds: []) is NOT a gate cycle", () => {
  expect(classifyCycle(line({ rounds: [] }))).toBe("gauge-only")
})

// ── aggregation ──────────────────────────────────────────────────────────

const MANY = (n: number, over: Partial<SensorLineIn>) => Array.from({ length: n }, () => line(over))

test("rates computed over gate cycles only; gauge-only lines excluded from denominators", () => {
  const lines = [
    ...MANY(15, {}),                                                        // clean
    ...MANY(4, { rounds: ["verify-failed", "accepted"] }),                  // catch
    ...MANY(1, { gateExhausted: true, rounds: ["verify-failed", "verify-failed"] }), // exhausted
    ...MANY(10, { rounds: [] }),                                            // gauge-only, must not count
  ]
  const [g] = scoreLines(lines, { minN: 20 }).groups
  expect(g!.counts).toMatchObject({ clean: 15, catch: 4, exhausted: 1, gaugeOnly: 10 })
  expect(g!.gateCycles).toBe(20)
  expect(g!.mCatch).toBeCloseTo(4 / 20)
  expect(g!.mExhaust).toBeCloseTo(1 / 20)
})

test("M-interrupt denominator is ALL cycles incl. interrupts, not just converged ones", () => {
  const lines = [...MANY(18, {}), ...MANY(2, { interrupted: true })]
  const [g] = scoreLines(lines, { minN: 20 }).groups
  expect(g!.gateCycles).toBe(18) // interrupts are not converged cycles
  expect(g!.mInterrupt).toBeCloseTo(2 / 20) // but they ARE in the interrupt denominator
})

test("M-tax is the MEDIAN over clean cycles only (human-wait inflates the tail)", () => {
  const lines = [
    line({ durationMs: 100 }),
    line({ durationMs: 200 }),
    line({ durationMs: 300_000 }), // approval-wait outlier
    line({ durationMs: 5000, rounds: ["verify-failed", "accepted"] }), // catch, excluded
  ]
  const [g] = scoreLines(lines, { minN: 1 }).groups
  expect(g!.mTaxMedianMs).toBe(200)
})

test("rates are SUPPRESSED below minN — a rate over 6 cycles is noise", () => {
  const [g] = scoreLines(MANY(6, {}), { minN: 20 }).groups
  expect(g!.gateCycles).toBe(6)
  expect(g!.underpowered).toBe(true)
  expect(g!.mCatch).toBeNull()
  expect(g!.mExhaust).toBeNull()
})

// ── grouping (pre-reg §3) ────────────────────────────────────────────────

test("grouped by (check, host) so kkamak-dev never pools with real work by default", () => {
  const lines = [
    ...MANY(3, { check: "cd cc-gate-plugin && bun test", host: "yoo-dev" }),
    ...MANY(2, { check: "bun test", host: "yoo-dev" }),
    ...MANY(1, { check: "bun test", host: "macbook" }),
  ]
  const { groups } = scoreLines(lines, { minN: 1 })
  expect(groups.length).toBe(3)
  expect(groups.map((g) => g.gateCycles).sort()).toEqual([1, 2, 3])
})

test("pool: true merges every group into one, as an explicit opt-in", () => {
  const lines = [
    ...MANY(3, { check: "a", host: "h1" }),
    ...MANY(2, { check: "b", host: "h2" }),
  ]
  const { groups } = scoreLines(lines, { minN: 1, pool: true })
  expect(groups.length).toBe(1)
  expect(groups[0]!.gateCycles).toBe(5)
})

// ── gauge dimension ──────────────────────────────────────────────────────

test("gauge metrics count present/executable/would-block across ALL lines", () => {
  const lines = [
    line({ gauge: { present: true, executable: true, pass: true, wouldBlock: false } }),
    line({ gauge: { present: true, executable: true, pass: false, wouldBlock: true, agreesWithFloor: false } }),
    line({ gauge: { present: true, executable: false, refused: "destructive-command" } }),
    line({}), // no gauge at all
  ]
  const { gauge } = scoreLines(lines, { minN: 1 })
  expect(gauge).toMatchObject({ present: 3, executable: 2, wouldBlock: 1, refused: 1, disagreedWithFloor: 1 })
})

// ── robustness ───────────────────────────────────────────────────────────

test("malformed lines are skipped, never throw, and are counted", () => {
  const junk = [{ nope: true }, null, "string", { rounds: "not-an-array" }] as unknown as SensorLineIn[]
  const r = scoreLines([...junk, line()], { minN: 1 })
  expect(r.skipped).toBe(4)
  expect(r.groups[0]!.gateCycles).toBe(1)
})

test("empty input yields no groups and no throw", () => {
  const r = scoreLines([], { minN: 20 })
  expect(r.groups).toEqual([])
  expect(r.skipped).toBe(0)
})

// ── CLI ──────────────────────────────────────────────────────────────────

import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const CLI = path.join(import.meta.dir, "..", "src", "score-cli.ts")

async function runCli(args: string[]): Promise<{ out: string; code: number }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const [so, se, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { out: so + se, code }
}

function sensorFile(lines: SensorLineIn[]): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "km-score-"))
  const p = path.join(d, "s.ndjson")
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + "\n")
  return p
}

test("CLI: --min-n is honoured and its VALUE is not treated as a filename", async () => {
  const f = sensorFile(MANY(3, {}))
  const r = await runCli([f, "--min-n", "2"])
  expect(r.code).toBe(0)
  expect(r.out).not.toContain("cannot read")
  expect(r.out).toContain("M-catch") // rates printed, not suppressed
  expect(r.out).not.toContain("rates suppressed")
})

test("CLI: --json emits parseable output; --pool merges groups", async () => {
  const f = sensorFile([...MANY(2, { check: "a", host: "h1" }), ...MANY(2, { check: "b", host: "h2" })])
  const parsed = JSON.parse((await runCli([f, "--json", "--pool", "--min-n", "1"])).out)
  expect(parsed.groups.length).toBe(1)
  expect(parsed.groups[0].gateCycles).toBe(4)
})

test("CLI: unreadable file is reported, never a crash", async () => {
  const r = await runCli(["/nope/missing.ndjson"])
  expect(r.code).toBe(0)
  expect(r.out).toContain("cannot read")
})

test("CLI: bad --min-n exits 2", async () => {
  expect((await runCli(["--min-n", "zero"])).code).toBe(2)
})

// ── §4.4 arm split (pre-reg §4b) ─────────────────────────────────────────

test("arms are reported separately so v0/v1 can be compared", () => {
  const lines = [
    ...MANY(10, { reinject: "v0" }),
    ...MANY(8, { reinject: "v1" }),
    ...MANY(2, { reinject: "v1", interrupted: true }),
  ]
  const { arms } = scoreLines(lines, { minN: 1 })
  expect(arms.v0.gateCycles).toBe(10)
  expect(arms.v1.gateCycles).toBe(8)
  expect(arms.v1.counts.interrupted).toBe(2)
  expect(arms.v1.mInterrupt).toBeCloseTo(2 / 10)
})

test("lines with no arm recorded are excluded from BOTH arms", () => {
  const { arms } = scoreLines([...MANY(5, {}), ...MANY(3, { reinject: "v0" })], { minN: 1 })
  expect(arms.v0.gateCycles).toBe(3)
  expect(arms.v1.gateCycles).toBe(0)
})
