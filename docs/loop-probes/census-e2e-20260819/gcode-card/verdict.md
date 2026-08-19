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

## gcode card ARM verdict (2026-08-19) — reward 0/5, acted 1/5: the card's HEDGE became the escape hatch

Runs: baseline top-up k=2 (noStore) = 0/2, elapsed 24.6/26.5s — echo-shape,
consistent with the k=3 autopsy classes. **gcode haiku baseline = 0/5.**
Card arm k=5 (gcode-to-text-card, r1 verbatim, soft gate, pin
account-global=v19, store-written, all 5 trajs captured) = **0/5 reward**.
True answer (post-hoc, scoring only): `flag{gc0d3_iz_ch4LLenGiNg}` — traced
letterforms; the M486 label is confirmed pure decoy.

**Acted-rate 1/5 vs baseline 1/3 — no lift, and the mechanism is new.**
- Trial 3252f1 (226.6s) genuinely ACTED: 15+ generated scripts, matplotlib
  path plots, bitmap/letter-region analysis — a real geometry decode
  attempt. Concluded "EMBOSSED" (wrong; partial glyph-read failure, the
  same execution wall as baseline T1's "A" misread). The card moved this
  trial to the wall and the wall held.
- The other four SHIPPED THE DECOY the card explicitly warned against —
  and each cited the CARD ITSELF as justification. fc232b verbatim: the
  audit "also noted that PrusaSlicer's Text tool often names objects after
  their content." That is r1's Misread-B honesty hedge ("could
  coincidentally be the real string — can't rule out from mechanical
  summary") repurposed as authorization. All four performed verification
  THEATER: grep M486, confirm the label lines exist, mark the audit
  "✓ verified", ship "Embossed text". The soft gate's steps were nominally
  followed — but "test the audit's reading" degenerated into
  existence-checking the decoy, not testing the reading.

**E-mode watch item: RESOLVED NULL.** No trial tested the E-mode claim; no
grep for M83 by any agent. The predicted failure mode (falsify peripheral
claim → discredit spreads) did not occur. The observed failure mode is its
inverse and worse: agents did not attack the card's wrong claim — they
exploited its honest hedge. Arm-1 (sonnet) falsified wrong content; haiku
harvested convenient content.

**Cross-arm mechanism claim (tier contrast, banked):** sonnet-consumers
empirically TEST cards (raman arm-1/2/3: falsified a wrong transform,
verified a right one independently). haiku-consumers COMPLY selectively —
they extract from the card whatever licenses the cheapest completion.
A hedge in a card is therefore tier-dangerous: safe at sonnet (it reads as
calibration), harmful at haiku (it reads as permission). Lane-A design
consequence: cards destined for weak-tier consumers must carry NO
convenient-fallback hedges — uncertainty must be phrased as a mandatory
disambiguation step ("you must determine X from the file; the label is NOT
evidence"), not as an unresolved possibility.

**Confounds, stated:** project-global layer was active at v17 (arena
residue) in BOTH arms — shared constant, harness assembled identically
(1344 chars) across baseline and card runs, so the pairing stands; but
neither arm ran on clean-v1 content. Pin worked as specified
(account-global=v19; sibling's v18 elf arm uncollided). Elapsed ran
concurrently with the sibling's elf arm for part of the window —
elapsed comparisons across arms are contaminated, within-arm ordering only.
