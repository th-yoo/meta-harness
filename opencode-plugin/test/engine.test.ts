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
 * accountGlobalRoot() never touch the developer's real ~/.config/meta-harness.
 * This actually WORKS now (Task L5's lazy accountMetaRoot()) — pre-L5, the
 * account root was an import-time constant, so a beforeAll env stub here
 * would have been silently too late (the L2-era bug this task fixed).
 */
import { test, expect, beforeAll } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { HarnessHost } from "../src/host.ts"
import {
  projectRoleRoot,
  projectGlobalRoot,
  accountGlobalRoot,
  readScore,
  activeVersion,
  bootstrapStore,
  DEFAULT_SYSTEM_PROMPT,
  createCandidate,
  writeActive,
  recordSession,
  candidatePath,
} from "../src/harness-store.ts"
import { handleScoreCommand } from "../src/score.ts"
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
  notifies: { msg: string; variant?: string; dur?: number; title?: string | null }[]
}

function fakeHost(worktree: string): { host: HarnessHost; calls: HostCalls } {
  const calls: HostCalls = { logs: [], notifies: [] }
  const host: HarnessHost = {
    platform: "fake",
    projectRoot: worktree,
    log: async (level, msg) => { calls.logs.push({ level, msg }) },
    notify: async (msg, variant, dur, title) => { calls.notifies.push({ msg, variant, dur, title }) },
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    runTaskAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  }
  return { host, calls }
}

/** Bootstrap the two non-role store layers (sessionMessage bootstraps the role
 * layers itself) so recordSession has all 4 roots to write into. */
function bootstrapProjectStores(worktree: string): void {
  bootstrapStore(projectGlobalRoot(worktree), DEFAULT_SYSTEM_PROMPT)
  bootstrapStore(accountGlobalRoot(), "")
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

  expect(await engine.composeInjection("unknown")).toEqual({ blocks: [] })

  const st = seedParticipating(store, "s7")
  st.participates = false
  store.put("s7", st)
  expect(await engine.composeInjection("s7")).toEqual({ blocks: [] })
})

test("sessionIdle skips a degenerate session without recording a score", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host, calls } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)
  bootstrapProjectStores(worktree)

  // First message under mh-build → participating, bootstrapped, turns=0.
  await engine.sessionMessage("d1", { role: "mh-build", isPrimary: true, participates: true, model: "anthropic/x" })
  const outcome = await engine.sessionIdle("d1") // turns===0 → degenerate
  expect(outcome).toBe("skipped-degenerate") // F3

  const prRoot = projectRoleRoot(worktree, "mh-build")
  expect(readScore(prRoot, activeVersion(prRoot)).sessions.length).toBe(0)
  const skip = calls.notifies.find((n) => n.msg.includes("session skipped"))
  expect(skip).toBeDefined()
  expect(skip!.title).toBeNull() // title-less toast (branding embedded in message)
})

// F3: sessionIdle's outcome return value, exercised directly (not-active,
// pending) — dispatch-level coverage of the resulting block messages lives
// in cc-dispatch.test.ts; this proves the engine-level contract the opencode
// adapter also relies on (it just ignores the return value — no behavior
// change there, per the existing happy-path/degenerate tests above/below).
test("sessionIdle returns 'not-active' for an unknown/untracked session, and 'pending' when a pendingScore wedge is set", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  expect(await engine.sessionIdle("no-such-session")).toBe("not-active")

  const st = seedParticipating(store, "pend1")
  st.bootstrapped = true
  st.pendingScore = true
  store.put("pend1", st)
  expect(await engine.sessionIdle("pend1")).toBe("pending")
})

test("sessionIdle happy path writes a SessionRecord stamped with the host platform", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host, calls } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)
  bootstrapProjectStores(worktree)

  await engine.sessionMessage("h1", { role: "mh-build", isPrimary: true, participates: true, model: "anthropic/claude-x" })
  // Make the session substantive so it isn't filtered as degenerate.
  const st = store.get("h1")!
  st.turns = 2
  st.summary = "implemented the feature and verified it end to end with tests"
  st.toolUsage = { bash: { calls: 3, errors: 0 } }
  st.trajectory = [{ t: "text", text: "work" }]
  store.put("h1", st)

  // Drive the human score: sessionIdle awaits promptHumanScore (score.ts's
  // pending map), which handleScoreCommand resolves.
  const idle = engine.sessionIdle("h1")
  await new Promise((r) => setTimeout(r, 10))
  handleScoreCommand("mh-score", "good extra note", "h1")
  expect(await idle).toBe("recorded") // F3

  const prRoot = projectRoleRoot(worktree, "mh-build")
  const score = readScore(prRoot, activeVersion(prRoot))
  expect(score.sessions.length).toBe(1)
  expect(score.sessions[0]!.passed).toBe(true)
  expect(score.sessions[0]!.note).toBe("extra note")
  expect(score.sessions[0]!.platform).toBe("fake") // == host.platform
  expect(score.sessions[0]!.model).toBe("anthropic/claude-x")

  // Score-recorded toast is title-less; session state was cleaned up.
  const rec = calls.notifies.find((n) => n.msg.startsWith("Score recorded:"))
  expect(rec).toBeDefined()
  expect(rec!.title).toBeNull()
  expect(store.get("h1")!.role).toBeNull() // cleanup() ran
})

test("sessionIdle folds a configured judgeModel's verdict into record.judge (host.runTextAgent wired = judge flows end to end)", async () => {
  // judge.ts/engine.ts are platform-neutral — they only ever see the
  // HarnessHost interface. This proves that ANY host whose runTextAgent
  // replies with the judge's inline JSON verdict (which is exactly what
  // ClaudeCodeHost.runTextAgent — Task L7's `claude -p` transport — now
  // does) makes the full shadow-judge pipeline flow: verdict parsed,
  // agreement computed against the human score, folded into the recorded
  // SessionRecord. cc-host.test.ts covers the CC-specific transport
  // mechanics (argv/isolation/timeout/parsing); this is the "wired up"
  // proof at the engine level the L7 brief asked for.
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  host.runTextAgent = async () => JSON.stringify({ passed: true, confidence: 0.95, reasoning: "looks solid" })
  const engine = new EvolutionEngine(host, store)
  bootstrapProjectStores(worktree)

  // sessionIdle only invokes runJudge when judgeModel is configured — seed
  // it via the same META_HARNESS_HOME test seam judge-calibration.test.ts /
  // harness-store-account-root.test.ts use, scoped to this test only.
  const savedHome = process.env["META_HARNESS_HOME"]
  const judgeHome = fs.mkdtempSync(path.join(os.tmpdir(), "mh-engine-judge-cfg-"))
  process.env["META_HARNESS_HOME"] = judgeHome
  try {
    fs.writeFileSync(path.join(judgeHome, "config.json"), JSON.stringify({ judgeModel: "anthropic/claude-sonnet-4-5" }))

    await engine.sessionMessage("j1", { role: "mh-build", isPrimary: true, participates: true, model: "anthropic/claude-x" })
    const st = store.get("j1")!
    st.turns = 2
    st.summary = "implemented the feature and verified it end to end with tests"
    st.toolUsage = { bash: { calls: 3, errors: 0 } }
    st.trajectory = [{ t: "text", text: "work" }]
    store.put("j1", st)

    const idle = engine.sessionIdle("j1")
    await new Promise((r) => setTimeout(r, 10))
    handleScoreCommand("mh-score", "good extra note", "j1")
    await idle

    const prRoot = projectRoleRoot(worktree, "mh-build")
    const score = readScore(prRoot, activeVersion(prRoot))
    expect(score.sessions.length).toBe(1)
    expect(score.sessions[0]!.judge).toEqual({
      passed: true,
      confidence: 0.95,
      mode: "shadow",
      agreed: true, // judge.passed===true === human result.passed===true
      trivial: false,
    })
  } finally {
    if (savedHome === undefined) delete process.env["META_HARNESS_HOME"]
    else process.env["META_HARNESS_HOME"] = savedHome
    fs.rmSync(judgeHome, { recursive: true, force: true })
  }
})

test("handleCommand routes /mh-score to a throw-only (no toast) swallow", async () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(tmpWorktree())
  const engine = new EvolutionEngine(host, store)
  const r = await engine.handleCommand("mh-score", "good nice work", "c1")
  expect(r).toEqual({
    consumed: true,
    kind: "throw",
    message: "Meta-Harness: score recorded ✓ (this notice is expected)",
  })
})

test("handleCommand /mh-status: 'no message yet' for an unknown session; 'scoring ON' for a participating one", async () => {
  const worktree = tmpWorktree()
  bootstrapProjectStores(worktree)
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const unknown = await engine.handleCommand("mh-status", "", "nope")
  expect(unknown.consumed).toBe(true)
  if (!(unknown.consumed && unknown.kind === "toast")) throw new Error("expected toast")
  expect(unknown.variant).toBe("info")
  expect(unknown.duration).toBe(15_000)
  expect(unknown.message).toContain("no message yet")

  await engine.sessionMessage("live", { role: "mh-build", isPrimary: true, participates: true })
  const live = await engine.handleCommand("mh-status", "", "live")
  if (!(live.consumed && live.kind === "toast")) throw new Error("expected toast")
  expect(live.message).toContain("agent=mh-build, scoring ON")
})

test("handleCommand /mh-propose with an unknown scope returns an error toast", async () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(tmpWorktree())
  const engine = new EvolutionEngine(host, store)
  const r = await engine.handleCommand("mh-propose", "bogus", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("error")
  expect(r.message).toContain(`unknown scope "bogus"`)
})

// ── /mh-activate budget-identity gate (Loop-3 T6) ─────────────────────────
//
// Seeds the account-global layer's ACTIVE version with a baseline session
// carrying a budget-identity env stamp, plus a CANDIDATE version's
// ab-verdict.json — hand-written (not driven through a real cmdAb) since
// this suite exercises the ENGINE's activation gate, not cmd-ab.ts's verdict
// stamping (covered separately in bench-cmd-ab.test.ts).

function seedActiveBudget(
  root: string,
  version: string,
  opts: { maxAgentTimeout?: number; resourceEnforcement?: boolean; timeoutRecording?: boolean },
): void {
  createCandidate(root, version, "active sys")
  writeActive(root, version, "active sys")
  recordSession(root, version, {
    sessionID: `s-${version}`,
    passed: true,
    note: "",
    turnCount: 3,
    timestamp: new Date().toISOString(),
    summary: "seed baseline session",
    model: "m",
    variant: "",
    toolUsage: {},
    env: { maxAgentTimeout: opts.maxAgentTimeout, resourceEnforcement: opts.resourceEnforcement ?? false },
  })
  // Only the ACTIVE version's own ab-verdict.json (if any) carries
  // timeoutRecording — it's not part of the per-session env block (see
  // readActiveBudget's doc in harness-store.ts).
  if (opts.timeoutRecording !== undefined) {
    fs.writeFileSync(
      candidatePath(root, version, "ab-verdict.json"),
      JSON.stringify({
        winner: "candidate",
        candidateRate: 1,
        activeRate: 0,
        nTasks: 1,
        timestamp: new Date().toISOString(),
        decision: "accept",
        maxAgentTimeout: opts.maxAgentTimeout,
        timeoutRecording: opts.timeoutRecording,
        env: { resourceEnforcement: opts.resourceEnforcement ?? false },
      }),
    )
  }
}

function seedCandidateVerdict(root: string, version: string, overrides: Record<string, unknown> = {}): void {
  createCandidate(root, version, "candidate sys")
  fs.writeFileSync(
    candidatePath(root, version, "ab-verdict.json"),
    JSON.stringify({
      winner: "candidate",
      candidateRate: 1,
      activeRate: 0,
      nTasks: 1,
      timestamp: new Date().toISOString(),
      decision: "accept",
      ...overrides,
    }),
  )
}

test("handleCommand /mh-activate: refuses on maxAgentTimeout budget mismatch (no --force)", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", { maxAgentTimeout: 600, resourceEnforcement: false })
  seedCandidateVerdict(root, "v2", { maxAgentTimeout: 900, timeoutRecording: false, env: { resourceEnforcement: false } })

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("error")
  expect(r.message).toContain("maxAgentTimeout")
  expect(r.message).toContain("600")
  expect(r.message).toContain("900")
  expect(activeVersion(root)).toBe("v1") // refused — not activated
})

test("handleCommand /mh-activate: refuses on resourceEnforcement mismatch (no --force)", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", { maxAgentTimeout: 600, resourceEnforcement: false })
  seedCandidateVerdict(root, "v2", { maxAgentTimeout: 600, timeoutRecording: false, env: { resourceEnforcement: true } })

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("error")
  expect(r.message).toContain("resourceEnforcement")
  expect(activeVersion(root)).toBe("v1") // refused — not activated
})

test("handleCommand /mh-activate: --force overrides a budget-identity mismatch", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", { maxAgentTimeout: 600, resourceEnforcement: false })
  seedCandidateVerdict(root, "v2", { maxAgentTimeout: 900, timeoutRecording: false, env: { resourceEnforcement: false } })

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2 --force", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("success")
  expect(activeVersion(root)).toBe("v2")
})

test("handleCommand /mh-activate: matching budget-identity (600/600, same flags) activates without --force", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", { maxAgentTimeout: 600, resourceEnforcement: false })
  seedCandidateVerdict(root, "v2", { maxAgentTimeout: 600, timeoutRecording: false, env: { resourceEnforcement: false } })

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("success")
  expect(activeVersion(root)).toBe("v2")
})

// Loop-3 pre-flip fix #3: when the ACTIVE baseline has no recorded budget at
// all (readActiveBudget returns maxAgentTimeout: undefined — e.g. its
// sessions predate any env-carrying record) but the CANDIDATE verdict does,
// the generic per-field mismatch message renders cryptically ("... vs
// undefined ..."). This case gets its own actionable wording instead.
test("handleCommand /mh-activate: active baseline has NO recorded budget -> actionable toast, not 'vs undefined'", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", {}) // no maxAgentTimeout recorded on the active baseline at all
  seedCandidateVerdict(root, "v2", { maxAgentTimeout: 900, timeoutRecording: false, env: { resourceEnforcement: false } })

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("error")
  expect(r.message).not.toContain("undefined")
  expect(r.message).toContain("no recorded budget-identity")
  expect(r.message).toContain("re-baseline")
  expect(r.message).toContain("--force")
  expect(activeVersion(root)).toBe("v1") // refused — not activated
})

test("handleCommand /mh-activate: pre-Loop-3 verdict (no maxAgentTimeout field) still activates without --force (back-compat)", async () => {
  const worktree = tmpWorktree()
  const root = accountGlobalRoot()
  seedActiveBudget(root, "v1", { maxAgentTimeout: 600, resourceEnforcement: false })
  seedCandidateVerdict(root, "v2") // no maxAgentTimeout/timeoutRecording/env at all — pre-Loop-3 shape

  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const r = await engine.handleCommand("mh-activate", "account v2", "s")
  if (!(r.consumed && r.kind === "toast")) throw new Error("expected toast")
  expect(r.variant).toBe("success")
  expect(activeVersion(root)).toBe("v2")
})

test("handleCommand returns consumed:false for a non-mh command", async () => {
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(tmpWorktree())
  const engine = new EvolutionEngine(host, store)
  expect(await engine.handleCommand("some-other-command", "args", "s")).toEqual({ consumed: false })
})

// ── Task 3 (generality routing): composeInjection routes by st.model ──────
//
// Self-seeds a FAITHFUL account-global active store (playbook.json whose
// renderPlaybook exactly equals system.md) so composeHarness's back-compat
// guard (Task 2) actually fires the routed render instead of falling back
// to the flat read. Does not rely on any other test's leftover state.
test("composeInjection injects a vendor bullet only for the matching provider", async () => {
  const worktree = tmpWorktree()
  const store = new InMemorySessionStateStore()
  const { host } = fakeHost(worktree)
  const engine = new EvolutionEngine(host, store)

  const root = accountGlobalRoot()
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  const pb = {
    schemaVersion: 1,
    nextId: 3,
    bullets: [
      { id: "b1", text: "U", helpful: 0, harmful: 0, addedBy: "t", status: "active", createdAt: "t", updatedAt: "t" },
      { id: "b2", text: "VA", generality: "vendor", slice: "anthropic", helpful: 0, harmful: 0, addedBy: "t", status: "active", createdAt: "t", updatedAt: "t" },
    ],
  }
  fs.writeFileSync(path.join(root, "active", "playbook.json"), JSON.stringify(pb))
  fs.writeFileSync(path.join(root, "active", "system.md"), "- U\n- VA\n")

  await engine.sessionMessage("gr-s1", { role: "mh-build", isPrimary: true, participates: true, model: "anthropic/claude-haiku-4-5" })
  const anthropic = (await engine.composeInjection("gr-s1")).blocks.join("\n")

  await engine.sessionMessage("gr-s2", { role: "mh-build", isPrimary: true, participates: true, model: "openai/gpt-5" })
  const openai = (await engine.composeInjection("gr-s2")).blocks.join("\n")

  expect(anthropic).toContain("- VA")
  expect(openai).not.toContain("- VA")
  expect(openai).toContain("- U")
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
