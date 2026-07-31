# kkamak §4.3 trial mode — completion-gate-outcome trials, pre-registration (2026-07-29)

**Status:** REGISTERED (pre-data, 2026-07-29) — decision rules locked before any trial data exists.
**Purpose:** replace the workload-confounded, sequential trial mode (`resolveTrial`,
`opencode-plugin/src/harness-store.ts:1252-1383`) with an interleaved,
completion-gate-outcome-scored trial mode for provisional playbook candidates, and
retire the km-crank deadlock the sequential design causes today (`km-crank/src/crank.ts:171-192`,
`km-crank/src/gate.ts:68-83`, skip-trial early return). This is daily-evolution-loop
stage §4.3. It reuses the sensor taxonomy and metric definitions already registered in
the scorecard pre-registration (`docs/superpowers/specs/2026-07-28-kkamak-scorecard-preregistration.md`)
and partitions them by trial arm instead of by `(check, host)` group.

**Genesis, for future audit:** designed by two lenses — a minimal-buildable pass and an
adversarial-integrity pass — with four resulting conflicts resolved by user ratification
on 2026-07-29 (the decisions are codified in §1, §4, §5, and §6 below, at the point each
applies), then carried through three adversarial architect-review iterations: iteration 1
raised 16 findings (2 BLOCKER), iteration 2 raised 5 second-order findings (1 BLOCKER),
iteration 3 raised 3 cross-reference residuals. All findings from all three iterations are
resolved in this revision.

## 0. The question this trial mode does and does not answer

It answers: **did this provisional candidate make the completion gate less wrong or less
annoying than baseline, over the same interleaved workload?**

It does NOT answer:

- **kkamak's value.** That needs a counterfactual — what the agent would have shipped
  with no completion gate at all — which the sensor cannot observe (scorecard pre-reg §0).
- **Candidate correctness.** A completion-gate accept is **self-verified, never correct**
  (L4, `docs/2026-07-27-probe-grip-fix-design.md:144-151`): the completion gate never sees
  the grader (invariant 1, same doc, threat notes `:127-137`). Every metric in this design
  scores completion-gate **shape** — exhaustion, catch/clean split, interruption — never
  accept rate itself. The false-accept consumption discipline in §4 exists precisely
  because accept-derived counts are not ground truth.

## 1. Scope

Both the mechanism class (bespoke, §4b-style pre-registrations, one experiment at a time —
e.g. the reinject-wording trial already running, scorecard pre-reg §4b) and the playbook
class (general prose candidates competing at a shared layer) are in scope for this design.
**User-ratified decision 1 (2026-07-29): v0 is BUILT for the playbook class only.**
Mechanism-class candidates keep using bespoke pre-registrations like §4b until a second
registration extends this machinery to them. v0 build = playbook prose candidates at the
**project-global** layer, Claude Code sessions only (opencode-session arms are §10).

**One live trial, enforced two ways.** Per-layer, the existing `readTrial` guard
(`opencode-plugin/src/harness-store.ts:1241-1245`) mechanically prevents a second trial
from clobbering a layer that already has one live — this is unchanged from today's
trial-clobber protection (`km-crank/src/gate.ts:68-83`). Across repos and hosts, there is
no equivalent lock in v0: **global singleness is a declared operational convention, not a
mechanism.** Trial START is human-go (ratified decision 2, below); the human starting a
trial is the lock — do not start a second trial anywhere while one is live. Cross-host
trial start is forbidden by the same convention: **office host only in v0.** A mechanical
cross-repo/cross-host lock is registered as v1 work (§10). `REPOS` today is
`["~/z2/meta-harness", "~/z2/squad", "~/z2/km-play"]` (`km-crank/src/crank.ts:59`) — the
set this convention must hold over.

## 2. Unit of analysis and exposure

**Unit = one sensor cycle**, classified by the scorecard taxonomy (`interrupted` /
`exhausted` / `catch` / `clean` / gauge-only; `accepted` true on both `catch` and
`exhausted`, scorecard pre-reg §1; `SensorLine` schema, `cc-gate-plugin/src/types.ts:101-118`)
— unchanged. One sensor truth worth restating because §9's exposure guard leans on it: a
mid-cycle block writes **no** sensor line — `handleStop`'s `"block"` branch returns only
`{state, decision}`, with no `sensor` field (`cc-gate-plugin/src/core/stop.ts:112-119`,
contrast the `"accepted"`/exhausted branches at `:80-98` and `:122-142`, which both build
one via `buildSensorLine`). A cycle produces exactly one line, at resolution — never one
per round. What §4.3 adds is an **inner join** of that cycle stream on
`(sessionID, trialId)` against a new exposure log,
`.km/trial-arms.ndjson`, one row per session:
`{ts, sessionID, trialId, layer, arm, forced}`, appended at the SessionStart injection
seam (`opencode-plugin/src/adapters/claude-code/dispatch.ts:12,152-168`: SessionStart →
`composeInjection` → `additionalContext`).

**Dedupe and boundary handling.** The appender checks for **any** existing row for this
`sessionID` — under any `trialId` — before writing a new one. Exact-composite-key dedupe
alone (same `sessionID` + same `trialId`) is not enough: a resumed session would be
silently re-enrolled into a *later* trial under a fresh key, even though its harness text
was composed under an earlier one. A session whose first SessionStart predates the live
trial (it already has a row under an earlier `trialId`, or it resumes across a trial
boundary) is enrolled in **no new trial**, and its post-boundary sensor lines are **VOID
for both trials** — the same void-class treatment already applied to 0-turn/auth-race
sessions (resume.md resume-gotcha precedent). Its injected text may no longer match its
recorded arm, so counting it anywhere would be silently wrong, not just noisy.
Additionally, every trial's join is **time-bounded**: only sensor lines with `ts` inside
that trial's `[start, resolution]` window count toward it, regardless of session identity.

**Exclusions** from every §4.3 metric: gauge-only lines (`rounds: []`, fabricated on a
fast-path Stop); forced arms — `KKAMAK_TRIAL_ARM` overrides are recorded in the exposure
log with `forced:true` and are never compared, and because the join enforces this from the
exposure record itself (not from a sensor-side flag), exclusion here is mechanically
enforced, unlike the reinject experiment's sensor-only gap (`reinject.ts:44-51`, forced
runs recorded but excluded only by convention at analysis time); sensor lines with no
matching exposure record at all; and the kkamak-dev check group (this repo's own check,
scorecard pre-reg §3 — the workload here is editing the completion gate itself, the exact
confound this design exists to avoid). Pooling across the remaining `(check, host)` groups
is explicit opt-in and must be stated in any verdict, with the per-group breakdown printed
beside the pooled number (scorecard pre-reg §3/§4 convention, `score.ts`'s `pool` option).

**PRE-DATA AMENDMENT (2026-07-30, fix-them-serialized-teacup plan Task 1; no trial data
exists yet, §4.3 has never enrolled a real session):** a new sensor line class,
`skipped-stop` (`SensorLine.skippedStop`, `cc-gate-plugin/src/types.ts`), is registered as
excluded from every §4.3 metric AND from the §9 exposure-density guard — a stronger
exclusion than gauge-only's, which is density-INCLUDED. `skipped-stop` marks a user prompt
that arrived while edits were unmeasured (`edited:true, gating:false`), fabricated at the
prompt path — most commonly a queued prompt eating the Stop boundary (the live dogfood
finding this amendment codifies: an 8-commit kernel build on the installed plugin produced
**zero** sensor cycles, because every prompt in that session queued past an open Stop
boundary and the boundary loss went entirely unrecorded before this fix). This class gets
its OWN rationale, not §9's gauge-only one ("witness a Stop the gate never armed for") —
that rationale does not hold here, because a skipped-stop line means the gate WAS armed;
the boundary was lost, not absent. The reason for excluding it from density specifically is
a **false-void risk**: repeated queued prompts within one open turn each emit their own
`skipped-stop` line (the field counts unmeasured-boundary EVENTS, not distinct sessions or
distinct skipped Stops), so a habit difference in how often either arm's sessions queue
prompts could inflate that arm's line-per-session density arbitrarily and trip the §9
`DENSITY_DIVERGENCE_FACTOR` guard on pure prompting-style noise, voiding a trial for a
reason unrelated to either arm's candidate text. Excluding `skipped-stop` from density
(alongside metrics) removes that failure mode entirely, at the cost of the class carrying
no exposure-guard signal of its own — an accepted trade given it is a diagnostic/instrument
line, not a workload-shape observation. `km-crank/src/trial-verdict.ts`'s join
(`joinAndExclude`) implements this as join rule 7, alongside the existing 6.

**PRE-DATA AMENDMENT (2026-07-31, roadmap Phase 3.1 draft; no trial data exists yet,
§4.3 has never enrolled a real session — A/A earliest ~08-12):** a new sensor line class,
`prompt-check` (`SensorLine.promptCheck?: true`), is registered as excluded from every
§4.3 metric AND from the §9 exposure-density guard — the same double exclusion as
`skipped-stop`, for partly different reasons. The class recovers *measurement* from the
boundary-loss events `skipped-stop` can only *count*: when a user prompt arrives with
edits unmeasured (`edited:true, gating:false` at UserPromptSubmit — the skipped-stop
trigger), the hook additionally spawns the repo's check **detached** (double-fork, the
`maybeSpawnGauge` pattern at the same hook, `hook-cli.ts:256-271`; emission at the
hook-cli seam ONLY, F1). A synchronous in-hook run is prohibited: it would delay every
queued prompt by up to `checkTimeoutMs`. When the detached check completes it fabricates
one `prompt-check` line carrying its result. Registered relationship to `skipped-stop`
at the same trigger: **accompany, never replace** — the `skipped-stop` line is emitted
at trigger time exactly as today (its shape unchanged), because the boundary-loss
diagnostic must survive even when the detached spawn dies unobserved; the `prompt-check`
line is a second, later line for the same event, joinable by `sessionID` plus the spawn
timestamp it stamps. Three registered exclusion rationales: (1) **wrong quantity** — the
check runs mid-turn against whatever half-finished state the agent left at the boundary,
not the agent's own Stop-boundary claim of done; scoring it in §4.3 metrics would mix
two different measurands under one `accepted` label; (2) **false-void density risk** —
line count scales with per-session prompting habit exactly as `skipped-stop` does, so
density inclusion re-opens the §9 `DENSITY_DIVERGENCE_FACTOR` noise-void this spec's
fourth amendment closed; (3) **no actuator exposure** — the line is fabricated; the
completion gate never delivered evidence to the agent at that boundary, so the line says
nothing about either arm's candidate text in action. Implementation pins, binding on the
build: `classifyCycle` (`cc-gate-plugin/src/score.ts:29-30`) must test `promptCheck`
immediately after `skippedStop` and BEFORE the empty-rounds `gauge-only` branch — a
`prompt-check` line also carries `rounds: []`, and the gauge-only class is
density-INCLUDED, so misordering silently converts the exclusion into inclusion (the
exact swallow the skipped-stop review caught, `score.ts:21-27`); `joinAndExclude`
(`km-crank/src/trial-verdict.ts`) excludes it as join rule 8; `newLineCount`
(`km-crank/src/scan.ts:121-125`) discounts `prompt-check` lines alongside `skipped-stop`
so the crank volume threshold cannot be inflated by prompting habit. Purpose of the
class, registered so it cannot drift: proposer evidence density (the ~1/3 of day-1
boundaries queued prompts destroyed: 13 skipped-stop vs 25 cycles, GA5) — never trial
metrics.

## 3. Assignment

`arm = (FNV-1a(`${trialId}:${sessionID}`) >>> 16) & 1`. **The trial ID is a required
salt.** Hashing `sessionID` alone would make this trial's arm assignment collinear with
the live reinject experiment's arm assignment (`hash(sessionID) % 2`, `reinject.ts:29-51`)
— every session would land in the same arm on both axes, so a real effect on one axis
could be mistaken for the other's. Every verdict reports the reinject-arm composition
(v0/v1 split) of each trial arm as a balance check; a skewed split is a warning sign, not
by itself a void. Arm assignment is constant for the life of a session, same rationale as
reinject's per-session stability (`reinject.ts:39-42`).

**PRE-DATA AMENDMENT (2026-07-29, build TM2; zero exposure rows existed):** as
originally registered this read `… % 2`. That formula is algebraically broken for its
own stated purpose: FNV-1a's low bit is a linear XOR-parity of the input's character
low bits (the multiply by an odd constant preserves parity), so for any FIXED
`trialId`, `hash(trialId:sid) % 2` agrees with the reinject axis `hash(sid) % 2` at
exactly 0% or 100% across ALL sessions — perfect (anti-)collinearity within every
real trial, the precise failure §3 exists to prevent. Found by the build's named
salt-decorrelation test (§11 item 10) during TM2; verified algebraically and
empirically (per-trialId agreement 500/500 or 0/500; bit-16 formula ~50% with
balanced splits). Remedy: take bit 16 (a carry-mixed, non-parity-linear bit) instead
of bit 0. The reinject axis (`% 2`) is deployed and UNCHANGED. Lineage: same
pre-data-amendment ceremony as the GA3 build-review amendment.

The baseline arm is composed from the `TrialState` snapshot taken at trial start — the
fields already captured there (`baselineSystem`, `baselineTools`, `baselinePlaybook`,
`baselineAgentConfig`, `baselineEnvPolicy`, `harness-store.ts:1267-1277`) are verified
sufficient to reconstruct it. **Named build gap:** `composeHarness`
(`opencode-plugin/src/compose.ts:59`, called from `engine.ts:343`) has no
baseline-snapshot parameter today — it always composes the *current* active layers. Giving
it an arm-aware, snapshot-based path is a prerequisite build item (§11 item 1).

**Contamination limitation, registered.** Both arms share one engram/CLAUDE.md memory
store; anything the treatment teaches the agent can leak into the control arm's sessions
mid-trial. This dilutes any real effect **toward a tie** — it can only make a genuine win
look smaller or null, never manufacture one. The event floor (`E_MIN`, §5) and the FA
guards (§4) exist in part to keep a diluted, noisy comparison from producing a false KEEP
on vacuously few events.

**N_eff reporting.** Every verdict reports, per arm: cycle count, session count, and
session-count with ≥1 completion-gate cycle (the quantity the session floor in §5 checks
against) — three different denominators, printed separately so a thin arm cannot hide
behind a healthier-looking one.

## 4. Metrics

Reuses the scorecard's metric definitions (`M-catch`, `M-exhaust`, `M-interrupt`,
`M-tax`, `M-rounds`; scorecard pre-reg §2), computed per trial arm instead of per
`(check, host)` group.

**Primary (both must not worsen; a fall is a win):** `M-exhaust` and `M-interrupt`.
**Guard (must not worsen):** `M-catch(T) ≥ M-catch(B)`.

**Named trade-off.** A genuine first-try-correctness improvement — fewer cycles need a
fix round at all, so some cycles shift from `catch` to `clean` — is **sensor-identical**
to round-0 false-accept gaming, where the completion gate is fooled into accepting on the
first round instead of catching something it should have caught (also a catch→clean
shift). The sensor cannot distinguish the two by construction. The decision rule (§5)
therefore computes ROLLBACK on both, deliberately: this design prefers a **false
rollback** — reversible, and the candidate remains re-proposable with supporting bench
evidence — over a **false keep**, which would adopt false-accept gaming as if it were a
real improvement. A second, separate asymmetry is accepted alongside it: the guard has no
visibility into round-≥1 superficial fixes (a fix that satisfies the check without fixing
the underlying problem) — that failure mode is invisible to `M-catch` and is not claimed
to be caught here.

**Report-only, never a decision input:** `M-rounds` (a collider — it is shaped by both
completion-gate strictness and workload difficulty, so it cannot be attributed) and
`M-tax` (human-approval wait contaminates `durationMs`, scorecard pre-reg §2).

**Never consumable as reward, under any framing:** accept rate, clean rate, `M-catch`
alone (only as a non-worsening guard, never as a target to maximize), `M-rounds`, gauge
fields (tripwire-only, never reward), `/mh-score` rate, and kkamak-dev cycles.

**False-accept (FA) consumption — four rules, no numeric discount:**

1. A committed calibration registry, `{rate: 2/19 ≈ 10.5%, wilson95CI: [3%, 31%],
   coveredMechanismRev, date}` — the **cross-host pooled, not independently certified**
   false-accept rate measured across C2+C1+G1 (`minimal/HISTORY.md:175-246`, "CLOSED BY
   MATH", `:240`; the wide Wilson interval is the honest reflection of that). **Staleness
   is computed, not attested:** `stale := (git log -1 --format=%H -- <probe +
   completion-gate mechanism paths>) ≠ coveredMechanismRev`. This is a **path-scoped**
   last-modifying commit — never repo `HEAD` — because `HEAD` moves on every unrelated
   docs commit, which would make verdicts perpetually refused. The verdict engine (§6)
   checks this on every run; verdicts are refused while stale.
   **PRE-DATA AMENDMENT (2026-07-29, build TM6 review; no verdict has ever been
   enacted): refusal is time-bounded by §5's `T_MAX` — staleness persisting at
   `now − startedAt ≥ T_MAX` abandons the live trial (reason
   `"calibration-stale"`, §5 abandon list), so a permanently stale registry
   cannot hold the single trial slot unboundedly. (Found at TM6 review: the
   as-planned unconditional refusal, placed before the T_MAX check, converted
   §5's bounded slot into an unbounded one.)**
   **PRE-DATA ADDENDUM (2026-07-29, build TM5; no verdict has ever consumed this
   registry):** the 2/19 rate was measured with the mutation probe active in BOTH
   FA1 arms (ON arm additionally ran spec-coverage + relations); the SHIPPED daily
   gate (cc-gate-plugin `round.ts`, `mutants: 0`, no FA probes) is strictly weaker
   than either measured arm. The registered rate is therefore a **lower-bound
   proxy** for the daily mechanism's false-accept rate, not a point estimate of
   it. Consumers of rule 2's minimum-effect floor MUST treat it as a lower bound
   (a floor computed from it is itself a minimum); wiring any probe into the
   daily gate is a mechanism change that already triggers the registered fresh-
   calibration-arm cadence, which is also the path to replacing this proxy with
   a shipped-mechanism measurement. Numbers unchanged; this records what they
   cover. (Found at TM5 build review, escalated before first consumption.)
2. A **minimum-effect floor**: an arm-to-arm difference in accept-derived counts smaller
   than what ~10% misclassification could itself generate is not claimable as a candidate
   effect — it is within the noise the FA rate already predicts.
3. **FA-relevance triage at registration (ratified decision 3).** A candidate whose
   mechanism could plausibly move the false-accept rate (e.g. touches check-authoring
   guidance, verification strength, acceptance criteria) is **refused in v0** — not
   trialed at all. Default on doubt is FA-relevant (refuse). This keeps v0 scoped to
   candidates whose effect on completion-gate shape cannot be confused with an effect on
   completion-gate correctness.
4. **No numeric discount.** The calibration rate informs the floor in rule 2 and the
   triage in rule 3; it is never subtracted from a metric or folded into a score.

**Calibration cadence.** The registry must be refreshed by a fresh calibration arm every 2
consumed KEEPs, or every 60 days while a trial is active, whichever comes first — the same
recheck discipline already registered for the probes themselves: every mechanism change to
any probe (mutation, spec-coverage, relation) triggers a fresh calibration arm before this
design may consume its outcomes (`probe-grip-fix-design.md:247-250`).
**Cadence-collision rule:** if a calibration refresh and a golden-baseline window (§5) are
both due at the same KEEP (e.g. the 6th KEEP, which is both the 3rd every-2 calibration
point and the 2nd every-3 golden point), calibration runs **first** — verdicts are refused
while stale regardless, so running it first costs nothing — and the golden window follows.

## 5. Decision rule

**Fixed-N, counts-only** (`docs/explicitly-not-now.md` §7.5 stands: sequential/SPRT
stopping stays deferred until a pre-registered boundaries spec exists). No alpha
arithmetic anywhere in this design.

**Where this is evaluated.** A new `resolveGateTrial` is called from `crank.ts`
**before** `decideGate`'s trial-clobber check, on every crank invocation. Only if no
KEEP/ROLLBACK/T_MAX fires this round does `decideGate` see `trialInProgress` and skip
proposing (unchanged skip-trial path, `gate.ts:68-83,80`). This is what un-deadlocks
km-crank: resolution now fires on every scheduled run — not only on `/mh-score`, which may
not fire for days in daily CC use — and `T_MAX = 28d` bounds how long any one trial can
occupy the slot.

**Acceptance criterion — the trial scan is independent of propose-target selection.**
`crank.ts` checks `readTrial` across **all** `REPOS`' project-global layers first, and
calls `resolveGateTrial` on whichever layer holds a live trial (at most one, by
convention), **regardless of which repo wins that round's new-line-volume contest**. Today
`crank.ts` only computes `layer.root` for the volume-winning target
(`crank.ts:160-164`); unmodified, a live trial sitting in a non-winning repo would never
be evaluated at all. `T_MAX` and the abandon backstops (below) apply to whichever layer
holds the live trial, independent of that round's winner.

**Verdict is read at the first evaluation where all three floors are met:**

- both arms ≥ `MIN_N = 20` **gateCycles** (`clean + catch + exhausted`; since
  `allCycles ≥ gateCycles`, this floor also covers `M-interrupt`'s wider denominator) —
  and if any metric is still null at this point, the verdict is **DEFERRED**, never
  coerced to 0;
- AND ≥ 5 sessions-with-≥1-completion-gate-cycle per arm;
- AND pooled block-class events — `catch + exhausted + interrupted`, summed across both
  arms — ≥ `E_MIN = 5`.

`E_MIN` is a deliberate asymmetry against the scorecard's §4b mechanism-experiment rule,
which has no equivalent floor: prose is not adopted on zero events here, because zero
events is unfalsified bloat, not evidence.

**Rule:** KEEP iff `M-exhaust(T) ≤ M-exhaust(B)` AND `M-interrupt(T) ≤ M-interrupt(B)` AND
`M-catch(T) ≥ M-catch(B)`; otherwise ROLLBACK. A null result (the floors are met but the
inequalities do not hold) is a real result, not a failure to decide — same precedent as
loop-1's provable null. `T_MAX = 28d` without meeting the floors → ROLLBACK, logged as
`"insufficient-events"`.

**Trial ledger.** Not a new file: the existing `event:"trial"` rows in `meta-metrics.jsonl`
(`harness-store.ts:744`, the same sink `startTrial`/`resolveTrial` already write to,
`:1280,1350,1368,1378`) gain new `action` values — `"keep"`, `"rollback"`,
`"insufficient-events"`, `"deferred"`, `"abandoned"`. This is a query convention over one
stream, not a schema migration. It is distinct from the review-gate rejected ledger
(`rejected.json` per layer, `harness-store.ts:1791`, a permanent proposer-prompt input): a
§4.3 ROLLBACK does not write a rejected-ledger entry, so the candidate remains
re-proposable. The rejected ledger's own rule — no retest without new observations —
governs only entries that actually land there, via the review gate.

**Abandon** (clears the trial without a KEEP/ROLLBACK verdict): the active version changed
under the trial (manual `activate`, same precedent as today's abandon path,
`resolveTrial`, `harness-store.ts:1317-1320`); the calibration registry goes stale
mid-trial; or a manual command supersedes (§6).

**PRE-DATA AMENDMENT (2026-07-29, TM6 review; no verdict has ever been enacted) —
two clarifications, found at the first code that routes these paths:**
1. **Stale-abandon trigger.** While the registry is stale and
   `now − startedAt < T_MAX`, the engine refuses verdicts (§4 rule 1): pending,
   nothing enacted, recalibration un-blocks it. If staleness persists at
   `≥ T_MAX`, the trial is **abandoned** with reason `"calibration-stale"` — not
   rollback `"insufficient-events"`, which would misname the cause; like every
   abandon, no rejected-ledger entry, candidate re-proposable. Immediate
   abandon-on-first-stale was rejected (any mechanism-path commit would destroy
   a healthy trial that a recalibration arm could have resumed); unbounded
   refusal was rejected (defeats this section's T_MAX slot bound). This gives
   §4's refusal and this list's "goes stale mid-trial" clause one coherent,
   bounded mechanization.
2. **Abandon restores the baseline.** An abandon enacted while the trial
   candidate is still the active version restores the recorded baseline (the
   same `writeActive` path as ROLLBACK). Abandon-without-restore would leave an
   unvalidated candidate silently adopted — a false-keep-shaped default that §4's
   "prefers a false rollback over a false keep" posture forbids. When the active
   version has already changed (manual `activate` / supersede), there is nothing
   to restore and clear-only stands, as today.

**Adoption semantics.** Across the null-adopt path, roughly 60% of KEEPs are expected to
be "not measurably worse" ties rather than measured improvements — KEEP means exactly
that, **never** "better." No ledger entry may cite a KEEP as lift evidence. **Post-adoption
rollback trigger:** if a guard breach (`M-catch` regression) shows up at the *next*
`MIN_N` window after a KEEP, the incumbent is rolled back then, not silently kept.

**Golden-baseline anti-ratchet (ratified decision 4).** Every 3rd KEEP mechanically
**queues** a golden window. Starting it still requires an explicit human go — per ratified
decision 2 (trial START is human-go in v0; only the *queueing* is mechanical) — and no new
real-candidate trial may start while a golden window is queued. A golden window is the
same trial machinery with its own `trialId`/salt/exposure rows: arms are the current
incumbent (as "trial") vs. a frozen golden snapshot (as "baseline"), evaluated under the
identical `MIN_N`/`E_MIN`/session-floor/`T_MAX` rule above. It occupies the single live-
trial slot and can block proposing for up to 28 days — a bounded, accepted cost, stated
here explicitly. Rule: KEEP the incumbent iff the same 3-clause rule holds against golden;
otherwise ROLLBACK TO GOLDEN and flag for review. If a golden window hits `T_MAX` without
meeting the floors, the incumbent is kept (status quo bias, not golden), a ledger entry is
written, and the golden check is re-queued after the next KEEP rather than retried
immediately.

**Rejected ledger:** no retest without new observations (unchanged review-gate rule,
carried here by reference — §4.3 does not relax it).

## 6. Engine and authority

**New module, `km-crank/src/trial-verdict.ts`:** owns the `(sessionID, trialId)` join,
the exclusion rules (§2), the decision rule (§5), a futility projection (days-to-floors at
the current event rate, for the SITREP), and new `SitrepAction` kinds for trial
transitions (following the existing union's pattern, `km-crank/src/sitrep.ts:25-33`).
Per-arm scoring reuses the scorecard's exported `scoreLines`
(`cc-gate-plugin/src/score.ts:86`, called once per arm-filtered subset with `pool: true`
so each arm collapses to one bucket); `scoreGroup` stays unexported (`score.ts:132`) — the
`(sessionID, trialId)` join and arm filtering live entirely in `trial-verdict.ts`, upstream
of `scoreLines`.

**New authority entry point:** `resolveGateTrial`, exported from `harness-store.ts`,
reusing the existing `writeActive` / `clearTrial` / `appendMetaMetric` primitives that
`resolveTrial` already uses. `TrialState` gains `rewardMode: "gate-outcomes"` to mark a
trial as §4.3-governed.

**Acceptance criterion — stand-down guard.** The **old** `resolveTrial`
(`harness-store.ts:1312-1383`) must return `{action: "none"}` as its **very first branch**
whenever `rewardMode === "gate-outcomes"`, before any score read. `resolveTrial` fires on
**every** `/mh-score` call (`engine.ts:603-611`) — far more often than a crank round — so
an underspecified guard here would be a silent confirm/revert race that bypasses the
entire §4.3 decision rule from a completely different code path. Abandon-on-active-changed
for gate-outcomes trials is handled inside `resolveGateTrial` (§5), not the old path.

**Three adopter domains, named explicitly** so no future reader conflates them:
`minimal/gate.ts` (bench-only, unchanged by this design); the §4b scorecard-informed
mechanism rule (human reads the scorecard, human edits the wording — mechanism wording
stays human-executed); and the §4.3 engine itself (playbook keep/rollback — **auto with
post-hoc veto**, ratified decision 2: every KEEP/ROLLBACK/abandon transition posts a
SITREP, and a manual command always supersedes the automatic verdict).

This third domain is a scoped **amendment** to the scorecard pre-reg's own §5 sentence
that "`gate.ts` remains the sole adopter" — that sentence still holds for the mechanism
class and for `minimal/gate.ts`'s bench track, but the §4.3 engine is now a second,
narrower automatic adopter for the playbook class specifically. This is registered inline,
the same way the scorecard pre-reg itself carries a pre-data correction without a rewrite
(scorecard pre-reg §4b, correction lineage, `:86-92`) — a stated amendment, not a silent
supersession.

`km-panic.sh` today has no trial-aware verb (`scripts/km-panic.sh`: `status` /
`gauge-off` / `off` / `restore` / `nuke`) — disabling the completion gate
(`km-panic.sh off`) stops sensor production, but trial text keeps injecting, because
`composeInjection`
(`engine.ts:337`) is independent of `gate.json`. §11 item 9 adds a `km-panic.sh trial-off`
verb that reverts to the baseline snapshot, matching the veto's intent. Auto trial-**start**
is explicitly v1, blocked on closing km-crank's legacy-mode review-gate bypass first
(docs/resume.md (km-crank "legacy-mode proposals bypass the review gate" WATCH-ITEM)) —
v0 keeps trial start human-go (docs/resume.md ("fully-automatic-with-veto" §4.3 note)).

## 7. Two-host union

Committed snapshots live at `evidence/kkamak-sensors/<host>/<repo>.{gate-outcomes,
trial-arms}.ndjson`. A **new** snapshot script is written for this sensor+exposure ndjson
class — `term-bench2/store-sync.sh` is TB2-store-shaped and stays untouched — following
the same surgical, diff-first, no-blind-export discipline this repo already requires for
shareable artifacts (CLAUDE.md). Sync is **manual in v0** (automated cross-host sync is
§10). Because arm assignment is deterministic (§3), partial host coverage at any given
snapshot time is unbiased — a union of partial snapshots buys additional `N`, it does not
skew the split. Every verdict's SITREP prints per-host coverage and snapshot age so a
stale or one-host-only read is visible, not silently treated as complete.

## 8. Activation precondition

No trial may start until the trailing-14-day pooled **real-work** completion-gate cycle
rate is ≥ 10/day. **Today the real-work stream is empty:** 19 sensor lines exist total,
all kkamak-dev, 0 block-class events (`minimal/HISTORY.md`, FA1 pooled count). This design
carries no live real-work sessions to observe yet either — both live sessions recorded so
far are this repo's own kkamak-dev stream (`.km/gate-outcomes.ndjson`, host-local,
gitignored) and both happened to land in the same reinject arm (`v1`), a small-sample
illustration of exactly why §3's per-arm balance check exists rather than an assumption.
The verdict CLI prints projected days-to-threshold at the current trailing rate; the two
multipliers expected to move it are squad dogfooding and the MacBook install.

**Honest projections fold in the sequencing cost this design itself imposes**, not just
the activation wait: the time to a first real KEEP/ROLLBACK is approximately the
activation-precondition wait, **plus** one A/A accrual window (§9 — the falsification
trial runs first, before any real candidate), **plus** one real-candidate accrual window;
every 3rd subsequent KEEP adds one more golden-window accrual (≤28 days each, §5). At
plausible post-multiplier rates, cycle-level metrics (`M-exhaust`, `M-interrupt`) are
expected in 2–6 weeks; block-class-event floors (`E_MIN`) take months at current rates;
candidates whose effect is keyed to a rare event class should be **refused as futile**
rather than trialed, by the same reasoning as the false-accept futility call in
`probe-grip-fix-design.md §6.3`.

## 9. Gaming guards and design falsification

**Exposure guard:** completion-gate cycle density per session, per arm — gauge-only lines
witness a Stop the completion gate never armed for, so they are the tripwire for
divergence, not a metric input. A gross density divergence between arms is VOID for that
trial, not silently pooled through.

**Check-string pin:** the `check` string (`gate.json`) is pinned at trial registration; if
it changes mid-trial, that trial is VOID from the change point.

**Check-strength audit:** an assertion-count delta over the trial window (GA1 precedent —
the same kind of drift watch already exercised there) is mandatory before any KEEP — a
check that quietly weakened during the trial window would manufacture a `catch`→`clean`
shift indistinguishable from a real improvement (§4's named trade-off, again).

**Sensor integrity** rests on assumption A0: a trusted single operator per host (no
adversarial tampering with the sensor stream itself) — consistent with the scorecard
pre-reg's own single-user framing (§4, Power). This design does not add protection against
a hostile operator; it only guards against gaming *within* the trusted-operator model
(check weakening, false-accept gaming, exposure divergence).

**Interrupt-narration softspot:** `interrupted` cycles carry no record of *why* the human
stopped the session — annoyance and unrelated context switches are indistinguishable in
the sensor. This is flagged, not fixed, and is one reason `M-catch` is carried as a hard
guard rather than trusting `M-interrupt` alone.

**Design falsification.** Before the first real candidate trial, an **A/A trial** —
candidate text identical to baseline text, on both arms — must run to the same floors
(§5) and produce a **KEEP by tie**. Any other outcome (a spurious ROLLBACK, or floors that
never fill within `T_MAX`) means the machinery itself is broken; no real trial runs until
it is fixed and the A/A is rerun clean. Ongoing: if golden-baseline windows (§5) show
**repeated regressions with no plausible candidate-side cause**, that is evidence the
decision rule itself — not any one candidate — is broken. That halts all trials pending a
review of the rule, not just the offending trial.

## 10. Non-goals (v0), deferred

Numeric false-accept discounting; sequential/SPRT stopping (`docs/explicitly-not-now.md`
§7.5 stands); concurrent trials (one live trial at a time, §1); opencode-session arms (Claude
Code sessions only, §1); account-global or role layers (project-global only, §1);
gauge-as-reward (tripwire only, §4); automated cross-host sync (manual snapshot script,
§7); composite reward scores (each metric stays separately reported, never combined into
one number, §4); auto trial-**start** (human-go stays the lock, §6); a generalized
mechanism-class slot for this machinery (bespoke §4b-style registrations continue, §1); a
mechanical cross-repo/cross-host trial lock (declared convention only, §1). Each of these
is mirrored into `docs/explicitly-not-now.md` with its own reopen trigger, following the
existing deferral-register convention that entry already documents for the SPRT case
(`explicitly-not-now.md:387-393`).

## 11. Prerequisite build items (separate go, ≈4–6 days)

None of the following is built by this document; each needs its own explicit go before
any spend.

1. Salted-hash arm assignment + an arm-aware compose path from a `TrialState` snapshot —
   `composeHarness` (`compose.ts`, called from `engine.ts`) gains a baseline-snapshot
   parameter it does not have today (§3).
2. Exposure-log appender: any-row-for-`sessionID` dedupe (any `trialId`), void-class
   boundary handling, time-bounded join, and `KKAMAK_TRIAL_ARM` forcing
   (`adapters/claude-code/dispatch.ts`) (§2).
3. `rewardMode`, `resolveGateTrial`, and the first-branch stand-down guard in the old
   `resolveTrial` (`harness-store.ts`) (§5, §6).
4. `trial-verdict.ts` plus `crank.ts` wiring **before** `decideGate`, and the new
   `SitrepAction` kinds (§5, §6).
5. The calibration registry plus its computed staleness check (§4).
6. `forced` and `pluginVersion` `SensorLine` fields (`cc-gate-plugin`) (§2).
7. Exposure-guard checks and per-arm session counts surfaced in the scorecard CLI (§9).
8. The new two-host snapshot script for the sensor+exposure ndjson class (§7).
9. A `km-panic.sh trial-off` verb that reverts to the baseline snapshot (§6).
10. Tests: salt-decorrelation from the reinject arm; three named exposure cases
    (any-row dedupe, void-class boundary exclusion, time-bounded join); the full exclusion
    matrix (§2); the decision truth table, including null-metric deferral, zero-event
    refusal, `T_MAX` rollback, and the golden-window rules (§5); the stand-down guard
    (§6); revert-restores-snapshot; and the A/A machinery test (§9).

**Build-time decision, noted here, not resolved:** whether a queued golden window gets its
own new state marker, or reuses `.trial` with an `awaitingGo`-style field layered on the
existing `readTrial` guard. Either is workable; the build task picks one and records why.
