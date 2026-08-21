# VERDICT — the cap manufactured the mode. 8/8 flipped.

Pre-registered outcome **A**, and the registered prediction (`capability`
dominant for path-tracing) held. One variable changed: the judge stopped
receiving a silently truncated trajectory.

## Result

| session | BEFORE (cap 8,000) | AFTER (cap 200,000 + notice) |
|---|---|---|
| 8f3cd0 | incomplete | **capability** |
| 7840dd | incomplete | **looks_done** |
| b948ae | incomplete | **capability** |
| 82bbaf | incomplete | **capability** |
| e3f22d | incomplete | **capability** |
| 7513b2 | incomplete | **capability** |
| 3a14a5 | incomplete | **capability** |
| c5933f | incomplete | **capability** |

**`incomplete = 8/8` -> `capability = 7, looks_done = 1`. Not one survived.**

## The narratives changed character, not just content

BEFORE — a description of where the WINDOW stopped:
> *"the trajectory ends before any image.c file is written or compiled"*

AFTER — specific, numeric, checkable against the run:
> *"After exhausting radial-gradient, checkerboard, and multiple hash/noise
> reconstructions, similarity plateaued around **0.81-0.82**, far short of
> **0.99**"*
> *"the agent pivoted to extracting exact pixel blocks from the target image
> into hardcoded LUT arrays"* — proxy validation, hence `looks_done`.

The truncated judge was not guessing badly. It was reporting its input
faithfully. Given the whole session it produces a diagnosis with real numbers
in it.

## What this kills

1. **`incomplete = 8/8` was an instrument artifact.** Confirmed by intervention,
   not inference. The unanimity was the tell.
2. **The L1 trial's diagnosis — mode AND narrative.** Both were readouts of the
   cap.
3. **Bullet b7's premise.** The proposer emitted *"cap exploration to a fixed
   number of steps, then write and test a first-draft implementation"* from a
   diagnosis that said the agents never got to implementation. They did, 6-23
   compile-run cycles each, and the real wall is **capability** — they could not
   infer the generative model. b7 prescribes a fix for a failure that did not
   occur.
4. **path-tracing's class membership.** `capability` is the pure-difficulty
   class. §5 places path-tracing in the LENGTH sub-band as its heaviest member
   (12/14). That assignment is wrong.
5. **The length sub-band's remaining evidence.** `llm-inference-batching-scheduler`
   also classified `capability`. Two of the sub-band's four named members now
   read as pure-difficulty on full-context classification.
6. **Level 2's motivating evidence.** It rested entirely on the 8/8.

## The scope nobody has bounded yet

**Every judge-based classification this repo has produced ran through
`cap = 8_000`.** The failure taxonomy is one consumer; `buildJudgeAuditPrompt`
is the other. Any verdict derived from a judge reading a trajectory longer than
8,000 rendered characters is suspect by the same mechanism, and trajectories in
this store run to 66,508.

That is not a claim that those verdicts are wrong. It is a claim that **their
evidentiary basis was truncated and nobody knew**, and re-running them is now
cheap and mechanical.

## Method note

First correct registered prediction of the session, against three refuted ones
earlier today. It was cheap to be right here for a specific reason: the
prediction was derived from a DIRECT MEASUREMENT of the artifact (7/7 wrote and
compiled) rather than from a model's narrative about it. The three refuted
predictions were all reasoning about behaviour; this one was reasoning from
bytes.
