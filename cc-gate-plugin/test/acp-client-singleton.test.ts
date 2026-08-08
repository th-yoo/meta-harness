/** Tests for `acp-client-singleton.ts` — the properties that justify the
 * module existing at all, not a restatement of `@th-yoo/cc-api-daemon`'s own
 * tests (those live in the package and are pinned separately by
 * acp-package-surface.test.ts):
 *
 *  1. N concurrent callers of `ensureDaemon` trigger exactly ONE underlying
 *     `ensureDaemon` invocation — the memoization contract.
 *  2. The SAME env is reused across calls regardless of what a later caller
 *     passes, so every consumer computes the same `envFingerprint` and
 *     therefore reaches the same daemon.
 *  3. A settled (including failed) `ensureDaemon` does not permanently
 *     poison the singleton — the retry-semantics choice documented on
 *     `ensureDaemon` itself in the source.
 *  4. `runOnce` (review-sensor/runner.ts) still works when its `RunnerDeps`
 *     defaults resolve to this singleton's exports — existing behavior
 *     preserved by the swap.
 *
 * Every underlying `ensureDaemon`/`daemonCall`/`closeSession` here is a
 * FAKE injected via `resetAcpClientSingleton` — this file never spawns a
 * real daemon, never opens a socket, and never reads a host credential. The
 * `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds`
 * invariant (package CLAUDE.md) holds trivially here for the same reason.
 */
import { afterEach, describe, expect, test } from "bun:test"
import { envFingerprint, type DaemonOutcome } from "@th-yoo/cc-api-daemon"
import {
  ensureDaemon,
  daemonCall,
  closeSession,
  resetAcpClientSingleton,
  type AcpClientSingletonDeps,
} from "../src/acp-client-singleton.ts"
import { runOnce, type RunnerDeps } from "../src/review-sensor/runner.ts"
import { MODEL } from "../src/review-sensor/core.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"

afterEach(() => {
  // Never let one test's fakes or captured env leak into the next.
  resetAcpClientSingleton()
})

/** A promise this test controls the settlement of, so "N concurrent
 * callers" can be constructed deterministically: call `ensureDaemon` N
 * times BEFORE resolving, proving the underlying fake was invoked once no
 * matter how many callers are waiting on it. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void } {
  let resolve!: (v: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

describe("ensureDaemon memoization", () => {
  test("N concurrent callers cause exactly one underlying ensureDaemon invocation", async () => {
    let calls = 0
    const gate = deferred<boolean>()
    resetAcpClientSingleton({
      ensureDaemon: async () => {
        calls++
        return gate.promise
      },
    })

    const env = { HOME: "/tmp/whoever" }
    const p1 = ensureDaemon(env, { waitMs: 5000 })
    const p2 = ensureDaemon(env, { waitMs: 5000 })
    const p3 = ensureDaemon(env, { waitMs: 5000 })

    // All three callers are pending on the SAME underlying call before it
    // has been given a chance to resolve.
    expect(calls).toBe(1)

    gate.resolve(true)
    const results = await Promise.all([p1, p2, p3])
    expect(results).toEqual([true, true, true])
    expect(calls).toBe(1)
  })

  test("callers share the identical in-flight promise instance", () => {
    resetAcpClientSingleton({
      ensureDaemon: async () => true,
    })
    const env = { HOME: "/tmp/whoever" }
    const p1 = ensureDaemon(env)
    const p2 = ensureDaemon(env)
    expect(p1).toBe(p2)
  })
})

describe("env pinning", () => {
  test("the first-use env is reused across later calls with a DIFFERENT env, so the fingerprint stays stable", async () => {
    const seenEnvs: Array<Record<string, string | undefined>> = []
    resetAcpClientSingleton({
      daemonCall: async (_text, _model, env) => {
        seenEnvs.push(env)
        return { kind: "no-call" } satisfies DaemonOutcome
      },
    })

    const isolation = { title: "t", tools: [] } as unknown as Parameters<typeof daemonCall>[3]["isolation"]

    const firstEnv = { HOME: "/tmp/first", MARKER: "one" }
    await daemonCall("hi", MODEL, firstEnv, { isolation })

    // A LATER caller passes a differently-shaped env (a different key set,
    // a different value) — exactly the "whatever env this call site
    // happens to be holding" divergence the singleton exists to neutralize.
    const secondEnv = { HOME: "/tmp/second", MARKER: "two", EXTRA: "x" }
    await daemonCall("hi again", MODEL, secondEnv, { isolation })

    expect(seenEnvs.length).toBe(2)
    // The underlying package call received the FIRST env both times, not
    // whatever each caller passed.
    expect(seenEnvs[0]).toBe(firstEnv)
    expect(seenEnvs[1]).toBe(firstEnv)
    expect(envFingerprint(seenEnvs[0]!)).toBe(envFingerprint(seenEnvs[1]!))
    // And it differs from what the SECOND caller's own env would have
    // fingerprinted to, proving this isn't a coincidence of equal content.
    expect(envFingerprint(seenEnvs[1]!)).not.toBe(envFingerprint(secondEnv))
  })

  test("ensureDaemon and daemonCall/closeSession share the same pinned env", async () => {
    const seenByEnsure: Array<Record<string, string | undefined>> = []
    const seenByCall: Array<Record<string, string | undefined>> = []
    const seenByClose: Array<Record<string, string | undefined>> = []
    resetAcpClientSingleton({
      ensureDaemon: async (env) => {
        seenByEnsure.push(env)
        return true
      },
      daemonCall: async (_t, _m, env) => {
        seenByCall.push(env)
        return { kind: "no-call" } satisfies DaemonOutcome
      },
      closeSession: async (_id, env) => {
        seenByClose.push(env)
        return { closed: true }
      },
    })

    const isolation = { title: "t", tools: [] } as unknown as Parameters<typeof daemonCall>[3]["isolation"]
    const firstCallerEnv = { HOME: "/tmp/a", TAG: "ensure-first" }
    await ensureDaemon(firstCallerEnv, { waitMs: 0 })
    await daemonCall("x", MODEL, { HOME: "/tmp/b", TAG: "call-second" }, { isolation })
    await closeSession("sess-1", { HOME: "/tmp/c", TAG: "close-third" })

    expect(envFingerprint(seenByEnsure[0]!)).toBe(envFingerprint(seenByCall[0]!))
    expect(envFingerprint(seenByCall[0]!)).toBe(envFingerprint(seenByClose[0]!))
    // All three literally received the FIRST caller's env object.
    expect(seenByCall[0]).toBe(firstCallerEnv)
    expect(seenByClose[0]).toBe(firstCallerEnv)
  })
})

describe("ensureDaemon retry semantics", () => {
  test("a settled (failed) ensureDaemon does not permanently poison the singleton — the next call retries for real", async () => {
    let calls = 0
    resetAcpClientSingleton({
      ensureDaemon: async () => {
        calls++
        // First attempt fails to reach/spawn a daemon (the package's own
        // `false`, never a throw); a later attempt succeeds — e.g. a
        // daemon that was mid-restart on the first probe is up by the
        // second.
        return calls === 1 ? false : true
      },
    })

    const env = { HOME: "/tmp/retry" }
    const first = await ensureDaemon(env, { waitMs: 0 })
    expect(first).toBe(false)
    expect(calls).toBe(1)

    const second = await ensureDaemon(env, { waitMs: 0 })
    expect(second).toBe(true)
    expect(calls).toBe(2)
  })
})

describe("runOnce through the singleton's default wiring", () => {
  const CLEANUP: string[] = []
  afterEach(() => {
    for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
  })

  function mkTmp(prefix: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
    CLEANUP.push(dir)
    return dir
  }

  function repoWithPendingDiff(): { dir: string; headSha: string } {
    const dir = mkTmp("acp-client-singleton-runner-")
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\n")
    execFileSync("git", ["add", "a.ts"], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "initial"], {
      cwd: dir,
    })
    const headSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
    fs.writeFileSync(path.join(dir, "a.ts"), "export const a = 1\nexport const b = 2\n")
    return { dir, headSha }
  }

  test("a PASS still round-trips end to end when RunnerDeps resolves to the singleton's ensure/call/close", async () => {
    const { dir, headSha } = repoWithPendingDiff()
    const streamPath = path.join(dir, ".km", "review-findings.ndjson")
    const FIXED_TS = 1_800_000_000_000

    const closeCalls: string[] = []
    const fakeDeps: Partial<AcpClientSingletonDeps> = {
      ensureDaemon: async () => true,
      daemonCall: async () =>
        ({
          kind: "ok",
          text: JSON.stringify({ findings: [{ severity: "high", file: "a.ts", line: 2 }] }),
          model: MODEL,
          canonicalModel: MODEL,
          sessionId: "sess-1",
        }) satisfies DaemonOutcome,
      closeSession: async (sessionId) => {
        closeCalls.push(sessionId)
        return { closed: true }
      },
    }
    resetAcpClientSingleton(fakeDeps)

    // The exact shape runner.ts's own `main()` builds: `RunnerDeps` pointed
    // straight at the singleton's exports, unmodified — this is what
    // proves the swap is behavior-preserving, not just type-compatible.
    const deps: RunnerDeps = {
      now: () => FIXED_TS,
      call: daemonCall,
      close: closeSession,
      ensure: ensureDaemon,
    }

    await runOnce(dir, { HOME: "/tmp/runner-env" }, deps)

    const lines = fs
      .readFileSync(streamPath, "utf-8")
      .split("\n")
      .filter((l) => l.length > 0)
      .map((l) => JSON.parse(l) as Record<string, unknown>)
    expect(lines.length).toBe(1)
    expect(lines[0]!.skipped).toBeUndefined()
    expect(lines[0]!.findingsCount).toBe(1)
    expect(lines[0]!.headSha).toBe(headSha)
    expect(closeCalls).toEqual(["sess-1"])
  })
})
