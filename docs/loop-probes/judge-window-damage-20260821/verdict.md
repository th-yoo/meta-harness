# Window damage on INDEPENDENT data — the maker-checker record

Zero spend. Cross-lane suggestion: the historical shadow-judge sessions carry
BOTH a windowed judge verdict AND a human score, with agreement tracked. That is
an already-collected measurement of the 8,000-char window's real-world damage on
a path where humans were checking — independent of the taxonomy both lanes have
been staring at.

## Result

26 sessions across v4/v5/v6/v17 carry both verdicts. Split by turn count:

| group | disagreement |
|---|---|
| SHORT (<= 2 turns) | **5/23 = 22%** |
| LONG (> 2 turns) | **3/3 = 100%** |

Every multi-turn session disagreed. Every one.

| version | turns | judge | human |
|---|---|---|---|
| v17 | 7 | False | True |
| v17 | 20 | False | True |
| v17 | 34 | True | False |

**Two of the three long disagreements have the window's exact signature**: the
judge says FAIL where the human says PASS — the reading you get from a prefix
that stops before the work completes. That is the same failure as
*"the trajectory ends before any image.c is written"*, in the scoring path,
against a human control.

## What it does and does not establish

**Does:** on independent data, judge-human disagreement is far higher on long
sessions than short ones, and the long-session errors run in the direction the
window predicts (under-crediting completed work).

**Does not:** n = 3 at the long end. Three sessions is an observation, not a
rate. `turnCount` is also a PROXY — these are kkamak sessions whose trajectories
I do not have, so I cannot confirm they exceeded 8,000 rendered characters. A
34-turn session almost certainly did; a 1-turn session almost certainly did not.
That inference is reasonable and it is still an inference.

**Separate fact worth keeping:** short sessions disagree 22% of the time, and
those are almost certainly UNWINDOWED (1-2 turns). So ~22% is the judge's
baseline disagreement with humans, independent of truncation. The window's
contribution is whatever the long-session excess is — and 100% vs 22% is a large
excess on a tiny sample.

## Why this evidence is worth more than its n

It is the only measurement of window damage that does not come from the artifact
the hypothesis was formed on. The taxonomy flip (8/8) and this (3/3 long-session
disagreement) are independent corpora, independent paths (classification vs
scoring), and independent controls (a code change vs a human scorer). Agreeing
by different routes is the thing neither lane could manufacture by review.

## Registered follow-on, not run

The paired-render design proposed cross-lane removes my sample's fatal limit
(all 8 taxonomy sessions were over-cap, so length had no variance): re-run the
SAME long trajectories through the OLD 8k renderer and the NEW uncapped one.
Old-render reproducing the historical entries doubles as the A/A stability
measurement that is currently missing. If old-render does NOT reproduce them,
the window story loses its main support and judge instability re-enters.
