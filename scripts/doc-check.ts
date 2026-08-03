#!/usr/bin/env bun
// scripts/doc-check.ts — deterministic doc-linter floor (queue item 7a).
//
// Runs over git-TRACKED *.md files only, anchored to the repo root via
// `git rev-parse --show-toplevel` + `git -C <root> ls-files '*.md'` (so an
// invocation from a subdirectory cannot silently narrow scope — `git
// ls-files <pathspec>` interprets a bare pathspec relative to CWD, which
// would otherwise miss files outside it). Untracked scratch docs never
// block the gate. Zero external dependencies, zero network — a flaky or
// dependency-fetching gate is worse than no gate. Scope is deliberately
// narrow (see docs/resume.md 7a): relative-link integrity + fenced-code-
// block balance. No style rules, no line-length, no heading rules — the
// floor must be green on the current corpus by construction; it catches
// regressions, not existing shape.
//
// Checks:
//   (a) every markdown link/image whose target is a relative path (i.e. not
//       http(s):, not mailto:, not anchor-only `#...`) must resolve to an
//       existing file, after stripping any `#fragment` suffix. A target
//       starting with `/` is REPO-ROOT-relative (resolved against the repo
//       root), not OS-filesystem-absolute.
//   (b) fenced code blocks (``` or ~~~) must balance within each file,
//       following CommonMark's closing rule: a fence closes only on a line
//       consisting solely of the SAME character as the opener, repeated the
//       same length or longer — a shorter or different-character fence-like
//       line inside stays literal content, not a nested open/close.
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

function getRepoRoot(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--show-toplevel"], {
    stdout: "pipe",
    stderr: "pipe",
  })
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr)
    throw new Error(`git rev-parse --show-toplevel failed: ${stderr}`)
  }
  return new TextDecoder().decode(proc.stdout).trim()
}

// Anchored to repoRoot via `git -C` so a subdirectory CWD cannot narrow the
// pathspec (git interprets a bare pathspec relative to CWD by default).
// Returns paths relative to repoRoot.
function listTrackedMarkdown(repoRoot: string): string[] {
  const proc = Bun.spawnSync(["git", "-C", repoRoot, "ls-files", "*.md"], {
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
  if (target.startsWith("<")) return true // angle-bracket autolinks, rare in our corpus — skip rather than misparse
  return false
}

// file is repo-root-relative (as returned by listTrackedMarkdown). Link
// targets are resolved against repoRoot: a leading `/` means repo-root-
// relative (NOT OS-absolute), anything else resolves relative to the
// linking file's own directory.
function checkLinks(file: string, text: string, violations: Violation[], repoRoot: string): void {
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
      const resolved = targetPath.startsWith("/")
        ? path.join(repoRoot, targetPath) // repo-root-relative, not OS-absolute
        : path.join(repoRoot, dir, targetPath)
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

// CommonMark fence-close rule: a fence opened with N repeats of a marker
// char (` or ~) closes only on a line consisting SOLELY of that same
// character, repeated N or more times. A fence-like line of a different
// character, or the same character but shorter, is literal content while a
// fence is open — it neither closes the open fence nor opens a nested one
// (fenced regions are not parsed for nested fences, matching CommonMark).
function checkFenceBalance(file: string, text: string, violations: Violation[]): void {
  const lines = text.split("\n")
  let inFence = false
  let fenceChar: "`" | "~" | null = null
  let fenceLen = 0
  let openLine = -1

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (!inFence) {
      const m = /^(`{3,}|~{3,})/.exec(trimmed)
      if (m) {
        inFence = true
        fenceChar = m[1][0] as "`" | "~"
        fenceLen = m[1].length
        openLine = i + 1
      }
    } else {
      const closeRe = fenceChar === "`" ? /^`+$/ : /^~+$/
      if (closeRe.test(trimmed) && trimmed.length >= fenceLen) {
        inFence = false
        fenceChar = null
        fenceLen = 0
        openLine = -1
      }
    }
  }

  if (inFence) {
    violations.push({
      file,
      line: openLine,
      reason: "unclosed fenced code block (no matching same-char, same-or-longer closing fence)",
    })
  }
}

async function main(): Promise<number> {
  const start = performance.now()
  const repoRoot = getRepoRoot()
  const files = listTrackedMarkdown(repoRoot)
  const violations: Violation[] = []

  for (const file of files) {
    const absFile = path.join(repoRoot, file)
    if (!existsSync(absFile)) continue // tracked-but-deleted-in-worktree edge case
    const text = await Bun.file(absFile).text()
    checkLinks(file, text, violations, repoRoot)
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

export { checkLinks, checkFenceBalance, listTrackedMarkdown, isSkippableTarget, getRepoRoot }
