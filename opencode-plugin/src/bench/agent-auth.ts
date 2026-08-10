/**
 * agent-auth.ts — Claude Code oauth mounts for the bench agent container.
 *
 * Verified live (this session, real >0-turn opencode turn, ~$0.01 cost): the
 * bench agent container (where `opencode run` executes) needs THREE mounts
 * to use CC oauth, not just the one (`~/.local/share/opencode`, auth.json)
 * cmd-run.ts already wired. Without #1 below, the `opencode-claude-auth`
 * plugin never loads and oauth fails with "Unexpected server error"; #2 is
 * the credential the plugin reads once it does load.
 *
 *  1. A MINIMAL per-run opencode config (ro) that loads the plugin —
 *     `{"$schema":"https://opencode.ai/config.json","plugin":["opencode-claude-auth@latest"]}`.
 *     Deliberately minimal so no host MCP/other config leaks into the
 *     container; written to a fresh temp dir every run.
 *  2. `.credentials.json` (ro) — the source credential the container-side
 *     plugin reads. Both platforms copy it into a throwaway 700/600 shadow
 *     dir holding ONLY that file and mount THAT, read-only — the real
 *     `~/.claude` (memory, transcripts, history: operator context an agent
 *     under test must never read) is never mounted:
 *       - linux (WSL) host: copied from the on-disk `~/.claude/.credentials.json`.
 *       - darwin host: no `.credentials.json` on disk (Keychain-only) — exported
 *         at runtime via `security find-generic-password -s "Claude
 *         Code-credentials" -w`.
 *  3. The opencode data dir (rw) — auth.json. Unchanged from before this
 *     helper existed; folded in here so cmd-run.ts has ONE mount list to
 *     merge (see this module's callers) instead of two.
 *
 * Security: the shadow `.credentials.json` (linux copy or darwin Keychain
 * export) carries a live refresh token. It is written mode 600 inside a
 * mode-700 dir under the OS temp root, mounted read-only into the container,
 * and shredded (overwritten, then the whole temp root removed) by the
 * returned `cleanup()`.
 *
 * Concurrency: every container mounts the SAME rw opencode-data dir
 * (auth.json lives there), and the plugin rotates the refresh token on
 * REFRESH — i.e. at the ~8h access-token expiry, NOT per request/task. The
 * refresh token is single-use: one container's refresh invalidates every other
 * holder's, and nothing locks the shared file (confirmed: Anthropic claude-code
 * #22600 / #48786). So concurrent containers that cross a refresh boundary race
 * each other; runs shorter than the token TTL never refresh and are safe.
 * Policy (docs/auth-delegation-design.md): we do NOT coordinate — the --parallel
 * guard SURFACES this and the user chooses serial or a static API key (see
 * paths.ts's `apiKeyEnv` / keyOnly), which sidesteps oauth/refresh entirely.
 *
 * Testability: `platform` / `execFn` / `home` are all injectable so tests
 * never touch the real Keychain, spawn `security`, or read the real host
 * `~/.claude`.
 *
 * task-B5-brief.md adds a second export below, `prepareClaudeCodeAuth` — the
 * claude-code driver's OWN auth path (no opencode plugin involved), see its
 * doc comment for the differences.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { BenchError } from "./util.ts"

/**
 * Fresh 0700 dir under `tmpRoot` holding ONLY `.credentials.json` (0600) —
 * the one file a container needs from `~/.claude`. The real dir (memory,
 * session transcripts, history.jsonl — operator context an agent under test
 * must never read) never crosses the mount boundary; both platforms and both
 * prepare* exports below go through here.
 */
function writeShadowClaudeDir(tmpRoot: string, creds: string | Buffer): { claudeDir: string; credsPath: string } {
  const claudeDir = join(tmpRoot, "claude")
  mkdirSync(claudeDir, { recursive: true })
  chmodSync(claudeDir, 0o700)
  const credsPath = join(claudeDir, ".credentials.json")
  writeFileSync(credsPath, creds)
  chmodSync(credsPath, 0o600)
  return { claudeDir, credsPath }
}

export interface AgentAuthMount {
  host: string
  container: string
  ro: boolean
}

export interface AgentAuthMounts {
  mounts: AgentAuthMount[]
  cleanup: () => void
  /** Optional container env vars a driver's auth needs alongside its mounts
   * (task-B3-brief.md) — e.g. a claude-code driver's ANTHROPIC_API_KEY.
   * opencode's own `prepareAgentAuthMounts` below returns none (auth flows
   * entirely through the mounts); cmd-run.ts merges this into the
   * agent-container create env AFTER `apiKeyEnv()`, so a driver's own auth
   * env wins on key collision. */
  env?: Record<string, string>
}

/** Runs a host command and returns its stdout, throwing on nonzero exit.
 * Only ever `security find-generic-password ...` in practice — injectable so
 * tests never shell out to the real macOS Keychain. */
export type SecurityExecFn = (argv: string[]) => string

function defaultSecurityExec(argv: string[]): string {
  const [bin, ...rest] = argv
  return execFileSync(bin!, rest, { encoding: "utf-8" })
}

const MINIMAL_OPENCODE_CONFIG = {
  $schema: "https://opencode.ai/config.json",
  plugin: ["opencode-claude-auth@latest"],
}

const ACTIONABLE_AUTH_MSG =
  "Claude Code not authenticated on host; run `claude` / `opencode auth login`, or set ANTHROPIC_API_KEY"

export interface PrepareAgentAuthMountsOpts {
  /** default: process.platform */
  platform?: NodeJS.Platform
  /** default: a wrapper around node:child_process's execFileSync */
  execFn?: SecurityExecFn
  /** default: os.homedir() */
  home?: string
  /** spec D4 / task-4-brief.md: when true, return ONLY the per-run temp
   * config-dir mount — skip the platform credential branch (Keychain
   * `security` exec / `~/.claude/.credentials.json` check) entirely AND the
   * shared rw `opencodeDataDir` mount (this module header's documented
   * concurrency hazard: every container mounting the SAME rw dir races the
   * plugin's refresh-token rotation). Callers passing keyOnly are expected
   * to supply auth purely via the API-key env cmd-run.ts already injects
   * (paths.ts's `apiKeyEnv()` / a driver's own `requiredApiKeyVar`-gated
   * env) — the opencode-claude-auth plugin config still loads (so opencode
   * doesn't 0-turn on a missing plugin), it just has no oauth credential to
   * read and falls through to the env-var key instead.
   * Tradeoff: without the shared data dir, opencode's fetched-plugin cache
   * is cold on every container (network is on inside the bench container,
   * so the plugin fetch itself still succeeds — this is a per-run latency
   * cost, not a correctness one; accepted for --parallel's isolation win). */
  keyOnly?: boolean
}

function cleanupTmp(tmpRoot: string): void {
  rmSync(tmpRoot, { recursive: true, force: true })
}

/**
 * Builds the three mounts described in this module's header and a
 * `cleanup()` that removes every temp artifact created along the way (the
 * real host `~/.claude` is never mounted nor touched — only its
 * `.credentials.json` is copied into the per-run shadow dir).
 *
 * Throws `BenchError` with an actionable message if there is no credential
 * to mount: on linux when `~/.claude/.credentials.json` doesn't exist, on
 * darwin when the Keychain export fails (no entry / `security` errors).
 */
export function prepareAgentAuthMounts(opts: PrepareAgentAuthMountsOpts = {}): AgentAuthMounts {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  const execFn = opts.execFn ?? defaultSecurityExec

  const tmpRoot = mkdtempSync(join(tmpdir(), "mh-bench-auth-"))

  const configDir = join(tmpRoot, "config")
  mkdirSync(configDir, { recursive: true })
  writeFileSync(join(configDir, "opencode.json"), JSON.stringify(MINIMAL_OPENCODE_CONFIG) + "\n")

  if (opts.keyOnly) {
    // Never touch the Keychain/`security` exec or the ~/.claude credential
    // check below — keyOnly's whole point is a container that needs neither
    // (see the opts doc comment above). platform/execFn/home are accepted
    // but unused on this branch.
    return {
      mounts: [{ host: configDir, container: "/root/.config/opencode", ro: false }],
      cleanup: () => cleanupTmp(tmpRoot),
    }
  }

  let claudeHost: string
  let shredPath: string | undefined

  if (platform === "linux") {
    const realCredsPath = join(home, ".claude", ".credentials.json")
    if (!existsSync(realCredsPath)) {
      cleanupTmp(tmpRoot)
      throw new BenchError(`prepareAgentAuthMounts: ${realCredsPath} not found. ${ACTIONABLE_AUTH_MSG}`)
    }
    ;({ claudeDir: claudeHost, credsPath: shredPath } = writeShadowClaudeDir(tmpRoot, readFileSync(realCredsPath)))
  } else if (platform === "darwin") {
    let creds: string
    try {
      creds = execFn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]).trim()
      if (!creds) throw new Error("empty credential export")
    } catch {
      cleanupTmp(tmpRoot)
      throw new BenchError(`prepareAgentAuthMounts: Keychain export failed. ${ACTIONABLE_AUTH_MSG}`)
    }
    ;({ claudeDir: claudeHost, credsPath: shredPath } = writeShadowClaudeDir(tmpRoot, creds + "\n"))
  } else {
    cleanupTmp(tmpRoot)
    throw new BenchError(`prepareAgentAuthMounts: unsupported platform "${platform}" (expected "linux" or "darwin")`)
  }

  const xdgDataHome = process.env["XDG_DATA_HOME"] || join(home, ".local", "share")
  const opencodeDataDir = join(xdgDataHome, "opencode")

  const mounts: AgentAuthMount[] = [
    // Config dir is RW, not ro: opencode writes a `.gitignore` (and caches the
    // fetched plugin) into its config dir at startup — a ro mount makes that
    // write fail ("FileSystem.writeFile /root/.config/opencode/.gitignore") and
    // opencode exits 0-turn. Safe to be rw because it's a per-run temp dir,
    // isolated per container (verified live: ro fails, rw runs a real turn).
    { host: configDir, container: "/root/.config/opencode", ro: false },
    { host: claudeHost, container: "/root/.claude", ro: true },
    { host: opencodeDataDir, container: "/root/.local/share/opencode", ro: false },
  ]

  const cleanup = (): void => {
    if (shredPath) {
      try {
        const size = statSync(shredPath).size
        writeFileSync(shredPath, "0".repeat(size))
      } catch {
        // already gone / unreadable — the recursive rm below still cleans up
      }
    }
    cleanupTmp(tmpRoot)
  }

  return { mounts, cleanup }
}

// ── readOauthExpiresAt (oauth-parallel freshness gate, Task 1) ───────────

/**
 * The ~5-min refresh buffer: Claude Code / opencode-claude-auth refresh the
 * oauth access token once it has under ~5 minutes left, not exactly at
 * expiry. Shared by this task's pre-flight check (cli.ts's validateParallel)
 * and the later scheduler launch-guard — see this module's header on WHY a
 * refresh during --parallel is unsafe (shared rw auth.json mount, single-use
 * refresh token, no file lock).
 */
export const OAUTH_PARALLEL_MARGIN_MS = 5 * 60 * 1000

/** `.credentials.json` (real file on linux, Keychain export on darwin) is
 * sometimes wrapped under `claudeAiOauth`, sometimes flat — handle both.
 * Never throws; returns `undefined` on unparseable JSON or an absent field. */
function parseOauthExpiresAt(raw: string): number | undefined {
  try {
    const json = JSON.parse(raw) as { claudeAiOauth?: { expiresAt?: number }; expiresAt?: number }
    const exp = json.claudeAiOauth?.expiresAt ?? json.expiresAt
    return typeof exp === "number" ? exp : undefined
  } catch {
    return undefined
  }
}

export interface ReadOauthExpiresAtOpts {
  /** default: process.platform */
  platform?: NodeJS.Platform
  /** default: os.homedir() */
  home?: string
  /** default: a wrapper around node:child_process's execFileSync */
  execFn?: SecurityExecFn
}

/**
 * Reads the oauth access-token expiry (ms-epoch), or `null` if there's no
 * oauth credential to read (missing file/Keychain entry, unparseable JSON,
 * or the field is absent) — NEVER throws, so callers (validateParallel's
 * pre-flight gate) can treat "no credential" and "can't tell" identically.
 *
 * Reuses this file's injectable platform/home/execFn machinery so tests
 * never touch the real Keychain or `~/.claude`.
 */
export function readOauthExpiresAt(opts: ReadOauthExpiresAtOpts = {}): number | null {
  const platform = opts.platform ?? process.platform
  // process.env.HOME checked ahead of homedir(): matches POSIX $HOME-first
  // semantics AND (unlike this file's other opts.home defaults) stays
  // dynamically overridable in Bun, whose node:os homedir() binding does NOT
  // re-read $HOME per call — only at process start. This function's default
  // (no injected `home`) is the one path exercised through cli.ts's
  // validateParallel default `readExpiry`, which test/bench-cli-*.test.ts's
  // `main()` integration tests rely on being able to fake via process.env.HOME.
  const home = opts.home ?? process.env["HOME"] ?? homedir()
  const execFn = opts.execFn ?? defaultSecurityExec

  if (platform === "darwin") {
    try {
      const raw = execFn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])
      return parseOauthExpiresAt(raw) ?? null
    } catch {
      return null
    }
  }

  // linux (or any other non-darwin platform): the real file, same as
  // prepareAgentAuthMounts's linux branch mounts directly (no export step).
  const credsPath = join(home, ".claude", ".credentials.json")
  if (!existsSync(credsPath)) return null
  try {
    return parseOauthExpiresAt(readFileSync(credsPath, "utf-8")) ?? null
  } catch {
    return null
  }
}

// ── prepareClaudeCodeAuth ────────────────────────────────────────────────

/**
 * Claude Code's own oauth/onboarding mounts (task-B5-brief.md §2) — same
 * shape as prepareAgentAuthMounts above (injectable platform/exec/home,
 * try/finally-guaranteed shred, actionable BenchError on missing
 * credential) but for the `claude` CLI directly rather than opencode's
 * `opencode-claude-auth` plugin path:
 *
 *  - `ANTHROPIC_API_KEY` present: no credential mounts at all — CC reads the
 *    key straight from its own env var (paths.ts's `apiKeyEnv()` already
 *    forwards it into the container create env; this function just needs to
 *    skip the Keychain/`.credentials.json` dance).
 *  - otherwise: both platforms build a fresh 0700 shadow dir / 0600
 *    `.credentials.json` (linux copies the on-disk file, darwin exports the
 *    Keychain item via `security find-generic-password -s "Claude
 *    Code-credentials" -w`) and mount THAT rw at `/root/.claude`, shredding
 *    it in `cleanup()`. RW because CC rotates its oauth refresh token on
 *    refresh ~8h + writes settings on use — same rationale as opencode's
 *    data-dir mount above. The real `~/.claude` (memory, transcripts,
 *    history) is never mounted: an agent under test must not read operator
 *    context, and the container must not write into the host dir. The
 *    refresh token CC rotates to inside the container is therefore silently
 *    discarded (never written back to the real file/Keychain) — fine for a
 *    single task-length run, not a durable multi-run credential store.
 *  - ALWAYS (both branches, and the API-key path too): a `/root/.claude.json`
 *    file mount with `{"hasCompletedOnboarding":true}` — CC's headless
 *    first-run gate; verified live (this task's fixture captures) that a
 *    fresh CLAUDE_CONFIG_DIR with no prior onboarding state fails before
 *    ever reaching the model. Plus env `IS_SANDBOX:"1"`, which CC requires to
 *    accept `--dangerously-skip-permissions` while running as the
 *    container's root user.
 */
export interface PrepareClaudeCodeAuthOpts {
  /** default: process.platform */
  platform?: NodeJS.Platform
  /** default: a wrapper around node:child_process's execFileSync */
  execFn?: SecurityExecFn
  /** default: os.homedir() */
  home?: string
  /** default: process.env — injectable so tests never depend on the real
   * host's ANTHROPIC_API_KEY being set or unset. */
  env?: Record<string, string | undefined>
}

const ONBOARDED_CLAUDE_JSON = { hasCompletedOnboarding: true }

export function prepareClaudeCodeAuth(opts: PrepareClaudeCodeAuthOpts = {}): AgentAuthMounts {
  const platform = opts.platform ?? process.platform
  const home = opts.home ?? homedir()
  const execFn = opts.execFn ?? defaultSecurityExec
  const env = opts.env ?? process.env

  const tmpRoot = mkdtempSync(join(tmpdir(), "mh-bench-cc-auth-"))

  const onboardingPath = join(tmpRoot, "claude.json")
  writeFileSync(onboardingPath, JSON.stringify(ONBOARDED_CLAUDE_JSON) + "\n")

  const mounts: AgentAuthMount[] = [{ host: onboardingPath, container: "/root/.claude.json", ro: true }]
  const runEnv: Record<string, string> = { IS_SANDBOX: "1" }

  if (env["ANTHROPIC_API_KEY"]) {
    return { mounts, env: runEnv, cleanup: () => cleanupTmp(tmpRoot) }
  }

  let claudeHost: string
  let shredPath: string | undefined

  if (platform === "linux") {
    const realCredsPath = join(home, ".claude", ".credentials.json")
    if (!existsSync(realCredsPath)) {
      cleanupTmp(tmpRoot)
      throw new BenchError(`prepareClaudeCodeAuth: ${realCredsPath} not found. ${ACTIONABLE_AUTH_MSG}`)
    }
    ;({ claudeDir: claudeHost, credsPath: shredPath } = writeShadowClaudeDir(tmpRoot, readFileSync(realCredsPath)))
  } else if (platform === "darwin") {
    let creds: string
    try {
      creds = execFn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]).trim()
      if (!creds) throw new Error("empty credential export")
    } catch {
      cleanupTmp(tmpRoot)
      throw new BenchError(`prepareClaudeCodeAuth: Keychain export failed. ${ACTIONABLE_AUTH_MSG}`)
    }
    ;({ claudeDir: claudeHost, credsPath: shredPath } = writeShadowClaudeDir(tmpRoot, creds + "\n"))
  } else {
    cleanupTmp(tmpRoot)
    throw new BenchError(`prepareClaudeCodeAuth: unsupported platform "${platform}" (expected "linux" or "darwin")`)
  }

  mounts.push({ host: claudeHost, container: "/root/.claude", ro: false })

  const cleanup = (): void => {
    if (shredPath) {
      try {
        const size = statSync(shredPath).size
        writeFileSync(shredPath, "0".repeat(size))
      } catch {
        // already gone / unreadable — the recursive rm below still cleans up
      }
    }
    cleanupTmp(tmpRoot)
  }

  return { mounts, env: runEnv, cleanup }
}
