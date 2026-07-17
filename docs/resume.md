# RESUME — start here

**New session / new host: read this first.** (Personal memory is host-local and
does NOT transfer; this file + the repo are the source of truth.)

## ✅ MACBOOK PICKUP DONE (2026-07-17) — open work (a) COMPLETE, band hole FILLED

Home steps 1–3 executed clean: suite **1250 pass / 0 fail** on macOS; store diff showed exactly the
expected v0-re-baseline drift; surgically imported (no `--delete`) + activated v0 in **BOTH** local
stores — `~/.config/meta-harness` AND the repo `.meta-harness` (which existed on the MacBook but was
STALE: old v1, pre-rebaseline active, no config.json — the open-work recipes point `META_HARNESS_HOME`
at it, so it had to be brought current too).

**(a) write-compressor re-run — DONE, PASSED.** Serial (no `--parallel`, oauth-race dodged),
reward=1 in 788.9s (turns=1, verifier clean). Store: **v0 = 12 PASS / 2 FAIL over 14 sessions
(85.7%)** — the 13/14 band hole is filled; fails remain extract-elf + openssl-selfsigned-cert
(genuine). Synced to `term-bench2/store/` (surgical) + mirrored to `~/.config/meta-harness`.
Recipe fix: **`--cpu-budget`/`--mem-budget` are `--parallel`-only** — drop them for serial runs
(the runner errors out otherwise).

**FIRST resource profile written** (load-aware scheduler #1 live-proven on macOS/applehv):
`<repo>/resource-profiles/x64-12c-intel-r-core-tm-i7-8850h-cpu-2-60ghz.json` → write-compressor
`{avgCpu: 0.43, peakRssMb: 1217, wall: 788.9}`. Declared/floored 4 cpus vs measured 0.43 sustained
cores = the over-declaration increment #2 will exploit. `resource-profiles/` is now GITIGNORED
(host-local by design — `readResourceProfile` keys by the CURRENT host class, so profiles don't
transfer meaningfully).

**MacBook host notes:** podman = official installer at `/opt/podman/bin` (NOT on default PATH —
prefix `PATH=/opt/podman/bin:$PATH`); machine applehv **4 CPUs / 8 GiB** → parallel budgets must be
scaled down from the 8-core Linux recipes (a `--cpu-budget 8`/`--min-cpus 4` parallel run degenerates
to width-1 here).

**REMAINING OPEN WORK:** (b) first real loop `ab` — propose a NEW candidate ≠ v0, same
budget-identity — now runs on the MEASURED packer (below) and fills profiles for all 14 band
tasks; (d) Axis-2 vendor content + panel. Details in the handoff block below.

## ✅ LOAD-AWARE #2 SHIPPED (2026-07-18) — measured packing DEFAULT-ON + OOM-escalation retry

Open-work (c) is DONE and merged (branch `feat/loadaware-2`, 10 commits, suite **1310 pass / 0
fail**). Built via parallel subagent waves (3∥ → 2∥ → serial ×3), per-task spec+quality reviews,
final whole-branch review = MERGE-READY. Plan (3× architect-reviewed to FLAWLESS before build):
`~/.claude/plans/plan-to-flip-2-tidy-aurora.md`.

**What changed:**
- **Packing weight = measured profile** (default-ON): `packingWeight` (resource-profile.ts) —
  avgCpu (floor 0.5) / peakRssMb×1.2 (floor 256MB), gated `n≥3 && avgCpu>0`; declared/floored =
  cold-start prior. `packingFootprints` (tasks.ts) splits `{cap, pack}` — containers ALWAYS get
  the generous cap, the scheduler packs the honest weight. scheduler.ts itself unchanged.
- **Cap raise-only lift**: `raiseCapMeasured` — cap.memoryMb = max(declared/floored, peak×1.5) at
  n≥3, parallel AND serial enforce paths (cmd-oracle excluded, test-pinned). Closes the
  chronic-OOM loop (measured demand > declared cap no longer kills every run).
- **OOM-escalation retry**: cgroup `memory.events oom_kill` (cumulative-counter caveat → trigger
  is `oomKilled && reward !== 1` — an OOM'd-then-recovered PASS is kept); single retry in a fresh
  container at 2× memory (clamped to mem-budget under parallel); carry-forward across k-repeats
  and both ab arms; killed attempt never recorded (infra noise, like the auth-skip); oomKilled
  samples never memorized into profiles.
- **Escape hatch**: `--no-pack-measured` (run+ab, legal with AND without `--parallel`) disables
  ALL measured decisions. **Provenance**: per-session `capMemoryMb`/`capRaised` on SessionRecord
  (threaded like cpuSeconds/peakRssMb). **task-load**: MeasCPU/MeasMB/n columns + a second
  "measured packing" co-run preview block.
- **NOT a budget-identity change** (packing width is verdict-equivalent; ab re-runs both arms
  under identical caps) → no re-baseline needed.

**Deferred to increment #3**: online wall-clock back-pressure (the real fix for burst-phase
contention — avgCpu is a whole-run median; watch first live sweeps for timeout upticks), CPU
escalation, scheduler-visible escalated footprints. Post-merge cleanup candidate (final-review
minor): fold `capRaised` into `TaskFootprint` to delete the duplicated `capRaisedFor` closures.

**First live validation** = the (b) loop `ab`: it accumulates n≥3 profiles for the whole band,
after which packing goes measured automatically. On this 4-CPU VM expect width to rise from 1-2
toward ~4 as profiles mature (mem-bounded).

**(b) recipe, MacBook-adapted** (the Linux `run-loop3-ab.sh` assumed 8 cores; this VM is 4c/8GiB):
1. Propose off the fresh 14-session evidence: store-writing history is already in the loop store —
   start opencode in the repo, `/mh-propose account` → emits a NEW candidate vN (with Axis-2
   generality tags — first live capture data). Verify vN ≠ active: `ls .meta-harness/global/candidates/`.
2. `ab`, detached + logged (`term-bench2/logs/`), oauth fine (freshness gate), fresh token first (`claude`, login, ctrl-D):
   ```
   META_HARNESS_HOME=<repo>/.meta-harness PATH=/opt/podman/bin:$PATH bun term-bench2/runner.ts ab \
     --layer account-global --candidate vN --split-file term-bench2/splits/loop1.json \
     --model anthropic/claude-haiku-4-5 --k 2 --parallel --enforce-resources \
     --min-cpus 2 --cpu-budget 4 --mem-budget 7000 --max-agent-timeout 3600 --resume
   ```
   (`--min-cpus 2 --cpu-budget 4` = width-2 on the 4-cpu VM — the Linux `--min-cpus 4 --cpu-budget 8`
   pins width-1 here. Serial alternative: drop `--parallel`/`--cpu-budget`/`--mem-budget`, keep the rest.
   Same budget-identity either way: {3600, timeoutRecording:true, resourceEnforcement:true}.)
3. Verdict `report-loop`; on accept `/mh-activate account vN` (T6 gate checks budget-identity), then
   SURGICAL sync of `candidates/vN/` into `term-bench2/store/` + commit + push (never blind export).

---

## ➡️ MACBOOK HOME PICKUP (handoff 2026-07-16 evening) — DONE 2026-07-17, see block above

**Everything is PUSHED — `git pull` fast-forwards to the latest `origin/main`.** Clean tree (only a stray untracked `oom` — ignore). Recent commits (newest last): `2a8fda5` v0 re-baseline snapshot · `e113f43` cgroup capture+memorize · `e0e6e7c` ab-path cgroup capture · then this handoff on top. (Don't assert an exact tip hash — this doc commits after the code, so the tip is always ≥ the hashes listed.)

**What did NOT transfer from the Linux box (git-only cross-host — [[tmp-dir-mnt-d]]):** the `.meta-harness` runtime store (active=v0 pointer + `config.json recordTimeouts=true`), the `/mnt/d/tmp/*.sh` scripts (rebaseline-v0 / -sync / run-loop3-ab — recreate from the procedures below), and `~/.claude` memories (their content is folded into THIS file). The v0 baseline itself IS in git (`term-bench2/store/global/candidates/v0/`).

**Home steps, in order:**
1. `git pull` (fast-forwards to the latest origin/main).
2. `cd opencode-plugin && bun test` → expect **1250 pass / 0 fail** (confirms the cgroup-capture code lands clean on macOS). NOTE: `readCgroupStats`/live bench needs Linux+podman cgroup v2 — macOS podman runs in a Linux VM so the container cgroup read still works; but the UNIT tests are pure/mocked and pass anywhere.
3. **Store import — DIFF FIRST, never blind export** (the export-trap fired TWICE on the stale MacBook store — [[tmp-dir-mnt-d]]): `term-bench2/store-sync.sh diff`. Only if it shows the v0 re-baseline missing, surgically import (NO --delete): `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json`, then ACTIVATE v0 (the active pointer is host-local, not in the snapshot).
4. Pick up the open work below.

**OPEN WORK (pick any):**
- **(a) write-compressor re-run** — fill the 13/14 band hole. It dropped as an oauth-parallel-race 0-turn (auth/transient skip, not a timeout). Re-run SERIALLY (drop `--parallel`) or with a fresh token: `run --layers account --tasks write-compressor --model anthropic/claude-haiku-4-5 --enforce-resources --min-cpus 4 --cpu-budget 8 --max-agent-timeout 3600` under `META_HARNESS_HOME=<repo>/.meta-harness`. This also writes the FIRST resource profile.
- **(b) first real loop `ab`** — propose a NEW candidate ≠ active(v0), same budget-identity → valid comparison. `ab` dies "nothing to compare" if candidate==active (`cmd-ab.ts`). Recipe: `/mnt/d/tmp/run-loop3-ab.sh <candidate>` (recreate — see LINUX block below).
- **(c) load-aware scheduler increment #2** — flip the packer input from declared `cpus` int → measured `avgCpu` (`readResourceProfile`), declared int + `--min-cpus` kept only as cold-start prior. NEEDS profile data first → run the loop live (step a/b) to accumulate, THEN flip. See the Load-aware section in the LINUX block + [[load-aware-scheduler]].
- **(d) Axis-2** — seed/propose vendor content so routing does something; multi-model panel needs a 2nd vendor model.

---

## LINUX SESSION (2026-07-16 cont.) — MASTER SHIPPED · Axis-2 tag CAPTURE+ROUTING shipped · TB2-timeout fixed · cgroup-capture shipped

**HEAD `2a8fda5`, PUSHED to `origin/main` (`origin/main..HEAD` empty, `git ls-remote` confirms). Tree clean** (except a stray empty `oom` file, untracked — ignore). **Loop-3 v0 re-baseline DONE + synced — see the "Re-baseline v0" section at the end of this block.**

**Shipped to main (local) this session:**
1. **MASTER BUILT + MERGED** — the 8-module deterministic boundary/orchestration layer under `opencode-plugin/src/fleet/master/` (gate-state · transport · frozen-gate · namespace · relay · scheduler · reconcile · master) + a `master` CLI case + hermetic E2E. Executed the master DAG as parallel subagent waves (wave0 4∥ · wave1 3∥ · wave2 1), TDD per task, per-task code-architect review + a final whole-branch review (merge-ready, 0 crit/imp). Review-driven fixes: T4 frozen-gate `testsRun` parse (was reading pass-count not `Ran N tests` → blinded the DGM-114 gaming detector); T1 gate-state made **kind-aware** (`resolveGate`/`markRelayed` take a `GateKind` — HUMAN-approved interface change, guards co-pending different-kind gates); T5 upsert test. The 4 open Qs settled in-build (masterRoot = injected param; grammar `approve|revise <project>/<sliceId>` + `status`; gateRoot injected; lock TTL deferred). Plan `docs/superpowers/plans/2026-07-16-master-build.md`. Suite 1214 pass.
2. **TB2-timeout fix** — the loop `ab` recipe was capping tasks BELOW their real TB2 budgets: `--max-agent-timeout 1800` halved distribution-search (TB2 3600), `--max-verifier-timeout 300` starved nearly every verifier (TB2 verifiers 900–3600s). `taskTimeouts` (tasks.ts) ALREADY reads exact TB2 `task.toml` timeouts; a cap only LOWERS. Fix = agent cap **3600** (split max), **DROP** the verifier cap. The "oauth+parallel recipe" section below already reflects this; `/mnt/d/tmp/run-loop3-ab.sh` fixed too.
3. **Axis-2 generality tag CAPTURE** (`ecc6874`) — per-bullet `generality?: "universal"|"vendor"|"model"` + `slice?` on `PlaybookBullet`; proposer emits it per op; `applyPlaybookOps` coerces invalid→universal + caps slice; no-op guard now playbook-aware (a pure re-tag is no longer silently dropped); `generalityRollup` in candidate meta + `/mh-status gen[u v m]`. `renderPlaybook` UNCHANGED → injection byte-identical. Promote left untouched (pre-existing playbook-null-on-activate, documented `explicitly-not-now §2.4.1`). Docs: `target-model-axis.md §7.0` + research fold `§0.1`.
4. **Axis-2 generality tag ROUTING** (`4b13060..bbca3e4`) — a bullet tagged `vendor:anthropic` now INJECTS only for Anthropic sessions, via ONE shared `renderPlaybookRouted` + `composeHarness(model?)` with a **faithful-render guard** (`renderPlaybook(pb).trim()===flat.trim()` — absorbs `seedPlaybook`'s non-format-preserving migration → byte-identical by construction). Threaded through ALL 4 injection entry points: runtime `composeInjection` (session model), bench `cmd-ab`/`cmd-run` (`--model`), fleet `renderRole` (role's fixed model). Spec `2026-07-16-generality-routing-design.md` (SUPERSEDES `target-model-axis §4`'s separate-coordinate approach for delivery — the tag lives on the bullet, routing is a render filter); plan `2026-07-16-generality-routing.md`. 2 code-architect rounds to production-flawless. Suite 1233 pass.

**Loop-2 timeout-mirage CONFIRMED live:** tune-mjcf + distribution-search both PASS at generous budgets (`--min-cpus 4`). Loop-2's "no lift" was compute/timeout starvation, not real regression.

**Loop-3 re-baseline — flipped + DONE + synced (2026-07-16 21:49):**
- **`recordTimeouts` FLIPPED ON** — `<repo>/.meta-harness/config.json` = `{"recordTimeouts": true}`. That is the REPO store (loop runs point `META_HARNESS_HOME` there); `~/.config/meta-harness` is NOT the loop store. Budget-identity is now `{maxAgentTimeout:3600, timeoutRecording:true, resourceEnforcement:true}`.
- **Baseline reset v6→v0.** Active WAS the untested v6 (drift, no verdict). Reverted: v0 migrated to a 6-bullet playbook from its `DEFAULT_SYSTEM_PROMPT` (its header line becomes a `- ` bullet — a NON-faithful migration, so routing's faithful-render guard falls back to flat = v0's EXACT original prompt, byte-identical) + activated NON-destructively (v6 preserved as a candidate) + `score.json` reset to `{nPass:0,nFail:0,sessions:[]}` (its old score was 5 degenerate all-None placeholder rows, not real data). **active = v0.**
- **Re-baseline DONE + synced + pushed (`2a8fda5`).** Stored v0 baseline = **11 PASS / 2 FAIL over 13 sessions (84.6%), 0 timeouts** — budget-identity stamped `{maxAgentTimeout:3600, resourceEnforcement:true}`. Fails: extract-elf, openssl-selfsigned-cert (genuine, no timeout). Timeout fix CONFIRMED live: distribution-search (426s) + tune-mjcf (267s) both PASS where they used to time out under the old caps.
  - **⚠️ write-compressor MISSING from the 14-task band** — ran 602s but `opencode done turns=0` → store logged `skip store record: 0 agent turns (auth/transient agent failure)` = the oauth-parallel race, NOT a timeout. So the band is 13/14; runner's own summary counts it as a fail (11/14 = 78.6%), the STORE correctly excludes it as infra noise (11/13 = 84.6%). **`recordTimeouts` does NOT cover this skip path** — it records timeout 0-turn runs, but "auth/transient agent failure" 0-turn runs are a SEPARATE skip in the runner. write-compressor needs a re-run (serial, or fresh token to dodge the oauth-race) to fill the hole. See [[loop-blind-spots]].

**STILL dark / deferred:**
- **Axis-2 not fully APPLIED** — CAPTURE + ROUTING shipped, but (a) NO content is tagged vendor/model yet (a fresh propose emits tags, or hand-seed the documented Anthropic rules); (b) NO multi-model PANEL to VALIDATE a tag (needs a 2nd vendor model). Routing delivers the CLAIM, doesn't prove it. Deferred: `target-model-axis §6` (panel) + promote-playbook-preservation (`explicitly-not-now §2.4.1`).
- **No meaningful loop `ab` YET** — needs (i) the v0 re-baseline above to FINISH, THEN (ii) a NEW candidate ≠ active to compare. `ab` = candidate-vs-ACTIVE; a candidate == active dies "nothing to compare" (`cmd-ab.ts:184`). v0–v6 all pre-date the new budget-identity → only the re-baselined v0 is a valid baseline. `META_HARNESS_HOME=<repo>/.meta-harness`, detached+logged (`/mnt/d/tmp/run-loop3-ab.sh <candidate>`).

### Re-baseline v0 — procedure (scripts are HOST-LOCAL `/mnt/d/tmp`; recreate from these steps at home)
Prereq: fresh oauth (`claude`, login, ctrl-D — `--parallel` needs a live token). `run` (NOT `ab`) re-scores the ACTIVE version; store-writing by default (no `--results-file`/`--no-store`). `run` takes `--task-file`, NOT `--split-file` (that flag is `ab`-only).
1. **Baseline run** (`/mnt/d/tmp/rebaseline-v0.sh`): guards `active==v0` → extracts loop1's 14 tasks to a plain task-file → launches detached
   `META_HARNESS_HOME=<repo>/.meta-harness bun term-bench2/runner.ts run --layers account --task-file <14tasks> --model anthropic/claude-haiku-4-5 --k 1 --parallel --enforce-resources --min-cpus 4 --cpu-budget 8 --mem-budget 16000 --max-agent-timeout 3600`
   → 14 v0 sessions land in `candidates/v0/score.json` stamped the new budget-identity. k=1 fits the ~1h window; bump `--k 2/5` later for a robust baseline.
2. **Sync** (`/mnt/d/tmp/rebaseline-v0-sync.sh`, run SEPARATELY after eyeballing the log): SURGICAL — `rsync -a` (NO `--delete`) of `candidates/v0/` + `config.json` from the `.meta-harness` store → `term-bench2/store/` snapshot → `git add term-bench2/store` → commit → push. Do NOT `store-sync.sh export` (a full `--delete` mirror → would drag the dead v2–v6 into the snapshot). Self-guards on v0 sessions > 0.
3. **At home:** `git pull` → `rsync -a term-bench2/store/global/candidates/v0/ ~/.config/meta-harness/global/candidates/v0/` + `cp term-bench2/store/config.json ~/.config/meta-harness/config.json` → activate v0 (the active pointer + active playbook are host-local, NOT in the snapshot — activate separately on the home host).

**NEXT:** (a) a real loop `ab` — propose a NEW candidate vs the re-baselined v0 (same budget-identity → valid comparison); (b) re-run write-compressor SERIALLY to fill the 13/14 band hole; (c) seed/propose vendor content so routing does something; (d) the multi-model panel (needs a 2nd vendor model) to validate tags. [re-baseline + sync DONE — origin/main @ `2a8fda5`]

**Load-aware scheduler — increment #1 (capture+memorize) WIRED + COMMITTED + PUSHED (`e113f43` capture+memorize, `e0e6e7c` ab-path), tests green:**
- **Problem (user critique):** the bench packer (`scheduler.ts`, `d528ae5`) IS load-aware (`fitsBudget` sums per-task `cpus`≤budget) but packs on a STATIC declared int (task.toml default `cpus=1`); `--min-cpus 4` floors every task → on the 8-core box `--cpu-budget 8` degenerates to fixed width-2. A declared count is meaningless across P/E cores / hosts (and inside WSL2 the topology is invisible); most tasks are LLM-latency-bound anyway. Only in-env MEASUREMENT is ground truth.
- **Shipped (behavior-neutral — packer UNCHANGED, only collects):** `bench/cgroup.ts` `readCgroupStats` reads the container's OWN cgroup v2 (`/sys/fs/cgroup/cpu.stat usage_usec` + `memory.peak`) via `podman exec` just before teardown (mirrors `readSelfScore`; null on any fail). `bench/resource-profile.ts` MEMORIZES a per-task × per-host-class profile at `<metaRoot>/resource-profiles/<hostClass>.json` (`hostClass()` = `<arch>-<Ncpu>c-<model-slug>`; rolling window 5; `avgCpu = median(cpuSeconds/wall)` = sustained core-demand; `readResourceProfile` for the future packer). `SessionRecord` gains `cpuSeconds?`/`peakRssMb?`, threaded through `record.ts`; wired in BOTH `cmd-run.ts` (serial+parallel) AND `cmd-ab.ts` (memorizes BOTH arms A+B — a footprint is a task×host property, ~prompt-independent; stamps arm-B score too). tsc clean, **1250 pass / 0 fail** (+17). Live-verified against a real container. (Test-hygiene note: profile tests MUST isolate metaRoot — the cmd-ab harness sets `metaRoot=dirname(termBenchDir)`, which collapses to `os.tmpdir()` when termBenchDir is the tmpDir itself; other tests survive it via createCandidate reset, the profile store has none → `isolatedPaths()` nests termBenchDir.)
- **NEXT for this feature:** (i) increment #2 = flip the packer input `enforcedResources` declared-int → measured `avgCpu`, declared int + `--min-cpus` kept only as cold-start prior (needs profile data → run the loop with #1 live first); (ii) increment #3 = online wall-clock back-pressure. Capture now covers both run + ab paths. See [[load-aware-scheduler]].

---

## OFFICE PICKUP (2026-07-16 evening, MacBook session end)

**Everything pushed, `git status` clean, HEAD = `ce54fd3`.** Discipline first:
`git pull && term-bench2/store-sync.sh diff` (import only if drift — the
export-trap nearly fired again today on the stale MacBook store; that's twice).

MacBook session shipped today (details in sections below):
1. **Bench resource-scheduler SHIPPED DARK** (`d528ae5`) — see its section +
   the ⚠️ UNTESTED oauth-race block (user-flagged big issue).
2. Office-runnable pickups, any order:
   (a) **3-concurrent smoke** = the --parallel flag-flip gate — needs an
       ANTHROPIC_API_KEY in env; keyOnly mode is platform-independent, linux OK.
   (b) **oauth-race sandbox experiment** (defined in the ⚠️ block) — settles
       whether the key requirement is genuinely needed or over-strict.
   (c) **Loop-3 T6+T7 + pre-flip checklist** (the standing throughline) → then
       ONE combined re-baseline: recordTimeouts + --enforce-resources together.
3. Still pending a go (unchanged): Phase-0 SELF_CHECK_INSTRUCTION re-run;
   seed-corpus stays measure-first behind loop-1's ab.

## HOME SESSION pt 2 (2026-07-16) — Loop-3 COMPLETE · oauth-parallel SHIPPED+VALIDATED · T3 built · master DAG

Everything committed + pushed. HEAD `f37ec51` (see `git log`). Loop-2 stays inconclusive (v0 active). Recipe: the "oauth+parallel recipe" section above.

**Shipped (all pushed):**
1. **Loop-3 FUNCTIONALLY COMPLETE** (was T1-T5 dark) — T6 (`0c9f2be`, `/mh-activate` budget-identity gate) + T7 (`f598d08`, report-loop segmentation) + emission (`cc64dea`, ab+trial meta-metric events stamp the {maxAgentTimeout,timeoutRecording,resourceEnforcement} tuple → segmentation LIVE, proven by an integration test) + pre-flip (`da0e107`: per-task timeout-marker denominator via `SessionRecord.agentTimeout`, project-scope steer gate, clearer undefined-active toast). **`recordTimeouts` STILL default-OFF.** To flip: `config.json recordTimeouts=true` + re-baseline v0 (budget-identity change → T6/T7 handle it).
2. **oauth-parallel freshness gate SHIPPED+VALIDATED** (`0a823bd`+`ec3b31f`+`aeabef1`) — run `--parallel` on oauth, **NO API KEY**, safe by construction (no task runs across the ~8h token refresh → no auth.json race). = pre-flight (token must outlive one task; oauth+parallel REQUIRES explicit `--max-agent-timeout`) + scheduler `canLaunch` launch-guard (stops launching near expiry, graceful resolve, `--resume` continues) + oauth mount under parallel (`useKeyOnlyForParallel`: keyOnly only if key present). Validated LIVE 2-concurrent.
3. **`--min-cpus`/`--min-mem-mb` resource floor** (`f37ec51`) — generous per-task cgroup cap `max(declared,floor)` so `--enforce-resources` doesn't starve compute-heavy tasks. Default off = byte-identical.
4. **VALIDATION (live runs):** tune-mjcf + distribution-search (both loop-2 timeout-fails @600s) → **2/2 PASS serial @1800s**. Parallel @1-cpu-cap → 1/2 (distribution-search STARVED: 1367s+fail vs 446s serial). Parallel GENEROUS (`--min-cpus 4`, 8-cpu machine) → distribution-search recovered (196s+pass partial at handoff; **CHECK `term-bench2/results/validate-parallel-generous.json` for the full result**). LESSON: artificial resource limits (time OR cpu) → false fails → weaker loop signal; loop wants the loosest envelope that fits the machine. Loop-2's "no improvement" was partly a **timeout mirage**. USER DECISION: parallel + generous footprints.
5. **Self-hosting T3 BUILT** (`a39c1db`..`71216b0`) — `fleet/dag.ts` DagNode{id,task,deps[],files?,mutatesDeps?} + total validator + PLANNER_SQUAD + gate2-reuse. **DAG: T1+T3 built; T4/T5/T6sh/T2/T7sh/master planned.**
6. **oauth-race fully resolved+documented** — `oauth-parallel-race-research.md` + `auth-delegation-design.md` (UPDATED: freshness gate SUPERSEDES the old "surface don't handle / key-or-serial" decision).
7. **MASTER decomposed into a parallel task-DAG** (max-parallelism, expressed in the `fleet/dag.ts` TaskDag format = dogfood): **Wave0 (4∥):** gate-state · transport · frozen-gate · namespace. **Wave1 (3∥):** relay(gs,tr) · scheduler(ns) · reconcile(gs,ns). **Wave2:** daemon+CLI+E2E(all). Each node = a distinct `master/*.ts` file → no intra-wave conflict. Build-plan `docs/superpowers/plans/2026-07-16-master-build.md` (8 tasks), **4 open Qs** (masterRoot convention, inbound grammar, gateRoot provisioning, singleton-lock TTL) to settle before building.

**NEXT:** (a) check the generous-validation result; (b) settle master's 4 open Qs → execute master DAG **wave-0 as 4 parallel subagents** (distinct files, no worktree needed); (c) OR flip Loop-3 `recordTimeouts` + re-baseline v0 + a real loop `ab` run (parallel+generous, `--min-cpus 4 --cpu-budget 8`). grok-build = xAI leaf-agent coding TUI (possible future `--driver`, not orchestration prior-art).

---

## SESSION END 2026-07-16 (leaving office) — loop-2 CALLED · Loop-3 shipped DARK · T1 shipped

**Everything is committed + pushed. `git status` clean, 0 unpushed. HEAD = `7e23797`.**
The sections below this one (office/v1/Phase-0) are HISTORICAL — superseded by the loops since.

**Is the necessary data saved?** YES — all code, docs, plans, the Loop-3 build, the T1
primitive, and the bug fix are in git (`origin/main`). Store note: the account store's
`active` is the EMPTY baseline (nothing promoted); the git snapshot `term-bench2/store/`
has `v0 v1`, which is all home needs. Dead candidates `v2` (superseded) and `v3` (loop-2,
called) are host-local and NOT needed — **do NOT store-export them** (blind export is the
data-loss trap; nothing new needs syncing anyway). To run anything at home: `git pull`
(+ `store-sync.sh import` only if you need the candidate store).

**What happened this session:**
1. **Loop-2 CALLED = `inconclusive / no-lift`** (user decision — grinding the rest was
   hours of timeout-dominated compute to confirm a near-certain reject). Candidate `v3`
   (the proposer-fix's output) vs active `v0`: 3 held-in TIES incl **tune-mjcf FAIL/FAIL
   (both ~600s timeout)**, a `v3` regression hint on distribution-search. `v3` NOT
   activated; active stays baseline. **Meta-win stands:** the proposer-fix (`679326f`)
   worked — `v3` self-corrected off `v1`'s reject. Full detail: memory `loop-2-outcome`
   (host-local) + `.superpowers/sdd/progress.md` ledger (host-local).
2. **Loop-3 (timeout blind-spot fix) T1–T5 SHIPPED DARK** — commits `062ca93..85fbfed`,
   final-reviewed (opus) merge-ready. Flag `recordTimeouts` **default-OFF = zero behavior
   change**. This is the priority self-improvement fix: makes agent timeouts a first-class,
   proposer-visible failure (today they're 0-turn results invisible to the proposer, so the
   loop can't learn its frontier failures — tune-mjcf above is the live proof).
   **To turn it ON (next session):** finish **T6+T7** (stamp `maxAgentTimeout`/
   `timeoutRecording` into verdictDict + `writeRunResults`; the MANUAL re-baseline op +
   runbook) + the **pre-flip checklist** (thread the real per-task `agentTimeout` — already
   captured as `agentElapsedSec` — into the proposer marker, which today uses the run-cap
   denominator; scope-gate the T4 steer to project layers), THEN set `recordTimeouts=true`
   in `config.json` + **re-baseline `v0`**, THEN a fresh loop-3 run. Plan:
   `docs/superpowers/plans/2026-07-16-loop3-timeout-fix.md`; pre-flip details in the ledger.
3. **T1 git-worktree primitive SHIPPED** (`144f31b..f536b6e`, reviewed-to-merge) — the
   fleet/self-hosting execution substrate (worktree-isolated squad-runs, ledger survives
   cleanup). Self-hosting build DAG: **T1 built; T3/T4/T6 + master + Loop-3 planned;
   T2/T5/T7 unplanned.** Also landed: **master build-plan** (`6c2ee4f`, 8-task deterministic
   orchestrator, §9+R1-R4), **R4 credit-assignment research** (`9e246d4`, closes the last
   master gap — exact-replay difference rewards). All mapped in `docs/INDEX.md`.
4. **Harness bug fixed** (`ac0cd18`): every chunked `ab --resume` was silently dying
   (`verdictDict` omitted the top-level `driver` field the resume-ident check requires).
   Fixed + regression-tested. NOTE: a partial written BEFORE `ac0cd18` still lacks the
   field — patch top-level `"driver":"opencode"` into `ab-verdict.partial.json` to resume
   it without a full restart.

**Next session — pick up any of:** (a) Loop-3 T6+T7 + pre-flip fixes → flip it ON →
re-baselined loop-3 run (the throughline); (b) execute a planned self-hosting task
(T3/T4/T6, SDD like T1); (c) write the remaining plans (T2/T5/T7); (d) resolve the
~30 open-questions accumulated across the new plans (each plan lists its own). The
current loop empirically produces NO task-pass lift yet — Loop-3 (honest signal on
frontier tasks) is the highest-leverage near-term fix; the self-hosting substrate is
the bigger structural bet after that.

## oauth+parallel recipe (2026-07-16 — NEW, no API key needed)

The bench can now run `--parallel` on your subscription oauth (no `ANTHROPIC_API_KEY`),
**safe by construction** — the freshness gate guarantees no task runs across the ~8h token
refresh, so the shared `auth.json` is read-only during the parallel window (no race).
Commits `0a823bd` + `ec3b31f` + `aeabef1`. **Validated live** (2 concurrent, oauth, 2/2 pass).

Also loosen the agent timeout: the loop-2 **600s cap was artificially clipping** tasks below
their declared budgets (tune-mjcf declares 900s, distribution-search 3600s) → false timeouts.
Run at the real budget.

```
# 1. fresh token (the gate refuses if it can't outlive one task; re-login if stale)
claude          # or: opencode auth login   (~8h TTL)
# 2. run parallel on oauth, no key — TB2-EXACT per-task timeouts (NO sub-TB2 cap):
#    vN must be a REAL, NON-ACTIVE version (else cmd-ab.ts:184 "nothing to compare")
bun term-bench2/runner.ts ab --layer account-global --candidate vN \
  --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
  --k 2 --parallel --enforce-resources --max-agent-timeout 3600 --resume
```
- **`taskTimeouts` (tasks.ts) ALREADY reads each task's exact TB2 `[agent]/[verifier] timeout_sec`**
  from `<tbRoot>/<task>/task.toml`; a `--max-*-timeout` flag only ever LOWERS it, never raises.
  So "take timeout from TB2" = set the agent cap AT OR ABOVE the split's per-task max, and OMIT
  the verifier cap. (TB2 agent budgets across the 89 tasks: 48×900, 17×1800, 12×3600, 1×7200, 1×12000.)
- `--parallel`+oauth REQUIRES an explicit `--max-agent-timeout` (freshness math). Set it to the
  split's MAX real TB2 agent budget — loop1 = **3600** (distribution-search) — so NO task is
  shortened below TB2; a ~8h token easily outlives 3600s. **Do NOT set it below TB2** — the old
  `1800` halved distribution-search (3600→1800).
- **No `--max-verifier-timeout`.** The verifier runs AFTER the agent and never touches the oauth
  token, so it needs no cap. Omit it → each task's exact TB2 `[verifier] timeout_sec` (up to 3600)
  is used. The old `300` STARVED nearly every verifier (TB2 verifiers are 900–3600s) — the real
  false-timeout source on heavy tasks.
- Self-limiting: as the token nears expiry the scheduler stops launching new tasks, lets
  in-flight finish, ends the chunk → re-login + `--resume` continues.
- Raising `--max-agent-timeout` (→3600) is a **budget-identity change** → Loop-3 T6/T7 re-baseline
  it (re-score the active version at the new budget first).
- With a static `ANTHROPIC_API_KEY` set, `--parallel` uses keyOnly (no token TTL → omit
  `--max-agent-timeout` entirely for fully-exact TB2 timeouts).

**VALIDATION (2026-07-16):** tune-mjcf + distribution-search (both loop-2 timeout-fails at
600s) → **2/2 PASS** at loosened timeout, serial AND 2-concurrent oauth+parallel. Loop-2's
"no improvement" was partly a **timeout mirage** (the artificial 600s cap), not harness
quality — validates Loop-3's thesis.

---

## AT THE OFFICE (2026-07-16) — v1-into-git DONE ✅ (read the warning)

**DONE (commit `9bc5166`):** v1 is now in the git snapshot (`term-bench2/store/global/candidates/` = `v0 v1`).

⚠️ **The original instruction here (`store-sync.sh export` on the linux host) was a
DATA-LOSS TRAP and was NOT used.** By 2026-07-16 the hosts were split-brain: the
linux host had `v1` in its live store but was STALE on the overnight tier-2 work
(role stores `mh-analyzer/designer/evaluator/implementer`, config, calibration);
the git snapshot had the overnight work but not `v1`. `export` is `rsync --delete`
(store→snapshot), so it would have DELETED the overnight role stores from git.
Instead v1 was added SURGICALLY (`rsync` no `--delete`, only `global/candidates/v1`)
— zero deletions. **Lesson: always `store-sync.sh diff` first; if it shows
`*deleting` lines you care about, do NOT export — surgically copy just the new
candidate dir into `term-bench2/store/` and commit.** The import-before-work
discipline prevents this; it was skipped when linux made v1 before store-sync existed.

Next: `ab` can run on ANY host. The linux host can run it directly (its live store
already has `v0 v1`). Other hosts: `git pull && store-sync.sh import` (now safe —
the snapshot has v1 + the overnight roles).

## Where we are (2026-07-16)

First propose→ab improvement loop (#5). Done: baseline (haiku pass@5 **0.381**),
14-task band split, store-writing run, **propose → account-global `v1`**
(a real generalized playbook). The `ab` verdict (v0 vs v1) is the last step.

Landed overnight 2026-07-15→16 (MacBook, pushed to `main`):
- **Prompt-mining plan EXECUTED** (was saved-only) — `docs/external-prompts-cc-opencode.md`
  (17-row verdict table, 22-bullet dual-tagged seed corpus, 6 meta-prompt lessons),
  the two HIGH lessons applied to `buildProposerPrompt` (L1 untrusted-evidence,
  L2 evidence-gated rejection list — conditional on non-empty failures so fresh-layer
  bootstrap still writes a baseline; live propose smoke passed), and
  `docs/target-model-axis.md` spec (additive-only v1; build deferred,
  `explicitly-not-now.md` §2.4). Raw extraction scratch: `.superpowers/sdd/mining/`
  (host-local, MacBook). Seed corpus is measure-first: do NOT hand-seed until
  loop-1's ab shows what propose finds on its own.
- **Phase-0 self-score correlation run DONE** (best-of-k gate; MacBook, 2026-07-16
  morning): 43 baseline tasks × k=1 haiku `--self-check` →
  `term-bench2/results/phase0-selfscore-haiku.json`. **GATE: UNDERSIZED, not
  predictive on current data** — pass@1 5/43 (11.6%); capture rate 11/43 (26%,
  haiku usually skips the self-check); among captured pairs essentially every
  self-claim is 1.0 (no variance), so score-value lift is only +2.7pp (30% vs
  27.3% within-pairs base) with 7/10 self-PASS claims false-positive; N=11 < 30
  floor. Per the plan's stopping rule: do NOT build the k-loop on this. Two real
  findings: (1) the self-report VALUE is near-uninformative as-is; (2) writing a
  self-check at ALL correlates with success (27.3% vs 6.3% for non-compliant
  runs) — compliance is the stronger signal. NEXT (deliberate revision):
  strengthen `SELF_CHECK_INSTRUCTION` (`opencode-plugin/src/bench/self-score.ts`)
  to force compliance + honest fractions, then re-run the 43-task night.

Landed 2026-07-15 (all pushed to `main`):
- **Store is git-syncable** — `term-bench2/store-sync.sh` + `term-bench2/store/` snapshot (next section). No more scp.
- **Verifier-timeout bug fixed** — `--max-verifier-timeout` now bounds each attempt (was unbounded; `ab` command below already includes it).
- **Tier-2 machinery HARDENED** (`7503ae0`) — adversarial review of the office-host code found + fixed 2 Critical + 4 Important bugs before any loop leans on it: squad-run pins one def-version per slice (no mid-run-activation drift); `squad-trial` is now a PAIRED comparison with the tier-1 McNemar significance test (no promote-on-noise, default n=5 floor); Phase-0 self-score gate floors on self-PASS sample size (n=1 greenlight killed); `flow.reentry` frozen; failure retrieval blends importance×diversity. 916 tests green. Detail: `.superpowers/sdd/tier2-fix-report.md` + `selfscore-fix-report.md`.
- **Slack/OpenClaw fixed** (fleet, oc-test side) — root cause of "#oc doesn't answer" was `requireMention` defaulting true (plain messages dropped as `no-mention`), NOT agent provisioning. Fix: `requireMention:false` on #oc. Token-free patch + sanitized gateway template in `oc-test/agents-fleet/gateway/` for office-host bring-up (new bot). Live DM outbound proven.

**BLOCKER RESOLVED (2026-07-16, commit `9bc5166`):** `v1` is now in the git
snapshot (added surgically — see the office section above for why blind `export`
was NOT used). NEXT = run `ab` (v0 vs v1). Linux host can run it directly; other
hosts `git pull && store-sync.sh import` first.

Full detail + v1's diagnosis & playbook: **[loop-1-state.md](loop-1-state.md)**.

**Completed run data also travels via git now:** `term-bench2/results-archive/`
holds committed copies of final results (both baselines, phase-0 self-score,
gate/soak) — the working `term-bench2/results/` dir stays git-ignored.

## The store travels via git now (no scp)

The account store (`~/.config/meta-harness` — candidates v0/v1, active, playbooks,
traces, role/squad stores) is mirrored into the repo at **`term-bench2/store/`** by
`term-bench2/store-sync.sh`. So loop artifacts cross hosts by `git push`/`git pull`.

- **Host that HAS the new candidate** (e.g. linux with v1):
  ```
  git pull
  term-bench2/store-sync.sh export          # ~/.config/meta-harness -> term-bench2/store/
  git add term-bench2/store && git commit -m "store: loop-N candidates" && git push
  ```
- **Other host** (e.g. MacBook, to run `ab`):
  ```
  git pull
  term-bench2/store-sync.sh import          # term-bench2/store/ -> ~/.config/meta-harness (backs up existing to .bak)
  ls ~/.config/meta-harness/global/candidates/   # expect: v0 v1
  ```
Discipline (single-user serial, like the old scp-replace): **pull+import before working, export+push after.** `import` is a full mirror (`--delete`) but backs up the prior store to `.bak` first; `store-sync.sh diff` shows drift.

## Resume the loop (Path A — keeps this exact v1)

1. `cd ~/z2/meta-harness && git pull && term-bench2/store-sync.sh import` (brings v1 into the store).
2. Bench prereqs (macOS): `podman machine start` (if needed) → `bun term-bench2/runner.ts prep --apply`. Needs the TB2 task repo at `~/z2/terminal-bench-2`.
3. Run `ab` (detached, ~3–5 hr, resumable). **Bound each attempt** with the timeout flags (verifier was uncapped — fixed 2026-07-15):
   ```
   nohup bun term-bench2/runner.ts ab --layer account-global --candidate v1 \
     --split-file term-bench2/splits/loop1.json --model anthropic/claude-haiku-4-5 \
     --k 2 --max-agent-timeout 600 --max-verifier-timeout 300 --resume \
     > term-bench2/logs/loop1-ab.log 2>&1 &
   ```
4. Verdict: `bun term-bench2/runner.ts report-loop`; on accept → `/mh-activate account v1`, then `store-sync.sh export` + commit + push so every host has the new active.

**No committed v1 yet?** Path B (re-derives a DIFFERENT v1): store-writing run
`run --task-file term-bench2/splits/loop1-band.txt --k 2 --layers account --model anthropic/claude-haiku-4-5`,
then start opencode + `/mh-propose account` (the `external_directory` grant is already in `opencode.json`), then `ab` as above.

## Gotchas (already handled, don't re-hit)
- Account-scope propose needs `opencode.json` → `"permission": {"external_directory": "allow"}` (committed) — else the headless proposer hangs on a permission prompt.
- `--results-file` forces `--no-store` (a run feeds the store OR writes results, never both); store-writing runs aren't resumable; `ab` is.

## Landed 2026-07-16 evening (MacBook): bench resource-scheduler SHIPPED DARK
`--enforce-resources` + `--parallel` (budget-packed, D5 verdict-equivalent) +
`task-load` — all default-OFF, merged `d528ae5`. Spec/plan in docs/superpowers/
{specs,plans}/2026-07-16-bench-resource-scheduler*. applehv cgroup caps VERIFIED
live; serial enforce smoke green; parallel key-gate verified. **Flag-flip gate
(NOT merge gate): the 3-concurrent smoke needs ANTHROPIC_API_KEY** (parallel
forbids shared oauth mounts by design) — then flipping enforcement on is a
re-baseline event, bundled with Loop-3's recordTimeouts flip. Deferred
pre-first-sweep item: interior log-line prefixes under --parallel.

✅ **RESOLVED 2026-07-16 (home session): the oauth-race rationale is CONFIRMED,
not just assumed** — Anthropic's own tracker (claude-code #22600/#48786) + local
`~/.claude` `expiresAt` ≈ 8h show the refresh token is single-use, rotated on
refresh (~8h expiry, NOT per task), with no locking in CC or the harness → the
`--parallel` shared-credential race is real. DECISION recorded in
`docs/auth-delegation-design.md`: **surface, don't handle** — the `--parallel`
guard rejects oauth+parallel up front, user chooses serial (safe) or a static key
(keyOnly). The destructive live experiment is NOT needed (existence proven; a real
refresh would rotate + invalidate the live token). Now TESTED (`46131ec`: ab-guard
fires + keyOnly removes the race surface). The block below is the original OPEN
framing, kept for context.

⚠️ **(historical) the oauth-race rationale behind the --parallel key requirement was
UNTESTED (user-flagged as a big issue 2026-07-16).** The whole D4 design (no
oauth under --parallel; ANTHROPIC_API_KEY mandatory) rests on the pre-existing
`agent-auth.ts:32-37` comment ("plugin rotates the refresh token on use;
concurrent containers can race auth.json") — a code-grounded ASSUMPTION, never
reproduced by anyone. What IS verified: every container mounts the same rw
credential dir (fact, from code). What is NOT verified: that rotation actually
happens on use, or that concurrent rotations corrupt the store. We designed
around it without testing because the destructive test would race the REAL
credential store (asymmetric risk, cheap mitigation). **Safe experiment, defined
and pending:** copy the auth dir to scratch, point two containers at the COPY
(XDG override — same isolation the propose-smoke used), force both to refresh
concurrently (expire the access token in the copy), diff what survives.
Outcomes: (a) corruption reproduced → assumption confirmed, key requirement
stands, close the question; (b) no corruption → the key gate is over-strict —
consider relaxing D4 to allow oauth+parallel (spec + gate change + re-review).
Until tested, oauth+parallel stays FORBIDDEN (fail-safe default). Also note:
API keys CAN carry org-set expiry (CC shows remaining days) — check before an
overnight parallel sweep; mid-run expiry = fail-fast 401, ab resumes, run loses
in-flight tasks only.

## Pending decisions (not started, need a go)
- **Phase-0 re-run** (MacBook, overnight ~7h): strengthen `SELF_CHECK_INSTRUCTION`
  in `opencode-plugin/src/bench/self-score.ts` (force compliance + honest
  fractions — current one yields 26% capture, all-1.0 claims), then re-run the
  43-task `--self-check` night and re-check the gate.
- **Seed corpus** (`docs/external-prompts-cc-opencode.md`): measure-first — only
  after loop-1's `ab` verdict shows what propose finds on its own.

## Bigger map
`docs/INDEX.md` → all design docs. The prompt-mining plan
(`docs/superpowers/plans/2026-07-14-cc-opencode-prompt-mining.md`) was EXECUTED
2026-07-15→16 (see "Landed overnight" above) — no saved-but-unexecuted plans remain.
