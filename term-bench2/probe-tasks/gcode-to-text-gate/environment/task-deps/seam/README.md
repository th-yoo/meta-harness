spec.json — deployment is EXPLICIT PER-ARM, not auto-synced

`sync-task-copies.sh` only refreshes `validator.py` / `spec_check.py` /
`hook.py` from `term-bench2/seam-gate/` (code files). It deliberately does
NOT touch `spec.json` (rung-4 Task 5 ruling) -- which spec a task arm ships
is a decision recorded per-arm in that probe's verdict, not something a
generic sync script should silently overwrite.

Current state: `spec.json` here is BYTE-IDENTICAL to
`term-bench2/seam-gate/specs/gcode-to-text-gate.json` (the Task-3 curated /
calibrated reference spec). Verify with:

    diff term-bench2/seam-gate/specs/gcode-to-text-gate.json \
         term-bench2/probe-tasks/gcode-to-text-gate/environment/task-deps/seam/spec.json

Provenance: rung-4 Task 5 (2026-08-19) generated a v4 seamSpec via the
gcode convention-card auditor (2 sonnet calls, `generator-prompt-v4.txt`)
and scored both against `calibrate_gcode.py --check-only`. Both calls'
emitted seamSpecs FAILED that check as literally emitted -- the auditor
invented its own artifact filenames (e.g. `s0_points.csv`, `s0_uv.csv`)
rather than the harness's fixed `points.txt` / `projected.txt` output
layout, so every seam failed with "artifact file not found" regardless of
predicate correctness. (Diagnostic-only re-check, not the pass bar: with
artifact paths mechanically remapped to the harness's fixed layout, the
selected card's [r2] predicates passed cleanly -- oracle 5/5, bad 3/5
failed -- while the other call's [r1] did not, informing the r2-over-r1
selection. See
`docs/loop-probes/census-e2e-20260819/gcode-card/verdict.md`, "Card regen
v4" section, for the full scoring.) Per the ruling's "generated spec FAILED
the harness but the card's prose passed" branch: the selected card's prose
(including its seamSpec JSON, informational) was deployed into
`instruction.md`, and this `spec.json` was kept as the Task-3 curated spec
-- a "generated-prose + curated-spec" arm, not a generated-spec deployment.
No `term-bench2/seam-gate/specs/gcode-to-text-gate-generated.json` exists
because no generated spec passed the harness this round.

Update (Task 7, 2026-08-19): the curated spec was migrated to the id-only
shape (`artifactIds` list, no paths anywhere -- see SPEC.md and
spec_check.py) and gained a 7th seam, `s7` (`source_crosscheck`,
reader=`gcode_g1_points`, sample=50). `spec.json` here was re-copied from
the curated spec after that migration and re-verified byte-identical.
`readers.py` is now also a generated copy synced by `sync-task-copies.sh`
(needed by validator.py's `source_crosscheck` op) -- add it to the same
"never hand-edit" rule as validator.py/spec_check.py/hook.py.
