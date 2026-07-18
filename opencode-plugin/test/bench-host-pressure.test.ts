import { test, expect } from "bun:test"
import {
  createHostPressure,
  parseMemAvailablePct,
  parseMemoryPressureQ,
  parsePsiMemory,
  PRESSURE_POLL_SEC,
  LOAD_HI,
  LOAD_LO,
  MEMFREE_HI_PCT,
  MEMFREE_LO_PCT,
} from "../src/bench/host-pressure.ts"

const POLL_MS = PRESSURE_POLL_SEC * 1000

// ── parser fixtures ──────────────────────────────────────────────────────

// Captured live on this host (darwin 24.6.0, x86_64) via `memory_pressure -Q`.
const REAL_MEMORY_PRESSURE_Q = `The system has 17179869184 (4194304 pages with a page size of 4096).
System-wide memory free percentage: 60%
`

test("parseMemoryPressureQ: real captured darwin output → free percentage", () => {
  expect(parseMemoryPressureQ(REAL_MEMORY_PRESSURE_Q)).toBe(60)
})

test("parseMemoryPressureQ: malformed/missing line → null", () => {
  expect(parseMemoryPressureQ("")).toBeNull()
  expect(parseMemoryPressureQ("some unrelated output\n")).toBeNull()
  expect(parseMemoryPressureQ("System-wide memory free percentage: not-a-number%\n")).toBeNull()
})

const PSI_MEMORY_LINE = "some avg10=12.34 avg60=5.00 avg300=1.00 total=123456\nfull avg10=1.00 avg60=0.50 avg300=0.10 total=789\n"

test("parsePsiMemory: /proc/pressure/memory 'some avg10=' → number", () => {
  expect(parsePsiMemory(PSI_MEMORY_LINE)).toBe(12.34)
})

test("parsePsiMemory: malformed/missing 'some' line → null", () => {
  expect(parsePsiMemory("")).toBeNull()
  expect(parsePsiMemory("full avg10=1.00 avg60=0.50 avg300=0.10 total=789\n")).toBeNull()
  expect(parsePsiMemory("some avg10=not-a-number avg60=5.00\n")).toBeNull()
})

const MEMINFO = "MemTotal:       16000000 kB\nMemFree:         2000000 kB\nMemAvailable:    4000000 kB\n"

test("parseMemAvailablePct: MemTotal + MemAvailable → percent", () => {
  expect(parseMemAvailablePct(MEMINFO)).toBe(25) // 4000000/16000000 * 100
})

test("parseMemAvailablePct: malformed/missing fields → null", () => {
  expect(parseMemAvailablePct("")).toBeNull()
  expect(parseMemAvailablePct("MemTotal:       16000000 kB\n")).toBeNull() // no MemAvailable
  expect(parseMemAvailablePct("MemTotal:       0 kB\nMemAvailable:    0 kB\n")).toBeNull() // zero total
})

// ── test helpers ─────────────────────────────────────────────────────────

/** Controllable clock: starts at 0, `advance()` moves it forward by exactly
 * one poll window so each call is guaranteed to sample (not cache-hit). */
function mkClock() {
  let t = 0
  return { now: () => t, advance: (ms: number = POLL_MS) => (t += ms) }
}

function mkLog() {
  const lines: string[] = []
  return { log: (line: string) => lines.push(line), lines }
}

// ── per-signal transitions: CPU (load/core), normal direction ──────────────

test("CPU signal: load/core >= HI held for MIN_STATE_TICKS commits pressure; a single sample does not", () => {
  const clock = mkClock()
  const { log, lines } = mkLog()
  let load = LOAD_HI // 2.0, at the enter threshold
  const sensor = createHostPressure({
    platform: "linux", // no memory source injected below → mem signal stays null/calm
    ncpus: 1,
    loadavg: () => [load],
    // Both /proc reads succeed but parse to null (no PSI support, e.g. an
    // older kernel) — this is the parser-graceful path (module header),
    // NOT a read failure, so it must not touch the CPU signal at all.
    readFile: () => "",
    now: clock.now,
    log,
  })

  expect(sensor.underPressure()).toBe(false) // sample 1: tick 1, not yet committed
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // sample 2: tick 2 → commits
  expect(lines).toEqual(["  [pressure] paused launches (load/core 2.0)"])

  // Dead zone: between LO(1.2) and HI(2.0), stays pressured (hysteresis).
  load = 1.5
  clock.advance()
  expect(sensor.underPressure()).toBe(true)

  // Exit requires <= LO held for MIN_STATE_TICKS.
  load = LOAD_LO
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // tick 1 of exit, not yet
  clock.advance()
  expect(sensor.underPressure()).toBe(false) // tick 2 → commits exit
  expect(lines).toEqual(["  [pressure] paused launches (load/core 2.0)", "  [pressure] resumed (load/core 1.2)"])
})

// ── per-signal transitions: mem-free% INVERTED direction, pinned explicitly ─

test("mem-free% signal is INVERTED: enters at <= MEMFREE_HI_PCT (a LOW number), exits at >= MEMFREE_LO_PCT (a HIGHER number)", () => {
  expect(MEMFREE_HI_PCT).toBeLessThan(MEMFREE_LO_PCT) // pin the inversion itself

  const clock = mkClock()
  const { log, lines } = mkLog()
  let freePct = MEMFREE_HI_PCT // 10, at the enter threshold (LOW free% = bad)
  const sensor = createHostPressure({
    platform: "darwin",
    ncpus: 1,
    loadavg: () => [0.1], // CPU signal stays calm throughout — isolates mem
    execFn: () => `System-wide memory free percentage: ${freePct}%\n`,
    now: clock.now,
    log,
  })

  expect(sensor.underPressure()).toBe(false) // tick 1
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // tick 2 → commits (LOW free% entered pressure)
  expect(lines).toEqual(["  [pressure] paused launches (load/core 0.1, mem 10% free)"])

  // Dead zone: between HI(10) and LO(20), stays pressured.
  freePct = 15
  clock.advance()
  expect(sensor.underPressure()).toBe(true)

  // Exit requires >= LO (a HIGHER free%, i.e. more free memory) held for
  // MIN_STATE_TICKS — the opposite comparison direction from load/PSI.
  freePct = MEMFREE_LO_PCT // 20
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // tick 1 of exit
  clock.advance()
  expect(sensor.underPressure()).toBe(false) // tick 2 → commits exit
  expect(lines).toEqual([
    "  [pressure] paused launches (load/core 0.1, mem 10% free)",
    "  [pressure] resumed (load/core 0.1)",
  ])
})

// ── flap guard ───────────────────────────────────────────────────────────

test("flap guard: a single tick past HI then back below it never commits (1-tick flip blocked)", () => {
  const clock = mkClock()
  const { log, lines } = mkLog()
  let load = 0.1
  const sensor = createHostPressure({
    platform: "linux",
    ncpus: 1,
    loadavg: () => [load],
    readFile: () => "", // parses to null gracefully — no mem signal, CPU isolated
    now: clock.now,
    log,
  })

  expect(sensor.underPressure()).toBe(false)

  load = 3.0 // well above HI
  clock.advance()
  expect(sensor.underPressure()).toBe(false) // tick 1 only — not committed

  load = 0.1 // flips back before the second tick
  clock.advance()
  expect(sensor.underPressure()).toBe(false) // streak reset, never entered pressure
  expect(lines).toEqual([]) // no combined-state change ever logged
})

// ── OR composition ───────────────────────────────────────────────────────

test("underPressure() = OR of per-signal states: one tripped signal keeps pressure while the other is calm", () => {
  const clock = mkClock()
  const { log } = mkLog()
  let load = LOAD_HI
  let freePct = 60 // calm
  const sensor = createHostPressure({
    platform: "darwin",
    ncpus: 1,
    loadavg: () => [load],
    execFn: () => `System-wide memory free percentage: ${freePct}%\n`,
    now: clock.now,
    log,
  })

  sensor.underPressure()
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // CPU alone trips it

  // CPU recovers, but memory now trips — combined must STAY true throughout
  // (never a false blip in between) as long as at least one signal is up.
  load = LOAD_LO
  freePct = MEMFREE_HI_PCT
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // CPU tick 1 of exit, mem tick 1 of enter — still true (CPU not yet exited)
  clock.advance()
  // CPU exits (tick 2), mem enters (tick 2) in the same sample — OR keeps it true.
  expect(sensor.underPressure()).toBe(true)

  // Now only memory is pressured; recovering it (and nothing else pressured)
  // is required before combined finally clears.
  freePct = MEMFREE_LO_PCT
  clock.advance()
  expect(sensor.underPressure()).toBe(true) // mem tick 1 of exit
  clock.advance()
  expect(sensor.underPressure()).toBe(false) // mem tick 2 → both signals calm → combined clears
})

// ── cache / tick semantics ───────────────────────────────────────────────

test("cache: samples at most once per PRESSURE_POLL_SEC — a burst of calls within one window advances no tick counter and re-reads nothing", () => {
  const clock = mkClock()
  const { log } = mkLog()
  let loadCalls = 0
  const sensor = createHostPressure({
    platform: "linux",
    ncpus: 1,
    loadavg: () => {
      loadCalls++
      return [LOAD_HI] // would tick toward pressure if actually sampled
    },
    readFile: () => "", // parses to null gracefully — no mem signal, CPU isolated
    now: clock.now,
    log,
  })

  sensor.underPressure() // sample 1 (tick 1)
  expect(loadCalls).toBe(1)

  // Burst of calls with NO time advance — every one must be a cache hit.
  for (let i = 0; i < 5; i++) sensor.underPressure()
  expect(loadCalls).toBe(1) // still just the one real sample

  // Advancing time and sampling again must show tick 2 → commit (proving
  // the burst above truly advanced nothing — if it had, this would already
  // have committed on the burst instead of needing this second real sample).
  clock.advance()
  expect(sensor.underPressure()).toBe(true)
  expect(loadCalls).toBe(2)
})

// ── whole-body throw fail-safe ───────────────────────────────────────────

test("fail-safe: a throw anywhere in the sample path → no pressure, logs exactly once, closure itself never throws", () => {
  const clock = mkClock()
  const { log, lines } = mkLog()
  const sensor = createHostPressure({
    platform: "linux",
    ncpus: 1,
    loadavg: () => {
      throw new Error("loadavg exploded")
    },
    readFile: () => {
      throw new Error("unreachable")
    },
    now: clock.now,
    log,
  })

  let result: boolean | undefined
  expect(() => {
    result = sensor.underPressure()
  }).not.toThrow()
  expect(result).toBe(false)
  expect(lines.length).toBe(1)
  expect(sensor.state()).toBe("normal")
})

// ── exact log lines (combined-state change only) ────────────────────────

test("exact log line: paused launches includes load/core AND mem free% (darwin)", () => {
  const clock = mkClock()
  const { log, lines } = mkLog()
  const sensor = createHostPressure({
    platform: "darwin",
    ncpus: 1,
    loadavg: () => [2.4],
    execFn: () => "System-wide memory free percentage: 8%\n",
    now: clock.now,
    log,
  })
  sensor.underPressure()
  clock.advance()
  sensor.underPressure()
  expect(lines).toEqual(["  [pressure] paused launches (load/core 2.4, mem 8% free)"])
})

test("exact log line: resumed includes only load/core", () => {
  const clock = mkClock()
  const { log, lines } = mkLog()
  let load = 2.4
  let freePct = 8
  const sensor = createHostPressure({
    platform: "darwin",
    ncpus: 1,
    loadavg: () => [load],
    execFn: () => `System-wide memory free percentage: ${freePct}%\n`,
    now: clock.now,
    log,
  })
  sensor.underPressure()
  clock.advance()
  sensor.underPressure() // commits pause

  load = 1.1
  freePct = 60
  clock.advance()
  sensor.underPressure() // exit tick 1
  clock.advance()
  sensor.underPressure() // exit tick 2 → commits resume

  expect(lines).toEqual([
    "  [pressure] paused launches (load/core 2.4, mem 8% free)",
    "  [pressure] resumed (load/core 1.1)",
  ])
})

// ── no-signal / undefined-injection defaults sanity ─────────────────────

test("state(): reflects combined committed state without sampling ('normal' initially)", () => {
  const sensor = createHostPressure({
    platform: "linux",
    ncpus: 1,
    loadavg: () => [0.1],
    readFile: () => "",
    now: () => 0,
    log: () => {},
  })
  expect(sensor.state()).toBe("normal")
})
