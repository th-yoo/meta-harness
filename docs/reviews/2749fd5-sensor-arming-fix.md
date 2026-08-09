# Review artifact — sensor-arming-fix (the two arming blockers)

reviewed-range: 10baf37129e1faec57cfa2e86210810a1c0dfcb7..2749fd5b7bd1932ab19720ddc68fbf48f78269e9
reviewer: fresh-context-opus
fresh-context: true
verdict: approved
findings-count: 0 code defects (2 Important pre-arming caveats + 5 minors; minors 3+5 fixed in 2749fd5, rest recorded below)

The review sensor shipped OFF with two recorded blockers standing between it and
an arming go. Both are fixed; arming remains a separate ruling.

**Blocker 1 — the arming gate.** `review-sensor-spawn.ts` required
`path.resolve(cwd) === MAIN_CHECKOUT_DIR` exactly; sessions live in worktrees
(`.claude/worktrees/*`, which sit UNDER the repo root) and subdirs, so the gate
passed ~2×/day against a >=25/day observation bar. Now a separator-anchored
prefix match (root, any subdir, any worktree under the root; `<root>-sibling`
rejected — pinned by test), with BOTH sides resolved so a trailing-slash or
relative anchor from a future caller cannot silently fail closed. The runner is
now always handed the main-checkout path, never the triggering cwd — state,
claim and diff stay in one debounce domain; reviewer confirmed `hook-cli.ts:341`
is the only caller and the argv value is unchanged for the previously-passing
case.

**Blocker 2 — structurally no-call.** `runner.ts` did `ensure(env, {waitMs: 0})`
then `daemonCall` immediately, while `DEBOUNCE_MS` (15 min) equals the daemon's
idle reap budget: every post-debounce cycle found the daemon JUST reaped,
zero-wait ensure returned pre-boot, and the call landed no-call →
"warm-lane-busy" skip. Armed as-is the sensor emits skips, not reviews. The
zero-wait precedent (anthropic-cli-warm.ts) has a session actively waiting;
this runner is a detached child nothing awaits — reviewer confirmed via the
package's `acp-client.ts:503-511` that `waitMs === 0` returns false immediately
after spawning while `waitMs > 0` poll-connects, and that both real-daemon e2e
tests publish discovery before `runOnce` (no timing dependency). Now
`ensure({waitMs: ENSURE_WAIT_MS})` (exported, 15 s; cold spawn observed 1-2 s).

Kill switch (`KKAMAK_REVIEW_SENSOR`, fail-closed) and the 30/day cap untouched
— spend ceiling unchanged. Plan doc's gate contract amended in place (dated),
spec's activation section needed no change.

## Pre-arming caveats (reviewer's Important findings — decide at the arming go)

1. **The widened gate ticks a clock that may have nothing to review.** The
   runner diffs the MAIN checkout; worktree work is invisible until merged. A
   clean main = spawn with no line (empty-diff early return); a long-lived
   uncommitted main diff = up to 30 near-duplicate reviews/day
   (`lastPassHead` only advances with HEAD). State which of these counts
   toward ">=25/day" before arming.
2. **Env reach:** `KKAMAK_REVIEW_SENSOR=1` planned for the main checkout's
   `.claude/settings.local.json` — a session launched fresh WITH cwd in a
   worktree does not load that file. The widening pays off only if the var is
   process-inherited or set user-level. Verify at arming.

Deferred minors (recorded, not blocking): no realpath canonicalization
(symlinked cwd fails closed — pre-existing, I/O-free function by design);
`.km/review-findings.ndjson` has no rotation and skip-line volume rises with
the widened gate (sole consumer filters `skipped !== true`, metric safe);
mid-file import in the runner test (hoisted, style only).

Verified: cc-gate-plugin full suite in the worktree **998 pass / 0 fail**
(4708 expects, 57 files); tsc clean; new tests fail on revert (gate tests
return false; runner test loses the `ENSURE_WAIT_MS` import). Suites run
serially; the live P2 bench (separate podman container path) shares no files
with this diff.
