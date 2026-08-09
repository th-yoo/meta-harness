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

// ---- Arming-gate widening (2026-08-09): any cwd INSIDE the main checkout
// (subdir or .claude/worktrees/* worktree) arms the sensor; the runner is
// always handed mainCheckoutDir, never the triggering cwd, so state/claim/
// diff stay in the single main-checkout debounce domain. Rationale: the
// exact-equality gate yielded ~2 passes/day against the >=25/day bar —
// sessions live in worktrees and subdirs, and their Stops are the clock
// ticks the sensor needs.

test("env=1 + cwd is a subdir of mainCheckoutDir → spawns, runner arg is mainCheckoutDir not cwd", () => {
  const repo = mkRepo()
  const sub = path.join(repo, "cc-gate-plugin", "src")
  fs.mkdirSync(sub, { recursive: true })
  const { result, spawned } = run({
    cwd: sub,
    env: { KKAMAK_REVIEW_SENSOR: "1" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(true)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.cmd[spawned[0]!.cmd.length - 1]).toBe(repo)
})

test("env=1 + cwd is a worktree under .claude/worktrees → spawns with mainCheckoutDir", () => {
  const repo = mkRepo()
  const wt = path.join(repo, ".claude", "worktrees", "feature-x")
  fs.mkdirSync(wt, { recursive: true })
  const { result, spawned } = run({
    cwd: wt,
    env: { KKAMAK_REVIEW_SENSOR: "1" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(true)
  expect(spawned.length).toBe(1)
  expect(spawned[0]!.cmd[spawned[0]!.cmd.length - 1]).toBe(repo)
})

test("env=1 + sibling dir sharing the path-string prefix → no spawn (separator-anchored, not naive startsWith)", () => {
  const repo = mkRepo()
  const sibling = repo + "-sibling"
  fs.mkdirSync(sibling, { recursive: true })
  const { result, spawned } = run({
    cwd: sibling,
    env: { KKAMAK_REVIEW_SENSOR: "1" },
    mainCheckoutDir: repo,
  })
  expect(result).toBe(false)
  expect(spawned).toEqual([])
})
