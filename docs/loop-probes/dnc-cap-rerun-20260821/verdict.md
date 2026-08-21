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

---

# ADDENDUM 01 — the first re-run was CONFOUNDED; corrected, conclusion holds

The verdict above claims *"one variable changed."* **That was false**, caught by
the user asking whether the probe environment had a flaw. It did, and I built it.

## The flaw

`makeBenchPaths` derives `tbRoot` from `findMetaRoot`, which walks up from the
SOURCE FILE — not from `META_HARNESS_HOME`. From the main tree that resolves to
`~/z2/terminal-bench-2` (correct). **From a worktree it resolves to
`.claude/worktrees/terminal-bench-2`, which does not exist.**

`cmd-failure-taxonomy:61-62` then does
`existsSync(instrPath) ? readFileSync(...) : ""` — **a silent empty-string
fallback.** The judge is asked to classify against *"the acceptance criteria the
agent was given"* and handed nothing, with no warning, no flag, and no record.

So the compared runs differed in TWO ways:

| run | cap | task instruction |
|---|---|---|
| BEFORE (main tree) | 8,000 | **present** |
| AFTER (worktree) | 200,000 | **ABSENT** |

**Third instance of the same pattern in one session** — 8,000-char cap (silent
window), missing tbRoot (silent empty instruction), and my own `nohup` under a
SIGTERM'd parent (silent process death). Missing input, silent substitution,
fluent output over the gap. I wrote up the first, then built the second.

## Correction: re-run with `--tb-root /home/th-yoo/z2/terminal-bench-2`

| session | BEFORE | AFTER-confounded | AFTER-clean | agree |
|---|---|---|---|---|
| 8f3cd0 | incomplete | capability | capability | yes |
| 7840dd | incomplete | looks_done | looks_done | yes |
| b948ae | incomplete | capability | capability | yes |
| 82bbaf | incomplete | capability | capability | yes |
| e3f22d | incomplete | capability | capability | yes |
| 7513b2 | incomplete | capability | capability | yes |
| 3a14a5 | incomplete | capability | capability | yes |
| c5933f | incomplete | capability | capability | yes |

**Per-session agreement between the two AFTER runs: 8/8. `incomplete` surviving:
0.**

The confound is **measured inert**, not argued inert. Every session received the
identical mode with and without the task instruction. The cap is the sole cause
of the flip, and the headline verdict stands unchanged.

## Two things this buys beyond the correction

1. **The right to say "the cap did it"** rather than "something in this change
   did it." That distinction is the entire point of a controlled comparison, and
   the first run had not earned it.
2. **An unplanned observation, recorded not concluded:** supplying or withholding
   the task instruction changed **no** classification across 8 sessions. The
   taxonomy prompt's instruction section may be doing no work. That is n=8 on one
   task pair and a single judge model — a lead, not a finding. It would be cheap
   to test properly and it bears on every taxonomy this repo runs.

## Standing

`taxonomy-AFTER-confounded-no-instruction.json` is preserved rather than deleted
— it is the evidence that the confound was inert, and deleting it would leave
only my assertion that it was.
