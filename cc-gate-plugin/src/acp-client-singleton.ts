// acp-client-singleton.ts — the ONE `@th-yoo/cc-api-daemon` client for this
// plugin process.
//
// THE HAZARD THIS CLOSES: `@th-yoo/cc-api-daemon` discovers its daemon by
// `envFingerprint(env)` (acp-paths.ts) — a hash of the WHOLE env minus a
// denylist, written to a fingerprint-derived discovery path
// (`~/.config/acpd/acp-<fp>.json`). Every consumer today (review-sensor's
// runner.ts, and later anthropic-cli-warm.ts) imports `ensureDaemon` /
// `daemonCall` / `closeSession` directly and calls `ensureDaemon` with
// whatever env object it happens to be holding at that call site — usually
// `process.env`, but assembled or threaded slightly differently per
// consumer. Two SAME-content env objects still fingerprint identically, so
// today this mostly works by luck; but the moment one consumer's env
// differs by even one key (a derived var, a test override, a future
// per-consumer tweak) it computes a DIFFERENT fingerprint, reaches a
// DIFFERENT daemon, and that daemon spins up its own session pool — at
// ~330MB RSS per warm session (acp-pool.ts). One plugin process ends up
// paying for and talking to N daemons instead of one. This module makes
// "one process, one env, one daemon" structural instead of a convention
// every new call site has to remember.
//
// Three things owned here, for the process's lifetime:
//  1. ONE env — captured from whichever caller happens to invoke this
//     module first, reused for every later call regardless of what env any
//     OTHER caller passes afterward. Every consumer therefore computes the
//     same fingerprint and reaches the same daemon.
//  2. ONE in-flight `ensureDaemon` — concurrent first-callers (the startup
//     stampede: several consumers each doing their own zero-wait
//     "kick the daemon" on the same Stop) share a single connect-or-spawn
//     promise instead of each racing their own. See the retry-semantics
//     note on `ensureDaemon` below for what happens once it SETTLES.
//  3. A thin `daemonCall`/`closeSession` pass-through, so no consumer needs
//     to import the package's trio directly (and therefore can't
//     accidentally reintroduce hazard #1 above by calling the package
//     itself with a locally-built env).
//
// DELIBERATELY NOT HERE: no session held across calls (`daemonCall` already
// does a fresh `session/new` per call by design — reusing one would leak
// conversation context between unrelated turns, a separate later decision),
// no pool-size/budget change, no caching, no retry of `daemonCall` itself.
//
// Value import of the trio below (not `import type`) is unavoidable — this
// module IS the call surface, it has to actually call them. This is not a
// NEW eager load: runner.ts already imports these same three values from
// the same barrel today (`@th-yoo/cc-api-daemon`'s `index.ts` re-exports
// `ApiSession`/`WarmSession` too, whose chain reaches `@anthropic-ai/sdk`
// at module scope — see send-prompt.ts's header for the full explanation of
// why that barrel is eager). Swapping the import source from the package to
// this module does not add a load that was not already happening.
import {
  ensureDaemon as pkgEnsureDaemon,
  daemonCall as pkgDaemonCall,
  closeSession as pkgCloseSession,
  envFingerprint,
  type DaemonOutcome,
  type WarmIsolation,
} from "@th-yoo/cc-api-daemon"

type EnsureDaemonFn = typeof pkgEnsureDaemon
type DaemonCallFn = typeof pkgDaemonCall
type CloseSessionFn = typeof pkgCloseSession

/** The injectable seam — same DI idiom as `RunnerDeps`
 * (review-sensor/runner.ts): a plain interface of the functions this module
 * calls, swappable via `resetAcpClientSingleton` so tests never touch a real
 * daemon or a real env. */
export interface AcpClientSingletonDeps {
  ensureDaemon: EnsureDaemonFn
  daemonCall: DaemonCallFn
  closeSession: CloseSessionFn
}

const packageDeps: AcpClientSingletonDeps = {
  ensureDaemon: pkgEnsureDaemon,
  daemonCall: pkgDaemonCall,
  closeSession: pkgCloseSession,
}

let deps: AcpClientSingletonDeps = packageDeps

/** Captured on first use (any of the three functions below), then reused —
 * see the module header. `undefined` means "not yet captured". */
let capturedEnv: Record<string, string | undefined> | undefined

/** The in-flight `ensureDaemon` promise, memoized WHILE PENDING only — see
 * `ensureDaemon`'s own comment for why it is cleared on settle rather than
 * kept forever. */
let ensureInFlight: Promise<boolean> | undefined

/** Test-only reset/inject seam (module-level singletons are otherwise
 * poison for test isolation — every test needs a clean env-capture and a
 * clean in-flight slot, and most tests need fakes so `bun test` never
 * spawns a real daemon or reads real credentials). Call with no argument to
 * restore the real package functions; call with a partial override to
 * inject fakes for the functions a given test cares about.
 *
 * NON-OPTIONAL for any test that routes through this singleton: call this
 * in `beforeEach`/`afterEach`, not just once at the top of the file. `bun
 * test` does NOT reset the module registry between test FILES by default —
 * a `capturedEnv` pinned by whichever test happened to run first stays
 * pinned for every test file that imports this module afterward in the
 * same `bun test` process. Concretely: if a future test routes through this
 * singleton the way `test/review-sensor-runner-daemon.test.ts` currently
 * routes through the package's trio DIRECTLY (bypassing this module, so it
 * is NOT at risk today), an earlier file's leftover `capturedEnv` would
 * silently redirect that test's `ensureDaemon` probe away from its own
 * `tempEnv`-scoped fake discovery file. `ensureDaemon`'s probe-miss
 * fallback is to SPAWN A REAL DAEMON PROCESS — exactly the outcome that
 * test's own header and the package's CLAUDE.md both treat as
 * non-negotiable never-happens-in-`bun test`. This comment exists so that
 * refactor does not silently reintroduce a real daemon spawn into the gate. */
export function resetAcpClientSingleton(injected?: Partial<AcpClientSingletonDeps>): void {
  deps = injected ? { ...packageDeps, ...injected } : packageDeps
  capturedEnv = undefined
  ensureInFlight = undefined
}

/** First caller's env wins for the life of the process (or since the last
 * `resetAcpClientSingleton` in a test) — every later call's `env` argument
 * is accepted structurally (so this module's functions stay
 * signature-compatible with the package's) but ignored in favor of the
 * captured one. That is the point: it is precisely the "whatever env this
 * particular call site happens to be holding" divergence that fragments
 * consumers onto different daemons.
 *
 * SNAPSHOTTED, not referenced (`{ ...env }`, not `capturedEnv = env`): the
 * realistic caller is `process.env`, which the process goes on mutating
 * for the rest of its life (a derived var set later, a credential
 * refreshed). A REFERENCE would let the "pinned" content silently drift
 * out from under the very stability guarantee this module exists to
 * provide — "captured once" (module header) means the CONTENT is frozen at
 * first use, not that this module merely remembers which object to keep
 * re-reading. A snapshot also makes the mismatch check below meaningful:
 * comparing against a moving target would make `envFingerprint(capturedEnv)`
 * itself unstable, which defeats the point of computing it.
 *
 * SILENT override would be its own hazard once a second real call site
 * exists in one process (the module header names anthropic-cli-warm.ts as
 * exactly that future consumer): "first wins" is correct and stays, but a
 * later caller handing this a DELIBERATELY different env (an isolated
 * HOME, a derived var) with no way to ever notice the redirect is not.
 * Diagnostic only, never throws — matches runner.ts:305's own
 * logged-not-inspected `console.error` style: a caller cannot opt out of
 * "first wins" by handing this a different env, but it CAN see, after the
 * fact, that its env was overridden and by how much the fingerprints
 * differed. */
function pinnedEnv(env: Record<string, string | undefined>): Record<string, string | undefined> {
  if (capturedEnv === undefined) {
    capturedEnv = { ...env }
    return capturedEnv
  }
  const incomingFp = envFingerprint(env)
  const pinnedFp = envFingerprint(capturedEnv)
  if (incomingFp !== pinnedFp) {
    console.error(
      `acp-client-singleton: env mismatch — pinned fingerprint ${pinnedFp}, caller passed ${incomingFp}; ` +
        `keeping the pinned env (first-use wins, see module header) rather than the caller's own`,
    )
  }
  return capturedEnv
}

/** Connect-or-spawn, deduped. RETRY SEMANTICS (deliberate choice, pinned by
 * this file's test): the in-flight promise is memoized only WHILE PENDING.
 * As soon as it settles — success OR the package's own `false` ("could not
 * reach or spawn a daemon in time", `ensureDaemon` never throws) — the slot
 * is cleared, so the NEXT call performs a fresh probe/connect-or-spawn
 * rather than replaying a stale `false` forever. A memoized REJECTED (or
 * permanently-false) promise would silently and permanently disable the
 * warm lane for the rest of the process after one transient failure (daemon
 * mid-restart, a lost spawn-lock race); that is not this package's contract
 * (`ensureDaemon` is a cheap idempotent probe, safe to repeat) and would be
 * a real regression versus every consumer calling it directly today. What
 * IS deduped is concurrent CALLERS of the SAME attempt — the startup
 * stampede this module exists to fix — not calls that happen to be
 * sequential. */
export function ensureDaemon(
  env: Record<string, string | undefined>,
  opts?: { waitMs?: number },
): Promise<boolean> {
  const e = pinnedEnv(env)
  if (ensureInFlight === undefined) {
    const p = deps.ensureDaemon(e, opts)
    ensureInFlight = p
    p.finally(() => {
      if (ensureInFlight === p) ensureInFlight = undefined
    })
  }
  return ensureInFlight
}

/** Thin pass-through — no caching, no retry, one `session/new` +
 * `session/prompt` per call, exactly as the package does. The only thing
 * this adds over calling `daemonCall` directly is routing through the
 * singleton's pinned env. */
export function daemonCall(
  outgoingText: string,
  model: string,
  env: Record<string, string | undefined>,
  opts: { isolation: WarmIsolation; budgetMs?: number },
): Promise<DaemonOutcome> {
  return deps.daemonCall(outgoingText, model, pinnedEnv(env), opts)
}

/** Thin pass-through, same rationale as `daemonCall` above. */
export function closeSession(
  sessionId: string,
  env: Record<string, string | undefined>,
  opts?: { budgetMs?: number },
): Promise<{ closed: boolean; reason?: string }> {
  return deps.closeSession(sessionId, pinnedEnv(env), opts)
}
