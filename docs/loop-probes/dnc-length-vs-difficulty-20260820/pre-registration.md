# Pre-registration — length-induced vs difficulty-induced failure (2026-08-20)

## Question

Do TB2 failures carry the signature D&C (divide & conquer) can address —
**length-induced error** (context overload: dropped items, position-dependent
mistakes, degradation late in a long trajectory) — or are they
**difficulty-induced** (wrong approach / missing capability, independent of
input length)? Sibling-lane prerequisite for any level-2 harness
orchestration: *if failures are difficulty-induced, a harness map-reduce stage
is null before it is built.*

## Corpus

All failed sessions with a stored trajectory across
`term-bench2/store/global/candidates/*/`: **196 failed** (of 279 failed
sessions; the rest have no traj). 16 passed sessions with trajs are used only
for a within-task byte-size contrast. Mixed models (recorded per session from
`score.json`); mixed candidate versions — this is a *descriptive* sweep over
everything available, not a controlled comparison.

## Disclosure (what was seen before this registration)

- Aggregate event-type counts across all trajs (`text`/`tool`/233 unparseable
  lines) and the tool-name histogram.
- The first ~800 bytes of ONE traj (`v14/bench-raman-fitting-1787041847-e30ac8`).
- `v14/score.json` head (one session record).
No per-session metrics, no distributions, no other traj content.

## Mechanical metrics (script-computed, per failed session)

- **M1** turnCount (from `score.json`)
- **M2** traj file bytes
- **M3** cumulative tool-output bytes (the context-pressure proxy)
- **M4** tool-error count; **M5** position of the LAST tool error as a
  fraction of the traj's event count (0..1)
- **M6** thrash: number of normalized command keys (tool name + first 60
  chars of args, whitespace-collapsed) occurring ≥3 times in the session
  with ≥2 of those occurrences in the final third of events
- **M7** explicit truncation/context marker in tool OUTPUT fields only —
  literal substrings `output truncated`, `context low`, `[truncated`
  (case-insensitive; narrow on purpose: task file content must not false-hit)
- **M8** empty/timeout class: turnCount == 0 OR traj has < 3 events

## Classification rules (priority order, per failed session)

1. **EXCLUDED** — M8 (the invisible-timeout class; reported separately,
   never classified).
2. **LENGTH-hard** — M7 present, OR (M3 in the top quartile of the failed
   corpus AND M5 ≥ 0.75: heavy context AND failing late).
3. **LENGTH-thrash** — M6 ≥ 1. Reported as its OWN class because late
   repetition is a contestable signature: context degradation (forgetting
   earlier attempts) or pure stuck-ness. The verdict reports LENGTH share
   both with and without this class (sensitivity).
4. **DIFFICULTY** — M3 below the failed-corpus median AND M6 == 0 AND no
   M7: short, clean, still wrong.
5. **AMBIGUOUS** — everything else.

Quartile/median cutoffs are computed from the failed corpus itself.

## Within-task contrast

For every task with ≥1 passed traj AND ≥1 failed traj: mean M2 and M3,
passed vs failed. Fails systematically heavier than passes = corroborating
length signal; equal or lighter = corroborating difficulty.

## Decision rule (pre-registered)

Over classifiable failures (non-EXCLUDED):

- LENGTH share (hard + thrash) **< 15%** → **level-2 orchestration NULL** —
  do not build; D&C investment stays at playbook level 1.
- LENGTH share (hard only) **≥ 30%** → **level-2 ALIVE** — licenses only the
  next cheapest measurement (a controlled split-vs-whole probe), never a
  build directly.
- Otherwise → **INCONCLUSIVE**; report per-task breakdown and stop.

## Caveats (bound the claim)

Proxies, not ground truth: no metric here observes the model's attention.
A LENGTH verdict is a licence for the next measurement, not evidence D&C
works; a NULL is stronger (absence of even the proxy signature). Mixed
models/candidates mean per-task shares, not pooled shares, carry what
transfer signal exists. Zero model spend; script-tally counts, never quoted
impressions.
