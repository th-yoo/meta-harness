# T7 — Self-Host End-to-End Smoke (the capstone) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the whole self-hosting stack composes and holds its invariants on a REAL run: `fleet-dev --project ~/z2/meta-harness --feature "<trivial>"` → the planner Designer emits a task-DAG (T3/N4) → the human approves it at gate2 → the scheduler runs the READY nodes as parallel A→D→I→E squads in throwaway git worktrees (T4/N5a, T6/N3 render) → the completed node branches merge into one integration branch and the deterministic gate (`bun test` + `smoke/fleet/*`) re-runs on the merged branch (T5/N5b) → one PR is pushed with the `fleet/*`-scoped credential (T2/N2) → **the flow STOPS at human merge** (never auto-merges `main`). This is spec line 91 (**T7 end-to-end smoke, deps: T2, T5, T6**) and the **N3 self-host-e2e** verification (spec line 107), where **N1/N1b/N2/N4/N5** all fire together on a real run.

**Architecture:** T7 adds almost no new units — it is an INTEGRATION/SMOKE plan: three hermetic `bun test` files that drive the *composed* stack through injected seams (proving the plumbing), plus one live smoke script that drives the real thing against the real repo. The one bit of new wiring is closing the `--feature` seam that T4 explicitly stubbed (`docs/superpowers/plans/2026-07-16-t4-fleet-dev-scheduler.md` Task 8: `--feature` today `die`s "provide --dag-file (T3 planner-emit integration pending)") — T7 wires the planner-emit → gate2-approve → `dagFromApprovedPayload` → the existing `cmdFleetDev` DAG tail (runDag → mergeAndVerify → pushAndOpenPr). Everything below reuses shipped/sibling exports; T7 owns the *composition + assertions + the live smoke*, not the constituent modules.

**Where T7 sits in the build DAG:** Wave 4 (spec line 98) — after **T2** (push/PR boundary, N2), **T5** (merge + integration-verify, N5b), and **T6** (self-host target + render seam, N3), which transitively pull in **T1** (worktree primitive, SHIPPED), **T3** (DAG artifact, N4), and **T4** (parallel scheduler, N5a + D9). T7 is the proof the six pieces are one working stack.

**Concurrent-plan note (T5/T2 may be unwritten at execution time):** the T5 (`2026-07-16-t5-merge-integration-verify.md`) and T2 (`2026-07-16-t2-push-pr-boundary.md`) plans are being written in parallel and may be absent. T7 consumes them at their **spec-level interface** (N5b / N2, pinned in Global Constraints below) and the hermetic composition test injects a **mock at that seam**. On T5/T2 landing, swap the mock for the real export and re-run; T7's assertions (an integration branch is created off `base`, the deterministic gate re-runs on the *merged* branch, the push targets a `fleet/*` branch and NEVER `main`) are interface-stable.

**Tech Stack:** TypeScript, Bun (`bun test`, `bun:test`), `node:child_process` (`execFileSync`), `node:fs`, git worktrees — plus, for the ONE live task, `bash`, a credentialed `opencode` on PATH, `git`, and (only under the PR gate) `gh` + the T2 scoped credential. Hermetic tests mirror `test/fleet-squad-worktree.test.ts` / `test/fleet-dag-run.test.ts` / `test/fleet-e2e.test.ts`: a real git repo in a `mkdtempSync` tmpdir, `META_HARNESS_HOME` per-test, injected `execFn`/`squadRun`/`DriveFn` seams and the `trace()` NDJSON fixture — **no real `opencode` spawn, no network, no real repo, no real store**.

## Global Constraints

- **Never auto-merge `main`; the smoke STOPS at the open PR.** The terminal state of the whole flow is a verified integration branch and (only under the PR gate) one open PR; the `main` merge is a human action in the GitHub UI — the load-bearing "human merges" invariant (spec N2/N3, lines 29/74/107). **No task — hermetic or live — ever merges, pushes, or force-pushes `main`.** Individual nodes never open their own PR; there is exactly one PR per feature (the integration branch's).
- **Running-instance-safe = snapshot-and-compare, NOT assume-empty (N1).** The invariant is that the fleet run leaves the origin's working tree **unchanged**, not absolutely clean. Every N1 assertion captures `git -C <origin> status --porcelain` (and the `.opencode/agents/` listing) BEFORE the run and asserts it is byte-identical AFTER — the operator may legitimately have their own uncommitted work; the invariant is **zero fleet-caused delta**. Worktrees are throwaway `mkdtemp` dirs (T1); the origin tree is never any role's `--dir` and personas render only into the worktree (T6).
- **Throwaway `META_HARNESS_HOME` + pre-migration store guard (MIRROR the depth-1 e2e — this is the exact failure a prior session hit).** The live smoke sets a dedicated persistent throwaway `META_HARNESS_HOME` (`$HOME/.mh-selfhost-smoke`), NEVER the real `~/.config/meta-harness`. Before it touches that var it runs the SAME guard as `smoke/fleet/squad-demo.sh:39-43`: `runner.ts` calls `migrateAccountRoot()` on **every** invocation, so if the legacy store `$HOME/.config/opencode/.meta-harness` still exists as a REAL directory (not yet a symlink), pointing `META_HARNESS_HOME` at the throwaway root would MOVE the user's real evolved store into the sandbox. Guard: if `[ -d "$LEGACY" ] && [ ! -L "$LEGACY" ]` → SKIP with an actionable message (run any `runner.ts` command once WITHOUT `META_HARNESS_HOME` first to perform the one-time migration). Hermetic tests set `META_HARNESS_HOME` to a per-test tmpdir and never call the real migration.
- **The live run is explicitly costed + DOUBLE-gated; nothing costed runs by default.** `MH_SMOKE_LIVE=1` enables the token/opencode-drive portion (the planner squad + N node-squads × ~5 drives each + the integration `bun test`+smoke — real Haiku/Sonnet tokens, several minutes). `MH_SELFHOST_PR=1` (which ALSO requires the T2 `fleet/*`-scoped credential provisioned in the environment) enables the real `git push` + `gh pr create`. With neither, the script SKIPs (exit 0). With only `MH_SMOKE_LIVE`, it runs the full local flow and STOPS after integration-verify, printing the verified integration ref — it never touches the network.
- **Hermetic ⟂ live split (exactly as T1's plan separated the plumbing tests from the live §N1 check).** Tasks 1–3 are hermetic `bun test` — real git in tmpdir, injected `execFn`/`squadRun`/mocked push, ZERO tokens/network/real-repo/real-store — proving the composed plumbing. Task 4 is the SINGLE real live run — tokens (+ optional network) — proving the wire holds end-to-end against the real repo. A hermetic test never spawns `opencode`, never pushes, never targets `~/z2/meta-harness` or `~/.config/meta-harness`.
- **T5/T2 consumed at their spec interface (pin — align on landing):**
  - **T5 / N5b** `mergeAndVerify(run: DagRunState, deps?: { verifyFn?: (branch: string, cwd: string) => { ok: boolean; log: string } }): { integrationBranch: string; ok: boolean; conflicts?: string[]; verifyLog: string }` — merges every `done` node branch into `fleet/<runId>/integration` (off `run.base`); on a git conflict OR a failing deterministic gate returns `ok:false` (→ escalation, no PR). The default `verifyFn` runs `bun test` + `smoke/fleet/*` in the integration worktree (spec architecture step 3 / line 58).
  - **T2 / N2** `pushAndOpenPr(args: { project: string; integrationBranch: string }, deps?: { pushFn?: (branch: string) => void; prFn?: (branch: string) => string }): { pushed: boolean; prUrl?: string }` — orchestrator-owned; the branch name is orchestrator-fixed (`fleet/<runId>/integration`, never agent-chosen), pushed with the **`fleet/*`-scoped non-admin** credential; `gh pr create` opens ONE PR; **never** targets `main`; the integration worktree is released with `removeWorktree(wt, { keepBranch: true })` so the open PR's branch survives (spec N2, lines 47-50; T4 constraint line 16).
- **`git` only via `execFileSync("git", [...])`** — never a shell string (no interpolation/injection). **Tests run with** `bun test test/<file>.test.ts` from `opencode-plugin/`.

---

### Task 1 (HERMETIC): end-to-end composition + close the `--feature` planner-emit seam

Drive the *composed* stack — planner-emit (T3) → schedule (T4) → merge+verify (T5, mocked at its interface) → PR (T2, mocked at its interface) — through one `cmdFleetDev --feature` flow with injected seams, and close the one open seam (T4's `--feature` stub). Proves **N4/N5** (2 independent nodes run concurrently, the dependent unblocks only on VERDICT PASS, all merge into one integration branch), **N1** (origin tree unchanged throughout), **N1b** (ledger under `runtimeRoot` survives node-worktree release), and that the PR seam is handed a `fleet/*` branch, never `main`.

**Files:**
- Create: `opencode-plugin/src/fleet/feature-flow.ts` (the `--feature` front-end glue — a leaf over `cmdSquadRun`(planner) + T3's `dagFromApprovedPayload`; does NOT reach into T4's `dag-scheduler.ts`)
- Modify: `opencode-plugin/src/bench/cli.ts` (replace T4 Task 8's `--feature` `die`-stub in the `fleet-dev` case with a call into `feature-flow.ts`; usage line unchanged)
- Test: `opencode-plugin/test/fleet-selfhost-e2e.test.ts` (new — the composition test)

**Interfaces:**
- Consumes (all shipped/sibling): `cmdSquadRun` (`./squad-cli.ts`, with `squadType:"planner"`, `gatePolicy:"auto"`, `--resume`/`gateAnswer`); `dagFromApprovedPayload`/`formatDagBlock`/`TaskDag` (`./dag.ts`, T3); `PLANNER_SQUAD`/`writeSquadDefV1` (`./squad-def.ts`, T3); `runDag`/`RunDagOpts`/`NodeDeps`/`DagRunState` (`./dag-scheduler.ts`, T4); `mergeAndVerify` (T5, at the pinned interface — mocked here); `pushAndOpenPr` (T2, at the pinned interface — mocked here); `die`/`log` (`../bench/util.ts`); `scripted`/`OK`/`trace` (`test/fleet-helpers.ts`, `test/fleet-squad-run-model.test.ts`).
- Produces:
  ```ts
  export interface FeatureFlowDeps {
    /** planner drive seam — defaults to the real cmdSquadRun. */
    squadRun?: typeof cmdSquadRun
    /** node scheduler seam — defaults to the real runDag. */
    runDag?: typeof runDag
    /** T5 merge+verify seam (pinned N5b interface). */
    mergeAndVerify?: (run: DagRunState) => { integrationBranch: string; ok: boolean; conflicts?: string[]; verifyLog: string }
    /** T2 push+PR seam (pinned N2 interface). */
    pushAndOpenPr?: (a: { project: string; integrationBranch: string }) => { pushed: boolean; prUrl?: string }
    /** hermetic node-drive seam threaded into the default runDag. */
    nodeDeps?: NodeDeps
  }
  export type FeatureFlowResult =
    | { status: "awaiting-gate2"; runId: string; dagPayload: string }   // planner paused; human approves via --resume
    | { status: "verified"; runId: string; integrationBranch: string }  // gate green, no PR gate
    | { status: "pr-open"; runId: string; integrationBranch: string; prUrl: string }
    | { status: "escalated"; runId: string; reason: string }            // conflict / integration-gate FAIL / node not-done

  /** The `fleet-dev --feature` orchestration (spec end-to-end flow, lines 69-75).
   * Two-invocation, mirroring squad-run's gate resume:
   *  (1) initial `--feature`: drive the PLANNER squad (squadType:"planner",
   *      gatePolicy:"auto" → gate1 auto, gate2 pauses on the DAG); persist +
   *      return {status:"awaiting-gate2", dagPayload}. The human inspects and
   *      approves via the SHIPPED gate (`--resume --gate-answer approve`).
   *  (2) approve/continue: dagFromApprovedPayload(payload) → runDag → (all
   *      done?) mergeAndVerify → (ok && pr-gate?) pushAndOpenPr. A non-`done`
   *      node, a merge conflict, or an integration-gate FAIL → "escalated"
   *      (never a PR). NEVER merges main. */
  export function runFeatureFlow(
    opts: RunDagOpts & { feature: string; openPr?: boolean; approvedDagPayload?: string },
    deps?: FeatureFlowDeps,
  ): Promise<FeatureFlowResult>
  ```

- [ ] **Step 1: Write the failing composition test** — `test/fleet-selfhost-e2e.test.ts` (real git repo in a `mkdtempSync` tmpdir via the `initRepo()` idiom from `fleet-squad-worktree.test.ts`; `META_HARNESS_HOME` per-test; `writeSquadDefV1(PLANNER_SQUAD)` + `cmdRolesImport` fixtures). One `describe("fleet-dev --feature composition (N1/N1b/N4/N5)")` with:
  - **planner emit → gate2 → approve (T3 seam closed):** inject a `squadRun` (via `scripted({ designer: [formatDagBlock(DAG)] })` for the planner) so the first `runFeatureFlow({ feature, ... })` returns `status:"awaiting-gate2"` with a `dagPayload` that `parseDagFromPayload` accepts and deep-equals `DAG`. `DAG` = 3 nodes: `a`,`b` independent (disjoint `files`), `c` deps `["a","b"]` — the spec's canonical shape.
  - **schedule 2 concurrent (N4/N5):** the continue-invocation (`approvedDagPayload` set) threads a `nodeDeps.squadRun` that (i) WRITES A REAL FILE into `args.worktreeDir` (a role-edit proxy — T4 heads-up #1) and (ii) records a **concurrency counter** (inc on entry / dec on exit / track peak) and returns `{status:"done", payload:"VERDICT: PASS"}`. Assert peak concurrency `== 2` (a,b overlapped under cap 2); `c`'s node began only after both `a` and `b` were `done` (dependent unblock-on-PASS).
  - **N1 (origin unchanged throughout):** snapshot `git -C repo status --porcelain` before; after the whole flow assert it is byte-identical; assert `repo/.opencode/agents/` listing unchanged (personas rendered into worktrees only, T6).
  - **N1b (ledger survives release):** the node session ledger is under `listPending(repo).filter(id => id.startsWith("ses_"))` (runtimeRoot), `listPending(<any worktreeDir>)` is `[]`; and after the (mocked) post-merge worktree release the DAG-state file `<repo>/.meta-harness/runtime/fleet/dag/<runId>.json` + the archived sessions still resolve (survive `removeWorktree`).
  - **merge+PR seam (N2 branch-name):** inject `mergeAndVerify` returning `{integrationBranch:"fleet/<runId>/integration", ok:true, verifyLog:"ok"}` and a `pushAndOpenPr` spy; assert the spy is called with `integrationBranch` starting `fleet/` and NEVER equal/`main`; with `openPr:false` the result is `status:"verified"` and `pushAndOpenPr` is NOT called (the no-PR-gate path).
  - **escalation short-circuits the PR (no main path):** inject `mergeAndVerify` returning `{ok:false, conflicts:["src/x.ts"], ...}` → result `status:"escalated"`, `pushAndOpenPr` NEVER called.
- [ ] **Step 2: Run test to verify it fails** — `bun test test/fleet-selfhost-e2e.test.ts` → FAIL (`Cannot find module '../src/fleet/feature-flow.ts'`).
- [ ] **Step 3: Write minimal implementation.**
  - `feature-flow.ts`: `runFeatureFlow` per the doc-comment. Initial call: `cmdSquadRun({ project, sliceId: runId, slice: feature, squadType:"planner", gatePolicy:"auto" }, deps?.squadRun's DriveFn)`; if `status:"gate"` (gate2) → `{status:"awaiting-gate2", runId, dagPayload: outcome.payload}`. Continue call (`approvedDagPayload` present): `const dag = dagFromApprovedPayload(approvedDagPayload)`; `const run = await (deps?.runDag ?? runDag)(dag, opts, deps?.nodeDeps)`; if any node not `done` → `{status:"escalated", reason:"node(s) not done"}`; else `const mv = (deps?.mergeAndVerify ?? mergeAndVerify)(run)`; if `!mv.ok` → `{status:"escalated", reason: mv.conflicts ? "merge conflict" : "integration gate fail"}`; else if `opts.openPr` → `const pr = (deps?.pushAndOpenPr ?? pushAndOpenPr)({ project: opts.project, integrationBranch: mv.integrationBranch })` → `{status:"pr-open", ..., prUrl: pr.prUrl!}`; else `{status:"verified", ..., integrationBranch: mv.integrationBranch}`.
  - `cli.ts`: in the `fleet-dev` case, when `--feature` is set, call `runFeatureFlow(...)` (openPr from a `--open-pr` flag, default false); print the returned status + (on `awaiting-gate2`) the DAG + the exact `--resume --gate-answer approve` command. **Defensive (concurrent-plan):** if `mergeAndVerify`/`pushAndOpenPr` are not yet exported by T5/T2 at execution time, import-guard and `die` "self-host tail pending T5/T2" so the composition test (which mocks them) still builds — do NOT stub their behavior.
- [ ] **Step 4: Run test to verify it passes** — `bun test test/fleet-selfhost-e2e.test.ts` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/feature-flow.ts opencode-plugin/src/bench/cli.ts opencode-plugin/test/fleet-selfhost-e2e.test.ts
  git commit -m "feat(fleet): T7 fleet-dev --feature end-to-end glue + composition test (N1/N1b/N4/N5)"
  ```

---

### Task 2 (HERMETIC): N5b — the integration gate catches an injected cross-node break

Prove the load-bearing N5b claim (spec line 28/58/106): two nodes touching **disjoint file-sets**, each **green in isolation**, can still break a **shared interface** — and the deterministic gate (`bun test` + smoke) re-run on the *merged* integration branch catches it, so it is **escalated, never PR'd**. Disjoint files stop only *textual* conflicts; this is the semantic-break backstop.

**Files:**
- Test: `opencode-plugin/test/fleet-selfhost-e2e.test.ts` (append a `describe("N5b integration gate catches a cross-node break")`)

**Interfaces:**
- Consumes: `runFeatureFlow`/`FeatureFlowDeps` (Task 1); `mergeAndVerify` at the pinned T5 interface **with an injected `verifyFn`** (so the test controls the gate outcome deterministically without a real `bun test`); `runDag` real (T4) over a real tmpdir repo, or the `nodeDeps.squadRun` seam that writes the two disjoint real files.
- Produces: nothing — assertion-only.

- [ ] **Step 1: Write the failing/gating test** — append to `test/fleet-selfhost-e2e.test.ts`:
  - Build a 2-node DAG: `a` (`files:["src/api.ts"]`) and `b` (`files:["src/caller.ts"]`), both `deps:[]` — disjoint, concurrent. Thread a `nodeDeps.squadRun` that writes, into each node's `worktreeDir`, a file that is **self-consistent per node** (each node's own "tests" pass) but whose **merge** is inconsistent (e.g. `a` renames an exported symbol `api.ts` still-used by `b`'s `caller.ts`). Both nodes return `{status:"done", payload:"VERDICT: PASS"}` — green in isolation.
  - Inject `mergeAndVerify` with a `verifyFn` that runs a **cheap real check on the merged worktree** proving the break (e.g. `execFileSync` a `grep`/`node -e` that fails because the symbol is gone) → `mergeAndVerify` returns `{ok:false, verifyLog:<the failure>}`. (This exercises the SEAM shape T5 ships; the real `bun test`+smoke gate is the live smoke's job, Task 4.)
  - Assert: `runFeatureFlow(..., { openPr:true })` returns `status:"escalated"` with a reason naming the integration-gate failure; the `pushAndOpenPr` spy is **NEVER called** (a semantic cross-node break does NOT reach a PR); the per-node VERDICTs were both PASS (proving the escalation came from the *integration* gate, not a node verdict — spec line 28's exact distinction).
  - Companion assert: a **control** run where the two nodes are consistent (no break) → `verifyFn` ok → `status:"pr-open"`, spy called once (the gate is not a false-positive).
- [ ] **Step 2: Run test to verify it fails** — FAIL until Task 1's `feature-flow.ts` exists (and the escalation branch is exercised).
- [ ] **Step 3: Implementation** — none beyond Task 1 (the escalation path already exists); if the control run PRs but the break run also PRs, the bug is in `runFeatureFlow`'s `!mv.ok` short-circuit, fix there.
- [ ] **Step 4: Run test** — `bun test test/fleet-selfhost-e2e.test.ts` → PASS (Task 1 + Task 2 cases).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/test/fleet-selfhost-e2e.test.ts
  git commit -m "test(fleet): T7 N5b — integration gate catches an injected cross-node break, no PR"
  ```

---

### Task 3 (HERMETIC): N2 boundary — only the scoped cred is reachable; the push is `fleet/*`, never `main`

Prove the *local* half of the N2 invariant (spec line 47-50/104): the orchestrator's push targets an orchestrator-fixed `fleet/*` branch (never agent-chosen, never `main`), and a `bash:allow` role that runs the documented `git -c credential.helper` env-scrub bypass reaches **only** the `fleet/*`-scoped non-admin credential — a credential that structurally cannot push `main`, cannot `gh pr merge --admin`, cannot `gh api` the protection off. The **server-side** half (admin-enforced branch protection actually rejecting a direct-to-`main` push) is inherently a live GitHub check — it is the operator/live gate (Task 4 + DEFERRED), not hermetically assertable.

**Files:**
- Test: `opencode-plugin/test/fleet-selfhost-e2e.test.ts` (append a `describe("N2 push boundary (local half)")`)

**Interfaces:**
- Consumes: `pushAndOpenPr` at the pinned T2 interface with an injected `pushFn`/`prFn` spy; `sandboxEnv`/`REMOTE_WRITE_DENY_ENV` from `../src/fleet/sandbox.ts` (the shipped env-scrub, spec line 39/50); the run's `runId` from Task 1's flow.
- Produces: nothing — assertion-only.

- [ ] **Step 1: Write the failing/gating test** — append to `test/fleet-selfhost-e2e.test.ts`:
  - **branch name is orchestrator-fixed `fleet/*`, never main:** call `pushAndOpenPr({ project, integrationBranch: "fleet/<runId>/integration" }, { pushFn: spy, prFn: () => "https://…/pull/1" })`; assert the `pushFn` spy's branch arg starts `fleet/` and is not `main`/`HEAD`. Then assert a **guard**: `pushAndOpenPr({ ..., integrationBranch: "main" }, ...)` throws (`die`) — the orchestrator refuses any non-`fleet/*` target (belt for "agent-chosen branch").
  - **env-scrub strips admin creds on a default role invocation (third layer):** build a `sandboxEnv` for a `bash:allow` role and assert every name in `REMOTE_WRITE_DENY_ENV` (+ `GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`) is absent — the shipped scrub still fires (spec line 39/104 "third layer, not the guarantee").
  - **only the scoped cred is reachable (documented, asserted at the seam):** assert that the environment the orchestrator uses to push carries the `fleet/*`-scoped token identity (a `MH_FLEET_PUSH_TOKEN`-style name, per T2), NOT the owner's admin identity — i.e. the composition never plumbs an admin credential into a role or the push seam. (This asserts the WIRING; the cryptographic scope of the PAT is a GitHub-side fact verified once by the operator, Task 4.)
- [ ] **Step 2: Run test to verify it fails** — FAIL until the T2 `pushAndOpenPr` guard + scoped-cred wiring exist (or, if T2 is unlanded, the test runs against the mock and documents the required guard — mark it `test.todo` keyed to T2 landing, do NOT fake the guarantee).
- [ ] **Step 3: Implementation** — none in T7 (the guard + scoped-cred are T2's code). If T2 is present, this task is pure assertion; if T2 is unlanded, leave the branch-name + env-scrub assertions live (they hit shipped `sandbox.ts` and the mock) and the scoped-cred assertion as `test.todo("T2 pushAndOpenPr scoped-cred wiring")`.
- [ ] **Step 4: Run test** — `bun test test/fleet-selfhost-e2e.test.ts` → PASS (todo-skips counted, not failing).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/test/fleet-selfhost-e2e.test.ts
  git commit -m "test(fleet): T7 N2 local boundary — fleet/* push never main, env-scrub, scoped-cred wiring"
  ```

---

### Task 4 (THE SINGLE REAL LIVE RUN): `smoke/fleet/selfhost-e2e.sh` — the capstone smoke

The one real run (spec N3 verification, line 107). Targets the REAL repo `~/z2/meta-harness`, drives `fleet-dev --feature "<trivial>"` all the way to a verified integration branch and (under the PR gate) one open PR, and asserts the composed invariants on the live run — while the running instance stays safe throughout. Costed + double-gated + store-guarded. Extends the `smoke/fleet/squad-demo.sh` style verbatim.

**Files:**
- Create: `smoke/fleet/selfhost-e2e.sh`
- Modify: `smoke/README.md` (one row describing the new scenario + its two gates and cost)

**Interfaces (CLI + env the script consumes):**
- `bun term-bench2/runner.ts fleet-dev --project <PROJECT> --feature "<text>" [--max-concurrency 2] [--node-gate-policy auto] [--open-pr]` (the Task-1 surface via `cli.ts`).
- `bun term-bench2/runner.ts squad-run --project <PROJECT> --slice-id <runId> --resume --gate-answer approve` (the SHIPPED gate2 approve, for the planner DAG).
- `bun term-bench2/runner.ts squad-def-init | roles-import | roles-render` (setup, exactly as `squad-demo.sh`).
- `assertSelfHostReady(project)` (T6) — invoked once via a tiny `runner.ts self-host-check` subcommand if T6 exposed one, else inline git/`.gitignore`/`opencode.json` checks.
- Env gates: `MH_SMOKE_LIVE` (tokens), `MH_SELFHOST_PR` (network + scoped cred), `MH_SELFHOST_MANUAL_GATE` (optional — leave gate2 for a real human instead of script auto-approve).

- [ ] **Step 1: Write `smoke/fleet/selfhost-e2e.sh`.** Skeleton (mirrors `squad-demo.sh:37-66` for the guard + env + `set -euo pipefail`):
  ```bash
  #!/usr/bin/env bash
  # smoke/fleet/selfhost-e2e.sh — the T7 self-host end-to-end smoke (spec N3,
  # line 107). Drives fleet-dev --feature against the REAL ~/z2/meta-harness:
  # planner DAG (T3) -> gate2 approve -> parallel node worktrees (T4/T6) ->
  # merge + integration-verify (T5) -> [gated] PR (T2) -> STOPS at human merge.
  # Asserts on the live run: origin porcelain UNCHANGED (N1), throwaway ledger
  # survives worktree release (N1b), 2 node worktrees seen concurrently
  # (N4/N5), integration branch verified. NEVER pushes/merges main.
  #
  # COST + GATES (nothing costed runs by default):
  #   MH_SMOKE_LIVE=1   -> real opencode drives (planner + N node-squads x ~5
  #                        drives + integration `bun test`+smoke): tokens, min.
  #   MH_SELFHOST_PR=1  -> real `git push` + `gh pr create` (needs the T2
  #                        fleet/*-scoped credential provisioned): network.
  #   MH_SELFHOST_MANUAL_GATE=1 -> stop at gate2 for a real human `--resume
  #                        --gate-answer approve` (default: script auto-approves
  #                        after printing the emitted DAG for inspection).
  set -euo pipefail

  # --- STORE GUARD (verbatim mirror of squad-demo.sh) ---------------------
  LEGACY_STORE="$HOME/.config/opencode/.meta-harness"
  if [ -d "$LEGACY_STORE" ] && [ ! -L "$LEGACY_STORE" ]; then
    echo "SKIP: pre-migration store present — run any runner.ts command once WITHOUT META_HARNESS_HOME first (migrateAccountRoot)"
    exit 0
  fi
  # dedicated throwaway home — NEVER the real ~/.config/meta-harness
  export META_HARNESS_HOME="$HOME/.mh-selfhost-smoke"

  [ "${MH_SMOKE_LIVE:-0}" = 1 ] || { echo "SKIP: set MH_SMOKE_LIVE=1 (costed: real opencode drives)"; exit 0; }
  command -v opencode >/dev/null 2>&1 || { echo "SKIP: opencode not on PATH"; exit 0; }

  REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"   # = ~/z2/meta-harness (the real self-host target)
  RUNNER=(bun "$REPO_ROOT/term-bench2/runner.ts")
  PROJECT="$REPO_ROOT"
  RUN_ID="selfhost-smoke-$(date +%s)"

  # --- N1 pre-snapshot (running-instance-safe = unchanged, not empty) ------
  PORCELAIN_BEFORE="$(git -C "$PROJECT" status --porcelain)"
  AGENTS_BEFORE="$(ls "$PROJECT/.opencode/agents" 2>/dev/null | sort)"

  # --- cleanup: leave the real repo pristine unless a PR is open ----------
  PR_OPENED=0
  cleanup() {
    git -C "$PROJECT" worktree prune 2>/dev/null || true
    for b in $(git -C "$PROJECT" branch --list "fleet/$RUN_ID/*" | tr -d ' *'); do
      git -C "$PROJECT" branch -D "$b" 2>/dev/null || true
    done
    if [ "$PR_OPENED" = 0 ]; then
      git -C "$PROJECT" branch -D "fleet/$RUN_ID/integration" 2>/dev/null || true
    fi   # PR open -> keep the integration branch for the human merge (N2 keepBranch)
  }
  trap cleanup EXIT

  # --- readiness (T6 assertSelfHostReady) ---------------------------------
  echo "== self-host readiness check =="
  "${RUNNER[@]}" self-host-check --project "$PROJECT"   # or inline git/.gitignore/opencode.json checks

  # --- setup (squad-def + personas; preserves an already-evolved store) ---
  "${RUNNER[@]}" squad-def-init || echo "(squad def already active)"
  # ... roles-import(fixtures)/roles-render guarded exactly as squad-demo.sh ...

  # --- (1) feature -> planner DAG -> gate2 --------------------------------
  echo "== fleet-dev --feature (planner emits the task DAG) =="
  FEATURE='add two independent pure helpers slugify() and titlecase() in two
           separate new util files, each with its own test'
  OUT="$("${RUNNER[@]}" fleet-dev --project "$PROJECT" --feature "$FEATURE" \
          --max-concurrency 2 --node-gate-policy auto)"
  echo "$OUT"                                  # prints the emitted DAG + the resume command
  if [ "${MH_SELFHOST_MANUAL_GATE:-0}" = 1 ]; then
    echo "== PAUSED at gate2 — inspect the DAG above, then approve:"
    echo "   ${RUNNER[*]} squad-run --project $PROJECT --slice-id $RUN_ID --resume --gate-answer approve"
    exit 0
  fi
  echo "== gate2 auto-approve (DAG printed above for inspection) =="
  "${RUNNER[@]}" squad-run --project "$PROJECT" --slice-id "$RUN_ID" --resume --gate-answer approve

  # --- (2) schedule -> merge -> integration-verify -> [gated] PR ----------
  #   observe concurrency (N4/N5): sample `git -C $PROJECT worktree list` while
  #   the scheduler runs (a background poller records max simultaneous
  #   fleet/$RUN_ID/* worktrees; assert >= 2 for the 2 independent nodes).
  OPEN_PR_FLAG=""; [ "${MH_SELFHOST_PR:-0}" = 1 ] && OPEN_PR_FLAG="--open-pr"
  RES="$("${RUNNER[@]}" fleet-dev --project "$PROJECT" --run-id "$RUN_ID" --resume $OPEN_PR_FLAG)"
  echo "$RES"
  echo "$RES" | grep -q "pr-open" && PR_OPENED=1

  # --- ASSERTIONS ---------------------------------------------------------
  # N1: origin working tree + tracked personas UNCHANGED by the whole run
  [ "$(git -C "$PROJECT" status --porcelain)" = "$PORCELAIN_BEFORE" ] || { echo "FAIL N1: origin tree changed"; exit 1; }
  [ "$(ls "$PROJECT/.opencode/agents" 2>/dev/null | sort)" = "$AGENTS_BEFORE" ] || { echo "FAIL N1: origin personas changed"; exit 1; }
  # N1b: throwaway ledger (DAG-state + node sessions) present under META_HARNESS_HOME/runtimeRoot, survives release
  [ -f "$PROJECT/.meta-harness/runtime/fleet/dag/$RUN_ID.json" ] || { echo "FAIL N1b: DAG-state missing"; exit 1; }
  # N4/N5: the concurrency poller saw >= 2 simultaneous node worktrees
  [ "${MAX_WORKTREES:-0}" -ge 2 ] || { echo "FAIL N4/N5: nodes did not run concurrently"; exit 1; }
  # verified integration branch exists (green gate); NEVER main
  git -C "$PROJECT" rev-parse -q --verify "fleet/$RUN_ID/integration" >/dev/null || { echo "FAIL N5b: no verified integration branch"; exit 1; }
  echo "== SELF-HOST E2E: integration verified. main untouched. Human merges the PR (if opened). =="
  ```
  (The exact concurrency poller, the `roles-import`/`roles-render` block, and the DAG-state path are copied from `squad-demo.sh` + the T4 DAG-state layout; keep them faithful. The `self-host-check` subcommand is optional — inline the three T6 checks if T6 did not add a CLI case.)
- [ ] **Step 2: Dry-run the guards WITHOUT the cost gate** — `bash smoke/fleet/selfhost-e2e.sh` (no `MH_SMOKE_LIVE`) → must exit 0 with `SKIP: set MH_SMOKE_LIVE=1`. Then, on a machine with a pre-migration legacy store, confirm it SKIPs with the migration message (or reason about the branch by inspection if not reproducible). **These skip-path checks are the only part runnable without tokens.**
- [ ] **Step 3: The costed live run (operator, gated).** With `MH_SMOKE_LIVE=1` and a credentialed `opencode`, run the script; confirm it reaches "integration verified. main untouched." and all four assertions pass. Separately, with `MH_SELFHOST_PR=1` + the T2 scoped credential, confirm exactly one PR opens against a `fleet/*` branch, `main` is NOT merged, and — the SERVER-SIDE N2 half — a manual `git push origin HEAD:main` with the scoped cred is **rejected** by branch protection (the one live check Task 3 could not make hermetically). Record the run output in the commit body or an adjacent `.log` (not committed).
- [ ] **Step 4: Update `smoke/README.md`** — add a row under a new "Tier C — self-host live" note: `selfhost-e2e` | drives `fleet-dev --feature` on the real repo end-to-end; asserts N1/N1b/N4/N5 + verified integration branch; **double-gated** (`MH_SMOKE_LIVE` tokens, `MH_SELFHOST_PR` network+cred); STOPS at human merge.
- [ ] **Step 5: Commit**
  ```bash
  git add smoke/fleet/selfhost-e2e.sh smoke/README.md
  git commit -m "test(fleet): T7 self-host e2e smoke — real fleet-dev --feature, N1/N1b/N4/N5, stops at human merge (N3)"
  ```

---

## Notes / scope boundaries (carried from the spec)

- **T7 proves composition, not constituents.** T1/T3/T4/T5/T6/T2 each unit-test their own module (mirrored/mocked neighbors). T7's hermetic tasks (1-3) wire the REAL modules together across their seams — the one thing no sub-plan can test — and the live task (4) is the single real run. The only new *code* is `feature-flow.ts` (the `--feature` front-end glue T4 stubbed) + the smoke script; everything else is assertions.
- **The live smoke is the home of the T1-review carry-forward §N1 gate.** T1's isolation is only PROXIED (mocked `execFn`); T4 defers the "all four roles share ONE worktree — an Implementer's *failing* test yields a VERDICT FAIL from the SAME worktree the Evaluator reads" assertion to a live/smoke gate (T4 plan line 375). T7's live run against the real repo is that gate: the default trivial feature exercises the happy path (VERDICT PASS from worktree edits); the deliberate-failing-node variant (spec line 103) is an OPTIONAL second live scenario (below), not the default smoke.
- **gate2 auto-approve is faithful for a smoke; the `main` merge is NEVER automated.** The operator who runs the script IS the human-as-master; the script prints the emitted DAG before auto-approving gate2 (or leaves it manual under `MH_SELFHOST_MANUAL_GATE`). The load-bearing "human merges" invariant lives at the FINAL step — the smoke stops at the open PR; the `main` merge is a human click in GitHub, never scripted.
- **Cost, stated honestly.** Task 4 with `MH_SMOKE_LIVE=1`: planner squad (~5 drives) + 3 node-squads (~5 drives each) + one integration `bun test`+smoke ≈ 15-20 real model calls (Haiku/Sonnet per `FLEET_ROLES`) + a local test run, several minutes. With `MH_SELFHOST_PR=1`: one real branch push + `gh pr create` (network; leaves an open PR the human must merge or close). Tasks 1-3: zero tokens, zero network, seconds.
- **The real repo is left pristine.** The smoke creates real local `fleet/<runId>/*` node branches + worktrees off the real `.git`; the cleanup trap prunes worktrees and deletes every `fleet/<runId>/*` branch on exit — and the integration branch too UNLESS a PR is open (then it is kept for the human merge, N2 `keepBranch:true`). The working tree is never a `--dir`, so N1's snapshot-compare stays green regardless.

## Explicitly DEFERRED / out of scope

- **The optional "all-roles-share-one-worktree via a deliberately-failing node" live scenario** (spec line 103: an Implementer writes a failing test → VERDICT FAIL from the same worktree) — a SECOND live scenario behind its own flag, not the default happy-path smoke. Add it to `selfhost-e2e.sh` as `MH_SELFHOST_FAILNODE=1` if a run shows the happy path alone under-proves shared-worktree; otherwise it stays a documented manual check.
- **Crash-consistency (D9) live verification** (spec line 108: SIGKILL the scheduler mid-merge → relaunch aborts the partial merge, treats committed nodes as done by SHA, re-drives the crash node) — exercised by T4's `reconcileDagRun` hermetic tests + the `--run-id --resume` path; a live SIGKILL-mid-merge smoke is a separate hardening check, not T7's e2e happy path.
- **Server-side branch-protection enforcement** (admin-enforced "Do not allow bypassing" actually rejecting a direct-to-`main` push / `gh pr merge --admin` / `gh api` protection-off) — a GitHub-side fact provisioned + verified once by T2's operator setup (Task 4 Step 3 does the one live confirmation); it is not hermetically assertable and is NOT re-verified on every smoke run.
- **Multi-project namespace + fair-share (D8.3)** — the smoke targets ONE repo (`~/z2/meta-harness`); per-project isolation + a global resource cap is additive, out of scope for self-hosting v1 (spec line 67).
- **Master automation (fleet spec §9.4/§9.5, D8/D9)** — the human-as-master runs `fleet-dev` + approves gate2 + merges the PR today; the singleton master owning that composite scheduling is a separate build (`oc-test`). T7 changes nothing about the master.
- **A synthesized whole-feature Evaluator gate on the merged branch** (vs. the v1 deterministic `bun test`+smoke gate) — spec architecture step 3 marks it deferred; T7's N5b assertion (Task 2) and the live smoke both use the deterministic gate.

## Open questions for the human (esp. live-run prerequisites)

1. **The T2 scoped-credential provisioning is the hard prerequisite for the PR gate.** Task 4's `MH_SELFHOST_PR=1` path needs a **fine-grained PAT / deploy key that can push only `fleet/*`, cannot touch `main`, cannot administer the repo** (spec N2 (i)) already provisioned in the environment, AND admin-enforced branch protection on `main` already enabled (N2 (ii)). Both are T2's deliverables. **Confirm they exist before the first live PR run** — otherwise run with only `MH_SMOKE_LIVE=1` (full local flow, no push) until T2 lands. Which env var name does T2 use for the scoped token (the smoke must read it)?
2. **Target the real repo directly, or a throwaway clone, for the first live run?** The plan follows spec N3 (target `~/z2/meta-harness` itself; safety comes from worktree isolation + throwaway home + scoped cred, not cloning). If the first live run should instead go against a throwaway clone/fork until the boundary is trusted (bootstrap ordering, spec line 79/100), say so — the script's `PROJECT` is the only change.
3. **gate2: script auto-approve vs. always-manual for the live smoke?** The plan auto-approves gate2 (printing the DAG first) so the smoke runs unattended, with `MH_SELFHOST_MANUAL_GATE=1` to force a real human approve. Confirm auto-approve-after-print is an acceptable stand-in for the human-directed gate in a smoke, or require manual always.
4. **Does T4/T6 expose a `self-host-check` CLI subcommand for `assertSelfHostReady`, or should the smoke inline the three checks?** (T6 Open Question 2 left the `assertSelfHostReady` call site to T4/the operator.) No code depends on the answer — only whether Task 4 Step 1 calls a subcommand or inlines git/`.gitignore`/`opencode.json` checks.
5. **Trivial feature choice.** The plan uses "two independent pure helpers in two new files + tests" (naturally a 2-independent-node DAG so N4/N5 concurrency fires, + an optional dependent re-export node). Confirm this is trivial-but-real enough, or name a preferred throwaway feature.
