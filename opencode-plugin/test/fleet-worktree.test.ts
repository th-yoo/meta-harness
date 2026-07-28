import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, lstatSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createWorktree, removeWorktree } from "../src/fleet/worktree.ts"

/** A real, minimal git repo in a temp dir, mirroring meta-harness's own
 * `.gitignore` for `.kkamak/` + `node_modules/` so a runtime-ledger
 * write does not dirty the tracked tree. */
function initRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "mh-wt-repo-"))
  const g = (args: string[]) => execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" })
  g(["init", "-q", "-b", "main"])
  g(["config", "user.email", "t@t.t"])
  g(["config", "user.name", "t"])
  writeFileSync(join(repo, ".gitignore"), ".kkamak/\nnode_modules/\n")
  writeFileSync(join(repo, "README.md"), "hi\n")
  g(["add", "-A"])
  g(["commit", "-qm", "init"])
  return repo
}

let repo: string
beforeEach(() => { repo = initRepo() })
afterEach(() => { rmSync(repo, { recursive: true, force: true }) })

describe("worktree primitive", () => {
  test("createWorktree adds a linked worktree + branch; removeWorktree tears it down", () => {
    const wt = createWorktree(repo, { branch: "fleet/s1" })
    expect(existsSync(wt.dir)).toBe(true)
    expect(existsSync(join(wt.dir, "README.md"))).toBe(true)          // base HEAD checked out
    const list = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" })
    expect(list).toContain(wt.dir)
    expect(list).toContain("[fleet/s1]")

    removeWorktree(wt)
    expect(existsSync(wt.dir)).toBe(false)
    const after = execFileSync("git", ["-C", repo, "worktree", "list"], { encoding: "utf-8" })
    expect(after).not.toContain(wt.dir)
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "fleet/s1"], { encoding: "utf-8" })
    expect(branches.trim()).toBe("")                                  // throwaway branch deleted
  })

  test("createWorktree symlinks node_modules (gitignored, not carried by git)", () => {
    mkdirSync(join(repo, "node_modules"))
    writeFileSync(join(repo, "node_modules", "marker.txt"), "x")
    const wt = createWorktree(repo, { branch: "fleet/s2" })
    const link = join(wt.dir, "node_modules")
    expect(lstatSync(link).isSymbolicLink()).toBe(true)
    expect(existsSync(join(link, "marker.txt"))).toBe(true)           // resolves to the repo's
    removeWorktree(wt)
  })

  test("the live tree stays clean after createWorktree (worktree is elsewhere)", () => {
    const wt = createWorktree(repo, { branch: "fleet/s3" })
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain"], { encoding: "utf-8" })
    expect(status.trim()).toBe("")
    removeWorktree(wt)
  })

  test("create → remove → create the same branch again is re-run safe", () => {
    const a = createWorktree(repo, { branch: "fleet/reuse" })
    removeWorktree(a)                                        // deletes the branch + prunes admin state
    const b = createWorktree(repo, { branch: "fleet/reuse" }) // same name works — branch was deleted
    expect(existsSync(b.dir)).toBe(true)
    removeWorktree(b)
  })

  test("removeWorktree with keepBranch:true preserves the branch", () => {
    const wt = createWorktree(repo, { branch: "fleet/keep" })
    removeWorktree(wt, { keepBranch: true })
    expect(existsSync(wt.dir)).toBe(false)                    // worktree torn down
    const branches = execFileSync("git", ["-C", repo, "branch", "--list", "fleet/keep"], { encoding: "utf-8" })
    expect(branches).toContain("fleet/keep")                  // branch preserved
    // cleanup the preserved branch so the temp repo is tidy
    execFileSync("git", ["-C", repo, "branch", "-D", "fleet/keep"], { encoding: "utf-8" })
  })
})
