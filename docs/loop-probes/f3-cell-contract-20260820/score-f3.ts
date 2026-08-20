// F3 cell-contract probe — scorer. Zero spend; reads committed raw cells.
//
//   bun docs/loop-probes/f3-cell-contract-20260820/score-f3.ts
//
// Scores every arm under BOTH parsers, per pre-registration.md's matrix:
//   shipped prompt (../reval-adherence-20260819/out-TRAP-r*.json) x {strict, tolerant}
//   O2 / O3 arms   (out-O{2,3}-r*.json)                            x {strict, tolerant}
// PARSE RATE is the primary metric; MISPARSE is the disqualifying one and is
// flagged structurally here (ranges, unit suffixes, embedded digits in words)
// rather than being left to the eye.
import { readFileSync, readdirSync } from "node:fs"
import { join } from "node:path"
import { parseRevalBlock } from "../../../opencode-plugin/src/bench/convention-audit.ts"

const OUT = import.meta.dir
const PRIOR = join(OUT, "..", "reval-adherence-20260819")

const NUM = /[-+]?\d*\.?\d+(?:[eE][-+]?\d+)?/

interface Row { cells: string[] }

function blockRows(raw: string): Row[] {
  const i = raw.indexOf("REVALIDATION:")
  if (i < 0) return []
  const out: Row[] = []
  for (const line of raw.slice(i).split("\n")) {
    if ((line.match(/\|/g) ?? []).length < 4) continue
    if (/^\s*\|[-|\s]+\|\s*$/.test(line)) continue
    const cells = line.split("|").map((c) => c.trim()).filter((c, j, a) => !(j === 0 && !c) && !(j === a.length - 1 && !c))
    if (cells[0] === "input") continue
    if (cells.length >= 4) out.push({ cells })
  }
  return out
}

/** O1's tolerant reading: first number for input/canonical, post-last-`=` for
 * computed. Returns the value AND whether the cell was clean enough that the
 * number is the cell's actual assertion rather than a guess at prose. */
function tolerant(cell: string, kind: "plain" | "computed"): { v: number | null; misparse: string | null } {
  const s = cell.replace(/,/g, "")
  if (kind === "computed" && s.includes("=")) {
    const tail = s.split("=").pop()!.trim()
    if (new RegExp(`^${NUM.source}$`).test(tail)) return { v: Number(tail), misparse: null }
    const m = tail.match(NUM)
    return { v: m ? Number(m[0]) : null, misparse: m ? `post-= segment is not a lone number: ${JSON.stringify(tail)}` : null }
  }
  const m = s.match(NUM)
  if (!m) return { v: null, misparse: null }
  const v = Number(m[0])
  // A range ("1580-1590") silently collapses to its low end.
  if (/\d\s*[-–]\s*\d/.test(s)) return { v, misparse: `range collapsed to low end: ${JSON.stringify(cell)}` }
  // A digit inside a word ("2D band") is not a measurement.
  const idx = s.indexOf(m[0])
  if (/[A-Za-z]/.test(s.slice(idx + m[0].length, idx + m[0].length + 1))) {
    return { v, misparse: `digit taken from a word: ${JSON.stringify(cell)}` }
  }
  return { v, misparse: null }
}

function scoreTolerant(raw: string): { parsed: boolean; landings: number; misparses: string[] } {
  const rows = blockRows(raw)
  const misparses: string[] = []
  let landings = 0
  for (const { cells } of rows) {
    // O3 adds a derivation column before `discriminates`; numeric columns stay 0..2.
    const a = tolerant(cells[0]!, "plain")
    const b = tolerant(cells[1]!, "computed")
    const c = tolerant(cells[2]!, "plain")
    for (const r of [a, b, c]) if (r.misparse) misparses.push(r.misparse)
    if (a.v !== null && b.v !== null && c.v !== null && cells[cells.length - 1]) landings++
  }
  return { parsed: landings >= 2, landings, misparses }
}

function arm(label: string, dir: string, prefix: string) {
  const files = readdirSync(dir).filter((f) => f.startsWith(prefix) && f.endsWith(".json")).sort()
  if (!files.length) return
  let strictOk = 0, tolOk = 0, shape = 0
  const allMis: string[] = []
  for (const f of files) {
    const raw = JSON.parse(readFileSync(join(dir, f), "utf8")).rawAudit as string
    const s = parseRevalBlock(raw)
    if (s.kind === "claim") strictOk++
    if (raw.includes("REVALIDATION:") && blockRows(raw).length >= 2) shape++
    const t = scoreTolerant(raw)
    if (t.parsed) tolOk++
    allMis.push(...t.misparses)
  }
  const n = files.length
  console.log(`${label.padEnd(22)} shape ${shape}/${n}   strict ${strictOk}/${n}   +tolerant ${tolOk}/${n}   misparses ${allMis.length}`)
  for (const m of [...new Set(allMis)]) console.log(`    ! ${m}`)
}

console.log("arm                    SHAPE       STRICT       O1(tolerant)   MISPARSE")
arm("shipped prompt", PRIOR, "out-TRAP-r")
arm("O2 split-channels", OUT, "out-O2-r")
arm("O3 derivation-col", OUT, "out-O3-r")
