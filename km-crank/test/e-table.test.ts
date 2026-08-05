/** Tests for scripts/e-table.ts (task-3 brief). Direct-function tests
 * exercise the pure aggregation helpers (viableSignals, viableP1Sources,
 * buildCrosses, buildETable) against small synthetic P0/P1 fixture
 * objects — no subprocess, no disk. One subprocess-level test proves the
 * CLI wiring end-to-end via the env seams (KKAMAK_PROBE_P0_JSON,
 * KKAMAK_PROBE_P1_JSON), matching the real CLI's file-read + JSON-write +
 * stdout-table contract. Real committed docs/loop-probes/*.json are never
 * touched by any test here. */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tmpdir } from "node:os"
import { spawnSync } from "node:child_process"
import { nPerArmBinomial, nPerArmCount } from "../src/loop-probes.ts"
import {
  SPEC_PATH, EFFECTS, MIN_N, BAR_DAYS,
  viableSignals, viableP1Sources, buildCrosses, buildETable,
  type ExcludedEntry, type Cross,
} from "../../scripts/e-table.ts"

const SCRIPT = path.join(import.meta.dir, "..", "..", "scripts", "e-table.ts")

const CLEANUP: string[] = []
afterEach(() => {
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

// b2: count family, VIABLE, mean/sd irrelevant to the N formula (it takes
// only the standardized effect d) but reported as context.
// b4: rate family, VIABLE, successes=14/failures=6 -> p1 = 14/20 = 0.7.
// b1.accepted / b3.live: present but NOT viable -> must land in `excluded`.
const P0_FIXTURE = {
  b1: {
    accepted: { family: "boolean", viability: "UNKNOWN", stats: { n: 5, trueCount: 5, falseCount: 0 } },
  },
  b2: { family: "count", viability: "VIABLE", stats: { n: 8, mean: 3.5, sd: 2.0 } },
  // Mirrors the REAL P0 json's b3 shape exactly: `family` lives on b3
  // itself, NOT per provenance entry (a live regression: toSignal must
  // fall back to the parent's family or this entry silently vanishes
  // from allP0Signals instead of landing in `excluded`).
  b3: {
    family: "categorical",
    provenance: {
      live: { viability: "UNKNOWN (binarization undeclared)", stats: { n: 10 } },
    },
  },
  b4: { family: "rate", viability: "VIABLE", stats: { successes: 14, failures: 6 } },
}

// s1 eventsPerDay=10; s2 has one live repo (repoA, 5/day) and one dead one
// (repoB, 0/day -> must be excluded); s3 addsPerDay=2 (low, so b2 x s3
// misses the 14-day bar at its raw rate -> NO-CONFIG-PASSES fixture).
// s4 is always excluded regardless of shape (boundary-split view of s1).
const P1_FIXTURE = {
  s1: { eventsPerDay: 10 },
  s2: { repos: [{ label: "repoA", commitsPerDay: 5 }, { label: "repoB", commitsPerDay: 0 }] },
  s3: { addsPerDay: 2 },
  s4: { segments: [{ index: 0, n: 1 }] },
}

// Same as P1_FIXTURE but s3 fast enough that b2 x s3 clears the bar at
// effect 0.30 (350/30 = 11.67 -> ceil 12 <= 14) -> PASS branch.
const P1_FIXTURE_FAST_S3 = { ...P1_FIXTURE, s3: { addsPerDay: 30 } }

function findCross(crosses: Cross[], signal: string, source: string): Cross {
  const c = crosses.find(x => x.signal === signal && x.source === source)
  if (!c) throw new Error(`no cross for ${signal}x${source}`)
  return c
}

// ---------------------------------------------------------------------
// viableSignals / viableP1Sources
// ---------------------------------------------------------------------

describe("viableSignals", () => {
  test("keeps only VIABLE count/rate signals, excludes the rest with reasons", () => {
    const excluded: ExcludedEntry[] = []
    const signals = viableSignals(P0_FIXTURE, excluded)
    expect(signals.map(s => s.label).sort()).toEqual(["b2", "b4"])

    const excludedLabels = excluded.map(e => e.label).sort()
    expect(excludedLabels).toEqual(["b1.accepted", "b3.live"])
    const b1Excl = excluded.find(e => e.label === "b1.accepted")!
    expect(b1Excl.viability).toBe("UNKNOWN")
    expect(b1Excl.reason).toContain("not VIABLE")

    // b3.live's family comes from the PARENT (b3.family), not the entry
    // itself (real-json shape) -- must still resolve to "categorical",
    // not "unknown", proving the fallback wiring works.
    const b3Excl = excluded.find(e => e.label === "b3.live")!
    expect(b3Excl.family).toBe("categorical")
    expect(b3Excl.reason).toContain("not VIABLE")
  })
})

describe("viableP1Sources", () => {
  test("keeps sources with eventsPerDay > 0, always excludes s4, excludes zero-rate sources", () => {
    const excluded: ExcludedEntry[] = []
    const sources = viableP1Sources(P1_FIXTURE, excluded)
    expect(sources).toEqual([
      { label: "s1", eventsPerDay: 10 },
      { label: "s2:repoA", eventsPerDay: 5 },
      { label: "s3", eventsPerDay: 2 },
    ])
    const excludedLabels = excluded.map(e => e.label).sort()
    expect(excludedLabels).toEqual(["s2:repoB", "s4"])
    const s4Excl = excluded.find(e => e.label === "s4")!
    expect(s4Excl.reason).toContain("not an independent event source")
    const repoBExcl = excluded.find(e => e.label === "s2:repoB")!
    expect(repoBExcl.reason).toContain("eventsPerDay is 0")
  })
})

// ---------------------------------------------------------------------
// buildCrosses — count row, rate row, MIN_N floor, meaningful flags
// ---------------------------------------------------------------------

describe("buildCrosses", () => {
  const excluded: ExcludedEntry[] = []
  const signals = viableSignals(P0_FIXTURE, excluded)
  const sources = viableP1Sources(P1_FIXTURE, excluded)
  const crosses = buildCrosses(signals, sources)

  test("2 viable signals x 3 viable sources = 6 crosses", () => {
    expect(crosses).toHaveLength(2 * 3)
  })

  test("known count-family row: b2 x s1, effect 0.30 -> nPerArmCount 175, floored 175, days ceil(350/10)=35", () => {
    const c = findCross(crosses, "b2", "s1")
    expect(c.family).toBe("count")
    expect(c.p1OrMoments).toEqual({ mean: 3.5, sd: 2.0 })
    const row030 = c.effects.find(e => e.effect === 0.30)!
    expect(nPerArmCount(0.30)).toBe(175)
    expect(row030.nPerArm).toBe(175)
    expect(row030.floored).toBe(175)
    expect(row030.daysToVerdict).toBe(35)
    expect(c.passesBarAt030).toBe(false) // 35 > 14
  })

  test("rate row: b4 x s1 uses nPerArmBinomial with fixture's p1 = 14/20 = 0.7", () => {
    const c = findCross(crosses, "b4", "s1")
    expect(c.family).toBe("rate")
    expect(c.p1OrMoments).toEqual({ p1: 0.7 })
    const row010 = c.effects.find(e => e.effect === 0.10)!
    const expectedN = nPerArmBinomial(0.7, 0.10)
    expect(row010.nPerArm).toBe(expectedN)
    expect(row010.floored).toBe(Math.max(expectedN, MIN_N))
    expect(row010.daysToVerdict).toBe(Math.ceil((2 * Math.max(expectedN, MIN_N)) / 10))
  })

  test("MIN_N=20 floor binds for b4 x s1 at effect 0.40 (large effect -> small raw N)", () => {
    const c = findCross(crosses, "b4", "s1")
    const row040 = c.effects.find(e => e.effect === 0.40)!
    const rawN = nPerArmBinomial(0.7, 0.40)
    expect(rawN).toBeLessThan(20) // confirms this fixture actually exercises the floor
    expect(row040.nPerArm).toBe(rawN)
    expect(row040.floored).toBe(20)
    expect(row040.daysToVerdict).toBe(Math.ceil((2 * 20) / 10))
  })

  test("effects table covers exactly {0.10,0.20,0.30,0.40} in order", () => {
    const c = findCross(crosses, "b2", "s1")
    expect(c.effects.map(e => e.effect)).toEqual([...EFFECTS])
  })

  test("meaningful: only b2 x s3 is true; every other cross is false with the standard reason", () => {
    for (const c of crosses) {
      if (c.signal === "b2" && c.source === "s3") {
        expect(c.meaningful).toBe(true)
        expect(c.reason).toBeUndefined()
      } else {
        expect(c.meaningful).toBe(false)
        expect(c.reason).toBe("signal does not ride this source today")
      }
    }
  })

  test("passesBarAt030 uses BAR_DAYS=14 at effect 0.30: b4 x s1 (fast source, small N) passes, b2 x s3 (slow source, large N) does not", () => {
    const b4s1 = findCross(crosses, "b4", "s1")
    expect(b4s1.passesBarAt030).toBe(true)
    const b2s3 = findCross(crosses, "b2", "s3")
    expect(b2s3.passesBarAt030).toBe(false)
    expect(BAR_DAYS).toBe(14)
  })
})

// ---------------------------------------------------------------------
// buildETable — full wiring + verdict branches
// ---------------------------------------------------------------------

describe("buildETable", () => {
  test("NO-CONFIG-PASSES: the only meaningful cross (b2 x s3) misses the bar", () => {
    const out = buildETable(P0_FIXTURE, P1_FIXTURE, "p0.json", "p1.json", "test-host", 12345)
    expect(out.spec).toBe(SPEC_PATH)
    expect(out.generatedAtTs).toBe(12345)
    expect(out.hostname).toBe("test-host")
    expect(out.inputs).toEqual({ p0: "p0.json", p1: "p1.json" })
    expect(out.crosses).toHaveLength(6)
    expect(out.excluded).toHaveLength(4) // b1.accepted, b3.live, s4, s2:repoB
    expect(out.verdict).toEqual({ meaningfulCrosses: 1, passing: 0, verdict: "NO-CONFIG-PASSES" })
  })

  test("PASS: a faster s3 pushes the one meaningful cross (b2 x s3) under the 14-day bar", () => {
    const out = buildETable(P0_FIXTURE, P1_FIXTURE_FAST_S3, "p0.json", "p1.json", "test-host", 12345)
    const b2s3 = out.crosses.find(c => c.signal === "b2" && c.source === "s3")!
    expect(b2s3.meaningful).toBe(true)
    expect(b2s3.passesBarAt030).toBe(true)
    expect(out.verdict).toEqual({ meaningfulCrosses: 1, passing: 1, verdict: "PASS" })
  })
})

// ---------------------------------------------------------------------
// CLI subprocess — env-seam fixtures, real file write + stdout table
// ---------------------------------------------------------------------

describe("e-table CLI", () => {
  test("reads P0/P1 fixture jsons via env seams, writes docs/loop-probes/<hostname>-e-table.json, prints a table", () => {
    const cwd = mkTmp("e-table-cli-")
    const p0File = path.join(cwd, "p0.json")
    const p1File = path.join(cwd, "p1.json")
    fs.writeFileSync(p0File, JSON.stringify(P0_FIXTURE))
    fs.writeFileSync(p1File, JSON.stringify(P1_FIXTURE))

    const r = spawnSync("bun", [SCRIPT], {
      cwd, encoding: "utf8",
      env: { ...process.env, KKAMAK_PROBE_P0_JSON: p0File, KKAMAK_PROBE_P1_JSON: p1File },
    })
    expect(r.status).toBe(0)

    const outFile = path.join(cwd, "docs", "loop-probes", `${os.hostname()}-e-table.json`)
    expect(fs.existsSync(outFile)).toBe(true)
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))

    expect(out.spec).toBe(SPEC_PATH)
    expect(out.hostname).toBe(os.hostname())
    expect(out.inputs).toEqual({ p0: p0File, p1: p1File })
    expect(out.crosses).toHaveLength(6)
    expect(out.verdict).toEqual({ meaningfulCrosses: 1, passing: 0, verdict: "NO-CONFIG-PASSES" })

    const stdout = r.stdout ?? ""
    expect(stdout).toContain("meaningful crosses: 1")
    expect(stdout).toContain("verdict: NO-CONFIG-PASSES")
    expect(stdout).toContain("b2")
    expect(stdout).toContain("b4")
  })
})
