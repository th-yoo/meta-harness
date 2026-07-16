/**
 * master-relay.test.ts — Task 3 (T3): master/relay.ts, the deterministic
 * relay tick. Poll → parse inbound → resume the paused squad on a gate answer
 * → surface pending state on a status query → send. The single chokepoint for
 * human-owned outward actions (halt-on-approval, §9.3).
 *
 * Hermetic: fake in-memory transport + a hand-written fake `resumeSquad`. NO
 * real network / squad / LLM. `raisedAt` is deterministic via an injected
 * `now: () => "t0"`. The determinism invariant is *structural* — RelayDeps
 * exposes no LLM seam, so this test cannot even reach one.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { parseInbound, relayTick, type ResumeSquadFn } from "../src/fleet/master/relay.ts"
import { fakeTransport } from "../src/fleet/master/transport.ts"
import { pendingGates, raiseGate } from "../src/fleet/master/gate-state.ts"
import type { SquadOutcome } from "../src/fleet/squad.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mh-master-relay-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("parseInbound", () => {
  test("answer verbs carry project + sliceId + answer", () => {
    expect(parseInbound("approve p/s1")).toEqual({
      verb: "answer",
      project: "p",
      sliceId: "s1",
      answer: "approve",
    })
    expect(parseInbound("revise proj/slice-9")).toEqual({
      verb: "answer",
      project: "proj",
      sliceId: "slice-9",
      answer: "revise",
    })
  })

  test("status verb", () => {
    expect(parseInbound("status")).toEqual({ verb: "status" })
  })

  test("unknown / malformed → unknown verb", () => {
    expect(parseInbound("hello there").verb).toBe("unknown")
    expect(parseInbound("approve").verb).toBe("unknown") // missing project/sliceId
    expect(parseInbound("approve p").verb).toBe("unknown") // missing sliceId
  })
})

describe("master/relay relayTick", () => {
  test("gate round-trip: approve resolves old gate1, resume pauses at gate2, outbound sent, inbound acked", async () => {
    // Seed a pending gate1 for p/s1.
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" })

    const t = fakeTransport([{ id: "u1", text: "approve p/s1" }])
    const resumeCalls: Array<{ project: string; sliceId: string; gateAnswer: string }> = []
    const resumeSquad: ResumeSquadFn = async (a) => {
      resumeCalls.push({ project: a.project, sliceId: a.sliceId, gateAnswer: a.gateAnswer })
      return { status: "gate", gate: "gate2", payload: "second spec" }
    }

    const res = await relayTick({ masterRoot: root, transport: t, resumeSquad, now: () => "t0" })

    expect(res.handled).toBe(1)
    // resumeSquad was invoked with the resume/gateAnswer idiom.
    expect(resumeCalls).toEqual([{ project: "p", sliceId: "s1", gateAnswer: "approve" }])
    // Old gate1 resolved (moved to processed) — the new gate2 is the only pending.
    const pending = pendingGates(root)
    expect(pending).toHaveLength(1)
    expect(pending[0].kind).toBe("gate2")
    expect(pending[0].sliceId).toBe("s1")
    expect(pending[0].payload).toBe("second spec")
    // An outbound was sent, and the inbound was acked.
    expect(t.sent).toHaveLength(1)
    expect(t.acked).toEqual(["u1"])
  })

  test("status exposure (R1): a single outbound contains every pending sliceId", async () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "a", raisedAt: "t0" })
    raiseGate(root, { project: "q", sliceId: "s2", kind: "gate2", payload: "b", raisedAt: "t0" })

    const t = fakeTransport([{ id: "u1", text: "status" }])
    const resumeSquad: ResumeSquadFn = async () => {
      throw new Error("resumeSquad must NOT be called for a status query")
    }

    const res = await relayTick({ masterRoot: root, transport: t, resumeSquad, now: () => "t0" })

    expect(res.handled).toBe(1)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0].text).toContain("s1")
    expect(t.sent[0].text).toContain("s2")
    expect(t.acked).toEqual(["u1"])
    // Status is read-only: nothing resolved.
    expect(pendingGates(root)).toHaveLength(2)
  })

  test("outward-action halt (§9.3): onApprovedTerminal fires ONCE on approve-done, NEVER on revise", async () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec", raisedAt: "t0" })

    const terminalCalls: Array<{ project: string; sliceId: string; status: string }> = []
    const onApprovedTerminal = async (o: SquadOutcome, ctx: { project: string; sliceId: string }) => {
      terminalCalls.push({ project: ctx.project, sliceId: ctx.sliceId, status: o.status })
    }

    // 1) approve → resumeSquad returns done → terminal seam fires once.
    const t1 = fakeTransport([{ id: "u1", text: "approve p/s1" }])
    const resumeDone: ResumeSquadFn = async () => ({ status: "done", payload: "shipped" })
    await relayTick({
      masterRoot: root,
      transport: t1,
      resumeSquad: resumeDone,
      onApprovedTerminal,
      now: () => "t0",
    })
    expect(terminalCalls).toEqual([{ project: "p", sliceId: "s1", status: "done" }])

    // 2) revise → resumeSquad returns a new gate → terminal seam must NOT fire again.
    raiseGate(root, { project: "p", sliceId: "s2", kind: "gate1", payload: "spec2", raisedAt: "t0" })
    const t2 = fakeTransport([{ id: "u2", text: "revise p/s2" }])
    const resumeGate: ResumeSquadFn = async () => ({ status: "gate", gate: "gate2", payload: "again" })
    await relayTick({
      masterRoot: root,
      transport: t2,
      resumeSquad: resumeGate,
      onApprovedTerminal,
      now: () => "t0",
    })
    // still only the one call from the approve-done path.
    expect(terminalCalls).toHaveLength(1)
  })

  test("escalation: resume returns escalation → new escalation gate raised + outbound sent", async () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec", raisedAt: "t0" })
    const t = fakeTransport([{ id: "u1", text: "approve p/s1" }])
    const resumeSquad: ResumeSquadFn = async () => ({
      status: "escalation",
      escalation: { type: "stuck", body: "need human help" },
    })
    await relayTick({ masterRoot: root, transport: t, resumeSquad, now: () => "t0" })
    const pending = pendingGates(root)
    expect(pending).toHaveLength(1)
    expect(pending[0].kind).toBe("escalation")
    expect(pending[0].payload).toBe("need human help")
    expect(t.sent).toHaveLength(1)
    expect(t.acked).toEqual(["u1"])
  })

  test("self-heal on unmatched answer: resumeSquad NOT called, 'no such pending gate' reply sent, acked", async () => {
    // No pending gate for p/nope.
    const t = fakeTransport([{ id: "u1", text: "approve p/nope" }])
    let called = false
    const resumeSquad: ResumeSquadFn = async () => {
      called = true
      return { status: "running" }
    }
    const res = await relayTick({ masterRoot: root, transport: t, resumeSquad, now: () => "t0" })
    expect(res.handled).toBe(1)
    expect(called).toBe(false)
    expect(t.sent).toHaveLength(1)
    expect(t.sent[0].text.toLowerCase()).toContain("no such pending gate")
    expect(t.acked).toEqual(["u1"])
  })

  test("unknown verb → help reply sent + acked, resumeSquad NOT called", async () => {
    const t = fakeTransport([{ id: "u1", text: "gibberish" }])
    let called = false
    const resumeSquad: ResumeSquadFn = async () => {
      called = true
      return { status: "running" }
    }
    const res = await relayTick({ masterRoot: root, transport: t, resumeSquad, now: () => "t0" })
    expect(res.handled).toBe(1)
    expect(called).toBe(false)
    expect(t.sent).toHaveLength(1)
    expect(t.acked).toEqual(["u1"])
  })
})
