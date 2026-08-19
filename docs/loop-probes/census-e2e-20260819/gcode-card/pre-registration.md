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
