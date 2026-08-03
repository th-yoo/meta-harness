// km-gauge channel batch driver (plan 2026-08-03-gauge-verification-channel-
// ladder.md Task 4; pre-reg spec §2/§4). IO lives HERE — channel.ts stays
// pure. Structure mirrors corpus-replay.ts's runDerive exactly: pre-lock
// fence -> acquireCorpusLock -> fence re-checked under the lock -> paced
// sequential model calls (refreshCorpusLock after each) -> ONE writeCorpus
// at batch end ({lockHeld: true}) -> releaseCorpusLock in a finally.
//
// Spend shape (spec §2): A1/B/C records stamp deterministically via
// channelForClass — ZERO model calls. Only A2/D records lacking
// `derivation.channel` are model work (the C2/C3/C4 split this instrument
// measures), and the cost fence sizes `--go` against exactly that count.
// A failed/malformed refinement leaves its record UNSTAMPED — retryable,
// never fabricated (parseChannelOutput's undefined discipline).
//
// Model: `claude-opus-5` — channel classification is judgment
// (sonnet=subject, opus=judgment, plan Global Constraints), following
// transport.ts callModelSdkLabel's precedent: NEVER routed through
// KKAMAK_GAUGE_MODEL, so a stray env var armed for the live refiner can
// never silently retarget this instrument.
//
// Transport note: `callChannelModel` below rides transport.ts's shared
// `sdkCall` plumbing (OAuth-only authToken + apiKey:null,
// KKAMAK_GAUGE_SDK_BASE_URL seam, maxRetries:0, oauth beta header) with
// this instrument's own knobs — 60s timeout, CHANNEL_SCHEMA structured
// output, 2048 max tokens — same fail-open-on-anything discipline:
// undefined on any failure.
import type { GaugePromptClass } from "../types.ts"
import type { GaugeFile } from "./files.ts"
import {
  channelForClass,
  buildChannelPrompt,
  parseChannelOutput,
  type ChannelOrExempt,
} from "./channel.ts"
import { resolveModelId, sdkCall } from "./transport.ts"
import {
  readCorpus,
  writeCorpus,
  upsertRecords,
  acquireCorpusLock,
  refreshCorpusLock,
  releaseCorpusLock,
  type CorpusRecord,
} from "./corpus-store.ts"

export interface ChannelWork {
  modelWork: unknown[]   // A2/D lacking derivation.channel
  stampOnly: unknown[]   // A1/B/C lacking derivation.channel
  done: number           // already carrying derivation.channel
}

export function selectChannelWork(records: readonly unknown[]): ChannelWork {
  const out: ChannelWork = { modelWork: [], stampOnly: [], done: 0 }
  for (const r of records) {
    const d = (r as { derivation?: { class?: string; channel?: string } }).derivation
    if (!d?.class) continue
    if (d.channel) { out.done++; continue }
    const direct = channelForClass(d.class as never)
    if (direct === null) out.modelWork.push(r)
    else out.stampOnly.push(r)
  }
  return out
}

const CHANNEL_MODEL = "claude-opus-5"
const CALL_TIMEOUT_MS = 60_000
const MAX_TOKENS = 2048

/** JSON schema for the channel refinement output (channel.ts
 * ChannelRefinement / parseChannelOutput — same shape-parity discipline as
 * transport.ts DERIVATION_SCHEMA/LABEL_SCHEMA). Refinement set only: C1 is
 * never refinable (extraction already ruled it out upstream). Nullable
 * `reason` is anyOf — the API rejects union type arrays. */
export const CHANNEL_SCHEMA = {
  type: "object",
  properties: {
    channel: { type: "string", enum: ["C2", "C3", "C4"] },
    reason: { anyOf: [{ type: "string" }, { type: "null" }] },
  },
  required: ["channel", "reason"],
  additionalProperties: false,
} as const

/** ONE channel refinement over the direct API: returns the model's JSON
 * text (feed to parseChannelOutput), undefined on ANY failure — same
 * env seams as transport.ts (KKAMAK_GAUGE_SDK_BASE_URL /
 * KKAMAK_GAUGE_AUTH_TOKEN) so tests can stub the whole call over localhost
 * with zero real model calls. Thin wrapper over transport.ts `sdkCall`,
 * carrying this instrument's knobs: CHANNEL_SCHEMA, 60s, 2048 tokens. */
export async function callChannelModel(
  messageText: string,
  env: Record<string, string | undefined>,
): Promise<string | undefined> {
  return sdkCall(messageText, resolveModelId(CHANNEL_MODEL), env, {}, {
    schema: CHANNEL_SCHEMA as unknown as Record<string, unknown>,
    maxTokens: MAX_TOKENS,
    timeoutMs: CALL_TIMEOUT_MS,
  })
}

/** `derivation.channel` stamp — a NEW optional key on the persisted
 * GaugeFile blob (plan Task 4 Interfaces: records gain
 * `derivation.channel?: "C1"|"C2"|"C3"|"C4"|"exempt"`). files.ts is outside
 * this task's touch set, so the widened shape lives here as a cast — the
 * stored blob is still GaugeFile-plus-one-additive-key, never a rewrite. */
function stampChannel(record: CorpusRecord, channel: ChannelOrExempt): CorpusRecord {
  return { ...record, derivation: { ...record.derivation!, channel } as GaugeFile }
}

/** One A2/D record -> channel-stamped on a parsed refinement, undefined on
 * any failure (transport failure or malformed output) — the record stays
 * unstamped, retryable, never fabricated. */
async function refineRecord(record: CorpusRecord): Promise<CorpusRecord | undefined> {
  const raw = await callChannelModel(buildChannelPrompt(record.prompt), process.env)
  if (raw === undefined) return undefined
  const refinement = parseChannelOutput(raw)
  if (!refinement) return undefined
  return stampChannel(record, refinement.channel)
}

export interface ChannelSummary {
  go: number
  refined: number
  stampedDeterministic: number
  stayedPending: number
}

/** Cost fence (derive-fence discipline, corpus-replay.ts runDerive): `go`
 * must exactly equal the CURRENT model-work count (A2/D records lacking
 * `derivation.channel`) or the batch refuses with zero effect — no model
 * calls, no store write. `go === undefined` also refuses, printing the
 * count so the operator can size the next call. Deterministic stamps ride
 * along free — they are never part of the fence (zero spend).
 *
 * Lock discipline (same as runDerive): lock acquired AFTER the outer fence
 * passes but BEFORE any model call, fence re-checked against a FRESH read
 * UNDER the lock (closing the window where a concurrent mine/derive lands
 * between the pre-lock read and acquisition — checkFenceUnderLock's shape,
 * re-stated here because its predicate is stage==="mined", not
 * channel-pending), held across the whole batch (refreshCorpusLock after
 * each record), ONE writeCorpus at batch end under {lockHeld: true},
 * released only in a finally. */
export async function runChannel(
  cwd: string,
  go: number | undefined,
  log: (m: string) => void,
): Promise<ChannelSummary | undefined> {
  const work = selectChannelWork(readCorpus(cwd))

  if (go === undefined) {
    log(
      `REFUSING: channel — no --go given; ${work.modelWork.length} record(s) need model ` +
        `refinement (${work.stampOnly.length} deterministic stamp(s) ride along free). ` +
        `Re-run with --go ${work.modelWork.length} to refine all of them.`,
    )
    return undefined
  }
  if (go !== work.modelWork.length) {
    log(
      `REFUSING: channel — --go ${go} does not match the current model-refinement count ` +
        `${work.modelWork.length}. Re-run with --go ${work.modelWork.length}.`,
    )
    return undefined
  }

  if (!acquireCorpusLock(cwd, log)) return undefined
  try {
    const freshAll = readCorpus(cwd)
    const fresh = selectChannelWork(freshAll)
    if (fresh.modelWork.length !== go) {
      log(
        `REFUSING: channel — model-refinement count changed under lock (now ` +
          `${fresh.modelWork.length}, expected ${go}); a concurrent writer landed. ` +
          `Re-run with --go ${fresh.modelWork.length}.`,
      )
      return undefined
    }

    const results: CorpusRecord[] = []
    let refined = 0
    for (const record of fresh.modelWork as CorpusRecord[]) {
      const stamped = await refineRecord(record)
      if (stamped) {
        results.push(stamped)
        refined++
      }
      refreshCorpusLock(cwd)
    }

    let stampedDeterministic = 0
    for (const record of fresh.stampOnly as CorpusRecord[]) {
      const direct = channelForClass(record.derivation!.class as GaugePromptClass)
      if (direct === null) continue // unreachable by selection — defensive
      results.push(stampChannel(record, direct))
      stampedDeterministic++
    }

    const merged = upsertRecords(freshAll, results)
    const ok = writeCorpus(cwd, merged, log, { lockHeld: true })
    if (!ok) return undefined

    const summary: ChannelSummary = {
      go,
      refined,
      stampedDeterministic,
      stayedPending: go - refined,
    }
    log(
      `channel: ${summary.refined}/${summary.go} refined, ` +
        `${summary.stampedDeterministic} stamped deterministic, ` +
        `${summary.stayedPending} stayed pending (retryable)`,
    )
    return summary
  } finally {
    releaseCorpusLock(cwd)
  }
}
