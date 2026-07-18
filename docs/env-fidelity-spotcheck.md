# Env-fidelity spot-check — W3 (GATE for leaderboard-fail picks)

Manual procedure (task-5-brief.md's Phase 5 — W3). **EXECUTED 2026-07-18**
on this machine (podman VM, 4 CPU / 8 GiB). Fresh `--save-all-traj k=1`
captures (model `anthropic/claude-haiku-4-5`, `--layers account`, active
version v0) were taken into an isolated throwaway `META_HARNESS_HOME`
(mktemp copy of config + `global/active` + `global/candidates/v0`); the real
store was never written. Run logs: `term-bench2/logs/env-fid/`.

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
| 1. Dockerfile diff | **Material delta found: the `/tb` mount** | Details below. Package-wise the union is a superset (official apt = `python3 python3-pip sqlite3 xxd`, all in the shared image or staged); fixture COPYs replayed identically (`main.db` → `/app/main.db`, `main.db-wal.encrypted` → `/app/main.db-wal`). But our bench container ALSO gets the whole TB task repo mounted RO at `/tb` (`cmd-run.ts:212` — `{ host: paths.tbRoot, container: "/tb", ro: true }`), exposing every task's `environment/` fixtures (incl. the pristine `main.db-wal.encrypted`), `tests/`, and `solution/`. The official image has none of that. Minor: `file(1)` exists in our union image but not the official one (diagnostic use only). |
| 2. `podman build` real image | **Clean build** | `podman build -t tb2-fid-db-wal-recovery .../db-wal-recovery/environment/` → `localhost/tb2-fid-db-wal-recovery:latest` (id `176d06e5e204`, 516 MB). No apt failures. |
| 3. Replay (trajectory source, truncated?, reconstruction needed?) | **Fresh capture, reward=1; 3 solution-path commands truncated → reconstructed** | Source: fresh `run --save-all-traj` capture `bench-db-wal-recovery-1784383496-454cee.ndjson` (42 events; agent 280.2 s, verifier PASS, reward=1 under our union image). `extractShellCommands` → 25 commands, `truncated=[1,28,32,34,38,39,40]`. Events 1/28/38/40 are `todowrite` (non-shell, irrelevant). Events **32/34/39 are python3 heredocs ON the solution path** (32 = XOR key probing, 34 = the actual XOR-0x42 decrypt, 39 = the `recovered.json` export); all three confidently reconstructed from their captured `output` fields (decrypt output literally says "Decrypted WAL file written to /app/main.db-wal", export output dumps the full 11-record JSON). Per the truncation rule this alone caps the verdict at `soft`. |
| 4. Real `tests/test.sh` | **FAIL — reward 0 (2 failed, 5 passed)** | Replay transcript executed in order inside the official container (`scratchpad replay log`; summarized below). The decisive failure: the captured trajectory's decrypt step reads `/tb/db-wal-recovery/environment/main.db-wal.encrypted` — which does not exist in the official image — and by that point `/app/main.db-wal` is already gone (see below). `test_recovered_data_completeness` and `test_wal_was_decrypted` fail ("Expected 11 records, got 5" / "Only base data recovered - WAL decryption failed"); `/logs/verifier/reward.txt` = `0`. |
| **Verdict** | **soft** | The pass does NOT hold in the official image. Two independent soft triggers: (a) truncated solution-path commands required reconstruction; (b) the replayed pass depends on the union container's `/tb` task-source mount. |

Replay detail (why the official-image replay fails — this is the interesting
part): the very first probe `sqlite3 /app/main.db ".tables"` makes SQLite
open the DB, see a WAL whose header is XOR-garbage, discard it, and **delete
`/app/main.db-wal` on connection close** — the agent's own later backup step
(`cp /app/main.db-wal /tmp/main.db-wal.backup`) already fails with "No such
file or directory" in the official container. In our union container the
same deletion happened, but the agent recovered by `find / -name "main.db*"`
→ discovering `/tb/db-wal-recovery/environment/` → reading the Dockerfile
and the pristine `main.db-wal.encrypted` from the mount, decrypting THAT
(XOR 0x42) and writing it back to `/app/main.db-wal`. In the official image
the encrypted bytes are unrecoverable once SQLite has unlinked the WAL, so
even an adapted decrypt (sourcing the agent's intended backup) has nothing
to read: final export produced only the 5 base records. The `/tb` mount was
the load-bearing escape hatch for this pass. (A trajectory that backed up or
decrypted the WAL *before* any `sqlite3` invocation could legitimately pass
in the official image — but that is not the trajectory we captured, and not
what our leaderboard pass rests on.)

### `path-tracing`

| Step | Result | Notes |
|---|---|---|
| 1. Dockerfile diff | **Material delta found: `rm /app/orig.c` is DROPPED by our staging** | Official Dockerfile: ubuntu:24.04, apt `ffmpeg gcc curl`, `COPY orig.c /app`, `RUN gcc -o orig /app/orig.c -lm`, `RUN ./orig` (renders `/app/image.ppm`), then **`RUN rm /app/orig.c`** — the shipped image contains only `image.ppm` + the `orig` binary (verified: `podman run --rm tb2-fid-path-tracing ls /app`). Our runtime staging replays the copy/gcc/render steps but **drops the `rm` as a "pure cleanup" line** (`staging.ts`'s `classifyRun` — an `rm`-only RUN body is discarded, a faithful port of `gen_setup_deps.py`), so in our union container `/app/orig.c` — the reference renderer source, i.e. the answer key for a reverse-engineering task — is present at agent time. The same `/tb` RO mount delta as db-wal-recovery also applies (`/tb/path-tracing/environment/orig.c` is visible there too). |
| 2. `podman build` real image | **Clean build** | `podman build -t tb2-fid-path-tracing .../path-tracing/environment/` → `localhost/tb2-fid-path-tracing:latest` (id `c3f02c012134`, 1.11 GB). The build itself runs the renderer (`RUN ./orig`), no failures. |
| 3. Replay (trajectory source, truncated?, reconstruction needed?) | **Fresh capture, reward=1; NOT confidently reconstructable → stop per rule (b)** | Source: fresh capture `bench-path-tracing-1784383997-e25b99.ndjson` (61 events; agent 577.3 s, reward=1 under our union image). `extractShellCommands` → 33 commands, **19 truncated events**. Fatal for replay fidelity, in order of severity: (i) **event 4 (3rd tool call): the agent `read` `/app/orig.c`** — the full reference source, which exists only in our container (step 1) — and consulted it again mid-run (event 32, re-reading the camera-setup lines); (ii) the solution artifact `image.c` was produced by `write`/`edit` TOOL events, which are non-shell (rendered as comments in the sh transcript) AND arg-capped at 300 chars — the full file content was never captured; (iii) the final `read` of `/app/image.c` (event 57) is output-capped at 800 chars. The solution file cannot be confidently reconstructed from the trajectory, so per truncation rule (b) the transcript was not blindly replayed and the verdict is capped at `soft`. |
| 4. Real `tests/test.sh` | **FAIL — reward 0 (5 failed)** | Demonstrative partial replay in the official container: the first transcript command (`head -c 5000 /app/image.ppm \| tail -c 2000`) works; the trajectory's precondition read of `/app/orig.c` fails ("No such file or directory"); the transcript compile step `gcc -static -o image image.c -lm` fails (`image.c` cannot be materialized from the capture). Real `tests/test.sh` after that partial replay: all 5 tests fail (`test_image_c_exists`, `test_image_compiles`, `test_no_deps`, `test_runs_and_produces_output`, `test_image_similarity`); `/logs/verifier/reward.txt` = `0`. |
| **Verdict** | **soft** | The union-image pass is answer-key-assisted: the agent's first substantive action was reading `orig.c`, which the official image deletes at build time. Independent soft triggers: unreconstructable truncated solution-path content, and a material Dockerfile delta (the dropped `rm`) sitting directly on the solution path. |

---

## 3. Outcome

If EITHER task lands on `soft` or `env-blocked`: band v2 falls back to
our-pass-rate-only curation for leaderboard-fail picks (no per-task
Dockerfile-fidelity claim) — per-task staging (closing that gap for real)
becomes a separate project, not folded into this loop.

If BOTH land on `faithful`: the leaderboard-fail picks for these two tasks
are trusted as-is.

**Result: BOTH tasks landed `soft`, and in both cases the official-image
replay actually FAILED (reward 0) — these are not merely
procedurally-downgraded passes; the passes demonstrably do not transfer to
the official per-task images.** Band v2 falls back to our-pass-rate-only
curation; no per-task Dockerfile-fidelity claim may be made for these picks.

Root causes surfaced (both actionable, both outside this doc's scope to
fix):

1. **`/tb` task-source mount leak** — `cmd-run.ts:212` mounts the entire TB
   task repo RO at `/tb` in every bench container, exposing each task's
   `environment/` fixtures, `tests/`, and `solution/` to the agent.
   db-wal-recovery's pass used it as a recovery escape hatch (re-reading the
   pristine encrypted WAL after SQLite deleted it); path-tracing's
   `orig.c` is also reachable there. Any pass whose trajectory touches
   `/tb` is suspect.
2. **Staging drops cleanup `RUN` lines** — `staging.ts` `classifyRun`
   discards `rm`-only RUN bodies (a faithful port of `gen_setup_deps.py`'s
   generator behavior), so Dockerfiles that stage-then-delete an answer key
   (`path-tracing`'s `RUN rm /app/orig.c`) leave the key present in our
   union container. Cleanup lines that remove task-solution material must
   be executed, not dropped.
3. (Capture-quality, not env-fidelity:) the 300-char `args` cap and
   800-char `output` cap make full solution reconstruction from a saved
   trajectory impossible for write/edit-heavy tasks — worth raising the cap
   or capturing file-write payloads if replays are to be a recurring tool.

**LEADERBOARD-FAIL PICKS: untrusted**
