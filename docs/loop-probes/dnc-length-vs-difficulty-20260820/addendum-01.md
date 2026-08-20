# Addendum 01 — post-verdict peer review (sibling lane, 2026-08-20)

Source: cross-session review of `verdict.md` @ `44ef03b` by `meta-harness-1e`.
Adopted as design constraints for any second pass or L2 probe; the verdict
itself is unchanged.

## A1 — the cleaner classifier is the within-task fail/pass ratio

Absolute output size and last-error position confound TASK IDENTITY with
length (a task can be verbose without being length-failing). The
within-task fail/pass output ratio (llm-inference-batching: 4.18×) controls
for task identity by construction, and the band has both passes and fails by
construction. Any second classification pass should lead with that ratio,
not the pooled quartile cutoffs.

## A2 — thrash is a THIRD class: GATE-shaped stuckness

Retry-against-gate stuckness (raman-fitting + sam-cell-seg, 53/75 thrash
sessions, all at exactly the rule's minimum count) is neither
length-induced nor difficulty-induced — it is gate-shaped, and D&C predicts
zero lift on it. Three classes, not two: an L2 probe that pools these tasks
into EITHER arm dilutes both.

The count==1 pileup is itself the parameter-shaped-boundary tell: the class
exists because the rule's minimum made it sayable. The M6 threshold (≥3
occurrences, ≥2 in final third) manufactured a bright line at its own floor
— same family as fitted shape thresholds; a future rubric should report the
raw repeat distribution, not a thresholded boolean.

## A3 — treatment lift is within-task only

The length sub-band is observational and task-confounded. Any eventual L2
probe measures lift WITHIN-TASK against that task's own stored baseline,
never cross-task. Per-task baselines already exist in the store — this
constraint costs nothing.

## A4 — the control arm is the method

The pure-difficulty control (torch-tensor-parallelism, polyglot-rust-c,
configure-git-webserver) is "build the input that should break it" applied
to an experiment: if those tasks lift under L2, the mechanism claim is
refuted regardless of sub-band lift.
