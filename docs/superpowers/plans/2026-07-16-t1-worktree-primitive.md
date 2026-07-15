# T1 — Git-Worktree Primitive (N1 + N1b) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a throwaway git-worktree primitive and decouple the runtime ledger from the code directory, so a squad-run can develop in an isolated worktree while its checkpoint/pending/scored records stay in the origin repo and survive worktree cleanup.

**Architecture:** A new `fleet/worktree.ts` wraps `git worktree add/remove`. `cmdRoleRun` and `cmdSquadRun` gain an optional `worktreeDir` (defaulting to `project`, so existing behavior is byte-identical): `worktreeDir` becomes the code dir (persona lookup + `opencode run --dir`), while `project` stays the **runtimeRoot** (checkpoint/pending/scored). This is spec pieces **N1** (worktree isolation, all roles share one worktree) and **N1b** (ledger anchored to runtimeRoot, not the throwaway worktree) from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:child_process` (`execFileSync`), git worktrees.

## Global Constraints

- **Back-compat is byte-identical when `worktreeDir` is absent.** Every existing caller passes only `project`; `worktreeDir` must default to `project` so the argv, persona path, and ledger location are unchanged. Verified by a dedicated regression test.
- **The runtime ledger stays under `project` (= runtimeRoot), NEVER the worktree.** `checkpointPath`, `pendingDir`, and the `scored/` archive already key off `project` — do NOT repoint them at `worktreeDir`. Only the *code* dir (`--dir` + persona `mdPath`) moves to `worktreeDir`.
- **`pendingDir` and `checkpointPath` are the SAME directory** (`<project>/.meta-harness/runtime/fleet/`): `saveCheckpoint` writes `squad-<slice>.json` alongside the `ses_*.json` session files, and `listPending` returns any `.json`. When a test asserts on *sessions*, filter by the `ses_` prefix — never blindly index `listPending()[0]` (it may be the checkpoint).
- **git only via `execFileSync("git", [...])`** — never a shell string (no interpolation / injection).
- **Atomic writes unchanged.** Keep `writeJsonAtomic` (`bench/util.ts:68-74`, temp+rename) as-is; T1 does not touch write discipline (that hardening is a later task).
- **No `squad-run` CLI `--worktree` flag in T1.** `cmdSquadRun` accepts `worktreeDir` programmatically; the `fleet-dev` scheduler (T4) is the real caller. Adding a CLI flag now is out of scope (YAGNI).
- **Tests run with:** `bun test test/<file>.test.ts` from `opencode-plugin/`. All fleet tests are hermetic (temp dirs under `tmpdir()`, `META_HARNESS_HOME` set per-test, injected `execFn` — no real process spawn).

---

### Task 1: `fleet/worktree.ts` — create/remove a throwaway worktree

**Files:**
- Create: `opencode-plugin/src/fleet/worktree.ts`
- Test: `opencode-plugin/test/fleet-worktree.test.ts`

**Interfaces:**
- Consumes: `die` from `../bench/util.ts` (signature `(msg: string) => never`).
- Produces:
  - `interface Worktree { dir: string; branch: string; repo: string }`
  - `createWorktree(repo: string, opts: { branch: string; base?: string }): Worktree`
  - `removeWorktree(wt: Worktree, opts?: { keepBranch?: boolean }): void`

- [ ] **Step 1: Write the failing test**

Create `opencode-plugin/test/fleet-worktree.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktree, removeWorktree } from "../src/fleet/worktree.ts"

/** A real, minimal git repo in a temp dir, mirroring meta-harness's own
 * `.gitignore` for `.meta-harness/` + `node_modules/` so a runtime-ledger
 * write does not dirty the tracked tree. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mh-wt-repo-"))
  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" })
  g(["init", "-q", "-b", "main"])
  g(["config", "user.email", "t@t.t"])
  g(["config", "user.name", "t"])
  writeFileSync(join(repo, ".gitignore"), ".meta-harness/\nnode_modules/\n")
  writeFileSync(join(repo, "README.md"), "hi\n")
  g(["add", "-A"])
  g(["commit", "-qm", "init"])
  return repo
}

let repo: string
beforeEach(() => { repo = initRepo() })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

describe("worktree primitive", () => {
  test("createWorktree adds a linked worktree + branch; removeWorktree tears it down", () => {
    const wt = createWorktree(repo, { branch: "fleet/s1" })
    expect(existsSync(wt.dir)).toBe(true)
    expect(existsSync(join(wt.dir, "README.md"))).toBe(true)          // base HEAD checked out
    const list = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" })
    expect(list).toContain(wt.dir)
    expect(list).toContain("[fleet/s1]")

    removeWorktree(wt)
    expect(existsSync(wt.dir)).toBe(false)
    const after = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" })
    expect(after).not.toContain(wt.dir)
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "fleet/s1"], { encoding: "utf-8" })
    expect(branches.trim()).toBe("")                                  // throwaway branch deleted
  })

  test("createWorktree symlinks node_modules (gitignored, not carried by git)", () => {
    mkdirSync(join(repo, "node_modules"))
    writeFileSync(join(repo, "node_modules", "marker.txt"), "x")
    const wt = createWorktree(repo, { branch: "fleet/s2" })
    const link = join(wt.dir, "node_modules")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(link, "marker.txt"))).toBe(true)           // resolves to the repo's
    removeWorktree(wt)
  })

  test("the live tree stays clean after createWorktree (worktree is elsewhere)", () => {
    const wt = createWorktree(repo, { branch: "fleet/s3" })
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf-8" })
    expect(status.trim()).toBe("")
    removeWorktree(wt)
  })

  test("create → remove → create the same branch again is re-run safe", () => {
    const a = createWorktree(repo, { branch: "fleet/reuse" })
    removeWorktree(a)                                        // deletes the branch + prunes admin state
    const b = createWorktree(repo, { branch: "fleet/reuse" }) // same name works — branch was deleted
    expect(existsSync(b.dir)).toBe(true)
    removeWorktree(b)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fleet-worktree.test.ts`
Expected: FAIL — `Cannot find module '../src/fleet/worktree.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `opencode-plugin/src/fleet/worktree.ts`:

```ts
/**
 * worktree.ts — the fleet git-worktree primitive (spec 2026-07-16 N1 + N1b).
 *
 * A squad-run develops in a THROWAWAY git worktree + branch off a target repo
 * so parallel nodes write safely AND self-hosting never mutates the live tree.
 * The worktree is the CODE dir (every role's `--dir`); the runtime ledger
 * (checkpoint/pending/scored) stays anchored to the ORIGINAL repo (runtimeRoot,
 * N1b) so it survives worktree cleanup.
 *
 * Retention policy (enforced by the CALLER — the fleet-dev scheduler, T4):
 * keep a run's worktree alive across a gate-pause/escalation; call
 * `removeWorktree` only on terminal done/abort. This module just provides the
 * create/remove mechanism.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { die } from "../bench/util.ts"

export interface Worktree {
  /** the throwaway checkout — every role's `--dir` for this run */
  dir: string
  /** the fleet branch checked out in `dir` */
  branch: string
  /** the origin repo the worktree is linked to */
  repo: string
}

const sanitizeBranch = (b: string) => b.replace(/[^A-Za-z0-9_\-/]/g, "_")

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim()
  } catch (e) {
    return die(`git ${args.join(" ")} failed in ${repo}: ${(e as Error).message}`)
  }
}

/**
 * Create a throwaway git worktree + branch off `repo` at `base` (default HEAD).
 * The checkout lands in a fresh system-temp dir, keeping the live repo dir
 * pristine. `node_modules` is gitignored — `git worktree add` does not carry
 * it — so it is symlinked from the repo, letting the worktree run bun without a
 * fresh install.
 */
export function createWorktree(repo: string, opts: { branch: string; base?: string }): Worktree {
  const repoAbs = resolve(repo)                 // the node_modules symlink target must be absolute
  const branch = sanitizeBranch(opts.branch)
  const base = opts.base ?? "HEAD"
  // Clear admin entries left by a worktree whose dir was deleted out from under
  // git (e.g. a crash) so a fresh add doesn't trip over stale state. Does NOT
  // delete a leftover BRANCH: a true branch-name collision dies loudly here —
  // the caller passes a UNIQUE branch per run (the fleet-dev scheduler uses a
  // run-id), and cleaning crash-leftover branches is the scheduler's D9
  // reconciliation job (T4), not this primitive's.
  git(repoAbs, ["worktree", "prune"])
  const dir = join(mkdtempSync(join(tmpdir(), "mh-fleet-wt-")), "wt")
  git(repoAbs, ["worktree", "add", "-b", branch, dir, base])
  const repoNm = join(repoAbs, "node_modules")
  const wtNm = join(dir, "node_modules")
  if (existsSync(repoNm) && !existsSync(wtNm)) symlinkSync(repoNm, wtNm, "dir")
  return { dir, branch, repo: repoAbs }
}

/**
 * Remove a worktree created by `createWorktree`: force-removes the checkout,
 * cleans its temp parent dir, and (by default) deletes its throwaway branch.
 * Call only on TERMINAL done/abort.
 */
export function removeWorktree(wt: Worktree, opts: { keepBranch?: boolean } = {}): void {
  git(wt.repo, ["worktree", "remove", "--force", wt.dir])
  rmSync(dirname(wt.dir), { recursive: true, force: true })   // the mkdtemp parent, now empty
  if (!opts.keepBranch) {
    try {
      execFileSync("git", ["-C", wt.repo, "branch", "-D", wt.branch], { encoding: "utf-8" })
    } catch {
      // branch already gone (merged/deleted upstream) — throwaway, not an error
    }
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fleet-worktree.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/worktree.ts opencode-plugin/test/fleet-worktree.test.ts
git commit -m "feat(fleet): T1 git-worktree primitive (N1) — createWorktree/removeWorktree"
```

---

### Task 2: split `cmdRoleRun` — `worktreeDir` for code, `project` for ledger

**Files:**
- Modify: `opencode-plugin/src/fleet/run.ts` (the `cmdRoleRun` args type ~180-195, the `spec`/`mdPath` block ~198-199, the `argv` ~205-208; leave the `pending.project` at ~240 UNCHANGED)
- Test: `opencode-plugin/test/fleet-run.test.ts` (append two tests inside the existing `describe("role-run", ...)`)

**Interfaces:**
- Consumes: nothing new.
- Produces: `cmdRoleRun`'s args object gains optional `worktreeDir?: string`. When present it is the code dir (`--dir` argv + persona `mdPath`); when absent it defaults to `project`. `project` remains the ledger root written into `FleetPendingSession.project`.

- [ ] **Step 1: Write the failing test**

Append inside `describe("role-run", () => { ... })` in `opencode-plugin/test/fleet-run.test.ts`:

```ts
  test("worktreeDir routes --dir + persona lookup; project stays the ledger root (N1/N1b)", async () => {
    const rt = mkdtempSync(join(tmpdir(), "mh-run-rt-"))   // runtimeRoot: NO persona rendered here
    const wt = mkdtempSync(join(tmpdir(), "mh-run-wt-"))   // worktree: persona rendered here
    renderRole(wt, "analyzer")                              // account store seeded by beforeEach's seedRenderedRole
    let seenArgv: string[] = []
    const execFn = async (argv: string[]) => { seenArgv = argv; return { stdout: multiTurn, rc: 0 } }
    const res = await cmdRoleRun({ project: rt, worktreeDir: wt, role: "analyzer", input: "x" }, execFn)
    const at = seenArgv.indexOf("--dir")
    expect(seenArgv[at + 1]).toBe(wt)                       // code dir = worktree (proves mdPath used wt too — rt has no persona)
    expect(readPending(rt, res.id).id).toBe(res.id)        // ledger under runtimeRoot
    expect(listPending(wt)).toEqual([])                     // nothing under the worktree
    rmSync(rt, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  })

  test("no worktreeDir: --dir === project (byte-identical back-compat)", async () => {
    let seenArgv: string[] = []
    const execFn = async (argv: string[]) => { seenArgv = argv; return { stdout: multiTurn, rc: 0 } }
    await cmdRoleRun({ project, role: "analyzer", input: "x" }, execFn)   // project seeded in beforeEach
    const at = seenArgv.indexOf("--dir")
    expect(seenArgv[at + 1]).toBe(project)
  })
```

(`renderRole` is already imported in this file — `import { renderRole } from "../src/fleet/render.ts"`; `mkdtempSync`/`rmSync`/`listPending`/`readPending` are already imported too.)

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fleet-run.test.ts`
Expected: the new `worktreeDir routes --dir...` test FAILS — today `--dir` is `args.project` (`rt`), so `seenArgv[at+1]` is `rt`, not `wt` (and the run would actually die first at the `mdPath` existence check in `rt`, `roles-render first`). The back-compat test PASSES already.

- [ ] **Step 3: Write minimal implementation**

In `opencode-plugin/src/fleet/run.ts`, add the field to the args type (right after `project: string`):

```ts
    project: string
    /** The CODE dir for this drive: `opencode run --dir` + the persona
     * `mdPath` lookup. Defaults to `project`, so a caller that passes only
     * `project` is byte-identical to before. When a squad-run develops in a
     * throwaway git worktree (spec N1), this is that worktree; `project` then
     * stays the runtimeRoot where the ledger (pending/checkpoint) lives (N1b). */
    worktreeDir?: string
    role: string
```

Then, just after `const spec = roleSpec(args.role)` (~line 198), add:

```ts
  const spec = roleSpec(args.role)
  const worktreeDir = args.worktreeDir ?? args.project
```

Change the persona path (was `join(args.project, ...)`):

```ts
  const mdPath = join(worktreeDir, ".opencode", "agents", `${spec.agent}.md`)
```

Change the argv `--dir` (was `args.project`):

```ts
  const argv = [
    "opencode", "run", "--dir", worktreeDir, "--agent", spec.agent,
    "--auto", "--format", "json", "--model", model, args.input,
  ]
```

**Leave `pending.project` UNCHANGED** (~line 240 stays `project: args.project`) — the ledger root is `project` (runtimeRoot), per N1b.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fleet-run.test.ts`
Expected: PASS (all existing tests + the 2 new ones).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/run.ts opencode-plugin/test/fleet-run.test.ts
git commit -m "feat(fleet): T1 split cmdRoleRun into worktreeDir (code) vs project (ledger) — N1/N1b"
```

---

### Task 3: thread `worktreeDir` through `cmdSquadRun`'s drive closure

**Files:**
- Modify: `opencode-plugin/src/fleet/squad-cli.ts` (the `cmdSquadRun` args type ~96-126, the default `DriveFn` closure ~143-163)
- Test: `opencode-plugin/test/fleet-squad-worktree.test.ts` (new)

**Interfaces:**
- Consumes: `cmdRoleRun`'s new `worktreeDir` field (Task 2).
- Produces: `cmdSquadRun`'s args object gains optional `worktreeDir?: string`, forwarded to every `cmdRoleRun` the default DriveFn makes. `checkpointPath`/`saveCheckpoint`/`cmdRoleScore` continue to use `args.project` (runtimeRoot) — unchanged.

- [ ] **Step 1: Write the failing test**

Create `opencode-plugin/test/fleet-squad-worktree.test.ts`:

```ts
/**
 * fleet-squad-worktree.test.ts — cmdSquadRun must thread `worktreeDir` onto
 * every role drive's `--dir` while the ledger (pending) lands under `project`
 * (runtimeRoot). Mirrors fleet-squad-run-model.test.ts's execFn-seam pattern:
 * an analyzer Clarify short-circuits to a terminal escalation after one drive.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdSquadRun } from "../src/fleet/squad-cli.ts"
import { cmdRolesImport } from "../src/fleet/import.ts"
import { cmdRolesRender } from "../src/fleet/render.ts"
import { writeSquadDefV1, STANDARD_SQUAD } from "../src/fleet/squad-def.ts"
import { listPending } from "../src/fleet/pending.ts"
import type { ExecFn } from "../src/fleet/run.ts"

const FIXTURES = join(import.meta.dir, "fixtures", "fleet")

function trace(payload: string): string {
  const lines = [
    { type: "text", sessionID: "ses_wt_1", text: payload },
    { type: "step_finish", sessionID: "ses_wt_1", part: { reason: "stop", tokens: { input: 1, output: 1 }, cost: 0 } },
  ]
  return lines.map((l) => JSON.stringify(l)).join("\n") + "\n"
}

describe("cmdSquadRun worktreeDir threading", () => {
  let home: string, rt: string, wt: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-sqwt-home-"))
    rt = mkdtempSync(join(tmpdir(), "mh-sqwt-rt-"))       // runtimeRoot: ledger, NO personas
    wt = mkdtempSync(join(tmpdir(), "mh-sqwt-wt-"))       // worktree: personas rendered here
    process.env.META_HARNESS_HOME = home
    writeSquadDefV1(STANDARD_SQUAD)
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })
    cmdRolesRender({ project: wt })                        // personas into the worktree
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(rt, { recursive: true, force: true })
    rmSync(wt, { recursive: true, force: true })
  })

  test("drives --dir=worktree while the ledger lands under project (N1/N1b)", async () => {
    const captured: string[][] = []
    const execFn: ExecFn = async (argv) => { captured.push(argv); return { stdout: trace("## Clarify\nneed more"), rc: 0 } }
    const outcome = await cmdSquadRun(
      { project: rt, worktreeDir: wt, sliceId: "s1", slice: "x" },
      undefined, undefined, execFn,
    )
    expect(outcome.status).toBe("escalation")
    const at = captured[0]!.indexOf("--dir")
    expect(captured[0]![at + 1]).toBe(wt)                  // N1: role drives the worktree
    // pendingDir === checkpointPath dir (<project>/.meta-harness/runtime/fleet/),
    // so listPending also returns the checkpoint file squad-<slice>.json — filter
    // to the real session (ses_ prefix) to assert the SESSION ledger, not the checkpoint.
    expect(listPending(rt).filter((id) => id.startsWith("ses_")).length).toBeGreaterThan(0) // N1b: session ledger under runtimeRoot
    expect(listPending(wt)).toEqual([])                    // not the worktree
  })

  test("no worktreeDir: --dir=project (byte-identical back-compat)", async () => {
    cmdRolesRender({ project: rt })                        // when no worktree, personas live in project
    const captured: string[][] = []
    const execFn: ExecFn = async (argv) => { captured.push(argv); return { stdout: trace("## Clarify\nx"), rc: 0 } }
    await cmdSquadRun({ project: rt, sliceId: "s2", slice: "x" }, undefined, undefined, execFn)
    const at = captured[0]!.indexOf("--dir")
    expect(captured[0]![at + 1]).toBe(rt)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fleet-squad-worktree.test.ts`
Expected: the first test FAILS — `cmdSquadRun` does not accept `worktreeDir` yet, so the drive uses `args.project` (`rt`, which has no persona) → dies `no rendered persona ... roles-render first`. The back-compat test PASSES.

- [ ] **Step 3: Write minimal implementation**

In `opencode-plugin/src/fleet/squad-cli.ts`, add the field to `cmdSquadRun`'s args type (right after `project: string`):

```ts
    project: string
    /** The CODE dir every role of this squad-run drives (`--dir`) — a
     * throwaway git worktree (spec N1) when self-hosting; defaults to
     * `project`. The ledger (checkpoint/pending/scored) stays under `project`
     * (runtimeRoot, N1b), so it survives the worktree's removal. */
    worktreeDir?: string
    sliceId: string
```

Then in the default `DriveFn` closure, forward it into the `cmdRoleRun` args object (add one line):

```ts
      const r = await cmdRoleRun(
        {
          project: args.project,
          worktreeDir: args.worktreeDir,
          role,
          input,
          model: args.model,
          sliceId,
          nodePath: `root/${sliceId}/${phase}`,
          silent: true,
        },
        execFn,
      )
```

Leave `checkpointPath`/`saveCheckpoint` and the `cmdRoleScore({ project: args.project, ... })` calls UNCHANGED — they correctly use `args.project` (runtimeRoot).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fleet-squad-worktree.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/squad-cli.ts opencode-plugin/test/fleet-squad-worktree.test.ts
git commit -m "feat(fleet): T1 thread worktreeDir through cmdSquadRun drive closure — N1/N1b"
```

---

### Task 4: integration — real worktree + squad-run, ledger survives cleanup

**Files:**
- Modify: `opencode-plugin/test/fleet-squad-worktree.test.ts` (add a second `describe` using the real `worktree.ts`)

**Interfaces:**
- Consumes: `createWorktree`/`removeWorktree` (Task 1), `cmdSquadRun` with `worktreeDir` (Task 3).
- Produces: nothing (integration test only).

- [ ] **Step 1: Write the failing test (then it passes once Tasks 1+3 are in — this task is the end-to-end proof of N1+N1b)**

Append to `opencode-plugin/test/fleet-squad-worktree.test.ts`. First extend the top-of-file imports — **merge into the existing lines, do not add duplicate `import` statements from the same specifier**: add `execFileSync` (`node:child_process`), `existsSync` + `writeFileSync` (merge into the existing `node:fs` line, which already has `mkdtempSync, rmSync`), `readPending` (merge into the existing `../src/fleet/pending.ts` line, which already has `listPending`), and a new line `import { createWorktree, removeWorktree } from "../src/fleet/worktree.ts"`. Then append the second `describe`:

```ts
describe("cmdSquadRun in a real worktree (N1 isolation + N1b ledger survival)", () => {
  let home: string, repo: string
  function initRepo(): string {
    const r = mkdtempSync(join(tmpdir(), "mh-sqwt-repo-"))
    const g = (a: string[]) => execFileSync("git", ["-C", r, ...a], { encoding: "utf-8" })
    g(["init", "-q", "-b", "main"]); g(["config", "user.email", "t@t.t"]); g(["config", "user.name", "t"])
    writeFileSync(join(r, ".gitignore"), ".meta-harness/\nnode_modules/\n")
    writeFileSync(join(r, "README.md"), "hi\n")
    g(["add", "-A"]); g(["commit", "-qm", "init"])
    return r
  }
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "mh-sqwt-e2e-home-"))
    repo = initRepo()
    process.env.META_HARNESS_HOME = home
    writeSquadDefV1(STANDARD_SQUAD)
    cmdRolesImport({ from: FIXTURES, map: { architect: ["analyzer", "designer"] } })
  })
  afterEach(() => {
    delete process.env.META_HARNESS_HOME
    rmSync(home, { recursive: true, force: true })
    rmSync(repo, { recursive: true, force: true })
  })

  test("drive targets the worktree, ledger lands in the repo runtimeRoot and survives worktree removal", async () => {
    const wt = createWorktree(repo, { branch: "fleet/s1" })
    cmdRolesRender({ project: wt.dir })                    // personas in the worktree
    const captured: string[][] = []
    const execFn: ExecFn = async (argv) => { captured.push(argv); return { stdout: trace("## Clarify\nx"), rc: 0 } }
    await cmdSquadRun({ project: repo, worktreeDir: wt.dir, sliceId: "s1", slice: "x" }, undefined, undefined, execFn)

    const at = captured[0]!.indexOf("--dir")
    expect(captured[0]![at + 1]).toBe(wt.dir)              // N1: all roles → the worktree
    // listPending co-locates with the checkpoint (squad-<slice>.json) in the same
    // dir, so filter to the real session (the trace fixture uses id "ses_wt_1").
    const sessions = listPending(repo).filter((id) => id.startsWith("ses_"))
    expect(sessions).toContain("ses_wt_1")                // N1b: session ledger under repo runtimeRoot
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf-8" })
    expect(status.trim()).toBe("")                        // live tree clean (.meta-harness gitignored)

    removeWorktree(wt)                                     // terminal cleanup
    expect(existsSync(wt.dir)).toBe(false)                // worktree gone
    expect(readPending(repo, "ses_wt_1").id).toBe("ses_wt_1") // N1b: ledger SURVIVES the removal
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test test/fleet-squad-worktree.test.ts`
Expected: PASS (all 3 tests). If Task 1 or 3 is incomplete this fails — this is the end-to-end gate for N1+N1b.

- [ ] **Step 3: Run the full suite (no regression)**

Run: `bun test`
Expected: all green (existing fleet tests unchanged; back-compat confirmed by the `no worktreeDir` cases).

- [ ] **Step 4: Commit**

```bash
git add opencode-plugin/test/fleet-squad-worktree.test.ts
git commit -m "test(fleet): T1 e2e — worktree isolation + ledger survives cleanup (N1/N1b)"
```

---

## Notes / scope boundaries (carried from the spec)

- **Retention policy** (keep worktree across gate-pause/escalation, remove only on terminal done/abort) is *enforced by the caller* — the `fleet-dev` scheduler (T4). T1 provides only `createWorktree`/`removeWorktree`; `removeWorktree` has a `keepBranch` option for the N2 PR-flow case (branch still needed for an open PR).
- **Per-worktree deps:** T1 symlinks `node_modules`. A fallback `bun install` (when no repo `node_modules` exists) is not needed for the fleet's own repo and is out of scope here.
- **`fsync` hardening** of `writeJsonAtomic`, the **role-store `score.json` atomicity** fix, the **DAG-scheduler-state** atomic writer, and **restart reconciliation** are spec D9 items that land with the scheduler (T4/T5), not T1.
- **Real code-edit isolation** (an Implementer editing files that land only in the worktree) is a live-run verification (spec Verification §N1) — it needs a real `opencode` drive, so it is not a hermetic unit test here; Task 4 proves the *plumbing* (drive `--dir` + ledger location + survival) with an injected `execFn`.
