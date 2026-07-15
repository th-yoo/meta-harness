# Spec: fleet-as-dev-team — PARALLEL task-DAG dev, self-hosting (human-directed)

## Context

Use the EXISTING fleet (A→D→I→E squads) as a human-directed **development team**,
applied to the meta-harness repo itself: human instructs → fleet develops → PR →
**human merges**. This is NOT an autonomous self-improvement loop (the earlier
"Loop B" autonomous code-gate idea is **DROPPED** — `explicitly-not-now.md §2.1`
stands). Code correctness isn't McNemar-measurable like prompt pass-rates, so the
**gate for code is the human PR review**, not `ab`. Validated by the two prior
surveys (`docs/ai-dev-automation-survey.md`): no-auto-merge-to-main is universal,
git-worktree isolation is standard, human PR review is the gate, CrewAI's
hierarchical-manager mirrors our master.

**The two-layer model (the frame — state it explicitly):**
- **Layer 1 — CODE base = the shared "seed".** One lineage (this git repo). Developed by the fleet under human direction, merged by a human. Everyone gets the same seed code.
- **Layer 2 — harness CONTENT (system.md/playbook) = per-user.** Evolved by **Loop A (propose→ab)** on each user's own tasks (account/project stores). This is where users diverge. Already built.
- Clean separation (verified): code in git `opencode-plugin/src/`; prompts in `~/.config/meta-harness` + `<proj>/.meta-harness/` stores — a *different* tree.

## Parallel dev architecture — decompose → schedule → merge (the CENTERPIECE)

A feature is NOT one linear A→D→I→E squad — it's a **task DAG run in parallel**
(OpenClaw's 1 human + 3–8 parallel agents; CrewAI's hierarchical manager;
validated by the surveys). Flow:

1. **Decompose (N4):** the top-level squad's Designer (the "planner") emits a **task DAG** — nodes = independently-developable + independently-testable + coherent-diff units; edges = dependencies. **Proper granularity** = each node is one bounded change one squad can own in one worktree, sized so parallel nodes touch **disjoint file-sets** where possible (minimizes merge conflict). Emitted as a structured artifact (`{id, task, deps[], files?}`).
2. **Schedule + run parallel (N5):** a scheduler runs every **READY** node (deps satisfied) concurrently, each as its own **A→D→I→E squad in its own git worktree (N1)** — topological waves. As a node's Evaluator returns VERDICT PASS, its dependents unblock. (Fleet recursion: node = squad; star topology — nodes never message peers, they **merge**.)
3. **Merge (N5):** completed node worktrees merge into an **integration branch** (the best-of-k B1 write-merge primitive); a conflict → escalate (`Exhausted`/human) or a merge-resolution node.
4. **PR → human merge (N2):** the integration branch → one PR → **human reviews + merges to main** (the authoritative gate).

This makes N1 (worktrees) load-bearing twice over: it's what lets parallel nodes
write safely AND what keeps self-hosting from mutating the live tree.

## Reuse (built today — do NOT rebuild)
- A→D→I→E runner (`fleet/squad.ts`), `squad-run` CLI + **checkpoint / exit-and-wait resume** (`fleet/squad-cli.ts`), `--project`/`--slice` targeting.
- **root-human intent gates** (gate1 spec, gate2 design) + `--resume --gate-answer approve|revise` (`squad-cli.ts:185-225`, `squad.ts:304-322`).
- **Evaluator dev-test + VERDICT = the pre-PR quality check** (`evaluator-verdict` runs checks/emits VERDICT, `squad.ts:236-284`; `roles.ts:52-60` bash-allow/edit-deny).
- **merge-score hook** (`score.ts:42,84-93`, `role-score --gate merge`) — fitness for the merge decision.
- credential sandbox (`fleet/sandbox.ts` blocks remote git/gh for bash-allow roles).

## NEW — the 5 pieces this spec adds

**N1 — Git-worktree isolation (THE precondition; also the long-deferred best-of-k B1 primitive).** Today the Implementer edits the project tree **in place** (`opencode run --dir <project>`, `run.ts:205`) — for self-hosting that mutates the very tree the fleet runs from. NEW: each squad run develops in a **throwaway git worktree + branch** off the target repo; the Implementer's `--dir` = the worktree. This materializes the "fleet write-merge primitive" flagged as *THE sharpest gap* (`capability-envelope.md:56,60,103`). (Note the `worktree` var in `index.ts`/`engine.ts` is opencode's project-root — a naming collision, NOT git worktrees.)

**N2 — PR-flow output (branch → PR → human merge).** Today the squad emits a REPORT + leaves edits in the tree (`squad.ts:229-261`); no branch/PR. NEW: on **VERDICT PASS**, commit the worktree to a branch and `gh pr create`. Extend the sandbox (`sandbox.ts:188`, currently blocks all remote git/gh) with a **bounded exception**: allow push to a *fleet-created branch* + open a PR; **NEVER push or merge to main**. The human reviews the PR + merges = the authoritative gate (record via merge-score).

**N3 — Self-hosting target + seed distribution.** The fleet targets `--project ~/z2/meta-harness` (its own repo — mechanically ready: `.opencode/` personas + provider-only `opencode.json` exist). Distribution: meta-harness code = shared seed; each user gets the seed and evolves their own Layer-2 prompts.

**N4 — DAG decomposition.** The top-level Designer (planner) emits the task-DAG artifact (`{id, task, deps[], files?}`) — a new wire-contract output + schema/lint. Reuses the Designer role; adds the DAG structure.

**N5 — Parallel scheduler + merge.** A new orchestrator (`fleet-dev` mode) reads the DAG, runs every READY node as a concurrent `squad-run` (each in its own N1 worktree), unblocks dependents on VERDICT PASS, and merges completed worktrees → an integration branch (conflict → escalate). This is the parallel-execution engine the master will eventually own; **human-as-master runs it today**.

## End-to-end flow (parallel)
1. Human: `fleet-dev --project ~/z2/meta-harness --feature "dev feature X"` (new scheduler entry; wraps `squad-run`).
2. **Plan:** a top-level squad's Designer decomposes → **task DAG** (N4); human approves the DAG at gate2 (root-human).
3. **Parallel build:** scheduler (N5) runs ready DAG nodes as **parallel A→D→I→E squads**, each in its own **worktree** (N1); each node self-gates via its Evaluator VERDICT; dependents unblock on PASS. A node FAIL → existing R2/R3 loops on *that node only* (siblings proceed).
4. **Merge:** completed nodes → integration branch (N5); conflicts escalate.
5. **PR → human merge:** integration branch → one **PR** (N2 bounded push) → **human reviews + merges to main** = the authoritative gate.

## Scope boundaries (what this is NOT)
- **NOT** an autonomous code loop / McNemar-on-code / EVOLVE-BLOCK freeze-line — dropped; the human PR is the code gate.
- **NOT** the master/OpenClaw build (spec'd for `oc-test`, separate). Today the **human IS the master** (runs squad-run, answers gates, merges); this spec works with human-as-master, the master automates it later.
- **Bootstrap ordering (chicken-and-egg):** N1 (worktree) is the precondition for *safe* self-hosting, so **N1 is built first** — by a human, or by the fleet targeting a NON-self repo — before pointing the fleet at its own tree.

## Implementation task DAG (this spec — parallelizable; dogfoods the design)

Nodes (proper granularity — each an independently-buildable + testable unit):
- **T1 worktree primitive (N1)** — `fleet/worktree.ts`: create/remove a throwaway git worktree+branch off a target repo; Implementer drive `--dir` = the worktree. **deps: none.** *(foundational; also unblocks best-of-k)*
- **T2 PR-flow (N2)** — on VERDICT PASS: commit worktree → branch → `gh pr create`; sandbox bounded exception (branch push OK, main blocked). **deps: T1.**
- **T3 DAG artifact + Designer emit (N4)** — DAG schema + wire-contract so the planner Designer emits `{id,task,deps[]}`. **deps: none.**
- **T4 scheduler + merge (N5)** — `fleet-dev` orchestrator: read DAG → run READY nodes as parallel `squad-run`s (T1 worktrees) → merge completed → integration branch. **deps: T1, T3.**
- **T5 self-host target + seed doc (N3)** — target `~/z2/meta-harness`, personas, the two-layer/seed-model doc. **deps: T1.**
- **T6 end-to-end smoke** — full flow (feature → DAG → parallel nodes → merge → PR → human merge) on a trivial feature. **deps: T2, T4, T5.**

**Parallel build waves (this spec's own DAG):**
- **Wave 0** (no deps): **T1 ∥ T3**
- **Wave 1** (after T1; T4 also needs T3): **T2 ∥ T5 ∥ T4**
- **Wave 2**: **T6** (after T2, T4, T5)

**Bootstrap ordering:** T1 is the precondition for *safe* self-hosting, so build **T1 first** — by a human, or by the fleet targeting a throwaway repo — before pointing the fleet at its own tree. The rest can then be built BY the fleet via this very DAG (the self-hosting proof).

## Verification
- N1: during a run the **live tree stays untouched** (`git status` clean on main); edits land only in the worktree.
- N2: on PASS a branch + PR appear; a push-to-main attempt is **blocked by the sandbox**.
- **N4/N5 (parallel DAG):** a 3-node DAG with 2 independent nodes runs **2 squads concurrently** (2 live worktrees observed); the dependent node starts only after its dep's VERDICT PASS; all merge into one integration branch; an injected file-conflict fires the escalation path.
- N3 (self-host e2e): `fleet-dev --project ~/z2/meta-harness --feature "<trivial>"` → DAG → parallel nodes → integration branch → PR → **human merges**; the running instance stays safe throughout.
- Reuse intact: `bun test` green; existing squad smoke (`smoke/fleet/squad-demo.sh`) still passes.

## Status
Design approved 2026-07-16 (brainstorm: human-directed dev, not autonomous Loop B;
parallel task-DAG centerpiece). Loop B (autonomous code self-improvement) is
DROPPED here and remains deferred (`explicitly-not-now.md §2.1`). Next: an
implementation plan (writing-plans) sequencing the T1–T6 DAG; T1 (worktree
primitive) first as the precondition.
