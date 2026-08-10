import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { prepareAgentAuthMounts, readOauthExpiresAt } from "../src/bench/agent-auth.ts"
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

test("prepareAgentAuthMounts: linux — mounts a shadow dir (ro, only .credentials.json) at /root/.claude, plus opencode-data (rw)", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude", "projects"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')
  fs.writeFileSync(path.join(home, ".claude", "projects", "memory.md"), "P2 design — must not leak")

  const { mounts, cleanup } = prepareAgentAuthMounts({ platform: "linux", home })
  try {
    expect(mounts).toHaveLength(3)

    const claudeMount = mounts.find((m) => m.container === "/root/.claude")!
    expect(claudeMount.host).not.toBe(path.join(home, ".claude")) // per-run shadow, not the real dir
    expect(claudeMount.ro).toBe(true)
    expect(fs.readFileSync(path.join(claudeMount.host, ".credentials.json"), "utf-8")).toBe('{"fake":"cred"}')
    expect(fs.readdirSync(claudeMount.host)).toEqual([".credentials.json"]) // nothing else travels
    expect(fs.statSync(claudeMount.host).mode & 0o777).toBe(0o700)
    expect(fs.statSync(path.join(claudeMount.host, ".credentials.json")).mode & 0o777).toBe(0o600)

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

test("prepareAgentAuthMounts: keyOnly removes the shared rw auth.json mount serial oauth uses — the refresh-token-rotation race surface (D4)", () => {
  // CONFIRMED (Anthropic claude-code #22600, #48786; local ~/.claude expiresAt
  // ~8h): the oauth refresh token is SINGLE-USE — a refresh rotates it
  // server-side and invalidates every other holder, and neither Claude Code nor
  // this harness locks the shared credential file. Serial oauth mounts the SAME
  // rw opencode-data dir (/root/.local/share/opencode, auth.json) into every
  // container; under --parallel that shared rw mount is the EXACT surface two
  // containers race on. keyOnly's job is to REMOVE it (auth comes from the API
  // key env instead). This pins the discriminating contrast so a refactor can't
  // silently re-introduce the shared rw credential mount under keyOnly.
  const RACE_MOUNT = "/root/.local/share/opencode" // auth.json — the rotated-token file
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), '{"fake":"cred"}')

  const serial = prepareAgentAuthMounts({ platform: "linux", home })
  const serialRace = serial.mounts.find((m) => m.container === RACE_MOUNT)
  expect(serialRace).toBeDefined()
  expect(serialRace!.ro).toBe(false) // rw — the file the plugin writes the rotated token to
  serial.cleanup()

  const keyOnly = prepareAgentAuthMounts({ keyOnly: true, platform: "linux", home })
  expect(keyOnly.mounts.find((m) => m.container === RACE_MOUNT)).toBeUndefined() // race surface GONE
  expect(keyOnly.mounts).toHaveLength(1) // only the isolated per-run config dir remains
  expect(keyOnly.mounts[0]!.container).toBe("/root/.config/opencode")
  keyOnly.cleanup()
})

// ── readOauthExpiresAt (oauth-parallel freshness gate, Task 1) ────────────
// Reads the oauth access-token expiry (ms-epoch) so validateParallel's
// pre-flight gate (cli.ts) can decide whether a --parallel run started
// without an API key will safely outlive the token's refresh boundary.
// Never throws — null on any missing/unparseable credential.

test("readOauthExpiresAt: linux — {claudeAiOauth:{expiresAt}} wrapped fixture returns the ms-epoch", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(
    path.join(home, ".claude", ".credentials.json"),
    JSON.stringify({ claudeAiOauth: { expiresAt: 1234567890123 } }),
  )
  expect(readOauthExpiresAt({ platform: "linux", home })).toBe(1234567890123)
})

test("readOauthExpiresAt: linux — flat {expiresAt} fixture returns the ms-epoch", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ expiresAt: 999 }))
  expect(readOauthExpiresAt({ platform: "linux", home })).toBe(999)
})

test("readOauthExpiresAt: linux — missing .credentials.json returns null", () => {
  const home = tmpDir() // no .claude dir at all
  expect(readOauthExpiresAt({ platform: "linux", home })).toBeNull()
})

test("readOauthExpiresAt: linux — unparseable JSON returns null", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), "{not json")
  expect(readOauthExpiresAt({ platform: "linux", home })).toBeNull()
})

test("readOauthExpiresAt: linux — field absent from otherwise-valid JSON returns null", () => {
  const home = tmpDir()
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true })
  fs.writeFileSync(path.join(home, ".claude", ".credentials.json"), JSON.stringify({ somethingElse: true }))
  expect(readOauthExpiresAt({ platform: "linux", home })).toBeNull()
})

test("readOauthExpiresAt: darwin — injected execFn returning wrapped JSON returns the ms-epoch", () => {
  let seenArgv: string[] = []
  const execFn = (argv: string[]) => {
    seenArgv = argv
    return JSON.stringify({ claudeAiOauth: { expiresAt: 555555 } })
  }
  expect(readOauthExpiresAt({ platform: "darwin", execFn })).toBe(555555)
  expect(seenArgv).toEqual(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"])
})

test("readOauthExpiresAt: darwin — flat {expiresAt} JSON returns the ms-epoch", () => {
  const execFn = () => JSON.stringify({ expiresAt: 42 })
  expect(readOauthExpiresAt({ platform: "darwin", execFn })).toBe(42)
})

test("readOauthExpiresAt: darwin — exec throws (no Keychain entry) returns null", () => {
  const execFn = (): string => {
    throw new Error("security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.")
  }
  expect(readOauthExpiresAt({ platform: "darwin", execFn })).toBeNull()
})

test("readOauthExpiresAt: darwin — field absent from otherwise-valid JSON returns null", () => {
  const execFn = () => JSON.stringify({ somethingElse: true })
  expect(readOauthExpiresAt({ platform: "darwin", execFn })).toBeNull()
})
