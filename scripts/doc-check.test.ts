// scripts/doc-check.test.ts — unit + process-level tests for doc-check.ts
// (queue item 7a, doc-linter floor). Zero model calls, zero network. Run
// directly (NOT wired into cc-gate-plugin's suite, per instruction):
//
//   bun test scripts/doc-check.test.ts
//
// Uses hermetic tmp git repos for the process-level (spawn) cases so the
// script's own `git ls-files` call sees a real, controlled tracked set, and
// direct function imports for the pure-logic cases.
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { checkLinks, checkFenceBalance, isSkippableTarget, isExcludedPath } from "./doc-check"

function mkPlainDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "doc-check-unit-"))
}

const DOC_CHECK = path.join(import.meta.dir, "doc-check.ts")

interface RunResult {
  stdout: string
  stderr: string
  exitCode: number
}

async function run(cwd: string): Promise<RunResult> {
  const proc = Bun.spawn(["bun", DOC_CHECK], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: process.env as Record<string, string>,
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { stdout, stderr, exitCode }
}

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "doc-check-test-"))
  Bun.spawnSync(["git", "init", "-q"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.email", "test@example.com"], { cwd: dir })
  Bun.spawnSync(["git", "config", "user.name", "Test"], { cwd: dir })
  return dir
}

function gitAdd(dir: string, ...files: string[]): void {
  Bun.spawnSync(["git", "add", ...files], { cwd: dir })
}

function rm(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true })
}

// ---------------------------------------------------------------------
// Process-level (spawn) tests — exercise the real git ls-files + exit code
// ---------------------------------------------------------------------

test("broken relative link is detected and fails with exit 1", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [missing](./nope.md) for details.\n",
    )
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("doc.md:3")
    expect(result.stdout).toContain("nope.md")
  } finally {
    rm(repo)
  }
})

test("good relative link passes with exit 0", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "target.md"), "# Target\n")
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [target](./target.md) for details.\n",
    )
    gitAdd(repo, "doc.md", "target.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("OK")
  } finally {
    rm(repo)
  }
})

test("fragment-only links (#anchor) are skipped, not treated as broken", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nJump to [section](#some-section) below.\n\n## Some section\n",
    )
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
  } finally {
    rm(repo)
  }
})

test("relative link with a #fragment suffix checks the file part only", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "target.md"), "# Target\n\n## Sub\n")
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [sub](./target.md#sub) for details.\n",
    )
    gitAdd(repo, "doc.md", "target.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
  } finally {
    rm(repo)
  }
})

test("http(s) links are skipped even when unreachable-looking", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [external](https://example.com/definitely/not/a/real/path) for details.\n",
    )
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
  } finally {
    rm(repo)
  }
})

test("unclosed fenced code block is detected and fails with exit 1", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\n```bash\necho hi\n",
    )
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("doc.md:3")
    expect(result.stdout).toContain("unclosed fenced code block")
  } finally {
    rm(repo)
  }
})

test("untracked file with a broken link is ignored (git ls-files scope)", async () => {
  const repo = mkRepo()
  try {
    // Tracked file is clean.
    fs.writeFileSync(path.join(repo, "tracked.md"), "# Clean\n")
    gitAdd(repo, "tracked.md")
    // Untracked scratch file has a broken link and an unclosed fence —
    // neither should block the gate.
    fs.writeFileSync(
      path.join(repo, "scratch.md"),
      "# Scratch\n\n[bad](./nowhere.md)\n\n```\nunterminated\n",
    )
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("scratch.md")
  } finally {
    rm(repo)
  }
})

// ---------------------------------------------------------------------
// Controller ruling (2026-08-03 fix wave): term-bench2/store/** is
// experiment DATA (candidate lineage, live role prompts) with load-bearing
// bytes — never linted, never edited to satisfy a lint check.
// ---------------------------------------------------------------------

test("a store-path .md with a lint violation does NOT block — excluded from scope entirely, not just tolerated", async () => {
  const repo = mkRepo()
  try {
    // Tracked, clean file outside the excluded tree.
    fs.writeFileSync(path.join(repo, "tracked.md"), "# Clean\n")
    // Tracked file INSIDE term-bench2/store/** with BOTH a broken relative
    // link and an unclosed fence — real violations, would fail the checks
    // if scanned. Bytes are load-bearing (sha-pinned harness slots,
    // byte-compare candidate discipline) — must never be a lint target.
    fs.mkdirSync(path.join(repo, "term-bench2", "store", "roles", "x"), { recursive: true })
    fs.writeFileSync(
      path.join(repo, "term-bench2", "store", "roles", "x", "system.md"),
      "# Candidate prompt\n\n[bad](./nowhere.md)\n\n```\nunterminated\n",
    )
    gitAdd(repo, "tracked.md", "term-bench2/store/roles/x/system.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).not.toContain("term-bench2/store")
    // Scanned-file count in the summary line reflects the exclusion (1
    // tracked doc counted, not 2) — proves the file was never scanned, not
    // merely that its violations were silently swallowed.
    expect(result.stdout).toContain("1 tracked file(s)")
  } finally {
    rm(repo)
  }
})

test("isExcludedPath matches term-bench2/store/** and leaves other paths alone", () => {
  expect(isExcludedPath("term-bench2/store/roles/x/system.md")).toBe(true)
  expect(isExcludedPath("term-bench2/store/global/candidates/s1/system.md")).toBe(true)
  expect(isExcludedPath("docs/2026-08-01-gate-floor-boundary.md")).toBe(false)
  expect(isExcludedPath("term-bench2/leaderboard/README.md")).toBe(false) // sibling tree, not store/
})

// ---------------------------------------------------------------------
// Direct function tests — pure logic, no process spawn needed
// ---------------------------------------------------------------------

test("isSkippableTarget classifies http/https/mailto/anchor as skippable", () => {
  expect(isSkippableTarget("https://example.com")).toBe(true)
  expect(isSkippableTarget("http://example.com")).toBe(true)
  expect(isSkippableTarget("mailto:a@b.com")).toBe(true)
  expect(isSkippableTarget("#anchor")).toBe(true)
  expect(isSkippableTarget("./relative.md")).toBe(false)
  expect(isSkippableTarget("../up/relative.md")).toBe(false)
})

test("checkFenceBalance passes balanced fences and flags an odd count", () => {
  const balanced: ReturnType<typeof Array> = []
  checkFenceBalance("f.md", "```\ncode\n```\n", balanced as any)
  expect(balanced.length).toBe(0)

  const unbalanced: any[] = []
  checkFenceBalance("f.md", "```\ncode\n", unbalanced)
  expect(unbalanced.length).toBe(1)
  expect(unbalanced[0].line).toBe(1)
})

test("checkLinks flags a missing relative target with correct file:line", () => {
  const repoRoot = mkPlainDir()
  try {
    const violations: any[] = []
    checkLinks("docs/sub/doc.md", "line1\n[x](./missing.md)\n", violations, repoRoot)
    expect(violations.length).toBe(1)
    expect(violations[0].file).toBe("docs/sub/doc.md")
    expect(violations[0].line).toBe(2)
  } finally {
    rm(repoRoot)
  }
})

// ---------------------------------------------------------------------
// FIX 2: repo-root-relative links (leading `/`) resolve against the repo
// root, not the OS filesystem root.
// ---------------------------------------------------------------------

test("repo-root-relative link (leading slash) resolves against the repo root, not OS-absolute", async () => {
  const repo = mkRepo()
  try {
    fs.mkdirSync(path.join(repo, "docs"))
    fs.writeFileSync(path.join(repo, "docs", "target.md"), "# Target\n")
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [target](/docs/target.md) for details.\n",
    )
    gitAdd(repo, "doc.md", "docs/target.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
  } finally {
    rm(repo)
  }
})

test("repo-root-relative link (leading slash) to a missing file is still caught", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(
      path.join(repo, "doc.md"),
      "# Title\n\nSee [target](/docs/nowhere.md) for details.\n",
    )
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("doc.md:3")
    expect(result.stdout).toContain("/docs/nowhere.md")
  } finally {
    rm(repo)
  }
})

// ---------------------------------------------------------------------
// FIX 3: CommonMark fence-close rule — a fence closes only on a same-char,
// same-or-longer marker; a shorter or different-char fence-like line inside
// stays literal content (no false-positive unclosed-fence on nesting-shaped
// content).
// ---------------------------------------------------------------------

test("fence balance: a shorter same-char fence-like line inside a longer fence does not falsely close it", async () => {
  const repo = mkRepo()
  try {
    const content = ["# Title", "", "````", "```", "some text", "````", ""].join("\n")
    fs.writeFileSync(path.join(repo, "doc.md"), content)
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("OK")
  } finally {
    rm(repo)
  }
})

test("fence balance: a genuinely unclosed fence still fails even with a shorter same-char line inside it", async () => {
  const repo = mkRepo()
  try {
    const content = ["# Title", "", "````", "```", "some text", ""].join("\n")
    fs.writeFileSync(path.join(repo, "doc.md"), content)
    gitAdd(repo, "doc.md")
    const result = await run(repo)
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("doc.md:3")
    expect(result.stdout).toContain("unclosed fenced code block")
  } finally {
    rm(repo)
  }
})

// ---------------------------------------------------------------------
// FIX 4: git ls-files is anchored to the repo root — invoking from a
// subdirectory cannot silently narrow scope.
// ---------------------------------------------------------------------

test("invoking from a subdirectory still scans the whole tracked tree, not just the subdirectory", async () => {
  const repo = mkRepo()
  try {
    fs.writeFileSync(path.join(repo, "root-level.md"), "# Root level\n")
    fs.mkdirSync(path.join(repo, "sub"))
    fs.writeFileSync(
      path.join(repo, "sub", "nested.md"),
      "# Nested\n\n[bad](./missing.md)\n",
    )
    gitAdd(repo, "root-level.md", "sub/nested.md")
    const result = await run(path.join(repo, "sub"))
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toContain("sub/nested.md")
  } finally {
    rm(repo)
  }
})
