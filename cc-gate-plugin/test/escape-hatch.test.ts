// ESCAPE HATCH — the properties that let a user stop kkamak mid-session,
// without restarting Claude Code or losing conversation context.
//
// These are SAFETY invariants, not features: if a future refactor caches
// gate.json at session start, the hot disarm silently dies and a wedged
// session has no exit. Locked here deliberately.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")
const PANIC = path.join(import.meta.dir, "..", "..", "scripts", "km-panic.sh")

function mkRepo(): string {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "km-panic-"))
  fs.mkdirSync(path.join(repo, ".km", "cc-gate"), { recursive: true })
  return repo
}

function arm(repo: string, sessionId: string): void {
  fs.writeFileSync(
    path.join(repo, ".km", "cc-gate", `${sessionId}.json`),
    JSON.stringify({
      v: 1, edited: true, gating: false, round: 0, outcomes: [],
      cycleStartedAt: 0, failStreak: 0, updatedAt: Date.now(),
    }),
  )
}

async function stop(repo: string, sessionId: string): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bun", HOOK_CLI, "Stop"], {
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: sessionId, cwd: repo })),
    stdout: "pipe",
    stderr: "ignore",
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { stdout, exitCode }
}

/** `km-panic.sh status` shells out to `claude plugin list` (km-panic.sh:66)
 * with no timeout, so this test's runtime is set by an EXTERNAL CLI's
 * startup: ~0.7s on an idle host, measured 4.5s under 6-way concurrency.
 * The gate runs tier-0 synchronously while a detached tier-1 bg run
 * (gate-check.ts spawnBg) executes the same suite, so two copies of this
 * file spawn `claude` at once — that pushed the status test past bun's
 * 5000ms default timeout and blocked the gate (5002.84ms, 2026-08-08).
 *
 * Stub `claude` on PATH for every panic() call: no test here asserts on the
 * plugin line (only that status prints "gate" and exits 0), so the real
 * binary bought nothing but latency and a host dependency — km-panic
 * already tolerates `claude` being absent entirely (`2>/dev/null`, `||
 * echo "kkamak not installed"`), which is exactly what a credential-less
 * or claude-less CI runner sees. Fix the flake at the test boundary, not
 * with a bigger timeout: a longer deadline would only make the same
 * unbounded spawn fail more slowly. */
const STUB_BIN = fs.mkdtempSync(path.join(os.tmpdir(), "km-panic-stubbin-"))
fs.writeFileSync(path.join(STUB_BIN, "claude"), "#!/bin/bash\necho 'kkamak (local)'\n")
fs.chmodSync(path.join(STUB_BIN, "claude"), 0o755)

async function panic(repo: string, ...args: string[]): Promise<{ stdout: string; exitCode: number }> {
  const proc = Bun.spawn(["bash", PANIC, ...args], {
    cwd: repo,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PATH: `${STUB_BIN}:${process.env.PATH ?? ""}` },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { stdout: stdout + stderr, exitCode }
}

test("INVARIANT: gate.json is re-read every hook call — disarm takes effect with no restart", async () => {
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "false", rounds: 2 }))

  arm(repo, "s1")
  const blocked = await stop(repo, "s1")
  expect(blocked.stdout).toContain("block")

  // Disarm between invocations, same session, no restart.
  fs.rmSync(path.join(repo, "gate.json"))
  arm(repo, "s1")
  const after = await stop(repo, "s1")
  expect(after.stdout).not.toContain("block")
  expect(after.exitCode).toBe(0)
})

test("km-panic off: disables the gate, keeps the config recoverable", async () => {
  const repo = mkRepo()
  const cfg = { check: "false", rounds: 2, gauge: true }
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify(cfg))

  const r = await panic(repo, "off")
  expect(r.exitCode).toBe(0)
  expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(false)
  expect(fs.existsSync(path.join(repo, "gate.json.disabled"))).toBe(true)

  arm(repo, "s2")
  expect((await stop(repo, "s2")).stdout).not.toContain("block")

  const back = await panic(repo, "restore")
  expect(back.exitCode).toBe(0)
  expect(JSON.parse(fs.readFileSync(path.join(repo, "gate.json"), "utf-8"))).toEqual(cfg)
})

test("km-panic gauge-off: stops refiner spend, leaves the gate running", async () => {
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "false", rounds: 2, gauge: true }))

  const r = await panic(repo, "gauge-off")
  expect(r.exitCode).toBe(0)
  const cfg = JSON.parse(fs.readFileSync(path.join(repo, "gate.json"), "utf-8"))
  expect(cfg.gauge).toBe(false)
  expect(cfg.check).toBe("false") // gate itself untouched

  arm(repo, "s3")
  expect((await stop(repo, "s3")).stdout).toContain("block") // still gating
})

test("km-panic status reports armed state without changing anything", async () => {
  const repo = mkRepo()
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "true", gauge: true }))

  const r = await panic(repo, "status")
  expect(r.exitCode).toBe(0)
  expect(r.stdout.toLowerCase()).toContain("gate")
  expect(fs.existsSync(path.join(repo, "gate.json"))).toBe(true)
})

test("km-panic is safe to run twice and in a repo with no gate.json", async () => {
  const repo = mkRepo()
  expect((await panic(repo, "off")).exitCode).toBe(0) // nothing to disable
  expect((await panic(repo, "status")).exitCode).toBe(0)

  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "true" }))
  expect((await panic(repo, "off")).exitCode).toBe(0)
  expect((await panic(repo, "off")).exitCode).toBe(0) // idempotent, no clobber
  expect(fs.existsSync(path.join(repo, "gate.json.disabled"))).toBe(true)
})

test("km-panic --help / -h / help print usage and exit 0", async () => {
  const repo = mkRepo()
  for (const flag of ["--help", "-h", "help"]) {
    const r = await panic(repo, flag)
    expect(r.exitCode).toBe(0)
    expect(r.stdout).toContain("gauge-off")
    expect(r.stdout).toContain("restore")
  }
})

test("km-panic with no argument prints usage and exits non-zero", async () => {
  const repo = mkRepo()
  const r = await panic(repo)
  expect(r.exitCode).not.toBe(0)
  expect(r.stdout).toContain("usage")
})

test("km-panic rejects an unknown verb loudly", async () => {
  const repo = mkRepo()
  const r = await panic(repo, "explode")
  expect(r.exitCode).not.toBe(0)
})
