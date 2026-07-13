import { describe, expect, test } from "bun:test"
import { REMOTE_WRITE_DENY_ENV, sandboxEnv } from "../src/fleet/sandbox.ts"
import { roleSpec } from "../src/fleet/roles.ts"

describe("sandboxEnv", () => {
  test("bash:allow role (implementer) gets the exact blocking deny-list", () => {
    const env = sandboxEnv(roleSpec("implementer"))
    expect(env).toEqual({
      GH_TOKEN: "",
      GITHUB_TOKEN: "",
      GIT_TERMINAL_PROMPT: "0",
      GIT_ASKPASS: "/bin/false",
      SSH_ASKPASS: "/bin/false",
      GIT_SSH_COMMAND: "/bin/false",
      SSH_AUTH_SOCK: "",
    })
  })

  test("bash:allow role (evaluator) also gets scrubbed", () => {
    const env = sandboxEnv(roleSpec("evaluator"))
    expect(env).toEqual(REMOTE_WRITE_DENY_ENV)
  })

  test("bash:deny role (analyzer) gets no scrub — undefined, byte-identical to today", () => {
    expect(sandboxEnv(roleSpec("analyzer"))).toBeUndefined()
  })

  test("bash:deny role (designer) gets no scrub", () => {
    expect(sandboxEnv(roleSpec("designer"))).toBeUndefined()
  })

  test("never touches model-auth / API-key env vars (regression guard against over-scrubbing)", () => {
    const env = sandboxEnv(roleSpec("implementer"))!
    const keys = Object.keys(env)
    for (const k of keys) {
      expect(k).not.toMatch(/API_KEY/)
      expect(k).not.toMatch(/^ANTHROPIC_/)
      expect(k).not.toMatch(/^OPENROUTER_/)
    }
    expect(keys).not.toContain("HOME")
    expect(keys).not.toContain("PATH")
  })

  test("REMOTE_WRITE_DENY_ENV is the exact named set the deny-list test asserts (single source of truth)", () => {
    expect(Object.keys(REMOTE_WRITE_DENY_ENV).sort()).toEqual(
      ["GH_TOKEN", "GITHUB_TOKEN", "GIT_ASKPASS", "GIT_SSH_COMMAND", "GIT_TERMINAL_PROMPT", "SSH_ASKPASS", "SSH_AUTH_SOCK"].sort(),
    )
  })

  test("returns a fresh object each call (caller mutation can't leak back into the const)", () => {
    const a = sandboxEnv(roleSpec("implementer"))!
    a["GH_TOKEN"] = "mutated"
    const b = sandboxEnv(roleSpec("implementer"))!
    expect(b["GH_TOKEN"]).toBe("")
  })
})
