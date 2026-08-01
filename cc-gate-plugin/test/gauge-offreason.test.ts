// test/gauge-offreason.test.ts — instrument-state visibility
// (pre-reg §6b amendment, 2026-08-01, user-approved).
//
// An absent gauge field used to be ambiguous: either the instrument ran and
// had nothing to say, or it was never running. Those are opposite facts, and
// on 2026-08-01 the second one went unnoticed for two cycles on the yoo-mac
// dogfood repo — a review removed `"gauge": true` from gate.json (correct
// against the PUBLIC kernel's schema, load-bearing for THIS build), the
// instrument silently disarmed, and gate cycles kept recording normally.
//
// A disarmed corpus and a starved corpus must not look alike: corpus
// starvation is what the activation precondition is read from.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { scoreLines } from "../src/score.ts"
import type { SensorLine } from "../src/types.ts"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")

async function runHook(opts: { event: string; stdin: string; env?: Record<string, string> }): Promise<void> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.MH_CHILD
  delete env.KM_CHILD
  delete env.KKAMAK_DELIVERY
  delete env.KKAMAK_GAUGE
  if (opts.env) Object.assign(env, opts.env)
  const proc = Bun.spawn(["bun", HOOK_CLI, opts.event], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(opts.stdin),
    env,
  })
  await new Response(proc.stdout as ReadableStream<Uint8Array>).text()
  await proc.exited
}

function mkRepo(cfg: Record<string, unknown>): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-offreason-"))
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

async function driveCycle(repo: string, sid: string, env?: Record<string, string>): Promise<Record<string, unknown>> {
  await runHook({
    event: "PostToolUse",
    stdin: JSON.stringify({ session_id: sid, cwd: repo, tool_name: "Write" }),
    env,
  })
  await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: sid, cwd: repo }), env })
  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  return lines[0]!
}

test("gauge disabled in gate.json -> the line SAYS so, instead of omitting the field", async () => {
  const repo = mkRepo({ check: "true" })
  try {
    const line = await driveCycle(repo, "sid-disabled")
    const gauge = line.gauge as Record<string, unknown> | undefined
    expect(gauge).toBeDefined()
    expect(gauge!.present).toBe(false)
    expect(gauge!.offReason).toBe("disabled")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("KKAMAK_GAUGE=off is distinguishable from never being configured", async () => {
  const repo = mkRepo({ check: "true", gauge: true })
  try {
    const line = await driveCycle(repo, "sid-envoff", { KKAMAK_GAUGE: "off" })
    const gauge = line.gauge as Record<string, unknown> | undefined
    expect(gauge!.present).toBe(false)
    expect(gauge!.offReason).toBe("env-off")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

test("armed but nothing derived -> no-record, NOT silence", async () => {
  // Gauge on, but this prompt never produced a derivation to attach.
  const repo = mkRepo({ check: "true", gauge: true })
  try {
    const line = await driveCycle(repo, "sid-norecord")
    const gauge = line.gauge as Record<string, unknown> | undefined
    expect(gauge!.present).toBe(false)
    expect(gauge!.offReason).toBe("no-record")
  } finally {
    fs.rmSync(repo, { recursive: true, force: true })
  }
})

// The amendment's BINDING clause: a present:false field is not a gauge record.
// If this ever fails, the change has moved the denominators the activation
// precondition is measured against — which it is explicitly forbidden to do.
test("metric neutrality: present:false contributes to NO gauge counter", () => {
  const base: SensorLine = {
    ts: 1,
    sessionID: "s",
    check: "bun test",
    accepted: true,
    gateExhausted: false,
    rounds: ["accepted"],
    interrupted: false,
    marker: false,
    durationMs: 10,
    host: "h",
    app: "claude-code",
  }
  const off = { ...base, gauge: { present: false, offReason: "disabled" } } as never
  const real = {
    ...base,
    ts: 2,
    gauge: { present: true, class: "C", reason: "extractable", executable: true },
  } as never

  const onlyOff = scoreLines([off], { minN: 1 })
  expect(onlyOff.gauge.present).toBe(0)
  expect(onlyOff.gauge.byClass).toEqual({ A1: 0, A2: 0, B: 0, C: 0, D: 0 })

  // And a present:false line must not perturb a real one counted beside it.
  const mixed = scoreLines([off, real], { minN: 1 })
  expect(mixed.gauge.present).toBe(1)
  expect(mixed.gauge.byClass.C).toBe(1)
})
