# Step 0 — does exploration leave CARRYABLE artifacts? PRE-REGISTRATION

Zero spend: re-reads trajectories already in the store. Registered before
reading any of them.

## Why this gates the level-2 design

A level-2 phase split (bounded explore -> forced handoff -> implement) can only
work if there is something to hand off. If the exploration's findings live only
in context and evaporate at the cut, a bare phase-split hands the implement
phase nothing and the device needs an artifact-FORCING component before it can
work at all.

## Corpus

The 8 `incomplete` failures classified today (`v20` traj dir): 7 `path-tracing`
+ 1 `llm-inference-batching-scheduler`. Traj format is ndjson of
`{t:"text"|"tool", tool, args, output}`.

## The measurement, and the distinction that matters

Per trajectory, count and classify every WRITE the agent performed during
exploration:

- **PROCESS artifacts** — scratch scripts, sampling programs, one-off probes.
  Evidence the agent worked, but a script is a TOOL, not a finding.
- **UNDERSTANDING artifacts** — notes, summaries, parameter values, extracted
  structure written to disk. These are what a handoff could carry.
- **TARGET artifact** — the deliverable itself (`image.c`). Known absent from
  the taxonomy's `failurePoint` fields, recorded for completeness.

The taxonomy root causes already say agents ran "repeated bash/python sampling
scripts", so PROCESS artifacts are expected. **The open question is whether any
UNDERSTANDING artifact exists.** A phase-cut carries files, not context.

## Pre-registered outcomes

- **A: understanding artifacts present** — a bare phase-cut has something to
  hand off. Level-2 design is a plain split; rung-4's pro-forma risk is less
  applicable.
- **B: only process artifacts** — the findings live in context and die at the
  cut. Level 2 REQUIRES an artifact-forcing component ("write what you learned
  before proceeding"), and rung-4's compliance-without-competence becomes the
  primary risk, so the pro-forma marker becomes the primary endpoint.
- **C: no writes at all** — exploration is pure reading. Strongest form of B.
- **D: corpus unreadable** — infrastructure, recorded as such.

## Registered prediction

**B.** The taxonomy's own root causes describe iterative sampling and
hypothesis-testing, none of which mentions recording conclusions. Agents write
scripts to look, then hold what they saw in context.

If B holds, it also explains the L1 bullet's shape: the proposer said "cap
exploration, write a first draft" — a draft IS an understanding artifact, so
the bullet and the level-2 device are the same intervention at two altitudes.
