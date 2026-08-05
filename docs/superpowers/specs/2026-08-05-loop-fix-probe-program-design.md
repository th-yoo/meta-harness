# Loop-fix probe program — design + P0/P1 pre-registration (2026-08-05)

**Status:** REGISTERED, pre-data for P0/P1. P2 is a named placeholder with a
contract, NOT pre-registered here (it spends; it gets its own spec after P0).
Constants for each probe freeze at that probe's first datum.

## 0. Context — what is being fixed, and how fixes get chosen

The 2026-08-05 diagnosis (kkamak-repo session, cross-checked against this
repo's own verdicts: loop-1 provable null with lesson ignored 7/8; loop-2
no-lift called early; the event-starvation roadmap note) named five causes
for the self-improving loop not turning:

- **A** — actuator doesn't bind (prose advice loses to model priors)
- **B** — outcome variable nearly constant (`accepted` always true;
  catches resolve round 1)
- **C** — event starvation, worse with work depth (one Stop = one event)
- **D** — instrument blind to non-breaking defects (green ≠ good)
- **E** — rigor priced above the evidence rate (bars unreachable at
  ~10 events/day)

Each cause has SEVERAL candidate fixes and no principled way to pick by
argument. This program picks by measurement: free probes first, spend
probes later, the architecture decision made from numbers. The user rules
on every adoption; nothing here self-adopts.

**Probe registry:**

| id | cause | cost | status |
|----|-------|------|--------|
| P0 signal-variance audit | B | zero model calls | pre-registered §1 |
| P1 event-density counters | C | zero model calls | pre-registered §2 |
| E computation | E | arithmetic only | defined §3, runs after P0+P1 |
| P2 actuator-binding probe | A | model spend | contract §4, own spec later |
| P3 channel program | D | in flight | foreign to this spec (ladder + the ladder's C4 nudge-vs-reject pre-regs) |

## 1. P0 — signal-variance audit (pre-registered)

**Question:** which candidate outcome signals actually vary? A signal with
no variance cannot rank candidates regardless of volume; dead signals are
eliminated before any probe spends.

**Candidate signals and their mechanical computation (all from EXISTING
data — zero model calls):**

- **B1 gate-outcomes** — `accepted`, `rounds` length, `gateExhausted`,
  `durationMs` from `.km/gate-outcomes.ndjson` on this repo (office
  `yoo-dev` stream only — host-local, stated to avoid a silently
  host-biased set), and read-only from `~/z2/kkamak/.km/` as a FOREIGN
  stream. Attribution (architect review finding 1): the foreign stream's
  `pluginVersion:"0.2.1"` lines are NOT one bucket — they split at that
  repo's SDK-transport boundary ts 1785711630125 (ledger §6c:
  CLI-transport vs sdk-transport regimes, ledger itself orders SPLIT).
  Every regime reported separately; nothing pooled.
- **B2 review findings** — findings-count per review from committed
  `docs/reviews/*.md` (`findings-count:` field, 10/10 files carry it;
  grounded value set at spec time: {3, 1, 16, 0, 0, 0, 12, 9, 0, 1} —
  n=10 exactly, zero margin over the viability n-floor, fragility
  declared). SDD-ledger severity lines (`.superpowers/sdd/*/progress.md`)
  are SECONDARY and DESCRIPTIVE ONLY: gitignored/host-local (this repo's
  own CLAUDE.md rule — not reproducible cross-host) and free-text with
  ≥4 observed phrasings; they enter no viability computation unless a
  parse rule is pre-registered first. No other numbers are asserted.
- **B3 gauge class/channel distribution** — descriptive import of
  `bun cc-gate-plugin/src/gauge/replay-cli.ts report` output (A1/A2/B/C/D
  counts by provenance; store under `~/.config/kkamak/`), and, when the
  armed chain lands them, channel labels. No new classification here.
- **B4 TB2 band pass@k** — ONLY artifacts with per-task repeat arrays
  qualify (architect review finding 5): at spec time that is
  `term-bench2/store/global/candidates/v1/ab-verdict.json` (17 tasks ×
  k=2) alone. Partial/early-stopped artifacts (`v2`, `v3` partials) and
  k=1 `score.json` aggregates are EXCLUDED — no k-mixing, no
  complete/partial pooling. If that leaves n < 10 task-level
  observations with variance, B4 reports UNKNOWN.

**Viability rule (pre-registered, amended per architect findings 4 +
round-2 N2/N3/N4). One clause per §3 signal family — the two taxonomies
must not diverge:** a signal is VIABLE iff (i) n ≥ 10 existing
observations, (ii) its family-specific spread floor holds:

- boolean → minority class count ≥ 3 (literal nonzero variance does not
  pass a 1-in-478 degenerate skew, which is cause B's own shape);
- categorical → second-most-frequent class count ≥ 3;
- count (numeric) → sd/mean ≥ 0.1; if mean = 0 the signal is NON-VIABLE
  by definition (no events observed), independent of sd;
- rate → the underlying binary trials have ≥ 3 successes AND ≥ 3
  failures across the observation set (B4: task-level passes/fails);

and (iii) its per-event acquisition cost is stated and bounded (B1: free
rider on gated Stops; B2: one review dispatch; B3: classifier call; B4:
one bench run). The floors (3, 0.1) are pre-registered constants the
user may amend pre-data, same standing as §3's bar. Signals failing
(ii) or (iii) are EXCLUDED from P2's outcome design. n < 10 → UNKNOWN,
not viable, not excluded — may re-enter when data exists.

**Output:** `docs/loop-probes/<hostname>-p0-signal-variance.json` —
per-signal n, distribution summary (counts per value or
mean/sd/min/max), viability verdict. Counts and stats only (F2: no
prompt/note text). Committed.

## 2. P1 — event-density counters (pre-registered)

**Question:** how many evidence events per day does each candidate source
actually generate on live work?

**Window:** the 7 calendar days ending at run time, both hosts where the
data travels (git history travels; `.km` streams are host-local — the
office host's stream is read here, the MacBook's only if its snapshot was
committed).

**Sources and their mechanical counts (ids S1-S4 — renamed from C1-C4 to
avoid colliding with the channel ladder's C1-C4; architect finding 13):**

- **S1 gated Stops/day** — gate-outcomes lines per day (existing stream).
- **S2 commits/day** — `git log --since` count on this repo + `~/z2/kkamak`.
  This PROXIES a per-commit hook source without building it: if S2 wins,
  the hook gets built; the probe itself is `git log` arithmetic.
- **S3 review passes/day** — count of committed `docs/reviews/*.md` per
  day, dated by GIT AUTHOR DATE of each file's ORIGINAL adding commit
  (`git log --follow --diff-filter=A --format=%aI -- <file> | tail -1`
  — tail pins the oldest add when rename/re-add chains emit several
  lines; never filesystem mtime — host-local timestamps are the trap
  this repo's CLAUDE.md names). DECLARED CRUDE: manual dispatches only; a
  scheduled-sweep source would multiply this at will, so S3's number is a
  floor, not a ceiling.
- **S4 post-two-tier turn shift** — gated Stops/day and `durationMs`
  distribution split at instrument boundary ts 1785888548054 (this repo,
  never pooled across; descriptive read of whether cheap Stops actually
  shortened turns yet — 14 post-boundary lines exist at spec time,
  reported as-is).

**Output:** `docs/loop-probes/<hostname>-p1-event-density.json` —
events/day per source per repo, window bounds, boundary splits. Committed.

**No verdict rule of its own** — P1 feeds §3.

## 3. E computation (arithmetic, no probe)

For each (signal from P0-viable) × (source from P1): compute days-to-verdict
for a two-arm comparison at MIN_N = 20/arm across effect sizes
{0.10, 0.20, 0.30, 0.40}, per signal FAMILY (architect finding 9 — the
formula must exist for every family that can turn viable):

- boolean signals (B1 `accepted`-like): binomial, measured base rate.
- count signals (B2 findings/review): two-sample comparison on
  mean/sd (normal approximation, measured moments); effect size =
  Cohen-d-style standardized difference.
- categorical signals (B3 classes): pre-binarized before E — the
  binarization (which class vs rest) must be declared when the config is
  proposed; undeclared categorical signals do not enter E.
- rate signals (B4 pass@k): binomial on task-level pass rate.

**Config-viability bar (pre-registered, user may amend pre-data):
days-to-verdict ≤ 14, evaluated AT effect size = 0.30 exactly** (the
{0.10, 0.20, 0.40} columns are reported context, not the bar; architect
finding 10). Output table appended to this spec + the P0 json. Rigor is
never lowered: MIN_N and §4.3 discipline stand; only the evidence CHANNEL
changes.

## 4. P2 — actuator-binding probe (contract only; own spec later)

Blocked until P0's verdict exists (it needs a viable outcome signal).
Its spec MUST state: arms — A1 prose bullet (measured baseline: 7/8
ignored), A3 binding middleware (mechanically enforced check/transform),
A4 review-actuator (findings applied as edits, binding by construction);
mechanical behavior-change detection per arm; task band; model tiers; and
its own sized go. Nothing in this document authorizes P2 spend.

## 5. Program decision rule

After P0 + P1 + E: the architecture choice (review-loop-as-sensor
synthesis vs piecemeal cause fixes) is presented to the user as the set of
configs passing the §3 bar, with their numbers. The user rules. If NO
config passes, that is itself the finding: the loop is unaffordable on
current evidence channels, and the program stops proposing until a new
channel exists (e.g. P3's landing).

## 6. Boundaries

- F1: no mechanism edits anywhere in P0/P1 (read-only probes).
- F2: committed artifacts carry counts, stats, dates, keys — never prompt
  or note text.
- Pooling prohibitions inherited and restated. RULE, not a hand-picked
  list (architect finding 2; liveness criterion made explicit per
  round-2 N1): before any probe computation over a time window,
  enumerate the boundaries from BOTH sources — (a) every entry in
  `docs/2026-08-01-gauntlet-adoption-ledger.md`, and (b) every
  `pluginVersion` stamp change observed in the stream being read (the
  stream self-partitions; a stamp change need not have a ledger entry
  yet, e.g. 0.2.1→0.3.0 whose first 0.3.0 line had not been emitted at
  spec time). **A boundary is LIVE iff its ts falls inside the window
  AND it applies to a stream/host/field this run actually reads** —
  chronology alone does not make it live. Worked example at spec time
  (P1 window reaches ~2026-07-29; all streams read here are
  host=yoo-dev): 1785571509000 (gauge fail-loud) and 1785684571765
  (SDK transport, yoo-mac) are in-window but NOT live — yoo-mac-only
  deploy events, no yoo-dev line crosses them; LIVE: 1785711630125
  (gauge SDK transport, office — also splits the FOREIGN kkamak
  stream's 0.2.1 lines), 1785727963349 (7a doc-linter floor — changes
  the `check` grouping key), 1785847012141, 1785856371528,
  1785888548054 (check string + durationMs regime), 1785892022908.
  Never across `pluginVersion` stamps; never across hosts; the
  `~/z2/kkamak` stream is a foreign instrument read for descriptive
  contrast only.
- No §4.3 claims from any probe. Probes describe; adoption has its own
  gates.

## 7. What this program cannot do

Cannot fix anything by itself — it selects which fixes earn a build.
Cannot lower rigor bars (E changes the channel, not the bar). Cannot
adopt: every next step (P2 spec, hook build, sweep scheduler, synthesis
design) is a separate user-ruled go.

## Results — office run 2026-08-05 (appended per §3; data: docs/loop-probes/yoo-dev-*.json)

### P0 viability, per signal

- **b1.accepted** — UNKNOWN (latest-segment n=5, trueCount=5, falseCount=0)
- **b1.gateExhausted** — UNKNOWN (latest-segment n=5, trueCount=0, falseCount=5)
- **b1.roundsLength** — UNKNOWN (latest-segment n=5, mean=0.8, sd=0.44721359549995804 ≈0.45)
- **b1.durationMs** — UNKNOWN (latest-segment n=5, mean=2662.8, sd=5541.712794795487 ≈5541.71)
- **b2 review findings** — VIABLE (count family, n=10, mean=4.2, sd=5.921711464320654 ≈5.92)
- **b3.live** — UNKNOWN (binarization undeclared) (n=107, classes A1=38, A2=35, B=6, C=1, D=27)
- **b3.corpusTranscript** — UNKNOWN (binarization undeclared) (n=407, classes A1=68, A2=127, B=17, C=21, D=174)
- **b4 TB2 band pass@k (arm=candidate)** — VIABLE (rate family, n=34, successes=22, failures=12 → 22/34)

### P1 events/day, per source

- **s1 gated Stops/day** — eventsPerDay = 62.57142857142857 ≈62.57 (n=438 over 7-day window 2026-07-29→2026-08-05)
- **s2 commits/day, per repo**:
  - this-repo (worktree-loop-probes branch): commitsPerDay = 55.42857142857143 ≈55.43 (388 commits)
  - kkamak (main branch): commitsPerDay = 10.571428571428571 ≈10.57 (74 commits)
- **s3 review passes/day** — addsPerDay = 1.4285714285714286 ≈1.43 (10 files over the window; byDay 2026-08-03:4, 2026-08-04:5, 2026-08-05:1)
- **s4 post-two-tier turn shift (note)** — boundary ts 1785888548054, live in window: pre-boundary segment n=421, linesPerDay=60.142857142857146 ≈60.14, durationMs mean=108733.47505938243 ≈108733.48 sd=1262408.391004921 ≈1262408.39; post-boundary segment n=17, linesPerDay=2.4285714285714284 ≈2.43, durationMs mean=4942.882352941177 ≈4942.88 sd=9276.10473125946 ≈9276.10

### E table — days-to-verdict by signal × source × effect size

| signal | source | days@0.10 | days@0.20 | days@0.30 | days@0.40 | meaningful | passesBarAt030 |
|---|---|---|---|---|---|---|---|
| b2 | s1 | 51 | 13 | 6 | 4 | false | true |
| b2 | s2:this-repo | 57 | 15 | 7 | 4 | false | true |
| b2 | s2:kkamak | 297 | 75 | 34 | 19 | false | false |
| b2 | s3 | 2196 | 549 | 245 | 138 | true | false |
| b4 | s1 | 11 | 3 | 1 | 1 | false | true |
| b4 | s2:this-repo | 12 | 3 | 1 | 1 | false | true |
| b4 | s2:kkamak | 63 | 14 | 6 | 4 | false | true |
| b4 | s3 | 462 | 103 | 38 | 28 | false | false |

b2 crosses (count family): p1OrMoments mean=4.2, sd=5.921711464320654 ≈5.92. b4 crosses (rate family): p1OrMoments p1=0.6470588235294118 ≈0.65. Only b2×s3 is `meaningful`; its `reason` field is absent (meaningful=true) — all other crosses carry `"reason": "signal does not ride this source today"`. b1 and b3 signals are excluded from E entirely (viability UNKNOWN, per §3's P0-viable-only input); s4 is excluded as a boundary-split view of s1, not an independent source.

### Verdict (verbatim from yoo-dev-e-table.json)

```json
{
  "meaningfulCrosses": 1,
  "passing": 0,
  "verdict": "NO-CONFIG-PASSES"
}
```

The only meaningful pairing (b2×s3) needs 245 days at effect 0.30 vs the 14-day bar.

### Caveats (final-review items, declared)

(a) P0 b1 top-level n/stats reflect the LATEST SEGMENT only (linesTotal 480, latest regime n=5) — read `segments[]` in `docs/loop-probes/yoo-dev-p0-signal-variance.json` for history across all 10 segments (n ranging 3–182 per segment).

(b) B4 pools all 34 repeat-array trials (p1≈0.647), not task-level pass@k (≈13/17) — taxonomy note, verdict-neutral today since every b4 cross is capacity-only (passesBarAt030=true but meaningful=false for every b4 row).

§5 decision: presented to the user by the controller; this spec records data, not the adoption choice.

### Cause mapping — what proved effective, what is fixed, what remains open (2026-08-05, controller record)

| cause (defect) | options probed | verdict from data | status |
|---|---|---|---|
| A actuator doesn't bind | NOT probed (P2 was gated on P0) | historical only: prose ignored 7/8 (loop-1) | **OPEN — P2 now unblocked**: outcome signal = B2; needs its own spec + sized go |
| B constant outcome | B1 gate-outcomes / B2 review findings / B3 gauge classes / B4 TB2 trials | B1 ineffective (UNKNOWN latest regime n=5; historical 1% minority is the defect itself); **B2 EFFECTIVE** (VIABLE, sd/mean 1.41); B3 admissible only after a declared binarization; B4 viable but no source emits bench cadence | **PARTIALLY FIXED**: one real signal exists (B2). B3 ruling + B4 cadence source open |
| C event starvation | S1 Stops / S2 commits / S3 review-adds / S4 turn-shift | diagnosis STALE: S1 = 62.57/day, S2 = 55.43/day (dense). The starved source is S3 = 1.43/day — exactly the one carrying the viable signal | **REFRAMED**: density exists; the viable signal rides the wrong source |
| D blind to non-breaking defects | foreign to this program (P3: channel ladder + C4 experiment) | no new data — chain armed, opus-walled | **OPEN — in flight elsewhere** |
| E rigor unaffordable | E table over P0-viable × P1 sources | pairing, not rigor, is the blocker: meaningful b2×s3 = 245 days (FAIL); capacity b2×s1 ≈ 6 days, b2×s2 ≈ 7 days (would PASS) | **REFRAMED**: bars reachable if the findings signal rides a dense cadence |

**Not yet fixed (open register):** (1) P2 actuator-binding probe — spec + sized go owed; (2) B3 binarization ruling — CLOSED 2026-08-05, D vs rest (ruling section below); (3) the pairing move itself — auto-fired review passes at commit/Stop cadence (the review-loop-as-sensor synthesis) is now numerically motivated but UNBUILT and needs its own user-ruled design; (4) D's whole program rides the premium wall. Nothing in this section adopts anything (spec §5/§7 stand).

### Erratum — S4 rate denominator (2026-08-05, found by the kkamak-repo session's independent review)

The committed `yoo-dev-p1-event-density.json` S4 segments divide both
rates by the full 7-day window, but the post-boundary segment spans only
~0.19 days — read literally it claims the two-tier gate cut line emission
25×, which is false (span-corrected: pre 421/6.81d ≈ 61.8/day, post
17/0.19d ≈ 88/day — emission ROSE slightly). The committed snapshot is
left frozen; `scripts/p1-event-density.ts` now emits span-aware
`spanDays` + per-segment rates so every future run is correct. The real
S4 content, span-neutral and worth recording: gated-Stop `durationMs`
mean fell 108,733 → 4,943 ms across the two-tier boundary — the deploy
made Stops ~22× faster, exactly as its ledger entry predicted. E table
unaffected (S4 was excluded as non-independent by design).

### B3 binarization ruling — D vs rest (2026-08-05, user-directed "measure and then decide")

Open-register item (2) CLOSED. Measurement (zero model calls, Task-1
formulas verbatim — `nPerArmBinomial`/`daysToVerdict`, MIN_N=20 floor,
script committed as `scripts/b3-binarization-measure.ts`, counts from the
committed P0 json):

- **True carrier cadence measured**: b3.live rides gauge DERIVATIONS, not
  Stops — 119 `gauge.present` lines / 6.52d trailing window in this
  repo's gate-outcomes.ndjson = **18.26 gauge events/day** (~27% of the
  438 Stops). Every earlier b3 cross printed against s1/s2 was
  capacity-only; this is the real rate.
- **Floors (minority ≥3 count AND ≥0.1 rate, both provenances)**: pass —
  D-vs-rest (25.2% live / 42.8% corpus), A1-vs-rest, A1+A2-vs-rest.
  Fail — C-vs-not-C (0.9% / 5.2%), B+C-vs-rest (6.5% / 9.3%).
- **Bar at measured cadence**: D-vs-rest needs n/arm 41–42 at d=0.30 →
  **5 days** (d=0.20 → 10–11 days) — under the 14-day bar with margin.

**Ruling: b3 is binarized as class D vs rest** (criterion exists but
not extractable — reason "not-extractable"/"out-of-scope" — vs A1/A2/B/C).
Rationale: the only floor-passing split that measures what a goal-setting
actuator targets (extraction failure); the A1 variants pass numerically
but track workload mix (chat share), not agent behavior. Declared
limitation carried forward: D rate is workload-confounded in any
non-randomized comparison — arms must be randomized or the confound
declared per §4.3.

Standing consequences: b3 (D-vs-rest) may now enter E when a config is
proposed; the pairing that carries it today is gauge-emission cadence
(measured 18.26/day here), NOT s1 — a future e-table run wanting b3 must
add the gauge-emission source explicitly rather than reusing s1's rate.
This ruling adopts no config and arms nothing (§5/§7 stand).
