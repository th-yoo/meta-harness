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

/** Greedy canonical-order packing (spec D3): launches items[i] when it fits the
 * remaining budget; over-total-budget items drain the pool and run alone.
 * runFn errors reject the whole schedule() after in-flight items settle. */
export function schedule(
  items: ScheduledItem[],
  budget: Budget,
  runFn: (item: ScheduledItem) => Promise<void>,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const remaining: Budget = { cpus: budget.cpus, memoryMb: budget.memoryMb }
    let cursor = 0
    let inFlight = 0
    let hasFailure = false
    let failure: unknown

    const fits = (it: ScheduledItem): boolean => it.cpus <= remaining.cpus && it.memoryMb <= remaining.memoryMb

    const overTotalBudget = (it: ScheduledItem): boolean => it.cpus > budget.cpus || it.memoryMb > budget.memoryMb

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

      while (cursor < items.length) {
        const it = items[cursor]!

        if (overTotalBudget(it)) {
          if (inFlight > 0) return // drain the pool before running it alone
          cursor++
          launch(it, true)
          return // solo item consumes the whole budget conceptually — stop
        }

        if (!fits(it)) return // canonical order: no skip-ahead

        cursor++
        launch(it, false)
      }

      finishIfDone()
    }

    scan()
  })
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
