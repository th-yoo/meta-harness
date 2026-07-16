// Resource-budget packing scheduler + a whole-call async mutex (spec D3/D4).
//
// schedule() walks `items` in canonical (submission) order with NO skip-ahead:
// item i is only ever launched once item i-1 has been considered against the
// remaining budget. If items[i] doesn't fit, scanning stops there — later,
// smaller items must not jump the queue — until a completion frees budget and
// triggers a re-scan from the same cursor position.
//
// Items whose demand exceeds the TOTAL budget (not just what's currently
// free) can never coexist with anything else: the pool must fully drain
// first, then the item runs alone, then packing resumes from the next item.

export interface Budget {
  cpus: number
  memoryMb: number
}

export const DEFAULT_BUDGET: Budget = { cpus: 3, memoryMb: 6144 }

export interface ScheduledItem {
  key: string
  cpus: number
  memoryMb: number
}

/** The ONE fit rule (spec D3): does `it` fit within `remaining` budget right
 * now? Equal-to-remaining counts as fitting. Shared by `schedule()` (against
 * its live `remaining` pool) and `packPreview()` (against its simulated
 * per-group remainder) so the two can never hand-roll diverging checks. */
export function fitsBudget(it: ScheduledItem, remaining: Budget): boolean {
  return it.cpus <= remaining.cpus && it.memoryMb <= remaining.memoryMb
}

/** Does `it`'s demand exceed the TOTAL budget (not just what's currently
 * free)? Equal-to-budget does NOT exceed — such an item still fits alone.
 * Items for which this is true can never coexist with anything else (spec
 * D3: pool drains, item runs solo, packing resumes after). Shared by
 * `schedule()` and `packPreview()` — see `fitsBudget`'s doc comment. */
export function exceedsTotalBudget(it: ScheduledItem, budget: Budget): boolean {
  return it.cpus > budget.cpus || it.memoryMb > budget.memoryMb
}

/** Defense in depth (final-review fix): a non-finite or non-positive budget
 * (e.g. NaN from an unvalidated CLI flag — see cli.ts's parseRunArgs/
 * parseAbArgs/parseTaskLoadArgs) defeats BOTH `fitsBudget` and
 * `exceedsTotalBudget` — every comparison against NaN is false, so
 * `schedule()`'s scan() never launches anything and never finishes (a silent
 * hang), and `packPreview()`'s inner while-loop breaks immediately without
 * advancing `i` (an infinite outer loop). The CLI is expected to reject these
 * values before they ever reach here; this guard exists so no future caller
 * of `schedule`/`packPreview` can reproduce that hang — fail loudly instead. */
function assertValidBudget(budget: Budget): void {
  if (!Number.isFinite(budget.cpus) || budget.cpus <= 0 || !Number.isFinite(budget.memoryMb) || budget.memoryMb <= 0) {
    throw new Error(
      `invalid budget: cpus=${budget.cpus} memoryMb=${budget.memoryMb} (both must be finite and > 0)`,
    )
  }
}

/** Greedy canonical-order packing (spec D3): launches items[i] when it fits the
 * remaining budget; over-total-budget items drain the pool and run alone.
 * runFn errors reject the whole schedule() after in-flight items settle.
 *
 * `canLaunch` (oauth-parallel freshness gate, Task 2 part A): an optional
 * launch-guard, checked at the top of every scan() — before the packing
 * while-loop even looks at the next item. While it returns true, schedule()
 * behaves exactly as before (this param didn't exist). The moment it returns
 * false, scan() stops launching NEW items: whatever is already in flight is
 * left to settle normally (their completion callbacks still fire, still
 * free budget, still trigger a re-scan), but no further item is ever
 * launched from that point on. Once nothing is left in flight, schedule()
 * finishes GRACEFULLY — resolves, never rejects (this is not a failure) —
 * even if items remain un-launched; the caller (cmd-run.ts/cmd-ab.ts's
 * --resume) is expected to pick up whatever didn't run this chunk. Absent
 * (undefined), the guard is skipped entirely — unbounded, byte-identical to
 * every schedule() call site from before this param existed. */
export function schedule(
  items: ScheduledItem[],
  budget: Budget,
  runFn: (item: ScheduledItem) => Promise<void>,
  canLaunch?: () => boolean,
): Promise<void> {
  assertValidBudget(budget)
  return new Promise<void>((resolve, reject) => {
    const remaining: Budget = { cpus: budget.cpus, memoryMb: budget.memoryMb }
    let cursor = 0
    let inFlight = 0
    let hasFailure = false
    let failure: unknown

    // Resolves/rejects the outer promise once nothing is left to do. Under a
    // failure, in-flight items still get to settle first (cursor may not
    // have reached the end — we stop launching new items, but wait for the
    // ones already running).
    const finishIfDone = (): boolean => {
      if (inFlight !== 0) return false
      if (hasFailure) {
        reject(failure)
        return true
      }
      if (cursor >= items.length) {
        resolve()
        return true
      }
      return false
    }

    const launch = (it: ScheduledItem, solo: boolean): void => {
      inFlight++
      if (!solo) {
        remaining.cpus -= it.cpus
        remaining.memoryMb -= it.memoryMb
      }
      runFn(it).then(
        () => {
          inFlight--
          if (!solo) {
            remaining.cpus += it.cpus
            remaining.memoryMb += it.memoryMb
          }
          if (!finishIfDone()) scan()
        },
        (err) => {
          inFlight--
          if (!hasFailure) {
            hasFailure = true
            failure = err
          }
          if (!solo) {
            remaining.cpus += it.cpus
            remaining.memoryMb += it.memoryMb
          }
          if (!finishIfDone()) scan()
        },
      )
    }

    const scan = (): void => {
      if (finishIfDone()) return
      if (hasFailure) return // draining: let in-flight items settle, launch nothing new

      if (canLaunch && !canLaunch()) {
        // oauth-parallel freshness guard: the token is nearing expiry — stop
        // launching NEW tasks so none runs across the refresh (the shared rw
        // auth.json write race — see agent-auth.ts's header). Let whatever is
        // already in flight settle normally, then finish GRACEFULLY.
        //
        // finishIfDone() above would NOT have resolved in this state (cursor
        // hasn't reached items.length, and there's no failure) — so this is
        // the ONLY path that can settle schedule() while items remain
        // un-launched. Must not hang: the moment nothing is in flight,
        // resolve explicitly right here. Promise resolution is idempotent
        // (a no-op if already settled), so there is no race with any other
        // path that might also reach a resolve/reject first.
        if (inFlight === 0) {
          resolve()
          return
        }
        return // in-flight settle → their .then calls scan() again → eventually inFlight 0 → resolve above
      }

      while (cursor < items.length) {
        const it = items[cursor]!

        if (exceedsTotalBudget(it, budget)) {
          if (inFlight > 0) return // drain the pool before running it alone
          cursor++
          launch(it, true)
          return // solo item consumes the whole budget conceptually — stop
        }

        if (!fitsBudget(it, remaining)) return // canonical order: no skip-ahead

        cursor++
        launch(it, false)
      }

      finishIfDone()
    }

    scan()
  })
}

/**
 * Pure preview of schedule()'s canonical-order packing (spec D3), WITHOUT
 * running anything: groups `items` into the "co-run waves" schedule() would
 * launch under the SAME budget, same canonical (submission) order, the same
 * no-skip-ahead rule, and the same over-total-budget-drains-then-solo
 * behavior. Used by `task-load`'s inspection output — a preview must reuse
 * this exact fit rule so it can never drift from what schedule() actually
 * does at runtime.
 *
 * Approximation note: this assumes every item in a group holds its share of
 * the budget until every OTHER item in that same group has also finished —
 * i.e. the next group only starts scanning once the current group is fully
 * drained. schedule() itself is more opportunistic (a group member that
 * finishes early frees its slice immediately, letting a later item launch
 * mid-group instead of waiting for the whole group to drain). For
 * same-duration items the two agree exactly; for mixed-duration items
 * packPreview's groups are a conservative, static PREVIEW of what could
 * co-run, not a claim about exact launch timing — see schedule()'s own doc
 * comment above for the real runtime semantics.
 */
export function packPreview(items: ScheduledItem[], budget: Budget): string[][] {
  assertValidBudget(budget)
  const groups: string[][] = []
  let i = 0
  while (i < items.length) {
    const it = items[i]!
    if (exceedsTotalBudget(it, budget)) {
      // Over-total-budget: drains the pool then runs alone (spec D3) — its
      // own solo group; nothing else can join it.
      groups.push([it.key])
      i++
      continue
    }
    const group: string[] = []
    const remaining: Budget = { cpus: budget.cpus, memoryMb: budget.memoryMb }
    while (i < items.length) {
      const cur = items[i]!
      if (exceedsTotalBudget(cur, budget)) break // over-total starts its own group
      if (fitsBudget(cur, remaining)) {
        group.push(cur.key)
        remaining.cpus -= cur.cpus
        remaining.memoryMb -= cur.memoryMb
        i++
      } else {
        break // canonical order: no skip-ahead
      }
    }
    groups.push(group)
  }
  return groups
}

/** Whole-call critical section (spec D4).
 *
 * NON-REENTRANT: a `withLock` body must never call `withLock` on the same
 * mutex — the inner call queues behind the outer (still-running) one and both
 * await each other forever (silent deadlock). Keep critical sections
 * leaf-level: one lock per shared mutation site, never nested. */
export class AsyncMutex {
  private tail: Promise<unknown> = Promise.resolve()

  withLock<T>(fn: () => Promise<T> | T): Promise<T> {
    const run = this.tail.then(fn, fn)
    this.tail = run.catch(() => {})
    return run as Promise<T>
  }
}
