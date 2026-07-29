/**
 * trial-compose.test.ts — Task 3 (§4.3 prerequisite build item §11 #1/#2):
 * arm-aware compose from a TrialState snapshot + SessionStart exposure
 * wiring. Exercises the 6 behavior contracts from
 * .superpowers/sdd/tm3-brief.md against the wiring added to
 * `engine.ts`'s `composeInjection` and `adapters/claude-code/dispatch.ts`'s
 * SessionStart case — NOT the arm-assignment/exposure-log PRIMITIVES
 * themselves (fully covered by test/trial-arm.test.ts already).
 *
 * Two layers of coverage:
 *  - "engine-level" tests drive `EvolutionEngine.composeInjection` directly
 *    against a fake host + in-memory session state (mirrors engine.test.ts's
 *    pattern) — these check WHAT gets composed and the returned enrollment.
 *  - "dispatch-level" tests drive `dispatch("SessionStart", ...)` end to end
 *    (mirrors cc-dispatch.test.ts's runHook pattern) — these check the
 *    exposure log side effect, which only the CC adapter's SessionStart
 *    case triggers (spec §1: v0 exposure/arms are Claude Code sessions
 *    only; the opencode adapter's index.ts intentionally never appends).
 *
 * Hermetic: META_HARNESS_HOME redirects the account-scoped stores into a
 * tmp dir (same convention as cc-dispatch.test.ts); every project-global
 * store lives under a tmp project dir passed as `cwd`.
 *
 * `TrialState.rewardMode`/`trialId`/`awaitingGo` are OPTIONAL interface
 * fields added by this task (Task 4 owns startTrial/resolveTrial behavior
 * for them) — tests here patch a trial's `.trial` file directly via the
 * exported `activePath`/`readTrial` primitives to simulate a Task-4-started
 * gate-outcomes trial, since no start-trial helper for `rewardMode` exists
 * yet.
 */
import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { HarnessHost } from "../src/host.ts"
import {
  projectGlobalRoot,
  bootstrapStore,
  startTrial,
  readTrial,
  activePath,
} from "../src/harness-store.ts"
import { EvolutionEngine, InMemorySessionStateStore, type SessionState } from "../src/engine.ts"
import { dispatch, type HookInput } from "../src/adapters/claude-code/dispatch.ts"
import { ClaudeCodeHost } from "../src/adapters/claude-code/cc-host.ts"
import { FileSessionStateStore } from "../src/adapters/claude-code/file-state.ts"
import { readExposureRows } from "../src/trial-arm.ts"

let home: string
let project: string
let prevHome: string | undefined
let prevArm: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  prevArm = process.env["KKAMAK_TRIAL_ARM"]
  delete process.env["KKAMAK_TRIAL_ARM"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-trial-compose-home-"))
  project = fs.mkdtempSync(path.join(os.tmpdir(), "mh-trial-compose-proj-"))
  process.env["META_HARNESS_HOME"] = home
})

afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  if (prevArm === undefined) delete process.env["KKAMAK_TRIAL_ARM"]
  else process.env["KKAMAK_TRIAL_ARM"] = prevArm
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(project, { recursive: true, force: true })
})

// ── shared helpers ──────────────────────────────────────────────────────────

function fakeHost(worktree: string): HarnessHost {
  return {
    platform: "fake",
    projectRoot: worktree,
    log: async () => {},
    notify: async () => {},
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    runTaskAgent: async () => null,
    exec: async () => ({ stdout: "", exitCode: 0 }),
  }
}

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

/** Patch a live `.trial` file (already created by `startTrial`) into a §4.3
 * gate-outcomes trial. No production code writes `rewardMode`/`trialId`/
 * `awaitingGo` yet (Task 4) — this is the test-only stand-in for that. */
function markGateOutcomes(root: string, opts: { trialId?: string; awaitingGo?: boolean } = {}): void {
  const t = readTrial(root)
  if (!t) throw new Error("markGateOutcomes: no live trial to mark")
  const patched = { ...t, rewardMode: "gate-outcomes" as const, ...opts }
  fs.writeFileSync(activePath(root, ".trial"), JSON.stringify(patched))
}

const FIX = path.join(import.meta.dir, "fixtures", "cc-hooks")

function fixture(name: string, overrides: Partial<HookInput> = {}): HookInput {
  const raw = JSON.parse(fs.readFileSync(path.join(FIX, name), "utf-8"))
  return { ...raw, cwd: project, session_id: "test-sess-1", ...overrides }
}

async function runHook(event: string, input: HookInput, env: NodeJS.ProcessEnv = process.env) {
  const host = new ClaudeCodeHost(input.cwd ?? project)
  const state = new FileSessionStateStore()
  const engine = new EvolutionEngine(host, state)
  const output = await dispatch(event, input, { engine, host, state }, env)
  return { output, state }
}

// ── Contract 1: no live trial -> compose byte-identical to today ───────────

test("contract 1: no live trial -> composeInjection composes active text, enrollment undefined", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "ACTIVE SYSTEM TEXT")
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s1")

  const { blocks, enrollment } = await engine.composeInjection("s1")
  expect(enrollment).toBeUndefined()
  expect(blocks.join("\n")).toContain("ACTIVE SYSTEM TEXT")
})

test("contract 1: no live trial -> dispatch's SessionStart appends no exposure row", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "ACTIVE SYSTEM TEXT")

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)

  expect(readExposureRows(project)).toEqual([])
})

// ── Contract 2: live gate-outcomes trial -> arm-aware compose ──────────────

test("contract 2: baseline arm composes project-global from the TrialState snapshot", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-1" })

  process.env["KKAMAK_TRIAL_ARM"] = "baseline"
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s-baseline")

  const { blocks, enrollment } = await engine.composeInjection("s-baseline")
  expect(enrollment).toEqual({ trialId: "gate-trial-1", arm: "baseline", forced: true })
  const text = blocks.join("\n")
  expect(text).toContain("BASELINE SYSTEM TEXT")
  expect(text).not.toContain("TRIAL SYSTEM TEXT")
})

test("contract 2: trial arm composes the active (trial) text unchanged", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-1" })

  process.env["KKAMAK_TRIAL_ARM"] = "trial"
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s-trial")

  const { blocks, enrollment } = await engine.composeInjection("s-trial")
  expect(enrollment).toEqual({ trialId: "gate-trial-1", arm: "trial", forced: true })
  const text = blocks.join("\n")
  expect(text).toContain("TRIAL SYSTEM TEXT")
  expect(text).not.toContain("BASELINE SYSTEM TEXT")
})

test("contract 2: legacy trial (no rewardMode) never arms — compose stays active-only even with KKAMAK_TRIAL_ARM set", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  // NOT marked gate-outcomes — legacy `.trial` shape (today's resolveTrial world).

  process.env["KKAMAK_TRIAL_ARM"] = "baseline"
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s-legacy")

  const { blocks, enrollment } = await engine.composeInjection("s-legacy")
  expect(enrollment).toBeUndefined()
  const text = blocks.join("\n")
  expect(text).toContain("TRIAL SYSTEM TEXT")
  expect(text).not.toContain("BASELINE SYSTEM TEXT")
})

test("contract 2: trialId falls back to trial.trial (the candidate version) when TrialState.trialId is unset", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v7", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg) // no trialId override

  process.env["KKAMAK_TRIAL_ARM"] = "trial"
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s-fallback")

  const { enrollment } = await engine.composeInjection("s-fallback")
  expect(enrollment?.trialId).toBe("v7")
})

// ── Contract 3: awaitingGo trials are inert ─────────────────────────────────

test("contract 3: awaitingGo gate-outcomes trial -> no enrollment, active compose", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "queued-golden", awaitingGo: true })

  process.env["KKAMAK_TRIAL_ARM"] = "baseline" // even forced, awaitingGo must win
  const host = fakeHost(project)
  const store = new InMemorySessionStateStore()
  const engine = new EvolutionEngine(host, store)
  seedParticipating(store, "s-await")

  const { blocks, enrollment } = await engine.composeInjection("s-await")
  expect(enrollment).toBeUndefined()
  expect(blocks.join("\n")).toContain("TRIAL SYSTEM TEXT")
})

test("contract 3: awaitingGo trial -> dispatch appends no exposure row", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "queued-golden", awaitingGo: true })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)

  expect(readExposureRows(project)).toEqual([])
})

// ── Contract 4: exactly one exposure row per session, across re-fires ──────

test("contract 4: exposure row appended exactly once per session, across SessionStart re-fires (resume/compaction)", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-refire" })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  await runHook("SessionStart", fixture("session-start-resume.json"), { MH_ROLE: "mh-build" } as any)
  await runHook("SessionStart", fixture("session-start-resume.json"), { MH_ROLE: "mh-build" } as any)

  const rows = readExposureRows(project)
  expect(rows.length).toBe(1)
  expect(rows[0]!.sessionID).toBe("test-sess-1")
  expect(rows[0]!.trialId).toBe("gate-trial-refire")
})

test("contract 4 / §2 re-enrollment trap: a session already enrolled under an earlier trial keeps its original row when a NEW trial goes live and the same session_id fires again", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL-A SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "trial-A" })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)
  const firstRows = readExposureRows(project)
  expect(firstRows.length).toBe(1)
  expect(firstRows[0]!.trialId).toBe("trial-A")

  // Trial A resolves and a fresh trial B goes live on the same layer.
  startTrial(pg, "v2", "TRIAL-B SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "trial-B" })

  // Same session resumes — must NOT be re-enrolled into trial B.
  await runHook("SessionStart", fixture("session-start-resume.json"), { MH_ROLE: "mh-build" } as any)

  const rows = readExposureRows(project)
  expect(rows.length).toBe(1)
  expect(rows[0]!.trialId).toBe("trial-A")
})

// ── Contract 5: forced arm (KKAMAK_TRIAL_ARM) ───────────────────────────────

test("contract 5: KKAMAK_TRIAL_ARM forces the arm — exposure row has forced:true and the forced arm's text composes", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-forced" })

  process.env["KKAMAK_TRIAL_ARM"] = "baseline"
  const { output } = await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)

  const ctx = (output as any)?.hookSpecificOutput?.additionalContext ?? ""
  expect(ctx).toContain("BASELINE SYSTEM TEXT")
  expect(ctx).not.toContain("TRIAL SYSTEM TEXT")

  const rows = readExposureRows(project)
  expect(rows.length).toBe(1)
  expect(rows[0]!.forced).toBe(true)
  expect(rows[0]!.arm).toBe("baseline")
  expect(rows[0]!.trialId).toBe("gate-trial-forced")
})

test("contract 5: an UNFORCED session's exposure row has forced:false", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-unforced" })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build" } as any)

  const rows = readExposureRows(project)
  expect(rows.length).toBe(1)
  expect(rows[0]!.forced).toBe(false)
})

// ── Contract 6: child / non-participating sessions never get a row ─────────

test("contract 6: a child session (MH_CHILD_ENV) never appends an exposure row, even with a live gate-outcomes trial", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-child" })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "mh-build", MH_CHILD: "1" } as any)

  expect(readExposureRows(project)).toEqual([])
})

test("contract 6: a non-participating role (declared but not mh-*) never appends an exposure row", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-nonpart" })

  await runHook("SessionStart", fixture("session-start.json"), { MH_ROLE: "build" } as any)

  expect(readExposureRows(project)).toEqual([])
})

test("contract 6: no role declared at all -> silent no-op, no exposure row", async () => {
  const pg = projectGlobalRoot(project)
  bootstrapStore(pg, "BASELINE SYSTEM TEXT")
  startTrial(pg, "v1", "TRIAL SYSTEM TEXT", "trial tools", 5)
  markGateOutcomes(pg, { trialId: "gate-trial-norole" })

  const { output } = await runHook("SessionStart", fixture("session-start.json"), {} as any)

  expect(output).toBeUndefined()
  expect(readExposureRows(project)).toEqual([])
})
