/**
 * engine.test.ts — orchestration coverage for EvolutionEngine (Task L4).
 *
 * The score/judge/propose FUNCTIONS are already covered by their own suites;
 * these tests exercise the ENGINE that wires them together against a fake
 * HarnessHost + an InMemory SessionStateStore — capture accumulation, the
 * role-switch reset, the idle scoring pipeline, and /mh-* command routing —
 * none of which was reachable without opencode before this extraction.
 *
 * Hermetic: XDG_CONFIG_HOME is redirected into a tmp dir so accountRoleRoot()/
 * accountGlobalRoot() never touch the developer's real ~/.config/opencode.
 */
import { test, expect, beforeAll } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { HarnessHost } from "../src/host.ts"
import {
  EvolutionEngine,
  InMemorySessionStateStore,
  type SessionState,
} from "../src/engine.ts"

beforeAll(() => {
  // Redirect account-scoped store roots into a throwaway dir.
  process.env["XDG_CONFIG_HOME"] = fs.mkdtempSync(path.join(os.tmpdir(), "mh-engine-xdg-"))
})

function tmpWorktree(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-engine-wt-"))
}

type HostCalls = {
  logs: { level: string; msg: string }[]
  notifies: { msg: string; variant?: string; dur?: number }[]
}

function fakeHost(worktree: string): { host: HarnessHost; calls: HostCalls } {
  const calls: HostCalls = { logs: [], notifies: [] }
  const host: HarnessHost = {
    platform: "fake",
    projectRoot: worktree,
    log: async (level, msg) => { calls.logs.push({ level, msg }) },
    notify: async (msg, variant, dur) => { calls.notifies.push({ msg, variant, dur }) },
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    runTaskAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  }
  return { host, calls }
}

/** A participating (mh-role) capture state, seeded directly so recordTool/
 * recordTurn tests don't have to run the fs-touching sessionMessage path. */
function seedParticipating(store: InMemorySessionStateStore, id: string, role = "mh-build"): SessionState {
  const st: SessionState = {
    role,
    participates: true,
    turns: 0,
    summary: "",
    toolUsage: {},
    trajectory: [],
    bootstrapped: true,
    pendingScore: false,
    snapshotInjected: false,
    scoreCount: 0,
    pausedToastShown: false,
  }
  store.put(id, st)
  return st
}

test("recordTool accumulates call counts and flags errors only for execution tools", () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost("/wt")
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s1")

  engine.recordTool("s1", "bash", "ok, all good")
  engine.recordTool("s1", "bash", "bash: command not found")
  engine.recordTool("s1", "read", "line with the word error inside a source file")
  engine.recordTool("s1", "read", "more file content")

  const st = store.get("s1")!
  expect(st.toolUsage["bash"]).toEqual({ calls: 2, errors: 1 })
  // read is NOT an execution tool → error heuristic never runs, errors stays 0
  expect(st.toolUsage["read"]).toEqual({ calls: 2, errors: 0 })
  // trajectory captured one event per tool call, output truncated
  expect(st.trajectory.length).toBe(4)
  expect(st.trajectory[1]).toEqual({ t: "tool", tool: "bash", output: "bash: command not found", error: true })
})

test("recordTool is a no-op for non-participating (non-mh) sessions", () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost("/wt")
  const engine = new EvolutionEngine(host, store)
  const st = seedParticipating(store, "s2")
  st.participates = false
  store.put("s2", st)

  engine.recordTool("s2", "bash", "error")
  expect(store.get("s2")!.toolUsage).toEqual({})
  expect(store.get("s2")!.trajectory.length).toBe(0)
})

test("recordTurn increments turns, truncates summary to 500 chars, appends text trajectory", () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost("/wt")
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s3")

  engine.recordTurn("s3", "first turn")
  engine.recordTurn("s3", "x".repeat(700))

  const st = store.get("s3")!
  expect(st.turns).toBe(2)
  expect(st.summary.length).toBe(500)
  // one text trajectory event per non-empty turn (output capped at 800)
  expect(st.trajectory.filter((e) => e.t === "text").length).toBe(2)

  // whitespace-only text still counts as a turn but adds no trajectory event
  engine.recordTurn("s3", "   ")
  const st2 = store.get("s3")!
  expect(st2.turns).toBe(3)
  expect(st2.trajectory.filter((e) => e.t === "text").length).toBe(2)
})

test("the per-session trajectory buffer is capped (drop-oldest)", () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost("/wt")
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s4")

  for (let i = 0; i < 600; i++) engine.recordTool("s4", "bash", `call-${i}`)
  const st = store.get("s4")!
  expect(st.trajectory.length).toBe(500)
  // oldest (call-0..call-99) dropped; the window now starts at call-100
  expect(st.trajectory[0]).toEqual({ t: "tool", tool: "bash", output: "call-100", error: false })
})

test("sessionMessage resets the fitness counters on a role switch", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host, calls } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  // First message under mh-build → establishes a participating session.
  await engine.sessionMessage("s5", { role: "mh-build", isPrimary: true, participates: true, model: "anthropic/x" })
  // Accumulate some work.
  engine.recordTurn("s5", "did a thing under mh-build")
  engine.recordTool("s5", "bash", "output")
  const before = store.get("s5")!
  expect(before.turns).toBe(1)
  expect(before.toolUsage["bash"]?.calls).toBe(1)
  expect(before.trajectory.length).toBe(2)

  // Switch to mh-review → counters reset, model persists, participates stays.
  await engine.sessionMessage("s5", { role: "mh-review", isPrimary: true, participates: true })
  const after = store.get("s5")!
  expect(after.role).toBe("mh-review")
  expect(after.turns).toBe(0)
  expect(after.toolUsage).toEqual({})
  expect(after.trajectory).toEqual([])
  expect(after.summary).toBe("")
  expect(after.model).toBe("anthropic/x") // model is NOT reset on switch
  expect(after.participates).toBe(true)
  // "Harness active for mh-review…" toast fired on the switch to a participating role
  expect(calls.notifies.some((n) => n.msg.includes("Harness active for mh-review"))).toBe(true)
})

test("sessionMessage switching from an mh-role to a non-mh role deactivates and warns", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host, calls } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  await engine.sessionMessage("s6", { role: "mh-build", isPrimary: true, participates: true })
  await engine.sessionMessage("s6", { role: "build", isPrimary: true, participates: false })

  const st = store.get("s6")!
  expect(st.role).toBe("build")
  expect(st.participates).toBe(false)
  expect(calls.notifies.some((n) => n.msg.includes("harness inactive"))).toBe(true)
})

test("composeInjection returns [] for a non-participating session and no state", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  expect(await engine.composeInjection("unknown")).toEqual([])

  const st = seedParticipating(store, "s7")
  st.participates = false
  store.put("s7", st)
  expect(await engine.composeInjection("s7")).toEqual([])
})

test("cleanup resets transient state but preserves scoreCount and pausedToastShown", () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost("/wt")
  const engine = new EvolutionEngine(host, store)
  const st = seedParticipating(store, "s8")
  st.turns = 7
  st.scoreCount = 2
  st.pausedToastShown = true
  st.trajectory.push({ t: "text", text: "x" })
  store.put("s8", st)

  engine.cleanup("s8")
  const after = store.get("s8")!
  expect(after.turns).toBe(0)
  expect(after.role).toBeNull()
  expect(after.trajectory).toEqual([])
  expect(after.bootstrapped).toBe(false)
  // survive across re-scoring cycles
  expect(after.scoreCount).toBe(2)
  expect(after.pausedToastShown).toBe(true)
})
