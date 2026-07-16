# T5 — Merge + Integration-Verify (N5b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the merge + integration-verify phase (spec **N5b**) that runs AFTER T4's scheduler drives every DAG node to `done`. It merges the completed nodes' `fleet/<runId>/<nodeId>` branches into ONE **integration branch**, then **re-runs the repo's own deterministic gate (`bun test` + smoke) on the MERGED branch** — because a green per-node Evaluator VERDICT is NOT sufficient: two disjoint-file nodes, each green in isolation, can still break a shared interface, and only a re-run of the gate on the merged tree catches it. A git **merge conflict** OR an **integration-gate FAIL** → **escalate** to the human-as-master (recorded in DAG state), NEVER a silent force-merge or PR. On PASS, the verified integration branch is handed to T2/N2 (PR → human merge).

**Architecture:** Two new modules. `fleet/integration-gate.ts` owns the **deterministic gate-runner** (`defaultGateRunner` = `bun test` in `opencode-plugin/` + `smoke/run.sh`, both run on the merged worktree; a `GateRunner` seam lets tests inject). `fleet/merge-integrate.ts` owns the **merge mechanics** (`mergeDoneNodes`: create an integration worktree off the run's base via T1's `createWorktree`, **sequential** `git merge --no-ff` each done node's branch, conflict → `git merge --abort` + throw the integration worktree away) and the **orchestration** (`mergeAndVerify`: merge → gate → escalate|verify, apply the retention/release policy, persist DAG-state atomically). T5 consumes T4's `DagRunState`/`DagNodeState` (nodes carry `status:"done"` + `branch` + `worktreeDir` + `headSha`) and sets the T5-owned `integrationBranch` field. This is spec piece **N5b** and the load-bearing **N4/N5 verification** ("an injected shared-interface break across two disjoint-file nodes, each green in isolation, is caught by the integration gate (`bun test` + smoke), NOT silently PR'd") from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`.

**Master boundary (reference only — do NOT re-plan here):** `mergeAndVerify` is a **skill-less deterministic** step — pure git + a deterministic gate, no LLM. It is exactly the composite scheduling the singleton master (fleet spec §9.4/§9.5, D8/D9) will eventually own; **today the human-as-master invokes T4→T5** and resolves an integration escalation by fixing/re-driving. T5 delegates all skill (any actual code fix on a conflict/fail) back to a re-driven node's squad — the deferred "merge-resolution node" — never to T5 itself.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:child_process` (`execFileSync`), `node:fs`, git worktrees + `git merge`. Hermetic tests: a real git repo in a `mkdtempSync` tmpdir (same idiom as `test/fleet-squad-worktree.test.ts` / `test/fleet-worktree.test.ts`'s `initRepo`), an **injected `GateRunner`** for the merge/escalate/retention logic (no real `bun test`/podman/opencode), plus ONE end-to-end task that runs the **real `defaultGateRunner`** against a tiny synthetic bun-testable tree to prove the deterministic gate genuinely catches a real merged break.

## Global Constraints

- **The integration gate is the cross-node safety net — a per-node VERDICT PASS is NOT enough.** T4 drives each node's own Evaluator to VERDICT PASS in isolation; T5 re-runs `bun test` + smoke on the MERGED tree. Disjoint file-sets prevent only *textual* conflicts — two disjoint-file nodes can still break a shared interface (node A changes `foo`'s signature in `lib.ts`; node B, in `app.ts`, still calls the old signature; textual merge is clean, the merged tree fails). Catching that is T5's whole reason to exist. The load-bearing test (Task 4) constructs exactly this: two disjoint-file nodes each green in isolation, red only after merge.
- **Conflict/fail ESCALATES — it never force-merges and never PRs.** A git conflict → `git merge --abort` (leave no `MERGE_HEAD`), throw the half-built integration worktree away, record the escalation, return. A gate FAIL → keep no PR handoff, throw the integration worktree away, record the escalation, return. NEVER `git merge -X ours/theirs`, `--strategy octopus` force, `git commit` over conflict markers, or hand a red branch to T2. The verified integration branch is produced ONLY on a clean merge AND a green gate.
- **The deterministic gate = `bun test` + smoke, NO LLM.** `defaultGateRunner` shells out to `bun test` (cwd `<mergedDir>/opencode-plugin`) and `bash <mergedDir>/smoke/run.sh`; it is exactly what the human PR reviewer would run. It is NOT the per-node Evaluator VERDICT (spec architecture step 3: `inputFor`'s evaluator-verdict branch, `squad.ts`, builds its prompt from ONE node's `testSpec`+`implReport` — it has no coherent input for a merged multi-node branch). **Smoke means `smoke/run.sh` in its default token-free mode** (Tier A only; it self-skips `exit 0` when tmux/opencode are absent). The live Tier-B smoke (`MH_SMOKE_LIVE=1`, token-spending `smoke/fleet/squad-demo.sh`) is deliberately NOT part of the deterministic gate — a non-deterministic, token-spending, opencode-requiring script cannot be a deterministic gate. See Notes.
- **N1b ledger invariant — T5 touches only git + the DAG-state file; never the ledger.** The node scored/pending records + checkpoints live under `<runtimeRoot>/.meta-harness/runtime/fleet/**` (anchored to `project` = origin repo, N1b) and must SURVIVE the post-merge worktree release so `role-score --gate merge` at PR time (T2) still finds them. T5's DAG-state write goes to the same `dag/` subdir T4 uses (`<runtimeRoot>/.meta-harness/runtime/fleet/dag/<runId>.json`) via T4's `saveDagState`. T5 does a `createWorktree`, `git merge`, the gate, `removeWorktree`, and `saveDagState` — no `writePending`/`saveCheckpoint`/store writes. Verified by asserting the node ledger is intact AFTER `mergeAndVerify` releases the node worktrees.
- **Retention/release policy (spec N1b + T4 Global Constraints).** On a **verified** integration (clean merge + green gate): the done nodes' branches are now in the integration branch → **release** each node worktree with `removeWorktree(wt)` (default `keepBranch:false` → the merged node branch is deleted; individual nodes never open their own PR, N2), mark those nodes `merged`, and **RETAIN** the integration worktree + branch for T2's PR. On **conflict OR gate-fail**: **RETAIN** every node worktree (a human / re-driven node fixes the break — the node code is still needed) and **THROW AWAY** the integration worktree (`removeWorktree(intWt)` default `keepBranch:false` — nothing to PR). `keepBranch:true` (T4-noted "T5/N2 integration-branch case") is where T2 later disposes of the integration worktree while keeping the branch for the open PR — referenced, exercised by T2, not T5.
- **Sequential merge, not octopus (per-node conflict attribution).** The spec permits "git octopus OR sequential merge." Sequential `git merge --no-ff --no-edit <nodeBranch>` one node at a time lets T5 name WHICH node conflicted in the escalation (octopus aborts wholesale without attribution). Every node branch was created by T4 off the SAME resolved `run.base` SHA (`createWorktree(project, {branch, base: run.base})`), so the integration branch — also created off `run.base` — has a clean common ancestor with each.
- **Atomic durable-state writes + crash-consistency (D9).** `mergeAndVerify` mutates `run` and re-persists it via T4's `saveDagState` (atomic temp+rename) after the terminal transition — the integration branch is real only after its merge commits, and the DAG-state `integrationBranch` is set only after a green gate. Before merging, guard against a leftover `MERGE_HEAD` on `project` (co-owned with T4's `reconcileDagRun`): if present, `git merge --abort` first. A crash mid-merge leaves an un-set `integrationBranch` → on restart T4's reconcile aborts the partial merge and the run re-enters T5 cleanly (re-merging an already-applied commit is a no-op).
- **Back-compat with shipped fleet + T1 is byte-identical.** T5 ADDS two modules and one ADDITIVE optional field to T4's `DagRunState` (`integrationEscalation?`). It does not change `createWorktree`/`removeWorktree`/`cmdSquadRun`/`cmdRoleRun` signatures, and it imports `DagRunState`/`DagNodeState`/`saveDagState`/`dagStatePath` from T4's `fleet/dag-state.ts` unchanged.
- **`bun test test/<file>.test.ts` from `opencode-plugin/`.** All tests hermetic (tmpdir repos, injected `GateRunner`; the one real-gate task runs `bun test` only against a tiny synthetic tree, never the whole suite). `git` only via `execFileSync("git", [...])` — never a shell string (no interpolation/injection).
- **deps: T4.** T5 consumes T4's `fleet/dag-state.ts` (`DagRunState`/`DagNodeState`/`saveDagState`) and T4's produced DAG state (nodes `done` with `branch`/`worktreeDir`/`headSha`). T4 must land first. T5 does NOT import `fleet/dag-scheduler.ts` (it operates on the already-produced state), so it can be built and tested against a hand-built `DagRunState`.

---

### Task 1: `fleet/integration-gate.ts` — the deterministic gate-runner (`bun test` + smoke)

**Files:**
- Create: `opencode-plugin/src/fleet/integration-gate.ts`
- Test: `opencode-plugin/test/fleet-integration-gate.test.ts`

**Interfaces:**
- Consumes: `execFileSync` (`node:child_process`), `existsSync` (`node:fs`), `join` (`node:path`).
- Produces:
  ```ts
  export interface GateResult {
    ok: boolean
    /** each command run + its rc + a tail of its output — the escalation body */
    report: string
    steps: { cmd: string; rc: number }[]
  }
  /** Run the repo's deterministic gate on a MERGED worktree root. Production =
   * the real gate the human PR reviewer runs; a test injects a stub. */
  export type GateRunner = (mergedDir: string) => GateResult

  /** The v1 deterministic gate (spec N5b): `bun test` (cwd
   * `<mergedDir>/opencode-plugin` if present, else `<mergedDir>`) then
   * `bash <mergedDir>/smoke/run.sh` (skipped if absent). NO LLM; NOT the
   * per-node Evaluator VERDICT. Runs `smoke/run.sh` in its default token-free
   * mode (Tier A; self-skips exit 0 without tmux/opencode) — the live Tier-B
   * smoke is NOT part of the deterministic gate. `ok` iff every step rc===0. */
  export const defaultGateRunner: GateRunner

  /** exposed for reuse/testing: the ordered command list + cwd for a merged dir. */
  export function gateSteps(mergedDir: string): { cmd: string[]; cwd: string }[]
  ```

- [ ] **Step 1: Write the failing test**

  Create `opencode-plugin/test/fleet-integration-gate.test.ts`. Build a tiny synthetic merged tree in a tmpdir (NO git needed — the gate runs on a directory): an `opencode-plugin/` with a `package.json` (`{"name":"x"}`) and ONE `x.test.ts` that `bun test` will actually run, plus a `smoke/run.sh` stub.
  - **green tree → ok:** `x.test.ts` = `import {test,expect} from "bun:test"; test("ok",()=>expect(1).toBe(1))`; `smoke/run.sh` = `#!/usr/bin/env bash\nexit 0`. `defaultGateRunner(dir).ok` is `true`; `steps` has a `bun test` step rc 0 and a smoke step rc 0.
  - **red `bun test` → not ok:** flip `x.test.ts` to `expect(1).toBe(2)`. `defaultGateRunner(dir).ok` is `false`; `report` contains the failing-test signal; the `bun test` step rc ≠ 0.
  - **red smoke → not ok:** green test but `smoke/run.sh` = `exit 3`. `ok` is `false`; the smoke step rc is 3.
  - **missing smoke tolerated:** green test, no `smoke/run.sh` → `ok` true and `steps` has NO smoke entry (skipped, not failed).
  - `gateSteps(dir)` lists `bun test` cwd `<dir>/opencode-plugin` when that dir exists (assert the cwd string).

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test test/fleet-integration-gate.test.ts`
  Expected: FAIL — `Cannot find module '../src/fleet/integration-gate.ts'`.

- [ ] **Step 3: Write minimal implementation**

  Create `opencode-plugin/src/fleet/integration-gate.ts`. `gateSteps(dir)`: `[{cmd:["bun","test"], cwd: existsSync(join(dir,"opencode-plugin")) ? join(dir,"opencode-plugin") : dir}]`, then push `{cmd:["bash", join(dir,"smoke","run.sh")], cwd: dir}` only if `existsSync(join(dir,"smoke","run.sh"))`. `defaultGateRunner(dir)`: run each step with `execFileSync(cmd[0], cmd.slice(1), {cwd, encoding:"utf-8"})` inside try/catch (a nonzero rc throws — capture `e.status` as rc and `e.stdout`/`e.stderr` for the report); accumulate `steps` + a tail of each output into `report`; `ok = steps.every(s => s.rc === 0)`. Never throw — a failing gate is a RESULT, not an exception.

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test test/fleet-integration-gate.test.ts`
  Expected: PASS (5 cases).

- [ ] **Step 5: Commit**

  ```bash
  git add opencode-plugin/src/fleet/integration-gate.ts opencode-plugin/test/fleet-integration-gate.test.ts
  git commit -m "feat(fleet): T5 integration-gate — deterministic bun test + smoke gate-runner (N5b)"
  ```

---

### Task 2: `fleet/merge-integrate.ts` — `mergeDoneNodes` (sequential merge + conflict detection)

**Files:**
- Create: `opencode-plugin/src/fleet/merge-integrate.ts` (this task adds `mergeDoneNodes`; Task 3 adds `mergeAndVerify` to the same file)
- Test: `opencode-plugin/test/fleet-merge-integrate.test.ts`

**Interfaces:**
- Consumes (REAL shipped signatures): `createWorktree(repo: string, opts: { branch: string; base?: string }): Worktree`, `removeWorktree(wt: Worktree, opts?: { keepBranch?: boolean }): void`, `Worktree` (`{ dir; branch; repo }`) from `./worktree.ts`; `execFileSync` (`node:child_process`); `die` from `../bench/util.ts`.
- Produces:
  ```ts
  export type MergeOutcome =
    | { status: "merged"; integrationWorktree: Worktree; merged: string[] }
    | { status: "conflict"; conflictBranch: string; conflictNode: string; merged: string[] }

  /** Create an integration worktree off `base` and SEQUENTIALLY merge each
   * `{node, branch}` into it (`git merge --no-ff --no-edit`). On the first
   * conflict: `git merge --abort` (leave no MERGE_HEAD), `removeWorktree` the
   * half-built integration worktree (keepBranch:false — nothing to PR), and
   * return `conflict` naming the offending node. On all-clean: return the
   * retained integration worktree. NEVER force-resolves. */
  export function mergeDoneNodes(
    project: string,
    opts: { integrationBranch: string; base: string; nodes: { id: string; branch: string }[] },
  ): MergeOutcome
  ```

- [ ] **Step 1: Write the failing test**

  Create `opencode-plugin/test/fleet-merge-integrate.test.ts`. Reuse the `initRepo()` idiom (real git repo in tmpdir, `.gitignore` with `.meta-harness/`+`node_modules/`, an initial commit). Helper `nodeBranch(repo, base, branch, files: Record<string,string>)`: `createWorktree(repo,{branch,base})`, write the files, `git -C wt.dir add -A`, `git -C wt.dir commit -m ...`, `removeWorktree(wt,{keepBranch:true})` (keep the branch, drop the checkout — simulates a T4 `done` node's branch).
  - **two disjoint-file nodes merge clean:** node `a` adds `a.ts`, node `b` adds `b.ts` (off the same `base = git rev-parse HEAD`). `mergeDoneNodes(repo,{integrationBranch:"fleet/int/r1", base, nodes:[{id:"a",branch:"fleet/r1/a"},{id:"b",branch:"fleet/r1/b"}]})` → `status:"merged"`; the returned `integrationWorktree.dir` contains BOTH `a.ts` and `b.ts`; `git -C repo log --oneline fleet/int/r1` shows both node merges; the integration worktree still exists (retained).
  - **conflicting nodes:** node `a` and node `b` BOTH write `same.ts` with divergent content (off the same base) → `mergeDoneNodes` returns `status:"conflict"` naming the second node; `git -C repo rev-parse -q --verify fleet/int/r1` is empty (branch thrown away) OR the integration worktree is gone (`existsSync` false); assert no dangling worktree admin entry (`git -C repo worktree list` does not contain the int dir).
  - **first-node-clean, second-node-conflict attribution:** `a` clean, `b` conflicts → `conflictNode === "b"`, `merged` includes `"a"`.

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test test/fleet-merge-integrate.test.ts`
  Expected: FAIL — `Cannot find module '../src/fleet/merge-integrate.ts'`.

- [ ] **Step 3: Write minimal implementation**

  `mergeDoneNodes`: guard a leftover merge — `try { execFileSync("git",["-C",project,"rev-parse","-q","--verify","MERGE_HEAD"]); execFileSync("git",["-C",project,"merge","--abort"]) } catch {}` (no-op when clean). `const intWt = createWorktree(project, {branch: opts.integrationBranch, base: opts.base})`. For each `{id,branch}` in order: `execFileSync("git",["-C",intWt.dir,"merge","--no-ff","--no-edit",branch])` inside try/catch. On catch (conflict): `execFileSync("git",["-C",intWt.dir,"merge","--abort"])` (tolerate failure), `removeWorktree(intWt)` (throws the branch away), `return {status:"conflict", conflictBranch: branch, conflictNode: id, merged}`. Else push `id` to `merged`. After the loop: `return {status:"merged", integrationWorktree: intWt, merged}`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test test/fleet-merge-integrate.test.ts`
  Expected: PASS (3 cases).

- [ ] **Step 5: Commit**

  ```bash
  git add opencode-plugin/src/fleet/merge-integrate.ts opencode-plugin/test/fleet-merge-integrate.test.ts
  git commit -m "feat(fleet): T5 mergeDoneNodes — sequential integration merge + conflict-abort (N5b)"
  ```

---

### Task 3: `mergeAndVerify` — merge → gate → escalate|verify + retention/release + atomic DAG-state (N5b)

**Files:**
- Modify: `opencode-plugin/src/fleet/merge-integrate.ts` (add `mergeAndVerify` + `IntegrationResult`)
- Modify: `opencode-plugin/src/fleet/dag-state.ts` (add ONE additive optional field `integrationEscalation?` to `DagRunState`)
- Test: `opencode-plugin/test/fleet-merge-verify.test.ts`

**Interfaces:**
- Consumes: `mergeDoneNodes` (Task 2); `GateRunner`/`GateResult`/`defaultGateRunner` (Task 1); `DagRunState`/`DagNodeState`/`saveDagState` from `./dag-state.ts` (T4 Task 1 — REAL shapes: `DagNodeState` has `id`, `status`, `branch?`, `worktreeDir?`, `headSha?`; `DagRunState` has `runId`, `project` (= runtimeRoot), `base`, `nodes: Record<string,DagNodeState>`, `integrationBranch?`); `removeWorktree`/`Worktree` from `./worktree.ts`.
- The one additive field on `DagRunState` (`dag-state.ts`):
  ```ts
    integrationBranch?: string
    /** T5/N5b: set when merge/gate escalates (persisted for crash-resume +
     * human visibility). Absent on a verified run. ADDITIVE, back-compat:
     * T4's loader ignores it when absent. */
    integrationEscalation?: { kind: "conflict" | "gate-failed"; detail: string; ts: string }
  ```
- Produces:
  ```ts
  export type IntegrationResult =
    | { status: "verified"; integrationBranch: string; integrationWorktree: Worktree; merged: string[]; gate: GateResult }
    | { status: "conflict"; conflictNode: string; merged: string[] }
    | { status: "gate-failed"; integrationBranch: string; merged: string[]; gate: GateResult }

  /** N5b: merge every `done` node's branch into a fresh integration branch,
   * re-run the deterministic gate on the MERGED tree, and:
   *  - conflict → escalate (retain node worktrees; integration worktree thrown
   *    away by mergeDoneNodes); record `integrationEscalation`; persist.
   *  - gate FAIL → escalate (retain node worktrees; throw the integration
   *    worktree away — nothing to PR); record `integrationEscalation`; persist.
   *  - PASS → mark those nodes `merged`; set `run.integrationBranch`; RELEASE
   *    each node worktree (removeWorktree, keepBranch:false); RETAIN the
   *    integration worktree+branch for T2/N2; persist.
   * NEVER force-merges, NEVER PRs a red branch. Mutates + re-persists `run`. */
  export function mergeAndVerify(
    run: DagRunState,
    opts?: { integrationBranch?: string; gateRunner?: GateRunner },
  ): IntegrationResult
  ```
  Node-worktree reconstruction for release: from a `done` `DagNodeState` build `{ dir: st.worktreeDir!, branch: st.branch!, repo: run.project }` (T1's `removeWorktree` runs `git -C repo worktree remove --force dir`; `run.project` is the absolute origin repo).

- [ ] **Step 1: Write the failing test**

  Create `opencode-plugin/test/fleet-merge-verify.test.ts` (real git repo tmpdir; `META_HARNESS_HOME` per-test so `saveDagState`'s path resolves). Helper builds a `DagRunState` with two `done` nodes whose branches exist AND whose `worktreeDir` are LIVE T1 worktrees (so release can be asserted). Use `createWorktree` to make each node's worktree, write a disjoint file, commit, and record `{status:"done", branch, worktreeDir: wt.dir, headSha}` — leaving the worktree checked out (retained, as T4 leaves a `done` node).
  - **verified (injected gate ok):** `gateRunner = () => ({ok:true, report:"", steps:[]})`. `mergeAndVerify(run, {gateRunner})` → `status:"verified"`; both nodes' `run.nodes[id].status === "merged"`; `run.integrationBranch` set; both node worktree dirs are GONE (`existsSync` false — released); the integration worktree exists (retained); `loadDagState(run.project, run.runId).integrationBranch` equals the set branch (persisted); **N1b:** the node scored/pending ledger under `<project>/.meta-harness/runtime/fleet/` is still present after release (seed a `scored/<id>.json` before the call, assert it survives).
  - **cross-node break (injected gate FAIL) → escalate, NOT PR (load-bearing logic):** `gateRunner = () => ({ok:false, report:"integration break: foo/2 vs foo/1", steps:[{cmd:"bun test",rc:1}]})`. → `status:"gate-failed"`; node statuses UNCHANGED (still `done`); both node worktrees RETAINED (`existsSync` true — a human/re-drive fixes them); the integration worktree is GONE (thrown away — nothing to PR); `run.integrationBranch` NOT set; `run.integrationEscalation.kind === "gate-failed"`; `loadDagState(...).integrationEscalation` persisted.
  - **conflict → escalate:** make the two nodes write the SAME file divergently. `mergeAndVerify(run, {gateRunner: okStub})` → `status:"conflict"` with `conflictNode`; node worktrees RETAINED; `integrationEscalation.kind === "conflict"`; the gate is NEVER called (assert the injected gate spy count is 0 — no merged tree to gate).
  - **MERGE_HEAD guard:** write a stray `.git/MERGE_HEAD` in `project` before a clean-merge verified run → `mergeAndVerify` still succeeds (the pre-merge abort cleared it); assert no `MERGE_HEAD` remains.

- [ ] **Step 2: Run test to verify it fails**

  Run: `bun test test/fleet-merge-verify.test.ts`
  Expected: FAIL — `mergeAndVerify` not exported (and `integrationEscalation` absent on `DagRunState`).

- [ ] **Step 3: Write minimal implementation**

  Add the optional `integrationEscalation?` field to `DagRunState` in `dag-state.ts` (additive; no other change). Implement `mergeAndVerify`: pick `done = Object.values(run.nodes).filter(n => n.status === "done")`; `integrationBranch = opts?.integrationBranch ?? \`fleet/int/${run.runId}\``; `const m = mergeDoneNodes(run.project, {integrationBranch, base: run.base, nodes: done.map(n => ({id:n.id, branch:n.branch!}))})`. If `m.status === "conflict"`: set `run.integrationEscalation = {kind:"conflict", detail:\`node ${m.conflictNode} conflicts on merge\`, ts:new Date().toISOString()}`, `saveDagState(run.project, run)`, return `{status:"conflict", conflictNode:m.conflictNode, merged:m.merged}`. Else run `const gate = (opts?.gateRunner ?? defaultGateRunner)(m.integrationWorktree.dir)`. If `!gate.ok`: `removeWorktree(m.integrationWorktree)` (throw away — nothing to PR), set `run.integrationEscalation = {kind:"gate-failed", detail: gate.report, ts:...}`, `saveDagState`, return `{status:"gate-failed", integrationBranch, merged:m.merged, gate}`. Else (verified): for each `done` node set `run.nodes[id].status = "merged"` and `removeWorktree({dir: st.worktreeDir!, branch: st.branch!, repo: run.project})` (release; `keepBranch:false`); `run.integrationBranch = integrationBranch`; delete `run.integrationEscalation`; `saveDagState(run.project, run)`; return `{status:"verified", integrationBranch, integrationWorktree: m.integrationWorktree, merged:m.merged, gate}`.

- [ ] **Step 4: Run test to verify it passes**

  Run: `bun test test/fleet-merge-verify.test.ts`
  Expected: PASS (4 cases).

- [ ] **Step 5: Commit**

  ```bash
  git add opencode-plugin/src/fleet/merge-integrate.ts opencode-plugin/src/fleet/dag-state.ts opencode-plugin/test/fleet-merge-verify.test.ts
  git commit -m "feat(fleet): T5 mergeAndVerify — integration gate escalates conflict/fail, verifies + releases (N5b)"
  ```

---

### Task 4: E2E — the real `defaultGateRunner` catches a cross-node interface break (spec N4/N5 verification)

**Files:**
- Test: `opencode-plugin/test/fleet-merge-verify-e2e.test.ts` (new; integration test only — no new source)

**Interfaces:**
- Consumes: `mergeAndVerify` (Task 3) with the DEFAULT (real) `defaultGateRunner` (Task 1); `defaultGateRunner` directly (to prove per-node isolation-greenness); `createWorktree` (T1); `saveDagState`/`DagRunState` (T4).
- Produces: nothing (the load-bearing proof of the spec's "an injected shared-interface break across two disjoint-file nodes, each green in isolation, is caught by the integration gate (`bun test` + smoke), NOT silently PR'd").

- [ ] **Step 1: Write the failing test (passes once Tasks 1–3 are in — this is the end-to-end N5b proof)**

  Create `opencode-plugin/test/fleet-merge-verify-e2e.test.ts`. Build a real tmpdir git repo whose `opencode-plugin/` is a **tiny bun-testable package** (its own `package.json` + tests — so `bun test` there runs ONLY these synthetic tests, never the meta-harness suite), plus a `smoke/run.sh` stub (`exit 0`). Base commit (`main`) has `opencode-plugin/lib.ts` = `export function foo(a: string): string { return a }`, `opencode-plugin/lib.test.ts` green for `foo("x")`, and `opencode-plugin/app.ts` = `import {foo} from "./lib"; export const app = () => foo("z")`, `opencode-plugin/app.test.ts` asserting `app() === "z"` — all green. `base = git rev-parse HEAD`.
  - **Node A** (worktree off base, branch `fleet/r1/a`): edits ONLY `lib.ts` → `foo(a: string, b: string): string { return a + b }` AND its own `lib.test.ts` → asserts `foo("x","y") === "xy"`. Commit. **Assert green in isolation:** `defaultGateRunner(wtA.dir).ok === true`. Files touched: `lib.ts`, `lib.test.ts`.
  - **Node B** (worktree off base, branch `fleet/r1/b`): edits ONLY `app.ts`/`app.test.ts` — adds a second caller `app2 = () => foo("q")` + a test — still calling the OLD 1-arg `foo` (which is 1-arg on base). Commit. **Assert green in isolation:** `defaultGateRunner(wtB.dir).ok === true`. Files touched: `app.ts`, `app.test.ts` — **disjoint from Node A**.
  - Build a `DagRunState` with A,B `done` (branches + live worktreeDirs), then `mergeAndVerify(run)` with the **DEFAULT** gate (no injected `gateRunner`). The textual merge is CLEAN (disjoint files), but the merged tree has `foo` requiring 2 args while `app.ts` calls it with 1 → **real `bun test` FAILS**. Assert: `result.status === "gate-failed"`; `result.gate.ok === false`; `run.integrationBranch` is NOT set (never handed to T2/PR); `run.integrationEscalation.kind === "gate-failed"`; both node worktrees RETAINED (`existsSync` true). This is the spec's load-bearing claim end-to-end: **green in isolation, red on merge, caught by the gate, not silently PR'd.**
  - **companion happy-path E2E:** a variant where Node B's edit is compatible (calls `foo("q","r")`) → merged `bun test` GREEN → `mergeAndVerify` returns `verified`, `integrationBranch` set, node worktrees released. Proves the gate does not false-positive.

- [ ] **Step 2: Run test to verify it passes**

  Run: `bun test test/fleet-merge-verify-e2e.test.ts`
  Expected: PASS (2 E2E cases). If Task 1/2/3 is incomplete this fails — this is the end-to-end gate for N5b.

- [ ] **Step 3: Run the full suite (no regression)**

  Run: `bun test`
  Expected: all green (existing fleet + T1 + T4 tests unchanged; T5 only ADDS modules + one additive optional `DagRunState` field).

- [ ] **Step 4: Commit**

  ```bash
  git add opencode-plugin/test/fleet-merge-verify-e2e.test.ts
  git commit -m "test(fleet): T5 e2e — disjoint-file interface break green-in-isolation caught by integration gate (N5b)"
  ```

---

## Notes / scope boundaries (carried from the spec)

- **Why the gate, not the per-node VERDICT (spec architecture step 3).** `inputFor`'s evaluator-verdict branch (`squad.ts`) builds its prompt from ONE node's `testSpec`+`implReport` — it has no coherent input for a merged multi-node branch. `bun test` + smoke needs no synthesized spec and is exactly what the human PR reviewer runs. A fresh Evaluator drive with a synthesized whole-feature `testSpec` on the merged branch is a future option — DEFERRED; the deterministic gate is the v1 mechanism.
- **Smoke interpretation (resolved).** The spec references the smoke suite as `smoke/fleet/…`, but `smoke/fleet/squad-demo.sh` is a **live, token-spending, opencode-requiring** E2E — it cannot be a *deterministic* gate. `defaultGateRunner` therefore runs `smoke/run.sh` in its default token-free Tier-A mode (which self-skips `exit 0` when tmux/opencode are absent); the live Tier-B smoke (`MH_SMOKE_LIVE=1`) is out of the deterministic gate. If a fleet-specific token-free smoke is later added under `smoke/fleet/`, add it to `gateSteps` — the seam makes that a one-line change.
- **T4→T5 handoff (consumed, not re-planned).** T4 drives each node to `done`, makes the orchestrator-owned **code-only** commit on `fleet/<runId>/<nodeId>`, and records `{status:"done", branch, worktreeDir, headSha}` in `DagRunState`. T5 consumes exactly those `done` nodes. The `merged` `NodeStatus` and the `integrationBranch?` field already exist in T4's `dag-state.ts` (T4 Task 1) — T5 is their writer. T5 adds ONE additive optional field (`integrationEscalation?`).
- **T5→T2 handoff.** On `verified`, T5 RETAINS the integration worktree + branch and records `integrationBranch`. T2/N2 then commits nothing new (the merge commits are the content), pushes the `fleet/*`-branch with the non-admin scoped credential, and `gh pr create`s — and owns the integration worktree's final disposition (`removeWorktree(intWt, {keepBranch:true})` — keep the branch for the open PR). T5 does NOT push or PR.
- **Crash-consistency (D9), co-owned with T4.** T5's pre-merge `MERGE_HEAD` abort + atomic `saveDagState` means a crash mid-merge leaves `integrationBranch` unset; on restart T4's `reconcileDagRun` aborts any partial merge and the run re-enters T5 (re-merging an already-applied commit is a no-op). The integration branch's merge commits are the durable truth.

## Explicitly DEFERRED / out of scope

- **T2 push/PR boundary (N2)** — the non-admin `fleet/*`-scoped push credential, orchestrator `commit→push→gh pr create` of the **integration** branch, admin-enforced `main` branch protection, `removeWorktree(intWt, {keepBranch:true})` disposal of the integration worktree. Depends on T1+T5; separate plan. T5 stops at a retained, verified integration branch.
- **Spawn a merge-resolution node** — the spec's alternative to escalation ("escalate OR spawn a merge-resolution node"). v1 ESCALATES to the human-as-master (records `integrationEscalation`, retains node worktrees). Auto-spawning a fix-squad on the merged tree is a T4-scheduler extension — DEFERRED.
- **A synthesized whole-feature Evaluator drive on the merged branch** (a fresh Evaluator with a synthesized `testSpec` covering the whole feature, vs. the v1 deterministic `bun test`+smoke gate) — spec architecture step 3 marks this deferred; the deterministic gate is the v1 mechanism.
- **Octopus merge** — sequential merge is chosen for per-node conflict attribution (the spec permits either). An octopus fast-path for many clean disjoint nodes is a possible optimization — DEFERRED (unneeded at the small concurrency cap).
- **Live-run verification (spec Verification §N1/§N3)** — the full real-`opencode` flow (feature → DAG → parallel nodes → merge → integration-verify → PR → human merge) is a live/smoke gate (T7), not a hermetic unit test. Task 4 proves the merge+gate mechanism with a real `bun test` on a synthetic tree; the real all-roles-share-one-worktree drive stays the §N1 live gate.
- **Multi-project namespace + fair-share (D8.3)** — T5 targets ONE run's integration branch under one `project`. Per-project isolation is additive, out of scope for self-hosting v1.
