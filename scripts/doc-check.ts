#!/usr/bin/env bun
// scripts/doc-check.ts — deterministic doc-linter floor (queue item 7a).
//
// Runs over git-TRACKED *.md files only (`git ls-files '*.md'`), so
// untracked scratch docs never block the gate. Zero external dependencies,
// zero network — a flaky or dependency-fetching gate is worse than no gate.
// Scope is deliberately narrow (see docs/resume.md 7a): relative-link
// integrity + fenced-code-block balance. No style rules, no line-length,
// no heading rules — the floor must be green on the current corpus by
// construction; it catches regressions, not existing shape.
//
// Checks:
//   (a) every markdown link/image whose target is a relative path (i.e. not
//       http(s):, not mailto:, not anchor-only `#...`) must resolve to an
//       existing file, after stripping any `#fragment` suffix.
//   (b) fenced code blocks (``` or ~~~) must balance within each file — an
//       odd count means an unclosed fence.
//
// Exit 0 + one summary line on pass. Exit 1 + one `file:line: reason` line
// per violation on failure.

import { existsSync } from "node:fs"
import path from "node:path"

interface Violation {
  file: string
  line: number
  reason: string
}

function listTrackedMarkdown(): string[] {
  const proc = Bun.spawnSync(["git", "ls-files", "*.md"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr)
    throw new Error(`git ls-files failed: ${stderr}`)
  }
  const out = new TextDecoder().decode(proc.stdout)
  return out.split("\n").filter((l) => l.length > 0)
}

// Matches markdown links and images: [text](target) / ![alt](target).
// Captures the target group (group 2), tolerant of an optional title
// after a space (e.g. `(./foo.md "title")`).
const LINK_RE = /!?\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g

function isSkippableTarget(target: string): boolean {
  if (target.startsWith("http://") || target.startsWith("https://")) return true
  if (target.startsWith("mailto:")) return true
  if (target.startsWith("#")) return true // anchor-only
  if (target.startsWith("<") ) return true // angle-bracket autolinks, rare in our corpus — skip rather than misparse
  return false
}

function checkLinks(file: string, text: string, violations: Violation[]): void {
  const lines = text.split("\n")
  const dir = path.dirname(file)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    LINK_RE.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = LINK_RE.exec(line)) !== null) {
      const rawTarget = m[1]
      if (isSkippableTarget(rawTarget)) continue
      // Strip a trailing #fragment before checking file existence.
      const fragIdx = rawTarget.indexOf("#")
      const targetPath = fragIdx === -1 ? rawTarget : rawTarget.slice(0, fragIdx)
      if (targetPath === "") continue // fragment-only after all (defensive)
      const resolved = path.isAbsolute(targetPath)
        ? targetPath
        : path.join(dir, targetPath)
      if (!existsSync(resolved)) {
        violations.push({
          file,
          line: i + 1,
          reason: `broken relative link -> ${rawTarget}`,
        })
      }
    }
  }
}

function checkFenceBalance(file: string, text: string, violations: Violation[]): void {
  const lines = text.split("\n")
  // Count opening fence lines: a line whose trimmed content starts with
  // ``` or ~~~ (of length >= 3). Every fence line toggles open/closed;
  // an odd total count means the last one never closed.
  let fenceCount = 0
  let firstFenceLine = -1
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (/^(`{3,}|~{3,})/.test(trimmed)) {
      if (fenceCount === 0) firstFenceLine = i + 1
      fenceCount++
    }
  }
  if (fenceCount % 2 !== 0) {
    violations.push({
      file,
      line: firstFenceLine,
      reason: "unclosed fenced code block (odd number of ``` /~~~ fence lines)",
    })
  }
}

async function main(): Promise<number> {
  const start = performance.now()
  const files = listTrackedMarkdown()
  const violations: Violation[] = []

  for (const file of files) {
    if (!existsSync(file)) continue // tracked-but-deleted-in-worktree edge case
    const text = await Bun.file(file).text()
    checkLinks(file, text, violations)
    checkFenceBalance(file, text, violations)
  }

  const elapsedMs = performance.now() - start

  if (violations.length > 0) {
    for (const v of violations) {
      console.log(`${v.file}:${v.line}: ${v.reason}`)
    }
    console.log(
      `doc-check: FAIL — ${violations.length} violation(s) across ${files.length} tracked file(s) (${elapsedMs.toFixed(0)}ms)`,
    )
    return 1
  }

  console.log(
    `doc-check: OK — ${files.length} tracked file(s), 0 violations (${elapsedMs.toFixed(0)}ms)`,
  )
  return 0
}

if (import.meta.main) {
  const code = await main()
  process.exit(code)
}

export { checkLinks, checkFenceBalance, listTrackedMarkdown, isSkippableTarget }
