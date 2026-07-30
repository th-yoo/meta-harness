/**
 * fixture-ref.ts — Phase 2 block-time repo snapshot (evidence-only).
 * Lives at the hook-cli seam ON PURPOSE (F1): src/core/ and vendor/ are
 * MECHANISM_PATHS. Host-local; NEVER exported by km-sensors-sync.sh (F2).
 * Non-mutating: temp GIT_INDEX_FILE, working index and tree untouched.
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

export const FIXTURE_REF_REL_PATH = ".km/fixture-refs.ndjson"

export interface FixtureRefRecord {
  ts: number            // SAME value as the paired check-output sidecar record
  sessionID: string
  round: number
  check: string
  headSha: string       // HEAD at block time ("" if unborn)
  treeSha: string       // git write-tree result ("" when bailed)
  ref: string           // refs/kkamak/fixtures/<ts>-<sid8>-r<round> ("" when bailed)
  transcriptPath?: string
  bail?: string         // "rebase-merge" | "rebase-apply" | "merge-head" | "cherry-pick" | "not-a-repo" | "git-failed: <step>"
}

export interface GitRunOpts {
  cwd: string
  env?: Record<string, string>
}

export type GitRunner = (argv: string[], opts: GitRunOpts) => Promise<{ code: number; out: string }>

export const bunGitRunner: GitRunner = async (argv, opts) => {
  const proc = Bun.spawn(["git", ...argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe", stderr: "pipe",
  })
  const timer = setTimeout(() => { try { proc.kill("SIGKILL") } catch {} }, 15_000)
  // Drain stdout AND stderr concurrently — a git call that writes >64KB to
  // stderr while nothing reads it deadlocks the child on the pipe, stalling
  // this (interactive Stop-critical-path) call until the SIGKILL timer.
  const [out] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ])
  const code = await proc.exited
  clearTimeout(timer)
  return { code, out }
}

const BAILS: Array<[string, string]> = [
  ["rebase-merge", ".git/rebase-merge"],
  ["rebase-apply", ".git/rebase-apply"],
  ["merge-head", ".git/MERGE_HEAD"],
  ["cherry-pick", ".git/CHERRY_PICK_HEAD"],
]

export async function buildFixtureRef(
  args: { cwd: string; ts: number; sessionID: string; round: number; check: string; transcriptPath?: string },
  run: GitRunner,
): Promise<FixtureRefRecord> {
  const base = {
    ts: args.ts, sessionID: args.sessionID, round: args.round, check: args.check,
    headSha: "", treeSha: "", ref: "",
    ...(args.transcriptPath ? { transcriptPath: args.transcriptPath } : {}),
  }
  if (!fs.existsSync(path.join(args.cwd, ".git"))) return { ...base, bail: "not-a-repo" }
  for (const [name, rel] of BAILS) {
    if (fs.existsSync(path.join(args.cwd, rel))) return { ...base, bail: name }
  }
  const tmpIndex = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "kkamak-fxidx-")), "index")
  const opts: GitRunOpts = { cwd: args.cwd, env: { GIT_INDEX_FILE: tmpIndex } }
  try {
    const head = await run(["rev-parse", "HEAD"], opts)
    const headSha = head.code === 0 ? head.out.trim() : ""
    const add = await run(["add", "-A"], opts)
    if (add.code !== 0) return { ...base, headSha, bail: "git-failed: add" }
    const wt = await run(["write-tree"], opts)
    if (wt.code !== 0) return { ...base, headSha, bail: "git-failed: write-tree" }
    const treeSha = wt.out.trim()
    const ref = `refs/kkamak/fixtures/${args.ts}-${args.sessionID.slice(0, 8)}-r${args.round}`
    const ur = await run(["update-ref", ref, treeSha], opts)
    if (ur.code !== 0) return { ...base, headSha, treeSha, bail: "git-failed: update-ref" }
    return { ...base, headSha, treeSha, ref }
  } finally {
    try { fs.rmSync(path.dirname(tmpIndex), { recursive: true, force: true }) } catch {}
  }
}

/** mkdir -p + append one ndjson line; never throws (appendCheckOutput contract). */
export function appendFixtureRef(cwd: string, rec: FixtureRefRecord, log: (msg: string) => void): void {
  try {
    const p = path.resolve(cwd, FIXTURE_REF_REL_PATH)
    fs.mkdirSync(path.dirname(p), { recursive: true })
    fs.appendFileSync(p, JSON.stringify(rec) + "\n")
  } catch (e) {
    try { log(`hook-cli: failed to append fixture-ref (swallowed): ${String(e)}`) } catch {}
  }
}

/** Full capture: build + append, swallowing everything (fail-open). */
export async function captureFixtureRef(
  args: { cwd: string; ts: number; sessionID: string; round: number; check: string; transcriptPath?: string },
  run: GitRunner,
  log: (msg: string) => void,
): Promise<void> {
  try {
    appendFixtureRef(args.cwd, await buildFixtureRef(args, run), log)
  } catch (e) {
    try { log(`hook-cli: fixture capture failed (swallowed): ${String(e)}`) } catch {}
  }
}
