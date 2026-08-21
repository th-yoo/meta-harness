# Scoring-judge paired-render probe — PRE-REGISTRATION

Registered before any call. Probes the fix I made to `judge.ts` (a2cf26b) and
never tested empirically — only unit tests ran.

## Why this and not a re-judge of history

The 26 historical maker-checker sessions have judge verdicts but **0/26 have
stored trajectories**, so they cannot be re-judged. Paired renders on trajectories
we DO have is the available design (cross-lane proposal): same session, same
judge, same everything — only the renderer differs.

## Design

3 real path-tracing trajectories from v20 (43,999 / 55,583 / 66,508 rendered
chars). For each, build `buildJudgePrompt` twice:

- **OLD**: cap 8,000, bare slice, no notice (the shipped behaviour)
- **NEW**: cap 200,000 + in-band truncation notice (the fix)

6 judge calls, `anthropic/claude-sonnet-5`, tool-free deny-all agent.

## Ground truth

All three FAILED — reward 0 from the container verifier (`reward.txt`),
mechanical, no judge in that path. So the correct verdict is `passed: false`.

## Pre-registered outcomes

- **A: OLD mis-verdicts, NEW correct.** The window damages scoring; the fix
  repairs it. Strongest result.
- **B: both correct.** The fix is harmless but the window did not damage THESE
  verdicts — the historical 3/3 disagreement then needs another explanation.
- **C: both wrong.** Judge cannot score this task class at all; the renderer is
  not the binding problem here.
- **D: NEW wrong, OLD correct.** The fix HARMS. Registered because it must be
  reportable — more context can bury the signal.

## Registered prediction

**B or C, not A.** These sessions end without a submission, and even an 8,000-char
prefix shows an agent still mid-investigation — which reads as "not accomplished"
and lands on the correct verdict for the wrong reason. The window's damage
signature in the historical data was judge=FAIL / human=PASS, i.e. under-crediting
**successful** work. All three of these actually failed, so the window has no
success to hide. **This probe is therefore aimed at the case least likely to
show the effect** — stated now so a null is not later read as exonerating.

## Falsifier

If OLD and NEW verdicts are identical on all three, this probe provides NO
evidence the scoring fix matters, and the honest report is that the fix rests on
the taxonomy result plus the historical correlation, not on a direct measurement
of the scoring path.
