# Review artifact — acp-singleton-client (one daemon per plugin process)

reviewed-range: 4236cb46c962ff76592655908cb7367559abfe7b..852ddde
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 2

Adds `cc-gate-plugin/src/acp-client-singleton.ts` and points
`src/review-sensor/runner.ts`'s `RunnerDeps` defaults at it.

**The hazard it closes.** `@th-yoo/cc-api-daemon` discovers its daemon by
`envFingerprint(env)` — a hash of the whole env minus a denylist. Every consumer
previously called `ensureDaemon` itself with whatever env object it happened to hold, so
two consumers in ONE process passing even slightly different envs compute different
fingerprints, reach DIFFERENT daemons, and each daemon carries its own session pool and
its own ~330MB-per-session RSS. The singleton pins one env for the process lifetime, so
every consumer resolves to the same daemon.

**What it does NOT do, deliberately.** It does not raise the concurrency ceiling.
`DEFAULT_MAX_SESSIONS` is 4 in both the old in-repo pool and the package's, RSS-bound.
The levers that actually raise throughput are routing to the api lane (never pooled —
which is why review-sensor's haiku traffic now consumes zero slots), raising
`ACP_MAX_SESSIONS`, or session reuse. Session reuse is explicitly out of scope here: a
long-lived session would carry conversation context between unrelated turns and collide
with review-sensor's deliberate close-not-release.

**Design decisions, both tested.** `ensureDaemon` memoizes only the IN-FLIGHT promise and
clears on settle — a permanently cached `false` after one transient failure (daemon
mid-restart, lost spawn-lock race) would silently disable the warm lane for the rest of
the process, a regression versus every consumer calling the package directly. The env is
SNAPSHOTTED (`{ ...env }`), not referenced: the realistic first caller is `process.env`,
a live object the process keeps mutating, so a reference would let the pinned content
drift while identity stayed stable — defeating the fingerprint stability the module
exists to provide.

`RunnerDeps` is unchanged; only the import source for the trio moved. The existing
fake-injecting tests pass untouched, which is the point — the seam was preserved, not
rebuilt.

**Findings (2, both Important, both fixed in `852ddde`, both re-reviewed ADDRESSED).**
Both stem from one root cause: the env override was correct but SILENT.
1. No mismatch signal. "First wins" is right, but undetectable — once a second real call
   site exists, a deliberately-different env (isolated `HOME`, derived var) would be
   silently redirected to the wrong daemon with no way to notice afterwards. Fixed by
   comparing `envFingerprint(incoming)` against the pinned one and `console.error`ing a
   mismatch, without throwing and without changing "first wins". Tested both ways: fires
   on a real mismatch, stays silent for a different object with identical content.
2. No documented reset requirement for tests. `bun test` does not isolate the module
   registry per file, so a `capturedEnv` leaked from an earlier file would redirect a
   later file's `ensureDaemon` probe away from its own scoped fake discovery — and the
   probe-miss fallback SPAWNS A REAL DAEMON, the invariant
   `test/review-sensor-runner-daemon.test.ts` and the package's CLAUDE.md both treat as
   non-negotiable. Not a live bug (that test bypasses the singleton today); this is the
   guardrail against the obvious next refactor. Fixed as documentation on
   `resetAcpClientSingleton`.

The fix changed two pre-existing assertions from `toBe` to `toEqual`, forced by the
snapshot. Re-review judged the net capability equal or better: both tests use envs that
differ in CONTENT, so a broken pin still fails, and reference-independence is now pinned
more precisely by a dedicated mutation test than it was incidentally by `toBe`.

Verified: `bunx tsc --noEmit` clean; `bun test` 1132 pass / 0 fail across 63 files;
credential-scrubbed run of the new file clean; `git diff cc-gate-plugin/src/acp/` EMPTY;
`anthropic-cli-warm.ts` still on the local `../acp/index.ts` (deferred, untouched).
A stale background run had reported 2 failures in `warm-session.test.ts` (a subprocess
hard-reset timing test); a fresh foreground rerun was clean — the same CPU-contention
flake class seen elsewhere in this plan, not a regression.
