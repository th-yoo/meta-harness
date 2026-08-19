# gcode card generation — pre-registration (2026-08-19, before any call)

Parallel step per user "go both": generate the gcode-to-text convention card
(sonnet, 2 calls, generator-prompt.txt with compute clause) from a leak-safe
sample (instruction + mechanical whole-file stats + head-40/tail-20; tests/
and solution/ never read).

**PASS bar (fixed here, before reading any output), per meta-harness-f7's
spec:** the card UNPROMPTED states that the text content is encoded as
TOOLPATH GEOMETRY — the letterforms are traced by the G-code movement path,
and reading the text requires reconstructing/plotting that path. Naming
geometry-as-text = PASS. Treating a literal string or the M486 object label
("Embossed text") as the answer = FAIL. Ideal (recorded, not required for
PASS): flags the M486 label as a decoy.

Scoring: each call scored independently against the bar; probe passes if
>=1/2 calls PASS (the arm consumes one selected card, selection rule =
mechanical where applicable; here geometry-claim presence is the selector).

Spend: 2 headless sonnet calls, authorized via user "go both" (relayed
2026-08-19 by meta-harness-f7). No bench trials in this step.

## Card regen v2 — pre-registration (2026-08-19, user "go 1", BEFORE any call)

Changes vs v1 generation (both production-shaped, no hand-written card):
1. Sampler v2: adds a deterministic OBJECT-SCOPED block (S0 = "Embossed
   text"): counts (12 blocks, 49918 G1, E-split 41777/8141, Z 0.2-64.88
   across 1507 uniques), first-30 G1 verbatim of the first printing block,
   15 evenly-sampled G1 verbatim. Rationale: v1's sample contained zero
   text-object rows, so tilt/extrusion facts were structurally
   undiscoverable (attack-plan.md).
2. Generator prompt gains the generic IMPERATIVE RULE (tier law: hedges
   read as permission at weak tiers): uncertainty must be phrased as a
   mandatory disambiguation step; non-evidence must be named NOT evidence.

**PASS bar (fixed here):** a card passes iff ALL of:
(a) names object scoping — the text's moves live in the M486 S0..S-1
    blocks and must be isolated;
(b) names extrusion-vs-travel — only extruding moves (E present/positive)
    draw glyphs; travel moves must be excluded;
(c) names the tilted-plane property — Z varies continuously within the
    text object (0.2-64.88, 1507 uniques), so a naive flat-XY projection
    distorts; the processor must fit/project the actual plane;
(d) states the M486 label is NOT evidence for the answer (no permissive
    hedge licensing it);
(e) zero permissive-hedge phrasings ("could be", "sometimes",
    "can't rule out") anywhere in the card.
2 sonnet calls; probe passes if >=1/2 cards meet the full bar; selected
card = the passing one (both pass -> the one with more of (a)-(c) carried
as explicit processor instructions). Arm remains a SEPARATE go.

## Card regen v3 — pre-registration (2026-08-19, user "probe first", BEFORE any call)

Changes vs v2 (TWO variables move — flagged: a pass is attributable to the
package, not either alone; production ships both, arm-2 precedent):
1. Sampler v3 = v2 + STRUCTURE PROFILE block, mechanical and task-blind,
   report-not-interpret: global SVD variance ratios; local SVD at 3 fixed
   scales; per-axis affine functional-dependence R2 (each axis regressed on
   the other two — functional-dependency discovery, standard data-profiling
   canon); per-axis spacing CV under frozen transform family {identity,
   log10, reciprocal}; 20 verbatim Z-bearing extruding S0 lines. No plane
   named, no dimension claimed, no axis privileged. (Recorded honestly: raw
   global SVD alone under-discriminates here — 0.9958/0.0028/0.0013 reads
   quasi-1D; the affine-dependence triple ~0.98/0.98/0.99 carries the
   plane signal without naming it.)
2. Generator prompt v3 = imperative rule + DECOMPOSITION RULE (supply an
   ordered one-dimension-at-a-time recipe with per-step checkpoints; never
   ask the processor to derive the decomposition — HSRL 2026 finding:
   agent-derived decompositions are sub-optimal; TopoBench: keep compact).

**PASS bar: UNCHANGED from v2** (five clauses a-e). Recorded-not-required:
whether the card carries a staged checkpointed recipe (decomposition-rule
compliance). 2 sonnet calls; >=1/2 full-bar = pass; arm remains separate go.

## Attack arm (v3 card) — pre-registration (2026-08-19, user "go", BEFORE any trial)

Task gcode-to-text-card rebuilt: identical soft gate (byte-same wording as
the v1-card arm — channel constant), r2 v3 card VERBATIM (4934 chars, zero
hand edits). Store pin account-global=v21 (fresh mint, byte-identical
content to v19 so harness assembly matches the v1-card arm; rows isolated).
k=5, haiku, --save-all-traj (store-write), tmux.

**Mechanism rungs (primary, scored per traj):**
R1 acted (any geometry decode attempted beyond label verification)
R2 scoped+filtered extraction (S0 blocks AND E>0 filter, per recipe step 1)
R3 plane projection performed (recipe steps 2-3, not raw-XY)
R4 data-driven multi-glyph segmentation (>3 clusters, recipe step 4)
R5 multi-character reading produced (recipe step 5)
Baselines for comparison: v1-card arm acted 1/5, R2-R5 = 0/5; no-card
baseline acted 1/3 R2+ 0/3.
**Reward secondary.** Prediction to score against (from attack-plan.md):
acted-rate high (elf imperative precedent), R2-R3 reached if checkpoints
hold, reward 0-2/5 capped by haiku glyph perception. Checkpoint-recovery
events (a failed checkpoint followed by a redo) recorded as their own
mechanism datum — first live test of checkpointed-recipe self-repair at
weak tier.

## Card regen v4 — pre-registration (2026-08-19, rung-4 Task 5, BEFORE any call)

Changes vs v3 (one variable moves; sample unchanged, still
`input-gcode-sample-v3.txt`): generator prompt gains a SEAM EMISSION RULE
paragraph appended after the DECOMPOSITION RULE — for each mandatory
recipe step, also emit a machine-checkable seam as a fenced ```json block
(key `seamSpec`), restricted to the eight-op frozen predicate vocabulary
from `term-bench2/seam-gate/SPEC.md` (`artifact_exists`,
`row_count_in_range`, `numeric_cols`, `affine_residual_below`,
`variance_ratio_below`, `spread_above`, `cluster_count_in_range`,
`value_in_range`), each op's one-line semantics condensed verbatim from
that spec. Rationale: v3's card proved the decomposition-recipe mechanism
generates real checkpoints in prose, but the arm found checkpoints never
get ENFORCED at haiku tier (verdict above, "checkpoint compliance" note) —
rung-4 tests whether the SAME generation step can also emit a
machine-checkable spec a Stop-hook can enforce, closing that gap.
`generator-prompt-v4.txt` = `generator-prompt-v3.txt` + this one paragraph
only (TopoBench lesson: long prompts hurt, kept compact).

**PASS bar, fixed here before any call:**

Prose bar — v3's five clauses, UNCHANGED (a-e): (a) names object scoping;
(b) names extrusion-vs-travel; (c) names the tilted-plane property with a
fit/project consequence; (d) states the M486 label is NOT evidence; (e)
zero permissive-hedge phrasings anywhere in the card (mechanical scan, the
gcode-card verdict.md precedent's pattern: "could be", "sometimes", "can't
rule out", "likely", "commonly", "usually", "hints").

Seam bar — the emitted seamSpec, ALL of:
1. a fenced ```json block with top-level key `seamSpec` is present and
   parses as JSON;
2. passes `spec_check.check_spec` (imported from
   `term-bench2/seam-gate/spec_check.py`) with zero errors;
3. references >= 3 seams using >= 3 distinct predicate ops;
4. passes `python3 term-bench2/seam-gate/calibrate_gcode.py
   term-bench2/probe-tasks/gcode-to-text-gate/environment/text.gcode.gz
   --spec <extracted-spec.json> --check-only` at exit code 0 — the script's
   own internal assertion is oracle-all-seams-pass AND bad-artifacts-fail
   >= 2 seams, which is strictly stronger than (and therefore satisfies)
   the task-5-brief's stated floor of bad-fails->=1; exit 0 is the
   mechanical pass signal used here.

A call meets the FULL bar only if BOTH the prose bar and the seam bar pass.
Each call is scored independently. Selected card = the one meeting the
full bar; if both meet it, the one whose seamSpec has more
calibration-consistent seams (more seams surviving the calibrate_gcode.py
oracle-pass / bad-fail check, ties broken toward more distinct ops used).
If neither call meets the full bar: bank the verdict, deploy v3's prose
verbatim (current instruction.md content) with the Task-3 calibrated spec
kept in task-deps, mark the arm "v3-prose + curated-spec" for Task 6, and
STOP — no retries beyond the 2 pre-registered calls (hard cap).

If a call passes the prose bar but its seamSpec fails the seam bar, that
call is scored FAIL on the full bar (both required) but its prose remains
eligible under ruling 5's "generated-prose + curated-spec" arm if it is
the only prose-passing call — recorded honestly as a divergence, not a
probe failure.

Spend: exactly 2 headless sonnet calls (hard cap, no bench trials, no
extra calls), authorized as Task 5 of the rung-4 seam-gate plan. Same
isolated-scratch call mechanics as v3 (mktemp -d outside the repo, prompt
+ `input-gcode-sample-v3.txt` copied in as `sample.txt`, `--model sonnet
--allowedTools "Bash Read" --output-format json`, no KKAMAK_HOME, no store
touched).

## Enforcement arm (gcode-to-text-gate, k=5 haiku) — pre-registration (2026-08-19, rung-4 Task 6, BEFORE any trial)

Deployed configuration, stated honestly per the Task-5 verdict: **generated
prose (r2, the v4 card) + curated spec** — the task's `instruction.md`
carries r2's full generated prose verbatim (including its informational,
not-enforced, seamSpec JSON block), while the actually-enforced
`task-deps/seam/spec.json` is the Task-3 CURATED calibrated spec (verified
byte-identical to `term-bench2/seam-gate/specs/gcode-to-text-gate.json`),
staged into the container per Task 4's Dockerfile wiring (`/app/.seam/` +
`/app/.claude/settings.json` Stop hook -> `python3 /app/.seam/hook.py`).
This is ruling 5's "generated-prose + curated-spec" arm, not a hand-written
card and not a generated-spec arm — r2's own seamSpec failed
`calibrate_gcode.py --check-only` by construction (artifact-naming gap) and
was never promoted to the enforced spec.

**Primary bar (fixed here, before any trial): seam artifacts exist AND
validate on >=3/5 trials** — i.e. the Stop-hook's validator.py finds the
agent's declared `/app/.seam/` artifacts present and passing the curated
spec's predicates at Stop time, on a majority of the 5 trials. This is
scored against the v3-card arm's **0/5 self-verification** (checkpoint
compliance was 0/5 there — no trial ever ran its own stated checkpoints;
enforcement is the mechanism under test here, replacing self-report with a
hook that can actually block).

**Mechanism rungs, scored per traj (R1-R5 = the v3 arm's rungs, unchanged
definitions and flag vocabulary, so this arm is directly rung-comparable to
v3/v1/baseline):**
- R1 acted (any geometry decode attempted beyond label verification)
- R2 scoped+filtered extraction (S0 blocks AND E>0 filter)
- R3 plane projection performed (svd/pca/lstsq/plane/project flag vocabulary
  — not raw-XY)
- R4 data-driven multi-glyph segmentation (>3 clusters; cluster/gap/segment/
  travel flag vocabulary)
- R5 multi-character reading produced (final `out.txt` content scored
  against the true answer, `flag{gc0d3_iz_ch4LLenGiNg}`, for record only —
  reward stays secondary per the prediction below)

New rungs for this arm only (the enforcement mechanism has no v3 analogue):
- R6 block event observed — the traj shows a Stop attempt rejected by the
  hook (validator FAIL / spec_check FAIL surfacing as stop-feedback text,
  or the spec's onFail phrases appearing verbatim)
- R7 post-block recovery improved a seam — comparing seam-artifact-related
  activity immediately before vs. immediately after a block event, the
  post-block attempt measurably moves an artifact/predicate closer to
  passing (new artifact written, corrected numeric range, etc.), not just a
  repeated identical Stop attempt

**Reward stays secondary.** Prediction, carried forward from the v3-card
arm and rung-3's "perception is the last wall" verdict: reward 0-2/5,
perception-capped — enforcement is expected to move R1-R4 (and possibly
manufacture R6/R7 events) but NOT to fix haiku's glyph-reading perception
failure, which is a different mechanism (R5/reward).

**Recorded per trial (not gating, informational):** elapsed time, block-
event count (R6 occurrences), and the R9F watch — any trial spending more
than 2x the arm's median elapsed time cycling through block/redo (hook
rejects a Stop, agent redoes, hook rejects again) without net seam
progress, i.e. the enforcement mechanism trapping the agent in unproductive
redo loops rather than driving it toward a passing artifact.

**Arm mechanics:** `gcode-to-text-gate`, k=5, haiku
(`anthropic/claude-haiku-4-5-20251001`), pin `account-global=v22` (fresh
mint, byte-identical to v21, verified via diff — row isolation only, same
pattern as v19/v21), `--save-all-traj` (store-write, trajs required for the
rung autopsy — NOT `--results-file`, which forces noStore and kills
`--save-all-traj` per the known runner gotcha), tmux-detached (long-run
survival rule), `KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak` explicit
on every runner invocation (worktree has no `.kkamak`; the store lives in
the main repo).

**Non-skippable pre-step, before the arm spend:** one k=1 haiku trial
("oracle pre-step", reward irrelevant) run against the real runtime,
inspected live via `podman exec` while the container is up to confirm
`/app/.seam/{validator.py,spec_check.py,hook.py,spec.json}` and
`/app/.claude/settings.json`'s Stop hook are actually present
in-container — closing the host-vs-container residual (staging could pass
on the host checkout and still fail to land inside the sandboxed
container). If staging is found broken during this pre-step, the run is
killed and the arm is NOT launched; the enforcement arm requires confirmed
in-container staging as a precondition, not an assumption.

Spend: one k=1 oracle-pre-step haiku trial + one k=5 haiku arm (this
document's pre-registered bar), authorized as Task 6 of the rung-4
seam-gate plan (final task). No further spend beyond these two runs.
