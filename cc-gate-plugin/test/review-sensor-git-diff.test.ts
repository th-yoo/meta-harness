/** Tests for cc-gate-plugin/src/review-sensor/git-diff.ts (task-5 brief).
 * Hermetic temp git repos, mirroring km-crank/test/loop-probes-cli.test.ts's
 * mkGitRepoWithCommits style: real git init/commit via execFileSync, never
 * the real checkout. Covers the brief's 5 required cases (range,
 * rebase->merge-base, orphan->fallback, real-conflict->undefined,
 * clean->empty diff) plus the brand-new-lastPassHead direct-fallback path
 * and a worktree case exercising the `--absolute-git-dir` MERGE_HEAD fix
 * (self-review: `.git` is a FILE inside a worktree, not a dir). */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { assembleDiff } from "../src/review-sensor/git-diff.ts"

const CLEANUP: string[] = []
afterEach(() => {
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}

function initRepo(): string {
  const dir = mkTmp("review-sensor-git-diff-")
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir })
  return dir
}

/** Writes `file` with `content`, stages it, commits, returns the new HEAD sha. */
function commit(dir: string, file: string, content: string, msg: string): string {
  fs.writeFileSync(path.join(dir, file), content)
  execFileSync("git", ["add", file], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", msg], { cwd: dir })
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
}

function headSha(dir: string): string {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: dir, encoding: "utf8" }).trim()
}

describe("assembleDiff", () => {
  test("range: lastPassHead is an ancestor of HEAD", () => {
    const dir = initRepo()
    const c1 = commit(dir, "a.txt", "1\n", "c1")
    commit(dir, "a.txt", "2\n", "c2")
    const c3 = commit(dir, "a.txt", "3\n", "c3")

    const result = assembleDiff(dir, c1)

    expect(result).toBeDefined()
    expect(result!.diffBase).toBe("range")
    expect(result!.baseSha).toBe(c1)
    expect(result!.headSha).toBe(c3)
    expect(result!.diff).toContain("a.txt")
    expect(result!.diffStat.files).toBe(1)
  })

  test("rebase/reset: lastPassHead not an ancestor -> merge-base", () => {
    const dir = initRepo()
    const base = commit(dir, "a.txt", "0\n", "base")
    execFileSync("git", ["checkout", "-q", "-b", "side"], { cwd: dir })
    const lastPassHead = commit(dir, "b.txt", "side\n", "side-commit")
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir })
    commit(dir, "c.txt", "main2\n", "main-commit")
    const head = headSha(dir)

    const result = assembleDiff(dir, lastPassHead)

    expect(result).toBeDefined()
    expect(result!.diffBase).toBe("merge-base")
    expect(result!.baseSha).toBe(base)
    expect(result!.headSha).toBe(head)
    expect(result!.diff).toContain("c.txt")
  })

  test("orphan: no common ancestor -> fallback", () => {
    const dir = initRepo()
    commit(dir, "a.txt", "1\n", "c1")
    const head = headSha(dir)

    execFileSync("git", ["checkout", "-q", "--orphan", "orphan"], { cwd: dir })
    const lastPassHead = commit(dir, "z.txt", "orphan\n", "orphan-commit")
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir })

    const result = assembleDiff(dir, lastPassHead)

    expect(result).toBeDefined()
    expect(result!.diffBase).toBe("fallback")
    expect(result!.baseSha).toBe(head)
    expect(result!.headSha).toBe(head)
  })

  test("real merge conflict in progress -> undefined", () => {
    const dir = initRepo()
    commit(dir, "a.txt", "base\n", "base")
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: dir })
    commit(dir, "a.txt", "feature\n", "feature-commit")
    execFileSync("git", ["checkout", "-q", "main"], { cwd: dir })
    commit(dir, "a.txt", "main-change\n", "main-commit")

    let conflicted = false
    try {
      execFileSync("git", ["merge", "-q", "feature"], { cwd: dir, stdio: "ignore" })
    } catch {
      conflicted = true
    }
    expect(conflicted).toBe(true) // sanity: fixture actually produced a conflict

    const result = assembleDiff(dir, undefined)

    expect(result).toBeUndefined()
  })

  test("clean repo, lastPassHead === HEAD -> empty diff", () => {
    const dir = initRepo()
    const head = commit(dir, "a.txt", "content\n", "c1")

    const result = assembleDiff(dir, head)

    expect(result).toBeDefined()
    expect(result!.diffBase).toBe("range")
    expect(result!.diff).toBe("")
    expect(result!.diffStat).toEqual({ files: 0, insertions: 0, deletions: 0 })
  })

  test("brand-new lastPassHead === undefined -> fallback directly, working-tree changes included", () => {
    const dir = initRepo()
    commit(dir, "a.txt", "1\n", "c1")
    const head = headSha(dir)
    fs.writeFileSync(path.join(dir, "a.txt"), "1\nuncommitted\n")

    const result = assembleDiff(dir, undefined)

    expect(result).toBeDefined()
    expect(result!.diffBase).toBe("fallback")
    expect(result!.baseSha).toBe(head)
    expect(result!.headSha).toBe(head)
    expect(result!.diff).toContain("uncommitted")
  })

  test("merge-in-progress inside a worktree checkout (`.git` is a FILE, not a dir)", () => {
    const main = initRepo()
    commit(main, "a.txt", "base\n", "base")
    execFileSync("git", ["checkout", "-q", "-b", "feature"], { cwd: main })
    commit(main, "a.txt", "feature\n", "feature-commit")
    execFileSync("git", ["checkout", "-q", "main"], { cwd: main })
    commit(main, "a.txt", "main-change\n", "main-commit")
    const mainHead = headSha(main)

    const wtDir = mkTmp("review-sensor-git-diff-wt-")
    fs.rmdirSync(wtDir) // `git worktree add` requires the target not exist
    // detached checkout: "main" itself is checked out in the primary
    // worktree, and git refuses to check out the same branch twice.
    execFileSync("git", ["worktree", "add", "-q", "--detach", wtDir, mainHead], { cwd: main })
    expect(fs.statSync(path.join(wtDir, ".git")).isFile()).toBe(true) // sanity: .git is a file here

    let conflicted = false
    try {
      execFileSync("git", ["merge", "-q", "feature"], { cwd: wtDir, stdio: "ignore" })
    } catch {
      conflicted = true
    }
    expect(conflicted).toBe(true)

    const result = assembleDiff(wtDir, undefined)

    expect(result).toBeUndefined()
  })

  test("diff larger than 1 MiB survives (maxBuffer regression)", () => {
    const dir = initRepo()

    // Generate ~800 KB of unique lines
    const lines1 = Array.from({ length: 10000 }, (_, i) => `line ${i}: ${"x".repeat(80)}\n`)
    const content1 = lines1.join("")

    const c1 = commit(dir, "large.txt", content1, "c1: ~800KB")

    // Generate ~1.5 MB of different unique lines
    const lines2 = Array.from({ length: 20000 }, (_, i) => `different line ${i}: ${"y".repeat(80)}\n`)
    const content2 = lines2.join("")

    commit(dir, "large.txt", content2, "c2: ~1.5MB")

    const result = assembleDiff(dir, c1)

    expect(result).toBeDefined()
    expect(result!.diff.length).toBeGreaterThan(1024 * 1024) // > 1 MiB
    expect(result!.diffStat.insertions).toBeGreaterThan(0)
  })
})
