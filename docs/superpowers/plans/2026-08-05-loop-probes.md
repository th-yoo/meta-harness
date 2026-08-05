# Loop-probes implementation plan (P0 + P1 + E)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use checkbox syntax.

**Goal:** Execute the probe program registered in
`docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md`
(reviewed-to-SOUND, 3 architect rounds, b6f8730 — THE SPEC IS LAW; every
mechanical rule below restates it, and on any conflict the spec governs):
P0 signal-variance audit + P1 event-density counters + E days-to-verdict
table. Zero model calls anywhere.

**Architecture:** proven gate-check pattern — pure logic in
`km-crank/src/loop-probes.ts` (unit-tested, no I/O), thin CLIs in
`scripts/` that bind real data, committed json outputs under
`docs/loop-probes/`.

## Global Constraints

- **Zero model calls** in all tasks, tests, and probe runs.
- **F2:** committed outputs carry counts/stats/dates/keys only — never
  prompt, note, or transcript text.
- **Spec §6 boundary rule binds every windowed computation:** boundaries
  from (a) the adoption ledger + (b) in-stream `pluginVersion` stamp
  changes; a boundary is LIVE iff its ts is inside the window AND applies
  to a stream/host/field actually read. Live-at-spec-time set for the
  office streams: 1785711630125, 1785727963349, 1785847012141,
  1785856371528, 1785888548054, 1785892022908 (+ any 0.3.0 stamp lines
  present at run time). Nothing pools across a live boundary, across
  `pluginVersion` stamps, or across hosts.
- **Foreign stream:** `~/z2/kkamak/.km/gate-outcomes.ndjson` is read-only,
  descriptive, reported per-regime (0.2.1 lines split at 1785711630125),
  never pooled with anything.
- **Viability floors (spec §1, amendable pre-data, applied per signal):**
  n ≥ 10 else UNKNOWN; boolean → minority count ≥ 3; categorical →
  second-most-frequent class count ≥ 3; count → sd/mean ≥ 0.1 with
  mean = 0 ⇒ NON-VIABLE; rate → ≥ 3 successes AND ≥ 3 failures.
- **B4 source restriction:** ONLY
  `term-bench2/store/global/candidates/v1/ab-verdict.json` (17 tasks,
  k=2 repeat arrays). Partials and k=1 score.json aggregates excluded.
- **E formulas (spec §3), α=0.05 two-sided (z=1.96), power 0.80
  (z=0.84), N per arm floored at MIN_N=20:**
  - binomial (boolean/rate): N = ceil(((1.96·sqrt(2·p̄·(1−p̄)) +
    0.84·sqrt(p1(1−p1)+p2(1−p2)))² ) / e²) with p1 = base rate, p2 =
    p1 + e (cap p2 ≤ 0.99), p̄ = (p1+p2)/2, e = absolute effect.
  - count: N = ceil(2·(1.96+0.84)² / d²) = ceil(15.68 / d²), d =
    standardized effect (the {0.10..0.40} grid is d for counts).
  - categorical: enters only pre-binarized (declared binarization),
    then binomial.
  - days-to-verdict = ceil(2·max(N, 20) / events_per_day) for the
    paired source. Bar: ≤ 14 days AT effect 0.30 exactly; other columns
    context.
- **cc-gate-plugin/src/core/ is MECHANISM_PATH** — untouched. This plan
  touches only `km-crank/`, `scripts/`, `docs/loop-probes/`.
- Probe CLIs are read-only over their data sources; they write ONLY their
  output jsons.

## File Structure

- `km-crank/src/loop-probes.ts` — NEW, pure: ndjson line parsing,
  boundary-split, per-family stats + viability verdicts, git-date
  bucketing, E formulas.
- `km-crank/test/loop-probes.test.ts` — NEW, unit tests with inline
  fixtures.
- `scripts/p0-signal-variance.ts` — NEW thin CLI → writes
  `docs/loop-probes/<hostname>-p0-signal-variance.json`.
- `scripts/p1-event-density.ts` — NEW thin CLI → writes
  `docs/loop-probes/<hostname>-p1-event-density.json`.
- `scripts/e-table.ts` — NEW thin CLI reading both jsons → writes
  `docs/loop-probes/<hostname>-e-table.json` + prints the table.

---

### Task 1: `km-crank/src/loop-probes.ts` — pure logic + unit tests

**Interfaces (Task 2/3 rely on exact names):**
- `parseGateLine(raw: string): GateLine | undefined` — tolerant JSON parse
  of a gate-outcomes line; undefined on malformed. `GateLine` carries
  `ts:number`, `accepted?:boolean`, `gateExhausted?:boolean`,
  `rounds?:unknown[]`, `durationMs?:number`, `pluginVersion?:string`,
  `check?:string`, `host?:string`.
- `splitAtBoundaries<T extends {ts:number}>(lines: T[], boundaries: number[]): T[][]`
  — ordered segments; boundaries sorted+deduped internally; a line with
  ts === boundary belongs to the POST segment.
- `regimeKey(line: GateLine, boundaries: number[]): string` — stable label
  `"<pluginVersion|unknown>@<index of segment>"` for grouping.
- Stats: `boolStats(xs: boolean[])` → `{n, trueCount, falseCount}`;
  `countStats(xs: number[])` → `{n, mean, sd}` (sample sd, n−1; sd=0 when
  n<2); `catStats(xs: string[])` → `{n, classes: Record<string,number>}`.
- Viability (spec §1 verbatim): `viability(family, stats)` →
  `"VIABLE" | "NON-VIABLE" | "UNKNOWN"` where family ∈
  `"boolean"|"categorical"|"count"|"rate"`; rate takes
  `{successes, failures}`; every floor from Global Constraints.
- E: `nPerArmBinomial(p1: number, e: number): number`,
  `nPerArmCount(d: number): number`,
  `daysToVerdict(nPerArm: number, eventsPerDay: number): number`
  (Infinity → returned as `null` when eventsPerDay = 0) — formulas from
  Global Constraints verbatim.
- `dayBucket(isoOrTs: string | number): string` — UTC `YYYY-MM-DD`.

- [ ] **Step 1: failing tests** — km-crank/test/loop-probes.test.ts
  covering: malformed line → undefined; boundary split incl. ts===boundary
  post-side and empty segments; boolStats/countStats (sd via known small
  set; mean=0 case); viability: boolean minority 2 → NON-VIABLE, 3 →
  VIABLE, n=9 → UNKNOWN; count sd/mean at exactly 0.1 → VIABLE, mean=0 →
  NON-VIABLE; rate 3/3 → VIABLE, 2 successes → NON-VIABLE; categorical
  second-class 3 → VIABLE; nPerArmBinomial spot value (p1=0.2, e=0.3 —
  assert the ceil'd integer the formula yields, computed by hand in-test);
  nPerArmCount(0.3) = ceil(15.68/0.09) = 175; MIN_N floor applied by
  daysToVerdict caller contract (document: floor lives in e-table CLI);
  daysToVerdict(175, 10) = 35; eventsPerDay 0 → null.
- [ ] **Step 2: verify fail** (module missing).
- [ ] **Step 3: implement** (pure, no imports beyond none — zero I/O).
- [ ] **Step 4: bun test file green; whole km-crank suite green; tsc --noEmit clean.**
- [ ] **Step 5: commit** `feat(probes): loop-probes pure logic — parsing, boundary split, viability floors, E formulas`

### Task 2: P0 + P1 CLIs, run on real data, commit outputs

**Consumes Task 1 exports. Real bindings:**
- P0 (`scripts/p0-signal-variance.ts`):
  - B1: read `.km/gate-outcomes.ndjson` (repo root, host yoo-dev). Signals
    per spec: `accepted` (boolean), `gateExhausted` (boolean),
    `rounds.length` (count), `durationMs` (count). Split at the live
    boundary set (Global Constraints) — report per-segment stats AND
    per-signal viability on the LATEST segment (the only regime new data
    joins); earlier segments descriptive.
  - B1-foreign: read `~/z2/kkamak/.km/gate-outcomes.ndjson`; group by
    `pluginVersion` + split 0.2.1 at 1785711630125; descriptive stats per
    regime; NO viability verdicts (foreign).
  - B2: `git log --follow --diff-filter=A --format=%aI -- <f> | tail -1`
    per committed docs/reviews/*.md for dates; findings-count via
    grep of each file's `findings-count:` field; count-family stats +
    viability.
  - B3: run `bun cc-gate-plugin/src/gauge/replay-cli.ts report`, parse the
    two `class-rate` lines (live + corpus-transcript) into
    `{A1,A2,B,C,D}` counts; categorical stats; viability requires a
    declared binarization — emit verdict `UNKNOWN (binarization
    undeclared)` per spec §3 unless/until one is declared.
  - B4: read v1/ab-verdict.json per-task repeat arrays → task-level pass
    rate (a task passes a trial per its repeat array entries); rate-family
    viability over trials.
  - Output json: per-signal `{family, n, stats, segments?, viability}` +
    window/boundary metadata. Write to
    `docs/loop-probes/<hostname>-p0-signal-variance.json`.
- P1 (`scripts/p1-event-density.ts`): window = trailing 7 calendar days
  (UTC) ending at run time.
  - S1: gate-outcomes lines/day (this repo), split at live boundaries.
  - S2: `git log --since=<window> --format=%aI` commits/day for this repo
    AND ~/z2/kkamak (label separately).
  - S3: docs/reviews adds/day via the Task-1 dayBucket over per-file
    git author dates (tail -1 rule).
  - S4: gate-outcomes durationMs distribution + lines/day split at
    1785888548054 — descriptive, small-n declared in output.
  - Output `docs/loop-probes/<hostname>-p1-event-density.json`.
- **Testing:** integration-lite — each CLI accepts an optional env
  override for its data roots (`KKAMAK_PROBE_GATE_NDJSON`,
  `KKAMAK_PROBE_REVIEWS_DIR`, `KKAMAK_PROBE_TB2_VERDICT`,
  `KKAMAK_PROBE_FOREIGN_NDJSON`, `KKAMAK_PROBE_SKIP_B3=1` to skip the
  replay-cli subprocess) so km-crank tests drive them against tiny
  fixtures in temp dirs and assert output-json shape + one known value
  each. Production omits the seams.
- [ ] Steps: failing tests → implement → green (file + suite + tsc) →
  **RUN BOTH CLIs for real from repo root** → verify outputs exist,
  json-valid, F2-clean (spot-check: no prompt text) → commit code +
  outputs: `feat(probes): P0+P1 CLIs + office probe outputs (zero model calls)`

### Task 3: E table + verdict

- `scripts/e-table.ts`: read both committed jsons; for every P0-VIABLE
  signal × P1 source (events/day > 0): compute N per arm at effects
  {0.10, 0.20, 0.30, 0.40} (family-appropriate formula; MIN_N=20 floor),
  days-to-verdict, and `passesBar` (≤14 days AT 0.30). Emit
  `docs/loop-probes/<hostname>-e-table.json` + human table on stdout.
- Testing: unit-level via Task-1 functions already covered; CLI gets one
  fixture-driven test (tiny synthetic P0/P1 jsons via env seam
  `KKAMAK_PROBE_P0_JSON`/`KKAMAK_PROBE_P1_JSON`).
- [ ] Steps: failing test → implement → green → **RUN for real** → commit
  `feat(probes): E days-to-verdict table (office)` → report in final
  message: viable signals, dead signals, configs passing the bar (or none).

---

## Post-plan notes

- Spec §5: the verdict presentation (architecture choice) is the
  CONTROLLER's duty after Task 3 — not any implementer's.
- The probes read live host data; runs are only meaningful on yoo-dev.
  Tests never touch real streams (env seams).
- If `.km/gate-outcomes.ndjson` gains 0.3.0-stamped lines between run and
  re-run, the stamp is a boundary (spec §6 source (b)) — the CLIs must
  derive the boundary set from data + the constant list, not constants
  alone.
