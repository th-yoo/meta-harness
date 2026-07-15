import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { prepareAgentAuthMounts } from "../src/bench/agent-auth.ts"
import { BenchError } from "../src/bench/util.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-agent-auth-"))
}

test("prepareAgentAuthMounts: minimal opencode config content is exactly the plugin-loading config", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "linux", home })
  try {
    const configMount = mounts.find((m) => m.container === "/root/.config/opencode")!
    expect(configMount).toBeTruthy()
    const written = JSON.parse(fs.readFileSync(path.join(configMount.host, "opencode.json"), "utf-8"))
    expect(written).toEqual({
      $schema: "https://opencode.ai/config.json",
      plugin: ["opencode-claude-auth@latest"],
    })
    expect(configMount.ro).toBe(false)
  } finally {
    cleanup()
  }
})

test("prepareAgentAuthMounts: linux — mounts real ~/.claude (ro) when .credentials.json is present, plus opencode-data (rw)", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "linux", home })
  try {
    expect(mounts).toHaveLength(3)

    const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
    expect(claudeMount.host).toBe(path.join(home, ".claude"))
    expect(claudeMount.ro).toBe(true)

    const ocDataMount = mounts.find((m) => m.container === "/root/.local/share/opencode")!
    expect(ocDataMount.host).toBe(path.join(home, ".local", "share", "opencode"))
    expect(ocDataMount.ro).toBe(false)

    const configMount = mounts.find((m) => m.container === "/root/.config/opencode")!
    expect(configMount.ro).toBe(false)  // rw: opencode writes .gitignore/plugin-cache into its config dir at startup
  } finally {
    cleanup()
  }
})

test("prepareAgentAuthMounts: linux — throws actionable BenchError when ~/.claude/.credentials.json is missing", () => {
  const home = tmpDir() // no .claude dir at all
  expect(() => prepareAgentAuthMounts({ platform: "linux", home })).toThrow(BenchError)
  try {
    prepareAgentAuthMounts({ platform: "linux", home })
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as Error).message).toContain("ANTHROPIC_API_KEY")
  }
})

test("prepareAgentAuthMounts: linux — cleanup removes temp artifacts (not the real ~/.claude fixture)", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "linux", home })
  const configMount = mounts.find((m) => m.container === "/root/.config/opencode")!
  expect(fs.existsSync(configMount.host)).toBe(true)

  cleanup()

  expect(fs.existsSync(configMount.host)).toBe(false)
  // the real fixture ~/.claude must survive — cleanup only removes temp dirs
  expect(fs.existsSync(path.join(home, ".claude", ".credentials.json"))).toBe(true)
})

test("prepareAgentAuthMounts: darwin — injected execFn export becomes .credentials.json (mode 600 in a 700 dir), mounted ro", () => {
  const home = tmpDir()
  let seenArgv: string[] = []
  const execFn = (argv: string[]) => {
    seenArgv = argv
    return "TOKEN-FROM-KEYCHAIN\n"
  }

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "darwin", home, execFn })
  try {
    expect(seenArgv).toEqual(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])

    const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
    expect(claudeMount.ro).toBe(true)
    // must NOT be the real host ~/.claude — it's a per-run temp export
    expect(claudeMount.host).not.toBe(path.join(home, ".claude"))

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

test("prepareAgentAuthMounts: darwin — throws actionable BenchError when the security exec fails (no Keychain entry)", () => {
  const home = tmpDir()
  const execFn = (): string => {
    throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
  }

  expect(() => prepareAgentAuthMounts({ platform: "darwin", home, execFn })).toThrow(BenchError)
  try {
    prepareAgentAuthMounts({ platform: "darwin", home, execFn })
    throw new Error("should have thrown")
  } catch (e) {
    expect((e as Error).message).toContain("ANTHROPIC_API_KEY")
  }
})

test("prepareAgentAuthMounts: darwin — cleanup removes the temp claude dir (shreds credentials first)", () => {
  const home = tmpDir()
  const execFn = () => "TOKEN-FROM-KEYCHAIN\n"

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "darwin", home, execFn })
  const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
  expect(fs.existsSync(claudeMount.host)).toBe(true)

  cleanup()

  expect(fs.existsSync(claudeMount.host)).toBe(false)
})

test("prepareAgentAuthMounts keyOnly: only the config mount, no credential dirs", () => {
  const failingExec = (): string => {
    throw new Error("keyOnly must never shell out to the Keychain")
  }
  const auth = prepareAgentAuthMounts({ keyOnly: true, platform: "darwin", execFn: failingExec })
  // failingExec would throw if the Keychain path were taken — keyOnly must not need it
  expect(auth.mounts).toHaveLength(1)
  expect(auth.mounts[0]!.container).toBe("/root/.config/opencode")
  expect(auth.mounts[0]!.ro).toBe(false)
  auth.cleanup()
})

test("prepareAgentAuthMounts keyOnly: linux path also skips the ~/.claude/.credentials.json existence check", () => {
  // No ~/.claude at all under this fixture home — the non-keyOnly linux path
  // would throw BenchError on this; keyOnly must never reach that check.
  const home = tmpDir()
  const auth = prepareAgentAuthMounts({ keyOnly: true, platform: "linux", home })
  expect(auth.mounts).toHaveLength(1)
  expect(auth.mounts[0]!.container).toBe("/root/.config/opencode")
  auth.cleanup()
})

test("prepareAgentAuthMounts keyOnly: cleanup removes the temp config dir", () => {
  const auth = prepareAgentAuthMounts({ keyOnly: true, platform: "linux", home: tmpDir() })
  const configHost = auth.mounts[0]!.host
  expect(fs.existsSync(configHost)).toBe(true)
  auth.cleanup()
  expect(fs.existsSync(configHost)).toBe(false)
})
