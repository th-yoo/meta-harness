# Addendum 01 — NOT judge fabrication: an 8,000-char cap manufactured the mode

Cross-lane challenge: *attribute before fixing — check what the judge was FED.*
Done. My verdict said "the judge fabricated its central fact." **That is wrong,
and the truth is worse.**

## The cap

`judge-audit.ts:40` — `renderJudgeAuditEvents(events, cap = 8_000)`, ending
`return lines.join("\n").slice(0, cap)`.

The judge sees **8,000 characters**. The path-tracing trajectories render to
**21,673 – 66,508** characters. **The judge saw 12–38% of each session.**

## Session-ID join, 8/8 matched

| traj | first `image.c` write | judge's failurePoint |
|---|---|---|
| 8f3cd0 | outside @ 9,836 | "trajectory ends before any image.c is written" |
| 7840dd | **INSIDE** @ 6,725 | "ends before ever [writing]" |
| b948ae | outside @ 18,700 | "spent the entire trajectory analyzing" |
| 82bbaf | outside @ 23,262 | "never progressed past open-ended analysis" |
| e3f22d | outside @ 8,700 | "still doing manual pixel-sampling analysis" |
| 7513b2 | **INSIDE** @ 1,235 | **"After the initial low-similarity gradient attempt (0.893)"** |
| 3a14a5 | outside @ 11,986 | "still reverse-engineering ... when the trajectory ends" |
| c5933f | n/a (different task) | "ends after data/tooling exploration" |

**5 of 8: the write is outside the window. The judge could not have known.**
**1 of 8 (7513b2): the write was inside — and the judge REPORTED IT accurately**,
naming the attempt and its similarity score. Only **1 of 8** (7840dd) looks like
genuine judge error.

## The judge was not lying — it was describing its input

Its recurring phrase is *"the trajectory ends."* For the judge, **it did.** The
word "trajectory" meant "what I was given." The false claim is not the judge's
sentence; it is the PIPELINE's implicit assertion that 8,000 characters ARE the
trajectory.

Same class as F5 (head/tail-20 sampler made the peak structurally invisible, the
model back-solved a confident story) and the `--layers none` capture loss (the
reviewer filled the hole and put the number in the sentence that overturned the
verdict). Third instance of: **a silent truncation, and a fluent narrative
covering the gap.**

## The consequence that matters most

**Truncation MANUFACTURES the `incomplete` mode.** `incomplete` is defined as
*"the attempt stops partway with work visibly unfinished."* A window cut at 8,000
characters stops partway with work visibly unfinished **by construction** —
whatever the session actually did.

So `incomplete = 8/8` is not a finding about the length sub-band. It is very
likely a readout of the cap. **The unanimity I cited as strong signal was the
tell**: eight independent sessions agreeing perfectly is what a shared artifact
of the instrument looks like, not what eight agent behaviours look like.

## Corrections

1. My verdict's "the judge fabricated" — **RETRACTED**. Attribution is
   input blindness (5/8), accurate reporting (1/8), probable judge error (1/8).
2. The fix is the **pipeline**, not the judge prompt. `cap = 8_000` is an
   unswept, unjustified default that silently bounds what any taxonomy can know
   — the same unmeasured-constant class audited all day, in the one place where
   it determines what is knowable rather than what is allowed.
3. `incomplete = 8/8` is **suspect as a mode**, not merely as a narrative. My
   earlier concession ("keep incomplete-as-mode, discard the causal story") was
   too generous. The cross-lane test applies: keep only what is mechanically
   recomputable from the ndjson without the judge.

## Standing

The L1 trial's outcome numbers never passed through the judge and are unaffected.
Everything the taxonomy asserted — mode and narrative alike — is now pending
recomputation.
