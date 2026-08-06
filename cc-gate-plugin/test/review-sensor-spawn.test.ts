import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { maybeSpawnReviewSensor } from "../src/review-sensor-spawn.ts"

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-review-sensor-spawn-"))
}

interface Spawned {
  cmd: string[]
}

function run(opts: {
  cwd: string
  env?: Record<string, string | undefined>
  mainCheckoutDir?: string
}): { result: boolean; spawned: Spawned[] } {
  const spawned: Spawned[] = []
  const result = maybeSpawnReviewSensor({
    cwd: opts.cwd,
    env: opts.env ?? {},
    mainCheckoutDir: opts.mainCheckoutDir,
    spawn: (cmd) => spawned.push({ cmd }),
  })
  return { result, spawned }
}

test("env unset → no spawn, returns false", () => {
  const repo = mkRepo()
  const { result, spawned } = run({ cwd: repo, env: {}, mainCheckoutDir: repo })
  expect(result).toBe(false)
  expect(spawned).toEqual([])
})

test("env=1 + wrong cwd → no spawn, returns false", () => {
  const repo = mkRepo()
  const wrongCwd = mkRepo()
  const { result, spawned } = run({
    cwd: wrongCwd,
    env: { KKAMAK_REVIEW_SENSOR: "1" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(false)
  expect(spawned).toEqual([])
})

test("env=1 + cwd === mainCheckoutDir (test seam) → exactly one spawn", () => {
  const repo = mkRepo()
  const { result, spawned } = run({
    cwd: repo,
    env: { KKAMAK_REVIEW_SENSOR: "1" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(true)
  expect(spawned.length).toBe(1)
  const joined = spawned[0]!.cmd.join(" ")
  expect(joined).toContain("review-sensor/runner.ts")
  expect(joined).toContain(repo)
})

test("env set to something other than \"1\" → no spawn", () => {
  const repo = mkRepo()
  const { result, spawned } = run({
    cwd: repo,
    env: { KKAMAK_REVIEW_SENSOR: "0" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(false)
  expect(spawned).toEqual([])
})
