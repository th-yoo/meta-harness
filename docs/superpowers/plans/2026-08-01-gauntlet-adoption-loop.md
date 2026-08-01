# Gauntlet adoption loop — evaluate Gauntlet applications BY Gauntlet Loop

**Status:** ACTIVE (user go 2026-08-01: "for each application create branch;
if works merge + document why; else drop + document why" + "adapt Gauntlet
Loop to us to plan/evaluate/adopt-drop").
**Method credit:** Matt Shumer's Gauntlet Loop (somethingbig.ai/gauntlet-loop),
adapted to meta-harness evidence discipline.
**Lane:** evolution-loop machinery (minimal/, opencode-plugin/) + plugin seam
(cc-gate-plugin/src/reinject.ts). NOT the frozen kernel (F1 untouched), NOT
gauge measurement semantics.

## The adaptation (Gauntlet primitive → our mechanism)

| Gauntlet primitive | Here |
|---|---|
| Lead agent owns goal, splits work | orchestrating session; one loop per application |
| Concrete reference bar | pre-registered decision rule + RECORDED ground truth (bench verdicts, rejected.json fates) — bar fixed BEFORE build, below |
| Builder | subagent implementing on a dedicated branch |
| Fresh-context critic | separate subagent; sees spec + bar + artifact + eval data ONLY — never builder reasoning. Builder NEVER grades itself |
| Biggest-remaining-gap feedback | critic names ONE largest gap; builder fixes; **max 2 rounds** (parity with gate.json rounds:2), then verdict as-is |
| Blind A/B vs reference | replay/paired evals against recorded outcomes |
| Human as brake | user reads verdict ledger; merge executed only on critic PASS |
| Smoothing pass | final cross-branch integration review before ledger seal |

## Loops (one per application)

### Loop A — S-A reviewer reference-bar (`branch gauntlet-sa-review-bar`)
- **Build:** `minimal/review.ts`: (E1) review verdict carries ranked
  `biggestGap` — single largest failure, evidence-quoted — consumed by the
  revise seat; (E2) new evidence-forced rubric key `null_precedent`:
  reviewer receives the rejected-null ledger as REFERENCE, must QUOTE the
  closest null-rejected bullet and WRITE the mechanism that distinguishes
  the candidate, else FAIL. Code-computed conjunction preserved; confidence
  stays advisory.
- **Bar (pre-registered):** retrospective replay over historical candidates
  with known bench fates. EMPLOY iff new reviewer (a) FAILs ≥2 of the 3
  null-at-bench bullets (rejected.json #0,#1,#2) AND (b) does NOT FAIL the
  known-good set (v9 sparql-certified bullet; active v7-era accepted
  content). Ties/abstains count as not-FAIL. Else DROP.
- **Spend:** ~8-12 one-shot review calls (opus-5) — covered by user go.
- **Critic:** fresh subagent runs the replay, tallies vs bar, names biggest
  gap if FAIL.

### Loop C — S-C seed reference-bar content (no new branch)
- **Build:** rides Path A tournament Stage 0 (its own go): exactly one of
  S1-S3 authored gauntlet-shaped (explicit quality bar + verify-before-done
  + biggest-gap iteration in seed text); others not.
- **Bar (pre-registered):** the tournament verdict machinery itself —
  screen k=1 w/ concurrent v7 arm → confirm k=5 McNemar → guards. EMPLOY
  iff gauntlet-shaped seed is the certified winner; DROP the shaping (not
  the tournament) otherwise.
- **Status:** DEFERRED to tournament execution (office). Decision rule
  sealed here so it cannot be post-hoc.

### Loop D — S-D proposer gap-targeting (`branch gauntlet-sd-proposer-gap`)
- **Build:** `minimal/propose.ts` prompt: proposer must rank observed
  failure gaps from evidence and attack exactly the LARGEST with one
  general edit, citing which gap and why largest.
- **Bar (pre-registered):** paired-on-same-evidence: same run-records, old
  vs new prompt, one candidate each, both reviewed by the ACTIVE reviewer.
  EMPLOY iff new-prompt candidate (a) passes review in ≤ rounds of
  old-prompt candidate (non-inferiority) AND (b) names a ranked gap
  traceable to the evidence. DROP if reviewer fails it and passes old.
  Inconclusive (both fail / both pass with equal rounds and no gap cited)
  → 1 repeat pair, then verdict.
- **Spend:** 2-4 proposer calls + 2-4 review calls (opus-5).

### Loop F — S-F reinject v2 wording (`branch gauntlet-sf-reinject-v2`)
- **Build:** `cc-gate-plugin/src/reinject.ts`: v2 variant — biggest-gap
  line composed FIRST from rawOut (single decisive failure named), then
  tail excerpt, then ownership sentence; arm added to deterministic hash
  rotation + score-cli split; tests. F1-safe by construction (seam layer,
  §4.4 precedent).
- **Bar (pre-registered):** CANNOT be judged yet — blocked-cycle flow ≈
  8/2.5wk, fixtures = 0. Branch verdict rule: (interim) fresh-context
  code critic must PASS correctness/tests to keep branch OPEN; (final)
  EMPLOY iff fixture-replay k=5 paired McNemar on ≥3 harvested fixtures
  favors v2 on rounds-to-accept/exhausted-rate, or live arm n≥20 blocked
  cycles reaches the same. Mid-data note: v0/v1 at n≈5 armed events —
  adding v2 = amendment to §4.4 registration, flagged for user ruling
  BEFORE merge (merge ≠ arm activation; env kill switch stays).
- **Status:** build + hold OPEN. No employ/drop verdict until evidence
  lane arms.

### Phase 2 — agent-node Evaluator (spec only)
No branch. One doc edit on main: write the gauntlet-Evaluator vs
plain-Evaluator bench comparison into the fleet spec as a pre-registered
future experiment. Employ/drop deferred to fleet existence.

## Ledger
Verdicts + rationale land in `docs/2026-08-01-gauntlet-adoption-ledger.md`
(employ/drop/open per loop, evidence quoted). Merges: solo-dev direct to
main after critic PASS + per-task review. HISTORY row on program seal.

## Bounds
- ≤2 gap-feedback rounds per loop, then verdict as-is (no round inflation).
- No bench spend beyond listed one-shot calls without a new sized go.
- Bars above are frozen; changes = pre-data amendment recorded here.
