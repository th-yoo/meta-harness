# gcode card generation — verdict (2026-08-19)

Scored against pre-registration.md (bar fixed before any call). 2 sonnet
calls, generator-prompt.txt (compute clause), leak-safe sample, isolated
scratch cwd (tests/ and solution/ unreachable).

## Scores

**r1 = PASS (strong).** CONTENT: "Actual visible text is encoded only in
G1/G2/G3 XY toolpath geometry of that object's layers." Misread A flags the
M486 label as the decoy with evidence (object-label syntax; symmetry with
AShape-Box, "box shapes don't have glyphs"). Closing prescription: "only way
to actually answer ... decode G1/G2/G3 XY toolpath geometry within the
'Embossed text' object's layer range into glyph shapes — summary/statistics
cannot substitute for that geometric reconstruction." Ideal clause (decoy
flag) also met. Honest hedge retained (label could coincidentally match the
real string).

**r2 = PARTIAL.** Names the decoy (Misreading B) and locates the answer in
geometry ("visible characters depend on vector/font shape baked into the
mesh ... not a decoded rendering of toolpath geometry"), but never states
the bar's required actionable form — reconstruct/plot the path to READ the
letters; instead closes "actual printed characters undetermined from this
data." Geometry named, method absent.

**Probe: PASS (≥1/2 pre-registered).** Selected card: r1 (only card meeting
the full bar).

## Card-content risk, measured before the arm (not hand-edited — verbatim
discipline): r1 carries ONE falsifiable-WRONG incidental claim. Its Misread
D asserts absolute-E mode, reasoning "M83 absent from top-15 command list."
The file contains `M83` at lines 43 and 107 (below top-15 frequency; the
histogram cut hid it). r2 got E-mode right by computing avg-E-per-G1
(0.00026mm — nonsensical for absolute). Arm-1 (raman) measured exactly this
failure mode: one empirically-falsified claim discredited an entire card.
The consuming agent can falsify r1's E claim with one grep. Watch item for
the arm trajs: does the agent test E-mode, and if it falsifies the claim,
does discredit spread to the (correct) geometry prescription? E-mode is
peripheral to the task question, so a discredit-spread would itself be a
clean robustness datum.

Also recorded: r1 and r2 CONTRADICT each other on E-mode from the same
sample — incidental-claim noise across generator calls is real, and the
mechanical revalidator concept (propose-verify) does not cover claims of
this type (no transform table to recompute). Selection rule caveat for
lane A.

## Next (separate go)
gcode card arm: haiku k=5 vs the banked 0/3 baseline (+2 top-up if wanted
for k=5 symmetric), r1 card VERBATIM under the soft gate, traj-primary
scoring (geometry decode attempted = acted; baseline acted-rate 1/3).
