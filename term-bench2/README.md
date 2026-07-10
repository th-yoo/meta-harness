# term-bench2 runner — concurrent runs

`runner.py` runs each TB2 task in a bwrap sandbox. By default the sandbox's
writable dirs are backed by a single tree at `~/bench`, so **two `runner.py`
processes clobber each other**. To run several at once (e.g. a haiku and a
sonnet baseline in parallel), give each its own sandbox root.

## `MH_BENCH_WORK` — per-run sandbox root

```bash
MH_BENCH_WORK=~/bench-haiku  python3 runner.py run --model anthropic/claude-haiku-4-5  --results-file results/haiku.json  --layers account &
MH_BENCH_WORK=~/bench-sonnet python3 runner.py run --model anthropic/claude-sonnet-4-6 --results-file results/sonnet.json --layers account &
wait
```

- **Default (`MH_BENCH_WORK` unset): `~/bench`** — single-run behavior is unchanged.
- The value **MUST be a path under `$HOME`.** Only `$HOME` is bind-mounted into
  the sandbox, and `/app`/`/tests`/`/logs`/`/tmp` are symlinks resolved from the
  sandbox root — a `/tmp`-rooted work dir makes the `/tmp` symlink self-reference
  (ELOOP) and breaks every sandbox op.
- **Don't launch two *default* (`~/bench`) runs at once** — give at least one a
  distinct `MH_BENCH_WORK`.
- Each `--results-file` is per-run (its own path), so the run outputs never
  collide either.

Isolates `run`, `oracle`, and per-task `ab` sandbox execution. It does **not**
cover two concurrent `ab` invocations racing the shared `score.json`/meta-metrics
store (outside the sandbox) — not a goal here.

## `run-parallel.sh` — turnkey

```bash
bash run-parallel.sh --task-file baseline-tasks.txt --layers account --max-agent-timeout 600 -- \
  anthropic/claude-haiku-4-5:results/account-global-v0-baseline-haiku.json \
  anthropic/claude-sonnet-4-6:results/account-global-v0-baseline-sonnet.json
```

Assigns each spec a unique `MH_BENCH_WORK=$HOME/bench-runs/<results-stem>`,
launches them concurrently, prints each pass-rate, and removes the work dirs on
completion. Refuses non-`$HOME` roots and `~/bench`. `--dry-run` prints the
commands without launching.

## `/usr/local` (no more 225M copy)

`/usr/local` is read-only inside the sandbox (from `--ro-bind /usr`). Only
`/usr/local/bin` is writable, via a per-run **symlink farm** over a shadow mount
of the real `/usr/local` — existing binaries read/execute through it, and NEW
installs (e.g. `sqlite-with-gcov`'s `ln -s … /usr/local/bin/sqlite3`) land in the
writable farm. This replaced a 225M writable copytree.

- **New installs land cleanly.** Creating a `/usr/local/bin` name that isn't
  already present works (e.g. `sqlite-with-gcov` installs `sqlite3`, which
  otherwise lives in `/usr/bin`, so the farm doesn't pre-seed it). *Replacing* a
  pre-existing entry needs `ln -sf`/rm-first (a bare `ln -s` hits `EEXIST` on the
  pre-seeded symlink), and *modifying* a pre-existing binary in place fails (it
  reads through to the read-only real file). No baseline task needs either.
- The stale `~/bench/usrlocal` (from the old copytree) is dead — safe to
  `rm -rf ~/bench/usrlocal`.

## Verifying isolation (token-free)

```bash
bash check-concurrency.sh sqlite-db-truncate sqlite-with-gcov
```

Runs two `oracle` invocations (no LLM) per task on distinct `~/bench-test-*`
roots concurrently and asserts both pass — proving workspace isolation and the
writable-`/usr/local/bin` farm hold under concurrency. Also unit-covered:
`test_bench_isolation.py`.

## Blast-radius note

Each sandbox binds all of `$HOME`, so with N concurrent runs each run's agent can
in principle see the others' `~/bench-*` work trees. Fine for trusted baselines;
not an adversarial-isolation guarantee.
