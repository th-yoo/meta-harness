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

// ── Task 1 (fix-them-serialized-teacup plan): skipped-stop class ───────────

test("skipped-stop: classified BEFORE gauge-only — skippedStop:true must not fall into the empty-rounds branch", () => {
  // Same rounds:[] shape as a gauge-only line — ordering is load-bearing
  // (round-1 review Critical 1). If gauge-only were checked first, this
  // line would misclassify as gauge-only and the fix would defeat itself.
  expect(classifyCycle(line({ rounds: [], skippedStop: true }))).toBe("skipped-stop")
})

test("skipped-stop wins over gauge-only but loses to interrupted (precedence)", () => {
  const l = line({ interrupted: true, rounds: [], skippedStop: true })
  expect(classifyCycle(l)).toBe("interrupted")
})

test("skipped-stop cycles are excluded from every rate denominator and populated+printed in counts", () => {
  const lines = [
    ...MANY(15, {}), // clean
    ...MANY(4, { rounds: ["verify-failed", "accepted"] }), // catch
    ...MANY(3, { rounds: [], skippedStop: true }), // skipped-stop, must not count
  ]
  const [g] = scoreLines(lines, { minN: 1 }).groups
  expect(g!.counts).toMatchObject({ clean: 15, catch: 4, skippedStop: 3 })
  expect(g!.gateCycles).toBe(19) // clean+catch+exhausted only — skipped-stop excluded
  expect(g!.mCatch).toBeCloseTo(4 / 19)
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

test("(check, host) group key never collides across the field boundary", () => {
  // Regression for the old NUL-joined key: two different (check, host)
  // pairs that would produce the SAME joined string under a naive
  // separator must still land in separate groups.
  const lines = [
    ...MANY(2, { check: "a\tb", host: "c" }),
    ...MANY(3, { check: "a", host: "b\tc" }),
  ]
  const { groups } = scoreLines(lines, { minN: 1 })
  expect(groups.length).toBe(2)
  expect(groups.map((g) => g.gateCycles).sort()).toEqual([2, 3])
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

// ── gauge dimension (v2 extractor, Task 3): counters RE-SCOPED to lines
// whose gauge carries a class field — class presence IS the v2-window
// filter, so v1 PoC lines (no class) contribute ZERO. See the companion
// "class-less legacy" test below for that half of the rule.

test("gauge metrics count present/executable/would-block across ALL v2 (class-carrying) lines", () => {
  const lines = [
    line({ gauge: { present: true, executable: true, pass: true, wouldBlock: false, class: "C" } }),
    line({
      gauge: { present: true, executable: true, pass: false, wouldBlock: true, agreesWithFloor: false, class: "C" },
    }),
    line({ gauge: { present: true, executable: false, refused: "destructive-command", class: "C" } }),
    line({}), // no gauge at all
  ]
  const { gauge } = scoreLines(lines, { minN: 1 })
  expect(gauge).toMatchObject({ present: 3, executable: 2, wouldBlock: 1, refused: 1, disagreedWithFloor: 1 })
})

test("class-less legacy gauge line (v1 PoC) contributes ZERO to every top-level counter", () => {
  const lines = [
    line({ gauge: { present: true, executable: true, pass: true, wouldBlock: false } }),
    line({ gauge: { present: true, executable: true, pass: false, wouldBlock: true, agreesWithFloor: false } }),
    line({ gauge: { present: true, executable: false, refused: "destructive-command" } }),
  ]
  const { gauge } = scoreLines(lines, { minN: 1 })
  expect(gauge).toMatchObject({ present: 0, executable: 0, refused: 0, wouldBlock: 0, disagreedWithFloor: 0 })
})

test("gauge byClass + downgraded counters", () => {
  const lines = [
    line({ gauge: { present: true, class: "A1" } }),
    line({ gauge: { present: true, class: "A1" } }),
    line({ gauge: { present: true, class: "A2" } }),
    line({ gauge: { present: true, class: "B" } }),
    line({ gauge: { present: true, class: "C", executable: true, pass: true, wouldBlock: false } }),
    line({
      gauge: {
        present: true,
        class: "D",
        downgraded: { fromClass: "C", fromCheck: "cat x", rule: "path-not-in-prompt", token: "x" },
      },
    }),
    line({ gauge: { present: true, class: "D", downgraded: { fromClass: "C", fromCheck: null, rule: "missing-check" } } }),
    line({}), // no gauge — must not count anywhere
    line({ gauge: { present: true, executable: true } }), // class-less legacy — must not count in byClass either
  ]
  const { gauge } = scoreLines(lines, { minN: 1 })
  expect(gauge.byClass).toEqual({ A1: 2, A2: 1, B: 1, C: 1, D: 2 })
  expect(gauge.downgraded).toBe(2)
})

test("byClass membership guard: a corrupted class string contributes to NOTHING — byClass unchanged", () => {
  const lines = [line({ gauge: { present: true, class: "Z" as unknown as never } })]
  const { gauge } = scoreLines(lines, { minN: 1 })
  expect(gauge.byClass).toEqual({ A1: 0, A2: 0, B: 0, C: 0, D: 0 })
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

test("CLI: km-gauge block prints the classes/downgraded line (text render)", async () => {
  const f = sensorFile([
    line({ gauge: { present: true, class: "C", executable: true, pass: true, wouldBlock: false } }),
    line({
      gauge: {
        present: true,
        class: "D",
        downgraded: { fromClass: "C", fromCheck: "cat x", rule: "path-not-in-prompt", token: "x" },
      },
    }),
  ])
  const r = await runCli([f, "--min-n", "1"])
  expect(r.code).toBe(0)
  expect(r.out).toContain("classes A1 0 · A2 0 · B 0 · C 1 · D 1 · downgraded 1")
})

test("CLI: --json emits parseable output; --pool merges groups", async () => {
  const f = sensorFile([...MANY(2, { check: "a", host: "h1" }), ...MANY(2, { check: "b", host: "h2" })])
  const parsed = JSON.parse((await runCli([f, "--json", "--pool", "--min-n", "1"])).out)
  expect(parsed.groups.length).toBe(1)
  expect(parsed.groups[0].gateCycles).toBe(4)
})

test("CLI: skipped-stop count is printed in the cycles breakdown line", async () => {
  const f = sensorFile([...MANY(2, {}), ...MANY(3, { rounds: [], skippedStop: true })])
  const r = await runCli([f, "--min-n", "1"])
  expect(r.code).toBe(0)
  expect(r.out).toContain("skipped-stop 3")
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

// ── §4.3 trial block (per-arm N_eff + exposure guard, TM7 / §11 item 7) ────
//
// Regression contract: with no `.km/trial-arms.ndjson` beside the target
// sensor file, the CLI's output must be byte-identical to the pre-trial
// baseline (this exact string, captured from the CLI BEFORE the §4.3 block
// existed). This test must stay green through the whole TM7 change.

function exposureFileBeside(sensorPath: string, rows: Record<string, unknown>[]): void {
  const p = path.join(path.dirname(sensorPath), "trial-arms.ndjson")
  fs.writeFileSync(p, rows.length ? rows.map((r) => JSON.stringify(r)).join("\n") + "\n" : "")
}

function expRow(over: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
  return { ts: 1000, sessionID: "s1", trialId: "t1", layer: "project-global", arm: "baseline", forced: false, ...over }
}

test("CLI: no trial-arms.ndjson beside sensor file -> §4.3 trial block absent, output byte-identical to the pre-trial baseline", async () => {
  const f = sensorFile(MANY(3, {}))
  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toBe(
    "kkamak scorecard — read-only; see the pre-registration before quoting any number.\n\n" +
      "── h · bun test\n" +
      "   cycles 3  (clean 3, catch 0, exhausted 0, interrupted 0)\n" +
      "   M-catch 0.0%   M-exhaust 0.0%   M-interrupt 0.0%   M-tax 100ms\n\n" +
      "Claimable: a fall in M-exhaust or M-interrupt at non-decreasing M-catch.\n" +
      "NOT claimable: M-catch alone, or kkamak's value — both need the §4.3 counterfactual.\n",
  )
  expect(r.out).not.toContain("§4.3 trial")
})

test("CLI: §4.3 trial block prints per-arm N_eff triplet, density, and forced count when trial-arms.ndjson exists beside the sensor file", async () => {
  const lines = [
    // s1: baseline, 2 clean gate cycles -> metrics 2, density-line 2
    line({ sessionID: "s1" }),
    line({ sessionID: "s1" }),
    // s2: trial, 1 clean gate cycle
    line({ sessionID: "s2" }),
    // s3: baseline, gauge-only (rounds:[]) -> counts toward density, NOT metrics
    line({ sessionID: "s3", rounds: [] }),
    // s4: trial but FORCED -> excluded from all per-arm metrics/density, only forcedCount
    line({ sessionID: "s4" }),
    // s5: no exposure row at all -> unmatched, attributed to neither arm
    line({ sessionID: "s5" }),
  ]
  const f = sensorFile(lines)
  exposureFileBeside(f, [
    expRow({ sessionID: "s1", arm: "baseline", forced: false }),
    expRow({ sessionID: "s2", arm: "trial", forced: false }),
    expRow({ sessionID: "s3", arm: "baseline", forced: false }),
    expRow({ sessionID: "s4", arm: "trial", forced: true }),
  ])

  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toContain("§4.3 trial")
  // baseline: metrics = 2 (s1's two clean lines); density set = 3 lines (s1x2 + s3
  // gauge-only) over 2 sessions (s1, s3) -> density 1.50; sessions-w-cycle = 1 (s1).
  expect(r.out).toMatch(/baseline.*cycles\s+2.*sessions\s+2.*sessions-w-cycle\s+1.*density 1\.50/)
  // trial: metrics = 1 (s2), density set = 1 line over 1 session -> density 1.00;
  // s4 (forced) contributes NOTHING here, only to the forced count below.
  expect(r.out).toMatch(/trial.*cycles\s+1.*sessions\s+1.*sessions-w-cycle\s+1.*density 1\.00/)
  expect(r.out).toContain("forced exposure rows: 1 (excluded from arms; a row's session may have 0 lines in this file)")
  // single trialId in the exposure file ("t1", the expRow default) -> named in the
  // block, no other-trial-rows line (TM7 review fix 2).
  expect(r.out).toContain("t1")
  expect(r.out).not.toContain("other-trial rows")
})

// ── TM7 review fixes: forced-ROW count + single-trial scoping ──────────────

test("CLI: forced count is per exposure ROW (deduped by session), not per matching sensor line — a forced session with 2 gate cycles still reports 1", async () => {
  const lines = [
    // s1 is forced-exposed but produced 2 sensor lines (e.g. 2 gate cycles in one
    // session) — the forced count must be 1 (rows), not 2 (lines).
    line({ sessionID: "s1" }),
    line({ sessionID: "s1" }),
  ]
  const f = sensorFile(lines)
  exposureFileBeside(f, [expRow({ sessionID: "s1", arm: "trial", forced: true })])

  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toContain("forced exposure rows: 1 (excluded from arms; a row's session may have 0 lines in this file)")
  // both forced lines are still excluded from the trial arm's metrics/density.
  expect(r.out).toMatch(/trial.*cycles\s+0.*sessions\s+0.*sessions-w-cycle\s+0.*density 0\.00/)
})

test("CLI: §4.3 trial block scopes to the trialId with the most recent ts; older-trial rows are excluded and reported as not-shown", async () => {
  const lines = [
    line({ sessionID: "s1" }), // exposed under the OLDER trial
    line({ sessionID: "s2" }), // exposed under the NEWER trial
  ]
  const f = sensorFile(lines)
  exposureFileBeside(f, [
    expRow({ sessionID: "s1", trialId: "t-old", ts: 1000, arm: "baseline", forced: false }),
    expRow({ sessionID: "s2", trialId: "t-new", ts: 2000, arm: "baseline", forced: false }),
  ])

  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toContain("t-new")
  expect(r.out).not.toContain("t-old")
  // only s2 (the newer trial) is joined; s1's row belongs to the older trial and is
  // excluded from the per-arm numbers entirely.
  expect(r.out).toMatch(/baseline.*cycles\s+1.*sessions\s+1.*sessions-w-cycle\s+1.*density 1\.00/)
  expect(r.out).toContain("other-trial rows: 1 (not shown)")
})

test("CLI: trial-arms.ndjson present but every row is unrelated to any sensor sessionID -> triplet all zero, no crash", async () => {
  const f = sensorFile(MANY(2, { sessionID: "unmatched" }))
  exposureFileBeside(f, [expRow({ sessionID: "some-other-session" })])
  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toContain("§4.3 trial")
  expect(r.out).toMatch(/baseline.*cycles\s+0.*sessions\s+0.*sessions-w-cycle\s+0.*density 0\.00/)
  expect(r.out).toMatch(/trial.*cycles\s+0.*sessions\s+0.*sessions-w-cycle\s+0.*density 0\.00/)
  expect(r.out).toContain("forced exposure rows: 0 (excluded from arms; a row's session may have 0 lines in this file)")
})

test("CLI: trialId selection uses the row with the max ts even when that row is forced:true — selection happens before forced filtering", async () => {
  const lines = [
    line({ sessionID: "s1" }), // only s1 has a visible sensor line in this file
  ]
  const f = sensorFile(lines)
  exposureFileBeside(f, [
    expRow({ sessionID: "s1", trialId: "t-old", ts: 1000, arm: "baseline", forced: false }),
    // s2's row has the max ts and is forced — it still determines the scoping
    // trialId ("t-new"), even though the row itself is excluded from the arms.
    expRow({ sessionID: "s2", trialId: "t-new", ts: 2000, arm: "trial", forced: true }),
  ])

  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toContain("t-new")
  expect(r.out).not.toContain("t-old")
  // s1's row belongs to the non-selected older trial -> reported as not-shown.
  expect(r.out).toContain("other-trial rows: 1 (not shown)")
  // the forced s2 row is the ONLY row in the selected trial, so both arms are empty.
  expect(r.out).toMatch(/baseline.*cycles\s+0.*sessions\s+0.*sessions-w-cycle\s+0.*density 0\.00/)
  expect(r.out).toMatch(/trial.*cycles\s+0.*sessions\s+0.*sessions-w-cycle\s+0.*density 0\.00/)
  expect(r.out).toContain("forced exposure rows: 1 (excluded from arms; a row's session may have 0 lines in this file)")
})

test("CLI: §4.3 trial block excludes skipped-stop lines from BOTH density and metrics (Task 1, own rationale, not gauge-only's)", async () => {
  const lines = [
    line({ sessionID: "s1" }), // baseline, 1 clean gate cycle -> metrics 1, density 1
    line({ sessionID: "s1", rounds: [], skippedStop: true }), // must count toward NEITHER
    line({ sessionID: "s1", rounds: [], skippedStop: true }),
  ]
  const f = sensorFile(lines)
  exposureFileBeside(f, [expRow({ sessionID: "s1", arm: "baseline", forced: false })])

  const r = await runCli([f, "--min-n", "1"])
  expect(r.out).toMatch(/baseline.*cycles\s+1.*sessions\s+1.*sessions-w-cycle\s+1.*density 1\.00/)
})

test("CLI: --json output is unaffected by an adjacent trial-arms.ndjson (still parseable, no trial key required)", async () => {
  const f = sensorFile(MANY(2, {}))
  exposureFileBeside(f, [expRow({ sessionID: "s" })])
  const parsed = JSON.parse((await runCli([f, "--json", "--min-n", "1"])).out)
  expect(parsed.groups.length).toBe(1)
})
