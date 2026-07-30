/**
 * sidecar.ts — Phase 1 check-output sidecar (evidence-only; spec
 * docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md).
 *
 * Captures the failing check output that the Stop block branch otherwise
 * discards after delivering it to the agent. Lives at the hook-cli seam ON
 * PURPOSE (F1): src/core/ and vendor/ are MECHANISM_PATHS — any commit
 * there stales the §4.3 calibration registry. This file must never move
 * under either.
 *
 * The sidecar is host-local and NEVER exported by km-sensors-sync.sh (F2:
 * the snapshot is a one-way door; code-bearing text must not reach it).
 */
import fs from "node:fs"
import path from "node:path"

const HEAD_CHARS = 2048
const TAIL_CHARS = 6144
const SIDECAR_REL_PATH = ".km/check-output.ndjson"

export interface CheckOutputRecord {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  excerpt: string
  /** Present only when the raw text exceeded HEAD_CHARS + TAIL_CHARS.
   * Chars, not bytes — parity with hook-cli's capOutput, which slices
   * String.length. */
  elidedChars?: number
}

export function buildCheckOutputRecord(args: {
  ts: number
  sessionID: string
  round: number
  roundsMax: number
  check: string
  rawText: string
}): CheckOutputRecord {
  const { rawText, ...rest } = args
  if (rawText.length <= HEAD_CHARS + TAIL_CHARS) {
    return { ...rest, excerpt: rawText }
  }
  const elidedChars = rawText.length - HEAD_CHARS - TAIL_CHARS
  const excerpt =
    rawText.slice(0, HEAD_CHARS) +
    `\n…[kkamak sidecar: ${elidedChars} chars elided]…\n` +
    rawText.slice(-TAIL_CHARS)
  return { ...rest, excerpt, elidedChars }
}

/** mkdir -p then append one ndjson line. Never throws: failures are logged
 * and swallowed — a sidecar-write problem must never change the emitted
 * decision (same fail-open contract as hook-cli's appendSensor). Path is
 * the FIXED default, deliberately independent of gate.json's `sensor`
 * override (spec §A). */
export function appendCheckOutput(cwd: string, rec: CheckOutputRecord, log: (msg: string) => void): void {
  try {
    const p = path.resolve(cwd, SIDECAR_REL_PATH)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + "\n")
  } catch (e) {
    try {
      log(`hook-cli: failed to append check-output sidecar (swallowed): ${String(e)}`)
    } catch {
      // even logging failed; nothing more to do
    }
  }
}
