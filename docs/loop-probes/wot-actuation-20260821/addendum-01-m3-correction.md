# Addendum 01 — M3 false negative and re-mapped outcomes (2026-08-21)

Trigger: sibling review asked for a one-line transcript check on the z→Z
attribution. The check found something bigger: **the verdict's M3 scoring
was wrong for CTRL-2.** Verdict stands as the record of what was scored;
this addendum corrects it.

## The correction

M3 scored "render path taken" from surviving workdir image files. CTRL-2's
workdir had none — but its TRANSCRIPT shows a full render pipeline
(`top.png`, `front.png`, `side.png`, `top_rot.png`, rotation experiments,
and region zooms `ging_zoom.png`, `ch4ll_zoom.png`, `end_zoom.png`) and
MULTIPLE image Reads (display dimensions logged). The agent deleted its
images before finishing. **Artifact-based render detection is unreliable
against cleanup; transcript evidence governs.**

Corrected table:

| arm | exact | per-glyph | render path (corrected) |
|---|---|---|---|
| CTRL-1 | YES | 26/26 | YES |
| CTRL-2 | no (`z`→`Z`) | 25/26 | **YES (was scored NO)** |
| BULLET-1 | YES | 26/26 | YES |
| BULLET-2 | YES | 26/26 | YES |

## Re-mapped registered outcomes

- Spontaneous render rate: **CTRL 2/2**, not 1/2. The registered null
  branch now fires cleanly: at this tier and context the behavior is
  ALREADY PRESENT — the bullet produced ZERO measurable actuation delta
  (2/2 vs 2/2). The verdict's "actuation confirmed" is RETRACTED to
  "actuation unmeasurable here — no headroom in this context".
- Produce-side: strengthened — 4/4 runs self-assembled the render loop.
- Outcome difference that remains: exact-match 2/2 (bullet) vs 1/2 (ctrl),
  n far too small to attribute.

## The z→Z mechanism — BOTH prior attributions wrong

My verdict said textual-path reference-free reading; sibling proposed
information-present-but-unintegrated. The transcript shows a third thing:
CTRL-2 **rendered and read ZOOM CROPS of string regions** — and cropping
is exactly the reference-destruction the glyph-perception probe measured.
The error occurred DESPITE the render path, plausibly BECAUSE the agent's
own workflow re-created per-region isolation. The shared-reference class
survives (it is the common mechanism across all three probes), but the
carrier here was the agent's self-chosen crop, not a textual decode.
Attribution beyond this stays OPEN (which crop produced the `iz` reading
is not recoverable with certainty).

## Consequences for the bullet ab

1. The GO-READY call is DOWNGRADED: with spontaneous render at 2/2 in this
   context, the bullet may buy nothing at sonnet tier. The decisive cheap
   measurement is now the SUT-context spontaneous render rate — readable
   from EXISTING stored gcode trajectories at zero spend (did failing SUT
   runs render? the length-vs-difficulty corpus holds the trajs).
2. If SUT spontaneous rendering is already common, the bullet ab is likely
   a null and should not spend; if SUT runs never render (prompt-surface
   dilution), the bullet has its headroom and the ab proceeds with the
   per-task-flips headline (gain − regression), pre-stated per sibling's
   note — a small aggregate delta must not be read as mechanism failure.
3. Method lesson, recorded: score behavior from TRANSCRIPTS, never from
   surviving artifacts — agents clean up. Same class as "a check that
   cannot fail": an artifact check that cleanup can empty is a detector
   with a silent false-negative mode.
