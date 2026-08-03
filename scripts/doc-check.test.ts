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
import { checkLinks, checkFenceBalance, isSkippableTarget } from "./doc-check"

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
  const violations: any[] = []
  checkLinks("docs/sub/doc.md", "line1\n[x](./missing.md)\n", violations)
  expect(violations.length).toBe(1)
  expect(violations[0].file).toBe("docs/sub/doc.md")
  expect(violations[0].line).toBe(2)
})
