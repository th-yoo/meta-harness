# How to attack raman-fitting — the representation-trap playbook

**Status:** design, evidence-complete; each lane needs its own go.
**Scope:** raman-fitting concretely; the representation-trap task class generally
(convention/unit/encoding mismatches — grader census `term-bench2/leaderboard/grader-classes-20260818.json`).
**Evidence base:** 45+ recorded trials (official anchor 0/5, v1 0/5, v2 0/5, arena
0/25-ish across 7 wordings), full trajectory forensics, external literature survey.
All banked: candidates v9, v11–v17 verdicts; resume 08-18 arena block; HISTORY.

## 1. The target, exactly

Verifier (`~/z2/terminal-bench-2/raman-fitting/tests/test_outputs.py`):
G peak x0=1580.3 (±5), gamma=9.06 (±1), A=8382.69 (±5%), offset (±10%);
2D x0=2670.08 (±5%), gamma=17.52 (±1), A (±5%), offset (±10%).

Data file (`graphene.dat`): two tab-separated columns, **European decimal commas**,
**no header**, x **descending** 47183→1649. X is wavelength-nm; the required
transform is **shift = 1e7/x** (solution's own comment). The transform also
inverts peak ordering (G/2D labels swap under the default reading).

## 2. Root cause chain (each link proven)

1. Agents' Lorentzian fits are **numerically correct in raw-axis space**
   (raw 6328.1 → 1e7/x = 1580.4 ✓; raw 3745.37 → 2670.0 ✓; amplitudes ±1%).
2. They ship raw-axis values → wrong units + swapped labels → fail.
3. Why: the unit trap has **no local strain mark** — unlike the decimal commas
   (which agents DID catch), a bare number column looks fine. Units are only
   detectable against **memory** (graphene G≈1580, 2D≈2670 cm⁻¹ — textbook).
4. The canonical values are almost never **retrieved** (autopsy: 0–2 weak
   mentions in 20 trials; retry/verification clauses never trigger because no
   reference exists in context to mismatch against).
5. One near-miss (G=1593.4 — conversion applied, lost on ±5/±1 precision)
   proves the downstream chain works when retrieval happens (~1/20 base rate)
   AND exposes a **precision residual**: passing likely requires refitting in
   the converted (cm⁻¹) axis, not just transforming fitted parameters.

**Failure ladder:** retrieval → detection → attribution → retry → precision.
All seven arena wordings attacked rungs 2–4. Rung 1 is the bottleneck; rung 5
waits behind it.

## 3. Why prose failed (measured, ours + external)

- Playbook bullets are static mid-prompt prose: position penalty 30–50%
  ("lost in the middle"); attention-trough at execution time ("compliance
  illusion" — form reproduced, substance skipped).
- Additive-vs-restraint asymmetry (SWE-bench-measured, replicated by us):
  agents comply with rules that ADD work at boundaries (b7 ordering-gate,
  10/10) and ignore mid-flow bans (b9, v5-b6, v8-c2, all arena arms).
- Generic wording cannot trigger specific memory: "check canonical values"
  presumes retrieval it never forces. SPARK (external, measured): a brief
  TASK-RELEVANT cue activates latent knowledge where generic rules don't.
- Session law: **prose asks, position taxes, hooks enforce.**

## 4. The attack stack (ordered by expected value)

### Lane A — staging-time retrieval cue (SPARK-style; harness feature)
At task staging, a cheap model call reads **instruction.md only** (never
`tests/` — leak-safe rule below) and emits a *reference card*:

> Domain: Raman spectroscopy of graphene. Quantities to report: peak x0,
> gamma, amplitude, offset. Canonical expectations from world knowledge:
> G peak ≈ 1580 cm⁻¹, 2D ≈ 2670 cm⁻¹; Raman shift axis is cm⁻¹; instrument
> files often store wavelength (nm) or pixel axes — convert (shift = 1/λ_laser
> − 1/λ in cm⁻¹ terms) and FIT IN THE CONVERTED AXIS. European locales use
> decimal commas.

Injected at the **end of the task prompt** (recency position, not mid-system).
This is rung-1 repair at the strongest prompt position, per-task, derived by
machinery — the playbook stays behavior-level (rule 3b intact: no domain
knowledge in bullets; the CARD is task-scoped ephemera, like staging deps).

**Leak-safety (hard rule):** the cue generator may consume the instruction
text and world knowledge ONLY. It must never read `tests/`, `solution/`, or
expected outputs. Cue text is stored with the trial for audit.

**Expected:** retrieval rung fixed outright (reference sits in context before
the first fit); with the fit-in-converted-axis hint, precision rung addressed
too. This is the lane most likely to flip raman 0→3-5/5.

### Lane B — hookRule (deterministic, PreToolUse)
Rule shape: on Write/Edit to the task's declared output file, WARN unless the
transcript contains a prior "canonical check" artifact (a stated reference
range + comparison). Infrastructure already built (hook-rule P0–P4, shadow →
warn → deny ramp, kill-switch). Behavior-level: the hook demands *a check
happened*, knowing nothing about Raman.

**Expected:** forces rung 2–3 mechanically; still depends on the agent
retrieving values to check against — pair with Lane A. Value: generalizes to
every representation-trap task with zero per-task cost.

### Lane C — retrieval-first playbook bullet (last prose move)
> "Before processing data in a named measurement domain, write down from
> memory the canonical ranges for every quantity you will report; then treat
> any derived value outside those ranges as a misread convention: re-derive
> under alternative readings and keep the canonical one."

Boundary-anchored (additive, "before processing"), forces the memory dump as
an artifact. Cheapest to test; ceiling limited by mid-prompt position and the
~2%-at-tier spontaneous-recognition rate. Run only as a pilot (see §5).

### Lane D — precision residual (rides any lane that fixes retrieval)
The cue/bullet must say **fit in the converted axis** (gamma ±1 and x0 ±5 are
tight; transforming raw-fit parameters through 1e7/x distorts widths). This is
knowledge, not discipline — Lane A carries it naturally.

## 5. Test protocol (arena lessons encoded)

0. **Pilot on the ablation ladder first** (term-bench2/probe-tasks/,
   installed into tbRoot via `term-bench2/probe-tasks/install.sh`; splits
   `raman-value.txt` / `raman-min.txt` / `raman-ladder.txt`). All rungs share
   the identical trap — value in wavelength-nm, no axis label, instruction
   silent on units, canonical G≈1580 cm⁻¹ retrievable only from memory — and
   the identical verifier bar (x0 = 1580.3 ±5; the nm readout fails by
   construction):

   | rung | task | above the trap | isolates |
   |---|---|---|---|
   | 0 | `raman-value-report` | nothing — readout stated inline in the instruction | pure retrieval, zero load |
   | 1 | `raman-peak-report` | headerless file + argmax (no fitting, single peak, dot decimals, ascending x) | retrieval under trivial processing |
   | 2 | `raman-fitting` | full load: Lorentzian fits, 2 peaks + label swap, decimal commas, descending x, precision residual | retrieval under real load |

   Readings: fail at rung 0 ⇒ retrieval failure is fully context-independent
   (a lane must inject the reference; no discipline wording can work). Pass
   at 0 + fail at 1 ⇒ even trivial processing displaces retrieval (attention
   story). Pass at 0+1 + fail at 2 ⇒ load interaction, and lane pilots must
   run on rung 2 to mean anything. Oracle: rung 1 PASS 10.1s (2026-08-19),
   rung 0 PASS same day. Rungs 0/1 are probe instruments, never
   leaderboard-comparable.
1. **Pilot 1 trial per lane before any k=5** (arena error: 5-trial arms with
   no mechanism pilot). Autopsy the pilot for rung-firing before spending.
2. Autopsy hygiene: grep **text events only** — tool outputs are data dumps
   that substring-match anything (round-1 retraction).
3. Success bars: raman ≥2/5 = mechanism actuates; ≥4/5 = task solved at tier.
   Any pass must show the mechanism in-traj (cue consulted / hook fired /
   memory dump written), else it's luck, not validation.
4. Baselines already banked — never re-run: anchor 0/5, v1 0/5, v2 0/5,
   arena 0/25. Any lift is unambiguous.
5. Generalization probe (after raman moves): the census's other convention-
   trap candidates (gcode-to-text dialects, extract-elf endianness,
   feal ciphertext formats) — same lanes, no raman-specific content.

## 6. What NOT to do (banked negative results)

- More prose wording variants of check/verify/retry WITHOUT forced retrieval
  — 7 wordings, 35 trials, all zero.
- Retry clauses alone — nothing to trigger on when retrieval never happened.
- Single-wording k=5 arms without a pilot — underpowered against a ~2% base
  rate and 76-point wording fragility (Sclar).
- Trusting the file's self-description or its visible conventions to reveal
  unit traps — units have no local strain marks.
- Substring-grep trajectory autopsies.

## 7. Ownership map

| lane | code touched | gate |
|---|---|---|
| A cue card | staging (cmd-run/staging.ts) + cue generator + audit trail | needs design review + go (harness change) |
| B hookRule | none (propose a hookRule bullet; infra live) | review gate + shadow ramp |
| C bullet | playbook mint (v18+) | review gate |
| D hint | rides A's card text | — |
