# Addressable-class census — PRE-REGISTRATION (lane A half)

**Status: registered, NOT RUN. Awaiting an explicit go. No data has been looked
at for either question below.**

Written before any measurement, per the method rule. Registering the question,
the method, the kill conditions and both outcome branches *first* is the whole
point: the previous census question ("does the task ship a two-column series?")
was a format sniffer that answered a question nobody had registered, and it took
four review rounds before anyone asked what it was actually measuring.

## The question this exists to answer

`generality-verdict.md` measured that the lane-A merge gate engages on **1 of 99**
real tasks. That number indicts a *detector*, not necessarily a *principle*. The
detector was "ships a 2-column `.dat`". The open question is the one the number
only appears to answer:

> **How many tasks are in the ADDRESSABLE CLASS of the over-determined-fit
> principle?**

Two structural sub-questions per task, both answerable from the task's own
artifacts:

- **Q1 — REDUNDANCY (what the merge needs).** Does the task's **graded output**
  contain `n >= 3` homogeneous elements constrained by fewer than `n` shared
  parameters? "Elements" is whatever repeats: rows, records, files, test cases,
  coordinates, glyphs, peaks.
- **Q2 — SOURCE (what value truth needs).** Is there a task-owned, SUT-visible
  artifact from which those elements are **independently recomputable**?

## Method — and the one thing it must not be

**Read the VERIFIER shape and the instruction text. Do NOT sniff formats.**
Format sniffing is precisely how a `.dat`-reader came to be called a divide step.
What the grader checks is what defines the output's element structure, and the
verifier is the one place the element count is **stated rather than inferred** —
so reading it is artifact contact, not inference.

**Two passes with DIFFERENT FRAMES, then diff.** Today's evidence is that
agreement checks propagate only content one side already possesses; two passes
with the same frame would be one pass. Split:

- **lane A (this half): the verifier-shape read** — `tests/`, `test_outputs.py`,
  `test.sh`, and whatever the runner actually executes to grade.
- **lane B (`meta-harness-1e`): the instruction-text / element-structure read** —
  what the task *asks* for, independent of how it is graded.

Neither lane reads the other's column before both are complete. The diff is the
result; agreement between frames is evidence, disagreement is a finding about
which frame sees what.

## Registered classification, per task

`Q1 ∈ {yes, no, undecidable}` with the element type named and `n` recorded when
`yes`. `Q2 ∈ {yes, no, undecidable}` with the source artifact named when `yes`.
`undecidable` is a real answer and is never rounded toward `no` to make a count
look decisive.

## Pre-registered branches — BOTH acceptable, decided by the count, not by preference

- **Class comes back LARGE (say ≥ 20 tasks with Q1=yes).** The divide step gets
  re-derived **per structural family** — series, grid, record-set, and so on.
  That is mechanism growth per STRUCTURAL CLASS, which is validated growth, and
  it is categorically different from one reader per task, which is the
  incident-registry prohibition already recorded in the generality verdict.
- **Class comes back ~1.** Then the verdict is that the merge gate is a
  **correct NARROW instrument**: keep it, scope it honestly, and **stop billing
  it as the general mechanism**. §6's generality would then live only where it
  has demonstrably transferred already — the method layer (the
  downstream-of-decision law, the scope-defect mechanism, the agreement-check
  law, the review protocol), which is running in three lanes and which this
  week's work actually produced.

**Registered now so neither branch can be argued for after the fact.** A ~1
result is a fine outcome and must not be treated as a failure to be re-measured
with a friendlier question — that would be the sweep-bounds relocation at the
level of the census.

## Kill conditions

- If Q1 cannot be decided from the verifier for **more than half** the corpus,
  the verifier-shape frame is the wrong instrument and this half of the census is
  reported as inconclusive rather than padded with inference.
- If the two lanes' frames disagree on **more than a third** of tasks, the
  disagreement is the finding and no count is published until it is explained.

## Contamination declared

I already know raman's element structure intimately (17 anchors, affine family)
and cannot un-know it. `raman-fitting` is therefore recorded as a **known
positive and excluded from the headline count**, quoted separately. Every other
task is unread by me on both questions as of this registration.

**Extended: ALL self-authored probe tasks are excluded from the headline**, not
just raman. Tasks we wrote can only be evidence about our own habits, never about
the benchmark's population — and the previous census demonstrated the cost
concretely: five of its six series-bearing trees were ours, inflating the
apparent count 6×. The denominator is **genuine benchmark tasks only**, stated
explicitly so no reader can reconstruct a friendlier one.

## What this is NOT

Not a design document. **No divide-v2 is to be designed before the count
exists** — designing it now would repeat exactly the failure the 1/99 census
exposed, where four rounds of review-against-review produced a correct artifact
nobody had checked against the task population.
