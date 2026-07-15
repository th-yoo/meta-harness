# Bench Resource Enforcement + Load-Aware Parallel Scheduling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enforce each TB2 task's declared container resources (opt-in) and run bench tasks in parallel when their declared footprints fit a resource budget, sequential otherwise — with every current behavior byte-identical while the new flags are off.

**Architecture:** A `taskResources()` reader (mirrors `taskTimeouts()`) feeds `--cpus/--memory` into `podman create` behind `--enforce-resources`. A new `scheduler.ts` provides budget-packed parallel execution + an async mutex; `cmd-run` and `cmd-ab` integrate it behind `--parallel` (which hard-requires enforcement AND provider API-key auth in a new `keyOnly` mount mode). ab's early-stop consumes results in canonical task order via a `postStop` tag. A `task-load` subcommand shows declared load + packing preview.

**Tech Stack:** Bun/TypeScript, `bun test`, `Bun.TOML.parse`, podman. All code in `opencode-plugin/src/bench/`, tests in `opencode-plugin/test/`.

**Spec:** `docs/superpowers/specs/2026-07-16-bench-resource-scheduler-design.md` (architect-reviewed, 3 rounds). Read it before starting any task; its D-sections are cited below.

## Global Constraints

- **All new flags default OFF; flag-off behavior byte-identical** — existing tests must pass unchanged; no new keys in ab's `runIdent` (spec D2; `splits.ts:198-204` does strict `!==` over every key — the `ac0cd18` bug class).
- **`--parallel` requires `--enforce-resources` AND the provider-specific API key env var** (spec D4) — hard errors, never implicit enabling.
- **Fallback resources when task.toml is missing/broken: `{cpus: 1, memoryMb: 2048, gpus: 0, declared: false}`** + one warning log line when enforcement is on (spec D1).
- **Default budget `{cpus: 3, memoryMb: 6144}`** (spec D3).
- **Within a task nothing parallelizes**: k attempts and ab's two arms stay sequential in one scheduled slot (spec Non-goals).
- **Mutex critical section = whole call** (`recordToStores` invocation / `writeRunResults` / ab partial write), not individual file writes (spec D4).
- Run `cd opencode-plugin && bun test` (full suite green) + `bunx tsc --noEmit` (clean) before every commit.
- Commit messages end with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: `taskResources()` reader

**Files:**
- Modify: `opencode-plugin/src/bench/tasks.ts` (add below `taskTimeouts`, `tasks.ts:120-149`)
- Test: `opencode-plugin/test/bench-tasks.test.ts` (extend the existing file that covers `taskTimeouts`; if the fixture helpers live elsewhere, follow where `taskTimeouts` tests are)

**Interfaces:**
- Produces: `interface TaskResources { cpus: number; memoryMb: number; gpus: number; declared: boolean }` and `taskResources(paths: BenchPaths, task: string): TaskResources` — consumed by Tasks 2, 6, 7, 8.

- [ ] **Step 1: Write failing tests** (same fixture style the `taskTimeouts` tests use — a temp dir with a synthetic `task.toml`):

```ts
describe("taskResources", () => {
  test("reads declared [environment] fields", () => {
    // fixture task.toml containing:
    // [environment]\ncpus = 2\nmemory_mb = 4096\ngpus = 0
    const r = taskResources(paths, "fixture-task")
    expect(r).toEqual({ cpus: 2, memoryMb: 4096, gpus: 0, declared: true })
  })
  test("missing task.toml falls back to modal footprint", () => {
    const r = taskResources(paths, "no-such-task")
    expect(r).toEqual({ cpus: 1, memoryMb: 2048, gpus: 0, declared: false })
  })
  test("broken toml falls back", () => {
    // fixture file containing "not [ toml"
    expect(taskResources(paths, "broken-task").declared).toBe(false)
  })
  test("partial fields: missing memory_mb takes fallback, cpus kept", () => {
    // fixture: [environment]\ncpus = 2
    const r = taskResources(paths, "partial-task")
    expect(r).toEqual({ cpus: 2, memoryMb: 2048, gpus: 0, declared: true })
  })
})
```

- [ ] **Step 2:** `cd opencode-plugin && bun test test/bench-tasks.test.ts` → FAIL (`taskResources is not defined`).
- [ ] **Step 3: Implement** in `tasks.ts`, mirroring `taskTimeouts`'s parse-and-tolerate shape (`Bun.TOML.parse`, try/catch → undefined):

```ts
export interface TaskResources {
  cpus: number
  memoryMb: number
  gpus: number
  /** false when task.toml was missing/unparseable OR had no [environment] table. */
  declared: boolean
}

/** Declared container footprint from task.toml [environment] (spec D1).
 * Fallback = the modal TB2 footprint (1 cpu / 2048 MB). Never throws. */
export function taskResources(paths: BenchPaths, task: string): TaskResources {
  const tomlPath = join(paths.tbRoot, task, "task.toml")
  let env: Record<string, unknown> | undefined
  if (existsSync(tomlPath)) {
    try {
      const doc = Bun.TOML.parse(readFileSync(tomlPath, "utf-8")) as { environment?: Record<string, unknown> }
      env = doc.environment
    } catch {
      env = undefined
    }
  }
  const num = (v: unknown, fallback: number): number => (typeof v === "number" && v > 0 ? v : fallback)
  return {
    cpus: num(env?.["cpus"], 1),
    memoryMb: num(env?.["memory_mb"], 2048),
    gpus: typeof env?.["gpus"] === "number" ? (env["gpus"] as number) : 0,
    declared: env !== undefined,
  }
}
```

- [ ] **Step 4:** `bun test test/bench-tasks.test.ts` → PASS; full `bun test` + `bunx tsc --noEmit` clean.
- [ ] **Step 5: Commit** `feat(bench): taskResources() — declared container footprint from task.toml [environment]`

---

### Task 2: enforcement plumbing — `SandboxSpec.resources`, `--enforce-resources`, threading

**Files:**
- Modify: `opencode-plugin/src/bench/sandbox.ts` (`SandboxSpec` :32-41, `buildCreateArgv` :43)
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (outer loop ~:396 where `taskTimeouts` is called; `RunOneTaskFn` params :66-76; `runTaskOnce` create call ~:168)
- Modify: `opencode-plugin/src/bench/cmd-oracle.ts` (inside `runOneOracleTask`, next to its internal `taskTimeouts` call :131 — signature UNCHANGED, spec D2/finding 6)
- Modify: `opencode-plugin/src/bench/cli.ts` (parse `--enforce-resources` for run/ab/oracle; usage text)
- Test: `opencode-plugin/test/bench-sandbox.test.ts` (extend existing argv tests)

**Interfaces:**
- Consumes: `taskResources` (Task 1).
- Produces: `SandboxSpec.resources?: { cpus: number; memoryMb: number }`; `CmdRunArgs.enforceResources?: boolean` (same field on ab/oracle args); `RunOneTaskFn` gains a `resources?: { cpus: number; memoryMb: number }` param (undefined = unenforced). Task 6/7 rely on `enforceResources` existing on the args types.

- [ ] **Step 1: Failing argv tests:**

```ts
test("buildCreateArgv with resources appends --cpus/--memory", () => {
  const argv = buildCreateArgv({ image: "img", name: "n", resources: { cpus: 2, memoryMb: 4096 } })
  const s = argv.join(" ")
  expect(s).toContain("--cpus 2")
  expect(s).toContain("--memory 4096m")
})
test("buildCreateArgv without resources is byte-identical to before", () => {
  const argv = buildCreateArgv({ image: "img", name: "n" })
  expect(argv.join(" ")).not.toContain("--cpus")
  expect(argv.join(" ")).not.toContain("--memory")
})
```

- [ ] **Step 2:** run → FAIL (unknown property / missing flags).
- [ ] **Step 3: Implement.** `SandboxSpec` gains `resources?: { cpus: number; memoryMb: number }`; in `buildCreateArgv` insert after `--init`:

```ts
    ...(spec.resources ? ["--cpus", String(spec.resources.cpus), "--memory", `${spec.resources.memoryMb}m`] : []),
```

Threading:
- `cmd-run.ts`: outer loop computes `const resources = args.enforceResources ? enforcedResources(paths, task) : undefined` next to the `taskTimeouts` call (:396) and passes it through `runOneTask`(→ `runTaskOnce`) into the `buildCreateArgv({...})` call. Add a tiny shared helper in `tasks.ts`:

```ts
/** taskResources + spec-D1 warning + spec Non-goals GPU refusal. Call only when enforcement is on. */
export function enforcedResources(paths: BenchPaths, task: string): { cpus: number; memoryMb: number } {
  const r = taskResources(paths, task)
  if (r.gpus > 0) throw new BenchError(`${task}: declares gpus=${r.gpus}; VM has none — refusing to run it unconstrained under --enforce-resources`)
  if (!r.declared) log(`  ${task}: no [environment] in task.toml — assuming 1 cpu / 2048 MB`)
  return { cpus: r.cpus, memoryMb: r.memoryMb }
}
```

- `cmd-oracle.ts`: inside `runOneOracleTask`, next to its `taskTimeouts` call (:131): `const resources = args.enforceResources ? enforcedResources(paths, task) : undefined`, passed to its own `buildCreateArgv`. The injectable `RunOneOracleTask` signature stays `(paths, task, staging)`-shaped — thread the flag via however `runOneOracleTask` already receives per-run options (its closure/args), NOT via the injectable signature.
- `cli.ts`: add `--enforce-resources` boolean parse for run/ab/oracle + one usage line.

- [ ] **Step 4:** targeted tests PASS; full suite green (existing argv snapshots unchanged); tsc clean.
- [ ] **Step 5: Commit** `feat(bench): --enforce-resources — podman create gets --cpus/--memory from task.toml (default off)`

---

### Task 3: provenance stamps + resume guards (the `ac0cd18` class)

**Files:**
- Modify: `opencode-plugin/src/bench/record.ts` (`EnvBlock` :189-196 + the `envBlock()` builder)
- Modify: `opencode-plugin/src/bench/results.ts` (`RunResultsMeta` :118-130, `resumeCarryForward` :78-116)
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (`writeRunResults` call sites ~:444-455, ~:477-487 add the field)
- Modify: `opencode-plugin/src/bench/cmd-ab.ts` (coalescing guard next to where `resumeIdentCheck` is invoked; `runIdent` :206-215 is NOT touched)
- Test: `opencode-plugin/test/bench-results.test.ts` (or wherever `resumeCarryForward` is tested today — extend in place)

**Interfaces:**
- Consumes: `CmdRunArgs.enforceResources` (Task 2).
- Produces: `EnvBlock.resourceEnforcement: boolean`; `RunResultsMeta.resourceEnforcement?: boolean`; `resumeCarryForward(resultsFile, resume, expectedDriver, expectedResourceEnforcement: boolean)` (new 4th param).

- [ ] **Step 1: Failing tests:**

```ts
test("resumeCarryForward: pre-feature file (no field) + flag off → carries forward", () => {
  // fixture results file WITHOUT resourceEnforcement key
  const { doneTasks } = resumeCarryForward(file, true, "opencode", false)
  expect(doneTasks.size).toBeGreaterThan(0)
})
test("resumeCarryForward: pre-feature file + flag ON → dies (regime mismatch)", () => {
  expect(() => resumeCarryForward(file, true, "opencode", true)).toThrow(/resource/i)
})
test("resumeCarryForward: stamped-true file + flag on → carries forward", () => { /* fixture with resourceEnforcement: true */ })
```

Plus an ab test asserting `runIdent` (the object compared by `resumeIdentCheck`) has NO `resourceEnforcement` key — pin the D2 invariant.

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- `record.ts`: `EnvBlock` gains `resourceEnforcement: boolean`; `envBlock()` takes/threads the flag (find its call sites — `cmd-run.ts:378` and ab's — and pass `args.enforceResources ?? false`).
- `results.ts`: `RunResultsMeta.resourceEnforcement?: boolean`; `writeRunResults` callers include `resourceEnforcement: args.enforceResources || undefined` (omit when false so old-file shape is preserved exactly). In `resumeCarryForward`, after the `driver` guard (:91-100), mirror it:

```ts
      const prevEnforce = (prev as { resourceEnforcement?: boolean }).resourceEnforcement ?? false
      if (prevEnforce !== expectedResourceEnforcement) {
        die(
          `--resume: ${resultsFile} was produced with resourceEnforcement=${prevEnforce}, this run uses ` +
            `${expectedResourceEnforcement} — refusing to mix measurement regimes in one results file.`,
        )
      }
```

- `cmd-ab.ts`: where the partial is ident-checked on resume, add the same coalescing comparison against `prev.env?.resourceEnforcement ?? false` (informational field, NOT in `runIdent`).

- [ ] **Step 4:** tests PASS; full suite + tsc clean.
- [ ] **Step 5: Commit** `feat(bench): resourceEnforcement provenance + coalescing resume guards (never in runIdent)`

---

### Task 4: `keyOnly` auth mode + provider-prefix key gate

**Files:**
- Modify: `opencode-plugin/src/bench/agent-auth.ts` (`prepareAgentAuthMounts` :111-183)
- Modify: `opencode-plugin/src/bench/drivers/types.ts` (the `AgentDriver.prepareAuth` signature) and `opencode-plugin/src/bench/drivers/opencode.ts:174`
- Create: `requiredApiKeyVar()` helper — put it in `opencode-plugin/src/bench/paths.ts` next to `apiKeyEnv()` (:91-97)
- Test: `opencode-plugin/test/agent-auth.test.ts` (extend), `opencode-plugin/test/bench-paths.test.ts` (or wherever `apiKeyEnv` is tested)

**Interfaces:**
- Produces: `prepareAgentAuthMounts({ keyOnly?: boolean })` — keyOnly returns ONLY the per-run temp config-dir mount (no `~/.claude`, no shared rw `opencodeDataDir`); `AgentDriver.prepareAuth(opts?: { keyOnly?: boolean })`; `requiredApiKeyVar(model: string): string` (throws `BenchError` on underivable provider). Task 6 consumes both.

- [ ] **Step 1: Failing tests:**

```ts
test("prepareAgentAuthMounts keyOnly: only the config mount, no credential dirs", () => {
  const auth = prepareAgentAuthMounts({ keyOnly: true, platform: "darwin", execFn: failingExec })
  // failingExec would throw if the Keychain path were taken — keyOnly must not need it
  expect(auth.mounts).toHaveLength(1)
  expect(auth.mounts[0]!.container).toBe("/root/.config/opencode")
  auth.cleanup()
})
test("requiredApiKeyVar derives provider key", () => {
  expect(requiredApiKeyVar("anthropic/claude-haiku-4-5")).toBe("ANTHROPIC_API_KEY")
  expect(requiredApiKeyVar("openrouter/gemini-2.5-flash")).toBe("OPENROUTER_API_KEY")
  expect(() => requiredApiKeyVar("no-slash-model")).toThrow(/provider/i)
})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- `prepareAgentAuthMounts`: accept `keyOnly?: boolean` in its opts; when true, build ONLY `tmpRoot` + `configDir` (the existing `MINIMAL_OPENCODE_CONFIG` write, :116-120), skip the entire platform branch (:125-154) and the `opencodeDataDir` mount, return `{ mounts: [{ host: configDir, container: "/root/.config/opencode", ro: false }], cleanup: () => cleanupTmp(tmpRoot) }`. (Container-side auth then flows purely from the API-key env that `cmd-run` already injects via `apiKeyEnv()` — `cmd-run.ts` create-call `env: { ...apiKeyEnv(), ... }`. Note: without the shared data dir the plugin cache is cold per container; network is on, this is accepted — say so in a code comment.)
- `drivers/types.ts`: `prepareAuth: (opts?: { keyOnly?: boolean }) => AgentAuthMounts`; `drivers/opencode.ts:174` → `prepareAuth: (opts) => prepareAgentAuthMounts({ keyOnly: opts?.keyOnly })`. Check the other driver (claude-code) for signature compatibility — it may ignore the param (its own key-skip already exists at :243-245).
- `paths.ts`:

```ts
/** Provider-specific key env var for a model string like "anthropic/claude-…" (spec D4).
 * Mirrors record.ts's provider-prefix convention (model.split("/")[0]). */
export function requiredApiKeyVar(model: string): string {
  const provider = model.split("/")[0]
  if (!provider || provider === model) throw new BenchError(`cannot derive provider from model "${model}" — --parallel needs a provider-prefixed model (e.g. anthropic/…)`)
  return `${provider.toUpperCase().replace(/-/g, "_")}_API_KEY`
}
```

- [ ] **Step 4:** tests PASS; full suite + tsc clean (check every `prepareAuth()` call site still typechecks).
- [ ] **Step 5: Commit** `feat(bench): keyOnly auth mode (no shared rw credential mounts) + provider-prefix key gate helper`

---

### Task 5: `scheduler.ts` — budget packing + async mutex

**Files:**
- Create: `opencode-plugin/src/bench/scheduler.ts`
- Test: `opencode-plugin/test/bench-scheduler.test.ts`

**Interfaces:**
- Produces (consumed by Tasks 6+7):

```ts
export interface Budget { cpus: number; memoryMb: number }
export const DEFAULT_BUDGET: Budget = { cpus: 3, memoryMb: 6144 }
export interface ScheduledItem { key: string; cpus: number; memoryMb: number }
/** Greedy canonical-order packing (spec D3): launches items[i] when it fits the
 * remaining budget; over-total-budget items drain the pool and run alone.
 * runFn errors reject the whole schedule() after in-flight items settle. */
export function schedule(items: ScheduledItem[], budget: Budget, runFn: (item: ScheduledItem) => Promise<void>): Promise<void>
/** Whole-call critical section (spec D4). */
export class AsyncMutex { withLock<T>(fn: () => Promise<T> | T): Promise<T> }
```

- [ ] **Step 1: Failing tests** (injectable `runFn` with manually-resolved promises to control completion order):

```ts
test("3 lights co-run under default budget", async () => { /* launch order 0,1,2 all before any completes */ })
test("2-cpu item packs with one 1-cpu, not two", async () => { /* budget 3: [2cpu] + [1cpu] in flight, third waits */ })
test("over-budget item drains pool then runs alone", async () => { /* item cpus:4 > budget 3: nothing else in flight while it runs */ })
test("canonical order: item i never launches before i-1 has been CONSIDERED", async () => { /* no skip-ahead: if items[1] doesn't fit, items[2] must not jump it */ })
test("budget released on completion", async () => { /* complete item 0 → item 3 launches */ })
test("runFn rejection propagates after in-flight settle", async () => {})
test("AsyncMutex serializes and preserves order", async () => { /* two withLock bodies with internal awaits never interleave */ })
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** (~70 lines): a cursor over `items`; a loop that launches while `items[cursor]` fits `remaining`; over-total-budget special case (wait for pool empty, run solo, continue); on each completion, release and re-scan from cursor. `AsyncMutex` = promise-chain:

```ts
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()
  withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => {})
    return run as Promise<T>
  }
}
```

- [ ] **Step 4:** tests PASS; tsc clean.
- [ ] **Step 5: Commit** `feat(bench): scheduler — canonical-order budget packing + whole-call AsyncMutex`

---

### Task 6: `run --parallel` integration

**Files:**
- Modify: `opencode-plugin/src/bench/cmd-run.ts` (task loop ~:382-460), `opencode-plugin/src/bench/cli.ts` (flags + validation), `opencode-plugin/src/bench/log.ts`-equivalent if a prefix hook is needed (check how `log()` is imported in cmd-run — prefix at call sites is fine)
- Test: `opencode-plugin/test/bench-cmd-run.test.ts` (extend — it already injects `runOneTask` fakes)

**Interfaces:**
- Consumes: `schedule`/`DEFAULT_BUDGET`/`AsyncMutex` (Task 5), `requiredApiKeyVar` (Task 4), `enforcedResources` (Task 2).
- Produces: `CmdRunArgs.parallel?: boolean; cpuBudget?: number; memBudget?: number`. CLI validation rules (also reused by Task 7): `--parallel` without `--enforce-resources` → die; `--parallel` with `process.env[requiredApiKeyVar(model)]` unset → die naming the variable; budget flags without `--parallel` → die.

- [ ] **Step 1: Failing tests:**

```ts
test("run --parallel: tasks execute concurrently within budget, results identical to serial", async () => {
  // fake runOneTask records (start,end) timestamps per task; assert overlap for 3 lights
  // and that taskAgg/results JSON equals the serial run's on the same fake outcomes
})
test("run --parallel: store/results writes serialized via mutex", async () => { /* fake writer asserts no interleave */ })
test("cli: --parallel without --enforce-resources dies", () => {})
test("cli: --parallel without ANTHROPIC_API_KEY (anthropic model) dies naming the var", () => {})
test("serial path untouched: no --parallel → existing for-loop (spy: schedule() never called)", () => {})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- `cli.ts`: parse the three flags; validations exactly as in Interfaces (before any podman work). keyOnly threading: when `args.parallel`, `prepareAuth` is called with `{ keyOnly: true }` (Task 4) — this lives where `runTaskOnce` calls `driver.prepareAuth`/`prepareAuth()` (cmd-run.ts ~:166).
- `cmd-run.ts`: keep the existing `for` loop verbatim for the serial path. Parallel path:

```ts
if (args.parallel) {
  const budget = { cpus: args.cpuBudget ?? DEFAULT_BUDGET.cpus, memoryMb: args.memBudget ?? DEFAULT_BUDGET.memoryMb }
  const mutex = new AsyncMutex()
  const items = tasks.filter(t => !doneTasks.has(t)).map(t => ({ key: t, ...enforcedResources(paths, t) }))
  await schedule(items, budget, async (item) => {
    // per-task pipeline: identical body to one iteration of the serial loop,
    // with (a) log lines prefixed `[${item.key}] `, (b) every taskAgg/results/store
    // mutation wrapped in mutex.withLock(...), (c) k attempts still a serial inner loop
  })
} else {
  /* existing loop, unchanged */
}
```

Extract the per-task body into a local `async function runOneTaskPipeline(task)` used by BOTH paths so serial/parallel can't drift (serial calls it in the plain loop without the mutex-prefix decorations only if that keeps byte-identical logs — otherwise serial keeps its original inline body; prefer the shared function with a `prefix: string` param defaulting to `""` and a no-op mutex for serial, and verify log-snapshot tests still pass).

- [ ] **Step 4:** tests PASS; full suite + tsc clean.
- [ ] **Step 5: Commit** `feat(bench): run --parallel — budget-packed task scheduling (default off, keyOnly auth)`

---

### Task 7: `ab --parallel` — `postStop` + canonical-order early-stop

**Files:**
- Modify: `opencode-plugin/src/bench/cmd-ab.ts` (`AbTaskResults` entry type; `runPhase` loop; `verdictDict` :265-306 incl. the independent filter at :274-277)
- Test: `opencode-plugin/test/bench-cmd-ab.test.ts` (extend — it already drives `cmdAb` with injected runners)

**Interfaces:**
- Consumes: Task 5 scheduler + mutex; Task 6's CLI validations (shared).
- Produces: `AbTaskResult.postStop?: true`. Invariant (spec D5): for identical per-task outcomes, parallel verdict (decision + counted-task set + `nTasks`/`candidateRate`/`activeRate`) === sequential verdict.

- [ ] **Step 1: Failing tests:**

```ts
test("sequential equivalence: out-of-order completions → identical verdictDict decision fields", async () => {
  // scripted outcomes for 7 tasks where the stop rule fires at task 3;
  // completion order shuffled (e.g. 2,0,4,1,3,...); assert decision, counted set,
  // nTasks, candidateRate, activeRate all equal the serial run's
})
test("postStop entries excluded from nTasks/candidateRate/activeRate but present in partial taskResults", async () => {})
test("scheduler instantiated per phase: no held-out task launches before held-in earlyStopped resolves", async () => {})
test("serial ab: postStop never set; verdict byte-identical to today (existing snapshot)", async () => {})
```

- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement.**
- Buffered canonical consumption inside `runPhase` (parallel path only): completed pairs land in `taskResults` under the mutex; a consumer advances `consumedIdx` while `taskResults[tasks[consumedIdx]]` exists, running the existing stop-rule check per consumed task; once the stop rule fires, mark `stopFired = true` and tag every task completing afterwards `postStop: true`.
- Each ab task's two arms run back-to-back inside its single scheduled pipeline slot (reuse the existing per-task pair body).
- `verdictDict`: apply the postStop filter in ONE shared view: `const counted = Object.entries(taskResults).filter(([, tr]) => !tr.error && !tr.postStop)` and use it for `nTasks`/`candidateRate`/`activeRate` (:274-277) AND pass the same exclusion into `filterTaskResults`/`pairedRunStats`; serialize the full map under `taskResults` unchanged.
- Fresh scheduler per `runPhase` call (:374-375 structure untouched) — full drain before return.

- [ ] **Step 4:** tests PASS (especially the equivalence test); full suite + tsc clean.
- [ ] **Step 5: Commit** `feat(bench): ab --parallel — canonical-order early-stop with postStop exclusion (verdict-equivalent to serial)`

---

### Task 8: `task-load` subcommand + docs

**Files:**
- Modify: `opencode-plugin/src/bench/cli.ts` (subcommand + usage), create `opencode-plugin/src/bench/cmd-task-load.ts`
- Modify: `docs/usage-manual.md` (one section: flags + task-load + the D4 API-key requirement + re-baseline warning)
- Test: `opencode-plugin/test/bench-task-load.test.ts`

**Interfaces:**
- Consumes: `taskResources` (Task 1), `taskTimeouts`, `DEFAULT_BUDGET`/packing preview from Task 5 (pure function reuse: expose `packPreview(items, budget): string[][]` from `scheduler.ts` if trivial, else compute groups inline with the same fit rule).

- [ ] **Step 1: Failing test:** golden output on two fixture tasks (one declared 2-cpu, one fallback) — assert the table contains declared fields, timeout columns, and a `co-run groups` preview line; with `--results-file` fixture, assert a mean-elapsed column appears.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3: Implement** `cmdTaskLoad(paths, args)`: resolve tasks (reuse `selectTasks`), print fixed-width table (match the repo's existing table style in cmd-run's summary), optional elapsed means from a results file's `tasks[t].elapsed`, plus packing preview under the active budget. Wire into `cli.ts` with `--task-file/--all/--results-file/--cpu-budget/--mem-budget`.
- [ ] **Step 4:** tests PASS; full suite + tsc clean.
- [ ] **Step 5: Commit** `feat(bench): task-load — declared footprint table + packing preview`

---

### Task 9 (final): live smoke + wrap-up

**Files:** none new (evidence into the task report).

- [ ] **Step 1:** `PATH=/opt/podman/bin:$PATH ANTHROPIC_API_KEY=<key> bun term-bench2/runner.ts run --tasks prove-plus-comm openssl-selfsigned-cert extract-elf --model anthropic/claude-haiku-4-5 --k 1 --enforce-resources --parallel --results-file /tmp/smoke-parallel.json --max-agent-timeout 300 --max-verifier-timeout 120` (3 known-fast tasks).
- [ ] **Step 2:** While running: `podman ps` shows up to 3 `mh-*` containers; `podman inspect <one> --format '{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}'` shows `1000000000 2147483648`.
- [ ] **Step 3:** Results file parses; per-task shapes identical to a serial run's; log lines carry `[task]` prefixes.
- [ ] **Step 4:** If applehv rejects the cgroup flags (spec Risks), STOP and report — do not ship `--parallel` with silently-ignored caps.
- [ ] **Step 5:** Final commit of any smoke-driven fixes; full suite + tsc; report.

## Self-review notes (done at write time)

- Spec coverage: D1→T1, D2→T2+T3, D3→T5+T6, D4→T4+T5+T6, D5→T7, D6→T8, D7→T2/T6/T8 CLI, Testing§live→T9. Non-goals respected (no within-task parallelism; storage/gpus unenforced with GPU refusal in T2).
- Type consistency: `TaskResources`/`enforcedResources` (T1/T2), `ScheduledItem`/`Budget`/`AsyncMutex` (T5) used with the same names in T6-T8; `requiredApiKeyVar` (T4) used in T6.
- Line numbers are anchors, not gospel — implementers re-locate by symbol name if drifted.
