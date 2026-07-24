/**
 * minimal/mutate.ts — crude mutation operators for the completion gate's
 * adequacy probe (docs/2026-07-24-completion-gate-design.md §2).
 *
 * Rationale: crude operators are exactly the class that survives weak
 * agent-written suites (MutGen "boundary value blindness"). A verify script
 * that trivially passes is caught because every mutant survives it.
 *
 * Pure module: the syntax checker is injected (real caller uses py_compile;
 * tests use a stub). Deterministic: operators are applied in fixed order at
 * the first applicable site each, then round-robin over later sites — same
 * input always yields the same mutants.
 */

export interface Mutant {
  op: string
  line: number // 1-based line of the change
  mutated: string
}

type Site = { line: number; mutated: string }
type Operator = { op: string; sites: (src: string) => Site[] }

function lines(src: string): string[] {
  return src.split("\n")
}
function withLine(src: string, i: number, newLine: string): string {
  const ls = lines(src)
  ls[i] = newLine
  return ls.join("\n")
}

const OPERATORS: Operator[] = [
  {
    op: "remove-await",
    sites(src) {
      const out: Site[] = []
      lines(src).forEach((l, i) => {
        if (/\bawait /.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/\bawait /, "")) })
      })
      return out
    },
  },
  {
    op: "swap-comparison",
    sites(src) {
      const out: Site[] = []
      lines(src).forEach((l, i) => {
        if (/<=/.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/<=/, "<")) })
        else if (/</.test(l) && !/<</.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/</, "<=")) })
        else if (/>=/.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/>=/, ">")) })
        else if (/>/.test(l) && !/>>/.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/>/, ">=")) })
      })
      return out
    },
  },
  {
    op: "swap-and-or",
    sites(src) {
      const out: Site[] = []
      lines(src).forEach((l, i) => {
        if (/ and /.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/ and /, " or ")) })
        else if (/ or /.test(l)) out.push({ line: i + 1, mutated: withLine(src, i, l.replace(/ or /, " and ")) })
      })
      return out
    },
  },
  {
    op: "negate-if",
    sites(src) {
      const out: Site[] = []
      lines(src).forEach((l, i) => {
        const m = /^(\s*)if (.+):(\s*)$/.exec(l)
        if (m) out.push({ line: i + 1, mutated: withLine(src, i, `${m[1]}if not (${m[2]}):${m[3]}`) })
      })
      return out
    },
  },
  {
    op: "drop-cancel-call",
    sites(src) {
      // deleting a bare .cancel() statement is the double-cancel class's
      // signature mutation — weak suites never notice it
      const out: Site[] = []
      lines(src).forEach((l, i) => {
        if (/^\s*[A-Za-z_][\w.\[\]]*\.cancel\(\)\s*$/.test(l)) {
          const ls = lines(src)
          const indent = /^\s*/.exec(l)![0]
          ls[i] = `${indent}pass`
          out.push({ line: i + 1, mutated: ls.join("\n") })
        }
      })
      return out
    },
  },
]

/** Up to maxK distinct, syntax-valid mutants: first site of each operator in
 * order, then second sites, and so on (deterministic). */
export function generateMutants(
  src: string,
  maxK: number,
  syntaxOk: (mutated: string) => boolean,
): Mutant[] {
  const perOp = OPERATORS.map((o) => ({ op: o.op, sites: o.sites(src) }))
  const out: Mutant[] = []
  const seen = new Set<string>()
  for (let round = 0; out.length < maxK; round++) {
    let any = false
    for (const { op, sites } of perOp) {
      if (out.length >= maxK) break
      const s = sites[round]
      if (!s) continue
      any = true
      if (s.mutated === src || seen.has(s.mutated) || !syntaxOk(s.mutated)) continue
      seen.add(s.mutated)
      out.push({ op, line: s.line, mutated: s.mutated })
    }
    if (!any) break
  }
  return out
}

/** Minimal unified-style diff: the changed lines only, with context line no. */
export function unifiedDiff(orig: string, mutated: string): string {
  const a = lines(orig)
  const b = lines(mutated)
  const out: string[] = []
  const n = Math.max(a.length, b.length)
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) {
      out.push(`@@ line ${i + 1} @@`)
      if (a[i] !== undefined) out.push(`-${a[i]}`)
      if (b[i] !== undefined) out.push(`+${b[i]}`)
    }
  }
  return out.join("\n")
}
