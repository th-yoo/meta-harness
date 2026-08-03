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

**Deploy.** Boundary ts logged in `docs/2026-08-01-gauntlet-adoption-ledger.md`
at the moment the default flips, per §6b/§6c precedent — required because
behaviour changes while `pluginVersion` does not.

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
`transportTally` (lines ~375-380) buckets records as `if (transport === "sdk")
sdk++ else cli++`, so any `"agent-sdk"` record it ever sees is counted as CLI.
That is a display miscount in the classifier A/B report, not a
transport-selection defect, and `cls-ab.ts` is out of scope for this
amendment. Recorded here so a later reader does not mistake it for a fresh
bug; fix it when cls-ab is next opened.

**What would falsify this change.** If the bar passes but Agent-SDK
derivations cost more wall-clock per record than the API SDK without buying
premium access (e.g. the credit is exhausted), the transport is retained as
selectable but not defaulted.

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
