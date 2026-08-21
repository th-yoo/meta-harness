import { parseSeries } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-source.ts"
import { detectPeaks } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/series-peaks.ts"
import { mergeCheck, FIT_FAMILY } from "/home/th-yoo/z2/meta-harness/opencode-plugin/src/bench/reval-fit.ts"
import { readFileSync, writeFileSync } from "node:fs"

function grade(label: string, text: string) {
  const rawLines = text.split("\n").filter(l => l.trim().length).length
  const { xs, ys } = parseSeries(text)
  let out = `${label.padEnd(30)} lines=${String(rawLines).padStart(4)} parsed=${String(xs.length).padStart(4)}`
  if (xs.length < 10) { console.log(out + "  -> PARSE FAILURE"); return }
  const ax = detectPeaks(ys).map(p => xs[p]!)
  out += ` anchors=${String(ax.length).padStart(2)}`
  if (ax.length >= 3) {
    const inv = FIT_FAMILY.find(f => f.name === "inv-x")!
    const m = mergeCheck(ax.map(x => inv.u(x)), ax.map(x => 1e7 / x))
    out += `  gate=${m.ok ? "accept" : "reject(" + m.reason + ")"}`
  } else out += "  gate=n<3"
  console.log(out)
}

// 1. the REAL rung-2 fixture, as shipped
const real = readFileSync("term-bench2/probe-tasks/raman-fitting-audit/environment/task-deps/graphene.dat", "utf-8")
grade("REAL rung2 (comma+CRLF+desc)", real)

// 2. my quartet, as built
const mine = readFileSync("term-bench2/probe-tasks/raman-quartet-report/environment/task-deps/graphene.dat", "utf-8")
grade("quartet (dot+LF+asc)", mine)

// 3. quartet converted to the REAL conventions
const rows = mine.trim().split("\n").map(l => l.split("\t"))
const eu = rows.slice().reverse().map(([a,b]) => `${a.replace(".", ",")}\t${b.replace(".", ",")}`).join("\r\n") + "\r\n"
writeFileSync("/tmp/claude-1001/quartet-eu.dat", eu)
grade("quartet -> comma+CRLF+desc", eu)

// 4. isolate each trap
grade("quartet + comma only", rows.map(([a,b]) => `${a.replace(".",",")}\t${b.replace(".",",")}`).join("\n"))
grade("quartet + CRLF only", rows.map(([a,b]) => `${a}\t${b}`).join("\r\n"))
grade("quartet + descending only", rows.slice().reverse().map(([a,b]) => `${a}\t${b}`).join("\n"))
