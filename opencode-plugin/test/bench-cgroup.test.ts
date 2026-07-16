import { test, expect } from "bun:test"
import { parseCgroupStats, readCgroupStats } from "../src/bench/cgroup.ts"
import type { ExecResult } from "../src/bench/exec.ts"

// Real cgroup v2 cpu.stat is multi-line; our READ_CMD appends a `PEAK <bytes>`
// line for memory.peak. Fixture mirrors the live probe output.
const CPU_STAT =
  "usage_usec 1120888\nuser_usec 1107597\nsystem_usec 13291\nnr_periods 0\nnr_throttled 0\nthrottled_usec 0\n"

test("parseCgroupStats: usage_usec → cpuSeconds (µs/1e6, 1dp), PEAK bytes → peakRssMb (MiB)", () => {
  const s = parseCgroupStats(CPU_STAT + "PEAK 1851392\n")
  expect(s).not.toBeNull()
  expect(s!.cpuSeconds).toBe(1.1) // 1120888µs = 1.120888s → round1 = 1.1
  expect(s!.peakRssMb).toBe(2) // 1851392 / 1024² = 1.765… → round = 2
})

test("parseCgroupStats: missing PEAK line → peakRssMb 0, cpuSeconds still parsed", () => {
  const s = parseCgroupStats(CPU_STAT + "PEAK \n") // empty memory.peak (older kernel)
  expect(s).not.toBeNull()
  expect(s!.cpuSeconds).toBe(1.1)
  expect(s!.peakRssMb).toBe(0)
})

test("parseCgroupStats: no usage_usec → null (no CPU signal)", () => {
  expect(parseCgroupStats("PEAK 1000000\n")).toBeNull()
  expect(parseCgroupStats("")).toBeNull()
  // must anchor on a line boundary — a substring like `foo_usage_usec 5` must not match
  expect(parseCgroupStats("foo_usage_usec 5\n")).toBeNull()
})

test("readCgroupStats: rc≠0 → null (container gone / read failed)", async () => {
  const execFn = async (): Promise<ExecResult> => ({ rc: 1, stdout: "", stderr: "no such container", timedOut: false })
  expect(await readCgroupStats("gone", execFn)).toBeNull()
})

test("readCgroupStats: execFn throws (missing binary) → null, never propagates", async () => {
  const execFn = async (): Promise<ExecResult> => {
    throw new Error("spawn podman ENOENT")
  }
  expect(await readCgroupStats("x", execFn)).toBeNull()
})

test("readCgroupStats: happy path parses the exec'd stdout", async () => {
  const execFn = async (): Promise<ExecResult> => ({
    rc: 0,
    stdout: CPU_STAT + "PEAK 1851392\n",
    stderr: "",
    timedOut: false,
  })
  const s = await readCgroupStats("live", execFn)
  expect(s).toEqual({ cpuSeconds: 1.1, peakRssMb: 2 })
})
