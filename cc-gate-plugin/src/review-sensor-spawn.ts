// review-sensor-spawn.ts — Task 7's arming gate (spec 2026-08-05,
// docs/superpowers/plans/2026-08-06-review-sensor.md). Decides whether a
// Stop earns a detached review-sensor run and fires it. Same discipline as
// maybeSpawnPromptCheck (prompt-check-spawn.ts) / maybeSpawnGauge
// (gauge/spawn.ts): best-effort, every failure swallowed, no I/O of its own
// — the gate check plus one spawn call, nothing else.
import path from "node:path"
import { MAIN_CHECKOUT_DIR } from "./review-sensor/core.ts"

const RUNNER_CLI = path.join(import.meta.dir, "review-sensor", "runner.ts")

export interface MaybeSpawnReviewSensorInput {
  cwd: string
  env: Record<string, string | undefined>
  /** Injected process launcher; production passes a detached nohup double-fork. */
  spawn: (cmd: string[]) => void
  /** Test seam only — defaults to MAIN_CHECKOUT_DIR. */
  mainCheckoutDir?: string
}

/**
 * Arming gate (ships OFF by default): both must hold —
 * KKAMAK_REVIEW_SENSOR === "1" (env-only kill switch, fail-closed default)
 * and cwd resolves to INSIDE the main checkout: the root itself, any
 * subdir, or a worktree under `.claude/worktrees/` (which live under the
 * root). Widened 2026-08-09 from exact equality — that gate yielded ~2
 * passes/day against the >=25/day bar, because sessions run in worktrees
 * and subdirs and their Stops are the clock ticks the sensor needs. The
 * runner is ALWAYS handed `mainCheckoutDir`, never the triggering cwd:
 * state, claim and diff stay in the single main-checkout debounce domain
 * regardless of which session's Stop fired (runner.ts trusts its argv per
 * its own header). The prefix check is separator-anchored so a sibling
 * like `<root>-backup` never matches.
 * Whole-function fail-open: any error is swallowed and treated as "did not
 * spawn" — review-sensor problems must never touch a session.
 */
export function maybeSpawnReviewSensor(input: MaybeSpawnReviewSensorInput): boolean {
  try {
    const { cwd, env, spawn, mainCheckoutDir = MAIN_CHECKOUT_DIR } = input

    if (env.KKAMAK_REVIEW_SENSOR !== "1") return false
    // Resolve BOTH sides — an unresolved anchor (trailing slash, relative
    // path from a future caller) would silently fail closed on every Stop.
    const anchor = path.resolve(mainCheckoutDir)
    const resolved = path.resolve(cwd)
    if (resolved !== anchor && !resolved.startsWith(anchor + path.sep)) return false

    spawn(["bun", RUNNER_CLI, anchor])
    return true
  } catch {
    return false
  }
}
