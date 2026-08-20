# Verdict — second fixture transfer test (2026-08-20)

REG_SHA: `2d5bd4b` (registration commit — fixture, truth, generator, runner,
pre-registration all committed BEFORE this run per spec §8.1's no-tuning
guard).

## Runner output (verbatim)

```
DIVIDE: n=6 peaks at channels 107.95, 136.60, 154.90, 167.05, 173.70, 186.75
matched 6/6 true centers within +/-5 samples
ORACLE: ok=true reason=- R=2.27e+10 [as-registered]
b1 shifted: ok=false reason=residual R=- [as-registered]
b2 reversed: ok=false reason=residual R=- [as-registered]
b3 out-of-family quadratic: ok=false reason=degenerate-constellation R=1.49e+0 [as-registered]
BOUNDARY invented (a=3,b=1): ok=true reason=- R=2.83e+9 [as-registered]
geometry u=x: spacing CV=0.471 alternates=2
geometry u=inv-x: spacing CV=0.789 alternates=2
```

No line shows `*** DEVIATES ***`. The divide found 6 peaks (>= 3 required).

## Machinery-freeze proof (command + output, verbatim)

```
$ git diff --stat 2d5bd4b..HEAD -- opencode-plugin/src/bench/ docs/loop-probes/dnc-second-fixture-20260820/
```

Output: (empty)

Empty diff confirms neither the frozen machinery
(`opencode-plugin/src/bench/`) nor this probe's own fixture/registration
files (`fixture.dat`, `truth.json`, `make-fixture.ts`, `run-transfer.ts`,
`pre-registration.md`) were touched between the registration commit and this
verdict — the run above is the unmodified, as-registered transfer result.

## Registered outcomes — HELD / FAILED

| Outcome | Registered | Observed | Verdict |
|---|---|---|---|
| DIVIDE: >= 3 scale-persistent peaks | >= 3 | 6 | HELD |
| DIVIDE: >= 4/6 true centers matched within +/-5 samples | >= 4/6 | 6/6 | HELD |
| ORACLE arm: mergeCheck ok=true | ok=true | ok=true, R=2.27e+10 | HELD |
| BAD b1 (shifted): reject | ok=false | ok=false, reason=residual | HELD |
| BAD b2 (reversed): reject | ok=false | ok=false, reason=residual | HELD |
| BAD b3 (out-of-family quadratic): reject | ok=false | ok=false, reason=degenerate-constellation | HELD |
| DOCUMENTED BOUNDARY (invented a=3,b=1): pass (T6 class, out of merge's scope by spec §6) | ok=true | ok=true, R=2.83e+9 | HELD |
| Geometry report: spacing CV per family member; conditioning alternates count | reported, not scored | u=x: CV=0.471, alternates=2; u=inv-x: CV=0.789, alternates=2 | HELD (reported as registered) |

## Decision applied

All registered outcomes HELD; no arm shows `*** DEVIATES ***`; the divide
found well above the 3-peak floor (6/6 true centers matched, exceeding the
4/6 floor). Per the registered decision rule: **transfer EVIDENCE** — this is
one more fixture (the second), not proof of general transfer. The divide and
merge machinery (frozen at its Task-1..8 state, unedited per the freeze-guard
proof above) reproduced the same qualitative behavior on a fixture from a
different domain (synthetic resonance scan vs. the raman fixture), a
different frozen family member exercised as the primary axis (`u=x` vs. the
raman work's `1/x`), a different peak count (6 vs. the first fixture's 17),
and different noise texture (Gaussian sigma=25 vs. the first fixture's
texture) — none of which the machinery was tuned against, since it was
committed and frozen before Task 11 began and untouched through this run
(confirmed above).

No failure was recorded. No tuning against this fixture occurred or is
permitted going forward — this is now historical evidence, not a target to
optimize.
