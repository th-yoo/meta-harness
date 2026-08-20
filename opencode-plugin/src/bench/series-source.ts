/** Full-numeric-series access for the D&C divide step — spec §8.9 decision:
 * the detector reads the raw task fixture harness-side, contained to a root,
 * entirely separate from the truncated audit sample. SHIPS OFF. */
import { readFileSync, realpathSync } from "node:fs"
import { sep } from "node:path"

/** Single-comma-no-dot tokens are EU decimal commas (mirrors the audit
 * pipeline's parseFirstColNum contract without importing it — ships-OFF
 * isolation). Anything else falls through to Number(). */
function numToken(tok: string): number {
  if (/^-?\d+,\d+$/.test(tok)) return Number(tok.replace(",", "."))
  return Number(tok)
}

export function parseSeries(text: string): { xs: number[]; ys: number[] } {
  const xs: number[] = []
  const ys: number[] = []
  for (const line of text.split("\n")) {
    const parts = line.trim().split(/\s+/)
    if (parts.length !== 2) continue
    const x = numToken(parts[0]!)
    const y = numToken(parts[1]!)
    if (Number.isNaN(x) || Number.isNaN(y)) continue
    xs.push(x)
    ys.push(y)
  }
  return { xs, ys }
}

export function readSeriesFile(filePath: string, rootDir: string): { xs: number[]; ys: number[] } {
  const real = realpathSync(filePath)
  const root = realpathSync(rootDir)
  if (real !== root && !real.startsWith(root + sep)) {
    throw new Error(`series-source: path escapes root: ${filePath}`)
  }
  return parseSeries(readFileSync(real, "utf-8"))
}
