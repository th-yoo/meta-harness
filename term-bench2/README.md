# term-bench2 runner

`runner.ts` (Bun) runs Terminal-Bench 2 tasks in a **podman** sandbox — one
fresh container per task attempt — and composes the meta-harness layers into
the task's `AGENTS.md`. It replaced the old Python `runner.py` + bwrap sandbox
(deleted; see [docs/python-elimination.md](../docs/python-elimination.md) for
the port rationale and history).

## Quick start

```bash
# one-time: build the bench image (localhost/mh-bench:latest)
bun runner.ts prep            # dry-run: prints the podman build command
bun runner.ts prep --apply    # actually builds

# pipeline sanity check, no LLM
bun runner.ts oracle --tasks sqlite-db-truncate

# agent run
bun runner.ts run --task-file baseline-tasks.txt --model anthropic/claude-haiku-4-5 \
  --layers account --k 5 --results-file results/haiku-k5.json
```

Subcommands: `prep | oracle | run | ab | judge-audit | split | report-loop`.
Run `bun runner.ts` with no args for the full flag reference. The TB2 clone is
expected at `../terminal-bench-2` (override with the global `--tb-root PATH`).

## Concurrency

Concurrent runs are safe **natively**: every task attempt gets its own podman
container with a collision-free name (`mh-<task>-<tag>-<epochms>-<hex>`), and
only the task's own paths are mounted — there is no shared host-side sandbox
state.

The bwrap-era `MH_BENCH_WORK` per-run sandbox root is **gone** (the Bun runner
ignores it). Per-run outputs still need distinct `--results-file` paths.

What concurrency does **not** cover (unchanged, deliberate non-goal): two
concurrent `ab` invocations racing the shared `score.json`/meta-metrics store —
that store sits outside the sandbox. See
[docs/explicitly-not-now.md](../docs/explicitly-not-now.md) §5.

## `run-parallel.sh` — turnkey parallel runs

```bash
bash run-parallel.sh --task-file baseline-tasks.txt --layers account --max-agent-timeout 600 -- \
  anthropic/claude-haiku-4-5:results/haiku-k5.json \
  anthropic/claude-sonnet-4-6:results/sonnet-k5.json
```

Launches one `runner.ts run` per `MODEL:RESULTS_FILE` spec concurrently, logs
each to `<results-file>.log`, and prints each run's pass rate at the end.
`--dry-run` prints the commands without launching.

## Verifying isolation (token-free)

```bash
bash check-concurrency.sh sqlite-db-truncate sqlite-with-gcov
```

Runs two `oracle` invocations (no LLM) per task concurrently and asserts both
pass — proving per-container workspace isolation holds under concurrency.

## Running with multiple agent drivers

The runner supports pluggable agent drivers via `--driver {opencode|claude-code}` (default: `opencode`). Each driver runs a different agent binary (e.g. the opencode CLI vs. the Claude Code CLI) but implements the same contract for output parsing, tool tracking, and attempt classification (the driver classifies attempts for the retry loop; the verifier decides task success). This allows evaluating different agents on the same task set. See [usage-manual.md](../docs/usage-manual.md) for driver details and authentication setup.
