# Bench resource enforcement + load-aware parallel scheduling — design

Date: 2026-07-16. Status: approved design (brainstormed interactively; scope +
packing rule chosen by user). Implementation plan follows via writing-plans
(`docs/superpowers/plans/`).

## Motivation

Three observations from the 2026-07-16 Phase-0 run and loop-2 postmortem:

1. **Containers are unconstrained.** `buildCreateArgv` (`sandbox.ts:43`) passes
   no `--cpus`/`--memory`, so any task can consume the whole podman VM (4 vCPU /
   8 GB on the MacBook). Perceived per-task load variance is mostly this.
2. **Load IS declared per task.** Every TB2 `task.toml` carries
   `[environment] cpus / memory_mb / storage_mb / gpus` (sweep over our 43
   baseline tasks: 42× `1 cpu`, 1× `2 cpu` (overfull-hbox); 2048–4096 MB; 10 GB
   storage; 0 GPUs) plus `agent.timeout_sec` 750–3600s. The leaderboard rule
   ("submissions may not modify timeouts or resources") makes the manifest the
   spec-honest configuration.
3. **Serial sweeps cost ~7 h/night.** With enforced 1-CPU containers, ~3-way
   parallelism on the 4-vCPU VM is principled and roughly halves that.

Goal: enforce declared resources (opt-in), schedule tasks by declared footprint
— parallel when light tasks fit a budget, sequential otherwise — and keep every
current behavior byte-identical when the new flags are off (shipped-dark
discipline, same as Loop-3's `recordTimeouts`).

## Non-goals / out of scope

- Enforcing `storage_mb` (podman storage quotas are storage-driver-dependent on
  applehv) and `gpus` (no GPU tasks; VM has none). Both are *read* and shown by
  `task-load`, not enforced. A task declaring `gpus > 0` is refused at scheduling
  time with a clear error when `--enforce-resources` is on (running it
  unconstrained would silently mismeasure).
- Multi-host / remote scheduling; k>1 attempt parallelism *within* a task;
  parallelism across the two arms of one ab task (arm symmetry requires the
  pair to run under identical contention conditions).
- Changing any default behavior. All new flags default off.
- Flipping the flags on for real loop runs — that is a re-baseline event and is
  explicitly bundled with the Loop-3 `recordTimeouts` flip (one re-baseline, not
  two). See `docs/superpowers/plans/2026-07-16-loop3-timeout-fix.md`.

## Design

### D1. Resource reading — `taskResources()` in `tasks.ts`

Mirror `taskTimeouts()` (`tasks.ts:120-149`): `Bun.TOML.parse` the task's
`task.toml`, tolerate missing file / parse failure / missing fields.

```ts
interface TaskResources { cpus: number; memoryMb: number; gpus: number; declared: boolean }
taskResources(paths, task): TaskResources   // fallback: {cpus: 1, memoryMb: 2048, gpus: 0, declared: false}
```

Fallback values are the modal declared footprint of the TB2 corpus. When
`declared: false` and enforcement is on, log one warning line (task name +
assumed footprint) — never crash.

### D2. Enforcement — `--enforce-resources` on `run` / `ab` / `oracle`

`SandboxSpec` (`sandbox.ts:32-41`) gains optional `resources?: { cpus: number;
memoryMb: number }`. When present, `buildCreateArgv` appends
`--cpus <cpus> --memory <memoryMb>m`. Threading follows each command's OWN
existing pattern (architect finding 6): `cmd-run.ts` computes resources in the
outer loop next to `taskTimeouts` (`cmd-run.ts:396`) and passes them through
`RunOneTaskFn` params; `cmd-oracle.ts` computes them INSIDE
`runOneOracleTask` (matching its internal `taskTimeouts` call at
`cmd-oracle.ts:131`) so the `RunOneOracleTask` injectable signature and its
existing unit-test fixtures stay unchanged. Absent flag → `resources`
undefined → argv byte-identical to today (existing argv tests stay green
unchanged).

Provenance (architect findings 1+3 — the `ac0cd18` bug class):

- **ab:** `EnvBlock` (`record.ts:189-196`) gains `resourceEnforcement: boolean`;
  it lands in `verdictDict.env` as informational metadata. It is **NOT added to
  `runIdent`** (`cmd-ab.ts:206-215`) — `resumeIdentCheck` (`splits.ts:198-204`)
  does strict `!==` over every key, so a new key would kill every pre-existing
  partial's `--resume` with the flags off. Instead, a dedicated coalescing
  guard compares `prev.env?.resourceEnforcement ?? false` against the current
  flag and dies only on a REAL regime mismatch; absent-vs-false is equal.
- **run:** `RunResultsMeta` (`results.ts:118-130`) has no env field today —
  it gains an optional `resourceEnforcement?: boolean` (absent = false, so old
  results files parse unchanged). `resumeCarryForward` (`results.ts:78-116`)
  gains a mismatch guard mirroring its existing hardcoded `driver` check
  (`results.ts:91-100`), with the same `?? false` coalesce so pre-feature
  files carry forward when the flag is off.

### D3. Scheduler — `--parallel` + budget packing

New module `bench/scheduler.ts`:

```ts
interface Budget { cpus: number; memoryMb: number }           // default {3, 6144}
schedule<T>(items: TaskItem[], budget, runFn): Promise<...>   // TaskItem = {task, resources}
```

- **Greedy, canonical order, no reordering:** launch `items[i]` when its
  footprint fits the *remaining* budget; otherwise wait for a completion. No
  skipping ahead (reordering would complicate ab's stop rule and log reading
  for zero measured benefit — the corpus is near-homogeneous).
- A task whose declared footprint exceeds the *total* budget runs **alone**
  (drain pool → run it solo → resume packing). This is the "otherwise
  sequential" arm of the user requirement.
- Default budget = VM(4 cpu/8 GB) minus 1 cpu/2 GB reserve for the VM kernel,
  podman, and verifier overhead. Overridable: `--cpu-budget N`, `--mem-budget MB`.
- The scheduled unit is the whole per-task pipeline (stage → create → agent →
  self-score → verifier → teardown). Within a task nothing changes.
- CLI validation: `--parallel` requires `--enforce-resources` (packing math
  against unenforced containers would be fiction) — hard error, not implicit
  enabling. Store-writing runs may use `--parallel` (D4 serializes their store
  writes). Budget flags without `--parallel` are a hard error.
- Serial path when `--parallel` absent: the existing `for` loop, untouched —
  not "scheduler with concurrency 1" — so the default path keeps zero new
  moving parts (byte-identical logs included).

### D4. Write serialization — in-process mutex

All shared-file mutation during parallel runs goes through one async mutex
(promise-chain, ~15 lines, in `scheduler.ts` or `util.ts`). The critical
section is the **whole call** — one `recordToStores` invocation (which does
multiple read-modify-write `recordSession` cycles plus trajectory writes), one
`writeRunResults`, one ab partial write — not individual `writeJsonAtomic`
calls, which would leave the `score.json` lost-update race open (architect
finding 7). Serial runs don't take the mutex path (no behavior change). This
makes store-writing runs safe under `--parallel`.

**Auth-mount race — `--parallel` requires API-key auth (architect finding 4).**
`agent-auth.ts:32-37` already documents that every container bind-mounts the
SAME rw credential dir (`opencodeDataDir`, `agent-auth.ts:156-167`; the
claude-code linux path mounts `~/.claude` rw directly) and that the plugin
rotates refresh tokens on use — concurrent containers can corrupt the durable
host credential store, and no in-process mutex can reach a race between
container processes. Per-container copies are worse (a rotated refresh token
in a copy strands the host's). Resolution has TWO required halves (a CLI gate
alone would NOT stop the mount from being created — architect re-review):

1. **Key-only auth mode in the mount layer.** `prepareAgentAuthMounts()`
   (`agent-auth.ts:111-183`) gains a `keyOnly` mode that returns env-only auth
   and NO rw credential mounts — porting the skip branch that
   `prepareClaudeCodeAuth` already has (`agent-auth.ts:243-245`) to the
   opencode path. Driver `prepareAuth` (`drivers/opencode.ts:174`) threads the
   mode through; under `--parallel` every container is created key-only, so
   the shared rw `opencodeDataDir` mount does not exist at all.
2. **Provider-specific gate, not the generic matcher.** `apiKeyEnv()`
   (`paths.ts:91-97`) matches ANY `*_API_KEY` and cannot vouch for the model
   in use. The `--parallel` gate instead derives the required variable from
   the model's provider prefix (`anthropic/claude-…` → `ANTHROPIC_API_KEY`,
   uppercase-provider + `_API_KEY` in general) and hard-errors if THAT exact
   variable is unset, or if the model string has no derivable provider prefix.
   The error message names the missing variable.

Oauth-mounted runs stay sequential (no `--parallel`), unchanged.

Log interleaving: when `--parallel` is on, per-task log lines get a
`[task-name]` prefix (the current bare `  reward=…` lines are unreadable when
interleaved). Serial log format unchanged.

### D5. `ab` under parallelism — canonical-order early-stop

ab's McNemar early-stop currently evaluates after each task in list order.
Under `--parallel`:

- Completed pairs are buffered per task; the stop rule consumes them **strictly
  in task-list order** (pair *i* is evaluated only when pairs 0..i-1 are
  consumed). Out-of-order completions wait in the buffer.
- Look-ahead is naturally capped by the budget width (~3 tasks), so at most
  ~2 in-flight tasks continue past a stop decision; their results are excluded
  from the verdict (compute waste, zero statistical contamination) but still
  recorded in the partial for `--resume` fidelity.
- **Mechanism (architect finding 2):** `taskResults` (`cmd-ab.ts:222`) is the
  single object behind both `verdictDict()` and the partial write, so exclusion
  needs a per-entry tag: `AbTaskResult` gains `postStop?: true`, set on any
  task whose pair completes after the stop rule fired. Inside `verdictDict()`,
  **every** derived field computes from one shared postStop-filtered view of
  `taskResults` — the `filterTaskResults`/`pairedRunStats` pipeline
  (`heldIn`/`heldOut`/`sentinels`/`decision`) AND the independent
  `nTasks`/`candidateRate`/`activeRate` filter at `cmd-ab.ts:274-277`, which
  today only excludes `error` entries and must additionally exclude `postStop`
  (otherwise stragglers leak into verdict-level summary fields). The full
  unfiltered `taskResults` map is still serialized under the partial's
  `taskResults` key for `--resume` fidelity. Serial runs never set the tag →
  verdicts and partials byte-identical to today.
- **Phase scoping (architect finding 5):** the scheduler is instantiated fresh
  per `runPhase` call (`cmd-ab.ts:374-375`) and fully drained before the phase
  returns — held-out tasks cannot launch until held-in's `earlyStopped` is
  resolved, preserving the "held-out only if the candidate survives" contract.
- Sequential-equivalence invariant: for identical per-task outcomes, the
  parallel verdict (accept/reject/insufficient + counted-task set) is
  **identical** to the sequential verdict. This is the load-bearing test.
- Each ab task still runs its two arms back-to-back within the one scheduled
  pipeline slot (arm symmetry under equal contention).

### D6. `task-load` subcommand

`runner.ts task-load [--task-file PATH | --all] [--results-file PATH]
[--cpu-budget N] [--mem-budget MB]`: prints per task the declared cpus /
memory / storage / gpus / agent+verifier timeouts, measured elapsed (mean over
attempts) when a results file is given, and a packing preview (which tasks
would co-run under the budget). Read-only; works without podman.

### D7. Flag surface (all default-off)

| Flag | Commands | Effect |
|---|---|---|
| `--enforce-resources` | run, ab, oracle | podman create gets `--cpus/--memory` from task.toml; provenance stamped |
| `--parallel` | run, ab | budget-packed scheduling; requires `--enforce-resources` AND API-key auth (D4) |
| `--cpu-budget N` / `--mem-budget MB` | run, ab | override default 3 / 6144; requires `--parallel` |
| `task-load` | new subcommand | inspection only |

## Testing

Hermetic (bun test, no podman):
1. `taskResources`: declared / missing file / broken toml / partial fields.
2. `buildCreateArgv`: with resources → flags appended; without → byte-identical
   argv (existing snapshot untouched).
3. Packing: 3 lights co-run; 2-cpu + 1-cpu pair; over-budget task runs alone
   (pool drained first); canonical launch order preserved; budget accounting
   on completion (injectable fake runFn with controlled completion order).
4. Mutex: interleaved writers → serialized, order preserved per queue.
5. ab stop rule: scripted out-of-order completions → verdict + counted-task
   set byte-identical to the sequential run on the same outcomes; post-stop
   in-flight results excluded from verdict but present in partial.
6. `task-load`: golden output on a fixture task dir.
7. Auth gating: `keyOnly` mode returns env-only auth with zero rw mounts;
   provider-prefix gate errors name the missing variable (`ANTHROPIC_API_KEY`
   for `anthropic/...`) and reject underivable model strings.
8. ab summary-field filtering: `nTasks`/`candidateRate`/`activeRate` exclude
   `postStop` entries; partial's `taskResults` retains them.

Live smoke (MacBook, ~15 min): 3 light tasks, `--parallel --enforce-resources
--model anthropic/claude-haiku-4-5` (explicit — `run`'s default model is
sonnet, `cmd-run.ts:322`) with `ANTHROPIC_API_KEY` set (the D4 requirement)
→ 3 concurrent containers (`podman ps`), cgroup caps visible in
`podman inspect` (`NanoCpus`/`Memory`), results identical shape to serial.
Cost note before any real parallel sweep: 3 concurrent agents triple the
short-term API request rate — acceptable at current tier; abort guidance in the
runbook if 429s appear in logs.

## Risks / notes

- **applehv cgroup support:** podman on applehv VMs honors `--cpus/--memory`
  via crun cgroups v2 — verified in the live smoke before any overnight use.
- **Baseline comparability:** enforcement changes effective CPU time for tasks
  that previously bursted >1 vCPU. Hence default-off + provenance stamp +
  bundled re-baseline (see Non-goals).
- **Timeout interaction:** wall-clock timeouts are unchanged; a CPU-capped task
  may hit them slightly sooner. This is the spec-honest regime (the leaderboard
  runs capped) and is absorbed by the same re-baseline.
- **Podman VM CPU count differs per host** (office linux ≠ MacBook): budget is
  a flag, default documented as MacBook-derived; `task-load` prints the active
  budget so a host mismatch is visible.
