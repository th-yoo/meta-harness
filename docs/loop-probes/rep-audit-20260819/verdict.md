# Representation-audit probe — verdict (2026-08-19)

Scored against `pre-registration.md` (written before any call). Raw outputs:
`out-{haiku,sonnet}-{A,B,C,D}.json` (claude -p, context-free cwd, 8 calls).

## Scores

| input | haiku | sonnet |
|---|---|---|
| A raman (unit trap, real data) | PARTIAL | **PASS** |
| B hangul (script≠language) | PARTIAL | **PASS** |
| C dates (silent coercion) | PASS | **PASS** |
| D control (quiet-on-clean) | FAIL | FAIL (by letter) |

Decision rule (A=PASS, B≥PARTIAL, C≥PARTIAL, D=PASS): **neither model meets
it by letter — both fall on D.**

## Findings

1. **Framing hypothesis CONFIRMED at executing tier.** The same
   sonnet that scored 0/5 on rung-0 raman-value-report IN-TASK produced,
   as auditor: "spacing pattern matches nonlinear behavior of 1/λ
   conversion — col1 derived from evenly-spaced-in-nm CCD pixels, not
   laser-line-subtracted Raman shift", retrieved G≈1580/2D≈2700, and named
   "trusting literal cm⁻¹" as the misreading. Task-framing — making
   convention-identification the ENTIRE task of the call — gates
   retrieval. Not load (rung-0 was zero-load and failed), not capability
   (same model, same day).
2. **Tier gradient.** Haiku A: retrieval fired (0–4000 cm⁻¹ range,
   1580/2680) and detection fired ("47183 unphysical — MAJOR MISMATCH")
   but attribution failed ("GHz? pixels? ~30× scaling"; called x=1649 "the
   G peak"). The failure ladder reproduces inside the audit call, one rung
   higher. Audit lane must run at executing tier.
3. **Hangul (generality proof).** Sonnet: line 1 Japanese "watashi wa
   kankokujin desu", line 2 Mandarin "wǒ shì Hánguórén", script≠language
   named, transliteration-vs-mojibake distinguished, per-line language ID
   (warned against assuming file homogeneity). Haiku: caught line 1 as
   Japanese (mistranslated it), forced line 2 into Japanese particles.
   Regex linters cannot reach any of this — reader-based detection is the
   only general form (user's 와따시와캉꼬꾸진데스/워싀한궈렌 challenge).
4. **Quiet-on-clean unsolved at both tiers** (the pre-registered D bar:
   exact sentence "No representation risks found"). Both models emitted
   risk lists on clean input; haiku invented concerns outright, sonnet
   self-refuted most and flagged currency. Injection-noise cost is real.
5. **POST-HOC observation (not pre-registered — needs its own confirmed
   probe before load-bearing use):** sonnet's CONTENT section alone was
   4/4 correct (mismatch/mismatch/mismatch/"No mismatch found here").
   Gating injection on the CONTENT verdict — inject the audit only when
   CONTENT reports a mismatch — would have produced exactly the right
   behavior on all four inputs. Candidate harness rule for lane A;
   confirm with a pre-registered clean-input batch first.

## Consequences for the attack plan

- Lane A upgrades: "domain cue card" → **convention audit** (input =
  instruction + input-data sample, never tests/; run at executing tier;
  content-gated injection at recency position). The audit output on raman
  contains everything rungs 1–3 need.
- Deterministic linter demoted to fast path for closed-vocabulary
  syntactic ambiguities only (proven non-general by the hangul pair).
- Open engineering items: quiet-on-clean confirmation batch; audit-output
  → prompt-injection format; leak-safety audit trail (store cue text with
  trial).

## Hand-injection pilot 1 (2026-08-19, same day, own go) — FAIL, injection did not actuate

Task `raman-fitting-audit` (term-bench2/probe-tasks/): byte-identical
raman-fitting grading + the sonnet audit output appended verbatim to
instruction.md at recency position, framed "REFERENCE CARD (...; advisory)".
Arm: v1 pin, sonnet-5, k=1, noStore; submitted values captured via 10s
podman-cp watcher (pilot1-submitted-results.json).

Result: reward=0, 39 turns, 874s. Submitted G x0=3745.37 / 2D x0=6327.97 —
raw axis + swapped labels, numerically identical to the banked root-cause
chain. The card supplied retrieval+detection+attribution complete (canonical
1580/2700, "trusting literal cm⁻¹" named, 1/λ conversion) and the agent
shipped raw anyway.

Reading (n=1, no traj): "prose asks, position taxes, hooks enforce" extends
to task-scoped, mechanism-complete, recency-positioned injection. Named
confound: card was ADVISORY-framed — the wording family that actuates is the
additive boundary-gate (b7 10/10). Discriminating next test: same card
re-worded as a before-write ordering gate (pilot 2); if that also fails,
prose injection is dead entirely and lane B (deterministic hook) is the only
survivor.

## Sibling review amendments (2026-08-19, meta-harness-f6 cross-session review; accepted after check)

1. **Rung-0 interpretation narrowed** (same evidence, refined reading —
   flagged per no-reason-drift): the rung-0 instruction ASSERTS the readout
   is the G peak, so retrieved-but-deferring produces the same echo as
   retrieval-absent; no transcripts → indistinguishable. Rung-0 measured
   retrieval ∧ authority-to-contradict, conflated. Retrieval failure
   remains traj-proven at rung 2 (arena autopsies: 0-2 weak canonical
   mentions / 20 trials); the zero-load context-independence claim is the
   confounded part. Pilot-1 weights the binding constraint toward
   actuation/authority once knowledge is supplied.
2. **Pilot-1 bigger confound**: the card is diagnosis-complete but
   prescription-incomplete, and its hedge ("G/2D may sit at different x0
   than textbook values") arguably licenses raw-axis reporting. Pilot-1 is
   three-way ambiguous (card unread / dismissed / hedge-followed);
   submitted numbers exclude only botched-conversion. "Advisory injection
   dead" = overreach; keep the hedged wording.
3. **Process rule**: probe runs that need mechanism evidence store-write
   under a MINTED v1-byte-identical probe version (arena pattern) — never
   --results-file (traj loss, bit twice 2026-08-19), never pinned to real
   v1 (store pollution).
4. **Pilot-2 design**: two arms, one variable each — arm 1 same hedged
   card as before-write ordering gate (framing-only); arm 2 gate +
   prescription sentence, runs only if arm 1 fails. k≥3, store-written.
5. **Clean-batch pre-registration must fix**: D-bar contradicts the audit
   prompt (Q3 demands misreading enumeration; D demands exact silence —
   bar or prompt, pick one); add a BLIND-sample arm (input-A used
   head/PEAK/tail with operator knowledge of peak location; automation
   samples blind).
6. **Lane B minimal pilot re-priced**: existing hook block channel +
   audit-card-as-block-evidence = detector reuse, tests the
   measured-to-actuate enforce channel; pivot target if pilot-2 arm 1
   fails, not a from-scratch build.
