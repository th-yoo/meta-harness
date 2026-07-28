import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  applyPendingArtifacts,
  proposerInFlight,
  proposerLockPath,
  writeProposerLock,
} from "../src/adapters/claude-code/proposer.ts"
import { ClaudeCodeHost } from "../src/adapters/claude-code/cc-host.ts"
import { dispatch } from "../src/adapters/claude-code/dispatch.ts"
import { FileSessionStateStore } from "../src/adapters/claude-code/file-state.ts"
import { EvolutionEngine } from "../src/engine.ts"
import { writeActive, listVersions, readTrial } from "../src/harness-store.ts"
import type { HarnessHost, StagedArtifactDescriptor } from "../src/host.ts"

let home: string
let worktree: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-ccprop-home-"))
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mh-ccprop-wt-"))
  process.env["META_HARNESS_HOME"] = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
})

interface Rec { notes: string[]; logs: string[] }
function recHost(rec: Rec): HarnessHost {
  return {
    platform: "test",
    projectRoot: worktree,
    log: (_l, m) => { rec.logs.push(m) },
    notify: (m) => { rec.notes.push(m) },
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    runTaskAgent: async () => ({ id: "child" }),
    exec: async () => ({ stdout: "", exitCode: 0 }),
  } as HarnessHost
}

function stagingBase(): string {
  const b = path.join(worktree, ".kkamak", "staging")
  fs.mkdirSync(b, { recursive: true })
  return b
}

function proposeDescriptor(root: string, over: Partial<StagedArtifactDescriptor> = {}): StagedArtifactDescriptor {
  return {
    kind: "propose",
    worktree,
    version: "v2",
    layer: { root, scope: "project-role", higherRoots: [] },
    playbookMode: false,
    proposerModel: "anthropic/claude-opus-4-8",
    proposerVariant: "high",
    sessionId: "child",
    spawnedAt: Date.now(),
    timeoutMs: 20 * 60 * 1000,
    pid: process.pid,
    ...over,
  }
}

// ── lock lifecycle ──────────────────────────────────────────────────────────

test("writeProposerLock + proposerInFlight: lock created blocks a second fire", () => {
  const root = path.join(home, "s1")
  expect(proposerInFlight(worktree, root)).toBe(false)
  writeProposerLock(proposeDescriptor(root))
  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(true)
  expect(proposerInFlight(worktree, root)).toBe(true)
})

test("proposerInFlight: a stale lock (past timeout horizon) reads as NOT in flight", () => {
  const root = path.join(home, "s2")
  writeProposerLock(proposeDescriptor(root, { spawnedAt: Date.now() - 60 * 60 * 1000, timeoutMs: 20 * 60 * 1000 }))
  // 60min ago, 20min horizon → stale
  expect(proposerInFlight(worktree, root)).toBe(false)
})

test("ClaudeCodeHost.stageArtifactApply writes a lock; proposerInFlight reflects it", () => {
  const root = path.join(home, "s3")
  const host = new ClaudeCodeHost(worktree)
  expect(host.proposerInFlight(root)).toBe(false)
  host.stageArtifactApply(proposeDescriptor(root))
  expect(host.proposerInFlight(root)).toBe(true)
})

// ── apply-on-next-event ─────────────────────────────────────────────────────

test("applyPendingArtifacts: completed staging + lock → applies, clears lock, notifies", async () => {
  const root = path.join(home, "s4")
  writeActive(root, "v1", "- baseline", "")
  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- applied-on-next-event\n")
  writeProposerLock(proposeDescriptor(root, { version: "v2", playbookMode: false }))

  const rec: Rec = { notes: [], logs: [] }
  await applyPendingArtifacts(recHost(rec), worktree)

  expect(listVersions(root)).toContain("v2")
  expect(readTrial(root)).not.toBeNull()
  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(false) // lock cleared
  expect(rec.notes.some((n) => n.includes("Trial started"))).toBe(true)
})

test("applyPendingArtifacts: incomplete staging (no artifact yet) → lock untouched", async () => {
  const root = path.join(home, "s5")
  writeActive(root, "v1", "- baseline", "")
  stagingBase() // no artifact written
  writeProposerLock(proposeDescriptor(root, { version: "v2", playbookMode: false }))

  const rec: Rec = { notes: [], logs: [] }
  await applyPendingArtifacts(recHost(rec), worktree)

  expect(listVersions(root)).not.toContain("v2")
  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(true) // still pending
})

test("applyPendingArtifacts: stale pending lock (child crashed) → reclaimed + timeout notify", async () => {
  const root = path.join(home, "s6")
  writeActive(root, "v1", "- baseline", "")
  stagingBase() // artifact never produced
  writeProposerLock(proposeDescriptor(root, {
    version: "v2", playbookMode: false,
    spawnedAt: Date.now() - 60 * 60 * 1000, timeoutMs: 20 * 60 * 1000,
  }))

  const rec: Rec = { notes: [], logs: [] }
  await applyPendingArtifacts(recHost(rec), worktree)

  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(false) // reclaimed
  expect(rec.notes.some((n) => n.includes("timed out"))).toBe(true)
})

test("applyPendingArtifacts: corrupt lock file → warn + remove, no crash", async () => {
  const root = path.join(home, "s7")
  const p = proposerLockPath(worktree, root)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, "{ not valid json")

  const rec: Rec = { notes: [], logs: [] }
  await applyPendingArtifacts(recHost(rec), worktree)

  expect(fs.existsSync(p)).toBe(false)
  expect(rec.logs.some((l) => l.includes("corrupt proposer lock"))).toBe(true)
})

test("applyPendingArtifacts: no lock dir → silent no-op", async () => {
  const rec: Rec = { notes: [], logs: [] }
  await applyPendingArtifacts(recHost(rec), worktree) // worktree has no .kkamak
  expect(rec.logs.length).toBe(0)
  expect(rec.notes.length).toBe(0)
})

// ── end-to-end through dispatch: ANY hook event applies pending artifacts ────

test("dispatch: any hook event flushes a completed proposer artifact", async () => {
  const root = path.join(home, "s8")
  writeActive(root, "v1", "- baseline", "")
  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- flushed-by-dispatch\n")
  writeProposerLock(proposeDescriptor(root, { version: "v2", playbookMode: false }))

  const host = new ClaudeCodeHost(worktree)
  const state = new FileSessionStateStore()
  const engine = new EvolutionEngine(host, state)

  // A PostToolUse event with an unrelated session — the apply-on-next-event
  // scan runs before the switch regardless of event type.
  await dispatch(
    "PostToolUse",
    { session_id: "unrelated", cwd: worktree, tool_name: "Bash", tool_response: { stdout: "x" } },
    { engine, host, state },
    {} as NodeJS.ProcessEnv,
  )

  expect(listVersions(root)).toContain("v2")
  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(false)
})

test("dispatch: MH_CHILD event does NOT run the apply scan (child is fully inert)", async () => {
  const root = path.join(home, "s9")
  writeActive(root, "v1", "- baseline", "")
  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- should-not-apply\n")
  writeProposerLock(proposeDescriptor(root, { version: "v2", playbookMode: false }))

  const host = new ClaudeCodeHost(worktree)
  const state = new FileSessionStateStore()
  const engine = new EvolutionEngine(host, state)

  const out = await dispatch(
    "Stop",
    { session_id: "child-sess", cwd: worktree, last_assistant_message: "hi" },
    { engine, host, state },
    { MH_CHILD: "1" } as NodeJS.ProcessEnv,
  )

  expect(out).toBeUndefined()
  // The scan never ran → artifact untouched, lock intact.
  expect(listVersions(root)).not.toContain("v2")
  expect(fs.existsSync(proposerLockPath(worktree, root))).toBe(true)
})
