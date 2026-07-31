// km-gauge corpus-replay execution-state resolver (plan 2026-07-31, Task 4).
//
// mine -> derive -> resolve -> report pipeline, stage 3: turns a "derived"
// CorpusRecord into a "resolved" one by locating a real repo snapshot for
// the record's prompt (join order below), materializing it into a scratch
// git repo, and running the derived check against it via the SAME
// evaluateGauge (evaluate.ts) the live path uses — so guard-refusal /
// 126-127-unrunnable / 124-timeout semantics are byte-identical to live.
// Zero model calls: resolve only evaluates an ALREADY-derived check.
//
// --- Join order (amendment point-2, plan Task 4 design paragraph) ---
//
// For a record's session (joined on the record's `sessionId`, renamed
// `sessionID` only at this consumption boundary — corpus-store.ts's casing
// pin), we first compute `cycle`: the SMALLEST-ts sensor-stream line
// (`.km/gate-outcomes.ndjson`, read from the record's OWN repo — sensor
// lines are per-repo, same as fixture-refs) for this session with
// `ts >= promptTs`, EXCLUDING `skippedStop` marker lines (those record a
// turn that never actually engaged the gate — see prompt.ts — so they are
// not a "real" completed cycle, just a soft signal). `cycle` doubles as
// both: (a) the misattribution bound for join (i), and (b) the anchor
// ts+host for join (ii).
//
// (i) `.km/fixture-refs.ndjson` join: candidate = smallest-ts fixture-ref
//     for this session with `ts >= promptTs` AND `ts - promptTs <= 24h`
//     (fixture-ref ts is BLOCK time, promptTs is SUBMISSION time — exact
//     equality would never fire) and a non-empty treeSha (a bail record —
//     not-a-repo / mid-rebase / git-failed — carries treeSha:"" and can
//     never be a real snapshot). Misattribution guard: if `cycle` exists
//     and `cycle.ts` falls strictly between promptTs and candidate.ts, the
//     candidate belongs to a LATER prompt's cycle (this record's own turn
//     already completed cleanly, or a filler turn's cycle completed, before
//     the candidate ref was ever written) — fall through to (ii) using the
//     SAME `cycle`. Otherwise verify the object still exists
//     (`git cat-file -e <treeSha>`, in the record's repo); pruned -> fall
//     through to (ii) using the SAME `cycle`. A verified match sets
//     `state.kind = "fixture-ref"` and a SIBLING `state.joinKind` (never
//     overloading `kind`): "clean" when no `skippedStop` marker line falls
//     strictly between promptTs and candidate.ts either, "nearest" when one
//     does — a `skippedStop` marker is the one kind of non-cycle-producing
//     turn that DOES leave sensor-stream evidence (prompt.ts's "queued
//     prompt ate the Stop boundary" case); ordinary fast-path turns
//     (`edited:false && !gating`) leave NO trace anywhere and stay an
//     un-auditable residual either way — "nearest" is the honest admission
//     that such a turn MAY still sit in the gap even though nothing here
//     proves it.
//
// (ii) commit join: requires `cycle` (no cycle info at all -> (iii) none)
//      AND `cycle.host === hostname()` of the machine running resolve — a
//      sensor line recorded on a DIFFERENT host has no reliable
//      relationship to THIS host's local git history (this project runs
//      across a WSL2 box and a MacBook; a repo clone's commit log on one
//      host says nothing trustworthy about commits at a given wall-clock
//      moment on the other). Given a host match: first commit (oldest to
//      newest, `git log --reverse`) with committer-ts >= cycle.ts and
//      <= cycle.ts + 7d. `state.kind = "commit"`; `joinKind` is left UNSET
//      here (T1's corpus-store.ts doc comment ties it to the fixture-ref
//      match specifically — a commit-anchored snapshot is already
//      acknowledged-approximate by construction, so there's no separate
//      clean/nearest distinction to draw).
//
// (iii) none: `state.kind = "none"`, descriptive-only — no exec, not pool
//       eligible.
//
// --- Materialization (BOTH tree + commit cases) ---
//
// `git archive <sha> | tar -x -C <mkdtemp dir>` as ONE raw
// `Bun.spawn(["bash","-c",...])` shell pipe — NEVER through GitRunner,
// whose `.text()` capture UTF-8-decodes and would corrupt the binary tar
// stream (GitRunner is reused only for the text-output calls below:
// cat-file/init/add/commit/log). Then, in the extracted dir:
// `git init && git add -A && git commit` (synthetic, `--allow-empty`, a
// throwaway author/committer identity) so checks that themselves invoke
// git parse a real (if history-less) repo instead of hitting exit 128 —
// worktree was REJECTED (can't take tree objects; shares the live object
// store = mutation risk on a repo we don't own). `bun install` runs ONLY
// if a bun lockfile is present, 120s setup budget; a setup failure (spawn
// throw, non-zero exit, or the 120s timeout) sets `state.error` and stops
// there — descriptive-only, NEVER counted as an M1v2 miss (pinned risk,
// plan Global Constraints). Finally `runCheck(check, dir, 30_000)` — 30s
// PINNED to GAUGE_CHECK_TIMEOUT_MS (hook-cli.ts:36) for live comparability,
// never the 60s model budget, never the old 300s default — via
// `evaluateGauge(shim, {ran:false}, injected)` where `shim` is the stored
// derivation blob AS-IS (already persisted full-GaugeFile-shaped by T1/T3 —
// "straight cast", no synthesis). `finally` rmSync the temp dir — after a
// timeout AND after a normal completed check alike — writing checks is
// disposable by construction; nothing there is ever meant to survive.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { evaluateGauge } from "./evaluate.ts"
import type { GaugeFile } from "./files.ts"
import {
  readCorpus,
  writeCorpus,
  upsertRecords,
  acquireCorpusLock,
  refreshCorpusLock,
  releaseCorpusLock,
  type CorpusRecord,
  type CorpusRecordState,
  type CorpusRecordExec,
} from "./corpus-store.ts"
import { bunGitRunner, FIXTURE_REF_REL_PATH, type FixtureRefRecord, type GitRunner } from "../fixture-ref.ts"
import { DEFAULT_SENSOR_REL_PATH } from "../sensor-append.ts"
import { runCheck as realRunCheck } from "../check-runner.ts"
import type { SensorLine } from "../types.ts"

const MS_24H = 24 * 60 * 60 * 1000
const MS_7D = 7 * 24 * 60 * 60 * 1000
export const CHECK_TIMEOUT_MS = 30_000 // pinned = GAUGE_CHECK_TIMEOUT_MS, hook-cli.ts:36
const INSTALL_TIMEOUT_MS = 120_000

// --- ndjson readers (per-repo files — sensor lines and fixture-refs both
// live under the RECORD'S repo, not the corpus store's cwd). Same
// never-throw, skip-malformed-lines discipline as corpus-store.readCorpus. ---

function readNdjson<T>(file: string): T[] {
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const out: T[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const j: unknown = JSON.parse(trimmed)
      if (typeof j === "object" && j !== null) out.push(j as T)
    } catch {
      // malformed line — skip silently
    }
  }
  return out
}

export function readSensorLines(repo: string): SensorLine[] {
  return readNdjson<SensorLine>(path.join(repo, DEFAULT_SENSOR_REL_PATH))
}

export function readFixtureRefsFor(repo: string): FixtureRefRecord[] {
  return readNdjson<FixtureRefRecord>(path.join(repo, FIXTURE_REF_REL_PATH))
}

// --- pure join helpers ---

/** Smallest-ts sensor line for `sessionId` with `ts >= promptTs`, excluding
 * `skippedStop` markers (not a "real" completed cycle — see module doc). */
export function findCycle(
  sensors: SensorLine[],
  sessionId: string,
  promptTs: number,
): SensorLine | undefined {
  let best: SensorLine | undefined
  for (const s of sensors) {
    if (s.sessionID !== sessionId) continue
    if (s.skippedStop) continue
    if (s.ts < promptTs) continue
    if (!best || s.ts < best.ts) best = s
  }
  return best
}

/** Smallest-ts fixture-ref for `sessionId` with `promptTs <= ts <= promptTs
 * + 24h` and a non-empty treeSha (bail records carry `treeSha:""` and are
 * never usable snapshots). */
export function findFixtureRefCandidate(
  refs: FixtureRefRecord[],
  sessionId: string,
  promptTs: number,
): FixtureRefRecord | undefined {
  let best: FixtureRefRecord | undefined
  for (const r of refs) {
    if (r.sessionID !== sessionId) continue
    if (!r.treeSha) continue
    if (r.ts < promptTs) continue
    if (r.ts - promptTs > MS_24H) continue
    if (!best || r.ts < best.ts) best = r
  }
  return best
}

/** True iff any NON-skippedStop sensor line for `sessionId` falls strictly
 * between `promptTs` and `boundTs` — the misattribution guard: such a line
 * is a DIFFERENT completed cycle, proof the candidate ref (at boundTs)
 * cannot be this record's own. */
function hasInterveningCycle(
  sensors: SensorLine[],
  sessionId: string,
  promptTs: number,
  boundTs: number,
): boolean {
  return sensors.some(
    (s) => s.sessionID === sessionId && !s.skippedStop && s.ts > promptTs && s.ts < boundTs,
  )
}

/** True iff any `skippedStop` marker line for `sessionId` falls strictly
 * between `promptTs` and `boundTs` — the joinKind "nearest" signal. */
function hasInterveningMarker(
  sensors: SensorLine[],
  sessionId: string,
  promptTs: number,
  boundTs: number,
): boolean {
  return sensors.some(
    (s) => s.sessionID === sessionId && s.skippedStop === true && s.ts > promptTs && s.ts < boundTs,
  )
}

// --- git plumbing ---

/** `argv` never throws — a bad cwd (e.g. a since-deleted repo) surfaces as
 * a non-zero/absent result, same as any other git failure, rather than an
 * uncaught spawn exception taking down the whole resolve batch. */
async function safeGit(git: GitRunner, argv: string[], cwd: string, env?: Record<string, string>) {
  try {
    return await git(argv, { cwd, ...(env ? { env } : {}) })
  } catch {
    return { code: 1, out: "" }
  }
}

function shQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/** `git archive <sha> | tar -x -C <dir>` — ONE raw bash pipe (module doc:
 * NEVER through GitRunner, whose `.text()` UTF-8-decode corrupts binary tar
 * output). Runs with cwd = the SOURCE repo (git archive reads from there);
 * extracts into `dir`. */
async function materializeTree(sha: string, repo: string, dir: string): Promise<boolean> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["bash", "-c", `git archive ${shQuote(sha)} | tar -x -C ${shQuote(dir)}`], {
      cwd: repo,
      stdout: "ignore",
      stderr: "ignore",
    })
  } catch {
    return false
  }
  try {
    const code = await proc.exited
    return code === 0
  } catch {
    return false
  }
}

const SYNTH_GIT_ENV = {
  GIT_AUTHOR_NAME: "kkamak-corpus-replay",
  GIT_AUTHOR_EMAIL: "corpus-replay@kkamak.local",
  GIT_COMMITTER_NAME: "kkamak-corpus-replay",
  GIT_COMMITTER_EMAIL: "corpus-replay@kkamak.local",
}

/** Best-effort: a synthetic init/add/commit failure never aborts resolve —
 * it only means git-invoking checks inside `dir` see exit-128 instead of a
 * real (if history-less) repo, same as if this step didn't exist. */
async function synthesizeCommit(git: GitRunner, dir: string, log: (m: string) => void): Promise<void> {
  const init = await safeGit(git, ["init", "-q"], dir)
  if (init.code !== 0) {
    log(`state-resolve: synthetic git init failed in ${dir} (swallowed)`)
    return
  }
  await safeGit(git, ["add", "-A"], dir)
  const commit = await safeGit(
    git,
    ["commit", "-q", "--allow-empty", "-m", "kkamak corpus-replay synthetic snapshot"],
    dir,
    SYNTH_GIT_ENV,
  )
  if (commit.code !== 0) {
    log(`state-resolve: synthetic git commit failed in ${dir} (swallowed)`)
  }
}

async function defaultBunInstall(dir: string): Promise<{ code: number }> {
  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn(["bun", "install"], { cwd: dir, stdout: "ignore", stderr: "ignore" })
  } catch {
    return { code: 1 }
  }
  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // best-effort
    }
  }, INSTALL_TIMEOUT_MS)
  try {
    const code = await proc.exited
    return { code }
  } catch {
    return { code: 1 }
  } finally {
    clearTimeout(timer)
  }
}

function hasLockfile(dir: string): boolean {
  return fs.existsSync(path.join(dir, "bun.lock")) || fs.existsSync(path.join(dir, "bun.lockb"))
}

export interface ResolveDeps {
  hostname: () => string
  git: GitRunner
  runCheck: (cmd: string, cwd: string, timeoutMs: number) => Promise<{ code: number; out: string; ms: number }>
  bunInstall: (dir: string) => Promise<{ code: number }>
  log: (m: string) => void
}

export function defaultResolveDeps(): ResolveDeps {
  return {
    hostname: () => os.hostname(),
    git: bunGitRunner,
    runCheck: realRunCheck,
    bunInstall: defaultBunInstall,
    log: (m: string) => console.error(m),
  }
}

/** Materialize `sha` from `repo` into a scratch dir, run the record's
 * derived check there via evaluateGauge, ALWAYS clean up (finally). Returns
 * the state additions (materialized/error) plus exec/poolEligible. */
async function materializeAndRun(
  sha: string,
  repo: string,
  derivation: GaugeFile,
  deps: ResolveDeps,
): Promise<{ materialized: boolean; error?: string; exec?: CorpusRecordExec; poolEligible: boolean }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-resolve-"))
  try {
    const ok = await materializeTree(sha, repo, dir)
    if (!ok) {
      return { materialized: false, error: "materialization failed: git archive | tar", poolEligible: false }
    }

    await synthesizeCommit(deps.git, dir, deps.log)

    if (hasLockfile(dir)) {
      const install = await deps.bunInstall(dir)
      if (install.code !== 0) {
        return {
          materialized: true,
          error: `bun install failed (exit ${install.code})`,
          poolEligible: false,
        }
      }
    }

    let captured: { code: number; ms: number } | undefined
    const injectedRunCheck = async (cmd: string): Promise<{ code: number; out: string }> => {
      const r = await deps.runCheck(cmd, dir, CHECK_TIMEOUT_MS)
      captured = { code: r.code, ms: r.ms }
      return { code: r.code, out: r.out }
    }

    const field = await evaluateGauge(derivation, { ran: false }, injectedRunCheck)
    const exec: CorpusRecordExec = {
      executable: field.executable ?? false,
      ...(field.pass !== undefined ? { pass: field.pass } : {}),
      ...(captured?.code !== undefined ? { code: captured.code } : {}),
      ...(captured?.ms !== undefined ? { ms: captured.ms } : {}),
      ...(field.refused !== undefined ? { refused: field.refused } : {}),
      timeoutMs: CHECK_TIMEOUT_MS,
    }
    return { materialized: true, exec, poolEligible: true }
  } finally {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      // best-effort — the temp dir is disposable by construction
    }
  }
}

/** One "derived" CorpusRecord -> "resolved". Never throws: any join/
 * materialization failure lands as `state.kind:"none"` or `state.error`,
 * both descriptive-only per the plan's pinned risk (never an M1v2 miss). */
export async function resolveRecord(
  record: CorpusRecord,
  sensors: SensorLine[],
  fixtureRefs: FixtureRefRecord[],
  deps: ResolveDeps,
): Promise<CorpusRecord> {
  if (!record.derivation) return record // defensive — resolve only ever runs on stage:"derived"

  const sessionID = record.sessionId // casing rename happens HERE (module doc)
  const cycle = findCycle(sensors, sessionID, record.promptTs)

  // --- (i) fixture-ref join ---
  const candidate = findFixtureRefCandidate(fixtureRefs, sessionID, record.promptTs)
  if (candidate) {
    const misattributed = cycle ? cycle.ts > record.promptTs && cycle.ts < candidate.ts : false
    if (!misattributed) {
      const verify = await safeGit(deps.git, ["cat-file", "-e", candidate.treeSha], record.repo)
      if (verify.code === 0) {
        const joinKind = hasInterveningMarker(sensors, sessionID, record.promptTs, candidate.ts)
          ? "nearest"
          : "clean"
        const state: CorpusRecordState = {
          kind: "fixture-ref",
          ref: candidate.ref,
          treeSha: candidate.treeSha,
          joinKind,
        }
        const result = await materializeAndRun(candidate.treeSha, record.repo, record.derivation, deps)
        return {
          ...record,
          stage: "resolved",
          state: {
            ...state,
            materialized: result.materialized,
            ...(result.error !== undefined ? { error: result.error } : {}),
          },
          ...(result.exec !== undefined ? { exec: result.exec } : {}),
          poolEligible: result.poolEligible,
        }
      }
      // pruned (git cat-file -e failed) -> fall through to (ii)
    }
    // misattributed -> fall through to (ii), using the same `cycle`
  }

  // --- (ii) commit join ---
  if (cycle && cycle.host === deps.hostname()) {
    const log = await safeGit(deps.git, ["log", "--reverse", "--format=%H%x09%ct"], record.repo)
    if (log.code === 0 && log.out.trim()) {
      for (const line of log.out.trim().split("\n")) {
        const [sha, ctStr] = line.split("\t")
        if (!sha || !ctStr) continue
        const committerTs = Number(ctStr) * 1000
        if (Number.isNaN(committerTs)) continue
        if (committerTs < cycle.ts) continue
        if (committerTs > cycle.ts + MS_7D) continue

        const state: CorpusRecordState = {
          kind: "commit",
          sha,
          committerTs,
          host: cycle.host,
        }
        const result = await materializeAndRun(sha, record.repo, record.derivation, deps)
        return {
          ...record,
          stage: "resolved",
          state: {
            ...state,
            materialized: result.materialized,
            ...(result.error !== undefined ? { error: result.error } : {}),
          },
          ...(result.exec !== undefined ? { exec: result.exec } : {}),
          poolEligible: result.poolEligible,
        }
      }
    }
  }

  // --- (iii) none ---
  return {
    ...record,
    stage: "resolved",
    state: { kind: "none" },
    poolEligible: false,
  }
}

export interface ResolveSummary {
  pending: number
  resolved: number
}

/** Batch-resolve every stage:"derived" record. Same lock-across-the-whole-
 * batch discipline as runDerive/runMine (corpus-replay.ts /
 * replay-cli.ts): acquire before the first read, refresh per record (a
 * batch of real-repo materializations + 30s checks can run long),
 * writeCorpus(..., {lockHeld:true}), release in `finally`. No `--go` cost
 * fence here — unlike derive, resolve spends zero model tokens (plan
 * Global Constraints: "mine/resolve/report model-free"). */
export async function runResolve(
  cwd: string,
  log: (m: string) => void,
  deps: ResolveDeps = defaultResolveDeps(),
): Promise<ResolveSummary | undefined> {
  if (!acquireCorpusLock(cwd, log)) return undefined
  try {
    const all = readCorpus(cwd)
    const pending = all.filter((r) => r.stage === "derived")

    const cache = new Map<string, { sensors: SensorLine[]; refs: FixtureRefRecord[] }>()
    const results: CorpusRecord[] = []
    for (const record of pending) {
      let ctx = cache.get(record.repo)
      if (!ctx) {
        ctx = { sensors: readSensorLines(record.repo), refs: readFixtureRefsFor(record.repo) }
        cache.set(record.repo, ctx)
      }
      results.push(await resolveRecord(record, ctx.sensors, ctx.refs, deps))
      refreshCorpusLock(cwd)
    }

    const merged = upsertRecords(all, results)
    const ok = writeCorpus(cwd, merged, log, { lockHeld: true })
    if (!ok) return undefined

    const summary: ResolveSummary = { pending: pending.length, resolved: results.length }
    log(`resolve: ${summary.resolved}/${summary.pending} resolved; store now ${merged.length} record(s)`)
    return summary
  } finally {
    releaseCorpusLock(cwd)
  }
}
