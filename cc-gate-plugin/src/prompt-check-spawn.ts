// prompt-check-spawn.ts — the 5th pre-data amendment's spawn seam (Phase 3
// Task 2, prompt-check-mechanize plan). Decides whether a skippedStop-flagged
// UserPromptSubmit earns a detached prompt-check run, single-flights it via a
// lockfile, and fires the detached prompt-check-cli (T3). Every failure is
// swallowed: prompt-check problems must NEVER touch a session — same prime
// directive as km-gauge's spawn seam (gauge/spawn.ts).
import fs from "node:fs"
import path from "node:path"
import type { GateConfig, SensorLine } from "./types.ts"

export const LOCK_REL_PATH = ".km/cc-gate/prompt-check.lock"

const PROMPT_CHECK_CLI = path.join(import.meta.dir, "prompt-check-cli.ts")

/** Default staleness window's base (mirrors GateConfig.checkTimeoutMs's own
 * default, config.ts:17) — used only when cfg is absent. */
const DEFAULT_CHECK_TIMEOUT_MS = 300_000
const STALE_GRACE_MS = 60_000

export interface MaybeSpawnPromptCheckInput {
  cwd: string
  sessionID: string
  sensor: SensorLine | undefined
  cfg: GateConfig | undefined
  env: Record<string, string | undefined>
  now: number
  /** Injected process launcher; production passes a detached nohup double-fork. */
  spawn: (cmd: string[]) => void
}

export type PromptCheckSpawnResult = "spawned" | `skipped:${string}`

interface LockContent {
  pid: number
  spawnTs: number
}

/** One O_EXCL create attempt. Returns true on success, false on EEXIST
 * (lock already held), rethrows anything else (bubbles to the caller's
 * whole-function catch — a genuinely unexpected fs error). */
function tryCreateLock(lockPath: string, content: LockContent): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false
    throw e
  }
}

/** True iff the existing lock is stale-equivalent: genuinely stale (spawnTs
 * older than staleMs), vanished between the EEXIST probe and this read
 * (ENOENT), or unparseable (torn write from a killed process). All three
 * collapse to the SAME atomic-takeover path — never the outer catch. */
function isLockStaleOrGone(lockPath: string, staleMs: number, now: number): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<LockContent> | null
    if (typeof parsed?.spawnTs !== "number") return true
    return now - parsed.spawnTs >= staleMs
  } catch {
    return true
  }
}

/**
 * Spawn decision (5th amendment: accompany skippedStop, never replace it —
 * the skippedStop line itself is already appended by the caller before this
 * runs). Whole-function fail-open: any error — corrupt lock, fs failure,
 * throwing spawn — returns "skipped:error" rather than touching the hook.
 */
export function maybeSpawnPromptCheck(input: MaybeSpawnPromptCheckInput): PromptCheckSpawnResult {
  try {
    const { cwd, sessionID, sensor, cfg, env, now, spawn } = input

    // 1. Trigger — the ONLY one, per the amendment.
    if (sensor?.skippedStop !== true) return "skipped:no-trigger"

    // 2. Config gate + env-only kill switch (no gate.json flag: GateConfig
    // carries no promptCheck field, deliberately — YAGNI).
    if (!cfg?.check) return "skipped:no-check"
    if (env.KKAMAK_PROMPT_CHECK === "off") return "skipped:env-off"

    // 3. Lockfile single-flight.
    const lockPath = path.join(cwd, LOCK_REL_PATH)
    const staleMs = (cfg?.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS) + STALE_GRACE_MS
    const content: LockContent = { pid: process.pid, spawnTs: now }

    if (!tryCreateLock(lockPath, content)) {
      // EEXIST at probe — read the existing lock.
      if (!isLockStaleOrGone(lockPath, staleMs, now)) return "skipped:in-flight"

      // Stale (or vanished/unparseable, treated identically): ATOMIC
      // takeover. Unlink ignore-ENOENT, then ONE fresh O_EXCL attempt —
      // EEXIST there means we lost the takeover race to a concurrent
      // event, never "overwrite and assume ownership".
      try {
        fs.unlinkSync(lockPath)
      } catch (e) {
        if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
      }
      if (!tryCreateLock(lockPath, content)) return "skipped:in-flight"
    }

    // 4. Spawn, detached, through the injected launcher.
    spawn(["bun", PROMPT_CHECK_CLI, cwd, sessionID, String(now)])
    return "spawned"
  } catch {
    return "skipped:error"
  }
}
