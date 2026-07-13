/**
 * util.ts — small shared helpers for the bench runner port.
 *
 * pyFixed / pySigned mirror Python's f-string `:.Nf` / `:+.Nf` formatting used
 * in runner.py log lines and verdict `reasons` strings. They are close-enough
 * approximations (JS toFixed vs Python round-half-even can differ in the last
 * digit on exact ties) — reasons strings are human-facing, never parsed
 * (parity trap #3 in the port plan).
 */
import { dirname, basename, join } from "node:path"
import { mkdirSync, writeFileSync, renameSync } from "node:fs"

/** Python f"{x:.Nf}" */
export function pyFixed(x: number, digits: number): string {
  return x.toFixed(digits)
}

/** Python f"{x:+.Nf}" — sign always present. */
export function pySigned(x: number, digits: number): string {
  const s = x.toFixed(digits)
  return x >= 0 && !s.startsWith("-") ? `+${s}` : s
}

/**
 * Vendored seeded PRNG (mulberry32) — deterministic, no third-party deps.
 * Lives here (rather than duplicated per call site) because both
 * ab-stats.ts (bootstrapTaskCi) and splits.ts (band_partition's sentinel
 * pick, cmd_split's pool shuffle/fold assignment) need the SAME seeded
 * source of randomness; ab-stats.ts re-exports this for its existing import
 * sites. Ports the *algorithm* Python's random.Random(seed) is used for
 * (uniform draws driving a Fisher-Yates shuffle / resampling), not its
 * MT19937 bit stream, which is irreproducible outside CPython — see
 * ab-stats.ts's file header and splits.ts's header for the consequences.
 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Thrown by pure functions instead of Python's `die()`. The CLI (P3) is
 * expected to catch this at the top level, print to stderr, and exit 1. */
export class BenchError extends Error {}

/** Runner logs go to stderr — stdout is reserved for data (e.g. JSON results
 * a caller might pipe/redirect). Mirrors Python runner.py's `log()`. */
export function log(msg: string): void {
  console.error(msg)
}

/** Mirrors Python's `die()`: report and abort. Here "abort" is a thrown
 * BenchError rather than `sys.exit`, so pure functions stay testable. */
export function die(msg: string): never {
  throw new BenchError(msg)
}

/**
 * Write JSON via a same-dir temp file + rename, so a concurrent reader never
 * observes a torn file (mirrors Python's `_write_json_atomic`, runner.py:1408).
 * Creates parent dirs first. Output is 2-space-indented JSON with a trailing
 * newline.
 */
export function writeJsonAtomic(path: string, data: unknown): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n")
  renameSync(tmp, path)
}

/**
 * Write plain text via a same-dir temp file + rename — same tmp-then-rename
 * discipline as writeJsonAtomic above, for callers whose store file isn't JSON.
 * Creates parent dirs first.
 */
export function writeTextAtomic(path: string, text: string): void {
  const dir = dirname(path)
  mkdirSync(dir, { recursive: true })
  const tmp = join(dir, `${basename(path)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`)
  writeFileSync(tmp, text)
  renameSync(tmp, path)
}
