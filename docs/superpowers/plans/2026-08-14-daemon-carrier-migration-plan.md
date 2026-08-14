# Daemon carrier migration — implementation plan + task DAG (two-session allocation)

## Context

Proven contamination: `claude -p` children inherit CC's system prompt, repo CLAUDE.md, hooks, and plugin surface — both crank proposer transcripts carried "CAVEMAN MODE ACTIVE". User ruled: production LLM seats (judge, proposer/promoter/curator) move to **cc-api-daemon** (toolless, pin `33f74db`/0.8.0, no daemon changes); `claude -p` survives only in bench measurement context (TB2 driver + p2 probes). Spec: `docs/superpowers/specs/2026-08-14-daemon-carrier-migration-design.md` (commit `13b9938`).

Goal here: decompose into tasks with a DAG maximizing parallelism between **session A = meta-harness-a8 ("harness", this session)** and **session B = meta-harness-13 ("minimal")**.

## Key exploration facts (drive the decomposition)

- `buildProposerPrompt` (`opencode-plugin/src/propose.ts:888-1272`) is already **pure and deterministic** — it inlines playbook bullets, score context, failure excerpts, rejected-candidate + ledger sections. The restructure is NOT "build a context assembler from scratch"; it is: swap the prompt's **output contract** (bash-heredoc writes to staging files → structured JSON reply) and lose the "Store access" go-read-more affordance.
- `triggerPropose` (`propose.ts:140-277`) computes staging paths, builds prompt, calls `host.runTaskAgent`, then forks: CC path = lock file (`stageArtifactApply`) + apply-on-next-event; opencode path = inline `waitForFile`. **Opencode path must stay byte-same** → prompt builder gains an optional trailing `outputMode: "staging-files" | "json-reply" = "staging-files"` parameter (same back-compat convention as `evidenceDir`/`heldOut`, `propose.ts:900-909`) so all existing call sites + prompt tests compile and pass unmodified; opencode keeps heredoc mode. NOTE: the CC/opencode discriminator (`host.stageArtifactApply` presence) is currently checked AFTER prompt build (`propose.ts:254`) — T4 hoists it above the `buildProposerPrompt` call since `outputMode` changes prompt text.
- **Kind shapes differ**: `triggerPropose` stages 6 files; `triggerPromote` stages 2 (`promote-<scope>-<version>-{system.md,tools.md}`); `triggerCurate` stages 1 (`curate-…-ops.json`, `add` ops forbidden). Worker + schemas MUST branch per kind — a generic proposer-shaped writer would leak files the promote/curate apply paths never clean. `buildPromotePrompt` (`propose.ts:1274`) is not exported — export it for T1/T5.
- Judge swap has a ready template: `runA4Review` (`opencode-plugin/src/bench/p2/a4-review.ts:247-290`) — `ensure(env,{waitMs})` → `call(prompt, model, env, {isolation, maxTokens})` → `outcome.kind`/`modelProvenBy`/`stopReason==="max_tokens"` checks → `closeSession` in finally. Deps-injection test pattern in `test/p2-a4-review.test.ts`. CAVEAT: a4-review's header comment claiming daemonCall has no maxTokens field is stale — read live `acp-client.ts`, not the donor's comments.
- Public `daemonCall` is `~/z2/cc-api-daemon/src/acp-client.ts:134-152`; opts support `isolation` + `maxTokens`. **`maxTokens` semantics are lane-split and load-bearing:** `routeBackend` (`route.ts:8`, exported from package index) sends only `*haiku*` models to the api lane; everything else (sonnet/opus — every real seat model, `DEFAULT_PROPOSER_MODEL = "anthropic/claude-opus-5"`) routes to the agent lane, where the daemon **hard-rejects any call carrying `maxTokens`** (`acp-daemon.ts:501-519`, `ACP_ERR_NO_CALL`). The 2048-token truncation cap exists on the api lane only. So: pass `maxTokens` ONLY when `routeBackend(model) === "api"`; omit it entirely for agent-lane models. Unconditional pass-through = total production outage.
- The daemon hard-requires a non-empty model on `session/prompt` (`acp-daemon.ts:406-412`) — no daemon-side default. But default `judgeModel` config is `""` → `parseModelSpec("")` = `undefined` (`harness-store.ts:595,609`), and `review-gate.ts:105`'s `reviewModel` is optional: the out-of-box judge runs with `model: undefined` today (old transport omitted `--model`, CLI defaulted). T0 MUST add fallback constants (`DEFAULT_JUDGE_MODEL`, reused for review calls) substituted when `opts.model` is undefined.
- Judge callers: `judge.ts:193`, `review-gate.ts:101` — both via `host.runTextAgent`, no signature change needed.
- Proposer seat constants: `PROPOSER_ALLOWED_TOOLS`/`MH_CHILD_ENV` (`cc-host.ts:312,321`) die with the CC child. Lock/apply machinery (`adapters/claude-code/proposer.ts`) untouched.
- Tests touching this surface: `test/cc-host.test.ts`, `test/cc-proposer.test.ts`, `test/proposer-prompt-ledger.test.ts`, `test/proposer-agent-config.test.ts`, `test/proposer-env-policy.test.ts`, `test/proposer-store-access.test.ts`, `test/propose-apply.test.ts`, `test/trial-compose.test.ts` (:367-376 injects literal `MH_CHILD: "1"` and asserts the dispatch guard — must stay green; the keep-the-guards decision is load-bearing for it), `test/p2-a4-review.test.ts` (pattern donor).

## Two-session ground rules

- Both sessions currently share cwd `/Users/yoo/z2/meta-harness`. **Session B works in a git worktree on branch `feat/daemon-judge`** (superpowers:using-git-worktrees); session A works on branch `feat/daemon-proposer` (worktree or main checkout — A owns the main checkout). No same-tree concurrent edits.
- File-ownership partition (function bodies are disjoint; the file prelude and one test import line are NOT — declared shared, handled below):
  - **A owns:** `propose.ts`, `host.ts` (optional `system`/`stagingPaths` opts on `runTaskAgent` — B never touches it), `review-gate.ts` (T4 `reviewModel` type widening), new worker + contracts files, `cc-host.ts` `runClaudeCodeTaskAgent` body, task-agent cases in `test/cc-host.test.ts`, `test/cc-proposer.test.ts` (verified decoupled — drives a hand-rolled fake host, `cc-proposer.test.ts:44`), new worker/prompt tests.
  - **B owns:** `cc-host.ts` `runClaudeCodeTextAgent` body, judge cases in `test/cc-host.test.ts`.
  - **Shared, deliberately deferred:** `cc-host.ts` prelude (`CCChildProcess`/`CCSpawnFn` types :85-104, `resolveClaudeArgv`/`defaultCCSpawn` :106-144, `DISALLOWED_TOOLS` :146-153, `isProviderModelSpec` :155-167 — used by BOTH transports, `DEFAULT_JUDGE_TIMEOUT_MS`/`ClaudeJsonResult` :169-180), the shared import line `test/cc-host.test.ts:5`, and the `resolveClaudeArgv` test block (`test/cc-host.test.ts:374+`). Rule: **neither track deletes prelude symbols or edits the shared import line** during parallel work — B1/T3 leave newly-dead symbols and unused imports in place (compiles fine), and a dedicated post-merge dead-code sweep (M1b, session A, single-tree) deletes `resolveClaudeArgv`, `defaultCCSpawn`, `defaultCCTaskSpawn`, `CCChildProcess`/`CCTaskChild`/`CCSpawnFn`/`CCTaskSpawnFn` (if fully dead), `DISALLOWED_TOOLS`, `ClaudeJsonResult`, the import-line leftovers, and the `resolveClaudeArgv` test block in one commit. `isProviderModelSpec` + `DEFAULT_JUDGE_TIMEOUT_MS` stay (still used).
- Merge order: **B merges first** (small diff), A rebases then merges; residual same-line conflicts expected at rebase are A's to resolve. Both merges need user go (standing rule). Suites run serial, one session at a time.
- Coordination via SendMessage (a8 ↔ meta-harness-13 verified working).

## Task DAG

```mermaid
graph TD
  T0[T0 A: contracts module — reply JSON schemas, isolation consts, worker argsfile shape] --> T1
  T0 --> T4
  T0 -.picked up by.-> B1
  subgraph Session B — minimal
    B1[B1: judge body-swap in runClaudeCodeTextAgent] --> B2[B2: judge tests → deps-injection seam]
    B2 --> B3[B3: suite green on feat/daemon-judge + report]
  end
  subgraph Session A — harness
    T1[T1: prompt outputMode fork — buildProposerPrompt/Promote/Curate JSON-reply variant] --> T2[T2: proposer worker script — assemble→daemonCall→validate→stage]
    T2 --> T3[T3: runTaskAgent swap → spawn bun worker; kill PROPOSER_ALLOWED_TOOLS/MH_CHILD_ENV]
    T3 --> T4[T4: propose.ts wiring + provenance persist]
    T4 --> T5[T5: proposer/worker/prompt tests updated + new]
  end
  B3 --> M1[M1 A: merge B, rebase A, merge A — user go each]
  T5 --> M1
  M1 --> M1b[M1b A: dead-code sweep — prelude symbols, shared import line, resolveClaudeArgv test block]
  M1b --> M2[M2 A: full serial suite + 7b gate + review artifact]
  M2 --> M3[M3 A: boundary ts stamp in adoption ledger + docs/resume update]
  M3 --> M4[M4 A: first post-migration crank smoke — SPEND, explicit user go]
```

Critical path: T0→T1→T2→T3→T4→T5→M1. B-track (B1-B3) fully parallel to A-track after T0 (B only needs T0's isolation-constants location — or can inline its own consts and unify at merge; T0 dependency is soft for B).

## Task details

### T0 (A) — shared contracts module — `opencode-plugin/src/adapters/claude-code/daemon-seat.ts` (new)
- `SEAT_ISOLATION` — a PARTIAL WarmIsolation base (`acp-wire.ts:203-212`): `settingSources: []`, `tools: []`, `settings: { autoMemoryEnabled: false }` (**nested**, not flat), `persistSession: false`, `strictMcpConfig: true`, `thinking: { type: "disabled" }`. Deliberately missing `systemPrompt` + `title` — every seat completes it identically: `{...SEAT_ISOLATION, systemPrompt: <seat system prompt>, title: <seat title>}` (B1 judge and T2 worker MUST use this same spread; tracks are in separate sessions, so the construction lives in T0's module as a helper, e.g. `seatIsolation(systemPrompt, title)`).
- `seatMaxTokens(model, seat)`: returns a number ONLY when `routeBackend(model) === "api"` (import from `@th-yoo/cc-api-daemon`), else `undefined` — the daemon hard-rejects `maxTokens` on the agent lane (`acp-daemon.ts:501-519`). Api-lane values: judge 4096, proposer/promoter/curator 16384.
- `DEFAULT_JUDGE_MODEL` fallback constant — **BARE model id** (e.g. `"claude-opus-5"`), following `A4_MODEL`'s convention (`a4-review.ts:74`), NOT `DEFAULT_PROPOSER_MODEL`'s prefixed `"anthropic/…"` config-string form — substituted when `opts.model` is `undefined`; daemon hard-requires a non-empty model. The actually-reachable undefined-model path is the review gate: `propose.ts:549-556` never passes `reviewModel`, so `review-gate.ts:105` sends `model: undefined` on EVERY playbook add-op review (the dense judge is config-gated off by default, `engine.ts:526-530`). Pre-existing gap worth one line in T4: `mhCfg.judgeModel` is never threaded into the review-gate call — thread it (`reviewModel: parseModelSpec(cfg.judgeModel)`) so a configured judge model governs the review seat instead of the hardcoded fallback.
- Worker argsfile TypeScript type: `{ kind: "propose"|"promote"|"curate", prompt, systemPrompt, model, stagingPaths: <per-kind discriminated union>, timeoutMs, spawnedAt, artifactId }` — `spawnedAt` stamped by cc-host at spawn time; T2's deadline math needs it, and it necessarily precedes the descriptor's own `spawnedAt` (stamped moments later in `triggerPropose`), so the worker's deadline is always ≤ the lock horizon.
- **Three distinct reply schemas + staging file-sets** (validators plain TS guards, `screenOpsChecks` style, `propose.ts:300`):
  - propose: `{diagnosis, ops?|system?, tools?, agentConfig?, envPolicy?, explanation}` → up to 6 files (`<scope>-<version>-*`).
  - promote: `{system, tools?}` → exactly `promote-<scope>-<version>-{system.md,tools.md}`.
  - curate: `{ops}` (no `add` op — validator enforces) → exactly `curate-<scope>-<version>-ops.json`.
- Commit early so B can import isolation consts + `DEFAULT_JUDGE_MODEL` + `seatMaxTokens` (or B inlines + unifies at merge).

### B1 (B) — judge body-swap — `runClaudeCodeTextAgent` body only
- Keep signature + NEVER-throws/null contract + `[cc-host] runTextAgent:` log-line shapes.
- Replace spawn with `runA4Review`'s exact pattern: `const effectiveModel = modelId ?? DEFAULT_JUDGE_MODEL` → `ensure(env, {waitMs: <nonzero, e.g. 15_000>})` → `call(opts.prompt, effectiveModel, env, {isolation: seatIsolation(opts.system, opts.title), maxTokens: seatMaxTokens(effectiveModel, "judge"), budgetMs: opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS})` → `outcome.kind !== "ok"` → null; `modelProvenBy` check; `stopReason === "max_tokens"` → log + null; `closeSession` in finally. (ONE `effectiveModel` variable feeds both the call and `seatMaxTokens` — a future haiku judge must compute its api-lane cap off the same model string. `seatMaxTokens` returns `undefined` for agent-lane models — MUST NOT pass a number there, daemon hard-rejects.)
- Stop USING scratch-cwd mkdtemp machinery, `DISALLOWED_TOOLS` argv, `ClaudeJsonResult` parsing — but do NOT delete the prelude symbols (shared-prelude rule; M1b sweeps). Keep non-anthropic guard verbatim.
- `CCSpawnFn` seam → `{ensure, call, close}` deps param (a4-review pattern). Constructor opt `spawnFn` for judge becomes `judgeDeps`.
- Timeout: `daemonCall` accepts `budgetMs` (`acp-client.ts:152`) and self-enforces it (`:178-180`) — pass `budgetMs: opts.timeoutMs ?? DEFAULT_JUDGE_TIMEOUT_MS` explicitly. No `Promise.race` needed. MUST NOT omit: no current caller sets `opts.timeoutMs` (`judge.ts:193`, `review-gate.ts:101`), and daemonCall's internal default is 36s (`acp-wire.ts:165` `clientBudgetMs`) — omitting silently regresses the judge timeout 90s→36s.

### B2 (B) — judge tests — `test/cc-host.test.ts` (judge cases only)
- Re-target existing runTextAgent cases from fake-spawn to fake `{ensure, call, close}` (donor: `test/p2-a4-review.test.ts`). Contract cases: happy path, non-anthropic skip (unchanged), daemon-unreachable → null, `kind: "error"` → null, model-proof fail → null, truncation → null + log, close always called, **`model: undefined` → `DEFAULT_JUDGE_MODEL` substituted**, **agent-lane model → no `maxTokens` in call opts**.
- Do NOT edit `test/cc-host.test.ts:5` shared import line or the `resolveClaudeArgv` block (`:374+`) — leave unused imports; M1b sweeps.

### B3 (B) — suite green on branch; SendMessage report to A with diff summary.

### T1 (A) — prompt outputMode fork — `propose.ts`
- `buildProposerPrompt(..., outputMode?: "staging-files" | "json-reply" = "staging-files")` — optional TRAILING param, default keeps every existing call site + test compiling unmodified (the `evidenceDir`/`heldOut` convention, `propose.ts:900-909`). `"json-reply"` replaces "## Write the results" + heredoc blocks + `storeAccessSection` with a JSON output-contract section (schema per T0; diagnosis required first-class field, ops/system per playbook mode, optional tools/agentConfig/envPolicy).
- Same fork for `buildPromotePrompt` (add `export` — currently unexported, `propose.ts:1274`) and `buildCuratePrompt`, each with its own kind schema section.
- Existing prompt tests (`proposer-prompt-ledger`, `proposer-agent-config`, `proposer-env-policy`, `proposer-store-access`) stay green untouched (they exercise the `"staging-files"` default).

### T2 (A) — proposer worker — `opencode-plugin/src/adapters/claude-code/proposer-worker.ts` (new, bun entrypoint)
- Reads argsfile JSON → `ensureDaemon(env, {waitMs: 30_000})` (worker is detached; MUST spawn a cold daemon, never silent-skip) → `daemonCall(prompt, model, env, {isolation: seatIsolation(argsfile.systemPrompt, <per-kind title>), maxTokens: seatMaxTokens(model, kind), budgetMs})` (maxTokens undefined on agent lane) → validate reply against the **kind-specific** schema → on invalid: ONE retry with repair nudge appended → on second failure: exit nonzero (lock stale-expiry reclaims).
- **Deadline discipline (prevents the zombie-worker/staging-collision race):** the lock is reclaimable at `spawnedAt + descriptor.timeoutMs` (`proposer.ts:75-78`), and `nextVersion()` is on-disk-derived (`harness-store.ts:881-886`) — a re-triggered propose after reclaim computes the SAME version string, so a still-running worker and a fresh one would write identical staging paths. The worker therefore takes a hard deadline from the argsfile (`spawnedAt + timeoutMs − MARGIN`, margin ≈ 30s) and budgets EVERY step against remaining time: first `daemonCall` gets `min(timeoutMs/2, deadline − now)`; the retry runs only if `deadline − now` leaves usable headroom, with `budgetMs: deadline − now`; past deadline the worker exits nonzero WITHOUT writing any staging file. Total wall clock (ensureDaemon wait + both calls) provably < descriptor.timeoutMs — the worker is always dead before its lock is reclaimable.
- Write staging files **per kind** (T0's file-sets — never write proposer-shaped files for promote/curate; their apply paths don't clean unknown files): secondaries first, **primary last** (propose: ops.json/system.md; promote: system.md; curate: ops.json) — `applyPendingArtifacts` polls the primary; primary-last guarantees complete artifact set at apply time. Use `writeTextAtomic` (`bench/util.ts`).
- Provenance: write `<staging>/<scope>-<version>-provenance.json` `{promptSha256, model, daemonOutcomeMeta, ts}` (full prompt already persisted by T4).
- `closeSession` in finally.

### T3 (A) — `runClaudeCodeTaskAgent` swap — `cc-host.ts:306-415`
- argv becomes `[process.execPath, workerPath, argsFilePath]` — **NEVER bare `"bun"`**: detached hook children under launchd have a minimal PATH; bare argv[0] is the exact documented 4/4-day proposer outage (`docs/reviews/42d6199-fix-cc-host-claude-path.md`), and `process.execPath` (the running Bun binary) is PATH-independent. This sidesteps `resolveClaudeArgv` entirely. New `defaultWorkerSpawn` replaces `defaultCCTaskSpawn` as the seam's production default (M1b then correctly deletes `defaultCCTaskSpawn` + `resolveClaudeArgv`). Argsfile written to `ccRuntimeDir()` scratch. Keep detached spawn + `unref` + `{id}` return + null-contract + log shapes.
- Stop setting `MH_CHILD_ENV` on the worker env and drop `PROPOSER_ALLOWED_TOOLS`/`--session-id` from the argv (worker gets `artifactId`). **Known readers of `MH_CHILD_ENV`: `adapters/claude-code/hook-cli.ts:22,48` and `dispatch.ts:34,144` — both files assigned to T3/A.** Decision: keep the sentinel export + reader guards in place (they are harmless if never set, and they still guard against a human running `claude` inside a worker-touched env), just stop setting it; revisit deletion in M1b only if grep shows the guard fully dead.
- `CCTaskSpawnFn` seam stays (tests inject fake spawn, now asserting bun-worker argv).

### T4 (A) — `triggerPropose`/`triggerPromote`/`triggerCurate` wiring — `propose.ts`
- **Hoist the CC/opencode discriminator (`host.stageArtifactApply` presence) ABOVE the prompt build** (today checked at `propose.ts:254`, after build at `:225`) — `outputMode` must be known before `buildProposerPrompt` runs.
- CC host path passes `outputMode: "json-reply"` + system prompt (new short proposer persona + output contract constant) via `runTaskAgent` opts (add optional `system` + `stagingPaths` to the host-interface opts; opencode adapter ignores them).
- Persist assembled prompt next to staging (`<scope>-<version>-prompt.md`) before spawn — the provenance record.
- Thread `reviewModel: parseModelSpec(cfg.judgeModel)` into the `reviewAddedBullets` call (`propose.ts:549-556`) — closes the pre-existing gap where the review seat ignores configured `judgeModel` and would otherwise always ride `DEFAULT_JUDGE_MODEL`. Companion type fix REQUIRED: `review-gate.ts:93` declares `reviewModel?: string` but `parseModelSpec` returns `{providerID, modelID} | undefined` (`harness-store.ts:609`) — widen the field to the ModelSpec object type (that object IS what both host `runTextAgent` implementations expect in `opts.model`); as a bare string it would not typecheck.
- Descriptor/lock/apply path byte-untouched.

### T5 (A) — tests
- `test/cc-proposer.test.ts` + `test/cc-host.test.ts` (task-agent cases): argv now bun worker; lock/apply cases unchanged-green.
- New `test/proposer-worker.test.ts`: fake `{ensure, call, close}` — happy path writes files (primary last verified by write-order capture), invalid JSON → one retry → nonzero exit, truncation handling, provenance content.
- New JSON-mode prompt test: golden assert of the output-contract section.

### M1 (A) — merges. B first, then A rebased (same-line conflicts on shared import line expected — A resolves). **User go before each merge** (standing rule).
### M1b (A) — dead-code sweep, single tree post-merge: delete `resolveClaudeArgv` (dead once T3 spawns via `process.execPath` — its `argv[0] !== "claude"` check never fires again), `defaultCCSpawn`, `defaultCCTaskSpawn` (replaced by `defaultWorkerSpawn` in T3), `CCChildProcess`/`CCTaskChild` types, `DISALLOWED_TOOLS`, `ClaudeJsonResult`, scratch-cwd helpers, unused imports on `test/cc-host.test.ts:5`, and the `resolveClaudeArgv` test block (`test/cc-host.test.ts:374+`). Keep `isProviderModelSpec` (both transports still use it) and `DEFAULT_JUDGE_TIMEOUT_MS` (B1's `budgetMs` fallback uses it). Keep `MH_CHILD_ENV` reader guards (`hook-cli.ts`, `dispatch.ts`; `test/trial-compose.test.ts:367-376` asserts them). Verification §4's grep expectation (`cc-host.ts` free of `"claude"` strings) holds only after this sweep completes.
### M2 (A) — full suite serial + 7b gate + committed review artifact (`docs/reviews/`, BARE fields, rev-parse SHAs).
### M3 (A) — boundary ts: adoption-ledger entries for proposer-environment + judge-transport change; `docs/resume.md` close block.
### M4 — first post-migration crank + judge smoke. **SPEND — explicit user go.** Stamps fresh boundary.

## Allocation summary

| Session | Tasks | Rationale |
|---|---|---|
| A (harness, this) | T0-T5, M1-M4 | Holds contamination/F2/spec context; proposer restructure is the deep half; M4 spend gate is A's to request |
| B (minimal) | B1-B3 | Judge swap is isolated, template-driven (a4-review donor), disjoint file region + disjoint tests |

B's track ≈ 1 focused pass; A's track ≈ 3-4x B. If B finishes early: B takes T5's new `proposer-worker.test.ts` authoring against T0's frozen contracts (message-coordinated).

## Verification

1. Per-branch: `bun test` (serial) in opencode-plugin — B3 / T5 gates.
2. Post-merge M2: full serial suite; 7b gate + artifact.
3. Live smoke (M4, user go): one `/mh-propose` crank on a real layer — verify lock → worker → daemon → staged files → apply → candidate created; judge path via one review-gate call. Transcript check: NO CC-harness markers (no "CAVEMAN", no superpowers refs) in the daemon-carried turns — the contamination probe repeated as the acceptance test.
4. End-state proof (the naive single-line grep matches NOTHING post-migration — `drivers/claude-code.ts` and `cmd-p2.ts` build argv across separate array lines, so it never matched them anyway): (a) `grep -rn '"claude"' opencode-plugin/src --include='*.ts'` hits only `drivers/claude-code.ts` + p2 files; (b) existing driver unit test still asserts `claudeCodeDriver.buildArgv` contains `"-p"` (specimen preserved); (c) `cc-host.ts` contains zero `"claude"` argv construction.
