/**
 * failure-retrieval.ts — relevance-ranked failure selection for the proposer.
 *
 * Replaces recency-tail-N selection (buildFailureExcerpts, squad-propose) with
 * importance × taxonomy-diversity ranking over the WHOLE failure corpus (all
 * candidate versions). Non-parametric — no embeddings, no vector store (see
 * docs/memory-landscape.md §3; explicitly-not-now §6 files-only). Plan:
 * docs/superpowers/plans/2026-07-14-failure-retrieval.md.
 *
 * The generic `selectDiverse` core is level-agnostic (role uses it; squad stays
 * minimal today; a future master/orchestrator proposer reuses it unchanged).
 */
import {
  listVersions,
  readScore,
  readDiagnosis,
  type SessionRecord,
} from "./harness-store.ts"

const DAY_MS = 86_400_000

// ── Generic diversity selector ──────────────────────────────────────────────

export interface RankItem<T> {
  item: T
  bucket: string
  importance: number
}

/**
 * Deterministic round-robin across buckets. Buckets are ordered by descending
 * max-importance; round r takes the r-th-best item of each bucket in that
 * order until maxN reached. A bucket exhausted mid-rotation is skipped and
 * rotation continues. Degenerate: all-one-bucket → importance sort;
 * maxN≥available → all; importance ties → stable (input order).
 */
export function selectDiverse<T>(items: RankItem<T>[], maxN: number): T[] {
  if (items.length === 0 || maxN <= 0) return []

  // Stable group by bucket, each bucket's items sorted by descending importance
  // (stable: equal-importance keeps input order).
  const buckets = new Map<string, RankItem<T>[]>()
  for (const it of items) {
    const arr = buckets.get(it.bucket)
    if (arr) arr.push(it)
    else buckets.set(it.bucket, [it])
  }
  for (const arr of buckets.values()) {
    arr.sort((a, b) => b.importance - a.importance)
  }

  // Bucket visitation order: descending max-importance (each bucket's best).
  const order = [...buckets.values()].sort(
    (a, b) => (b[0]?.importance ?? -Infinity) - (a[0]?.importance ?? -Infinity),
  )

  const out: T[] = []
  const total = items.length
  const limit = Math.min(maxN, total)
  for (let round = 0; out.length < limit; round++) {
    let progressed = false
    for (const arr of order) {
      if (round < arr.length) {
        out.push(arr[round]!.item)
        progressed = true
        if (out.length >= limit) break
      }
    }
    if (!progressed) break // all buckets exhausted (safety; limit≤total prevents it)
  }
  return out
}

// ── Role adapter ────────────────────────────────────────────────────────────

export interface RankedFailure {
  version: string
  sessionID: string
  taxonomy: string
  importance: number
}

export interface RoleRankOpts {
  /** INERT here — rankRoleFailures ALWAYS returns the full list. Consumed only
   * by the buildFailureExcerpts caller's over-select loop. Present so the
   * merged FailureExcerptOpts bundle can carry it. */
  maxSessions?: number
  recencyHalfLifeDays?: number
}

interface DiagnosisFailure {
  sessionID?: unknown
  taxonomy?: unknown
}

/** Flat sessionID→taxonomy map scanning EVERY version's diagnosis.json.
 * diagnosis for candidate vN documents the PRIOR active version's sessions,
 * NOT vN's own — so the lookup must never be scoped to a session's own
 * version. Defensive against unvalidated LLM JSON. */
function globalTaxonomyMap(storeRoot: string): Map<string, string> {
  const map = new Map<string, string>()
  for (const v of listVersions(storeRoot)) {
    const diag = readDiagnosis<{ failures?: unknown }>(storeRoot, v)
    const failures = diag && Array.isArray(diag.failures) ? (diag.failures as DiagnosisFailure[]) : []
    for (const f of failures) {
      if (!f || typeof f !== "object") continue
      const id = typeof f.sessionID === "string" ? f.sessionID : null
      const tax = typeof f.taxonomy === "string" ? f.taxonomy.trim().toLowerCase() : null
      if (id && tax) map.set(id, tax)
    }
  }
  return map
}

function totalErrors(s: SessionRecord): number {
  return Object.values(s.toolUsage ?? {}).reduce((acc, t) => acc + (t?.errors ?? 0), 0)
}

/** All three signals are optional on real on-disk data despite the TS type;
 * missing → that term is 0. `refNowMs` = newest timestamp in the corpus (or
 * Date.now) so recency is deterministic/testable. */
function importanceOf(s: SessionRecord, refNowMs: number, halfLifeDays: number): number {
  const tsMs = s.timestamp ? Date.parse(s.timestamp) : NaN
  const recency = Number.isFinite(tsMs)
    ? Math.exp((-Math.LN2 * Math.max(0, refNowMs - tsMs)) / (halfLifeDays * DAY_MS))
    : 0
  const toolError = 1 - Math.exp(-totalErrors(s) / 3)
  const judgeConf = s.judge?.confidence ?? 0
  return (recency + toolError + judgeConf) / 3
}

/**
 * Full ranked+diversified list of failing sessions across ALL versions. NOT
 * truncated (over-select headroom for the caller to skip pruned trajectories).
 */
export function rankRoleFailures(storeRoot: string, opts: RoleRankOpts = {}): RankedFailure[] {
  // Clamp to a positive floor: a <=0 (or NaN) half-life makes importanceOf
  // divide by <=0 → NaN importance, which selectDiverse's `??`/subtraction
  // comparators silently treat as insertion-order (review R1#1). Exposed via
  // RoleRankOpts, so guard even though no current caller sets it.
  const rawHalfLife = opts.recencyHalfLifeDays
  const halfLife = rawHalfLife !== undefined && rawHalfLife > 0 ? rawHalfLife : 14
  const taxMap = globalTaxonomyMap(storeRoot)

  const gathered: { version: string; session: SessionRecord }[] = []
  for (const v of listVersions(storeRoot)) {
    for (const s of readScore(storeRoot, v).sessions) {
      if (s.passed === false) gathered.push({ version: v, session: s })
    }
  }
  if (gathered.length === 0) return []

  const refNowMs = gathered.reduce((mx, g) => {
    const t = g.session.timestamp ? Date.parse(g.session.timestamp) : NaN
    return Number.isFinite(t) && t > mx ? t : mx
  }, 0) || Date.now()

  const items: RankItem<RankedFailure>[] = gathered.map((g) => {
    const taxonomy = taxMap.get(g.session.sessionID) ?? "untriaged"
    const importance = importanceOf(g.session, refNowMs, halfLife)
    return {
      item: { version: g.version, sessionID: g.session.sessionID, taxonomy, importance },
      bucket: taxonomy,
      importance,
    }
  })

  return selectDiverse(items, Infinity)
}

// ── Squad adapter (minimal — no diversity axis today) ───────────────────────

export interface SquadOutcomeLike {
  sliceId: string
  passed: boolean
  steps: number
  ts: string
  escalationType?: string
}

export interface RankedSquadFailure {
  sliceId: string
  steps: number
  ts: string
  count: number
}

/**
 * Failing-only, grouped by sliceId (keep most-recent, carry `count` as a
 * repeat-failure boost), sorted (count desc, recency desc), capped at maxN.
 * No bucket machinery: every recorded failure is escalationType "Exhausted"
 * and evidence is single-version — no real diversity axis yet.
 */
export function rankSquadFailures(sessions: SquadOutcomeLike[], maxN: number): RankedSquadFailure[] {
  const bySlice = new Map<string, RankedSquadFailure>()
  for (const s of sessions) {
    if (s.passed !== false) continue
    const prev = bySlice.get(s.sliceId)
    if (!prev) {
      bySlice.set(s.sliceId, { sliceId: s.sliceId, steps: s.steps, ts: s.ts, count: 1 })
    } else {
      prev.count++
      if ((s.ts ?? "") > (prev.ts ?? "")) {
        prev.steps = s.steps
        prev.ts = s.ts
      }
    }
  }
  return [...bySlice.values()]
    .sort((a, b) => b.count - a.count || (b.ts ?? "").localeCompare(a.ts ?? ""))
    .slice(0, Math.max(0, maxN))
}
