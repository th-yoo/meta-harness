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
complexity of the prompt.

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
