import { execFileSync } from "node:child_process"
import fs from "node:fs"
import path from "node:path"

export interface DiffResult {
  diff: string // committed range + working-tree, concatenated
  diffStat: { files: number; insertions: number; deletions: number }
  baseSha: string
  headSha: string
  diffBase: "range" | "merge-base" | "fallback"
}

/** Run git, returning trimmed-nothing stdout on success or undefined on ANY
 * failure (nonzero exit, missing binary, etc). Never throws. */
function safeExec(args: string[], repoDir: string): string | undefined {
  try {
    return execFileSync("git", args, { cwd: repoDir, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return undefined
  }
}

/** Same as safeExec but only cares about exit status (e.g. `--is-ancestor`). */
function safeExecOk(args: string[], repoDir: string): boolean {
  try {
    execFileSync("git", args, { cwd: repoDir, stdio: "ignore" })
    return true
  } catch {
    return false
  }
}

/** git-dir resolved via `rev-parse`, never a hardcoded `.git/` join — `.git`
 * is a FILE (not a dir) inside a worktree checkout, so MERGE_HEAD lives
 * under the resolved (possibly `.git/worktrees/<name>`) dir, not `repoDir/.git`. */
function isMergeInProgress(repoDir: string): boolean {
  const gitDir = safeExec(["rev-parse", "--absolute-git-dir"], repoDir)?.trim()
  if (gitDir && fs.existsSync(path.join(gitDir, "MERGE_HEAD"))) {
    return true
  }

  const status = safeExec(["status", "--porcelain"], repoDir)
  if (!status) return false

  for (const line of status.split("\n")) {
    if (line.length < 2) continue
    // porcelain v1: XY <path> — unmerged paths carry 'U' in X and/or Y
    // (UU, AU, UA, DU, UD). AA/DD (both-added/both-deleted) are
    // deliberately not treated as unmerged here, per spec.
    if (line[0] === "U" || line[1] === "U") return true
  }
  return false
}

function parseShortstat(text: string | undefined): { files: number; insertions: number; deletions: number } {
  if (!text) return { files: 0, insertions: 0, deletions: 0 }
  const files = /(\d+) files? changed/.exec(text)
  const insertions = /(\d+) insertions?\(\+\)/.exec(text)
  const deletions = /(\d+) deletions?\(-\)/.exec(text)
  return {
    files: files ? Number(files[1]) : 0,
    insertions: insertions ? Number(insertions[1]) : 0,
    deletions: deletions ? Number(deletions[1]) : 0,
  }
}

/** undefined => merge in progress (caller skips "merge-in-progress").
 * Empty-string diff => nothing to review (caller: no dispatch, no line). */
export function assembleDiff(repoDir: string, lastPassHead: string | undefined): DiffResult | undefined {
  if (isMergeInProgress(repoDir)) {
    return undefined
  }

  const headSha = safeExec(["rev-parse", "HEAD"], repoDir)?.trim() ?? ""

  let base = headSha
  let diffBase: DiffResult["diffBase"] = "fallback"

  if (lastPassHead !== undefined) {
    if (safeExecOk(["merge-base", "--is-ancestor", lastPassHead, "HEAD"], repoDir)) {
      base = lastPassHead
      diffBase = "range"
    } else {
      const mergeBase = safeExec(["merge-base", lastPassHead, "HEAD"], repoDir)?.trim()
      if (mergeBase) {
        base = mergeBase
        diffBase = "merge-base"
      }
    }
  }

  let rangeDiff = ""
  let rangeStat = { files: 0, insertions: 0, deletions: 0 }
  if (diffBase !== "fallback") {
    const rd = safeExec(["diff", base, "HEAD"], repoDir)
    if (rd === undefined) {
      // git failure mid-range-diff -> degrade to fallback, never throw.
      diffBase = "fallback"
      base = headSha
    } else {
      rangeDiff = rd
      rangeStat = parseShortstat(safeExec(["diff", "--shortstat", base, "HEAD"], repoDir))
    }
  }

  const wtDiff = safeExec(["diff", "HEAD"], repoDir) ?? ""
  const wtStat = parseShortstat(safeExec(["diff", "--shortstat", "HEAD"], repoDir))

  return {
    diff: rangeDiff + wtDiff,
    diffStat: {
      files: rangeStat.files + wtStat.files,
      insertions: rangeStat.insertions + wtStat.insertions,
      deletions: rangeStat.deletions + wtStat.deletions,
    },
    baseSha: base,
    headSha,
    diffBase,
  }
}
