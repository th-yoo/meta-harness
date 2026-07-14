import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  selectDiverse,
  rankRoleFailures,
  rankSquadFailures,
  type RankItem,
  type SquadOutcomeLike,
} from "../src/failure-retrieval.ts"
import { buildFailureExcerpts } from "../src/harness-store.ts"

// Extended seedCandidate: cross-version-UNIQUE sessionIDs (#5) + optional
// per-session toolUsage/timestamp/judge/taxonomy overrides (#8). A "failure"
// entry may set `taxOfVersion` → we write it into THIS version's diagnosis.json
// keyed by the given sessionID (which typically belongs to ANOTHER version —
// the B1 version-shift).
interface SeedSession {
  sessionID: string
  passed?: boolean
  timestamp?: string
  summary?: string
  toolUsage?: Record<string, { calls: number; errors: number }>
  judge?: { passed: boolean; confidence?: number; mode: "shadow" | "prefill" }
  traj?: boolean
}
interface SeedOpts {
  sessions?: SeedSession[]
  // diagnosis rows written INTO this version's diagnosis.json (sessionID may
  // reference a session recorded under a different version — B1).
  diagnosis?: { sessionID: string; taxonomy: string }[]
}

function seed(storeRoot: string, version: string, opts: SeedOpts = {}): void {
  const dir = join(storeRoot, "candidates", version)
  mkdirSync(join(dir, "traj"), { recursive: true })
  const sessions = (opts.sessions ?? []).map((s) => ({
    sessionID: s.sessionID,
    passed: s.passed ?? false,
    note: "",
    turnCount: 1,
    timestamp: s.timestamp ?? "",
    summary: s.summary ?? `session ${s.sessionID}`,
    model: "m",
    variant: "",
    toolUsage: s.toolUsage ?? {},
    ...(s.judge ? { judge: s.judge } : {}),
  }))
  const nFail = sessions.filter((s) => !s.passed).length
  writeFileSync(join(dir, "score.json"), JSON.stringify({ version, nPass: sessions.length - nFail, nFail, sessions }))
  for (const s of opts.sessions ?? []) {
    if (s.traj) writeFileSync(join(dir, "traj", `${s.sessionID}.ndjson`), `{"t":"text","text":"boom ${s.sessionID}"}\n`)
  }
  if (opts.diagnosis) {
    writeFileSync(join(dir, "diagnosis.json"), JSON.stringify({ failures: opts.diagnosis }))
  }
}

let store: string
beforeEach(() => { store = mkdtempSync(join(tmpdir(), "mh-failretr-")) })
afterEach(() => { rmSync(store, { recursive: true, force: true }) })

describe("selectDiverse", () => {
  const mk = (bucket: string, importance: number, id: string): RankItem<string> => ({ item: id, bucket, importance })

  test("covers distinct buckets before doubling up", () => {
    const items = [
      mk("a", 0.9, "a1"), mk("a", 0.8, "a2"), mk("a", 0.7, "a3"),
      mk("b", 0.5, "b1"), mk("c", 0.4, "c1"),
    ]
    // round0: a1(a),b1(b),c1(c) → then round1: a2 → top-4 = a1,b1,c1,a2
    expect(selectDiverse(items, 4)).toEqual(["a1", "b1", "c1", "a2"])
  })

  test("all-one-bucket degenerates to importance sort", () => {
    const items = [mk("x", 0.2, "lo"), mk("x", 0.9, "hi"), mk("x", 0.5, "mid")]
    expect(selectDiverse(items, 3)).toEqual(["hi", "mid", "lo"])
  })

  test("maxN >= available returns all; empty → []", () => {
    const items = [mk("a", 0.9, "a1"), mk("b", 0.5, "b1")]
    // No .sort(): assert the round-robin ORDER (buckets by descending
    // max-importance → a before b), not just set membership (review R1 gap).
    expect(selectDiverse(items, 99)).toEqual(["a1", "b1"])
    expect(selectDiverse([], 5)).toEqual([])
    expect(selectDiverse(items, 0)).toEqual([])
  })

  test("importance ties keep stable input order", () => {
    const items = [mk("a", 0.5, "first"), mk("a", 0.5, "second")]
    expect(selectDiverse(items, 2)).toEqual(["first", "second"])
  })
})

describe("rankRoleFailures — B1 global taxonomy map", () => {
  test("diagnosis in vN keyed to v(N-1)'s sessionIDs still resolves taxonomy", () => {
    // v1 has the failing sessions; v2's diagnosis.json documents THEM (version-shift).
    seed(store, "v1", { sessions: [
      { sessionID: "ses_v1a", traj: true },
      { sessionID: "ses_v1b", traj: true },
    ] })
    seed(store, "v2", {
      sessions: [{ sessionID: "ses_v2a", traj: true }],
      diagnosis: [
        { sessionID: "ses_v1a", taxonomy: "verifier-mismatch" },
        { sessionID: "ses_v1b", taxonomy: "tool-misuse" },
      ],
    })
    const ranked = rankRoleFailures(store)
    const byId = new Map(ranked.map((r) => [r.sessionID, r]))
    // v1 sessions get taxonomy from v2's diagnosis (global map, not per-version).
    expect(byId.get("ses_v1a")?.taxonomy).toBe("verifier-mismatch")
    expect(byId.get("ses_v1b")?.taxonomy).toBe("tool-misuse")
    // v2's own session has no diagnosis anywhere → untriaged.
    expect(byId.get("ses_v2a")?.taxonomy).toBe("untriaged")
    // spans both versions
    expect(new Set(ranked.map((r) => r.version))).toEqual(new Set(["v1", "v2"]))
  })

  test("normalizes taxonomy (trim + lowercase)", () => {
    seed(store, "v1", { sessions: [{ sessionID: "s1" }] })
    seed(store, "v2", { diagnosis: [{ sessionID: "s1", taxonomy: "  Verifier-Mismatch  " }] })
    expect(rankRoleFailures(store)[0]!.taxonomy).toBe("verifier-mismatch")
  })
})

describe("rankRoleFailures — defensiveness (#8, C3) + signals", () => {
  test("session with NO toolUsage/timestamp/judge ranks without throwing", () => {
    seed(store, "v1", { sessions: [{ sessionID: "bare" }] }) // seed writes toolUsage:{} — override to truly absent:
    // rewrite score.json with a field-less session
    writeFileSync(join(store, "candidates", "v1", "score.json"),
      JSON.stringify({ version: "v1", nPass: 0, nFail: 1, sessions: [{ sessionID: "bare", passed: false, summary: "x" }] }))
    expect(() => rankRoleFailures(store)).not.toThrow()
    expect(rankRoleFailures(store)[0]!.sessionID).toBe("bare")
  })

  test("malformed diagnosis (failures absent / non-array) → untriaged, no throw", () => {
    seed(store, "v1", { sessions: [{ sessionID: "s1" }] })
    writeFileSync(join(store, "candidates", "v1", "diagnosis.json"), JSON.stringify({ failures: "not-an-array" }))
    expect(rankRoleFailures(store)[0]!.taxonomy).toBe("untriaged")
  })

  test("importance ranks tool-error-rich + recent + judge-confident failures higher", () => {
    const now = "2026-07-14T12:00:00Z"
    const old = "2026-01-01T00:00:00Z"
    seed(store, "v1", { sessions: [
      { sessionID: "rich", timestamp: now, toolUsage: { bash: { calls: 5, errors: 5 } }, judge: { passed: false, confidence: 0.9, mode: "shadow" } },
      { sessionID: "thin", timestamp: old },
    ] })
    const ranked = rankRoleFailures(store)
    expect(ranked[0]!.sessionID).toBe("rich")
    expect(ranked[0]!.importance).toBeGreaterThan(ranked[1]!.importance)
  })

  test("empty store → []", () => {
    expect(rankRoleFailures(store)).toEqual([])
  })

  test("recencyHalfLifeDays <= 0 / NaN is clamped — no NaN importance (R1#1)", () => {
    seed(store, "v1", { sessions: [
      { sessionID: "recent", timestamp: "2026-07-14T12:00:00Z" },
      { sessionID: "old", timestamp: "2026-01-01T00:00:00Z" },
    ] })
    for (const hl of [0, -5, Number.NaN]) {
      const ranked = rankRoleFailures(store, { recencyHalfLifeDays: hl })
      for (const r of ranked) expect(Number.isFinite(r.importance)).toBe(true)
    }
    // clamps to the default (14 days) → the recent failure still ranks first.
    expect(rankRoleFailures(store, { recencyHalfLifeDays: 0 })[0]!.sessionID).toBe("recent")
  })
})

describe("buildFailureExcerpts — ranked, multi-version, E1", () => {
  test("excerpts span ≥2 versions with taxonomy titles + (no label) fallback", () => {
    seed(store, "v1", { sessions: [{ sessionID: "ses_v1a", traj: true }] })
    seed(store, "v2", {
      sessions: [{ sessionID: "ses_v2a", summary: "", traj: true }], // empty label → B6 fallback
      diagnosis: [{ sessionID: "ses_v1a", taxonomy: "verifier-mismatch" }],
    })
    const out = buildFailureExcerpts(store, { maxSessions: 5 })
    expect(out).toContain("ses_v1a [verifier-mismatch]")
    expect(out).toContain("ses_v2a [untriaged]")
    expect(out).toContain("(no label)")           // ses_v2a has empty note+summary (B6)
    expect(out).toContain("boom ses_v1a")          // trajectory body present
  })

  test("E1 — a ranked session whose trajectory is pruned/absent is skipped", () => {
    // Two failing sessions; only the LOWER-importance one has a trajectory on
    // disk. maxSessions=1 must still yield the one with a real trajectory, not
    // a blank block for the trajectory-less higher-ranked session.
    seed(store, "v1", { sessions: [
      { sessionID: "no_traj", timestamp: "2026-07-14T12:00:00Z", toolUsage: { b: { calls: 9, errors: 9 } } }, // high importance, NO traj
      { sessionID: "has_traj", timestamp: "2026-01-01T00:00:00Z", traj: true },                                // low importance, has traj
    ] })
    const out = buildFailureExcerpts(store, { maxSessions: 1 })
    expect(out).toContain("has_traj")
    expect(out).not.toContain("no_traj")
    expect(out).not.toBe("")
  })
})

describe("rankSquadFailures — minimal", () => {
  const s = (sliceId: string, passed: boolean, ts: string, steps = 1): SquadOutcomeLike =>
    ({ sliceId, passed, ts, steps, escalationType: passed ? undefined : "Exhausted" })

  test("failing-only, dedupe by sliceId with count boost, sort count-then-recency", () => {
    const out = rankSquadFailures([
      s("slice-A", false, "2026-07-14T01:00:00Z"),
      s("slice-A", false, "2026-07-14T03:00:00Z"), // A fails twice → count 2, latest ts
      s("slice-B", false, "2026-07-14T05:00:00Z"), // B fails once but newest
      s("slice-C", true, "2026-07-14T06:00:00Z"),  // passed → excluded
    ], 10)
    expect(out.map((o) => o.sliceId)).toEqual(["slice-A", "slice-B"]) // A first (count 2 > 1)
    expect(out[0]!.count).toBe(2)
    expect(out[0]!.ts).toBe("2026-07-14T03:00:00Z") // most-recent kept
  })

  test("caps at maxN; empty → []", () => {
    expect(rankSquadFailures([s("x", false, "t1"), s("y", false, "t2")], 1)).toHaveLength(1)
    expect(rankSquadFailures([], 5)).toEqual([])
  })
})
