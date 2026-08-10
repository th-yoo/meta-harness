# Gauge classifier 2×2 A/B (model × prompt) — pre-registration (2026-08-03)

**Status:** REGISTERED (pre-data, 2026-08-03) — sample, blind-label protocol,
metrics, and the decision rule's constants are locked in this document
BEFORE any label or arm data exists, per the same discipline as
§6c of `2026-07-29-km-gauge-v2-extractor-preregistration.md` ("bar constants
... pre-registered before any SDK data"). **The decision-rule constants
below are user-proposed values; the user may re-rule any of them at any
time BEFORE the first blind label is written. Once the first label exists,
the constants are FROZEN** — the same pre-data/post-data boundary §6c uses
for its own bar (T=0.80, N=ceil(0.10×|C_cli|)).
**Authority:** plan `docs/superpowers/plans/2026-08-03-gauge-classifier-ab.md`
("Design", "Global constraints" sections) + user go 2026-08-03 ("we run two
arms of haiku and sonnet for classifier ... determine which to use"),
executed via SDD. This document is Task 0 of that plan.
**Mode:** offline, read-only against production. Zero effect on the shadow
gauge, the live/corpus-replay windows of §3 above, or the completion-gate
trial machinery of §4.3 (`2026-07-29-trial-mode-gate-outcomes-preregistration.md`).
**Lineage — the "third lane":** resume.md's queue item 12 ("run the
proposer/reviewer/A-B loop on this prompt rather than hand-tuning it",
carried since `docs/2026-08-01-gauge-classifier-labels.md`) was parked
pending its own pre-registered bar. This document IS that bar. It is a
third measurement lane alongside the live §3 window and the GA9
corpus-replay lane — independent of both, feeding neither.

## 1. What this experiment decides

Which of four `{model} × {prompt}` combinations the gauge refiner's
classifier stage should use: `{claude-haiku-4-5, claude-sonnet-5} ×
{base prompt, patched prompt}`. The patched prompt is the anti-
over-extraction text committed (not applied) in
`docs/2026-08-01-gauge-classifier-labels.md` — four traps against
"a path appears ⇒ class C" without an independently stated property.
Decided by pre-registered measurement against fresh blind opus labels,
not by re-reading the 13-record slice already in hand (that slice is
cited as motivating evidence only, per the no-reason-drift-without-
evidence discipline — it is not re-scored here as if it were new).

## 2. Design

### 2.1 Sample

Per host, drawn from that host's own corpus store (`.km/gauge-corpus/`,
host-bound by design, per GA9 — see §6 below): **all records whose stored
derivation is nominal class C**, plus an **equal-size random draw of
nominal not-C derived records**. The stored CLI-era nominal class is used
only as a stratification / enrichment heuristic to guarantee the C stratum
isn't vanishingly small at the corpus's ~5% natural C-rate — it is NOT the
ground truth this experiment scores against (see 2.2). Office today: 16 C +
16 not-C = 32 sampled records.

This mirrors §6c's own stratified-sample rationale in the extractor
pre-registration (a C-only or unstratified sample cannot see errors in the
opposite direction), adapted here from transport comparison to model/prompt
comparison.

### 2.2 Ground truth — blind opus labels

One blind `claude-opus-5` label per sampled record, produced under the
**same isolation discipline as the GA11 blind-label methodology**
(`docs/2026-08-01-gauge-classifier-labels.md`): fresh context; the labeler
sees ONLY the classification rubric and the record's prompt (+
`floorCheck`) — never the stored nominal class, never any arm's output,
never any other label. Label = C / not-C, with an optional class letter.
Enforced by construction: labeling and arm classification are separate
subcommands operating on separate files (see §5), never a shared process
or a shared read.

**Rubric provenance note (pre-data, 2026-08-03):** the label rubric was
authored independently 2026-08-03 (pre-data — zero labels existed at
rewrite time), replacing a base-prompt-derived draft. Final-review
finding: reusing an arm's C-definition aligns the judge's prior with that
arm and structurally blinds the experiment to the other arm's
corrections.

**Registered limit (opus-judgment ceiling), restated verbatim from GA11's
own limit clause:** "these are opus judgments, not ground truth. Work
optimised against them is distillation, capped at opus accuracy." Every
metric in this document is agreement-with-opus-labels. **Never report
agreement with this set as "correctness."** This is the same ceiling GA11
registered for the 13-record slice; this experiment inherits it rather
than re-deriving it, and does not attempt to lift it — a fresh, larger
blind-label set does not change what kind of thing a label is.

### 2.3 Arms (2×2)

`{haiku, sonnet} × {base prompt, patched prompt}`. Model literals are
experiment pins, recorded on every result row exactly as written — no
alias, no default substitution:
- `claude-haiku-4-5`
- `claude-sonnet-5`
- labeler only: `claude-opus-5`

Patched prompt = base + the four committed traps, text as already recorded
in `docs/2026-08-01-gauge-classifier-labels.md` — this document does not
restate that text (F2: no prompt text in any artifact destined for git).
Each arm classifies every sampled record via the SDK transport (§6c
precedent: direct API, not `claude -p`). 4 arms × 32 records (office) = 128
cheap calls, sized per host at run time.

### 2.4 Metrics per arm

C-precision, C-recall, F1 — all against the blind opus label, not the
stored nominal class. Error profile: false-C count, missed-C count.
Descriptive only until run through the decision rule in §3; no metric here
carries an implicit bar of its own.

## 3. Decision rule (constants pre-registered, proposed values — see the
Status header for the re-ruling window)

**Incumbent:** haiku + base prompt (the production default today).

**Winner candidate:** `argmax(F1)` across the 4 arms.

**Adoption condition — winner replaces incumbent ONLY IF both hold:**
- (a) `F1_winner − F1_incumbent ≥ 0.10` (the registered margin — a raw F1
  point gap, not a relative lift, not a significance test: "no p-values;
  counts and user labels only" is the same discipline §3 of the extractor
  pre-registration already commits to), AND
- (b) `missed-C_winner ≤ missed-C_incumbent` (**missed-C not-worse** — the
  winner is barred from buying F1 by trading away recall on the class the
  gauge exists to catch; a margin win that increases missed-C does not
  adopt).

**Tie-break order** (applies when (a) and (b) both hold for more than one
arm, or when comparing candidates before applying argmax): **cheaper model
first, then base prompt.** Concretely: haiku beats sonnet at equal
qualifying F1; base beats patched at equal qualifying F1 and equal model.
This keeps the tie-break monotonic with production cost, not with
complexity of the prompt. (Clarified pre-data 2026-08-03, before any label
existed; implemented reading: `argmax(F1)` first selects a SINGLE winner
candidate across the 4 arms — the tie-break applies only among arms tied at
that max F1 — and ONLY THEN do adoption conditions (a)/(b) gate that one
winner against the incumbent. The tie-break never re-enters after (a)/(b)
are evaluated; there is exactly one winner candidate per run.)

**If no arm clears (a) and (b):** the incumbent (haiku + base) stands. See
§7, falsification clause — this is a registered outcome, not an
inconclusive run.

These are the ONLY constants this document registers as binding on the
decision. Task 3 (`cls-score`) imports them from one exported object,
single source, per the plan — no re-derivation of the numbers inside the
scorer.

## 4. What this experiment CANNOT do

Restated explicitly, in the same register as §3 point 7 of the extractor
pre-registration ("what this cannot do, restated to prevent drift"):

- **Cannot unshadow the gauge.** The gauge remains shadow-only,
  invariant-locked (`af0a132`); nothing here touches that lock or any
  gate decision.
- **Cannot change the bars of §3** (`2026-07-29-km-gauge-v2-extractor-
  preregistration.md` — M0/M1v2/M2/M3/M4/M5, the validity floor, the
  redesign-round rule) **or of §4.3**
  (`2026-07-29-trial-mode-gate-outcomes-preregistration.md` — the
  completion-gate-outcome trial's decision rule). Both stand exactly as
  registered regardless of this experiment's outcome.
- **Cannot pool into M1v2.** Arm classifications and opus labels are
  experiment records, not live or corpus-transcript derivations under GA9
  §3 point 1's provenance taxonomy — they never carry a `provenance` field
  recognized by that pool and must never be merged into it, in either
  direction.
- **Labels never become corpus records.** `labels.ndjson` and the arm
  files are experiment state under `.km/gauge-cls-ab/` (gitignored), never
  written into `.km/gauge-corpus/`, never assigned a `recordKey` that
  collides with a production derivation, never read by the production
  refiner or scorer.

A winning non-incumbent arm changes what the production refiner calls at
derive time — it does not change what a derivation IS, what a gauge line
records, or any bar computed over that stream.

## 5. Blind-label isolation protocol (hard requirement)

Enforced by construction, not by convention, and pinned by tests (Task 2):
- The **labeler run** (`cls-label`) reads the sampled records' prompt +
  `floorCheck` only. It never reads any arm's output file
  (`arm-<name>.ndjson`) and never reads the stored nominal class carried in
  the sampler's manifest.
- The **arm runs** (`cls-run`) never read `labels.ndjson`.
- Labeling and arm classification are separate subcommands writing to
  separate files (`labels.ndjson` vs `arm-<name>.ndjson`); there is no
  shared in-process state between them within a single invocation of the
  tool.
- This is the same isolation GA11 already proved operationally ("the input
  file it read carried no `derivation`/`class`/`check`/`state` fields,
  verified before dispatch") — carried forward as a structural rule instead
  of a manual verification step.

## 6. Per-host mechanics

Corpus stores are host-bound by design (`.km/` gitignored, GA9 precedent —
"resolve is hostname-bound per GA9", `docs/resume.md`). Consequently:

- Sampling, labeling, and arm runs all execute **per host**, against that
  host's own corpus store and its own `.km/gauge-cls-ab/` experiment
  state.
- The experiment state itself (manifest, records, labels, arm outputs) is
  host-local and never committed — it is derived data over a host-local
  store and would be stale or meaningless on another host.
- **Only counts travel.** Each host's `cls-score --emit-doc` output is
  committed to `docs/gauge-cls-ab/<hostname>-*.json` — counts, keys,
  classes, and metrics only, no prompt text (F2). This is the same
  transport used by the paired-validation lane
  (`docs/gauge-pv/<hostname>-*.json`, `docs/resume.md` 2026-08-03 entry)
  and by GA9 corpus-replay readings before it: host-local raw state stays
  host-local; only the derived, non-sensitive reading is git-portable.
- The decision rule in §3 is evaluated on **combined counts across hosts**
  once each host's committed file exists, mirroring §6c's paired-validation
  bar ("evaluated on the combined counts across hosts").

## 7. Spend accounting

Two independent spends, each sized and gated separately, neither folded
into the other:

- **Label go:** `cls-label --go n` where `n` equals the exact count of
  sampled records not yet labeled. Produces the ground truth.
- **Arm go:** `cls-run --arm <name> --go n` where `n` equals the exact
  count of sampled records not yet classified by that specific arm — four
  separate gos, one per arm, not one go covering all four.

Both are cost-fenced exactly like `derive --go` (plan's Global constraints):
refuses unless `--go n` equals the exact pending count. Both are **outside
§4's daily cap** (`2026-07-29-km-gauge-v2-extractor-preregistration.md` §4,
the 30/day gauge cap), on the same footing as corpus-replay batches. The
citation for that footing, verified against what §3 point 6 of that
document actually says (not the plan's paraphrase): **"Cost fence: corpus
replay is batch haiku spend outside §4's daily cap — each batch needs its
own explicit go, sized in the go (prompts × 1 call)."** This experiment's
label and arm batches are the same shape of spend (offline, batch,
model-call-per-record, no bearing on the live daily-cap-gated derive path)
and are held to the same "own explicit go, sized in the go" rule — nothing
in this document weakens that citation to "outside any cap" in general; it
is specifically the §4 daily cap that does not apply, and only because
these are not live derive-path calls.

Nothing in this build (Tasks 1-3, tooling) spends. The label go and each
arm go happen only at run time, per host, after tooling exists.

## 8. Adoption mechanics for a winning non-incumbent arm

Out of scope for this experiment itself (plan's "Out of scope": "Deploying
a winner (own boundary + amendment mechanics)"), but the mechanics are
registered here so a future deploy inherits them rather than inventing new
ones:

- **Pre-data amendment mechanics are already satisfied by this document** —
  the constants that would justify a switch are locked before data exists,
  same as §6c's "pre-data amendment + logged boundary ts FIRST (§6b
  discipline)" sequencing for the transport switch.
- **Deploy requires a logged boundary timestamp**, in the gauntlet
  adoption ledger, per the §6b/§6c precedent (`2026-08-01-gauntlet-
  adoption-ledger.md`; §6c: "Boundary timestamp logged in the gauntlet
  ledger at deploy ... required because the behaviour changes while
  `pluginVersion` does not").
- **Model must be recorded on production derivations**, following the
  transport-field precedent set by §6c: a NEW field, not a widened meaning
  of an existing one (§6c's own reasoning against double-duty fields:
  "two live instances this week of a field doing double duty and losing
  the distinction"). Absent/default value on pre-boundary records means
  the production default in force before the switch, exactly as `transport`
  absent means `"cli"`.
- Any pooled or split reporting that spans the adoption boundary follows
  the same split-by-default rule §6c registers for transport: reported
  split unless a comparability bar is separately earned, never silently
  pooled.

None of this is authorized to run by this document. It is recorded so a
later deploy amendment does not have to re-derive mechanics this document
already worked out.

## 9. Falsification clause

If no arm satisfies both conditions in §3 (F1 margin ≥ 0.10 AND missed-C
not worse than the incumbent), the incumbent (haiku + base) stands. This is
not an inconclusive or aborted run — it is a **registered finding**: at the
measured sample size and against the blind opus labels, no candidate
model/prompt combination clears a large enough, safe enough improvement
over the current default to justify the switch. The result is reported
with full per-arm metrics regardless of outcome; a null result is written
up exactly as a positive one would be, per the same discipline as loop-1's
"provable null" verdict (`docs/reboot.md`) — silence is not an acceptable
substitute for a registered null.

## 10. Non-goals

No prompt tuning against this sample beyond the fixed 2×2 (plan's "Out of
scope": "Prompt-tuning loops beyond the fixed 2×2"). No change to the
production refiner prompt or model as a side effect of running this
experiment. No claim that a winning arm is more "correct" than the
incumbent — only that it agrees with the blind opus labels more, within
the registered margin, at no cost in missed-C.

## Amendment 1 — labeler transport (2026-08-10, PRE-DATA, boundary ts 1786333049922)

**Status when registered: labels.ndjson = 0 rows** (the §2.2 constants-freeze
trigger — the first label — has not occurred; this amendment is inside the
registered amendment window). Arm files: also 0 rows each.

**Forcing evidence:** the first authorized label go (2026-08-10,
`cls-label --go 32`) returned 0/32 — every call refused HTTP 429
`rate_limit_error` on the bare-SDK transport (raw probe confirmed the exact
status). This is the per-model-tier wall first measured 2026-08-06 (haiku
serves; sonnet/opus 429 on bare SDK while the CLI/agent-SDK lane serves all
three) — four days standing. `callModelSdkLabel` HARDWIRES the bare-SDK
path: unlike `callModelSdk` (the derive path), it never consults
`selectTransport`, so the labeler cannot reach the unwalled lane at all.

**Amendment:** `callModelSdkLabel` gains the SAME per-caller transport
branch `callModelSdk` already has — `KKAMAK_GAUGE_TRANSPORT=agent-sdk`
routes the label call through `agentSdkCall` (§6d transport: reviewed,
pv-validated sdk↔agent-sdk POOLING-PERMITTED, GA13 context isolation
applied). The labeler MODEL literal is unchanged (`claude-opus-5`, §2.3 —
never routed through `KKAMAK_GAUGE_MODEL`). Label rows gain an optional
`transport` field ("sdk" when absent — the pre-amendment shape), same
additive-provenance discipline as `GaugeSensorField.transport`.

**Honesty bounds, stated now:** (1) the §6d pv pooling verdict was measured
on haiku DERIVE calls, not the opus labeler — transport equivalence for the
labeler is assumed-with-grounding, not measured; if the 2×2 verdict lands
within its margin of the adopt bar, this assumption gets named in the
verdict doc. (2) GA13's enforcement asymmetry applies: the agent lane
CATCHES non-conforming output at the parser rather than PREVENTING it, so
labeler pending-counts may differ from what the sdk lane would have
produced. (3) All 32 labels will ride ONE transport (agent-sdk) — no
mixed-transport label set, so no within-labels split to reason about.

**Not amended:** the four ARM transports. Arms measure candidate classifier
configurations against the PRODUCTION transport selection; sonnet arms stay
walled until the wall lifts or their own amendment with its own reasoning.

## Amendment 2 — sonnet arm transport (2026-08-10, PRE-DATA for those arms, user-directed)

**Status when registered: arm-sonnet-base.ndjson and arm-sonnet-patched.ndjson
= 0 rows each** (pre-data for the artifacts this amendment governs). Labels
and both haiku arms are complete and untouched.

**Forcing evidence + directive:** the bare-SDK per-model-tier 429 wall has
held ~7 days (measured 08-06, re-probed 429 at 2026-08-10 13:01); the sonnet
arms cannot run on the production transport for as long as it stands. The
user directed (2026-08-10): run them via the unwalled agent lane now rather
than wait.

**Amendment:** `cls-run` gains an explicit per-invocation `--transport
agent-sdk` flag (never ambient env — the arm pin stays fail-safe: without
the flag, cls-run still STRIPS `KKAMAK_GAUGE_TRANSPORT` and pins "sdk"
exactly as before). With the flag, the call routes through `agentSdkCall`
(§6d) and the row's `transport` field records the ACTUAL transport
("agent-sdk"), never a fiction. `ClsArmRow.transport` widens from the "sdk"
literal accordingly.

**Honesty bounds, stated now — STRONGER than Amendment 1's:**
(1) The four arms are now TRANSPORT-ASYMMETRIC: haiku arms measured the
production sdk transport, sonnet arms will measure agent-sdk. Any
haiku-vs-sonnet comparison in the §3 decision carries transport as a
CONFOUND, bounded only by the §6d pv verdict (pooling-permitted at the
exact bar edge, 4/5 = 0.800, measured on haiku DERIVE calls — neither
sonnet nor arm-shaped). (2) If the §3 decision turns on a sonnet arm
beating a haiku arm within ~the pv bar's own slack, the verdict doc MUST
name the transport asymmetry as an alternative explanation and the adopt
bar's ≥0.10 F1 margin is the only thing standing between the confound and
a wrong adoption. (3) Per-row `transport` provenance makes the asymmetry
permanently visible in the committed counts.

## OUTCOME (2026-08-10, yoo-dev) — INCUMBENT-STAYS; 4-arm decision NOT-EVALUABLE; sonnet DISQUALIFIED on schema conformance

- **Labels:** 32/32, blind claude-opus-5 via agent-sdk (Amendment 1).
  Ground truth: C=12, not-C=20. Stored-nominal C confirmed 12/16 (75% —
  replicates GA11's over-extraction finding on the frozen sample); stored
  not-C confirmed 16/16 (the false-C problem is one-sided).
- **haiku-base / haiku-patched:** both complete (32/32), IDENTICAL confusion
  counts — TP 12, FP 2, FN 0, TN 18 → P 0.857, R 1.000, F1 0.923. Identical
  C-sets; the 6/32 row-level disagreements are all within not-C classes.
  **The anti-over-extraction patch moved NOTHING on the C boundary for
  haiku on this sample.**
- **sonnet-base / sonnet-patched (via agent-sdk, Amendment 2):**
  STRUCTURALLY INCOMPLETE — 29/32 and 30/32; the 5 missing records failed
  **28/28 attempts** across two days' batches and manual probes. Root
  cause, verified with raw output: on those prompts sonnet deterministically
  emits `class:"A1"` with `criteria: []` — semantically defensible
  (no-eval-needed ⇒ nothing to verify) but the registered parser
  (`refiner.ts:209`) requires non-empty criteria unconditionally. Both
  prompt variants affected. A probe WITHOUT the appended schema instruction
  flipped one record to A2-with-criteria — the conformance failure is
  specific to the real path.
- **Relaxing the parser to admit sonnet was CONSIDERED AND REFUSED** — a
  mid-experiment instrument change to accommodate one candidate arm is
  tuning the bar to the candidate. The parser is the production contract;
  failing it on ~15% of a representative sample is a REAL disqualification
  for a production classifier seat regardless of any F1 it might have
  scored.
- **§3 decision as registered:** all-four-arms evaluation NOT-EVALUABLE
  (two arms incomplete). Within the evaluable set the incumbent is itself
  argmax(F1). **Verdict: INCUMBENT-STAYS — haiku-base remains the
  production classifier.** The Amendment 2 transport asymmetry never
  entered the decision: sonnet disqualified before any cross-model
  comparison was made.
- **Spend:** 32 opus labels + 65 haiku + ~92 sonnet attempts (incl. 28 on
  the 5 non-conforming records) + 5 diagnostic probes — all short
  classification calls, subscription lane.
- Emitted counts: `docs/gauge-cls-ab/yoo-dev-cls-score.json` (provisional
  flag true solely from the structurally-incomplete sonnet arms; F8 drift
  check green on all four arms).

### CORRECTION to the OUTCOME above (2026-08-10, same day, user-caught)

The OUTCOME block's "sonnet DISQUALIFIED on schema conformance" ATTRIBUTED TO
THE MODEL what a 5-call diagnostic then showed to be a PATH effect the model
merely participates in. The user's challenge: the two lanes differ in more
than transport — the sdk path carries the schema OUT-OF-BAND
(`output_config` structured outputs) while the agent path APPENDS THE RAW
SCHEMA JSON AS PROMPT TEXT (`buildAgentOutgoingText`), so sonnet answered a
different prompt than haiku did. Verified against the code, then measured:

- `DERIVATION_SCHEMA`'s own comment already names the designed
  interpretation: structured outputs cannot express `minItems`, so empty
  arrays are legal on BOTH paths and a parse-reject is "an M0 miss, never a
  wrong record" — a MISS, not a disqualification. The OUTCOME's "haiku pads
  criteria" framing was wrong: nothing forces it on either path.
- Diagnostic (haiku through the AGENT path on the 3 unique failing
  records): one of three REJECTED with the identical signature — A1,
  `criteria: []` — on a record haiku completed on the sdk path. A
  WITHIN-MODEL transport effect, single specimen. On the other two, haiku
  filled criteria where sonnet emptied them 28/28 (n=1 per record — noise,
  not a model claim).
- This is the first measured specimen of GA13's DECLARED enforcement
  asymmetry ("the arms can differ in PENDING COUNT") — consistent with the
  §6d pv verdict, which measured classification agreement on conforming
  outputs, not completion rates.

**What stands, on corrected grounds:** verdict INCUMBENT-STAYS is
unchanged — no arm cleared the ≥0.10 F1 bar over the incumbent, and the
sonnet arms are NOT-EVALUABLE on the only lane currently available to them.
**What is withdrawn:** any claim about sonnet-the-model's schema
conformance. The decisive test (sonnet via the sdk path's structured
outputs) stays untestable while the 429 wall stands; if it lifts, 5 calls
settle it. The parse-rejects were the agent lane's declared catch-vs-
prevent asymmetry doing exactly what Amendment 2's honesty bounds
predicted — bounds this author wrote and then failed to apply to his own
conclusion.
