// km-gauge paired-validation shadow-store tooling (§6c amendment, approved
// c22fbd0 — docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor
// -preregistration.md lines 443-529; build plan docs/superpowers/plans/
// 2026-08-03-paired-validation-script.md, T1: `pv-sample`).
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
