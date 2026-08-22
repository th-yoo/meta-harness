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

> Corrected by Addendum 1 (2026-08-22) — expressible 11 → 7; no rule outcome changed.

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

## Addendum 1 — census corrections from building fix 1 (2026-08-22)

Appended, not rewritten: everything above stands as recorded on the day.
Building fix 1 (the debt-in-suite markers) put every "skip-expressible" row
under a calibration test — active-run-must-FAIL before it may land — and four
of the eleven did not survive that check. Corrections below, with the evidence
that produced each. Plan: `docs/superpowers/plans/2026-08-22-debt-in-suite-markers.md`;
task ledger: `.superpowers/sdd/2026-08-22-debt-in-suite-markers/progress.md`.

### Removed from the expressible-11

- **MH-22 — REFUTED, not a hole.** `docs/loop-probes/f4-retraction-20260820/retraction.md`
  (written 08-20, i.e. BEFORE this census) already retracts the claim the row
  restates: the F4 task's own oracle is `shift = 1e7/x` at the real peak
  (`x = 6327.285 → 1580.46`), which lands under **plain `reciprocal`, already
  in the whitelist and already accepted**. The two-op composition was the
  models' fabrication, and the op built to accept it (`offset-reciprocal`,
  `5e3df53`) was reverted (`5982a08`) as an answer key. Row `census.md:70` is
  an unreconciled carry-forward of `resume.md:462-465`. What survives is the
  narrow, general fact that `applyTransform` cannot express a composed
  transform — true, but with no live task class requiring it, so nothing to
  calibrate a marker against. Task M4 parked with no commit, correctly.
- **MH-12 — UNBACKED, therefore not expressible.** This verdict's line 20
  claims "0.63/0.65 inputs exist". They do not. The row's own cited
  environment (`docs/loop-probes/dnc-second-fixture-20260820/`) contains no
  `0.63`, no `0.65`, no "bad list entries" and no "wrong transform" in any
  file — that probe pair documents a different finding (F1, the derived-delta
  serving two purposes). The numbers trace to exactly one source,
  `docs/resume.md:220-222`, a narration sentence with no pre-registration, no
  fixture, no runner, no truth file and no verdict behind it; `census.md:60`
  and this verdict quote it downstream. Only the two OUTPUT scores were ever
  recorded; the inputs behind them were not, so a marker could only be written
  by inventing them. Task M6 parked with no commit, correctly. MH-12 stays an
  open recorded item, but it moves to the not-skip-expressible side —
  specifically as a **recording-layer debt**: the fixture that produced those
  scores must reach the repo (per CLAUDE.md's shareable-artifacts rule) before
  the diagnostic-layer hole can be pinned at all.
- **DOG-1a and DOG-1b — VERIFIED CLOSED in the subject repo.** The census
  classified both from kkamak's `docs/dogfood-log.md:504-522` and recorded at
  `census.md:154` that they were **undatable because `~/z2/cc-api-daemon` was
  not checked out for the collection**. Task D1 checked it out and verified
  directly (cc-api-daemon `dcc1c91`): DOG-1a — `grep -rn "\.skip\|skipIf" test/`
  returns only `describe.skipIf(GATE_FAST)` sites (warm-session.test.ts:92,359,567;
  lane-parity.test.ts:50,233; acp-daemon.test.ts:1652), zero unconditional
  `.skip`, and the env-conditional pattern is contract-documented in
  warm-session.test.ts's header; DOG-1b — `daemonCall`/`closeSession`/`ensureDaemon`
  have exactly one definition each (`src/acp-client.ts:134,395,493`, re-exported
  once from `src/index.ts:23`), the in-process twin having been deleted by
  `0d8a0eb`, which `src/call.ts`'s header documents in place. These were never
  verified holes; they were unverifiable rows, and verification closed them.

### Scope refinements (count unchanged, but the rows as written are no longer accurate)

- **KI-9** — the specific instance the row describes (the `from`-based
  `importsIn()` false positive on `file-state-store.ts`'s "old and merely /
  slow" prose) no longer reproduces: the quoted-namespace fix's quote-exclusion
  closed that bridging shape as a side effect. Issue #9 remains open through
  its **addendum** instance — `COMPUTED_CALL_PATTERN` is comment-blind by the
  same root cause, with two reword-to-pass events on record (`registry.ts`,
  `cli-spawn.ts`). The landed marker pins that, under the same census id.
  Calibration: active run failed with `[["import (r"]]`. (`known-issues.md` #9's
  main body is now stale for the `from`-based scanner and needs its own doc
  correction — recorded here, not repaired here.)
- **MH-21** — the marker landed and is calibration-proven, but the
  contradiction's live surface is the **O3 arm, which F3's verdict did not
  adopt** (O2 shipped). The marker's comment therefore records both
  resolutions: (a) the parser learns the derivation column → unskip; (b) the
  O3 shape stays retired → do NOT unskip, delete or re-point the marker with a
  reason. Counted as one open hole, conditionally.

### Corrected counts

| | as recorded | corrected |
|---|---|---|
| open/partial census items | 44 | 41 (−DOG-1a, −DOG-1b closed; −MH-22 not a hole) |
| skip-expressible | 11 | **7** (KI-9, KI-13, KI-14, MH-1, MH-3, MH-21, MH-24) |
| not skip-expressible | 33 (75%) | 34 (82.9%) — MH-12 moves across |

Arithmetic note for future readers: the −2 (DOG) and the −2 (MH-22, MH-12)
corrections are independent and compose; 11 → 7, not 11 → 9.

### No frozen decision changes

Re-running the rule exactly as frozen, on the corrected numbers:
- (i) ≥3 open skip-expressible: **still PASS** (7 ≥ 3).
- (ii) unchanged: **FAIL** (0 strict silent-fires beyond KI-8).
- (iii) inexpressible <50% of census: **still FAIL**, and more harshly
  (82.9% vs the recorded 75%) — the same denominator artifact already noted
  above, now with two fewer expressible rows in the numerator's complement.

The frozen outcome clause therefore still reads **build fix 1 only, drop fix 2**,
and fix 3 remains unjustified. The corrections tighten the scope of fix 1's
target list; they change no gate. The 75%→82.9% move is also the honest
direction of this probe's own finding: three of the eleven "expressible" rows
were expressible only on paper, and one was already fixed — a census can
overstate its own instrumentability, and calibration is what catches it.

### What actually landed (fix 1, as scoped by the corrections)

Seven open expressible holes, seven calibrated markers, 1:1 — every one
active-run-FAIL proven before being flipped to `test.skip`:

| id | marker | commit |
|---|---|---|
| MH-1 | `opencode-plugin/test/known-holes.test.ts:13` | `a088b5a` (meta-harness, `worktree-debt-markers`) |
| MH-3 | `known-holes.test.ts:61` | `2dde3d7` |
| MH-21 | `known-holes.test.ts:93` | `709a644` (+ `7d709c3`, both-branch comment) |
| MH-24 | `known-holes.test.ts:134` | `3e299cc` |
| KI-9 | `test/imports.test.ts:414` | `20fc2ad` (kkamak main) |
| KI-13 | `test/oneshot-dogfood-hook.test.ts:80` | `d12e56c` |
| KI-14 | `test/extensions-registry.test.ts:150` | `108c4eb` |

Convention line in all three repos: meta-harness `a088b5a`, kkamak `20fc2ad`,
cc-api-daemon `dcc1c91` (convention-only — no marker needed, both its rows
verified closed). No production code changed in any repo.
