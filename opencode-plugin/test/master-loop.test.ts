import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  runMaster,
  masterTick,
  acquireSingletonLock,
  type MasterDeps,
} from "../src/fleet/master/master.ts"
import { fakeTransport } from "../src/fleet/master/transport.ts"
import { raiseGate, pendingGates } from "../src/fleet/master/gate-state.ts"
import type { ResumeSquadFn } from "../src/fleet/master/relay.ts"
import type { SubScheduler } from "../src/fleet/master/scheduler.ts"
import type { GitProbe, CrashIntent } from "../src/fleet/master/reconcile.ts"
import type { NamespaceRegistry, ProjectNamespace } from "../src/fleet/master/namespace.ts"
import type { SquadOutcome } from "../src/fleet/squad.ts"

function tmpRoot(): string {
  return mkdtempSync(join(tmpdir(), "mh-master-loop-"))
}

function ns(overrides: Partial<ProjectNamespace> & { project: string }): ProjectNamespace {
  return {
    project: overrides.project,
    runtimeRoot: overrides.runtimeRoot ?? `/rt/${overrides.project}`,
    worktreeBase: overrides.worktreeBase ?? `/wt/${overrides.project}`,
    integrationBranch: overrides.integrationBranch ?? `int/${overrides.project}`,
    credentialScope: overrides.credentialScope ?? `cred/${overrides.project}`,
    gatePolicy: overrides.gatePolicy ?? "root-human",
    lifetime: overrides.lifetime ?? "ephemeral",
  }
}

function registry(...projects: ProjectNamespace[]): NamespaceRegistry {
  const map: Record<string, ProjectNamespace> = {}
  for (const p of projects) map[p.project] = p
  return { projects: map, globalCap: 3 }
}

/** A GitProbe that records every consult into a shared ordered event log —
 * so a test can prove reconcile ran (git consulted) BEFORE the first poll. */
function instrumentedGit(events: string[], opts: { mergeHead?: boolean } = {}): GitProbe {
  return {
    hasMergeHead(_root) {
      events.push("git")
      return opts.mergeHead ?? false
    },
    branchContains(_root, _branch, _sha) {
      events.push("git")
      return false
    },
    abortMerge(_root) {
      events.push("git")
    },
  }
}

/** A sub-scheduler that must never fire in these tests (empty queued set) —
 * calling it fails the test loudly. */
const neverSub: SubScheduler = async () => {
  throw new Error("sub-scheduler must not run with an empty queue")
}

describe("master/master — singleton daemon loop (§9.1, D8.1)", () => {
  test("singleton lock (D8.1): held → second acquire dies; after release, re-acquire succeeds", () => {
    const root = tmpRoot()
    try {
      const release = acquireSingletonLock(root)
      expect(() => acquireSingletonLock(root)).toThrow("master already running")
      release()
      // A fresh acquire after release succeeds (and can be released again).
      const release2 = acquireSingletonLock(root)
      release2()
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("gate E2E round-trip: status exposes s1, approve resolves the gate + acks + fires outward-action once", async () => {
    const root = tmpRoot()
    try {
      // Pre-seed a pending gate1 for p/s1 (the paused squad awaiting a human).
      raiseGate(root, {
        project: "p",
        sliceId: "s1",
        kind: "gate1",
        payload: "spec-body",
        raisedAt: "t0",
      })

      // Transport scripts a status query THEN an approve — order matters so the
      // status render still sees the (as-yet-unresolved) gate.
      const transport = fakeTransport([
        { id: "u1", text: "status" },
        { id: "u2", text: "approve p/s1" },
      ])

      // The paused squad, on resume-with-approve, terminates done.
      const resumeSquad: ResumeSquadFn = async () => ({ status: "done", payload: "report" })

      let approvedTerminalCount = 0
      const onApprovedTerminal = async (_o: SquadOutcome) => {
        approvedTerminalCount += 1
      }

      const deps: MasterDeps = {
        masterRoot: root,
        transport,
        resumeSquad,
        registry: registry(ns({ project: "p" })),
        sub: neverSub,
        git: instrumentedGit([]),
        removeWorktree: () => {},
        onApprovedTerminal,
        now: () => "t-fixed",
      }

      // Stop after exactly 2 ticks (tick 1 drains both messages; tick 2 is a
      // no-op empty poll — proves the loop is bounded by the `until` seam).
      let ticks = 0
      await runMaster(deps, { until: () => ticks++ >= 2 })

      // status exposure (R1): some outbound listed the sliceId.
      expect(transport.sent.some((m) => m.text.includes("s1"))).toBe(true)
      // approve resolved the gate: nothing pending remains.
      expect(pendingGates(root)).toEqual([])
      // the inbound approve was acked (so it won't re-appear).
      expect(transport.acked).toContain("u2")
      // outward-action seam fired exactly once (on the terminal approve).
      expect(approvedTerminalCount).toBe(1)
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("reconcile on startup: GitProbe is consulted BEFORE any transport poll (restart-safety before serving)", async () => {
    const root = tmpRoot()
    try {
      const events: string[] = []
      const project = ns({ project: "p" })
      const intent: CrashIntent = { project: "p", sliceId: "s1", phase: "merging" }

      const base = fakeTransport() // empty backlog; poll is still exercised
      const transport = {
        sent: base.sent,
        acked: base.acked,
        inject: base.inject,
        ack: base.ack,
        send: base.send,
        poll: async () => {
          events.push("poll")
          return base.poll()
        },
      }

      const deps: MasterDeps = {
        masterRoot: root,
        transport,
        resumeSquad: async () => ({ status: "done", payload: "" }),
        registry: registry(project),
        sub: neverSub,
        git: instrumentedGit(events, { mergeHead: true }),
        removeWorktree: () => {},
        loadIntents: () => [intent],
      }

      // Run a single tick so at least one poll happens after reconcile.
      let ticks = 0
      await runMaster(deps, { until: () => ticks++ >= 1 })

      // Poll happened, and the FIRST git consult precedes the FIRST poll.
      expect(events).toContain("poll")
      expect(events).toContain("git")
      expect(events.indexOf("git")).toBeLessThan(events.indexOf("poll"))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  test("no LLM anywhere: MasterDeps exposes no LLM seam (structural determinism invariant)", () => {
    const root = tmpRoot()
    try {
      const deps: MasterDeps = {
        masterRoot: root,
        transport: fakeTransport(),
        resumeSquad: async () => ({ status: "done", payload: "" }),
        registry: registry(),
        sub: neverSub,
        git: instrumentedGit([]),
        removeWorktree: () => {},
      }
      for (const key of Object.keys(deps)) {
        expect(/llm|model|driver|persona|prompt|judge/i.test(key)).toBe(false)
      }
      // masterTick is exported and callable with only injected deterministic
      // seams (no LLM parameter exists to pass).
      expect(typeof masterTick).toBe("function")
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })
})
