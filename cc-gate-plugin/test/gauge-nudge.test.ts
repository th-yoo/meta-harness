// cc-gate-plugin/test/gauge-nudge.test.ts
import { describe, test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { shouldConsiderPrompt, buildNudgeContext, decideNudge } from "../src/gauge/nudge.ts"
import { parseGateConfig } from "../src/config.ts"

describe("shouldConsiderPrompt (spec §5 prefilter, frozen at first firing)", () => {
  test("short prompts and slash commands never trigger", () => {
    expect(shouldConsiderPrompt("hi")).toBe(false)
    expect(shouldConsiderPrompt("/compact")).toBe(false)
    expect(shouldConsiderPrompt("/goal " + "x".repeat(200))).toBe(false)
  })
  test("long task-shaped prompts pass the prefilter", () => {
    expect(shouldConsiderPrompt("please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, "."))).toBe(true)
  })
})

describe("buildNudgeContext", () => {
  test("nudge asks for a measurable exit and names the channel ladder, never blocks", () => {
    const t = buildNudgeContext("C4")
    expect(t).toContain("measurable")
    expect(t).toContain("verifiable")
    expect(t.toLowerCase()).not.toContain("refuse")
    expect(t.toLowerCase()).not.toContain("block")
  })
})

describe("parseGateConfig: channelNudge flag (inert-by-default)", () => {
  test("explicit true parses to true", () => {
    const c = parseGateConfig(`{"check": "bun test", "channelNudge": true}`)
    expect(c!.channelNudge).toBe(true)
  })
  test("absent parses to undefined (flag off — existing behavior untouched)", () => {
    const c = parseGateConfig(`{"check": "bun test"}`)
    expect(c!.channelNudge).toBeUndefined()
  })
  test("non-boolean values are ignored (tolerant parse)", () => {
    const c = parseGateConfig(`{"check": "bun test", "channelNudge": "yes"}`)
    expect(c!.channelNudge).toBeUndefined()
  })
})

// ── T5b: decideNudge — the whole armed path over an injected transport.
// bun test NEVER makes a real model call: every transport below is a stub,
// and the spy counter proves the flag-off path never even reaches one.
const LONG_PROMPT =
  "please improve the overall quality of the data layer and make everything nicer across the app somehow".padEnd(120, ".")

describe("decideNudge (armed path, injected transport)", () => {
  test("flag off (false / absent cfg): transport is NEVER called, nothing returned", async () => {
    let calls = 0
    const transport = async () => {
      calls++
      return '{"channel":"C4","reason":null}'
    }
    expect(await decideNudge({ transport }, LONG_PROMPT, { channelNudge: false })).toBeUndefined()
    expect(await decideNudge({ transport }, LONG_PROMPT, {})).toBeUndefined()
    expect(await decideNudge({ transport }, LONG_PROMPT, undefined)).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("armed but prefilter miss (short / slash prompt): transport never called", async () => {
    let calls = 0
    const transport = async () => {
      calls++
      return '{"channel":"C4","reason":null}'
    }
    expect(await decideNudge({ transport }, "hi", { channelNudge: true })).toBeUndefined()
    expect(await decideNudge({ transport }, "/goal " + "x".repeat(200), { channelNudge: true })).toBeUndefined()
    expect(calls).toBe(0)
  })

  test("C4 verdict returns the nudge context; transport got the built channel prompt", async () => {
    let seen: string | undefined
    const transport = async (messageText: string) => {
      seen = messageText
      return '{"channel":"C4","reason":"no criterion"}'
    }
    const out = await decideNudge({ transport }, LONG_PROMPT, { channelNudge: true })
    expect(out).toBe(buildNudgeContext("C4"))
    expect(seen).toContain("<<<PROMPT")
    expect(seen).toContain(LONG_PROMPT)
  })

  test("C2/C3 verdicts return nothing (only the C4 tail nudges)", async () => {
    expect(
      await decideNudge({ transport: async () => '{"channel":"C2","reason":"criterion stated"}' }, LONG_PROMPT, { channelNudge: true }),
    ).toBeUndefined()
    expect(
      await decideNudge({ transport: async () => '{"channel":"C3","reason":null}' }, LONG_PROMPT, { channelNudge: true }),
    ).toBeUndefined()
  })

  test("malformed / empty transport output returns nothing (fail-open)", async () => {
    expect(await decideNudge({ transport: async () => "not json at all" }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
    expect(await decideNudge({ transport: async () => undefined }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })

  test("transport throw returns nothing (fail-open)", async () => {
    const transport = async (): Promise<string | undefined> => {
      throw new Error("connection refused")
    }
    expect(await decideNudge({ transport }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })

  test("timeout returns nothing (spec §5 budget; shrunk for test)", async () => {
    const never = () => new Promise<string | undefined>(() => {})
    expect(await decideNudge({ transport: never, timeoutMs: 10 }, LONG_PROMPT, { channelNudge: true })).toBeUndefined()
  })
})

// ── T5b integration: the real hook-cli.ts UserPromptSubmit branch. The
// flag-off run proves inertness (no stdout bytes added); the armed run
// points the SDK seam at an unreachable localhost port so NO real model
// call can happen and proves fail-open end-to-end.
const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")

async function runUps(repo: string, prompt: string, env?: Record<string, string>): Promise<{ stdout: string; exitCode: number }> {
  const fullEnv: Record<string, string> = { ...(process.env as Record<string, string>) }
  delete fullEnv.MH_CHILD
  delete fullEnv.KM_CHILD
  delete fullEnv.KKAMAK_DELIVERY
  if (env) Object.assign(fullEnv, env)
  const proc = Bun.spawn(["bun", HOOK_CLI, "UserPromptSubmit"], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: new TextEncoder().encode(JSON.stringify({ session_id: "sid-nudge", cwd: repo, prompt })),
    env: fullEnv,
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { stdout, exitCode }
}

describe("hook-cli UserPromptSubmit nudge wiring", () => {
  test("channelNudge absent: byte-identical inertness — no stdout, exit 0", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-nudge-"))
    try {
      fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "true" }))
      const r = await runUps(repo, LONG_PROMPT)
      expect(r.stdout).toBe("")
      expect(r.exitCode).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })

  test("armed but transport unreachable: fail-open — no stdout, exit 0, no real model call", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "cc-gate-nudge-"))
    try {
      fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify({ check: "true", channelNudge: true }))
      const r = await runUps(repo, LONG_PROMPT, {
        // Both seams set: auth never touches real credentials, base URL is a
        // dead local port — the SDK call fails fast and must be swallowed.
        KKAMAK_GAUGE_AUTH_TOKEN: "test-token-never-sent-anywhere-real",
        KKAMAK_GAUGE_SDK_BASE_URL: "http://127.0.0.1:9",
      })
      expect(r.stdout).toBe("")
      expect(r.exitCode).toBe(0)
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
