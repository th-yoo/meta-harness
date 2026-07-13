/**
 * sandbox.ts — credential isolation for squad-spawned opencode children
 * (security follow-up: the fleet master is meant to be sole remote-writer,
 * but a squad-driven `mh-implementer`/`mh-evaluator` role runs
 * `opencode run --dir <target-repo>` with `bash: allow` in the owner's repo,
 * inheriting the owner's full ambient env via `runHost`'s
 * `{ ...process.env, ...opts.env }` merge (bench/exec.ts) — including
 * `GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`/git credential-helper state. That
 * lets it `git push`/`gh` with the owner's identity. This module computes a
 * per-role sandbox (env overrides + tmp files) that blocks remote-write
 * credentials while leaving local git (add/commit/diff/status) and opencode
 * MODEL auth untouched.
 *
 * mh-followup-A (2026-07-14): a live security review PROVED the original
 * env-only scrub (empty GH_TOKEN/GITHUB_TOKEN, /bin/false askpass, no
 * SSH_AUTH_SOCK) does NOT close the real remote-write paths on a machine
 * that has `gh auth login`ed (credential lives in the OS keyring, outside
 * $GH_TOKEN) and `git config --system credential.helper osxkeychain` set (a
 * configured credential helper answers `git credential fill` directly —
 * GIT_ASKPASS/GIT_TERMINAL_PROMPT are never consulted once a helper
 * satisfies the request). Verified live on this machine:
 *   - `GH_TOKEN="" GITHUB_TOKEN="" gh auth status` → still logged in (keyring).
 *   - `git config --show-origin --get credential.helper` → osxkeychain
 *     (system-level), and `git credential fill` for github.com returns a
 *     live token even with the old REMOTE_WRITE_DENY_ENV applied (it only
 *     scrubbed GIT_ASKPASS/GIT_TERMINAL_PROMPT/SSH_*, none of which
 *     osxkeychain consults).
 * This module now ALSO neutralizes both real paths (see `sandboxEnv`'s body
 * for the exact mechanism + how each was empirically verified). The
 * original env sentinels are kept as belt-and-suspenders — they still close
 * the ssh-remote and no-helper-configured cases.
 *
 * Sentinel, not deletion: `runHost` merges `opts.env` onto `process.env` —
 * it has no "delete this key" capability today, only override. So
 * `REMOTE_WRITE_DENY_ENV` uses BLOCKING SENTINEL values (empty string /
 * `/bin/false`) rather than omitting keys. Verified empirically
 * (`Bun.spawn` with `env: { ...process.env, X: "" }`): the child sees `X`
 * as a present, empty-string env var — it is not dropped. That is exactly
 * what we want: `gh`/git read an empty token/askpass path as "no
 * credential", i.e. fail closed, not "fall through to some other
 * credential source". `GIT_CONFIG_GLOBAL`/`GH_CONFIG_DIR` below are plain
 * overrides (real paths, not sentinels) — no deletion needed for those
 * either.
 *
 * Scope: only roles with `permission.bash === "allow"` can exec anything at
 * all (roles.ts) — design/analysis roles are `bash: deny` and need no scrub.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { execFileSync } from "node:child_process"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { RoleSpec } from "./roles.ts"

/** The exact remote-write-credential env overrides applied to a `bash:allow`
 * role's opencode drive. Exported so tests can assert the precise set (a
 * regression guard against silently growing or shrinking the deny-list).
 * This is the ORIGINAL 7bd204c scrub — still closes the ssh-remote path and
 * the "no credential helper configured" case. It does NOT, by itself, close
 * an osxkeychain-style credential helper or a `gh` keyring login — see
 * `sandboxEnv` for the mechanisms that do. */
export const REMOTE_WRITE_DENY_ENV: Record<string, string> = {
  // `gh` reads these for auth; empty = unauthenticated → push/PR/API writes fail
  // UNLESS a keyring login exists (gh treats "" as unset and falls back to
  // the keyring) — closed separately below via GH_CONFIG_DIR.
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  // No interactive credential prompt to fall back to.
  GIT_TERMINAL_PROMPT: "0",
  // Askpass helpers fail hard instead of returning a real credential. Only
  // reached if no `credential.helper` satisfies the request first — see
  // GIT_CONFIG_GLOBAL below for the helper-neutralization this needs.
  // Deliberately the bare command name "false" (PATH-resolved), not an
  // absolute path: `/bin/false` does not exist on this dev machine (Intel
  // macOS ships it only at `/usr/bin/false`) — with the absolute path, git
  // logged "cannot exec '/bin/false': No such file or directory" instead of
  // the intended "unable to read askpass response", a different failure
  // mode that happened to still fail closed but didn't match the documented
  // behavior. Verified live: bare "false" resolves via PATH on both the
  // `false` builtin's usual locations (/bin, /usr/bin) and produces the
  // intended askpass-refusal error.
  GIT_ASKPASS: "false",
  SSH_ASKPASS: "false",
  // Any git operation over ssh (incl. ssh-form remotes) fails closed.
  GIT_SSH_COMMAND: "false",
  // Drop the ssh-agent socket — ssh key auth becomes unavailable.
  SSH_AUTH_SOCK: "",
}

export type GitConfigExecFn = (argv: string[]) => string

function defaultGitConfigExec(argv: string[]): string {
  return execFileSync(argv[0]!, argv.slice(1), { encoding: "utf-8" })
}

/** Reads `git config --get <key>` on the HOST at sandbox-build time (before
 * the child's credential helper gets neutralized), so the written per-role
 * git config can carry the real committer identity forward. Returns
 * undefined if unset (git config exits non-zero on a missing key) — the
 * written config just omits that line; a target repo with its own local
 * `.git/config` identity (highest precedence, unaffected by
 * GIT_CONFIG_GLOBAL) still commits fine either way. */
function readGitConfig(exec: GitConfigExecFn, key: string): string | undefined {
  try {
    const out = exec(["git", "config", "--get", key]).trim()
    return out || undefined
  } catch {
    return undefined
  }
}

export interface SandboxSetup {
  /** Env overrides to merge onto the child's inherited env (runHost-style
   * `{...process.env, ...env}`). Superset of REMOTE_WRITE_DENY_ENV. */
  env: Record<string, string>
  /** Removes every tmp artifact this call created (the written git config,
   * the empty gh config dir). Caller MUST call this in a `finally` — see
   * run.ts's `cmdRoleRun`. Idempotent / safe to call even if setup partially
   * failed. */
  cleanup: () => void
}

export interface SandboxEnvOpts {
  /** default: a wrapper around node:child_process's execFileSync, reading
   * from the HOST's real `git config`. Injectable so tests never shell out
   * to the actual `git` binary / depend on the test machine's identity. */
  gitConfigExec?: GitConfigExecFn
}

/**
 * Builds a per-role sandbox (env overrides + tmp files) that denies a squad
 * child remote git/gh write while leaving local git (add/commit/diff/status)
 * and opencode MODEL auth intact. Applied only to roles that can run shell
 * (`permission.bash === "allow"`); design/read-only roles need no scrub
 * (they can't exec) and get `undefined` back — byte-identical to before this
 * module existed.
 *
 * Two mechanisms beyond the original REMOTE_WRITE_DENY_ENV sentinel set,
 * each independently live-verified (mh-followup-A):
 *
 * 1. **Neutralize the git credential helper, keep commit identity.**
 *    `GIT_CONFIG_GLOBAL` is pointed at a freshly written file containing the
 *    real `user.name`/`user.email` (read from the host's `git config` above
 *    the sandbox boundary) plus `[credential]\n\thelper =`. Git's config
 *    precedence is system → global → local; an empty `credential.helper`
 *    value RESETS the accumulated helper list (git-config(1)), and global is
 *    read after system, so this clears an inherited system-level
 *    `credential.helper = osxkeychain` WITHOUT needing to blow away the
 *    whole system config file. Verified live via the actual credential
 *    subsystem (`git credential fill`, not just `--get-all`, which
 *    misleadingly still lists both entries):
 *      - baseline (no override): `git credential fill` for github.com
 *        returns a live `password=gho_...` token from osxkeychain.
 *      - `GIT_CONFIG_GLOBAL=<written file>` ALONE (system config left
 *        alone): `git credential fill` fails with `fatal: could not read
 *        Username for 'https://github.com': Device not configured` — the
 *        keychain helper no longer answers. Adding `GIT_CONFIG_SYSTEM=/dev/null`
 *        on top made no observable difference in this probe, so it is
 *        deliberately NOT set — it would also drop unrelated system config
 *        (e.g. `safe.directory` entries) this module has no reason to
 *        touch.
 *    Commit identity confirmed to survive: `git config --get user.name`
 *    under the same override still returns the real name.
 *
 * 2. **Deny gh the OS keyring.** `GH_CONFIG_DIR` points at a fresh empty tmp
 *    dir. `gh` resolves auth from `$GH_CONFIG_DIR/hosts.yml`
 *    (or its keyring reference) with no fallback to the real
 *    `~/.config/gh` — an empty dir means gh has never seen a login here.
 *    Verified live: `GH_CONFIG_DIR=<empty dir> GH_TOKEN="" gh auth status`
 *    reports "You are not logged into any GitHub hosts" even though the
 *    real host keyring has a live, scoped (repo+workflow) oauth token.
 *
 * Deliberately does NOT touch `*_API_KEY`, `ANTHROPIC_*`, `OPENROUTER_*`,
 * opencode-auth-plugin credentials, `HOME`, or `PATH` — the model drive
 * itself needs those (run.ts's `cmdRoleRun` dies with an auth error if the
 * opencode CLI can't authenticate the model call).
 *
 * Known residual (documented, not silently claimed closed): the written
 * `GIT_CONFIG_GLOBAL` file carries ONLY identity + the credential-helper
 * reset — any other settings a real `~/.gitconfig` might hold (aliases,
 * `url.<>.insteadOf` rewrites, `safe.directory` entries, `init.defaultBranch`,
 * etc.) do NOT apply inside the sandboxed child, since `GIT_CONFIG_GLOBAL`
 * fully replaces which file counts as "global" rather than layering onto it.
 * Also: this closes credential-helper- and keyring-based auth; it does
 * nothing about a determined implementer explicitly re-adding a helper via
 * `git -c credential.helper=... push` (local `-c` overrides still win) or
 * exfiltrating a secret to a file the master later reads — true isolation
 * needs worktree/process separation, out of scope here (same caveat 7bd204c
 * already carried).
 */
export function sandboxEnv(spec: RoleSpec, opts: SandboxEnvOpts = {}): SandboxSetup | undefined {
  if (spec.permission["bash"] !== "allow") return undefined
  const gitConfigExec = opts.gitConfigExec ?? defaultGitConfigExec

  const tmpRoot = mkdtempSync(join(tmpdir(), "mh-fleet-sandbox-"))

  const name = readGitConfig(gitConfigExec, "user.name")
  const email = readGitConfig(gitConfigExec, "user.email")
  const gitConfigLines: string[] = []
  if (name) gitConfigLines.push("[user]", `\tname = ${name}`, ...(email ? [`\temail = ${email}`] : []))
  else if (email) gitConfigLines.push("[user]", `\temail = ${email}`)
  // Empty value resets the accumulated credential.helper list — see doc
  // comment above for the live-verified mechanism.
  gitConfigLines.push("[credential]", "\thelper =")
  const gitConfigPath = join(tmpRoot, "gitconfig")
  writeFileSync(gitConfigPath, gitConfigLines.join("\n") + "\n")

  const ghConfigDir = join(tmpRoot, "gh-config")
  mkdirSync(ghConfigDir, { recursive: true })

  const env: Record<string, string> = {
    ...REMOTE_WRITE_DENY_ENV,
    GIT_CONFIG_GLOBAL: gitConfigPath,
    GH_CONFIG_DIR: ghConfigDir,
  }

  const cleanup = (): void => {
    rmSync(tmpRoot, { recursive: true, force: true })
  }

  return { env, cleanup }
}
