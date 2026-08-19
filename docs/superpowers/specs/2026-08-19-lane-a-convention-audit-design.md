# Lane A — convention-audit staging step (design)

**Status:** design, approved-in-chat 2026-08-19; increment-1 scope. Architectural.
**Evidence base:** the representation-trap arc (`docs/loop-probes/rep-audit-20260819/`,
`docs/loop-probes/census-20260819/`, `docs/loop-probes/census-e2e-20260819/`) and the
attack plan (`docs/2026-08-19-raman-attack.md` §4/§7). Decisions this spec encodes are
measured, not assumed — see "Grounding" below.

## 1. Purpose

Make an agent read the right representation convention (units, endianness, script,
address-base, extraction-scope, dialect) on tasks where mis-reading the convention is the
binding failure. A per-task **convention card** is generated at staging by an executing-tier
audit call and injected into the task instruction. This is a **task-level capability**, not a
proposer/playbook lesson: the card helps every arm equally and is byte-identical across A/B
arms, so it never contaminates the gate (same discipline as `agent-run.ts`'s `budgetLine`).

Ships behind a flag, **OFF by default** (the `review-sensor` ship-off precedent). First use is
measured (board lift, audit-on vs audit-off on representation-trap tasks), never silently armed.

## 2. Grounding (measured facts this design rests on)

- **Injection seam:** `agent-run.ts:147-167` reads `instruction.md`, then appends `budgetLine`
  — a CONTROLLED per-task constant kept OUT of the evolvable harness precisely so it cannot
  become an A/B lever. The card appends in the same place under the same discipline.
- **Detector generalizes** (census 2/2: toolpath-geometry, ELF format) and the
  **instruction-criteria clause** was validated end-to-end (elf-v3 PASS 2/2 → elf card arm
  5/5 vs 2/5, mechanism 5/5).
- **Content-gate is sound** (clean batch 12/12: 0 false positives on clean input incl. a
  domain-matched decoy; 4/4 trapped fire).
- **Auditor tier:** sonnet attributes; haiku detects-but-cannot-attribute → the audit call is
  sonnet, hardcoded.
- **Imperative rule (hedge-harvest law):** weak-tier consumers harvest a card's hedge as
  permission (gcode 4/5 shipped a decoy citing the card's "can't rule out"). Cards must phrase
  uncertainty as MANDATORY disambiguation, never open possibility. Folded into the audit prompt.
- **Leak-safety:** the auditor consumes `instruction.md` + task input files + world knowledge
  ONLY. Never `tests/`, `solution/`, expected outputs. Scope conventions are derivable from the
  instruction's own stated success criteria (elf case) — no reference access needed.

## 3. Architecture

One module, `opencode-plugin/src/bench/convention-audit.ts`, one entry point:

```
auditCard(paths: BenchPaths, task: string, opts): Promise<AuditResult>
  AuditResult = { card: string; rawAudit: string; verdict: "MISMATCH" }
              | { card: null; rawAudit: string; verdict: "NO_MISMATCH" | "ERROR" }
```

Pipeline (each a small internal fn, independently testable):

1. **sampler** `buildSample(paths, task) → { text: string; truncated: boolean }` — leak-safe.
   Reads `instruction.md` and the task's input files. Emits: instruction verbatim + a
   deterministic mechanical summary per input file + a head/tail excerpt.
   - **Input-file resolution is NOT `parseTaskDockerfile` reuse.** That function (`staging.ts:618`
     `resolveCopyStep`, `:762` fail-loud `die` on unclassifiable directives) was built to stage
     *trusted* Dockerfiles for container builds and does ZERO path containment — `src` is
     `join(envDir, srcTrimmed)`'d verbatim and `cp -r`'d with no `..`/symlink rejection
     (`staging.ts:623,980`). The sampler resolves input files independently and applies its own
     containment guard.
   - **Leak-guard = realpath containment (the critical property, explicitly designed):**
     canonicalize both the resolved candidate path and the `<task>/environment` root
     (`realpathSync`, symlinks followed), then require the canonical candidate to be a descendant
     of the canonical root. Rejects `..`-traversal AND symlinks-out. `tests/`, `solution/`,
     `*.json` expected outputs are never enumerated regardless. A rejected path is a hard error
     (no partial sample), not a silent skip.
   - **Derived discriminating stats, not aggregates (sibling gcode finding, 3rd instance of the
     arc's "fix the evidence, not the reasoner" law):** the per-file summary must carry the
     mechanical statistic that DISCRIMINATES the likely convention, not a generic aggregate —
     spacing-histogram for a spectrum axis, plane-fit (coeffs + R²) for a toolpath point cloud,
     `readelf -h/-S/-l` structural summary for a binary, command/token histogram + coordinate
     ranges for text. Aggregate stats that cannot separate the trap from the mundane reading
     (e.g. aggregate Z that cannot distinguish tilt from normal layer growth) have cost a
     generation round three times; the contract is per-format derived stats.
   - **Size bound:** COPY sources can be whole directories, recursively (`staging.ts:621-636`
     `srcIsDir`/`contentsOnly`). The sampler applies an explicit total-sample byte budget and
     per-file/file-count cap; on overflow it truncates deterministically (documented order) and
     sets `truncated: true`, recorded in the audit trail (§6).
2. **auditCall** `runAudit(sample, deps) → string` — ONE toolless, model-pinned host-side
   completion via the ACP daemon: `ensureDaemon → daemonCall → parse → closeSession`. The real
   precedent is **`opencode-plugin/src/bench/p2/a4-review.ts`** (bench-code, exactly this shape,
   `deps`-injection seam for tests, `max_tokens` truncation detection) — NOT `proposer-worker.ts`/
   `cc-host.ts` (those describe the daemon lane but their prompts differ) and NOT `claude -p`
   (`cc-host.ts:288-299` documents the PATH/auth outage that migration fixed; do not reopen it).
   Landmines inherited from that precedent, designed for here:
   - **16s default turn-timeout trap** (`daemon-seat.ts:56-59`): the gauge-sized
     `ACP_BUDGET.turnTimeoutMs` default cannot clear a multi-KB sample + frozen prompt. The audit
     call MUST set an explicit generous turn timeout (the `ACP_TURN_TIMEOUT_MS`-override path this
     codebase already special-cased for exactly this "large prompt, short default" mode).
   - **Lane routing** (`daemon-seat.ts:52` `routeBackend`): the hardcoded sonnet auditor routes to
     the uncapped `agent` lane (haiku would hit the 2048-token `api` cap) — reply size is
     budget-bound, not token-capped; fine for a card, but stated.
   - Fail-safe: any daemon error / empty / `max_tokens`-truncated reply → `verdict: ERROR`,
     `card: null` → no injection, run proceeds byte-identical to audit-off.
3. **contentGate** `parseVerdict(raw) → "MISMATCH" | "NO_MISMATCH"` — reads the prompt's
   machine line `CONTENT VERDICT: {MISMATCH|NO MISMATCH}`. NO_MISMATCH (or unparseable) →
   `card: null` (quiet-on-clean).
4. **extractCard** `cardFrom(raw) → string` — the injectable card body (the audit's SURFACE +
   CONTENT + prescription, imperative by construction of the prompt). Returned verbatim; no
   host-side rewriting (verbatim discipline — hand edits void the end-to-end claim).

## 4. The frozen audit prompt (lane-A v1)

The `census-e2e` generator-prompt + compute clause + the instruction-criteria clause
(elf-v3, validated) + the imperative clause (hedge-harvest fix), plus the machine verdict line.
Stored as a repo constant (`convention-audit-prompt.txt`), version-stamped. Its three
load-bearing clauses:

- **compute:** numerically test each convention hypothesis against the sample before writing.
- **instruction-criteria:** also audit the instruction's success criteria for scope/deliverable
  ambiguities; where a broader reading is penalty-free under the stated scoring, name the
  dominant reading.
- **imperative (hedge-harvest fix):** every uncertainty must be written as a MANDATORY
  disambiguation step the solver must perform ("you MUST determine X from the file"), never as
  an unresolved possibility; explicitly name any decoy/label as NOT evidence.
  EVIDENCE-BACKED, not just inferred: the gcode regen-v2 probe (sibling lane, `fb71800`) showed
  the imperative clause ACTUATES — the auditor produced zero permissive hedges ("the label is
  NOT evidence... you must determine glyph content by plotting") AND converted a
  falsifiable-wrong assertion into a safe mandatory disambiguation step (M82/M83 grep). The
  clause belongs in the production prompt on measured grounds.

## 5. Wiring

`agent-run.ts`: when `opts.conventionAudit` is set and `auditCard` returned a non-null card,
append the card after `budgetLine`, under an identical CONTROLLED-CONSTANT comment (per-task,
byte-identical across arms, NOT proposer-controlled).

**Cache — per-process per-task, with the sequential invariant stated and single-flighted.**
Cache `AuditResult` by `task` so every arm/rep in one run injects identical bytes and the audit
call runs once. This is race-free ONLY under the current architecture: `cmd-ab.ts:689` `runTaskPairs`
awaits arm A's full container lifecycle before arm B, `cmd-run.ts:917`'s k-loop is sequential,
and `--parallel` fans out ACROSS tasks (keyed by task), never within one task's arms/reps.
- The card is **cached like `budgetLine`, NOT stable like `budgetLine`.** `budgetLine`
  (`agent-run.ts:165`) is a pure fn of `agentTimeout` — reproducible across every process forever.
  The card is a live sonnet completion; nothing bounds it to reproduce across separate runs.
  `--resume` (`cmd-ab.ts:495`) re-runs any task not complete at k reps for both arms → a resumed
  task regenerates a possibly-differently-worded card (never a within-task split, but not
  run-to-run stable). Callout, not a bug — matters when comparing card text across loop iterations.
- This codebase has already had to retrofit `AsyncMutex` (`cmd-run.ts:1051`, `cmd-ab.ts:907`)
  where a once-sequential path was parallelized. To fail safe against a future concurrent-arm
  change, the cache miss is **single-flighted** (one in-flight promise per task key, matching the
  `AsyncMutex` idiom); a test asserts two concurrent requests for the same task key share one
  completion. Without this, concurrent arms would fire two non-deterministic completions and the
  card would silently diverge — defeating the whole premise.

`cmd-run.ts` / `cmd-ab.ts`: thread a `--convention-audit` boolean (default false) into the
per-task flow. When off, the code path is byte-identical to today.

**oauth-parallel interaction (architect finding B — first-arming blocker).** `cli.ts:680`'s
`validateParallel` budgets only `maxAgentTimeout*1000 + OAUTH_PARALLEL_MARGIN_MS` — the
in-container agent phase — against oauth token expiry under `--parallel`. A staging-time audit
call is a real LLM call OUTSIDE that budget; under `--parallel` oauth mode it can eat the exact
refresh margin the gate protects. Increment-1 decision: **refuse `--convention-audit` together
with `--parallel` under oauth auth**, mirroring the existing refusal pattern (`cmd-run.ts:783-791`,
`cmd-ab.ts:342-347`). Folding a worst-case audit duration into `neededMs` is the increment-2
option; the refusal is the safe MVP.

## 6. Audit trail (leak-safety requirement)

For each task with the flag on, write `{task, promptVersion, sample, rawAudit, verdict, card}`
to a per-run audit-trail file under the results/log dir (host-side, not in-container). This is
the leak-safety record ("cue text stored with the trial") and the debugging surface. Never
written into the container / never visible to the grader.

## 7. Scoped OUT of increment 1 (designed, not built)

- **Mechanical propose-verify revalidator** (increment 2, the #1 follow-up): recompute the
  card's claimed transform table against the mechanical sample; reject a card whose winning row
  does not reproduce (rejects the gen4-r1 "confident-wrong" class). Deferred ONLY because the
  flag ships OFF and first use is measurement-gated — a wrong card cannot reach production
  silently. Until it exists, an audit-on run can inject a confident-wrong card; stated risk.
- Auto-running in the loop / board wiring beyond the flag.
- Per-task sampler specializations beyond the generic text/binary summary (the gcode
  text-object-row bug the sibling found — sampler must include in-object rows — is a sampler
  quality item folded into `buildSample`, but domain-specific samplers are out).

## 8. Testing

TDD, unit-first (the pipeline fns are pure over fixtures):
- `buildSample` leak-safety = the critical test, and it must exercise the TRAVERSAL path, not
  just the happy path: a Dockerfile fixture with a `COPY ../tests/x /app` line AND a fixture with
  a symlinked COPY source under `environment/` pointing outside it — assert BOTH are rejected
  (hard error), and assert a normal fixture emits deterministic output with no `tests/`/`solution/`
  bytes. Plus a directory-COPY fixture exceeding the byte budget → asserts truncation + `truncated:
  true`.
- `parseVerdict`: MISMATCH / NO MISMATCH / missing-line → null.
- `cardFrom`: extracts the body verbatim.
- `auditCard` integration: a recorded-daemon-reply fixture via the `deps` seam (NO live model
  call in tests) → card or null; a `max_tokens`/error reply → `card: null`.
- Cache: two concurrent requests for the same task key share ONE completion (single-flight).
- Wiring: `agent-run` appends the card after budgetLine when flag on + card non-null; byte-
  identical to today when off. A/B byte-identity across arms asserted.
- oauth-parallel: `--convention-audit --parallel` under oauth is refused (assert the error).
- The audit call is injected via the **`deps` seam** matching `a4-review.ts` (`{ensure, call,
  close}`), NOT the `ExecFn` CLI seam — no live daemon/`claude -p` in the suite.
- A one-line trace citation (not just precedent) that the appended card never reaches
  `envBlock`'s budget-identity hash (`envBlock` computed once per invocation from `harnessMd`,
  before per-task `runAgent` append) nor `drivers/claude-code.ts`'s `normalizeEvents` (parses only
  assistant/result NDJSON, never the instruction turn) → confirms §item-4 by trace.

## 9. Readiness caveats (on the record)

1. Reward-level significance is still weak (elf card reward p=0.083; the strong result is
   mechanism-level, p=0.024). This build ENABLES measuring the capability at board scale; it
   does not itself claim the win.
2. Without the increment-2 revalidator, an audit-on run can inject a confident-wrong card.
   Mitigated by ship-off + measurement-gated first use. Do not arm before increment 2.

**FIRST-ARMING BLOCKERS (architect review, must be resolved in increment 1 — NOT deferrals).**
The ship-off flag gates every risk below from a *silent* production arm, but the spec's own
"first use is measured, never silently armed" means the very first measurement run hits these
immediately. They are increment-1 correctness, not increment-2 scope:
- **A. Transport** (§3.2): the audit call uses the ACP-daemon `a4-review.ts` shape with the
  explicit turn-timeout override — NOT `claude -p`, NOT `ExecFn`. Building on the wrong transport
  reopens the documented PATH/auth outage or dies on the 16s default.
- **B. oauth-parallel refusal** (§5): `--convention-audit --parallel` under oauth is refused.
- **C. Leak-guard realpath containment** (§3.1): the sampler's own canonicalizing guard, with the
  traversal + symlink tests, NOT `parseTaskDockerfile` reuse.
The increment-2 revalidator (caveat 2) is a genuine deferral; A–C are not.
