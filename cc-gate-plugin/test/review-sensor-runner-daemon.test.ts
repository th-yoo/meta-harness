/** Integration test for the review-sensor -> `@th-yoo/cc-api-daemon` swap
 * (runner.ts's import of ensureDaemon/daemonCall/closeSession/modelProvenBy
 * moved from the in-repo `../acp/index.ts` to the pinned package).
 *
 * review-sensor-runner.test.ts already pins the outcome -> sensor-line
 * mapping, but it does so with `RunnerDeps` FAKES for `call`/`close`/
 * `ensure` — the exact same fakes exercise the exact same runner code
 * whether the real client comes from `../acp/index.ts` or
 * `@th-yoo/cc-api-daemon`, so that file cannot observe this swap at all.
 * This file wires `RunnerDeps` to the REAL `ensureDaemon`/`daemonCall`/
 * `closeSession` imported from the package, pointed at a scripted fake
 * daemon over a real (loopback) WebSocket connection via the package's own
 * `@th-yoo/cc-api-daemon/testing` subpath — proving the new client's
 * signatures and wire behavior actually match what runner.ts expects at
 * runtime, not just structurally at the type level (bunx tsc --noEmit
 * already covers the type level; this covers the wire).
 *
 * Isolation (non-negotiable, package CLAUDE.md + task brief):
 *  - every env handed to ensureDaemon/daemonCall/fakeDaemon carries its own
 *    throwaway HOME via `tempEnv` — discoveryPath() falls back to the REAL
 *    os.homedir() when HOME is absent, so an ungoverned env here would
 *    read/write the developer's real ~/.config/acpd/.
 *  - the fake daemon's discovery file is published (fakeDaemon awaits its
 *    own `server.listen` before writing it) BEFORE `runOnce` ever calls
 *    `ensure`, so `ensureDaemon`'s probe finds it immediately and its
 *    spawn-a-real-daemon fallback never runs. `ACP_TEST_SPAWN_LOG` /
 *    `LIVE_DAEMONS` are wired anyway, defensively, matching the package's
 *    own e2e-test precedent — if that assumption were ever wrong, the spawn
 *    is loggable and reapable rather than a silent 900s-idle leak.
 *  - `afterEach` stops the fake, reaps any real daemon (defensive, see
 *    above), and cleans up every temp HOME — the cleanup contract
 *    `@th-yoo/cc-api-daemon/testing`'s own header makes non-optional.
 *  - no ANTHROPIC_* credential is ever read: the fake answers every prompt
 *    itself, so `bun test` here never reaches the network or a live model.
 */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { runOnce, REVIEW_SENSOR_ISOLATION, type RunnerDeps } from "../src/review-sensor/runner.ts"
import { MODEL } from "../src/review-sensor/core.ts"
import { ensureDaemon, daemonCall, closeSession, envFingerprint } from "@th-yoo/cc-api-daemon"
import {
  fakeDaemon,
  tempEnv,
  cleanupTempHomes,
  reapDaemons,
  readDiscovery,
  waitForLines,
  LIVE_DAEMONS,
  type FakeDaemonHandle,
} from "@th-yoo/cc-api-daemon/testing"

const CLEANUP_DIRS: string[] = []
const LIVE_FAKES: FakeDaemonHandle[] = []

afterEach(() => {
  for (const d of CLEANUP_DIRS.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  while (LIVE_FAKES.length) {
    const f = LIVE_FAKES.pop()!
    try {
      f.stop()
    } catch {
      // ignore
    }
  }
  reapDaemons()
  cleanupTempHomes()
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  CLEANUP_DIRS.push(dir)
  return dir
}

function initRepo(): string {
  const dir = mkTmp("review-sensor-runner-daemon-")
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

function commit(dir: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), content)
  execFileSync("git", ["add", file], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], { cwd: dir })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
}

/** Mirrors review-sensor-runner.test.ts's own helper: one commit plus an
 * uncommitted edit gives assembleDiff a non-empty diff with no prior state
 * on disk, so shouldDispatch(undefined, now) => {go: true} unconditionally
 * (core.ts) — no debounce window to wait out. */
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

describe("review-sensor runner wired to the REAL @th-yoo/cc-api-daemon client", () => {
  test("runOnce, with RunnerDeps pointed at ensureDaemon/daemonCall/closeSession from the package, round-trips a pass through a scripted fake daemon over the wire", async () => {
    const { dir, headSha } = repoWithPendingDiff()
    const p = kmPaths(dir)
    const FIXED_TS = 1_800_000_000_000

    const env = tempEnv("runner-daemon-swap")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    // Defensive, matching the package's own e2e-test precedent: SHOULD
    // never be written to (see header) — if ensureDaemon ever fell through
    // to spawning a real daemon, this makes that spawn loggable and
    // reapable instead of a silent 900s-idle leak.
    env.ACP_TEST_SPAWN_LOG = spawnLog
    LIVE_DAEMONS.push({ spawnLog })

    const fake = await fakeDaemon(env, {
      fingerprint: envFingerprint(env),
      answer: "ok",
      text: JSON.stringify({ findings: [{ severity: "high", file: "a.ts", line: 2 }] }),
    })
    LIVE_FAKES.push(fake)
    expect(readDiscovery(env)).toBeTruthy()

    const deps: RunnerDeps = {
      now: () => FIXED_TS,
      call: daemonCall,
      close: closeSession,
      ensure: ensureDaemon,
    }

    await runOnce(dir, env, deps)

    const lines = readLines(p.streamPath)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    expect(line.skipped).toBeUndefined()
    expect(line.ts).toBe(FIXED_TS)
    expect(line.findingsCount).toBe(1)
    expect(line.severityCounts).toEqual({ high: 1, med: 0, low: 0 })
    expect(line.model).toBe(MODEL)
    expect(line.headSha).toBe(headSha)

    // State advanced and the claim was released, same as the fake-deps test.
    const state = JSON.parse(fs.readFileSync(p.statePath, "utf-8"))
    expect(state.lastPassTs).toBe(FIXED_TS)
    expect(state.lastPassHead).toBe(headSha)
    expect(fs.existsSync(p.claimPath)).toBe(false)

    // Proves the wiring reached the daemon FOR REAL, not just that runOnce
    // produced the right output: the fake recorded review-sensor's own
    // model and isolation constants over session/new + session/prompt, and
    // closeSession (real, not a stub) actually delivered session/close for
    // the SAME sessionId session/new minted.
    expect(fake.sessionNewParams()?._meta?.kkamak?.isolation).toEqual(REVIEW_SENSOR_ISOLATION)
    expect(fake.promptParams()?._meta.model).toBe(MODEL)
    const closed = fake.closeParams()
    expect(closed?.sessionId).toBeTruthy()
    expect(closed?.sessionId).toBe(fake.promptParams()?.sessionId)

    // No real daemon was ever spawned: ensureDaemon's probe found the fake
    // immediately (discovery was published before runOnce ran), so
    // spawnDaemonProcess's nohup path never ran and this spawn log — wired
    // up purely as a defensive backstop — was never written to.
    expect(await waitForLines(spawnLog, 1, 100)).toEqual([])
    expect(fs.existsSync(spawnLog)).toBe(false)
  })

  test("runOnce, with the fake daemon reporting apiStopReason: \"max_tokens\" over the wire (v0.5.0 surface-truncation), skips with output-truncated — proves the field survives the REAL wire round-trip, not just the fake-deps unit tests", async () => {
    const { dir } = repoWithPendingDiff()
    const p = kmPaths(dir)
    const FIXED_TS = 1_800_000_000_001

    const env = tempEnv("runner-daemon-truncation")
    const spawnLog = path.join(env.HOME!, "spawnlog")
    env.ACP_TEST_SPAWN_LOG = spawnLog
    LIVE_DAEMONS.push({ spawnLog })

    const fake = await fakeDaemon(env, {
      fingerprint: envFingerprint(env),
      answer: "ok",
      // Deliberately well-formed JSON — proves runner.ts's truncation
      // check fires off the wire's apiStopReason field itself, not off a
      // parse failure it happens to also cause.
      text: JSON.stringify({ findings: [] }),
      apiStopReason: "max_tokens",
    })
    LIVE_FAKES.push(fake)
    expect(readDiscovery(env)).toBeTruthy()

    const deps: RunnerDeps = {
      now: () => FIXED_TS,
      call: daemonCall,
      close: closeSession,
      ensure: ensureDaemon,
    }

    await runOnce(dir, env, deps)

    const lines = readLines(p.streamPath)
    expect(lines.length).toBe(1)
    const line = lines[0]!
    expect(line.skipped).toBe(true)
    expect(line.reason).toBe("output-truncated")
    expect("findingsCount" in line).toBe(false)

    // The session established for this "ok"-but-truncated outcome is still
    // closed (close-not-release), same as any other "ok" outcome.
    const closed = fake.closeParams()
    expect(closed?.sessionId).toBeTruthy()
    expect(closed?.sessionId).toBe(fake.promptParams()?.sessionId)
  })
})
