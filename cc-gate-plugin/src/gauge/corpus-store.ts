// km-gauge corpus-replay store (pre-reg amendment d869660, corpus-transcript
// lane — docs/superpowers/plans/2026-07-31-gauge-corpus-replay.md Task 1).
//
// Single append/rewrite target for the whole mine -> derive -> resolve ->
// report pipeline: `.km/gauge-corpus/records.ndjson`, one CorpusRecord per
// line, idempotent on `(repo, promptSha256)`. Host-local by construction
// (F2): NEVER added to scripts/km-sensors-sync.sh's FILES list — see the F2
// tripwire test in corpus-store.test.ts (fixture-ref.test.ts:185-190
// precedent). F1: this file lives under cc-gate-plugin/src/gauge/, outside
// every MECHANISM_PATH.
//
// Casing boundary (pinned by the plan): the raw transcript JSONL key is
// `sessionId` (lowercase d) — CorpusRecord.sessionId keeps that raw casing.
// The rename to `sessionID` happens ONLY at the two later consumption points
// (GaugeFile-shaped derivation blob; fixture-ref join key), never here.
//
// Locking (review round 1: the original mkdir+separate-writeFileSync design
// had a TOCTOU window — a concurrent reader could observe the just-created
// dir before its content file landed, misread that as torn/stale, and take
// over while the first writer was still mid-flight, letting both hold the
// lock). Fixed to a SINGLE atomic artifact, mirroring prompt-check-spawn.ts:
// `.km/gauge-corpus/.lock` is one FILE created via `writeFileSync(path,
// content, {flag:"wx"})` — content and exclusivity land in one syscall, so
// there is no window where the lock exists without its content. A lock
// older than STALE_MS is stale-equivalent (also: unreadable/unparseable,
// i.e. torn from a killed writer) and takeover unlinks it, then makes
// exactly one fresh `wx` attempt; losing that race to a concurrent takeover
// is treated the same as ordinary fresh contention. Genuine contention
// REFUSES (km-sensors-sync.sh refusal-discipline precedent) rather than
// silently losing the concurrent writer's update — writeCorpus is
// read-modify-write at the caller level (full records array in, full array
// out), so two overlapping invocations without a lock would clobber each
// other.
import fs from "node:fs"
import path from "node:path"
import type { GaugeFile } from "./files.ts"

export const CORPUS_DIR_REL = ".km/gauge-corpus"
export const CORPUS_FILE_REL = ".km/gauge-corpus/records.ndjson"

const LOCK_FILE_NAME = ".lock"
const STALE_MS = 10 * 60 * 1000 // 10 minutes

export type CorpusStage = "mined" | "derived" | "resolved"

/** Registered literal per the pre-verdict amendment (d869660, gauge v2
 * pre-reg lines 46-47): `live | corpus-transcript | corpus-bench`. `"live"`
 * is deliberately NOT a member here — live provenance exists only in
 * verdict reporting computed over the sensor stream (`.km/gate-outcomes
 * .ndjson`), never as a stored corpus record; this store persists the two
 * corpus lanes only. Corpus-bench (TB2) lane deferred — this schema
 * reserves the value only; only "corpus-transcript" is ever produced today. */
export type CorpusProvenance = "corpus-transcript" | "corpus-bench"

export interface CorpusRecordState {
  kind: "fixture-ref" | "commit" | "none"
  ref?: string
  treeSha?: string
  sha?: string
  committerTs?: number
  host?: string
  materialized?: boolean
  error?: string
  /** Sibling of `kind`, never overloading it: "clean" when zero Stop cycles
   * intervene between promptTs and the matched fixture-ref's ts, "nearest"
   * when the sensor-stream bound passed but a non-cycle-producing turn may
   * still sit between (Task 4). */
  joinKind?: "clean" | "nearest"
}

export interface CorpusRecordExec {
  executable: boolean
  pass?: boolean
  code?: number
  ms?: number
  refused?: string
  timeoutMs: number
}

/** v1 corpus record. `derivation`, when present, is persisted full
 * GaugeFile-shaped (files.ts:25-41) — n always 1 (no session ordinal exists
 * in the corpus), ts = Date.now() at derive call (promptTs already carries
 * the when-provenance), model/derivationMs measured at replay — so a later
 * evaluateGauge shim is a straight cast, never a synthesized placeholder. */
export interface CorpusRecord {
  provenance: CorpusProvenance
  stage: CorpusStage
  repo: string
  sessionId: string
  promptTs: number
  prompt: string
  promptSha256: string
  floorCheck: string
  floorCheckMinedAt: number
  derivation?: GaugeFile
  state?: CorpusRecordState
  exec?: CorpusRecordExec
  poolEligible?: boolean
}

/** Missing store file -> []. Malformed / non-object lines are skipped
 * silently (never throw) — a torn write from a killed writer must not take
 * down every later reader. */
export function readCorpus(cwd: string): CorpusRecord[] {
  const file = path.join(cwd, CORPUS_FILE_REL)
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf-8")
  } catch {
    return []
  }
  const out: CorpusRecord[] = []
  for (const line of raw.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const j: unknown = JSON.parse(trimmed)
      if (typeof j === "object" && j !== null) out.push(j as CorpusRecord)
    } catch {
      // malformed line — skip silently, keep reading the rest of the file
    }
  }
  return out
}

interface LockContent {
  pid: number
  ts: number
}

/** One `wx` create attempt — content and exclusivity in the same syscall
 * (prompt-check-spawn.ts precedent). Returns true on success, false on
 * EEXIST (lock already held), rethrows anything else. */
function tryCreateLock(lockPath: string, content: LockContent): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false
    throw e
  }
}

/** True iff the held lock is stale-equivalent: genuinely stale (ts older
 * than STALE_MS), vanished (ENOENT — raced with a concurrent release), or
 * unreadable/unparseable (torn write from a killed writer) — all collapse
 * to the same takeover path. */
function isLockStale(lockPath: string, now: number): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<LockContent> | null
    if (typeof parsed?.ts !== "number") return true
    return now - parsed.ts >= STALE_MS
  } catch {
    return true
  }
}

/** Acquire `.km/gauge-corpus/.lock`. Fresh contention -> false (caller
 * refuses). Stale/torn/vanished lock -> unlink + ONE fresh `wx` attempt;
 * losing that race to a concurrent takeover (EEXIST on the retry) also ->
 * false — never "overwrite and assume ownership". */
function acquireLock(cwd: string, now: number): boolean {
  const lockPath = path.join(cwd, CORPUS_DIR_REL, LOCK_FILE_NAME)
  const content: LockContent = { pid: process.pid, ts: now }

  if (tryCreateLock(lockPath, content)) return true
  if (!isLockStale(lockPath, now)) return false

  try {
    fs.unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
  return tryCreateLock(lockPath, content)
}

/** True iff `<cwd>/.km/gauge-corpus/.lock` exists AND is not stale-equivalent
 * — i.e. a writer is, as far as the lock protocol can tell, genuinely in
 * flight. Exported for paired-validation.ts's `--reset` guard (T1 fix wave):
 * discarding a shadow store must refuse while a shadow derive holds the
 * shadow's own lock, judged by THIS store's staleness rule (isLockStale +
 * STALE_MS above), never a re-invented one. Read-only — never creates,
 * refreshes, or takes over the lock. */
export function hasLiveCorpusLock(cwd: string, now: number = Date.now()): boolean {
  const lockPath = path.join(cwd, CORPUS_DIR_REL, LOCK_FILE_NAME)
  if (!fs.existsSync(lockPath)) return false
  return !isLockStale(lockPath, now)
}

function releaseLock(cwd: string): void {
  const lockPath = path.join(cwd, CORPUS_DIR_REL, LOCK_FILE_NAME)
  try {
    fs.unlinkSync(lockPath)
  } catch {
    // best-effort — never let release itself surface
  }
}

// --- Exported lock lifecycle (Task 3 review, findings 1+2: the lock must be
// able to guard a whole read -> derive -> write lifecycle, not just
// writeCorpus's own tmp+rename, so a caller doing expensive work (model
// calls) between its read and its write can hold the lock across all of it.
// These are the SAME mechanics writeCorpus uses internally — acquireLock /
// releaseLock above — just exposed so a caller can acquire before its first
// read and release after its write, passing writeCorpus `{lockHeld: true}`
// so it neither double-acquires nor releases out from under the caller. ---

/** Acquire `.km/gauge-corpus/.lock` as a standalone step. Same
 * mkdir-exclusive + pid/ts + stale(>10min)-takeover mechanics as
 * writeCorpus's internal acquire (this IS that acquire, exported). On
 * contention, logs a "REFUSING: ..." message (km-sensors-sync.sh refusal
 * discipline) and returns false — caller decides what to refuse (e.g. an
 * entire cost-fenced batch, before any spend). */
export function acquireCorpusLock(cwd: string, log: (m: string) => void): boolean {
  const ok = acquireLock(cwd, Date.now())
  if (!ok) {
    log(
      `REFUSING: gauge-corpus lock — lock held (${CORPUS_DIR_REL}/${LOCK_FILE_NAME}); ` +
        "another writer is in flight.",
    )
  }
  return ok
}

/** Rewrite the held lock's `ts` in place (pid unchanged) — staleness guard
 * for a long-running batch: without periodic refresh, a batch that runs
 * longer than STALE_MS would let a second caller observe the still-valid
 * lock as stale and take over mid-batch. Best-effort: a failed refresh
 * (e.g. the lock file vanished from underneath, which should not happen
 * absent a bug elsewhere) is silently ignored — release/re-acquire handles
 * the fallout, not this call. */
export function refreshCorpusLock(cwd: string): void {
  const lockPath = path.join(cwd, CORPUS_DIR_REL, LOCK_FILE_NAME)
  const content: LockContent = { pid: process.pid, ts: Date.now() }
  try {
    fs.writeFileSync(lockPath, JSON.stringify(content))
  } catch {
    // best-effort — see doc comment above
  }
}

/** Release `.km/gauge-corpus/.lock` as a standalone step (this IS
 * releaseLock, exported) — pairs with acquireCorpusLock for a caller
 * holding the lock across more than just writeCorpus's own tmp+rename. */
export function releaseCorpusLock(cwd: string): void {
  releaseLock(cwd)
}

/** Atomic tmp+rename full rewrite of the corpus store. By default acquires
 * and releases the lock itself, refusing on contention. When the caller
 * already holds the lock (`opts.lockHeld: true` — acquired via
 * acquireCorpusLock across its own read -> derive -> write sequence, Task 3
 * review finding 1/2), this skips BOTH acquire and release: the caller owns
 * the lock's lifetime, and a post-spend write under an already-held lock
 * can never hit contention. Default path (no opts) is byte-identical to the
 * pre-refactor behavior. Returns true on success; on lock contention (only
 * possible when not lockHeld), logs a "REFUSING: ..." message and returns
 * false WITHOUT touching the store file — no lost update. */
export function writeCorpus(
  cwd: string,
  records: CorpusRecord[],
  log: (m: string) => void,
  opts?: { lockHeld?: boolean },
): boolean {
  const now = Date.now()
  const lockHeld = opts?.lockHeld ?? false
  if (!lockHeld && !acquireLock(cwd, now)) {
    log(
      `REFUSING: gauge-corpus write — lock held (${CORPUS_DIR_REL}/${LOCK_FILE_NAME}); ` +
        "another writer is in flight. Nothing written — retry later.",
    )
    return false
  }
  try {
    const corpusDir = path.join(cwd, CORPUS_DIR_REL)
    fs.mkdirSync(corpusDir, { recursive: true })
    const dest = path.join(cwd, CORPUS_FILE_REL)
    const tmp = path.join(corpusDir, `.records.ndjson.tmp-${process.pid}-${now}`)
    const body = records.map((r) => JSON.stringify(r)).join("\n") + (records.length ? "\n" : "")
    fs.writeFileSync(tmp, body)
    fs.renameSync(tmp, dest)
    return true
  } finally {
    if (!lockHeld) releaseLock(cwd)
  }
}

const STAGE_RANK: Record<CorpusStage, number> = { mined: 0, derived: 1, resolved: 2 }

/** Text-safe identity key — plain JSON array serialization, never a raw
 * control-byte separator (review round 1: a literal delimiter char between
 * the two fields made this source file diff as binary to git). Exported for
 * paired-validation.ts (§6c plan T1) — the pv manifest records sampled keys
 * with the store's own identity formula, never a re-derived one. */
export function recordKey(r: CorpusRecord): string {
  return JSON.stringify([r.repo, r.promptSha256])
}

/** Drop keys whose value is explicitly `undefined` before a spread-merge —
 * a patch object that sets `{state: undefined}` must never erase a
 * previously-persisted `state` (review round 1 finding: a plain `{...prev,
 * ...inc}` spread lets an explicit-undefined key null out prior data). */
function stripUndefined<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {}
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Pure merge. Identity is `(repo, promptSha256)`. incoming wins field-wise
 * per matched record (explicit-undefined keys in incoming are ignored, not
 * applied), EXCEPT `stage` never regresses (mined < derived < resolved) — a
 * later "derived" upsert must not un-resolve an already-resolved record
 * just because it was built from a stale in-memory copy. */
export function upsertRecords(
  existing: CorpusRecord[],
  incoming: CorpusRecord[],
): CorpusRecord[] {
  const byKey = new Map<string, CorpusRecord>()
  for (const r of existing) byKey.set(recordKey(r), r)

  for (const inc of incoming) {
    const k = recordKey(inc)
    const prev = byKey.get(k)
    if (!prev) {
      byKey.set(k, inc)
      continue
    }
    const merged: CorpusRecord = { ...prev, ...stripUndefined(inc) }
    if (STAGE_RANK[inc.stage] < STAGE_RANK[prev.stage]) merged.stage = prev.stage
    byKey.set(k, merged)
  }

  return Array.from(byKey.values())
}
