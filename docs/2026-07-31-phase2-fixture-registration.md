# Phase 2 fixture-harvest registration note

Seals `phase2-fixture-harvest` (base `2b076c5`). Registers the fixture-ref
sidecar the same way `docs/superpowers/specs/2026-07-30-phase1-check-output-sidecar-design.md`
registered the check-output sidecar: evidence-only, host-local, one-way door
until an explicit ruling says otherwise.

## Live dogfood test (2026-07-31, pre-merge, office host)

Full pipeline proven on a REAL agent session before merge, in a
contamination-free clone (`~/tmp/kkamak-livetest`, own `.km`, not in REPOS —
nothing entered the real sensor stream or the committed snapshot):
branch build deployed to the installed cache via `km-refresh.sh --force`
(grep-verified: `fixture-ref.ts` present, `captureFixtureRef` ×2 in cached
hook-cli); a live Sonnet session given a TDD-red task produced a real
3-round `verify-failed` exhausted cycle; capture wrote 2 fixture-refs + 2
check-output records (rounds 1+2; exhausted final round not captured, per
the documented limitation) with EXACT shared ts `1785458541926`; the tree
ref resolved and carried the session's untracked red test file;
`harvestFixture` (allowlist injected test-side; committed allowlist still
empty) produced a complete task dir with the real transcript ask in
instruction.md; `podman build` of the real repo + `tests/test.sh` returned
**reward=0** — the fixture reproduces the blocked state. Data-quality note
for a later refinement: `extractPromptContext`'s `lastUser` can pick up
skill-injection content recorded as user-type transcript lines.

## What this is

`cc-gate-plugin/src/fixture-ref.ts` (T1) snapshots the dirty working tree at
block time — `git write-tree` into a temp index, `update-ref` to
`refs/kkamak/fixtures/<ts>-<sid8>-r<round>` — and appends one record to
`.km/fixture-refs.ndjson`, sharing the exact `blockTs` the Phase 1
check-output sidecar (`.km/check-output.ndjson`) already stamps on the same
block branch. `(sessionID, ts, round)` is the harvest join key; T2
(`km-crank/src/fixture-harvest.ts`) parses + joins both sidecars and pulls
prompt context from the transcript. T3 (`km-crank/src/tb2-task.ts`) renders
a terminal-bench-2 task dir (`task.toml`, `Dockerfile`, `test.sh`,
`instruction.md`) from the join. T4 (`km-crank/src/harvest-cli.ts`) wires it
together behind an allowlist guard.

## Evidence-only, never in the sync path

Same status as the Phase 1 check-output sidecar:

- `.km/fixture-refs.ndjson` and the `refs/kkamak/fixtures/*` refs it points
  at are host-local runtime state, never exported by
  `scripts/km-sensors-sync.sh` — its `FILES=(gate-outcomes trial-arms)` line
  does not list them (F2), and this note adds nothing to that list.
- No `SensorLine` field changed or added. The check-output/fixture-ref
  capture runs AFTER the Stop decision is finalized but BEFORE it is
  emitted — in `cc-gate-plugin/src/hook-cli.ts`, `captureFixtureRef` is
  `await`ed ahead of `emit(buildStopOutput(...))`. It cannot change the
  decision VALUE: every failure path inside `captureFixtureRef` is caught
  and swallowed (fail-open, verified). What it CAN do is delay delivery of
  a block outcome to the agent, by a bounded worst case of roughly 60s —
  four sequential git calls (`rev-parse`, `add -A`, `write-tree`,
  `update-ref`), each under its own 15s SIGKILL timer
  (`cc-gate-plugin/src/fixture-ref.ts`'s `bunGitRunner`).
- No §4.3 calibration metric is touched by this phase — the fixture ref is
  provenance for harvested terminal-bench-2 tasks, not a scored signal.

## Ref namespace and the one-way door

Refs live at `refs/kkamak/fixtures/<ts>-<sid8>-r<round>` in the repo where
the block happened. They are host-local: an ordinary `git push` does not
move refs outside `refs/heads/*`/`refs/tags/*`, so these do not travel
between hosts on their own. They stay host-local until:

1. a per-repo inclusion ruling adds that repo's basename to
   `FIXTURE_ALLOWED_REPOS` in `km-crank/src/harvest-cli.ts` — a reviewed
   commit, deliberately with no CLI bypass flag (T4's allowlist guard is the
   implementation point for that ruling), AND
2. the refs themselves are explicitly pushed (deferred — see the phase
   plan's "Deferred within the phase" section; the harvested, committed
   task dir is the travel vehicle in the meantime, not the raw ref).

`FIXTURE_ALLOWED_REPOS` stays `[]` as committed by this phase — no repo is
allowlisted yet.

## Known limitations

- **Exhausted final rounds are not captured.** The `rawOut` on an exhausted
  round never leaves `core/stop.ts` — `cc-gate-plugin/src/core/` is a
  MECHANISM_PATH (F1), so a capture call cannot be inserted there without
  breaking the phase's F1 constraint. This is the same limitation the Phase
  1 check-output sidecar has, for the same reason (documented spec
  limitation, not an oversight — see the Phase 1 design doc's equivalent
  note).
- **The tamper guard is narrow by design.** `test.sh` restores only the
  `TEST_PRISTINE_GLOBS` dirs (`test`, `tests`, `__tests__`) from the
  capture-time archive before rerunning the check. A harvested task whose
  check depends on fixtures outside those three directory names is not
  protected against an agent editing them to force a pass.
- **Hygiene is best-effort, pattern-based.** The materialize step strips
  `.env*`, `.npmrc`, and `.netrc` recursively (any depth) from
  `environment/repo/`, but that is a fixed name-pattern list, not a secret
  scanner — it does not catch, e.g., a credential pasted into a tracked
  file with an unmatched name. Separately, transcript text lands verbatim
  in `instruction.md` and `fixture.json` (original session ask, most
  recent instruction, failing-check excerpt) with no redaction at all. A
  harvested task dir must be manually scanned before it is committed; that
  scan is part of the burden the per-repo inclusion ruling above already
  takes on.

## Smoke evidence (Task 5, this seal)

All five steps run against a synthetic scratch repo
(`t5-smoke-fixture`, gate.json `{"check": "bun test", "rounds": 2}`, one
intentionally failing `bun test`), driving the WORKING-TREE
`cc-gate-plugin/src/hook-cli.ts` with a synthetic PostToolUse (`Edit`) then
Stop payload, exactly as a live Claude Code session would.

### Step 1 — live capture smoke

`.km/fixture-refs.ndjson` record produced:

```json
{"ts":1785456413013,"sessionID":"smoke-1785456401","round":1,"check":"bun test","headSha":"4faecbec1487b20fae3bd0e623ee795ea1f5b65a","treeSha":"167c5ee1c90eb7e5b698616fcdcb67ab13684d5b","ref":"refs/kkamak/fixtures/1785456413013-smoke-17-r1","transcriptPath":"<scratch>/transcript.jsonl"}
```

No `bail` field (non-bailed record). Paired `.km/check-output.ndjson`
record has `"ts":1785456413013` — identical to the fixture-ref record's
`ts`, confirming the shared-`blockTs` join key holds. `treeSha` resolves:

```
$ git -C <scratch repo> cat-file -t 167c5ee1c90eb7e5b698616fcdcb67ab13684d5b
tree
$ git -C <scratch repo> rev-parse 167c5ee1c90eb7e5b698616fcdcb67ab13684d5b
167c5ee1c90eb7e5b698616fcdcb67ab13684d5b
```

### Step 2 — harvest smoke

One-off driver script (not committed) called `harvestFixture` from
`km-crank/src/harvest-cli.ts` with `allowedRepos: ["repo"]` (the scratch
basename) and an out dir outside `term-bench2/tasks`. Produced
`harvested-repo-20260731-000653/` with `task.toml`, `environment/Dockerfile`,
`environment/repo/` (materialized from the captured tree, `.km/` and
`.env*` stripped), `tests/test.sh`, `tests/pristine.tar`,
`instruction.md`, `fixture.json`. `instruction.md` reads cleanly (original
session ask + most-recent instruction from the synthetic transcript +
check command + failing check excerpt). `fixture.json` provenance is
complete: `ref`, `excerpt`, `firstUser`/`lastUser`, `generatedAt`,
`repoPath`.

### Step 3 — container fidelity smoke (podman 4.9.3)

```
$ cd <task-dir>/environment && podman build -t harvest-smoke .
...
Successfully tagged localhost/harvest-smoke:latest
```

Raw fixture (oracle-inverse — reproduces the failure):

```
$ podman run --rm -v <task-dir>/tests:/tests:ro harvest-smoke \
    bash -c 'mkdir -p /logs/verifier && bash /tests/test.sh; cat /logs/verifier/reward.txt'
...
(fail) add adds two numbers [0.14ms]
 0 pass
 1 fail
---REWARD---
0
```

Fixed, non-interactively via `podman run ... bash -c 'sed -i ... /app/src/add.ts && bash /tests/test.sh'`
(no `-it`):

```
(pass) add adds two numbers [0.07ms]
 1 pass
 0 fail
---REWARD---
1
```

Both directions hold: `0` on the raw fixture, `1` after the fix, same task
dir, same verifier.

### Step 5 — phase verification

```
$ git log --oneline 2b076c5..HEAD -- cc-gate-plugin/src/core cc-gate-plugin/vendor
(empty)
$ git log --oneline 2b076c5..HEAD -- scripts/km-sensors-sync.sh
(empty)
```

F1 (MECHANISM_PATHS untouched) and F2 (sync-script FILES list untouched)
both hold across the whole phase.

```
$ cd cc-gate-plugin && bun test
 404 pass / 0 fail / 1161 expect() calls, 27 files
$ cd km-crank && bun test
 220 pass / 0 fail / 424 expect() calls, 15 files
$ cd cc-gate-plugin && bunx tsc --noEmit   # exit 0, no output
$ cd km-crank && bunx tsc --noEmit        # exit 0, no output
```

## Deferred within the phase (unchanged from the plan)

- First real k=5 replay — blocked on a live block event reaching the
  sidecars from real Claude Code usage (none as of 2026-07-31). Model-token
  spend when it happens: explicit go required.
- Ref pushing / cross-host fixture travel — deferred; the harvested,
  committed task dir is the travel vehicle for now.
- Solution dirs for harvested tasks — deferred until a real fixture exists.
