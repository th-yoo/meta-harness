// km-gauge corpus-replay batch deriver (plan 2026-07-31, Task 3).
//
// mine -> derive -> resolve -> report pipeline, stage 2: turns "mined"
// CorpusRecords into "derived" ones by running the SAME model pipeline as
// the live refiner (refiner-cli.ts) — MIRRORED, not refactored, because
// refiner-cli.ts is deployed live-path code (plan Global Constraints). Only
// its exported `extractResultText` is imported; the `callModel` subprocess
// pattern (not exported there) is copied verbatim below.
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
import { extractResultText } from "./refiner-cli.ts"
import { buildRefinerPrompt, parseRefinerOutput } from "./refiner.ts"
import { validateDerivation } from "./validate.ts"
import type { GaugeFile } from "./files.ts"
import { readCorpus, writeCorpus, upsertRecords, type CorpusRecord } from "./corpus-store.ts"

const CALL_TIMEOUT_MS = 60_000

/** Mirrors refiner-cli.ts:34-70 `callModel` — same argv shape, same
 * KM_CHILD=1, same 60s kill timeout, same env-override seams
 * (KKAMAK_GAUGE_CLAUDE_BIN / KKAMAK_GAUGE_MODEL). Copied rather than
 * imported: callModel is not exported there, and refiner-cli.ts stays
 * untouched per the plan's mirror-don't-refactor discipline. */
async function callModel(prompt: string, floorCheck: string): Promise<string | undefined> {
  const bin = process.env.KKAMAK_GAUGE_CLAUDE_BIN ?? "claude"
  const model = process.env.KKAMAK_GAUGE_MODEL ?? "haiku"

  let proc: ReturnType<typeof Bun.spawn>
  try {
    proc = Bun.spawn([bin, "-p", "--output-format", "json", "--model", model], {
      stdin: new TextEncoder().encode(buildRefinerPrompt(prompt, floorCheck)),
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, KM_CHILD: "1" },
    })
  } catch {
    return undefined
  }

  const timer = setTimeout(() => {
    try {
      proc.kill()
    } catch {
      // best-effort
    }
  }, CALL_TIMEOUT_MS)

  try {
    const [out, code] = await Promise.all([
      new Response(proc.stdout as ReadableStream<Uint8Array>).text().catch(() => ""),
      proc.exited,
    ])
    if (code !== 0) return undefined
    return out
  } catch {
    return undefined
  } finally {
    clearTimeout(timer)
  }
}

/** One "mined" CorpusRecord -> "derived" on a fully-validated success, the
 * SAME record unchanged (still stage "mined") on any upstream failure. */
export async function deriveRecord(record: CorpusRecord): Promise<CorpusRecord> {
  const started = Date.now()
  const raw = await callModel(record.prompt, record.floorCheck)
  if (raw === undefined) return record

  const derivation = parseRefinerOutput(extractResultText(raw) ?? raw)
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
    model: process.env.KKAMAK_GAUGE_MODEL ?? "haiku",
    derivationMs: Date.now() - started,
  }

  return { ...record, stage: "derived", derivation: blob }
}

export interface DeriveSummary {
  pending: number
  derived: number
  staysMined: number
}

/** Cost fence (amendment-mandated, no bypass): `go` must exactly equal the
 * CURRENT pending ("mined" stage) record count, or the batch refuses with
 * zero effect — no model calls, no store write. `go === undefined` (no
 * `--go` given) also refuses, printing the pending count so the operator
 * can size the next call. Pending records are derived SEQUENTIALLY (not in
 * parallel) — a batch is a deliberately sized, deliberately paced spend. */
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

  const results: CorpusRecord[] = []
  for (const record of pending) {
    results.push(await deriveRecord(record))
  }
  const derivedCount = results.filter((r) => r.stage === "derived").length

  const merged = upsertRecords(all, results)
  const ok = writeCorpus(cwd, merged, log)
  if (!ok) return undefined

  const summary: DeriveSummary = {
    pending: pending.length,
    derived: derivedCount,
    staysMined: pending.length - derivedCount,
  }
  log(
    `derive: ${summary.derived}/${summary.pending} derived, ${summary.staysMined} stayed mined ` +
      `(retryable); store now ${merged.length} record(s)`,
  )
  return summary
}
