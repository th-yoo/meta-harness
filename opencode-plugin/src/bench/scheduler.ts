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
 * every schedule() call site from before this param existed.
 *
 * `pauseGate` (transient host-pressure gate, plan S2) — CONTRAST with
 * `canLaunch`, which they superficially resemble:
 *   - `canLaunch` is TERMINAL: false + nothing in flight ⇒ schedule() RESOLVES
 *     and abandons un-launched items (oauth expiry: end the chunk, `--resume`).
 *   - `pauseGate` is TRANSIENT: true ⇒ HOLD launches and re-check later on a
 *     timer; it NEVER resolves-with-work-abandoned. Used for a passing host-
 *     pressure spike — width shrinks by attrition and recovers when pressure
 *     clears. It is consulted only AFTER finishIfDone() and canLaunch, so the
 *     terminal oauth-drain path always dominates (see scan()).
 * `pausePollMs` is the injected re-scan cadence (the caller passes the sensor's
 * poll interval; kept as a param, NOT imported, so this generic scheduler does
 * not couple to the host-pressure sensor module). Tests inject ~1ms so the
 * transient re-scan is observable without clock mocking or wall-clock waits. */
export function schedule(
  items: ScheduledItem[],
  budget: Budget,
  runFn: (item: ScheduledItem) => Promise<void>,
  canLaunch?: () => boolean,
  pauseGate?: () => boolean,
  pausePollMs = 20_000,
): Promise<void> {
  assertValidBudget(budget)
  return new Promise<void>((resolve, reject) => {
    const remaining: Budget = { cpus: budget.cpus, memoryMb: budget.memoryMb }
    let cursor = 0
    let inFlight = 0
    let hasFailure = false
    let failure: unknown

    // Single re-scan timer handle for the transient pauseGate. Doubles as the
    // dedup guard: while non-null a timer is already pending, so we never
    // stack a second one.
    let pauseTimer: ReturnType<typeof setTimeout> | null = null
    let pauseGateFailOpenLogged = false
    const clearPauseTimer = (): void => {
      if (pauseTimer !== null) {
        clearTimeout(pauseTimer)
        pauseTimer = null
      }
    }

    // Resolves/rejects the outer promise once nothing is left to do. Under a
    // failure, in-flight items still get to settle first (cursor may not
    // have reached the end — we stop launching new items, but wait for the
    // ones already running).
    const finishIfDone = (): boolean => {
      if (inFlight !== 0) return false
      if (hasFailure) {
        // Clear any armed pauseGate re-scan timer before settling: with the
        // shared per-command sensor (S3), a stale timer from ab phase 1
        // firing during phase 2 would emit a spurious [pressure] log against
        // the live sensor. Covers finishIfDone()'s 3 callers.
        clearPauseTimer()
        reject(failure)
        return true
      }
      if (cursor >= items.length) {
        clearPauseTimer()
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
          // This direct resolve() bypasses finishIfDone(), so it must clear
          // the pauseGate re-scan timer here too (same stale-timer / spurious
          // [pressure]-log rationale as finishIfDone's clear).
          clearPauseTimer()
          resolve()
          return
        }
        return // in-flight settle → their .then calls scan() again → eventually inFlight 0 → resolve above
      }

      // Transient host-pressure gate (plan S2). Ordering is correctness-
      // critical: this runs ONLY after finishIfDone() and the canLaunch block
      // above. If oauth is expiring (canLaunch false) WHILE the host is under
      // pressure, the run must still terminal-drain and resolve for --resume;
      // consulting pauseGate first would re-arm the timer forever and hang
      // schedule(). So pauseGate can only hold launches, never block the drain.
      if (pauseGate) {
        let paused: boolean
        try {
          paused = pauseGate()
        } catch (err) {
          // Fail-OPEN: a sensor fault must NEVER pause or propagate. Same
          // defense-in-depth stance as assertValidBudget above — but here the
          // stakes are sharper: scan() runs from a setTimeout re-scan (an
          // uncaught exception there escapes the Promise machinery entirely)
          // and from completion handlers (an unhandled rejection that leaves
          // schedule() hanging). Swallow it, treat the host as NOT paused, and
          // log once (the gate can be consulted on every scan — don't spam).
          paused = false
          if (!pauseGateFailOpenLogged) {
            pauseGateFailOpenLogged = true
            console.error("  [scheduler] pauseGate threw — failing open, launches proceed:", err)
          }
        }
        if (paused) {
          // NO resolve branch: finishIfDone() at scan()'s top already owns the
          // fully-drained state (cursor >= items.length && inFlight === 0), so
          // a resolve here would be dead code. pauseGate is TRANSIENT — hold,
          // never abandon work.
          if (inFlight === 0) {
            // The sole state with no in-flight completion left to re-trigger
            // scan(). Arm exactly ONE re-scan timer (dedup via the handle).
            //
            // This timer MUST keep the process alive. While un-launched work
            // remains under pause, with inFlight === 0 this timer is the ONLY
            // live event-loop handle — do NOT unref() it. If it were unref'd, a
            // real CLI run whose pauseGate holds all launches at a zero-inflight
            // moment would have no ref'd handle left, so the runtime (Bun/Node)
            // would exit 0 with schedule() unresolved and the remaining tasks
            // silently abandoned. It is intentionally the handle that keeps the
            // process alive until pressure clears. Leak-safety without unref is
            // already guaranteed: every settle path clears it (finishIfDone's
            // reject/resolve, and canLaunch's drain-resolve), so it can never
            // outlive schedule().
            if (pauseTimer === null) {
              pauseTimer = setTimeout(() => {
                pauseTimer = null
                scan()
              }, pausePollMs)
            }
          }
          // inFlight > 0: a completion (below, at the runFn .then handlers)
          // re-invokes scan() and re-checks the gate naturally — no timer.
          return
        }
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
