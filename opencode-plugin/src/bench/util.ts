/**
 * util.ts — small shared helpers for the bench runner port.
 *
 * pyFixed / pySigned mirror Python's f-string `:.Nf` / `:+.Nf` formatting used
 * in runner.py log lines and verdict `reasons` strings. They are close-enough
 * approximations (JS toFixed vs Python round-half-even can differ in the last
 * digit on exact ties) — reasons strings are human-facing, never parsed
 * (parity trap #3 in the port plan). writeJsonAtomic lands in Phase 2.
 */

/** Python f"{x:.Nf}" */
export function pyFixed(x: number, digits: number): string {
  return x.toFixed(digits)
}

/** Python f"{x:+.Nf}" — sign always present. */
export function pySigned(x: number, digits: number): string {
  const s = x.toFixed(digits)
  return x >= 0 && !s.startsWith("-") ? `+${s}` : s
}
