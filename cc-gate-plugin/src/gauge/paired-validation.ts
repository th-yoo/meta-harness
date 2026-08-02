// km-gauge paired-validation shadow-store tooling (§6c amendment, approved
// c22fbd0 — docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor
// -preregistration.md lines 443-529; build plan docs/superpowers/plans/
// 2026-08-03-paired-validation-script.md, T1: `pv-sample`; T2: `pv-compare`).
//
// `pv-sample` is MODEL-FREE. From the host's REAL corpus store it selects
// every CLI-derived class-C record plus an equal-size Math.random draw of
// CLI-derived not-C records (stratified, C-enriched — the spec's flat sample
// was uninformative at the ~5% natural C-rate), and builds a SHADOW store
// containing exactly those records reset to stage "mined" (R1: sample-only
// copy, so the fenced deriver's `go === pending.length` arithmetic IS the
// sample size). The actual spend then happens through the EXISTING, unmodified
// `derive` subcommand pointed at the shadow root as its cwd.
//
// Shadow layout (R4): `<cwd>/.km/gauge-corpus-shadow/` is the shadow ROOT —
// records live NESTED at `<root>/.km/gauge-corpus/records.ndjson` (same
// layout the store helpers resolve relative to a cwd), so
// `replay-cli.ts derive <root> --go <n>` reads the sample as its ordinary
// pending set with zero deriver changes. The sample manifest
// (`pv-manifest.json`, top of the shadow root) carries counts + record KEYS
// only, never prompt text (R5/F2). Host-local like the real store: `.km/` is
// gitignored, never in km-sensors-sync FILES.
//
// The REAL store is opened strictly read-only — readCorpus only, never
// writeCorpus, never its lock (report-subcommand precedent: a pure read
// cannot contend with a writer). The byte-identical-store test pins this.
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  readCorpus,
  writeCorpus,
  recordKey,
  hasLiveCorpusLock,
  type CorpusRecord,
} from "./corpus-store.ts"

export const SHADOW_DIR_REL = ".km/gauge-corpus-shadow"
export const PV_MANIFEST_NAME = "pv-manifest.json"

/** Shadow ROOT for the repo at `cwd` — pass this as the cwd of every store
 * helper (and of the `derive` subcommand) to operate on the shadow store. */
export function shadowRoot(cwd: string): string {
  return path.join(cwd, SHADOW_DIR_REL)
}

/** R2 — "CLI-derived": has a derivation AND its transport is `"cli"` or
 * ABSENT (absent = pre-boundary CLI, per the §6c provenance rule —
 * files.ts:41-46). `transport:"sdk"` records are post-boundary and have no
 * CLI arm to pair with, so they are excluded from sampling entirely. */
export function isCliDerived(r: CorpusRecord): boolean {
  if (r.derivation === undefined) return false
  return r.derivation.transport !== "sdk"
}

export interface PvStrata {
  /** every CLI-derived class-C record (sampled in full) */
  c: CorpusRecord[]
  /** every CLI-derived record whose derivation class !== "C" (draw pool) */
  notC: CorpusRecord[]
}

/** Pure stratification over the whole store. Not-C deliberately includes
 * class-less derivations (class is optional on v1 blobs) — "not C" is the
 * plan's literal predicate, not "classified as something else". */
export function stratify(records: CorpusRecord[]): PvStrata {
  const c: CorpusRecord[] = []
  const notC: CorpusRecord[] = []
  for (const r of records) {
    if (!isCliDerived(r)) continue
    if (r.derivation!.class === "C") c.push(r)
    else notC.push(r)
  }
  return { c, notC }
}

/** R3 — equal-size draw from the not-C pool: Fisher-Yates on a copy with
 * plain Math.random (injectable for tests), take the first `size`.
 * Reproducibility comes from the MANIFEST (the drawn keys are recorded),
 * never from a seed. A pool smaller than `size` yields the whole pool. */
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

/** Reset a sampled record to EXACTLY the mined-stage shape corpus-mine.ts
 * produces (corpus-mine.ts:99-107) — identity + prompt + floorCheck fields
 * only; `derivation`/`state`/`exec`/`poolEligible` are all dropped, not just
 * blanked, so the fenced deriver sees an ordinary pending record. */
export function resetToMined(r: CorpusRecord): CorpusRecord {
  return {
    provenance: r.provenance,
    stage: "mined",
    repo: r.repo,
    sessionId: r.sessionId,
    promptTs: r.promptTs,
    prompt: r.prompt,
    promptSha256: r.promptSha256,
    floorCheck: r.floorCheck,
    floorCheckMinedAt: r.floorCheckMinedAt,
  }
}

/** Sample manifest (R3/R5) — counts + store keys per stratum ONLY, never
 * prompt text (F2: code-bearing text never travels). `pv-compare` (T2) joins
 * real-vs-shadow classifications on these keys. */
export interface PvManifest {
  sampledAt: string
  hostname: string
  cCount: number
  notCCount: number
  keys: { c: string[]; notC: string[] }
}

export interface PvSampleSummary {
  cCount: number
  notCCount: number
  total: number
}

/** `pv-sample [cwd] [--reset]` — --reset extracted, one positional (cwd). */
export function parsePvSampleArgs(args: string[]): { cwd: string; reset: boolean } {
  let reset = false
  const positional: string[] = []
  for (const a of args) {
    if (a === "--reset") reset = true
    else positional.push(a)
  }
  return { cwd: positional[0] ?? process.cwd(), reset }
}

/** Build the shadow store + manifest. Returns undefined on refusal (CLI
 * exits 1, runDerive precedent). Three refusal paths, all with zero effect
 * on both stores: zero CLI-derived class-C records ("nothing to validate" —
 * checked first, before the shadow dir is even looked at, so a bad run can
 * never discard an in-flight sample, even with --reset); a pre-existing
 * shadow store without --reset (R3: a re-run must never silently replace an
 * in-flight sample); and --reset while the SHADOW store's own lock is live
 * (a shadow derive batch mid-spend — rmSync'ing store+lock out from under
 * it would let its post-spend write({lockHeld:true}) silently overwrite the
 * fresh sample's records while the new manifest survives: a key mismatch
 * pv-compare would misread). */
export function runPvSample(
  cwd: string,
  opts: { reset?: boolean },
  log: (m: string) => void,
  rand: () => number = Math.random,
): PvSampleSummary | undefined {
  // REAL store: lock-free read path only — never writeCorpus, never its lock.
  const { c, notC } = stratify(readCorpus(cwd))
  if (c.length === 0) {
    log("pv-sample: nothing to validate — the store has no CLI-derived class-C records.")
    return undefined
  }

  const root = shadowRoot(cwd)
  if (fs.existsSync(root)) {
    if (!opts.reset) {
      log(
        `REFUSING: shadow store already exists (${SHADOW_DIR_REL}) — a re-run would silently ` +
          "replace an in-flight sample. Pass --reset to discard it and rebuild.",
      )
      return undefined
    }
    // --reset guard: the shadow store's OWN lock (judged by corpus-store.ts's
    // staleness rule, never a re-invented one) live => a shadow derive is in
    // flight; deleting store+lock now would strand its post-spend write.
    if (hasLiveCorpusLock(root)) {
      log(
        `REFUSING: --reset — the shadow store's lock is held (${SHADOW_DIR_REL}) — a shadow ` +
          "derive batch appears to be in flight. Wait for it to finish (or clear the lock " +
          "manually if it is known dead) before discarding the sample.",
      )
      return undefined
    }
    fs.rmSync(root, { recursive: true, force: true })
  }

  const drawn = drawNotC(notC, c.length, rand)
  if (drawn.length < c.length) {
    log(
      `pv-sample: not-C pool (${drawn.length}) smaller than the class-C stratum (${c.length}) — ` +
        "drawing the whole pool.",
    )
  }

  // Shadow store write reuses writeCorpus verbatim (atomic tmp+rename; its
  // lock lives INSIDE the fresh shadow root, so it can never contend).
  const sampled = [...c.map(resetToMined), ...drawn.map(resetToMined)]
  if (!writeCorpus(root, sampled, log)) return undefined

  const manifest: PvManifest = {
    sampledAt: new Date().toISOString(),
    hostname: os.hostname(),
    cCount: c.length,
    notCCount: drawn.length,
    keys: { c: c.map(recordKey), notC: drawn.map(recordKey) },
  }
  const dest = path.join(root, PV_MANIFEST_NAME)
  const tmp = dest + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(manifest, null, 2) + "\n")
  fs.renameSync(tmp, dest)

  // Absolute shadow root in the hint — the derive command runs from anywhere,
  // so a relative path would resolve against the WRONG cwd (fix wave, F4).
  log(
    `pv-sample: ${c.length} class-C + ${drawn.length} not-C CLI-derived record(s) -> ` +
      `${SHADOW_DIR_REL} (pending ${sampled.length}; next: derive ${root} --go ${sampled.length})`,
  )
  return { cCount: c.length, notCCount: drawn.length, total: sampled.length }
}

// ── T2: `pv-compare` — join + pre-registered bar ────────────────────────
//
// `pv-compare` is MODEL-FREE and READ-ONLY on BOTH stores (readCorpus only —
// never writeCorpus, never a lock; report-subcommand precedent). Its only
// writes are `pv-counts.json` at the shadow root top (counts, per-set record
// KEYS, the bar arithmetic, hostname + comparedAt — never prompt text,
// R5/F2) and, on a successful `--combine`, `pv-combined.json` beside it
// (both hosts' counts + the combined bar verdict — the durable cross-host
// decision). Cross-host combining (`--combine <other-host pv-counts.json>`)
// sums the two hosts' counts and evaluates the same bar on the sums — plain
// set arithmetic on counts is valid because the host samples are DISJOINT by
// construction (corpus stores are host-bound, GA9); that disjointness is
// VERIFIED, not assumed (self-combine hostname check + key-overlap check in
// runPvCompare).

export const PV_COUNTS_NAME = "pv-counts.json"
export const PV_COMBINED_NAME = "pv-combined.json"

/** Bar constants — pre-registered in the spec (lines 472-478) BEFORE any SDK
 * data existed; copied EXACTLY, never tuned. */
export const PV_AGREEMENT_MIN = 0.8
export const PV_MISSED_C_FRAC = 0.1

export interface PvCounts {
  /** decided records whose CLI arm is class C — |C_cli| */
  cCli: number
  /** decided records whose SDK arm is class C — |C_sdk| */
  cSdk: number
  /** |C_cli ∩ C_sdk| */
  intersection: number
  /** |C_cli ∪ C_sdk| */
  union: number
  /** |C_cli \ C_sdk| — CLI calls C, SDK does not */
  missedC: number
  /** |C_sdk \ C_cli| — SDK calls C, CLI does not */
  sdkOnlyC: number
  /** manifest records with BOTH arms derived (the paired sample the bar
   * reads) */
  decided: number
  /** manifest records whose shadow derivation is missing/failed (shadow
   * record still stage "mined") — excluded from both strata, never dropped */
  undecided: number
  /** manifest keys absent from either store (or a real record with no
   * derivation to read a CLI arm from) — distinct from undecided */
  missing: number
  /** manifest records whose arms carry the WRONG transport: a shadow
   * derivation not `transport:"sdk"` (a stale pre-boundary checkout deriving
   * the shadow on CLI would make the comparison CLI-vs-CLI — trivial
   * agreement approving pooling while SDK never ran), or a real record that
   * no longer satisfies isCliDerived (its CLI arm was overwritten by an SDK
   * derive). Blocks bar evaluation exactly like undecided/missing. */
  wrongTransport: number
}

export interface PvSetKeys {
  cCli: string[]
  cSdk: string[]
  intersection: string[]
  missedC: string[]
  sdkOnlyC: string[]
  undecided: string[]
  missing: string[]
  wrongTransport: string[]
}

export interface PvComparison {
  counts: PvCounts
  keys: PvSetKeys
}

/** R3 — the join is MANIFEST-driven: exactly the sampled keys are compared;
 * records outside the manifest in EITHER store are ignored entirely (the
 * real store carries hundreds of unsampled records; a stray shadow record
 * must not widen the sample). Per manifest key:
 * - key absent from either store, or a real record with no derivation (no
 *   CLI arm to read) -> `missing`;
 * - shadow record present but underived (still stage "mined": the shadow
 *   derive failed or has not run) -> `undecided`;
 * - both arms derived but on the WRONG transport — shadow derivation not
 *   `transport:"sdk"`, or the real record no longer isCliDerived ->
 *   `wrongTransport` (a stale pre-boundary checkout deriving the shadow on
 *   CLI would score trivial CLI-vs-CLI agreement while SDK never ran);
 * - both arms derived on the right transports -> `decided`; CLI arm class
 *   from the REAL store's derivation, SDK arm class from the SHADOW store's.
 * Undecided/missing/wrongTransport are excluded from every C set but always
 * REPORTED — never silently dropped. */
export function comparePvRecords(
  manifest: PvManifest,
  realRecords: CorpusRecord[],
  shadowRecords: CorpusRecord[],
): PvComparison {
  const realByKey = new Map(realRecords.map((r) => [recordKey(r), r] as const))
  const shadowByKey = new Map(shadowRecords.map((r) => [recordKey(r), r] as const))

  const keys: PvSetKeys = {
    cCli: [],
    cSdk: [],
    intersection: [],
    missedC: [],
    sdkOnlyC: [],
    undecided: [],
    missing: [],
    wrongTransport: [],
  }
  let decided = 0
  let union = 0

  for (const k of [...manifest.keys.c, ...manifest.keys.notC]) {
    const real = realByKey.get(k)
    const shadow = shadowByKey.get(k)
    if (real?.derivation === undefined || shadow === undefined) {
      keys.missing.push(k)
      continue
    }
    if (shadow.derivation === undefined) {
      keys.undecided.push(k)
      continue
    }
    if (shadow.derivation.transport !== "sdk" || !isCliDerived(real)) {
      keys.wrongTransport.push(k)
      continue
    }
    decided++
    const cliC = real.derivation.class === "C"
    const sdkC = shadow.derivation.class === "C"
    if (cliC) keys.cCli.push(k)
    if (sdkC) keys.cSdk.push(k)
    if (cliC || sdkC) union++
    if (cliC && sdkC) keys.intersection.push(k)
    if (cliC && !sdkC) keys.missedC.push(k)
    if (!cliC && sdkC) keys.sdkOnlyC.push(k)
  }

  return {
    counts: {
      cCli: keys.cCli.length,
      cSdk: keys.cSdk.length,
      intersection: keys.intersection.length,
      union,
      missedC: keys.missedC.length,
      sdkOnlyC: keys.sdkOnlyC.length,
      decided,
      undecided: keys.undecided.length,
      missing: keys.missing.length,
      wrongTransport: keys.wrongTransport.length,
    },
    keys,
  }
}

/** Spec-verbatim missed-C cap: `ceil(0.10 × |C_cli|)`. Plain Math.ceil over
 * the product — verified float-exact at the integer boundaries that matter
 * (0.1×10 === 1, 0.1×20 === 2, 0.1×30 === 3 in IEEE doubles; the ceil-edge
 * tests pin 10 -> 1 and 13 -> 2). */
export function missedCCap(cCli: number): number {
  return Math.ceil(PV_MISSED_C_FRAC * cCli)
}

export interface PvBarVerdict {
  verdict: "POOLING-PERMITTED" | "SPLIT" | "NOT-EVALUATED"
  /** intersection/union — null whenever the bar is not evaluated */
  agreement: number | null
  agreementOk?: boolean
  missedCap?: number
  missedOk?: boolean
  /** present iff verdict is NOT-EVALUATED — why */
  reason?: string
}

/** The pre-registered bar, evaluated ONLY on a fully-and-correctly-derived
 * sample: any undecided/missing/wrongTransport record blocks evaluation (an
 * undecided not-C-stratum record could still be SDK-only C, so no stratum is
 * safely complete until all three counts are zero). `union === 0` is the
 * vacuous edge — reported explicitly, never a divide-by-zero and never an
 * auto-pass. */
export function evaluatePvBar(counts: PvCounts): PvBarVerdict {
  if (counts.undecided + counts.missing + counts.wrongTransport > 0) {
    return {
      verdict: "NOT-EVALUATED",
      agreement: null,
      reason:
        `${counts.undecided} undecided + ${counts.missing} missing + ` +
        `${counts.wrongTransport} wrong-transport record(s) — the bar is not evaluated ` +
        "until the sample is fully derived on the correct transports",
    }
  }
  if (counts.union === 0) {
    return {
      verdict: "NOT-EVALUATED",
      agreement: null,
      reason: "no C in either arm — bar not meaningful (|C_cli ∪ C_sdk| = 0)",
    }
  }
  const agreement = counts.intersection / counts.union
  const agreementOk = agreement >= PV_AGREEMENT_MIN
  const missedCap = missedCCap(counts.cCli)
  const missedOk = counts.missedC <= missedCap
  return {
    verdict: agreementOk && missedOk ? "POOLING-PERMITTED" : "SPLIT",
    agreement,
    agreementOk,
    missedCap,
    missedOk,
  }
}

/** Field-wise sum — valid set arithmetic because the two hosts' samples are
 * disjoint by construction (host-bound corpus stores, GA9): every set the
 * counts describe is a disjoint union across hosts. */
export function combinePvCounts(a: PvCounts, b: PvCounts): PvCounts {
  return {
    cCli: a.cCli + b.cCli,
    cSdk: a.cSdk + b.cSdk,
    intersection: a.intersection + b.intersection,
    union: a.union + b.union,
    missedC: a.missedC + b.missedC,
    sdkOnlyC: a.sdkOnlyC + b.sdkOnlyC,
    decided: a.decided + b.decided,
    undecided: a.undecided + b.undecided,
    missing: a.missing + b.missing,
    wrongTransport: a.wrongTransport + b.wrongTransport,
  }
}

/** `pv-counts.json` — the ONLY thing pv-compare ever writes. Counts, per-set
 * record KEYS, bar verdict, hostname + comparedAt — never prompt text
 * (R5/F2: code-bearing text never travels; this file is what gets committed
 * for the cross-host --combine). */
export interface PvCountsFile {
  comparedAt: string
  hostname: string
  counts: PvCounts
  keys: PvSetKeys
  bar: PvBarVerdict
}

const PV_COUNT_FIELDS = [
  "cCli",
  "cSdk",
  "intersection",
  "union",
  "missedC",
  "sdkOnlyC",
  "decided",
  "undecided",
  "missing",
  "wrongTransport",
] as const satisfies readonly (keyof PvCounts)[]

const PV_KEY_FIELDS = [
  "cCli",
  "cSdk",
  "intersection",
  "missedC",
  "sdkOnlyC",
  "undecided",
  "missing",
  "wrongTransport",
] as const satisfies readonly (keyof PvSetKeys)[]

export interface PvCountsFileParsed {
  hostname: string
  comparedAt: string
  counts: PvCounts
  keys: PvSetKeys
}

/** Set-cardinality identities every honest pv-counts.json satisfies —
 * checked on a `--combine` input so a corrupted/hand-edited file can never
 * poison the combined bar (fix-wave repro: `undecided:-1` in a combine file
 * cancelled a 1-undecided local sample into combined undecided:0 and let a
 * partially-derived sample reach POOLING-PERMITTED). */
function pvCountsConsistent(c: PvCounts): boolean {
  return (
    c.union === c.cCli + c.sdkOnlyC &&
    c.missedC === c.cCli - c.intersection &&
    c.intersection <= c.union &&
    c.intersection <= c.cCli &&
    c.intersection <= c.cSdk
  )
}

/** Shape-validate another host's pv-counts.json for `--combine`. Required:
 * `hostname`/`comparedAt` strings (the per-host report line + self-combine
 * check), all ten counts as NON-NEGATIVE INTEGERS satisfying the set
 * identities above, and all key sets as string arrays (the key-overlap
 * disjointness check). A missing, non-integer, negative, or inconsistent
 * field refuses rather than silently summing garbage into the bar. Returns
 * undefined on any violation. */
export function parsePvCountsFile(raw: string): PvCountsFileParsed | undefined {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null) return undefined
  const o = parsed as Record<string, unknown>
  if (typeof o.hostname !== "string" || typeof o.comparedAt !== "string") return undefined
  if (typeof o.counts !== "object" || o.counts === null) return undefined
  const rawCounts = o.counts as Record<string, unknown>
  const counts = {} as PvCounts
  for (const f of PV_COUNT_FIELDS) {
    const v = rawCounts[f]
    if (typeof v !== "number" || !Number.isInteger(v) || v < 0) return undefined
    counts[f] = v
  }
  if (!pvCountsConsistent(counts)) return undefined
  if (typeof o.keys !== "object" || o.keys === null) return undefined
  const rawKeys = o.keys as Record<string, unknown>
  const keys = {} as PvSetKeys
  for (const f of PV_KEY_FIELDS) {
    const v = rawKeys[f]
    if (!Array.isArray(v) || v.some((k) => typeof k !== "string")) return undefined
    keys[f] = v as string[]
  }
  return { hostname: o.hostname, comparedAt: o.comparedAt, counts, keys }
}

function renderPvCountsLine(c: PvCounts): string {
  return (
    `|C_cli| ${c.cCli} · |C_sdk| ${c.cSdk} · |C_cli ∩ C_sdk| ${c.intersection} · ` +
    `|C_cli ∪ C_sdk| ${c.union} · missed-C ${c.missedC} · sdk-only-C ${c.sdkOnlyC} · ` +
    `decided ${c.decided} · undecided ${c.undecided} · missing ${c.missing} · ` +
    `wrong-transport ${c.wrongTransport}`
  )
}

/** Both bar clauses with the arithmetic shown, then the verdict line. */
function renderPvBarLines(c: PvCounts, bar: PvBarVerdict): string[] {
  if (bar.verdict === "NOT-EVALUATED") {
    return [`bar: NOT evaluated — ${bar.reason}`, "verdict: NOT-EVALUATED"]
  }
  return [
    "bar (pre-registered):",
    `  positive agreement |C_cli ∩ C_sdk| / |C_cli ∪ C_sdk| = ${c.intersection}/${c.union} = ` +
      `${bar.agreement!.toFixed(3)} ≥ ${PV_AGREEMENT_MIN}? ${bar.agreementOk ? "YES" : "NO"}`,
    `  missed-C |C_cli \\ C_sdk| = ${c.missedC} ≤ ceil(${PV_MISSED_C_FRAC} × ${c.cCli}) = ` +
      `${bar.missedCap}? ${bar.missedOk ? "YES" : "NO"}`,
    `verdict: ${bar.verdict}`,
  ]
}

/** Human report for one host's comparison. Exported for tests. */
export function renderPvReport(manifest: PvManifest, c: PvCounts, bar: PvBarVerdict): string {
  return [
    "pv-compare — CLI-vs-SDK transport comparison (§6c pre-registered bar)",
    `sample: ${manifest.cCount} C + ${manifest.notCCount} not-C ` +
      `(sampled ${manifest.sampledAt}, host ${manifest.hostname})`,
    renderPvCountsLine(c),
    ...renderPvBarLines(c, bar),
  ].join("\n")
}

/** `pv-compare [cwd] [--combine <path>]` — --combine's value extracted, one
 * positional (cwd). A --combine with no value falls through as "" and hits
 * the cannot-read refusal (parseDeriveArgs's missing-value precedent). */
export function parsePvCompareArgs(args: string[]): { cwd: string; combine: string | undefined } {
  let combine: string | undefined
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--combine") {
      combine = args[i + 1] ?? ""
      i++
    } else {
      positional.push(args[i]!)
    }
  }
  return { cwd: positional[0] ?? process.cwd(), combine }
}

export interface PvCompareSummary {
  counts: PvCounts
  bar: PvBarVerdict
  combined?: { counts: PvCounts; bar: PvBarVerdict }
}

/** `pv-combined.json` — written beside pv-counts.json on a successful
 * `--combine` so the actual CROSS-HOST decision is durable and committable
 * (the per-host pv-counts.json alone only carries one arm of it). Counts +
 * verdict only — keys already live in the two per-host files (R5/F2). */
export interface PvCombinedFile {
  comparedAt: string
  local: { hostname: string; counts: PvCounts }
  other: { hostname: string; comparedAt: string; counts: PvCounts }
  combined: { counts: PvCounts; bar: PvBarVerdict }
}

/** Values appearing more than once in `keys`, each reported once. */
function duplicateKeys(keys: string[]): string[] {
  const seen = new Set<string>()
  const dup = new Set<string>()
  for (const k of keys) {
    if (seen.has(k)) dup.add(k)
    seen.add(k)
  }
  return [...dup]
}

/** Join real-store CLI classifications with shadow-store SDK classifications
 * on the manifest keys, evaluate the bar, write pv-counts.json (and, on a
 * successful --combine, pv-combined.json), report. Returns undefined on
 * refusal (CLI exits 1). Refusal order is validate-first: a missing/corrupt
 * manifest, a malformed/self/overlapping --combine file, or duplicate sample
 * keys in a store all refuse with ZERO writes — the artifacts only land on a
 * run that will finish. */
export function runPvCompare(
  cwd: string,
  opts: { combine?: string },
  log: (m: string) => void,
): PvCompareSummary | undefined {
  const root = shadowRoot(cwd)

  // Manifest (R3): the join is manifest-driven — no manifest, no comparison.
  let manifest: PvManifest
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(root, PV_MANIFEST_NAME), "utf-8")) as PvManifest
  } catch {
    log(`pv-compare: no readable ${PV_MANIFEST_NAME} under ${SHADOW_DIR_REL} — run pv-sample first.`)
    return undefined
  }
  if (!Array.isArray(manifest?.keys?.c) || !Array.isArray(manifest.keys.notC)) {
    log(`pv-compare: ${PV_MANIFEST_NAME} is malformed (no keys.c/keys.notC arrays) — re-run pv-sample.`)
    return undefined
  }

  // Duplicate manifest keys (within OR across strata) break every count the
  // join produces — REFUSE rather than warn+dedupe: pv-sample never writes
  // duplicates, so any duplicate means a corrupted/hand-edited manifest and
  // the sample itself is suspect. (Keys are repo+sha only — safe to print.)
  const manifestKeys = [...manifest.keys.c, ...manifest.keys.notC]
  const manifestDups = duplicateKeys(manifestKeys)
  if (manifestDups.length > 0) {
    log(
      `REFUSING: ${PV_MANIFEST_NAME} has ${manifestDups.length} duplicate key(s) within/across ` +
        `strata (e.g. ${manifestDups[0]}) — the manifest is corrupt; re-run pv-sample --reset.`,
    )
    return undefined
  }

  // --combine input validated BEFORE any read/write of our own stores.
  let other: PvCountsFileParsed | undefined
  if (opts.combine !== undefined) {
    let raw: string
    try {
      raw = fs.readFileSync(opts.combine, "utf-8")
    } catch {
      log(`pv-compare: cannot read --combine file ${opts.combine}`)
      return undefined
    }
    other = parsePvCountsFile(raw)
    if (other === undefined) {
      log(
        `REFUSING: --combine — ${opts.combine} is not a valid pv-counts file ` +
          "(missing/non-integer/negative/inconsistent counts, or missing hostname/comparedAt/keys).",
      )
      return undefined
    }
    // Summing counts is only valid over DISJOINT samples — verify, don't
    // assume. Same hostname = combining a host with itself (the counts file
    // grabbed from the wrong checkout), guaranteed overlap.
    if (other.hostname === os.hostname()) {
      log(
        `REFUSING: --combine — ${opts.combine} was produced on THIS host (${other.hostname}); ` +
          "combining a host with itself double-counts its sample. Pass the OTHER host's " +
          "pv-counts.json.",
      )
      return undefined
    }
    // Belt-and-braces on the same assumption: no key the other host reports
    // may appear in this host's sample (manifest keys cover the WHOLE local
    // sample; the other file's key sets are the closest cross-host proxy).
    const localKeySet = new Set(manifestKeys)
    const overlap = Object.values(other.keys)
      .flat()
      .filter((k) => localKeySet.has(k))
    if (overlap.length > 0) {
      log(
        `REFUSING: --combine — ${overlap.length} record key(s) appear in BOTH hosts' samples ` +
          `(e.g. ${overlap[0]}); samples must be disjoint for summed counts to be valid.`,
      )
      return undefined
    }
  }

  // Both stores: lock-free read path only (report precedent — a pure read
  // never contends). The only writes below are pv-counts.json (+
  // pv-combined.json on a successful --combine).
  const realRecords = readCorpus(cwd)
  const shadowRecords = readCorpus(root)

  // Duplicate record keys WITHIN a store would make the join's Map build a
  // silent last-wins pick — REFUSE instead. Scoped to manifest keys, same
  // rationale as R3: records outside the manifest are ignored, so their
  // duplicates cannot affect the join either.
  const manifestKeySet = new Set(manifestKeys)
  for (const [label, records] of [
    ["REAL", realRecords],
    ["shadow", shadowRecords],
  ] as const) {
    const dups = duplicateKeys(records.map(recordKey).filter((k) => manifestKeySet.has(k)))
    if (dups.length > 0) {
      log(
        `REFUSING: the ${label} store has ${dups.length} duplicate record key(s) in the sample ` +
          `(e.g. ${dups[0]}) — a manifest key must resolve to exactly one record per store.`,
      )
      return undefined
    }
  }

  const comparison = comparePvRecords(manifest, realRecords, shadowRecords)
  const bar = evaluatePvBar(comparison.counts)

  const countsFile: PvCountsFile = {
    comparedAt: new Date().toISOString(),
    hostname: os.hostname(),
    counts: comparison.counts,
    keys: comparison.keys,
    bar,
  }
  const dest = path.join(root, PV_COUNTS_NAME)
  const tmp = dest + ".tmp"
  fs.writeFileSync(tmp, JSON.stringify(countsFile, null, 2) + "\n")
  fs.renameSync(tmp, dest)

  log(renderPvReport(manifest, comparison.counts, bar))
  log(`pv-compare: wrote ${PV_COUNTS_NAME} -> ${dest}`)

  if (other === undefined) return { counts: comparison.counts, bar }

  const combinedCounts = combinePvCounts(comparison.counts, other.counts)
  const combinedBar = evaluatePvBar(combinedCounts)

  // The cross-host decision is the one that matters — persist it (durable,
  // committable) rather than leaving it stdout-only.
  const combinedFile: PvCombinedFile = {
    comparedAt: countsFile.comparedAt,
    local: { hostname: countsFile.hostname, counts: comparison.counts },
    other: { hostname: other.hostname, comparedAt: other.comparedAt, counts: other.counts },
    combined: { counts: combinedCounts, bar: combinedBar },
  }
  const combinedDest = path.join(root, PV_COMBINED_NAME)
  const combinedTmp = combinedDest + ".tmp"
  fs.writeFileSync(combinedTmp, JSON.stringify(combinedFile, null, 2) + "\n")
  fs.renameSync(combinedTmp, combinedDest)

  log(
    [
      "",
      `combine — other host ${other.hostname} (comparedAt ${other.comparedAt}):`,
      `  this host:  ${renderPvCountsLine(comparison.counts)}`,
      `  other host: ${renderPvCountsLine(other.counts)}`,
      `  combined:   ${renderPvCountsLine(combinedCounts)}`,
      ...renderPvBarLines(combinedCounts, combinedBar).map((l) => `  ${l}`),
    ].join("\n"),
  )
  log(`pv-compare: wrote ${PV_COMBINED_NAME} -> ${combinedDest}`)
  return { counts: comparison.counts, bar, combined: { counts: combinedCounts, bar: combinedBar } }
}
