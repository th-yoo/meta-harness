# Addendum 02 — split-axis selection criterion (cross-lane, 2026-08-20)

Question (user): can probe 2 decide the split axis — glyphs vs dimensions?
Converged answer across both lanes: **no — probe 2 answers WHETHER a task's
failure is length-shaped, never WHERE to cut.** This addendum records what
CAN decide the axis without an answer key.

## Rank vs select

Failure signatures legitimately **RANK** axis hypotheses — late-position
errors (path-tracing, last error at 0.79–0.96 of the traj) point at the
sequential/generation axis; independent per-item errors (lane-B rung-5's
per-glyph compounding) point at the item axis. Ranking is free. Using the
same signatures to **SELECT** the axis is fitting the split to this task
set's failure stats — the TARGET_TRUTH class — and will not transfer by
construction.

## The answer-free selection criterion (lane B derivation, ONE fixture)

A valid split axis is one whose partitions are:

- **(a) independently solvable** — minimal cross-boundary coupling. This is
  D&C's own applicability requirement and is checkable STRUCTURALLY, with no
  answer. **Load-bearing clause:** an axis that severs dependencies produces
  subtasks whose MERGE needs the answer — reintroducing claimant degrees of
  freedom at merge time, the same defect the revalidator bypass has.
- **(b) sweep-stable** — the partition persists over the widest unchosen
  parameter range (the scale-space class from lane B's seam replacement).
- **(c) non-degenerate** — "divided nothing" excluded as a property of the
  operation, not by a threshold.

Glyphs-vs-dimensions then decides itself PER ARTIFACT: cut where coupling is
lowest and stability is highest.

## Status

Criterion is a derivation validated on ONE fixture (lane B). Not a proven
general. The second fixture remains the open transfer test for it, same as
for everything else in both lanes.
