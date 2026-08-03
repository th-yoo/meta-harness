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
import { parseRefinerOutput, parseLabelOutput, type PromptVariant, type ClsLabel } from "./refiner.ts"
import { callModelSdk, callModelSdkLabel } from "./transport.ts"
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

/** Acquire `.km/gauge-cls-ab.lock`. Fresh contention -> false (caller
 * refuses). Stale/torn/vanished lock -> unlink + ONE fresh `wx` attempt;
 * losing that race to a concurrent takeover (EEXIST on the retry) also ->
 * false — never "overwrite and assume ownership". EXPORTED for Task 2's
 * arm/label runners to share (see module doc). */
export function acquireClsAbLock(cwd: string, now: number = Date.now()): boolean {
  const lockPath = clsAbLockPath(cwd)
  const content: ClsAbLockContent = { pid: process.pid, ts: now }

  if (tryCreateClsAbLock(lockPath, content)) return true
  if (!isClsAbLockStale(lockPath, now)) return false

  try {
    fs.unlinkSync(lockPath)
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") throw e
  }
  return tryCreateClsAbLock(lockPath, content)
}

/** Release `.km/gauge-cls-ab.lock` — best-effort (never let release itself
 * surface). EXPORTED for Task 2's arm/label runners to share. */
export function releaseClsAbLock(cwd: string): void {
  try {
    fs.unlinkSync(clsAbLockPath(cwd))
  } catch {
    // best-effort — see doc comment above
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
 * `stratify` precedent). */
export function stratify(records: CorpusRecord[]): ClsStrata {
  const c: CorpusRecord[] = []
  const notC: CorpusRecord[] = []
  for (const r of records) {
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

/** Sample manifest — counts + store keys per stratum ONLY, never prompt text
 * (F2: code-bearing text never travels). Task 2's arm/label runners join on
 * these keys against `records.ndjson`. */
export interface ClsManifest {
  sampledAt: string
  hostname: string
  cCount: number
  notCCount: number
  keys: { c: string[]; notC: string[] }
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

/** `cls-sample [cwd] [--reset]` — --reset extracted, one positional (cwd),
 * pv-sample's `parsePvSampleArgs` precedent. */
export function parseClsSampleArgs(args: string[]): { cwd: string; reset: boolean } {
  let reset = false
  const positional: string[] = []
  for (const a of args) {
    if (a === "--reset") reset = true
    else positional.push(a)
  }
  return { cwd: positional[0] ?? process.cwd(), reset }
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
export function runClsSample(
  cwd: string,
  opts: { reset?: boolean },
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
    const sampleRecords: ClsSampleRecord[] = sampled.map((r) => ({
      key: recordKey(r),
      prompt: r.prompt,
      floorCheck: r.floorCheck,
    }))
    const recordsBody =
      sampleRecords.map((r) => JSON.stringify(r)).join("\n") + (sampleRecords.length ? "\n" : "")
    atomicWrite(path.join(root, CLS_RECORDS_NAME), recordsBody)

    const manifest: ClsManifest = {
      sampledAt: new Date().toISOString(),
      hostname: os.hostname(),
      cCount: c.length,
      notCCount: drawn.length,
      keys: { c: c.map(recordKey), notC: drawn.map(recordKey) },
    }
    atomicWrite(path.join(root, CLS_MANIFEST_NAME), JSON.stringify(manifest, null, 2) + "\n")

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
      const raw = await callModelSdk(record.prompt, record.floorCheck, process.env, {}, {
        model: modelLiteral,
        promptVariant: variant,
      })
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
      const raw = await callModelSdkLabel(record.prompt, record.floorCheck, process.env, {}, {
        model: CLS_LABEL_MODEL_LITERAL,
      })
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
 * precedent (extract flags, everything else positional). */
export function parseClsRunArgs(
  args: string[],
): { cwd: string; arm: string | undefined; go: number | undefined } {
  let arm: string | undefined
  let go: number | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--arm") {
      arm = args[i + 1]
      i++
    } else if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), arm, go }
}

/** `cls-label [cwd] --go <n>` arg parsing. */
export function parseClsLabelArgs(args: string[]): { cwd: string; go: number | undefined } {
  let go: number | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--go") {
      go = Number(args[i + 1])
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), go }
}

// ── Task 3: `cls-score` — metrics + pre-registered decision rule ─────────
//
// `cls-score` is MODEL-FREE and READ-ONLY on every input it touches:
// `manifest.json` (JSON.parse), `labels.ndjson`, and every present
// `arm-<name>.ndjson` are read via `readNdjson`/`fs.readFileSync` only —
// never written, never locked. A pure read cannot contend with a
// concurrent cls-run/cls-label writer (report-subcommand precedent, same
// as pv-compare in paired-validation.ts), so `acquireClsAbLock` is neither
// called nor needed here.
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

/** Metrics for one arm against the labels, restricted to the manifest's
 * sampled keys. `complete` iff every manifest key has a row in `armRows` —
 * an arm missing even one key is INCOMPLETE (plan Task 3): its
 * TP/FP/FN/TN/precision/recall/F1 all come out zero/"n/a" (the loop below
 * is skipped entirely) and it is excluded from winner selection
 * (`pickWinner`), but `missingKeys` is always reported explicitly, never
 * silently dropped. Zero-division edges (plan step 3): no C predicted ->
 * precision "n/a"; no C in labels -> recall "n/a"; F1 "n/a" whenever
 * EITHER is "n/a", or when both are defined but both zero (0/0 is
 * reported as "n/a", never NaN). `tp+fp===0`/`tp+fn===0` already cover the
 * incomplete case too (the skipped loop leaves every count at 0), so no
 * separate `complete` branch is needed in the precision/recall formulas. */
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

  const precision: ClsMetricValue = tp + fp === 0 ? "n/a" : tp / (tp + fp)
  const recall: ClsMetricValue = tp + fn === 0 ? "n/a" : tp / (tp + fn)
  let f1: ClsMetricValue
  if (precision === "n/a" || recall === "n/a") f1 = "n/a"
  else if (precision === 0 && recall === 0) f1 = "n/a"
  else f1 = (2 * precision * recall) / (precision + recall)

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
  const margin = winner.f1 - incumbent.f1
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
  sample: { cCount: number; notCCount: number; total: number }
  expectedArms: string[]
  absentArms: string[]
  provisional: boolean
  arms: ClsScoreArmEntry[]
  decision: ClsDecisionResult
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

function renderDecisionLines(d: ClsDecisionResult): string[] {
  const lines = [`decision (pre-registered, spec §3 — incumbent ${d.incumbentArm}):`]
  if (d.verdict === "NOT-EVALUABLE") {
    lines.push(`  ${d.reason}`, "verdict: NOT-EVALUABLE")
    return lines
  }
  const marginOk = d.marginAchieved! >= CLS_DECISION_CONSTANTS.f1Margin
  const missedOk = d.missedCWinner! <= d.missedCIncumbent!
  lines.push(
    `  winner (argmax F1, tie-break cheaper-model-then-base-prompt): ${d.winnerArm}`,
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

/** `cls-score [cwd] [--emit-doc <path>]` arg parsing. `--emit-doc` with no
 * following value becomes `""` (distinct from `undefined` = flag not
 * passed at all) so `runClsScore` can refuse it cleanly instead of
 * attempting to write to an empty path. */
export function parseClsScoreArgs(args: string[]): { cwd: string; emitDoc: string | undefined } {
  let emitDoc: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--emit-doc") {
      emitDoc = args[i + 1] ?? ""
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), emitDoc }
}

/** `cls-score [cwd] [--emit-doc <path>]` (Task 3). READ-ONLY on every input
 * (module doc above) — no lock is acquired or needed. Refusal-first ORDER:
 * `--emit-doc ""` (flag with no value), a missing/malformed manifest, and
 * incomplete labels all refuse BEFORE any write — including the main
 * `cls-score.json` write, so a refusal has zero effect on either output. Per-
 * arm completeness is reported explicitly (`missingKeys`, log line per
 * incomplete arm) but does NOT refuse the whole run — only labels being
 * incomplete does (labels are the ground truth every arm is scored against). */
export function runClsScore(
  cwd: string,
  opts: { emitDoc?: string },
  log: (m: string) => void,
): ClsScoreFile | undefined {
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
  const metrics = presentArms.map((arm) =>
    computeArmMetrics(
      arm,
      manifestKeys,
      readNdjson<ClsArmRow>(path.join(root, clsArmFileName(arm))),
      labelPositiveByKey,
    ),
  )
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

  const decision = evaluateClsDecision(metrics)
  // PROVISIONAL (fix-wave, IMPORTANT): true whenever the decision above was
  // NOT computed over all 4 registered arms fully derived — i.e. any
  // registered arm is absent OR present-but-incomplete.
  const provisional = absentArms.length > 0 || metrics.some((m) => !m.complete)

  const scoreFile: ClsScoreFile = {
    scoredAt: new Date().toISOString(),
    hostname: os.hostname(),
    sample: { cCount: manifest.cCount, notCCount: manifest.notCCount, total: manifestKeys.length },
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
    })),
    decision,
  }

  const body = JSON.stringify(scoreFile, null, 2) + "\n"
  const dest = path.join(root, CLS_SCORE_NAME)
  fs.mkdirSync(root, { recursive: true })
  atomicWrite(dest, body)

  log(renderClsScoreReport(scoreFile.sample, metrics, decision, { expectedArms, absentArms, provisional }))
  log(`cls-score: wrote ${CLS_SCORE_NAME} -> ${dest}`)

  if (opts.emitDoc !== undefined) {
    fs.mkdirSync(path.dirname(opts.emitDoc), { recursive: true })
    atomicWrite(opts.emitDoc, body)
    log(`cls-score: --emit-doc -> ${opts.emitDoc}`)
  }

  return scoreFile
}
