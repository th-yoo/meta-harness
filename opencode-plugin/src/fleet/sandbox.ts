/**
 * sandbox.ts — credential isolation for squad-spawned opencode children
 * (security follow-up: the fleet master is meant to be sole remote-writer,
 * but a squad-driven `mh-implementer`/`mh-evaluator` role runs
 * `opencode run --dir <target-repo>` with `bash: allow` in the owner's repo,
 * inheriting the owner's full ambient env via `runHost`'s
 * `{ ...process.env, ...opts.env }` merge (bench/exec.ts) — including
 * `GH_TOKEN`/`GITHUB_TOKEN`/`SSH_AUTH_SOCK`/git credential-helper state. That
 * lets it `git push`/`gh` with the owner's identity. This module computes a
 * per-role env override that blocks remote-write credentials while leaving
 * local git (add/commit/diff/status) and opencode MODEL auth untouched.
 *
 * Sentinel, not deletion: `runHost` merges `opts.env` onto `process.env` —
 * it has no "delete this key" capability today, only override. So this
 * returns BLOCKING SENTINEL values (empty string / `/bin/false`) rather than
 * omitting keys. Verified empirically (`Bun.spawn` with
 * `env: { ...process.env, X: "" }`): the child sees `X` as a present,
 * empty-string env var — it is not dropped. That is exactly what we want:
 * `gh`/git read an empty token/askpass path as "no credential", i.e. fail
 * closed, not "fall through to some other credential source". No exec.ts
 * change was needed to ship this.
 *
 * Scope: only roles with `permission.bash === "allow"` can exec anything at
 * all (roles.ts) — design/analysis roles are `bash: deny` and need no scrub.
 */
import type { RoleSpec } from "./roles.ts"

/** The exact remote-write-credential env overrides applied to a `bash:allow`
 * role's opencode drive. Exported so tests can assert the precise set (a
 * regression guard against silently growing or shrinking the deny-list). */
export const REMOTE_WRITE_DENY_ENV: Record<string, string> = {
  // `gh` reads these for auth; empty = unauthenticated → push/PR/API writes fail.
  GH_TOKEN: "",
  GITHUB_TOKEN: "",
  // No interactive credential prompt to fall back to.
  GIT_TERMINAL_PROMPT: "0",
  // Askpass helpers fail hard instead of returning a real credential.
  GIT_ASKPASS: "/bin/false",
  SSH_ASKPASS: "/bin/false",
  // Any git operation over ssh (incl. ssh-form remotes) fails closed.
  GIT_SSH_COMMAND: "/bin/false",
  // Drop the ssh-agent socket — ssh key auth becomes unavailable.
  SSH_AUTH_SOCK: "",
}

/**
 * Env overrides that deny a squad child remote git/gh write while leaving
 * local git (add/commit/diff/status) and opencode MODEL auth intact.
 * Applied only to roles that can run shell (`permission.bash === "allow"`);
 * design/read-only roles need no scrub (they can't exec).
 *
 * Deliberately does NOT touch `*_API_KEY`, `ANTHROPIC_*`, `OPENROUTER_*`,
 * opencode-auth-plugin credentials, `HOME`, or `PATH` — the model drive
 * itself needs those (run.ts's `cmdRoleRun` dies with an auth error if the
 * opencode CLI can't authenticate the model call), and local git commit
 * needs none of the scrubbed vars.
 */
export function sandboxEnv(spec: RoleSpec): Record<string, string> | undefined {
  if (spec.permission["bash"] !== "allow") return undefined
  return { ...REMOTE_WRITE_DENY_ENV }
}
