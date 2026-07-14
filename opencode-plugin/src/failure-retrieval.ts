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
 * Deterministic importance-vs-diversity blend (greedy, no RNG). Each bucket's
 * items are sorted by descending importance; at each step the globally
 * highest-scoring remaining item is picked, where a candidate's effective
 * score is `importance * penalty^k` (k = items ALREADY picked from that
 * candidate's bucket so far — 0th pick full weight, 1st repeat discounted
 * once, 2nd repeat discounted twice, ...).
 *
 * This makes importance genuinely compete with diversity instead of
 * subordinating it: two strong failures in the same taxonomy bucket can still
 * outrank one weak failure in a fresh bucket (importance wins), while a fresh
 * bucket's top item still tends to beat an already-picked bucket's next item
 * (diversity still rewarded) — unlike the old diversity-FIRST round-robin,
 * which took every bucket's best before any bucket's 2nd pick regardless of
 * how the importances compared (review R2#1: "diversity-in-name").
 *
 * `penalty` defaults to 0.5 — halving per repeat is steep enough that a
 * bucket's 3rd+ pick rarely beats a fresh bucket, but gentle enough that a
 * strong 2nd pick (importance close to the bucket's best) can still beat a
 * mediocre fresh bucket, matching "importance × taxonomy-diversity" as an
 * actual product of both signals rather than a lexicographic tiebreak.
 *
 * Ties break deterministically: (a) higher raw (undiscounted) importance,
 * then (b) the bucket's overall visitation rank (descending max-importance,
 * mirroring the old round-robin's bucket order) — never RNG or Map iteration
 * order. Degenerate: all-one-bucket → importance sort (only one bucket ever
 * competes, so scores never need discounting to pick the next item);
 * maxN≥available → all; importance ties within a bucket → stable (input
 * order).
 */
export function selectDiverse<T>(items: RankItem<T>[], maxN: number, penalty = 0.5): T[] {
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

  // Bucket visitation-rank order: descending max-importance (each bucket's
  // best) — used only as the final tiebreak below, and to iterate buckets in
  // a fixed, deterministic order every round.
  const bucketOrder = [...buckets.entries()].sort(
    (a, b) => (b[1][0]?.importance ?? -Infinity) - (a[1][0]?.importance ?? -Infinity),
  )

  const pointer = new Map<string, number>() // next unpicked index within bucket
  const pickedCount = new Map<string, number>() // items already picked from bucket
  for (const [bucket] of bucketOrder) {
    pointer.set(bucket, 0)
    pickedCount.set(bucket, 0)
  }

  const out: T[] = []
  const limit = Math.min(maxN, items.length)
  while (out.length < limit) {
    let bestBucket: string | null = null
    let bestScore = -Infinity
    let bestImportance = -Infinity
    for (const [bucket, arr] of bucketOrder) {
      const idx = pointer.get(bucket)!
      if (idx >= arr.length) continue // bucket exhausted
      const candidate = arr[idx]!
      const score = candidate.importance * Math.pow(penalty, pickedCount.get(bucket)!)
      const better =
        score > bestScore ||
        (score === bestScore && candidate.importance > bestImportance)
      if (better) {
        bestScore = score
        bestImportance = candidate.importance
        bestBucket = bucket
      }
      // else: on a full tie (score AND importance equal), keep the earlier
      // bucket in bucketOrder — deterministic, no further tiebreak needed.
    }
    if (bestBucket === null) break // all buckets exhausted (safety; limit≤items.length prevents this)
    const arr = buckets.get(bestBucket)!
    const idx = pointer.get(bestBucket)!
    out.push(arr[idx]!.item)
    pointer.set(bestBucket, idx + 1)
    pickedCount.set(bestBucket, pickedCount.get(bestBucket)! + 1)
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
 * version. Defensive against unvalidated LLM JSON.
 *
 * M2 (known, deliberately NOT hardened): keyed by sessionID alone → if a
 * sessionID is ever reused across DIFFERENT actual sessions (unrelated to the
 * cross-version diagnosis references above), the later write wins and could
 * mislabel a bucket. Not fixed with a `${version}|${sessionID}` key here
 * because diagnosis.json entries carry no version field for the session they
 * describe (by design — see above), so there is no version to scope the key
 * to without breaking the intentional cross-version lookup; the consumer
 * (rankRoleFailures below) only ever looks up by bare sessionID too. Mitigant
 * in practice: sessionIDs are opencode/TB2 session identifiers, which are
 * effectively globally unique (not sequential/reused per-version counters),
 * so a real collision is not expected. Revisit if diagnosis.json ever gains a
 * version field for the session it's describing. */
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
