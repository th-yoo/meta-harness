# Path A Stage-1 (screen) — execution runbook

**Date:** 2026-08-03 (drafted on the office box, branch `path-a-stage0`).
**Operationalizes:** Stage 1 of `2026-08-01-path-a-seed-tournament.md` (4 arms:
s1, s2, s3, concurrent v7 control; held-in band of 7; k=1; **sonnet** per the
2026-08-03 pre-data amendment, plan lines 15-19).
**Seed provenance:** `2026-08-03-path-a-stage0-provenance.md`.

> **SPEND NOTE (binding):** executing this runbook is bench spend (~28 trials
> + up to 9 re-rolls, est 2-4h wall per plan line 129). It requires its own
> explicit user "go". This document authorizes nothing — it is the procedure,
> not the permission (plan lines 3-4; hard rule: questions ≠ authorization).

Every mechanic below is cited `file:line` against the worktree
`/mnt/d/tmp/wt-path-a-stage0` (= commit `8491fe9` + this doc). Items that
could not be verified from repo evidence are marked **OPEN** inline and
collected in §10.

---

## 1. Mechanism (the candidate-selection research answer)

**How an arm selects its candidate: per-run `--pin`, never an activation
flip.** The runner has a purpose-built `screen` subcommand (usage:
`opencode-plugin/src/bench/cli.ts:66-75`) that sweeps N candidates of one
layer at k=1:

- Per candidate it calls `cmdRun` with `pin: ["<layer>=<candidate>"]` and
  `k: 1` (`opencode-plugin/src/bench/cmd-screen.ts:293-294`). A pinned layer
  composes `candidates/<vN>/system.md` instead of `active/system.md`
  (`opencode-plugin/src/compose.ts:92-93`); the store's active pointer
  (`<storeRoot>/active/.version`, `opencode-plugin/src/harness-store.ts:126-128,802-803`)
  is **never touched**. No flip, no restore step, and the loop-3 "ab requires
  candidate ≠ active" trap (`cmd-ab.ts:249`) does not apply — `parsePins`
  has no such check (`opencode-plugin/src/bench/record.ts:73-107`), so
  pinning `v7` while v7 is active is legal and gives the concurrent control
  arm.
- Each candidate gets its own `--results-file <outDir>/<vN>.json`, which
  **forces `noStore`** (`cmd-run.ts:569-571`: `noStore = Boolean(args.noStore
  || resultsFile)`) — a screen never writes the version store and never emits
  a verdict (`cmd-screen.ts:9-17,357-358`). This matches the plan: screen has
  NO verdict authority.
- Store root selection is by env: `KKAMAK_HOME` overrides
  `META_HARNESS_HOME` overrides `~/.config/kkamak`
  (`opencode-plugin/src/harness-store.ts:78-84`); account-global =
  `<root>/global` (`harness-store.ts:103-105`). The TB2-lane office store is
  `/home/th-yoo/z2/meta-harness/.meta-harness` → symlink to `.kkamak`
  (verified 08-03; recipe precedent `docs/resume.md:1953`).

**Constraint that shapes the whole runbook:** both `screen` and `--pin`
hard-require candidate names matching `^v\d+$` —
`cmd-screen.ts:232-234` ("--candidates must look like vN") and
`record.ts:91` ("version must look like vN"). The committed seed dirs are
named `s1/s2/s3` (`term-bench2/store/global/candidates/s{1,2,3}/system.md`),
so they **cannot be pinned by those names**. Resolution: install vN **aliases**
of the seed texts into the office store (§3 step D):

| arm | alias | source (committed snapshot) |
|-----|-------|-----------------------------|
| control | `v7` (already in office store, active) | byte-identical to snapshot `v0/system.md` (verified 08-03) |
| S1 | `v13` | `term-bench2/store/global/candidates/s1/system.md` |
| S2 | `v14` | `term-bench2/store/global/candidates/s2/system.md` |
| S3 | `v15` | `term-bench2/store/global/candidates/s3/system.md` |

Why v13-15: the office store holds v0-v8 (verified 08-03); the committed
snapshot separately holds v9/v10 dirs + `v11-factory-proposal.json`, so
office-local v9/v10 aliases would collide with committed lineage names, and
**v12 is reserved** for the tournament winner by the adoption rule (plan
lines 149-151). **OPEN (decision, fold into the go):** the v13/v14/v15
naming is this runbook's proposal, not in the plan — user ack required; the
mapping must be recorded in the launch log. Side effect: `nextVersion()` =
max+1 over `^v\d+$` dirs (`harness-store.ts:806-822`), so leaving the
aliases in place makes the next propose mint v16; §9 cleans up.

Fallback if `screen` misbehaves (it is shipped tooling, `docs/resume.md:2260`,
but no live screen run is recorded in resume.md/HISTORY — **OPEN**): the
identical arm can be run as four `run --pin account-global=<vN>
--results-file <f>` invocations (`cli.ts:46-53`); same pins, same noStore
exclusivity.

## 2. Arms × tasks × k (trial accounting)

- 4 arms (`v7,v13,v14,v15`) × held-in band (7) × k=1 = **28 base trials**;
  screen hardcodes k=1 (`cmd-screen.ts:294`).
- Up to **9 re-rolls** for R2-flagged artifacts (plan lines 126-127), run
  serially (§7).
- Held-in band (plan lines 103-105): `path-tracing-reverse mailman
  headless-terminal sanitize-git-repo query-optimize
  financial-document-processor sparql-university`. All 7 verified present as
  `<tbRoot>/<task>/task.toml` under `/home/th-yoo/z2/terminal-bench-2`
  (08-03) — that is the validity check `selectTasks` runs
  (`opencode-plugin/src/bench/tasks.ts:88-115`). Note: tasks do NOT live in
  the repo; `tbRoot` defaults to a sibling `terminal-bench-2` clone of the
  **metaRoot the runner file resolves to** (`paths.ts:74`) — running from the
  worktree therefore requires `--tb-root` (§4).
- Results land at `<worktree>/term-bench2/results/screens/account-global/`:
  `v7.json v13.json v14.json v15.json` + `ranking.json` + `screen-meta.json`
  (`cmd-screen.ts:243,277,330`). `results/` is gitignored — archive per §9.
- **Results-file-vs-store exclusivity:** `--results-file` forces `noStore`
  (`cmd-run.ts:571`); a run feeds the store OR writes a results file, never
  both. Correct here — Stage 1 must not write the store; Stage 2's k=5
  control arm is the store-writing run (plan lines 133-135).

## 3. Pre-flight (all token-free; run in order; any FAIL = stop)

**A. Git state.** Execute from the worktree `/mnt/d/tmp/wt-path-a-stage0`
(branch `path-a-stage0`): it is the only checkout containing the seeds
(commit `74e9edc`) and the sonnet amendment (`8491fe9`) — verified 08-03
that the office checkout `~/z2/meta-harness` sits on unrelated branch
`gauge-paired-validation` and lacks `s1/s2/s3`; **do not switch its branch**.

```bash
cd /mnt/d/tmp/wt-path-a-stage0
git status --short   # must be clean (this runbook file may be untracked/uncommitted)
git log --oneline -1 # record the sha in the launch log
git merge-base --is-ancestor 74e9edc HEAD && echo SEEDS_REACHABLE
```

**B. Store env.** All commands below run with the office TB2 store selected.
`KKAMAK_HOME` has highest precedence (`harness-store.ts:79`) — set both so
no ambient value can redirect a run into the dogfood store:

```bash
export KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak
export META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak
STORE=$KKAMAK_HOME/global
```

**C. v7 integrity (plan risk register: v7 is host-local, plan lines 166-167).**

```bash
cat  $STORE/active/.version                     # must print: v7
diff $STORE/candidates/v7/system.md /mnt/d/tmp/wt-path-a-stage0/term-bench2/store/global/candidates/v0/system.md
diff $STORE/active/system.md        /mnt/d/tmp/wt-path-a-stage0/term-bench2/store/global/candidates/v0/system.md
```

Both diffs must be empty (v7 is byte-identical to snapshot v0, plan lines
59-60; both verified clean 08-03). If drifted: recreate from the committed
snapshot using the recipe at `docs/resume.md:1950-1961`
(`createCandidate`/`activateCandidate` from
`opencode-plugin/src/harness-store.ts:940,1544` reading snapshot
`v0/system.md` + `v0/playbook.json`) BEFORE Stage 1.

**D. Install seed aliases (v13/v14/v15) into the office store.** Uses the
same `createCandidate` API as the v7 recipe (`harness-store.ts:940-957`;
writes `candidates/<vN>/system.md` + a zeroed `score.json`; seeds have no
playbook/tools by design — provenance doc lines 73-75):

```bash
cd /mnt/d/tmp/wt-path-a-stage0 && bun -e '
import { createCandidate, candidateExists } from "./opencode-plugin/src/harness-store.ts"
const fs = require("fs")
const root = process.env.KKAMAK_HOME + "/global"
for (const [seed, alias] of [["s1","v13"],["s2","v14"],["s3","v15"]]) {
  if (candidateExists(root, alias)) { console.log(alias, "already exists — verify, do not overwrite"); continue }
  const sys = fs.readFileSync(`term-bench2/store/global/candidates/${seed}/system.md`, "utf8")
  createCandidate(root, alias, sys)
  console.log(alias, "<-", seed, sys.length, "chars")
}'
# verify byte-identity of the installed aliases:
for p in s1:v13 s2:v14 s3:v15; do s=${p%:*}; v=${p#*:}; \
  diff term-bench2/store/global/candidates/$s/system.md $STORE/candidates/$v/system.md \
  && echo "$v == $s OK"; done
```

**E. Task existence** (already verified 08-03, re-run cheaply — also
exercises the full CLI path token-free via the read-only `task-load`
command, `opencode-plugin/src/bench/cmd-task-load.ts:1-13`):

```bash
bun term-bench2/runner.ts --tb-root /home/th-yoo/z2/terminal-bench-2 task-load \
  --tasks path-tracing-reverse mailman headless-terminal sanitize-git-repo \
          query-optimize financial-document-processor sparql-university
```

**F. Model pin (sonnet arms).** The subject model is
`anthropic/claude-sonnet-5` (plan lines 16-19; `docs/resume.md:44-46`).
`--model` is mandatory on every invocation: the omitted-flag default is
`anthropic/claude-sonnet-4-6` (`opencode-plugin/src/bench/paths.ts:28`,
applied at `cmd-run.ts:551`) — the WRONG model, silently. The flag is passed
verbatim to the in-container CLI as `opencode run … --model <id>`
(`opencode-plugin/src/bench/drivers/opencode.ts:160-161,170` via
`opencode-run.ts:106`) and stamped into the results file (`results.ts:141`)
and the launch log line `Running N task(s) × k=1, model=…`
(`cmd-run.ts:573`). **OPEN:** no token-free, code-cited way to pre-verify
that the installed opencode resolves the id `anthropic/claude-sonnet-5` was
found in the repo — check the office box's opencode model listing (e.g.
`opencode models`) before go; a bad id would burn 28 fast failures. If the
dogfood subject pin has moved, the launch log records the pin actually used
(plan lines 17-19).

**G. Infra.** Bench image `localhost/mh-bench:latest` present
(`paths.ts:18`; verified 08-03 via `podman image exists`). Fresh oauth on
the host (`--no-oauth-gate` = operator assertion the host keeps the token
fresh, `cli.ts:552-559`; standing ruling `docs/resume.md:1998`). No orphan
`mh-*` containers: `podman ps -a --format '{{.Names}}' | grep '^mh-' `must
be empty (orphan-mask incident, `docs/resume.md:1986-1987`). Weekly token
budget standing checked (plan line 169).

**H. Launch check — "Harness assembled (N chars)", per arm.** The line is
logged once per candidate sweep, immediately after the `Running …` /
`TB_ROOT=…` header of that arm's `cmdRun`
(`opencode-plugin/src/bench/cmd-run.ts:583-586`). Assembled text for
`--layers account` = `"## General coding guidance\n\n"` (28 chars;
`record.ts:44` + `compose.ts:144`) + the pinned candidate's **trimmed**
`system.md` (`readText` trims, `harness-store.ts:728-729`; pin path
`compose.ts:92-93`). Expected values, computed from the committed seed files
(trimmed lengths 2661/3205/2963; no astral chars, so codepoints = JS
`.length`):

| arm | pin | expected N |
|-----|-----|-----------|
| control | v7 | **394** (= 28 + 366; matches the plan's measured 394, lines 59-60; v7's playbook routes identically — all 6 bullets untagged → universal match, `harness-store.ts:1006-1008`, `compose.ts:94-99`) |
| S1 | v13 | **2689** (= 28 + 2661) |
| S2 | v14 | **3233** (= 28 + 3205) |
| S3 | v15 | **2991** (= 28 + 2963) |

Gate (binding, plan lines 96-99): if any arm's N mismatches its expected
value, Ctrl-C the tmux pane BEFORE that arm's trials count, fix, re-invoke
(free resume skips complete arms, §8). ⚠ Discrepancy, recorded: the
provenance doc's stated seed sizes (s1 2662 / s2 3048 / s3 2725, its lines
9/23/37) match the committed file only for s1 — committed `s2/system.md` is
3206 codepoints and `s3/system.md` 2964 (seeds and the provenance doc landed
in the same commit `74e9edc`, "authored, reviewed, fix-waved" — the counts
apparently predate the fix wave). **The file-derived numbers above are
authoritative for the launch check.** **OPEN:** reconcile the provenance
doc's s2/s3 counts (doc fix, no spend).

## 4. Launch (single command, all 4 arms, tmux mandatory)

tmux, never setsid — detached runners get silently killed
(`docs/resume.md:1962`, memory `detached-runs-need-tmux`). Flags mirror the
proven width-4 recipe (`docs/resume.md:1964-1969` and `:1999-2010`):
`--no-pack-measured` **mandatory on this host** (WSL2 shared-cgroup poisoned
resource profiles → packer runs tasks solo without it,
`docs/resume.md:2018-2023`); `--no-oauth-gate` per standing ruling
(`docs/resume.md:1998`); width 4 = `--parallel --min-cpus 2 --cpu-budget 12
--mem-budget 16000` (`docs/resume.md:1999`; width 6 = HOLD,
`docs/resume.md:2030-2032`); fixed 3600/3600 timeout envelope (screen's own
floor default is also 3600, `cmd-screen.ts:238`, so ordering is not
budget-confounded vs a later ab). `--tb-root` is a global flag, position
before the subcommand (`cli.ts:40,107-123`). `--candidates` is
comma-separated (`cli.ts:936-961`); v7 first so the known-good control arm
shakes out model/env issues before any seed trial burns.

```bash
LOG=/mnt/d/tmp/path-a-stage1-screen-$(date +%Y%m%d-%H%M).log
tmux new-session -d -s stage1screen "cd /mnt/d/tmp/wt-path-a-stage0 && \
  export KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak && \
  export META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak && \
  bun term-bench2/runner.ts --tb-root /home/th-yoo/z2/terminal-bench-2 screen \
    --layer account-global --candidates v7,v13,v14,v15 \
    --tasks path-tracing-reverse mailman headless-terminal sanitize-git-repo \
            query-optimize financial-document-processor sparql-university \
    --model anthropic/claude-sonnet-5 --layers account \
    --parallel --enforce-resources --min-cpus 2 --cpu-budget 12 --mem-budget 16000 \
    --min-agent-timeout 3600 --max-agent-timeout 3600 --host-pressure on \
    --no-oauth-gate --no-pack-measured \
    >> $LOG 2>&1; echo DONE_EXIT=\$? >> $LOG"
echo "log: $LOG"; tmux ls
```

Launch log entries to record immediately (in the session notes / eventual
commit message): worktree sha, alias mapping v13=s1 v14=s2 v15=s3, model pin
actually used, the four "Harness assembled" N values, `$LOG` path.

Monitor: `tmux attach -t stage1screen` (detach `C-b d`), or
`tail -f $LOG`. Arms run serially (`cmd-screen.ts:276`), tasks within an arm
pack in parallel — "concurrent v7" in the plan means same
window/host/model as the seed arms (the only baseline any decision reads,
plan lines 33-38), which this satisfies.

## 5. Post-run R2 audit — BEFORE any tally (binding)

Auth-race trials are silent `reward=0`; the results file does NOT record
`agent_no_output` in `errors[]` (known gap, `docs/resume.md:1981-1982`), so
the log grep is mandatory (`docs/resume.md:1978-1982,2024-2027`).

```bash
LOG=<the log path from §4>
RES=/mnt/d/tmp/wt-path-a-stage0/term-bench2/results/screens/account-global

# 1. auth failures (AUTH_FAIL_MARK, agent-run.ts:66,209):
grep -n "authentication error" $LOG

# 2. zero-turn attempts (per-attempt line "… done in <s>s, turns=N", agent-run.ts:234):
grep -nE "done in [0-9.]+s, turns=0" $LOG

# 3. cross-check in the results files (turns[]/elapsed[] arrays, results.ts:26-30):
for a in v7 v13 v14 v15; do jq -r --arg a $a \
  '.tasks | to_entries[] | select((.value.turns // []) | index(0) != null) |
   "\($a) \(.key) turns=\(.value.turns) elapsed=\(.value.elapsed) rewards=\(.value.rewards)"' \
  $RES/$a.json; done

# 4. setup failures:
for a in v7 v13 v14 v15; do jq -r --arg a $a \
  '.tasks | to_entries[] | select((.value.errors // []) | length > 0) |
   "\($a) \(.key) errors=\(.value.errors)"' $RES/$a.json; done
```

Triage (verbatim policy, `docs/resume.md:1979-1980`): `turns:0` with
elapsed ≈ 0 = setup/env artifact → **EXCLUDE the task** (from all arms — a
task excluded in one arm cannot be counted in another); elapsed < 60s =
suspected auth-race → **strip + re-roll** (§7); elapsed ≈ 3600s = genuine
timeout → **keep as fail**. Every voided trial and its disposition goes in
the launch log. Script-tally counts; never quote notes (gauge amendment
rule).

## 6. Tally + decision rule

Screen prints a ranking table + writes `ranking.json` and an `ADVANCE:` hint
(`cmd-screen.ts:329-362`) — **advisory only**, and it cannot see re-rolls.
The binding tally is computed from the four results files with §5's voids
applied and §7's re-rolls substituted:

```bash
for a in v7 v13 v14 v15; do echo -n "$a: "; jq -r \
  '[.tasks | to_entries[] | select((.value.rewards|max) == 1) | .key] | "\(length)/7  \(join(","))"' \
  $RES/$a.json; done   # then hand-apply voids/re-rolls, show work in the log
```

**Decision rule, verbatim from the plan (lines 127-129):** "Decision rule
(screen has NO verdict authority): rank by band passes; kill any candidate
strictly below the concurrent v7 arm's band rate; at most **2 advance**."

Sonnet drift is evidence, not a protocol break: tasks may leave the 0<pass<1
band under sonnet; it shows up symmetrically in the v7 arm (plan lines
33-38). Advancing arms go to Stage 2 only on its own go (plan lines
131-139). Note: the printed `ADVANCE:` line's `bench ab` suggestion targets
one candidate; Stage 2's design (paired k=5 + v7 store-writing control) is
the plan's, not the hint's.

## 7. Re-rolls (≤ 9, R2-flagged artifacts only)

One task × one arm × k=1 per re-roll, **serial** (no `--parallel` — the
proven auth-race dodge, `docs/resume.md:2480`), fresh results file (never
the arm's screen file — an unresumed `run` overwrites its `--results-file`
whole):

```bash
# example: re-roll mailman on the S1 arm
cd /mnt/d/tmp/wt-path-a-stage0 && \
export KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak && \
tmux new-session -d -s reroll-v13-mailman "cd /mnt/d/tmp/wt-path-a-stage0 && \
  export KKAMAK_HOME=$KKAMAK_HOME META_HARNESS_HOME=$META_HARNESS_HOME && \
  bun term-bench2/runner.ts --tb-root /home/th-yoo/z2/terminal-bench-2 run \
    --layers account --pin account-global=v13 --tasks mailman --k 1 \
    --model anthropic/claude-sonnet-5 \
    --results-file term-bench2/results/screens/account-global/reroll-v13-mailman.json \
    --min-agent-timeout 3600 --max-agent-timeout 3600 --enforce-resources \
    --host-pressure on --no-oauth-gate --no-pack-measured \
    >> /mnt/d/tmp/path-a-stage1-reroll-v13-mailman.log 2>&1"
```

Each re-roll gets its own §5 audit before its result substitutes into the
tally. Stop at 9 total (plan line 126); anything still R2-dirty past the cap
is voided and reported as a hole, not guessed.

## 8. Abort / resume discipline

- **Screen resume = whole-candidate, free.** Re-invoking the §4 command
  skips any arm whose results file is stamped `status:"complete"`
  (`cmd-screen.ts:193-217,277-283`); an interrupted arm (file `in_progress`
  or absent) re-runs **from scratch**. Reuse is guarded by
  `screen-meta.json` (layer/agent identity, `cmd-screen.ts:245-269`) —
  don't hand-edit that dir.
- **No `--resume` inside Stage 1.** The `run --resume` carry-forward
  freezes ANY task with non-empty rewards — partials are never topped up
  (`opencode-plugin/src/bench/results.ts:122-127`; B1 blocker,
  `docs/resume.md:2013-2017`). Screen's whole-candidate granularity makes
  strip-partials unnecessary here; re-rolls are single-task k=1 runs —
  re-run fresh, never resume. If you ever DO resume a multi-task `run`
  results file: first strip every partial task from the live copy, e.g.
  `jq 'del(.tasks["<partial-task>"])' f.json > f2.json && mv f2.json f.json`.
- **Store-writing runs are NOT resumable** (`docs/resume.md:1971-1972`) —
  not applicable in Stage 1 (nothing here writes the store), binding for
  Stage 2.
- **On abort:** Ctrl-C in the tmux pane, then reap orphan containers:
  `podman ps -a --format '{{.Names}}' | grep '^mh-' | xargs -r podman rm -f`
  (orphans mask silent kills, `docs/resume.md:1986-1987`).
- The store needs **no restore** at any point: active stayed v7 throughout
  (§1 — pins never write `active/`, `compose.ts:92-93`).

## 9. Wrap-up (after tally, before the Stage-2 go)

1. Archive results into the repo (CLAUDE.md cross-host rule — `results/` is
   gitignored, host-local state does not travel):
   `mkdir -p term-bench2/rebaseline && cp $RES/{v7,v13,v14,v15}.json $RES/ranking.json term-bench2/rebaseline/path-a-stage1-$(date +%Y%m%d)-<name>.json`-style
   copies (pattern: `docs/resume.md:1936-1937,2040`), then commit on
   `path-a-stage0` together with the launch-log notes. **Surgical, diff-first
   store sync only if any store artifact must travel — never blind
   `store-sync.sh export`** (`docs/resume.md:2567,2605`; note
   `store-sync.sh` reads `META_HARNESS_HOME` only, `term-bench2/store-sync.sh:23`).
2. Alias hygiene: either delete the office-store aliases
   (`rm -rf $STORE/candidates/{v13,v14,v15}`) once the tally is committed,
   or record that `nextVersion()` now mints v16 (`harness-store.ts:817-822`).
   Deleting is reversible — the seed texts are the committed snapshot.
3. Record outcome in the tournament plan / resume top block; survivors wait
   for Stage 2's own explicit go.

## 10. OPEN items (unresolved by repo evidence)

1. **Model-id resolution for `anthropic/claude-sonnet-5`** on the office
   box's installed opencode — verify token-free (e.g. `opencode models`
   listing) before go; repo pins the string (plan line 17) but nothing in
   the repo proves the installed CLI accepts it.
2. **Provenance char-count mismatch:** provenance doc says s2 = 3048, s3 =
   2725; committed files are 3206 / 2964 codepoints (trimmed 3205 / 2963).
   §3H uses file-derived numbers; the provenance doc needs a one-line
   correction.
3. **`screen` has no recorded live run** (shipped `docs/resume.md:2260`;
   built for exactly this shape, tested in unit tests only as far as the
   record shows). First-use risk is bounded: error isolation per candidate
   (`cmd-screen.ts:318-326`) + the §1 per-arm `run --pin` fallback.
4. **v13/v14/v15 alias naming** is this runbook's proposal (plan reserves
   v12 for the winner; committed snapshot occupies v9-v11 names) — needs
   user ack in the go, and the mapping recorded in the launch log.
5. **v7-arm N=394 under sonnet-5 playbook routing** is derived (untagged
   bullets → universal match → routed == flat), not yet observed under a
   sonnet model string. §3H's gate catches any surprise before trials count.
