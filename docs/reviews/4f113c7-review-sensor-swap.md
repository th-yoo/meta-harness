# Review artifact — review-sensor-swap (repoint review-sensor onto @th-yoo/cc-api-daemon)

reviewed-range: 2b4efdbdcde3160769e6e24d67173f4b79e0eab5..4f113c7
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 1

The plan's core deliverable: `cc-gate-plugin/src/review-sensor/runner.ts` — the first
RUNTIME consumer — now drives the external package instead of the in-repo
`cc-gate-plugin/src/acp/`. Upstream shipped v0.3.0 (`f99bcd6`) publishing its `./testing`
subpath and exporting `routeBackend`/`ACP_BUDGET`/`envFingerprint`; this range bumps
cc-gate-plugin's pin to it and repoints the consumer.

**`fb40c65` — pin bump.** cc-gate-plugin only, full 40-char SHA
`f99bcd689ec002cb0a2f12a3bf3430ac024e4485`, in `dependencies`. `opencode-plugin`'s pin
deliberately left at `469456b` — its consumer (`p2/a4-review.ts`) is deferred.

**`f6bdfde` — the swap.**
- `runner.ts`'s import repointed to `@th-yoo/cc-api-daemon`. `RunnerDeps` and its
  defaults needed NO change: the old and new `ensureDaemon`/`daemonCall`/`closeSession`
  signatures and the `DaemonOutcome` shape are structurally identical. That was the
  prediction and it held.
- Corrected a now-false comment at the session close, which justified closing by
  "pinning one of the 4 global warm-lane slots". review-sensor's model is
  `claude-haiku-4-5` (`core.ts:9`), and the package's `routeBackend` sends `haiku` to the
  `api` lane where `ApiSession` bypasses the pool entirely — no slot, no exhaustion
  error. The close still matters (it releases daemon-side session state rather than
  letting it age out) and is unchanged; only the rationale was wrong. The reviewer
  independently confirmed the replacement claim against the package's
  `acp-daemon.ts` close path, so the new comment is verified, not merely plausible.
- New `test/review-sensor-runner-daemon.test.ts` — the swap's actual evidence. The
  pre-existing `review-sensor-runner.test.ts` injects `RunnerDeps` fakes and therefore
  CANNOT observe this change: it replaces the client wholesale and exercises identical
  code before and after. The new test wires the REAL `daemonCall`/`closeSession` and
  drives `runOnce` against the package's published `fakeDaemon` over a real loopback
  WebSocket. The reviewer traced the wire path and confirmed its assertions read state
  the fake only populates by decoding real JSON-RPC frames — it could not pass against
  a stub.

**`4f113c7` — the one finding, fixed.** `test/acp-package-surface.test.ts`'s header
claimed `envFingerprint`/`routeBackend`/`ACP_BUDGET` were "not exported at the pinned
SHA". True at the old pin, false at v0.3.0. Flagged by the implementer as out of its
own scope; fixed deliberately rather than deferred, because a comment asserting a
false fact about the pinned surface is the same false-confidence pattern that already
cost this plan a review round earlier (a test comment claiming a behavior was
"documented" when the source never said so). The fix also ADDS assertions for all three
— correct call: `runner.ts` now depends on this package at runtime, and both queued
follow-ups need exactly these exports (a floor guard needs
`ACP_BUDGET.daemonWorstCaseMs`, a lane assertion needs `routeBackend`), so leaving them
unlocked would let a future SHA bump drop one and surface only in that later work.

**Isolation audit (load-bearing, checked explicitly).** The package's `discoveryPath`
falls back to `os.homedir()` when `env.HOME` is absent, so a test env missing it would
read and write the developer's REAL `~/.config/acpd/` and could spawn a real daemon
there. The new test has exactly one env literal (`tempEnv(...)`, which overrides `HOME`
to a fresh mkdtemp dir), threaded through every call site; `afterEach` runs
`cleanupTempHomes()` + `reapDaemons()` and fires on the failure path too. No real daemon
is spawned by construction — the fake publishes discovery before `ensureDaemon` probes —
and no auth path is reached on either side, so credential-independence holds
structurally rather than incidentally.

Verified: `bunx tsc --noEmit` clean; `bun test` 1122 pass / 0 fail; the credential-scrubbed
run clean; `git diff cc-gate-plugin/src/acp/` EMPTY; `anthropic-cli-warm.ts` and
`opencode-plugin/src/bench/p2/a4-review.ts` still on the local `../acp/index.ts`; no
stray daemons and no leaked temp HOMEs after the run; `~/.config/acpd/` never created.

Still deliberately out of scope: B4 (daemonWorstCaseMs floor guard), B6 (lane lock +
sensor `lane` field) — both were confirmed PREMATURE before this range, since no runtime
consumer existed yet; they are unblocked now. B5 (gauge `anthropic-cli-warm` + P2
`a4-review` + their two test ports) and B8 (live verification, real spend, needs a sized
go) remain held.
