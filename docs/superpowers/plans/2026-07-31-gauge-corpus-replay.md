# Gauge Corpus-Replay Tooling Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task.

**Goal:** Implement the corpus-replay amendment's build items (transcript miner, replay runner, execution-state resolver, provenance-split report) — gauge pre-reg amendment `d869660`, corpus-transcript lane.

## Context

The pre-verdict amendment (`d869660`, gauge v2 pre-reg lines 168-250) registered an offline corpus-replay channel so gauge's M1v2 exam (class-C executable precision ≥90%, floor ≥5) becomes reachable despite live class-C starvation (1 of 72 gauge-classified). This build implements the amendment's point-8 items: transcript miner, replay runner, execution-state resolver, plus the provenance-split report. Corpus-bench (TB2) lane deferred — schema reserves the provenance value only. First actual replay batch = separate sized go (`--go <n>` cost fence). All files in `cc-gate-plugin/src/gauge/` (outside MECHANISM_PATHS — F1 safe); corpus store `.km/gauge-corpus/` host-local, never in km-sensors-sync FILES (F2 tripwire test).

## Global Constraints

- F1: nothing under `cc-gate-plugin/src/core/`, `vendor/`, or the four `minimal/` MECHANISM_PATHS files; all new files in `cc-gate-plugin/src/gauge/` (+ `test/`).
- F2: `.km/gauge-corpus/` NEVER enters `scripts/km-sensors-sync.sh` FILES — tripwire test (fixture-ref.test.ts:185-190 precedent).
- Amendment conformance is LAW (spec lines 168-250): provenance field, pool-eligibility resolution order, point-4 report form, `--go <n>` cost fence, report-never-consumes banner.
- Zero real model calls in tests (stub `KKAMAK_GAUGE_CLAUDE_BIN`); no ambient model spend (mine/resolve/report model-free; derive gated).
- Check budget 30_000ms pinned (= GAUGE_CHECK_TIMEOUT_MS, hook-cli.ts:36) — never the 60s model budget, never 300s.
- Mirror, don't refactor, deployed live-path files (refiner-cli.ts, evaluate.ts, score.ts stay untouched).
- Suites green per task: `cd cc-gate-plugin && bun test && bunx tsc --noEmit`.
- Guardrail: live dedup key `(sessionID, gauge.n)` never reused on corpus records — corpus identity is `(repo, promptSha256)`.

## Pipeline

mine → derive → resolve → report; single store `.km/gauge-corpus/records.ndjson`; stage field mined|derived|resolved.

---

### Task 1: Corpus store + schema + lockfile + F2 tripwire

**File:** `cc-gate-plugin/src/gauge/corpus-store.ts` (+ its test file `cc-gate-plugin/test/corpus-store.test.ts`)

**Design (verbatim from the architect-reviewed plan):**

`CorpusRecord` (v1: provenance, stage mined|derived|resolved, repo, sessionId, promptTs, prompt+promptSha256, floorCheck+floorCheckMinedAt, derivation?, state?, exec?, poolEligible?) + ndjson read/atomic-rewrite; store = `.km/gauge-corpus/records.ndjson`, idempotent on `(repo, promptSha256)`. The `derivation` blob is persisted **full-`GaugeFile`-shaped** (files.ts:25-41: v/sessionID/n/ts/model/derivationMs + payload; corpus fill policy pinned: `n` always `1` — no session ordinal exists; `ts` = `Date.now()` at derive call, mirroring refiner-cli.ts:116 — `promptTs` already carries the when-provenance; `model`/`derivationMs` measured at replay) so T4's `evaluateGauge` shim is a straight cast, no synthesized placeholders at eval time. **Casing boundary pinned:** the raw transcript JSONL key is `sessionId` (lowercase d — verified live) while every internal schema here uses `sessionID`; mine reads `o.sessionId`, `CorpusRecord.sessionId` keeps the raw casing, and the rename to `sessionID` happens ONLY at the two consumption points (GaugeFile-shaped blob construction; fixture-ref join key). A `o.sessionID` typo in the miner reads `undefined` from untyped JSON and silently kills join option (i) for every record — tsc cannot catch it; T2 asserts a mined record's `sessionId` equals the fixture's known id. **Locking:** every store rewrite takes `.km/gauge-corpus/.lock` (mkdir-exclusive, pid+ts content, stale >10min) and REFUSES with a message on contention (km-sensors-sync.sh refusal-discipline precedent) — atomic full-rewrite is read-modify-write; two overlapping invocations would otherwise silently lose updates.

**Tests (must-cover):**

corpus-store + schema + F2 tripwire (fixture-ref.test.ts:185-190 precedent) + lockfile contention test (two overlapping rewrites: second refuses, no lost update; stale-lock takeover). Pure, no subprocess.

---

### Task 2: Transcript miner + mine subcommand

**File:** `cc-gate-plugin/src/gauge/corpus-mine.ts` (+ its test file `cc-gate-plugin/test/corpus-mine.test.ts`; plus thin `cc-gate-plugin/src/gauge/replay-cli.ts` entry growth per subcommand)

**Design (verbatim from the architect-reviewed plan):**

transcript JSONL → mined records. Filter: `type==="user" && !isSidechain && !isMeta && userText(content) non-empty && isTaskShaped(text)` (classifier.ts:25). **`origin.kind` is NOT a hard gate** — the field is a recent schema addition present in only ~19 of ~195 transcripts on this host (review round 1 finding: `undefined !== "human"` would silently discard the historical corpus the amendment exists to mine); when `origin` IS present, `origin.kind !== "human"` excludes the line (bonus signal only). `userText()` shape lifted from km-crank fixture-harvest.ts:33 (string | text-blocks; tool_result blocks excluded by construction). Source `~/.claude/projects/<slug>/*.jsonl` (override `KKAMAK_CLAUDE_PROJECTS_DIR`); repo = line `cwd`; dedupe `(repo, sha256(prompt))` keep-earliest-ts; floorCheck = repo gate.json check at mining time ("" if absent), drift caveat recorded.

**Tests (must-cover):**

corpus-mine + `mine` (synthetic JSONL fixtures: human / sidechain / meta / non-task / array-content / `origin:{kind:"coordinator"}` excluded-when-present / origin-ABSENT line still mined (the no-hard-gate assertion); dedupe-earliest; floorCheck present/absent; sessionId casing assertion; real-subprocess CLI test via `KKAMAK_CLAUDE_PROJECTS_DIR`).

---

### Task 3: Batch deriver + derive subcommand (cost-fenced)

**File:** `cc-gate-plugin/src/gauge/corpus-replay.ts` (+ its test file `cc-gate-plugin/test/corpus-replay.test.ts`; plus thin `cc-gate-plugin/src/gauge/replay-cli.ts` entry growth per subcommand)

**Design (verbatim from the architect-reviewed plan):**

derive stage: mirror refiner-cli.ts:34-70 `callModel` (~15 lines: `claude -p --output-format json --model haiku`, stdin=`buildRefinerPrompt(prompt, floorCheck)` refiner.ts:27, `KM_CHILD=1`, 60s model timeout, env bins `KKAMAK_GAUGE_CLAUDE_BIN`/`KKAMAK_GAUGE_MODEL`) → `extractResultText` (refiner-cli.ts:22, exported) → `parseRefinerOutput` (refiner.ts:68) → `validateDerivation({derivation, prompt, floorCheck, repoRoot})` (validate.ts:317; repoRoot string-only, deleted repos fine). Mirrored, NOT refactored — refiner-cli is deployed live-path code. Cost fence: `derive --go <n>` refuses unless n == pending count.

**Tests (must-cover):**

corpus-replay + `derive` (stub `KKAMAK_GAUGE_CLAUDE_BIN` bash emitting the `claude -p` JSON envelope — gauge-refiner-cli.test.ts:39-53 precedent; malformed output → stays `stage:"mined"`; `--go` mismatch refuses).

---

### Task 4: Execution-state resolver + resolve subcommand

**File:** `cc-gate-plugin/src/gauge/state-resolve.ts` (+ its test file `cc-gate-plugin/test/state-resolve.test.ts`; plus thin `cc-gate-plugin/src/gauge/replay-cli.ts` entry growth per subcommand)

**Design (verbatim from the architect-reviewed plan):**

amendment point-2 order: (i) `.km/fixture-refs.ndjson` join — pinned predicate: for the record's session (join on the record's `sessionId`, renamed at this boundary), the fixture-ref with the SMALLEST `ts ≥ promptTs` within 24h (fixture-ref `ts` is block-time, promptTs is submission-time — exact equality would never fire), **AND no other completed cycle of the same session falls strictly between `promptTs` and that ref's `ts` — bounded against the SENSOR STREAM (`.km/gate-outcomes.ndjson` lines for that sessionID), not against mined records:** the sensor stream records every Stop cycle including non-task-shaped turns the miner filtered out, so a filler turn's block cannot be misattributed to an earlier mined prompt (a mined-records-only bound would be blind to exactly those turns). Without this tightening, an earlier non-blocking prompt would steal a later unrelated prompt's block state (misattribution vs the amendment's "same-cycle" framing). `state.joinKind` is a NEW sibling field beside `state.kind` (never overloading it): `"clean"` when zero cycles intervene, `"nearest"` when the bound passed but ≥1 non-cycle-producing turn may still sit between (fast-path turns emit no line — the honest residual, now auditable per-record); `git cat-file -e` verify, pruned/no-match → fall through; (ii) first commit committer-ts ≥ cycle ts, ≤7d, same host as cycle sensor-line `host`; (iii) none → descriptive-only. Materialization (BOTH tree + commit cases): `git archive <sha> | tar -x -C <dir>` **as ONE raw `Bun.spawn(["bash","-c",...])` shell pipe — NEVER through `GitRunner`/`bunGitRunner`, whose `.text()` capture UTF-8-decodes and corrupts the binary tar stream** (GitRunner reuse reserved for text-output calls: cat-file/init/add/commit) — to mkdtemp + `git init && git add -A && commit` synthetic commit (git-invoking checks parse instead of exit-128; REJECTED worktree — can't take tree objects, shares live object store = mutation risk) + `bun install` if lockfile (120s setup budget; failure → `state.error`, descriptive-only, never an M1v2 miss) → `runCheck(check, dir, 30_000)` — **30s pinned = GAUGE_CHECK_TIMEOUT_MS (hook-cli.ts:36) for live comparability** — via `evaluateGauge(shim, {ran:false}, injected)` (evaluate.ts:19), shim = straight cast of the stored GaugeFile-shaped derivation blob, so guard-refusal/126/127-unrunnable/124-executable-fail semantics are byte-identical to live; `finally` rmSync temp (writing checks disposable by construction).

**Tests (must-cover):**

state-resolve + `resolve` (scratch repos: fixture-ref path, commit-window/host match+mismatch, none, pruned-ref fallthrough, misattribution guard — two mined prompts one session, later one blocks: EARLIER prompt must NOT take the ref, later one must; PLUS the non-mined-turn case: a sensor cycle line (non-task-shaped turn) between an early mined prompt and the ref also blocks the match (sensor-stream bound, not mined-records bound); joinKind clean-vs-nearest assertions; cleanup after timeout AND after writing check, install-skip, evaluateGauge semantics delegation).

---

### Task 5: Report subcommand (provenance-split M1v2)

**File:** `cc-gate-plugin/src/gauge/replay-cli.ts` (+ its test file `cc-gate-plugin/test/replay-cli.test.ts`; plus thin `cc-gate-plugin/src/gauge/replay-cli.ts` entry growth per subcommand)

**Design (verbatim from the architect-reviewed plan):**

thin `import.meta.main`-guarded entry, subcommands mine|derive|resolve|report. `report`: read-only. **Live a/b tally implements the spec's OWN amended M1v2 definition (lineage clause (c), spec lines 115-119), which a naive line count violates:** class-C sensor lines are DEDUPED by `(sessionID, gauge.n)` taking the TERMINAL line (two-strike multi-turn derivations emit two lines per derivation, shadow.ts:64-69), and passthrough-only lines (`horizon==="multi-turn" && rounds.length===0`, no `pass` field, shadow.ts:82-100 — never executed) are EXCLUDED from the denominator; a = deduped class-C with `executable:true`, b = deduped non-passthrough class-C. (score.ts's existing GaugeScore has this same gap today — report fixes its own tally, does not touch score.ts.) Corpus c/d = poolEligible `exec.executable`/total. Pooled line EXACT amendment point-4 form + floor verdict (≥5 pool, ≥1 live; all-corpus = "reportable, cannot satisfy §3 M1v2 leg"); descriptive class-rate table by provenance; banner restating points 5/7 (report never consumes §3; pooled pass = pilot design may be WRITTEN only).

**Tests (must-cover):**

`report` (fixture streams+corpus → exact pooled string, floor rules, zero writes; MUST-COVER: two-strike double-line deduped to one derivation by `(sessionID, gauge.n)` terminal line, and passthrough-only line excluded from the denominator — synthetic stream fixtures mirroring shadow.ts's real line shapes).

---

## Pinned risks (bind every task)

Guardrail: the live dedup key `(sessionID, gauge.n)` is NEVER reused on corpus records (all corpus derivations carry `n:1`, so it would collide session-wide) — corpus identity is `(repo, promptSha256)`, and the report's dedup helper stays live-stream-only by construction.


bun-install failures and materialization errors are descriptive-only, never M1v2 misses; floorCheck mining-time drift recorded per-record + report footnote; resume-duplicated prompts deduped; git-history-dependent checks under synthetic commit = stated comparability caveat (mechanical property only); 30s check budget ≠ 60s model budget, never conflated; no ambient model spend anywhere (mine/resolve/report are model-free; derive gated).

## Verification

T1-T5 test suites as above (all real-subprocess/scratch-repo, stub model bin — zero real model calls in tests); final: full cc-gate-plugin suite + tsc, F1 `git log` empty over MECHANISM_PATHS, F2 grep, then a live smoke `mine` over this host's real transcripts (model-free) reporting corpus size — the sized `derive --go <n>` batch remains a separate user go per the amendment's cost fence.