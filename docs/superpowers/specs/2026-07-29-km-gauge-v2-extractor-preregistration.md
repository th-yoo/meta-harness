# km-gauge v2 — extractor — pre-registration (2026-07-29)

**Status:** REGISTERED (pre-data, 2026-07-29) — classes, mechanisms, metrics,
and decision rule locked before any v2 data exists. Build not yet deployed;
the window opens at the deploy commit (recorded below when it lands).
**Supersedes:** the v1 derivation design whose M0–M3 window CLOSED 2026-07-29
with **M2 FAIL (9/10 false-block)** — analysis in
`2026-07-28-km-gauge-poc-preregistration.md` §7. v1 window data is NOT reused
here; it motivated the design and is cited as evidence only.
**Mode:** SHADOW ONLY, unchanged. The gauge never blocks, never changes any
completion-gate decision (invariant test-locked, `af0a132`).

## 0. Root cause this design answers

v1 asked one prompt-time haiku call to invent both the meaning of "done" and
its observable test, from an input that provably lacks the required
information (paths, conventions, workflow, timing). It guessed; guesses were
90% wrong when they would have blocked. Three gaps, measured: the world gap
(never saw the repo — hallucinated paths, adopted a false premise from prompt
text), the semantics gap ("done" is a workflow outcome, not a worktree
predicate — dirty-tree proxies, repo-wide greps for template-scoped intents),
the timing gap (multi-turn tasks graded at first Stop, mid-flight).

The measured success signature: gauge was right exactly when the prompt
itself contained the operationalization (explicit path + observable
property) — it EXTRACTED. It was wrong when it INVENTED. v2 makes that
boundary structural: **extraction only, enforced in code, never trusted to
the model.**

## 1. Prompt classes (ratified by user 2026-07-29)

Test for a proper class: distinct action, decidable at classification time,
mutually exclusive. One decision axis, one scheduling axis:

| Class | The completion criterion lives... | Action |
|---|---|---|
| **A1** | nowhere — no evaluation needed (greeting / chat / trivial) | no check, reason `no-eval-needed` |
| **A2** | in reply/behavior QUALITY — real criterion, not shell-checkable (research / review / judgment / plan goals) | no check, reason `not-shell-checkable` |
| **B** | in the repo-owned check already ("fix the failing tests", "make the build green") | no check, reason `floor-covered` |
| **C** | **in the prompt text, artifact inside the repo** | extract check; schedule by horizon |
| **D** | exists, but requires invention or out-of-repo observation | no check, reason `not-extractable` or `out-of-scope` |

*Amendment lineage (pre-data, 2026-07-29):* the original registration had a
single class A (`no-criterion`), conflating "nothing to evaluate" with
"evaluation needed but not shell-checkable" — user-identified the same day,
before any v2 data existed. A2 is deliberately NOT served by gauge: deriving
reply-quality judgment would repeat v1's invention mistake one level up with
no deterministic enforcement possible (L4: LLM detectors ≈63%). The sound A2
instruments are the calibrated judge-shadow path (opencode
`SessionRecord.judge` precedent, agreement-vs-human-labels) and human
`/mh-score` — out of gauge's scope. What v2 DOES take on: measuring the A2
share of daily work (measurement before instrument) — if the window shows A2
is a large share, that number is the case for investing in judge-shadow
calibration; if small, learned cheap. Behavior (as opposed to reply content)
is already objectively graded by the sensor stream itself (§4.3's reward
channel); A2's gap is reply content only.

Horizon (C only): `single-turn` (evaluate at next Stop) vs `multi-turn`
(two-strike deferred confirmation, §3). "Task-shaped" (v1 classifier)
survives only as the cost prefilter deciding whether to spend the haiku
call; it is no longer a semantic boundary.

v1's failure restated in these terms: it collapsed B, C, D into one
"derive" class; D is where the 90% lived.

## 2. Mechanisms

1. **Prefilter (unchanged):** deterministic `isTaskShaped`; not task-shaped →
   no spawn, no class.
2. **Refiner v2 = classifier + extractor (one haiku call, unchanged cost):**
   output schema
   `{goalSummary, class: "A1"|"A2"|"B"|"C"|"D", reason, criteria[], check: string|null,
   horizon: "single-turn"|"multi-turn"|null, confidence}`.
   `check` non-null iff class C. The check may reference ONLY paths that
   appear literally in the prompt text, and must test a property the prompt
   states.
3. **Deterministic extraction enforcement (the key mechanism — model output
   is distrusted, code enforces the information bound):** post-parse
   validation in plugin code, not the model:
   - every path token in `check` must appear verbatim in the prompt text,
     else the derivation is downgraded to D `not-extractable`;
   - any referenced path resolving outside the repo root (absolute paths,
     `~/…`) downgrades to D `out-of-scope` (v1's plan-file failure class);
   - class B keyword screen (conservative list: the armed check command's
     own tokens, "test(s) pass", "build green") may override C→B;
   - the read-only guard (v1, unchanged) still refuses non-read-only checks.
   A downgraded derivation is recorded with both the model's claim and the
   downgrade reason — misclassification becomes measurable.
4. **Eval scheduling (timing gap):** class C `single-turn` → evaluate at the
   next Stop (v1 behavior; the measured success class). Class C
   `multi-turn` → **two-strike rule:** a failing evaluation does not record
   `wouldBlock` — the pending file is kept with a first-strike marker;
   `wouldBlock` is recorded only on a second consecutive failing evaluation
   at a later Stop. A pass at either evaluation records a pass. Bounds
   mid-flight grading; does not claim to solve the completion-detection
   circularity (recorded limitation).
5. **Sensor:** the `gauge` field gains `class`, `reason?`, `horizon?`,
   `downgraded?`. `wouldBlock` is only possible for class C. The null-reason
   distribution (A/B/D counts) becomes a first-class measurable instead of
   an autopsy artifact.

*Amendment lineage (pre-data, 2026-07-29, build-review):* build review
sharpened §2.4/§2.5 beyond the original registration, still before any v2
data exists. (a) Two-strike (§2.4) refinement as built: strike advancement
requires a real floor-gate cycle — an edited turn whose completion-gate
cycle ran. At a Stop with no floor cycle (fast-path/planning turns), an OPEN
multi-turn-C pending is NOT evaluated at all: the check does not execute,
the pending is left untouched, and the sensor line carries a
passthrough-only gauge field (class/horizon/strike passthrough,
`executable:false`, no `pass`/`wouldBlock`). Without this, planning turns
could burn both strikes pre-work — mid-flight grading, the exact failure
§2.4 exists to damp — or re-execute the check unboundedly. Single-turn C is
unchanged: it still evaluates at any Stop. (b) Sensor (§2.5): the gauge
field also records `strike: 1|2` — a first-strike marker or terminal second
strike. (c) §3's metrics computation rule: M1v2 and M5 are computed PER
DERIVATION, not per line — dedupe by `(sessionID, n)` using the terminal
line (or the `.done.json` audit) so one derivation is one M1v2/M5 unit;
passthrough-only lines (`horizon === "multi-turn" && rounds.length === 0`,
no `pass` field) are excluded from M1v2's denominator. (d) Footnote: the
operational v2-window filter (score.ts) is class-presence on the gauge
field — only v2 lines carry `class` — a strict subset of the registered
deploy-timestamp cut; a stale pre-deploy refiner writing a v:1 pending
after the deploy commit self-excludes.

## 3. Pre-registered metrics + decision rule (fresh window)

Window: ≥30 task-shaped prompts accumulated AFTER the v2 deploy commit,
union stream (armed repos, both hosts welcome), no calendar deadline.
**Validity floor: ≥5 class-C derivations in the window** — below that at 60
task-shaped prompts, the extractor is over-refusing: one redesign round
allowed, then re-run. v1 lines never mix into v2 metrics (deploy-commit
timestamp is the cut).

- **M0 coverage (unchanged bar):** derivation present at some Stop for ≥70%
  of task-shaped prompts.
- **M1v2 executable precision (redefined — v1's M1 rewarded volume):** of
  class-C derivations, ≥90% run to a clean 0/1 exit (guard refusals and
  126/127 count as misses). Class-C RATE is reported but carries NO bar —
  coverage loss is the accepted price of extraction discipline; measure the
  trade, don't hide it.
- **M2 false-block (unchanged bar — the metric that killed v1):** of
  would-have-blocked lines, ≤20% judged WRONG at the user's end-of-window
  review.
- **M3 value existence (unchanged):** ≥1 would-have-blocked line judged
  RIGHT where the completion-gate floor accepted (fast-path accepts count,
  per the 2026-07-29 user ruling).
- **M4 classification honesty (descriptive, no bar):** user labels a sample
  of ≤10 null-check lines at review — how many were actually extractable C.
  Feeds the next design round; deliberately not a pass/fail criterion
  (small-N honesty).
- **M5 A2 share (descriptive, no bar — amendment 2026-07-29):** fraction of
  task-shaped prompts classified A2 (`not-shell-checkable`) over the window.
  This is the sizing number for whether a calibrated reply-quality
  judge-shadow instrument is worth building; it decides investment, never a
  gauge verdict.

**Decision rule (locked):** all of M0/M1v2/M2/M3 pass → a blocking-pilot
design may be written (folded into the §4.3 trial machinery, per the v1
intent). **M2 fails again → per-task check derivation is KILLED — two
designs, two M2 failures, no third window without a fundamentally new
information channel (tool-using refiner class, out of scope here).** M0 or
M1v2 fail → one redesign round, then re-run. No p-values; counts and user
labels only.

This is the user's 2026-07-29 "fix or drop" directive made operational:
v2 is the fix; v2's failure is the drop.

**PRE-VERDICT AMENDMENT (2026-07-31, corpus-replay amplification; no §3 verdict
has been read — the live window's class-C validity floor is unmet, recomputed
2026-07-31 by direct script tally across all three armed streams' gauge fields:
1 class-C of 72 gauge-classified lines UNION (kkamak 30: A1×1 · A2×11 · B×11 ·
C×1 · D×6; meta-harness 40: A1×12 · A2×14 · B×6 · D×8; km-play 2: B×1 · D×1) —
so every bar amended here is still unconsumed. Since gauge-classified lines are
a lower bound on task-shaped prompts, the window has plausibly already crossed
§3's 60-prompt over-refusal checkpoint with class-C still at 1 — meaning §3's
own remedy (one extractor redesign round) may already be AVAILABLE on live
grounds alone; this amendment is registered alongside, not instead of, that
reading, and consuming the redesign round remains a separate §3 decision. Lineage note: styled as its own block rather than the italic
*Amendment lineage* convention above, deliberately — those were pre-data
amendments to unmeasured definitions; this is a pre-verdict amendment to an
open, partially-accumulated window, a distinct class):** the class-C starvation
risk is an event-rate problem of exactly the shape Phases 2-3 solved for other
rare classes (GA7/GA8): the measurement is fine, the live event supply is thin.
This amendment registers an **offline corpus-replay evaluation channel** that
raises the event count feeding the M1v2 bar (and its validity floor) — no
threshold, class definition, or shadow-invariant changes anywhere in this
block; the two places it touches §3's decision-rule MECHANICS are stated
explicitly in point 5, not left implicit.

1. **Instrument.** The v2 deriver (same prompt, same model, same extraction and
   validation path) may be run OFFLINE over two captured-prompt corpora:
   (a) real task-shaped prompts mined from Claude Code session transcripts
   (the JSONLs CC keeps under `~/.claude/projects/<slug>/`, joinable to sensor
   cycles by sessionID + ts; Phase 2's `transcriptPath` capture where a
   block-cycle fixture-ref exists); (b) TB2 bench task instructions, executed
   against the task's containered state. Each corpus derivation is one
   M1v2-unit with a mandatory `provenance` field:
   `live` | `corpus-transcript` | `corpus-bench`.
   **Prompt inputs may predate the v2 window — a stated departure from the
   fresh-window framing, justified narrowly:** the fresh-window rule (§1)
   bars v1-era MEASUREMENTS from v2 metrics; corpus replay produces fresh v2
   OUTPUTS on old prompt INPUTS, and no v1 derivation output ever enters any
   corpus number.
2. **Execution-state resolution (pool eligibility).** A corpus-transcript
   class-C derivation enters the M1v2 pool ONLY if its check executed against
   a well-defined state, resolved in this order: (i) the same-cycle Phase 2
   fixture-ref tree, where one exists (block cycles only — `fixture-ref.ts`
   captures nothing on accepts); (ii) otherwise the first commit in that
   repo whose committer timestamp is ≥ the prompt's cycle `ts`, same host as
   the cycle's sensor-line `host` field, within 7 days — the post-turn commit approximates the state the turn
   produced, adequate for M1v2's MECHANICAL property (command parses,
   resolves its binaries/paths, exits 0/1) though never for correctness
   judgments, which this pool does not feed; (iii) no resolvable state → the
   derivation is DESCRIPTIVE only (class-C rate, extraction shape), never
   pooled.
3. **What pools and what does not.** M1v2 (executable precision) may be
   computed over POOLED live + pool-eligible corpus-transcript class-C
   derivations at the unchanged ≥90% bar, with the unchanged ≥5-event floor
   satisfiable by the pool **provided ≥1 event is live** (an all-corpus M1v2
   is reportable but cannot alone satisfy §3's M1v2 leg). Corpus-bench M1v2
   is DESCRIPTIVE only (distribution shift: bench prompts are not dogfood
   prompts). M0, M2, M3, M4, M5 are UNCHANGED and live-window-only — M2's
   wrongness judgment stays a user-labeled live review; corpus-derived
   would-block/wrongness evidence may be shown to the user AT that review as
   context, never counted in M2's denominator.
4. **Provenance split is mandatory in any verdict text** — pooled M1v2 must be
   reported as `live a/b · corpus c/d · pooled ≥90%?`, never as one number.
5. **§3 interaction rules (consumption ordering + unwind, explicit):**
   (a) a pooled M1v2 pass permits the blocking-pilot design to be WRITTEN
   (cheap, reversible doc work) but NOT registered or deployed — §3
   decision-rule CONSUMPTION requires live-only class-C n≥5 confirming ≥90%
   first; (b) a redesign round triggered SOLELY by a pooled M1v2 fail is
   provisional: if live-only data at n≥5 later passes, the spent
   redesign-round allowance is restored; (c) if live-only precision at n≥5
   contradicts a pooled pass, the live reading GOVERNS, the pooled pass is
   void, and any design written under (a) is shelved un-actioned. All three
   recorded before data exists on either side.
6. **Cost fence:** corpus replay is batch haiku spend outside §4's daily cap —
   each batch needs its own explicit go, sized in the go (prompts × 1 call).
7. **What this cannot do (restated to prevent drift):** it cannot unshadow the
   gauge, cannot substitute for M2/M3, cannot lower any bar, cannot count
   toward the §3 window's ≥30-prompt accumulation NOR toward the 60-prompt
   over-refusal checkpoint (both live-only), and does not extend the
   two-strike kill rule — a second M2-class failure still kills the
   derivation regardless of any corpus result.
8. **Build items (addendum to §6, each gated on its own explicit go):**
   (i) transcript miner (session JSONLs → task-shaped prompt corpus,
   sessionID/ts join); (ii) offline replay runner (deriver batch mode +
   `provenance` stamping); (iii) execution-state resolver implementing
   point 2's order.

## 4. Cost fencing (unchanged) + deploy

Haiku, exactly 1 call per task-shaped prompt, daily cap 30
(`.km/gauge/daily-count`), opt-in `"gauge": true`, kill switches
`KKAMAK_GAUGE=off` + `scripts/km-panic.sh gauge-off`. Deploy REQUIRES the
installed-plugin cache refresh (marketplace update + uninstall + install) —
the standing watch-item; a stale cache silently runs v1 and poisons the
window. **Deploy: build head `1cad4ba` (v0.2.0), installed-cache refreshed
2026-07-29T16:00+09:00 (office `yoo-dev`); active cache verified 0.2.0 with
v2 code (validate.ts present, two-strike in shadow.ts, vendor intact); a
stale leftover 0.1.0 cache dir was found beside it and removed — the
version-dir enumeration gotcha is real, verify via `claude plugin list`,
not by picking a cache path. THE WINDOW OPENS HERE (office; MacBook joins
at its own refresh after pull).**

## 5. Non-goals (v2)

No blocking. No invention (structurally enforced, not prompted away). No
tool-using or multi-call refiner. No out-of-repo observation. No completion
-detection oracle (two-strike is a damper, not a solution). No §4.3
integration before a blocking-pilot design exists. No opencode port.

## 6. Build items (separate go)

(1) refiner.ts: v2 prompt + schema + parse (class/reason/horizon fields);
(2) NEW validate.ts: path-in-prompt enforcement, repo-scope check, B-keyword
screen, downgrade records; (3) shadow.ts: two-strike pending state for
multi-turn C; (4) types.ts: gauge sensor field extension; (5) score-cli
gauge block: class/reason/downgrade counts; (6) tests per mechanism incl.
downgrade matrix + two-strike sequences + invariant lock untouched;
(7) cache refresh + deploy-commit recording in §4.

## 6b. Amendment (pre-data, 2026-08-01, user-approved): instrument-state visibility

**Trigger — a live incident, not a hypothesis.** On 2026-08-01 the yoo-mac
dogfood repo lost its gauge for two cycles (16:18-16:30). A pre-release review
of the *public* kkamak kernel correctly found that `"gauge": true` is absent
from that kernel's `parseGateConfig`, and the field was removed from
`gate.json`. But the same `gate.json` also configures the *research* build
that actually runs there, where `gauge` is load-bearing: `spawn.ts`'s
`maybeSpawnGauge` returns early unless `cfg?.gauge`, and `hook-cli.ts:224`
skips the whole attach path on the same condition. Gate cycles kept recording
normally; gauge records simply stopped. Nothing errored, nothing surfaced, and
detection was incidental — noticing that two sensor lines carried a gauge field
and two did not.

**The failure mode this closes.** An absent gauge field is currently
ambiguous: it means either "the instrument ran and had nothing to say" or "the
instrument was not running". Those are opposite facts. Under the second, a
starved corpus and a disarmed corpus are indistinguishable — and corpus
starvation (`pool 0/0`, the class table, the C-rate) is precisely what the
activation precondition is read from.

**Change.** Where the gauge path currently omits the field, it emits
`gauge: {present: false, offReason: <cause>}` instead. Causes registered for
this build, chosen by what is honestly derivable at the point the sensor line
is written:

- `disabled` — no `cfg.gauge`. The 2026-08-01 incident, and the one that
  matters most: it distinguishes "instrument switched off" from "nothing to
  report".
- `env-off` — `KKAMAK_GAUGE=off`.
- `no-record` — the instrument was armed but no derivation was available to
  attach at Stop. Deliberately COLLECTIVE: it covers not-task-shaped,
  daily-cap, a swallowed spawn error, and a derivation still pending (the
  state that left record `-3.json` un-consumed on 2026-08-01).

*Finer attribution deferred, with its reason:* splitting `no-record` into its
four causes requires the spawn path to persist why it declined, at prompt time,
for a line written at Stop. That is new cross-turn state in the instrument, and
this amendment deliberately does not add it — the ambiguity being closed here
is armed-vs-disarmed, which `disabled` alone resolves. A later amendment may
register the split if `no-record` proves too coarse in practice.

**`offReason`, NOT `reason` (build-review correction, pre-write).**
`GaugeSensorField.reason` already carries the *classification* reason
(`not-extractable`, `floor-covered`). Reusing it for instrument state would
overload one key with two meanings and let a consumer grouping by `reason` mix
instrument states into class statistics. Same defect class as a version field
doing double duty as provenance. `offReason` is additive and optional.

**Metric neutrality (BINDING).** A `present: false` field is **not a gauge
record**. M1-M5, the class table, the C-rate and pool eligibility count
`present: true` lines only; `present: false` lines are excluded from every
numerator and denominator. This amendment adds instrument-state visibility and
cannot move any measured rate. Any future metric that wishes to count them must
register that intent separately.

**Why pre-data.** No metric definition changes and no excluded line enters the
corpus window, so the measured window is untouched.

**Risk + acceptance check (not an assumption).** A consumer testing
`"gauge" in line` rather than `gauge.present === true` would inflate its counts
the moment this ships. `km-crank/src/scan.ts` must be verified against a
`present: false` line by a real test before deploy; that verification is part
of the build item.

**Prime directive unchanged.** Gauge failures still never touch a session.
This makes the instrument stop lying by omission; it does not let it interfere.

## 6c. Amendment (pre-data, 2026-08-02, APPROVED — user rulings ~23:30 KST 2026-08-02): derive transport → direct API SDK

**Approval record.** Drafted 2026-08-02 night (8a0b715), approved same night
with three user rulings that replaced the draft's two invented numbers:
(1) pooling bar → stratified C-enriched Jaccard bar (the draft's ±25% class-C
band and flat ≥90% agreement were both degenerate at the corpus's ~5.1%
C-rate — see the bar section for the arithmetic); (2) paired re-derivation
runs on a shadow store copy, leaving the fenced/locked deriver untouched;
(3) bar constants T=0.80, N=ceil(0.10×|C_cli|). The draft's claimed conflict
with §4's daily cap was void: §3 point 6 already places corpus-replay batches
outside the daily cap under their own sized go.

**Trigger.** The refiner spawns `claude -p`, which carries Claude Code's whole
system prompt and tool definitions into every derivation — measured on this
host 2026-08-01: `input_tokens 9`, `cache_creation 10481`, `cache_read 17536`,
i.e. ~28k tokens of harness per call. A direct Anthropic API SDK call sends the
refiner prompt and nothing else. On identical corpus prompts: **CLI median
15.6-33.0s vs SDK 2.3-3.1s (5-10x)**, ~700-3000 prompt tokens vs ~28k.
Structured outputs additionally remove a failure mode the CLI path cannot fix
(markdown fences, truncation) by construction. User ruling 2026-08-02 ~21:45
KST: transport moves to the SDK; the CLI has no intrinsic meaning, only
comparability with what it already produced.

**Change.** `maybeSpawnGauge`'s refiner call switches from a detached
`claude -p --output-format json` child to a direct `@anthropic-ai/sdk`
`messages.create` call. Model selection (`KKAMAK_GAUGE_MODEL`, default haiku),
the daily cap (§4, 30/day), the prompt text, `validate.ts`, and every
downstream metric definition are **unchanged by this amendment**.

### THIS AMENDMENT IS NOT METRIC-NEUTRAL

§6b could bind itself to metric neutrality because `present:false` is not a
gauge record. **This one cannot make that claim and must not pretend to.** The
transport demonstrably changes classifications, and classification is what the
metrics are computed from. Everything below exists to keep that change
attributable rather than silent.

**Known error-profile delta** (GA11, n=13 corpus class-C records, blind opus
labels — see `docs/2026-08-01-gauge-classifier-labels.md`):

| | correct (C vs not-C) | false-C | missed-C |
|---|---|---|---|
| CLI | 9/13 | 4 | 0 |
| SDK | 9/13 | 1 | 3 |

The transports **tie on accuracy** and differ in direction: CLI over-extracts
(a path appears ⇒ C), SDK under-extracts. **The mechanism is not understood** —
the hypothesis that CC's ambient system prompt supplies repo grounding was
tested by adding that grounding explicitly to the prompt and made *no
difference* (3/6 both ways). Recorded as an open unknown, not a settled cause.

### Validity-floor hazard (the sharp one)

§3's floor is **≥5 class-C derivations in the window**, and its failure branch
reads "the extractor is over-refusing: one redesign round allowed, then
re-run." The SDK under-extracts C. **A floor trip caused by the transport would
therefore be misattributed to the extractor design and would burn the single
redesign round on a cause that is not the extractor.**

Binding rule: **a validity-floor trip must be evaluated per transport before
any redesign round is opened.** If SDK-derived records fall below the floor
while CLI-derived records in the same window do not, that is a TRANSPORT
finding and does not consume the redesign allowance. Only a trip visible in
both transports, or in the sole transport in use once CLI records age out, is
an extractor-design trip.

### Provenance — a new field, not a reused one

Every derivation record gains **`transport: "cli" | "sdk"`**, written at
derive time. **Absent means `"cli"`** — the 586 pre-boundary records carry no
field and must not be rewritten.

This is deliberately a *new* key rather than a widened meaning for `model` or
`v`. Two live instances this week of a field doing double duty and losing the
distinction: `pluginVersion` serving as both version and producer identity
(0.4.0 vs 0.2.1 are different codebases, not newer/older), and `reason`
carrying both classification reason and instrument state until §6b split it.

**Split rule.** Any M1v2, class-table, or C-rate reading that spans the
boundary MUST report per-transport, exactly as GA9's amendment requires the
live/corpus provenance split. Pooling across transports is permitted only
after the paired validation below passes its bar.

### The 586 CLI records are the baseline anchor (user ruling 2026-08-02 ~22:00)

MacBook 176 + office 410 = **586 CLI-derived records** are the transport
baseline: the paired anchor for SDK validation and the reference population for
anything pre-boundary. **Descriptive anchor, not verdict authority** — an
anchor never self-certifies. Transport-effect claims require the paired
comparison below.

### Paired validation + pre-registered bar (registered BEFORE any SDK data)

**Why the draft's bar was replaced (recorded so the degeneracy stays known).**
At the corpus's honest C-rate (~5.1% after blind-label correction), a
50-record all-class sample carries ~2.5 class-C records — a ±25% band on that
count is narrower than one record and can neither pass nor fail meaningfully.
The flat ≥90% C-vs-not-C agreement clause fails the opposite way: with ~95%
of records not-C, a transport that returns "not-C" for everything scores ~95%
agreement — **the bar was beatable by an oracle that never finds a single C.**
Both clauses were uninformative at the natural class distribution.

**Sample (stratified, C-enriched).** Per host, over that host's own corpus
store: **every CLI-derived class-C record** in the store, plus an
**equal-size random draw of CLI-derived not-C records**. Corpus stores are
host-bound by design (`.km/` gitignored, resolve hostname-bound per GA9), so
the paired validation runs per host and only the resulting counts travel via
git; the bar below is evaluated on the combined counts across hosts. The
not-C stratum exists because a C-only sample cannot see SDK-only C (records
CLI called not-C that SDK calls C).

**Method (shadow store — user ruling 2).** Copy the host's
`.km/gauge-corpus/` to a side store, reset the sampled records to stage
`"mined"`, run the standard derive there with `transport: "sdk"` under its
own sized go, compare classifications offline. The real corpus is never
mutated; the fenced/locked deriver (`runDerive`, whose cost fence requires
`go === pending.length` and cannot re-derive `"derived"` records) is not
modified; paired-validation derivations live only in the shadow store and
are never pooled into, or counted in, any reading.

**Bar for pooling across transports (user ruling 3, constants pre-registered
before any SDK data):**
- **Positive agreement on C** — of the records EITHER transport calls C,
  the fraction both call C: `|C_cli ∩ C_sdk| / |C_cli ∪ C_sdk| ≥ 0.80`, AND
- **Missed-C cap** — records CLI calls C that SDK calls not-C:
  `≤ ceil(0.10 × |C_cli|)` where `|C_cli|` is the CLI class-C count in the
  paired sample.

Both hold → transports may be pooled in a single reading, with the split still
reported. Either fails → all readings stay split by transport for the life of
the window, and the pooled figure is not computed.

**Expected outcome stated up front:** the only paired data in hand (the 13
blind-labeled records) gives `|C_cli ∩ C_sdk| = 7`, union 13, positive
agreement **7/13 ≈ 54%** — below the bar. If the full sample behaves like the
slice, the bar FAILS and readings stay split. That is the designed result,
not a defect: pooling is the exception to be earned, split is the default.
The bar is set on principle, not tuned to pass.

**This bar tests comparability, not correctness.** Neither transport is ground
truth; blind labels put CLI's own class-C precision at 9/13 = 69%.

**Spend.** Paired-validation derive batches are corpus-replay batches: per §3
point 6 they sit **outside §4's daily cap** and each needs its own explicit
sized go (the draft's claim that the sample collides with the 30/day cap was
wrong and is withdrawn). Rough size: MacBook 13 C + 13 not-C = 26; office
sized after its 410-batch class table is read.

### Implementation constraints (binding on the build)

- **Auth:** keychain OAuth token passed explicitly as `authToken`. A zero-arg
  client does NOT inherit Claude Code credentials — proven 2026-08-02
  (`Could not resolve authentication method`). Token is short-lived; read it
  per process, never cache it to disk.
- **Structured outputs:** `output_config.format` + `json_schema`. Union type
  arrays (`["string","null"]`) are **rejected by the API** — use `anyOf`.
- **Tests:** the suite makes **zero real model calls**. Transport is injected
  and stubbed, same discipline as every other gauge test.
- **Fail-open unchanged:** a transport error must behave exactly as a CLI spawn
  failure does today — swallowed, no gauge record, never touching a session.
- **Prime directive unchanged:** gauge failures never affect gate decisions.

### Deploy

Boundary timestamp logged in the gauntlet ledger at deploy, per §6b precedent —
required because the behaviour changes while `pluginVersion` does not. **Both
hosts switch at the same commit.** The office's in-flight 410-record batch
finishes on CLI (sunk, and comparable with the MacBook's 176) and is the last
CLI batch.

### What would falsify this change

If the paired validation shows the transports disagree beyond the bar AND the
SDK's misses concentrate in prompts a human labeller calls C, then the SDK
transport is buying speed at the cost of the instrument's sensitivity, and the
correct response is to keep the CLI transport (or fix the prompt under §6c's
own successor) rather than accept a cheaper but blinder derive path.

## 6d. Amendment (pre-data, 2026-08-03): third derive transport → Agent SDK

**What changes.** A third derive transport, `transport: "agent-sdk"`, using
`@anthropic-ai/claude-agent-sdk`. Selected per process by
`KKAMAK_GAUGE_TRANSPORT=agent-sdk`; absent or any other value keeps the
current `"sdk"` path byte-for-byte. The `"cli"` and `"sdk"` literals and
their records are untouched.

**Why a third transport rather than a replacement.** The subscription premium
quota is per model tier (measured 2026-08-03: haiku OK, sonnet/opus 429 on the
same token in the same second), and Agent-SDK traffic bills a separate
Agent-SDK credit rather than the premium tier. If the bar below passes, this
buys premium-model instrument work without an API key. If it fails, we keep
the incumbent and lose nothing.

**Premise measured TRUE (2026-08-04, yoo-dev, pre-data note — evidence, not a
bar change).** The separate-pool claim above was asserted from docs when
registered; it is now measured. Same minute, same OAuth token: raw-API probe
(`scripts/probe-models.sh`) returned sonnet 429 / opus 429, while `query()`
with this transport's exact option set returned `subtype: "success"` on both
`claude-sonnet-5` and `claude-opus-5`. The Agent-SDK lane rides a quota the
raw-API premium tier does not share. Scope guard: this proves lane
reachability only — instrument fidelity on this lane is still the bar below
(Task 8), and the `claude -p` CLI lane was NOT re-measured.

**Known, accepted differences (measured on the wire, not inferred).** The
Agent SDK sends 2 harness system blocks that `systemPrompt: ""` does not
remove, enforces schemas via a forced `StructuredOutput` tool rather than
`output_config`, and wraps the user turn with ~200 characters of
`<system-reminder>` context. These are exactly what the bar below is measuring
the effect of — they are not defects to be argued about in advance.

**Call-count rule (binding).** §4's exactly-one-model-call-per-record rule
holds for this transport too. Task 4 measures calls per `query()` against a
stub; if a single classification query cannot be made to issue exactly one
model call, this transport is REJECTED for batch use and the plan stops at
Task 4. The cost fence sizes `--go N` against N records and must keep meaning
N calls.

**Pooling bar (reused verbatim from §6c, evaluated on combined counts).**
- Positive agreement on C: `|C_sdk ∩ C_agent| / |C_sdk ∪ C_agent| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk"` calls not-C,
  `<= ceil(0.10 × |C_sdk|)`.
Both hold → the transports may be pooled in one reading, split still reported.
Either fails → readings stay split by transport for the life of the window,
and `"agent-sdk"` does NOT become the default.

**Expected outcome stated up front.** The CLI→SDK paired validation on
`yoo-dev` came back SPLIT (0.625 agreement, missed-C 6 > cap 2). The Agent SDK
is CLI-family (it drives the bundled `claude` binary), so a SPLIT result here
is the likely outcome, not a surprise. Split is the default; pooling is the
exception to be earned.

**OUTCOME (2026-08-04, yoo-dev, post-data): POOLING-PERMITTED — at the bar's
exact edge.** Artifact: `docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json`
(`arms: {baseline: "sdk", shadow: "agent-sdk"}` disambiguates the legacy
`cCli`/`cSdk` field names). Sample: 5 sdk-derived C + 5 not-C (the entire
sdk-C stratum; sdk baseline came from the 109/112 retry batch derived the
same day). Counts: agreement 4/5 = 0.800 (bar ≥ 0.80 — zero slack), missed-C
1 = cap 1 (zero slack), sdk-only-C 0, decided 10/10, wrongTransport 0.
Reading discipline: both margins sit exactly at the boundary on the smallest
possible stratum, so pooling is PERMITTED but the number carries no cushion —
a single flipped record would have split it. Split reporting continues
alongside any pooled reading, per the bar's own terms. The expected-SPLIT
prediction above was wrong in the pooling direction, which is the honest
place for it to be wrong. Operational note: one shadow record (the
4,428-char meta-record whose prompt text is the refiner prompt itself)
needed 3 agent-arm attempts — the first two rolls emitted `criteria: []`
which `parseRefinerOutput` rejects (length-0 guard), while the sdk arm's
`output_config` produced non-empty criteria first try; the declared
prompt-side-vs-grammar enforcement asymmetry materializing as retryable
pending, exactly as registered. Per the PER-CALLER ruling, `selectTransport`'s
default STAYS `"sdk"` and the live path stays pinned; this outcome permits
batch callers to opt in individually (boundary ts logged in the gauntlet
ledger when the first one does). The deriver's bar validates the derive
instrument at haiku — it says nothing about the opus labeler or channel
verifier, which were never routed (transport.ts documents this) and would
need their own consideration before riding the agent lane.

**Schema enforcement differs between the arms — declared, not incidental
(2026-08-03).** The API-SDK arm enforces `DERIVATION_SCHEMA` at the API
layer via `output_config` (grammar-constrained sampling: the model cannot
emit a non-conforming shape). The agent-sdk arm no longer uses the SDK's
`outputFormat` — it was measured at 352 bytes of forced `StructuredOutput`
tool on every request, and the schema instruction is already carried by
`buildRefinerPrompt`/`buildChannelPrompt` ("Output ONLY a JSON object, no
prose, no markdown fences" plus the field shape). So the agent arm's
enforcement is PROMPT-SIDE, with `parseRefinerOutput`/`parseChannelOutput`
as the backstop (first `{` to last `}`, fence-tolerant, `undefined` on
anything malformed → record stays pending and retryable, never
fabricated).

Consequence the bar must not be allowed to hide: the two arms differ in
whether a non-conforming generation is PREVENTED (API arm) or CAUGHT AFTER
THE FACT (agent arm). A model that will not emit valid JSON produces a
constrained-but-valid answer on one arm and an unstamped pending record on
the other, so the arms can differ in PENDING COUNT as well as in
classification. When reading the §6d verdict, a disagreement is therefore
attributable to transport, harness context, OR enforcement mechanism —
this note exists so a SPLIT result is not misread as a pure transport
effect.

Two further arm asymmetries, measured 2026-08-04 during the whole-branch
review and recorded while the pre-data window is open:

- **Retry behaviour.** The bundled CLI auto-retries a 5xx response — measured
  against a local stub: one `agentSdkCall` produced a second `/v1/messages`
  request after a 500, which would silently break the binding
  exactly-one-call rule (the incumbent arm pins `maxRetries: 0`). Guard now
  in code: `agentSdkCall` aborts the query on the SDK's `api_retry` system
  message and returns undefined (fail-open; record stays pending/retryable).
  The abort races a retry request already in flight, so the wire may still
  see a second request begin — but the transport never consumes its result,
  and no third request occurs (test-locked at ≤2 with the race documented).
- **Output cap.** The API arm caps generation at `max_tokens: 2048`; the
  Agent-SDK `Options` surface exposes no output cap (verified against
  sdk.d.ts — a draft `maxTokens` option was deleted as unwireable). An
  over-long generation therefore truncates → parse-fails → stays pending on
  the API arm only. Same consequence as the enforcement asymmetry above:
  arms can differ in PENDING COUNT for this reason too.

**Selection is PER-CALLER, not a global default (RULED 2026-08-03, user).**
The original draft ended with a global default flip once the bar passed.
That is withdrawn, for a reason that only became visible once the live
path was measured:

- The LIVE derive path (`refiner-cli.ts`, the detached child the Stop
  hook spawns) resolves `KKAMAK_GAUGE_MODEL ?? "haiku"` — it runs on
  **haiku**, and haiku is NOT rate-walled (probed directly 2026-08-03:
  haiku OK, sonnet 429, opus 429 on the same token in the same second).
  It therefore has no premium problem for this transport to solve.
- Routing it through `agent-sdk` anyway would impose ~1.25 s of
  subprocess spawn on EVERY Stop hook, buying nothing. A global flip is a
  pure tax on the one code path whose prime directive is to never affect
  the session. **Correction (Task 4, 2026-08-04, measured):** an earlier
  draft of this sentence also charged the one-shot lane a ~423-byte
  `/clear` echo. That was wrong and is removed here — the one-shot lane
  (`agentSdkCall`, what this bullet is about) is a single fresh `query()`
  per call and never pushes `/clear`, so it cannot carry that residue.
  Measured directly: a fresh one-shot request under the identical option
  set is 1,145 B; the echo is a property of the WARM lane's post-`/clear`
  turns only (§6e below), not this one. See §6e's residue paragraph for
  the resolved numbers.
- The premium-blocked work — `cls-label` (opus), the sonnet arms,
  `channel-smoke` — is ALL batch. That is the only place the lane earns
  its cost.

BINDING: the live path stays pinned to `transport: "sdk"`. `"agent-sdk"`
is opt-in per batch caller. `selectTransport(env)` already takes its env
as a parameter rather than reading `process.env` internally, so per-caller
selection is a call-site change, not a redesign.

**Deploy.** Boundary ts logged in `docs/2026-08-01-gauntlet-adoption-ledger.md`
when the first batch caller opts in, per §6b/§6c precedent — required
because behaviour changes while `pluginVersion` does not. There is no
global default flip to log, and the §6c split rule still governs every
reading: `"agent-sdk"` records stay separable from `"sdk"` records
regardless of which caller produced them.

**Context-isolation requirement (measured on the wire 2026-08-03, binding
on the implementation).** The Agent SDK injects per-project context into
every request unless explicitly disabled. Measured against a local stub,
one classification call:

| config | request | user turn | contents |
|--------|---------|-----------|----------|
| `settingSources: []` alone | 10,693 B | 9,627 B | `<system-reminder>` carrying `claudeMd` + the whole auto-memory `MEMORY.md` index |
| + `settings: { autoMemoryEnabled: false }` | 1,572 B | 506 B | memory gone |
| + `persistSession:false`, `strictMcpConfig:true`, neutral `cwd` | 1,572 B | 506 B | no further change |

`settings: { autoMemoryEnabled: false }` is therefore MANDATORY for this
transport, and not for cost reasons: without it the classifier reads this
project's own memory index — which contains notes on gauge, classification
and the class-C rules — while judging whether a prompt is class C. A
paired validation run in that state would measure contamination and report
it as transport disagreement. `persistSession: false` and
`strictMcpConfig: true` are also set (no disk writes; no project
`.mcp.json` / plugin MCP servers / claude.ai connectors loading into the
session), though both are payload-neutral. A neutral `cwd` is redundant
once auto-memory is off — both key off the same directory — and
`excludeDynamicSections` is inert here (docs: applies only to the
`claude_code` preset form of `systemPrompt`, and it MOVES context into the
first user message rather than removing it).

**RULED 2026-08-03 (user): keep OAuth, skip `--bare`.** The bundled CLI's
`--bare` flag ("skip hooks, LSP, plugin sync, attribution, auto-memory,
background prefetches, keychain reads, CLAUDE.md auto-discovery") does
remove the email reminder and shrink attribution — measured 1,124 → 1,001
bytes total, metadata 212 → 176, user turn 494 → 418, email gone. It is
rejected because it authenticates **strictly** via `ANTHROPIC_API_KEY`
(OAuth and keychain are never read — confirmed on the wire: the header
switches from an OAuth bearer to `x-api-key`). Under `--bare` the traffic
bills API rates, not the Agent-SDK credit pool — which is this
transport's entire reason to exist. And if an API key is in play, the
incumbent API SDK dominates on every measured axis (5 ms vs 1,293 ms
per-call overhead, 342 vs ~1,349 bytes, no harness context, no
subprocess, no paired validation needed). So `--bare` is not a
configuration option for this instrument; it is a different lane, and
that lane is option (b) in the 429 block, not this one.

Consequence, accepted deliberately: the two residuals below stay. They
are the price of the OAuth/credit-pool lane, not oversights.

**Residual, unavoidable via the documented SDK surface:** a ~369-byte
`<system-reminder>` carrying the account email address and the current
date rides on every request. Tested against `settingSources`, `settings`,
`persistSession`, `strictMcpConfig` and `cwd` — none remove it. Recorded
so it is a known property of any `"agent-sdk"` record, not a later
surprise. Net overhead after isolation: 1,572 B vs the API SDK's 342 B
(~4.6x, ≈75 tokens per record) plus ~1.3 s of subprocess spawn per call.

**Known reporting gap, acknowledged not fixed.** `cls-ab.ts`'s
`transportTally` (lines 375-383) buckets records as `if (transport === "sdk")
sdk++ else cli++`, so any `"agent-sdk"` record it ever sees is counted as CLI.
That is a display miscount in the classifier A/B report, not a
transport-selection defect, and `cls-ab.ts` is out of scope for this
amendment. Recorded here so a later reader does not mistake it for a fresh
bug; fix it when cls-ab is next opened.

**What would falsify this change.** If the bar passes but Agent-SDK
derivations cost more wall-clock per record than the API SDK without buying
premium access (e.g. the credit is exhausted), the transport is retained as
selectable but not defaulted.

## 6e. Amendment (pre-data, 2026-08-04): warm-daemon lane → `agent-sdk-daemon`

**Governing rulings (2026-08-04, user — verbatim).** This amendment exists
because the user directed it in today's session:

1. "Daemon first. Can we make it ACP server?"
2. "ACP is just interface not implementation. We do this under interface"
   — given in response to five objections to taking on the official ACP
   SDK; the direction is an OWN implementation of the ACP interface.
3. "I don't want to distinguish batch and daily use. We can hook the start
   and the end of CC process. On start, connect or instantiate ACP server.
   ACP server itself has kill timeout, say 15min, on timed out, APC server
   exit to close the ACP process."

**What these supersede, explicitly.** Ruling 3 is a UNIFIED-LANE
instruction. It withdraws, as of 2026-08-04: (a) §6d's "Selection is
PER-CALLER, not a global default" BINDING sentence — "the live path stays
pinned to `transport: "sdk"`"; and (b) the 2026-08-03 agreed daemon shape
recorded in `docs/resume.md` — "in-process singleton for BATCH only … Live
path must NOT use it". The supersession is scoped to THIS lane: the
`"sdk"` and `"agent-sdk"` literals, their records, and §6d's OUTCOME are
untouched, and `KKAMAK_GAUGE_TRANSPORT=agent-sdk` remains exactly what §6d
made it.

**The "end" half of ruling 3, deliberately NOT implemented — registered
here rather than left in a plan step.** Ruling 3 says "hook the start and
the end of CC process". Only the START is hooked (a `SessionStart` branch
that ensures a daemon). No `SessionEnd` hook is added, because the same
ruling gives the daemon its OWN kill timeout, and a per-session shutdown
hook would be actively wrong for a HOST-GLOBAL daemon: closing one CC
window would tear down the warm session other windows and any running
batch are still using, re-imposing the ~1.25-1.46 s respawn this lane
exists to remove. The 15-minute idle self-exit owns shutdown, and it is
strictly safer (it fires only when nothing is in flight). If a future
reading wants deterministic teardown, the correct shape is a reference
count over live connections, not a SessionEnd hook — recorded so a later
reader sees a decision, not an omission. The same reasoning binds
OPERATIONS: no procedure in this amendment or its plan may terminate
daemons by pattern-matching the process table (`pkill -f acp-daemon`),
because that is the host-wide teardown this paragraph rejects. A run that
starts a daemon terminates THAT daemon, by the pid it recorded.

**What changes.** A fourth derive transport literal, `transport:
"agent-sdk-daemon"`: the same Agent-SDK lane §6d validated, but through a
host-global warm daemon (one streaming CLI session, `/clear` between
records) speaking the Agent Client Protocol over a Unix socket. Selected
per process by `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon`; absent or any
other value keeps the current behaviour byte-for-byte.

**Why, and what is still UNMEASURED.** §6d measured the one-shot agent
lane at +1.25-1.46 s subprocess spawn per record (~25% end-to-end). The
daemon amortizes that to one spawn per warm period. Indicative
measurement 2026-08-03 (recorded in `docs/resume.md`, scratch probe, NO
in-tree artifact): first record 838 ms then ~20 ms per record, `/clear`
handled CLI-side with no model call. Those numbers were NOT taken with
this amendment's isolation option set and NOT taken through a
streaming-input `Query` — the mode this lane requires. Whether a `/clear`
user message pushed into a streaming input stream is processed as a slash
command at all is therefore an OPEN QUESTION at registration time, gated
by a token-free probe before any of this lane is built. If the probe
fails, this amendment records a design that was not realizable and the
lane is not built; that is a complete outcome, not a failure to hide.

**Amendment (pre-data, 2026-08-04): Step 1a gate probe result — measured,
token-free.** The probe above was run today, 2026-08-04, entirely against a
local SSE stub (`ANTHROPIC_BASE_URL` pinned to it; no real endpoint ever
reachable) — token-free, per the isolation check recorded in
`.superpowers/sdd/2026-08-04-acp-warm-daemon/task-4-step1a-report.md`,
which is the source of every number below. It pushed `MARKER-ONE`, then
`/clear`, then `MARKER-TWO` into a streaming-input `Query`. Four conditions
were checked; three PASS, one FAILS, and the FAIL surfaces a fact this spec
did not previously anticipate.

  1. PASS — `conversation_reset` arrives after the `/clear` push: the push
     landed at `t+8.01s` and `conversation_reset` was observed at
     `t+8.02s` — "10 ms later", i.e. a direct, fast response to the push.
  2. PASS — `/clear` itself makes no model call: `requests: 2` for the
     whole run (`CAPTURED.length === 2`), exactly the two real turns
     (`MARKER-ONE`, `MARKER-TWO`) — ZERO HTTP requests are attributable to
     `/clear`.
  3. PASS — the transcript really resets: the second request's `messages`
     does not contain `MARKER-ONE` ("2nd request carries MARKER-ONE?:
     false").
  4. FAIL — "every `result`'s `modelUsage` is a non-empty object" does not
     hold. Pushing `/clear` produces THREE `result` messages across the
     two real turns, not two: `modelUsage per result:
     [{"claude-haiku-4-5":{...}}, {}, {"claude-haiku-4-5":{...}}]`. The
     middle entry is `/clear`'s OWN synthetic local turn — its own fresh
     `system/init`, an `assistant` message, and a `result` with
     `num_turns: 0`, `duration_api_ms: 0`, and `modelUsage: {}` — emitted
     between `conversation_reset` and the next real turn's `system/init`,
     with zero HTTP requests of its own.

MEASURED FACT, not anticipated by the "Why, and what is still UNMEASURED"
paragraph above: this paragraph's claim that `/clear` "costs no model
call" REMAINS TRUE — condition 2 confirms zero HTTP requests — but the
prior text said nothing about `/clear` emitting a `result` FRAME of its
own. It does. Any consumer that matches on `type === "result"` alone,
without a distinguishing check, can be handed this empty-`modelUsage`
local ack in place of a turn's real terminal result.

BINDING sequencing rule (user ruling, 2026-08-04): `awaitClear()` must
consume BOTH the `conversation_reset` message AND the synthetic `result`
that follows it before the prompt is pushed, so that frame is always
absorbed while `sent === false` and handled by the existing
stray-message guard/counter — never left free to land after the push,
where `route()` would see `type === "result"` with `sent === true` and
settle a live record from a frame carrying no text and no model evidence.
Field-discriminating the synthetic frame instead (e.g. branching on
`num_turns === 0` or an empty `modelUsage`) was explicitly REJECTED: it
pins the design to undocumented SDK fields rather than to the ordering
the SDK's own event stream already guarantees.

`modelUsage` key observation: both real turns' `modelUsage` were keyed by
the UNDATED alias `"claude-haiku-4-5"` (`canonicalModel` identical to it),
not by the dated snapshot id (`claude-haiku-4-5-20251001`) the stub
declared in `message_start` — under this SDK build
(`@anthropic-ai/claude-agent-sdk@0.3.220`) and this streaming-input/
local-stub configuration, the key tracks the client-requested model id,
not the server-declared one. `modelProvenBy` (the matching rule above)
stays tolerant of BOTH forms by construction — `k === m OR
k.startsWith(m + "-") OR usage[k].canonicalModel === m` — and needs no
change. The dated form remains observed elsewhere in this repo, at
`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22`, on
a DIFFERENT driving path (a captured real-CLI transcript, not this
stub/streaming-input probe); that observation stands on its own and was
not re-measured here.

**Declared residue — RESOLVED by measurement (Task 4, 2026-08-04).** Each
post-`/clear` turn was believed to carry ~423 B of constant
`<local-command-caveat>`/`<command-name>/clear</command-name>` echo, and an
earlier draft of §6d's PER-CALLER ruling above (the paragraph beginning
"Routing it through `agent-sdk` anyway") attributed that SAME figure to the
ONE-SHOT lane, on every Stop hook. Both could not be describing distinct
facts, and this was registered as an OPEN DISCREPANCY pending measurement,
per this section's earlier text.

Measured directly (token-free, local SSE stub, identical isolation option
set and identical prompt text on both sides —
`cc-gate-plugin/test/warm-session-measure.ts`, committed and reproducible
on any host per CLAUDE.md's "reusable scripts / recipes / procedures →
the repo" rule; corrected from an earlier draft that left this script
host-local under `/mnt/d/tmp/`, review finding 5, 2026-08-04. Run with
`cd cc-gate-plugin && bun test/warm-session-measure.ts`): a `WarmSession`
turn immediately after `/clear` sent a request of **1,651 B** (1 message);
a fresh one-shot `agentSdkCall` under the same option set and the same
prompt sent **1,145 B** (1 message). Delta: **506 B** — the `/clear` echo
(`<local-command-caveat>` + `<command-name>/clear</command-name>` +
`<local-command-stdout>` blocks), confirmed present verbatim in the warm
request and verbatim ABSENT from the one-shot request.

**Verdict: §6e's attribution was correct; §6d's sentence was wrong about
the one-shot lane and is corrected in the same commit as this measurement**
(see the "Correction (Task 4, 2026-08-04, measured)" note on that
paragraph above). The one-shot lane is a single fresh `query()` per call
and never pushes `/clear`, so it structurally cannot carry this residue —
it only exists on the WARM lane, where a `/clear`-recycled turn's context
literally contains the SDK's own echo of the `/clear` command it just
issued. The earlier ~423 B figure was an unmeasured estimate quoted in two
places under two different (and incompatible) attributions; 506 B (under
this task's specific option set and prompt) is now the measured,
in-tree-anchored figure and supersedes both. The separate §6e bar never
depended on this outcome either way: a many-turn session that has served
other prompts is a different context from a fresh spawn whether or not the
echo distinguishes them, and that alone is why this literal gets its own
bar rather than inheriting §6d's result.

**Instrument invariants (pinned in daemon code, not client-negotiable).**
The §6d isolation option set, with TWO registered deltas:
(a) REMOVED — `maxTurns: 1` and `abortController` are query-scoped and
cannot transfer to a many-turn warm session (`maxTurns` would stop the
whole `Query` after the first record; aborting the shared controller would
kill every later turn). They are replaced by per-turn model-call
accounting plus `interrupt()` as the per-turn cancel.
(b) ADDED — an explicit neutral `cwd`. §6d measured a neutral `cwd` as
payload-neutral and therefore redundant for a one-shot; for a host-global
daemon it is the difference between a fixed instrument and one that varies
with whichever session spawned it.
Also pinned: the outgoing text is built by the SAME builder the §6d
one-shot lane uses, including its trailing schema instruction — the two
lanes must differ in transport only, never in prompt bytes. One turn in
flight at a time (FIFO across all connected callers). A turn's generation
budget is measured from the PUSH while the CLI subprocess is still
starting, so that budget must always exceed the measured 1.25-1.46 s
spawn; the registered value is 16 s and no configuration, including a test
seam, may set it below 8 s.

**Instrument fingerprint (binding).** A daemon freezes its subprocess `env`
— one of the ten pinned isolation keys — at spawn time, so "which env"
would otherwise depend on which process happened to start it (a wrapper
exporting `ANTHROPIC_BASE_URL` would silently redirect every derivation).
The fingerprint therefore covers the WHOLE environment, minus an
enumerated denylist of keys that provably cannot change the instrument:

  `_`, `PWD`, `OLDPWD`, `SHLVL`, `RANDOM`, `LINES`, `COLUMNS`,
  `WINDOWID`, `TERM_SESSION_ID`, `ITERM_SESSION_ID`, `TMUX`,
  `TMUX_PANE`, `STY`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
  `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `XDG_SESSION_ID`,
  `DBUS_SESSION_BUS_ADDRESS`, `KKAMAK_ACP_IDLE_MS`,
  `KKAMAK_ACP_TEST_SPAWN_LOG`, `KKAMAK_GAUGE_TRANSPORT`,
  `KKAMAK_ACP_SOCKET`

The denylist has two classes and both are stated so a later reader does
not "tidy" one into the other:
  · PER-PROCESS VOLATILE — the shell/terminal/ssh/tmux group above.
  · NOT AN INSTRUMENT PARAMETER — `KKAMAK_ACP_IDLE_MS` and
    `KKAMAK_ACP_TEST_SPAWN_LOG` are daemon OPERATING parameters;
    `KKAMAK_ACP_SOCKET` is an ENDPOINT ADDRESS; and
    `KKAMAK_GAUGE_TRANSPORT` is a LANE SELECTION. None of the four can
    change a single byte the daemon sends to the model. Denylisting
    `KKAMAK_GAUGE_TRANSPORT` is load-bearing rather than cosmetic: after
    the live flip the derive path FORCES that value into a derived env
    while the process that started the daemon carries whatever the user's
    shell had, so keeping it in the hash would make a client and its own
    daemon permanently unable to match. Denylisting `KKAMAK_ACP_SOCKET` is
    load-bearing for the same reason in tests and in any run that binds a
    dedicated socket.

`KKAMAK_ACP_TURN_TIMEOUT_MS` is RULED IN (not denylisted), deliberately:
it changes when a generation is cut off, which changes which turns produce
a derivation, which is an instrument property. A daemon running a
different turn budget is a different instrument and must not be adopted by
a client expecting the registered one.

Secrets never appear in a filename, a log, or a wire frame: any key whose
name matches `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` contributes
`NAME=set`/`NAME=unset` rather than its value. Everything else
contributes `NAME=value`. Keys are sorted by name; `envFingerprint` =
first 12 hex chars of sha256 over the `k=v\n` lines. It is baked into the
DEFAULT socket filename (`~/.config/kkamak/acp-<fp>.sock`) and echoed in
`initialize`'s result; a client whose own fingerprint differs REFUSES the
daemon and reports `no-call` (a pre-send condition — the fallback is
safe).

RESIDUAL, stated honestly and with the RIGHT failure mode: a whole-env
hash is sensitive to benign differences (a shell that exports one extra
variable produces a different fingerprint). For a process that can SPAWN —
`ensureDaemon` — that costs one extra daemon, which is the safe direction:
an extra daemon costs one spawn, a shared daemon with a different
instrument costs the measurement. For a process that CANNOT spawn — the
deriver, whose `daemonCall` never spawns by design — a mismatch is NOT an
extra daemon; it is a permanent, silent `no-call` on every record, i.e.
100% fallback to the one-shot lane with a correspondingly changed
`transport` stamp. That asymmetry is why the denylist above rules out
selection/endpoint/operating keys explicitly instead of leaving them to
"an extra daemon is harmless". A host that accumulates several
`acp-*.sock` files is behaving correctly; a deriver that never once
stamps `agent-sdk-daemon` is a fingerprint bug and must be diagnosed as
one.

**The wire-send boundary law (binding — stated ONCE here; the wire, the
daemon, the client and the deriver all implement THIS text).** Every turn
resolves as exactly one of `ok`, `no-call`, or `call-consumed`. The
dividing line is whether the `session/prompt` bytes crossed the boundary
toward the model. Both sides of the wire classify the SAME physics the
SAME way: there is no post-send `no-call` anywhere.

  L1. CLIENT — any failure BEFORE the `session/prompt` frame is fully
      written to the socket is `no-call`: no socket, connect refused,
      socket-dir creation failure, `initialize`/`session/new` failure,
      env-fingerprint mismatch, write error. "Fully written" means the
      socket's write callback reported success; a write that errors before
      that callback cannot have delivered a parseable frame (a partial
      line is held in the daemon's decoder and never dispatched), so it is
      `no-call`.
  L2. CLIENT — any ambiguity AFTER that frame is written is
      `call-consumed`: client budget expiry, socket closed mid-turn,
      unparseable response, an error frame carrying NEITHER a recognized
      instrument code NOR a boolean `data.callConsumed`, or a
      `data.callConsumed` that is present but not a boolean. The
      conservative side of an ambiguity is always "consumed"; the cost is
      one retryable record, and the alternative cost is a second model
      call.
  L3. CLIENT — the post-send decision procedure, in this exact order, with
      no other branches:
        (i)  `error.data.callConsumed` present AND `typeof === "boolean"`
             ⇒ AUTHORITATIVE, use it.
        (ii) otherwise, `error.code === ACP_ERR_NO_CALL` ⇒ `no-call`;
             `error.code === ACP_ERR_CALL_CONSUMED` ⇒ `call-consumed`.
             A recognized code with `data` absent is HONOURED — that is
             what "the numeric code is the fallback for a daemon that
             omitted it" means, and it is the only reading under which a
             conforming daemon that omits the optional field does not have
             its `no-call` silently upgraded.
        (iii) anything else ⇒ L2 ⇒ `call-consumed`.
      (Round-4 reconciliation: an earlier draft listed "missing
      `data.callConsumed`" under L2 while L3 made the code the fallback —
      a direct contradiction on the one branch that decides between one
      and two model calls. L2 now scopes its clause to "neither a
      recognized code nor a boolean field", and step (ii) above is the
      single authority for a recognized code with no data.)
  L4. DAEMON — a turn that never pushed its prompt is a PROVABLE `no-call`,
      and this is the ONLY daemon-side source of `no-call`: still in the
      FIFO queue when its queue-wait cap expired; cancelled while queued;
      cancelled after leaving the queue but BEFORE its prompt was pushed;
      `/clear` not confirmed by `conversation_reset` within its cap;
      `setModel` not confirmed within its cap; the session was closed
      before the push; or the `Query` could not be started at all.
  L5. DAEMON — once the prompt is pushed, EVERY non-success ending is
      `call-consumed`. There is no exception. An earlier draft carved out
      `api_retry` with `error_status === null`, reasoning that a
      connection-level failure proves nothing reached the model.
      sdk.d.ts:2839-2841 does not support that reading: it documents
      `error_status: null` for "connection errors (e.g. TIMEOUTS) that had
      no HTTP response", and a read timeout is precisely the case where
      the API received, processed and BILLED the request while no response
      came back. `SDKAssistantMessageError` (sdk.d.ts:2901) is a closed
      enum that reports `'unknown'` for both refusal and timeout, so the
      two are indistinguishable from the SDK surface. The carve-out was
      also worthless: a daemon and its clients are fingerprint-matched on
      the same endpoint and credentials, so an endpoint the daemon cannot
      reach the one-shot fallback cannot reach either — it would have
      bought no recoveries while risking the one invariant this law
      protects.
  L6. DAEMON — `api_retry` with `error_status !== null` means the API
      answered, so the call is CONSUMED; the turn is cancelled at that
      moment because the CLI's own internal retry would be call #2 (§6d,
      `agent-transport.ts:135-145`). `api_retry` with `error_status ===
      null` is likewise CONSUMED once the prompt was pushed (L5) and is
      likewise cancelled, for the same reason. An `api_retry` arriving
      while the CURRENT turn has NOT yet pushed its prompt belongs to the
      recycle leg, not to the turn: it is counted as a stray and MUST NOT
      poison an unsent turn or interrupt an in-flight `/clear`.
  L7. DAEMON — a cancelled or timed-out turn that was SENT settles from its
      OWN terminal `result` message, never at the instant of cancellation,
      so a trailing message can never be attributed to the NEXT turn. A
      cancel that arrives while the turn is UNSENT settles immediately as
      `no-call` (L4) and the turn is never pushed — cancelling a turn must
      never be the thing that causes it to spend a model call. If
      `interrupt()` itself hangs past the hard grace, the whole `Query` and
      its subprocess are destroyed. Destroying the `Query` is NOT by itself
      sufficient to prevent stale routing: the message pump is a separate
      object whose loop unwinds asynchronously, so the implementation must
      additionally bind every pump to the generation of `Query` it was
      started for and make a superseded pump a no-op — both while routing
      and while tearing down. A pump that outlives its `Query` and settles
      whatever turn is current would destroy a FRESH record. For the same
      reason a session `close()` must be observed after EVERY suspension
      point inside a turn's execution, not only at its entry: a `close()`
      that lands while a turn is awaiting the SDK package import would
      otherwise be followed by a fresh subprocess spawn and a real model
      call on a session the caller already terminated.

A caller may fall back to the one-shot lane ONLY on `no-call`. On
`call-consumed` the deriver returns undefined and the record stays
pending/retryable. Without this split, a fail-open fallback would issue a
second model call for the same record, breaking §4's exactly-one-call rule
and making the `--go N` cost fence mean up to `2N` calls.

**Budget rule (binding, and the reason L2 is not a loophole).** The
client's daemon-leg budget MUST exceed the daemon's worst-case per-turn
wall clock, or an ordinary slow-but-legitimate turn would trip L2 and cost
the record. Registered values: daemon queue-wait 6 s + `/clear` confirm
4 s + `setModel` confirm 2 s + generation 16 s + hard grace 4 s = 32 s
worst case; client leg 36 s (the 4 s of slack is the client's connect +
`initialize` + `session/new` preamble, which the daemon's clock does not
cover); minimum fallback leg 10 s; total per-record budget 60 s (unchanged
from today's `CALL_TIMEOUT_MS`). Every daemon-side wait is capped —
including `setModel`, which the SDK exposes as an un-timed control
round-trip and which would otherwise let one wedged subprocess hang the
FIFO for the daemon's whole lifetime. The one uncapped item is the lazy
`import` of the SDK package (~84 ms measured); it sits outside the 32 s
sum, and an import slow enough to consume the client's slack degrades to
L2 (`call-consumed`, a lost retryable record), never to a second call.
Per-record latency therefore never exceeds today's. The arithmetic is
locked by a unit test, not by prose.

**Fail-open provenance rule (binding).** A caller selecting
`agent-sdk-daemon` that falls back derives via the direct lane instead and
the record stamps the transport THAT ACTUALLY RAN, and the model the lane
actually used. A stamp may therefore differ from the selection; the stamp
is the truth. Silent mislabeling here is the §6d cls-ab defect all over
again — the paired-validation partition reads stamps, so a lie in the
stamp corrupts the §6e bar itself.

**Which field proves the model — SCOPED TO THIS LANE (binding), and the
asymmetry that scoping registers.** For a turn served by the
`agent-sdk-daemon` lane, the AUTHORITATIVE evidence of which model ran is
the keys of `modelUsage` on the SDK's terminal result (sdk.d.ts:4312 on
success, sdk.d.ts:4279 on error). The `model` field of the turn's
assistant messages is DIAGNOSTIC ONLY and never becomes evidence —
treating it as a fallback proof would quietly reinstate the tautology this
rule exists to remove.

THE MATCHING RULE (binding, and NOT string equality). A `modelUsage` key
is not required to equal the requested model id, and in practice does not:
this repo's own captured CLI transcripts key `modelUsage` by the DATED
snapshot id (`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson`
records `"modelUsage":{"claude-haiku-4-5-20251001": …}` for a request that
named the undated alias), and sdk.d.ts:1274-1277 states outright that the
key may be a provider-specific id or an alias differing from the canonical
one. A key `k` therefore PROVES a requested model `m` iff:

    k === m  OR  k.startsWith(m + "-")  OR  usage[k].canonicalModel === m

Naive string equality here would discard EVERY honest derivation and turn
a sized go into a full spend with zero records — registered explicitly so
no later reader "simplifies" it back.

When `modelUsage` carries exactly one key, that key (with its
`canonicalModel`) is the turn's evidence. When it carries several (an
auxiliary title/summarizer model is possible), the turn is proven for `m`
only if some key proves `m` under the rule above AND every other key
recorded zero output tokens — the proof still comes from the result, not
from the request. A turn that produced text but whose result carries no
key proving the requested model is reported `call-consumed` (the call
happened; the record must not be stamped). The `transport` and `model`
STAMPS written onto the record remain the lane that ran and the resolved
requested id, exactly as §6c/§6d records already carry them; what this
rule adds is that a daemon-lane record is only written when the result
PROVES the lane ran that model.

REGISTERED ASYMMETRY, not an oversight: this rule binds the
`agent-sdk-daemon` lane only. The `"sdk"` lane returns an API response the
caller does not inspect for model provenance, and the `"agent-sdk"` lane's
`agentSdkCall` returns a bare string with no result surface at all
(`agent-transport.ts:146-149`), so neither can supply this evidence
without a change to code §6c/§6d already validated and froze. Those two
lanes keep their §6c/§6d requested-model stamp. Pretending otherwise
would make this amendment declare a rule two of the three live lanes
violate on their first record.

**Pooling bar (reused verbatim from §6c/§6d, baseline `"sdk"`).**
- Positive agreement on C: `|C_sdk ∩ C_daemon| / |C_sdk ∪ C_daemon| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk-daemon"` calls
  not-C, `<= ceil(0.10 × |C_sdk|)`.
Both hold → pooling permitted, split still reported. Either fails → the
literal stays selectable with split readings, and the live flip DOES NOT
HAPPEN.

**Power limitation, declared pre-data.** On `yoo-dev` the entire
`"sdk"`-derived class-C stratum is 5 records (measured 2026-08-04: 109
`transport:"sdk"` records, 5 of class C), so the sample is 5 C + 5 not-C
and the cap is `ceil(0.5) = 1`. Agreement ≥ 0.80 over a union of 5 means
4/5. §6d already landed on both edges with zero slack. This bar therefore
has NO power to separate a small real effect from a single coin flip, and
that is registered here BEFORE the data rather than argued afterwards. A
PASS licenses the flip because the flip is user-directed and reversible by
one env var; it does not license a claim that the warm residue is
behaviourally neutral.

**Validation-run instrument parameters, registered pre-data.** The §6e
validation run binds its OWN socket path (`KKAMAK_ACP_SOCKET` set to a
run-specific file) and sets `KKAMAK_ACP_IDLE_MS` above the expected batch
duration, then re-proves daemon liveness inside the same script that
spends. The dedicated socket is not cosmetic: both `KKAMAK_ACP_IDLE_MS`
and `KKAMAK_ACP_SOCKET` are on the fingerprint denylist (neither can
change the instrument), so a daemon already listening at the default
fingerprinted path would be adopted by the liveness probe and would serve
the run under ITS idle budget, not the registered one — the registered
parameter would be silently inert. Both are operational parameters of the
run, not changes to the bar. The run records its daemon's pid (via
`KKAMAK_ACP_TEST_SPAWN_LOG`, itself denylisted), terminates THAT pid and
no other process, and asserts the socket file is gone.

**Pooling is not transitive, and the post-flip live stream is split three
ways.** §6d permits pooling `sdk` with `agent-sdk` at exactly 0.800; a
§6e pass would permit pooling `sdk` with `agent-sdk-daemon` at ≥ 0.80.
Neither licenses pooling `agent-sdk` with `agent-sdk-daemon`. After a
flip, the live derive path emits `"agent-sdk-daemon"` when the daemon
serves the turn and `"agent-sdk"` when it fell back on a `no-call` — the
lane is chosen by daemon availability, which is not independent of host
state or time of day. Every post-flip reading is therefore split THREE
ways (`sdk` pre-boundary, `agent-sdk-daemon`, `agent-sdk`), and the
fallback mixture is itself a registered source of variance. A post-flip
stream in which `agent-sdk-daemon` NEVER appears is not a valid reading of
this lane at all — it is an ensure-gate or fingerprint defect (see the
fingerprint residual above and the flip gate below).

**Live flip gate.** The live derive path (refiner-cli.ts) stays pinned to
`"sdk"` until: (1) this bar passes, (2) the flip ships with the fail-open
fallback and the wire-send boundary law above, (3) the flip ships with a
SessionStart ensure gate that fires on exactly the condition under which
the live path takes the daemon lane — one predicate read by both, not two
that can drift, because a forced live lane with an opt-in ensure gate
would produce a 100%-fallback stream that is slower than the pre-flip
instrument and stamped as a lane this bar never measured — and (4) the
boundary ts is logged in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at the flip commit
— behaviour changes while `pluginVersion` does not. A bar FAIL is a
complete, successful outcome: the daemon stays available for any caller
that opts in with split readings, and live keeps `"sdk"`.

**Boundary ts for batch, too.** §6d's Deploy clause requires a boundary ts
when the first BATCH caller opts in. The §6e validation run (a shadow-store
derive) is instrument validation, not a production reading, and does NOT
trigger it. The first `agent-sdk-daemon` derive against a REAL store does,
whether or not the live flip ever happens.

**Known reporting gap, re-recorded.** `cls-ab.ts`'s `transportTally`
(lines 375-383, the `if/else` at 379-380 — this is the precise range;
§6d's own paragraph above says "lines ~375-380" and is corrected to this
range in the same commit that lands §6e) buckets records as `if
(transport === "sdk") sdk++ else cli++`. §6d recorded this for
`"agent-sdk"`; it applies identically to `"agent-sdk-daemon"`, which will
also be miscounted as CLI in the classifier A/B report. Display miscount
only, still out of scope, fix it when cls-ab is next opened.

**What would falsify this design.** If warm-lane derivations disagree with
fresh-spawn agent-lane derivations more than fresh-spawn disagrees with
the API lane (i.e. the warm context is NOT behaviourally neutral), the
daemon is retained as a convenience only and the live flip is off the
table for it. NOTE ON MEASURABILITY: the pv machinery compares a real-store
baseline against a shadow arm, so it cannot compare two shadow arms
directly. This criterion is therefore evaluated on the class-C stratum
ONLY — the same 5 baseline keys appear in both the §6d and §6e samples —
against the per-key classes recorded in
`docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json`. The not-C stratum
is an independent random draw in each run and is NOT comparable across
them.

## 7. Known risks

- Extraction discipline may over-refuse (class-C starvation) — the validity
  floor measures it and routes to redesign, not silent death.
- B-keyword screen is heuristic; a wrong B eats a legitimate C — M4 sample
  catches the rate.
- Two-strike halves the false-block class it targets only if mid-flight
  failures are transient; persistent mid-flight states (long multi-turn
  tasks) can still double-strike — recorded limitation, M2 measures it.
- Prompt-quoted false premises (v1 case #8) survive when the false premise
  names a real repo path — extraction enforcement narrows but does not
  close this channel.
