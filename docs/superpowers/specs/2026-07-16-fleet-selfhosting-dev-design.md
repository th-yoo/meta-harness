# Spec: fleet-as-dev-team — PARALLEL task-DAG dev, self-hosting (human-directed)

## Context

Use the EXISTING fleet (A→D→I→E squads) as a human-directed **development team**,
applied to the meta-harness repo itself: human instructs → fleet develops → PR →
**human merges**. This is NOT an autonomous self-improvement loop (the earlier
"Loop B" autonomous code-gate idea is **DROPPED** — explicitly-not-now §2.1
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
2. **Schedule + run parallel (N5a):** a scheduler runs every **READY** node (deps satisfied) concurrently up to a **max-concurrency cap**, each as its own **A→D→I→E squad in its own git worktree (N1)** — topological waves. As a node's Evaluator returns VERDICT PASS, its dependents unblock. (Fleet recursion: node = squad; star topology — nodes never message peers, they **merge**.)
3. **Merge + integration-verify (N5b):** completed node worktrees merge into an **integration branch** (the best-of-k B1 write-merge primitive). Disjoint file-sets prevent only *textual* conflicts — two disjoint-file nodes can still break a shared interface. So after merging, **re-run the repo's own deterministic gate — `bun test` + the smoke suite (`smoke/fleet/…`) — on the integration branch itself**; a green per-node VERDICT is NOT sufficient. Deterministic-gate (not the per-node Evaluator VERDICT) by design: `inputFor`'s evaluator-verdict branch (`squad.ts:90-91`) builds its prompt from ONE node's `testSpec`+`implReport`, so it has no coherent input for a merged multi-node branch; `bun test`+smoke needs no synthesized spec and is exactly what the human PR reviewer would run. A git conflict OR an integration-gate FAIL → escalate (`Exhausted`/human) or spawn a merge-resolution node. (A future option: a fresh evaluator drive with a synthesized whole-feature testSpec — deferred; the deterministic gate is the v1 mechanism.)
4. **PR → human merge (N2):** the *verified* integration branch → one PR → **human reviews + merges to main** (the authoritative gate). Individual nodes never open their own PR — there is exactly one PR per feature, the integration branch's.

This makes N1 (worktrees) load-bearing twice over: it's what lets parallel nodes
write safely AND what keeps self-hosting from mutating the live tree.

## Reuse (built today — do NOT rebuild)
- A→D→I→E runner (`fleet/squad.ts`), `squad-run` CLI + **checkpoint / exit-and-wait resume** (`fleet/squad-cli.ts`), `--project`/`--slice` targeting.
- **root-human intent gates** (gate1 spec, gate2 design) + `--resume --gate-answer approve|revise` (`squad-cli.ts:185-225`; root-human default at `squad-cli.ts:223`; `answerGate` at `squad.ts:304-322`).
- **Evaluator dev-test + VERDICT = the pre-PR quality check** (`evaluator-verdict` at `squad.ts:236-284`; the "runs checks" is the driven `mh-evaluator` persona's behavior, `roles.ts:52-60` bash-allow/edit-deny).
- **merge-score hook** (`score.ts:42,84-93`, `role-score --gate merge`) — fitness for the merge decision.
- **credential env-scrub** (`fleet/sandbox.ts` — header `:9-12`, `sandboxEnv` doc `:129-132`): denies a bash-allow role remote git/gh **write credentials** (`REMOTE_WRITE_DENY_ENV`, `GIT_CONFIG_GLOBAL`, `GH_CONFIG_DIR`). NOTE (verified): it is an **all-or-nothing env scrub, NOT a git/gh argument filter**, and its own doc (`:184-187`) names a residual bypass (a role can re-add a credential helper via `git -c credential.helper=…`). N2 is designed around this limitation (below), not on top of it.

## NEW — the 5 pieces this spec adds

**N1 — Git-worktree isolation (THE precondition; also the long-deferred best-of-k B1 primitive).** Today every role's drive edits the target tree **in place**: the single shared `DriveFn` (`squad-cli.ts:143-163`) passes the same `args.project` as `--dir` (`run.ts:206`) to **all five driving phases** (analyzer/evaluator-spec/designer/implementer/evaluator-verdict) — for self-hosting that mutates the very tree the fleet runs from. NEW: each **squad-run** develops in ONE **throwaway git worktree + branch** off the target repo, and **every role in that run drives with `--dir` = that one worktree** (not just the Implementer). This is load-bearing: the Evaluator (bash:allow) runs the tests behind VERDICT, so it MUST see the Implementer's edits — a per-role or Implementer-only worktree would make VERDICT test the untouched tree and be meaningless. Materializes the "fleet write-merge primitive" flagged as *THE sharpest gap* (`capability-envelope.md:56,60,103`). Two build-time subtleties (verified): (a) `.gitignore` excludes `node_modules/` and `.meta-harness/`, so `git worktree add` carries neither — each worktree needs its own dependency install (`bun install`, or a `node_modules` symlink/hardlink to bound disk+time ×concurrent nodes); (b) the worktree needs a committed base (the target repo's HEAD). (Naming caveat: the `worktree` var in `index.ts:97`/`engine.ts:219` is opencode's project-root — a collision, NOT git worktrees.)

**N1b — Decouple the runtime ledger from the code worktree (a lifecycle correction N1 forces).** The worktree is for CODE edits only; **all `.meta-harness/runtime/**` bookkeeping must stay anchored to the ORIGINAL target-repo root, never the worktree `--dir`.** Three sinks are worktree-scoped today and each breaks if it follows `--dir` into a throwaway tree: (1) `checkpointPath` (`squad-cli.ts:60-68`) → a gate-pause checkpoint dies with the worktree, breaking `--resume --gate-answer`; (2) `pendingDir` (`pending.ts:40-41`, `writePending` `run.ts:247`) and (3) its `scored/` archive — read by the **merge-score hook** (`role-score --gate merge`, `score.ts:84-93` via `readArchived`/`hasPending`) at **human-PR-merge time**, which is *after* the node's worktree (and any worktree-local ledger) is deleted at that node's terminal "done" (retention policy below). If the ledger lived in the worktree, the archived session would already be gone and merge-score would silently break. Fix — **split the one overloaded `project` param at the single call site that couples them.** `cmdRoleRun` (`run.ts`) today takes ONE `args.project` used for THREE things; split it into TWO params: **`worktreeDir`** → the `--dir` argv (`run.ts:206`) AND persona render/lookup `mdPath` (`roles-render` writes into `<worktreeDir>/.opencode/agents`, `render.ts:115`, so the opencode drive running with `--dir worktreeDir` finds them); and **`runtimeRoot`** (= the real target repo) → `FleetPendingSession.project` (`writePending`, `run.ts:247`), `checkpointPath` (`squad-cli.ts:60-68`), `pendingDir`/`scored/` (`pending.ts:40-41`, `score.ts:84-93`). The squad-cli drive closure (`squad-cli.ts:149`) passes BOTH into `cmdRoleRun`. `.meta-harness/` is gitignored so it is never carried into the worktree anyway — the split removes the only remaining risk (code writing to the *worktree's* copy of the ledger). Worktree-retention policy: **keep a run's worktree alive across gate-pause and escalation; delete it only on terminal done/abort** (after its branch is merged or discarded); the ledger, living in `runtimeRoot`, survives that deletion.

**N2 — PR-flow output (integration branch → ONE PR → human merge); the load-bearing invariant is server-side, not local.** Today the squad emits a REPORT and leaves edits in the tree (`squad.ts:229-234`); no branch/PR. The env-scrub *cannot* express "push to fleet-branch OK, main NEVER" (it filters credentials, not `git push` arguments — SEV1), so do NOT add a bounded exception inside it. Honest threat model: the scrub is **reversible** — its own doc names the bypass (`git -c credential.helper=…` reaches the OS keyring, `sandbox.ts:184-191`), both `implementer` and `evaluator` are `bash:"allow"` (`roles.ts:44-60`), and there is **no OS-process boundary** between the orchestrator and the squad children on a single-host/single-account run. Worse, the reachable creds are the **repo owner's own admin identity** (`sandbox.ts:6-9`). So do NOT claim "roles can never touch credentials," and do NOT rely on branch protection **alone**: an *admin*-scoped token reached via the bypass could `gh api` the protection off. Two mechanisms together make the invariant hold, and BOTH are required:
- **(i) Squad children get a NON-admin, fleet-branch-scoped credential — never the owner's admin identity.** A fine-grained PAT / deploy key that can push only `fleet/*` branches, cannot touch `main`, cannot administer the repo. Now the reversible scrub no longer matters: the *only* credential a role can reach is one that structurally cannot mutate `main` or reconfigure protection. This is the load-bearing boundary (promoted from "future hardening" — it is required for the security invariant, not optional).
- **(ii) GitHub branch protection on `main` WITH admin enforcement** ("Do not allow bypassing the above settings" ON → no direct push, no force-push, no `gh pr merge --admin`, required PR review). Defense-in-depth behind (i); also catches an accidental push from the human operator.
The env-scrub stays as a third layer (raises the bar on a default invocation). The **orchestrator** (`fleet-dev`, run by the human-as-master) is the *intended* pusher: `commit worktree → push a fleet-named branch (with the scoped credential) → gh pr create` for the *verified integration branch only*, branch name fixed by the orchestrator (never agent-chosen). The human reviews + merges = the authoritative gate (record via merge-score). (Disambiguation: `fleet/sandbox.ts` = credential env-scrub; `bench/sandbox.ts` = the podman task container — unrelated.)

**N3 — Self-hosting target + seed distribution.** The fleet targets `--project ~/z2/meta-harness` (its own repo). Scaffolding present but personas are runtime-rendered, NOT pre-baked (verified): `opencode.json` at the repo root holds only `$schema`/`plugin`/`permission` (it is **plugin+permission config, NOT a `provider` block**); `.opencode/agents/` ships only `mh-build.md` — the fleet A/D/I/E personas (`mh-analyzer`/`mh-designer`/`mh-implementer`/`mh-evaluator`) are written at run time by `roles-render` (`render.ts:115`, into `<project>/.opencode/agents`). So "mechanically ready" = dir + config wiring exist and the render step produces the personas per run — not that they pre-exist. Distribution: meta-harness code = shared seed; each user gets the seed and evolves their own Layer-2 prompts.

**N4 — DAG decomposition.** The top-level Designer (planner) emits the task-DAG artifact (`{id, task, deps[], files?}`) — a new wire-contract output + schema/lint. Reuses the Designer role; adds the DAG structure. This artifact is what the human approves at **gate2**: the existing root-human gate machinery (`squad-cli.ts:185-225`, `answerGate` `squad.ts:304-322`) gates the top-level *planning* squad, so `approve|revise` on gate2 = approve/revise the DAG (granularity, deps) before any node runs.

**N5a — Parallel scheduler.** A new orchestrator (`fleet-dev` mode) reads the DAG, runs every READY node as a concurrent `squad-run` (each in its own N1 worktree) up to a **max-concurrency cap** (config; default small, e.g. 3–4), and unblocks dependents on VERDICT PASS. It persists its own **DAG-level scheduler state** (which nodes done/running/ready + the integration-branch ref) to a stable runtime file (in `runtimeRoot`, per N1b) so a scheduler crash resumes without re-running completed nodes (per-node squad checkpointing alone does not cover DAG state). This is the parallel-execution engine the master will eventually own; **human-as-master runs it today**.

**N5b — Merge + integration-verify.** Merges completed node worktrees → the integration branch, then **re-runs the deterministic gate (`bun test` + smoke) on the merged branch** (see architecture step 3 — NOT the per-node Evaluator VERDICT, which has no coherent merged input) before handing to N2. Git conflict OR integration-gate FAIL → escalate or spawn a merge-resolution node.

**Crash-consistency (system-down mid-run) — fleet spec D9.** Ephemeral node processes are safe against a crash because **incomplete work is discarded, not consumed** — the system advances only past an **atomic commit boundary** (worktree edits real only after `git commit`; a node done only after checkpoint+score written; a merge real only after its merge commit). Anything before its boundary is outside the durable record → discarded on restart, never merged; **git is the crash-consistent artifact store** (integration-branch commits = the durable truth of completed nodes). Three concrete requirements land here:
1. **Atomic durable-state writes.** Checkpoint (`squad-cli.ts:83-88`) + the squad-def score channel already use `writeJsonAtomic` (temp+rename, `bench/util.ts:68-74`); the **new N5a DAG-scheduler-state** must too, and the **role-store `score.json`** (`harness-store.ts writeJson:476-479`) is currently a plain non-atomic `writeFileSync` to fix (a torn DAG-state or score file = an unrecoverable run). `writeJsonAtomic` also lacks `fsync` → add `fsync(file)`+`fsync(dir)` for power-loss (not just process-crash) durability.
2. **Restart reconciliation** in N5a: on launch, reconcile persisted *intent* vs *git truth* — abort any in-progress merge (`MERGE_HEAD` present), treat a node whose commit-SHA is on the integration branch as done, re-drive nodes live at crash, discard their partial worktrees (idempotent: re-merging an applied commit = no-op).
3. **Per-phase completion flag** in the checkpoint so resume re-runs only the in-flight phase.

Crash blast radius = the nodes live at crash (≤ the concurrency cap); completed nodes' commits + the DAG-state survive.

**Multi-project (forward note) — fleet spec D8.3.** `fleet-dev` here targets ONE project. Running many projects under one master is additive, NOT a redesign: a **project namespace** (per-project isolation of store-slice / worktrees / integration-branch / credential-scope / gate-policy) + **fair-share scheduling under one global resource cap** (shared LLM rate-limit / disk / API quota). The per-project store-slice is the *existing* account/project store layer, NOT a new split — D6's per-role-NAME pooling operates *within* a project (fleet spec §9.4 D8.3). Out of scope for this self-hosting v1 (one repo, one operator); specified in the fleet master-boundary spec §9.4.

## End-to-end flow (parallel)
1. Human: `fleet-dev --project ~/z2/meta-harness --feature "dev feature X"` (new scheduler entry; wraps `squad-run`).
2. **Plan:** a top-level squad's Designer decomposes → **task DAG** (N4); human approves the DAG at gate2 (root-human).
3. **Parallel build:** scheduler (N5a) runs ready DAG nodes as **parallel A→D→I→E squads** up to the concurrency cap, each in its own **worktree** (N1, all 4 roles share it); each node self-gates via its Evaluator VERDICT; dependents unblock on PASS. A node FAIL → existing R2/R3 loops on *that node only* (siblings proceed).
4. **Merge + verify:** completed nodes → integration branch (N5b); **re-run the deterministic gate on the merged branch**; git conflict or integration-gate FAIL escalates.
5. **PR → human merge:** the *verified* integration branch → one **PR** (N2, orchestrator-pushed) → **human reviews + merges to main** = the authoritative gate; the non-admin scoped credential + admin-enforced branch protection block any direct-to-main path.

## Scope boundaries (what this is NOT)
- **NOT** an autonomous code loop / McNemar-on-code / EVOLVE-BLOCK freeze-line — dropped; the human PR is the code gate. `explicitly-not-now.md §2.1` (autonomous harness-code self-modification) stands as deferred and is a *distinct* thing from this human-directed fleet-dev.
- **NOT** the master/OpenClaw build (spec'd for `oc-test`, separate). Today the **human IS the master** (runs squad-run, answers gates, merges); this spec works with human-as-master, the master automates it later.
- **Bootstrap ordering (chicken-and-egg):** N1 (worktree) is the precondition for *safe* self-hosting, so **N1 is built first** — by a human, or by the fleet targeting a NON-self repo — before pointing the fleet at its own tree.
- **Concurrency fires two deferred reopen-triggers (must be handled, not ignored).** N5a's routine parallel `squad-run`s are exactly the trigger named in `explicitly-not-now.md` §5 (the `score.json` concurrent-writer race, "Parallel squad-run invocations become routine → same advisory-flock fix covers both sinks") and §5.1 (pending/checkpoint gc, "routine live fleet use"). This spec therefore **includes**: an advisory `flock` on the two `score.json` sinks (role-score + squad-def score) and pending-dir gc — folded into N5a, not left as silent races.

## Implementation task DAG (this spec — parallelizable; dogfoods the design)

Nodes (proper granularity — each an independently-buildable + testable unit):
- **T1 worktree primitive (N1 + N1b)** — `fleet/worktree.ts`: create/remove a throwaway git worktree+branch off a target repo; thread the worktree as `--dir` for **all** roles of a squad-run; per-worktree `bun install`/symlink; split `cmdRoleRun`'s `project` into `worktreeDir` vs `runtimeRoot` so checkpoint+pending+scored live in `runtimeRoot` (survive worktree cleanup) + retention policy. **deps: none.** *(foundational; also unblocks best-of-k)*
- **T2 push/PR boundary (N2)** — provision a **non-admin `fleet/*`-scoped push credential** (fine-grained PAT / deploy key; cannot touch `main` or admin) as the ONLY credential reachable by a run; orchestrator-owned `commit → fleet-branch → gh pr create` for the integration branch (scrub unchanged as a third layer); enable **admin-enforced** GitHub branch-protection on `main` ("Do not allow bypassing"). **deps: T1, T5** *(needs a worktree to commit and the verified integration branch to PR).*
- **T3 DAG artifact + Designer emit (N4)** — DAG schema + wire-contract so the planner Designer emits `{id,task,deps[],files?}`; gate2 approves it. **deps: none.**
- **T4 parallel scheduler (N5a)** — `fleet-dev` orchestrator: read DAG → run READY nodes as parallel `squad-run`s (T1 worktrees) up to a concurrency cap → unblock on VERDICT PASS; persist DAG-level scheduler state (crash-resume); advisory `flock` on `score.json` + pending gc. **deps: T1, T3.**
- **T5 merge + integration-verify (N5b)** — merge completed worktrees → integration branch → **re-run the deterministic gate (`bun test` + smoke) on the merged branch** → conflict/fail escalates. **deps: T4.**
- **T6 self-host target + seed doc (N3)** — target `~/z2/meta-harness`, the runtime-render persona wiring, the two-layer/seed-model doc. **deps: T1.**
- **T7 end-to-end smoke** — full flow (feature → DAG → parallel nodes → merge → integration-verify → PR → human merge) on a trivial feature. **deps: T2, T5, T6.**

**Parallel build waves (this spec's own DAG):**
- **Wave 0** (no deps): **T1 ∥ T3**
- **Wave 1** (after T1; T4 also needs T3): **T4 ∥ T6**
- **Wave 2** (after T4): **T5**
- **Wave 3** (T2 needs T1+T5): **T2**
- **Wave 4**: **T7** (after T2, T5, T6)

**Bootstrap ordering:** T1 is the precondition for *safe* self-hosting, so build **T1 first** — by a human, or by the fleet targeting a throwaway repo — before pointing the fleet at its own tree. The rest can then be built BY the fleet via this very DAG (the self-hosting proof).

## Verification
- **N1 (isolation + all-roles):** during a run the **live tree stays untouched** (`git status` clean on main); edits land only in the worktree; and the **Evaluator's VERDICT reflects the Implementer's edits** (assert a run whose implementer wrote a failing test yields VERDICT FAIL from the *same* worktree — proves all roles share it, not just the Implementer).
- **N2 (enforcement is real):** on integration PASS a fleet-branch + one PR appear (orchestrator-pushed); the load-bearing check — simulate the `git -c credential.helper` bypass from a `bash:allow` role and confirm (i) the only reachable credential is the **`fleet/*`-scoped non-admin** one, which **cannot push `main`, cannot `gh pr merge --admin`, cannot `gh api` the protection off**, and (ii) admin-enforced branch protection independently rejects any direct push/force-push/admin-merge to `main`; the env-scrub still strips creds from a default role invocation (third layer, not the guarantee).
- **N1b (ledger survives worktree cleanup):** a gate-pause mid-run + cleanup of a *sibling* node's worktree, then `--resume --gate-answer approve` succeeds (checkpoint in `runtimeRoot`); and `role-score --gate merge` at PR-merge time still finds the node's archived session AFTER that node's worktree was deleted (pending/scored in `runtimeRoot`, not the worktree).
- **N4/N5 (parallel DAG + integration-verify):** a 3-node DAG with 2 independent nodes runs **2 squads concurrently** (2 live worktrees observed) within the cap; the dependent node starts only after its dep's VERDICT PASS; all merge into one integration branch; an injected **git conflict** fires escalation; an injected **shared-interface break** across two disjoint-file nodes (each green in isolation) is caught by the **integration gate (`bun test` + smoke)**, not silently PR'd; killing the scheduler mid-run and re-launching resumes from DAG state without re-running completed nodes.
- **N3 (self-host e2e):** `fleet-dev --project ~/z2/meta-harness --feature "<trivial>"` → DAG → parallel nodes → integration branch → integration-verify → PR → **human merges**; the running instance stays safe throughout.
- **Crash-consistency (D9):** SIGKILL the scheduler mid-merge (`MERGE_HEAD` present) → relaunch aborts the partial merge, treats already-committed nodes as done (by branch SHA), re-drives the node live at crash, and discards its partial worktree; no half-merged branch reaches PR. Corrupt/truncate a checkpoint write mid-flight → the atomic temp+rename leaves the prior complete checkpoint intact (run still resumes).
- **Concurrency safety:** two parallel `squad-run`s do not corrupt `score.json` (advisory flock holds).
- **Reuse intact:** `bun test` green; existing squad smoke (`smoke/fleet/squad-demo.sh`) still passes.

## Status
Design approved 2026-07-16 (brainstorm: human-directed dev, not autonomous Loop B;
parallel task-DAG centerpiece). **Reviewed to flawless 2026-07-16** via code-architect
(4 adversarial rounds + a reference-accuracy pass): the first pass found 4 SEV1
blockers (Implementer-only worktree, env-scrub cannot gate pushes, checkpoint dies
with the worktree, no integration re-verify) + SEV2s and 2 wrong code refs; each was
fixed and re-verified until an independent reviewer returned "FLAWLESS — implementable
as written." Net design changes vs the first draft: all 4 roles share ONE worktree;
`cmdRoleRun` `project` split into `worktreeDir`/`runtimeRoot` (ledger survives worktree
cleanup); N2 rebuilt around a **non-admin `fleet/*`-scoped credential** (the real
boundary) + admin-enforced branch protection; deterministic `bun test`+smoke integration
gate; N5a advisory `flock` + pending gc (fires `explicitly-not-now.md` §5/§5.1); the
build DAG re-sequenced to **T1–T7 / 5 waves**. **2026-07-16 additions** from the
master-lifecycle discussion: **crash-consistency (fleet spec D9)** folded into
N5a/N1b (atomic commit boundaries + atomic checkpoint/DAG-state writes + restart
git-reconciliation) with a verification bullet; a **multi-project forward note
(D8.3)** marking the project-namespace + fair-share layer as out-of-scope-for-v1.
Loop B (autonomous code self-improvement) is DROPPED here and remains deferred
(`explicitly-not-now.md §2.1`). Next: an implementation plan (writing-plans)
sequencing the T1–T7 DAG; T1 (worktree primitive) first as the precondition.
