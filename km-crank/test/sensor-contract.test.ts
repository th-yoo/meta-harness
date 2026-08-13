// sensor-contract.test.ts — Phase 0 Task 2 (2026-07-30 phase0-contract-events
// plan). Guards the drift class that made kkamak's kernel-emitted sensor
// lines invisible to km-crank: a separate repo (~/z2/kkamak) reimplements
// the sensor emitter and today emits `sessionId` (wrong casing) without
// `marker` — scan.ts's `isSensorLine` silently drops every such line, no
// error, no signal. This file (a) proves the real parser accepts every
// contract-conforming vector line, (b) proves it silently rejects the exact
// drift shape (sessionId casing), and (c) carries an advisory cross-repo
// byte-parity check against kkamak's canonical fixture (D2, ratified
// decisions in docs/superpowers/plans/2026-07-30-phase0-contract-events.md).
//
// Counterpart (canonical) file: ~/z2/kkamak/test/fixtures/sensor-contract.ndjson
// (relative from meta-harness repo root: ../kkamak/test/fixtures/sensor-contract.ndjson).
// D2: that file is the standalone/publishable canonical copy; kkamak's Task 1
// authors it BY COPYING THE FIVE LINES BELOW BYTE-FOR-BYTE (execution-order
// note: this repo's vectors are authored first — kkamak's fixture doesn't
// exist yet, so the parity check below skips with a printed notice until it
// lands). Header comment there must name this file back. (a3 live adapter
// Task 5, 2026-08-13: 5th vector line added — ruleChecks contract rev — the
// parity check below now HARD-FAILS if a present fixture lacks it; see the
// advisory-parity test near the bottom of this file.)
//
// Vector field truth derived from the frozen contract
// (cc-gate-plugin/src/types.ts's SensorLine, ~:150-165) and km-crank's own
// re-declared parser shape (src/scan.ts's SensorLine + isSensorLine,
// ~:27-74), not invented. Key order and optional-field combinations mirror
// real emission: core/sensor.ts's buildSensorLine (required fields +
// checkMs/skippedStop) followed by hook-cli.ts's appendSensor
// (pluginVersion stamp) and, on the Stop path only, the reinject/forced
// stamp (hook-cli.ts:309-320) — skippedStop lines (UserPromptSubmit path)
// never carry reinject/forced, matching hook-cli.ts:249-251.

import { test, expect } from "bun:test"
import { existsSync, readFileSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { parseSensorLines } from "../src/scan.ts"

// ── Canonical vector lines (byte-identical to the kkamak counterpart file
// once it exists) — one line per required contract-2 shape. ────────────────

/** 1. Clean accept: single round, no failures. */
const CLEAN_ACCEPT =
  '{"ts":1753848001000,"sessionID":"sess-a1b2c3d4","check":"bun test","accepted":true,"gateExhausted":false,"rounds":["accepted"],"interrupted":false,"marker":true,"durationMs":4210,"host":"kkamak-dev","app":"claude-code","checkMs":[1180],"pluginVersion":"0.3.1","reinject":"v1"}'

/** 2. Catch: block round then fix (verify-failed -> accepted). Also
 * exercises `forced` (KKAMAK_REINJECT env override), coherently paired with
 * `reinject` per hook-cli.ts:309-320 — `forced` never appears alone in real
 * emission. */
const CATCH_BLOCK_THEN_FIX =
  '{"ts":1753848062500,"sessionID":"sess-e5f6a7b8","check":"bun test","accepted":true,"gateExhausted":false,"rounds":["verify-failed","accepted"],"interrupted":false,"marker":true,"durationMs":18734,"host":"kkamak-dev","app":"claude-code","checkMs":[2310,1290],"pluginVersion":"0.3.1","reinject":"v0","forced":true}'

/** 3. Exhausted: rounds budget spent, gateExhausted:true. marker is always
 * false here — stop.ts:136-137: "Marker must NOT fire on exhaustion even
 * with cfg.marker true." */
const EXHAUSTED =
  '{"ts":1753848140000,"sessionID":"sess-c9d0e1f2","check":"bun test","accepted":true,"gateExhausted":true,"rounds":["verify-failed","verify-failed"],"interrupted":false,"marker":false,"durationMs":26510,"host":"kkamak-dev","app":"claude-code","checkMs":[2890,3105],"pluginVersion":"0.3.1","reinject":"v1"}'

/** 4. skippedStop-shaped diagnostic: prompt.ts's sole emission point for a
 * queued-prompt-ate-the-Stop-boundary marker (rounds:[], durationMs:0). No
 * reinject/forced — the UserPromptSubmit path (hook-cli.ts:249-251) never
 * stamps those; only pluginVersion (appendSensor, all paths). */
const SKIPPED_STOP_DIAGNOSTIC =
  '{"ts":1753848201000,"sessionID":"sess-f3a4b5c6","check":"bun test","accepted":true,"gateExhausted":false,"rounds":[],"interrupted":false,"marker":false,"durationMs":0,"host":"kkamak-dev","app":"claude-code","skippedStop":true,"pluginVersion":"0.3.1"}'

/** 5. a3 live adapter (Task 5, 2026-08-13 contract rev): same shape as (1)
 * plus the shadow rule-check outcomes — {id,pass,ms} | {id,skipped} |
 * {id,refused} — SHADOW-only, never influencing accepted/rounds. Mirrors
 * cc-gate-plugin/src/types.ts's SensorLine.ruleChecks and km-crank's own
 * src/scan.ts SensorLine mirror; emitted on Stop cycles only, alongside
 * checkMs, per types.ts's doc comment on ruleChecks. */
const CLEAN_ACCEPT_WITH_RULE_CHECKS =
  '{"ts":1753848301000,"sessionID":"sess-a7b8c9d0","check":"bun test","accepted":true,"gateExhausted":false,"rounds":["accepted"],"interrupted":false,"marker":true,"durationMs":3980,"host":"kkamak-dev","app":"claude-code","checkMs":[1050],"pluginVersion":"0.3.1","reinject":"v1","ruleChecks":[{"id":"no-any","pass":true,"ms":42},{"id":"no-console","skipped":true},{"id":"no-todo","refused":true}]}'

const VECTOR_LINES = [
  CLEAN_ACCEPT,
  CATCH_BLOCK_THEN_FIX,
  EXHAUSTED,
  SKIPPED_STOP_DIAGNOSTIC,
  CLEAN_ACCEPT_WITH_RULE_CHECKS,
]

// ── Parser acceptance: every vector line survives parseSensorLines ─────────

test("sensor-contract vectors: parseSensorLines accepts every vector line (none dropped)", () => {
  const text = VECTOR_LINES.join("\n") + "\n"
  const result = parseSensorLines(text)
  expect(result).toHaveLength(VECTOR_LINES.length)
  expect(result).toEqual(VECTOR_LINES.map((l) => JSON.parse(l)))
})

test("sensor-contract vectors: each vector line is individually well-formed JSON matching its required shape", () => {
  for (const l of VECTOR_LINES) {
    const parsed = parseSensorLines(l + "\n")
    expect(parsed).toHaveLength(1)
  }
})

// ── Deliberate rejection: the exact drift class this test guards ───────────
// kkamak's current (broken) emitter writes `sessionId` (lowercase d), not
// `sessionID`, and omits `marker` entirely — isSensorLine (scan.ts:57-74)
// requires both, so every such line is silently dropped, no error. Prove it.

test("sensor-contract drift guard: a sessionId-cased line (the kkamak drift) is silently dropped, not accepted", () => {
  const good = JSON.parse(CLEAN_ACCEPT) as Record<string, unknown>
  const { sessionID, ...rest } = good
  const broken = { ...rest, sessionId: sessionID } // wrong casing, exact kkamak drift shape
  expect(broken).not.toHaveProperty("sessionID")

  const text = `${JSON.stringify(broken)}\n${CLEAN_ACCEPT}\n`
  const result = parseSensorLines(text)
  // The broken line vanishes; only the well-formed vector line survives.
  expect(result).toHaveLength(1)
  expect(result[0]!.sessionID).toBe("sess-a1b2c3d4")
})

test("sensor-contract drift guard: a sessionId-cased line missing marker too (full kkamak drift) is also dropped", () => {
  const good = JSON.parse(CLEAN_ACCEPT) as Record<string, unknown>
  const { sessionID, marker, ...rest } = good
  const broken = { ...rest, sessionId: sessionID } // no sessionID AND no marker
  const result = parseSensorLines(JSON.stringify(broken) + "\n")
  expect(result).toEqual([])
})

// ── Advisory cross-repo parity (D2) ─────────────────────────────────────────
// Canonical vector file lives in kkamak: test/fixtures/sensor-contract.ndjson
// (D2). Execution-order note (this task's brief): kkamak's Task 1 hasn't
// landed yet at authoring time, so the fixture does not exist — this check
// SKIPS with a printed notice rather than failing. Once it lands (copied
// byte-for-byte from VECTOR_LINES above), this becomes a real byte-compare
// that fails loudly on drift, naming both files.
//
// a3 live adapter Task 5 (2026-08-13 contract rev): absent fixture is STILL
// an advisory skip (yoo-mac has no kkamak clone). A PRESENT fixture that
// lacks the ruleChecks vector is now a HARD FAIL — the contract rev must not
// land half-updated silently (spec §4 round-2 finding 6). The vector-presence
// check is extracted into `assertFixtureHasRuleChecksVector` below so it's
// unit-testable against a temp file without needing an actual kkamak clone.

const KKAMAK_FIXTURE = path.join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "kkamak",
  "test",
  "fixtures",
  "sensor-contract.ndjson",
)

/** Throws iff `raw` (a sensor-contract.ndjson fixture's full text) does not
 * contain the ruleChecks vector — i.e. the a3 contract rev (Task 5) hasn't
 * been ported to this fixture yet. Extracted so the hard-fail branch is
 * unit-testable with a temp file (see the two tests directly below) rather
 * than only reachable via an actual kkamak clone, which this host lacks. */
export function assertFixtureHasRuleChecksVector(raw: string): void {
  if (!raw.includes('"ruleChecks"')) {
    throw new Error(
      "kkamak sensor-contract fixture is missing the ruleChecks vector — the a3 contract rev landed half-updated; update ~/z2/kkamak's fixture + conformance suite in the same change window",
    )
  }
}

test("assertFixtureHasRuleChecksVector: throws on a fixture missing the ruleChecks vector", () => {
  const tmp = path.join(tmpdir(), `sensor-contract-no-rulechecks-${Date.now()}-${Math.random()}.ndjson`)
  writeFileSync(tmp, VECTOR_LINES.slice(0, 4).join("\n") + "\n", "utf8")
  try {
    const raw = readFileSync(tmp, "utf8")
    expect(() => assertFixtureHasRuleChecksVector(raw)).toThrow(/missing the ruleChecks vector/)
  } finally {
    rmSync(tmp)
  }
})

test("assertFixtureHasRuleChecksVector: passes silently on a fixture containing the ruleChecks vector", () => {
  const tmp = path.join(tmpdir(), `sensor-contract-has-rulechecks-${Date.now()}-${Math.random()}.ndjson`)
  writeFileSync(tmp, VECTOR_LINES.join("\n") + "\n", "utf8")
  try {
    const raw = readFileSync(tmp, "utf8")
    expect(() => assertFixtureHasRuleChecksVector(raw)).not.toThrow()
  } finally {
    rmSync(tmp)
  }
})

test("sensor-contract advisory parity: byte-matches ../kkamak/test/fixtures/sensor-contract.ndjson when present", () => {
  // Absent fixture: still an advisory skip (yoo-mac has no kkamak clone).
  // PRESENT fixture that lacks the ruleChecks vector: HARD FAIL — the
  // contract rev must not land half-updated silently (spec §4 round-2
  // finding 6).
  if (!existsSync(KKAMAK_FIXTURE)) {
    console.log(
      `[sensor-contract] advisory parity SKIPPED: ${KKAMAK_FIXTURE} does not exist yet ` +
        `(kkamak Task 1 — phase0-contract-events plan — not landed) — advisory on this host; ` +
        `ruleChecks vector verification (a3 contract rev, Task 5) is pending on yoo-dev. Not a failure.`,
    )
    return
  }
  const theirs = readFileSync(KKAMAK_FIXTURE, "utf-8")
  assertFixtureHasRuleChecksVector(theirs)
  const ours = VECTOR_LINES.join("\n") + "\n"
  if (ours !== theirs) {
    throw new Error(
      "sensor-contract parity mismatch between " +
        "km-crank/test/sensor-contract.test.ts (embedded VECTOR_LINES, this repo) and " +
        `${KKAMAK_FIXTURE} (kkamak's canonical fixture) — the two must stay byte-identical (D2).`,
    )
  }
  expect(ours).toBe(theirs)
})
