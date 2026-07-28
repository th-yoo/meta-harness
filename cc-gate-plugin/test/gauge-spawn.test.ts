import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { maybeSpawnGauge } from "../src/gauge/spawn.ts"
import { gaugeDir } from "../src/gauge/files.ts"
import { parseGateConfig } from "../src/config.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-gauge-spawn-"))
}

const GAUGE_ON = parseGateConfig(`{"check": "true", "gauge": true}`)
const GAUGE_OFF = parseGateConfig(`{"check": "true"}`)
const PROMPT = "fix the parser in src/config.ts"
const NOW = new Date("2026-07-28T10:00:00Z").getTime()

interface Spawned {
  cmd: string[]
}

function run(opts: {
  repo: string
  cfg?: ReturnType<typeof parseGateConfig>
  prompt?: unknown
  env?: Record<string, string | undefined>
}): { n: number | undefined; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  const n = maybeSpawnGauge({
    cwd: opts.repo,
    sessionID: "sid-1",
    prompt: opts.prompt ?? PROMPT,
    cfg: "cfg" in opts ? opts.cfg : GAUGE_ON,
    env: opts.env ?? {},
    now: NOW,
    spawn: (cmd) => spawned.push({ cmd }),
  })
  return { n, spawned }
}

test("happy path: writes req file, bumps daily count, spawns refiner", () => {
  const repo = mkRepo()
  const { n, spawned } = run({ repo })
  expect(n).toBe(1)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.cmd.join(" ")).toContain("refiner-cli.ts")

  const req = JSON.parse(
    fs.readFileSync(path.join(gaugeDir(repo), "sid-1-1.req.json"), "utf-8"),
  )
  expect(req.prompt).toBe(PROMPT)
  expect(req.sessionID).toBe("sid-1")

  const count = JSON.parse(fs.readFileSync(path.join(gaugeDir(repo), "daily-count"), "utf-8"))
  expect(count.count).toBe(1)
})

test("second prompt in same session gets n=2", () => {
  const repo = mkRepo()
  run({ repo })
  const { n } = run({ repo })
  expect(n).toBe(2)
})

test("gauge not enabled in config → no-op", () => {
  const repo = mkRepo()
  const { n, spawned } = run({ repo, cfg: GAUGE_OFF })
  expect(n).toBeUndefined()
  expect(spawned.length).toBe(0)
  expect(fs.existsSync(gaugeDir(repo))).toBe(false)
})

test("missing config → no-op", () => {
  const repo = mkRepo()
  const { n } = run({ repo, cfg: undefined })
  expect(n).toBeUndefined()
})

test("KKAMAK_GAUGE=off kill-switch → no-op", () => {
  const repo = mkRepo()
  const { n } = run({ repo, env: { KKAMAK_GAUGE: "off" } })
  expect(n).toBeUndefined()
})

test("non-task-shaped prompt → no-op, no daily count consumed", () => {
  const repo = mkRepo()
  const { n } = run({ repo, prompt: "thanks!" })
  expect(n).toBeUndefined()
  expect(fs.existsSync(path.join(gaugeDir(repo), "daily-count"))).toBe(false)
})

test("non-string prompt → no-op", () => {
  const repo = mkRepo()
  expect(run({ repo, prompt: 42 }).n).toBeUndefined()
})

test("daily cap exhausted → no-op", () => {
  const repo = mkRepo()
  for (let i = 0; i < 30; i++) run({ repo })
  const { n, spawned } = run({ repo })
  expect(n).toBeUndefined()
  expect(spawned.length).toBe(0)
})

test("spawn throwing is swallowed (prime directive)", () => {
  const repo = mkRepo()
  expect(() =>
    maybeSpawnGauge({
      cwd: repo,
      sessionID: "sid-1",
      prompt: PROMPT,
      cfg: GAUGE_ON,
      env: {},
      now: NOW,
      spawn: () => {
        throw new Error("boom")
      },
    }),
  ).not.toThrow()
})
