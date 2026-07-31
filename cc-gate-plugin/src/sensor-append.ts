/**
 * sensor-append.ts — the sensor-file choke point extracted from hook-cli.ts
 * (Phase 3 Task 1: moved verbatim, behavior identical). Every emitted
 * gate-outcomes line (UserPromptSubmit, Stop, and the gauge-fabricated
 * re-stamp) funnels through appendSensor here.
 */
import fs from "node:fs"
import path from "node:path"
import { parseGateConfig } from "./config.ts"
import type { SensorLine } from "./types.ts"

export const DEFAULT_SENSOR_REL_PATH = ".km/gate-outcomes.ndjson"

// Cache sentinel: `null` = not yet attempted, `undefined` = attempted and
// unreadable/invalid (cached negative — never re-stat every line).
let cachedPluginVersion: string | undefined | null = null

/** cc-gate-plugin version, read once per process from the manifest actually
 * shipped alongside this module. Resolved MODULE-relative (import.meta.dir),
 * never repo-relative: `claude plugin install` copies the whole plugin dir
 * (self-contained.test.ts INSTALL SHAPE proves .claude-plugin/ travels with
 * it), but a repo-relative path would resolve against the copy's cwd and
 * die silently. Fail-open: any read/parse failure just omits the field. */
export function readPluginVersion(): string | undefined {
  if (cachedPluginVersion !== null) return cachedPluginVersion
  try {
    const p = path.join(import.meta.dir, "..", ".claude-plugin", "plugin.json")
    const parsed = JSON.parse(fs.readFileSync(p, "utf-8")) as { version?: unknown }
    cachedPluginVersion = typeof parsed.version === "string" ? parsed.version : undefined
  } catch {
    cachedPluginVersion = undefined
  }
  return cachedPluginVersion
}

export function sensorFilePath(cwd: string, gateConfigRaw: string | undefined): string {
  const cfg = parseGateConfig(gateConfigRaw)
  // path.resolve (not path.join): an absolute `sensor` must stay absolute —
  // path.join would silently re-root it under cwd. For a relative sensor,
  // resolve behaves the same as join-against-an-absolute-cwd.
  return path.resolve(cwd, cfg?.sensor ?? DEFAULT_SENSOR_REL_PATH)
}

/** mkdir -p the sensor's parent dir then append one ndjson line. Never throws:
 * failures are logged to stderr and swallowed — a sensor-write problem must
 * never change the emitted decision. */
export function appendSensor(
  cwd: string,
  gateConfigRaw: string | undefined,
  sensor: SensorLine,
  log: (msg: string) => void,
): void {
  try {
    // pluginVersion stamped here — the single choke point every sensor line
    // (UserPromptSubmit, Stop, and the gauge-fabricated re-stamp) funnels
    // through — so "every emitted line" holds without touching each caller.
    const version = readPluginVersion()
    const stamped = version !== undefined ? { ...sensor, pluginVersion: version } : sensor
    const p = sensorFilePath(cwd, gateConfigRaw)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(stamped) + "\n")
  } catch (e) {
    try {
      log(`hook-cli: failed to append sensor line (swallowed): ${String(e)}`)
    } catch {
      // even logging failed; nothing more to do
    }
  }
}
