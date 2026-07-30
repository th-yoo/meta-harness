/** Phase 2 harvest core — PURE (no fs, no subprocess): parse fixture-ref
 * ndjson, join with the Phase 1 check-output sidecar, extract prompt
 * context from a Claude Code transcript JSONL string. Host-local inputs;
 * never exported (F2). */
import type { CheckOutputRecord } from "./check-output"

export interface FixtureRefRecord { /* byte-compatible re-declaration of Task 1's shape (standalone-package rule) */ ts: number; sessionID: string; round: number; check: string; headSha: string; treeSha: string; ref: string; transcriptPath?: string; bail?: string }

export function parseFixtureRefRecords(text: string): FixtureRefRecord[] {
  const out: FixtureRefRecord[] = []
  for (const ln of text.split("\n")) {
    if (!ln.trim()) continue
    try {
      const o = JSON.parse(ln) as Record<string, unknown>
      if (typeof o.ts !== "number" || typeof o.sessionID !== "string" || typeof o.round !== "number"
        || typeof o.check !== "string" || typeof o.headSha !== "string" || typeof o.treeSha !== "string"
        || typeof o.ref !== "string") continue
      out.push(o as unknown as FixtureRefRecord)
    } catch { /* skip malformed */ }
  }
  return out
}

export interface HarvestJoin { ref: FixtureRefRecord; excerpt?: string; elidedChars?: number }

export function joinFixture(ref: FixtureRefRecord, sidecar: CheckOutputRecord[]): HarvestJoin {
  const m = sidecar.find((r) => r.sessionID === ref.sessionID && r.ts === ref.ts && r.round === ref.round)
  return m ? { ref, excerpt: m.excerpt, ...(m.elidedChars !== undefined ? { elidedChars: m.elidedChars } : {}) } : { ref }
}

export interface PromptContext { firstUser?: string; lastUser?: string }

function userText(content: unknown): string | undefined {
  if (typeof content === "string") return content || undefined
  if (Array.isArray(content)) {
    const texts = content
      .filter((b): b is { type: string; text: string } =>
        typeof b === "object" && b !== null && (b as Record<string, unknown>).type === "text"
        && typeof (b as Record<string, unknown>).text === "string")
      .map((b) => b.text)
    return texts.length ? texts.join("\n") : undefined
  }
  return undefined
}

export function extractPromptContext(jsonlText: string, beforeTs: number): PromptContext {
  let firstUser: string | undefined
  let lastUser: string | undefined
  for (const ln of jsonlText.split("\n")) {
    if (!ln.trim()) continue
    try {
      const o = JSON.parse(ln) as Record<string, unknown>
      if (o.type !== "user") continue
      const ts = typeof o.timestamp === "string" ? Date.parse(o.timestamp) : NaN
      if (!Number.isNaN(ts) && ts > beforeTs) continue
      const msg = o.message as Record<string, unknown> | undefined
      const text = userText(msg?.content)
      if (!text) continue
      if (firstUser === undefined) firstUser = text
      lastUser = text
    } catch { /* skip */ }
  }
  return { firstUser, lastUser }
}
