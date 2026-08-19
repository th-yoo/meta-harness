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
