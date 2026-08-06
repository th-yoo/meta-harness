# Review-Loop-as-Sensor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Auto-fired haiku review passes at gated-Stop cadence emitting a counts-only findings stream (`.km/review-findings.ndjson`) — the b2 signal moved onto a dense source.

**Architecture:** Three layers. (1) The ACP layer gains the `session/close` wire verb — the spec's named build prerequisite — so a caller can close its pool entry instead of pinning one of 4 global slots for the 900 s reap. (2) A pure sensor-core module owns every decision (debounce/cap/claim/diff/truncation/line shapes) with hermetic tests. (3) A detached runner CLI wires core to git + the warm lane, spawned from hook-cli's Stop branch behind the arming gate. Ships OFF; activation is a separately-granted sized go.

**Tech Stack:** Bun + TypeScript, existing `src/acp/` daemon/pool (post-promotion layout, main ≥ 6417b7a), `bun test`.

**Spec:** `docs/superpowers/specs/2026-08-05-review-sensor-synthesis-design.md` (reviewed-to-FLAWLESS; spec-is-law — deviations get recorded in the review artifact, never silently).

## Global Constraints (verbatim from spec)

- Debounce ≥ 15 min between completed passes; cap < 30 passes since local midnight; constants pre-registered, user-amendable pre-data.
- Tier/transport: claude-haiku-4-5 via the ACP warm lane; zero-wait seat acquisition, lowest priority, never queues, never evicts; **close-not-release** at pass completion.
- Arming: env `KKAMAK_REVIEW_SENSOR=1` AND cwd == home-anchored main checkout (`~/z2/meta-harness`); worktree Stops never dispatch; **ships OFF** — flipping the env before the sized go is a protocol violation; sensor MUST NOT arm until `session/close` exists (build order in this plan guarantees it).
- Claim = exclusive create `fs.openSync(path, "wx")`; loser skips reason `"claim-lost"`; stale claim (older than debounce window) removed before create (declared TOCTOU accepted).
- Clock: negative debounce delta → skip reason `"clock-skew"`. Midnight cap-reset burst declared accepted.
- Diff: accumulated since last completed pass (committed range + working tree); empty diff → no dispatch, no line; merge in progress (`MERGE_HEAD` or porcelain `U*`) → skip reason `"merge-in-progress"`; truncation at nearest hunk boundary at/below 128 KiB, flagged in the line.
- F2: the ndjson stream carries counts/shas/stats ONLY — never finding text; full text → `.km/review-findings-text/<ts>.json` (gitignored), pruned beyond newest 500.
- Fail-open: sensor failure never blocks/delays the Stop; dispatch is a detached fire-and-forget spawn issued BEFORE `emit()`.
- Reviewer prompt frozen at implementation, sha256 recorded (ledger entry at activation, not in this plan's scope).
- `.km/` is already gitignored — no gitignore change needed.

## File Structure

```
cc-gate-plugin/src/acp/acp-wire.ts          (modify: ACP_SESSION_CLOSE + shapes)
cc-gate-plugin/src/acp/acp-pool.ts          (modify: closeEntry())
cc-gate-plugin/src/acp/acp-daemon.ts        (modify: session/close handler)
cc-gate-plugin/src/acp/acp-client.ts        (modify: sessionId on outcome + closeSession())
cc-gate-plugin/src/acp/index.ts             (modify: export closeSession — deliberate widening)
cc-gate-plugin/src/review-sensor/core.ts    (create: pure decisions + line shapes)
cc-gate-plugin/src/review-sensor/git-diff.ts(create: diff assembly, impure git seam)
cc-gate-plugin/src/review-sensor/runner.ts  (create: detached CLI entry)
cc-gate-plugin/src/review-sensor-spawn.ts   (create: maybeSpawnReviewSensor, mirrors prompt-check-spawn.ts)
cc-gate-plugin/src/hook-cli.ts              (modify: Stop-branch spawn hookup)
cc-gate-plugin/test/acp-pool.test.ts        (modify)
cc-gate-plugin/test/acp-daemon.test.ts      (modify)
cc-gate-plugin/test/acp-client.test.ts      (modify)
cc-gate-plugin/test/review-sensor-core.test.ts   (create)
cc-gate-plugin/test/review-sensor-git-diff.test.ts (create)
cc-gate-plugin/test/review-sensor-spawn.test.ts  (create)
```

Sensor modules live OUTSIDE `src/acp/` and import ONLY from `src/acp/index.ts` (the promotion's stated rule) and node/bun builtins — the sensor is the first non-gauge ACP consumer and must respect the boundary.

---

### Task 1: `SessionPool.closeEntry()`

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-pool.ts`
- Test: `cc-gate-plugin/test/acp-pool.test.ts`

**Interfaces:**
- Produces: `closeEntry(id: string): { closed: boolean; reason?: "unknown-id" | "busy" | "turn-in-flight" }` on `SessionPool` — closes the warm session and removes the entry; refuses busy/turn-in-flight entries (reap()'s discipline, per spec §2 warm-lane bullet).

- [ ] **Step 1: Write failing tests** (append to the existing `describe` in `acp-pool.test.ts`, using the file's existing fake `makeSession` pattern):

```ts
test("closeEntry closes and removes an idle entry", () => {
  const pool = mkPool(4) // file's existing helper
  const a = pool.acquire(ISO_A, 1000)
  expect(a.ok).toBe(true)
  const id = (a as { ok: true; entry: { id: string } }).entry.id
  pool.release(id, 2000)
  const r = pool.closeEntry(id)
  expect(r.closed).toBe(true)
  expect(pool.size()).toBe(0)
  // the fake session records close() calls — assert exactly one
})

test("closeEntry refuses a busy entry", () => {
  const pool = mkPool(4)
  const a = pool.acquire(ISO_A, 1000)
  const id = (a as { ok: true; entry: { id: string } }).entry.id
  // no release — still busy
  const r = pool.closeEntry(id)
  expect(r).toEqual({ closed: false, reason: "busy" })
  expect(pool.size()).toBe(1)
})

test("closeEntry refuses turn-in-flight even if not busy", () => {
  // fake session with turnInFlight() => true after release
  const r = poolWithInFlightIdleEntry().closeEntry(knownId)
  expect(r).toEqual({ closed: false, reason: "turn-in-flight" })
})

test("closeEntry on unknown id is a safe no-op", () => {
  const pool = mkPool(4)
  expect(pool.closeEntry("nope")).toEqual({ closed: false, reason: "unknown-id" })
})
```

Adapt helper names to what `acp-pool.test.ts` actually defines — read the file first; its fakes already expose close-call counting and `turnInFlight` control.

- [ ] **Step 2: Run to verify fail** — `cd cc-gate-plugin && bun test test/acp-pool.test.ts` → FAIL (`closeEntry is not a function`).

- [ ] **Step 3: Implement** (in `acp-pool.ts`, after `release()`; mirror `reap()`'s guard order and comment style):

```ts
/** Close ONE idle entry and remove it (sensor close-not-release,
 * review-sensor spec §2): refuses busy or turn-in-flight entries —
 * same ground-truth guards as reap(); a refusal degrades to the 900 s
 * reap backstop. Unknown ids are a safe no-op (double-close must never
 * throw into the daemon's dispatch path). */
closeEntry(id: string): { closed: boolean; reason?: "unknown-id" | "busy" | "turn-in-flight" } {
  const e = this.entries.find((e) => e.id === id)
  if (!e) return { closed: false, reason: "unknown-id" }
  if (e.busy) return { closed: false, reason: "busy" }
  if (e.warm.turnInFlight()) return { closed: false, reason: "turn-in-flight" }
  e.warm.close()
  this.entries = this.entries.filter((x) => x.id !== id)
  return { closed: true }
}
```

- [ ] **Step 4: Run to verify pass** — same command → all green (including pre-existing pool tests).
- [ ] **Step 5: Commit** — `git add cc-gate-plugin/src/acp/acp-pool.ts cc-gate-plugin/test/acp-pool.test.ts && git commit -m "feat(acp): SessionPool.closeEntry — guarded close+remove for one idle entry"`

---

### Task 2: `session/close` wire verb + daemon handler

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-wire.ts`, `cc-gate-plugin/src/acp/acp-daemon.ts`
- Test: `cc-gate-plugin/test/acp-daemon.test.ts` (+ `test/acp-wire.test.ts` if it asserts the verb list)

**Interfaces:**
- Consumes: Task 1's `closeEntry`.
- Produces: wire const `ACP_SESSION_CLOSE = "session/close"`; request params `{ sessionId: string }`; response result `{ closed: boolean; reason?: string }`. Daemon: reverse lookup entryId via `state.lastServedBySessionForEntry` (entryId → sessionId map — iterate to find the entry whose value === sessionId), then `pool.closeEntry(entryId)`; unknown sessionId → `{ closed: false, reason: "unknown-session" }`. Always a RESPONSE, never an error frame — a lost close race is a no-op by spec.

- [ ] **Step 1: Write failing daemon tests** (extend `acp-daemon.test.ts` with its existing fake-pool/fake-write harness):

```ts
test("session/close closes the entry that served the session", async () => {
  // arrange: session/new + session/prompt so lastServedBySessionForEntry maps entry→session
  // act: send {method: "session/close", params: {sessionId}}
  // assert: response {closed: true}; fake pool saw closeEntry(entryId)
})

test("session/close for an unknown session responds closed:false unknown-session", async () => { /* ... */ })

test("session/close while the entry is busy responds closed:false busy (pool guard)", async () => { /* ... */ })
```

Flesh these out against the harness's real helper names — the file already builds `handle(frame, write)` with an injectable pool.

- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — in `acp-wire.ts` add the const + shapes next to `ACP_SESSION_CANCEL`; in `acp-daemon.ts` add `case ACP_SESSION_CLOSE` to the dispatch switch:

```ts
case ACP_SESSION_CLOSE: {
  const sessionId = readSessionIdParam(msg) // reuse the file's existing param-reading style
  let entryId: string | undefined
  for (const [eid, sid] of state.lastServedBySessionForEntry) {
    if (sid === sessionId) { entryId = eid; break }
  }
  const result = entryId === undefined
    ? { closed: false, reason: "unknown-session" }
    : pool.closeEntry(entryId)
  if (result.closed && entryId !== undefined) {
    state.lastServedBySessionForEntry.delete(entryId)
  }
  respond(msg.id, result) // file's existing response helper
  return
}
```

- [ ] **Step 4: Run to verify pass** — `bun test test/acp-daemon.test.ts test/acp-wire.test.ts`.
- [ ] **Step 5: Commit** — `"feat(acp): session/close wire verb + daemon handler (review-sensor build prerequisite)"`

---

### Task 3: client `closeSession()` + sessionId on `DaemonOutcome` + public export

**Files:**
- Modify: `cc-gate-plugin/src/acp/acp-client.ts`, `cc-gate-plugin/src/acp/index.ts`
- Test: `cc-gate-plugin/test/acp-client.test.ts`

**Interfaces:**
- Produces: `DaemonOutcome` gains `sessionId?: string` (set when a session was established — additive, no existing consumer breaks); new `closeSession(sessionId: string, env: Record<string, string | undefined>, opts?: { budgetMs?: number }): Promise<{ closed: boolean; reason?: string }>` — one socket round-trip, resolves `{ closed: false, reason: "unreachable" }` on any transport failure (never throws; close is best-effort by spec — reap is the backstop). `index.ts` exports `closeSession` with a comment marking the deliberate widening for the review-sensor consumer.

- [ ] **Step 1: Failing tests** — extend `acp-client.test.ts` (it has a fake-daemon harness, `test/acp-fake-daemon.ts`): (a) `daemonCall` outcome carries the sessionId the fake daemon issued; (b) `closeSession` sends a `session/close` frame with that id and resolves the daemon's result; (c) `closeSession` against a dead socket resolves `{closed:false, reason:"unreachable"}` without throwing.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** — thread the sessionId already tracked inside `daemonCall`'s promise into its resolutions; `closeSession` follows `probeOnce`'s minimal connect-send-await-response shape. Add to `acp-fake-daemon.ts` a `session/close` echo. Export from `index.ts`:

```ts
/** Close the pool entry that served a session (review-sensor spec §2:
 * close-not-release). First consumer outside src/gauge/: the review
 * sensor. Deliberate widening of the public surface. */
export { closeSession } from "./acp-client.ts"
```

- [ ] **Step 4: Run to verify pass** — `bun test test/acp-client.test.ts`.
- [ ] **Step 5: Commit** — `"feat(acp): closeSession client + sessionId on DaemonOutcome, exported via index"`

---

### Task 4: sensor core (pure decisions + line shapes)

**Files:**
- Create: `cc-gate-plugin/src/review-sensor/core.ts`
- Test: `cc-gate-plugin/test/review-sensor-core.test.ts`

**Interfaces:**
- Produces (all pure, no I/O — callers inject `now`, file ops live in runner):

```ts
export const DEBOUNCE_MS = 15 * 60 * 1000
export const DAILY_CAP = 30
export const DIFF_CEILING_BYTES = 128 * 1024
export const SIDE_FILE_KEEP = 500
export const MAIN_CHECKOUT_DIR = path.join(os.homedir(), "z2", "meta-harness") // probe-script precedent

export interface SensorState { lastPassTs: number; lastPassHead: string; dayKey: string; dayCount: number }
export type SkipReason = "debounce" | "cap" | "clock-skew" | "claim-lost"
  | "merge-in-progress" | "warm-lane-busy" | "bad-review-output" | "dispatch-error"

/** Gate decision. dayKey = local YYYY-MM-DD of `now` (midnight reset, burst accepted by spec). */
export function shouldDispatch(state: SensorState | undefined, now: number):
  { go: true } | { go: false; reason: "debounce" | "cap" | "clock-skew" }

/** Hunk-aligned truncation: cut at the LAST hunk/file header boundary
 * ("diff --git " or "@@ " line start) at or below the ceiling.
 * Returns { text, truncated }. Never cuts mid-hunk. */
export function truncateDiff(diff: string, ceilingBytes?: number): { text: string; truncated: boolean }

/** Frozen reviewer prompt (sha256 of this string is the instrument identity). */
export function buildReviewPrompt(diff: string): string
export function reviewPromptSha(): string

/** Parse the model's JSON reply. Tolerant: fenced or bare JSON object with
 * findings: Array<{severity: "high"|"med"|"low", file: string, line: number}>.
 * Anything unparseable -> undefined (runner emits skip "bad-review-output"). */
export function parseFindings(text: string): { findings: Array<{ severity: "high" | "med" | "low"; file: string; line: number }> } | undefined

/** ndjson line builders — counts only, F2. */
export function passLine(args: { ts: number; findings: Array<{severity: string}>; diffStat: { files: number; insertions: number; deletions: number }; baseSha: string; headSha: string; truncated: boolean; diffBase: "range" | "merge-base" | "fallback"; durationMs: number; pluginVersion: string | undefined; host: string }): string
export function skipLine(args: { ts: number; reason: SkipReason; pluginVersion: string | undefined; host: string }): string
```

`buildReviewPrompt` content (frozen here; changing it later = new boundary ts):

```
kkamak review sensor. Review ONLY the diff below for defects a
code reviewer would flag: bugs, broken invariants, silent behavior
changes, missing error paths. Reply with STRICT JSON, nothing else:
{"findings":[{"severity":"high"|"med"|"low","file":"<repo-relative path>","line":<number>}]}
Empty array if nothing rises to a finding. No prose, no fences.

DIFF:
<diff text>
```

- [ ] **Step 1: Failing tests** — hermetic, table-driven:
  - `shouldDispatch`: undefined state → go; delta < 15 min → debounce; negative delta → clock-skew; dayCount 29 → go, 30 → cap; dayKey rollover resets count (compute dayKey from injected `now` values one minute either side of local midnight).
  - `truncateDiff`: small diff untouched; synthetic multi-hunk diff > ceiling cuts exactly at a `diff --git `/`@@ ` boundary ≤ ceiling with `truncated: true`; a single hunk larger than the ceiling degrades to header-only + truncated.
  - `parseFindings`: bare JSON, fenced JSON, junk → undefined, wrong-shaped severity → undefined.
  - `passLine`/`skipLine`: JSON.parse round-trip; passLine severityCounts counted correctly; NO field carries finding text (assert the serialized line does not contain a sentinel string planted in a hypothetical `note` field — i.e. the builder accepts no text fields at all, enforced by the type).
- [ ] **Step 2: Run to verify fail.** — `bun test test/review-sensor-core.test.ts`
- [ ] **Step 3: Implement** exactly the surface above; keep every function under ~30 lines.
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `"feat(review-sensor): pure core — gate decisions, hunk-aligned truncation, frozen prompt, F2 line builders"`

---

### Task 5: git diff assembly

**Files:**
- Create: `cc-gate-plugin/src/review-sensor/git-diff.ts`
- Test: `cc-gate-plugin/test/review-sensor-git-diff.test.ts`

**Interfaces:**
- Consumes: nothing from other tasks (parallel-safe with Task 4).
- Produces:

```ts
export interface DiffResult {
  diff: string                       // committed range + working-tree, concatenated
  diffStat: { files: number; insertions: number; deletions: number }
  baseSha: string; headSha: string
  diffBase: "range" | "merge-base" | "fallback"
}
/** undefined => merge in progress (caller skips "merge-in-progress").
 * Empty-string diff => nothing to review (caller: no dispatch, no line). */
export function assembleDiff(repoDir: string, lastPassHead: string | undefined): DiffResult | undefined
```

Mechanics (spec §2 diff edge cases, verbatim order): merge-in-progress check first (`fs.existsSync(.git/MERGE_HEAD)` OR `git status --porcelain` lines whose first two chars contain `U`); base = `lastPassHead` if `git merge-base --is-ancestor` holds (`diffBase: "range"`), else `git merge-base lastPassHead HEAD` (`"merge-base"`), else working-tree-vs-HEAD only (`"fallback"`); diff = `git diff <base> HEAD` + `git diff HEAD` (working tree incl. staged); diffStat from `git diff --shortstat` over the same inputs. All git via `execFileSync` with `{ cwd: repoDir }`, any git failure → treat as fallback, never throw.

- [ ] **Step 1: Failing tests** — temp git repos (mirror `loop-probes-cli.test.ts`'s `mkGitRepoWithCommits` style): range case, non-ancestor (rebase) → merge-base, no-merge-base (orphan) → fallback, mid-merge repo (create a real conflict) → undefined, clean repo with no changes since base → empty diff.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass.**
- [ ] **Step 5: Commit** — `"feat(review-sensor): diff assembly — ancestor/merge-base/fallback ladder, merge-in-progress guard"`

---

### Task 6: runner CLI (claim → diff → warm call → emit)

**Files:**
- Create: `cc-gate-plugin/src/review-sensor/runner.ts`
- Test: extend `cc-gate-plugin/test/review-sensor-core.test.ts` only for the pure helper below; the runner's end-to-end path is covered by Task 7's spawn test + the ACP fakes (no live model call in tests, ever).

**Interfaces:**
- Consumes: Task 3 `ensureDaemon`/`daemonCall`/`closeSession` (import from `../acp/index.ts` ONLY), Task 4 core, Task 5 `assembleDiff`.
- Produces: `bun cc-gate-plugin/src/review-sensor/runner.ts <repoDir>` — the detached entry point. Also exports `runOnce(deps)` with injected deps `{ now(): number; call: typeof daemonCall; close: typeof closeSession; ensure: typeof ensureDaemon }` for testability.

Flow (each guard emits its skip line via core builders and exits 0 — fail-open, exit code never matters to the Stop):

```
state = read .km/review-sensor-state.json (tolerant: missing/corrupt -> undefined)
d = shouldDispatch(state, now)          -> skip line on {go:false}
stale-claim cleanup + openSync(claim, "wx")  -> "claim-lost" on EEXIST
diff = assembleDiff(repo, state?.lastPassHead) -> "merge-in-progress" / silent exit on empty
ensure + daemonCall(prompt, "claude-haiku-4-5", env, { isolation: REVIEW_SENSOR_ISOLATION, budgetMs })
  -> pool-exhausted / transport failure => "warm-lane-busy"
parseFindings -> undefined => "bad-review-output"
append passLine to .km/review-findings.ndjson; write side file; prune side files beyond SIDE_FILE_KEEP
write new state {lastPassTs: now, lastPassHead: HEAD, dayKey, dayCount+1}
closeSession(outcome.sessionId, env)    // best-effort; result ignored beyond a log line
unlink claim (finally)
```

`REVIEW_SENSOR_ISOLATION`: defined in runner.ts on the CALLER side (the promotion's extraction-wart guidance — isolation values belong to consumers, like `REASONING_ISOLATION` in send-prompt.ts). Copy `GAUGE_ISOLATION`'s shape with a distinct marker value.

- [ ] **Step 1: Failing test for the one pure piece worth isolating** — `pruneSideFiles(dir, keep)` exported from runner.ts: create 7 fake side files, keep 5, assert the 2 oldest (by name = ts) removed.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement runner.**
- [ ] **Step 4: Run to verify pass** + `cd cc-gate-plugin && bunx tsc --noEmit`.
- [ ] **Step 5: Commit** — `"feat(review-sensor): detached runner — claim, diff, warm-lane call, close-not-release, F2 emit"`

---

### Task 7: spawn seam + Stop-branch hookup (armed = no-op by default)

**Files:**
- Create: `cc-gate-plugin/src/review-sensor-spawn.ts`
- Modify: `cc-gate-plugin/src/hook-cli.ts` (Stop branch, immediately before the final `emit` — same placement discipline as the file's other spawns)
- Test: `cc-gate-plugin/test/review-sensor-spawn.test.ts`

**Interfaces:**
- Consumes: nothing from runner at runtime (it only builds the command string).
- Produces: `maybeSpawnReviewSensor(args: { cwd: string; env: Record<string, string | undefined>; spawn: (cmd: string) => void }): boolean` — returns whether it spawned. Mirrors `maybeSpawnPromptCheck`'s injected-spawn pattern exactly (read `prompt-check-spawn.ts` first and copy its structure).

Gate, in order (all must hold): `env.KKAMAK_REVIEW_SENSOR === "1"`; `path.resolve(cwd) === MAIN_CHECKOUT_DIR` (worktree Stops never dispatch); then `spawn(...)` the runner with nohup-detached bash exactly like hook-cli's existing two spawns. The `session/close` build prerequisite is satisfied structurally (Tasks 1-3 precede this in the same package); the env default-off IS the fail-closed arming state the spec demands.

- [ ] **Step 1: Failing tests** — fake spawn recorder: env unset → no spawn; env set + wrong cwd (a tmp dir) → no spawn; env set + cwd == MAIN_CHECKOUT_DIR → exactly one spawn, command contains `review-sensor/runner.ts`. (Override the checkout dir via an optional `mainCheckoutDir` arg so the test doesn't depend on the real home path.)
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement + hook into hook-cli.ts Stop branch** — one call, comment: `// review-sensor (spec 2026-08-05): detached BEFORE emit(); second detached child on a gated Stop alongside gate-check's own spawnBg — declared, no conflict.`
- [ ] **Step 4: Run** — `bun test test/review-sensor-spawn.test.ts`, then the FULL suite `cd cc-gate-plugin && bun test` and `bunx tsc --noEmit` (hook-cli is load-bearing for every Stop).
- [ ] **Step 5: Commit** — `"feat(review-sensor): Stop-branch spawn behind arming gate (ships OFF)"`

---

### Task 8: full-suite gate + ready-to-arm report (no arming)

**Files:** none created — verification task.

- [ ] **Step 1:** repo root `bun test` (all packages' tests the root config reaches) — green.
- [ ] **Step 2:** `cd cc-gate-plugin && bunx tsc --noEmit` (+ km-crank, opencode-plugin if the repo's doc-check/tsc convention covers them) — clean.
- [ ] **Step 3:** grep-verify F2: `grep -rn "note\|text" cc-gate-plugin/src/review-sensor/core.ts` — line builders expose no text-bearing field.
- [ ] **Step 4:** Report READY-TO-ARM to the user: prompt sha256 (from `reviewPromptSha()`), constants table, and the sized-go template the spec demands (named host, 30/day cap math). **Do NOT set KKAMAK_REVIEW_SENSOR anywhere. Do NOT write the ledger entry — that happens at activation with the real boundary ts.**

---

## Self-Review (done at write time)

- Spec coverage: rulings 1-2 → Tasks 4/6/7; §2 mechanism bullets → Tasks 4 (claim/clock/truncation constants + builders), 5 (diff ladder + merge guard), 6 (flow + close-not-release), 7 (spawn discipline + arming); §3 stream shape → Task 4 builders; §4 boundary/comparison discipline → activation-time duties, named in Task 8's report; §5 activation → Task 8 explicitly defers; §6/§7 → structural (no gate coupling, F2 asserted in tests). `session/close` prerequisite → Tasks 1-3 precede Task 7.
- Placeholders: none — every step carries real code or an exact command.
- Type consistency: `closeEntry` result shape identical in Tasks 1-2; `closeSession` result mirrors it in Task 3; `SkipReason` in Task 4 covers every reason Tasks 6-7 emit.
- Deviation latitude: executors adapt test-harness helper NAMES to what the existing test files define (explicitly instructed in Tasks 1-3) — shapes and behaviors are fixed.
