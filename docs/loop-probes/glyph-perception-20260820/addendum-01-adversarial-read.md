# Addendum 01 — adversarial read corrections (2026-08-20)

Source: cross-lane adversarial read (meta-harness-1e) of `verdict.md` @
`75b06d1`, plus controller tile inspection for (D). **The verdict's
registered outcome stands unchanged** (accG 0.500 ≤ accW 1.000 → rung-5
dead for this fixture class); every correction below is to MECHANISM
wording and scope, not to any scored number.

## A — "reading a render is solved" OVERCLAIMED, corrected

The adjacent delivery-channel probe's own data contradicts the general
form: its arm 2 read `9R557Z` for `9R5572` TWICE — a whole-render
per-character error at the same tier on a different fixture. Corrected
claim: **on THIS fixture's stroke render, whole-read is perfect; whole-read
error exists at this tier on other renders.** The upstream-bottleneck
conclusion for gcode survives; "solved" as a general claim does not.

## B — case signal is PRESENT but UNINTERPRETABLE, not deleted

`render_glyphs.py` crops each tile to its own bbox at FIXED px-per-unit:
absolute scale is preserved (a cap `C` tile is physically taller than a
lowercase `c` tile); what is destroyed is the shared REFERENCE (baseline /
neighboring x-height) needed to interpret it. This strengthens the
registered escape: the revival design needs ONE shared reference mark (a
baseline/height rule or common canvas) — format-contract-class structure,
not a re-architecture and not an answer.

## C — "zero shared errors" was vacuous

W made zero errors, so the empty intersection is arithmetic, not a
fingerprint. Correct statement: **W: zero errors; therefore every G error
is decomposition-introduced by construction.**

## D — the three disputed tiles, inspected (controller, raw pixels)

`glyph-01` (l→N), `glyph-11` (i→K), `glyph-22` (i→A): all components
INTACT — both `i` dots present as filled marks above complete stems; the
`l` is a complete double-stroke outline. **Divide/gap-break artifacts are
EXCLUDED.** The actual class: the font renders as OUTLINE STROKE PAIRS,
and parallel-stroke outlines are inherently shape-ambiguous without the
string's font-consistency context (W read all three correctly). Relabeled
from "model shape prior" to **context-recoverable outline-render
ambiguity** — same family as the case/baseline errors: a shared-reference
loss, which makes the mechanism story MORE uniform, not less (13/13 errors
now trace to one channel: reference destroyed by isolation).

## Tier scope

W = 26/26 is a SONNET-tier result and carries its tier the way it carries
its fixture; it does not transfer downward unmeasured.

## Endorsed general result (recorded for the D&C spec)

The paired W-vs-G per-position delta is an EMPIRICAL COUPLING INSTRUMENT:
solve each partition alone, solve the whole, diff per position — the delta
localizes any hidden shared-reference dependency a geometric coupling
analysis cannot see. Criterion (a) "independently solvable" thereby gains a
measurement procedure, answer-free, transferable to any proposed divide on
any artifact. Spec amendment lands alongside this addendum.
