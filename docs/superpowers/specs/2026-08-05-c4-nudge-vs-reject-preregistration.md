# C4 nudge-vs-reject experiment — pre-registration (2026-08-05)

**Status:** DRAFT, pre-data. Written before any C4 label exists (channel
base-rate run armed but not yet fired — `scripts/channel-chain.sh`).
Constants freeze at the first experiment datum. Open rulings in §6.
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
- **reject**: prompt + a hard-reject context (verbatim text fixed in §6
  ruling 2 before any call): the model must refuse to begin work and
  instead return a restated goal with a measurable exit, mirroring
  goal-setting-skill's contract (Three Pillars: boolean exit,
  transcript-demonstrable, bounded).

Then one classification call per response (same channel classifier, opus):
does the RESPONSE state a falsifiable completion criterion (maps C1/C2/C3)
or none (C4)?

**Total calls: 6 × |C4|** (3 response + 3 classification per prompt).
Sized go computed and reported after the base-rate run lands; no spend
before that go.

## 4. Outcome metrics (mechanical, pre-registered)

- **conversion(arm)** = fraction of arm responses classified C1/C2/C3
  (criterion established).
- **work-loss(reject)** = fraction of reject-arm responses that refused
  AND whose control twin produced a substantive answer (proxy for the
  over-refusal cost a hard reject would impose on live sessions; counted
  mechanically from the classifier's refusal field — §6 ruling 3 fixes the
  field definition).
- Script-tally only; notes never quoted (gauge standing rule).

## 5. Decision rule (pre-registered, proposed — §6 ruling 4 may amend)

- **Nudge sufficient**: conversion(nudge) − conversion(control) ≥ 0.30 AND
  conversion(nudge) ≥ 0.60 → nudge arming proceeds on the ladder spec's
  own bars; no reject mechanism built.
- **Reject earns a design** (not a deploy): conversion(reject) −
  conversion(nudge) ≥ 0.20 AND work-loss(reject) ≤ 0.10 → a reject-mode
  design doc may be WRITTEN (cheap, reversible); deployment needs its own
  ruling since it breaks the fail-open family rule.
- Anything else → nudge stands as shipped, findings recorded, no build.
- The two clauses are independent; both can fire (nudge sufficient AND
  reject better) — then nudge ships first and the reject design waits for
  live nudge data.

## 6. Open rulings (user) — must close before first experiment call

1. Response-arm model tier: haiku (unwalled, cheap; declared limitation:
   live sessions run stronger models, conversion may differ by tier) vs
   opus (matches live, premium-walled). PROPOSED: haiku with limitation
   declared.
2. Verbatim reject-context text (draft to be appended pre-data).
3. Refusal-detection field definition for work-loss (classifier output
   extension vs separate mechanical check).
4. Bars in §5 (0.30/0.60/0.20/0.10) — accept or amend BEFORE data.
5. k per arm (k=1 single response vs k=3 majority) — PROPOSED k=1 for
   cost; noise acknowledged.

## 7. What this experiment cannot do

Cannot measure live-session conversion (corpus replay only; live arming
data comes later via the ladder spec's own over-refusal window). Cannot
license pooling any of its counts with gauge sensor streams. Cannot
unshadow anything. A reject-arm win here does NOT deploy a reject — it
buys a design document, nothing else.
