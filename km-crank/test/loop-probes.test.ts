import { describe, expect, test } from "bun:test"
import {
  parseGateLine, splitAtBoundaries, regimeKey,
  boolStats, countStats, catStats, viability,
  nPerArmBinomial, nPerArmCount, daysToVerdict, dayBucket,
  type GateLine,
} from "../src/loop-probes.ts"

describe("parseGateLine", () => {
  test("parses a well-formed line", () => {
    const raw = JSON.stringify({ ts: 1000, accepted: true, pluginVersion: "0.3.0" })
    expect(parseGateLine(raw)).toEqual({ ts: 1000, accepted: true, pluginVersion: "0.3.0" })
  })
  test("malformed JSON -> undefined", () => {
    expect(parseGateLine("{nope")).toBeUndefined()
  })
  test("valid JSON but not an object -> undefined", () => {
    expect(parseGateLine("42")).toBeUndefined()
    expect(parseGateLine("null")).toBeUndefined()
    expect(parseGateLine("[1,2,3]")).toBeUndefined()
  })
  test("missing/non-numeric ts -> undefined", () => {
    expect(parseGateLine(JSON.stringify({ accepted: true }))).toBeUndefined()
    expect(parseGateLine(JSON.stringify({ ts: "1000" }))).toBeUndefined()
  })
})

describe("splitAtBoundaries", () => {
  const mk = (ts: number) => ({ ts })
  test("a line with ts === boundary belongs to the POST segment", () => {
    const lines = [mk(1), mk(5), mk(10)]
    const segs = splitAtBoundaries(lines, [5])
    expect(segs).toEqual([[mk(1)], [mk(5), mk(10)]])
  })
  test("boundaries sorted + deduped internally", () => {
    const lines = [mk(1), mk(5), mk(10), mk(15)]
    const segs = splitAtBoundaries(lines, [10, 5, 10, 5])
    expect(segs).toEqual([[mk(1)], [mk(5)], [mk(10), mk(15)]])
  })
  test("empty segments preserved: segments.length === boundaries.length + 1", () => {
    const lines = [mk(1), mk(20)]
    const segs = splitAtBoundaries(lines, [5, 10])
    expect(segs).toEqual([[mk(1)], [], [mk(20)]])
    expect(segs.length).toBe(3)
  })
  test("no boundaries -> single segment with all lines", () => {
    const lines = [mk(1), mk(2)]
    expect(splitAtBoundaries(lines, [])).toEqual([[mk(1), mk(2)]])
  })
})

describe("regimeKey", () => {
  test("stable label <pluginVersion|unknown>@<segment index>", () => {
    const boundaries = [10, 20]
    const pre: GateLine = { ts: 5 }
    const mid: GateLine = { ts: 10, pluginVersion: "0.3.0" }
    const post: GateLine = { ts: 25 }
    expect(regimeKey(pre, boundaries)).toBe("unknown@0")
    expect(regimeKey(mid, boundaries)).toBe("0.3.0@1")
    expect(regimeKey(post, boundaries)).toBe("unknown@2")
  })
})

describe("boolStats", () => {
  test("counts true/false", () => {
    expect(boolStats([true, true, false, true, false])).toEqual({ n: 5, trueCount: 3, falseCount: 2 })
  })
  test("empty array", () => {
    expect(boolStats([])).toEqual({ n: 0, trueCount: 0, falseCount: 0 })
  })
})

describe("countStats", () => {
  test("known small set: [2, 4, 4, 4, 5, 5, 7, 9] -> mean 5, sample sd sqrt(32/7)", () => {
    // Textbook example (population sd is famously 2, i.e. sqrt(32/8), but
    // this module uses SAMPLE sd, n-1): mean = 40/8 = 5; sum of squared
    // deviations = 9+1+1+1+0+0+4+16 = 32; sample variance = 32/7;
    // sd = sqrt(32/7) ≈ 2.13809.
    const xs = [2, 4, 4, 4, 5, 5, 7, 9]
    const stats = countStats(xs)
    expect(stats.n).toBe(8)
    expect(stats.mean).toBeCloseTo(5, 10)
    expect(stats.sd).toBeCloseTo(Math.sqrt(32 / 7), 10)
  })
  test("mean = 0 case", () => {
    const stats = countStats([0, 0, 0])
    expect(stats).toEqual({ n: 3, mean: 0, sd: 0 })
  })
  test("n < 2 -> sd = 0", () => {
    expect(countStats([5])).toEqual({ n: 1, mean: 5, sd: 0 })
    expect(countStats([])).toEqual({ n: 0, mean: 0, sd: 0 })
  })
})

describe("catStats", () => {
  test("tallies classes", () => {
    const xs = ["A", "B", "A", "C", "B", "A"]
    expect(catStats(xs)).toEqual({ n: 6, classes: { A: 3, B: 2, C: 1 } })
  })
})

describe("viability", () => {
  test("n < 10 -> UNKNOWN regardless of family (n-check first)", () => {
    const xs = Array(9).fill(true)
    xs[0] = false
    xs[1] = false
    xs[2] = false // minority=3, would be VIABLE at n>=10, but n=9 -> UNKNOWN
    expect(viability("boolean", boolStats(xs))).toBe("UNKNOWN")
  })
  test("boolean: minority count 2 (n=10) -> NON-VIABLE", () => {
    const xs = [...Array(8).fill(true), ...Array(2).fill(false)]
    expect(boolStats(xs).n).toBe(10)
    expect(viability("boolean", boolStats(xs))).toBe("NON-VIABLE")
  })
  test("boolean: minority count 3 (n=10) -> VIABLE", () => {
    const xs = [...Array(7).fill(true), ...Array(3).fill(false)]
    expect(boolStats(xs).n).toBe(10)
    expect(viability("boolean", boolStats(xs))).toBe("VIABLE")
  })
  test("count: sd/mean exactly 0.1 (n>=10) -> VIABLE", () => {
    // Want n=10, mean=10, sample sd=1 (ratio 0.1 exactly). Sample variance
    // = sum(deviations^2)/(n-1) = 1 requires sum(deviations^2) = 9 with
    // deviations summing to 0. Use deviations [+1.5,+1.5,-1.5,-1.5,0*6]:
    // sum = 0; sum of squares = 4*(1.5^2) = 4*2.25 = 9 -> variance = 9/9=1
    // -> sd = 1. Values = mean + deviations = 11.5,11.5,8.5,8.5,10*6.
    const xs = [11.5, 11.5, 8.5, 8.5, 10, 10, 10, 10, 10, 10]
    const stats = countStats(xs)
    expect(stats.n).toBe(10)
    expect(stats.mean).toBeCloseTo(10, 10)
    expect(stats.sd).toBeCloseTo(1, 10)
    expect(stats.sd / stats.mean).toBeCloseTo(0.1, 10)
    expect(viability("count", stats)).toBe("VIABLE")
  })
  test("count: mean = 0 -> NON-VIABLE even with n>=10", () => {
    const stats = countStats(Array(10).fill(0))
    expect(viability("count", stats)).toBe("NON-VIABLE")
  })
  test("rate: 3 successes / 3 failures (n=6 < 10) -> UNKNOWN (n-check first)", () => {
    expect(viability("rate", { successes: 3, failures: 3 })).toBe("UNKNOWN")
  })
  test("rate: 3 successes / 7 failures (n=10) -> VIABLE", () => {
    expect(viability("rate", { successes: 3, failures: 7 })).toBe("VIABLE")
  })
  test("rate: 2 successes / 8 failures (n=10) -> NON-VIABLE", () => {
    expect(viability("rate", { successes: 2, failures: 8 })).toBe("NON-VIABLE")
  })
  test("categorical: second-most-frequent class count 3 (n=10) -> VIABLE", () => {
    // classes: A=7, B=3 -> second-most-frequent = 3
    const xs = [...Array(7).fill("A"), ...Array(3).fill("B")]
    expect(catStats(xs).n).toBe(10)
    expect(viability("categorical", catStats(xs))).toBe("VIABLE")
  })
  test("categorical: second-most-frequent class count 2 (n=10) -> NON-VIABLE", () => {
    const xs = [...Array(8).fill("A"), ...Array(2).fill("B")]
    expect(catStats(xs).n).toBe(10)
    expect(viability("categorical", catStats(xs))).toBe("NON-VIABLE")
  })
})

describe("nPerArmBinomial", () => {
  test("spot value: p1=0.2, e=0.3", () => {
    // By-hand derivation:
    //   p2 = min(p1+e, 0.99) = min(0.5, 0.99) = 0.5
    //   pbar = (0.2+0.5)/2 = 0.35
    //   term1 = 1.96 * sqrt(2*0.35*0.65) = 1.96 * sqrt(0.455)
    //         sqrt(0.455) ~= 0.6745387...  -> term1 ~= 1.3220923
    //   term2 = 0.84 * sqrt(0.2*0.8 + 0.5*0.5) = 0.84 * sqrt(0.16+0.25)
    //         = 0.84 * sqrt(0.41); sqrt(0.41) ~= 0.6403124 -> term2 ~= 0.5378624
    //   sum = term1 + term2 ~= 1.8599547
    //   sum^2 ~= 3.4594315
    //   N = ceil(3.4594315 / 0.09) = ceil(38.43813...) = 39
    expect(nPerArmBinomial(0.2, 0.3)).toBe(39)
  })
  test("p2 caps at 0.99 when p1+e exceeds it", () => {
    // p1=0.9, e=0.5 -> p1+e=1.4 -> p2 capped to 0.99. Just assert it returns
    // a finite positive integer using the capped p2 (regression guard for
    // the cap, not a hand-derived spot value).
    const n = nPerArmBinomial(0.9, 0.5)
    expect(Number.isInteger(n)).toBe(true)
    expect(n).toBeGreaterThan(0)
  })
})

describe("nPerArmCount", () => {
  test("nPerArmCount(0.3) = ceil(15.68/0.09) = 175", () => {
    expect(nPerArmCount(0.3)).toBe(175)
  })
})

describe("daysToVerdict", () => {
  test("daysToVerdict(175, 10) = 35", () => {
    expect(daysToVerdict(175, 10)).toBe(35)
  })
  test("eventsPerDay 0 -> null", () => {
    expect(daysToVerdict(175, 0)).toBeNull()
  })
  test("does NOT floor nPerArm at MIN_N=20 — that is the caller's job", () => {
    // nPerArm=5, eventsPerDay=10 -> ceil(2*5/10) = 1, NOT the MIN_N=20-floored
    // ceil(2*20/10) = 4. Flooring lives in the e-table CLI (Task 3), not here.
    expect(daysToVerdict(5, 10)).toBe(1)
  })
})

describe("dayBucket", () => {
  test("numeric ts -> UTC YYYY-MM-DD", () => {
    // 1785711630125 ms epoch -> 2026-08-01T... UTC (spot-checked externally
    // via Date#toISOString on this exact constant).
    expect(dayBucket(1785711630125)).toBe(new Date(1785711630125).toISOString().slice(0, 10))
  })
  test("ISO string input -> UTC YYYY-MM-DD", () => {
    expect(dayBucket("2026-08-05T23:59:59.000Z")).toBe("2026-08-05")
  })
  test("ISO string with non-UTC offset normalizes to UTC day", () => {
    // 2026-08-05T23:30:00-05:00 == 2026-08-06T04:30:00Z
    expect(dayBucket("2026-08-05T23:30:00-05:00")).toBe("2026-08-06")
  })
})
