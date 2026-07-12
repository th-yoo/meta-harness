import { test, expect, beforeEach } from "bun:test"
import { OpencodeHost } from "../src/adapters/opencode-host.ts"
import { proposerSessions, judgeSessions } from "../src/session-state.ts"

// Token-free: exercises OpencodeHost's mapping onto a fake { client, $, worktree }
// trio with exact argument-shape assertions (session.create title, prompt
// parts/model/tools-false, toast variants/durations, judgeSessions/
// proposerSessions registration ORDERING relative to session.prompt — the
// load-bearing subtlety the system.transform hook depends on).

type Recorded = {
  logs: { service: string; level: string; message: string }[]
  toasts: { title?: string; message: string; variant?: string; duration?: number }[]
  clearPromptCount: number
  appendedTexts: string[]
  sessionCreateBodies: { title: string }[]
  sessionPromptCalls: {
    id: string
    body: unknown
    proposerRegisteredAtCallTime: boolean
    judgeRegisteredAtCallTime: boolean
  }[]
  execTemplateCmds: string[]
}

function fakeInput(opts: {
  sessionIds?: string[]
  promptReplyParts?: { type: string; text?: string }[]
  noSessionId?: boolean
} = {}) {
  const calls: Recorded = {
    logs: [], toasts: [], clearPromptCount: 0, appendedTexts: [],
    sessionCreateBodies: [], sessionPromptCalls: [], execTemplateCmds: [],
  }
  let counter = 0
  const ids = opts.sessionIds

  const client: any = {
    app: {
      log: async ({ body }: any) => { calls.logs.push(body) },
    },
    tui: {
      showToast: async ({ body }: any) => { calls.toasts.push(body) },
      clearPrompt: async () => { calls.clearPromptCount++ },
      appendPrompt: async ({ body }: any) => { calls.appendedTexts.push(body.text) },
    },
    session: {
      create: async ({ body }: any) => {
        calls.sessionCreateBodies.push(body)
        if (opts.noSessionId) return { data: {} }
        const id = ids ? ids[counter++] : `sess-${++counter}`
        return { data: { id } }
      },
      prompt: async ({ path, body }: any) => {
        calls.sessionPromptCalls.push({
          id: path.id,
          body,
          proposerRegisteredAtCallTime: proposerSessions.has(path.id),
          judgeRegisteredAtCallTime: judgeSessions.has(path.id),
        })
        return { data: { parts: opts.promptReplyParts ?? [{ type: "text", text: "ok" }] } }
      },
    },
  }

  const $ = (_strings: TemplateStringsArray, ...values: unknown[]) => {
    calls.execTemplateCmds.push(String(values[0]))
    const chain = {
      quiet: () => chain,
      nothrow: () => Promise.resolve({
        stdout: Buffer.from("stdout-here"),
        exitCode: 0,
      }),
    }
    return chain
  }

  const input: any = { client, $, worktree: "/proj/worktree" }
  return { input, calls }
}

beforeEach(() => {
  proposerSessions.clear()
  judgeSessions.clear()
})

// ── constructor / identity ──────────────────────────────────────────────

test("OpencodeHost exposes platform='opencode' and projectRoot=worktree", () => {
  const { input } = fakeInput()
  const host = new OpencodeHost(input)
  expect(host.platform).toBe("opencode")
  expect(host.projectRoot).toBe("/proj/worktree")
})

// ── log ──────────────────────────────────────────────────────────────────

test("log() calls client.app.log with service=meta-harness, same level/message", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  await host.log("warn", "something happened")
  expect(calls.logs).toEqual([{ service: "meta-harness", level: "warn", message: "something happened" }])
})

// ── notify ───────────────────────────────────────────────────────────────

test("notify() shows a toast titled Meta-Harness with the given variant/duration", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  await host.notify("proposing v2", "info", 5_000)
  expect(calls.toasts).toEqual([{ title: "Meta-Harness", message: "proposing v2", variant: "info", duration: 5_000 }])
})

test("notify() defaults variant=info, duration=5000 when omitted", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  await host.notify("plain message")
  expect(calls.toasts[0]).toEqual({ title: "Meta-Harness", message: "plain message", variant: "info", duration: 5_000 })
})

// ── showScorePrompt ──────────────────────────────────────────────────────

test("showScorePrompt: default (non-judge) toast copy, then clearPrompt, then appendPrompt with text", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  await host.showScorePrompt("/mh-score good", false)

  expect(calls.toasts).toEqual([{
    title: "Meta-Harness: rate this session",
    message: "Type /mh-score good  or  /mh-score bad",
    variant: "info",
    duration: 30_000,
  }])
  expect(calls.clearPromptCount).toBe(1)
  expect(calls.appendedTexts).toEqual(["/mh-score good"])
})

test("showScorePrompt: judge-suggestion toast copy flags it as editable", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  await host.showScorePrompt("/mh-score bad judge: looked wrong", true)

  expect(calls.toasts[0]?.message).toBe("Type /mh-score good  or  /mh-score bad (judge suggestion — edit if wrong)")
  expect(calls.appendedTexts).toEqual(["/mh-score bad judge: looked wrong"])
})

// ── runTextAgent (judge transport) ──────────────────────────────────────

test("runTextAgent: creates the session with the given title, registers BOTH proposerSessions and judgeSessions BEFORE prompting, sends parts+model+tools-all-false, and cleans up after", async () => {
  const { input, calls } = fakeInput({ sessionIds: ["judge-sess-1"], promptReplyParts: [{ type: "text", text: '{"passed":true}' }] })
  const host = new OpencodeHost(input)
  const model = { providerID: "anthropic", modelID: "claude-x" }

  const text = await host.runTextAgent({
    title: "[meta-harness] judge sess-42",
    system: "you are the judge",
    prompt: "judge this session",
    model,
  })

  expect(text).toBe('{"passed":true}')
  expect(calls.sessionCreateBodies).toEqual([{ title: "[meta-harness] judge sess-42" }])
  expect(calls.sessionPromptCalls).toHaveLength(1)
  const call = calls.sessionPromptCalls[0]!
  expect(call.id).toBe("judge-sess-1")
  // Load-bearing ordering: both Sets must already contain the session id
  // WHEN session.prompt is invoked, so index.ts's system.transform hook
  // (which reads judgeSessions synchronously) sees the membership.
  expect(call.proposerRegisteredAtCallTime).toBe(true)
  expect(call.judgeRegisteredAtCallTime).toBe(true)
  expect(call.body).toEqual({
    parts: [{ type: "text", text: "judge this session" }],
    model,
    tools: {
      bash: false, read: false, grep: false, glob: false, list: false,
      edit: false, write: false, patch: false,
      webfetch: false, websearch: false,
      task: false, todowrite: false, todoread: false, skill: false,
    },
  })
  // Cleanup: both Sets no longer contain the session id after the call resolves.
  expect(proposerSessions.has("judge-sess-1")).toBe(false)
  expect(judgeSessions.has("judge-sess-1")).toBe(false)
})

test("runTextAgent: omits the model field entirely when no model is given", async () => {
  const { input, calls } = fakeInput({ sessionIds: ["judge-sess-2"] })
  const host = new OpencodeHost(input)
  await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(calls.sessionPromptCalls[0]!.body).not.toHaveProperty("model")
})

test("runTextAgent: joins multiple text parts and skips non-text parts", async () => {
  const { input } = fakeInput({
    sessionIds: ["judge-sess-3"],
    promptReplyParts: [{ type: "text", text: "line one" }, { type: "tool" }, { type: "text", text: "line two" }],
  })
  const host = new OpencodeHost(input)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  // Non-text parts map to "" but still occupy a slot in the join (matches the
  // pre-extraction judge.ts behavior exactly).
  expect(text).toBe("line one\n\nline two")
})

test("runTextAgent: returns null (without touching the Sets) when session.create yields no id", async () => {
  const { input, calls } = fakeInput({ noSessionId: true })
  const host = new OpencodeHost(input)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(calls.sessionPromptCalls).toHaveLength(0)
  expect(proposerSessions.size).toBe(0)
  expect(judgeSessions.size).toBe(0)
})

test("runTextAgent: an exception from session.prompt returns null and still cleans up the Sets", async () => {
  const { input } = fakeInput({ sessionIds: ["judge-sess-err"] })
  input.client.session.prompt = async ({ path }: any) => {
    // Sets must be registered before the throw too.
    expect(proposerSessions.has(path.id)).toBe(true)
    expect(judgeSessions.has(path.id)).toBe(true)
    throw new Error("boom")
  }
  const host = new OpencodeHost(input)
  const text = await host.runTextAgent({ title: "t", system: "s", prompt: "p" })
  expect(text).toBeNull()
  expect(proposerSessions.has("judge-sess-err")).toBe(false)
  expect(judgeSessions.has("judge-sess-err")).toBe(false)
})

// ── runTaskAgent (proposer/promoter/curator transport) ──────────────────

test("runTaskAgent: creates the session with the given title, registers proposerSessions BEFORE prompting, sends parts+model (NO tools field), and does NOT unregister (caller owns that after waitForFile)", async () => {
  const { input, calls } = fakeInput({ sessionIds: ["proposer-sess-1"] })
  const host = new OpencodeHost(input)
  const model = { providerID: "openrouter", modelID: "some-model" }

  const result = await host.runTaskAgent({
    title: "[meta-harness] project-role v3",
    prompt: "propose a system.md",
    model,
  })

  expect(result).toEqual({ id: "proposer-sess-1" })
  expect(calls.sessionCreateBodies).toEqual([{ title: "[meta-harness] project-role v3" }])
  const call = calls.sessionPromptCalls[0]!
  expect(call.id).toBe("proposer-sess-1")
  expect(call.proposerRegisteredAtCallTime).toBe(true)
  expect(call.body).toEqual({
    parts: [{ type: "text", text: "propose a system.md" }],
    model,
  })
  expect((call.body as any)).not.toHaveProperty("tools")
  // Unlike runTextAgent, runTaskAgent leaves the session registered — the
  // caller (propose.ts) deletes it itself once waitForFile settles.
  expect(proposerSessions.has("proposer-sess-1")).toBe(true)
  expect(judgeSessions.has("proposer-sess-1")).toBe(false)
})

test("runTaskAgent: omits the model field entirely when no model is given", async () => {
  const { input, calls } = fakeInput({ sessionIds: ["proposer-sess-2"] })
  const host = new OpencodeHost(input)
  await host.runTaskAgent({ title: "t", prompt: "p" })
  expect(calls.sessionPromptCalls[0]!.body).toEqual({ parts: [{ type: "text", text: "p" }] })
})

test("runTaskAgent: returns null and never registers/prompts when session.create yields no id", async () => {
  const { input, calls } = fakeInput({ noSessionId: true })
  const host = new OpencodeHost(input)
  const result = await host.runTaskAgent({ title: "t", prompt: "p" })
  expect(result).toBeNull()
  expect(calls.sessionPromptCalls).toHaveLength(0)
  expect(proposerSessions.size).toBe(0)
})

// ── exec ─────────────────────────────────────────────────────────────────

test("exec() runs `bash -c <cmd>` via $, quiet+nothrow, and returns stdout/exitCode", async () => {
  const { input, calls } = fakeInput()
  const host = new OpencodeHost(input)
  const result = await host.exec("echo hi && pwd")
  expect(calls.execTemplateCmds).toEqual(["echo hi && pwd"])
  expect(result).toEqual({ stdout: "stdout-here", exitCode: 0 })
})
