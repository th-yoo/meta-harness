/**
 * p2-a4-review.test.ts — TDD for src/bench/p2/a4-review.ts: the A4 arm's
 * host-side haiku review of a completed attempt + reinject-prompt builder
 * (task-3-brief.md, plan §Task 3).
 *
 * Written FIRST, failing (src/bench/p2/a4-review.ts does not exist yet).
 *
 * `runA4Review` is exercised entirely via INJECTED fake `call`/`ensure`/
 * `close` functions (the brief's `deps` seam) — no real socket, no fake
 * daemon, zero model spend. That live call is only exercised in Task
 * 8-equivalent runs.
 *
 * F2 note: all doneCheck/bashCommands/workspaceFiles/reviewer-text strings
 * below are synthetic fixtures invented for this test, never a real bench
 * transcript.
 */
import { test, expect } from "bun:test"
import {
  A4_MODEL,
  A4_TURN_CAP,
  buildA4ReviewPrompt,
  parseA4Review,
  buildReinjectInstruction,
  runA4Review,
} from "../src/bench/p2/a4-review.ts"
import { P2_RULE_TEXT } from "../src/bench/p2/rule.ts"
import type { DaemonOutcome } from "@th-yoo/cc-api-daemon"

// ── constants ────────────────────────────────────────────────────────────

test("A4_MODEL is the plan's frozen A4 review model", () => {
  expect(A4_MODEL).toBe("claude-haiku-4-5")
})

test("A4_TURN_CAP is the plan's frozen re-pass turn cap", () => {
  expect(A4_TURN_CAP).toBe(10)
})

// ── buildA4ReviewPrompt ──────────────────────────────────────────────────

test("buildA4ReviewPrompt: contains the frozen rule text verbatim", () => {
  const prompt = buildA4ReviewPrompt({ doneCheck: "ran: bun test x", bashCommands: ["bun test x"], workspaceFiles: ["main.py"] })
  expect(prompt).toContain(P2_RULE_TEXT)
})

test("buildA4ReviewPrompt: includes DONE-CHECK content when present", () => {
  const prompt = buildA4ReviewPrompt({
    doneCheck: "I ran pytest -q and it passed",
    bashCommands: ["pytest -q"],
    workspaceFiles: ["app.py"],
  })
  expect(prompt).toContain("I ran pytest -q and it passed")
})

test("buildA4ReviewPrompt: DONE-CHECK absent (undefined) renders as \"absent\", not \"undefined\"", () => {
  const prompt = buildA4ReviewPrompt({ doneCheck: undefined, bashCommands: [], workspaceFiles: [] })
  expect(prompt).toContain("absent")
  expect(prompt).not.toContain("undefined")
})

test("buildA4ReviewPrompt: lists every bash command", () => {
  const prompt = buildA4ReviewPrompt({
    doneCheck: "x",
    bashCommands: ["ls /app", "bun test x.test.ts", "git status"],
    workspaceFiles: [],
  })
  expect(prompt).toContain("ls /app")
  expect(prompt).toContain("bun test x.test.ts")
  expect(prompt).toContain("git status")
})

test("buildA4ReviewPrompt: lists every workspace file", () => {
  const prompt = buildA4ReviewPrompt({
    doneCheck: "x",
    bashCommands: [],
    workspaceFiles: ["main.py", "test_main.py", "DONE-CHECK.txt"],
  })
  expect(prompt).toContain("main.py")
  expect(prompt).toContain("test_main.py")
  expect(prompt).toContain("DONE-CHECK.txt")
})

test("buildA4ReviewPrompt: demands strict JSON with complied + requiredEdits fields", () => {
  const prompt = buildA4ReviewPrompt({ doneCheck: undefined, bashCommands: [], workspaceFiles: [] })
  expect(prompt).toContain("complied")
  expect(prompt).toContain("requiredEdits")
})

test("buildA4ReviewPrompt: same evidence -> byte-identical prompt (frozen/deterministic, so a sha can be recorded)", () => {
  const evidence = { doneCheck: "ran: x", bashCommands: ["x"], workspaceFiles: ["y"] }
  expect(buildA4ReviewPrompt(evidence)).toBe(buildA4ReviewPrompt({ ...evidence }))
})

// ── parseA4Review ────────────────────────────────────────────────────────

test("parseA4Review: bare JSON, complied true, empty requiredEdits", () => {
  const text = '{"complied": true, "requiredEdits": []}'
  expect(parseA4Review(text)).toEqual({ complied: true, requiredEdits: [] })
})

test("parseA4Review: bare JSON, complied false with requiredEdits", () => {
  const text = '{"complied": false, "requiredEdits": ["write DONE-CHECK.txt", "run the tests"]}'
  expect(parseA4Review(text)).toEqual({ complied: false, requiredEdits: ["write DONE-CHECK.txt", "run the tests"] })
})

test("parseA4Review: fenced JSON (```json ... ```) is unwrapped", () => {
  const text = '```json\n{"complied": false, "requiredEdits": ["x"]}\n```'
  expect(parseA4Review(text)).toEqual({ complied: false, requiredEdits: ["x"] })
})

test("parseA4Review: bare fence (``` ... ``` with no language tag) is unwrapped", () => {
  const text = '```\n{"complied": true, "requiredEdits": []}\n```'
  expect(parseA4Review(text)).toEqual({ complied: true, requiredEdits: [] })
})

test("parseA4Review: junk (not JSON at all) -> undefined", () => {
  expect(parseA4Review("I think it complied, no JSON here")).toBeUndefined()
})

test("parseA4Review: empty string -> undefined", () => {
  expect(parseA4Review("")).toBeUndefined()
})

test("parseA4Review: valid JSON but wrong shape (missing complied) -> undefined", () => {
  expect(parseA4Review('{"requiredEdits": []}')).toBeUndefined()
})

test("parseA4Review: valid JSON but wrong shape (complied not boolean) -> undefined", () => {
  expect(parseA4Review('{"complied": "yes", "requiredEdits": []}')).toBeUndefined()
})

test("parseA4Review: valid JSON but wrong shape (requiredEdits not an array) -> undefined", () => {
  expect(parseA4Review('{"complied": false, "requiredEdits": "fix it"}')).toBeUndefined()
})

test("parseA4Review: valid JSON but requiredEdits array has a non-string entry -> undefined", () => {
  expect(parseA4Review('{"complied": false, "requiredEdits": ["ok", 5]}')).toBeUndefined()
})

test("parseA4Review: valid JSON array (not object) -> undefined", () => {
  expect(parseA4Review('["complied", true]')).toBeUndefined()
})

test("parseA4Review: valid JSON null -> undefined", () => {
  expect(parseA4Review("null")).toBeUndefined()
})

// ── buildReinjectInstruction ─────────────────────────────────────────────

test("buildReinjectInstruction: contains the frozen rule text verbatim", () => {
  const instruction = buildReinjectInstruction(["write the DONE-CHECK file"])
  expect(instruction).toContain(P2_RULE_TEXT)
})

test("buildReinjectInstruction: numbers the required edits in order", () => {
  const instruction = buildReinjectInstruction(["run the tests", "write DONE-CHECK.txt", "fix the off-by-one"])
  const iRun = instruction.indexOf("1. run the tests")
  const iWrite = instruction.indexOf("2. write DONE-CHECK.txt")
  const iFix = instruction.indexOf("3. fix the off-by-one")
  expect(iRun).toBeGreaterThanOrEqual(0)
  expect(iWrite).toBeGreaterThan(iRun)
  expect(iFix).toBeGreaterThan(iWrite)
})

test("buildReinjectInstruction: empty requiredEdits still produces a well-formed instruction (no crash, still carries the rule)", () => {
  const instruction = buildReinjectInstruction([])
  expect(instruction).toContain(P2_RULE_TEXT)
  expect(instruction.length).toBeGreaterThan(P2_RULE_TEXT.length)
})

// ── runA4Review (fake deps only — zero live calls) ──────────────────────

const ENV: Record<string, string | undefined> = { KKAMAK_ACP_TEST_MARKER: "p2-a4-review-test" }
const EVIDENCE = { doneCheck: "ran: bun test x -> 3 pass", bashCommands: ["bun test x"], workspaceFiles: ["main.py"] }

function okOutcome(text: string, opts: Partial<Extract<DaemonOutcome, { kind: "ok" }>> = {}): DaemonOutcome {
  return { kind: "ok", text, model: A4_MODEL, canonicalModel: "", sessionId: "sess-1", ...opts }
}

test("runA4Review: full ok path -> parsed review returned, deps invoked with expected args", async () => {
  const calls: unknown[] = []
  const ensured: unknown[] = []
  const closed: unknown[] = []
  const deps = {
    ensure: async (env: Record<string, string | undefined>, opts?: { waitMs?: number }) => {
      ensured.push({ env, opts })
      return true
    },
    call: async (outgoingText: string, model: string, env: Record<string, string | undefined>, opts: unknown) => {
      calls.push({ outgoingText, model, env, opts })
      return okOutcome('{"complied": false, "requiredEdits": ["write DONE-CHECK.txt"]}')
    },
    close: async (sessionId: string, env: Record<string, string | undefined>) => {
      closed.push({ sessionId, env })
      return { closed: true }
    },
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toEqual({ complied: false, requiredEdits: ["write DONE-CHECK.txt"] })

  // ensure called zero-wait
  expect(ensured).toHaveLength(1)
  expect((ensured[0] as { opts?: { waitMs?: number } }).opts?.waitMs).toBe(0)

  // daemonCall invoked with the review prompt, A4_MODEL, and the frozen isolation
  expect(calls).toHaveLength(1)
  const call0 = calls[0] as { outgoingText: string; model: string }
  expect(call0.model).toBe(A4_MODEL)
  expect(call0.outgoingText).toBe(buildA4ReviewPrompt(EVIDENCE))
})

test("runA4Review: close called with the outcome's sessionId on ok", async () => {
  const closed: Array<{ sessionId: string }> = []
  const deps = {
    ensure: async () => true,
    call: async () => okOutcome('{"complied": true, "requiredEdits": []}', { sessionId: "sess-xyz" }),
    close: async (sessionId: string) => {
      closed.push({ sessionId })
      return { closed: true }
    },
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toEqual({ complied: true, requiredEdits: [] })
  expect(closed).toEqual([{ sessionId: "sess-xyz" }])
})

test("runA4Review: modelProvenBy fails (evidence for a different model) -> undefined", async () => {
  const deps = {
    ensure: async () => true,
    call: async () => okOutcome('{"complied": true, "requiredEdits": []}', { model: "claude-opus-4-1", canonicalModel: "" }),
    close: async () => ({ closed: true }),
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toBeUndefined()
})

test("runA4Review: reviewer text is junk (fails parseA4Review) -> undefined", async () => {
  const deps = {
    ensure: async () => true,
    call: async () => okOutcome("not json at all"),
    close: async () => ({ closed: true }),
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toBeUndefined()
})

test("runA4Review: pool-exhausted (daemon no-call) -> undefined, no close attempted (no session)", async () => {
  const closed: unknown[] = []
  const deps = {
    ensure: async () => true,
    call: async (): Promise<DaemonOutcome> => ({ kind: "no-call" }),
    close: async (sessionId: string) => {
      closed.push(sessionId)
      return { closed: true }
    },
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toBeUndefined()
  expect(closed).toEqual([])
})

test("runA4Review: call-consumed (post-send ambiguity) -> undefined", async () => {
  const deps = {
    ensure: async () => true,
    call: async (): Promise<DaemonOutcome> => ({ kind: "call-consumed" }),
    close: async () => ({ closed: true }),
  }
  const result = await runA4Review(EVIDENCE, ENV, deps)
  expect(result).toBeUndefined()
})

test("runA4Review: ensure/call throwing is caught -> undefined, never throws (interface law)", async () => {
  const deps = {
    ensure: async () => {
      throw new Error("boom")
    },
    call: async (): Promise<DaemonOutcome> => okOutcome('{"complied": true, "requiredEdits": []}'),
    close: async () => ({ closed: true }),
  }
  await expect(runA4Review(EVIDENCE, ENV, deps)).resolves.toBeUndefined()
})

// Deliberately NOT tested: calling `runA4Review` with no `deps` at all.
// Doing so would exercise the REAL `ensureDaemon`/`daemonCall` (a probe
// miss can take the spawn lock and fork a real daemon process) — the
// brief's "no live calls in tests" / "zero model calls in this task"
// constraints rule that out. `deps` defaulting to the real imports is
// covered by type-checking (the default-parameter values themselves,
// verified by `tsc`), not by executing them.
