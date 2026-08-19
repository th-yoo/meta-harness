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

## Pilot 2 arm 1 (2026-08-19) — 0/3 BUT autopsy overturns the framing: gate ACTUATED, card CONTENT failed

raman-fitting-gate (same audit body byte-identical, reframed as mandatory
before-write ordering gate), k=3, store-written under minted v18 →
trajectories recovered. All three trials reward=0, submitted values
identical to pilot-1 (G=3745.37/2D=6327.9, raw+swapped).

Traj autopsy (text events): all three agents READ the gate, EXECUTED its
steps, TESTED the audit's claims, and REJECTED them with stated reasons:
 - T1: "no peak exists near 1580/2700" — checked in the RAW axis (true
   there); location-unbiased peak search instead.
 - T2: tested the audit's proposed laser-line-subtraction transform,
   found it "physically impossible for the stated range", rejected. The
   card's attribution WAS wrong — 1e7/x appears 0 times in all 3 trajs
   because the card never contained it.
 - T3: classified the gate as a "textbook prompt-injection pattern" and
   treated resisting it as correct security behavior.

FINDINGS (each new):
 1. Gate framing ACTUATES (b7 law intact) — pilot-1 ambiguity resolves to
    read-and-reasoned-rejection, not non-compliance.
 2. Wrong prescription < no prescription: the card's incorrect
    laser-subtraction hedge was empirically falsified by the agent, which
    discredited the whole card (sibling Q2 confirmed hard).
 3. Self-sealing check: "verify canonical values" performed in the raw
    axis confirms the raw reading. A check without the transform is
    circular.
 4. NEW WALL: mandatory-framed mid-prompt directives trigger the model's
    prompt-injection defenses (T3 explicit).
 5. The actuator is the agent's EMPIRICISM: agents test what the card
    proposes. Arm-2 design therefore: correct transform framed as a
    falsifiable prediction ("test shift=1e7/x; both peaks should land at
    G≈1580 and 2D≈2670 simultaneously"), non-mandatory tone, plus the
    preemption "in the raw axis you will find peaks near 3745/6328".
    Testing it succeeds spectacularly (both peaks land on canonical
    values at once) — confirmation, not conflict.

Lane A consequence: audit ATTRIBUTION quality is now load-bearing (a wrong
transform poisons the card), which retro-justifies the clean-batch
finding that blind sampling degrades attribution → sampler must ship
distribution stats. Chain: sample-with-stats → audit → content-gate →
falsifiable-prediction card → agent's own empiricism closes the loop.

## Sibling review round 2 (accepted) + arm-2 pre-registration

Sibling pokes, accepted:
 1. **Generator gap = the real lane-A hole.** Arm-2's card content
    (1e7/x, raw positions, joint landing) is hand-authored; the automated
    auditor never produced it. Lane-A viability probe = give the auditor
    compute + instruction to numerically test its hypotheses against the
    sample before writing the card; pass iff it derives the 1e7/x
    prediction itself. Arm-2 cannot prove lane A regardless of outcome.
 2. **Arm-2 scope = CHANNEL-CEILING probe** (prediction is
    solution-adjacent: 1e7/3745.37=2669.96, 1e7/6327.97=1580.29 — exact;
    the transform IS the label swap, preemption sentence load-bearing).
    Mild scope note kept: after arm-1, "correct recipe survives agent
    empiricism + injection defense" was genuinely in doubt (T3 rejected a
    card containing the textbook values), so a pass is informative, not
    trivial. But it is NOT lane-A viability.
 3. **Three variables move together** (correct content, prediction
    framing, non-mandatory tone) — named here per pre-reg discipline. A
    PASS is package-level, unattributable among the three; production
    ships the package whole, acceptable. If FAIL: decomposition arm =
    correct-content-with-mandatory-tone first.
 4. Leak-safety item gains a line: coercive injected wording
    pattern-matches to prompt-injection attack (arm-1 T3) — cost scales
    with coerciveness; credibility, not force, is the lever.

**Arm-2 pre-registration (before any call):** task raman-fitting-predict =
raman-fitting-gate with the card's MISREADINGS hedge replaced by a
falsifiable-prediction block (non-mandatory tone): candidate transform
shift=1e7/x; prediction that raw peaks ≈3745.4 and ≈6328.0 are the 2D and
G peaks and land at ≈2670 and ≈1580 simultaneously under the transform;
invitation to test and keep whichever reading survives. Gate steps stay.
k=3, sonnet, pinned v18, store-written. Success bar: ≥2/3 reward=1 =
channel ceiling confirmed; 0-1/3 with trajs showing the prediction tested
and confirmed but output still raw = actuation wall below content (would
be a new finding); trajs showing prediction untested = framing regression.

## Amendment: generator-first sequencing (sibling proposal, adopted before go)

Order: generator probe FIRST (headless). If the auditor derives the 1e7/x
prediction itself, arm-2 runs with the GENERATED card verbatim
(unmodified — any hand edit voids the end-to-end claim) and an arm-2 pass
becomes load-bearing for lane A END-TO-END (sampler → audit → gate → card
→ agent). If the generator fails, arm-2 runs the hand-authored card as
fallback (channel-ceiling datum salvaged; generator gap stays open).

**Generator probe pre-registration:** prompt = audit-prompt-v2 + compute
clause ("you may run calculations; numerically TEST each hypothesis
against the sample before writing the card; state which hypotheses
survived testing"). Input = production-shaped BLIND sample: instruction.md
+ head-20/tail-20 rows + mechanical distribution-stats block (row count,
min/max both columns, row-spacing at head/middle/tail) — no peak-region
rows, no operator knowledge. Tools: Bash allowed (arithmetic on given
numbers only; no task paths provided). 2 calls, sonnet. PASS iff ≥1 call's
card contains the reciprocal transform (1e7/x or 1/λ-with-scale) AND the
joint canonical landing prediction. Partial (transform named, no joint
prediction) = run arm-2 with generated card anyway, scope note attached.

**Arm-2 fixture deviation (noted pre-results):** the pre-reg said "MISREADINGS
hedge replaced"; the built card (raman-fitting-predict) keeps only the
audit's SURFACE section verbatim and replaces sections 2 AND 3 with the
prediction block — section 2 also carried the falsified laser-subtraction
hedge, and leaving falsified content beside the correct prediction would
re-poison the card (arm-1 finding 2). Deviation banked before any trial
completed. Also: user chose PARALLEL over generator-first — arm-2 runs the
hand-authored card (channel-ceiling scope); a generated-card arm-2 remains
available as a follow-up if the generator passes.

## Arm-2 verdict (2026-08-19) — 2/3 PASS, CHANNEL CEILING CONFIRMED · REPRESENTATION TRAP SOLVED 3/3

raman-fitting-predict k=3 under v18 (hand-authored falsifiable-prediction
card): rewards 1,1,0. Passes: G=1580.33/2D=2670.10 and G=1580.31/2D=2670.09.
Trial-3 traj: mechanism executed PERFECTLY (located raw peaks 6329.4/3745.1,
applied 1e7/x, verified joint landing "right on top of canonical", refit in
converted axis, x0=1580.34/2670.11) — failed the verifier on 2D gamma 18.55
vs 17.52 (±1 bar, missed by 0.03) and offset. Ordinary fit-quality
residual; the representation trap itself was solved in all three trials.

Elapsed signature inverted: passes 76-104s vs historical fails 360-880s —
solving the right problem is FAST (consistent with crank-1's slow-fail
churn finding).

Pre-registered bar (≥2/3) MET: a correct transform framed as a falsifiable
prediction, delivered through a soft ordering gate, survives agent
empiricism + injection defense and flips raman 0/48+ lifetime → 2/3
(mechanism 3/3). Scope: CHANNEL CEILING (hand-authored card). Lane A
end-to-end still gated on the generator (0/2, sampler-evidence bottleneck —
see generator/verdict.md).

Attack-stack state after today: retrieval(audit)✓ gate(content-verdict)✓
channel(prediction card)✓ generator(sampler iter-2)✗ ← the one open link.

## Sibling round-3 notes (accepted verbatim)

1. Headline number = TRAP 3/3, verifier 2/3 — keep separated downstream;
   the residual is fitting precision, a different failure class from the
   entire banked raman chain.
2. Elapsed signature (pass 76-104s vs fail 360-880s) replicates crank-1's
   within-arm churn proof (63-86s vs 551-772s) in an independent context:
   elapsed-per-pair confirmed again as the cheapest mechanism probe.
3. Generator 0/2 stays FAIL by the letter; "observationally equivalent
   given the sample" is a diagnosis, not a re-score. Iter-2 = NEW
   pre-registered probe, never a retry of this one.
4. Iter-2 sampler is leak-safe (mechanical local-maxima from the raw file;
   conversion + attribution remain the auditor's work).

## Generator iter-2 — pre-registration (turnkey, awaiting go)

Sampler change ONLY: the blind sample gains a DETERMINISTIC peak-finder
block with output format fixed HERE, before any run — after replacing
commas and sorting ascending by col1: smooth col2 with a 21-point moving
average, list every local maximum with prominence > 3× the median absolute
deviation of col2, as lines `peak: x=<col1 at max, 3dp> y_smoothed=<1dp>
prominence=<1dp>`, capped at 10 peaks by prominence. No other sample or
prompt change (generator-prompt.txt byte-identical). 2 calls, sonnet.
PASS bar unchanged: card contains reciprocal transform + joint canonical
landing. A pass feeds the generated card VERBATIM into bench k=3
(raman-fitting-gen task) under v18 — that run passing at ≥2/3 = lane A
proven end-to-end.

**Iter-2 pre-call note (before any generator call):** the pre-registered
deterministic peak-finder emits 3 peaks (x=18858.0, x=3745.1, x=10421.4);
the G-raw peak (≈6328) is ABSENT — the fixed 21-pt window over-smooths it
at local row spacing. Per the determinism clause this is NOT tuned away;
run proceeds as-is. Noted: the reciprocal reading remains derivable
(1e7/3745.05=2670.2 = 2D canonical) and a strong card could PREDICT the
G peak at raw ≈6329 as an agent-verifiable consequence.

## Generator iter-2 verdict (2026-08-19) — 0/2; the decisive arithmetic never ran

Both calls computed hard and missed: r1 fell into a coincidence trap
(artifact peak 10421/10 = 1042.1 "matches" Si 2nd-order to 0.07% — the
synthetic file's accident) and ruled out the nm reading via a botched
check; r2 matched the mega-peak to a 532nm laser line (0.3%), computed
laser-corrected G/2D targets, found nothing, declared "unresolved". Neither
ever computed 1e7/3745.05 = 2670.2 — the mechanically-found second peak's
reciprocal, sitting on the 2D canonical.

Pattern across all 4 generator calls (iter-1+2): the DOMINANT peak anchors
the hypothesis; the laser-line story explains it well and absorbs the rest
of the reasoning; secondary peaks never get the transform test. Structural
note: the task's encoding is UNPHYSICAL (shift = 1e7/x directly implies a
laser at infinite wavenumber), so a physically-competent auditor is biased
AGAINST the true reading — raman is plausibly the generator's adversarial
worst case, not its representative case.

Iter-3 options (each its own go): (a) transform-table instruction — "for
each candidate transform compute where EVERY listed peak lands; tabulate
against canonical lines; the reading landing multiple peaks simultaneously
wins" (generic, leak-free, forces the missing arithmetic); (b) pivot to
census generalization — test the generator on convention traps where
physics agrees with the truth (gcode dialects, endianness, feal).

## Sibling round-4 (accepted) — iter-3a′ pre-registration (turnkey, awaiting go)

Sibling ran the transform table on the fixed peak list independently:
reciprocal lands 3745.1→2670.20 (exact 2D), 10421.4→959.6 (Si 2nd-order),
18858→530.3 (Si 1st-order, loose); laser story lands the dominant peak and
nothing else. Evidence as sampled already discriminates — the failure is
purely that secondaries never got the reciprocal test. Challenges
accepted: (1) dominant-peak anchoring is domain-general, will follow to
the census — "unphysical worst case" must not excuse it; (2) the
peak-finder has an OBJECTIVE bug (fixed 21-row window on an axis with
~2000× spacing variation), fixable independently of raman.

**Iter-3a′ pre-reg:** sampler change only, prompt byte-identical (third
time). Corrected deterministic peak-finder, fixed before run: normalize
commas, sort ascending by col1, linear-interpolate col2 onto a uniform
grid from min(col1) to max(col1) with step = MEDIAN of the file's own
successive |dx| (data-derived, no new constant); then the inherited
pipeline unchanged (21-pt moving average, local maxima, prominence > 3×
MAD of the resampled col2, top 10 by prominence, same line format, x
reported at the grid position of the maximum). 2 calls, sonnet. PASS bar
unchanged (reciprocal transform + joint canonical landing in the card).
If FAIL → step 2 adds the transform-table instruction (single variable).
Census probe (3b) runs afterwards regardless of outcome — generality is
its question, not raman's. STATED DEPENDENCE: the joint-landing table
discriminates only if the auditor brings graphene-on-Si canonical lines
(G/2D/Si 1st/2nd order) from world knowledge — sonnet has them; census
domains may not share this property.

**Iter-3a′ pre-call note:** the corrected deterministic finder emits 2
peaks (19139.4, 3745.3); G-raw still misses the inherited 3×MAD bar by a
hair (the file's clipped plateau inflates MAD of the resampled signal).
Determinism clause: run as-is. Evidence nonetheless sharpened: 19139.4 →
522.5 ≈ Si 1st-order 520.7 (0.35%) while NO standard laser line fits it
(514.5nm→19436, 532nm→18797); reciprocal lands both peaks on canonical
lines, laser lands zero.

**Iter-3a′ verdict: 0/2.** Both calls anchored again; r2 wrote "no
scale/laser-line conversion tested reproduces sane G/2D positions from the
two detected peaks" with 1e7/3745.3=2670.2 unrun. Six generator calls
total, the decisive arithmetic never executed. Evidence-alone hypothesis
DEAD (sibling's optimistic branch refuted; anchoring diagnosis stands).
Step 2 per pre-registered sequence: transform-table instruction
(generator-prompt-v2.txt — generic anti-anchoring decision procedure:
enumerate standard transform families incl. reciprocal, evaluate every
peak under every transform, multi-peak joint landing wins, show the
table). Sample stays v3. Single variable.

## Generator step-2 verdict (2026-08-19) — PASS (1/2, bar ≥1): r2 derived the reciprocal with the full table

r1 FAIL, instructive: executed the table faithfully but fit every
transform constant by anchoring the DOMINANT peak to a graphene line —
anchoring recursed into the procedure's free parameter; never tried the
natural constant or the secondary-peak anchor (k = 2670.1×3745.34 =
1.0000e7 unrun). Canonical set G/D/2D only (no Si).

r2 PASS, exceeding the bar: derived x=1e7/shift via THREE independent
arguments (range; spacing-collapse matching d(1/x); Δshift-uniformity
under the transform — a structural proof no prior call or audit found),
tabulated fixed candidate families, reciprocal row lands P1→522.5 (Si
520.7 — Si brought in from its own world knowledge) and P2→2670.0 (2D)
simultaneously with all rivals falsified, and PREDICTS G at x=6329.1 and
D at 7407.4 as verifiable consequences, explaining Si's prominence
dominance. out-gen4-r2.json = the generated card.

NEXT (pre-registered consequence, own spend go): raman-fitting-gen =
soft-gate wrapper + gen4-r2 audit VERBATIM, bench k=3 under v18; ≥2/3 =
lane A proven END-TO-END.

## Sibling round-5 (accepted) — arm-3 scope asterisk + propose-verify split

1. Arm-3 scope: card was OPERATOR-SELECTED from a 1/2 field; a pass proves
   the chain END-TO-END MODULO CARD SELECTION. Summary wording bound to
   this form.
2. "Failing card = no injection" RETRACTED: gen4-r1 failed CONFIDENT
   (anchored constants, wrong attributions) — a CONTENT-gate alone would
   inject it (false-attribution, the arm-1 poison). Production injection
   gate = CONTENT verdict ∧ MECHANICAL REVALIDATION (propose-verify
   split): harness deterministically recomputes the card's winning row —
   apply the claimed transform to the mechanical peaks, check the claimed
   landings within the claimed Δ, require ONE FIXED constant landing ≥2
   peaks. Verified: passes gen4-r2 (k=1e7 lands both), rejects gen4-r1 by
   construction (per-peak fitted constants never jointly land). This is
   the production card-selection rule that closes the asterisk in (1).
3. Card risk ranking: Δ-30 on 2D canonical = minor (agents report fits
   not priors, card self-discloses). Live risk = D-band prediction at
   x=7407.4 — likely absent in the synthetic file; arm-1 proved one
   falsified claim can sink a card. Verbatim clause stands; trajs to be
   read for the D reaction. Evidence-alone branch formally conceded
   refuted by its author.

## Arm-3 verdict (2026-08-19) — verifier 1/3, BAR MISSED · trap solved 3/3 · residual = precision rung only

raman-fitting-gen (generated card verbatim) k=3 under v18: rewards 0,1,0.
ALL THREE trials converted and landed x0 dead-on (1580.33-35 /
2670.09-2.15); fails were 2D offset 26%/38% past the ±10% bar (+2D gamma
0.34 past ±1 in trial 1) — baseline-window fit residual, zero
representation content. Trial-3 traj: agent verified the card
independently ("confirmed against known Si 300.8/522.5/971.8 and graphene
lines... not by trusting the injected audit outright"), found EXTRA Si
lines, D-band prediction caused no discredit (round-5 watch item CLEARED).
Trial-3 wrote 7/8 bars passing; watcher captured trial-2's file, truth
recovered from the traj Write event.

BY THE LETTER: lane A end-to-end (modulo card selection) NOT proven — 1/3
< 2/3. DEMONSTRATED: the full machine chain (mechanical sampler →
prompted auditor → generated card → agent) cracks the representation trap
3/3. The binding constraint across arms 2+3 is now wholly the precision
rung (2D offset/gamma): 3 of 6 card-armed trials fail there and nowhere
else. Content note (unattributable at n=3 vs n=3): the hand card carried
"fit in the converted axis for accurate widths"; the generated card has
no baseline/width prescription.

Options from here (each own go): (a) arm-3b — generator prompt gains a
generic "state fitting-practice implications (baseline, windowing) of the
identified convention" clause → regenerate → rerun (attacks the precision
rung through the same machine chain); (b) accept raman as
representation-cracked, bank, pivot to census generality + production
build (propose-verify gate, sampler, staging integration); (c) park.
