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
