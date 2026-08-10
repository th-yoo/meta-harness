# Review artifact — sensor-checkpoint-reader (08-13 cadence reading locked in code)

reviewed-range: 18f584eec6dd470f986d7d096289db50bfa32003..7a2fec8964b15d6886c728fef5a37f5fd2120fda
reviewer: fresh-context-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One commit, two NEW files (`scripts/sensor-checkpoint.ts` 166 lines,
`km-crank/test/sensor-checkpoint.test.ts` 110 lines, 276 insertions, nothing
else in the diff). Implements the CHECKPOINT-READING RULING (user,
2026-08-11, sensor spec §5) as a standalone reader CLI so the pre-registered
2026-08-13 cadence reading on the armed host is one command, not judgment.

Reviewer verification, all file:line opened by the reviewer itself:

- **Ruling fidelity (the Critical axis):** spec §5 ruling text
  (`…review-sensor-synthesis-design.md:208-220`) vs `computeCheckpoint`
  (`sensor-checkpoint.ts:81-103`) — per-calendar-day distinct
  `(baseSha, headSha)` via `Map<dayKey, Set<pair>>`, same pair on two days =
  two events, skip lines `continue`d before the pair set. `dayKey()`
  construction is identical to the sensor's own `getDayKey`
  (`review-sensor/core.ts:42-48`) — local-midnight semantics match the
  instrument being read. No divergence found.
- **Field parity with the producer:** `passLine`/`skipLine`
  (`core.ts:200-215`, `:225-237`) vs the reader's accesses — `ts`,
  `skipped`, `reason`, `baseSha`, `headSha` exact.
- **Edge honesty:** malformed pass lines (missing shas) counted in
  `rawPassLines`, excluded from ruled events, surfaced as
  `malformedPassLines` — never silently dropped or counted. Torn ndjson
  lines survive via try/catch. Empty stream → zeros, no division by zero.
  Window filter `[since, until]` inclusive both ends, consistent with
  spanDays' inclusive local-midnight day count.
- **DST:** a ±1h transition day sits well inside `Math.round`'s 12h
  tolerance on the midnight-to-midnight division — no off-by-one across
  spring-forward/fall-back.
- **Un-gameable defaults:** `CADENCE_BAR = 25` matches spec §5;
  `SENSOR_EFFECTIVE_BOUNDARY_TS = 1785996709580` matches
  `minimal/HISTORY.md:1106` verbatim; both pinned by a dedicated test, and
  the CLI echoes `stream/since/until/bar` in its output so any override is
  visible in the reading itself.
- **No scope creep:** `p2-tally.ts` `computeB2Shadow` untouched —
  deliberately, it serves P2's shadow read under its own pre-registered
  definition. No other files in the range.
- **Tests are targeted regressions pins**, none vacuous: repeat-collapse,
  per-day (not global) dedupe, skip exclusion with reason tally, window
  filter, malformed-sha surfacing, span/rate math, exact-bar boundary,
  empty stream, pinned constants.
- **F1/F2:** no `review-sensor/` file touched; reader emits counts and a
  closed `SkipReason` tally only — no text.

**Division of verification labor, recorded:** the reviewer's session had no
exec tool, so it traced all 10 tests by hand and left two items procedural:
a literal green run and a byte-level diff confirmation. Both were done by
the author and are part of this record: km-crank **396 pass / 0 fail**
(includes the 10 new tests), `tsc --noEmit` zero errors for the new files,
CLI smoke against an empty stream prints zeros + BAR NOT MET without
crashing, and the commit's `--stat` is exactly the two named files above
(the commit used explicit `git add <file> <file>` — no `add -A`, per this
session's recorded lesson). TDD: the 10 tests were watched failing before
the implementation existed; the two mid-cycle test edits were fixture
window-arithmetic fixes (local-midnight crossings), not assertion
weakenings.
