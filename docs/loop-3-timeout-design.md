# Loop-3: closing the timeout blind-spot

Design doc (2026-07-15) — **precedes** an implementation plan (like
[master-open-questions-research.md](master-open-questions-research.md) and
[enhancement-roadmap.md](enhancement-roadmap.md)), not a task-by-task TDD plan.
Graduates into a `docs/superpowers/plans/` plan once the open questions below
are settled.

Grounded in the code at commit `f519bc5`. Every claim cites `file:line`.

---

## 1. Problem

The evolution loop's proposer learns from task **trajectories** and per-session
scores. **Timeout runs are invisible to it.** When an agent drive hits the wall
timeout it produces a 0-turn, `reward=0` result that is *dropped before it ever
reaches the store* — so the proposer sees no trajectory, no session line, and
cannot learn to fix timeouts (surface a time budget, pick a cheaper approach,
or emit a timeout-bump policy).

This is live, not hypothetical. In the loop-2 `ab` running right now, task
`tune-mjcf` times out on **both** arms:

```
loop2-ab-v3.log:68   === ab tune-mjcf [held-in]: v3 vs active v0 ===
loop2-ab-v3.log:76     agent timed out after 600s
loop2-ab-v3.log:78     reward=0  elapsed=638.4s
loop2-ab-v3.log:83     agent timed out after 600s        (second arm)
loop2-ab-v3.log:85     reward=0  elapsed=636.8s
```

`638.4s ≈ 636.8s ≈` the 600s agent wall + container-staging + verifier
overhead. That failure will teach the proposer nothing under the current
design.

### The exact code path where a timeout becomes an invisible 0-turn result

1. **Wall hit → 0-turn output.** `runAgent` wraps the driver argv in
   `withTimeout(cmd, agentTimeout)` (`agent-run.ts:178`). `exec.ts` maps the
   coreutils `timeout` exit code 124 to `timedOut: true` (`exec.ts:95`,
   `ExecResult.timedOut` at `exec.ts:54`). On timeout, `runAgent` logs
   `TIMEOUT_MARK` (`"agent timed out after"`, `agent-run.ts:48`) and
   **returns a zero result**:

   ```
   agent-run.ts:181   if (result.timedOut) {
   agent-run.ts:182     log(`  ${TIMEOUT_MARK} ${pyFixed(agentTimeout, 0)}s`)
   agent-run.ts:183     return { turnCount: 0, toolUsage: {}, events: [] }
   agent-run.ts:184   }
   ```

   Note `events: []` — the partial trajectory is discarded here. The agent-phase
   `elapsedSec` measured at `agent-run.ts:179` is **not** returned either;
   `AgentRunOutput` (`drivers/types.ts:15-19`) carries only
   `{ turnCount, toolUsage, events }`.

2. **0-turn → dropped by the store recorder.** `runTaskOnce` computes the
   whole-task `elapsed` (`cmd-run.ts:249`), logs `reward=… elapsed=…s`
   (`cmd-run.ts:250`), and returns a `RunTaskResult` whose `error` field is
   `turnCount === 0 ? "agent_no_output" : ""` (`cmd-run.ts:258`). Then
   `recordToStores` **returns early, recording nothing**, for any 0-turn run:

   ```
   record.ts:299   if (turnCount === 0) {
   record.ts:300     log("  skip store record: 0 agent turns (timeout/transient agent failure)")
   record.ts:301     return
   record.ts:302   }
   ```

3. **Same drop in `ab`.** The `ab` gate records only arm B (candidate),
   held-in, and only when `resB.turns > 0` (`cmd-ab.ts:330`). A timeout
   (`turns === 0`) is skipped there too — while **still counting as `reward=0`
   in the gate's rate** (`cmd-ab.ts:325-326` push `resA.reward`/`resB.reward`).

So the timeout **penalizes the candidate's pass-rate but leaves no evidence the
proposer can read**.

---

## 2. Root cause — why the proposer never learns timeouts today

The proposer's entire view of a layer is built from `score.json` sessions and
on-disk trajectories:

- Per-session context lines come from `buildProposerContext`
  (`harness-store.ts:1300`), which renders each `SessionRecord` as
  `… | PASS/FAIL | … | turns=N …` (`harness-store.ts:1333`). It iterates
  `readScore(...).sessions` — records that `recordToStores` never wrote.
- The failing-trajectory index comes from `buildFailureExcerpts`
  (`harness-store.ts:421`), which lists `traj/<sessionID>.ndjson` files — files
  `recordToStores` never wrote (it skipped both the record *and*
  `writeTrajectory`).
- The proposer prompt stitches these together at `propose.ts:782-784` ("Prior
  session scores and traces") and `propose.ts:617-620` (failing excerpts).

Because a timeout produces **no session record and no trajectory**, none of
these surfaces contain it. The proposer literally cannot diagnose a failure it
cannot see.

Meanwhile the fix path already exists but **starves**: `buildProposerPrompt`
offers an `agent-config.json` op for "bash-tool timeout tuning" gated on a
timeout diagnosis —

```
propose.ts:697   Emit this file ONLY if a diagnosed root cause is a timeout / tool-latency problem; otherwise omit it.
```

— and the `FAILURE_TAXONOMY` already includes `resource-limit`
(`propose.ts:65`), the natural label for a wall-timeout. The proposer can react
to timeouts; it just never gets a timeout to react to. (Note the two knobs are
distinct: `agent-config.json fastTimeoutMs` is a *plugin-level bash-command*
timeout for the live loop, project-layer only and inert during account `ab`
(`propose.ts:263-265, 683-684`); the wall that `tune-mjcf` hit is the
*bench-level agent wall* `--max-agent-timeout` → `taskTimeouts`
(`tasks.ts:120-143`) → `withTimeout` (`agent-run.ts:178`). Loop-3 makes the
*wall* visible; §6 keeps the two from being conflated.)

### The measured-but-unpersisted seam (key finding)

Wall-clock `elapsed` **is** measured and logged (`agent-run.ts:179`,
`cmd-run.ts:249-250`) and pushed into the results-file aggregate
(`cmd-run.ts:423`, `TaskAgg.elapsed[]` in `results.ts:27`). But it is **not**
persisted onto `score.json` sessions and **not** used in selection. The
`SessionRecord` schema (`harness-store.ts:112-146`) has no `elapsed` and no
timeout flag — a real record confirms it:

```jsonc
// ~/.config/meta-harness/global/candidates/v3/score.json  (a passing session)
{
  "sessionID": "bench-path-tracing-…", "passed": true, "turnCount": 1,
  "toolUsage": { … },
  "env": { "maxAgentTimeout": 600, "driver": "opencode", … },   // budget IS here
  "platform": "opencode"
  // no "elapsed", no "timedOut"
}
```

The wall (`env.maxAgentTimeout: 600`) is already recorded; what's missing is
(a) the actual `elapsed` the run consumed and (b) a `timedOut` flag — and,
above all, (c) that timeout runs are dropped entirely. `record-timeouts` (§4)
closes all three.

---

## 3. The fix — three named components

| Component | One-line intent |
|---|---|
| **budget-inject** | Tell the agent how long it has, so it can self-manage / pick a cheaper approach. |
| **record-timeouts** | Make a 0-turn wall-timeout a first-class, proposer-visible, *diagnosed* signal. |
| **re-baseline** | After any budget/timeout-policy change, re-establish the reference so the gate compares apples-to-apples. |

`record-timeouts` is the load-bearing one (it unblocks the proposer);
`budget-inject` gives the proposer something actionable to propose against;
`re-baseline` keeps the change honest.

---

## 4. record-timeouts (the core fix)

**Goal:** a wall-timeout becomes a stored `SessionRecord` (a distinct failure
mode with `elapsed`), *without* also storing auth-failure / transient-outage
0-turn runs (which are genuinely not verdicts on the harness).

### 4.1 The discriminator problem

`runAgent` today returns an **identical** `{ turnCount: 0, … }` for three
different 0-turn outcomes:

- wall timeout (`agent-run.ts:183`),
- unrecoverable auth failure (`agent-run.ts:206`),
- genuine no-output / exhausted transient retries (`agent-run.ts:221`).

The store-skip guard (`record.ts:299`) exists **on purpose** for auth/transient
— "not a verdict on the harness." So we cannot just delete the guard; we must
teach the pipeline to tell a *timeout* apart from the other two, then record the
timeout while still dropping the others.

### 4.2 Data-shape changes

**(a) `AgentRunOutput` gains `timedOut`** (`drivers/types.ts:15-19`):

```ts
export interface AgentRunOutput {
  turnCount: number
  toolUsage: ToolUsage
  events: TrajEvent[]
  timedOut?: boolean         // NEW — set true only on the wall-timeout branch
  agentElapsedSec?: number   // NEW (optional) — agent-phase seconds (agent-run.ts:179)
}
```

`runAgent` sets `timedOut: true` in the timeout branch (`agent-run.ts:183`),
leaves it unset for auth (`:206`) and normal (`:221`). Optional so every driver
`parseOutput` (`drivers/types.ts:39`) keeps compiling.

**(b) `RunTaskResult` gains `timedOut`** (`cmd-run.ts:46-58`): carry the flag
through so `error` stops conflating causes. `error` becomes
`timedOut ? "timeout" : turnCount === 0 ? "agent_no_output" : ""` (extends the
union at `cmd-run.ts:53`). `elapsed` is already present (`cmd-run.ts:49, :254`).

**(c) `SessionRecord` gains `elapsed` + `timedOut`** (`harness-store.ts:112`):

```ts
export interface SessionRecord {
  … existing fields …
  /** Wall-clock seconds this session consumed (cmd-run.ts elapsed). Optional
   *  so pre-Loop-3 records keep parsing; absent = unknown. */
  elapsed?: number
  /** True iff the agent phase hit the wall timeout (turnCount will be 0).
   *  Optional; absent = false. */
  timedOut?: boolean
}
```

This follows the **established additive-optional precedent** in this same
interface (`platform?` at `:129`, `judge?` at `:132`, both documented "Optional
so pre-… records keep parsing"). **No `schemaVersion` bump** — `CandidateScore`
has no version field today and every consumer already tolerates missing optional
fields. Back-compat rule for all readers: **absent `timedOut` ⇒ `false`, absent
`elapsed` ⇒ unknown.** The record is serialized once and lands in both
`traces/<id>.json` (`harness-store.ts:634`) and `score.json`
(`:641`) automatically.

### 4.3 Wiring changes

- **`sessionRecord` builder** (`record.ts:249`): accept `elapsed` + `timedOut`,
  stamp them onto the record.
- **`recordToStores`** (`record.ts:281`): add a `timedOut` parameter and change
  the skip guard so a timeout is **recorded**, auth/transient still dropped:

  ```ts
  // record.ts:299 (new)
  if (turnCount === 0 && !timedOut) {
    log("  skip store record: 0 agent turns (auth/transient agent failure)")
    return
  }
  // timeouts fall through: passed=false, turnCount=0, timedOut=true, elapsed set
  ```

  A timeout record is a genuine **fail** (`passed = false` → `nFail++` in
  `recordSession`, `harness-store.ts:640`). It has no trajectory to save
  (`events: []`), so the `saveTraj` branch (`record.ts:305`) is naturally a
  no-op — see §7 for optional partial-trajectory capture.
- **`ab` recording** (`cmd-ab.ts:330`): change the guard
  `recordArmB && !noStore && resB.turns > 0` →
  `… && (resB.turns > 0 || resB.timedOut)` so held-in candidate timeouts also
  become visible to the proposer.
- **`cmd-run.ts` call site** (`cmd-run.ts:402-421`): thread `res.timedOut` and
  `res.elapsed` into the `recordToStores` call and the `taskAgg` push.

### 4.4 Making it a *diagnosed* signal (not just a stored fail)

Storing the record is necessary but not sufficient — the proposer must read it
as "timeout," not another anonymous FAIL:

- **Context line** (`buildProposerContext`, `harness-store.ts:1333`): when
  `s.timedOut`, append a marker, e.g.
  `… | FAIL | turns=0 | TIMEOUT ${s.elapsed}s / ${env.maxAgentTimeout}s budget`.
  This is the single highest-leverage surface — it's what the proposer reads
  first (`propose.ts:782-784`).
- **A dedicated "timed-out sessions" note** in the proposer prompt so the model
  is explicitly nudged toward the `resource-limit` taxonomy label
  (`propose.ts:65`) and the existing `agent-config.json` / `env-policy.json`
  timeout ops (`propose.ts:697, :727`). Timeouts have **no trajectory** to
  diagnose from, so this note *is* the evidence (elapsed vs budget, plus any
  tool-usage captured before the wall).

**Why this closes the hole:** the exact failure that is invisible today
(`tune-mjcf`, 638s / 600s) becomes a `SessionRecord{passed:false, turns:0,
timedOut:true, elapsed:638.4}` that the proposer sees, labels `resource-limit`,
and can react to by emitting a budget-hint rule or a timeout-bump policy —
turning `propose.ts:697`'s starving path into a fed one.

---

## 5. budget-inject

**Goal:** the agent knows how long it has, so it can choose a cheaper approach
instead of blindly running into the wall.

**What changes.** `runAgent` (`agent-run.ts:135-155`) already holds
`agentTimeout` and reads `instruction.md`. Inject a single advisory line derived
from `agentTimeout` into the instruction (same text delivered to the container
regardless of driver — `agent-run.ts:147-155`), e.g.:

> *You have roughly **{agentTimeout}s** of wall-clock for this task. Budget it:
> prefer a simpler approach that finishes over an ambitious one that risks
> running out of time.*

**Which file/function.** `agent-run.ts` `runAgent`, at instruction assembly
(before `driver.buildArgv`, `agent-run.ts:155`). No schema change. The value
comes from the already-computed `agentTimeout` parameter, which both `ab` arms
receive identically from `taskTimeouts` (`cmd-ab.ts:310`, `tasks.ts:120`).

**Why symmetric ⇒ fair (and not gameable — see §6):** because it's derived from
the real wall and injected at the bench level, **both `ab` arms get the same
budget line**, so it is a controlled constant, not an A/B lever. A candidate
that *additionally* evolves a budget-management rule in its `system.md` is a
legitimate, separately-tested lever (arm B only) — and that's exactly the
proposer reaction §4 unblocks.

**Provenance.** `env.maxAgentTimeout` already records the wall
(`record.ts:236`, seen in `v3/score.json`). budget-inject reuses it — no new
provenance field, and the re-baseline gate (§6) keys off it.

---

## 6. re-baseline mechanics — keeping the gate fair

### 6.1 What is already fair (the airtight core)

Within **one** `ab` invocation the comparison is apples-to-apples **by
construction**: arm A (active) is re-run fresh alongside arm B (candidate) every
time (`cmd-ab.ts:316-318`), and both draw the **same** `agentTimeout` from
`taskTimeouts` (`cmd-ab.ts:310`). `tune-mjcf` demonstrates it — both arms hit
600s (log lines 76 and 83). The gate never compares a fresh candidate against a
stale persisted baseline; it always pairs them at the identical budget. So the
`decision` in `ab-verdict.json` (`candidateRate` vs `activeRate`,
`cmd-ab.ts:283-284`) is fair for any single verdict, whatever the budget.

Account-layer candidates additionally **cannot** smuggle a wall-timeout bump
into their own `ab`: `env-policy`/`agent-config` are project-only and the plugin
is inert under the default `build` agent that account `ab` runs
(`propose.ts:263-265, 679-682`). So "a candidate that wins only because it got
more time" is structurally impossible *inside* a verdict.

### 6.2 Where unfairness actually enters — and the re-baseline obligation

Two budget changes happen **outside** a single `ab`, and those are what
re-baseline must guard:

1. **The loop bumps `--max-agent-timeout`** (a plausible reaction to diagnosed
   timeouts: "give `tune-mjcf` 900s"). Every subsequent `ab` is still internally
   fair, but the **longitudinal baseline** the loop uses to claim progress
   (`report-loop.ts` `baselineRate`, `:63, :118-128`; the 0.381 figure in
   [loop-1-state.md]) was measured at 600s. Comparing a 900s pass-rate against a
   600s baseline is not progress — it's a different benchmark.

2. **The recording-policy change in §4 itself.** After Loop-3, timeouts count as
   stored **fails**; before, they were excluded from `score.json` entirely. So
   an old (timeout-excluded) baseline pass-rate is not comparable to a new
   (timeout-included) one, *independently of any wall change*.

**The rule:** *a candidate may only be accepted over — and the loop may only
claim improvement against — a baseline measured under the same effective budget
**and** the same timeout-recording policy.*

**Mechanics:**

- **Stamp the budget into the verdict.** Add `maxAgentTimeout` (and a
  `timeoutRecording: true` marker) to `ab-verdict.json` and to
  `writeRunResults` (`results.ts:138`). The verdict already carries `splitHash`
  and `activeFold` (`cmd-ab.ts:207-208, 279`) as the split-identity guard;
  `maxAgentTimeout` is the budget-identity guard, in the same spirit.
- **Trigger a re-baseline when the budget-identity changes.** Concretely: when
  the loop changes `--max-agent-timeout` (or flips on timeout-recording), it
  **re-scores the active version** at the new budget (`runner.ts run` on active,
  or equivalently a fresh `ab` of the incoming candidate whose arm A *is* the
  re-scored active) **before** trusting any cross-generation delta. The
  `report-loop` baseline ledger is reset to the re-scored figure.
- **Belt-and-suspenders gate check.** When activating a candidate
  (`/mh-activate`, or the auto-gate), refuse/flag a verdict whose stamped
  `maxAgentTimeout` differs from the budget the active/baseline sessions carry
  in their `env.maxAgentTimeout`. This makes a budget mismatch a hard,
  detectable condition rather than a silent Goodhart.

Because the *gate decision itself* always re-pairs both arms at one budget
(§6.1), re-baseline is about the loop's **progress ledger and activation
provenance**, not the internal accept/reject math. That split is what makes the
fairness argument airtight: the thing that decides accept/reject is
self-fair; the thing re-baseline protects is the longitudinal claim.

### 6.3 Operator runbook: performing a manual re-baseline (T7)

**Status: SHIPPED (T6 provenance/gate + T7 report-loop segmentation).** Both
mechanisms are now built. What follows is settled — it answers open question 2
below (§ "Open questions"): re-baseline is a **MANUAL operator step**, never an
auto-fire.

**What T7 built (the mechanism, not the trigger).** `report-loop.ts`'s
`plateauVerdict`/`benchLayerVerdict` now segment their windows by the
budget-identity tuple `{maxAgentTimeout, timeoutRecording, resourceEnforcement}`
stamped on each `trial`/`ab` `MetaMetricEvent` (mirroring T6's `ab-verdict.json`
stamp — `harness-store.ts`'s `budgetIdentityMatches`/`BudgetStamp`, reused
as-is). A `trial`/`ab` event whose tuple differs from the stream's *current*
identity (the most recent stamped event's tuple) is excluded from both `n` and
the trailing window — so a post-change `trialRate` can never register as a
"strict improvement" over a pre-change `baselineRate`, and a post-change
`ab` run can never fill a pre-change layer's plateau window either. Events with
no budget-identity fields at all (pre-Loop-3) are treated as compatible with
everything (no claim to violate), so nothing here changes behavior until the
fields start actually being stamped onto live `trial`/`ab` events. This makes
the reset **automatic once the identity change happens** — the operator does
not need to hand-edit or truncate the `meta-metrics.jsonl` ledger.

**The operator step — do this whenever you bump `--max-agent-timeout`, flip
`recordTimeouts` ON, or flip `--enforce-resources` ON** (any one of these is a
budget-identity change; §6.2 item 2 — flipping `recordTimeouts` is itself one,
independent of any wall change):

1. **Decide and make the change once, deliberately.** If both a wall bump and
   the `recordTimeouts` flip are due, do them together as ONE cutover (per
   design §6.2 item 2 / the Loop-3 plan's "Notes" — don't re-baseline twice for
   what is really one identity change).
2. **Re-score the active version at the new identity** — run the bench harness
   against the layer's currently-active text at the new budget (e.g.
   `bun term-bench2/runner.ts run --all --layers <layer> --max-agent-timeout 900`,
   plus `--enforce-resources` if that's flipping too, and/or the new
   `recordTimeouts` config value in `<accountMetaRoot()>/config.json`). This is
   the step design §6.2 calls "re-scores the active version at the new budget
   … before trusting any cross-generation delta" — it refreshes the active
   version's `score.json` `env.maxAgentTimeout`/`env.resourceEnforcement` (and,
   for `timeoutRecording`, its own `ab-verdict.json` if it has one) so
   `readActiveBudget` (T6, `harness-store.ts`) reports the NEW identity as the
   layer's baseline.
3. **Continue the propose→ab→activate loop as normal.** Because step 2 already
   moved the active layer's budget-identity forward, a subsequent candidate's
   `ab` at the new identity will match `readActiveBudget` and activate through
   `/mh-activate`'s T6 gate WITHOUT needing `--force`. (If you skip step 2 and
   activate a new-identity candidate straight away, the T6 gate refuses with a
   budget-mismatch toast naming both budgets — you can `--force` through it as
   the one deliberate cutover, but then the longitudinal ledger has no
   same-identity history yet either way; re-scoring active first, per step 2,
   is the cleaner path.)
4. **Nothing further to do to the `report-loop` ledger itself.** T7's
   segmentation means the first few post-change generations will correctly
   read `project: ok (n=<k>, insufficient data)` (not a false plateau, not a
   false improvement) until `PLATEAU_TRIAL_K` (default 4) same-identity
   resolved trials accumulate — at which point `report-loop` resumes giving a
   real verdict, now entirely on new-identity data. Old-identity events remain
   on disk (never deleted) but are permanently excluded from the window once a
   newer identity is stamped.

---

## 7. Risks / interactions

- **budget-inject induces premature-termination.** Told "you have ~600s," an
  agent might bail early and score 0 when it would have passed at 601s.
  *Mitigation:* make the hint **advisory** ("budget it / prefer simpler"), never
  a hard "stop at N"; keep the real wall unchanged so a run that finishes at
  610s still gets its full window. Watch the `premature-termination` vs
  `resource-limit` mix in diagnoses after rollout — a spike in the former is the
  tell.
- **budget-inject as a gameable metric — it isn't, against true fitness.** The
  gate's reward is the **verifier** (`cmd-run.ts:242`, ground-truth tests), not
  the agent's self-report (self-score is transported but never gates —
  `cmd-run.ts:246`, self-score.ts). A budget hint cannot fake a pass; worst case
  it converts a timeout-fail into an early-give-up-fail (same `reward=0`). The
  only genuine gaming surface — self-score — does not gate, so budget-inject is
  safe.
- **re-baseline cost.** Re-scoring the active version is a full extra
  pass over the task set. *Mitigation:* trigger it **only** on a budget-identity
  change (rare — a deliberate `--max-agent-timeout` bump or the one-time
  recording-policy flip), not per generation; reuse the incoming candidate's
  arm A as the re-scored active where possible (no extra run).
- **Pass-rate denominator shift.** Recording timeouts as fails lowers persisted
  pass-rates (a task that always times out now counts against the layer). This
  is *more* accurate, but it means the §4 rollout is itself a re-baseline
  trigger (§6.2 item 2) — sequence the two together.
- **score.json back-compat.** Additive-optional (`elapsed?`, `timedOut?`),
  absent ⇒ unknown/false, no `schemaVersion` bump — identical to how `platform?`
  / `judge?` were added (`harness-store.ts:129, :132`). Old records keep
  parsing; new readers must not assume the fields exist.
- **Two-timeouts conflation.** Keep the bench **wall** (budget-inject / this
  doc) distinct from the plugin **bash-tool** timeout (`agent-config.json`
  `fastTimeoutMs`, `propose.ts:693`). The proposer note (§4.4) should name the
  wall explicitly so a `resource-limit` diagnosis doesn't misfire the
  bash-tool knob.
- **Trajectory-less diagnosis.** A timeout has `events: []`, so
  `buildFailureExcerpts` (`harness-store.ts:421`) has nothing to index. The
  proposer diagnoses from the score line + elapsed/budget only. Acceptable for
  v1; §8 lists partial-trajectory capture as the follow-up.

---

## 8. Proposed task breakdown (for the future `plans/` doc)

Rough tasks, TDD-decomposable later. Order matters: T1→T2→T3 is the minimal
proposer-visible slice; T4/T5 make it actionable; T6/T7 keep it honest.

1. **T1 — plumb the discriminator.** Add `timedOut?` (+ optional
   `agentElapsedSec?`) to `AgentRunOutput` (`drivers/types.ts`); set it in
   `runAgent`'s timeout branch (`agent-run.ts:183`). Unit: a timed-out
   `ExecResult` yields `timedOut:true`; auth/normal yield unset.
2. **T2 — carry through run-task.** Add `timedOut` to `RunTaskResult`; split the
   `error` union `"timeout"` vs `"agent_no_output"` (`cmd-run.ts:53, :258`).
3. **T3 — record timeouts.** Add `elapsed`+`timedOut` to `SessionRecord`
   (`harness-store.ts:112`); extend `sessionRecord` (`record.ts:249`); change the
   `recordToStores` guard to `turnCount === 0 && !timedOut`
   (`record.ts:299`); mirror in `cmd-ab.ts:330`. Test: a timeout writes a
   `passed:false, turns:0, timedOut:true` record; an auth-fail still writes
   nothing. Assert old records without the fields still parse.
4. **T4 — surface + diagnose.** Timeout marker in `buildProposerContext`
   (`harness-store.ts:1333`) and a "timed-out sessions" note in
   `buildProposerPrompt` steering `resource-limit` + the existing timeout ops
   (`propose.ts:65, :697, :727`).
5. **T5 — budget-inject.** Advisory budget line from `agentTimeout` into the
   instruction in `runAgent` (`agent-run.ts:155`). Test: line present, value =
   `agentTimeout`, identical across both `ab` arms.
6. **T6 — budget provenance + re-baseline gate.** Stamp `maxAgentTimeout` (+
   `timeoutRecording`) into `ab-verdict.json` (`cmd-ab.ts` verdictDict) and
   `writeRunResults` (`results.ts:138`); add the activation-time budget-identity
   check (§6.2).
7. **T7 — re-baseline trigger in the loop ledger.** Reset/re-score the
   `report-loop` baseline (`report-loop.ts:63, :118-128`) on a budget-identity
   change; document the operator step in the loop runbook.

---

## 9. Deferred / out of scope

- **Partial-trajectory capture on timeout.** `runAgent` discards `events` on the
  wall (`agent-run.ts:183`); recovering the NDJSON emitted before the kill would
  give the proposer a real trajectory to diagnose (where did the agent get
  stuck?). Higher value but higher effort — separate increment.
- **Latency as a first-class selection signal.** Now that `elapsed` is
  persisted, a future gate could prefer a faster candidate on a tie (today the
  gate is binary reward — `ab-stats.ts`/`abDecision`). Out of scope: this doc
  only makes latency *visible*, not *selective*.
- **Auto-tuning the wall.** Automatically raising `--max-agent-timeout` per task
  based on observed `elapsed` distributions. Requires the re-baseline machinery
  (§6) as a prerequisite; defer until timeout signal has accumulated.
- **Plugin bash-tool timeout (`fastTimeoutMs`) evolution.** Already supported
  (`propose.ts:693`) and project-layer-scoped; this doc deliberately does not
  touch it beyond keeping it distinct from the wall.

---

## Open questions for the human (settle before this becomes a plan)

1. **Budget-inject placement & wording.** Into `instruction.md` (bench-symmetric,
   proposed here) vs. into the composed `AGENTS.md` harness? The instruction
   keeps it a controlled constant; the harness would make it evolvable but risks
   asymmetry between arms. Confirm the instruction placement.
2. **Re-baseline trigger authority — SETTLED (T7, this doc's §6.3): MANUAL.**
   The operator performs the re-score + continues the loop as a deliberate
   step; `report-loop.ts`'s budget-identity segmentation is what makes that
   step actually take effect on the ledger, but it never auto-fires a re-score
   itself. Automatic re-baseline remains out of scope (see §9 "Auto-tuning the
   wall", which explicitly depends on this machinery as a prerequisite).
3. **Timeout-recording rollout sequencing — SETTLED: land T3 behind the
   `recordTimeouts` flag (default OFF, done) and treat flipping it ON as one
   deliberate cutover, sequenced together with the first manual re-baseline
   (§6.3) — not a separate re-baseline per flip.**
