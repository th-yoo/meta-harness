# docs/ index — the durable map

- **[resume.md](resume.md) — START HERE on a new host/session** (how to continue the loop; personal memory doesn't transfer).

One entry per canonical doc so a fresh/cleared-context session can re-find the
design state. Git is the backstop; `~/.claude/.../memory/MEMORY.md` points here.

## Architecture & loops
- [evolution-loop.md](evolution-loop.md) — the components (store, layers, proposer, judge, gate).
- [improvement-loops.md](improvement-loops.md) — the PROCEDURAL view: how static (TB2 bench) & dynamic (runtime) improvement actually run, and how they compose.
- [loop-1-state.md](loop-1-state.md) — FIRST propose→ab run (#5) live state: baseline 0.381, 14-band split, account-global **v1** created (playbook preserved), next=`ab`. Cross-host continuation notes (account store is host-local — scp or re-run).
- [enhancement-roadmap.md](enhancement-roadmap.md) — what was built (dated status blocks).
- [loop-3-timeout-design.md](loop-3-timeout-design.md) — **DESIGN (pre-plan, 2026-07-16)**: close the timeout blind-spot. Timeout drives = 0-turn reward=0 skipped at `record.ts:299` → proposer never learns timeouts (live: tune-mjcf 638s in loop-2). Fix = record-timeouts (plumb a `timedOut` discriminator — `runAgent` returns identical `turnCount:0` for timeout/auth/transient — + add optional `elapsed?`/`timedOut?` to score.json, additive) + budget-inject + re-baseline (recording-policy change shifts pass-rates → silent-Goodhart; re-score active + stamp `maxAgentTimeout` as budget-identity). Task breakdown T1–T7; 3 open Qs.
- [explicitly-not-now.md](explicitly-not-now.md) — deferral register: every deliberate non-decision + its reopen trigger. Read before proposing "new" work.
- [python-elimination.md](python-elimination.md) — the runner.py→Bun cutover (complete).

## Memory / retrieval
- [memory-landscape.md](memory-landscape.md) — where meta-harness sits in the agent-memory literature (category, prior art, gap→paper), + how we keep memory under a bounded context window.

## Capabilities / strategy
- [capability-envelope.md](capability-envelope.md) — `discoverable = mutable ∩ benchmarked`: what the loop can/can't improve, the inner-loop gap map, and the reordered roadmap (search-with-verifier #1). Read before adding a deferral with an off-benchmark trigger.
- [external-practices-openclaw.md](external-practices-openclaw.md) — mined OpenClaw "vibe coding" best practices → mapped to our system (mostly validates it) + a seed-bullet corpus for the proposer (test what propose discovers before hand-seeding). We add the selection gate they lack.
- [external-prompts-cc-opencode.md](external-prompts-cc-opencode.md) — mined Claude Code / opencode / official-plugin prompts → a 22-bullet seed corpus tagged A–D × universal/vendor/model (deduped against opencode's common base) + 6 meta-prompt lessons for `buildProposerPrompt`/`judge-prompt.txt`. Same "measure before seeding" discipline; we add the selection gate they lack.
- [target-model-axis.md](target-model-axis.md) — SPEC (build deferred, `explicitly-not-now §2.4`) for the **target-model / content-generality axis** (universal→vendor→model) that gives the seed corpus's vendor/model tags a home: additive-only merge (no override), one global budget over the resolved coordinate set, N-model panel gate with worst-case-nonregression. Disambiguated from the frozen squad-structure `model` pins.
- [ai-dev-automation-survey.md](ai-dev-automation-survey.md) — adversarially-verified prior-art survey (MetaGPT/ChatDev/AlphaEvolve/DGM/STOP/Reflexion, 24 primary sources) for the fleet + **self-hosting Loop-B** design: EVOLVE-BLOCK freeze-line, frozen gate/store, worktree isolation, held-out-hidden-from-patcher. Concrete recommendation for all 5 open Loop-B decisions; seeds the Loop-B D-series. Includes the R4 follow-up (master/orchestrator): no-auto-merge-to-main is universal, git-worktree isolation validated, OpenClaw long-lived-gateway confirmed. Plus the **master lifecycle & scaling validation** (2026-07-16): persistent-supervisor+ephemeral-workers is the dominant production pattern (Fortune-500 SVW, Temporal, OpenHands, OpenClaw gateway, Gas Town) → feeds fleet D8/D9.

## Fleet / squad (the multi-agent builder)
- [superpowers/specs/2026-07-13-fleet-squad-integration-design.md](superpowers/specs/2026-07-13-fleet-squad-integration-design.md) — **the design spec** (D1–D9 all decided): node grammar, SquadDef, flow state machine, escalation taxonomy, score routing, master boundary layer, repo boundary; **§9.4 D8 master lifecycle & scaling** (singleton authority + composite scheduling, multi-project namespace, two-axis lifetime), **§9.5 D9 crash-consistency** (atomic commit boundaries + restart git-reconciliation) — prior-art validated.
- [superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md](superpowers/specs/2026-07-16-fleet-selfhosting-dev-design.md) — **fleet-as-dev-team, self-hosting** (human-directed, NOT autonomous Loop B): the fleet develops meta-harness's own code via a **parallel task-DAG** (decompose→schedule→merge, worktree-isolated squads) → PR → human merges. Two-layer seed model (shared code / per-user prompts). New pieces N1/N1b/N2/N3/N4/N5a/N5b; T1–T7 build DAG (5 waves). Survey-validated + **code-architect-reviewed to flawless** (4 rounds).
- [master-open-questions-research.md](master-open-questions-research.md) — adversarially-verified research (2026-07-16) on the 4 open master questions. **R1 (build risk): Slack Socket Mode has NO offline durability → master needs a durable inbox + Telegram getUpdates or Slack-HTTP+Delayed-Events, persist-before-ack** (corrects §9.2). R2 candidate-auto-merge behind auto-gate is precedented (DGM), human at main (Copilot). R3 gate must be out-of-process/hidden + gaming-monitor (DGM node-114 gamed its gate; STOP ~0.42% escape). R4 orchestrator credit-assignment = unresolved gap (but deterministic master likely needs no LLM-fitness).
- [master-credit-assignment-research.md](master-credit-assignment-research.md) — **R4 CLOSED (2026-07-16)**: orchestrator credit-assignment. Recommends **exact-by-replay counterfactual difference rewards** — ablate a bullet/role, re-run the SAME frozen `ab` split, take paired `taskDeltas`; the master schedules + derives credit arithmetically from gate verdicts (no LLM scores it — stays deterministic; LLM helpful/harmful demoted to advisory). Reuses the SHIPPED `pairedRunStats().taskDeltas` (ab-stats.ts), not new infra; cost bounded to 0–3 gate re-runs on McNemar-discordant tasks under the D8.3 cap; Shapley deferred. Feeds the master build-plan's deferred credit slot. 5 open Qs.
- [fleet-context.md](fleet-context.md) — the OpenClaw dev-fleet briefing (has a stale-pointer correction header).
- [fleet-integration-plan.md](fleet-integration-plan.md) — the original T0–T6 primitives plan.
- [fleet-integration.md](fleet-integration.md) — the recipe/how-to for driving the fleet.

## Implementation plans (docs/superpowers/plans/)
- [2026-07-13-fleet-squad-depth1-e2e.md](superpowers/plans/2026-07-13-fleet-squad-depth1-e2e.md) — the depth-1 squad E2E build (9 tasks, shipped).
- [2026-07-14-failure-retrieval.md](superpowers/plans/2026-07-14-failure-retrieval.md) — relevance-ranked proposer failure retrieval (shipped) + MCP increment-2 (deferred).
- [2026-07-16-t1-worktree-primitive.md](superpowers/plans/2026-07-16-t1-worktree-primitive.md) — **T1 worktree primitive (N1+N1b) — SHIPPED 2026-07-16** (5 commits 144f31b..f536b6e, reviewed-to-merge). `fleet/worktree.ts` create/remove + `worktreeDir` (code dir) split from `project` (ledger/runtimeRoot) through cmdRoleRun/cmdSquadRun.
- **Self-hosting build DAG (T1–T7, from the self-hosting spec):**
  - [2026-07-16-master-build.md](superpowers/plans/2026-07-16-master-build.md) — **master build-plan** (8 tasks): deterministic singleton orchestrator per §9 + R1-R4. gate-state → transport (Telegram/Slack-HTTP) → relay → frozen-gate+gaming-monitor → namespace → scheduler → reconcile → daemon. R1/R4 override stale §9.2/§9.3. 4 open Qs.
  - [2026-07-16-t4-fleet-dev-scheduler.md](superpowers/plans/2026-07-16-t4-fleet-dev-scheduler.md) — **T4 parallel scheduler (N5a)** (8 tasks): consumes T1; dag-state → worktree-deps policy → runNode (retention+commit) → runDag (wave sched) → D9 reconcile → fsync/atomic score.json → flock+gc → `fleet-dev` CLI. Uses SHIPPED T1 names. 3 open Qs.

## Testing manuals
- [tier3-testing-manual.md](tier3-testing-manual.md) — the interactive full-loop manual test.
