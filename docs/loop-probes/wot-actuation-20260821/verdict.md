# WoT actuation + produce-side verdict (2026-08-21, `yoo-dev`)

Scored against `pre-registration.md` (written first; prompts fixed before
any call). 4 sonnet subagent calls, independent contexts, real -gate
fixture, host env (matplotlib/PIL/numpy present — recorded). Raw answers +
workdir listings under `answers/`.

## Results

| arm | exact match | per-glyph | render path (image files + read) | duration |
|---|---|---|---|---|
| CTRL-1 | **YES** | 26/26 | **YES** (layer_all/rot/mid/zoom.png) | n/r |
| CTRL-2 | no — `iZ` for `iz` | 25/26 | **NO** (zero image files; geometry reasoned textually) | n/r |
| BULLET-1 | **YES** | 26/26 | **YES** (5 pngs incl. crops) | ~104s |
| BULLET-2 | **YES** | 26/26 | **YES** (4 pngs incl. crops) | ~81s |

CTRL: exact 1/2, mean per-glyph 51/52 = 98.1%, render 1/2.
BULLET: exact 2/2, per-glyph 52/52 = 100%, render 2/2.

## Registered outcome mapping (two branches fired; both reported)

1. **BULLET renders ≥1/2 AND beats CTRL per-glyph → HOLDS** (2/2 rendered,
   100% vs 98.1%): actuation + produce-side confirmed locally. **The ab go
   is justified as designed.**
2. **CTRL renders spontaneously ≥1/2 → ALSO HOLDS at the boundary** (1/2):
   sonnet takes the render path unprompted about half the time in this
   context. Registered consequence carried forward honestly: the ab may
   measure a SMALLER lift than the external numbers suggest, because part
   of the behavior pre-exists — the bullet's measured job is raising
   render RELIABILITY (1/2 → 2/2 here), not creating the capability.

## The mechanistic signature (unregistered observation, marked as such)

The single error across all four runs came from the single NON-rendering
run, and it is exactly a CASE error (`z`→`Z`, position 12) — the
shared-reference failure class the glyph-perception probe measured for
reading without relative context, here produced by TEXTUAL geometry
decoding. One instance, n=1, but the error class landing precisely where
two independent probes point is worth recording: render-path runs 3/3
exact; the non-render run failed on case.

## Produce-side detail

All three rendering runs self-assembled the full WoT pipeline unprompted
in its specifics: gunzip → parse G1 extrusion moves under the M486-tagged
object → project XY → de-rotate (~22°) → rasterize (PIL/matplotlib) → Read
own image → transcribe. No prompt named gcode semantics, objects, rotation,
or any library.

## Actuation vs the 1/8 prior

The prose bullet actuated 2/2 — against the loop-1 prose prior (1/8).
Scope caveat, registered: this is a one-sentence instruction adjacent to a
short task prompt in a fresh subagent context, not a playbook bullet inside
the SUT harness's larger prompt surface; actuation there remains the ab's
question. This probe removes the "prose cannot actuate this behavior at
all" hypothesis, not the dilution question.

## Consequences

1. Render-bullet ab: GO-READY per the registered rule (its spend go remains
   the user's).
2. Expectation set honestly: CTRL's spontaneous 1/2 means lift may be
   moderate; the paired gain/regression report (Regression-Tax shape) is
   the right lens, per the research note's §4d registrations.
3. WoT produce-side needs nothing built — the model assembles the loop
   itself when nudged (and sometimes unnudged). The harness's only jobs
   remain the declared invariant (network+pip) and staying out of the way.

## Not measured

SUT-harness actuation (prompt-surface dilution); container install latency
on the render path (host had libs; the libs audit covered container
self-provision separately); haiku tier; k beyond 2.
