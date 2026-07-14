# Plan: Relevance-ranked failure retrieval for the proposer

## Context

**Why.** The proposer learns from *failure evidence*, but today it sees a
recency tail only: `buildFailureExcerpts(layer.root, activeVer)`
(`opencode-plugin/src/harness-store.ts:413`, called at `src/propose.ts:583`)
excerpts full trajectories for just the **active version's last-3 failing
sessions**. Every failure from a *prior* candidate version is invisible to the
excerpt (it survives only as a one-line trace in `buildProposerContext`). The
squad proposer is the same shape (`src/fleet/squad-propose.ts:148`,
`.slice(-MAX_SESSIONS_SHOWN=20)`). This is the #1 gap named in
`docs/memory-landscape.md §3`: recency-window, not relevance.

**What we're building.** A non-parametric (no embeddings, no new deps)
**importance × taxonomy-diversity ranker** over the *whole* failure corpus
(all candidate versions), replacing both recency-tail choke points. Diversity
matters more than similarity here: the propose flow has no "query task," so the
goal is a *representative spread* of distinct failure modes, not N near-dupes of
the most recent one. The live proof already exists in the smoke store —
`mh-evaluator` v1/v2/v3 each failed with a distinct pattern; today a v4 propose
would only see v3's last-3.

**Outcome.** The proposer's diagnosis draws on the best/most-diverse failures
across the store's history, so candidate generation converges on fewer
generations (the v1→v2→v3 arc would have had richer evidence sooner).

**Decisions taken (user + architect review):** widen to all versions + rank
(role side — the real payoff); build the `selectDiverse` core **level-agnostic**
for the future master/orchestrator proposer (§9.3). Squad side is **minimal**
(recency + dedupe-by-sliceId, single version) — it has no real diversity axis or
multi-version corpus yet (see Scope). MCP exposure = increment 2.

## Design

### New module: `opencode-plugin/src/failure-retrieval.ts`

A generic diversity+importance selector plus two thin adapters.

```ts
// Generic core — role uses it now; squad/master reuse it LATER when a real
// second bucket dimension exists (see Scope note — squad has none today).
export interface RankItem<T> { item: T; bucket: string; importance: number }
export function selectDiverse<T>(items: RankItem<T>[], maxN: number): T[]
//   Deterministic round-robin: order buckets by descending max-importance
//   within each; round r takes the r-th-best item of each bucket in that
//   bucket order until maxN reached. A bucket exhausted mid-rotation is
//   simply skipped and rotation continues (#6). Degenerate (E3): all-one-
//   bucket → importance sort; maxN≥available → all; importance ties → stable
//   (input order = listVersions ascending then score.json append order).

// Role adapter.
export interface RankedFailure { version: string; sessionID: string; taxonomy: string; importance: number }
export interface RoleRankOpts { maxSessions?: number; recencyHalfLifeDays?: number }
export function rankRoleFailures(storeRoot: string, opts?: RoleRankOpts): RankedFailure[]
//   Returns the FULL ranked+diversified list (not truncated) so the caller can
//   over-select and skip pruned-trajectory sessions (E1).
//   1. GLOBAL taxonomy map (B1 — load-bearing): scan readDiagnosis(w) for
//      EVERY w in listVersions(storeRoot), merge all `failures[].sessionID →
//      taxonomy` into ONE flat Map. diagnosis.json for candidate vN documents
//      the PRIOR active version's sessions, NOT vN's own (verified: mh-evaluator
//      v3/diagnosis.json holds v2's session IDs) — so a per-version join matches
//      ~nothing. Never scope the lookup to the session's own version.
//      Defensive (C3): `failures` may be absent/non-array/LLM-malformed; skip
//      bad entries; normalize taxonomy (trim + lowercase) before bucketing.
//   2. gather failing sessions: for each v in listVersions → readScore(v) →
//      s.passed===false, tagged {version:v, session}.
//   NOTE (finding #2): opts.maxSessions is INERT inside rankRoleFailures —
//   this fn ALWAYS returns the full list (selectDiverse Infinity). maxSessions
//   is consumed ONLY by the buildFailureExcerpts caller's over-select loop.
//   Do NOT wire maxSessions into selectDiverse's maxN — that removes the skip
//   headroom and silently reintroduces E1.
//   3. importance = weighted sum of 0..1-normalized signals (weights = module
//      consts, default equal 1/3 each). EVERY field is optional on real
//      on-disk data despite the TS type (buildProposerContext:1316 /
//      buildPromotionEvidence:1073 both guard toolUsage) — guard ALL three,
//      missing → that term = 0 (#8, same class as C3/E1):
//        recency   = timestamp ? exp(-ln2 * ageDays / halfLifeDays) : 0   (halfLife 14d; missing ts → 0 = oldest)
//        toolError = 1 - exp(-totalErrors / 3)   (saturating; bounds unbounded count)
//                    totalErrors = Σ Object.values(session.toolUsage ?? {}).map(t=>t.errors)  (#7,#8 — ?? {} guard)
//        judgeConf = session.judge?.confidence ?? 0                  (already 0..1)
//   4. bucket = globalMap.get(sessionID) ?? "untriaged" (E2 — untriaged is
//      first-class; expect it to dominate until diagnoses accumulate).
//   5. selectDiverse(…, Infinity) → full diversified order.

// Squad adapter — MINIMAL (see Scope). No diversity: squad failures are 100%
// escalationType "Exhausted" (B2: only done/Exhausted are recorded), and
// evidence is single-version (B3). So recency + dedupe only, no selectDiverse.
export interface RankedSquadFailure { sliceId: string; steps: number; ts: string; count: number }
export function rankSquadFailures(sessions: SquadOutcomeRecord[], maxN: number): RankedSquadFailure[]
//   failing (passed=false) only; group by sliceId (keep most-recent, carry
//   `count` = # failures for that slice as a repeat-signal boost); sort by
//   (count desc, recency desc); take maxN. No bucket machinery.
//   RENDER (#3): each line hardcodes the B2 invariants so the untouched B4
//   assertion `toContain("escalationType=Exhausted")` still holds:
//   `- sliceId=${sliceId} passed=false steps=${steps} escalationType=Exhausted` + (count>1 ? ` ×${count}` : "").
```

### Scope (per architect (D) — YAGNI; matches explicitly-not-now §2.2 criterion b: "pays off at a scale we haven't reached")

The **role side is the real payoff**: B1 global-map fix + widen-across-versions
+ taxonomy-diversity. The **squad side stays minimal** (recency + dedupe-by-
sliceId, single active version) because today it has neither a real diversity
axis (all failures are `Exhausted` — B2) nor multiple squad-def versions to
widen over (B3). The generic `selectDiverse` core is still built (role uses it)
and is ready for squad/master when a real bucket dimension appears — but it is
NOT force-fit onto the squad side now. Widening the squad corpus across
squad-def versions is deferred until >1 squad-def candidate exists.

### Wiring

- **`harness-store.ts` `buildFailureExcerpts`** — change signature
  `(storeRoot, version, opts)` → `(storeRoot, opts)` (the `version` param is
  obsolete once we span all versions). Body: `rankRoleFailures(storeRoot, opts)`
  → walk the ranked list, for each `readTrajectory(storeRoot, r.version,
  r.sessionID)`, **skip entries whose trajectory is empty/pruned (E1)**, take
  the first `maxSessions` non-empty, apply the existing head/tail/
  `maxCharsPerSession` elision unchanged, title
  `### ${sessionID} [${taxonomy}] — ${note || summary || "(no label)"}`
  (**B6**: keep the existing `"(no label)"` fallback from `:433`). Only caller
  is `src/propose.ts:583` — drop the `activeVer` arg there.
- **Opts merge (C4):** `buildFailureExcerpts`'s single `opts` object is one
  merged interface = `FailureExcerptOpts` (headEvents/tailEvents/
  maxCharsPerSession, consumed locally) **extended** with `RoleRankOpts`
  (recencyHalfLifeDays used by the ranker; maxSessions present in the bundle
  passed to `rankRoleFailures` but INERT there per #2 — consumed only by this
  caller's over-select loop). Not two hand-threaded objects.
- **`squad-propose.ts` `buildSquadProposerPrompt`** — replace the
  `.slice(-MAX_SESSIONS_SHOWN)` block (~:147-152) with
  `rankSquadFailures(evidence.sessions, MAX_SESSIONS_SHOWN)`, render per the
  `RankedSquadFailure` RENDER spec above. **#4 — do NOT lose the pass/fail
  ratio:** filtering to failing-only removes the proposer's only view of
  fitness, but a flow-knob proposer reasons on the *rate* (done=good vs
  Exhausted=bad). Add one summary line ABOVE the failing list from the
  already-computed `evidence.nPass`/`evidence.nFail`:
  `outcomes: ${nPass} done / ${nFail} exhausted (${rate}%) over ${nPass+nFail} runs`.
- **Config (optional, minimal):** none required for v1 — merged-opts defaults
  suffice and mirror the existing `FailureExcerptOpts` default idiom. No
  `config.json` knob this pass.

### Correctness edges (verified against source — must handle)

- **E1 — pruned trajectories.** `pruneTrajectories` (`harness-store.ts:378`,
  called with defaults keepFailures=20/keepPasses=5 **per version**) deletes old
  `traj/*.ndjson` while the session row persists in `score.json`. So a
  high-ranked *older* failure may have NO trajectory on disk →
  `readTrajectory` returns `[]`. `buildFailureExcerpts` must **over-select and
  skip** sessions whose trajectory is empty/missing (rank a pool larger than
  `maxSessions`, take the first `maxSessions` that actually have trajectory
  content), not emit blank blocks. The effective excerpt corpus is therefore
  "all versions' *un-pruned* trajectory-backed failures" — still far wider than
  active-last-3, but bounded by prune policy (honest framing).
- **E2 — partial taxonomy coverage.** `diagnosis.json` tags only the sessions
  the proposer actually diagnosed (and early/legacy candidate versions may have
  NO `diagnosis.json` at all — `readDiagnosis` tolerates absence). So most
  failing sessions have no taxonomy early on. `"untriaged"` must be a
  first-class bucket; expect diversity to be untriaged-dominated at first and
  sharpen as diagnoses accumulate. Join key `diagnosis.failures[].sessionID →
  SessionRecord.sessionID` is correct but PARTIAL — never assume full coverage.
- **E3 — `selectDiverse` degenerate cases (specify).** all-one-bucket →
  behaves as pure importance-sort; empty input → `[]`; `maxN >= available` →
  return all (importance-ordered); importance ties → stable order (input order,
  which is version-then-append order). Round-robin visits buckets by
  descending max-importance-in-bucket.
- **E4 — `buildProposerContext` one-liners unchanged.** It already lists ALL
  sessions across ALL versions as one-line traces (`:1302-1329`, uncapped) — so
  the proposer already *sees that* older failures exist; this change adds
  FULL-TRAJECTORY detail for the ranked diverse top-N. Framing: "rich detail on
  the most instructive diverse failures," not "reveal hidden failures." (The
  uncapped one-liner list is its own latent bloat at huge N — out of scope,
  note only.)

### Reuse (found in exploration — do not reinvent)
`listVersions`, `readScore`, `readDiagnosis`, `readTrajectory`, `fmtTrajEvent`,
`FailureExcerptOpts` head/tail/char-cap logic (all `harness-store.ts`);
`FAILURE_TAXONOMY` (`propose.ts:60`); `SquadOutcomeRecord` (`squad-def.ts:253`).
No existing ranking/similarity helper exists — the generic core is new.

## Tasks (TDD)

1. **`failure-retrieval.ts` generic core + role adapter** + `test/failure-retrieval.test.ts`.
   Tests (hermetic tmp storeRoot, `seedCandidate` idiom from
   `proposer-store-access.test.ts:20-43`, extended to write `diagnosis.json` +
   multi-version, **#5**: the extended helper MUST emit cross-version-UNIQUE
   sessionIDs — `seedCandidate` numbers per-version from `ses_0`, so v1/v2 would
   collide and the B1 test could pass for the wrong reason; **#8**: `seedCandidate`
   today writes only `{sessionID, passed, summary}` — extend its opts to accept
   per-session `toolUsage`/`timestamp`/`judge` overrides, both to exercise
   recency/toolError/judgeConf meaningfully AND to prove the missing-field
   guards (a session with NO toolUsage/timestamp/judge must rank without throwing)):
   **B1** — diagnosis for vN keyed to a DIFFERENT version's
   sessionIDs still resolves via the global map (the load-bearing test);
   `selectDiverse` covers distinct buckets before doubling; importance orders
   within bucket; recency decay + toolError saturation + judgeConf; missing/
   malformed diagnosis (`failures` absent/non-array) → "untriaged", no throw
   (C3); taxonomy normalized (trim/case); empty store → []; **E3** (all-one-
   bucket → importance sort; maxN≥available → all; ties → stable order).
2. **Rewire `buildFailureExcerpts`** (merged opts, C4) + update `propose.ts:583`
   call; add a direct `buildFailureExcerpts` test (none exists today): excerpt
   pulls from ≥2 versions, titles carry taxonomy + keep `"(no label)"` fallback
   (B6), and **E1** — a ranked session whose `traj/*.ndjson` is absent is skipped
   (not a blank block), next non-empty ranked session used instead.
3. **Squad adapter (minimal) + rewire `squad-propose.ts`** + extend
   `test/fleet-squad-propose.test.ts`: rankSquadFailures keeps failing-only,
   dedupes same-sliceId with `count` boost, sorts count-then-recency, caps N.
   **B4** — the existing assertion at `fleet-squad-propose.test.ts:191-210`
   records a `passed:true` `sliceId=s1` and asserts `toContain("sliceId=s1")`;
   filtering to failing-only removes it — this assertion MUST be updated (make
   s1 a failing outcome, or assert on a seeded failing slice).
4. **Doc**: update `docs/memory-landscape.md §3` (relevance-retrieval partially
   adopted: importance×diversity role-side done; squad minimal; embedding-
   similarity + task-id deferred). **B5** — `explicitly-not-now.md` has NO
   recency-window entry; do NOT "retire" one — instead ADD a §5 row: "proposer
   failure retrieval was recency-tail; now importance×diversity role-side;
   semantic-similarity/vector deferred (trigger + prefer-embedded/MCP per §…)".
5. **Discoverability / recall (the index side — do NOT skip).** Externalized
   docs are unreachable after a context reset unless the auto-loaded index
   points at them. So, on completion:
   - Persist this plan into the repo: `docs/superpowers/plans/2026-07-14-failure-retrieval.md`
     (git-tracked, stable name — the `~/.claude/plans/*` scratch file does not survive).
   - Create a stable `docs/INDEX.md` — a one-line-per-doc map of the canonical
     design docs (fleet spec, memory-landscape, improvement-loops,
     explicitly-not-now, this plan). Git is the durable backstop.
   - Add pointers in `~/.claude/.../memory/MEMORY.md` (the auto-loaded index) to
     `docs/INDEX.md` + the fleet spec, so a fresh/cleared session recalls that
     the design work exists and where to find it. MEMORY.md currently has only
     3 entries, none pointing at this session's design docs — that is the gap.

## Verification

- `cd opencode-plugin && bunx tsc --noEmit && bun test` (targeted files + full
  suite green; current baseline 865 pass).
- **Live proof on the smoke store** (real multi-version fixture): the
  `~/.mh-fleet-smoke` `mh-evaluator` store has v2/v3 with `recordSession`'d
  failures + `diagnosis.json`. **C7 caveat:** `v1/score.json` is
  `{nFail:0,sessions:[]}` despite orphan traj files (smoke wrote them directly,
  bypassing `recordSession`), so `readScore(v1)` enumerates zero v1 failures —
  expected, not a ranker bug. Proof target: after the fix, one propose → confirm
  `buildFailureExcerpts` spans **v2 AND v3** failures and that v3's failing
  sessions resolve a taxonomy **via the global map** (B1) rather than all
  "untriaged". (Temporary debug print of the excerpt; ≤ one opus propose.)

## Increment 2 (next plan, NOT this change): read-only MCP server

Decided: build the ranker now (this plan); expose it over MCP next. The
`failure-retrieval.ts` module is the implementation the MCP server wraps —
this plan is its prerequisite.

**`mh-experience` MCP server** (Bun, stdio) — read-only, wraps harness-store
readers + the new ranker. Turns retrieval from a pre-stuffed prompt section
into agentic **memory-as-a-tool** (lit: 2601.05960; MemGPT/Letta lineage).

- Tools: `rank_failures(store, {taxonomy?, k, weights?})` → `RankedFailure[]`;
  `get_trajectory(store, version, sessionID)`; `get_diagnosis(store, version)`;
  `query_experience(store, {bucket?, k})`.
- Resources: `experience://roles/<agent>/failures`, `experience://squads/<type>/outcomes`.
- Payoffs: (a) **transport-neutral** — a proposer under claude-code OR opencode
  calls it identically, retiring the opencode-hardcoded retrieval edge
  (`explicitly-not-now.md §5`); (b) **on-demand context** — proposer pulls the
  relevant slice when needed vs front-loaded excerpt; (c) sits alongside
  engram/kratos in the user's existing MCP memory stack.
- Then rewire the proposer to CALL the tool (keep `buildFailureExcerpts` direct
  call as the fallback path).
- **Write primitives stay CLI** (propose/score/activate/squad-run): stateful,
  long-running (containers, minutes — bad request/response fit), security-
  sensitive, no second consumer yet. Not exposed over MCP until those change.

## Deferred (follow-ups, neither increment)
- **Task-identity on `SessionRecord`** (TB2 task name) → enables true same-task
  *similarity* retrieval role-side; schema change touching `recordSession` + all
  record sites. Separate increment.
- **Lexical/embedding similarity + vector store** (AssoMem/SwiftMem full form)
  — only worth it once retrieval becomes *query-driven semantic similarity*
  (task-identity present, "find failures whose content resembles THIS") over a
  large corpus. NOT needed for the current regime: structured signals
  (taxonomy/tool-errors/recency = ORDER BY, not nearest-neighbor) + diversity
  (coverage, not similarity) + small corpus. A vector DB is also heavier than
  the SQLite already rejected in §6 (files-only decision). When triggered,
  prefer (a) an embedded vector index (sqlite-vec-style, keeps the zero-server
  ethos) or (b) leaning on the existing engram/kratos memory MCPs (which do
  embedding retrieval internally) — do NOT stand up a standalone vector DB.
- **Master/orchestrator wiring** — the generic `selectDiverse` core is built to
  serve it; wire when the master proposer ships (§9.3). MCP makes this a tool
  call, not a spawn.
