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

## Card regen v2 verdict (2026-08-19) — 0/2 by the letter; (c) tilt missed BOTH calls, and the sampler is again the cause

Scored against the v2 pre-registered bar (five clauses, fixed before calls).

**r2 = near-miss, 4/5 clauses.** PASSES (a) object scoping (S0 blocks valid,
"must union in interleaved G2/G3 within the same block boundaries"),
(b) extrusion-vs-travel EXPLICIT ("plotting the X/Y extrusion geometry (G1
moves with E>0, plus G2/G3 arcs)"), (d) label-NOT-evidence in textbook
imperative form ("NOT a rendering of the printed glyphs... not evidence...
You must determine actual glyph content by plotting"), (e) ZERO permissive
hedges — the imperative prompt rule actuated fully. MISSES (c): no tilt;
worse, its Misread D instructs "render/plot the path top-down as-is",
an actively anti-tilt instruction, and its CONTENT VERDICT is NO MISMATCH.
Bonus true item: G2/G3 arcs (270+87 present) must be included or curved
glyphs break — new, correct, nobody had it.

**r1 = 2.5/5.** Passes (a) (with a new true item: G1 extremes outside the
M555 bbox are purge/skirt contamination, filter to bbox), (d); (b) weak
(names the 41777 G1-with-E subset as the render set but never states the
travel-weld risk); FAILS (e) — "commonly", "usually", "likely", "hints"
all present; MISSES (c). Notable: r1 CORRECTED v1's E-mode error into a
mandatory disambiguation ("Must grep full file for M82/M83 before trusting
any E delta math") — the imperative rule turned last generation's
falsifiable-wrong assertion into a safe instruction.

**Root cause of the (c) miss is the SAMPLER again, not the auditors, and
this one is mine.** Verified on the real data after scoring: the S0
extruding cloud lies on one plane, Z = 0.3325X + 0.1720Y - 30.37 with
R^2 = 0.9878 (38,972 points) — the tilt is real and extreme. But
sample-v2 carried only aggregate Z stats (min/max/unique-count), which
CANNOT distinguish a tilted plane from ordinary multi-layer growth, and
only ~6% of G1 lines are Z-bearing so the 45 verbatim rows carried almost
no joint (X,Y,Z) structure. Both auditors read the Z spread as normal
layered printing — the parsimonious reading of the evidence they were
given. Same failure class as v1's missing text-object rows: the audit
finds what the sample lets it compute. Generator-arc lesson, third
instance: fix the evidence, not the reasoner.

**Sampler v3 (staged, mechanical, no spend yet):** add one deterministic
stat — least-squares plane fit Z ~ aX + bY over S0 extruding points,
reporting coefficients and R^2 — plus 20 consecutive Z-bearing extruding
G1 lines verbatim. With R^2=0.99 stated in the sample, tilt is one
inference step. Re-run = 2 sonnet calls, own go. Bar unchanged.

## Card regen v3 verdict (2026-08-19) — PASS: r2 meets the full five-clause bar

Scored against the v3 pre-registration (bar unchanged from v2, fixed before
calls). Zero permissive hedges in EITHER card (mechanical scan) — the
imperative rule now actuates 2/2 generations in a row.

**r2 = FULL PASS, all five clauses, plus the recorded-not-required
decomposition recipe in exactly the divide-and-conquer shape.**
(a) S0 scoping with a count checkpoint (~41777); (b) E>0 filtering — and it
inverts travel moves into a FEATURE (pen-up jumps = glyph segmenters,
step 4); (c) tilt derived via THREE independent arguments: the
affine-dependence triple ("points fit a single tilted plane, not the
horizontal XY plane"), a falsification of the horizontal reading ("if the
plane were horizontal, Z's own R2 would be ~0; instead 0.988"), and a new
argument the operator had not conceived — avg unique-Z spacing 0.043mm <<
0.2mm layer height, so Z varies WITHIN layers along the path, i.e. the
toolpath tracks a sloped surface point-by-point; (d) label barred as
evidence at both ends of the card ("no earlier step or the M486 label may
be used as the answer"); (e) hedge count zero. Recipe: 5 ordered steps,
one checkpoint each, 3D→2D (fit+project) → 2D→1D (travel-break glyph
clustering along the baseline) → per-glyph read, with a curved-surface
fallback branch (2b: local tangent planes) — the full recursion, supplied
to the processor rather than asked of it.

**r1 = 4/5, fails (c) by the letter.** Sound methodology — it refused to
assume PCA axes align with raw X/Y/Z and demanded eigenvector loadings
(a LEGITIMATE gap in the structure profile: ratios were reported without
loadings; production sampler contract should add them) — and its recipe
does fit-and-project correctly, but it never names the tilt; its step 4
stays agnostic ("nearly constant per-layer bbox → flat; varying → stop and
re-scope"), deferring the property the bar demands be stated.

**Sampler post-mortem, banked:** the affine-dependence triple carried the
tilt (r2 cited it verbatim); the global SVD ratios alone were ambiguous
exactly as pre-registered (r2's misreading 3 even falsifies the "PC1=99.6%
means 1-D, ignore Z" trap the profile could have induced). The sub-layer-Z
argument shows a strong auditor builds discriminating stats we did not
supply — but only once the object-scoped evidence exists at all.

**Selected card: r2 (4934 chars), verbatim, zero hand edits.** Two-variable
attribution (sampler stats vs decomposition rule) unresolved by design —
package-whole, arm-2 precedent.

**Next (separate go): the k=5 haiku attack arm** — gcode-to-text-card task
rebuilt with the r2 card under the same soft gate, minted store version,
--save-all-traj; mechanism rungs primary (acted → scoped+filtered
extraction → plane-projected → >3 glyph clusters → multi-char read),
reward secondary; prediction: acted-rate high, reward capped by haiku
glyph perception (0-2/5), per attack-plan.md.
