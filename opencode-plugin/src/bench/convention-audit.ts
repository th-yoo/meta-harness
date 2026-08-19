import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs"
import { join, dirname, relative, sep } from "node:path"
import type { BenchPaths } from "./paths.ts"
import { BenchError } from "./util.ts"

export const AUDIT_PROMPT_VERSION = "lane-a-v1"

export function auditPrompt(): string {
  return readFileSync(join(dirname(new URL(import.meta.url).pathname), "convention-audit-prompt.txt"), "utf-8")
}

/** Output of buildSample: the flattened text handed to the audit model call
 * + whether the size budget forced early truncation (files after the cutoff
 * were dropped, not partially emitted). */
export interface Sample {
  text: string
  truncated: boolean
}

const DEFAULT_BUDGET_BYTES = 200_000

/** Parse only the COPY directives out of a Dockerfile's raw text — a
 * deliberately narrow, leak-guard-only parser. Do NOT import
 * parseTaskDockerfile (staging.ts): it does zero path containment and
 * die()s on any directive it doesn't classify, which is fatal for a sampler
 * that must run over arbitrary task Dockerfiles. Mirrors the COPY-handling
 * shape at staging.ts:735-756 (skip --from=, multi-source COPY iterates
 * every token but the last as a source) without adopting any of that
 * module's other behavior.
 */
function parseCopySources(dockerfileText: string): string[] {
  const sources: string[] = []
  for (const raw of dockerfileText.split("\n")) {
    const line = raw.trim()
    const m = /^COPY\s+(.+)$/i.exec(line)
    if (!m) continue
    const body = m[1]!
    if (body.includes("--from=")) continue // multi-stage/external-image copy — not a host path
    const parts = body.split(/\s+/).filter((p) => p.length > 0)
    if (parts.length < 2) continue // need at least one source + a dest
    const srcs = parts.slice(0, -1) // last token is the dest, everything else is a source
    sources.push(...srcs)
  }
  return sources
}

/** Depth-first, name-sorted file listing under `p` (file or directory) —
 * sorted so the emitted sample is deterministic across OS readdir order. */
function collectFiles(p: string): string[] {
  const st = statSync(p)
  if (st.isFile()) return [p]
  if (!st.isDirectory()) return []
  const out: string[] = []
  const entries = [...readdirSync(p, { withFileTypes: true })].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  for (const e of entries) {
    const full = join(p, e.name)
    if (e.isDirectory()) out.push(...collectFiles(full))
    else if (e.isFile()) out.push(full)
  }
  return out
}

/** A cheap, dependency-free per-file summary: line count + a `\S+` token
 * histogram (top 10) + a first-column numeric range when every non-blank
 * line's first column parses as a number; binary files (a NUL byte in the
 * first 8000 bytes) get a hex dump of the first 64 bytes instead. Followed
 * by head-20/tail-20 lines so the model sees real content, not just stats.
 */
function summarizeFile(buf: Buffer): string {
  const probe = buf.subarray(0, 8000)
  if (probe.includes(0)) {
    const head = buf.subarray(0, 64)
    return `binary; first 64 bytes hex: ${head.toString("hex")}`
  }

  const text = buf.toString("utf-8")
  const rawLines = text.split("\n")
  const lines = text.endsWith("\n") ? rawLines.slice(0, -1) : rawLines
  const lineCount = lines.length

  const tokenCounts = new Map<string, number>()
  for (const m of text.matchAll(/\S+/g)) {
    tokenCounts.set(m[0], (tokenCounts.get(m[0]) ?? 0) + 1)
  }
  const top = [...tokenCounts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, 10)
    .map(([tok, c]) => `${tok}:${c}`)
    .join(" ")

  const nonBlank = lines.filter((l) => l.trim().length > 0)
  const firstCols = nonBlank.map((l) => l.trim().split(/\s+/)[0]!)
  const nums = firstCols.map(Number)
  let rangeStr = ""
  if (firstCols.length > 0 && nums.every((n) => !Number.isNaN(n))) {
    rangeStr = ` first-col-range=[${Math.min(...nums)}, ${Math.max(...nums)}]`
  }

  const head = lines.slice(0, 20).join("\n")
  const tail = lines.slice(-20).join("\n")
  return `lines=${lineCount} top-tokens: ${top}${rangeStr}\n--head--\n${head}\n--tail--\n${tail}`
}

/** Sample a task's instruction + Dockerfile COPY inputs for the convention-
 * audit model call — LEAK-SAFE: every COPY source is realpath-canonicalized
 * and required to resolve to `<task>/environment` or a descendant of it
 * before any bytes are read, so it can NEVER emit tests/ or solution/
 * content (directly, via `..`-traversal, or via a symlink that resolves
 * outside environment/). Both containment failures throw BenchError rather
 * than silently skipping — a leak guard that degrades instead of failing
 * loud is not a leak guard.
 */
export function buildSample(paths: BenchPaths, task: string, budgetBytes: number = DEFAULT_BUDGET_BYTES): Sample {
  const taskDir = join(paths.tbRoot, task)
  const instructionText = readFileSync(join(taskDir, "instruction.md"), "utf-8")

  let dockerfileText = ""
  try {
    dockerfileText = readFileSync(join(taskDir, "environment", "Dockerfile"), "utf-8")
  } catch {
    dockerfileText = "" // no Dockerfile — nothing to COPY, instruction-only sample
  }

  const root = realpathSync(join(taskDir, "environment"))
  const sources = parseCopySources(dockerfileText)

  const parts: string[] = [instructionText]
  let usedBytes = Buffer.byteLength(instructionText, "utf-8")
  let truncated = false

  outer: for (const src of sources) {
    let cand: string
    try {
      cand = realpathSync(join(root, src))
    } catch (e) {
      throw new BenchError(`convention-audit: COPY source not found (leak guard): ${src}`)
    }
    if (!(cand === root || cand.startsWith(root + sep))) {
      throw new BenchError(`convention-audit: COPY source escapes environment/ (leak guard): ${src}`)
    }

    for (const filePath of collectFiles(cand)) {
      const buf = readFileSync(filePath)
      const name = relative(root, filePath)
      const block = `=== ${name} (${buf.length}) ===\n${summarizeFile(buf)}\n`
      const blockBytes = Buffer.byteLength(block, "utf-8")
      if (usedBytes + blockBytes > budgetBytes) {
        truncated = true
        break outer
      }
      parts.push(block)
      usedBytes += blockBytes
    }
  }

  return { text: parts.join("\n"), truncated }
}

export function parseVerdict(raw: string): "MISMATCH" | "NO_MISMATCH" {
  const m = raw.match(/CONTENT VERDICT:\s*(MISMATCH|NO MISMATCH)/i)
  if (!m) return "NO_MISMATCH"
  return m[1].toUpperCase() === "MISMATCH" ? "MISMATCH" : "NO_MISMATCH"
}

export function cardFrom(raw: string): string {
  return raw.trim()
}
