// test/sensor-contract.test.ts — emission conformance for THIS producer.
//
// Two implementations write the same stream (`.km/gate-outcomes.ndjson`):
// this research build and the standalone kernel in ~/z2/kkamak. The frozen
// SensorLine contract is what couples them — there is no shared code. Until
// now only kkamak proved that what it *emits* conforms (its
// test/sensor-contract.test.ts drives its kernel and asserts every line);
// this side only unit-tested the builder. That asymmetry mattered because
// this producer is the one whose lines feed the gauge corpus and the §4.3
// stream — the unproven emitter was the measured one.
//
// Scenario set mirrors the frozen vectors authored in
// km-crank/test/sensor-contract.test.ts (the authoritative copy; kkamak's
// test/fixtures/sensor-contract.ndjson is the publishable byte-identical
// counterpart): clean accept, block-then-fix, exhausted, skippedStop.
//
// This is NOT a byte-compare against those vectors — a driven run has its
// own timestamps, session ids and host — it proves the same *shape*.
//
// HERMETICITY: assertions here never depend on ambient environment. The
// reinject arm is env-gated (KKAMAK_REINJECT_V2 opens a third arm), so this
// file asserts only that `reinject`, when present, is drawn from the frozen
// variant set — never which arm was drawn. A test that reads the host's
// activation state fails on activated hosts only, which is exactly how the
// pre-v2 tests in reinject.test.ts broke after 4fec674.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")
const PKG_VERSION = (
  JSON.parse(fs.readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf-8")) as {
    version: string
  }
).version

const REQUIRED_FIELDS = [
  "ts",
  "sessionID",
  "check",
  "accepted",
  "gateExhausted",
  "interrupted",
  "rounds",
  "durationMs",
  "host",
  "app",
  "marker",
] as const

const ROUND_VOCAB = ["verify-failed", "accepted"] as const
const REINJECT_VARIANTS = ["v0", "v1", "v2"] as const

async function runHook(opts: { event: string; stdin: string }): Promise<number> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.MH_CHILD
  delete env.KM_CHILD
  delete env.KKAMAK_DELIVERY
  const proc = Bun.spawn(["bun", HOOK_CLI, opts.event], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(opts.stdin),
    env,
  })
  await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  return await proc.exited
}

function mkRepo(cfg: Record<string, unknown>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-contract-"))
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify(cfg))
  return repo
}

function sensorLines(repo: string): Record<string, unknown>[] {
  const p = path.join(repo, ".km", "gate-outcomes.ndjson")
  if (!fs.existsSync(p)) return []
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

const edit = (repo: string, sid: string) =>
  runHook({ event: "PostToolUse", stdin: JSON.stringify({ session_id: sid, cwd: repo, tool_name: "Write" }) })

const stop = (repo: string, sid: string) =>
  runHook({ event: "Stop", stdin: JSON.stringify({ session_id: sid, cwd: repo }) })

/**
 * Schema-level conformance: required fields present, correctly typed and
 * correctly cased; rounds drawn from the frozen vocabulary; optionals either
 * absent or well-typed.
 */
function assertConformsToSensorContract(line: Record<string, unknown>): void {
  for (const field of REQUIRED_FIELDS) expect(line).toHaveProperty(field)

  expect(typeof line.ts).toBe("number")
  expect(typeof line.sessionID).toBe("string")
  expect(typeof line.check).toBe("string")
  expect(typeof line.accepted).toBe("boolean")
  expect(typeof line.gateExhausted).toBe("boolean")
  expect(typeof line.interrupted).toBe("boolean")
  expect(typeof line.durationMs).toBe("number")
  expect(typeof line.host).toBe("string")
  expect(typeof line.app).toBe("string")
  expect(typeof line.marker).toBe("boolean")

  expect(Array.isArray(line.rounds)).toBe(true)
  for (const round of line.rounds as unknown[]) expect(ROUND_VOCAB).toContain(round as never)

  // The drift the frozen contract exists to prevent: the consumer's parser
  // keys on sessionID, and the wrong casing made whole streams invisible.
  expect(line).not.toHaveProperty("sessionId")

  if ("checkMs" in line) expect(Array.isArray(line.checkMs)).toBe(true)
  if ("skippedStop" in line) expect(typeof line.skippedStop).toBe("boolean")
  if ("forced" in line) expect(typeof line.forced).toBe("boolean")
  // Arm identity is env-gated; membership in the frozen set is not.
  if ("reinject" in line) expect(REINJECT_VARIANTS).toContain(line.reinject as never)

  // a3 live adapter (Task 4): shadow rule-check outcomes, when present.
  if ("ruleChecks" in line) {
    expect(Array.isArray(line.ruleChecks)).toBe(true)
    for (const rc of line.ruleChecks as Array<Record<string, unknown>>) {
      expect(typeof rc.id).toBe("string")
      expect("cmd" in rc).toBe(false) // F2: outcomes never carry command text
      const shapeOk =
        (typeof rc.pass === "boolean" && typeof rc.ms === "number") ||
        rc.skipped === true || rc.refused === true
      expect(shapeOk).toBe(true)
    }
  }

  // This producer can always determine its own version, so the optional
  // field is in practice always stamped — and must match the package it
  // shipped from, or a consumer cannot attribute the line.
  expect(line.pluginVersion).toBe(PKG_VERSION)
}

// Negative control. Every assertion above passed on its first run, which
// proves nothing on its own — a conformance check that cannot fail reads
// exactly like a conforming producer. This pins that the guard bites on the
// three drifts the frozen contract was written against.
test("the conformance check rejects the drift it exists to catch", () => {
  const conforming = {
    ts: 1, sessionID: "s", check: "bun test", accepted: true, gateExhausted: false,
    interrupted: false, rounds: ["accepted"], durationMs: 1, host: "h", app: "claude-code",
    marker: false, pluginVersion: PKG_VERSION,
  }
  expect(() => assertConformsToSensorContract({ ...conforming })).not.toThrow()

  // 1. the casing that made whole streams invisible to the consumer
  const { sessionID, ...withoutSessionID } = conforming
  expect(() => assertConformsToSensorContract({ ...withoutSessionID, sessionId: sessionID })).toThrow()
  // 2. a rounds vocabulary the consumer's parser does not recognise
  expect(() => assertConformsToSensorContract({ ...conforming, rounds: ["passed"] })).toThrow()
  // 3. a required field silently dropped
  const { marker, ...withoutMarker } = conforming
  expect(() => assertConformsToSensorContract(withoutMarker)).toThrow()
  // 4. a line attributed to a version this package never shipped
  expect(() => assertConformsToSensorContract({ ...conforming, pluginVersion: "9.9.9" })).toThrow()
})

test("driven emission conforms: clean accept", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    await edit(repo, "sid-clean")
    await stop(repo, "sid-clean")

    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.rounds).toEqual(["accepted"])
    expect(line.accepted).toBe(true)
    expect(line.gateExhausted).toBe(false)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("driven emission conforms: block then fix", async () => {
  // Fails once, then passes — the canonical catch-and-recover cycle.
  const repo = mkRepo({ check: "test -f .fail_once && rm .fail_once && exit 1 || exit 0", rounds: 2 })
  try {
    fs.writeFileSync(path.join(repo, ".fail_once"), "")
    await edit(repo, "sid-catch")
    await stop(repo, "sid-catch") // blocks: check fails, cycle stays open
    expect(sensorLines(repo).length).toBe(0)
    await stop(repo, "sid-catch") // passes: cycle closes, one line for the whole cycle

    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.rounds).toEqual(["verify-failed", "accepted"])
    expect(line.accepted).toBe(true)
    expect(line.gateExhausted).toBe(false)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("driven emission conforms: exhausted", async () => {
  const repo = mkRepo({ check: "false", rounds: 1 })
  try {
    await edit(repo, "sid-exhausted")
    await stop(repo, "sid-exhausted") // round 1 blocks
    await stop(repo, "sid-exhausted") // budget spent: allowed through, recorded

    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.gateExhausted).toBe(true)
    expect(line.accepted).toBe(true)
    expect((line.rounds as string[]).every((r) => r === "verify-failed")).toBe(true)
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("driven emission conforms: skippedStop diagnostic", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    await edit(repo, "sid-skipped")
    // A queued prompt consumes the turn boundary before any Stop arrives.
    await runHook({
      event: "UserPromptSubmit",
      stdin: JSON.stringify({ session_id: "sid-skipped", cwd: repo, prompt: "more work" }),
    })

    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.skippedStop).toBe(true)
    expect(line.rounds).toEqual([])
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

// ── a3 live adapter (Task 4): shadow rule checks wired into the Stop path ──

test("SHADOW + byte-identity: absent rule-checks file -> emitted line has NO ruleChecks key", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    await edit(repo, "sid-rc-absent")
    await stop(repo, "sid-rc-absent")
    const lines = sensorLines(repo)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect("ruleChecks" in line).toBe(false)
    expect(line.accepted).toBe(true)
    expect(line.rounds).toEqual(["accepted"])
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("SHADOW invariant: failing rule check annotates the line; Stop still accepts, single line, no extra rounds", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    fs.mkdirSync(path.join(repo, ".km"), { recursive: true })
    fs.writeFileSync(
      path.join(repo, ".km", "rule-checks.json"),
      JSON.stringify({ version: 1, writtenTs: 1, rules: [{ id: "pb-1", cmd: "false", timeoutMs: 1000, state: "shadow" }] }),
    )
    await edit(repo, "sid-rc-shadow")
    await stop(repo, "sid-rc-shadow")
    const lines = sensorLines(repo)
    expect(lines.length).toBe(1) // one line, one cycle — the failing rule did NOT block or reopen
    const line = lines[0]!
    assertConformsToSensorContract(line)
    expect(line.accepted).toBe(true)
    expect(line.rounds).toEqual(["accepted"]) // no verify-failed round from the rule check
    expect(line.ruleChecks).toHaveLength(1)
    const rc = (line.ruleChecks as Array<{ id: string; pass: boolean; ms: number }>)[0]!
    expect(rc.id).toBe("pb-1")
    expect(rc.pass).toBe(false)
    expect(typeof rc.ms).toBe("number")
    expect(JSON.stringify(line)).not.toContain("false\"") // F2: no cmd text on the line (cmd was "false")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})
