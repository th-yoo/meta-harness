# Dangerous-case arm: does the window under-credit SUCCESS? PRE-REGISTRATION

Registered before any call. This is the arm the previous paired probe could not
test.

## Why this is the decisive case

The window's damage mode, from the historical maker-checker data, is
**judge=FAIL / human=PASS** — under-crediting work that was completed. The
earlier paired probe used three sessions that all FAILED, so the window had no
success to hide. Registered at the time as "aimed at the case least likely to
show the effect", and it nulled exactly as predicted.

These are **real, SUT-produced, `reward.txt`-grounded PASSES** that render longer
than the old window. No synthesis, no authorship-boundary issue.

## Sessions (longest first, all verified `passed: true`)

| rendered | session |
|---|---|
| 16,953 | `bench-dna-assembly-1787131382-78864b` |
| 13,349 | `bench-llm-inference-batching-scheduler-1786526516-5d7fd4` |
| 13,068 | `bench-sanitize-git-repo-1787029858-73fe40` |

## Design

Per session, `buildJudgePrompt` twice: **OLD** (bare slice at 8,000, no notice)
vs **NEW** (cap 200,000 + in-band notice). Same judge, same rubric. 6 calls,
`anthropic/claude-sonnet-5`, tool-free deny-all agent.

Ground truth: **PASS** for all three (`reward.txt` = 1, mechanical).

## Pre-registered outcomes

- **A: OLD says FAIL on a passing session, NEW says PASS.** The window
  under-credits success under control. Reproduces the historical signature.
  Strongest possible support for the fix.
- **B: both say PASS.** No under-crediting at these lengths. The fix gains no
  scoring-outcome support from this arm either, and the honest report is that
  scoring damage remains unmeasured.
- **C: both say FAIL.** Judge cannot score this task class; renderer irrelevant.
- **D: OLD PASS, NEW FAIL.** The fix harms. Registered because it must be
  reportable.

## Registered prediction

**B, weakly — but much less confidently than last time.** These render
16,953 / 13,349 / 13,068 chars, i.e. the judge sees ~47-60% of each, versus
12-38% on the failing set. **Truncation here is mild**, and the completed work in
a passing session tends to sit at the END, which is precisely what a prefix cuts.
So A is live in a way it was not before. Effect size should be smaller than the
historical 3/3 because those sessions ran 7-34 turns and these are shorter.

## Falsifier / limit, stated first

If B, this arm still does NOT exonerate the window — it bounds the damage as
absent at ~2x truncation, leaving the 5-9x regime (43k-79k) untested for
successes, because **no passing trajectory that long exists in the store**. That
is a hard archive limit, not a choice.

Reason-level scoring also applies: per the cross-lane consumer split, verdict
agreement can null while REASON truth diverges. Reasons will be dereferenced
against the raw ndjson regardless of verdict.
