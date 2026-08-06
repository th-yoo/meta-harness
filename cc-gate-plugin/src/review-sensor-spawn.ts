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
 * and cwd resolves to the main checkout (worktree Stops never dispatch).
 * Whole-function fail-open: any error is swallowed and treated as "did not
 * spawn" — review-sensor problems must never touch a session.
 */
export function maybeSpawnReviewSensor(input: MaybeSpawnReviewSensorInput): boolean {
  try {
    const { cwd, env, spawn, mainCheckoutDir = MAIN_CHECKOUT_DIR } = input

    if (env.KKAMAK_REVIEW_SENSOR !== "1") return false
    if (path.resolve(cwd) !== mainCheckoutDir) return false

    spawn(["bun", RUNNER_CLI, cwd])
    return true
  } catch {
    return false
  }
}
