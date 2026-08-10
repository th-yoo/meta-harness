import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { prepareClaudeCodeAuth } from "../src/bench/agent-auth.ts"
import { BenchError } from "../src/bench/util.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-cc-auth-test-"))
}

// ── onboarding gate — always present, regardless of platform/API-key path ──

test("prepareClaudeCodeAuth: always mounts /root/.claude.json with hasCompletedOnboarding:true, and IS_SANDBOX=1 env", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const { mounts, env, cleanup } = prepareClaudeCodeAuth({ platform: "linux", home })
  try {
    const onboardingMount = mounts.find((m) => m.container === "/root/.claude.json")!
    expect(onboardingMount).toBeTruthy()
    expect(onboardingMount.ro).toBe(true)
    expect(JSON.parse(fs.readFileSync(onboardingMount.host, "utf-8"))).toEqual({ hasCompletedOnboarding: true })
    expect(env).toEqual({ IS_SANDBOX: "1" })
  } finally {
    cleanup()
  }
})

// ── API key path — no credential mounts, onboarding gate still present ────

test("prepareClaudeCodeAuth: ANTHROPIC_API_KEY present -> no /root/.claude mount, only the onboarding gate", () => {
  const home = tmpDir() // deliberately NO .claude dir — must not be touched
  const { mounts, cleanup } = prepareClaudeCodeAuth({ platform: "linux", home, env: { ANTHROPIC_API_KEY: "sk-ant-real" } })
  try {
    expect(mounts).toHaveLength(1)
    expect(mounts[0]!.container).toBe("/root/.claude.json")
    expect(mounts.find((m) => m.container === "/root/.claude")).toBeUndefined()
  } finally {
    cleanup()
  }
})

test("prepareClaudeCodeAuth: API key path never invokes execFn (no Keychain access needed)", () => {
  let called = false
  const execFn = (): string => {
    called = true
    return "unused"
  }
  const home = tmpDir()
  const { cleanup } = prepareClaudeCodeAuth({ platform: "darwin", home, execFn, env: { ANTHROPIC_API_KEY: "sk-ant-real" } })
  cleanup()
  expect(called).toBe(false)
})

// ── linux — shadow dir (darwin parity): only .credentials.json travels ────

test("prepareClaudeCodeAuth: linux — mounts a shadow dir (0700, cred 0600) RW at /root/.claude, never the real ~/.claude", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')
  fs.writeFileSync(path.join(home, ".claude", "projects", "memory.md"), "P2 design — must not leak")

  const { mounts, cleanup } = prepareClaudeCodeAuth({ platform: "linux", home, env: {} })
  try {
    const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
    expect(claudeMount.ro).toBe(false) // CC rotates its oauth refresh token + writes settings
    expect(claudeMount.host).not.toBe(path.join(home, ".claude")) // per-run shadow, not the real dir

    const credsPath = path.join(claudeMount.host, ".credentials.json")
    expect(fs.readFileSync(credsPath, "utf-8")).toBe('{"fake":"cred"}')
    expect(fs.readdirSync(claudeMount.host)).toEqual([".credentials.json"]) // nothing else travels

    const dirMode = fs.statSync(claudeMount.host).mode & 0o777
    const fileMode = fs.statSync(credsPath).mode & 0o777
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
  } finally {
    cleanup()
  }
})

test("prepareClaudeCodeAuth: linux — cleanup shreds the copied credential and removes the shadow dir, real ~/.claude untouched", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const { mounts, cleanup } = prepareClaudeCodeAuth({ platform: "linux", home, env: {} })
  const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
  expect(fs.existsSync(claudeMount.host)).toBe(true)

  cleanup()

  expect(fs.existsSync(claudeMount.host)).toBe(false)
  expect(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf-8")).toBe('{"fake":"cred"}')
})

test("prepareClaudeCodeAuth: linux — throws actionable BenchError when ~/.claude/.credentials.json is missing", () => {
  const home = tmpDir()
  expect(() => prepareClaudeCodeAuth({ platform: "linux", home, env: {} })).toThrow(BenchError)
  try {
    prepareClaudeCodeAuth({ platform: "linux", home, env: {} })
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as Error).message).toContain("ANTHROPIC_API_KEY")
  }
})

// ── darwin — Keychain export ────────────────────────────────────────────

test("prepareClaudeCodeAuth: darwin — Keychain export becomes .credentials.json (0600 in a 0700 dir), mounted RW", () => {
  const home = tmpDir()
  let seenArgv: string[] = []
  const execFn = (argv: string[]) => {
    seenArgv = argv
    return "TOKEN-FROM-KEYCHAIN\n"
  }

  const { mounts, cleanup } = prepareClaudeCodeAuth({ platform: "darwin", home, execFn, env: {} })
  try {
    expect(seenArgv).toEqual(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])

    const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
    expect(claudeMount.ro).toBe(false)
    expect(claudeMount.host).not.toBe(path.join(home, ".claude")) // per-run temp export, not the real dir

    const credsPath = path.join(claudeMount.host, ".credentials.json")
    expect(fs.readFileSync(credsPath, "utf-8")).toContain("TOKEN-FROM-KEYCHAIN")

    const dirMode = fs.statSync(claudeMount.host).mode & 0o777
    const fileMode = fs.statSync(credsPath).mode & 0o777
    expect(dirMode).toBe(0o700)
    expect(fileMode).toBe(0o600)
  } finally {
    cleanup()
  }
})

test("prepareClaudeCodeAuth: darwin — throws actionable BenchError when the Keychain export fails", () => {
  const home = tmpDir()
  const execFn = (): string => {
    throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
  }
  expect(() => prepareClaudeCodeAuth({ platform: "darwin", home, execFn, env: {} })).toThrow(BenchError)
  try {
    prepareClaudeCodeAuth({ platform: "darwin", home, execFn, env: {} })
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as Error).message).toContain("ANTHROPIC_API_KEY")
  }
})

test("prepareClaudeCodeAuth: darwin — cleanup shreds the exported credential then removes the temp dir", () => {
  const home = tmpDir()
  const execFn = () => "TOKEN-FROM-KEYCHAIN\n"
  const { mounts, cleanup } = prepareClaudeCodeAuth({ platform: "darwin", home, execFn, env: {} })
  const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
  const onboardingMount = mounts.find((m) => m.container === "/root/.claude.json")!
  expect(fs.existsSync(claudeMount.host)).toBe(true)
  expect(fs.existsSync(onboardingMount.host)).toBe(true)

  cleanup()

  expect(fs.existsSync(claudeMount.host)).toBe(false)
  expect(fs.existsSync(onboardingMount.host)).toBe(false)
})

// ── unsupported platform ────────────────────────────────────────────────

test("prepareClaudeCodeAuth: unsupported platform throws BenchError (no credential-mount attempt)", () => {
  expect(() => prepareClaudeCodeAuth({ platform: "win32", home: tmpDir(), env: {} })).toThrow(BenchError)
})
