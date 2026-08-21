# VERDICT — outcome B. The registered falsifier FIRED.

Pre-registered outcome **B: both arms correct.** My registered falsifier said:
*"If OLD and NEW verdicts are identical on all three, this probe provides NO
evidence the scoring fix matters."* **It fired. I am reporting it as such.**

## Verdicts: 6/6 correct, both arms, no difference

Ground truth: all three FAILED (`reward.txt` = 0, mechanical, no judge in path).

| session | OLD verdict | NEW verdict |
|---|---|---|
| e3f22d | false (CORRECT) | false (CORRECT) |
| 7513b2 | false (CORRECT) | false (CORRECT) |
| 82bbaf | false (CORRECT) | false (CORRECT) |

**The fix changed no scoring outcome here.** On the registered terms, this probe
does not support the scoring fix.

## What DID differ — reported as unregistered observation, not as rescue

| session | OLD conf | OLD reason | NEW conf | NEW reason |
|---|---|---|---|---|
| e3f22d | 0.70 | "ending mid-investigation, no evidence" | 0.92 | "final measured similarity was only 0.96" |
| 7513b2 | 0.70 | "truncated mid-investigation" | 0.85 | "final … ~0.99 per agent's own stated target" |
| 82bbaf | 0.75 | "**No evidence of image.c being written, compiled, or verified**" | 0.95 | "acknowledged final similarity of only **0.754**" |

**`82bbaf`'s OLD reason is demonstrably FALSE.** That session wrote `image.c` 5
times, compiled 9 times, ran 9 times — counted directly in the raw ndjson
(`dnc-level2-carryable-20260821`). The judge asserted absence of work that
happened.

So the pattern is **right answer, false reason**: OLD concludes `false` because
the prefix LOOKS unfinished; NEW concludes `false` because the reconstruction
actually missed the 0.99 bar. Confidence rises 0.15-0.20 with full context.

This is the ∀-fragility formalised cross-lane: every OLD reason is an ABSENCE
claim through a window, and a windowed witness cannot testify to absence.

## Why this probe was aimed at the weakest case, stated BEFORE running

Registered: *"These sessions all FAILED, so the window has no success to hide.
The historical damage signature was judge=FAIL / human=PASS — under-crediting
SUCCESSFUL work. This probe is therefore aimed at the case least likely to show
the effect."*

That held. A null here is **not** evidence the window is harmless; it is evidence
that on already-failing sessions the window's error mode has nothing to bite on.
The dangerous case — a long SUCCESSFUL session scored from its opening prefix —
is untested, and the 26 historical sessions that would test it have **0/26
trajectories stored**, so it cannot be tested from the archive.

## Honest standing of the judge.ts fix

- **No direct evidence it changes scoring outcomes.** (This probe, registered
  terms.)
- **Direct evidence it changes the EVIDENCE scores rest on** — false absence
  claims replaced by measured values. Unregistered, so weaker, but checkable and
  checked.
- **Indirect support**: the taxonomy flip (8/8) and the historical maker-checker
  correlation (3/3 long-session disagreement vs 22% baseline).

The fix is justified on defect grounds — a judge that cannot know it holds a
prefix will make absence claims about prefixes, and two of three did. It is NOT
justified by a measured scoring-outcome improvement, and I am not going to claim
one.

## Second correct registered prediction today

Against three refuted ones. Both correct predictions came from measuring the
artifact first (7/7 write-compile-run; these sessions all failed, so no success
to hide). The three refuted ones were reasoning about behaviour.
