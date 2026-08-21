# Step 0 VERDICT — the corpus REFUTES the diagnosis the probe was built on

Zero spend. Registered outcomes were A/B/C/D about carryable artifacts. The
answer is none of them: **the trajectories contradict the taxonomy that
motivated the question.**

## Measured, all 7 `path-tracing` failures

| traj | wrote image.c | compiled | ran | edits |
|---|---|---|---|---|
| 342-3a14a5 | 3 | 19 | 19 | 16 |
| 855-7513b2 | 21 | 20 | 23 | 0 |
| 800-e3f22d | 1 | 19 | 19 | 17 |
| 954-82bbaf | 5 | 9 | 9 | 3 |
| 465-b948ae | 1 | 13 | 13 | 8 |
| 111-7840dd | 3 | 6 | 6 | 1 |
| 186-8f3cd0 | 1 | 11 | 11 | 9 |

**7/7 wrote the target artifact, compiled it with gcc, and ran it.** Six to
twenty-three compile-run cycles each; up to seventeen edit iterations.

## What the taxonomy said

- *"the trajectory ends before any image.c file is written or compiled"*
- *"never began writing image.c"*
- *"spent its entire visible budget on manual pixel-by-pixel pattern discovery
  ... instead of converging quickly on a parametric model and writing code"*

**All three are FALSE.** Verified directly in the ndjson: `write` to
`/app/image.c`, `bash: gcc -static -o image image.c -lm && ./image`, then `edit`
loops on the same file.

## What this retracts

1. **The L1 trial's causal story.** `incomplete = 8/8` was reported with root
   causes describing unbounded exploration that never reached implementation.
   The mode label may survive (runway did run out); **the cause narrative does
   not.**
2. **Bullet b7's premise.** The proposer emitted *"cap exploration to a fixed
   number of steps, then write and test a first-draft implementation
   immediately"* — from this diagnosis. **The agents were already writing and
   testing drafts, 6-23 cycles each.** The bullet prescribes what they were
   already doing.
3. **My level-2 argument.** "Bounded explore -> forced handoff -> implement" was
   the structural form of that bullet. Its motivating evidence is gone.

## The mechanism of the error

The judge's `rootCause` fields are fluent and specific — they name "histograms,
row scans, gradient/checkerboard characterization" — and they are wrong on the
central fact. This is CLAUDE.md's rule firing exactly as written:

> *Check every model/agent claim against the actual artifact before building on
> it; fabricated rationales look exactly like correct ones.*

I checked the taxonomy's mode COUNTS (8/8) and never its failurePoint TEXT. The
counts were the number I scrutinised; the narrative was the part I inherited —
and the narrative was load-bearing for everything downstream.

Fourth frame-level miss today, and the first where the inherited frame came from
a MODEL rather than a peer or myself.

## What is now open

The real failure shape of `path-tracing` is UNKNOWN. The agents converged,
implemented, compiled, ran, and iterated — and still failed. That is not a
runway-exhaustion signature; it is closer to a capability or accuracy wall, which
would place `path-tracing` in the pure-difficulty class rather than the length
sub-band. If so, §5's own arm assignment is wrong for this task and the length
sub-band needs re-deriving from transcripts rather than from metadata.

**Not asserted — measured only to the point above.** Re-classifying the mode is
its own probe, zero-spend, and must read the trajectory TAILS (why each run
stopped), which this pass did not.
