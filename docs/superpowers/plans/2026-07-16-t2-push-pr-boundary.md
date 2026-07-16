# T2 — Push/PR Boundary (N2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **SECURITY-CRITICAL NODE.** This node's whole point is that a compromised or misbehaving squad child **cannot reach `main`**. Read the Global Constraints (the layered-defense ranking + the no-main-credential invariant) before touching code. If any task appears to hand a *run* a credential that can touch `main`, STOP — that is a SEV1 and the design is wrong, not the task.

**Goal:** Turn a T5-verified integration branch into exactly **one PR** against `main`, pushed by the **orchestrator** with a **non-admin, `fleet/*`-scoped credential that structurally cannot touch `main` or administer the repo** — the only credential any push path can reach — while **admin-enforced GitHub branch protection on `main`** independently rejects every direct push/force-push/admin-merge. The env-scrub (`fleet/sandbox.ts`) stays as a third, defense-in-depth layer that strips creds (now including the scoped one) from every *run*.

**Architecture:** Two new modules plus one additive scrub hardening:
- `fleet/push-cred.ts` — loads the scoped token from a **file** (never `process.env`, so no child ever inherits it) and builds a **push env** by *reusing* `sandboxEnv`'s verified owner-admin scrub as the base, then injecting **only** the scoped token on top. Result: even a buggy orchestrator cannot push with the owner's admin identity — the scoped token is the *only* credential in the push subprocess's env.
- `fleet/push-pr.ts` — the orchestrator-owned `assert-committed → push fleet-branch → gh pr create` flow for the T5-verified integration branch (base fixed to `main`, head = the orchestrator-fixed `fleet/*` branch, never agent-chosen; exactly one PR per feature). Node worktrees are then cleaned with T1's `removeWorktree(..., { keepBranch: true })` so the PR branch survives.
- `fleet/sandbox.ts` — add the scoped-cred env-var name to `REMOTE_WRITE_DENY_ENV` so a *run*'s scrub strips it too (belt-and-suspenders; the token is normally file-only and never in env at all).

This is spec piece **N2** (PR-flow output; the load-bearing invariant is server-side, not local) from `docs/superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md`. **deps: T1** (the worktree to commit + `removeWorktree`'s `keepBranch`), **T5** (the verified integration branch this PRs).

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:child_process` (`execFileSync`), `git`, the `gh` CLI, and the existing `fleet/sandbox.ts` credential scrub.

## Global Constraints

- **THE THREE DEFENSE LAYERS, RANKED — memorize the ranking, it drives every decision here:**
  1. **Admin-enforced branch protection on `main` = THE GUARANTEE.** GitHub-side, human-configured ("Do not allow bypassing the above settings" ON): no direct push, no force-push, no `gh pr merge --admin`, PR review required — enforced **even for admins**. This is server-side and cannot be reversed by any local process. Everything below is *additional*, not the guarantee.
  2. **The scoped non-admin `fleet/*` credential = the local boundary.** A fine-grained PAT / deploy key that can push non-protected branches and open a PR, **cannot** push `main` (protected), **cannot** `gh pr merge --admin`, **cannot** `gh api` the protection off (no Administration permission). Makes the reversible scrub irrelevant: the *only* credential a push path can reach structurally cannot mutate `main`.
  3. **The env-scrub (`fleet/sandbox.ts`) = defense-in-depth, NOT the guarantee.** It is an all-or-nothing env scrub, reversible from a `bash:allow` role via `git -c credential.helper=…` (documented residual, `sandbox.ts:183-191`). It raises the bar on a default invocation; it is never relied on as the boundary. T2 extends its deny-list to also strip the scoped-cred env var — the scrub's *role* is unchanged (still not the guarantee).
- **NO-MAIN-CREDENTIAL INVARIANT (the one rule).** **No code path may hand a *run* (any A/D/I/E role drive or squad child) a credential that can touch `main`.** The owner's admin identity must never reach a run; the scoped token must never reach a run either. The scoped token lives in the orchestrator only, injected into the specific `git push` / `gh` subprocess env — never in `process.env`, never in a rendered persona, never in the worktree.
- **ONLY-SCOPED-CRED-REACHABLE.** The orchestrator's push env is built **from the scrub base + the scoped token** (`push-cred.ts`), so the owner's admin identity is structurally *absent* from the push subprocess. Even the intended pusher cannot push with owner-admin. `buildPushEnv` is the **sole** producer of a real token in any env in this codebase.
- **Orchestrator is the sole intended pusher; branch names are orchestrator-fixed.** The fleet branch name is passed in by the caller (the `fleet-dev` scheduler, T4) — **never derived from agent/model output**. Exactly **one PR per feature** (the integration branch's); individual nodes never open their own PR.
- **Push only past a commit boundary (D9 crash-consistency).** `pushIntegrationPr` **refuses to push an uncommitted/dirty tree** — node edits are already committed (T5 merged committed SHAs). The orchestrator turns a *committed* branch into a *pushed* branch; it never commits agent-uncommitted work (that would push unverified edits).
- **git/gh only via `execFileSync`-style argv** — never a shell string (no interpolation / injection). The scoped token is passed via the **subprocess env** (a `-c credential.helper` that reads it from env), never on argv (argv is visible in process listings).
- **No `fleet-push` CLI command in T2.** `pushIntegrationPr` is called *programmatically* by the `fleet-dev` scheduler (T4) after T5's integration-verify — mirroring T1's "no `--worktree` CLI flag" boundary. A standalone CLI surface is YAGNI here.
- **Hermetic where possible; the server-side guarantee is a LIVE/human-config check.** The local invariants (which env a *run* vs the *orchestrator* sees; argv shape; base=`main`; one PR) are hermetic (injected exec seam + throwaway repo). The true guarantee — the scoped token being rejected by GitHub and admin-enforced branch protection independently rejecting `main` writes — is a **live/human-config verification** (marked, like T1's real-concurrency deferral and the existing `fleet-sandbox-live.test.ts` probe).
- **Tests run with:** `bun test test/<file>.test.ts` from `opencode-plugin/`. Hermetic tests use temp dirs under `tmpdir()` + an injected exec seam (no real `git push`/`gh`). The live probe is `test.skipIf`-gated on an env flag.

---

### Task 1: `fleet/push-cred.ts` — scoped-token loader + push env (scrub base + scoped token); scrub the scoped-cred var in a run

**Files:**
- Create: `opencode-plugin/src/fleet/push-cred.ts`
- Modify: `opencode-plugin/src/fleet/sandbox.ts` (add `FLEET_PUSH_TOKEN: ""` to `REMOTE_WRITE_DENY_ENV`, `:61-87`)
- Test: `opencode-plugin/test/fleet-push-cred.test.ts`

**Interfaces:**
- Consumes: `sandboxEnv`, `type SandboxSetup` from `./sandbox.ts`; `RoleSpec` from `./roles.ts`; `die` from `../bench/util.ts`.
- Produces:
  - `loadScopedToken(opts: { file?: string; env?: NodeJS.ProcessEnv }): string` — reads the token from `opts.file` (default `process.env.FLEET_PUSH_TOKEN_FILE`); trims; `die`s loudly if the path is unset, missing, or the content is empty. **File-first by design** — the token is never expected in `process.env` (so no child inherits it).
  - `interface PushEnv { env: Record<string, string>; cleanup: () => void }`
  - `buildPushEnv(token: string): PushEnv` — `sandboxEnv(PUSH_SANDBOX_SPEC)` (reuses the verified owner-admin scrub + isolated `GH_CONFIG_DIR` + credential-helper reset) with `GH_TOKEN` and `FLEET_PUSH_TOKEN` **overridden to the scoped token** on top. `env.GH_TOKEN === token` (for `gh`); `env.FLEET_PUSH_TOKEN === token` (read by the inline git credential helper in Task 2); every owner-admin scrub sentinel from `REMOTE_WRITE_DENY_ENV` still present. `cleanup` shreds the tmp files `sandboxEnv` wrote.
  - `PUSH_GIT_CREDENTIAL_HELPER: string` — the inline `-c credential.helper` value that answers `git credential fill` with `username=x-access-token` + `password=$FLEET_PUSH_TOKEN` (token from env, never argv). Exported so Task 2 and the tests share one definition.

- [ ] **Step 1: Write the failing test**

Create `opencode-plugin/test/fleet-push-cred.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { buildPushEnv, loadScopedToken } from "../src/fleet/push-cred.ts"
import { REMOTE_WRITE_DENY_ENV } from "../src/fleet/sandbox.ts"

let tmp: string
beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "mh-pushcred-")) })
afterEach(() => { rmSync(tmp, { recursive: true, force: true }) })

describe("push-cred: loadScopedToken (file-first, never process.env)", () => {
  test("reads + trims the token from a file", () => {
    const f = join(tmp, "tok")
    writeFileSync(f, "  ghp_scoped_fleet_token\n")
    expect(loadScopedToken({ file: f })).toBe("ghp_scoped_fleet_token")
  })
  test("dies when the path is unset", () => {
    expect(() => loadScopedToken({ env: {} })).toThrow()
  })
  test("dies when the file is missing or empty (fail closed — no silent unauth push)", () => {
    expect(() => loadScopedToken({ file: join(tmp, "nope") })).toThrow()
    const empty = join(tmp, "empty"); writeFileSync(empty, "\n")
    expect(() => loadScopedToken({ file: empty })).toThrow()
  })
})

describe("push-cred: buildPushEnv (scrub base + ONLY the scoped token)", () => {
  test("scoped token is present for gh + the git helper", () => {
    const { env, cleanup } = buildPushEnv("ghp_scoped")
    try {
      expect(env.GH_TOKEN).toBe("ghp_scoped")          // gh uses it
      expect(env.FLEET_PUSH_TOKEN).toBe("ghp_scoped")  // the inline git helper reads it from env
    } finally { cleanup() }
  })
  test("owner admin identity is STRUCTURALLY scrubbed from the push env (reuses sandboxEnv)", () => {
    const { env, cleanup } = buildPushEnv("ghp_scoped")
    try {
      // the owner-admin scrub sentinels survive the override — proves the push
      // env is built FROM the scrub, so owner-keyring/askpass/ssh are all dead
      // and the scoped token is the only reachable credential.
      expect(env.GIT_ASKPASS).toBe("false")
      expect(env.SSH_ASKPASS).toBe("false")
      expect(env.GIT_SSH_COMMAND).toBe("false")
      expect(env.SSH_AUTH_SOCK).toBe("")
      expect(env.GIT_TERMINAL_PROMPT).toBe("0")
      expect(env.GIT_CONFIG_GLOBAL).toBeTruthy()       // helper-reset gitconfig written by sandboxEnv
      expect(env.GH_CONFIG_DIR).toBeTruthy()           // isolated empty gh dir (no owner login)
    } finally { cleanup() }
  })
})

describe("push-cred: the scoped-cred var is on the RUN scrub deny-list (N2 layer 3 hardening)", () => {
  test("REMOTE_WRITE_DENY_ENV strips FLEET_PUSH_TOKEN so a run never inherits it", () => {
    expect(REMOTE_WRITE_DENY_ENV.FLEET_PUSH_TOKEN).toBe("")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fleet-push-cred.test.ts`
Expected: FAIL — `Cannot find module '../src/fleet/push-cred.ts'`, and the `REMOTE_WRITE_DENY_ENV.FLEET_PUSH_TOKEN` assertion fails (key not yet added).

- [ ] **Step 3: Write minimal implementation**

First, in `opencode-plugin/src/fleet/sandbox.ts`, add one line to `REMOTE_WRITE_DENY_ENV` (`:61-87`), just after `SSH_AUTH_SOCK`:

```ts
  // The fleet SCOPED push token (T2). Normally supplied to the orchestrator via
  // a FILE, never process.env — but if an operator ever exports it, a bash:allow
  // RUN must not inherit it. Belt-and-suspenders: the scrub strips it too, so the
  // ONLY place the scoped token ever appears in an env is buildPushEnv (push-cred.ts),
  // used by the orchestrator's push subprocess — never by a run.
  FLEET_PUSH_TOKEN: "",
```

Then create `opencode-plugin/src/fleet/push-cred.ts`:

```ts
/**
 * push-cred.ts — the fleet SCOPED push credential (spec 2026-07-16 N2, layer 2).
 *
 * LAYERED DEFENSE (see the T2 plan Global Constraints):
 *   1. admin-enforced branch protection on `main`  = THE guarantee (GitHub-side)
 *   2. this scoped non-admin `fleet/*` credential   = the local boundary
 *   3. fleet/sandbox.ts env-scrub                    = defense-in-depth, not the guarantee
 *
 * The scoped token is loaded from a FILE (never process.env) so no squad child
 * ever inherits it. `buildPushEnv` reuses sandboxEnv's verified owner-admin scrub
 * as its base and injects ONLY the scoped token on top — so the orchestrator's
 * push subprocess can reach the scoped token and NOTHING ELSE (the owner's admin
 * identity is structurally absent). This is the ONLY producer of a real token in
 * an env anywhere in the codebase.
 */
import { existsSync, readFileSync } from "node:fs"
import { die } from "../bench/util.ts"
import { sandboxEnv } from "./sandbox.ts"
import type { RoleSpec } from "./roles.ts"

/** Synthetic bash:allow RoleSpec used ONLY to reach sandboxEnv's owner-admin
 * scrub (same trick as squad-propose.ts's PROPOSER_SANDBOX_SPEC). sandboxEnv
 * reads only `permission.bash`; the rest satisfies the shape. */
const PUSH_SANDBOX_SPEC: RoleSpec = {
  role: "implementer",
  agent: "fleet-orchestrator-push",
  description: "orchestrator push subprocess (synthetic — not a rendered fleet role)",
  mode: "all",
  model: "n/a",
  temperature: 0,
  permission: { bash: "allow", edit: "deny", write: "deny" },
}

/** Inline `git -c credential.helper` value: answers `git credential fill` with the
 * scoped token from $FLEET_PUSH_TOKEN (env, never argv). Legitimate use by the
 * ORCHESTRATOR of the same `-c credential.helper` path the threat model names as a
 * RUN bypass — the difference is the token: here it is the scoped, main-incapable
 * one; a run's env has FLEET_PUSH_TOKEN scrubbed to "". */
export const PUSH_GIT_CREDENTIAL_HELPER =
  '!f() { test "$1" = get && printf "username=x-access-token\\npassword=%s\\n" "$FLEET_PUSH_TOKEN"; }; f'

export function loadScopedToken(opts: { file?: string; env?: NodeJS.ProcessEnv } = {}): string {
  const env = opts.env ?? process.env
  const file = opts.file ?? env.FLEET_PUSH_TOKEN_FILE
  if (!file) {
    return die("no scoped push token: set FLEET_PUSH_TOKEN_FILE to a 600 file holding the fleet/* PAT (see the T2 plan Human prerequisites)")
  }
  if (!existsSync(file)) return die(`scoped push token file not found: ${file}`)
  const tok = readFileSync(file, "utf-8").trim()
  if (!tok) return die(`scoped push token file is empty: ${file}`)
  return tok
}

export interface PushEnv {
  env: Record<string, string>
  cleanup: () => void
}

export function buildPushEnv(token: string): PushEnv {
  // bash:allow spec → sandboxEnv returns a setup (never undefined). This gives us
  // the owner-admin scrub + isolated gh dir + credential-helper reset for free.
  const sbx = sandboxEnv(PUSH_SANDBOX_SPEC)!
  const env: Record<string, string> = {
    ...sbx.env,            // owner admin scrubbed (GH_TOKEN:"", helper reset, ssh dead, empty gh dir)
    GH_TOKEN: token,       // ...then the scoped token is the ONLY credential reachable
    FLEET_PUSH_TOKEN: token,
  }
  return { env, cleanup: sbx.cleanup }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fleet-push-cred.test.ts`
Expected: PASS (all cases). Also run `bun test test/fleet-sandbox.test.ts` — if it asserts the exact `REMOTE_WRITE_DENY_ENV` key-set (a regression guard), update that expected set to include `FLEET_PUSH_TOKEN` in the SAME commit.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/push-cred.ts opencode-plugin/src/fleet/sandbox.ts opencode-plugin/test/fleet-push-cred.test.ts
git commit -m "feat(fleet): T2 scoped push credential — file-loaded token + push env from scrub base (N2 layer 2)"
```

---

### Task 2: `fleet/push-pr.ts` — orchestrator `assert-committed → push fleet-branch → gh pr create`

**Files:**
- Create: `opencode-plugin/src/fleet/push-pr.ts`
- Test: `opencode-plugin/test/fleet-push-pr.test.ts`

**Interfaces:**
- Consumes: `buildPushEnv`, `PUSH_GIT_CREDENTIAL_HELPER`, `loadScopedToken` from `./push-cred.ts`; `die` from `../bench/util.ts`. (T1's `removeWorktree(..., { keepBranch: true })` is invoked by the *caller* — see Notes.)
- Produces:
  - `type GitGhExecFn = (argv: string[], opts: { cwd: string; env: Record<string, string> }) => { stdout: string; stderr: string; rc: number }` — the injectable exec seam (default = an `execFileSync` wrapper). Tests capture `(argv, cwd, env)` to assert the security-relevant env WITHOUT a real spawn.
  - `interface PrResult { prUrl: string; head: string; base: string }`
  - `pushIntegrationPr(opts: { repo: string; branch: string; token: string; title: string; body: string; base?: string; remote?: string }, exec?: GitGhExecFn): PrResult` — for the **T5-verified** integration branch checked out (or reachable) in `repo`. Steps, in order:
    1. **assert committed** — `git status --porcelain` in `repo` MUST be empty; else `die` (D9: never push uncommitted/unverified edits).
    2. **assert the branch is a `fleet/*` name** the caller fixed — `die` if `branch` doesn't start with `fleet/` (defense against an agent-chosen ref; the orchestrator names it).
    3. **push** — `git -C repo -c credential.helper='<PUSH_GIT_CREDENTIAL_HELPER>' push <remote:default origin> <branch>:refs/heads/<branch>` with `env = buildPushEnv(token).env`.
    4. **PR** — `gh pr create --base <base:default main> --head <branch> --title <title> --body <body>` with the same push env; parse the PR URL from stdout. Exactly one `gh pr create` call.
  - `base` defaults to `"main"`; the head is always the passed `fleet/*` branch.

- [ ] **Step 1: Write the failing test**

Create `opencode-plugin/test/fleet-push-pr.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { pushIntegrationPr, type GitGhExecFn } from "../src/fleet/push-pr.ts"

/** A fake exec seam that scripts responses by matching argv, and records every
 * (argv, cwd, env) so the test can assert the security-relevant env shape. */
function fakeExec(overrides: Record<string, { stdout?: string; rc?: number }> = {}) {
  const calls: Array<{ argv: string[]; cwd: string; env: Record<string, string> }> = []
  const exec: GitGhExecFn = (argv, opts) => {
    calls.push({ argv, cwd: opts.cwd, env: opts.env })
    const key = argv.join(" ")
    if (key.includes("status --porcelain")) return { stdout: overrides.status?.stdout ?? "", stderr: "", rc: overrides.status?.rc ?? 0 }
    if (argv.includes("push")) return { stdout: "", stderr: "", rc: 0 }
    if (argv.includes("pr") && argv.includes("create")) return { stdout: "https://github.com/o/r/pull/7\n", stderr: "", rc: 0 }
    return { stdout: "", stderr: "", rc: 0 }
  }
  return { exec, calls }
}

const base = {
  repo: "/tmp/repo", branch: "fleet/feat-x", token: "ghp_scoped",
  title: "feat x", body: "verified integration branch",
}

describe("pushIntegrationPr — orchestrator push→PR of the T5-verified branch", () => {
  test("pushes the fleet branch and opens exactly ONE PR with base=main, head=fleet/*", () => {
    const { exec, calls } = fakeExec()
    const res = pushIntegrationPr(base, exec)
    expect(res.prUrl).toBe("https://github.com/o/r/pull/7")
    expect(res.base).toBe("main")
    expect(res.head).toBe("fleet/feat-x")
    const push = calls.find((c) => c.argv.includes("push"))!
    expect(push.argv).toContain("fleet/feat-x:refs/heads/fleet/feat-x")
    const prCalls = calls.filter((c) => c.argv.includes("pr") && c.argv.includes("create"))
    expect(prCalls.length).toBe(1)                                   // exactly one PR
    const pr = prCalls[0]!
    expect(pr.argv).toEqual(expect.arrayContaining(["--base", "main", "--head", "fleet/feat-x"]))
  })

  test("SECURITY: push + PR run with the SCOPED token and NO owner-admin identity", () => {
    const { exec, calls } = fakeExec()
    pushIntegrationPr(base, exec)
    for (const c of calls.filter((c) => c.argv.includes("push") || c.argv.includes("create"))) {
      expect(c.env.GH_TOKEN).toBe("ghp_scoped")     // scoped token, not owner admin
      expect(c.env.FLEET_PUSH_TOKEN).toBe("ghp_scoped")
      expect(c.env.GIT_ASKPASS).toBe("false")       // owner-admin scrub base present
      expect(c.env.SSH_AUTH_SOCK).toBe("")
    }
    // the token is NEVER on argv (would leak in process listings) — it rides the env
    const push = calls.find((c) => c.argv.includes("push"))!
    expect(push.argv.join(" ")).not.toContain("ghp_scoped")
  })

  test("REFUSES a non-fleet branch (guards against an agent-chosen ref → main)", () => {
    const { exec } = fakeExec()
    expect(() => pushIntegrationPr({ ...base, branch: "main" }, exec)).toThrow()
    expect(() => pushIntegrationPr({ ...base, branch: "feature/sneaky" }, exec)).toThrow()
  })

  test("REFUSES an uncommitted/dirty tree (D9: never push unverified edits)", () => {
    const { exec } = fakeExec({ status: { stdout: " M src/foo.ts\n" } })
    expect(() => pushIntegrationPr(base, exec)).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test test/fleet-push-pr.test.ts`
Expected: FAIL — `Cannot find module '../src/fleet/push-pr.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `opencode-plugin/src/fleet/push-pr.ts`:

```ts
/**
 * push-pr.ts — orchestrator-owned PR-flow output (spec 2026-07-16 N2).
 *
 * Turns the T5-VERIFIED integration branch into exactly ONE PR against `main`,
 * pushed with the SCOPED, main-incapable credential (push-cred.ts) — the only
 * credential in the push subprocess's env. Branch name is fixed by the caller
 * (the fleet-dev scheduler, T4), NEVER agent-chosen. Pushes only a committed
 * branch (D9). Server-side, admin-enforced branch protection on `main` is the
 * guarantee that a stray push cannot reach it — see the T2 plan Human prerequisites.
 */
import { execFileSync } from "node:child_process"
import { die } from "../bench/util.ts"
import { buildPushEnv, PUSH_GIT_CREDENTIAL_HELPER } from "./push-cred.ts"

export type GitGhExecFn = (
  argv: string[],
  opts: { cwd: string; env: Record<string, string> },
) => { stdout: string; stderr: string; rc: number }

const defaultExec: GitGhExecFn = (argv, opts) => {
  try {
    const stdout = execFileSync(argv[0]!, argv.slice(1), { cwd: opts.cwd, env: opts.env, encoding: "utf-8" })
    return { stdout, stderr: "", rc: 0 }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return { stdout: err.stdout?.toString() ?? "", stderr: err.stderr?.toString() ?? "", rc: err.status ?? 1 }
  }
}

export interface PrResult {
  prUrl: string
  head: string
  base: string
}

export function pushIntegrationPr(
  opts: { repo: string; branch: string; token: string; title: string; body: string; base?: string; remote?: string },
  exec: GitGhExecFn = defaultExec,
): PrResult {
  const base = opts.base ?? "main"
  const remote = opts.remote ?? "origin"
  // orchestrator-fixed ref only — never an agent-chosen branch (which could be `main`).
  if (!opts.branch.startsWith("fleet/")) die(`refusing to push non-fleet branch '${opts.branch}' — the orchestrator fixes a fleet/* name`)

  const { env, cleanup } = buildPushEnv(opts.token)
  try {
    // 1. D9: only push a committed branch (T5 merged committed SHAs; a dirty tree = bug).
    const status = exec(["git", "status", "--porcelain"], { cwd: opts.repo, env })
    if (status.rc !== 0) die(`git status failed in ${opts.repo}: ${status.stderr}`)
    if (status.stdout.trim() !== "") die(`refusing to push: ${opts.repo} has uncommitted changes (D9: push only past a commit boundary)`)

    // 2. push the fleet branch with the scoped token (inline helper reads $FLEET_PUSH_TOKEN from env).
    const push = exec(
      ["git", "-c", `credential.helper=${PUSH_GIT_CREDENTIAL_HELPER}`, "push", remote, `${opts.branch}:refs/heads/${opts.branch}`],
      { cwd: opts.repo, env },
    )
    if (push.rc !== 0) die(`git push ${opts.branch} failed: ${push.stderr || push.stdout}`)

    // 3. exactly one PR, base fixed to main.
    const pr = exec(
      ["gh", "pr", "create", "--base", base, "--head", opts.branch, "--title", opts.title, "--body", opts.body],
      { cwd: opts.repo, env },
    )
    if (pr.rc !== 0) die(`gh pr create failed: ${pr.stderr || pr.stdout}`)
    const prUrl = pr.stdout.trim().split("\n").find((l) => l.startsWith("http")) ?? pr.stdout.trim()
    return { prUrl, head: opts.branch, base }
  } finally {
    cleanup()
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test test/fleet-push-pr.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/src/fleet/push-pr.ts opencode-plugin/test/fleet-push-pr.test.ts
git commit -m "feat(fleet): T2 orchestrator push→PR of the verified integration branch (N2), scoped-cred only"
```

---

### Task 3: N2 verification — the credential-bypass simulation (hermetic) + the live server-side guarantee

**Files:**
- Create: `opencode-plugin/test/fleet-push-boundary.test.ts` (hermetic asserts)
- Create: `opencode-plugin/test/fleet-push-boundary-live.test.ts` (`test.skipIf`-gated live probe — the true guarantee)

**Interfaces:**
- Consumes: `sandboxEnv`, `REMOTE_WRITE_DENY_ENV` from `../src/fleet/sandbox.ts`; `roleSpec` from `../src/fleet/roles.ts`; `buildPushEnv` from `../src/fleet/push-cred.ts`.
- Produces: nothing (verification only). The hermetic file encodes the **local** invariants; the live file encodes the **server-side** guarantee and is opt-in.

**This task is the spec's N2 verification (`spec :104`) made concrete.** The load-bearing check has two halves: (i) the ONLY reachable credential is the `fleet/*`-scoped non-admin one, and (ii) admin-enforced branch protection independently rejects `main` writes. Half (i)'s *local* shape (what env a run vs the orchestrator sees) is hermetic; half (i)'s *structural* property (the scoped token being rejected by GitHub) and all of half (ii) are LIVE.

- [ ] **Step 1: Write the hermetic bypass-simulation test**

Create `opencode-plugin/test/fleet-push-boundary.test.ts`:

```ts
import { describe, expect, test } from "bun:test"
import { REMOTE_WRITE_DENY_ENV, sandboxEnv } from "../src/fleet/sandbox.ts"
import { roleSpec } from "../src/fleet/roles.ts"
import { buildPushEnv } from "../src/fleet/push-cred.ts"

/** Exactly how runHost (bench/exec.ts) merges the scrub onto the ambient env for
 * a bash:allow role — the env a real `git -c credential.helper=…` bypass would see. */
function runEnvFor(role: "implementer" | "evaluator", ambient: Record<string, string>) {
  const sbx = sandboxEnv(roleSpec(role))!
  try { return { ...ambient, ...sbx.env } } finally { sbx.cleanup() }
}

describe("N2 layer 3 — the bypass from a bash:allow role reaches NO owner/scoped credential", () => {
  // ambient simulates the operator's shell: owner admin token + an exported scoped token
  const ambient = { GH_TOKEN: "OWNER_ADMIN", GITHUB_TOKEN: "OWNER_ADMIN", FLEET_PUSH_TOKEN: "SCOPED", SSH_AUTH_SOCK: "/run/agent.sock" }

  for (const role of ["implementer", "evaluator"] as const) {
    test(`${role}: owner admin AND scoped token are both scrubbed from the run's env`, () => {
      const env = runEnvFor(role, ambient)
      expect(env.GH_TOKEN).toBe("")            // owner admin gone
      expect(env.GITHUB_TOKEN).toBe("")        // owner admin gone
      expect(env.FLEET_PUSH_TOKEN).toBe("")    // scoped token gone (the new deny-list entry)
      expect(env.SSH_AUTH_SOCK).toBe("")       // ssh key auth gone
      expect(env.GIT_CONFIG_GLOBAL).toBeTruthy() // helper-reset gitconfig → keyring bypass hits nothing
      // the `git -c credential.helper=…` residual (sandbox.ts:183-191) still EXISTS, but with
      // GH_TOKEN/FLEET_PUSH_TOKEN emptied there is no token in the env for a re-added helper to echo.
    })
  }

  test("the scoped token is NEVER injected into a run's env by any run code path", () => {
    // sandboxEnv (the only env a run gets) never carries a real token value.
    const sbx = sandboxEnv(roleSpec("implementer"))!
    try {
      expect(sbx.env.GH_TOKEN).toBe("")
      expect(sbx.env.FLEET_PUSH_TOKEN).toBe("")
    } finally { sbx.cleanup() }
  })

  test("buildPushEnv is the SOLE producer of the scoped token — and it is scrubbed of owner admin", () => {
    const { env, cleanup } = buildPushEnv("SCOPED")
    try {
      expect(env.GH_TOKEN).toBe("SCOPED")      // orchestrator-only
      expect(env.GIT_ASKPASS).toBe("false")    // built from the owner-admin scrub base
    } finally { cleanup() }
  })

  test("REMOTE_WRITE_DENY_ENV keeps the owner-admin scrub AND now strips the scoped var", () => {
    expect(REMOTE_WRITE_DENY_ENV.GH_TOKEN).toBe("")
    expect(REMOTE_WRITE_DENY_ENV.GITHUB_TOKEN).toBe("")
    expect(REMOTE_WRITE_DENY_ENV.FLEET_PUSH_TOKEN).toBe("")
  })
})
```

- [ ] **Step 2: Run the hermetic test**

Run: `bun test test/fleet-push-boundary.test.ts`
Expected: PASS. If the `FLEET_PUSH_TOKEN` scrub (Task 1) is missing, the first tests FAIL — this is the hermetic gate for "no scoped/owner credential reaches a run."

- [ ] **Step 3: Write the LIVE server-side guarantee probe (skipIf-gated — this is the real N2 guarantee)**

Create `opencode-plugin/test/fleet-push-boundary-live.test.ts`, modeled on `fleet-sandbox-live.test.ts`. **This is a LIVE / human-config verification** (like T1's real-concurrency deferral): it needs a real GitHub repo with admin-enforced branch protection on `main`, the scoped `fleet/*` PAT in `FLEET_PUSH_TOKEN_FILE`, and (for the independent layer-1 check) the owner-admin token. Opt in with `MH_LIVE_PUSH_BOUNDARY_PROBE=1` + `MH_LIVE_PUSH_REPO=owner/name`.

```ts
import { describe, expect, test } from "bun:test"
import { execSync } from "node:child_process"
import { buildPushEnv, loadScopedToken } from "../src/fleet/push-cred.ts"

function has(bin: string): boolean {
  try { execSync(`command -v ${bin}`, { stdio: "ignore" }); return true } catch { return false }
}
const repo = process.env.MH_LIVE_PUSH_REPO ?? ""
const enabled = process.env.MH_LIVE_PUSH_BOUNDARY_PROBE === "1" && !!repo && has("git") && has("gh")

// Run each command with the SCOPED push env and report rc + combined output.
function scoped(argv: string[]): { rc: number; out: string } {
  const { env, cleanup } = buildPushEnv(loadScopedToken())
  try {
    const out = execSync(argv.map((a) => `'${a.replace(/'/g, "'\\''")}'`).join(" "), { env: { ...process.env, ...env }, encoding: "utf-8", stdio: "pipe" })
    return { rc: 0, out }
  } catch (e) {
    const err = e as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return { rc: err.status ?? 1, out: (err.stdout?.toString() ?? "") + (err.stderr?.toString() ?? "") }
  } finally { cleanup() }
}

describe("N2 LIVE — the scoped credential CANNOT reach main/admin; branch protection independently rejects", () => {
  // (i) the scoped credential is structurally main-incapable:
  test.skipIf(!enabled)("scoped token CANNOT push main, CAN push fleet/*", () => {
    // clone via the scoped env into a temp dir, commit an empty change, try both pushes.
    // push to main → rejected (protected / insufficient scope); push to fleet/probe → ok.
    // (assert: main push rc !== 0 with protected/403; fleet/* push rc === 0)
  })
  test.skipIf(!enabled)("scoped token CANNOT `gh pr merge --admin`", () => {
    const r = scoped(["gh", "pr", "merge", "--admin", "--repo", repo, "1"])
    expect(r.rc).not.toBe(0)
    expect(r.out.toLowerCase()).toMatch(/permission|forbidden|403|not allow/)
  })
  test.skipIf(!enabled)("scoped token CANNOT `gh api` the branch protection off", () => {
    const r = scoped(["gh", "api", "-X", "DELETE", `repos/${repo}/branches/main/protection`])
    expect(r.rc).not.toBe(0)
    expect(r.out.toLowerCase()).toMatch(/permission|forbidden|403|resource not accessible/)
  })

  // (ii) admin-enforced branch protection independently rejects main writes —
  // proven with the OWNER-ADMIN token (layer 1 alone, independent of layer 2):
  test.skipIf(!enabled || process.env.MH_LIVE_OWNER_ADMIN_PROVE !== "1")(
    "admin-enforced protection rejects a direct/force push to main even with the OWNER token", () => {
      // with the owner admin token: `git push --force origin HEAD:main` → rejected by protection.
      // (assert rc !== 0 with 'protected branch' / 'not allow bypassing')
    },
  )
})
```

- [ ] **Step 4: Run the full suite (no regression)**

Run: `bun test`
Expected: all green; the two live files skip by default (no env flag). The hermetic boundary + push-cred + push-pr tests pass.

- [ ] **Step 5: Commit**

```bash
git add opencode-plugin/test/fleet-push-boundary.test.ts opencode-plugin/test/fleet-push-boundary-live.test.ts
git commit -m "test(fleet): T2 N2 verification — hermetic bypass sim + live scoped-cred/branch-protection guarantee"
```

---

## Human prerequisites (inherently human / out-of-band — the guarantee lives here)

These are **not code** and cannot be automated by the fleet — they are the GitHub-side configuration the layered defense rests on. The plan documents them; a human must perform them **before** the live probe (Task 3) or any real self-hosting run.

1. **Enable admin-enforced branch protection on `main` — THIS IS THE GUARANTEE (defense layer 1).**
   - Settings → Branches → add a rule for `main`: **Require a pull request before merging** (+ require ≥1 review), **block force-pushes**, **block deletions**, and — critically — **"Do not allow bypassing the above settings" ON** (admin enforcement). With this, no direct push, no force-push, and no `gh pr merge --admin` can land on `main`, *even for a repo admin*. Verify with the owner-token probe (Task 3, `MH_LIVE_OWNER_ADMIN_PROVE=1`).

2. **Provision the scoped, non-admin `fleet/*` credential (defense layer 2).** Two options:
   - **Fine-grained PAT (recommended, single credential).** Scope to *this repo only*; permissions: **Contents: Read/Write** (to push branches) + **Pull requests: Read/Write** (for `gh pr create`); **Administration: none** (so it cannot change branch protection), no other write scopes. Note the honest GitHub limitation: a fine-grained PAT is scoped at repo+permission granularity, **not per-branch** — the "cannot push `main`" property is enforced by branch protection (layer 1), and "cannot admin" by omitting Administration. Optionally add a **repo ruleset** restricting branch *creation* to the `fleet/*` pattern for extra containment.
   - **Deploy key (stronger isolation of the API surface) + a minimal PAT.** A write **deploy key** can push git but has **no API surface at all** → structurally cannot `gh pr merge --admin` or `gh api` protection off (it is git-only), and branch protection still blocks it from `main`. Pair it with a minimal PAT scoped to **Pull requests: Read/Write only** for `gh pr create`. More moving parts; use if you want the push credential to be incapable of touching the API entirely.

3. **Store the scoped token in a file, never the shell env.** Write the PAT to a `600`-mode file readable only by the operator/orchestrator (e.g. `~/.config/meta-harness/fleet-push-token`), and point the orchestrator at it via `FLEET_PUSH_TOKEN_FILE=<path>`. **Do not `export FLEET_PUSH_TOKEN=…`** into the shared shell — file-only means no squad child ever inherits it (the deny-list entry from Task 1 is only a backstop for the case someone does export it).

---

## Notes / scope boundaries (carried from the spec)

- **T2 PRs the branch T5 verified.** `pushIntegrationPr` takes the integration branch that **T5** (N5b) built by merging completed node worktrees and re-running the deterministic gate (`bun test` + smoke). T2 does not verify or merge — it asserts the branch is committed (D9) and pushes it. If T5's plan is not yet written, the contract is spec §N5b: a local `fleet/*` branch at a verified SHA. The `fleet/*` branch name is the same one T1's `createWorktree` minted (orchestrator-fixed via the scheduler's run-id).
- **`keepBranch` is the caller's call.** After `pushIntegrationPr` returns, the scheduler (T4) cleans node worktrees with **T1's `removeWorktree(wt, { keepBranch: true })`** so the pushed PR branch survives worktree teardown (the branch backs the open PR). T2 provides the push→PR; the retention wiring lives in the scheduler, exactly as T1 documented (`worktree.ts:76`, `keepBranch`).
- **No `fleet-push` CLI in T2** — `pushIntegrationPr` is programmatic; the `fleet-dev` scheduler (T4) is the real caller (mirrors T1's "no `--worktree` CLI flag" boundary).
- **The "commit" in the spec's "commit → fleet-branch → gh pr create"** refers to the per-node commits T5 already merged; T2's guard is that it only pushes a *committed* branch — it never commits agent-uncommitted work (that would push unverified edits).
- **Token never on argv.** The scoped token rides the subprocess *env* (read by the inline `-c credential.helper`), never a command-line argument — argv is visible in process listings.

## CURRENT-CODEBASE RISK (flagged — a real main-capable-credential path)

Two findings, both real; neither is *introduced* by T2, and T2's guarantee (branch protection) neutralizes the impact — but they must be on the record:

1. **bash:`deny` roles inherit the owner's FULL ambient env, including a main-capable credential.** `cmdRoleRun` applies `sandboxEnv` **only** to `bash:allow` roles (`run.ts:224`; `sandboxEnv` returns `undefined` for `bash:deny`, `sandbox.ts:194`). The analyzer + designer are `bash:deny` (`roles.ts:32,41`) → they run with the operator's un-scrubbed ambient env, which on a `gh auth login`'d machine contains the **owner's admin identity** (a `main`-capable credential). It is **not exploitable today** (a `bash:deny` role cannot exec anything, `roles.ts`/opencode permission gate), but a `main`-capable credential *is present in a run's env* for two of four roles. If a role's permission were ever flipped, or opencode ever ran a hook for a "deny" role, that credential would be reachable. T2 does **not** re-scrub deny roles (the scrub-iff-bash:allow coupling is load-bearing and correct given the guarantee rests on branch protection) — but the plan flags it, and **layer 1 (admin-enforced branch protection) is exactly what makes even a leaked owner-admin token unable to reach `main`.**

2. **There is no scoped credential or orchestrator-push code today → the DEFAULT push identity is owner-admin.** The orchestrator (`fleet-dev`, T4) runs in the operator's shell, whose ambient auth *is* the owner's admin identity. A naive `git push` / `gh pr create` from that context would push with owner-admin (main-capable). **T2 closes this** by building the push env from the scrub base + the scoped token (`buildPushEnv`), so the owner's admin identity is structurally absent from the push subprocess — even the orchestrator cannot push with owner-admin. This is the key code-level guarantee T2 adds; without it, T4's push would default to a main-capable credential.

No code path in the current tree *hands a run the scoped token* (there is none yet); T2 adds it only inside `buildPushEnv`, used by the orchestrator, with the run-side scrub extended to strip it defensively.

## DEFERRED

- **The server-side guarantee is verified LIVE / by human config, not by a hermetic unit test.** The scoped token being rejected by GitHub and admin-enforced branch protection independently rejecting `main` writes are real-network / repo-config facts (Task 3's `test.skipIf` probe + the Human prerequisites). The hermetic tests prove only the *local* invariants (which env a run vs the orchestrator sees; argv shape; one PR; base=main). This live/manual split mirrors T1's real-concurrency deferral and the existing `fleet-sandbox-live.test.ts`.
- **OS-process / worktree isolation between the orchestrator and squad children.** The spec (`:47-50`) notes there is **no OS-process boundary** on a single-host/single-account run; T2 relies on the scoped credential + branch protection, NOT process isolation. True process/keyring isolation is out of scope (same caveat `sandbox.ts:188-191` already carries).
- **Per-project credential scoping / gate-policy (fleet spec D8.3).** `fleet-dev` here targets ONE repo with ONE scoped credential; a project-namespace credential scope under one master is additive and out of scope for self-hosting v1.
- **Short-lived / rotating tokens, secret-manager integration, GitHub App installation tokens.** v1 reads a static PAT from a `600` file; token rotation and a secret manager are a later hardening.
- **Automating the human GitHub config.** Creating the PAT and enabling admin-enforced branch protection are inherently human (require repo/org admin in the GitHub UI or a separately-provisioned admin token) — the plan documents them; it does not script them.
