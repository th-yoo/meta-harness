# T6 — Self-Host Target + Seed Doc (N3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the fleet to safely target its OWN repo (`~/z2/meta-harness`) as a self-hosting subject. T6 adds a named **runtime-render seam** that renders the squad's four role personas into a run's throwaway git worktree (T1) *before* the squad drives, a **self-host-target readiness precondition**, and the **two-layer / seed-model doc** — all without ever mutating the running instance's live tree. This is spec piece **N3** (self-hosting target + seed distribution) from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`.

**Architecture:** A new `fleet/self-host.ts` adds two exports plus one doc:
- `renderRunPersonas(worktreeDir, { runtimeRoot?, roles?, pins?, force? })` — the per-node runtime-render seam. A thin wrapper over the **shipped** `cmdRolesRender` (`render.ts:133`) that populates `<worktreeDir>/.opencode/agents/` at node start so a fresh throwaway worktree has its `mh-{analyzer,designer,implementer,evaluator}.md` personas before `cmdSquadRun` (`squad-cli.ts:96`) drives them via `--dir worktreeDir`. It carries the **running-instance-safe** guard: an opt-in `runtimeRoot` (the origin repo) that makes it `die` rather than render into the live tree.
- `assertSelfHostReady(project)` — the N3 "mechanically ready" precondition: the target repo is a git tree with a committed HEAD (a worktree needs a committed base — N1 subtlety b), its `.gitignore` excludes `.meta-harness/` + `node_modules/` (the ledger and deps never dirty the tree / are never carried into the worktree), and `opencode.json` (plugin + permission wiring, N3) exists at the root.
- The two-layer / seed-model doc (`docs/self-hosting-seed-model.md`) explaining the seed→runtime bootstrap.

**How this slots into the T4 node lifecycle (the seam):** T4's `runNode` (`docs/superpowers/plans/2026-07-16-t4-fleet-dev-scheduler.md`, Task 3) does per node: `createWorktree` → `prepareWorktreeDeps` → **render personas into the worktree** → `cmdSquadRun({ project: runtimeRoot, worktreeDir })`. T4's draft shows that render step as an inline `cmdRolesRender({ project: wt.dir })`. **T6 owns that step:** `runNode` calls `renderRunPersonas(wt.dir, { runtimeRoot: run.project })` at exactly that point — BEFORE the drive, so every role's `--dir wt.dir` finds its persona. T4 and T6 are the same build wave (Wave 1); whichever lands second wires the call (Task 3 handles both orderings). deps: **T1 (shipped 2026-07-16, commits `144f31b`..`f536b6e`).**

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:child_process` (`execFileSync`), `node:fs`, git worktrees. Hermetic tests mirror `test/fleet-squad-worktree.test.ts` (real git repo in a `mkdtempSync` tmpdir, `META_HARNESS_HOME` set per-test, `writeSquadDefV1(STANDARD_SQUAD)` + `cmdRolesImport` fixtures, no real `opencode` spawn).

## Global Constraints

- **Runtime-render, NEVER pre-baked (N3).** The fleet A/D/I/E personas (`mh-analyzer`/`mh-designer`/`mh-implementer`/`mh-evaluator`) do NOT pre-exist in the target — `~/z2/meta-harness/.opencode/agents/` ships only `mh-build.md` (verified). They are written *per run* by `roles-render`. T6 keeps that contract: `renderRunPersonas` produces the personas at node start into the run's worktree; nothing is committed to the origin's `.opencode/agents/`.
- **Reuse `cmdRolesRender` — do NOT reinvent rendering.** `renderRunPersonas` is a guard + a single `cmdRolesRender({ project: worktreeDir, ... })` call. It adds WHEN/WHERE (per node, into the worktree) and the safety guard — not a new render path. Layer composition, stamping, idempotence, and wire-lint stay entirely inside the shipped `render.ts`.
- **Render targets the WORKTREE (code dir); the ledger stays in `runtimeRoot` (N1b).** `renderRunPersonas` writes ONLY under `<worktreeDir>/.opencode/agents/` (`render.ts:115`). It touches no checkpoint/pending/scored sink — those remain anchored to `runtimeRoot` (the origin), exactly as T1 established. A test asserts `listPending(worktreeDir)` is unaffected and the ledger is untouched by a render.
- **Running-instance-safe when the target IS the fleet's own repo.** `.opencode/agents/` is a *tracked* dir and the `mh-*.md` role personas are NOT gitignored (only `mh-build.md` is committed; `.meta-harness/` + `node_modules/` are gitignored). A render into the live origin would therefore create untracked `mh-analyzer.md`… → `git status` dirty → the running instance is no longer safe. T1's `createWorktree` already isolates structurally (the worktree is a throwaway `mkdtemp` dir, never the origin). `renderRunPersonas` adds a belt-and-suspenders guard: when the caller passes `runtimeRoot` and it resolves equal to `worktreeDir`, it `die`s (a caller-bug tripwire for "you forgot the worktree / passed the origin"). The e2e test (Task 3) asserts the origin's `.opencode/agents/` still contains ONLY `mh-build.md` and `git status --porcelain` on the origin is clean after a worktree render.
- **Store read/write coupling — DOCUMENT the shipped behavior, do NOT redesign render.** The shipped `renderRole` (`render.ts:85`) uses its `project` param for BOTH the store-read layer roots (`layerStoreRoots("global", agent, project)`, `record.ts:56`) AND the persona-write path (`join(project, ".opencode/agents")`, `render.ts:115`). Consequence when `project = worktreeDir`:
  - **Account-scoped layers are UNAFFECTED.** `accountGlobalRoot()` / `accountRoleRoot(agent)` (`harness-store.ts:76,80`) resolve via `META_HARNESS_HOME` (`accountMetaRoot()`, `:60`), independent of the passed dir. The user's host-global evolved Layer-2 content (the load-bearing fleet-role content) renders identically whether `project` is the origin or the worktree.
  - **Project-scoped layers read from the (empty) worktree.** `projectGlobalRoot(dir)` / `projectRoleRoot(dir, agent)` (`harness-store.ts:84,88`) follow the passed dir; the worktree's `.meta-harness/` is gitignored (never carried by `git worktree add`) so it is empty. For the fleet A/D/I/E roles this is faithful: the origin has NO project-role stores for them (only `.meta-harness/roles/mh-build` + `mh-judge` exist), and the origin's populated `project-global` store (`.meta-harness/global/`, v0–v6) is the TB2/benchmark playbook, not fleet-role content. So a worktree render reproduces the account-scoped fleet-role personas and drops only project layers that are empty-for-fleet-roles.
  - This matches the already-reviewed T4 plan's `cmdRolesRender({ project: wt.dir })`. If a future need to preserve project-scoped Layer-2 in the worktree render arises, that is a **render.ts store-root/write-dir split** (read store from `runtimeRoot`, write file into `worktreeDir`) — out of T6's wiring scope and raised as an open question below.
- **Back-compat is additive.** T6 ADDS `fleet/self-host.ts` + the doc; it changes NO shipped signature (`renderRole`, `cmdRolesRender`, `createWorktree`, `cmdSquadRun` untouched). A no-worktree caller can still call `cmdRolesRender({ project })` directly; `renderRunPersonas`'s guard is inert unless `runtimeRoot` is passed.
- **Hermetic tests only.** Real git repo / tmpdir, `META_HARNESS_HOME` per-test, `writeSquadDefV1` + `cmdRolesImport` fixtures (render needs the account store seeded and a squad-def for the wire-lint). `git` only via `execFileSync("git", [...])` — never a shell string. Tests run with `bun test test/<file>.test.ts` from `opencode-plugin/`.

---

### Task 1: `fleet/self-host.ts` — `renderRunPersonas`, the runtime-render-into-worktree seam (N3)

**Files:**
- Create: `opencode-plugin/src/fleet/self-host.ts`
- Test: `opencode-plugin/test/fleet-self-host.test.ts`

**Interfaces:**
- Consumes:
  - `cmdRolesRender(args: { project: string; roles?: string[]; pins?: string[]; force?: boolean }): void` from `./render.ts` (writes `<project>/.opencode/agents/mh-<role>.md`, `render.ts:115-117,133`).
  - `die` from `../bench/util.ts` (`(msg: string) => never`).
  - `resolve`, `join` from `node:path`.
- Produces:
  ```ts
  /** Render the run's four role personas INTO a squad-run's throwaway worktree
   * (spec N3), so a fresh `git worktree add` checkout gets its
   * `.opencode/agents/mh-*.md` before `cmdSquadRun` drives with `--dir
   * worktreeDir`. A thin, named seam over the shipped `cmdRolesRender` — the
   * only change vs. a raw call is WHEN/WHERE (per node, into the worktree) plus
   * the running-instance-safe guard. Returns the persona dir it populated.
   *
   * `runtimeRoot` (the origin repo) is optional: when passed it activates the
   * guard — rendering INTO the live origin would create untracked mh-*.md
   * (only mh-build.md is tracked) and dirty the running instance, so an origin
   * target dies loudly. */
  export function renderRunPersonas(
    worktreeDir: string,
    opts?: { runtimeRoot?: string; roles?: string[]; pins?: string[]; force?: boolean },
  ): string   // absolute path of <worktreeDir>/.opencode/agents
  ```

- [ ] **Step 1: Write the failing test** — `opencode-plugin/test/fleet-self-host.test.ts` (idiom from `fleet-squad-worktree.test.ts`: `META_HARNESS_HOME` per-test, `writeSquadDefV1(STANDARD_SQUAD)`, `cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })`):
  - **renders all four personas into the worktree:** `renderRunPersonas(wt)` → assert `existsSync(join(wt, ".opencode/agents", "mh-analyzer.md"))` (and designer/implementer/evaluator); assert the return value equals `join(wt, ".opencode", "agents")`.
  - **account-scoped content lands (store read is host-global):** read `mh-analyzer.md`; assert it contains a marker seeded into the account store by the imported fixture (proves account layers rendered regardless of which project dir was passed).
  - **runtime-render, not pre-baked:** before the call the worktree has no `.opencode/agents/`; after, it does — nothing pre-existed.
  - **guard — refuses to render into the origin:** `expect(() => renderRunPersonas(origin, { runtimeRoot: origin })).toThrow()` (a `BenchError` via `die`); assert the message mentions the live tree / worktree.
  - **guard is inert without `runtimeRoot`:** `renderRunPersonas(wt)` and `renderRunPersonas(wt, { runtimeRoot: someOtherDir })` both succeed.
  - **idempotent re-render is byte-stable:** call twice into the same worktree; the `mh-analyzer.md` bytes are unchanged on the second call (relies on `render.ts` idempotence — only `renderedAt` would differ, and that is short-circuited).
- [ ] **Step 2: Run test to verify it fails** — `bun test test/fleet-self-host.test.ts` → FAIL (`Cannot find module '../src/fleet/self-host.ts'`).
- [ ] **Step 3: Write minimal implementation** — `self-host.ts`:
  ```ts
  export function renderRunPersonas(worktreeDir, opts = {}) {
    if (opts.runtimeRoot && resolve(opts.runtimeRoot) === resolve(worktreeDir)) {
      die("renderRunPersonas: refusing to render personas into the live tree " +
          `(${worktreeDir}); pass the throwaway worktree dir, not runtimeRoot ` +
          "(self-host running-instance-safe, spec N3/N1)")
    }
    cmdRolesRender({ project: worktreeDir, roles: opts.roles, pins: opts.pins, force: opts.force })
    return join(worktreeDir, ".opencode", "agents")
  }
  ```
- [ ] **Step 4: Run test to verify it passes** — `bun test test/fleet-self-host.test.ts` → PASS.
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/self-host.ts opencode-plugin/test/fleet-self-host.test.ts
  git commit -m "feat(fleet): T6 renderRunPersonas — runtime-render personas into the run worktree (N3)"
  ```

---

### Task 2: `assertSelfHostReady` — the N3 "mechanically ready" self-host-target precondition

**Files:**
- Modify: `opencode-plugin/src/fleet/self-host.ts` (add `assertSelfHostReady`)
- Test: `opencode-plugin/test/fleet-self-host.test.ts` (append a `describe("assertSelfHostReady", ...)`)

**Interfaces:**
- Consumes: `execFileSync` from `node:child_process`; `existsSync`, `readFileSync` from `node:fs`; `join` from `node:path`; `die` from `../bench/util.ts`.
- Produces:
  ```ts
  /** Verify a repo is safe to self-host-against (spec N3 "mechanically ready").
   * A worktree squad-run against a target that is NOT ready fails in confusing
   * ways; this dies EARLY with an actionable reason. Checks:
   *   1. it is a git work tree with a COMMITTED HEAD (worktree base, N1 sub-b);
   *   2. .gitignore excludes `.meta-harness/` AND `node_modules/` (ledger + deps
   *      never dirty the tree / are never carried into the worktree — N1/N1b);
   *   3. opencode.json exists at the root (plugin + permission wiring, N3).
   * Returns silently when ready. */
  export function assertSelfHostReady(project: string): void
  ```

- [ ] **Step 1: Write the failing test** — append to `test/fleet-self-host.test.ts`. Reuse an `initRepo()` helper (real git repo in tmpdir) that scaffolds a ready target: `git init` + a commit, a `.gitignore` with `.meta-harness/` + `node_modules/`, and an `opencode.json`:
  - **ready target passes:** `expect(() => assertSelfHostReady(repo)).not.toThrow()`.
  - **no committed HEAD dies:** a fresh `git init` with no commit → throws; message mentions HEAD/commit.
  - **missing `.gitignore` entry dies:** `.gitignore` without `.meta-harness/` (or without `node_modules/`) → throws; message names the missing entry.
  - **missing `opencode.json` dies:** remove it → throws; message names `opencode.json`.
- [ ] **Step 2: Run test to verify it fails** — FAIL (missing `assertSelfHostReady`).
- [ ] **Step 3: Write minimal implementation** — `assertSelfHostReady`:
  - `git -C project rev-parse -q --verify HEAD` inside a `try` → `die` "self-host target <project> has no committed HEAD (a worktree needs a committed base — N1)".
  - read `join(project, ".gitignore")` (die if absent); for each of `.meta-harness/`, `node_modules/` confirm a matching line (tolerate with/without trailing slash) else `die` naming it.
  - `existsSync(join(project, "opencode.json"))` else `die` "self-host target <project> missing opencode.json (plugin+permission wiring — N3)".
- [ ] **Step 4: Run test to verify it passes** — PASS (Task 1 + Task 2 cases).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/src/fleet/self-host.ts opencode-plugin/test/fleet-self-host.test.ts
  git commit -m "feat(fleet): T6 assertSelfHostReady — N3 mechanically-ready self-host-target precondition"
  ```

---

### Task 3: node-lifecycle integration — render into a REAL worktree BEFORE the drive; origin stays clean (the T4 seam)

**Files:**
- Modify: `opencode-plugin/test/fleet-self-host.test.ts` (append a second `describe` using the real `worktree.ts` + `cmdSquadRun`)
- Modify (integration wiring — do ONLY the branch that applies at execution time): `opencode-plugin/src/fleet/dag-scheduler.ts` (T4's `runNode`) — see Step 3.

**Interfaces:**
- Consumes: `createWorktree(repo, { branch, base? }): Worktree` / `removeWorktree(wt, opts?): void` from `./worktree.ts`; `renderRunPersonas` (Task 1); `cmdSquadRun(args, driveFn?, scoreFn?, execFn?): Promise<SquadOutcome>` from `./squad-cli.ts`; `listPending` from `./pending.ts`; `ExecFn` from `./run.ts`.
- Produces: no new export — this task proves the *seam order* (render → then drive) end-to-end hermetically and wires it into T4's `runNode`.

- [ ] **Step 1: Write the failing/gating test** — append `describe("renderRunPersonas in a real worktree (N3 self-host seam)", ...)` to `test/fleet-self-host.test.ts`. Merge new imports into the existing lines (no duplicate specifiers): `existsSync`/`writeFileSync` (`node:fs`), `execFileSync` (`node:child_process`), `createWorktree`/`removeWorktree` (`../src/fleet/worktree.ts`), `cmdSquadRun` (`../src/fleet/squad-cli.ts`), a `trace()` helper for the drive stdout (copy the `ses_`-prefixed step-finish shape from `fleet-squad-worktree.test.ts`). Use the `initRepo()` that mirrors meta-harness's `.gitignore` (`.meta-harness/` + `node_modules/`):
  - **render happens BEFORE the drive and the drive's `--dir` finds the persona:** `const wt = createWorktree(repo, { branch: "fleet/s1" })`; `renderRunPersonas(wt.dir, { runtimeRoot: repo })`; then drive `cmdSquadRun({ project: repo, worktreeDir: wt.dir, sliceId: "s1", slice: "x" }, undefined, undefined, execFn)` where `execFn` **asserts inside itself** that `existsSync(join(seenDirArg, ".opencode/agents/mh-analyzer.md"))` is true at drive time (the persona was rendered before the role drove) and returns a `## Clarify` trace. Assert the run reaches a terminal escalation without dying on a missing persona.
  - **origin stays clean (running-instance-safe, N3):** after the run, `git -C repo status --porcelain` is empty AND the origin's `.opencode/agents/` still contains ONLY `mh-build.md` (the personas landed in the worktree, not the origin). *(initRepo commits an `.opencode/agents/mh-build.md` so the "only mh-build.md" assertion is exact.)*
  - **ledger in runtimeRoot, not the worktree (N1b):** `listPending(repo).filter(id => id.startsWith("ses_")).length > 0`; `listPending(wt.dir)` is `[]`.
  - **survives cleanup:** `removeWorktree(wt)`; the origin's `.opencode/agents/` is still just `mh-build.md` and the origin ledger is intact.
- [ ] **Step 2: Run test to verify it passes** — `bun test test/fleet-self-host.test.ts` → PASS. (This gates the seam: render-before-drive, worktree-only personas, origin clean, ledger in runtimeRoot. It needs only shipped T1 + Task 1 — NOT T4.)
- [ ] **Step 3: Wire the seam into T4's `runNode` (whichever ordering applies).** T4 (`fleet/dag-scheduler.ts`) is the same build wave. Do exactly one:
  - **If T4 has NOT yet landed:** no code edit here — record in the T4 execution notes that `runNode`'s render step MUST be `renderRunPersonas(wt.dir, { runtimeRoot: run.project })`, placed AFTER `prepareWorktreeDeps` and BEFORE `cmdSquadRun`. (T4's Task 3 draft shows an inline `cmdRolesRender({ project: wt.dir })` at that spot; it becomes this call.)
  - **If T4 has already landed with the inline `cmdRolesRender({ project: wt.dir })`:** replace that single line with `renderRunPersonas(wt.dir, { runtimeRoot: run.project })` (add the import from `./self-host.ts`). Behavior is identical for a legit worktree; the change adds the running-instance-safe guard and the named seam. Run `bun test test/fleet-dag-node.test.ts` to confirm no regression.
- [ ] **Step 4: Run the full suite (no regression)** — `bun test` → all green (existing fleet tests unchanged; render/worktree/squad back-compat intact).
- [ ] **Step 5: Commit**
  ```bash
  git add opencode-plugin/test/fleet-self-host.test.ts
  # include opencode-plugin/src/fleet/dag-scheduler.ts ONLY if Step 3 edited it
  git commit -m "test(fleet): T6 self-host seam — render into worktree before drive, origin clean (N3/N1b)"
  ```

---

### Task 4: the two-layer / seed-model doc (N3 seed distribution)

**Files:**
- Create: `docs/self-hosting-seed-model.md`
- Modify: `docs/INDEX.md` (add one entry under "## Fleet / squad" or the self-hosting DAG block, next to the self-hosting spec)

**Interfaces:** documentation only — the "test" is a content checklist plus the INDEX.md link (the durable-map convention).

- [ ] **Step 1: Write `docs/self-hosting-seed-model.md`.** Cover, concretely (not hand-wavy), each of:
  - **The two layers (state them as the spec's frame, §"The two-layer model").**
    - *Layer 1 — CODE base = the shared "seed".* One git lineage (`~/z2/meta-harness`, `opencode-plugin/src/`). Developed by the fleet under human direction, **merged by a human** (the PR gate, N2). Every user gets the same seed code.
    - *Layer 2 — harness CONTENT = per-user.* The evolved `system.md`/playbook, evolved by **Loop A (propose→ab)** on each user's own tasks. Lives in the stores (`~/.config/meta-harness` account store + `<project>/.meta-harness/` project store) — a *different* tree from the code. This is where users diverge.
    - The clean separation, verified: code in git; prompts in the stores (gitignored `.meta-harness/`). Cite the store layout observed in this repo: account store via `META_HARNESS_HOME` (host-global); project store `.meta-harness/global/` (v0–v6) + `.meta-harness/roles/{mh-build,mh-judge}`.
  - **Seed → runtime bootstrap (the mechanism T6 wires).** State that the seed ships the *scaffolding*, not the rendered personas: `opencode.json` (plugin + permission only — no provider block), and `.opencode/agents/` ships only `mh-build.md`. The fleet A/D/I/E personas are **runtime-rendered per run** by `roles-render` into the run's worktree — never pre-baked. Explain the render layering (account-global → project-global → account-role → project-role, Option Y order) and that `renderRunPersonas` (T6) is where a run materializes Layer 2 into the throwaway worktree's `.opencode/agents/` before the squad drives.
  - **Why the two layers stay separate under self-hosting.** The fleet develops Layer 1 (code) in a worktree and PRs it; Layer 2 (each user's prompts) is untouched by the code merge. A user pulling the merged seed keeps their own evolved Layer-2 store. Note the store read/write coupling from the Global Constraints: for self-host runs the worktree render reads account-scoped Layer 2 (host-global, faithful) and empty project layers (no project-role stores exist for fleet roles) — see the "open question" if project-scoped Layer 2 must ever survive into the worktree.
  - **Running-instance-safe invariant.** Self-hosting targets the live tree only through a throwaway worktree (T1). The ledger stays in the origin `runtimeRoot` (N1b); personas render into the worktree, never the origin (the guard). `git status` on the running instance stays clean throughout — this is the N3 verification bullet's "the running instance stays safe throughout."
  - **Scope pointer.** Link the self-hosting spec (`docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`) as authoritative; note the actual `fleet-dev --project ~/z2/meta-harness --feature "<trivial>"` end-to-end run is the **T7 smoke**, not T6.
- [ ] **Step 2: Add the INDEX.md entry.** One line pointing at `self-hosting-seed-model.md` describing it as the N3 two-layer/seed-model doc (seed code vs per-user evolved prompts; runtime-rendered personas), sitting beside the self-hosting spec.
- [ ] **Step 3: Content check (the doc's "verification").** Confirm the doc names all of: the two layers + which is shared vs per-user; the seed scaffolding vs runtime-rendered personas distinction (`opencode.json` plugin/permission-only, `.opencode/agents/` = mh-build.md only); the `renderRunPersonas` worktree seam; the running-instance-safe invariant; and the T7 boundary. Confirm the INDEX.md link resolves.
- [ ] **Step 4: Commit**
  ```bash
  git add docs/self-hosting-seed-model.md docs/INDEX.md
  git commit -m "docs(self-hosting): T6 two-layer/seed-model doc — seed code vs per-user prompts, runtime-render (N3)"
  ```

---

## Notes / scope boundaries (carried from the spec)

- **T6 owns the render *seam*; T4 owns the node *schedule*.** `renderRunPersonas` is the one call T4's `runNode` makes to populate a worktree's personas; T6 does not schedule, merge, or commit. The two are Wave-1 parallel siblings (`docs/superpowers/specs/…selfhosting…md` build waves) — Task 3 wires them together whichever lands second.
- **Reuse over reinvention.** Rendering stays in `render.ts` (layers, stamp, idempotence, wire-lint). T6 adds only the per-node placement + safety guard + the target precondition + the doc. No shipped signature changes.
- **The guard is a tripwire, not the isolation.** Structural isolation is T1's (the worktree is a throwaway `mkdtemp` dir). The `runtimeRoot === worktreeDir` guard catches a *caller bug* (passing the origin) — defense-in-depth for the running-instance-safe invariant, not the primary mechanism.
- **`assertSelfHostReady` is a fast-fail precondition, not a scheduler concern.** T4's `runDag`/`cmdFleetDev` MAY call it once at run start against `--project` before creating any worktree; T6 provides the check, T4 decides where to call it (a one-line optional guard — noted for the T4 executor, not required by T6).

## Explicitly DEFERRED / out of scope

- **The actual self-host end-to-end run is T7's smoke, not T6.** `fleet-dev --project ~/z2/meta-harness --feature "<trivial>"` → DAG → parallel nodes → integration branch → integration-verify → PR → human merge (spec Verification §N3) needs T2+T5+T6 and a real `opencode` drive. T6 proves the render seam hermetically (Task 3) with an injected `execFn`; the live all-roles-share-one-worktree assertion is the T7/live gate.
- **A render.ts store-root/write-dir split** (read project-scoped Layer 2 from `runtimeRoot`, write the persona file into `worktreeDir`) so worktree renders preserve project-scoped Layer 2 — **out of scope**; T6 adopts the shipped/T4 behavior (`project = worktreeDir` for both read and write). See the open question.
- **DAG decomposition / scheduler / merge / PR (N4/N5a/N5b/N2)** — T3/T4/T5/T2, separate plans. T6 does not decompose features, schedule nodes, merge worktrees, or push branches.
- **Multi-project namespace + fair-share (D8.3)** — `fleet-dev` self-hosting v1 targets ONE repo (`~/z2/meta-harness`). Per-project isolation is additive and deferred.
- **Master automation (fleet spec §9.4/§9.5)** — the human-as-master points `fleet-dev` at the self-host target today; the singleton master owning that is a separate build.

## Open questions for the human (before/at execution)

1. **Project-scoped Layer 2 in the worktree render.** Confirmed behavior: `renderRunPersonas(project = worktreeDir)` reads project-scoped store layers from the *empty* worktree `.meta-harness/`, so the origin's `project-global` store (`.meta-harness/global/`, v0–v6 — the TB2/benchmark playbook) is NOT applied to the rendered fleet personas. Account-scoped Layer 2 (host-global) IS applied. For the fleet A/D/I/E roles this is faithful (no project-role stores exist for them). **Confirm this is intended for self-host runs.** If project-scoped Layer 2 must survive into the worktree render, that requires a `render.ts` store-root/write-dir split (a render change beyond T6's wiring scope, and one T4 would also adopt).
2. **`assertSelfHostReady` call site.** T6 provides the precondition; should T4's `cmdFleetDev`/`runDag` invoke it once at run start (recommended, one line), or should it stay an explicit operator step? (No T6 code depends on the answer.)
3. **Doc location.** Plan places the two-layer/seed doc at `docs/self-hosting-seed-model.md` (top-level design docs, linked from `INDEX.md`), consistent with the other durable design docs. Confirm this vs. co-locating it under `docs/superpowers/`.
