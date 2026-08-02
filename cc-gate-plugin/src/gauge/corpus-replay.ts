// km-gauge corpus-replay batch deriver (plan 2026-07-31, Task 3).
//
// mine -> derive -> resolve -> report pipeline, stage 2: turns "mined"
// CorpusRecords into "derived" ones by running the SAME model pipeline as
// the live refiner (refiner-cli.ts). §6c amendment (2026-08-02): both paths
// now share the ONE exported SDK transport (transport.ts callModelSdk) —
// the earlier mirror-don't-refactor CLI-subprocess copy is gone with the
// CLI transport itself; live and replay derivations are the same call by
// construction, not by mirroring discipline.
//
// Persisted derivation blob is full GaugeFile-shaped (files.ts:25-41) per
// the pinned corpus fill policy (plan, Task 1 design paragraph): `n` is
// always 1 (no session ordinal exists on a corpus record — `promptTs`
// already carries the when-provenance), `ts` = Date.now() at this derive
// call (mirrors refiner-cli.ts:116), `model`/`derivationMs` measured here at
// replay time — so a later evaluateGauge shim is a straight cast, never a
// synthesized placeholder.
//
// Any failure upstream of a validated derivation (spawn failure, non-zero
// exit, unparseable/malformed model text) leaves the record UNCHANGED —
// still stage "mined", retryable, no partial writes. A successfully
// SHAPE-parsed derivation that validateDerivation itself downgrades
// (C -> D, etc.) is still a complete, persistable result: validation is the
// code-side judge, not a failure mode.
import { parseRefinerOutput } from "./refiner.ts"
import { callModelSdk, resolveModelId } from "./transport.ts"
import { validateDerivation } from "./validate.ts"
import type { GaugeFile } from "./files.ts"
import {
  readCorpus,
  writeCorpus,
  upsertRecords,
  acquireCorpusLock,
  refreshCorpusLock,
  releaseCorpusLock,
  type CorpusRecord,
} from "./corpus-store.ts"

/** One "mined" CorpusRecord -> "derived" on a fully-validated success, the
 * SAME record unchanged (still stage "mined") on any upstream failure. */
export async function deriveRecord(record: CorpusRecord): Promise<CorpusRecord> {
  const started = Date.now()
  const raw = await callModelSdk(record.prompt, record.floorCheck, process.env)
  if (raw === undefined) return record

  const derivation = parseRefinerOutput(raw)
  if (!derivation) return record

  // The persisted blob is the VALIDATED result — same discipline as
  // refiner-cli.ts: validation runs pre-persist so downstream consumers can
  // trust a "derived" record as-is.
  const validated = validateDerivation({
    derivation,
    prompt: record.prompt,
    floorCheck: record.floorCheck,
    repoRoot: record.repo,
  })

  const blob: GaugeFile = {
    goalSummary: validated.goalSummary,
    criteria: validated.criteria,
    confidence: validated.confidence,
    class: validated.class,
    reason: validated.reason,
    horizon: validated.horizon,
    check: validated.check,
    ...(validated.downgraded ? { downgraded: validated.downgraded } : {}),
    v: 2,
    sessionID: record.sessionId,
    n: 1,
    ts: Date.now(),
    // Resolved API id actually sent (transport.ts), not the CLI alias.
    model: resolveModelId(process.env.KKAMAK_GAUGE_MODEL ?? "haiku"),
    derivationMs: Date.now() - started,
    transport: "sdk",
  }

  return { ...record, stage: "derived", derivation: blob }
}

export interface DeriveSummary {
  pending: number
  derived: number
  staysMined: number
}

export interface FenceCheck {
  all: CorpusRecord[]
  pending: CorpusRecord[]
}

/** Re-read the corpus and re-check the `go` fence against a FRESH pending
 * count. Meant to be called AFTER the lock is held (Task 3 review finding
 * 1: a `mine` can land between the CLI's first, pre-lock read and lock
 * acquisition; re-checking under the lock closes that window before any
 * model call happens). Extracted as its own exported function — rather
 * than inlined in runDerive — so this re-check is directly unit-testable:
 * seed a corpus, pass the outer fence, mutate the store (simulating a mine
 * landing in that window), then call this and observe it reject the
 * now-stale `go` with zero model calls. */
export function checkFenceUnderLock(
  cwd: string,
  go: number,
  log: (m: string) => void,
): FenceCheck | undefined {
  const all = readCorpus(cwd)
  const pending = all.filter((r) => r.stage === "mined")
  if (pending.length !== go) {
    log(
      `REFUSING: derive — pending count changed under lock (now ${pending.length}, ` +
        `expected ${go}); a concurrent mine landed. Re-run with --go ${pending.length}.`,
    )
    return undefined
  }
  return { all, pending }
}

/** Cost fence (amendment-mandated, no bypass): `go` must exactly equal the
 * CURRENT pending ("mined" stage) record count, or the batch refuses with
 * zero effect — no model calls, no store write. `go === undefined` (no
 * `--go` given) also refuses, printing the pending count so the operator
 * can size the next call. Pending records are derived SEQUENTIALLY (not in
 * parallel) — a batch is a deliberately sized, deliberately paced spend.
 *
 * Lock discipline (Task 3 review, findings 1+2): the corpus lock is
 * acquired AFTER the fence passes but BEFORE any model call, and held for
 * the entire derive batch (`refreshCorpusLock` after each record guards
 * against the lock going stale mid-batch), released only in a `finally` so
 * a thrown model error can't leak it. The pending set is re-read and the
 * fence re-checked UNDER the lock (`checkFenceUnderLock`) before spending
 * anything, closing the window where a concurrent `mine` lands between the
 * first (pre-lock) read and lock acquisition. Net effect: model spend only
 * ever happens while holding the lock, so the post-spend `writeCorpus(...,
 * {lockHeld: true})` can never hit contention — a spent-but-discarded
 * refusal is no longer possible. */
export async function runDerive(
  cwd: string,
  go: number | undefined,
  log: (m: string) => void,
): Promise<DeriveSummary | undefined> {
  const all = readCorpus(cwd)
  const pending = all.filter((r) => r.stage === "mined")

  if (go === undefined) {
    log(
      `REFUSING: derive — no --go given; ${pending.length} pending record(s). ` +
        `Re-run with --go ${pending.length} to derive all of them.`,
    )
    return undefined
  }
  if (go !== pending.length) {
    log(
      `REFUSING: derive — --go ${go} does not match the current pending count ` +
        `${pending.length}. Re-run with --go ${pending.length}.`,
    )
    return undefined
  }

  if (!acquireCorpusLock(cwd, log)) return undefined
  try {
    const fenced = checkFenceUnderLock(cwd, go, log)
    if (!fenced) return undefined
    const { all: freshAll, pending: freshPending } = fenced

    const results: CorpusRecord[] = []
    for (const record of freshPending) {
      results.push(await deriveRecord(record))
      refreshCorpusLock(cwd)
    }
    const derivedCount = results.filter((r) => r.stage === "derived").length

    const merged = upsertRecords(freshAll, results)
    const ok = writeCorpus(cwd, merged, log, { lockHeld: true })
    if (!ok) return undefined

    const summary: DeriveSummary = {
      pending: freshPending.length,
      derived: derivedCount,
      staysMined: freshPending.length - derivedCount,
    }
    log(
      `derive: ${summary.derived}/${summary.pending} derived, ${summary.staysMined} stayed mined ` +
        `(retryable); store now ${merged.length} record(s)`,
    )
    return summary
  } finally {
    releaseCorpusLock(cwd)
  }
}
