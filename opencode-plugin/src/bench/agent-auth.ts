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
 *     plugin reads:
 *       - linux (WSL) host: the file already exists at `~/.claude/.credentials.json`
 *         — mount the real `~/.claude` dir directly, read-only.
 *       - darwin host: no `.credentials.json` on disk (Keychain-only) — export
 *         it at runtime via `security find-generic-password -s "Claude
 *         Code-credentials" -w` into a throwaway 700/600 temp dir and mount
 *         THAT, read-only.
 *  3. The opencode data dir (rw) — auth.json. Unchanged from before this
 *     helper existed; folded in here so cmd-run.ts has ONE mount list to
 *     merge (see this module's callers) instead of two.
 *
 * Security: the darwin-exported `.credentials.json` carries a live refresh
 * token. It is written mode 600 inside a mode-700 dir under the OS temp
 * root, mounted read-only into the container, and shredded (overwritten,
 * then the whole temp root removed) by the returned `cleanup()`.
 *
 * Concurrency: every container mounts the SAME rw opencode-data dir
 * (auth.json lives there), and the plugin rotates the refresh token on use —
 * concurrent containers refreshing at the same time can race each other's
 * writes to that one file. Acceptable for sequential/small-k runs; the
 * durable fix is an API key (see paths.ts's `apiKeyEnv`), which coexists
 * with this oauth-mount path and sidesteps oauth/refresh entirely.
 *
 * Testability: `platform` / `execFn` / `home` are all injectable so tests
 * never touch the real Keychain, spawn `security`, or read the real host
 * `~/.claude`.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync, chmodSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { BenchError } from "./util.ts"

export interface AgentAuthMount {
  host: string
  container: string
  ro: boolean
}

export interface AgentAuthMounts {
  mounts: AgentAuthMount[]
  cleanup: () => void
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
}

function cleanupTmp(tmpRoot: string): void {
  rmSync(tmpRoot, { recursive: true, force: true })
}

/**
 * Builds the three mounts described in this module's header and a
 * `cleanup()` that removes every temp artifact created along the way (never
 * the real host `~/.claude` — on linux that's mounted directly, not copied).
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

  let claudeHost: string
  let shredPath: string | undefined

  if (platform === "linux") {
    const realClaudeDir = join(home, ".claude")
    if (!existsSync(join(realClaudeDir, ".credentials.json"))) {
      cleanupTmp(tmpRoot)
      throw new BenchError(
        `prepareAgentAuthMounts: ${join(realClaudeDir, ".credentials.json")} not found. ${ACTIONABLE_AUTH_MSG}`,
      )
    }
    claudeHost = realClaudeDir
  } else if (platform === "darwin") {
    let creds: string
    try {
      creds = execFn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"]).trim()
      if (!creds) throw new Error("empty credential export")
    } catch {
      cleanupTmp(tmpRoot)
      throw new BenchError(`prepareAgentAuthMounts: Keychain export failed. ${ACTIONABLE_AUTH_MSG}`)
    }
    const claudeDir = join(tmpRoot, "claude")
    mkdirSync(claudeDir, { recursive: true })
    chmodSync(claudeDir, 0o700)
    const credsPath = join(claudeDir, ".credentials.json")
    writeFileSync(credsPath, creds + "\n")
    chmodSync(credsPath, 0o600)
    claudeHost = claudeDir
    shredPath = credsPath
  } else {
    cleanupTmp(tmpRoot)
    throw new BenchError(`prepareAgentAuthMounts: unsupported platform "${platform}" (expected "linux" or "darwin")`)
  }

  const xdgDataHome = process.env["XDG_DATA_HOME"] || join(home, ".local", "share")
  const opencodeDataDir = join(xdgDataHome, "opencode")

  const mounts: AgentAuthMount[] = [
    { host: configDir, container: "/root/.config/opencode", ro: true },
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
