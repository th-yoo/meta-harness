# Addendum 01 — stage 1 was a TRANSPORT failure, not a result (2026-08-21)

Pre-registration outcome **D**, recorded as such per its own rule ("an
infrastructure result, recorded as such, never dressed as an abstention").

## What happened

`failure-taxonomy --layer account-global --candidate v17 --limit 30` exited 0
and reported:

```
taxonomy: 20 classified → other=20
(recency-capped at 30 — a biased sample, not the full failure set)
```

Every judge call logged `judge transient provider error` and burned all three
attempts before falling back to `other`. **All 20 entries are unclassified.**

## Root cause

`DEFAULT_JUDGE_MODEL = "openrouter/google/gemini-2.5-flash"`
(`judge-audit.ts:28`), but opencode's `~/.local/share/opencode/auth.json`
contains exactly one provider: **`anthropic`**. There is no `openrouter`
credential on this host, so the route can never resolve.

**The failure is PERMANENT, and it is labelled TRANSIENT.** `TRANSIENT_MARK`
(`agent-run.ts:39`) matches the provider's message and the retry wrapper treats
it as worth three attempts. A misconfiguration and a flaky provider are
indistinguishable in this log, and the command still exits 0.

This is the `lane-a-audit-transport-dead` class recurring at a different call
site: a transport that could never place a call, reported as an ordinary
negative result. The general form, already recorded: **exit 0 plus a plausible
output is not evidence that the path ran.**

## Why stage 2 was NOT entered

Proposer rule 2 targets the highest-count mode. With `other=20` the top mode is
the unclassified bucket, which names no fix class. Running `propose-lesson` on
that taxonomy would have spent a model call on a broken input and produced a
bullet — or an abstention — that would then have been read as evidence about the
ladder question. That is the reconstruct-the-missing-data trap the resume banner
already names.

**The spend gate registered between stages 2 and 3 did its job at stage 1→2
instead.**

## Deviation from the pre-registration, declared

Re-running stage 1 with `--model anthropic/claude-sonnet-5` — the provider that
IS authenticated here, and the tier the bench itself runs at
(`DEFAULT_BENCH_MODEL`). `--model` is a first-class argument of
`failure-taxonomy`, so this is configuration, not a bypass.

**Declared confound:** prior cranks' taxonomies (v18, v20) were classified by
gemini-flash. This one will be classified by sonnet. For a classifier feeding a
diagnosis this is a provenance difference that must not be silently compared
across cranks — proposer rule 10 (PROVENANCE guard) applies. Any cross-crank
mode-count comparison from this taxonomy is invalid.

## Standing repair, not done here

`DEFAULT_JUDGE_MODEL` pointing at an unconfigured provider is a live defect for
anyone running this path on this host. Fixing it is a code change and is **not**
part of this trial's spend go; recorded here so it is not rediscovered.
