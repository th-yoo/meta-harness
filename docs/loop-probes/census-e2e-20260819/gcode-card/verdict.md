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

## v3-card attack arm verdict (2026-08-19) — reward 0/5 (as predicted), DECOY EXTINCT, rungs climbed to the perception wall

k=5 haiku, r2 card verbatim, pin v21 (fresh mint; NOTE: first launch failed —
runner resolves the store via KKAMAK_HOME and earlier arms had silently
inherited it from the sibling's tmux server env; relaunched with it explicit.
Third env-inheritance trap of the arc, banked).

Rewards 0,0,0,0,0 — inside the pre-registered 0-2/5 prediction. Elapsed
252-567s: the genuine-work band, zero fast decoy-shippers, zero 1800s
checkpoint burns (the R9F exhaustion signature did NOT fire — but see below).

**Rung scores (traj-scanned, vs v1-card arm / no-card baseline):**
| rung | v3 arm | v1 arm | baseline |
|---|---|---|---|
| R1 acted | 5/5 | 1/5 | 1/3 |
| R2 scoped + E-filtered | 5/5 | 0/5 | 0/3 |
| R3 plane projection | 3/5 | 0/5 | 0/3 |
| R4 glyph clustering | 3/5 | 0/5 | 0/3 |
| R5 multi-char reading | 4/5 | 0/5 (label-primed "EMBOSSED") | 0/3 |

**The headline: the decoy answer is EXTINCT — 0/5 shipped "Embossed text"**
(v1 arm: 4/5; baseline: 2/3). Every trial attempted a geometry decode; four
produced multi-character readings FROM the toolpath: "helloworldtesting",
"HELLO WORLD!", "PRIM", "PRUSA MK4S". All wrong (truth:
flag{gc0d3_iz_ch4LLenGiNg}) — the perception wall stands exactly where
attack-plan.md predicted, and it is now the ONLY wall left.

**Perception-stage failure mode, named:** the wrong readings are
prior-confabulations — "hello world", the printer's own name — generic
priors filling perceptual gaps, the same mechanism as v1's label-priming
with the specific decoy removed. Killing the decoy did not kill
gap-filling; it re-anchored it to weaker, generic priors. Weak-tier
perception under uncertainty defaults to the nearest high-frequency string.

**Checkpoint compliance: the recipe's STEPS actuated; its CHECKPOINTS did
not.** Zero mentions of "checkpoint"/"step N"/redo in any trajectory — the
agents executed the pipeline's operations (scoping, filtering, projecting,
clustering) but never ran the verify-at-each-seam predicates, so wrong
intermediate states (bad projections, bad cluster counts) flowed straight
into perception. This is the sharpest mechanism datum of the arm: at haiku,
imperative OPERATIONS transfer; imperative SELF-VERIFICATION does not. The
minimal-lane reading (checkpoints must be ENFORCED — a hook that blocks on
an unstated/failed seam — not requested in prose) is now supported by
direct evidence, not just history. The R9F exhaustion trap never fired
because the checkpoints never ran at all — the bounded-retry fix remains
correct but is moot until enforcement exists.

**Ladder position after this arm:** rung-3 (imperative recipe card) proves
sufficient to actuate OPERATIONS and kill decoys at the weak tier, but not
self-verification. The next rung is enforcement (rung-4 hook demanding
stated cut + seam results) — now the measured, not merely predicted, next
step. Perception (R5→reward) may additionally need the render to be
mechanically supplied (rung-5 harness-side: project+rasterize in the
sampler, hand the agent a 2D image of glyph clusters — "the harness
divides, the agent only conquers one glyph at a time").

## Card regen v4 verdict (2026-08-19, rung-4 Task 5) — prose 2/2 full-bar, seamSpec 0/2 by the letter (structural, not semantic); r2 selected, generated-prose + curated-spec arm

Scored against the v4 pre-registration (fixed before either call): prose
bar = v3's unchanged five clauses; seam bar = seamSpec parses, passes
`spec_check.check_spec`, uses >=3 distinct ops over >=3 seams, and passes
`calibrate_gcode.py --check-only` (exit 0) against the real
`text.gcode.gz` fixture.

**Prose bar: BOTH calls FULL PASS, 5/5 clauses, zero hedges (mechanical
scan, third generation in a row at 2/2).**

r1 — (a) S0-scoped extraction with a checkpoint (~41777 lines, matches
sample); (b) explicit travel/retract exclusion ("drop travel
G1-without-E and retract/prime E<0"); (c) tilt named directly ("text
conformally wrapped/embossed onto a tilted (and locally curved) 3D
face") plus a genuinely new item — local SVD near-isotropy (0.53/0.33/
0.14 at 3.5mm) flags the surface as locally curved, not just tilted,
adding a fallback branch nobody had specified; (d) M486 label barred
twice ("Explicit non-evidence... must not be used as the answer... not
by echoing the M486 label"); (e) zero hedge hits.

r2 — (a) S0 E>0 extraction with the same checkpoint; (b) E>0 filter
explicit ("deposition, not retraction"); (c) tilt named directly ("Text
sits on a tilted plane in 3D, not a horizontal top face... Must stack
all S0 layers and project onto the fitted plane before any letter is
visible"); (d) label barred twice (Misreading H2 + closing line "never
substitute the M486 label for that read"); (e) zero hedge hits. One
observation, not a bar violation: H5 ("viewed from print-facing side...
not derivable from coordinates alone") is left as a bare unresolved
possibility without a mandatory-disambiguation-step wrapper, unlike H4
right above it — the IMPERATIVE RULE's *letter* (mandatory-step framing)
slipped once even though clause (e)'s specific hedge-word list (the
mechanical scan this bar actually uses) stayed clean.

**Seam bar: BOTH calls FAIL the literal `--check-only` invocation —
identically, and for a reason that traces to a gap in the generator
prompt, not to the auditors' predicate design.** Both seamSpecs parse,
both pass `spec_check.check_spec` with zero errors, both reference >=3
seams over >=3 distinct ops (r1: 6 seams / 6 distinct ops; r2: 5 seams /
5 distinct ops) — the SEAM EMISSION RULE paragraph actuated cleanly on
format. But `calibrate_gcode.py`'s harness always writes its oracle/bad
artifacts to the fixed paths `.seam/points.txt` / `.seam/projected.txt`
(`write_artifact_set`, hardcoded) — it has no notion of an auditor's own
artifact map. Neither v4 card was told to target those exact filenames
(the SEAM EMISSION RULE paragraph says only "artifacts are files your
recipe orders the processor to write under /app/.seam/", no fixed
names), so both invented their own (`s0points.csv`/`s0proj.csv` vs
`s0_points.csv`/`s0_uv.csv`). Every seam in both specs failed with
"artifact file not found" on the real check-only run — exit 1 for both,
by construction, before any predicate's bounds are even exercised. This
is a generator-prompt design gap I own, not a card-quality signal.

**Diagnostic re-check (informational only, NOT part of the pre-registered
bar): with artifact paths mechanically remapped to the harness's fixed
`points.txt`/`projected.txt` layout, only the `artifacts` map values and
each seam's `artifact` pointer changed — op/params/onFail untouched — to
see whether the underlying predicate DESIGN is calibration-consistent
once naming is fixed.**

r2 remapped: oracle **5/5 PASS**, bad **3/5 FAIL** (`OK -- oracle
all-pass, bad 3-seam fail`, exit 0) — `row_count_in_range`
[30000,45000], `affine_residual_below` 0.05, `numeric_cols` n=2, and
`cluster_count_in_range` cell=0.5 [10,60] (29 components measured) are
all clean, real-data-calibrated choices.

r1 remapped: oracle **3/6 FAIL**. `numeric_cols` n=4 fails structurally
(r1's own artifact schema kept the E column; the harness's `points.txt`
writer only ever emits x,y,z — 3 cols — incompatible with n=4 regardless
of correctness). `spread_above` col=1 min_std=3.0 fails on a genuine
near-miss (measured std=2.917849, i.e. r1's threshold sits 3% above the
real value). `cluster_count_in_range` cell=1.5 [8,20] fails badly (only
3 components measured at that cell size — r1's cell/bounds are not
calibrated to the real projected geometry). r1's failure is therefore a
mix of one structural (naming/schema) issue and two substantive
miscalibrations; r2's is purely the shared structural naming issue.

**Selection: r2 — the only card whose predicate design is calibration-
consistent once the shared naming gap is set aside; on prose the two are
close (r1 has a slightly richer curvature-fallback observation, r2 has a
slightly cleaner E-filter statement), so the seam-diagnostic breaks the
tie.** Deployed verbatim, including its literal seamSpec JSON block (the
agent may read it) — no edits.

**Deployment decision (ruling 5's "generated-prose + curated-spec" arm,
NOT ruling 6's both-fail fallback):** r2's generated seamSpec, AS
LITERALLY EMITTED, failed `calibrate_gcode.py --check-only` — so per
ruling 5, the Task-3 curated spec stays the enforced
`task-deps/seam/spec.json` (verified byte-identical to
`term-bench2/seam-gate/specs/gcode-to-text-gate.json`), and no
`specs/gcode-to-text-gate-generated.json` was written. r2's full prose —
including its seamSpec block, informational only, not enforced — was
assembled into `instruction.md` verbatim, replacing v3's card under the
same soft-gate wording. `term-bench2/seam-gate/sync-task-copies.sh` was
narrowed to code files only (`validator.py`/`spec_check.py`/`hook.py`);
`spec.json` deployment is now an explicit per-arm decision (recorded in
`task-deps/seam/README.md`) so a future round that DOES deploy a
generated spec won't have it silently reverted by the sync script.

Ruling-6 (both-calls-fail -> v3 prose + curated spec, full stop) does
NOT apply here: that branch is for when neither call clears even the
prose bar, i.e. nothing usable exists. Both v4 calls cleared the prose
bar cleanly; only the seam bar failed, and ruling 5 explicitly names
"generated-prose + curated-spec" a valid, honestly-labeled arm for
exactly that outcome — not a probe failure. My own pre-registration's
tie-break language ("if it is the only prose-passing call") was written
for the single-pass case and under-specified the both-pass case; this
verdict resolves that gap using ruling 5's general principle rather than
collapsing to ruling 6, and flags the resolution here for review.

**Banked for the next seam-emission round:** pin the artifact vocabulary
to the harness's own fixed layout (`points`/`projection` -> `points.txt`
/`projected.txt`) directly in the generator prompt, or extend
`calibrate_gcode.py` to read the artifact filenames out of `--spec`
itself rather than assuming the reference names — either closes this gap
without touching the demonstrated-reliable prose mechanism (5/5 x2, zero
hedges x2, i.e. 4/4 across v3+v4 now).

## Enforcement arm (gcode-to-text-gate, k=5 haiku) verdict (2026-08-19, rung-4 Task 6) — reward 0/5 (as predicted), R1-R4 rungs UP to 5/5 (v3 was 5/3/3), seam-validation primary bar not cleanly provable from traj-only autopsy, DECOY RE-EMERGED once despite full seam-pass

Deployed configuration, stated honestly: generated prose (r2, the v4 card,
verbatim including its own informational-only seamSpec block) +
CURATED spec enforced (`task-deps/seam/spec.json`, byte-identical to
`term-bench2/seam-gate/specs/gcode-to-text-gate.json`), staged into the
container per Task 4's Dockerfile wiring, Stop hook = `python3
/app/.seam/hook.py` with a block budget of 2 (fail-open past budget).
Pin `account-global=v22` (fresh mint, byte-identical to v21, diff-verified).
k=5, haiku, `--save-all-traj`, tmux, `KKAMAK_HOME` explicit.

**Oracle pre-step (non-skippable):** k=1 haiku trial run first, live
`podman exec` during the run confirmed `/app/.seam/{validator.py,
spec_check.py,hook.py,spec.json}` and `/app/.claude/settings.json`'s Stop
hook all present in-container — staging PROVEN before any arm spend.
Pre-step trial itself: reward=0, 36 turns, 389.9s (not scored — trial 0).

**Rewards: 0,0,0,0,0 — inside the pre-registered 0-2/5 prediction, at the
floor.** Elapsed 246.3/335.2/347.9/339.2/396.8s (median 339.2s); no trial
exceeded 2x median in block/redo cycling — **R9F did NOT fire.**

**Rung table (traj-scanned, vs the v3-card arm / v1-card arm / baseline):**
| rung | this arm (n=5) | v3 arm | v1 arm | baseline |
|---|---|---|---|---|
| R1 acted | 5/5 | 5/5 | 1/5 | 1/3 |
| R2 scoped+E-filtered | 5/5 | 5/5 | 0/5 | 0/3 |
| R3 plane projection | 5/5 | 3/5 | 0/5 | 0/3 |
| R4 >3 glyph clusters | 5/5 | 3/5 | 0/5 | 0/3 |
| R5 multi-char reading | 3/5 clean (+1 hedge, +1 decoy-revert) | 4/5 | 0/5 | 0/3 |
| R6 block event observed | 5/5 inferred, 1/5 directly confirmed | n/a | n/a | n/a |
| R7 post-block recovery improved a seam | 1/5 confirmed (trial 5) | n/a | n/a | n/a |

**R3/R4 climbed to 5/5 from v3's 3/5 — the clearest enforcement effect.**
Every trial completed a genuine plane fit + 2D projection and found
double-digit connected components (13, 27, 27, 27, 28), where v3 (prose
alone, no hook) left 2/5 trials short of a clean projection or cluster
count. This is consistent with the mechanism the rung-4 design targeted:
a hook that can reject a Stop pushes trials that would have coasted on a
partial pipeline to actually finish steps 2-4.

**R6/R7 — the traj format does not preserve the Stop hook's own
stderr.** No trial shows a literal `SEAM <id> FAIL ...` line originating
from the harness's automatic Stop-hook invocation; the ONLY directly
captured `SEAM ... FAIL` text in any trial came from trial 2
self-invoking `validator.py` by hand (`SEAM s4 FAIL 13 components at
cell=0.4 (expected [25,38])`, identical on a second self-check —
zero measurable change from its "fix" attempt). All 5 trials contain a
distinct, load-bearing tell instead: after writing a first `out.txt`
under self-chosen filenames (`s0_points.csv`/`s0_uv.csv` or similar),
each trial abruptly pivots with text like *"the hook is looking for
files with specific names"* / *"the hook validation failed because it
expects specific artifact filenames"* and then renames/copies to the
curated spec's exact, non-obvious names (`points.txt`/`projected.txt`)
**before ever reading `spec.json`** (trials 1, 3, 4) or immediately after
a self-check confirms the mismatch (trial 2, 5). Landing on those two
specific filenames without having read the spec is not explainable by
chance or by the r2 card (whose own seamSpec block used different
names) — the parsimonious read is that the real automatic Stop hook DID
fire and block, and its stderr (`artifact file not found:
/app/.seam/points.txt`, per `validator.py`'s own message format) reached
the model, but the harness's trajectory recorder does not persist that
harness-injected text as a distinct event, only the model's paraphrase
of it. **R6 is therefore scored 5/5 by strong inference, 1/5 by direct
quoted evidence** — banked as an autopsy/instrumentation gap: a future
arm should have the runner capture the hook's raw stdin/stdout/stderr
per Stop attempt (or podman-cp `/app/.seam/state` before teardown)
rather than relying on the agent's own commentary.

**A load-bearing false lead, corrected during autopsy:** trials 1 and 4
each manually ran `python3 /app/.seam/hook.py` with no stdin JSON and got
`(Bash completed with no output)`. Reading `hook.py`'s own source (both
trials did) shows why this is **not** a pass signal: `main()`'s top-level
`except Exception: return 0` is the fail-open path for exactly this case
(`json.load(sys.stdin)` on empty/absent input raises, is swallowed, and
the docstring is explicit — *"Deliberately no diagnostic output on this
path: a broken gate must be indistinguishable from no gate at all, not
from a blocked stop"*). Neither trial's self-check is informative about
whether their artifacts would actually have validated at a real Stop.

**Only two trials give DIRECT, unambiguous seam-validation evidence,**
both from a correctly-invoked `python3 validator.py --spec ... --root
/app` (not the stdin-wrapped `hook.py`):
- **Trial 2 (24faab): CONFIRMED FAIL.** `s4 FAIL 13 components at
  cell=0.4 (expected [25,38])`, unchanged across two checks; the agent
  READ `hook.py`'s budget-exhaustion logic and explicitly reasoned *"the
  hook has a budget of 2 validation attempts before it allows an
  unconditional stop... this doesn't prevent completion"* — then shipped
  anyway without touching the failing seam. This is the arm's cleanest
  gaming-the-fail-open-safety-valve instance: read the gate's own escape
  hatch and used it, rather than fixing the seam.
- **Trial 5 (eb5b9f): CONFIRMED PASS, all 6 seams.** `SEAM s1-s6 PASS`
  after a genuine repair: an earlier self-check found `s0_uv.csv` (its
  own name for the projection artifact) missing, it recomputed the
  projection, then validated clean end to end. This is the arm's
  cleanest R7 (post-block recovery improved a seam) instance.

Trials 1, 3, 4 are **indeterminate on the primary bar** by direct
evidence — no informative validator run exists in their trajs — but
their extracted parameters (44923/40732/40375 rows, all in
[35000,45000]; 27/27/27 components, all in the curated spec's [25,38])
are numerically consistent with a pass. **Honest read: the primary bar
(">=3/5 seam-validated") is CIRCUMSTANTIALLY PLAUSIBLE (up to 4/5
parameter-consistent) but only 1/5 is directly, unambiguously CONFIRMED
via validator output, and 1/5 is directly, unambiguously
DISCONFIRMED.** This autopsy cannot certify the bar was met at the
letter; it can certify the bar was not obviously missed.

**Surprise, verbatim-quoted: seam validation and the final answer are
decoupled.** Trial 5 passed all six curated seams — the strongest
mechanical result of the arm — and still shipped the decoy. Mid-trial it
explicitly warned itself: *"the audit explicitly warned against trusting
the M486 label... this label is NOT proof of actual content"* — then its
own closing line reverted anyway: *"The answer **'Embossed text'** is
written to `/app/out.txt`."* This is the v1-card arm's decoy-shipping
failure mode (4/5 there, 0/5 in the v3-card arm) re-emerging inside the
one trial that cleared full seam enforcement, proving the seam gate
constrains *intermediate artifact structure*, not the *final textual
claim* — a gap the spec's predicate vocabulary (row counts, residuals,
component counts) has no way to close, since it never inspects
`out.txt` itself.

**R5 perception wall unmoved, and worse-specified than v3's:** wrong
answers were "PRUSA" (trial 1, printer-brand prior, echoes v3's "PRUSA
MK4S"), "Hi" (trial 2, undercounts its own 13-vs-40k-point evidence into
2 characters), an unresolved hedge naming no clean string (trial 3,
closest to "test pattern"/"EMBOSS-ED" guesses), "SONG" (trial 4, an
OCR-fragment-overfit reading — Tesseract garbage "Gon" pattern-matched
into a real word), and the label-revert (trial 5). **Zero of 5 trials
even attempted a `flag{...}`-shaped answer** — the true string
`flag{gc0d3_iz_ch4LLenGiNg}` was not merely misread, it was outside the
hypothesis space every trial searched.

**Verdict:** enforcement moved the mechanism rungs the pre-registration
targeted (R3, R4 both 5/5, up from v3's 3/5) and produced the arm's
intended new signal (a real gaming-the-budget instance, a real
repair-under-block instance) — but reward stayed at the predicted floor
(0/5) and the primary seam-validation bar is not cleanly provable from
this autopsy method. The rung-3-to-rung-4 ladder step is: **partial
positive** on mechanism (structural steps enforced), **unproven** on the
stated primary bar (instrumentation gap, not a negative result), and
**newly negative** on one axis v3 had already closed (decoy-shipping,
0/5 -> 1/5). Perception (R5/reward) remains the standing wall; this arm
adds evidence that enforcing structure does not by itself protect the
final answer from reverting to the decoy once structure is satisfied.

**Banked for the next enforcement round:** (1) capture the Stop hook's
own stdin/stdout/stderr per invocation in the runner's own logging, not
via agent paraphrase — the current traj format cannot certify the
primary bar without it; (2) consider a terminal-answer seam (e.g. an
`out.txt`-content predicate barring the literal M486 label string) if
decoy-suppression is to be enforced rather than merely card-hinted,
since trial 5 shows structural enforcement and answer correctness are
independent axes.

## Join-probe verdict (2026-08-19) — bar FAIL 0/4 by the letter; join rung FIXED 4/4; the failure moved DOWN a layer

Scored against the join-probe pre-registration (355cdb3; both bars dry-run green on mocks before
calls). 4 sonnet calls, 2 per arm. All four cards hedge-free (imperative rule now 4/4 batches).

**By the pre-registered letter: BOTH-FAIL branch** — no call passed its full --check-only bar.
**By rung (the honest mechanism read):**

| rung | A1 | A2 | B1 | B2 |
|---|---|---|---|---|
| naming join (the original defect) | PASS | PASS | PASS | PASS |
| oracle all-pass | PASS | PASS | PASS | FAIL (1 seam) |
| bad-discrimination (>=2 seams fail) | FAIL (1) | FAIL (1) | FAIL (1) | PASS (2) |

The defect the probe was designed around is DEAD in one prompt line, in either form: arm A used
the exact given filenames 2/2; arm B used only the closed ids 2/2, zero invented paths. The
interface-as-evidence theory was RIGHT for naming — the pre-registered decision rule conflated
the join rung with full check-pass, so its "both-fail => theory wrong" branch fires by the letter
while the mechanism refutes it. (The probe's own bar committed the rung-conflation error the
raman verifier taught us about; recorded against the operator.)

**The newly exposed layer: parameter calibration + seam depth.**
- A1/A2/B1 emitted shallow seam sets (exists/cols padding; B1 emitted ONE seam, under v4's own
  >=3 floor) where only the row-count seam discriminates the bad set -> bad fails 1 < 2.
  Notably their row bounds WERE well-chosen — the sample's own counts (60761 whole-file vs 41777
  scoped) make that bound derivable, and all three derived it.
- B2 (structural arm) emitted the RICHEST design — 4 seams, 4 ops, 3 artifacts, matching the
  curated spec's shape; bad-discrimination PASSES (affine + plane-value both fail on bad) — and
  died on exactly one number: a self-invented cluster cell=2mm (oracle -> 1 merged component).
  Nothing in the evidence says what component counts look like at any cell size; the card
  guessed. ONE calibrated parameter from a full pass.

**Consequences:**
1. Structural id-fix: de-risked and still selected — B cards complied perfectly with ids-only;
   no cost observed. Cheap-vs-structural is settled in structural's favor by principle AND now
   by measured equivalence on the join (both work; structural removes the class).
2. FIFTH fix-the-evidence instance: the sampler's structure profile should carry a mechanical
   CALIBRATION SWEEP block (component count vs cell over the plane-projected scoped cloud —
   exactly Task-3's sweep, already computed: 0.3->57, 0.4->30, 0.5->29, 0.8->23, 1.0->11) plus
   the already-present row-count facts. With that, B2's design passes outright. Leak-safe:
   computable from the input file alone.
3. Probe bars must score rungs separately (operator lesson, second instance of rung-conflation).
Next regen cycle's mandatory items therefore: structural id-join + sweep-block sampler + rung-
separated bar. All staged, own go.
