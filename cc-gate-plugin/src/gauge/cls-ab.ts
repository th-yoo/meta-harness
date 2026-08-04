// Gauge classifier 2×2 A/B — offline experiment tooling (plan
// docs/superpowers/plans/2026-08-03-gauge-classifier-ab.md, Task 1:
// `cls-sample`). Pre-registration amendment (Task 0):
// docs/superpowers/specs/2026-08-03-gauge-classifier-ab-preregistration.md.
//
// `cls-sample` is MODEL-FREE. From the host's REAL corpus store it selects
// every DERIVED record whose stored class is nominal C, plus an equal-size
// Math.random draw of derived not-C records (stratified, C-enriched — the
// design's literal predicate, plan §"Sample"). Unlike paired-validation.ts's
// `pv-sample`, the stratification population is ANY derived record
// regardless of transport (cli/sdk/absent) — the stored CLI-era class is
// only an enrichment heuristic here, never treated as ground truth (fresh
// blind opus labels are the ground truth, Task 2).
//
// Experiment state lives at `<cwd>/.km/gauge-cls-ab/` (gitignored via
// `.km/`, same as every other gauge/ host-local store):
//   manifest.json  — keys (via corpus-store.ts's recordKey) + strata +
//                     counts + sampledAt + hostname. NEVER prompt text
//                     (F2) — this is the only file of the two that could
//                     ever be considered for anything git-adjacent.
//   records.ndjson — the sampled records' key/prompt/floorCheck ONLY
//                     (ClsSampleRecord), host-local-only, never committed —
//                     full fidelity for Task 2's arm + label runners, which
//                     read prompt text from here, never from manifest.json.
//
// refuse-if-exists / --reset mirrors pv-sample (a re-run must never silently
// replace an in-flight sample). Zero nominal-C records is a HARD ERROR,
// checked before the experiment dir is even looked at — so a bad run can
// never discard an in-flight sample, even when --reset is passed.
//
// The REAL store is opened strictly read-only — readCorpus only, never
// writeCorpus, never its lock (report-subcommand precedent: a pure read
// cannot contend with a writer). The byte-identical-store test pins this on
// both the success path and every refusal path.
//
// Concurrency (fix-wave, review finding — cls-sample-vs-ITSELF): the
// existsSync(root)-then-mkdir-then-write sequence below is NOT atomic on its
// own — two concurrent `cls-sample` invocations can both observe
// existsSync(root)===false and race, producing a records.ndjson and a
// manifest.json from DIFFERENT invocations (breaking the manifest<->records
// key-coherence invariant the tests pin). Fixed with an exclusive lockfile
// at `.km/gauge-cls-ab.lock` — a SIBLING of the experiment dir, not nested
// inside it, so a `--reset` rmSync of the experiment dir can never delete
// the very lock protecting the rebuild. Mechanics mirror corpus-store.ts's
// `.lock` convention exactly (mkdir-exclusive `wx` create + pid/ts content +
// stale(>10min)-takeover), so behavior is familiar, NOT reused code (that
// convention is hardcoded to `.km/gauge-corpus/` inside corpus-store.ts and
// cannot be repointed at this experiment's dir without changing it).
// EXPORTED for Task 2's arm/label runners (`cls-run`/`cls-label`), which
// will write `arm-<name>.ndjson`/`labels.ndjson` into this SAME
// `.km/gauge-cls-ab/` dir — they should acquire this same lock around their
// own read-modify-write sequences rather than inventing a second one.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readCorpus, recordKey, type CorpusRecord } from "./corpus-store.ts"
import {
  parseRefinerOutput,
  parseLabelOutput,
  buildRefinerPrompt,
  buildLabelPrompt,
  type PromptVariant,
  type ClsLabel,
} from "./refiner.ts"
import { callModelSdk, callModelSdkLabel } from "./transport.ts"
import { sha256Hex } from "./corpus-mine.ts"
import type { GaugePromptClass } from "../types.ts"

export const CLS_AB_DIR_REL = ".km/gauge-cls-ab"
export const CLS_MANIFEST_NAME = "manifest.json"
export const CLS_RECORDS_NAME = "records.ndjson"
export const CLS_AB_LOCK_REL = ".km/gauge-cls-ab.lock"
export const CLS_AB_LOCK_STALE_MS = 10 * 60 * 1000 // 10 minutes — matches corpus-store.ts's STALE_MS

/** Experiment root for the repo at `cwd`. */
export function clsAbRoot(cwd: string): string {
  return path.join(cwd, CLS_AB_DIR_REL)
}

interface ClsAbLockContent {
  pid: number
  ts: number
}

function clsAbLockPath(cwd: string): string {
  return path.join(cwd, CLS_AB_LOCK_REL)
}

/** One `wx` create attempt — content and exclusivity in the same syscall
 * (corpus-store.ts's `tryCreateLock` precedent). true on success, false on
 * EEXIST (lock already held), rethrows anything else. */
function tryCreateClsAbLock(lockPath: string, content: ClsAbLockContent): boolean {
  try {
    fs.mkdirSync(path.dirname(lockPath), { recursive: true })
    fs.writeFileSync(lockPath, JSON.stringify(content), { flag: "wx" })
    return true
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "EEXIST") return false
    throw e
  }
}

/** True iff the held lock is stale-equivalent: genuinely stale, vanished
 * (ENOENT — raced with a concurrent release), or unreadable/unparseable
 * (torn write from a killed writer) — all collapse to the same takeover
 * path (corpus-store.ts's `isLockStale` precedent). */
function isClsAbLockStale(lockPath: string, now: number): boolean {
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<ClsAbLockContent> | null
    if (typeof parsed?.ts !== "number") return true
    return now - parsed.ts >= CLS_AB_LOCK_STALE_MS
  } catch {
    return true
  }
}

/** In-process record of the lock content THIS process most recently wrote
 * (via acquire or refresh), keyed by lock path (fix-wave F4). Backs the
 * ownership check in `releaseClsAbLock` below: without it, a lock this
 * process acquired, let go stale (e.g. a batch that outran
 * `CLS_AB_LOCK_STALE_MS` without refreshing, or simply a bug), and that was
 * legitimately taken over by a NEW acquirer could still be unlinked out
 * from under that new owner by this process's own deferred
 * `finally { releaseClsAbLock(cwd) }`. Deleted on every release attempt
 * (matched or not) so repeated acquire/release cycles on the same cwd
 * never accumulate stale entries. */
const ownedLocks = new Map<string, ClsAbLockContent>()

/** Acquire `.km/gauge-cls-ab.lock`. Fresh contention -> false (caller
 * refuses). Stale/torn/vanished lock -> unlink + ONE fresh `wx` attempt;
 * losing that race to a concurrent takeover (EEXIST on the retry) also ->
 * false — never "overwrite and assume ownership". EXPORTED for Task 2's
 * arm/label runners to share (see module doc). On success, records the
 * content just written in `ownedLocks` (fix-wave F4) so a later
 * `releaseClsAbLock`/`refreshClsAbLock` can recognize it as this process's
 * own. */
export function acquireClsAbLock(cwd: string, now: number = Date.now()): boolean {
  const lockPath = clsAbLockPath(cwd)
  const content: ClsAbLockContent = { pid: process.pid, ts: now }

  if (tryCreateClsAbLock(lockPath, content)) {
    ownedLocks.set(lockPath, content)
    return true
  }
  if (!isClsAbLockStale(lockPath, now)) return false

  try {
    fs.unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
  const ok = tryCreateClsAbLock(lockPath, content)
  if (ok) ownedLocks.set(lockPath, content)
  return ok
}

/** Rewrite the held lock's `ts` in place (pid unchanged) — staleness guard
 * for a long-running `cls-run`/`cls-label` batch (corpus-store.ts's
 * `refreshCorpusLock` precedent, fix-wave F4): without periodic refresh, a
 * batch that runs longer than `CLS_AB_LOCK_STALE_MS` would let a second
 * caller observe the still-in-flight lock as stale and take it over
 * mid-batch. Also updates this process's `ownedLocks` record so a later
 * `releaseClsAbLock` recognizes the refreshed content as still its own.
 * Best-effort: a failed refresh (e.g. the lock file vanished from
 * underneath, which should not happen absent a bug elsewhere) is silently
 * ignored. EXPORTED for Task 2's arm/label runners to call once per record. */
export function refreshClsAbLock(cwd: string, now: number = Date.now()): void {
  const lockPath = clsAbLockPath(cwd)
  const content: ClsAbLockContent = { pid: process.pid, ts: now }
  try {
    fs.writeFileSync(lockPath, JSON.stringify(content))
    ownedLocks.set(lockPath, content)
  } catch {
    // best-effort — see doc comment above
  }
}

/** Release `.km/gauge-cls-ab.lock` — OWNERSHIP-CHECKED (fix-wave F4): only
 * unlinks when the lock file's CURRENT on-disk pid+ts still match the
 * content this process last wrote via `acquireClsAbLock`/`refreshClsAbLock`
 * (`ownedLocks`). No record of ever having acquired this lock (or a
 * content mismatch — someone else's lock now occupies the path) -> no-op,
 * never unlink a lock this process does not own. Best-effort otherwise
 * (never let release itself surface). EXPORTED for Task 2's arm/label
 * runners to share. */
export function releaseClsAbLock(cwd: string): void {
  const lockPath = clsAbLockPath(cwd)
  const owned = ownedLocks.get(lockPath)
  ownedLocks.delete(lockPath)
  if (owned === undefined) return
  try {
    const raw = fs.readFileSync(lockPath, "utf-8")
    const parsed = JSON.parse(raw) as Partial<ClsAbLockContent> | null
    if (parsed?.pid !== owned.pid || parsed?.ts !== owned.ts) return
    fs.unlinkSync(lockPath)
  } catch {
    // best-effort — see doc comment above (includes: lock already gone)
  }
}

/** True iff `.km/gauge-cls-ab.lock` exists AND is not stale-equivalent —
 * i.e. a writer is, as far as the lock protocol can tell, genuinely in
 * flight. Read-only — never creates, refreshes, or takes over the lock. */
export function hasLiveClsAbLock(cwd: string, now: number = Date.now()): boolean {
  const lockPath = clsAbLockPath(cwd)
  if (!fs.existsSync(lockPath)) return false
  return !isClsAbLockStale(lockPath, now)
}

/** "Derived" per the design: has a stored derivation at all, ANY transport.
 * Deliberately broader than paired-validation.ts's `isCliDerived` — this
 * experiment samples every classified record regardless of which transport
 * produced the stored class, because the stored class is only an enrichment
 * heuristic (ground truth comes from a fresh blind opus label, Task 2). */
export function isDerived(r: CorpusRecord): boolean {
  return r.derivation !== undefined
}

export interface ClsStrata {
  /** every derived record whose stored derivation class is "C" */
  c: CorpusRecord[]
  /** every derived record whose stored derivation class is not "C" (draw pool) */
  notC: CorpusRecord[]
}

/** Pure stratification over the whole store. Not-C deliberately includes
 * class-less derivations (class is optional on v1 blobs) — "not C" is the
 * literal predicate, not "classified as something else" (pv-sample's
 * `stratify` precedent). Deduped by `recordKey` FIRST (fix-wave F14, one
 * line, last-write-wins) — a duplicated line in the store (e.g. a torn
 * write joined across two upsert cycles) must never be double-counted into
 * either stratum, which would silently skew the C-enrichment ratio. */
export function stratify(records: CorpusRecord[]): ClsStrata {
  const deduped = [...new Map(records.map((r) => [recordKey(r), r] as const)).values()]
  const c: CorpusRecord[] = []
  const notC: CorpusRecord[] = []
  for (const r of deduped) {
    if (!isDerived(r)) continue
    if (r.derivation!.class === "C") c.push(r)
    else notC.push(r)
  }
  return { c, notC }
}

/** Equal-size draw from the not-C pool: Fisher-Yates on a copy with plain
 * Math.random (injectable for tests), take the first `size`. Reproducibility
 * comes from the MANIFEST (the drawn keys are recorded), never from a seed.
 * A pool smaller than `size` yields the whole pool (pv-sample's `drawNotC`
 * verbatim). */
export function drawNotC(
  pool: CorpusRecord[],
  size: number,
  rand: () => number = Math.random,
): CorpusRecord[] {
  const shuffled = [...pool]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j]!, shuffled[i]!]
  }
  return shuffled.slice(0, size)
}

/** Per-stratum tally of the sampled records' STORED derivation transport —
 * absent-or-`"cli"` vs `"sdk"` (fix-wave F10; `"cli"` bucket mirrors
 * paired-validation.ts's `isCliDerived` absent-means-cli reading). Descriptive
 * only — the sample itself is any-transport (module doc above); this exists
 * so a reader of the manifest/emitted score doc can see the transport mix
 * without re-deriving it from `records.ndjson` (which carries no transport
 * field at all — F2). */
export interface ClsTransportTally {
  cli: number
  sdk: number
}

/** Sample manifest — counts + store keys per stratum ONLY, never prompt text
 * (F2: code-bearing text never travels). Task 2's arm/label runners join on
 * these keys against `records.ndjson`. */
export interface ClsManifest {
  sampledAt: string
  hostname: string
  cCount: number
  notCCount: number
  keys: { c: string[]; notC: string[] }
  /** fix-wave F10 — per-stratum cli-vs-sdk transport tally of the STORED
   * derivations sampled (descriptive; see `ClsTransportTally` doc). */
  transportCounts: { c: ClsTransportTally; notC: ClsTransportTally }
}

/** One sampled record as persisted to `records.ndjson` — key/prompt/
 * floorCheck ONLY (host-local, never committed — F2). `key` is the store's
 * own `recordKey` identity (JSON `[repo, promptSha256]`), the same value
 * that appears in `manifest.json`'s `keys.c`/`keys.notC`, so Task 2's arm +
 * label runners can join the two files without re-deriving identity. */
export interface ClsSampleRecord {
  key: string
  prompt: string
  floorCheck: string
}

export interface ClsSampleSummary {
  cCount: number
  notCCount: number
  total: number
}

/** `cls-sample [cwd] [--reset] [--discard-spend]` — flags extracted, one
 * positional (cwd), pv-sample's `parsePvSampleArgs` precedent.
 * `--discard-spend` (fix-wave F6) only matters alongside `--reset` — see
 * `runClsSample`'s spend guard. `unknownFlag` (fix-wave F17) is the FIRST
 * unrecognized `--`-prefixed token, if any: it is deliberately never pushed
 * into `positional`, so a typo like `--goo` can never silently become the
 * `cwd` positional — the caller refuses on it instead. */
export function parseClsSampleArgs(
  args: string[],
): { cwd: string; reset: boolean; discardSpend: boolean; unknownFlag: string | undefined } {
  let reset = false
  let discardSpend = false
  let unknownFlag: string | undefined
  const positional: string[] = []
  for (const a of args) {
    if (a === "--reset") reset = true
    else if (a === "--discard-spend") discardSpend = true
    else if (a.startsWith("--")) unknownFlag ??= a
    else positional.push(a)
  }
  return { cwd: positional[0] ?? process.cwd(), reset, discardSpend, unknownFlag }
}

function atomicWrite(dest: string, body: string): void {
  const tmp = dest + ".tmp"
  fs.writeFileSync(tmp, body)
  fs.renameSync(tmp, dest)
}

/** Build the experiment record set + manifest. Returns undefined on
 * refusal (CLI exits 1, runPvSample precedent). Three refusal paths, all
 * with zero effect on the real store AND (where applicable) zero effect on
 * an already-existing experiment dir: zero derived class-C records (a hard
 * error — "nothing to sample" — checked FIRST, before the experiment dir OR
 * the lock is even touched, so a bad run can never discard an in-flight
 * sample, even with --reset); the `.km/gauge-cls-ab.lock` held by a
 * concurrent invocation (cls-sample-vs-itself, or a Task 2 arm/label runner
 * sharing the dir — REFUSE rather than race, module-doc fix-wave); and a
 * pre-existing experiment dir without --reset (a re-run must never silently
 * replace an in-flight sample). The existsSync-check -> rmSync/mkdir ->
 * write sequence all happens WHILE THE LOCK IS HELD, so two concurrent
 * `cls-sample` calls can never both observe an absent dir and race to build
 * it — the second loses the lock and refuses cleanly. */
/** Row counts of the "spend" files a `--reset` would destroy: `labels.ndjson`
 * (if present) + every `arm-<name>.ndjson` (if present) under the experiment
 * root. Fix-wave F6 — the exact-counts audit both the refusal and the
 * (opted-in) discard path print, so `--reset` can never silently discard
 * completed label/arm spend. */
function clsSpendFileCounts(root: string): { file: string; rows: number }[] {
  const out: { file: string; rows: number }[] = []
  const labelsPath = path.join(root, CLS_LABELS_NAME)
  if (fs.existsSync(labelsPath)) out.push({ file: CLS_LABELS_NAME, rows: readNdjson<unknown>(labelsPath).length })
  for (const arm of CLS_ALL_ARM_NAMES) {
    const armPath = path.join(root, clsArmFileName(arm))
    if (fs.existsSync(armPath)) out.push({ file: clsArmFileName(arm), rows: readNdjson<unknown>(armPath).length })
  }
  return out
}

function fmtSpendFiles(files: { file: string; rows: number }[]): string {
  return files.map((f) => `${f.file}: ${f.rows} row(s)`).join(", ")
}

/** Per-stratum cli-vs-sdk transport tally of the STORED derivations sampled
 * (fix-wave F10) — every record here is already known `isDerived` (callers
 * pass the `c`/`drawn` arrays straight from `stratify`/`drawNotC`), so
 * `.derivation` is always defined; only `.transport` is optional
 * (absent = cli, mirrors paired-validation.ts's `isCliDerived`). */
function transportTally(records: CorpusRecord[]): ClsTransportTally {
  let cli = 0
  let sdk = 0
  for (const r of records) {
    if (r.derivation!.transport === "sdk") sdk++
    else cli++
  }
  return { cli, sdk }
}

export function runClsSample(
  cwd: string,
  opts: { reset?: boolean; discardSpend?: boolean },
  log: (m: string) => void,
  rand: () => number = Math.random,
): ClsSampleSummary | undefined {
  // REAL store: lock-free read path only — never writeCorpus, never its lock.
  const { c, notC } = stratify(readCorpus(cwd))
  if (c.length === 0) {
    log(
      "cls-sample: ERROR — zero nominal-C derived records in the store; nothing to sample. " +
        "(hard error, checked before any experiment-dir mutation)",
    )
    return undefined
  }

  if (!acquireClsAbLock(cwd)) {
    log(
      `REFUSING: cls-sample — lock held (${CLS_AB_LOCK_REL}) — another cls-sample (or a Task 2 ` +
        "arm/label writer) appears to be in flight against this experiment dir.",
    )
    return undefined
  }

  try {
    const root = clsAbRoot(cwd)
    if (fs.existsSync(root)) {
      if (!opts.reset) {
        log(
          `REFUSING: experiment dir already exists (${CLS_AB_DIR_REL}) — a re-run would silently ` +
            "replace an in-flight sample. Pass --reset to discard it and rebuild.",
        )
        return undefined
      }
      // Belt-and-braces (fix-wave F15): re-confirm the lock we JUST acquired
      // above reads back as live before any destructive rmSync — the same
      // paranoia check pv-sample's --reset guard performs via
      // hasLiveCorpusLock (against the shadow store's own separate lock),
      // ported here against a torn/foreign lock file written between our
      // acquisition and this point.
      if (!hasLiveClsAbLock(cwd)) {
        log(
          `REFUSING: --reset — lock (${CLS_AB_LOCK_REL}) unexpectedly not live right after ` +
            "acquisition; refusing to discard the sample defensively.",
        )
        return undefined
      }
      // Spend guard (fix-wave F6): a --reset must never silently discard
      // completed label/arm spend. Both the refusal and the (opted-in)
      // discard print the EXACT row counts about to be destroyed.
      const spendFiles = clsSpendFileCounts(root)
      if (spendFiles.length > 0) {
        const summary = fmtSpendFiles(spendFiles)
        if (!opts.discardSpend) {
          log(
            `REFUSING: --reset — spend file(s) present and would be destroyed (${summary}) — pass ` +
              "--discard-spend (in addition to --reset) to confirm discarding this spend.",
          )
          return undefined
        }
        log(`cls-sample: --reset --discard-spend — destroying (${summary}).`)
      }
      fs.rmSync(root, { recursive: true, force: true })
    }

    const drawn = drawNotC(notC, c.length, rand)
    if (drawn.length < c.length) {
      log(
        `cls-sample: not-C pool (${drawn.length}) smaller than the nominal-C stratum (${c.length}) — ` +
          "drawing the whole pool.",
      )
    }

    fs.mkdirSync(root, { recursive: true })

    const sampled = [...c, ...drawn]

    // manifest.json FIRST, records.ndjson second (fix-wave F5) — no other
    // gating changes; cls-label's "succeeds without manifest" test still
    // passes because labels gate on records.ndjson, never on manifest.json.
    const manifest: ClsManifest = {
      sampledAt: new Date().toISOString(),
      hostname: os.hostname(),
      cCount: c.length,
      notCCount: drawn.length,
      keys: { c: c.map(recordKey), notC: drawn.map(recordKey) },
      transportCounts: { c: transportTally(c), notC: transportTally(drawn) },
    }
    atomicWrite(path.join(root, CLS_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")

    const sampleRecords: ClsSampleRecord[] = sampled.map((r) => ({
      key: recordKey(r),
      prompt: r.prompt,
      floorCheck: r.floorCheck,
    }))
    const recordsBody =
      sampleRecords.map((r) => JSON.stringify(r)).join("\n") + (sampleRecords.length ? "\n" : "")
    atomicWrite(path.join(root, CLS_RECORDS_NAME), recordsBody)

    log(
      `cls-sample: ${c.length} nominal-C + ${drawn.length} nominal-not-C derived record(s) -> ` +
        `${CLS_AB_DIR_REL} (${sampled.length} total)`,
    )
    return { cCount: c.length, notCCount: drawn.length, total: sampled.length }
  } finally {
    releaseClsAbLock(cwd)
  }
}

// ── Task 2: `cls-run` (arm classification) + `cls-label` (blind labels) ──
//
// Both spend subcommands share this file's `.km/gauge-cls-ab/` root and the
// SAME `acquireClsAbLock`/`releaseClsAbLock` T1 exports (module doc above) —
// a mutating phase in either one holds the one lock the whole time, so
// cls-sample --reset, cls-run <arm>, and cls-label can never interleave.
//
// Both read ONLY `records.ndjson` (key/prompt/floorCheck — T1) for their
// input population. Neither ever opens `manifest.json` (which carries the
// stored nominal class per stratum) or the OTHER kind of output file
// (`cls-run` never opens `labels.ndjson`; `cls-label` never opens any
// `arm-<name>.ndjson`) — this is the pre-registration's §5 blind-isolation
// protocol enforced BY CONSTRUCTION (no code path here can even name those
// files for a read), not by a manual check, and pinned by a test that
// plants poisoned arm files + a poisoned manifest and asserts cls-label's
// output and the arm files themselves are both untouched.
//
// Idempotent top-up: "pending" for either subcommand is simply every
// records.ndjson key NOT already present in the (arm|labels) output file —
// a record that failed transport last run has no row yet and is
// automatically re-attempted on the next `--go`, no separate retry
// bookkeeping needed. Fail-open per record (plan Task 2): a transport
// failure or an unparseable response is counted in `failed` and produces NO
// row — never a fabricated class/label, never a crashed batch.
//
// Cost fence + lock re-check mechanics mirror corpus-replay.ts's
// `runDerive`/`checkFenceUnderLock` precedent: `go` is checked once fast
// (pre-lock, cheap fail without touching the lock), then the pending set is
// RE-READ and RE-CHECKED under the lock immediately before any model call,
// via the ONE shared `checkClsFenceUnderLock` helper below (used by both
// `runClsRun` and `runClsLabel` — not two independently-driftable inlined
// copies) — closing the window where a concurrent cls-run/cls-label/
// cls-sample lands between the first read and lock acquisition.

export const CLS_ARM_MODELS = ["haiku", "sonnet"] as const
export type ClsArmModel = (typeof CLS_ARM_MODELS)[number]

export const CLS_PROMPT_VARIANTS = ["base", "patched"] as const

/** Model literals are experiment pins (pre-reg §2.3) — exactly these two API
 * ids, never the CLI-era "haiku" alias, recorded verbatim on every row. */
export const CLS_ARM_MODEL_LITERALS: Record<ClsArmModel, string> = {
  haiku: "claude-haiku-4-5",
  sonnet: "claude-sonnet-5",
}

/** Labeler model literal (pre-reg §2.3) — the labeler is NEVER routed
 * through `KKAMAK_GAUGE_MODEL` (transport.ts's `callModelSdkLabel` doc). */
export const CLS_LABEL_MODEL_LITERAL = "claude-opus-5"

const ARM_NAME_RE = /^(haiku|sonnet)-(base|patched)$/

/** `<model>-<variant>` -> its two parts, or undefined for anything else
 * (typo, wrong case, extra dash). The ONLY four valid arm names are
 * `haiku-base`, `haiku-patched`, `sonnet-base`, `sonnet-patched`. */
export function parseClsArmName(
  arm: string,
): { model: ClsArmModel; variant: PromptVariant } | undefined {
  const m = ARM_NAME_RE.exec(arm)
  if (!m) return undefined
  return { model: m[1] as ClsArmModel, variant: m[2] as PromptVariant }
}

/** `arm-<name>.ndjson` — the file name a given arm's results live in. */
export function clsArmFileName(arm: string): string {
  return `arm-${arm}.ndjson`
}

export const CLS_LABELS_NAME = "labels.ndjson"

/** One row of `arm-<name>.ndjson` — NO prompt text (F2), same discipline as
 * `ClsManifest`. `class` is the arm's raw classification (A1/A2/B/C/D, not
 * yet reduced to C-vs-not-C — Task 3's scorer does that reduction against
 * the blind labels). */
export interface ClsArmRow {
  key: string
  class: GaugePromptClass
  model: string
  promptVariant: PromptVariant
  transport: "sdk"
  /** sha256 of the EXACT built prompt text sent (`buildRefinerPrompt`'s
   * output) — fix-wave F8 provenance. Hash only, never the prompt text
   * itself (F2). Lets `cls-score` detect a row whose prompt text drifted
   * from what the rest of the arm (or the arm's expected variant) sent. */
  promptSha256: string
  ts: string
}

/** One row of `labels.ndjson` — NO prompt text (F2). `label` is the
 * pre-registered C-vs-not-C ground truth; `class` (optional context, may be
 * null) is the labeler's finer-grained guess, never authoritative on its
 * own (pre-reg §2.2: "Label = C / not-C, with an optional class letter"). */
export interface ClsLabelRow {
  key: string
  label: ClsLabel
  class: GaugePromptClass | null
  model: string
  /** sha256 of the EXACT built prompt text sent (`buildLabelPrompt`'s
   * output) — fix-wave F8 provenance, same discipline as `ClsArmRow`. */
  promptSha256: string
  ts: string
}

/** Missing/unreadable file -> []. Malformed lines are skipped silently
 * (corpus-store.ts's `readCorpus` precedent) — a torn write from a killed
 * writer must not take down every later reader. */
function readNdjson<T>(filePath: string): T[] {
  let raw: string
  try {
    raw = fs.readFileSync(filePath, "utf-8")
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
      // malformed line — skip silently, keep reading the rest of the file
    }
  }
  return out
}

function writeNdjsonAtomic(filePath: string, rows: unknown[]): void {
  const body = rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length ? "\n" : "")
  atomicWrite(filePath, body)
}

/** Sampled records this experiment has to work with — `cls-run`/`cls-label`
 * refuse ("no sample exists") whenever this file is absent, i.e. before
 * `cls-sample` has ever run. Reading it never touches `manifest.json`. */
function readSampledRecords(cwd: string): ClsSampleRecord[] {
  return readNdjson<ClsSampleRecord>(path.join(clsAbRoot(cwd), CLS_RECORDS_NAME))
}

/** Re-read `outputPath` (the arm's `arm-<name>.ndjson` or `labels.ndjson`)
 * and re-check the `go` fence against a FRESH pending count. Meant to be
 * called AFTER the lock is held — corpus-replay.ts's
 * `checkFenceUnderLock` precedent, extracted here (review finding, fix
 * wave) so BOTH `runClsRun` and `runClsLabel` share ONE re-check
 * implementation instead of two inlined, independently-driftable copies: a
 * regression that silently reused the pre-lock `pending` array instead of
 * re-reading fresh under the lock would previously have passed the suite
 * with zero coverage. Closes the window where a concurrent
 * cls-run/cls-label/cls-sample writer lands between the caller's first
 * (pre-lock) read and lock acquisition — the fresh read happens INSIDE this
 * function, never passed in, so there is no way to call it with a stale
 * `done` set by mistake. Generic over the row shape (`ClsArmRow` for
 * cls-run, `ClsLabelRow` for cls-label) since both only need `key`. */
export function checkClsFenceUnderLock<T extends { key: string }>(
  records: ClsSampleRecord[],
  outputPath: string,
  go: number,
  subcommand: string,
  log: (m: string) => void,
): ClsSampleRecord[] | undefined {
  const done = new Set(readNdjson<T>(outputPath).map((r) => r.key))
  const pending = records.filter((r) => !done.has(r.key))
  if (pending.length !== go) {
    log(
      `REFUSING: ${subcommand} — pending count changed under lock (now ${pending.length}, expected ` +
        `${go}); a concurrent run landed. Re-run with --go ${pending.length}.`,
    )
    return undefined
  }
  return pending
}

export interface ClsRunSummary {
  arm: string
  pending: number
  classified: number
  failed: number
}

/** `cls-run --arm <haiku|sonnet>-<base|patched> --go n` (Task 2). See the
 * section doc above for the shared mechanics (idempotent top-up, fail-open,
 * lock/fence discipline). Sequential per record — corpus-replay.ts's
 * `runDerive` precedent, a batch is a deliberately sized, deliberately
 * paced spend, never parallelized. */
export async function runClsRun(
  cwd: string,
  arm: string,
  go: number | undefined,
  log: (m: string) => void,
): Promise<ClsRunSummary | undefined> {
  const parsed = parseClsArmName(arm)
  if (!parsed) {
    log(
      `REFUSING: cls-run — unknown arm "${arm}"; expected one of ` +
        "haiku-base, haiku-patched, sonnet-base, sonnet-patched.",
    )
    return undefined
  }
  const { model, variant } = parsed
  const modelLiteral = CLS_ARM_MODEL_LITERALS[model]

  const root = clsAbRoot(cwd)
  const recordsPath = path.join(root, CLS_RECORDS_NAME)
  if (!fs.existsSync(recordsPath)) {
    log(`REFUSING: cls-run — no sample exists (${CLS_AB_DIR_REL}); run cls-sample first.`)
    return undefined
  }
  const armPath = path.join(root, clsArmFileName(arm))

  const records = readSampledRecords(cwd)
  const alreadyDone = new Set(readNdjson<ClsArmRow>(armPath).map((r) => r.key))
  const pendingPreLock = records.filter((r) => !alreadyDone.has(r.key))

  if (go === undefined) {
    log(
      `REFUSING: cls-run — no --go given; ${pendingPreLock.length} pending record(s) for arm ` +
        `${arm}. Re-run with --go ${pendingPreLock.length}.`,
    )
    return undefined
  }
  if (go !== pendingPreLock.length) {
    log(
      `REFUSING: cls-run — --go ${go} does not match the current pending count ` +
        `${pendingPreLock.length} for arm ${arm}. Re-run with --go ${pendingPreLock.length}.`,
    )
    return undefined
  }

  if (!acquireClsAbLock(cwd)) {
    log(
      `REFUSING: cls-run — lock held (${CLS_AB_LOCK_REL}) — another cls-sample/cls-run/cls-label ` +
        "appears to be in flight against this experiment dir.",
    )
    return undefined
  }

  try {
    const pending = checkClsFenceUnderLock<ClsArmRow>(records, armPath, go, "cls-run", log)
    if (!pending) return undefined

    const newRows: ClsArmRow[] = []
    let failed = 0
    for (const record of pending) {
      // Exact prompt text this record is about to send, hashed for
      // provenance ONLY (fix-wave F8) — the real, unmodified
      // buildRefinerPrompt, never a re-implementation.
      const promptSha256 = sha256Hex(buildRefinerPrompt(record.prompt, record.floorCheck, variant))
      // §6d "route batch callers only after the deriver's bar result is
      // known": cls-run stamps every row `transport: "sdk"` (ClsArmRow.class
      // above) unconditionally, so the call it makes must ALSO be pinned to
      // "sdk" regardless of the ambient env — refiner-cli.ts:54's liveEnv
      // strip, same rationale, same shape.
      const liveEnv: Record<string, string | undefined> = { ...process.env, KKAMAK_GAUGE_TRANSPORT: undefined }
      const raw = await callModelSdk(record.prompt, record.floorCheck, liveEnv, {}, {
        model: modelLiteral,
        promptVariant: variant,
      })
      // Staleness guard (fix-wave F4): refresh the held lock's ts after
      // every record, success or failure, so a batch longer than
      // CLS_AB_LOCK_STALE_MS is never mistaken for stale mid-flight.
      refreshClsAbLock(cwd)
      const derivation = raw !== undefined ? parseRefinerOutput(raw) : undefined
      if (!derivation) {
        failed++
        continue
      }
      newRows.push({
        key: record.key,
        class: derivation.class,
        model: modelLiteral,
        promptVariant: variant,
        transport: "sdk",
        promptSha256,
        ts: new Date().toISOString(),
      })
    }

    const merged = [...readNdjson<ClsArmRow>(armPath), ...newRows]
    writeNdjsonAtomic(armPath, merged)

    const summary: ClsRunSummary = { arm, pending: pending.length, classified: newRows.length, failed }
    log(
      `cls-run ${arm}: ${summary.classified}/${summary.pending} classified, ${failed} failed-this-run ` +
        `(retryable); ${clsArmFileName(arm)} now ${merged.length} record(s)`,
    )
    return summary
  } finally {
    releaseClsAbLock(cwd)
  }
}

export interface ClsLabelSummary {
  pending: number
  labeled: number
  failed: number
}

/** `cls-label --go n` (Task 2). BLIND ISOLATION (hard, pinned by test): this
 * function's only file reads are `records.ndjson` (key/prompt/floorCheck)
 * and its OWN output file `labels.ndjson` — it never opens
 * `manifest.json` or any `arm-<name>.ndjson`, structurally, not by
 * convention (see the section doc above). */
export async function runClsLabel(
  cwd: string,
  go: number | undefined,
  log: (m: string) => void,
): Promise<ClsLabelSummary | undefined> {
  const root = clsAbRoot(cwd)
  const recordsPath = path.join(root, CLS_RECORDS_NAME)
  if (!fs.existsSync(recordsPath)) {
    log(`REFUSING: cls-label — no sample exists (${CLS_AB_DIR_REL}); run cls-sample first.`)
    return undefined
  }
  const labelsPath = path.join(root, CLS_LABELS_NAME)

  const records = readSampledRecords(cwd)
  const alreadyDone = new Set(readNdjson<ClsLabelRow>(labelsPath).map((r) => r.key))
  const pendingPreLock = records.filter((r) => !alreadyDone.has(r.key))

  if (go === undefined) {
    log(
      `REFUSING: cls-label — no --go given; ${pendingPreLock.length} pending record(s). ` +
        `Re-run with --go ${pendingPreLock.length}.`,
    )
    return undefined
  }
  if (go !== pendingPreLock.length) {
    log(
      `REFUSING: cls-label — --go ${go} does not match the current pending count ` +
        `${pendingPreLock.length}. Re-run with --go ${pendingPreLock.length}.`,
    )
    return undefined
  }

  if (!acquireClsAbLock(cwd)) {
    log(
      `REFUSING: cls-label — lock held (${CLS_AB_LOCK_REL}) — another cls-sample/cls-run/cls-label ` +
        "appears to be in flight against this experiment dir.",
    )
    return undefined
  }

  try {
    const pending = checkClsFenceUnderLock<ClsLabelRow>(records, labelsPath, go, "cls-label", log)
    if (!pending) return undefined

    const newRows: ClsLabelRow[] = []
    let failed = 0
    for (const record of pending) {
      // Exact prompt text this record is about to send, hashed for
      // provenance ONLY (fix-wave F8) — the real, unmodified
      // buildLabelPrompt, never a re-implementation.
      const promptSha256 = sha256Hex(buildLabelPrompt(record.prompt, record.floorCheck))
      const raw = await callModelSdkLabel(record.prompt, record.floorCheck, process.env, {}, {
        model: CLS_LABEL_MODEL_LITERAL,
      })
      // Staleness guard (fix-wave F4) — see runClsRun's identical comment.
      refreshClsAbLock(cwd)
      const parsed = raw !== undefined ? parseLabelOutput(raw) : undefined
      if (!parsed) {
        failed++
        continue
      }
      newRows.push({
        key: record.key,
        label: parsed.label,
        class: parsed.class,
        model: CLS_LABEL_MODEL_LITERAL,
        promptSha256,
        ts: new Date().toISOString(),
      })
    }

    const merged = [...readNdjson<ClsLabelRow>(labelsPath), ...newRows]
    writeNdjsonAtomic(labelsPath, merged)

    const summary: ClsLabelSummary = { pending: pending.length, labeled: newRows.length, failed }
    log(
      `cls-label: ${summary.labeled}/${summary.pending} labeled, ${failed} failed-this-run ` +
        `(retryable); ${CLS_LABELS_NAME} now ${merged.length} record(s)`,
    )
    return summary
  } finally {
    releaseClsAbLock(cwd)
  }
}

/** `cls-run [cwd] --arm <name> --go <n>` arg parsing — pv-sample/derive's
 * precedent (extract flags, everything else positional). `unknownFlag`
 * (fix-wave F17) is the first unrecognized `--`-prefixed token, never
 * pushed into `positional` — see `parseClsSampleArgs`'s doc for why. */
export function parseClsRunArgs(
  args: string[],
): { cwd: string; arm: string | undefined; go: number | undefined; unknownFlag: string | undefined } {
  let arm: string | undefined
  let go: number | undefined
  let unknownFlag: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--arm") {
      arm = args[i + 1]
      i++
    } else if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else if (args[i]!.startsWith("--")) {
      unknownFlag ??= args[i]
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), arm, go, unknownFlag }
}

/** `cls-label [cwd] --go <n>` arg parsing. `unknownFlag` — fix-wave F17,
 * see `parseClsRunArgs`'s doc. */
export function parseClsLabelArgs(
  args: string[],
): { cwd: string; go: number | undefined; unknownFlag: string | undefined } {
  let go: number | undefined
  let unknownFlag: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else if (args[i]!.startsWith("--")) {
      unknownFlag ??= args[i]
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), go, unknownFlag }
}

// ── Task 3: `cls-score` — metrics + pre-registered decision rule ─────────
//
// `cls-score` READS every input it touches — `manifest.json` (JSON.parse),
// `labels.ndjson`, every present `arm-<name>.ndjson`, and (on `--combine`) the
// other host's counts file — via `readNdjson`/`fs.readFileSync` only, and all
// of that stays LOCK-FREE (a pure read cannot contend with a concurrent
// cls-run/cls-label writer, report-subcommand precedent, same as pv-compare
// in paired-validation.ts). CORRECTED (fix-wave F12 — the previous doc here
// claimed the whole subcommand was "READ-ONLY ... acquireClsAbLock is
// neither called nor needed", which stopped being true once cls-score
// started WRITING `cls-score.json`/`cls-combined.json`/`--emit-doc`): the
// mkdir+write phase alone is guarded by the SAME shared `.km/gauge-cls-ab.lock`
// cls-sample/cls-run/cls-label use, acquired only around that phase (after
// every read and every pure computation) and released in a `finally` — so a
// score write can never land torn against an in-flight cls-run/cls-label
// batch, while every read stays as lock-free as before.
//
// Decision-rule constants (pre-reg spec §3) live in ONE exported object,
// `CLS_DECISION_CONSTANTS` below — the single source every decision path
// reads from; no number here is ever re-typed inline. Its tie-break order
// reuses this file's OWN `CLS_ARM_MODELS`/`CLS_PROMPT_VARIANTS` arrays
// (already declared cheapest-model/base-prompt-first), so the tie-break
// order and the valid-arm-name order can never drift apart.

export const CLS_SCORE_NAME = "cls-score.json"

/** Pre-registered decision-rule constants (spec §3) — copied verbatim:
 * incumbent = haiku+base, F1 margin = 0.10 raw points, tie-break = cheaper
 * model then base prompt. */
export const CLS_DECISION_CONSTANTS = {
  /** haiku + base prompt — the production default today (spec §3). */
  incumbentArm: "haiku-base",
  /** raw F1-point margin the winner must clear over the incumbent (spec §3
   * point (a)) — NOT a relative lift, NOT a significance test. */
  f1Margin: 0.1,
  /** tie-break order (spec §3): cheaper model first, then base prompt. */
  tieBreak: {
    modelOrder: CLS_ARM_MODELS,
    variantOrder: CLS_PROMPT_VARIANTS,
  },
} as const

/** Round to 3 decimals — IEEE-double-safe (fix-wave F1, pre-data fix
 * 2026-08-03). `0.9 - 0.8` is `0.09999999999999998` in raw doubles, which
 * fails an exactly-at-the-registered-bar `>= 0.1` comparison even though the
 * pre-registered margin (spec §3) is meant to read as exactly met. The ONE
 * helper every margin comparison AND every printed arithmetic line reads
 * through, so the gate decision and the report text can never disagree. */
export function roundTo3(n: number): number {
  return Math.round(n * 1000) / 1000
}

export type ClsMetricValue = number | "n/a"

export interface ClsArmMetrics {
  arm: string
  totalKeys: number
  presentKeys: number
  missingKeys: number
  complete: boolean
  tp: number
  /** false-C: predicted C, labeled not-C */
  fp: number
  /** missed-C: predicted not-C, labeled C */
  fn: number
  tn: number
  precision: ClsMetricValue
  recall: ClsMetricValue
  f1: ClsMetricValue
}

/** All four valid arm names, in the constants' cheapest-model/base-prompt-
 * first order (haiku-base, haiku-patched, sonnet-base, sonnet-patched) —
 * the ONE order every report/table below iterates in. */
export const CLS_ALL_ARM_NAMES: readonly string[] = CLS_ARM_MODELS.flatMap((model) =>
  CLS_PROMPT_VARIANTS.map((variant) => `${model}-${variant}`),
)

/** Arm names with an `arm-<name>.ndjson` file actually present on disk —
 * "ALL present arm files" (plan Task 3). An arm that has never been run at
 * all is simply absent from this list (not part of this scoring run),
 * distinct from an arm that has been run but is missing some records
 * (INCOMPLETE — see `computeArmMetrics`). */
export function listPresentArmNames(cwd: string): string[] {
  const root = clsAbRoot(cwd)
  return CLS_ALL_ARM_NAMES.filter((name) => fs.existsSync(path.join(root, clsArmFileName(name))))
}

/** Precision/recall/F1 from raw tp/fp/fn counts — pulled out of
 * `computeArmMetrics` (fix-wave F3) so the `--combine` path can recompute
 * metrics from SUMMED cross-host counts using the exact same formula, never
 * a re-derived one.
 *
 * F1 rule corrected (fix-wave F2, pre-data fix 2026-08-03): `f1 = (tp+fp+fn
 * === 0) ? "n/a" : 2*tp/(2*tp+fp+fn)` — computed directly from the counts,
 * NOT from precision/recall. The old rule (`f1 = "n/a"` whenever precision
 * OR recall was `"n/a"`, or whenever both were defined-zero) wrongly
 * reported `"n/a"` for e.g. tp=0,fp>0,fn>0 (precision=0, recall=0, but F1 is
 * a perfectly defined 0) — which made an otherwise-evaluable incumbent read
 * as NOT-EVALUABLE. P/R "n/a" semantics are UNCHANGED (still `tp+fp===0`
 * and `tp+fn===0` respectively) — only F1's formula was wrong. */
function metricsFromCounts(
  tp: number,
  fp: number,
  fn: number,
): { precision: ClsMetricValue; recall: ClsMetricValue; f1: ClsMetricValue } {
  const precision: ClsMetricValue = tp + fp === 0 ? "n/a" : tp / (tp + fp)
  const recall: ClsMetricValue = tp + fn === 0 ? "n/a" : tp / (tp + fn)
  const f1: ClsMetricValue = tp + fp + fn === 0 ? "n/a" : (2 * tp) / (2 * tp + fp + fn)
  return { precision, recall, f1 }
}

/** Metrics for one arm against the labels, restricted to the manifest's
 * sampled keys. `complete` iff every manifest key has a row in `armRows` —
 * an arm missing even one key is INCOMPLETE (plan Task 3): its
 * TP/FP/FN/TN/precision/recall/F1 all come out zero/"n/a" (the loop below
 * is skipped entirely) and it is excluded from winner selection
 * (`pickWinner`), but `missingKeys` is always reported explicitly, never
 * silently dropped. Zero-division edges (plan step 3, corrected fix-wave F2
 * — see `metricsFromCounts`'s doc): no C predicted -> precision "n/a"; no C
 * in labels -> recall "n/a"; F1 "n/a" ONLY when tp+fp+fn===0 — the earlier
 * "F1 n/a whenever P or R is n/a, or both are defined-zero" rule undercounted
 * evaluable arms. `tp+fp===0`/`tp+fn===0`/`tp+fp+fn===0` already cover the
 * incomplete case too (the skipped loop leaves every count at 0), so no
 * separate `complete` branch is needed in the metric formulas. */
export function computeArmMetrics(
  arm: string,
  manifestKeys: string[],
  armRows: ClsArmRow[],
  labelPositiveByKey: Map<string, boolean>,
): ClsArmMetrics {
  const armPositiveByKey = new Map(armRows.map((r) => [r.key, r.class === "C"] as const))
  const presentKeys = manifestKeys.filter((k) => armPositiveByKey.has(k)).length
  const missingKeys = manifestKeys.length - presentKeys
  const complete = missingKeys === 0

  let tp = 0
  let fp = 0
  let fn = 0
  let tn = 0
  if (complete) {
    for (const k of manifestKeys) {
      const predC = armPositiveByKey.get(k)!
      const actualC = labelPositiveByKey.get(k)!
      if (predC && actualC) tp++
      else if (predC && !actualC) fp++
      else if (!predC && actualC) fn++
      else tn++
    }
  }

  const { precision, recall, f1 } = metricsFromCounts(tp, fp, fn)

  return {
    arm,
    totalKeys: manifestKeys.length,
    presentKeys,
    missingKeys,
    complete,
    tp,
    fp,
    fn,
    tn,
    precision,
    recall,
    f1,
  }
}

/** Tie-break rank per spec §3: cheaper model first (haiku < sonnet), then
 * base prompt (base < patched) — lower rank wins a tie. Reads its ordering
 * from `CLS_DECISION_CONSTANTS.tieBreak`, never a re-typed literal. */
function armTieBreakRank(arm: string): number {
  const parsed = parseClsArmName(arm)!
  const { modelOrder, variantOrder } = CLS_DECISION_CONSTANTS.tieBreak
  const modelRank = modelOrder.indexOf(parsed.model)
  const variantRank = variantOrder.indexOf(parsed.variant)
  return modelRank * variantOrder.length + variantRank
}

/** argmax(F1) over complete arms with a DEFINED F1 (spec §3 — "arms with
 * n/a F1 excluded from winning"), tie-broken by `armTieBreakRank`.
 * undefined iff no complete arm has a defined F1 at all. */
export function pickWinner(metrics: ClsArmMetrics[]): { arm: string; f1: number } | undefined {
  let best: { arm: string; f1: number } | undefined
  for (const m of metrics) {
    if (!m.complete || m.f1 === "n/a") continue
    if (
      best === undefined ||
      m.f1 > best.f1 ||
      (m.f1 === best.f1 && armTieBreakRank(m.arm) < armTieBreakRank(best.arm))
    ) {
      best = { arm: m.arm, f1: m.f1 }
    }
  }
  return best
}

export interface ClsDecisionResult {
  verdict: "ADOPT" | "INCUMBENT-STAYS" | "NOT-EVALUABLE"
  incumbentArm: string
  winnerArm: string | null
  f1Winner: ClsMetricValue | null
  f1Incumbent: ClsMetricValue | null
  marginAchieved: number | null
  missedCWinner: number | null
  missedCIncumbent: number | null
  reason: string
}

/** `ClsDecisionResult` stamped with WHICH counts it was evaluated over
 * (fix-wave F3) — `"per-host"` for a single host's own local sample,
 * `"combined"` for the cross-host summed sample (`cls-combined.json`; §6:
 * "the decision rule ... is evaluated on combined counts across hosts" is
 * the REGISTERED verdict). `evaluateClsDecision` itself stays scope-unaware
 * (pure over whatever metrics it is handed); the caller (`runClsScore`)
 * stamps the scope onto the result before it lands in an emitted doc. */
export type ClsScopedDecisionResult = ClsDecisionResult & { scope: "per-host" | "combined" }

/** The pre-registered decision rule (spec §3), evaluated against
 * `CLS_DECISION_CONSTANTS` — the ONE exported constants object, never a
 * re-derived number. If the incumbent arm is missing, incomplete, or has
 * an undefined F1, there is no baseline to compare against -> verdict
 * NOT-EVALUABLE (no adoption decision without it). Otherwise the winner is
 * `pickWinner`'s argmax(F1) (which always includes the incumbent itself as
 * a candidate, so it never comes back undefined here); if the winner IS
 * the incumbent, or fails either adoption clause, the incumbent stays. */
export function evaluateClsDecision(metrics: ClsArmMetrics[]): ClsDecisionResult {
  const { incumbentArm, f1Margin } = CLS_DECISION_CONSTANTS
  const incumbent = metrics.find((m) => m.arm === incumbentArm)

  if (incumbent === undefined || !incumbent.complete) {
    return {
      verdict: "NOT-EVALUABLE",
      incumbentArm,
      winnerArm: null,
      f1Winner: null,
      f1Incumbent: null,
      marginAchieved: null,
      missedCWinner: null,
      missedCIncumbent: null,
      reason:
        `incumbent arm "${incumbentArm}" is missing or incomplete — no adoption decision without ` +
        "the incumbent baseline",
    }
  }
  if (incumbent.f1 === "n/a") {
    return {
      verdict: "NOT-EVALUABLE",
      incumbentArm,
      winnerArm: null,
      f1Winner: null,
      f1Incumbent: "n/a",
      marginAchieved: null,
      missedCWinner: null,
      missedCIncumbent: incumbent.fn,
      reason:
        `incumbent arm "${incumbentArm}" has an undefined F1 (zero-division edge) — no adoption ` +
        "decision without a defined baseline",
    }
  }

  const winner = pickWinner(metrics)! // incumbent itself always qualifies -> never undefined here
  const winnerMetrics = metrics.find((m) => m.arm === winner.arm)!
  // Rounded to 3dp (fix-wave F1, pre-data fix 2026-08-03) — see roundTo3's
  // doc. The SAME rounded value is stored in marginAchieved and rendered in
  // renderDecisionLines's arithmetic line, so the gate decision and the
  // printed report can never disagree.
  const margin = roundTo3(winner.f1 - incumbent.f1)
  const missedCOk = winnerMetrics.fn <= incumbent.fn

  if (winner.arm !== incumbentArm && margin >= f1Margin && missedCOk) {
    return {
      verdict: "ADOPT",
      incumbentArm,
      winnerArm: winner.arm,
      f1Winner: winner.f1,
      f1Incumbent: incumbent.f1,
      marginAchieved: margin,
      missedCWinner: winnerMetrics.fn,
      missedCIncumbent: incumbent.fn,
      reason:
        `${winner.arm} clears the margin (${margin.toFixed(3)} >= ${f1Margin}) and is missed-C ` +
        `not-worse (${winnerMetrics.fn} <= ${incumbent.fn})`,
    }
  }

  const reason =
    winner.arm === incumbentArm
      ? "the incumbent is itself the argmax(F1) arm"
      : margin < f1Margin
        ? `margin ${margin.toFixed(3)} < required ${f1Margin}`
        : `missed-C ${winnerMetrics.fn} > incumbent missed-C ${incumbent.fn} (not-worse condition fails)`

  return {
    verdict: "INCUMBENT-STAYS",
    incumbentArm,
    winnerArm: winner.arm,
    f1Winner: winner.f1,
    f1Incumbent: incumbent.f1,
    marginAchieved: margin,
    missedCWinner: winnerMetrics.fn,
    missedCIncumbent: incumbent.fn,
    reason,
  }
}

export interface ClsScoreArmEntry {
  arm: string
  totalKeys: number
  presentKeys: number
  missingKeys: number
  complete: boolean
  counts: { tp: number; fp: number; fn: number; tn: number }
  metrics: { precision: ClsMetricValue; recall: ClsMetricValue; f1: ClsMetricValue }
  /** fix-wave F8 — true iff this arm's rows do not all share ONE
   * `promptSha256` (i.e. at least one row was built from different prompt
   * text than the others). Warned on stdout too; see `runClsScore`. */
  mixedPrompt: boolean
  /** fix-wave F9 — count of this arm's rows whose `model`/`promptVariant`
   * does not match the arm filename's expected literals (e.g. a
   * `sonnet-patched.ndjson` row recorded `model: "claude-haiku-4-5"`). Any
   * mismatch marks the whole run provisional (see `ClsScoreFile` doc). */
  mismatchedRows: number
}

/** `cls-score.json` / `--emit-doc` target — counts/metrics/verdict/
 * hostname/scoredAt ONLY, never prompt text (F2: neither `ClsArmRow` nor
 * `ClsLabelRow` carries prompt text in the first place, so there is
 * nothing here that could leak it).
 *
 * `expectedArms`/`absentArms`/`provisional` (review fix-wave finding,
 * IMPORTANT): a never-run arm is silently absent from `arms` — without
 * these fields, a `cls-score` run before all 4 registered arms exist would
 * produce an unflagged ADOPT/INCUMBENT-STAYS verdict computed over FEWER
 * than the registered 4 arms. `expectedArms` is always the full registered
 * set (`CLS_ALL_ARM_NAMES`); `absentArms` is the subset with no
 * `arm-<name>.ndjson` file at all; `provisional` is true whenever ANY
 * registered arm is absent OR present-but-incomplete — i.e. whenever
 * `decision` was NOT computed over all 4 registered arms fully derived.
 * `provisional: false` iff all 4 are present AND complete. */
export interface ClsScoreFile {
  scoredAt: string
  hostname: string
  sample: {
    cCount: number
    notCCount: number
    total: number
    /** fix-wave F10 — per-stratum transport tally, carried straight from
     * `ClsManifest.transportCounts` (never re-derived here). */
    transportCounts: { c: ClsTransportTally; notC: ClsTransportTally }
    /** fix-wave F11 — this sample's manifest `sampledAt`, carried alongside
     * the score's own `scoredAt` so a reader can tell WHEN the sample this
     * score was computed over was actually drawn. */
    manifestSampledAt: string
    /** fix-wave F11 — sha256 over the SORTED full manifest key set
     * (`manifestKeysHash`, exported below) — a durable sample-identity
     * fingerprint two different `cls-score.json`/emitted docs can be
     * compared by without re-reading either host's `manifest.json`. */
    manifestKeysHash: string
  }
  expectedArms: string[]
  absentArms: string[]
  provisional: boolean
  arms: ClsScoreArmEntry[]
  decision: ClsScopedDecisionResult
}

function fmtMetric(v: ClsMetricValue): string {
  return v === "n/a" ? "n/a" : v.toFixed(3)
}

function renderArmRow(m: ClsArmMetrics): string {
  const status = m.complete ? "complete" : `INCOMPLETE (missing ${m.missingKeys}/${m.totalKeys})`
  return (
    `  ${m.arm.padEnd(16)} ${status.padEnd(28)} ` +
    `TP ${m.tp} FP(false-C) ${m.fp} FN(missed-C) ${m.fn} TN ${m.tn}  ` +
    `P ${fmtMetric(m.precision)} R ${fmtMetric(m.recall)} F1 ${fmtMetric(m.f1)}`
  )
}

/** Tie-break prose, DERIVED from `CLS_DECISION_CONSTANTS.tieBreak` (fix-wave
 * F16) — never a hardcoded restatement that could silently drift from the
 * constants' actual ordering if they are ever re-ruled pre-data. */
function tieBreakProse(): string {
  const { modelOrder, variantOrder } = CLS_DECISION_CONSTANTS.tieBreak
  return `cheaper model first (${modelOrder.join(" < ")}), then earlier prompt variant (${variantOrder.join(" < ")})`
}

function renderDecisionLines(d: ClsDecisionResult): string[] {
  const lines = [`decision (pre-registered, spec §3 — incumbent ${d.incumbentArm}):`]
  if (d.verdict === "NOT-EVALUABLE") {
    lines.push(`  ${d.reason}`, "verdict: NOT-EVALUABLE")
    return lines
  }
  const marginOk = d.marginAchieved! >= CLS_DECISION_CONSTANTS.f1Margin
  const missedOk = d.missedCWinner! <= d.missedCIncumbent!
  lines.push(
    `  winner (argmax F1, tie-break ${tieBreakProse()}): ${d.winnerArm}`,
    `  F1_winner ${fmtMetric(d.f1Winner!)} - F1_incumbent ${fmtMetric(d.f1Incumbent!)} = ` +
      `${d.marginAchieved!.toFixed(3)} >= ${CLS_DECISION_CONSTANTS.f1Margin}? ${marginOk ? "YES" : "NO"}`,
    `  missed-C_winner ${d.missedCWinner} <= missed-C_incumbent ${d.missedCIncumbent}? ${missedOk ? "YES" : "NO"}`,
    `  ${d.reason}`,
    `verdict: ${d.verdict}${d.verdict === "ADOPT" ? ` <${d.winnerArm}>` : ""}`,
  )
  return lines
}

/** Human report for one score run. Exported for tests. `presence` carries
 * the fix-wave's arm-presence accounting (module doc above) — the "arms
 * present N/4; absent: ..." line is ALWAYS shown (even when nothing is
 * absent), and a PROVISIONAL warning is appended whenever `provisional`. */
export function renderClsScoreReport(
  sample: { cCount: number; notCCount: number },
  metrics: ClsArmMetrics[],
  decision: ClsDecisionResult,
  presence: { expectedArms: string[]; absentArms: string[]; provisional: boolean },
): string {
  const presentCount = presence.expectedArms.length - presence.absentArms.length
  const lines = [
    "cls-score — gauge classifier 2×2 A/B (spec 2026-08-03-gauge-classifier-ab-preregistration.md §3)",
    `sample: ${sample.cCount} C + ${sample.notCCount} not-C`,
    `arms present ${presentCount}/${presence.expectedArms.length}; absent: ` +
      `${presence.absentArms.length ? presence.absentArms.join(", ") : "none"}`,
    "",
    "per-arm metrics vs blind opus labels:",
    ...metrics.map(renderArmRow),
    "",
    ...renderDecisionLines(decision),
  ]
  if (presence.provisional) {
    lines.push(
      "",
      "WARNING: PROVISIONAL — not all 4 registered arms are present AND complete; this verdict is NOT " +
        "the registered 4-arm decision (spec §3 evaluates all four arms). Re-run cls-score once every " +
        "arm has been derived to completion.",
    )
  }
  return lines.join("\n")
}

/** sha256 over the SORTED full manifest key set (fix-wave F11) — a durable
 * sample-identity fingerprint: two runs over the SAME sample (same keys,
 * any order) hash identically; two DIFFERENT samples hash differently. */
export function manifestKeysHash(keys: string[]): string {
  return sha256Hex(JSON.stringify([...keys].sort()))
}

/** Distinct `promptSha256` values among a set of rows, ignoring rows with no
 * hash at all (fix-wave F8 — tolerates pre-F8 fixtures/rows). */
function distinctPromptHashes(rows: { promptSha256?: string }[]): Set<string> {
  return new Set(rows.map((r) => r.promptSha256).filter((h): h is string => typeof h === "string"))
}

/** Count of `armRows` whose `model`/`promptVariant` does not match the arm
 * FILENAME's expected literals (fix-wave F9) — e.g. a row landed in
 * `arm-sonnet-patched.ndjson` recording `model: "claude-haiku-4-5"`.
 * Unparseable arm names (should never happen — `listPresentArmNames` only
 * ever returns the 4 valid literals) count zero mismatches defensively. */
function countMismatchedRows(arm: string, rows: ClsArmRow[]): number {
  const parsed = parseClsArmName(arm)
  if (!parsed) return 0
  const expectedModel = CLS_ARM_MODEL_LITERALS[parsed.model]
  return rows.filter((r) => r.model !== expectedModel || r.promptVariant !== parsed.variant).length
}

export const CLS_COMBINED_NAME = "cls-combined.json"

function nonNegInt(v: unknown): v is number {
  return typeof v === "number" && Number.isInteger(v) && v >= 0
}

export interface ClsScoreArmParsed {
  arm: string
  totalKeys: number
  presentKeys: number
  missingKeys: number
  complete: boolean
  counts: { tp: number; fp: number; fn: number; tn: number }
}

export interface ClsScoreFileParsed {
  hostname: string
  scoredAt: string
  sample: { cCount: number; notCCount: number; total: number }
  /** Combine hard-gate — the other host's OWN `provisional` flag (see
   * `ClsScoreFile` doc), REQUIRED on the file: every emitted doc carries it
   * (no legacy docs exist without it), so a file missing it / carrying a
   * non-boolean is not a cls-score doc and the parse refuses fail-closed. */
  provisional: boolean
  arms: ClsScoreArmParsed[]
}

/** Set-cardinality identity every honest per-arm entry satisfies (fix-wave
 * F3, paired-validation.ts's `pvCountsConsistent` precedent): present +
 * missing must sum to total, `complete` must agree with `missingKeys === 0`,
 * and the four counts must sum to `totalKeys` when complete or to exactly
 * zero when not (`computeArmMetrics` never accumulates counts for an
 * incomplete arm — the loop is skipped entirely). */
function clsArmEntryConsistent(a: ClsScoreArmParsed): boolean {
  if (a.presentKeys + a.missingKeys !== a.totalKeys) return false
  if (a.complete !== (a.missingKeys === 0)) return false
  const sum = a.counts.tp + a.counts.fp + a.counts.fn + a.counts.tn
  return a.complete ? sum === a.totalKeys : sum === 0
}

/** Shape-validate another host's `cls-score.json`/`--emit-doc` file for
 * `--combine` (fix-wave F3, paired-validation.ts's `parsePvCountsFile`
 * precedent) — required `hostname`/`scoredAt` strings, `sample` counts as
 * non-negative integers, and every `arms[]` entry's `arm` (one of the 4
 * registered names) / totalKeys / presentKeys / missingKeys / counts as
 * non-negative integers satisfying the completeness identity above, and a
 * REQUIRED boolean `provisional` (combine hard-gate — see
 * `ClsScoreFileParsed`'s field doc). A missing, non-integer, negative,
 * unrecognized-arm, non-boolean-provisional, or inconsistent field refuses
 * rather than silently summing garbage into the combined decision.
 * Returns undefined on any violation. */
export function parseClsScoreCombineFile(raw: string): ClsScoreFileParsed | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const o = parsed as Record<string, unknown>
  if (typeof o.hostname !== "string" || typeof o.scoredAt !== "string") return undefined
  if (typeof o.sample !== "object" || o.sample === null) return undefined
  const s = o.sample as Record<string, unknown>
  if (!nonNegInt(s.cCount) || !nonNegInt(s.notCCount) || !nonNegInt(s.total)) return undefined
  if (typeof o.provisional !== "boolean") return undefined
  if (!Array.isArray(o.arms)) return undefined
  const arms: ClsScoreArmParsed[] = []
  for (const rawArm of o.arms) {
    if (typeof rawArm !== "object" || rawArm === null) return undefined
    const a = rawArm as Record<string, unknown>
    if (typeof a.arm !== "string" || !CLS_ALL_ARM_NAMES.includes(a.arm)) return undefined
    if (!nonNegInt(a.totalKeys) || !nonNegInt(a.presentKeys) || !nonNegInt(a.missingKeys)) return undefined
    if (typeof a.complete !== "boolean") return undefined
    if (typeof a.counts !== "object" || a.counts === null) return undefined
    const c = a.counts as Record<string, unknown>
    if (!nonNegInt(c.tp) || !nonNegInt(c.fp) || !nonNegInt(c.fn) || !nonNegInt(c.tn)) return undefined
    const entry: ClsScoreArmParsed = {
      arm: a.arm,
      totalKeys: a.totalKeys,
      presentKeys: a.presentKeys,
      missingKeys: a.missingKeys,
      complete: a.complete,
      counts: { tp: c.tp, fp: c.fp, fn: c.fn, tn: c.tn },
    }
    if (!clsArmEntryConsistent(entry)) return undefined
    arms.push(entry)
  }
  return {
    hostname: o.hostname,
    scoredAt: o.scoredAt,
    sample: { cCount: s.cCount, notCCount: s.notCCount, total: s.total },
    provisional: o.provisional,
    arms,
  }
}

/** Field-wise sum of one arm's local + other-host counts (fix-wave F3,
 * paired-validation.ts's `combinePvCounts` precedent — valid set arithmetic
 * because per-host corpus stores, and therefore per-host samples, are
 * disjoint by construction, GA9). undefined iff the arm is absent from
 * EITHER side — an arm neither host (or only one host) has run at all
 * contributes nothing to the combined decision rather than a misleading
 * partial sum. */
function combineArmEntries(
  arm: string,
  local: ClsScoreArmEntry | undefined,
  other: ClsScoreArmParsed | undefined,
): ClsScoreArmEntry | undefined {
  if (local === undefined || other === undefined) return undefined
  const totalKeys = local.totalKeys + other.totalKeys
  const presentKeys = local.presentKeys + other.presentKeys
  const missingKeys = local.missingKeys + other.missingKeys
  const complete = missingKeys === 0
  const counts = {
    tp: local.counts.tp + other.counts.tp,
    fp: local.counts.fp + other.counts.fp,
    fn: local.counts.fn + other.counts.fn,
    tn: local.counts.tn + other.counts.tn,
  }
  const metrics = metricsFromCounts(counts.tp, counts.fp, counts.fn)
  return {
    arm,
    totalKeys,
    presentKeys,
    missingKeys,
    complete,
    counts,
    metrics,
    // Combine arithmetic only sums COUNTS (F3's own scope) — per-row
    // provenance checks (F8/F9) are per-host concerns, not meaningful to
    // sum; the combined entry reports neither as flagged.
    mixedPrompt: false,
    mismatchedRows: 0,
  }
}

function toArmMetrics(e: ClsScoreArmEntry): ClsArmMetrics {
  return {
    arm: e.arm,
    totalKeys: e.totalKeys,
    presentKeys: e.presentKeys,
    missingKeys: e.missingKeys,
    complete: e.complete,
    tp: e.counts.tp,
    fp: e.counts.fp,
    fn: e.counts.fn,
    tn: e.counts.tn,
    precision: e.metrics.precision,
    recall: e.metrics.recall,
    f1: e.metrics.f1,
  }
}

/** `cls-combined.json` — the CROSS-HOST registered verdict (spec §6: "the
 * decision rule ... is evaluated on combined counts across hosts"), written
 * beside `cls-score.json` on a successful `--combine` (fix-wave F3,
 * paired-validation.ts's `PvCombinedFile` precedent). Counts + verdict only,
 * mirroring `ClsScoreFile`'s own F2 discipline — no prompt text anywhere. */
export interface ClsCombinedFile {
  scoredAt: string
  local: { hostname: string; arms: ClsScoreArmEntry[] }
  other: { hostname: string; scoredAt: string; arms: ClsScoreArmParsed[] }
  combined: {
    arms: ClsScoreArmEntry[]
    absentArms: string[]
    /** Combine hard-gate — the combined verdict is THE registered verdict
     * (spec §6), so it carries its own flag; no reader may mistake a
     * provisional combine for the registered 4-arm decision. Rule (OR of
     * three sources, mirroring the per-host `ClsScoreFile.provisional`
     * semantics): true iff the LOCAL per-host run is provisional, OR the
     * OTHER host's file declares itself provisional, OR any of the 4
     * registered arms (`CLS_ALL_ARM_NAMES`) is absent from the combined
     * arm set (`absentArms` non-empty — an arm either side never ran).
     * The combine still RUNS and prints when provisional (per-host
     * precedent: warn + mark, never hide data) — it is only marked. */
    provisional: boolean
    decision: ClsScopedDecisionResult
  }
}

/** `cls-score [cwd] [--emit-doc <path>] [--combine <path>]` arg parsing.
 * `--emit-doc`/`--combine` with no following value become `""` (distinct
 * from `undefined` = flag not passed at all) so `runClsScore` can refuse
 * cleanly. `unknownFlag` — fix-wave F17, see `parseClsSampleArgs`'s doc. */
export function parseClsScoreArgs(
  args: string[],
): { cwd: string; emitDoc: string | undefined; combine: string | undefined; unknownFlag: string | undefined } {
  let emitDoc: string | undefined
  let combine: string | undefined
  let unknownFlag: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--emit-doc") {
      emitDoc = args[i + 1] ?? ""
      i++
    } else if (args[i] === "--combine") {
      combine = args[i + 1] ?? ""
      i++
    } else if (args[i]!.startsWith("--")) {
      unknownFlag ??= args[i]
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), emitDoc, combine, unknownFlag }
}

/** `cls-score [cwd] [--emit-doc <path>] [--combine <path>]` (Task 3, +
 * fix-wave F3/F12). Every READ (manifest/labels/arm files/`--combine` file)
 * stays lock-free (module doc above); only the mkdir+write phase is guarded
 * by the shared cls-ab lock. Refusal-first ORDER: `--emit-doc ""`, a
 * missing/malformed manifest, incomplete labels, and (when `--combine` is
 * given) an unreadable/self-hosted/malformed combine file all refuse BEFORE
 * any write — so a refusal has zero effect on every output, including
 * `cls-score.json` itself. Per-arm completeness is reported explicitly
 * (`missingKeys`, log line per incomplete arm) but does NOT refuse the whole
 * run — only labels being incomplete does (labels are the ground truth every
 * arm is scored against).
 *
 * `--combine` (fix-wave F3): once validated, `--emit-doc` (if also given)
 * targets the COMBINED content instead of the per-host one — the registered
 * verdict is the combined one (spec §6), so the committable doc an operator
 * asks for during a combine run should be the combined result, not the
 * per-host one (which is committed separately, its own earlier
 * `--emit-doc`-only run — see the runbook). The per-host `cls-score.json` at
 * the experiment root is ALWAYS written regardless (its `decision.scope` is
 * always `"per-host"`), and `cls-combined.json` is written alongside it on a
 * successful combine. */
export function runClsScore(
  cwd: string,
  opts: { emitDoc?: string; combine?: string },
  log: (m: string) => void,
): (ClsScoreFile & { combined?: ClsCombinedFile }) | undefined {
  if (opts.emitDoc === "") {
    log("REFUSING: cls-score — --emit-doc requires a path argument.")
    return undefined
  }

  const root = clsAbRoot(cwd)

  let manifest: ClsManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, CLS_MANIFEST_NAME), "utf-8")) as ClsManifest
  } catch {
    log(`REFUSING: cls-score — no readable ${CLS_MANIFEST_NAME} under ${CLS_AB_DIR_REL} — run cls-sample first.`)
    return undefined
  }
  if (!Array.isArray(manifest?.keys?.c) || !Array.isArray(manifest.keys.notC)) {
    log(`REFUSING: cls-score — ${CLS_MANIFEST_NAME} is malformed (no keys.c/keys.notC arrays) — re-run cls-sample.`)
    return undefined
  }
  const manifestKeys = [...manifest.keys.c, ...manifest.keys.notC]

  const labelRows = readNdjson<ClsLabelRow>(path.join(root, CLS_LABELS_NAME))
  const labelPositiveByKey = new Map(labelRows.map((r) => [r.key, r.label === "C"] as const))
  const missingLabelKeys = manifestKeys.filter((k) => !labelPositiveByKey.has(k))
  if (missingLabelKeys.length > 0) {
    log(
      `REFUSING: cls-score — labels incomplete (${missingLabelKeys.length}/${manifestKeys.length} sampled ` +
        `record(s) unlabeled, e.g. ${missingLabelKeys[0]}) — labels are the ground truth for every arm. ` +
        "Run cls-label first.",
    )
    return undefined
  }

  const presentArms = listPresentArmNames(cwd)
  const expectedArms = [...CLS_ALL_ARM_NAMES]
  const absentArms = expectedArms.filter((a) => !presentArms.includes(a))
  const armRowsByName = new Map(
    presentArms.map((arm) => [arm, readNdjson<ClsArmRow>(path.join(root, clsArmFileName(arm)))] as const),
  )
  const metrics = presentArms.map((arm) => computeArmMetrics(arm, manifestKeys, armRowsByName.get(arm)!, labelPositiveByKey))
  for (const m of metrics) {
    if (!m.complete) {
      log(
        `cls-score: arm ${m.arm} is INCOMPLETE — missing ${m.missingKeys}/${m.totalKeys} record(s); ` +
          "excluded from scoring.",
      )
    }
  }
  if (absentArms.length > 0) {
    log(`cls-score: ${absentArms.length}/${expectedArms.length} registered arm(s) never run: ${absentArms.join(", ")}.`)
  }

  // Provenance (fix-wave F8/F9): per-arm mixed-prompt-hash + model/variant
  // mismatch checks, both warned on stdout; either flags the whole run
  // provisional (see below).
  let anyMixedOrMismatched = false
  const mixedPromptByArm = new Map<string, boolean>()
  const mismatchedByArm = new Map<string, number>()
  for (const arm of presentArms) {
    const rows = armRowsByName.get(arm)!
    const mixed = distinctPromptHashes(rows).size > 1
    const mismatched = countMismatchedRows(arm, rows)
    mixedPromptByArm.set(arm, mixed)
    mismatchedByArm.set(arm, mismatched)
    if (mixed) {
      anyMixedOrMismatched = true
      log(`cls-score: WARNING — arm ${arm} has rows built from DIFFERING prompt text (mixed promptSha256).`)
    }
    if (mismatched > 0) {
      anyMixedOrMismatched = true
      log(
        `cls-score: WARNING — arm ${arm} has ${mismatched} row(s) whose model/promptVariant does not ` +
          "match the arm filename's expected literal(s).",
      )
    }
  }
  const labelsMixed = distinctPromptHashes(labelRows).size > 1
  if (labelsMixed) {
    log("cls-score: WARNING — labels.ndjson has rows built from DIFFERING prompt text (mixed promptSha256).")
  }

  const decisionRaw = evaluateClsDecision(metrics)
  const decision: ClsScopedDecisionResult = { ...decisionRaw, scope: "per-host" }
  // PROVISIONAL (fix-wave, IMPORTANT + F8/F9): true whenever the decision
  // above was NOT computed over all 4 registered arms fully derived (any
  // registered arm absent or present-but-incomplete), OR any present arm's
  // rows carry a provenance red flag (mixed prompt hash / model-variant
  // mismatch) that puts its metrics in question.
  const provisional = absentArms.length > 0 || metrics.some((m) => !m.complete) || anyMixedOrMismatched

  const scoreFile: ClsScoreFile = {
    scoredAt: new Date().toISOString(),
    hostname: os.hostname(),
    sample: {
      cCount: manifest.cCount,
      notCCount: manifest.notCCount,
      total: manifestKeys.length,
      transportCounts: manifest.transportCounts ?? { c: { cli: 0, sdk: 0 }, notC: { cli: 0, sdk: 0 } },
      manifestSampledAt: manifest.sampledAt,
      manifestKeysHash: manifestKeysHash(manifestKeys),
    },
    expectedArms,
    absentArms,
    provisional,
    arms: metrics.map((m) => ({
      arm: m.arm,
      totalKeys: m.totalKeys,
      presentKeys: m.presentKeys,
      missingKeys: m.missingKeys,
      complete: m.complete,
      counts: { tp: m.tp, fp: m.fp, fn: m.fn, tn: m.tn },
      metrics: { precision: m.precision, recall: m.recall, f1: m.f1 },
      mixedPrompt: mixedPromptByArm.get(m.arm) ?? false,
      mismatchedRows: mismatchedByArm.get(m.arm) ?? 0,
    })),
    decision,
  }
  const scoreBody = JSON.stringify(scoreFile, null, 2) + "\n"

  // --combine (fix-wave F3): validated BEFORE any write, so a refusal here
  // has zero effect (same discipline as pv-compare's --combine validation).
  let combinedFile: ClsCombinedFile | undefined
  const combinedProvisionalSources: string[] = []
  if (opts.combine !== undefined) {
    let raw: string
    try {
      raw = fs.readFileSync(opts.combine, "utf-8")
    } catch {
      log(`REFUSING: cls-score — cannot read --combine file ${opts.combine}`)
      return undefined
    }
    const other = parseClsScoreCombineFile(raw)
    if (other === undefined) {
      log(
        `REFUSING: --combine — ${opts.combine} is not a valid cls-score file (missing/non-integer/` +
          "negative/inconsistent counts, unrecognized arm name, missing hostname/scoredAt/sample, " +
          "or missing/non-boolean provisional flag).",
      )
      return undefined
    }
    if (other.hostname === os.hostname()) {
      log(
        `REFUSING: --combine — ${opts.combine} was produced on THIS host (${other.hostname}); combining ` +
          "a host with itself double-counts its sample. Pass the OTHER host's cls-score file.",
      )
      return undefined
    }

    const otherArmByName = new Map(other.arms.map((a) => [a.arm, a] as const))
    const localArmByName = new Map(scoreFile.arms.map((a) => [a.arm, a] as const))
    const combinedArms: ClsScoreArmEntry[] = []
    const combinedAbsentArms: string[] = []
    for (const arm of CLS_ALL_ARM_NAMES) {
      const combined = combineArmEntries(arm, localArmByName.get(arm), otherArmByName.get(arm))
      if (combined) combinedArms.push(combined)
      else combinedAbsentArms.push(arm)
    }
    const combinedDecisionRaw = evaluateClsDecision(combinedArms.map(toArmMetrics))
    const combinedDecision: ClsScopedDecisionResult = { ...combinedDecisionRaw, scope: "combined" }

    // Combined PROVISIONAL (hard-gate; rule doc'd on `ClsCombinedFile`):
    // local-provisional OR other-provisional OR any registered arm absent
    // from the combined set. Sources collected for the stdout warning.
    if (provisional) combinedProvisionalSources.push("local per-host score is provisional")
    if (other.provisional) combinedProvisionalSources.push(`other host's score (${other.hostname}) is provisional`)
    if (combinedAbsentArms.length > 0) {
      combinedProvisionalSources.push(`registered arm(s) absent from the combined set: ${combinedAbsentArms.join(", ")}`)
    }

    combinedFile = {
      scoredAt: scoreFile.scoredAt,
      local: { hostname: scoreFile.hostname, arms: scoreFile.arms },
      other: { hostname: other.hostname, scoredAt: other.scoredAt, arms: other.arms },
      combined: {
        arms: combinedArms,
        absentArms: combinedAbsentArms,
        provisional: combinedProvisionalSources.length > 0,
        decision: combinedDecision,
      },
    }
  }
  const combinedBody = combinedFile !== undefined ? JSON.stringify(combinedFile, null, 2) + "\n" : undefined

  // Write phase — LOCK-GUARDED (fix-wave F12): every read/computation above
  // is done; only mkdir+write from here on, and only for as long as that
  // takes.
  if (!acquireClsAbLock(cwd)) {
    log(
      `REFUSING: cls-score — lock held (${CLS_AB_LOCK_REL}) — a cls-sample/cls-run/cls-label write ` +
        "appears to be in flight against this experiment dir.",
    )
    return undefined
  }
  try {
    const dest = path.join(root, CLS_SCORE_NAME)
    fs.mkdirSync(root, { recursive: true })
    atomicWrite(dest, scoreBody)
    log(renderClsScoreReport(scoreFile.sample, metrics, decision, { expectedArms, absentArms, provisional }))
    log(`cls-score: wrote ${CLS_SCORE_NAME} -> ${dest}`)

    if (combinedFile !== undefined && combinedBody !== undefined) {
      const combinedDest = path.join(root, CLS_COMBINED_NAME)
      atomicWrite(combinedDest, combinedBody)
      log(
        `cls-score: combine — other host ${combinedFile.other.hostname} (scoredAt ` +
          `${combinedFile.other.scoredAt}); combined verdict: ${combinedFile.combined.decision.verdict}` +
          (combinedFile.combined.decision.verdict === "ADOPT" ? ` <${combinedFile.combined.decision.winnerArm}>` : ""),
      )
      if (combinedFile.combined.provisional) {
        log(
          "WARNING: PROVISIONAL — this combined verdict is NOT the registered 4-arm cross-host decision " +
            `(spec §6 evaluates all four arms on combined counts across hosts) — ${combinedProvisionalSources.join("; ")}.`,
        )
      }
      log(`cls-score: wrote ${CLS_COMBINED_NAME} -> ${combinedDest}`)
    }

    if (opts.emitDoc !== undefined) {
      const emitBody = combinedBody ?? scoreBody
      fs.mkdirSync(path.dirname(opts.emitDoc), { recursive: true })
      atomicWrite(opts.emitDoc, emitBody)
      log(`cls-score: --emit-doc -> ${opts.emitDoc} (${combinedBody !== undefined ? "combined" : "per-host"})`)
    }
  } finally {
    releaseClsAbLock(cwd)
  }

  return combinedFile !== undefined ? { ...scoreFile, combined: combinedFile } : scoreFile
}
