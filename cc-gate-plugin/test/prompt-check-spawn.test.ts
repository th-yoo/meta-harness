import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LOCK_REL_PATH, maybeSpawnPromptCheck } from "../src/prompt-check-spawn.ts"
import { parseGateConfig } from "../src/config.ts"
import type { SensorLine } from "../src/types.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-prompt-check-spawn-"))
}

const NOW = new Date("2026-07-31T10:00:00Z").getTime()
const CFG = parseGateConfig(`{"check": "bun test"}`)
const CFG_LONG_TIMEOUT = parseGateConfig(`{"check": "bun test", "checkTimeoutMs": 600000}`)
const TRIGGERED: SensorLine = {
  ts: NOW,
  sessionID: "sid-1",
  check: "bun test",
  accepted: true,
  gateExhausted: false,
  rounds: [],
  interrupted: false,
  marker: false,
  durationMs: 100,
  host: "h",
  app: "claude-code",
  skippedStop: true,
}
const NOT_TRIGGERED: SensorLine = { ...TRIGGERED, skippedStop: undefined }

interface Spawned {
  cmd: string[]
}

function run(opts: {
  repo: string
  cfg?: ReturnType<typeof parseGateConfig>
  sensor?: SensorLine | undefined
  env?: Record<string, string | undefined>
  now?: number
}): { result: string; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  const result = maybeSpawnPromptCheck({
    cwd: opts.repo,
    sessionID: "sid-1",
    sensor: "sensor" in opts ? opts.sensor : TRIGGERED,
    cfg: "cfg" in opts ? opts.cfg : CFG,
    env: opts.env ?? {},
    now: opts.now ?? NOW,
    spawn: (cmd) => spawned.push({ cmd }),
  })
  return { result, spawned }
}

function lockPathFor(repo: string): string {
  return path.join(repo, LOCK_REL_PATH)
}

test("no skippedStop → skipped:no-trigger, no lock, no spawn", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ repo, sensor: NOT_TRIGGERED })
  expect(result).toBe("skipped:no-trigger")
  expect(spawned.length).toBe(0)
  expect(fs.existsSync(lockPathFor(repo))).toBe(false)
})

test("undefined sensor → skipped:no-trigger", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ repo, sensor: undefined })
  expect(result).toBe("skipped:no-trigger")
  expect(spawned.length).toBe(0)
})

test("missing cfg.check → skipped:no-check", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ repo, cfg: undefined })
  expect(result).toBe("skipped:no-check")
  expect(spawned.length).toBe(0)
})

test("KKAMAK_PROMPT_CHECK=off kill-switch → skipped:env-off", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ repo, env: { KKAMAK_PROMPT_CHECK: "off" } })
  expect(result).toBe("skipped:env-off")
  expect(spawned.length).toBe(0)
})

test("happy path: creates lock, spawns prompt-check-cli with cwd/sessionID/ts argv", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ repo })
  expect(result).toBe("spawned")
  expect(spawned.length).toBe(1)
  const cmd = spawned[0]!.cmd
  expect(cmd[0]).toBe("bun")
  expect(cmd[1]).toContain("prompt-check-cli.ts")
  expect(cmd[2]).toBe(repo)
  expect(cmd[3]).toBe("sid-1")
  expect(cmd[4]).toBe(String(NOW))

  const lockRaw = fs.readFileSync(lockPathFor(repo), "utf-8")
  const lock = JSON.parse(lockRaw)
  expect(lock.spawnTs).toBe(NOW)
  expect(typeof lock.pid).toBe("number")
})

test("second call while lock fresh → skipped:in-flight, spawn NOT called", () => {
  const repo = mkRepo()
  run({ repo })
  const { result, spawned } = run({ repo, now: NOW + 1000 })
  expect(result).toBe("skipped:in-flight")
  expect(spawned.length).toBe(0)
})

test("stale lock (backdated spawnTs beyond default staleMs) → takeover → spawned", () => {
  const repo = mkRepo()
  const lockPath = lockPathFor(repo)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const staleSpawnTs = NOW - (300_000 + 60_000 + 1)
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, spawnTs: staleSpawnTs }))

  const { result, spawned } = run({ repo })
  expect(result).toBe("spawned")
  expect(spawned.length).toBe(1)
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf-8"))
  expect(lock.spawnTs).toBe(NOW)
})

test("cfg-derived staleness: checkTimeoutMs 600000 → lock aged 400s still in-flight (not falsely stale under hardcoded 360s)", () => {
  const repo = mkRepo()
  const lockPath = lockPathFor(repo)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const agedSpawnTs = NOW - 400_000 // 400s old; staleMs = 600000+60000 = 660000
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, spawnTs: agedSpawnTs }))

  const { result, spawned } = run({ repo, cfg: CFG_LONG_TIMEOUT })
  expect(result).toBe("skipped:in-flight")
  expect(spawned.length).toBe(0)
})

test("vanished lock (dangling symlink: EEXIST at probe, ENOENT at read) → takeover → spawned, never skipped:error", () => {
  const repo = mkRepo()
  const lockPath = lockPathFor(repo)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.symlinkSync(path.join(repo, "nonexistent-target"), lockPath)

  const { result, spawned } = run({ repo })
  expect(result).toBe("spawned")
  expect(spawned.length).toBe(1)
})

test("torn-write lock (unparseable content) → takeover → spawned, never skipped:error", () => {
  const repo = mkRepo()
  const lockPath = lockPathFor(repo)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  fs.writeFileSync(lockPath, "{not valid json at all")

  const { result, spawned } = run({ repo })
  expect(result).toBe("spawned")
  expect(spawned.length).toBe(1)
})

test("takeover race: concurrent process wins the fresh O_EXCL after our unlink → skipped:in-flight, spawn NOT called", () => {
  const repo = mkRepo()
  const lockPath = lockPathFor(repo)
  fs.mkdirSync(path.dirname(lockPath), { recursive: true })
  const staleSpawnTs = NOW - (300_000 + 60_000 + 1)
  fs.writeFileSync(lockPath, JSON.stringify({ pid: 1, spawnTs: staleSpawnTs }))

  // Inject a race: right after our takeover unlinks the stale lock, a
  // concurrent process recreates it before we attempt our own fresh
  // O_EXCL create.
  const origUnlink = fs.unlinkSync
  fs.unlinkSync = ((...args: Parameters<typeof fs.unlinkSync>) => {
    const r = origUnlink(...args)
    fs.writeFileSync(lockPath, JSON.stringify({ pid: 999, spawnTs: NOW }), { flag: "wx" })
    return r
  }) as typeof fs.unlinkSync

  try {
    const { result, spawned } = run({ repo })
    expect(result).toBe("skipped:in-flight")
    expect(spawned.length).toBe(0)
  } finally {
    fs.unlinkSync = origUnlink
  }
})

test("spawn throwing is swallowed (prime directive) → skipped:error", () => {
  const repo = mkRepo()
  expect(() =>
    maybeSpawnPromptCheck({
      cwd: repo,
      sessionID: "sid-1",
      sensor: TRIGGERED,
      cfg: CFG,
      env: {},
      now: NOW,
      spawn: () => {
        throw new Error("boom")
      },
    }),
  ).not.toThrow()
})

test("spawn throwing releases the fresh lock (finding M2) → lock absent afterward, no stranded ~staleMs outage", () => {
  const repo = mkRepo()
  let result: string | undefined
  expect(() => {
    result = maybeSpawnPromptCheck({
      cwd: repo,
      sessionID: "sid-1",
      sensor: TRIGGERED,
      cfg: CFG,
      env: {},
      now: NOW,
      spawn: () => {
        throw new Error("boom")
      },
    })
  }).not.toThrow()
  expect(result).toBe("skipped:error")
  expect(fs.existsSync(lockPathFor(repo))).toBe(false)
})
