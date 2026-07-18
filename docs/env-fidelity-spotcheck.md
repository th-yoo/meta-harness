# Env-fidelity spot-check — W3 (GATE for leaderboard-fail picks)

Manual procedure (task-5-brief.md's Phase 5 — W3). **SKELETON — not yet
executed.** Fill in the result tables and the final verdict line as each step
is actually run; do not hand-wave a row.

Cannot be automated end-to-end: it requires `podman build`-ing the REAL
per-task image (not our union-staged one) and eyeballing a Dockerfile diff.
The one piece that IS code is the trajectory→sh-transcript extraction, done
by `extractShellCommands` (`opencode-plugin/src/bench/traj-replay.ts`) —
everything else here is by-hand.

Targets: **`db-wal-recovery`** and **`path-tracing`** — two tasks where we
currently pass and the frontier-harness leaderboard reportedly fails, i.e.
exactly the tasks a leaderboard-fail "pick" (Phase 4's flag, Phase 6's
runbook) would rest on. If this spot-check doesn't hold up, that pick isn't
trustworthy.

---

## 0. Why this gates anything

Phase 4 flags tasks where we pass and frontier harnesses fail as candidate
"leaderboard-fail picks" — evidence our environment fidelity (or task
correctness) is genuinely better, not that our container is quietly easier
than the real task. This doc is the check on that claim: build the task's
REAL image, replay what we actually did in it, and see if the pass still
holds. Phase 6's runbook reads the final `LEADERBOARD-FAIL PICKS:` line from
this doc; nothing downstream should trust an unexecuted pick.

---

## 1. Per-task procedure

Repeat for each target task (`db-wal-recovery`, `path-tracing`):

### Step 1 — diff the real Dockerfile vs our union staging

- [ ] Locate the task's real Dockerfile (upstream terminal-bench task repo /
      term-bench2 task source, NOT `term-bench2/staging/` — our union image).
- [ ] `diff` it against what our union staging actually installs/configures
      for this task (`opencode-plugin/src/bench/staging.ts`'s union-build
      output, or the generated Dockerfile it produces).
- [ ] Record every substantive delta (base image, package versions, env vars,
      entrypoint, working dir, pre-installed files) — not just line noise.

### Step 2 — `podman build` the real per-task image

- [ ] Build the task's OWN Dockerfile directly (not through our staging
      pipeline) into a locally-tagged image.
- [ ] Record the image tag/digest and build outcome (clean build vs. any
      deltas from our union environment already visible at build time —
      missing base layers, apt failures, etc).

### Step 3 — replay a passing trajectory in it

- [ ] Locate an existing passing trajectory for this task
      (`term-bench2/logs/` or wherever `--save-all-traj` persisted it — do
      NOT touch live in-progress runs; use a completed one, or produce a
      fresh one per the fallback below).
- [ ] If the trajectory was pruned (no saved `TrajEvent[]`), run a fresh
      `--save-all-traj k=1` capture first, on either driver, before
      replaying — do not fabricate a transcript from memory of the task.
- [ ] Run `extractShellCommands` (`opencode-plugin/src/bench/traj-replay.ts`)
      over the captured `TrajEvent[]` to get `{commands, truncated}`.
- [ ] **Truncation downgrade rule:** if `truncated` is non-empty for any
      command relevant to the task's actual solution path, do NOT execute
      the raw transcript blindly. Either (a) manually reconstruct the true
      command from context (task instructions, the tool's `output` field,
      surrounding events) and note it was reconstructed, or (b) if it can't
      be confidently reconstructed, stop here and record the verdict as
      `soft` (never `faithful`) — a garbled replay must never produce a
      `faithful` verdict.
- [ ] Feed the (possibly reconstructed) `commands` transcript into the real
      per-task container built in Step 2, in order.

### Step 4 — run the real `tests/test.sh`

- [ ] Run the task's actual `tests/test.sh` (not our verifier's copy) inside
      the real container, after the replay.
- [ ] Record raw pass/fail and any stderr/diagnostic worth keeping.

### Step 5 — assign a verdict

Verdict taxonomy (pick exactly one per task):

- **faithful** — Dockerfile diff was immaterial (or immaterial to the
  task's solution path), replay had no truncated/relevant commands, and the
  real `tests/test.sh` passed. This is the only verdict that can back a
  leaderboard-fail pick as "trusted."
- **soft** — replay required manual reconstruction of a truncated command,
  OR the Dockerfile diff is material but plausibly doesn't affect the
  solution, OR `tests/test.sh` passed but with a meaningfully different
  path than what our union image exercises. Usable as directional evidence
  only.
- **env-blocked** — the real image doesn't build, or the replay can't run
  in it at all (missing tooling, incompatible base), so no verdict on
  pass/fail is possible from this procedure. Says nothing about task
  correctness either way.

---

## 2. Results

### `db-wal-recovery`

| Step | Result | Notes |
|---|---|---|
| 1. Dockerfile diff | _(not yet run)_ | |
| 2. `podman build` real image | _(not yet run)_ | |
| 3. Replay (trajectory source, truncated?, reconstruction needed?) | _(not yet run)_ | |
| 4. Real `tests/test.sh` | _(not yet run)_ | |
| **Verdict** | _(not yet run)_ | faithful / soft / env-blocked |

### `path-tracing`

| Step | Result | Notes |
|---|---|---|
| 1. Dockerfile diff | _(not yet run)_ | |
| 2. `podman build` real image | _(not yet run)_ | |
| 3. Replay (trajectory source, truncated?, reconstruction needed?) | _(not yet run)_ | |
| 4. Real `tests/test.sh` | _(not yet run)_ | |
| **Verdict** | _(not yet run)_ | faithful / soft / env-blocked |

---

## 3. Outcome

If EITHER task lands on `soft` or `env-blocked`: band v2 falls back to
our-pass-rate-only curation for leaderboard-fail picks (no per-task
Dockerfile-fidelity claim) — per-task staging (closing that gap for real)
becomes a separate project, not folded into this loop.

If BOTH land on `faithful`: the leaderboard-fail picks for these two tasks
are trusted as-is.

**LEADERBOARD-FAIL PICKS: _(not yet determined — fill in `trusted` or
`untrusted` once both verdicts above are recorded)_**
