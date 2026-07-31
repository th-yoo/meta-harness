// km-gauge corpus-replay transcript miner (plan 2026-07-31, Task 2).
//
// Pure over already-read jsonl text: filter + record-build only. No fs, no
// subprocess — replay-cli.ts owns directory scanning, the per-repo
// gate.json floorCheck lookup, and store I/O, and hands both in as plain
// callback/value injection (floorCheckFor / now). That keeps every filter
// edge case here a same-process `mineJsonl(...)` unit test with zero
// fixture-tree setup; only the CLI wiring itself needs a real subprocess
// test.
import { createHash } from "node:crypto"
import { isTaskShaped } from "./classifier.ts"
import type { CorpusRecord } from "./corpus-store.ts"

/** string | text-blocks content extractor. Shape lifted from
 * km-crank/src/fixture-harvest.ts:33 (REIMPLEMENTED here — no cross-package
 * import, standalone-package rule): tool_result / non-"text" blocks are
 * excluded by construction (the filter keeps only blocks whose `type` is
 * exactly "text"). */
function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined
  if (Array.isArray(content)) {
    const texts = content
      .filter(
        (b): b is { type: string; text: string } =>
          typeof b === "object" &&
          b !== null &&
          (b as Record<string, unknown>).type === "text" &&
          typeof (b as Record<string, unknown>).text === "string",
      )
      .map((b) => b.text)
    return texts.length ? texts.join("\n") : undefined
  }
  return undefined
}

/** `origin.kind` is NOT a hard gate (plan 2026-07-31 T2, review round 1
 * finding): the field is a recent schema addition present on only a
 * minority of live transcripts, so `undefined !== "human"` would silently
 * discard the historical corpus the amendment exists to mine. Absent
 * origin -> line still eligible. Present origin with `kind !== "human"` ->
 * excluded (bonus signal only, never the primary gate). */
function originExcludes(origin: unknown): boolean {
  if (typeof origin !== "object" || origin === null) return false
  return (origin as { kind?: unknown }).kind !== "human"
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex")
}

export interface MineOptions {
  /** repo gate.json `.check` at mining time, "" if absent/unreadable — the
   * CLI reads this per-repo over fs; this module stays pure via injection. */
  floorCheckFor: (repo: string) => string
  /** Date.now() at mine invocation time, stamped onto every record's
   * floorCheckMinedAt (one mine run = one "as-of" moment for drift purposes). */
  now: number
}

/** One transcript JSONL file's text -> mined CorpusRecords. Filter (plan
 * verbatim): `type==="user" && !isSidechain && !isMeta && userText(content)
 * non-empty && isTaskShaped(text)`, plus the origin bonus-signal exclusion
 * above. Malformed / non-object lines, and lines missing `cwd`/`sessionId`/
 * a parseable `timestamp`, are skipped silently — same discipline as
 * corpus-store.readCorpus: one torn or short line must never take down the
 * whole scan. */
export function mineJsonl(jsonlText: string, opts: MineOptions): CorpusRecord[] {
  const out: CorpusRecord[] = []

  for (const line of jsonlText.split("\n")) {
    const trimmed = line.trim()
    if (!trimmed) continue

    let o: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(trimmed)
      if (typeof parsed !== "object" || parsed === null) continue
      o = parsed as Record<string, unknown>
    } catch {
      continue
    }

    if (o.type !== "user") continue
    if (o.isSidechain) continue
    if (o.isMeta) continue
    if (originExcludes(o.origin)) continue

    const message = o.message as Record<string, unknown> | undefined
    const text = userText(message?.content)
    if (!text) continue
    if (!isTaskShaped(text)) continue

    const repo = typeof o.cwd === "string" ? o.cwd : undefined
    const sessionId = typeof o.sessionId === "string" ? o.sessionId : undefined
    const promptTs = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN
    if (!repo || !sessionId || Number.isNaN(promptTs)) continue

    out.push({
      provenance: "transcript",
      stage: "mined",
      repo,
      sessionId,
      promptTs,
      prompt: text,
      promptSha256: sha256Hex(text),
      floorCheck: opts.floorCheckFor(repo),
      floorCheckMinedAt: opts.now,
    })
  }

  return out
}

/** Dedupe `(repo, promptSha256)` keep-earliest-`promptTs`, run across ALL
 * scanned files before the store upsert — a resumed/duplicated prompt must
 * settle on one stable promptTs/floorCheck rather than flip-flopping on
 * every re-mine depending on file scan order. */
export function dedupeEarliest(records: CorpusRecord[]): CorpusRecord[] {
  const byKey = new Map<string, CorpusRecord>()
  for (const r of records) {
    const key = JSON.stringify([r.repo, r.promptSha256])
    const prev = byKey.get(key)
    if (!prev || r.promptTs < prev.promptTs) byKey.set(key, r)
  }
  return Array.from(byKey.values())
}
