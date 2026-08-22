# Verdict — debt-instrument probe (2026-08-22)

Registration: `pre-registration.md` (committed 7e9f65a BEFORE census).
Census: `census.md` (collector-verbatim, 63 items; commit hashes pinned inside).
Classifier: controller session, rubrics as frozen. Ambiguity counted AGAINST
the fixes throughout, per registration.

## Probe B classification — skip-expressibility of items open today

Skip-expressible (rubric: runnable test names the specific hole, fails/skips
while it exists, suite env suffices) — **11**:

| item | hole the test would name |
|---|---|
| KI-9 | import scanner matches prose in comments (false positive is reproducible in a fixture) |
| KI-13 | oneshot marker count blind to indirect writes |
| KI-14 | multi-extension flush ordering (two fake extensions in registry → order assertion) |
| MH-1 | project-global transition wipes mh-build's .km tables (scratch-store export test) |
| MH-3 | `--layers none` discards trajectories despite `--save-all-traj` |
| MH-12 | residual-pattern diagnostic blind to the two known bad list entries (0.63/0.65 inputs exist) |
| MH-21 | F3: prompt-conformant cell fails the parser (contradiction is a concrete input) |
| MH-22 | F4: a correct multi-op audit is rejected by the single-op whitelist (breaking input exists) |
| MH-24 | F6: head/tail near-match absent — the probe's own fabricated-landing inputs are the failing cases |
| DOG-1a | cc-api-daemon: disabled tests linger (already realized there as a grep-requirement — independent convergent design) |
| DOG-1b | cc-api-daemon: duplicate implementations of same three names (mechanically greppable) |

Not skip-expressible — **33** of 44 open/partial. Probe C classes:
- **queued work / "own go" tasks (not holes): 17** (MH-6,7,8,10,11,13,17,18,19,27,29,31,35,37,38,39 + MH-14 arming go)
- **process/environment-dependent: 6** (MH-2 shared-checkout two-session, DEBT-2 real-install cache, DEBT-3 private-repo citations, MH-20/36 push-goes, DOG-2 reword-to-pass recurrence)
- **probes needing model/vision env: 2** (MH-32, MH-33)
- **wishes / measurement wants: 3** (MH-40 coverage metric, MH-9 ownership, REM-2 speculative note)
- **meta/umbrella rows: 4** (MH-4, MH-25, MH-26, MH-28)
- **ambiguous → counted against: 1** (KI-10 — design-change judgment, no concrete failing case quoted)

## Probe A — conditioned deferrals that fired silently

- **KI-8: the anchor.** Condition verbatim, fired 2026-07-30 13:48 (adapters
  landed ~3.5h after the deferral was written), revisited 2026-08-11 —
  **12-day silent window**, ending in the defect that motivated this probe.
- **DEBT-1: ambiguous — against.** Stated condition IS the human act (circular,
  not a watchable precondition). The enabling event (tag cut) fired 08-05,
  runbook ran 08-11 (6 days, 5 defects found late) — real cost, but fails the
  verbatim-stated-precondition bar.
- **MH-34: inferred condition, not verbatim — against** (collector flagged it).
- **MH-5: 9-minute window — no silent firing.**
- **DOG-1a: same failure class confirmed** ("nothing enforced the
  re-enablement"), but the disable→re-enable dates were not cleanly extractable
  in bounded effort — **ambiguous, against**.

**Strict count of verbatim-condition-fired-silently beyond KI-8: 0.**

## Decision rule, applied as frozen

- (i) ≥3 open skip-expressible: **PASS** (11 ≥ 3)
- (ii) ≥1 historical silent-fire beyond KI-8: **FAIL** (0 strict; 2 same-class
  ambiguous instances recorded, both counted against per registration)
- (iii) inexpressible <50% of census: **FAIL** (33/44 = 75%)

Frozen outcome clause: "(i) holds but (ii) fails → **build fix 1 only, drop
fix 2** (watchers have no second confirmed target — n=1 pattern-match)."

**Registered-rule artifact, recorded not repaired:** the fix-1-only clause as
frozen does not reference (iii); applying the rule as written, (iii)'s failure
does not veto fix 1. Noted honestly: (iii)'s 75% is dominated by queued-work
rows the census legitimately collected but which are not holes — the
denominator construction made (iii) harsh. The rule stands as frozen; the
number is reported as measured.

## VERDICT

**Build fix 1 only, scoped:** the debt-in-suite convention (test.skip /
test.todo naming the hole) applied to the 11 expressible items above — not a
blanket policy over all recorded debt (75% of it is not hole-shaped and the
instrument cannot express it; writeup says so with numbers).

**Fix 2 (revisit-condition watchers): DROPPED by rule** — one confirmed target
in the entire two-repo history. The census's own evidence: most deferrals
(14 of 15 conditioned items) either resolved fast, had circular conditions, or
were never verbatim-conditioned at all.

**Fix 3 (invariant obligation) / probe D: NOT justified for spend** — the
root-cause chain that motivated it (trace-scoped fix) has its one instance in
KI-8, already covered by fix 1's expressible class (the residual window was
skip-expressible at fix time). No further evidence accrued.

**Independent convergence noted:** cc-api-daemon independently invented fix 1's
enforcement half (skip-grep plan requirement) after being bitten by the same
class — the only other repo in the fleet with the problem built the same
instrument.
