import { describe, expect, test } from "bun:test"
import { existsSync, readFileSync } from "node:fs"
import { REMOTE_WRITE_DENY_ENV, sandboxEnv } from "../src/fleet/sandbox.ts"
import { roleSpec } from "../src/fleet/roles.ts"

/** Deterministic fake so tests never shell out to the real `git` binary /
 * depend on the test machine's configured identity. */
const fakeGitConfigExec = (argv: string[]): string => {
  const key = argv[argv.length - 1]
  if (key === "user.name") return "Fixture User\n"
  if (key === "user.email") return "fixture@example.com\n"
  throw new Error(`fake git config: unknown key ${key}`)
}

const noIdentityGitConfigExec = (): string => {
  throw new Error("git config: key not found") // simulates unset user.name/email
}

describe("sandboxEnv", () => {
  test("bash:allow role (implementer) gets the exact blocking deny-list plus the dynamic sandbox keys", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    for (const [k, v] of Object.entries(REMOTE_WRITE_DENY_ENV)) {
      expect(sbx.env[k]).toBe(v)
    }
    expect(sbx.env["GIT_CONFIG_GLOBAL"]).toMatch(/mh-fleet-sandbox-.*\/gitconfig$/)
    expect(sbx.env["GH_CONFIG_DIR"]).toMatch(/mh-fleet-sandbox-.*\/gh-config$/)
    expect(Object.keys(sbx.env).sort()).toEqual(
      [...Object.keys(REMOTE_WRITE_DENY_ENV), "GIT_CONFIG_GLOBAL", "GH_CONFIG_DIR"].sort(),
    )
    sbx.cleanup()
  })

  test("bash:allow role (evaluator) also gets scrubbed", () => {
    const sbx = sandboxEnv(roleSpec("evaluator"), { gitConfigExec: fakeGitConfigExec })!
    for (const [k, v] of Object.entries(REMOTE_WRITE_DENY_ENV)) {
      expect(sbx.env[k]).toBe(v)
    }
    sbx.cleanup()
  })

  test("bash:deny role (analyzer) gets no scrub — undefined, byte-identical to today", () => {
    expect(sandboxEnv(roleSpec("analyzer"))).toBeUndefined()
  })

  test("bash:deny role (designer) gets no scrub", () => {
    expect(sandboxEnv(roleSpec("designer"))).toBeUndefined()
  })

  test("never touches model-auth / API-key env vars (regression guard against over-scrubbing)", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    const keys = Object.keys(sbx.env)
    for (const k of keys) {
      expect(k).not.toMatch(/API_KEY/)
      expect(k).not.toMatch(/^ANTHROPIC_/)
      expect(k).not.toMatch(/^OPENROUTER_/)
    }
    expect(keys).not.toContain("HOME")
    expect(keys).not.toContain("PATH")
    sbx.cleanup()
  })

  test("REMOTE_WRITE_DENY_ENV is the exact named set the deny-list test asserts (single source of truth)", () => {
    expect(Object.keys(REMOTE_WRITE_DENY_ENV).sort()).toEqual(
      ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "SSH_ASKPASS", "SSH_AUTH_SOCK"].sort(),
    )
  })

  test("returns a fresh sandbox each call (separate tmp dirs, no shared mutable state)", () => {
    const a = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    const b = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    expect(a.env["GIT_CONFIG_GLOBAL"]).not.toBe(b.env["GIT_CONFIG_GLOBAL"])
    a.cleanup()
    b.cleanup()
  })

  test("written GIT_CONFIG_GLOBAL carries the real committer identity + resets credential.helper", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    const written = readFileSync(sbx.env["GIT_CONFIG_GLOBAL"]!, "utf-8")
    expect(written).toContain("Fixture User")
    expect(written).toContain("fixture@example.com")
    // An empty credential.helper value resets the accumulated (e.g. inherited
    // system-level osxkeychain) helper list — see sandbox.ts's header for the
    // live-verified mechanism.
    expect(written).toMatch(/\[credential\]\s*\n\s*helper\s*=\s*(\n|$)/)
    sbx.cleanup()
  })

  test("missing host git identity: written config still resets credential.helper (no [user] section)", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: noIdentityGitConfigExec })!
    const written = readFileSync(sbx.env["GIT_CONFIG_GLOBAL"]!, "utf-8")
    expect(written).not.toContain("[user]")
    expect(written).toMatch(/\[credential\]\s*\n\s*helper\s*=\s*(\n|$)/)
    sbx.cleanup()
  })

  test("GH_CONFIG_DIR points at a fresh, empty, existing directory (no inherited hosts.yml/keyring ref)", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    expect(existsSync(sbx.env["GH_CONFIG_DIR"]!)).toBe(true)
    sbx.cleanup()
  })

  test("cleanup() shreds the tmp root — no leftover git config / gh config dir", () => {
    const sbx = sandboxEnv(roleSpec("implementer"), { gitConfigExec: fakeGitConfigExec })!
    const gitConfigPath = sbx.env["GIT_CONFIG_GLOBAL"]!
    const ghConfigDir = sbx.env["GH_CONFIG_DIR"]!
    expect(existsSync(gitConfigPath)).toBe(true)
    sbx.cleanup()
    expect(existsSync(gitConfigPath)).toBe(false)
    expect(existsSync(ghConfigDir)).toBe(false)
  })
})
