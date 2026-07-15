# T4 — Fleet-Dev Parallel Scheduler (N5a + D9 crash-consistency) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `fleet-dev`, the parallel task-DAG scheduler (spec **N5a**) that is the real caller of the just-shipped T1 git-worktree primitive. It reads a task-DAG, runs every READY node as its own A→D→I→E `squad-run` in its own throwaway git worktree (all roles share the worktree, ledger stays in the origin), unblocks dependents on VERDICT PASS up to a concurrency cap, enforces the worktree **retention policy**, and is **crash-consistent** (spec fleet **D9**): DAG-scheduler-state is written atomically and a restart reconciles leftover worktrees/branches against git truth.

**Architecture:** A new `fleet/dag-scheduler.ts` drives the DAG; a new `fleet/dag-state.ts` holds the scheduler-state shape + its N1b-anchored atomic persistence; a new `fleet/worktree-deps.ts` owns the per-worktree dependency policy (heads-up #2). Per node the scheduler does: `createWorktree(project, {branch: fleet/<runId>/<nodeId>, base})` → prepare deps → `cmdRolesRender({project: worktreeDir})` → `cmdSquadRun({project: <origin=runtimeRoot>, worktreeDir, sliceId: nodeId, slice: node.task})` → on `done`, an **orchestrator-owned commit** of the node's edits (branch never agent-chosen, spec N2) records the crash-truth SHA. For self-hosting, `project` is simultaneously the origin repo `createWorktree` branches from AND the `runtimeRoot` where the ledger (checkpoint/pending/scored) + the DAG-state file live (**N1b**). `runDag` schedules topological waves under a max-concurrency cap; `reconcileDagRun` handles D9 restart. This is spec pieces **N5a** (parallel scheduler) + the **D9 crash-consistency** trio (atomic durable-state writes, restart reconciliation, per-phase completion) from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`.

**Master boundary (reference only — do NOT re-plan here):** `runDag`/`cmdFleetDev` is a **skill-less deterministic orchestrator** — exactly the composite scheduling the singleton master (fleet spec §9.4/§9.5, D8/D9) will eventually own. **Today the human-as-master invokes it** via the `fleet-dev` CLI and answers gates via `--resume`. The master automates that invocation later; T4 changes nothing about the master and delegates all skill (planning, coding, judging) to the LLM leaves inside each node's squad-run.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:child_process` (`execFileSync`), `node:fs`, git worktrees. Hermetic tests: a real git repo in a `mkdtempSync` tmpdir (same idiom as `test/fleet-squad-worktree.test.ts`), `META_HARNESS_HOME` set per-test, an injected `execFn`/`squadRun` seam — no real `opencode` spawn.

## Global Constraints

- **Retention policy (spec N1b) — the scheduler NEVER removes a worktree during a normal drive.** Keep a run's worktree alive across a **gate-pause** AND **every escalation** (including `Exhausted`); `removeWorktree` fires ONLY on (a) an **explicit terminal abort** of a node/run, (b) a **post-merge release** (after T5 merges the node's branch into the integration branch), or (c) **restart reconciliation** of a crash-leftover. A `done` node's worktree is **retained** (its branch carries the node's commits that T5 must merge) until that release. A gate-pause / non-`Exhausted` escalation retains the worktree so `--resume` (or a human) can continue in the exact same checkout. Enforced in `runNode`/`runDag` (no `removeWorktree` on the drive path) and asserted by tests.
- **`keepBranch` is for the integration branch's open PR, not node branches (N2).** Individual nodes never open their own PR, so a node's post-merge release uses `removeWorktree(wt)` (default `keepBranch:false` → the merged node branch is deleted). `removeWorktree(wt, {keepBranch:true})` is the **T5/N2** integration-branch case (branch must survive for the open PR) — referenced, not exercised in T4.
- **N1b ledger invariant — every state sink the scheduler writes is anchored to `project` (= origin repo = runtimeRoot), NEVER a worktree.** `cmdSquadRun` is always called with `project: <runtimeRoot>` and `worktreeDir: <the worktree>`; `cmdRolesRender` targets `worktreeDir` (code); the **DAG-state file** lives under `<runtimeRoot>/.meta-harness/runtime/fleet/dag/<runId>.json`. The only things that touch the worktree are the `--dir` drive, the persona render, and the orchestrator commit — all CODE, never ledger. Verified: `listPending(worktreeDir)` is empty; DAG state + checkpoints + pending survive `removeWorktree`.
- **DAG-state lives in a `dag/` SUBDIR, out of `listPending`'s flat scan.** `pendingDir` is `<runtimeRoot>/.meta-harness/runtime/fleet/` and `listPending` returns every `*.json` file directly in it (co-locating `ses_*.json` + `squad-<slice>.json` checkpoints). Putting DAG state in the `dag/` subdir keeps it out of `listPending` (non-recursive) and out of pending-gc's blast radius. Any `listPending`-based assertion still filters by the `ses_` prefix (T1 gotcha).
- **Orchestrator-owned commit is code-only; runtime-rendered personas are excluded from the node diff.** `.opencode/agents/mh-*.md` are runtime-rendered into the worktree by `roles-render` and are **NOT gitignored** (only `mh-build.md` is tracked; `.meta-harness/` and `node_modules/` are gitignored). A blind `git add -A` on `done` would stage the rendered personas into the node's commit. The commit MUST exclude them: `git -C <wt> add -A -- ':(exclude).opencode/agents/mh-*.md'` (pathspec magic), then commit. Branch + message are orchestrator-fixed, never agent-chosen (spec N2). A test asserts the committed node diff contains the role-written code file and NOT the rendered personas.
- **Atomic durable-state writes (D9 req 1).** The new DAG-state writer uses `writeJsonAtomic` (temp+rename, `bench/util.ts:68`). T4 also hardens `writeJsonAtomic`/`writeTextAtomic` with `fsync(file)+fsync(dir)` (power-loss, not just process-crash, durability) and makes the role-store `harness-store.ts writeJson` (`:476`, currently a plain `writeFileSync`) atomic. The scheduler advances **only past an atomic commit boundary**: a node is `done` only after its checkpoint+score are written and its edits committed; the DAG-state file is re-written atomically after **every** node status transition.
- **Concurrency safety (explicitly-not-now §5/§5.1, folded into N5a).** Routine parallel `squad-run`s make the `score.json` read-modify-write race real. Both sinks — the role-store (`recordToStores`→`recordSession`) and the squad-def channel (`recordSquadOutcome`, `squad-def.ts:331`, already atomic-write but still an unguarded read-modify-write) — get an **advisory `flock`**; the pending/`scored/` dir gets **gc**. In scope for T4 per the spec's T4 node definition.
- **Back-compat with shipped fleet code is byte-identical.** T4 ADDS new modules + a `fleet-dev` CLI case and threads `worktreeDir`/`project` through the *already-shipped* `cmdSquadRun` seam (commit f536b6e). It does not change `cmdSquadRun`/`cmdRoleRun`/`createWorktree`/`removeWorktree` signatures. The two hardening edits (`writeJsonAtomic` fsync, `harness-store.writeJson` atomicity) keep their signatures and are guarded by existing tests staying green.
- **T1-review carry-forward heads-up #1 (isolation is only PROXIED by T1).** T1's tests use a mocked `execFn` and prove argv `--dir`=worktree + live-tree-clean — NOT that a real role-written file lands in the worktree and leaves origin clean. **T4 must close this:** its hermetic node test injects a `squadRun`/`execFn` that WRITES A REAL FILE into `worktreeDir` (simulating a role edit), and asserts the file appears under the worktree, is committed to the node branch, origin `git status --porcelain` stays clean, and the rendered personas are absent from the commit. The true live-run assertion with a real `opencode` role (spec Verification §N1) is a DEFERRED live gate (below), not a unit test.
- **T1-review carry-forward heads-up #2 (node_modules symlink WRITE-THROUGH hazard).** T1 symlinks the worktree's `node_modules` to the origin's. A node that runs `bun install` / mutates deps writes **through the link into the live repo** — unacceptable for self-hosting. **Policy (Task 2):** a node flagged `mutatesDeps` gets a FRESH install (unlink the T1 symlink, `bun install` into the worktree); a non-dep node keeps the read-through symlink. Any self-hosting node whose Implementer touches `package.json`/`bun.lock*` MUST be flagged `mutatesDeps` in the DAG (T3/N4 emits it; the scheduler enforces it).
- **`bun test test/<file>.test.ts` from `opencode-plugin/`.** All tests hermetic (tmpdir repos, `META_HARNESS_HOME` per-test, injected seams). `git` only via `execFileSync("git", [...])` — never a shell string.

---

### Task 1: `fleet/dag-state.ts` — scheduler-state shape + N1b-anchored atomic persistence

**Files:**
- Create: `opencode-plugin/src/fleet/dag-state.ts`
- Test: `opencode-plugin/test/fleet-dag-state.test.ts`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `die` from `../bench/util.ts`.
- Produces (the consumed DAG artifact is T3/N4's `{id,task,deps[],files?}` wire contract — mirror it locally so T4 builds/tests in isolation; **import T3's exported type once T3 lands**):
  ```ts
  export interface DagNode { id: string; task: string; deps: string[]; files?: string[]; mutatesDeps?: boolean }
  export interface TaskDag { nodes: DagNode[] }

  export type NodeStatus =
    | "pending" | "ready" | "running" | "paused-gate" | "escalated" | "done" | "merged" | "failed"

  export interface DagNodeState {
    id: string
    status: NodeStatus
    branch?: string            // fleet/<runId>/<id> — set when the worktree is created
    worktreeDir?: string       // the throwaway checkout; cleared only on release/abort/reconcile
    headSha?: string           // SHA of the node's committed edits — the D9 crash-truth
    pendingGate?: "gate1" | "gate2"   // set on a gate-pause (retention + --resume target)
    escalationType?: string    // set on a non-Exhausted escalation (needs human)
  }

  export interface DagRunState {
    runId: string
    project: string            // = origin repo = runtimeRoot (N1b): one dir, both roles
    base: string               // the run's base ref; every node worktree branches off it
    maxConcurrency: number
    nodeGatePolicy: "auto" | "root-human"
    integrationBranch?: string // owned by T5/N5b; tracked here, null in T4-alone
    nodes: Record<string, DagNodeState>
    ts: string
  }

  export function dagStateDir(runtimeRoot: string): string           // <rt>/.meta-harness/runtime/fleet/dag
  export function dagStatePath(runtimeRoot: string, runId: string): string
  export function saveDagState(runtimeRoot: string, state: DagRunState): void   // writeJsonAtomic → dagStatePath
  export function loadDagState(runtimeRoot: string, runId: string): DagRunState // die if missing
  ```

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-state.test.ts`:
  - `saveDagState`/`loadDagState` round-trips a `DagRunState` (all node fields preserved).
  - `dagStatePath(rt, runId)` resolves under `<rt>/.meta-harness/runtime/fleet/dag/` (assert the path string contains `/.meta-harness/runtime/fleet/dag/` and ends `${runId}.json`) — **N1b: never a worktree**.
  - The DAG-state file does NOT leak into `listPending(rt)` (import `listPending`; save state, assert `listPending(rt).filter(id => id.startsWith("dag"))` is empty — it lives in the `dag/` subdir).
  - Torn-write safety: write state A, then simulate a crashed second write by leaving a stray `*.tmp` in `dagStateDir` and confirm `loadDagState` still returns A (temp+rename means the live file is never the partial one).
  - `loadDagState` on a missing runId throws `BenchError` (via `die`).
- [ ] **Step 2: Run test to verify it fails** — `bun test test/fleet-dag-state.test.ts` → FAIL (`Cannot find module '../src/fleet/dag-state.ts'`).
- [ ] **Step 3: Write minimal implementation** — `dag-state.ts`: `dagStateDir` = `join(runtimeRoot, ".meta-harness", "runtime", "fleet", "dag")`; `dagStatePath` = `join(dagStateDir(rt), sanitize(runId) + ".json")` (reuse the `[^A-Za-z0-9_-]→_` sanitize idiom from `pending.ts:38`/`squad-cli.ts:66`); `saveDagState` = `writeJsonAtomic(dagStatePath(...), state)`; `loadDagState` reads or `die`s with the same message shape as `loadCheckpoint`.
- [ ] **Step 4: Run test to verify it passes** — `bun test test/fleet-dag-state.test.ts` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag-state.ts opencode-plugin/test/fleet-dag-state.test.ts
  git commit -m "feat(fleet): T4 dag-state — N1b-anchored atomic DAG scheduler-state (N5a/D9)"
  ```

---

### Task 2: `fleet/worktree-deps.ts` — per-worktree dependency policy (heads-up #2)

**Files:**
- Create: `opencode-plugin/src/fleet/worktree-deps.ts`
- Test: `opencode-plugin/test/fleet-worktree-deps.test.ts`

**Interfaces:**
- Consumes: `Worktree` from `./worktree.ts` (real shape `{ dir: string; branch: string; repo: string }`), `execFileSync`, `lstatSync`/`rmSync` from `node:fs`.
- Produces:
  ```ts
  export type DepsPolicy = "symlink" | "fresh-install"
  /** Enforce the node_modules policy on a T1 worktree (heads-up #2). A T1
   * `createWorktree` leaves node_modules as a SYMLINK to the origin's — a
   * dep-mutating node would `bun install` THROUGH the link into the live repo.
   * For `mutatesDeps`, sever the link and install fresh into the worktree; for
   * a read-only node keep T1's symlink (bounded disk/time). `installFn` is a
   * seam (default: `bun install` in the worktree via execFileSync). */
  export function prepareWorktreeDeps(
    wt: Worktree,
    opts: { mutatesDeps: boolean },
    installFn?: (dir: string) => void,
  ): DepsPolicy
  ```

- [ ] **Step 1: Write the failing test** — reuse the `initRepo()` idiom from `fleet-worktree.test.ts` (real git repo in tmpdir with a `node_modules/` so T1 symlinks it), plus `createWorktree`:
  - `mutatesDeps:true`: assert the worktree `node_modules` was a symlink before, is NOT a symlink (or is gone) after, and the injected `installFn` spy was called once with `wt.dir`; return value `"fresh-install"`.
  - `mutatesDeps:false`: `installFn` NOT called, the worktree `node_modules` symlink is intact (`lstatSync(link).isSymbolicLink()` true); return `"symlink"`.
  - `mutatesDeps:true` when the origin had no `node_modules` (no symlink created by T1): `installFn` still called (fresh install), return `"fresh-install"`.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing module).
- [ ] **Step 3: Write minimal implementation** — `prepareWorktreeDeps`: for `mutatesDeps`, `rmSync(join(wt.dir,"node_modules"), {recursive:true, force:true})` (removes the symlink OR a real dir), `installFn(wt.dir)` (default `execFileSync("bun", ["install"], { cwd: wt.dir })`), return `"fresh-install"`; else return `"symlink"`. **Note for the impl:** the fleet code is a bun workspace under `opencode-plugin/`; `installFn`'s default should install at the worktree root (workspace-aware) — document that a node touching `opencode-plugin/node_modules` specifically may need `cwd` at that subdir. Keep the seam so callers/tests override.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/worktree-deps.ts opencode-plugin/test/fleet-worktree-deps.test.ts
  git commit -m "feat(fleet): T4 worktree-deps policy — sever node_modules write-through for dep nodes (heads-up #2)"
  ```

---

### Task 3: `runNode` — one node's worktree squad-run + retention + orchestrator commit (N1/N1b + heads-up #1)

**Files:**
- Create: `opencode-plugin/src/fleet/dag-scheduler.ts` (this task adds `runNode`; Task 4 adds `runDag`; Task 5 adds `reconcileDagRun`)
- Test: `opencode-plugin/test/fleet-dag-node.test.ts`

**Interfaces:**
- Consumes (all REAL shipped signatures):
  - `createWorktree(repo: string, opts: { branch: string; base?: string }): Worktree`, `removeWorktree(wt: Worktree, opts?: { keepBranch?: boolean }): void` from `./worktree.ts`
  - `prepareWorktreeDeps` (Task 2)
  - `cmdRolesRender(args: { project: string; roles?; pins?; force? }): void` from `./render.ts` (renders into `<project>/.opencode/agents`; call with `project: wt.dir`)
  - `cmdSquadRun(args: { project; worktreeDir?; sliceId; slice?; ... }, driveFn?, scoreFn?, execFn?): Promise<SquadOutcome>` from `./squad-cli.ts`
  - `SquadOutcome` from `./squad.ts` (`{status:"done",payload,implementerSessionId?} | {status:"gate",gate,payload} | {status:"escalation",escalation:{type,body},implementerSessionId?} | {status:"running"}`)
  - `ExecFn` from `./run.ts`; `DagNode`/`DagNodeState`/`DagRunState` (Task 1)
- Produces:
  ```ts
  export interface NodeDeps {
    /** test seam — defaults to the real `cmdSquadRun`. */
    squadRun?: typeof cmdSquadRun
    /** threaded into the default squadRun's DriveFn (hermetic drive). */
    execFn?: ExecFn
    /** deps-policy install seam (Task 2). */
    installFn?: (dir: string) => void
  }
  /** Create the node's worktree, prepare deps, render personas into it, drive
   * ONE squad-run (project=runtimeRoot, worktreeDir=the worktree), and map the
   * terminal outcome to a DagNodeState. NEVER removes the worktree (retention
   * is the scheduler's job on abort/release/reconcile only). On `done`, makes
   * the orchestrator-owned code-only commit and records headSha. */
  export async function runNode(run: DagRunState, node: DagNode, deps?: NodeDeps): Promise<DagNodeState>
  ```
  Outcome → `DagNodeState` mapping (retention-faithful; NO `removeWorktree`):
  - `done` → orchestrator commit (`git -C wt.dir add -A -- ':(exclude).opencode/agents/mh-*.md'`; `git -C wt.dir commit -m "fleet: node <id>"` — skip commit if nothing staged), `headSha = git rev-parse HEAD`; return `{status:"done", branch, worktreeDir, headSha}`. **Retained** for T5 merge.
  - `gate` → `{status:"paused-gate", branch, worktreeDir, pendingGate: outcome.gate}`. **Retained** (resume in place).
  - `escalation`, `type==="Exhausted"` → `{status:"failed", branch, worktreeDir}`. **Retained** (removed only on explicit abort — spec N1b).
  - `escalation`, other type → `{status:"escalated", branch, worktreeDir, escalationType: outcome.escalation.type}`. **Retained** (needs human).
  - Node squad-run uses `gatePolicy: run.nodeGatePolicy` (default `"auto"`: the DAG-level human gate already approved the plan at N4/gate2, so nodes self-drive to VERDICT; gate-pause handling stays for a def that sets a human gate).

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-node.test.ts` (idiom: real git repo tmpdir from `fleet-squad-worktree.test.ts`'s `initRepo`, `META_HARNESS_HOME` per-test, `cmdRolesImport` fixtures, `writeSquadDefV1(STANDARD_SQUAD)`):
  - **heads-up #1 (real file lands in worktree, origin clean, code-only commit):** inject a `deps.squadRun` seam that WRITES A REAL FILE `feat.txt` into `args.worktreeDir` (it receives the worktree dir as an arg — `runNode` passes `{project, worktreeDir: wt.dir, ...}`) and returns `{status:"done", payload:"## Implementation Report\nVERDICT: PASS"}` — simulating a role edit landing in the worktree. Assert: `feat.txt` exists under the returned `worktreeDir`; the node branch HEAD commit (`git -C project log -p fleet/<runId>/<id>`) contains `feat.txt`; origin `git status --porcelain` on `project` is clean; the commit does NOT contain `.opencode/agents/mh-analyzer.md` (rendered personas excluded by the `:(exclude)` pathspec); `headSha` matches `git rev-parse fleet/<runId>/<id>`. *(A companion test drives the REAL `cmdSquadRun` via an `execFn` that writes into its `--dir` argv and scripts the full A→D→I→E auto-gate flow to `done` — same idiom as `fleet-squad-run-model.test.ts` — proving the real runner also builds the node ledger under `project`; keep it if the flow-scripting stays readable, else the `deps.squadRun` seam above is the load-bearing proof.)*
  - **N1b:** `listPending(worktreeDir)` is `[]`; the node's `ses_*` session ledger is under `listPending(project)` (filtered by `ses_` prefix).
  - **retention on gate:** inject a squadRun returning `{status:"gate", gate:"gate2", payload:"..."}` → returned state `paused-gate` with `pendingGate:"gate2"`, and `existsSync(worktreeDir)` is TRUE (not removed).
  - **retention on Exhausted:** inject `{status:"escalation", escalation:{type:"Exhausted", body:"..."}}` → state `failed`, `existsSync(worktreeDir)` TRUE.
  - **retention on Clarify:** inject `{status:"escalation", escalation:{type:"Clarify", body:"..."}}` → state `escalated` + `escalationType:"Clarify"`, worktree retained.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing `runNode`).
- [ ] **Step 3: Write minimal implementation** — `runNode` per the mapping above; `createWorktree(run.project, {branch:`fleet/${run.runId}/${node.id}`, base: run.base})`; `prepareWorktreeDeps(wt, {mutatesDeps: !!node.mutatesDeps}, deps?.installFn)`; `cmdRolesRender({project: wt.dir})`; `const outcome = await (deps?.squadRun ?? cmdSquadRun)({ project: run.project, worktreeDir: wt.dir, sliceId: node.id, slice: node.task, gatePolicy: run.nodeGatePolicy }, undefined, undefined, deps?.execFn)`. The orchestrator commit uses `execFileSync("git", ["-C", wt.dir, "add", "-A", "--", ":(exclude).opencode/agents/mh-*.md"])` then commit (guard: if `git status --porcelain` is empty, skip commit and set `headSha = git rev-parse HEAD`).
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag-scheduler.ts opencode-plugin/test/fleet-dag-node.test.ts
  git commit -m "feat(fleet): T4 runNode — worktree squad-run + retention + code-only commit (N1/N1b, heads-up #1)"
  ```

---

### Task 4: `runDag` — topological-wave scheduler, concurrency cap, unblock-on-PASS, atomic DAG-state (N5a)

**Files:**
- Modify: `opencode-plugin/src/fleet/dag-scheduler.ts` (add `runDag` + DAG validation)
- Test: `opencode-plugin/test/fleet-dag-run.test.ts`

**Interfaces:**
- Consumes: `runNode` (Task 3); `saveDagState`/`loadDagState`/`DagRunState`/`DagNodeState`/`TaskDag`/`DagNode` (Task 1); `die` from `../bench/util.ts`; `randomBytes` for the runId.
- Produces:
  ```ts
  export interface RunDagOpts {
    project: string                       // origin repo = runtimeRoot (N1b)
    runId?: string                        // default: `dev-<epoch>-<rand>` (unique per invocation)
    base?: string                         // default: "HEAD" at run start (resolved to a concrete SHA once)
    maxConcurrency?: number               // default: small (e.g. 3)
    nodeGatePolicy?: "auto" | "root-human"// default: "auto"
    resume?: boolean                      // load an existing DagRunState by runId instead of init
  }
  /** Read a DAG, run READY nodes concurrently up to the cap, unblock
   * dependents on VERDICT PASS (squad `done`), persisting DAG-state atomically
   * after EVERY node transition (D9 commit boundary). Returns the final
   * DagRunState (all done | some paused-gate/escalated/failed). */
  export async function runDag(dag: TaskDag, opts: RunDagOpts, deps?: NodeDeps): Promise<DagRunState>
  ```
- Scheduling contract:
  - **Validate** first: node ids unique, every `deps[]` id exists, DAG acyclic (`die` on a cycle/dangling dep).
  - **READY** = a `pending` node whose every dep is `done`. Launch READY nodes concurrently up to `maxConcurrency` (a simple promise-pool / worker loop). Mark launched nodes `running` and `saveDagState` before the drive.
  - On a node's `runNode` resolution, merge the returned `DagNodeState` into `run.nodes` and `saveDagState` (atomic boundary). If `done`, its dependents may become READY next tick. If `paused-gate`/`escalated`/`failed`, its dependents stay blocked (never unblocked by a non-`done` dep).
  - Loop until no node is `running` and none is newly READY. Return the final state. A run with any non-`done` terminal node is an **escalation to the human-as-master** (documented in the return, not thrown) — the human resolves via `--resume` (gate) or aborts.
  - **base is resolved to a concrete SHA once** at run start (`git rev-parse HEAD`) and stored, so every node branches off the identical base even as the loop runs — mirrors `cmdSquadRun`'s "resolve the active pointer to a concrete version once" discipline (`squad-cli.ts:214-217`).

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-run.test.ts` (real repo tmpdir):
  - **3-node DAG, 2 independent (`a`,`b`) + `c` deps `[a,b]`, cap 2:** inject a `squadRun` that records a **concurrency counter** (increment on entry, decrement on exit, track peak) and returns `done`. Assert: peak concurrency `== 2` (a,b overlapped, cap respected); `c`'s `runNode` began only after both `a` and `b` were `done`; final `runDag` state has all three `done`; the DAG-state file under `<project>/.meta-harness/runtime/fleet/dag/<runId>.json` reflects all `done`.
  - **cap respected on a wider fan-out:** a 4-independent-node DAG with cap 2 → peak concurrency never exceeds 2.
  - **gate-pause blocks dependents:** `a` returns `gate`, `c` deps `[a]` → `a` is `paused-gate`, `c` stays `pending` (never launched), `a`'s worktree retained.
  - **failed node blocks dependents but siblings proceed:** DAG `a`,`b` independent + `c` deps `[a]`; `a` returns `Exhausted` (→ `failed`), `b` returns `done` → `b` done, `c` never launched, `a` retained.
  - **atomic persistence:** after the run, `loadDagState(project, runId)` equals the returned state.
  - **DAG validation:** a DAG with a dangling dep id and a DAG with a 2-cycle each `die`.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing `runDag`).
- [ ] **Step 3: Write minimal implementation** — init `DagRunState` (all nodes `pending`, resolve `base`, generate `runId`) or `loadDagState` on `resume`; the wave loop + promise-pool cap; `saveDagState` after each transition. Keep it deterministic and side-effect-atomic.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag-scheduler.ts opencode-plugin/test/fleet-dag-run.test.ts
  git commit -m "feat(fleet): T4 runDag — parallel wave scheduler, concurrency cap, unblock-on-PASS (N5a)"
  ```

---

### Task 5: `reconcileDagRun` — restart reconciliation against git truth (D9 req 2)

**Files:**
- Modify: `opencode-plugin/src/fleet/dag-scheduler.ts` (add `reconcileDagRun`; call it from `runDag` when `resume`)
- Test: `opencode-plugin/test/fleet-dag-reconcile.test.ts`

**Interfaces:**
- Consumes: `DagRunState`/`saveDagState` (Task 1); `execFileSync`; `removeWorktree`/`Worktree` (Task/T1).
- Produces:
  ```ts
  /** On a crash-restart, reconcile persisted INTENT vs git TRUTH (D9):
   *  - a node `running` at crash → crash-leftover: force-remove its orphan
   *    worktree, DELETE its leftover branch (T1's createWorktree prunes admin
   *    state but NEVER deletes a leftover branch — that is the scheduler's
   *    job), reset the node to `pending` (re-drive).
   *  - a `done` node → confirm its branch HEAD == recorded headSha; if the
   *    branch is missing/behind, reset to `pending` and delete the stale
   *    branch (re-drive; re-merging an applied commit is a no-op — T5).
   *  - defensive: if MERGE_HEAD is present on `project` (an interrupted T5
   *    merge), `git merge --abort` (co-owned with T5; T4 clears it so a
   *    half-merged branch never advances).
   *  - `paused-gate`/`escalated`/`failed` are RETAINED — left as-is for a
   *    human/`--resume`; only their vanished worktrees (dir manually deleted)
   *    are admin-pruned. */
  export function reconcileDagRun(run: DagRunState): DagRunState
  ```

- [ ] **Step 1: Write the failing test** — `test/fleet-dag-reconcile.test.ts` (real repo tmpdir):
  - **leftover `running` node:** hand-build a `DagRunState` with node `a` `running` + a real leftover branch `fleet/<runId>/a` (create it via `git branch`) + a `worktreeDir` that no longer exists → `reconcileDagRun` deletes the leftover branch (`git branch --list` empty), resets `a` to `pending`.
  - **`done` node, branch intact:** node `b` `done` with `headSha == git rev-parse fleet/<runId>/b` (create the branch at a real commit) → stays `done` after reconcile.
  - **`done` node, branch vanished:** node `b` `done` but its branch does not exist → reset to `pending` (re-drive).
  - **MERGE_HEAD present:** create a real merge conflict / write a `.git/MERGE_HEAD` and assert reconcile leaves no `MERGE_HEAD` (via `git merge --abort`).
  - **retained states untouched:** a `paused-gate` node whose worktree dir still exists stays `paused-gate`, worktree not removed.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing `reconcileDagRun`).
- [ ] **Step 3: Write minimal implementation** — per the doc-comment contract; use `git -C project branch --list`, `git -C project branch -D`, `git -C project worktree remove --force <dir>` (tolerate "not a worktree"), `git -C project rev-parse -q --verify <ref>`, `git -C project rev-parse -q --verify MERGE_HEAD` + `git -C project merge --abort`. Wire `runDag(resume:true)` to call `reconcileDagRun` after `loadDagState` and before the wave loop.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/dag-scheduler.ts opencode-plugin/test/fleet-dag-reconcile.test.ts
  git commit -m "feat(fleet): T4 reconcileDagRun — restart reconcile leftover branches/worktrees vs git truth (D9)"
  ```

---

### Task 6: durable-write hardening — `fsync` + atomic role-store `score.json` (D9 req 1)

**Files:**
- Modify: `opencode-plugin/src/bench/util.ts` (`writeJsonAtomic` + `writeTextAtomic`: add `fsync`)
- Modify: `opencode-plugin/src/harness-store.ts` (`writeJson`, `:476`: make atomic)
- Test: `opencode-plugin/test/util-atomic-write.test.ts` (new; `harness-store` atomicity asserted via a new case)

**Interfaces:**
- No signature changes: `writeJsonAtomic(path: string, data: unknown): void`, `writeTextAtomic(path: string, text: string): void`, `writeJson(p, data)` (module-private) all keep their shapes. Behavior gains `fsync(file)` (on the tmp fd before rename) + `fsync(dir)` (after rename) for power-loss durability; `harness-store.writeJson` switches from a plain `writeFileSync` to the same temp+rename+fsync discipline (route it through `writeJsonAtomic`).

- [ ] **Step 1: Write the failing test** — `test/util-atomic-write.test.ts`:
  - `writeJsonAtomic`/`writeTextAtomic` still write exact content + trailing newline (regression) and leave NO `*.tmp` sibling behind (fsync + rename completed).
  - Torn-write invariant: a prior complete file survives a subsequent write that leaves a stray `*.tmp` (simulate) — the live file is always whole.
  - `harness-store` score.json path: drive a `recordToStores`/`recordSession` (or the smallest public entry that hits `writeJson`) and assert the resulting `score.json` parses cleanly AND no `.tmp` sibling remains (proves the atomic route). *(fsync itself is not directly observable in-process; the tests assert the observable durability properties — whole file, no tmp litter, prior-intact-on-crash. The fsync calls are verified by inspection + the existing suite staying green.)*
- [ ] **Step 2: Run test to verify it fails** — the `harness-store` no-`.tmp`-litter case FAILS today (plain `writeFileSync` writes in place, and — separately — the fsync assertions are new).
- [ ] **Step 3: Write minimal implementation** — in `writeJsonAtomic`/`writeTextAtomic`, after `writeFileSync(tmp, ...)` open+`fsyncSync`+close the tmp file (or `writeFileSync` then `openSync(tmp,'r')`+`fsyncSync`+`closeSync`), `renameSync`, then `fsyncSync` the containing dir fd. In `harness-store.ts`, replace `writeJson`'s body with a call to `writeJsonAtomic` (import from `./bench/util.ts`) — same 2-space JSON output; confirm existing `harness-store` consumers are unaffected.
- [ ] **Step 4: Run test + full suite** — `bun test test/util-atomic-write.test.ts` PASS; `bun test` green (no regression — existing atomic-write / store tests unchanged).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/bench/util.ts opencode-plugin/src/harness-store.ts opencode-plugin/test/util-atomic-write.test.ts
  git commit -m "feat(fleet): T4 durable-write hardening — fsync + atomic role-store score.json (D9 req 1)"
  ```

---

### Task 7: concurrency safety — advisory `flock` on the two `score.json` sinks + pending gc (explicitly-not-now §5/§5.1)

**Files:**
- Create: `opencode-plugin/src/bench/file-lock.ts` (a tiny advisory-lock helper)
- Modify: `opencode-plugin/src/harness-store.ts` (wrap the `score.json` read-modify-write) and `opencode-plugin/src/fleet/squad-def.ts` (`recordSquadOutcome`, `:331`, wrap its read-modify-write)
- Create/Modify: pending gc in `opencode-plugin/src/fleet/pending.ts` (`gcPending`)
- Test: `opencode-plugin/test/fleet-concurrency.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  // bench/file-lock.ts
  /** Advisory exclusive lock around a critical section keyed by a lock file
   * (sibling of the target). Serializes concurrent read-modify-write of a
   * shared JSON sink so parallel squad-runs never lose an update. */
  export function withFileLock<T>(lockPath: string, fn: () => T): T
  export async function withFileLockAsync<T>(lockPath: string, fn: () => Promise<T>): Promise<T>

  // pending.ts
  /** Prune archived (scored/) sessions older than maxAgeMs (default e.g. 7d).
   * Live pending/ files are never touched. Bounds routine-live-fleet disk. */
  export function gcPending(project: string, opts?: { maxAgeMs?: number }): number  // count pruned
  ```
- The role-store `score.json` write (Task 6 already made it atomic; here its read-modify-write in `recordSession` is wrapped in `withFileLock`) and `recordSquadOutcome`'s read-modify-write are each wrapped so two concurrent writers to the SAME `score.json` never drop a session (lost-update). `gcPending` prunes only the `scored/` archive by mtime.

- [ ] **Step 1: Write the failing test** — `test/fleet-concurrency.test.ts`:
  - `withFileLock` serializes: launch two concurrent closures that each read-modify-write a small counter file; without the lock the final count is `< 2`, with it `== 2` (no lost update). *(Use `withFileLockAsync` with two `await Promise.all` writers over a shared JSON `{n:[]}` array; assert both entries present.)*
  - Two concurrent `recordSquadOutcome` (or `recordSession`) calls to the same version's `score.json` both land (`sessions.length == 2`, `nPass+nFail == 2`).
  - `gcPending`: seed one archived session with an old mtime and one recent → `gcPending(project, {maxAgeMs})` removes the old, keeps the recent, and never touches a live pending file; returns `1`.
- [ ] **Step 2: Run test to verify it fails** — the lost-update case FAILS without the lock; `gcPending` missing.
- [ ] **Step 3: Write minimal implementation** — `withFileLock` via an `O_CREAT|O_EXCL` lockfile spin (bounded retries + a stale-lock timeout) or `fs`-level advisory lock; wrap both `score.json` read-modify-writes; add `gcPending` (readdir `scored/`, `statSync` mtime, `rmSync` past cutoff).
- [ ] **Step 4: Run test + full suite** — `bun test test/fleet-concurrency.test.ts` PASS; `bun test` green.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/bench/file-lock.ts opencode-plugin/src/harness-store.ts opencode-plugin/src/fleet/squad-def.ts opencode-plugin/src/fleet/pending.ts opencode-plugin/test/fleet-concurrency.test.ts
  git commit -m "feat(fleet): T4 concurrency safety — flock score.json sinks + pending gc (§5/§5.1 → N5a)"
  ```

---

### Task 8: CLI wiring — `fleet-dev` subcommand

**Files:**
- Modify: `opencode-plugin/src/bench/cli.ts` (usage block ~55-70; add a `parseFleetDevArgs` in the arg-parser cluster; add a `case "fleet-dev"` to the dispatch switch ~1287)
- Test: `opencode-plugin/test/fleet-dev-cli.test.ts` (new; arg-parse + dispatch, mirroring the `parseSquadRunArgs` test pattern)

**Interfaces:**
- Consumes: `runDag`/`RunDagOpts` (Task 4); `TaskDag`/`DagNode` (Task 1); `readFileSync`.
- Produces the CLI surface (added to `printUsage`):
  ```
  fleet-dev     --project PATH (--dag-file F | --feature "text")
                [--max-concurrency N] [--node-gate-policy auto|root-human]
                [--run-id ID --resume] [--base REF]
  ```
  - `--dag-file F` reads a pre-emitted DAG artifact (`{nodes:[{id,task,deps,files?,mutatesDeps?}]}`) and schedules it — **the T4-testable path** (decoupled from T3's live emit).
  - `--feature "text"` is the full flow: run the top-level planner squad (Designer emits the DAG at gate2, N4) then schedule it — **completed when T3 lands**; in T4 it is a thin wrapper that `die`s with "provide --dag-file (T3 planner-emit integration pending)" if T3's emit is not yet wired. Keep the flag in usage so the surface is stable.
  - `--run-id ID --resume` loads + reconciles an existing `DagRunState` (Task 5) and continues.

- [ ] **Step 1: Write the failing test** — `test/fleet-dev-cli.test.ts`: `parseFleetDevArgs` maps flags → `RunDagOpts` + a DAG source; a `--dag-file` pointing at a temp JSON parses into a `TaskDag`; missing both `--dag-file` and `--feature` returns `null`/usage; `--max-concurrency`/`--node-gate-policy`/`--run-id`/`--resume`/`--base` parse. (Mirror `parseSquadRunArgs`' shape and the existing `fleet-squad-cli.test.ts` arg-parse tests; do NOT spawn a real scheduler here — assert the parsed options object.)
- [ ] **Step 2: Run test to verify it fails** — FAIL (no `parseFleetDevArgs`/case).
- [ ] **Step 3: Write minimal implementation** — add `parseFleetDevArgs` (same flag-walk idiom as `parseSquadRunArgs`), a `case "fleet-dev"` that parses, loads the DAG (`--dag-file`), and calls `runDag(dag, opts)` (or the `--feature` guard-`die`), and the usage line.
- [ ] **Step 4: Run test + full suite** — `bun test test/fleet-dev-cli.test.ts` PASS; `bun test` green.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-dev-cli.test.ts
  git commit -m "feat(fleet): T4 fleet-dev CLI — schedule a task-DAG in parallel worktrees (N5a)"
  ```

---

## Notes / scope boundaries (carried from the spec)

- **T4/T5 boundary (merge is T5, not T4).** T4 drives each node to its terminal outcome, commits `done` nodes on their `fleet/<runId>/<nodeId>` branches, and records `{status, branch, headSha, worktreeDir}` in DAG state. **T5 (N5b)** consumes those `done` node branches: merges them into the integration branch, re-runs the deterministic gate (`bun test` + smoke) on the merged branch, and — post-merge — triggers the node worktree **release** (`removeWorktree(wt)`, `keepBranch:false`). The DAG-state `integrationBranch` field is owned by T5; it is `null`/untracked in T4-alone. T4 exposes the retained worktrees + branches; it does not merge.
- **Node gate policy defaults to `auto`.** The human gate that matters is the **DAG-level gate2** (N4 — approving the plan/granularity/deps), owned by the top-level planner squad (T3). Individual node squad-runs self-gate via their Evaluator VERDICT, so they run `gatePolicy:"auto"`. Gate-pause handling still exists (retention + `--resume`) for a squad-def that sets a human gate — defensive, spec-required.
- **Live-run verification (spec Verification §N1) is DEFERRED to a real `opencode` gate.** The hermetic node test (Task 3) proves a real file written into the worktree lands there + origin stays clean + the commit is code-only (heads-up #1) via an injected `execFn`. The full assertion — an Implementer persona (real drive) writing a **failing test** yields a VERDICT FAIL from the **same** worktree the Evaluator reads (proving all four roles share one worktree, not just the Implementer) — needs a real drive and is a live/smoke gate, not a unit test. Capture it in `smoke/fleet/` when running against a throwaway repo (bootstrap ordering: never point the fleet at its own live tree before this passes).

## Explicitly DEFERRED / out of scope

- **T5 merge + integration-verify (N5b)** — merge node branches → integration branch, re-run `bun test`+smoke, conflict/fail escalation, post-merge worktree release. Depends on T4; separate plan.
- **T2 push/PR boundary (N2)** — the non-admin `fleet/*`-scoped push credential, orchestrator `commit→push→gh pr create` of the **integration** branch, admin-enforced `main` branch protection, `removeWorktree(keepBranch:true)` for the open-PR integration branch. Depends on T1+T5; separate plan.
- **T3 DAG artifact + Designer emit (N4)** — the DAG schema + planner wire-contract + gate2 approval. T4 CONSUMES T3's `{id,task,deps[],files?}` shape; the `--feature` (live planner-emit) CLI path completes when T3 lands. Task 1 mirrors the type locally so T4 builds independently; align to T3's exported type on integration.
- **Master automation (fleet spec §9.4/§9.5, D8/D9)** — `fleet-dev` is invoked by the human-as-master today; the singleton master owning composite scheduling is a separate build (`oc-test`). T4 is designed to be the thing the master later drives, unchanged.
- **Multi-project namespace + fair-share (D8.3)** — `fleet-dev` targets ONE project. Per-project store-slice / worktree / integration-branch / credential-scope isolation + a global resource cap is additive, out of scope for self-hosting v1.
- **Per-phase completion flag (D9 req 3)** — the checkpoint carries `SquadState.phase`; resume already re-enters at the pending gate's phase (`squad-cli.ts` `--resume`). A finer per-phase "in-flight" flag so resume re-runs ONLY the interrupted phase is a squad-cli/checkpoint refinement, tracked with the checkpoint (not the DAG scheduler) — noted, deferred unless a live run shows redundant re-drives.
- **A synthesized whole-feature evaluator drive on the merged branch** (a fresh Evaluator with a synthesized testSpec covering the whole feature, vs. the v1 deterministic `bun test`+smoke gate) — spec architecture step 3 marks this deferred; the deterministic gate is the v1 mechanism (T5).
