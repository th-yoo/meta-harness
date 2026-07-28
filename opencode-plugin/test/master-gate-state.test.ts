/**
 * master-gate-state.test.ts — Task 1 (T1): master/gate-state.ts, the durable
 * pending-gate + processed-instruction log (R1 exposure surface, D8.1 durable
 * log, D9 atomic writes). No store touched — no META_HARNESS_HOME needed.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  loadMasterLog,
  markRelayed,
  masterLogPath,
  pendingGates,
  raiseGate,
  resolveGate,
} from "../src/fleet/master/gate-state.ts"

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mh-master-log-"))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("master/gate-state", () => {
  test("raiseGate → pendingGates exposes it; resolveGate moves it to processed", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" })
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" }) // dup
    expect(pendingGates(root)).toHaveLength(1) // idempotent
    resolveGate(root, "p", "s1", "gate1", { inboundId: "u7", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })
    expect(pendingGates(root)).toEqual([])
    expect(loadMasterLog(root).processed.map((r) => r.inboundId)).toEqual(["u7"])
  })

  test("masterLogPath is under .kkamak/runtime/master/ of masterRoot", () => {
    const p = masterLogPath(root)
    expect(p).toBe(join(root, ".kkamak", "runtime", "master", "gate-log.json"))
  })

  test("missing file → loadMasterLog defaults to empty pending/processed", () => {
    expect(loadMasterLog(root)).toEqual({ pending: [], processed: [] })
  })

  test("idempotent raise: same project+sliceId+kind twice leaves exactly one pending entry, latest payload wins", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "escalation", payload: "first", raisedAt: "t0" })
    raiseGate(root, { project: "p", sliceId: "s1", kind: "escalation", payload: "second", raisedAt: "t1" })
    const pending = pendingGates(root)
    expect(pending).toHaveLength(1)
    expect(pending[0].payload).toBe("second")
    expect(pending[0].raisedAt).toBe("t1")
  })

  test("different kind for same project+sliceId is a distinct pending entry (not collapsed)", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "a", raisedAt: "t0" })
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate2", payload: "b", raisedAt: "t0" })
    expect(pendingGates(root)).toHaveLength(2)
  })

  test("resolveGate moves pending → processed, not duplicated", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "verdict", payload: "v", raisedAt: "t0" })
    resolveGate(root, "p", "s1", "verdict", { inboundId: "u1", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })
    const log = loadMasterLog(root)
    expect(log.pending).toEqual([])
    expect(log.processed).toHaveLength(1)
    expect(log.processed[0]).toEqual({ inboundId: "u1", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })
  })

  test("exposure filter: pendingGates(root, project) returns only that project's gates", () => {
    raiseGate(root, { project: "projA", sliceId: "s1", kind: "gate1", payload: "a", raisedAt: "t0" })
    raiseGate(root, { project: "projB", sliceId: "s1", kind: "gate1", payload: "b", raisedAt: "t0" })
    const onlyA = pendingGates(root, "projA")
    expect(onlyA).toHaveLength(1)
    expect(onlyA[0].project).toBe("projA")
    expect(pendingGates(root)).toHaveLength(2) // unfiltered = both
  })

  test("markRelayed sets relayRef on the matching pending gate", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "a", raisedAt: "t0" })
    markRelayed(root, "p", "s1", "gate1", "msg-123")
    const pending = pendingGates(root)
    expect(pending).toHaveLength(1)
    expect(pending[0].relayRef).toBe("msg-123")
  })

  test("co-pending different-kind gates: resolveGate(..., \"gate1\", ...) leaves the escalation pending untouched", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" })
    raiseGate(root, { project: "p", sliceId: "s1", kind: "escalation", payload: "help…", raisedAt: "t0" })
    expect(pendingGates(root)).toHaveLength(2)

    resolveGate(root, "p", "s1", "gate1", { inboundId: "u9", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })

    const pending = pendingGates(root)
    expect(pending).toHaveLength(1)
    expect(pending[0].kind).toBe("escalation")

    const log = loadMasterLog(root)
    expect(log.processed).toHaveLength(1)
    expect(log.processed[0]).toEqual({ inboundId: "u9", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })
  })

  test("atomic/torn-write survival: a stray *.tmp sibling does not break loadMasterLog", () => {
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "a", raisedAt: "t0" })
    const p = masterLogPath(root)
    expect(existsSync(p)).toBe(true)
    // Simulate an interrupted writer: a stray temp sibling left behind.
    writeFileSync(`${p}.stray.tmp`, "{ not valid json, torn write")
    const log = loadMasterLog(root)
    expect(log.pending).toHaveLength(1)
    expect(log.pending[0].sliceId).toBe("s1")
  })
})
