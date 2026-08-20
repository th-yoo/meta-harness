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
is global by nature (one shared transform) — and is routed to §6 instead.
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
  split; a declared rung is a claimant-controlled statistic (F3/O4:
  announcing a check moves the failure). Behavior is taught; only outcomes
  are measured.
- G2 — triggers are OBSERVED failure signatures, never task-shape
  vocabulary (v18 b7 was a lexical trigger; "task has many parts" would
  misfire identically).
- G3 — expected under-actuation (prose lesson-following measured 1/8); a
  null ab result is informative about level 2, not a defect in the trial.

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
4. **Constellation conditioning check — REQUIRED, measured necessary.** The
   global identity-shift attack passes the plain over-determined gate with
   rms = 0 on an equal-spaced constellation (the affine family absorbs the
   shift into the intercept); redundancy alone does not defeat it. Check:
   shift-degeneracy ratio R = min(RMS under ±1-index shift)/RMS(claimed);
   R ≤ 3 or n < 3 → reject. Measured: kills the attack, accepts
   irregular-honest at R = 1.5e10, and refuses honest claims on degenerate
   geometry — fail-closed on purpose: degenerate constellations are
   UNCHECKABLE, not wrong; no inject, never a pass. T1 of the probe is the
   standing regression input for any implementation.

**Falsifiable expectation, registered:** raman's minimal-thrash class is
plausibly caused by the shipped gate's inability to accept a correct answer
(F4: right physics, inexpressible). Post-redesign, raman minimal-thrash
count should DROP. Measure it when the redesign runs.

## 7. Structural direction — the harness as commitment device

Probe-before-decide discipline is a scaffold property, not a model property
(4 measured reasons: no commitment device in a single context; playbook
never asks; timeout economics punish probing; instruction alone
under-actuates — the audit prompt ordered hypothesis-testing and models
fabricated instead). Level 1 teaches the behavior; the durable path is the
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
   both when implemented.
4. Every level-1 claim goes through the existing candidate/ab machinery —
   no new validation path invented.

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
`docs/loop-probes/dnc-merge-fit-20260820/`,
`docs/loop-probes/f3-cell-contract-20260820/`,
`docs/loop-probes/reval-adherence-20260819/`,
`docs/loop-probes/f4-retraction-20260820/retraction.md`.
Cross-lane review: meta-harness-1e (axis criterion, attack construction,
three merge conditions, thrash prediction, per-fixture scope).
