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
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { readCorpus, recordKey, type CorpusRecord } from "./corpus-store.ts"

export const CLS_AB_DIR_REL = ".km/gauge-cls-ab"
export const CLS_MANIFEST_NAME = "manifest.json"
export const CLS_RECORDS_NAME = "records.ndjson"

/** Experiment root for the repo at `cwd`. */
export function clsAbRoot(cwd: string): string {
  return path.join(cwd, CLS_AB_DIR_REL)
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
 * refusal (CLI exits 1, runPvSample precedent). Two refusal paths, both
 * with zero effect on the real store AND (where applicable) zero effect on
 * an already-existing experiment dir: zero derived class-C records (a hard
 * error — "nothing to sample" — checked FIRST, before the experiment dir is
 * even looked at, so a bad run can never discard an in-flight sample, even
 * with --reset); and a pre-existing experiment dir without --reset (a
 * re-run must never silently replace an in-flight sample). */
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
}
