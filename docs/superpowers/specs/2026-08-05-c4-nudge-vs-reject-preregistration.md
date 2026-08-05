# C4 nudge-vs-reject experiment — pre-registration (2026-08-05)

**Status:** REGISTERED, pre-data — all §6 rulings closed 2026-08-05
(brainstormed + ratified before any C4 label exists; channel base-rate
run armed but not yet fired — `scripts/channel-chain.sh`). Constants
freeze at the first experiment datum; until then amendments remain legal
and must be recorded in place.
Motivating comparison: goal-setting-skill (external) hard-REJECTS
unverifiable goal prompts at authoring time; our gauge C4 nudge
(ladder spec 2026-08-03, `nudge.ts`) soft-nudges and never blocks. This
experiment measures whether the soft nudge is sufficient or a harder
mechanism is warranted — with data, not taste.

## 1. Question

For prompts classified **C4** (no falsifiable completion criterion in the
prompt's own text), does injected guidance change whether the model's
RESPONSE establishes a falsifiable criterion — and does a reject-style
injection outperform the shipped soft nudge enough to justify breaking the
fail-open family rule?

## 2. Population

The C4-labeled subset of the corpus A2/D pool (301 records), as labeled by
the channel base-rate run (`replay-cli channel --go 301`, opus, instrument
smoke-verified at bar ≥9/12 + nudge proof BEFORE labeling — enforced
mechanically by `channel-chain.sh`). Population size |C4| is unknown
pre-data by construction. If |C4| < 10 the experiment is VOID for power and
only the base rate is reported (pre-declared, mirrors §6d power clause).

## 3. Design — three arms, corpus replay, F2

Per C4 prompt, three response-generation calls (corpus-replay style: the
prompt text never leaves the host; counts travel):

- **control**: prompt verbatim, no injected context.
- **nudge**: prompt + the shipped `buildNudgeContext("C4")` text as
  additionalContext (byte-identical to production `nudge.ts` — this arm
  measures the ACTUAL shipped mechanism, not a paraphrase).
- **reject**: prompt + the hard-reject context fixed VERBATIM by ruling 2
  (2026-08-05, pre-data). It shares the nudge's diagnostic clause
  byte-for-byte so the arms differ by policy, not wording quality:

```
kkamak gauge: this prompt states no verifiable completion
criterion (no programmatic check, no LLM-judgeable condition,
no human-decidable condition in the prompt's own words).
Do NOT begin the work. Reply ONLY with:
(1) the goal restated with a measurable, verifiable exit —
    name the artifact and the observable property that will
    hold when done;
(2) an explicit bound (turn cap or budget);
(3) a request for the user to confirm before any work starts.
```

**Response model (ruling 1):** haiku for all C4 prompts, PLUS the same
three arms on opus over a fixed random 10-prompt C4 subset (seeded from
the base-rate run's record ordering — declared here so the subset is not
cherry-picked post-hoc). The haiku↔opus subset comparison is a declared
tier-sensitivity read; live sessions run opus-class, haiku conversion is
the acknowledged proxy. **k = 1 response per arm per prompt (ruling 5)** —
single-draw noise acknowledged; the design-doc-only consequence and the
opus subset are the declared protections.

Then one classification call per response (same channel classifier, opus —
the smoke-verified instrument, byte-unchanged; ruling 3 explicitly rejects
extending it): does the RESPONSE state a falsifiable completion criterion
(maps C1/C2/C3) or none (C4)?

**Total calls: 6 × |C4| + 60** — per C4 prompt: 3 haiku responses +
3 opus classifications; plus the opus subset: 10 × 3 responses +
10 × 3 classifications (all opus). Sized go computed and reported after
the base-rate run lands; no spend before that go.

## 4. Outcome metrics (mechanical, pre-registered)

- **conversion(arm)** = fraction of arm responses classified C1/C2/C3
  (criterion established).
- **disobedience(reject)** (ruling 3, replacing the original work-loss —
  which was vacuous: an OBEDIENT reject always refuses by construction) =
  fraction of reject-arm responses that ignored the refuse instruction,
  detected MECHANICALLY, zero model calls: a response disobeys iff it
  lacks all three demanded markers `(1)`/`(2)`/`(3)` OR contains a fenced
  code block (``` ) — i.e. it started doing work instead of restating.
  Crude by declaration; counts only.
- **Over-refusal cost is explicitly OUT OF SCOPE here** (ruling 3): every
  prompt in the population is already C4-labeled, so this experiment
  cannot observe reject firing on a good prompt. That cost lives in the
  ladder spec's live over-refusal window (N=30, §6-bar direction), where
  it is actually measurable.
- Script-tally only; notes never quoted (gauge standing rule).

## 5. Decision rule (RATIFIED ruling 4, 2026-08-05, pre-data)

- **Nudge sufficient**: conversion(nudge) − conversion(control) ≥ 0.30 AND
  conversion(nudge) ≥ 0.60 → nudge arming proceeds on the ladder spec's
  own bars; no reject mechanism built.
- **Reject earns a design** (not a deploy): conversion(reject) −
  conversion(nudge) ≥ 0.20 AND disobedience(reject) ≤ 0.10 → a
  reject-mode design doc may be WRITTEN (cheap, reversible); deployment
  needs its own ruling since it breaks the fail-open family rule.
- Anything else → nudge stands as shipped, findings recorded, no build.
- The two clauses are independent; both can fire (nudge sufficient AND
  reject better) — then nudge ships first and the reject design waits for
  live nudge data.
- Bars apply to the haiku (full-population) counts; the opus subset is
  reported alongside as the tier-sensitivity read and moves no bar.

## 6. Rulings — ALL CLOSED 2026-08-05 (pre-data, brainstormed + ratified)

1. Response-arm tier: **haiku full population + opus fixed random
   10-prompt subset** (tier-sensitivity read; subset seeded from base-rate
   record ordering). §3 carries the mechanics.
2. Reject-context text: **fixed verbatim in §3** (refuse-and-restate,
   nudge-prefix-matched).
3. Refusal detection: **work-loss dropped as vacuous; mechanical
   disobedience check** per §4; classifier prompt stays byte-unchanged
   (extending it would invalidate the smoke verification); over-refusal
   deferred to the ladder's live window.
4. Bars: **accepted as proposed** (0.30 / 0.60 / 0.20 lift / 0.10
   disobedience cap), §5.
5. k: **k=1**, single-draw noise acknowledged.

## 7. What this experiment cannot do

Cannot measure live-session conversion (corpus replay only; live arming
data comes later via the ladder spec's own over-refusal window). Cannot
license pooling any of its counts with gauge sensor streams. Cannot
unshadow anything. A reject-arm win here does NOT deploy a reject — it
buys a design document, nothing else.
