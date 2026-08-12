# Review — fix-default-bench-model

reviewed-range: bed723342f62348626c56e48188ac52b98deb525..32ebccd365f2ba073bf3f9b93bae32fe8be6cac5
reviewer: fresh-context-general-purpose-subagent (claude-fable-5)
fresh-context: true
verdict: approved
findings-count: 2

## Scope

One-line constant change `opencode-plugin/src/bench/paths.ts:28`
DEFAULT_BENCH_MODEL `anthropic/claude-sonnet-4-6` → `anthropic/claude-sonnet-5`
plus a literal pin test appended to `opencode-plugin/test/bench-cmd-run.test.ts`.
74/74 tests green on the file, tsc clean. Diff verified exactly these two hunks.

## Findings (both advisory, neither blocks)

1. The commit message's "every documented invocation passes --model" is
   overstated: `docs/usage-manual.md:252,318,319` (and `reboot.md:54`, flags
   elided) show `run` invocations without `--model`, which now silently
   default to sonnet-5 instead of sonnet-4-6. Mitigated: the model is
   stamped per record in results files (`writeRunResults`, test-pinned) and
   store session records, so mixed-model data is attributable and
   filterable — no silent corruption. The old default was already
   adjudicated a defect ("silent default sonnet-4-6 = R1-class trap",
   resume.md; Stage-1 runbook calls it "the WRONG model, silently");
   the change direction is repo-policy-correct.
2. Advisory: opencode's resolution of the id `anthropic/claude-sonnet-5`
   was flagged OPEN in the Stage-1 runbook pre-go check (2026-08-03). The
   id is the repo's adjudicated subject model already used in
   `scripts/stage1-screen.sh:29,38`; a bad id at default fails fast and
   loudly.

## Comparability

Pre-change data (sonnet-4-6) stays distinguishable per record; no
re-baseline forced. This commit is the dated, greppable boundary.
