# Rung-4 seam gate — enforced checkpoint verification for card-recipe pipelines

**Spec authority:** `docs/loop-probes/census-e2e-20260819/gcode-card/` (pre-registration.md,
verdict.md, attack-plan.md). Binding evidence: the v3-card arm measured **operations 5/5,
self-verification 0/5** at haiku — imperative card prose actuates pipeline operations but never
the verify-at-seam predicates. Rung-4 = enforce the seams with a Stop-hook gate that validates
agent-emitted artifacts by **recomputing** predicates (never trusting agent-reported results —
the v1 arm measured verification theater).

**Verified facts this plan builds on (2026-08-19, this session — do not re-derive):**
- Project-level `.claude/settings.json` hooks (PostToolUse + Stop) FIRE under the bench driver's
  exact mode: headless `claude -p`, shadow `CLAUDE_CONFIG_DIR`, `--dangerously-skip-permissions`.
  Measured live on host. In-container parity expected (config-layer) but unconfirmed — Task 6's
  oracle pre-step confirms it.
- A full seam-validator pass on the real gcode workload costs **0.16s** (38,972 points: parse
  0.15s, SVD+projection+cluster predicates 0.02s).
- A naive 1D gap scan at 2.0mm returns **2 clusters on ORACLE-grade artifacts** (bar >3) — an
  uncalibrated predicate produces a false-positive gate. Hence Task 3 is mandatory.
- Bench driver: `opencode-plugin/src/bench/drivers/claude-code.ts` — argv `claude -p <instruction>
  --output-format stream-json --verbose --model <m> --dangerously-skip-permissions`; harness =
  workspace file /app/CLAUDE.md; task env staged via `setup_deps.sh` from
  `~/z2/terminal-bench-2/<task>/environment/` into WORKDIR (/app).
- The gcode data file: `~/z2/terminal-bench-2/gcode-to-text/environment/text.gcode.gz`; truth
  `flag{gc0d3_iz_ch4LLenGiNg}` (26 glyphs); text object = M486 S0 blocks; extruding S0 points lie
  on plane Z=0.3325X+0.1720Y−30.37, R²=0.9878.

## Global Constraints

1. **Fail-open is absolute.** The hook may never wedge a session: validator internal error →
   allow (exit 0 from the hook) with a warning line; only a *predicate failure* blocks. Block
   budget: **2 blocks per session**, tracked in a state file; third failing stop is allowed
   through with a notice. (kkamak law + R9F exhaustion lesson.)
2. **Declarative predicates only.** The seam spec is data (JSON) drawn from a frozen vocabulary;
   the validator interprets it. No auditor-authored code is ever executed. (Injection surface.)
3. **Leak safety.** Validator, spec, and hook never read `tests/` or `solution/`. Predicates are
   computable from the input file + agent artifacts alone.
4. **Explicit store env.** Every bench/runner launch sets `KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak`
   explicitly in the command. Never inherited. (Third env-inheritance trap, banked.)
5. **Pre-registration before spend.** Task 5's generation bar and Task 6's arm rungs are written
   and committed BEFORE their model calls / bench trials run.
6. Python for validator (numpy allowed — Task 4 ensures it in-container). New code lives under
   `term-bench2/seam-gate/`. Task-facing copies are staged via the existing probe-tasks
   `install.sh` flow.
7. Agent-facing artifact dir in-container: `/app/.seam/` (spec.json, state, agent-emitted
   artifacts). The instruction/card tells the agent what artifacts to write there; the hook
   validates them.

## Task 1 — Seam-spec schema + frozen predicate vocabulary

Create `term-bench2/seam-gate/SPEC.md` and `term-bench2/seam-gate/schema.json`.

Spec JSON shape:
```json
{
  "seamSpecVersion": 1,
  "task": "<name>",
  "artifacts": { "<id>": "/app/.seam/<file>" },
  "seams": [
    { "id": "s1", "artifact": "<id>", "predicate": { "op": "<vocab-op>", ...params },
      "onFail": "<one-line evidence message for the agent>" }
  ]
}
```

Frozen vocabulary (exactly these ops, schema-enforced):
- `artifact_exists` — file present and non-empty.
- `row_count_in_range` {min,max} — numeric rows in artifact.
- `numeric_cols` {n} — every row has exactly n numeric columns.
- `affine_residual_below` {cols:[i,j,k], max_ratio} — least-squares residual variance of col k
  regressed on cols i,j (+intercept), divided by col k variance, must be < max_ratio.
- `variance_ratio_below` {component:2, max} — SVD on the artifact's numeric columns (centered);
  variance ratio of the given 0-indexed component < max.
- `spread_above` {col, min_std} — std of a column above threshold.
- `cluster_count_in_range` {method:"conncomp2d", cell:<mm>, min, max} — rasterize cols 0,1 at
  the given cell size, 8-connected components above a min-pixel floor of 3, count in [min,max].
  (conncomp2d only — the 1D gap method is banned by the calibration finding above.)
- `value_in_range` {row:0, col, min, max} — single scalar check.

Each op's params and semantics documented in SPEC.md with one worked example. schema.json is a
JSON Schema (draft-07 ok) rejecting unknown ops and unknown top-level keys.

Also create the **gcode reference spec** `term-bench2/seam-gate/specs/gcode-to-text-gate.json`
with placeholder-free predicates for 4 seams (filtered S0+E points → count+cols; plane →
affine_residual_below; projection artifact → spread + variance; clusters → conncomp2d count)
using bounds from the verified facts, EXCEPT cluster/count bounds marked provisional — Task 3
calibrates and rewrites them.

Tests: a validation script `term-bench2/seam-gate/test/test-schema.py` (plain `python3 -m
unittest` style, no pytest dependency) asserting: reference spec validates; unknown op rejected;
unknown top-level key rejected; missing artifact id referenced by a seam rejected. Use only
stdlib `json` + `jsonschema` if available — if `jsonschema` is not importable, implement a
minimal hand-rolled checker in `term-bench2/seam-gate/spec_check.py` (op whitelist + required
params) and test THAT; do not add a package dependency to the repo.

## Task 2 — Validator kernel

Create `term-bench2/seam-gate/validator.py` (python3, numpy):

- CLI: `python3 validator.py --spec <spec.json> --root <dir>` (root = where artifact paths
  resolve; `/app` in-container, a temp dir in tests).
- Loads spec via the Task-1 checker. Evaluates every seam in order. Output: one line per seam
  `SEAM <id> PASS|FAIL <detail>` to stdout; exit 0 if all pass, exit 1 if any fail.
- **Fail-open contract:** any internal exception (unreadable artifact treated as predicate FAIL,
  but validator bugs / malformed spec / numpy missing) → print `SEAM-GATE INTERNAL ERROR <msg>`
  and **exit 0**. The distinction matters: predicate-fail exits 1, everything else exits 0.
- Artifact format: whitespace- or comma-separated numeric text files (the agent writes them);
  parse tolerantly, skip non-numeric lines, cap at 500k rows.
- Implement every vocabulary op from Task 1. conncomp2d via numpy only (no scipy): rasterize to
  a boolean grid, label components with a stack-based flood fill.

Tests `term-bench2/seam-gate/test/test-validator.py`: synthetic artifacts per op — pass case +
fail case for each of the 8 ops; the fail-open case (corrupt spec → exit 0 with INTERNAL ERROR);
exit-code contract; a planar synthetic cloud passing affine_residual_below while a spherical one
fails it.

## Task 3 — Calibration harness (predicate truth against oracle + bad artifacts)

Create `term-bench2/seam-gate/calibrate_gcode.py`:

- Generates ORACLE artifacts deterministically from the real gcode file (path arg): S0+E filter
  → `points.txt` (x y z rows); SVD plane fit → project → `projected.txt` (u v rows); the plane
  stats → `plane.txt` (single row: residual_ratio); conncomp2d clusters at the calibrated cell →
  `clusters.txt` (one row per component: cx cy pixels).
- Generates BAD artifacts reproducing the measured v1-arm failure shape: whole-file unfiltered
  points (no S0 scoping, travel included), raw-XY "projection" (u=X, v=Y, no plane fit).
- Runs the Task-2 validator against BOTH artifact sets with the gcode spec. Requirement:
  **oracle passes ALL seams; bad fails ≥2 seams** (it should fail the affine/variance seam and
  the cluster seam). If the provisional cluster bounds fail the oracle, the script SEARCHES cell
  size over {0.3, 0.4, 0.5, 0.8, 1.0}mm and picks the smallest cell whose component count lands
  in [10, 40] on oracle artifacts (26 glyphs ± merging/splitting tolerance), then REWRITES
  `specs/gcode-to-text-gate.json` with the calibrated cell + [count−5, count+8] bounds and
  prints the final numbers.
- Test `test/test-calibrate.py`: run the harness end-to-end against the real file at
  `~/z2/terminal-bench-2/gcode-to-text/environment/text.gcode.gz` (gunzip to temp); assert
  oracle-pass/bad-fail and that the rewritten spec still validates against the schema. Skip
  (not fail) with a clear message if the tb2 checkout is absent.

This task EXISTS because an uncalibrated predicate already blocked correct work once (2-cluster
false positive). The harness is the seam-gate's own gate.

## Task 4 — Hook wiring + in-container mechanical smoke

Create the probe task `term-bench2/probe-tasks/gcode-to-text-gate/`:

- Copy of `gcode-to-text-card/` (environment, task.toml with name
  `meta-harness/gcode-to-text-gate`, tests, solution) — instruction.md REPLACED in Task 5;
  for now keep the card-v3 instruction verbatim as placeholder.
- `environment/task-deps/` gains: `seam/validator.py` + `seam/spec_check.py` (copies from
  seam-gate, staged by a small sync step in install.sh or a copy script — single source of
  truth stays `term-bench2/seam-gate/`, the task copy is generated, with a header comment
  saying so), `seam/spec.json` (the calibrated gcode spec), and `dot-claude/settings.json`
  containing the Stop hook.
- `setup_deps.sh` additions: install numpy (`pip install numpy --quiet` with a
  fallback message), copy `seam/` → `/app/.seam/`, copy `dot-claude/settings.json` →
  `/app/.claude/settings.json`.
- Stop hook command (single bash line in settings.json): runs
  `python3 /app/.seam/hook.py`; create `seam/hook.py`: reads/increments a block counter at
  `/app/.seam/state`; if counter ≥ 2 → print notice, exit 0 (budget exhausted, allow); else run
  validator on `/app/.seam/spec.json` with root `/app`; validator exit 1 → print the failing
  seams' `onFail` lines to **stderr** and **exit 2** (block; stderr reaches the model per CC
  Stop-hook contract) and increment the counter; validator exit 0 → reset counter, exit 0.
  Internal error anywhere → exit 0. A Stop hook must also guard against infinite stop loops:
  if the payload has `stop_hook_active` true, exit 0 immediately.
- **Mechanical smoke (no model):** a script `term-bench2/seam-gate/test/smoke-container.sh`
  that stages the task's environment into a podman container from the bench image (mirror
  setup_deps), drops oracle artifacts into /app/.seam/, runs hook.py inside the container,
  asserts exit 0; then swaps in bad artifacts, asserts exit 2 + stderr contains a seam id;
  then corrupts spec.json, asserts exit 0 (fail-open). Bench image name: read it from the
  existing gcode task staging (grep the runner's staging code or use the image the arms used —
  `python:3.13-slim-bookworm` approximation; the smoke may use `python:3.13-slim-bookworm`
  directly with numpy installed).

Register the new task dir in install.sh's flow (it auto-globs `*/`, so verify only).

## Task 5 — Card regen with seam-spec emission (2 sonnet calls — pre-registered)

- `docs/loop-probes/census-e2e-20260819/gcode-card/generator-prompt-v4.txt` = v3 prompt + one
  paragraph: "For each mandatory recipe step, ALSO emit a machine-checkable seam as a JSON block
  (fenced ```json, key `seamSpec`) using ONLY these predicate ops: <the 8 ops with one-line
  semantics>. Artifacts are files your recipe orders the processor to write under /app/.seam/.
  A seam you cannot express in this vocabulary stays in prose — never invent new ops."
- Pre-registration appended to the gcode-card pre-registration.md BEFORE the calls: bar =
  v3's five clauses (unchanged) AND the emitted seamSpec parses, validates against schema.json,
  references ≥3 seams with ≥3 distinct ops, AND passes the Task-3 calibration harness's oracle
  artifacts (bad artifacts must fail ≥1 of its seams). Selected card = the passing one; if both
  pass, the one whose spec has more calibration-consistent seams.
- Run 2 sonnet calls (same isolated-scratch pattern as v3: prompt + input-gcode-sample-v3.txt,
  `--allowedTools "Bash Read"`, output-format json). Score. Bank verdict.
- Assemble `gcode-to-text-gate/instruction.md`: original task instruction + the SAME soft-gate
  wording as the card arms + the selected card's prose verbatim; the card's seamSpec block is
  ALSO left in the instruction (the agent may read it) and — mechanically extracted — replaces
  `seam/spec.json` in task-deps IF it passes the harness; if the generated spec fails the
  harness, keep the Task-3 calibrated spec as the enforced one and record the divergence in
  the verdict (generated-prose + curated-spec is a valid arm, honestly labeled).
- If BOTH calls fail the bar: STOP after banking the verdict — Task 6 runs with the Task-3
  calibrated spec + the v3 card's prose (rung-4 tests enforcement, not generation; the
  generation result is banked either way).

## Task 6 — The arm (k=5 haiku, pre-registered)

- Pre-register in gcode-card/pre-registration.md BEFORE trials: primary bar = **seam artifacts
  exist and validate on ≥3/5 trials** (vs v3 arm's 0/5 self-verification); mechanism rungs =
  v3's R1–R5 plus R6 "block event observed" and R7 "post-block recovery improved a seam";
  reward secondary (prediction unchanged: 0-2/5, perception-capped); elapsed and block-count
  per trial recorded. R9F watch: any trial spending >2× median elapsed in block-redo cycles.
- Oracle pre-step (the in-container hook-fire confirmation): run the task's own
  `solution/solve.sh`-equivalent once via the runner's oracle mode if available for probe
  tasks, OR one scripted container run that performs a trivial edit + stop with the hook armed
  and oracle artifacts pre-dropped — asserting the hook fires in-container before spending the
  arm. (This closes the host-vs-container residual.)
- Mint `v22` in `/home/th-yoo/z2/meta-harness/.kkamak/global/candidates/` byte-identical to
  v21 (fresh rows; same meta.json pattern, purpose "rung-4 arm isolation").
- Launch from the MAIN checkout's runner? NO — run the runner from THIS worktree (it is the
  same code; lane-A changes in opencode-plugin do not touch the claude-code driver's contract)
  with `KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak` explicit, tmux, tee log to
  /mnt/d/tmp/gcode-gate-arm.log, `--pin account-global=v22 --save-all-traj
  --min-agent-timeout 1800 --label gcode-gate-arm`.
- Autopsy: rung table per trial (traj text events + block events from the sensor/state files
  podman-cp'd or from traj), seam-validation outcomes, R9F check. Bank verdict in
  gcode-card/verdict.md + push.

**Definition of done:** all six tasks complete, verdict banked, branch NOT merged (merge is the
user's explicit go, per the standing rule), workspace ledger closed with all rulings surfaced.
# Task 7 — structural fix package (plan amendment, user-ordered 2026-08-19)

Four items, all evidence-backed (join-probe verdict c34d7af + elf desk-check):

1. **Structural id-join.** Card spec form becomes {seamSpecVersion, task, artifactIds:[...],
   seams:[...]} — NO paths anywhere. spec_check REJECTS any "artifacts" path map or any
   path-bearing entry (the removed freedom is enforced-absent, with tests). validator.py
   resolves ids by convention: <root>/.seam/<id>.txt. Migrate: the curated spec
   (specs/gcode-to-text-gate.json), the task-deps copy, all affected Task-1/2/3 tests
   (explicit recalibration notes required in the report per test changed), calibrate harness,
   hook (its own paths unchanged — verify).
2. **Calibration-evidence emission.** calibrate_gcode.py gains --emit-evidence: prints a
   sample-ready text block carrying the measured statistic or response curve for EVERY
   vocabulary op with a free numeric parameter, computed from the given gcode: cluster
   component-count vs cell over the frozen grid {0.3,0.4,0.5,0.8,1.0}; measured affine
   residual ratio; measured per-column spreads; row counts (scoped and whole-file). SPEC.md
   gains the general contract sentence: "for each op with a free parameter, the evidence
   carries the measured statistic or its response curve over a frozen grid — cards derive
   bounds, never guess them."
3. **Rung-separated bars** (docs only): SPEC.md "bar design" section — pre-registered bars must
   score format / join / content / calibration rungs separately; single conflated pass/fail
   bars are a recorded defect pattern (two instances in this program).
4. **source_crosscheck op family** (elf desk-check finding — the vocabulary was artifact-internal;
   fidelity-to-source was inexpressible). New op:
   source_crosscheck {reader: "<frozen-registry-id>", sample: N} — the validator re-derives N
   deterministically-sampled artifact rows from the TASK'S SOURCE FILE via a frozen reader
   registry and compares within tolerance. validator.py gains --source <path>; hook.py passes
   the task's input file (/app/text.gcode for this task). Implement the registry with ONE
   reader: gcode_g1_points (re-parses the sampled rows' x y z against the source's M486-S0
   extruding G1 lines; deterministic sampling, e.g. every len/N-th artifact row). Registry
   designed for one-file-per-reader growth (elf_le_words lands with the elf regen). Leak rule:
   readers read the task INPUT only — never tests/ or solution/; enforce with a test that the
   reader refuses paths containing /tests/ or /solution/.
   Fail-open: unknown reader id or missing --source = predicate FAIL with clear detail (not
   internal error). Update schema.json + spec_check for the new op. Add source_crosscheck
   {reader:"gcode_g1_points", sample:50} as a new seam in the curated spec, calibrated by
   running the harness (oracle must pass it; bad set: whole-file points contain non-S0 rows →
   crosscheck must FAIL on the bad set — verify and record).

Global constraints (binding, from the plan): fail-open absolute; frozen fixture untouched; no
new deps (numpy ok); python tests test_*.py, full discovery green; container smoke
(smoke-container.sh) re-run green — extend it if hook.py's invocation changed (--source arg);
TDD; do NOT touch docs/loop-probes/** (Task 6 owns those files this cycle); do not touch
verdict.md or pre-registration.md.
