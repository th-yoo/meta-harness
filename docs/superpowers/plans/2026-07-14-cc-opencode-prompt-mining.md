# Plan: mine CC + official-plugins + opencode system prompts → harness learnings

## Context

Developing our self-improving coding-agent harness (meta-harness). We evolve
harness content = **playbook bullets** (`playbook.json` → rendered `system.md`)
that are layered ONTO opencode's base system prompt via the
`chat.system.transform` hook (verified `index.ts:137-153`). The truly
hand-authored prompts (the analogs to what CC/plugins ship) are the
proposer/diagnosis prompt (`buildProposerPrompt`, `propose.ts:538-726`; the
returned template text is `:681-725`, incl. the load-bearing `${step2}` edit-vs-
propose branch at `:703` and the "write results" section `:706-724`) and
`judge-prompt.txt`. NOTE (architect): `roles.ts` is NOT a prompt — only
frontmatter/permission templates (`roles.ts:1-6`); the role BODY a model reads
is store-composed + gate-evolved (`render.ts:85-100`), out of scope. The
`squad-def.ts` wire-contract IS hand-authored but has no safe path to ship an
edit → out of scope (step 4). To improve BOTH
consumers, mine the best-in-class prompts we build on/near. Prompted by the
OpenClaw practice-mining (`docs/external-practices-openclaw.md`) — same output
pattern, three CODE sources instead of a blog.

**User decisions:** scope = FOCUSED high-value; output = BOTH (seed-corpus doc
for the loop + structural upgrades to our meta-prompts). Plus: openrouter is
already live for the judge-audit (`judge-audit.ts:28`, openrouter/gemini-2.5-
flash) and multi-LLM for the PRIMARY loop is coming → don't force model-agnostic.
A **target-model axis** (universal → vendor → model) for playbook content
emerges, orthogonal to the existing scope axis (global → role); this task SPECS
it (build later, Gall's law) and the seed categorization populates it.

## Sources & exact targets

Fetch via read-only `gh api .../contents/PATH --jq .content | base64 -d` (falls
back to the Git **blobs** API on the >1MB ceiling). "Verbatim" = fetch fidelity
(no small-model summarization like WebFetch), NOT a license to commit verbatim
(see ethics). **The contents/blobs API returns WHOLE files — there is no
line/byte-range param.** So "capture only a region" means: fetch the whole file →
decode → grep/slice **LOCALLY**; only the sliced region enters analysis/docs. The
full leaked CC file therefore DOES transit the tool output before narrowing —
the ethics rule constrains the committed OUTPUT, not the fetch.

**opencode (anomalyco/opencode = the LIVE repo we run; sst/opencode redirects here; branch `dev` — verbatim OK).** The base our content sits on. **We run Anthropic now but will test many LLMs via openrouter — cover ALL provider base prompts, not just anthropic.txt.**
- `packages/opencode/src/session/prompt/{anthropic,gpt,gemini,kimi,codex,copilot-gpt-5,beast,default,meta,trinity}.txt` — the per-provider base system prompts. **Diff across them → extract (a) the COMMON base every model gets and (b) per-provider deltas.** This diff is GROUND TRUTH for which behaviors vendors treat as universal vs model-specific — the categorization our seed-corpus reuses. Universal bullets ADD beyond the common base; model-specific bullets are flagged per-model (models genuinely differ — some plan well, some use tools well).
- `packages/opencode/src/session/prompt/{plan-mode,plan,plan-reminder-anthropic}.txt` — plan-mode prompts (relevant to our Research→Plan→Implement squad flow).
- `packages/opencode/src/agent/prompt/{explore,compaction,summary,title}.txt` — subagent/mode prompts.
- `packages/opencode/src/session/prompt.ts` + `packages/core/src/system-context/{index,builtins,registry}.ts` — how the base is SELECTED per provider + env assembly.

**Claude Code (codeaashu/claude-code, LEAKED proprietary — DISTILLED LEARNINGS ONLY, do NOT commit verbatim CC system-prompt text).**
- `src/buddy/prompt.ts`, `src/QueryEngine.ts` (fetch the WHOLE file, decode, then grep/slice the system-prompt string literal LOCALLY — the 46K-line file transits the tool output; there is no server-side region fetch), `src/Tool.ts` (tool-description conventions), `src/commands/agents/*` (Task/subagent dispatch).
- Extract PATTERNS: identity/tone, conciseness rules, tool-use discipline, planning/todo mechanics, refusal/safety framing, env injection.

**Official plugins (anthropics/claude-plugins-official — verbatim OK).**
- `plugins/claude-md-management/skills/claude-md-improver/{SKILL.md, references/{quality-criteria,templates,update-guidelines}.md}` — Anthropic's rubric for good CLAUDE.md ≈ direct rubric for our `system.md`/playbook. **HIGHEST value.**
- `plugins/code-modernization/agents/{architecture-critic,security-auditor,test-engineer,legacy-analyst,scaffolder,...}.md` — role-agent prompt structure ≈ our fleet roles.
- `plugins/claude-code-setup/skills/claude-automation-recommender/SKILL.md` (+references).

## Execution

1. **Extract** (read-only, verbatim via gh api). For CC's giant files, fetch + grep for the prompt string literal, capture only that region.
2. **Analyze into two buckets:**
   - **Playbook-bullet candidates** (behavioral → gate-evolvable): one-sentence rules (read-before-write, conciseness, tool discipline, planning, refusal). **Diff against the COMMON opencode base — DROP anything already there** (bullets only ADD). **Then place each on the MODEL axis (three generality levels, mirroring scope's global→role): UNIVERSAL** (survives the cross-provider diff → every model) **/ VENDOR** (all models of one vendor — opencode grounds this level: anthropic.txt vs gpt.txt) **/ MODEL** (one model's specific failure mode). The opencode provider-diff is the ground-truth signal for universal-vs-vendor. Do NOT force everything universal — models differ (planning-strong vs tool-strong).
   - **Meta-prompt structural lessons:** CC tool-description/planning/subagent patterns; claude-md-improver's "good harness content" criteria; code-modernization role framing → apply to the two genuinely hand-authored, non-gate-evolved prompts: `buildProposerPrompt` (`propose.ts:681-725`) + `judge-prompt.txt`. (NOT `squad-def.ts` wire-contract — out of scope, no safe path to ship it, see step 4; NOT `roles.ts` — no prompt there.)
3. **Write** `docs/external-prompts-cc-opencode.md` (reuse the `external-practices-openclaw.md` skeleton: source, why, verdict, mapping table, adoptable gaps, **A/B/C/D playbook seed-corpus** labelled "measure what propose discovers first; seed only misses into account-global `playbook.json`", "where we go further" = the gate, action tie-in to loop-1) + `docs/INDEX.md` entry.
4. **Meta-prompt upgrades** (the second "both" consumer) — present a diff-list for `buildProposerPrompt` (`propose.ts:681-725`) + `judge-prompt.txt`; apply only high-confidence edits (hand-authored, NOT gate-evolved → no ab needed). **Exclude `roles.ts`** (no prompt). **`squad-def.ts` wire-contract is OUT of scope for this task — there is NO safe existing path to ship a wire edit** (architect-verified): a source edit to `STANDARD_SQUAD.wire` never reaches an already-bootstrapped store (`readActiveSquadDef` reads disk `squadRoot(type)/active/squad.json`, `squad-def.ts:170-176`; fleet E2E shipped → active def exists + diverged), AND the tier-2 loop cannot push it — `squad-propose.ts:287-288` hard-rejects any `wire` mutation ("wire must be deep-equal to active — frozen, flow-knobs only"), `squad-trial` only trials an existing candidate, `squad-def-init` dies when an active def exists (and ignores the source edit), `/mh-activate` can't activate a squad-def candidate (keyed by `system.md`). Shipping a wire change needs NEW tooling (or manual surgery on `active/squad.json`) — a separate work item. **So meta-prompt upgrades in THIS task = `propose.ts` + `judge-prompt.txt` only.**
5. **Target-model-axis design spec** (`docs/`) — SPEC only (Gall's law: build later). Adds a second orthogonal generality gradient for playbook CONTENT: **target-model = universal → vendor → model**, alongside the existing **scope = global → role**. A bullet's home = a coordinate on both axes.
   - **NAMING (architect) — disambiguate:** call it **target-model / content-generality axis**, NOT "model". A pinned single-string `model` already exists and means something ELSE (the assignment: `SlotBinding.model` `squad-def.ts:12,31-34`, `RoleSpec.model` `roles.ts:17`, `MhConfig.proposerModel` `harness-store.ts:236`). The spec MUST reference `docs/capability-envelope.md:32-38` — the fixed squad structure (incl. those model pins) is already documented as co-adapted to the base model and frozen from evolution; the content-axis is a different lever and must say so.
   - **The core DESIGN DECISION the spec must make — additive vs override.** Two incompatible merge mechanisms already exist: system.md/playbook compose by **pure concatenation** (`compose.ts:69-103` PUSH every non-empty layer — nothing dropped), whereas `composeAgentConfig`/`composeEnvPolicy` (`harness-store.ts:837-845,924-932`) do **whole-artifact override** ("most-specific layer wins outright"). If the target-model axis is additive (like system.md), a `model:X` bullet can only ADD to the `universal` one — it can NEVER contradict/replace it, yet the whole motivation ("some models plan well, some don't") implies model-specific rules that REPLACE a universal default. Resolve explicitly: (a) additive-only — model bullets refine/add, never contradict (simplest; forbids replacement); or (b) an override channel per coordinate (new mechanism, like the agent-config override). Pick (a) for v1.
   - **Real extension points (NOT compose.ts — it maps generically over `LayerRef[]`, `compose.ts:51-58`; the 4-layer order guarantee lives in `layersFor`).** The hardcoding is in `harness-store.ts`: `StoreLayer.scope` is a CLOSED union (`:158`), `layersFor()` returns a fixed 4-element array with no model param (`:1369-1381`), root resolvers take no model arg (`:76-90`); `bench/record.ts` `LayerName` is the same closed 4-value union (`:34`). Extending needs: new root helpers + a model param threaded through `layersFor`/`layerStoreRoots` + unique `scope` keys per new layer (pins are scope-keyed, `compose.ts:53`), e.g. `account-vendor:anthropic`; sparse/opt-in (absent layer → empty → skipped).
   - **Bloat/curation (architect):** 4 scope × 3 levels = up to ~12 concatenated blocks. The playbook exists specifically as ACE anti-bloat (`harness-store.ts:664-666`, curator/budget). The spec MUST say how curation/budget operate across the new dimension — else it's an incomplete spec.
   - **Gate implication — NOT a small `ab` change.** `cmdAb` takes exactly ONE `--model` for BOTH arms (`cmd-ab.ts:95-186,314-316`). A "universal candidate gates on a multi-model panel" needs (i) N-model runs and (ii) a **decision-combination policy** (all-accept? majority? worst-case-regression?) — a materially new mechanism. Defer explicitly; do not imply `ab` covers it.
   - Recommend build INCREMENTALLY later (simplest first — likely just a `vendor` level), gated on loop-1 proving the single-model loop + a real 2nd primary-loop model. Consult `capability-envelope.md` (per `INDEX.md:17`) before registering the deferral in `docs/explicitly-not-now.md` + INDEX entry. The three-way seed categorization (step 2) populates it.

## Constraints
- **Model-specificity is real (don't force agnostic):** opencode itself ships per-vendor base prompts → models differ enough to tailor. Seeds are placed on the target-model axis universal/vendor/model (step 2); the axis itself is SPEC'd in step 5 and BUILT later (Gall's law). Today's store has no target-model key → a candidate gated on one model can silently regress another → the multi-model panel gate (step 5) is what prevents shipping a false "universal".
- **Leaked-source ethics:** CC repo is leaked Anthropic proprietary → distilled learning only, no verbatim CC-prompt commit. opencode + official plugins are public → verbatim fine.
- **No loop collision:** pure read + doc + meta-prompt edits; does NOT touch the account-global store the running loop writes. Playbook SEEDING is deferred (measure-first, same propose→ab gate as loop-1).

## Verification
- Extraction: per-source checklist of key prompts captured (whole-file-then-local-slice for CC).
- Doc: mapping table complete; seed-corpus deduped against the COMMON opencode base + each bullet tagged universal/vendor/model.
- Meta-prompt edits (`propose.ts` + `judge-prompt.txt`): `bun test` green + `tsc` clean + one `/mh-propose` (or propose dry-run) smoke confirming the edited proposer prompt still emits valid playbook ops; a judge unit/smoke if `judge-prompt.txt` changed.
- `squad-def.ts` wire edits are OUT of scope (no safe existing path to ship them — see step 4); not attempted in this task, so nothing to verify there.
- Spec (step 5): a reviewer can answer "additive or override? how does curation span the axis? what's the panel decision-policy?" from the doc alone — else the spec is incomplete.

---

> **NOTE:** the plan below is the earlier, still-pending best-of-k plan (Phase 0
> shipped; Phase 1 gated on the Phase-0 correlation result). Preserved here + in
> `docs/capability-envelope.md` + memory `[[static-loop-mechanics]]`. Not part of
> the CC/opencode prompt-mining task above.

---

# Plan: best-of-k search-with-verifier (design + phased, measure-first)

## Context

capability-envelope.md #1 — highest-leverage inner-loop lever. verdict→score
(#2, `parseVerdict().score`) shipped as its brick. This designs the selector:
generate k candidate implementations, rank by a verifier, keep the winner.

**Reframe from exploration + adversarial architect review (2026-07-14):**
- **The selection signal is LLM self-verification, the grader is separate by
  construction.** The fleet evaluator is a haiku LLM emitting a self-reported
  `VERDICT … score=p/t` (`roles.ts:52-60`, `squad.ts:90-91`); TB2's real
  verifier (`bench/verifier.ts:54-78`) is **binary** and runs only AFTER the
  agent's turn (`cmd-run.ts:224-237` — no `/tests` mounted during the turn), so
  it's held out by construction. The adviser's within-task-held-out defense is
  therefore N/A here; the real unknown is empirical.
- **THE load-bearing unknown: does the agent's own verification predict the
  hidden grader?** If yes, best-of-k lifts the true pass-rate; if no, it selects
  noise. Unmeasured.
- **Key correction (architect D): measuring this does NOT need the squad.** The
  already-built single-agent bench pipeline (`cmd-run.ts:runTaskOnce`/`runAgent`,
  `verifier.ts:runVerifier`) already creates the container, runs one agent turn,
  and captures the real hidden `reward.txt`. Adding self-verification is one
  harness-prompt instruction. This splits the cheap question ("does LLM
  self-verification work at all") from the expensive one ("does the squad
  pipeline expose it") — test the cheap one FIRST.

**Decisions (user):** measure-first (correlation gate before the k-loop); rank
on the strongest achievable score. HONESTY CORRECTION: a truly harness-
*verified* selection score is impossible by construction — the only independent
verifier IS the held-out grader, and selecting on it recreates the coupling we
avoid. What's achievable is **harness-controlled TRANSPORT of a structured
self-report**: the agent runs its own checks and writes `passed/total` to a
fixed file the harness reads via `podman exec` (robust; avoids fragile
prose-parsing) — but the *content* is still the agent's own claim, with NO
independent-execution guarantee like `reward.txt` (which the harness itself runs
via `test.sh`). Phase 0's whole job is to measure whether that structured
self-report can be trusted.

## Phase 0 — cheap single-agent correlation gate (build nothing downstream until it passes)

Question: does an agent's own real-execution self-score predict the hidden TB2
reward? Reuses the ENTIRE existing single-agent bench pipeline — zero new
subsystem, no squad, no ctrf/pytest.

1. **Harness-prompt the benched solo agent** (via the `harnessMd`/AGENTS.md
   already threaded into `runAgent`, `cmd-run.ts:224-234`) to, after
   implementing, **write and run its own checks and emit the real count to a
   fixed file**: `echo "$passed/$total" > /logs/self-check/score.txt`. Bash,
   language-agnostic — NOT ctrf/pytest (the task suite spans C/Rust/Go/…; ctrf
   is one hidden TB2 task's own thing, a red herring — architect B3).
2. **Harness reads `score.txt`** by MIRRORING verifier.ts's exec+read PATTERN
   (`verifier.ts:74-77` does `podman exec cat …/reward.txt` → trim → check) —
   but note that code parses a BINARY `"0"/"1"`, so the `passed/total` fraction
   parse (`Number()` split) is NEW logic, not a reused idiom. The result is a
   harness-controlled-transport self-score (structured file read, not prose),
   NOT an independently-verified one (see Decisions above — the content is the
   agent's own claim).
3. **Correlate** self-score vs the hidden `reward` (existing `runVerifier`) over
   N tasks. **GATE (stopping rule):** N ≥ 30 band tasks; proceed to Phase 1 only
   if self-score is meaningfully predictive — concretely, `reward` rate among
   agent-self-PASS runs materially exceeds the base rate (e.g. ≥ +20pp lift,
   or point-biserial r with p<0.05). If not predictive: best-of-k selects noise
   as designed — STOP, reassess the selector (property/formal checks), do not
   build the k-loop.

Cost: N single-agent runs (≈ the existing baseline's per-task cost) + zero new
LLM machinery. Confirm budget before the run.

## Phase 1 — best-of-k selector (ONLY if Phase 0 gate passes)

Now the squad-specific version, with every architect defect fixed.

**1a. Candidate isolation + winner materialization (architect B1 — severe).**
The k implementer drives must NOT share one mutating tree (`run.ts:205`
drives one persistent `--dir`; the implementer "commits locally", so candidate 2
would build on candidate 1 — not independent samples; and argmax only rewrites
SquadState *text*, so evaluator-verdict would grade whatever code is on disk =
the last candidate, not the winner). Fix: **one git worktree per candidate**
(the registered fleet write-merge primitive — best-of-k is its first instance),
run each implementer drive in its own worktree, score each, then **materialize
the winner** (checkout/apply the winning worktree onto the canonical tree)
before falling through to `evaluator-verdict`.

**1b. Per-candidate self-score via harness-controlled transport, NON-LLM
(architect B2, B3).** Each candidate's rank = the same `score.txt` signal as
Phase 0 (agent runs its checks in its worktree → `echo p/t > score.txt` →
harness reads) — harness-controlled TRANSPORT, still the agent's own claim (see
Decisions), NOT independently verified. Reading it is **compute, not an LLM
drive**. So the LLM cost is **k implementer drives + 1 evaluator-verdict drive
on the winner = k+1**, NOT 2k (the earlier "2k" assumed an LLM eval per
candidate — wrong once ranking is a file read, not a drive). Requires a
new wire sub-contract forcing the implementer/evaluator to emit runnable checks
at the fixed `score.txt` path (architect B3 — this is a real new persona
contract + harness step + the language-agnostic `p/t` format, NOT "reuse
verifier.ts").

**1c. k-loop insertion (agent 1 mechanics).** Replace the single `drive` at
`squad.ts:185` for the `implementer` phase with the k-loop (1a/1b); set winner
into `s.artifacts.implReport` + `s.lastDriveId`/`s.lastImplementerDriveId`
(`squad.ts:230-232`); fall through UNCHANGED to `evaluator-verdict` (`:236-285`).
Topology intact.

**1d. Knob + back-compat (architect B5).** `flow.bounds.bestOfK`
(`squad-def.ts:16,37`), validated `checkIntBound("bestOfK", …, 1, 8)`
(`squad-propose.ts:291-299`, mirror table `:199-208` + ranges `:216-221`). Loop
site MUST read `const k = def.flow.bounds.bestOfK ?? 1` — `i < undefined` is
`false`, which would drive ZERO times and break every existing squad store.
Cost safeguard: bestOfK multiplies drive cost up to 8× — cap low, and consider
excluding it from proposer-mutable knobs (unlike R1/R2/R3 retry ceilings, it's a
cost multiplier the autonomous proposer shouldn't freely raise).

**1e. Score + archive ALL k candidates (architect B6).** Every implementer
drive writes a pending session (`run.ts:247`); today only the winner reaches
`score.json`, so the k-1 losers orphan forever AND the tier-1 proposer only ever
sees winners (survivorship bias). Fix: score each candidate (winner good /
losers bad by the harness score) and archive all k, so the implementer persona's
fitness evidence is unbiased.

**1f. Diversity — impl-axis only for v1 (architect B7, B8).** v1 diversity =
re-drive the same plan k times (model stochasticity, per-candidate worktree).
Plan-diversity (top-k designer `## Alternatives`) is DEFERRED: it needs
state-forking at gate2 into parallel continuations (a different fan-out point,
doesn't exist), AND the alternatives aren't guaranteed splittable (wire is a
substring check `lintPayload` squad-def.ts:201; the ≥2-parseable-options prose lives in the
evolvable persona, not code). Do not bundle it into the k-loop.

## Phase 2 — diversity strength (if v1 impl-diversity is correlation-limited)

Add `temperature`/`seed` passthrough to drives for real impl-diversity. CAVEAT
(architect C): `opencode run` CLI support for per-invocation temp/seed is
UNCONFIRMED in this repo (`drivers/opencode.ts buildArgv` has no such flag) —
verify opencode supports it before planning on it.

## squad-on-bench (prerequisite for Phase 1 validation, NOT Phase 0)

Phase 1's live validation (bestOfK=1 vs k on the hidden reward) needs the squad
running in the bench container. This is NOT a thin adapter (architect B4): the
squad drives host-side (`cmdRoleRun`→`opencode run --dir <host>`), the bench
drives container-side (`agent-run.ts:178` `podman exec`). Needs: a new
podman-exec `DriveFn` (not `cmdRoleRun`), a container lifecycle spanning the
whole 5-phase run (bench today is create→one-agent→teardown), persona files
delivered into the container, auth mounts reused, and — critically —
`gatePolicy: "auto"` passed explicitly (`squad-cli.ts:198-199` defaults to
`"root-human"`, so an unattended loop HANGS on the first gate). Scope as its own
increment; Phase 0 deliberately avoids it.

## Files / reuse (verified)
- Insert: `squad.ts:185,229-234,236-285,131,32-55`; knob `squad-def.ts:15-19,36-40`
  + `squad-propose.ts:252-256,291-299,199-208,216-221`; signal
  `squad-def.ts:219-250` + `verifier.ts:54-78` (exec+read PATTERN to mirror, new
  suite). Serial-k prior art `cmd-run.ts:362`. Phase-0 harness-prompt seam
  `cmd-run.ts:224-234` (harnessMd). No argmax/fan-out/worktree code exists — new.

## Verification
- Phase 0: the correlation number IS the result; hermetic unit test for the
  `score.txt` parser (mirror verifier.ts tests). Live cost = N single-agent runs.
- Phase 1: hermetic squad tests (scripted per-candidate scores → assert argmax
  winner is MATERIALIZED onto the tree and routes; k=1 byte-identical to today;
  bestOfK `?? 1` back-compat; all-k scored/archived). Live: squad-on-bench ab
  bestOfK=1 vs k on hidden reward.

## Open / risks
- Phase 0 gate may fail → best-of-k as designed is dead (needs property/formal
  selector). Finding out cheaply is the POINT.
- B1 worktree isolation = the fleet write-merge primitive; best-of-k is its
  first real use.
- squad-on-bench is a real increment (B4), gating Phase 1 *validation* (not
  Phase 0).
- Update capability-envelope §4 when this lands: the within-task-Goodhart/
  held-out OPEN item is SUPERSEDED by the structural selector≠grader finding.
  The other OPEN item (plan-diversity is gate-coupled — measure upset rate)
  remains OPEN/DEFERRED (1f defers plan-diversity), NOT resolved.
