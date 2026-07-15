import { test, expect } from "bun:test"
import { schedule, packPreview, fitsBudget, exceedsTotalBudget, AsyncMutex, DEFAULT_BUDGET, type Budget, type ScheduledItem } from "../src/bench/scheduler.ts"

// ── test helpers ─────────────────────────────────────────────────────────

interface Deferred<T> {
  promise: Promise<T>
  resolve: (v: T) => void
  reject: (e: unknown) => void
}

function deferred<T = void>(): Deferred<T> {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/** Flush pending microtasks without any real timers/sleeps. */
async function flush(times = 5): Promise<void> {
  for (let i = 0; i < times; i++) await Promise.resolve()
}

function item(key: string, cpus: number, memoryMb = 1024): ScheduledItem {
  return { key, cpus, memoryMb }
}

// ── schedule() ───────────────────────────────────────────────────────────

test("3 lights co-run under default budget", async () => {
  const launched: string[] = []
  const deferreds = new Map<string, Deferred<void>>()
  const items = [item("0", 1), item("1", 1), item("2", 1)]

  const runFn = (it: ScheduledItem): Promise<void> => {
    launched.push(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise
  }

  const result = schedule(items, DEFAULT_BUDGET, runFn)

  // All three fit synchronously (1+1+1 = 3 <= budget.cpus) — canonical order,
  // all launched before any of them completes.
  expect(launched).toEqual(["0", "1", "2"])

  for (const key of ["0", "1", "2"]) deferreds.get(key)!.resolve()
  await result
})

test("2-cpu item packs with one 1-cpu, not two", async () => {
  const launched: string[] = []
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("a", 2), item("b", 1), item("c", 1)]

  const runFn = (it: ScheduledItem): Promise<void> => {
    launched.push(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise
  }

  const result = schedule(items, budget, runFn)

  // a (2) + b (1) = 3, fills the budget exactly. c must wait: only two
  // in flight, not three.
  expect(launched).toEqual(["a", "b"])

  // Completing a frees 2 cpus, letting c (needs 1) launch.
  deferreds.get("a")!.resolve()
  await flush()
  expect(launched).toEqual(["a", "b", "c"])

  deferreds.get("b")!.resolve()
  deferreds.get("c")!.resolve()
  await result
})

test("over-budget item drains pool then runs alone", async () => {
  const running = new Set<string>()
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("x", 1), item("y", 4)] // y exceeds the total budget

  let ySawEmptyPool = false

  const runFn = (it: ScheduledItem): Promise<void> => {
    if (it.key === "y") ySawEmptyPool = running.size === 0
    running.add(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise.then(() => {
      running.delete(it.key)
    })
  }

  const result = schedule(items, budget, runFn)

  // y cannot launch yet — it must drain the pool first.
  expect(running.has("y")).toBe(false)
  expect(running.has("x")).toBe(true)

  deferreds.get("x")!.resolve()
  await flush()

  // y now runs alone, with nothing else in flight at launch time.
  expect(ySawEmptyPool).toBe(true)
  expect(running.has("y")).toBe(true)

  deferreds.get("y")!.resolve()
  await result
})

test("canonical order: item i never launches before i-1 has been CONSIDERED", async () => {
  const launched: string[] = []
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  // a=2 fits (remaining 1). b=2 does NOT fit remaining=1. c=1 WOULD fit
  // remaining=1, but must not skip ahead of b.
  const items = [item("a", 2), item("b", 2), item("c", 1)]

  const runFn = (it: ScheduledItem): Promise<void> => {
    launched.push(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise
  }

  const result = schedule(items, budget, runFn)

  expect(launched).toEqual(["a"])

  // Free up the budget — b should now fit (2 <= 3), then c (1 <= 1).
  deferreds.get("a")!.resolve()
  await flush()
  expect(launched).toEqual(["a", "b", "c"])

  deferreds.get("b")!.resolve()
  deferreds.get("c")!.resolve()
  await result
})

test("budget released on completion", async () => {
  const launched: string[] = []
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  // item 0 fills the whole budget; 1,2,3 are blocked behind it in canonical
  // order until it completes and releases.
  const items = [item("0", 3), item("1", 1), item("2", 1), item("3", 1)]

  const runFn = (it: ScheduledItem): Promise<void> => {
    launched.push(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise
  }

  const result = schedule(items, budget, runFn)

  expect(launched).toEqual(["0"])
  expect(launched.includes("3")).toBe(false)

  deferreds.get("0")!.resolve()
  await flush()

  expect(launched).toEqual(["0", "1", "2", "3"])

  deferreds.get("1")!.resolve()
  deferreds.get("2")!.resolve()
  deferreds.get("3")!.resolve()
  await result
})

test("runFn rejection propagates after in-flight settle", async () => {
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("a", 1), item("b", 1), item("c", 1)]
  const boom = new Error("boom")

  const runFn = (it: ScheduledItem): Promise<void> => {
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise
  }

  const result = schedule(items, budget, runFn)

  let settled = false
  result.then(
    () => (settled = true),
    () => (settled = true),
  )

  // All three launched together (1+1+1 = 3). Reject b while a and c are
  // still in flight.
  deferreds.get("b")!.reject(boom)
  await flush()

  // The whole schedule() must NOT settle until a and c also settle.
  expect(settled).toBe(false)

  deferreds.get("a")!.resolve()
  deferreds.get("c")!.resolve()

  await expect(result).rejects.toBe(boom)
  expect(settled).toBe(true)
})

// ── packPreview() ────────────────────────────────────────────────────────
// Mirrors the schedule() scenarios above (same items/budgets), asserting
// packPreview's static grouping agrees with what schedule() actually
// launched together in each of those tests.

test("packPreview: empty items → no groups", () => {
  expect(packPreview([], DEFAULT_BUDGET)).toEqual([])
})

test("packPreview: 3 lights co-run under default budget → one group", () => {
  const items = [item("0", 1), item("1", 1), item("2", 1)]
  expect(packPreview(items, DEFAULT_BUDGET)).toEqual([["0", "1", "2"]])
})

test("packPreview: 2-cpu item packs with one 1-cpu, not two", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("a", 2), item("b", 1), item("c", 1)]
  expect(packPreview(items, budget)).toEqual([["a", "b"], ["c"]])
})

test("packPreview: over-budget item drains pool then runs alone", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("x", 1), item("y", 4)] // y exceeds the total budget
  expect(packPreview(items, budget)).toEqual([["x"], ["y"]])
})

test("packPreview: canonical order — no skip-ahead", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  // a=2 fits (remaining 1). b=2 does NOT fit remaining=1. c=1 WOULD fit
  // remaining=1, but must not skip ahead of b.
  const items = [item("a", 2), item("b", 2), item("c", 1)]
  expect(packPreview(items, budget)).toEqual([["a"], ["b", "c"]])
})

test("packPreview: budget released on completion — a large solo item, then the rest together", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("0", 3), item("1", 1), item("2", 1), item("3", 1)]
  expect(packPreview(items, budget)).toEqual([["0"], ["1", "2", "3"]])
})

test("packPreview: over-total item mid-list stops the current group without joining it", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("a", 1), item("huge", 10), item("b", 1)]
  // "a" starts a group; "huge" exceeds total budget so it can't join and
  // instead starts its own solo group; "b" starts a fresh group after that.
  expect(packPreview(items, budget)).toEqual([["a"], ["huge"], ["b"]])
})

test("packPreview: respects memory as well as cpu", () => {
  const budget: Budget = { cpus: 8, memoryMb: 4096 }
  const items = [
    { key: "a", cpus: 1, memoryMb: 3000 },
    { key: "b", cpus: 1, memoryMb: 2000 }, // doesn't fit remaining 1096 MB
  ]
  expect(packPreview(items, budget)).toEqual([["a"], ["b"]])
})

// ── fitsBudget / exceedsTotalBudget ─────────────────────────────────────
// schedule() and packPreview() must share these exact two predicates (single
// source of truth by construction) rather than each hand-rolling its own fit
// check that could drift. This pins their boundary behavior directly,
// including the exact-equal-to-budget edge (equal counts as fitting/not
// exceeding).

test("fitsBudget/exceedsTotalBudget: boundary matrix incl. exact-equal-to-budget", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const cases: Array<{ label: string; it: ScheduledItem; fits: boolean; exceeds: boolean }> = [
    { label: "exactly equal to budget on both dims", it: item("eq", 3, 6144), fits: true, exceeds: false },
    { label: "under budget on cpu, exact on mem", it: item("under-cpu", 2, 6144), fits: true, exceeds: false },
    { label: "exact on cpu, under budget on mem", it: item("under-mem", 3, 6000), fits: true, exceeds: false },
    { label: "cpu exceeds by 1", it: item("over-cpu", 4, 6144), fits: false, exceeds: true },
    { label: "mem exceeds by 1", it: item("over-mem", 3, 6145), fits: false, exceeds: true },
    { label: "both dims exceed", it: item("over-both", 4, 7000), fits: false, exceeds: true },
    { label: "zero-demand item", it: item("zero", 0, 0), fits: true, exceeds: false },
  ]
  for (const c of cases) {
    expect(fitsBudget(c.it, budget)).toBe(c.fits)
    expect(exceedsTotalBudget(c.it, budget)).toBe(c.exceeds)
  }
})

test("over-budget item in FIRST position runs alone immediately (empty pool, no wait)", async () => {
  const running = new Set<string>()
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("huge", 10), item("a", 1)] // huge exceeds the total budget, first in line

  let hugeSawEmptyPool = false

  const runFn = (it: ScheduledItem): Promise<void> => {
    if (it.key === "huge") hugeSawEmptyPool = running.size === 0
    running.add(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise.then(() => {
      running.delete(it.key)
    })
  }

  const result = schedule(items, budget, runFn)

  // Nothing was in flight before it, so huge launches right away — no drain wait.
  expect(hugeSawEmptyPool).toBe(true)
  expect(running.has("huge")).toBe(true)
  expect(running.has("a")).toBe(false)

  deferreds.get("huge")!.resolve()
  await flush()
  expect(running.has("a")).toBe(true)

  deferreds.get("a")!.resolve()
  await result
})

test("reject-during-drain suppresses the pending solo launch", async () => {
  const running = new Set<string>()
  const deferreds = new Map<string, Deferred<void>>()
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  // "a" fits and launches; "huge" exceeds the total budget so it must drain
  // the pool (wait for "a") before it can run solo.
  const items = [item("a", 1), item("huge", 10)]
  const boom = new Error("boom-during-drain")

  const runFn = (it: ScheduledItem): Promise<void> => {
    running.add(it.key)
    const d = deferred<void>()
    deferreds.set(it.key, d)
    return d.promise.then(
      () => {
        running.delete(it.key)
      },
      (err) => {
        running.delete(it.key)
        throw err
      },
    )
  }

  const result = schedule(items, budget, runFn)

  expect(running.has("a")).toBe(true)
  expect(running.has("huge")).toBe(false) // still draining, waiting for "a"

  let settled = false
  result.then(
    () => (settled = true),
    () => (settled = true),
  )

  // "a" fails instead of succeeding, while "huge" is still queued behind it.
  deferreds.get("a")!.reject(boom)
  await flush()

  // The failure must propagate WITHOUT ever launching "huge" — a
  // reject-during-drain must suppress the pending solo launch, not let it
  // slip through after the pool empties.
  expect(running.has("huge")).toBe(false)
  await expect(result).rejects.toBe(boom)
  expect(settled).toBe(true)
})

test("packPreview: over-budget item in FIRST position starts its own solo group", () => {
  const budget: Budget = { cpus: 3, memoryMb: 6144 }
  const items = [item("huge", 10), item("a", 1)]
  expect(packPreview(items, budget)).toEqual([["huge"], ["a"]])
})

// ── invalid budget guard (final-review fix: NaN defeats fitsBudget/
// exceedsTotalBudget silently — schedule() hangs forever, packPreview()
// loops forever without advancing. Defense in depth: both throw immediately
// on a non-finite or non-positive budget, even though the CLI is expected to
// reject these values first — see cli.ts's parseRunArgs/parseAbArgs/
// parseTaskLoadArgs.) ──────────────────────────────────────────────────────

test("schedule/packPreview: non-finite or non-positive budget throws instead of hanging/looping forever", () => {
  const badBudgets: Budget[] = [
    { cpus: NaN, memoryMb: 6144 },
    { cpus: 3, memoryMb: NaN },
    { cpus: Infinity, memoryMb: 6144 },
    { cpus: 3, memoryMb: Infinity },
    { cpus: 0, memoryMb: 6144 },
    { cpus: -1, memoryMb: 6144 },
    { cpus: 3, memoryMb: 0 },
    { cpus: 3, memoryMb: -5 },
  ]
  const items = [item("a", 1)]
  for (const budget of badBudgets) {
    expect(() => schedule(items, budget, async () => {})).toThrow()
    expect(() => packPreview(items, budget)).toThrow()
  }
})

// ── AsyncMutex ───────────────────────────────────────────────────────────

test("AsyncMutex serializes and preserves order", async () => {
  const mutex = new AsyncMutex()
  const log: string[] = []
  const d1 = deferred<void>()
  const d2 = deferred<void>()

  const p1 = mutex.withLock(async () => {
    log.push("1-start")
    await d1.promise
    log.push("1-end")
  })
  const p2 = mutex.withLock(async () => {
    log.push("2-start")
    await d2.promise
    log.push("2-end")
  })

  await flush()
  // 2-start causally depends on the first lock's body settling (it can only
  // begin after d1 resolves), so it cannot have run yet regardless of how
  // many microtasks have been flushed.
  expect(log).toEqual(["1-start"])

  d1.resolve()
  await p1
  await flush()
  expect(log).toEqual(["1-start", "1-end", "2-start"])

  d2.resolve()
  await p2

  expect(log).toEqual(["1-start", "1-end", "2-start", "2-end"])
})

test("AsyncMutex propagates the value/error and unlocks on rejection", async () => {
  const mutex = new AsyncMutex()

  await expect(
    mutex.withLock(async () => {
      throw new Error("mutex-boom")
    }),
  ).rejects.toThrow("mutex-boom")

  // The mutex must still be usable after a rejected body (lock released).
  const value = await mutex.withLock(() => 42)
  expect(value).toBe(42)
})
