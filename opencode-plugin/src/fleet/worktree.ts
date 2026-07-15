/**
 * worktree.ts — the fleet git-worktree primitive (spec 2026-07-16 N1 + N1b).
 *
 * A squad-run develops in a THROWAWAY git worktree + branch off a target repo
 * so parallel nodes write safely AND self-hosting never mutates the live tree.
 * The worktree is the CODE dir (every role's `--dir`); the runtime ledger
 * (checkpoint/pending/scored) stays anchored to the ORIGINAL repo (runtimeRoot,
 * N1b) so it survives worktree cleanup.
 *
 * Retention policy (enforced by the CALLER — the fleet-dev scheduler, T4):
 * keep a run's worktree alive across a gate-pause/escalation; call
 * `removeWorktree` only on terminal done/abort. This module just provides the
 * create/remove mechanism.
 */
import { execFileSync } from "node:child_process"
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { die } from "../bench/util.ts"

export interface Worktree {
  /** the throwaway checkout — every role's `--dir` for this run */
  dir: string
  /** the fleet branch checked out in `dir` */
  branch: string
  /** the origin repo the worktree is linked to */
  repo: string
}

const sanitizeBranch = (b: string) => b.replace(/[^A-Za-z0-9_\-/]/g, "_")

function git(repo: string, args: string[]): string {
  try {
    return execFileSync("git", ["-C", repo, ...args], { encoding: "utf-8" }).trim()
  } catch (e) {
    return die(`git ${args.join(" ")} failed in ${repo}: ${(e as Error).message}`)
  }
}

/**
 * Create a throwaway git worktree + branch off `repo` at `base` (default HEAD).
 * The checkout lands in a fresh system-temp dir, keeping the live repo dir
 * pristine. `node_modules` is gitignored — `git worktree add` does not carry
 * it — so it is symlinked from the repo, letting the worktree run bun without a
 * fresh install.
 */
export function createWorktree(repo: string, opts: { branch: string; base?: string }): Worktree {
  const repoAbs = resolve(repo)                 // the node_modules symlink target must be absolute
  const branch = sanitizeBranch(opts.branch)
  const base = opts.base ?? "HEAD"
  // Clear admin entries left by a worktree whose dir was deleted out from under
  // git (e.g. a crash) so a fresh add doesn't trip over stale state. Does NOT
  // delete a leftover BRANCH: a true branch-name collision dies loudly here —
  // the caller passes a UNIQUE branch per run (the fleet-dev scheduler uses a
  // run-id), and cleaning crash-leftover branches is the scheduler's D9
  // reconciliation job (T4), not this primitive's.
  git(repoAbs, ["worktree", "prune"])
  const dir = join(mkdtempSync(join(tmpdir(), "mh-fleet-wt-")), "wt")
  git(repoAbs, ["worktree", "add", "-b", branch, dir, base])
  const repoNm = join(repoAbs, "node_modules")
  const wtNm = join(dir, "node_modules")
  if (existsSync(repoNm) && !existsSync(wtNm)) symlinkSync(repoNm, wtNm, "dir")
  return { dir, branch, repo: repoAbs }
}

/**
 * Remove a worktree created by `createWorktree`: force-removes the checkout,
 * cleans its temp parent dir, and (by default) deletes its throwaway branch.
 * Call only on TERMINAL done/abort.
 */
export function removeWorktree(wt: Worktree, opts: { keepBranch?: boolean } = {}): void {
  git(wt.repo, ["worktree", "remove", "--force", wt.dir])
  rmSync(dirname(wt.dir), { recursive: true, force: true })   // the mkdtemp parent, now empty
  if (!opts.keepBranch) {
    try {
      execFileSync("git", ["-C", wt.repo, "branch", "-D", wt.branch], { encoding: "utf-8" })
    } catch {
      // branch already gone (merged/deleted upstream) — throwaway, not an error
    }
  }
}
