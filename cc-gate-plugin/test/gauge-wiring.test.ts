// Integration: the real hook-cli process with gauge enabled — spawn seam on
// UserPromptSubmit (detached refiner against a stub claude bin) and shadow
// eval on Stop. Mirrors cli.test.ts harness style.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { FileStateStore } from "../src/state.ts"
import { INITIAL_STATE, type CcGateState } from "../src/types.ts"
import { gaugeDir, writeGaugeFile } from "../src/gauge/files.ts"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")

async function runHook(opts: {
  event: string
  stdin: string
  env?: Record<string, string>
}): Promise<number> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete env.MH_CHILD
  delete env.KM_CHILD
  delete env.KKAMAK_DELIVERY
  delete env.KKAMAK_GAUGE
  if (opts.env) Object.assign(env, opts.env)
  const proc = Bun.spawn(["bun", HOOK_CLI, opts.event], {
    stdout: "ignore",
    stderr: "ignore",
    stdin: new TextEncoder().encode(opts.stdin),
    env,
  })
  return proc.exited
}

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-wire-"))
}

function writeGate(repo: string, cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify(cfg))
}

function seedState(repo: string, sessionId: string, overrides: Partial<CcGateState>): void {
  const store = new FileStateStore(path.join(repo, ".km", "cc-gate"))
  store.save(sessionId, { ...INITIAL_STATE, ...overrides })
}

function sensorLines(repo: string): Record<string, unknown>[] {
  const p = path.join(repo, ".km", "gate-outcomes.ndjson")
  return fs
    .readFileSync(p, "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l))
}

function stubBin(repo: string): string {
  const derivation = {
    goalSummary: "stub goal",
    criteria: ["stub criterion"],
    check: "test -f done-marker.txt",
    confidence: 0.9,
  }
  const wrapper = JSON.stringify({ type: "result", result: JSON.stringify(derivation) })
  const p = path.join(repo, "stub-claude")
  fs.writeFileSync(p, `#!/usr/bin/env bash\ncat >/dev/null\necho '${wrapper.replace(/'/g, `'\\''`)}'\n`)
  fs.chmodSync(p, 0o755)
  return p
}

const SID = "wire-sid"

function promptStdin(repo: string, prompt: string): string {
  return JSON.stringify({ session_id: SID, cwd: repo, prompt })
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return pred()
}

test("UserPromptSubmit + gauge on + task prompt → detached refiner produces the pending gauge file", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  const bin = stubBin(repo)

  await runHook({
    event: "UserPromptSubmit",
    stdin: promptStdin(repo, "create done-marker.txt at the repo root"),
    env: { KKAMAK_GAUGE_CLAUDE_BIN: bin },
  })

  // req written synchronously by the hook; pending file arrives from the
  // detached refiner shortly after.
  const pendingPath = path.join(gaugeDir(repo), `${SID}-1.json`)
  expect(await waitFor(() => fs.existsSync(pendingPath))).toBe(true)
  const gauge = JSON.parse(fs.readFileSync(pendingPath, "utf-8"))
  expect(gauge.check).toBe("test -f done-marker.txt")

  const count = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "daily-count"), "utf-8"))
  expect(count.count).toBe(1)
})

test("UserPromptSubmit with KKAMAK_GAUGE=off → nothing written", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  await runHook({
    event: "UserPromptSubmit",
    stdin: promptStdin(repo, "create done-marker.txt"),
    env: { KKAMAK_GAUGE: "off" },
  })
  expect(fs.existsSync(gaugeDir(repo))).toBe(false)
})

test("UserPromptSubmit with gauge unset in config → nothing written", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  await runHook({ event: "UserPromptSubmit", stdin: promptStdin(repo, "create done-marker.txt") })
  expect(fs.existsSync(gaugeDir(repo))).toBe(false)
})

test("Stop with pending gauge + edited session → sensor line carries gauge field (M3 shape), pending consumed", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true }) // floor passes; gauge check fails (no done-marker.txt)
  seedState(repo, SID, { edited: true })
  writeGaugeFile(gaugeDir(repo), {
    v: 1,
    sessionID: SID,
    n: 1,
    ts: 1,
    model: "haiku",
    derivationMs: 5,
    goalSummary: "g",
    criteria: ["c"],
    check: "test -f done-marker.txt",
    confidence: 0.9,
  })

  await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: SID, cwd: repo }) })

  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  const g = lines[0]!.gauge as Record<string, unknown>
  expect(g.present).toBe(true)
  expect(g.executable).toBe(true)
  expect(g.pass).toBe(false)
  expect(g.wouldBlock).toBe(true)
  expect(g.agreesWithFloor).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), `${SID}-1.json`))).toBe(false)
  expect(fs.existsSync(path.join(gaugeDir(repo), `${SID}-1.done.json`))).toBe(true)
})

test("fast-path Stop (no edits) + pending gauge → gauge-only line with rounds:[]", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  writeGaugeFile(gaugeDir(repo), {
    v: 1,
    sessionID: SID,
    n: 1,
    ts: 1,
    model: "haiku",
    derivationMs: 5,
    goalSummary: "g",
    criteria: ["c"],
    check: "true",
    confidence: 0.9,
  })

  await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: SID, cwd: repo }) })

  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  expect(lines[0]!.rounds).toEqual([])
  const g = lines[0]!.gauge as Record<string, unknown>
  expect(g.pass).toBe(true)
  expect(g.agreesWithFloor).toBeUndefined()
})

test("Stop without gauge config behaves exactly as before (no gauge field)", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" })
  seedState(repo, SID, { edited: true })
  await runHook({ event: "Stop", stdin: JSON.stringify({ session_id: SID, cwd: repo }) })
  const lines = sensorLines(repo)
  expect(lines.length).toBe(1)
  expect(lines[0]!.gauge).toBeUndefined()
})

// ── §4.4 reinject-wording experiment (pre-reg §4b) ───────────────────────

test("blocked turn: v1 arm receives the composed do-not-re-run message", async () => {
  const repo = mkRepo()
  // The check must EMIT output: v1 composes from the raw output and
  // fails open to kernel text when there is none (bare `false` case).
  writeGate(repo, { check: "echo wiring-fail; false", rounds: 2 })
  seedState(repo, SID, { edited: true })

  const proc = Bun.spawn(["bun", HOOK_CLI, "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, cwd: repo })),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...(process.env as Record<string, string>), KKAMAK_REINJECT: "v1" },
  })
  const [out] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  const payload = JSON.parse(out)
  expect(payload.decision).toBe("block")
  expect(payload.reason.toLowerCase()).toContain("do not run it yourself")
  expect(payload.reason).toContain("wiring-fail")
  expect(payload.reason).not.toContain("re-run it") // contradiction gone
})

test("blocked turn: v0 arm gets the kernel wording untouched", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "false", rounds: 2 })
  seedState(repo, SID, { edited: true })

  const proc = Bun.spawn(["bun", HOOK_CLI, "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, cwd: repo })),
    stdout: "pipe",
    stderr: "ignore",
    env: { ...(process.env as Record<string, string>), KKAMAK_REINJECT: "v0" },
  })
  const [out] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  const payload = JSON.parse(out)
  expect(payload.decision).toBe("block")
  expect(payload.reason.toLowerCase()).not.toContain("do not run it yourself")
})

test("every sensor line records the reinject arm, so the scorecard can split by it", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true" }) // passes -> accepted cycle, still records the arm
  seedState(repo, SID, { edited: true })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: SID, cwd: repo }),
    env: { KKAMAK_REINJECT: "v1" },
  })
  const lines = sensorLines(repo)
  expect(lines[0]!.reinject).toBe("v1")
})

test("REGRESSION: the reinject arm survives the gauge path (both fields on one line)", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  seedState(repo, SID, { edited: true })
  writeGaugeFile(gaugeDir(repo), {
    v: 1, sessionID: SID, n: 1, ts: 1, model: "haiku", derivationMs: 5,
    goalSummary: "g", criteria: ["c"], check: "true", confidence: 0.9,
  })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: SID, cwd: repo }),
    env: { KKAMAK_REINJECT: "v0" },
  })
  const l = sensorLines(repo)[0]!
  expect(l.reinject).toBe("v0")
  expect((l.gauge as Record<string, unknown>).present).toBe(true)
})

test("REGRESSION: a gauge-only line (no gate cycle) still records the arm", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  writeGaugeFile(gaugeDir(repo), {
    v: 1, sessionID: SID, n: 1, ts: 1, model: "haiku", derivationMs: 5,
    goalSummary: "g", criteria: ["c"], check: "true", confidence: 0.9,
  })
  await runHook({
    event: "Stop",
    stdin: JSON.stringify({ session_id: SID, cwd: repo }),
    env: { KKAMAK_REINJECT: "v1" },
  })
  const l = sensorLines(repo)[0]!
  expect(l.rounds).toEqual([])
  expect(l.reinject).toBe("v1")
})

// ── shadow invariant lock (M0-M3 window closed 2026-07-29, M2 FAIL) ──────
// A would-block gauge must never surface in the emitted Stop decision: the
// gauge shapes ONLY the sensor line. This is the structural guarantee the
// 90% false-block rate is contained by — lock it against refactors.

test("wouldBlock gauge + passing floor → emitted decision is still allow", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "true", gauge: true })
  seedState(repo, SID, { edited: true })
  writeGaugeFile(gaugeDir(repo), {
    v: 1,
    sessionID: SID,
    n: 1,
    ts: 1,
    model: "haiku",
    derivationMs: 5,
    goalSummary: "g",
    criteria: ["c"],
    check: "false", // derived check fails -> wouldBlock: true
    confidence: 0.9,
  })

  const proc = Bun.spawn(["bun", HOOK_CLI, "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: SID, cwd: repo })),
    stdout: "pipe",
    stderr: "ignore",
    env: (() => {
      const env = { ...(process.env as Record<string, string>) }
      delete env.MH_CHILD
      delete env.KM_CHILD
      delete env.KKAMAK_DELIVERY
      delete env.KKAMAK_GAUGE
      return env
    })(),
  })
  const [out, code] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])

  // Allow-family: exit 0, no block payload on stdout.
  expect(code).toBe(0)
  expect(out).not.toContain('"decision"')

  // The would-block verdict landed ONLY on the sensor line.
  const l = sensorLines(repo)[0]!
  expect(l.accepted).toBe(true)
  expect(l.gateExhausted).toBe(false)
  const g = l.gauge as Record<string, unknown>
  expect(g.wouldBlock).toBe(true)
  expect(g.agreesWithFloor).toBe(false)
})
