/** Tests for `runOnce` (cc-gate-plugin/src/review-sensor/runner.ts) — the
 * one claim -> diff -> warm-call -> emit cycle. Before this file, nothing in
 * the repo ever called `runOnce`; the `RunnerDeps` seam (now/call/close/
 * ensure) existed but was never exercised, so the outcome-to-sensor-line
 * mapping was unverified. These tests drive the real function end-to-end
 * (real fs, real git, real .km/ paths) with fake `call`/`close`/`ensure` so
 * `bun test` never reaches the network or a live daemon — see runner.ts:14
 * ("`bun test` must never make a live model call").
 *
 * Hermetic temp git repos, mirroring
 * review-sensor-git-diff.test.ts's / km-crank's mkGitRepoWithCommits style:
 * real `git init`/`commit` via execFileSync, never the real checkout. */
import { test, expect, describe, afterEach } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { runOnce, type RunnerDeps } from "../src/review-sensor/runner.ts"
import { MODEL } from "../src/review-sensor/core.ts"
import type { DaemonOutcome } from "../src/acp/index.ts"

const CLEANUP: string[] = []
afterEach(() => {
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}

function initRepo(): string {
  const dir = mkTmp("review-sensor-runner-")
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

function commit(dir: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), content)
  execFileSync("git", ["add", file], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], { cwd: dir })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
}

/** A fresh repo with one commit plus an uncommitted working-tree edit —
 * gives assembleDiff a non-empty diff (fallback base, since there is no
 * prior review-sensor state on disk yet) without needing any debounce
 * window to elapse: shouldDispatch(undefined, now) => {go: true}
 * unconditionally (core.ts:38-40). */
function repoWithPendingDiff(): { dir: string; headSha: string } {
  const dir = initRepo()
  const headSha = commit(dir, "a.ts", "export const a = 1\n", "initial")
  fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\nexport const b = 2\n")
  return { dir, headSha }
}

function kmPaths(dir: string) {
  const kmDir = path.join(dir, ".km")
  return {
    kmDir,
    statePath: path.join(kmDir, "review-sensor-state.json"),
    claimPath: path.join(kmDir, "review-sensor.claim"),
    sideFileDir: path.join(kmDir, "review-findings-text"),
    streamPath: path.join(kmDir, "review-findings.ndjson"),
  }
}

function readLines(streamPath: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(streamPath)) return []
  return fs
    .readFileSync(streamPath, "utf-8")
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>)
}

describe("runOnce", () => {
  test('ok outcome -> one PASS line with the mapped fields, side file, state advance, claim released, session closed', async () => {
    const { dir, headSha } = repoWithPendingDiff()
    const p = kmPaths(dir)
    const FIXED_TS = 1_800_000_000_000

    const closeCalls: string[] = []
    const deps: RunnerDeps = {
      now: () => FIXED_TS,
      call: async (): Promise<DaemonOutcome> => ({
        kind: "ok",
        text: JSON.stringify({ findings: [{ severity: "high", file: "a.ts", line: 2 }] }),
        model: MODEL,
        canonicalModel: MODEL,
        sessionId: "sess-1",
      }),
      close: async (sessionId) => {
        closeCalls.push(sessionId)
        return { closed: true }
      },
      ensure: async () => true,
    }

    await runOnce(dir, {}, deps)

    const lines = readLines(p.streamPath)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    expect(line.skipped).toBeUndefined()
    expect(line.ts).toBe(FIXED_TS)
    expect(line.findingsCount).toBe(1)
    expect(line.severityCounts).toEqual({ high: 1, med: 0, low: 0 })
    expect(line.model).toBe(MODEL)
    expect(line.headSha).toBe(headSha)
    expect(line.truncated).toBe(false)
    expect(line.diffBase).toBe("fallback") // no prior state -> shouldDispatch's undefined-state path
    expect(typeof line.durationMs).toBe("number")
    expect(line.host).toBe(os.hostname())

    // Side file: the un-truncated findings companion to the F2 stream line.
    const sideFile = path.join(p.sideFileDir, `${FIXED_TS}.json`)
    expect(fs.existsSync(sideFile)).toBe(true)
    const sideContent = JSON.parse(fs.readFileSync(sideFile, "utf-8"))
    expect(sideContent.findings).toEqual([{ severity: "high", file: "a.ts", line: 2 }])

    // State advanced, so the NEXT runOnce would see this pass.
    const state = JSON.parse(fs.readFileSync(p.statePath, "utf-8"))
    expect(state.lastPassTs).toBe(FIXED_TS)
    expect(state.lastPassHead).toBe(headSha)
    expect(state.dayCount).toBe(1)

    // Claim released; session closed (close-not-release applies to kind === "ok").
    expect(fs.existsSync(p.claimPath)).toBe(false)
    expect(closeCalls).toEqual(["sess-1"])
  })

  test('no-call outcome -> a SKIP line (warm-lane-busy), no pass line, no state/side-file writes, claim released, no close', async () => {
    const { dir } = repoWithPendingDiff()
    const p = kmPaths(dir)

    const closeCalls: string[] = []
    const deps: RunnerDeps = {
      now: () => Date.now(),
      call: async (): Promise<DaemonOutcome> => ({ kind: "no-call" }),
      close: async (sessionId) => {
        closeCalls.push(sessionId)
        return { closed: true }
      },
      ensure: async () => true,
    }

    await runOnce(dir, {}, deps)

    const lines = readLines(p.streamPath)
    expect(lines.length).toBe(1)
    expect(lines[0]!.skipped).toBe(true)
    expect(lines[0]!.reason).toBe("warm-lane-busy")
    expect("findingsCount" in lines[0]!).toBe(false) // never a pass line

    expect(fs.existsSync(p.statePath)).toBe(false) // ok-only path never reached
    expect(fs.existsSync(p.sideFileDir)).toBe(false)
    expect(fs.existsSync(p.claimPath)).toBe(false) // still released in the finally
    expect(closeCalls).toEqual([]) // no session was ever established
  })

  test('call-consumed outcome -> also collapses to the SAME warm-lane-busy skip reason, and any session it carries is not closed by this path', async () => {
    const { dir } = repoWithPendingDiff()
    const p = kmPaths(dir)

    const closeCalls: string[] = []
    const deps: RunnerDeps = {
      now: () => Date.now(),
      // call-consumed CAN carry a sessionId (ambiguous post-send: a
      // session may genuinely have been established server-side).
      call: async (): Promise<DaemonOutcome> => ({ kind: "call-consumed", sessionId: "sess-ambiguous" }),
      close: async (sessionId) => {
        closeCalls.push(sessionId)
        return { closed: true }
      },
      ensure: async () => true,
    }

    await runOnce(dir, {}, deps)

    const lines = readLines(p.streamPath)
    expect(lines.length).toBe(1)
    expect(lines[0]!.skipped).toBe(true)
    // emitSkip collapse (runner.ts:223-226): every non-"ok" outcome funnels
    // through ONE reason — "call-consumed" is not distinguished from
    // "no-call" in the emitted line. This test pins that collapse so a
    // future change to the mapping (e.g. the ACP client swap) has to
    // touch this assertion deliberately, not silently.
    expect(lines[0]!.reason).toBe("warm-lane-busy")

    expect(fs.existsSync(p.statePath)).toBe(false)
    expect(fs.existsSync(p.claimPath)).toBe(false)
    // Documented behavior (runner.ts:287-296): close-not-release is scoped
    // to kind === "ok" only. A session carried by a "call-consumed" outcome
    // is left for the daemon's own 900s reap, not closed here.
    expect(closeCalls).toEqual([])
  })
})
