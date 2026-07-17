import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  hostClass,
  profilePath,
  readHostProfiles,
  readResourceProfile,
  updateResourceProfile,
  PROFILE_WINDOW,
  packingWeight,
  raiseCapMeasured,
  PACK_MIN_SAMPLES,
  PACK_MIN_CPUS,
  PACK_MIN_MEM_MB,
  PACK_MEM_HEADROOM,
  CAP_MEM_HEADROOM,
  type TaskProfile,
} from "../src/bench/resource-profile.ts"

let meta: string
const HC = "test-host" // pin host-class so tests don't depend on the runner's CPU

beforeEach(() => {
  meta = fs.mkdtempSync(path.join(os.tmpdir(), "mh-resprofile-"))
})
afterEach(() => {
  fs.rmSync(meta, { recursive: true, force: true })
})

test("hostClass: <arch>-<Ncpu>c-<model-slug>, filename-safe", () => {
  const hc = hostClass()
  expect(hc).toMatch(/^[a-z0-9]+-\d+c-[a-z0-9-]+$/)
  expect(hc).not.toContain("/")
  expect(hc).not.toContain(" ")
})

test("readResourceProfile: absent → null (cold-start signal)", () => {
  expect(readResourceProfile(meta, "never-run", HC)).toBeNull()
  expect(readHostProfiles(meta, HC)).toEqual({})
})

test("updateResourceProfile: first sample → avgCpu=cpuSeconds/wall, n=1, persisted", () => {
  const prof = updateResourceProfile(meta, "taskA", { cpuSeconds: 100, peakRssMb: 512, wall: 200 }, HC)
  expect(prof.avgCpu).toBe(0.5) // 100/200
  expect(prof.peakRssMb).toBe(512)
  expect(prof.n).toBe(1)
  expect(prof.samples.length).toBe(1)
  // persisted to the per-host file, reloadable
  expect(fs.existsSync(profilePath(meta, HC))).toBe(true)
  expect(readResourceProfile(meta, "taskA", HC)).toEqual(prof)
})

test("updateResourceProfile: avgCpu is the MEDIAN across samples; peakRssMb the MAX", () => {
  updateResourceProfile(meta, "t", { cpuSeconds: 1, peakRssMb: 100, wall: 10 }, HC) // 0.1
  updateResourceProfile(meta, "t", { cpuSeconds: 30, peakRssMb: 800, wall: 10 }, HC) // 3.0
  const p = updateResourceProfile(meta, "t", { cpuSeconds: 5, peakRssMb: 400, wall: 10 }, HC) // 0.5
  // per-sample avgCpu = [0.1, 3.0, 0.5] → median 0.5
  expect(p.avgCpu).toBe(0.5)
  expect(p.peakRssMb).toBe(800) // max
  expect(p.n).toBe(3)
})

test("updateResourceProfile: samples window is capped at PROFILE_WINDOW; n keeps total", () => {
  for (let i = 0; i < PROFILE_WINDOW + 3; i++) {
    updateResourceProfile(meta, "t", { cpuSeconds: 10, peakRssMb: 10, wall: 10 }, HC)
  }
  const p = readResourceProfile(meta, "t", HC)!
  expect(p.samples.length).toBe(PROFILE_WINDOW)
  expect(p.n).toBe(PROFILE_WINDOW + 3) // total-ever, not windowed
})

test("updateResourceProfile: distinct tasks coexist in one host file; distinct host-classes in separate files", () => {
  updateResourceProfile(meta, "taskA", { cpuSeconds: 10, peakRssMb: 10, wall: 10 }, HC)
  updateResourceProfile(meta, "taskB", { cpuSeconds: 20, peakRssMb: 20, wall: 10 }, HC)
  const both = readHostProfiles(meta, HC)
  expect(Object.keys(both).sort()).toEqual(["taskA", "taskB"])

  updateResourceProfile(meta, "taskA", { cpuSeconds: 5, peakRssMb: 5, wall: 10 }, "other-host")
  expect(Object.keys(readHostProfiles(meta, "other-host"))).toEqual(["taskA"])
  expect(readHostProfiles(meta, HC)["taskA"]!.n).toBe(1) // unaffected by the other host
})

test("readHostProfiles: corrupt JSON → {} (never throws)", () => {
  const p = profilePath(meta, HC)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, "{not json")
  expect(readHostProfiles(meta, HC)).toEqual({})
})

test("updateResourceProfile: wall=0 contributes 0 to avgCpu (no divide-by-zero)", () => {
  const p = updateResourceProfile(meta, "t", { cpuSeconds: 50, peakRssMb: 10, wall: 0 }, HC)
  expect(p.avgCpu).toBe(0)
  expect(Number.isFinite(p.avgCpu)).toBe(true)
})

// --- packingWeight / raiseCapMeasured -------------------------------------

/** Pure helpers only read n/avgCpu/peakRssMb — samples content is irrelevant. */
function mkProfile(n: number, avgCpu: number, peakRssMb: number): TaskProfile {
  return { samples: [], avgCpu, peakRssMb, n }
}

test("packingWeight: null profile → prior verbatim, measured:false", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  expect(packingWeight(prior, null)).toEqual({ ...prior, measured: false })
})

test("packingWeight: n below PACK_MIN_SAMPLES (n=1, n=2) → prior verbatim, measured:false", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  expect(packingWeight(prior, mkProfile(1, 1, 512))).toEqual({ ...prior, measured: false })
  expect(packingWeight(prior, mkProfile(2, 1, 512))).toEqual({ ...prior, measured: false })
  expect(PACK_MIN_SAMPLES).toBe(3)
})

test("packingWeight: n>=3 → measured, cpus from avgCpu, mem = ceil(peak*PACK_MEM_HEADROOM)", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  const w = packingWeight(prior, mkProfile(3, 1.5, 700))
  expect(w).toEqual({ cpus: 1.5, memoryMb: Math.ceil(700 * PACK_MEM_HEADROOM), measured: true })
})

test("packingWeight: floors — avgCpu 0.05 -> PACK_MIN_CPUS, peakRssMb 100 -> max(120,256)=256", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  const w = packingWeight(prior, mkProfile(3, 0.05, 100))
  expect(w.cpus).toBe(PACK_MIN_CPUS)
  expect(w.memoryMb).toBe(PACK_MIN_MEM_MB)
  expect(w.measured).toBe(true)
})

test("packingWeight: avgCpu <= 0 -> prior verbatim, measured:false", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  expect(packingWeight(prior, mkProfile(5, 0, 500))).toEqual({ ...prior, measured: false })
  expect(packingWeight(prior, mkProfile(5, -1, 500))).toEqual({ ...prior, measured: false })
})

test("packingWeight: measured hotter than prior is NOT clamped (avgCpu 6 vs prior cpus 2 -> 6)", () => {
  const prior = { cpus: 2, memoryMb: 1024 }
  const w = packingWeight(prior, mkProfile(3, 6, 100))
  expect(w.cpus).toBe(6)
  expect(w.measured).toBe(true)
})

test("raiseCapMeasured: peak above cap -> raised to ceil(peak*CAP_MEM_HEADROOM)", () => {
  const cap = { cpus: 4, memoryMb: 1000 }
  const c = raiseCapMeasured(cap, mkProfile(3, 1, 800)) // 800*1.5 = 1200 > 1000
  expect(c.memoryMb).toBe(Math.ceil(800 * CAP_MEM_HEADROOM))
  expect(c.cpus).toBe(4)
})

test("raiseCapMeasured: peak*headroom below cap -> cap unchanged", () => {
  const cap = { cpus: 4, memoryMb: 5000 }
  const c = raiseCapMeasured(cap, mkProfile(3, 1, 800)) // 800*1.5 = 1200 < 5000
  expect(c.memoryMb).toBe(5000)
  expect(c.cpus).toBe(4)
})

test("raiseCapMeasured: null profile or n<PACK_MIN_SAMPLES -> cap verbatim", () => {
  const cap = { cpus: 4, memoryMb: 1000 }
  expect(raiseCapMeasured(cap, null)).toEqual(cap)
  expect(raiseCapMeasured(cap, mkProfile(1, 1, 9999))).toEqual(cap)
  expect(raiseCapMeasured(cap, mkProfile(2, 1, 9999))).toEqual(cap)
})

test("raiseCapMeasured: cpus never touched in any case", () => {
  const cap = { cpus: 4, memoryMb: 1000 }
  expect(raiseCapMeasured(cap, mkProfile(3, 1, 9999)).cpus).toBe(4)
  expect(raiseCapMeasured(cap, null).cpus).toBe(4)
})
