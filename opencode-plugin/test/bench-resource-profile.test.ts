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
