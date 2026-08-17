# Gen-3 design call by experiment: the regression gauntlet

**Date:** 2026-08-17 · **Status:** spec, awaiting user review · **Lane:** TB2.1 account-global loop
**Decides:** which gen-3 candidate shape advances — settled by trials on the six tasks
where gen-2 already proved the causal stories, not by argument.

## Background (evidence, all banked)

Gen-2 (v2) REJECTED net −5 vs v1 (92/150 vs 97/150; anchor 89/150). Trajectory-level
investigation (resume 08-17 ~18:00 block) found two mechanisms and one rig gap:

1. **First-idea anchoring** — sam-cell-seg 0/5 (v1 4/5): five independent trials
   produced the identical first approach and polished it; "no exploration until first
   runnable deliverable" suppressed approach search on quality-graded tasks.
2. **Premature completion confidence** — adaptive-rejection-sampler 2/5 (v1 5/5):
   turn distribution truncated (max 15; v1 passed at 29/56); failing finals claim
   "complete and verified" against a failing verifier.
3. Rig gap (fixed `ba86fc4`): no guard predictions in the production propose path;
   guards.json + expect_unchanged_guards now live. Taxonomy surfacing fixed `d1ec116`.

v2's pacing bullets also RESCUED runway-death tasks: sanitize-git-repo 3/5 (v1 0/5),
db-wal-recovery 3/5 (v1 1/5). A good gen-3 keeps the rescues and stops the regressions.

## The experiment

### Arms (candidate shapes)

- **V-A — scope-triggered pacing** (the already-planned gen-3 mint): failure-taxonomy
  over v2 → `/mh-propose account` with guards live; expected shape = pacing bullet
  conditioned on incompletion risk, not applied to precision/build tasks
  (rejected.json rule-8 exception: overreach attributed, mechanism certified).
- **V-C — V-A + mechanism counterweights**: the scope-triggered pacing bullet plus
  two bullets aimed at the proven mechanisms — (i) enumerate ≥2 candidate approaches
  and pick deliberately before committing scaffold on quality-graded work
  (anti-anchoring), (ii) "done" claims require a passing task-level check first
  (anti-premature-completion). Behavior-level wording only (no domain recipes).
- **V-B — machinery provenance arm (deferred, no clock pressure)**: build
  taxonomy-class → per-class bullet scoping into propose.ts. Acceptance = the
  machinery autonomously re-derives the WINNING shape of this experiment without a
  human reading trajectories. Runs after the A/C verdict; not part of the trial spend.

Both V-A and V-C are minted through the normal path and must pass the review gate.
If the proposer will not emit V-C's counterweights organically, V-C is authored from
V-A's proposal JSON plus the two bullets and still must clear the review gate.
Guards for both mints: the four regressed tasks (sam-cell-seg, polyglot-rust-c,
torch-tensor-parallelism, adaptive-rejection-sampler) as expect_unchanged_guards.

### Mini-board (`term-bench2/splits/regression-gauntlet.txt`, 6 tasks)

```
adaptive-rejection-sampler
db-wal-recovery
polyglot-rust-c
sam-cell-seg
sanitize-git-repo
torch-tensor-parallelism
```

Four regressed + two rescued. v1's banked k=5 rewards on all six exist in the gen-1/
gen-2 leaderboard exports — v1 is NEVER re-run (same frozen-rows ruling as the anchor).

### Protocol

1. Mint V-A, then V-C (propose calls only; minutes; no arm spend).
2. Both candidates k=5 on the mini-board — **60 trials total**, run per candidate:
   ```
   bun term-bench2/runner.ts run \
     --task-file term-bench2/splits/regression-gauntlet.txt \
     --model anthropic/claude-sonnet-5 --driver claude-code --k 5 \
     --layers account --pin account-global=<vN> \
     --label gauntlet-<vN> \
     --min-agent-timeout 3600 --max-agent-timeout 3600 \
     --enforce-resources --parallel --host-pressure on --no-oauth-gate
   ```
   NO `--results-file` (trajectories must reach the store; `--results-file` forces
   noStore, cmd-run.ts:746). Export rows to `term-bench2/leaderboard/` after.
   Screen (k=1) deliberately skipped: on 6 tasks it sits inside the ±1–2/5 drift band.
3. Paired per-task comparison of each candidate vs v1's banked rows.

### Decision rule (pre-registered)

Per candidate, over the six tasks vs v1 banked rewards:

- **Regression guard:** on the four regressed tasks, no task may land more than 1
  pass below v1's banked count, and the summed net across the four must be ≥ 0.
- **Rescue retention:** summed net on sanitize-git-repo + db-wal-recovery must be
  strictly positive (v1's floor there is 1/10 combined).
- **Winner:** the candidate satisfying both with the larger overall net. Both satisfy
  → larger net; tie → V-A (smaller playbook wins). Neither → no advance; both
  verdicts + trajectories feed V-B's machinery build and the next mint. Margins
  inside ±1 per task are drift, not signal — the rule above already absorbs this;
  do not narrate sub-threshold differences.
- The winner earns ONLY a full 31-task-board slot proposal (its own sized go). This
  experiment adopts nothing.

### Cost / time (from gen-2's own trial timestamps)

Per-trial minutes: db-wal 2 · sanitize 3.5 · adaptive 6 · torch 11 · sam 13 ·
polyglot ~20 → one k=1 pass ≈ 55 min serial. 60 trials ≈ overnight with the
parallel scheduler; zero API dollars (OAuth Max20); risk = quota-window zero-turn
attempts (store-excluded, burn wall-clock only).

### Host + hygiene

TB2.1 rig = yoo-mac (mint machinery + v2 store live there). Everything durable —
this spec, the split file, exported rows, verdict — travels via git. Store-writing
runs are not resumable; interrupted arm = re-run same command + `--resume` after
stripping partial tasks. `/login`-freshness before each arm (8h OAuth vs ~5h arm).

## Out of scope

Full 31-task board (separate go) · V-B implementation details (own plan after
verdict) · any activation (adoption verdicts only ever come from the full board).
