# D&C (divide & conquer) design — spec (2026-08-20)

User go 2026-08-20 ("Spec/Design for D&C"). Lab scope only (meta-harness);
kkamak explicitly out of scope. Every build item below still needs its own
go; this document fixes the design, not the schedule.

## 1. Purpose

Give the self-improving agent a general decomposition capability that
passes the generality rule (`CLAUDE.md` §1): structure that transfers,
never answers that fit. Every mechanism here is answer-free by
construction, and every design decision below that could be probed cheaply
HAS been — this spec argues from verdicts, not enthusiasm.

## 2. Binding principles

1. **Escalation ladder** (Anthropic guidance): chain → router → map-reduce
   → orchestrator-worker → agentic loop. Simplest that solves; agentic loop
   only when the path is genuinely dynamic.
2. **Rung chosen by the task's measured shape, never ambition.** Structure
   added "because this task seems to want it" is fitting.
3. **Verification escalates with the ladder.** Each rung up gives the
   claimant more degrees of freedom; a fixed chain is checkable
   step-by-step, an agentic loop needs over-determined checks. The cheapest
   rung is also the cheapest to falsify.
4. **A router, if ever built, routes on structural path shape** (known-path
   vs dynamic), never on domain labels — a domain router is the per-domain
   registry failure mode.
5. **Rank, never select, from failure stats.** Failure signatures may order
   axis hypotheses (late-position errors → sequential axis first); selecting
   the axis from failure stats is TARGET_TRUTH-class fitting and does not
   transfer.

## 3. The split-axis criterion (per artifact, answer-free)

A valid split axis has partitions that are:

- **(a) independently solvable** — minimal cross-boundary coupling,
  checkable structurally. LOAD-BEARING: an axis that severs dependencies
  produces subtasks whose merge needs the answer, reintroducing claimant
  degrees of freedom at merge time (the revalidator-bypass defect, at the
  merge).
- **(b) sweep-stable** — the partition persists over the widest unchosen
  parameter range (scale-space class).
- **(c) non-degenerate** — "divided nothing" excluded as a property of the
  operation, never by a fitted threshold.

The criterion is applied PER FIXTURE, and its ability to REFUSE is its
value: gcode's current fixture has a low-coupling glyph axis
(decompose-then-read); a connected-glyph font flips (a) and the criterion
must refuse or relocate the cut. Raman is REFUSED for plain D&C — coupling
is global by nature (one shared transform) — and is routed to §6, which
NARROWS the merge-time claimant degrees of freedom (to pairing over a full
harness-fixed anchor set with non-degenerate geometry) but does not
eliminate them: value truth remains outside §6's guarantee (see §6's scope
paragraph). Routed, not solved. (The gcode/raman applications here are
worked illustrations of the criterion, not independently verdicted
measurements — the second fixture (§8.1) is their test.)
Criterion provenance: lane-B derivation, validated on ONE fixture; the
second fixture (§8) is its transfer test.

## 4. Level 1 — playbook guidance (buildable next; ab-gated)

Behavior-level bullets (proposer rule 3b compliant), teaching the ladder
and the probe discipline. Registered wording, to be trialled as a candidate
and judged ONLY by outcome pass@k:

- "Before committing to an approach, run the cheapest test that could prove
  it wrong; if a claim cannot be tested, do not build on it."
- "When a long input has produced errors that look like overload — dropped
  items, position-dependent mistakes, late-run degradation — split the work
  into independently checkable parts and re-run per part."
- "Prefer the simplest structure that solves: fixed steps as a checklist;
  independent parts split and verified separately; open-ended exploration
  only when the path genuinely depends on what you find."

**Guards (measured, mandatory):**

- G1 — no check, score, or gate ever reads the agent's declared rung or
  split; a declared rung is a claimant-controlled statistic. Evidence: the
  O4 arm's raw cells (`f3-cell-contract-20260820/out-O4-r*.json` —
  announcing the cross-check produced 0/4 parseable blocks while
  constant-consistency rose, i.e. the announced metric improved as the
  underlying behaviour degraded). NOTE: the O4 arm was never formally
  scored in that probe's verdict — scoring it is a §8 obligation; until
  then this guard argues from the raw cells directly. Behavior is taught;
  only outcomes are measured.
- G2 — triggers are OBSERVED failure signatures, never task-shape
  vocabulary (v18 b7 was a lexical trigger; "task has many parts" would
  misfire identically).
- G3 — expected under-actuation (prose lesson-following measured 1/8,
  `docs/reboot.md` loop-1 verdict — carried-over evidence, now in §10); a
  null ab result is informative about level 2, not a defect in the trial.

**Injection path (implementability):** the registered wording above is
INTENT, not final bytes. The proposer's review gate requires trigger/
hard-gate phrasing tied to a measured taxonomy (`propose.ts` SCOPE
requirement), and bullets 1 and 3 as written do not conform. At build time
the bullets are rewritten into the trigger/hard-gate template and routed
through the STANDARD diagnosis-driven proposer path — no bypass script; if
the standard path cannot express one of them, that bullet is dropped, not
smuggled. The ab verdict judges whatever wording actually shipped.

Validation: standard candidate → ab → verdict on the band. Own spend go.

## 5. Level 2 — harness orchestration: blanket form DEAD, conditional probe designed

Probe verdict (`docs/loop-probes/dnc-length-vs-difficulty-20260820/`):
failure classes are BIMODAL per task, not pooled — a length sub-band
(path-tracing 12/14 hard, write-compressor 4/4, tune-mjcf 2/3,
llm-inference-batching, fails at 4.18× pass output) against pure-difficulty
tasks (torch-tensor 17/17, polyglot-rust-c 13/13, configure-git-webserver
11/11) and a third, GATE-shaped stuckness class (raman, sam-cell-seg).
Consequences fixed here:

- No blanket orchestration stage is ever built. D&C addresses only
  length-induced failure, a minority sub-band.
- IF level 2 is probed (own go, after §6 and the second fixture):
  treatment = the length sub-band; control = the pure-difficulty tasks — a
  built-in falsification arm (control lift refutes the mechanism claim
  regardless of treatment lift); gate-shaped tasks pooled into NEITHER arm;
  lift measured WITHIN-TASK against each task's stored baseline only.
- Any second classification pass leads with the within-task fail/pass
  output ratio, not pooled cutoffs; raw distributions reported, never
  thresholded booleans (the probe's own M6 minimum manufactured the class
  boundary it counted — parameter-shaped-boundary tell, addendum-01 A2).

## 6. Merge design for globally-coupled tasks (raman instance)

Where coupling is global (one shared convention), D&C's divide supplies
ANCHORS and the merge is the check. All four conditions are measured, not
assumed (`docs/loop-probes/dnc-merge-fit-20260820/verdict.md`):

1. **Divide** = mechanical scale-persistent peak detection, no line list,
   no count prior, survivor set never trimmed by expected count. Measured
   feasible: 17 peaks on the real fixture, found the known peak region
   blind, n ≥ 3 with margin.
2. **Merge** = ONE over-determined fit in a family FROZEN a priori
   (`y = a + b·u`, `u ∈ {x, 1/x}` — general measurement algebra). The
   family never grows per incident; with n ≥ 3 anchors a wrong family is
   residual-visible, which is why it can stay frozen.
3. **Delta DERIVED, never declared**: `delta < |b| · min Δu / 2` from the
   fit's own slope and the detected spacing. No external constant.
4. **Constellation conditioning check — REQUIRED, measured necessary,
   version 2.** The global identity-shift attack passes the plain
   over-determined gate with rms = 0 on an equal-spaced constellation (the
   affine family absorbs the shift into the intercept); redundancy alone
   does not defeat it. And the ±1-shift-only check (v1) was itself measured
   incomplete: on a SYMMETRIC irregular constellation, full reversal is
   affine with negated slope — plain gate rms = 0 and v1 ACCEPTS the wrong
   claim at R = 5.9e10 (addendum-01, T10). Check v2: R = min(RMS over
   alternates {+1 shift, −1 shift, full reversal}) / RMS(claimed); R ≤ 3 or
   n < 3 → reject; regression-verified identical to v1 on T1–T4. The attack
   class is "any wrong pairing composing with a symmetry of the
   constellation" — which is UNBOUNDED (reflections about interior points,
   near-periodic sub-constellations, partial reversals on symmetric
   subsets), so a fixed alternate list is the F4 whitelist-growth pattern
   at the meta level: v1 → v2 already grew by one entry in response to one
   found attack, the rule's own tell. **The REQUIREMENT is therefore the
   DERIVED form: the alternate set is computed from the constellation's own
   geometry — enumerate its approximate automorphisms (u-spacing
   autocorrelation / self-similarity under a noise-scaled tolerance) and
   use those as the alternates.** Per-artifact, answer-free, closed over
   the attack class instead of chasing it. v2's fixed set {±1 shift,
   reversal} ships only as the regression FLOOR — any implementation must
   pass it, and must not stop at it. Fail-closed on purpose: degenerate
   constellations are UNCHECKABLE, not wrong; no inject, never a pass. T1
   and T10 are the standing regression inputs.
5. **Full-anchor coverage — the merge consumes the ENTIRE harness survivor
   set.** The claimant never selects which anchors are graded: freedom to
   pick 3 of 17 is freedom to construct a fabricated line on a compliant
   subset (addendum-01, consequence 3). Inability to identify the full set
   → fail-closed, no card.

**Scope of the guarantee (measured boundary, addendum-01 T6):** conditions
1–5 establish *pairing integrity over the full anchor set plus geometric
non-degeneracy* — they do NOT establish value truth. An invented (a, b)
applied consistently to the harness's own anchors passes every geometric
check by construction (T6: gate PASS, v1 ACCEPT, v2 ACCEPT).

**Threat-model split (binding sentence):** the merge-gate rejects ERROR —
internal inconsistency, the gen4-r1 confident-wrong class, the original
design target — and NEVER rejects DECEPTION — consistent fabrication;
deception is rejectable only by a prior from OUTSIDE the claim. Value truth
therefore requires an outside mechanism — PRIMARY candidate: the
`source_crosscheck` class (recompute against the task's own source; the
only lane-B seam that survived the §1 audit, precisely because its prior
comes from the artifact's source); BACKSTOP: loop-level outcome evidence
(real but slow and confounded — an injected card can lift pass rate for
wrong reasons). Crosscheck where a source exists, outcome as backstop. This
is an OPEN design item (§8.8), not silently claimed. "The merge is the
check" holds for pairing, not for values.

**Falsifiable expectation, registered:** IF raman's repeated-command
behaviour was caused by a gate that no correct claim could pass, then after
a redesign under which correct claims can pass, the RAW repeat-count
distribution of raman failure trajectories should shift down (registered as
a distribution shift, not a thresholded class count — per §5.3's own rule;
the retracted F4 inference is NOT this claim's basis, cf.
`f4-retraction-20260820/retraction.md`: what survives is only that the
whitelist could not express a genuine two-free-parameter relationship).
Measure when the redesign runs.

## 7. Structural direction — the harness as commitment device

Probe-before-decide discipline is a scaffold property, not a model property.
One reason is measured in this spec's evidentiary base (instruction alone
under-actuates: the audit prompt ordered hypothesis-testing and models
fabricated instead — reval-adherence F5); three are carried-over
observations, not measurements (no commitment device in a single context;
playbook never asks; timeout economics punish probing). Level 1 teaches the behavior; the durable path is the
harness supplying the commitment device — the revalidator-forces-landings
pattern generalized. §6 IS that pattern for one claim class. Extending it
to further claim classes is future work gated on §8.

## 8. Validation obligations (what makes any of this real)

1. **Second fixture** — the single transfer test standing under: the axis
   criterion (§3), the merge design (§6), lane-B's seam replacement, and
   any level-2 probe. One agreement is not transfer. Highest-leverage next
   spend in both lanes.
2. **Noise robustness** of the R ≤ 3 threshold (probe cases were
   noiseless): synthetic noisy honest claims must not be rejected in bulk.
   Zero-spend extension of the existing probe. **Acceptance rule
   pre-committed NOW, before any verdict exists to protect:** in the
   noiseless probe the separation was total (R = 0 / 6.5e-16 vs 1.5e10) —
   removing or moving the threshold changes nothing, so 3 is a PLACEHOLDER,
   not load-bearing. It becomes a fitted constant the moment noise shrinks
   the gap and someone tunes it to keep verdicts. Rule: the fixed threshold
   survives only if the noisy gap stays ≥ 2 orders of magnitude across the
   sweep; otherwise the check must move to a DERIVED threshold (from the
   fit's own condition number under the delta bound) — never a tuned one.
2a. **Intercept-absorption generality:** the T1 mechanism (a consistent
   identity shift absorbed by the free additive constant) applies to ANY
   family with a free intercept, not just affine-in-u. Every future family
   member with an additive constant inherits the conditioning-check
   requirement automatically.
3. **Oracle set AND bad set** for any mechanism addition (per §1) — the
   frozen family, the conditioning check, and the peak detector each get
   both when implemented. The family's bad set MUST include a fixture whose
   true relationship is provably OUTSIDE {x, 1/x} (e.g. quadratic or log),
   testing that residuals reject a wrong family — the membership was chosen
   downstream of raman's known 1/x relationship, so its generality is
   unproven until an out-of-family rejection is measured.
4. Every level-1 claim goes through the existing candidate/ab machinery —
   no new validation path invented.
5. **Family-addition enforcement:** every family member added later must
   land with a T1-style regression case (its own identity-shift/symmetry
   attack input) in the test suite — enforced by a test that fails when a
   family member lacks one, not by documentation.
6. **Noise-extension pre-registration:** before the §8.2 noise sweep runs,
   its parameters are registered with T-matrix specificity — noise
   distribution and magnitudes, trial count, and "gap" defined as the
   WORST-CASE ratio across the sweep. Absent that registration, the sweep
   does not run.
7. **Score the O4 arm** of `f3-cell-contract-20260820` formally (cells
   exist; script-tally) so §4 G1 can cite a verdict instead of raw cells.
8. **Value-truth mechanism** (§6 scope paragraph): design the
   outside-the-constellation check for invented-(a,b) claims —
   `source_crosscheck` class or loop-level outcome evidence — before any
   arming decision. T6 is its motivating input.
9. **Full-series data path** (implementation): the peak detector needs the
   full numeric series; the audit sample pipeline truncates to head/tail by
   design. First build decision: harness-side raw-fixture read (leak-safe
   resolution, separate from the audit sample) vs a redesigned sample
   format. Named here so the builder does not discover it mid-increment.

## 9. Non-goals

- kkamak/production changes of any kind (lab/prod rule; dogfood evidence
  first).
- Arming the revalidator or building the §6 merge into the shipped gate —
  implementation is its own spec'd increment with its own gos.
- A general answer-leak detector, a domain router, a canonical line list,
  any per-task registry — all named cheating classes.
- Any push to origin without its own go.

## 10. Provenance

Verdicts this spec argues from:
`docs/loop-probes/dnc-length-vs-difficulty-20260820/` (+ addenda 01, 02),
`docs/loop-probes/dnc-merge-fit-20260820/` (+ addendum-01 pre/verdict —
T6 value-fabrication boundary, T10 symmetric-reversal gap, check v2),
`docs/loop-probes/f3-cell-contract-20260820/` (verdict + raw O4 cells,
`out-O4-r*.json`, arm unscored — §8.7),
`docs/loop-probes/reval-adherence-20260819/`,
`docs/loop-probes/f4-retraction-20260820/retraction.md`,
`docs/reboot.md` (loop-1 verdict: prose lesson-following 1/8).
Architect review: `docs/reviews/2026-08-20-dnc-spec-architect-review.md`
(SOUND-WITH-AMENDMENTS; F1–F15 — F1/F2/F13 resolved by addendum-01 +
§6.5/scope/check-v2; F3–F8, F10–F12 resolved by amendment; F9 → §8.9;
F14 → §3 wording; F15 positive).
Cross-lane review: meta-harness-1e (axis criterion, attack construction,
three merge conditions, thrash prediction, per-fixture scope).
