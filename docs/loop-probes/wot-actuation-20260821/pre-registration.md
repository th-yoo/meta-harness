# Pre-registration — WoT actuation + produce-side probe (2026-08-21)

## Question

Two links remain unmeasured before the render-bullet ab (user: "Probe
first"): (1) PRODUCE side — does a sonnet agent, nudged only by the
modality-level bullet, actually write and run rendering code on the real
gcode fixture and read its own image? (2) ACTUATION — does the prose bullet
move behavior at all (prior: prose lesson-following 1/8, loop-1)?

## Design

Two arms, k=2 each, 4 sonnet subagent calls, independent contexts, each in
its own workdir containing ONLY the real fixture
(`text.gcode.gz`, the -gate copy). Agents have Bash + image-capable Read
(host env: matplotlib/PIL/numpy present — recorded fact; install latency
therefore NOT exercised here, container self-provision was verified in the
libs audit separately).

- **CTRL (k=2):** "The file text.gcode.gz in your working directory encodes
  a piece of text. Recover the text and write ONLY the recovered text to
  answer.txt in the same directory."
- **BULLET (k=2):** same instruction + one sentence, the bullet verbatim:
  "When an artifact encodes something spatial or geometric, render it into
  an image and look at the image rather than decoding coordinates
  textually."

No prompt names gcode semantics, fonts, glyph counts, or the expected
string. Ground truth (`flag{gc0d3_iz_ch4LLenGiNg}`) known to the scorer
only.

## Metrics (mechanical)

Per arm instance: (M1) exact-match of answer.txt; (M2) per-glyph accuracy
(Levenshtein alignment, case-sensitive, as glyph-perception probe); (M3)
RENDER-PATH taken — an image file exists in the workdir AND the transcript
shows a Read of it (scored from workdir artifacts; transcript check
best-effort); (M4) wall-clock per instance.

## Registered outcomes → decision

- BULLET takes the render path ≥1/2 AND beats CTRL on mean per-glyph →
  actuation + produce-side both confirmed locally → the ab go is justified
  as designed.
- CTRL takes the render path spontaneously (≥1/2) → the bullet may be
  unnecessary at this tier; report as the null (interesting: behavior
  already present, ab would measure ~nothing).
- NEITHER arm renders → prose under-actuation confirmed (consistent with
  the 1/8 prior) → the bullet must be re-shaped to the proposer's
  hard-gate/trigger template BEFORE any ab spend; the ab as currently
  imagined would burn a run to measure a known-weak actuator.
- BULLET renders but reads wrong → produce-side gap (WoT's own error class:
  wrong drawing / right drawing wrong read); report confusion detail.

## Scope

Host-environment probe of BEHAVIOR, not a bench measurement: libs are
pre-installed here (the container path self-provisions — separate audit),
tier is sonnet subagents not the SUT harness. Confirms/denies mechanism
and actuation only; the ab remains the only local evidence for reward-level
lift. n=2 per arm is a coarse actuation screen, not a rate estimate.

## Disclosure

Fixture and its ground truth are fully known to me (committed in lane-B
verdicts). Prompts written before any call; scoring mechanical; raw
answers and workdir listings committed with the verdict.
