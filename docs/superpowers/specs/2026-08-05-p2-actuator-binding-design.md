# P2 actuator-binding probe — design (2026-08-05)

**Status:** DRAFT — spec go granted 2026-08-05 ("go both"), fulfilling
the probe-program §4 contract (spec 2026-08-05-loop-fix-probe-program-
design.md). Bench spend gated on its own sized go with exact call
counts; nothing here authorizes spend.

**Question:** loop-1's actuator was a prose bullet, ignored 7/8 runs —
proposals never became behavior. Per delivery MECHANISM, what fraction of
runs does an injected rule actually change behavior, and at what
side-effect cost? Output = a routing evidence table (which mechanism can
carry which rule class), not an adoption.

## 1. Rulings (closed 2026-08-05, brainstorm Q&A)

1. **Band: (c) both** — TB2 haiku band carries the verdict; live shadow
   is a PASSIVE read of the review-sensor stream (companion spec
   2026-08-05-review-sensor-synthesis-design.md) over the P2 window,
   boundary-stamped, descriptive only, moves no bar. No live arm
   assignment; no live enforcement deploys pre-verdict.
2. **A3 and A4 are built as bench-harness pieces** (arm substance), not
   live plugin features. Live deployment of any winner is a separate
   post-verdict adoption ruling.

## 2. Arms — same rule content, three carriers

Band: the loop-1 TB2 haiku band (14 tasks; band list frozen in
`term-bench2` splits at spec time of loop-1), model claude-haiku-4-5
(TB2 baseline rule: baseline/candidate/production share the model),
k = 2 repeats per task per arm.

- **A1 prose bullet** (control; exists): the rule as a harness-slot
  bullet (`/app/CLAUDE.md`, minimal/ kernel mechanism, sha256'd).
  Measured prior: 7/8 ignored (loop-1, opus tier — tier difference
  declared; this run re-baselines on haiku).
- **A3 binding middleware** (build): the rule enforced mechanically at a
  container chokepoint. NOT CC hooks — the TB2 claude-code driver is a
  one-shot `claude -p` batch process with no settings.json/hook
  injection (round-1 review finding 11; only CLAUDE.md is copied in),
  and whether -p mode fires hooks at all is unverified. A3's mechanism
  is therefore a CONTAINER-LEVEL SHIM: a wrapper on the command(s) the
  rule governs, placed on the container PATH, enforcing the check at
  action time (block or transform + explain on stderr). If plan-time
  verification shows -p mode does fire Stop/PreToolUse hooks, a hook
  chokepoint may be substituted — recorded as a plan decision, same
  contract (mechanical, cannot be ignored).
- **A4 review-actuator** (build): after the task attempt, one scoped
  haiku review pass against the rule; findings reinjected as
  required-edit instructions; ONE bounded re-pass, **turn cap 10**
  (pre-registered here; the ≤112-execution sizing in §6 assumes it).
  Binding post-hoc.

## 3. Rule under test

ONE behavior-level rule (proposer rule 3b compliant — general-SWE
behavior, no domain knowledge), chosen for mechanical detectability.
**Freeze point: the exact rule text + grep pattern + A3 check are frozen
at PLAN completion, before any run** — the pre-data boundary is the
first run datum, consistent with program-wide amendment discipline; this
spec fixes the selection CRITERIA, the plan fixes the text. Candidate:
loop-1's ignored lesson rule, reused for continuity with the 7/8
baseline. The rule MUST admit:

- a transcript/diff grep pattern (A1/A4 compliance detection), and
- a mechanical check (A3 enforcement),

both pre-registered alongside the rule text. If the loop-1 rule cannot
satisfy both, a replacement is chosen and the baseline-continuity claim
is dropped (recorded, not fudged).

## 4. Mechanical detection + outcomes (pre-registered)

Per run, zero human judgment:

- **compliance(run)** — A1/A4: transcript+diff grep for the rule's
  declared marker; A3: enforcement-check exit code (compliance = 1 by
  construction; recorded for the instrument, not compared).
- **pass@k(arm)** — TB2 oracle, per task, k=2 (rate family).
- **cost(arm)** — turns, durationMs, and for A4 the re-pass count.

Outcome metrics:

- compliance(A1) vs compliance(A4): the binding comparison.
- pass@k(A3) vs pass@k(A1), and cost(A3) vs cost(A1): A3's side-effect
  read (does enforcement hurt task completion?).
- b2-shadow: the live review-sensor stream over the P2 window, reported
  descriptively (no bar weight).

## 5. Decision rule (pre-registered; user may amend pre-data)

- A mechanism **earns routing** iff compliance ≥ 0.75 (≥ 21/28 runs)
  AND pass@k does not drop more than 0.15 absolute vs A1.
- A1 re-baseline: reported as the measured prose-binding rate on haiku;
  no bar (it is the control).
- "Earns routing" buys: eligibility as a carrier in a future
  proposer→actuator routing design. It deploys nothing; adoption of any
  mechanism into live sessions or the TB2 production loop is a separate
  user ruling.
- A3 and A4 BOTH failing their bars is itself the finding (A1 is the
  control and carries no bar): actuation remains the loop's open
  defect; recorded, program does not silently retry.

## 6. Sized go (computed, granted separately)

- Container runs: 3 arms × 14 tasks × k=2 = **84 runs**.
- Embedded model calls beyond the runs themselves: A4 adds ≤ 1 review
  call + ≤ 1 re-pass per run. Re-passes are ADDITIONAL bounded
  executions on top of the 84: worst case +28 → total ≤ 112 container
  executions, plus ≤ 28 review calls.
- All haiku. Wall estimate 4–6 hrs tmux (loop-1 precedent: 62 trials ≈
  3 hrs). Exact call-count table re-stated at plan completion; the go is
  granted against THAT table, not this estimate.

## 7. Boundaries

- F2: committed artifacts carry counts/stats/task-ids — never transcript
  or finding text.
- **Store isolation (round-1 review finding 12):** every probe run uses
  `--results-file` (which forces noStore — the documented gotcha is the
  guarantee here): P2 results land under `docs/loop-probes/p2/`, and
  NOTHING writes `term-bench2/store/**`. An arm invocation without
  `--results-file` is a protocol violation, checked by the run script
  before dispatch.
- Bench-only: nothing in P2 touches live plugin behavior; the live
  shadow is read-only.
- No pooling: P2's haiku compliance numbers never pool with loop-1's
  opus 7/8 (different tier, different rule-delivery details); the
  comparison is narrative, flagged as cross-tier.
- Build order: review-sensor (companion spec) ships first (shadow needs
  it); A3/A4 harness pieces built under plan; bench spend LAST, under
  the sized go.
