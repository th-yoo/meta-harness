#!/usr/bin/env bun
/**
 * prompt-check-cli.ts — the detached prompt-check child (5th pre-data
 * amendment, Phase 3 Task 3): `bun prompt-check-cli.ts <cwd> <sessionID>
 * <spawnTs>`. Spawned by prompt-check-spawn.ts's nohup double-fork after a
 * skippedStop-flagged UserPromptSubmit; runs the gate's configured check
 * once, fabricates ONE sensor line via the frozen `buildSensorLine` core
 * builder (CALLED, never edited — core/ is a MECHANISM_PATH, F1), and
 * releases its own single-flight lock.
 *
 * Line shape is LAW (types.ts:199-215, SensorLine.promptCheck/spawnTs doc
 * comments): `{...base, promptCheck: true as const, spawnTs}` where `base`
 * comes from `buildSensorLine(deps, {...})` — same choke point as every
 * other sensor line (host/pluginVersion stamped there and in appendSensor).
 * `reinject`/`forced` are hook-cli Stop-path stamps (hook-cli.ts:313-333,
 * i.e. this task's snapshot ~219-231) this line never touches; `checkMs` is
 * built inside core/stop.ts and appears only when a Stop-path caller passes
 * it to buildSensorLine — this call never does, so it is never present.
 *
 * PRIME DIRECTIVE (same family as hook-cli.ts/gauge/spawn.ts): a broken
 * prompt-check run must NEVER surface anywhere visible. Every failure path
 * is swallowed; stdout/stderr are nohup-discarded by the spawner anyway.
 * `bun test` must never run a real check — everything lives behind the
 * `import.meta.main` guard (refiner-cli.ts:129 precedent).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { parseGateConfig } from "./config.ts"
import { appendSensor } from "./sensor-append.ts"
import { runCheck } from "./check-runner.ts"
import { buildSensorLine } from "./core/sensor.ts"
import { LOCK_REL_PATH } from "./prompt-check-spawn.ts"
import type { CoreDeps } from "./types.ts"

const DEFAULT_CHECK_TIMEOUT_MS = 300_000

/** gate.json at <cwd>/gate.json, read as a raw string; undefined if
 * unreadable. Same read-a-raw-string-then-parseGateConfig split hook-cli
 * uses (readGateConfigRaw there, local here per the brief — hook-cli
 * doesn't export it and this task doesn't touch hook-cli). */
function readCfg(cwd: string): string | undefined {
  try {
    return fs.readFileSync(path.join(cwd, "gate.json"), "utf-8")
  } catch {
    return undefined
  }
}

/** Best-effort: unlink LOCK_REL_PATH ONLY if its own spawnTs matches this
 * process's argv spawnTs (ownership check) — a foreign lock left by a
 * successor's takeover must survive. Never throws. */
function releaseOwnLock(cwd: string, spawnTs: number): void {
  try {
    const lockPath = path.join(cwd, LOCK_REL_PATH)
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as { spawnTs?: unknown }
    if (parsed?.spawnTs === spawnTs) {
      fs.unlinkSync(lockPath)
    }
  } catch {
    // no lock, unreadable, torn write, or a foreign lock — nothing to do.
  }
}

async function main(): Promise<void> {
  const [cwd, sessionID, spawnTsRaw] = process.argv.slice(2)
  if (!cwd || !sessionID) return
  const spawnTs = Number(spawnTsRaw)
  if (!Number.isFinite(spawnTs)) return

  try {
    const gateConfigRaw = readCfg(cwd)
    const cfg = parseGateConfig(gateConfigRaw)
    if (!cfg?.check) return

    const timeoutMs = cfg.checkTimeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
    const startedAt = Date.now()
    let result: { code: number; out: string; ms: number }
    try {
      // A timing-out check RESOLVES (check-runner.ts:71-74, code 124) —
      // it is signal, not an internal error, so the happy path below
      // already appends it. Only a genuine internal error (e.g. Bun.spawn
      // throwing synchronously) rejects; that still must append
      // (accepted:false) rather than vanish silently.
      result = await runCheck(cfg.check, cwd, timeoutMs)
    } catch {
      result = { code: 1, out: "", ms: Date.now() - startedAt }
    }

    // Deps stub: buildSensorLine is TWO-arg (deps, args) — core/sensor.ts:3.
    // ts/host come from deps.now()/deps.hostname() (sensor.ts:33,42);
    // CoreDeps (types.ts:82-88) structurally requires runCheck/log too, so
    // inert stubs satisfy the type — buildSensorLine never calls them.
    const deps: CoreDeps = {
      now: () => Date.now(),
      hostname: () => os.hostname(),
      runCheck: async () => ({ code: 0, out: "" }),
      log: () => {},
    }
    const base = buildSensorLine(deps, {
      sessionID,
      check: cfg.check,
      accepted: result.code === 0,
      gateExhausted: false,
      rounds: [],
      interrupted: false,
      marker: false,
      durationMs: result.ms,
    })
    const line = { ...base, promptCheck: true as const, spawnTs }
    appendSensor(cwd, gateConfigRaw, line, () => {})
  } catch {
    // Fail-open family rule: every failure path swallowed, no visible error.
  } finally {
    releaseOwnLock(cwd, spawnTs)
  }
}

if (import.meta.main) {
  main()
    .catch(() => {})
    .finally(() => process.exit(0))
}
