import { test, expect } from "bun:test"
import { clampParallel, pidAlive } from "../../minimal/schedule.ts"

// Reservation layer (TB2 parity restored): effective width bounded by
// capacity BEFORE any measurement-based pacing — measurement alone is
// commitment-blind (admitted containers ramp to full cost after the check).

test("clampParallel: requested within capacity passes through", () => {
  const r = clampParallel(2, { cpus: 4, memTotalMb: 7925 }, { minCpusPer: 2, reserveMbPer: 800, memFloorMb: 1024 })
  expect(r.effective).toBe(2)
  expect(r.reason).toBeNull()
})

test("clampParallel: absurd request clamps to cpu bound (4 cpus / 2 min-cpus = 2)", () => {
  const r = clampParallel(1024, { cpus: 4, memTotalMb: 7925 }, { minCpusPer: 2, reserveMbPer: 800, memFloorMb: 1024 })
  expect(r.effective).toBe(2)
  expect(r.reason).toContain("cpu")
})

test("clampParallel: memory bound binds when tighter than cpu bound", () => {
  // 16 cpus but only 3224MB above floor → floor((3224)/800) = 4
  const r = clampParallel(100, { cpus: 16, memTotalMb: 4248 }, { minCpusPer: 2, reserveMbPer: 800, memFloorMb: 1024 })
  expect(r.effective).toBe(4)
  expect(r.reason).toContain("mem")
})

test("clampParallel: never below 1 even on tiny hosts", () => {
  const r = clampParallel(4, { cpus: 1, memTotalMb: 900 }, { minCpusPer: 2, reserveMbPer: 800, memFloorMb: 1024 })
  expect(r.effective).toBe(1)
})

test("clampParallel: k=1 sequential unaffected", () => {
  const r = clampParallel(1, { cpus: 4, memTotalMb: 7925 }, { minCpusPer: 2, reserveMbPer: 800, memFloorMb: 1024 })
  expect(r.effective).toBe(1)
  expect(r.reason).toBeNull()
})

// darwin reap bug: existsSync(/proc/pid) is linux-only — on darwin every pid
// looked dead and the stale-reap killed CONCURRENT LIVE runs' containers.
test("pidAlive: own process is alive on every platform", () => {
  expect(pidAlive(process.pid)).toBe(true)
})

test("pidAlive: unlikely-high pid reads dead", () => {
  expect(pidAlive(99999999)).toBe(false)
})
