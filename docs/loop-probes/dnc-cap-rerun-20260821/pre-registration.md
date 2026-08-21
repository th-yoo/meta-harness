# Cap-fix re-run — PRE-REGISTRATION (2026-08-21)

Registered before the re-run. Same 8 sessions, same judge model, one variable
changed: the trajectory the judge receives is no longer silently truncated at
8,000 characters.

## The question

**Did the 8,000-char cap MANUFACTURE `incomplete = 8/8`?**

`incomplete` is defined as *"stops partway with work visibly unfinished."* A
window cut mid-session satisfies that description by construction. The judge saw
12-38% of each session; in 5 of 7 the first `image.c` write fell outside the
window. Every one of those sessions actually wrote, compiled and ran the target,
6-23 compile-run cycles each.

## Before (preserved verbatim)

`taxonomy-BEFORE-cap-fix.json` — 8 entries, `{incomplete: 8}`, unanimous.

## Method

`failure-taxonomy --layer account-global --candidate v20 --limit 30 --model
anthropic/claude-sonnet-5`, run from the `fix/judge-window` worktree. Identical
invocation to the original except for the code fix (`DEFAULT_TRAJ_CAP` 200_000 +
in-band truncation notice). ~8-13 judge calls.

## Pre-registered outcomes

- **A: modes MOVE substantially** (`incomplete` drops below 8/8, replaced by
  `capability` / `looks_done` / `spec_precision`). The cap manufactured the mode.
  The L1 trial's diagnosis, bullet b7's premise, and §5's length-sub-band
  membership for path-tracing all fall with it.
- **B: modes hold at `incomplete = 8/8`.** The cap was not the cause; these
  sessions genuinely exhausted runway despite writing and compiling. The
  narrative text was wrong, the mode label was right, and my
  cap-manufactured-the-mode claim is REFUTED.
- **C: mixed** — some move, some hold. Report per-session with the join, no
  pooled headline.
- **D: transport/infra failure** — recorded as such, never dressed as a result.

## Registered prediction

**A, and specifically `capability` for most of the 7 path-tracing sessions.**
They converged, implemented, compiled, ran and iterated, and still failed —
that is the accuracy-wall signature, not a runway signature. If A holds with
`capability` dominant, path-tracing belongs in the pure-difficulty class and §5's
arm assignment is wrong for the sub-band's heaviest member.

**Registered counter-consideration** (so B is not explained away): these runs DID
end without a passing submission, and `incomplete` may still be defensible on
budget-exhaustion grounds alone. If B holds I will not reinterpret it as a
partial win — the claim "the cap manufactured the mode" simply fails.

## Guard

The BEFORE file is preserved OUTSIDE the store, because the re-run overwrites
`v20/taxonomy.json` in place. Verdicts are immutable; this is a new probe, not
an edit of the L1 trial's verdict.
