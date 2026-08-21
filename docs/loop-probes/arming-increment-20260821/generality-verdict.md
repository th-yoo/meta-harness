# Generality verdict: the method compressed, the artifact did not (2026-08-21)

Zero-spend measurements against CLAUDE.md §1's binding test — *does this transfer
to a task we have never seen?* Reproduce with the three probe scripts in this
directory.

## 1. The gate engages on ONE task in the corpus

`gate-engagement-census.py` over all 99 real `terminal-bench-2` task trees,
applying the plan's own structural criteria in order:

| stage | tasks |
|---|---|
| has `environment/` | 99 |
| resolvable COPY manifest | 97 |
| **exactly one numeric series** | **6** |
| ≥3 scale-persistent anchors | 5 |

**All six are raman variants reading the same `graphene.dat`** — and **five of
the six are probe tasks we authored ourselves** (`raman-fitting-audit`,
`-gate`, `-gen`, `-predict`, `raman-peak-report`). **91 of 99 tasks have no
two-column numeric series at all.**

**Denominator, stated so no friendlier one can be reconstructed:** tasks we wrote
are evidence about our own habits, never about the benchmark's population. They
are excluded from the headline and quoted only in the side column. Of genuine
benchmark tasks the count is **one: `raman-fitting`** — i.e. `1/99`, and the
`6/99` figure is an artifact of our own probe tasks inflating it 6×.

**This is the 1:1 tell, stated against our own rule.** CLAUDE.md: *"if additions
grow 1:1 with incidents … no compression happened and no induction happened."*
The divide/merge pipeline requires an artifact shape — a 2-column numeric series
— that exists in one task. The §6 design was always *routed* for the raman
instance, and the generality was supposed to be carried by the over-determined-fit
PRINCIPLE rather than by this pipeline. The principle may well be general; **the
implementation as built is a spectroscopy-fitting gate.**

What this does NOT license: adding a second artifact-shape reader because a
second task needs one. That is registry growth by incident. If the pipeline is to
generalise, the divide step has to be re-derived from a property more tasks have
than "ships a .dat file".

## 2. §8.2(b)'s constant was a proxy, and the proxy was wrong

Cross-lane pre-registered falsifier (`v7-verdict-breakdown.py`), prediction
recorded **before** the run: if the noise domain is really about ALTERNATE
DISTINGUISHABILITY rather than the claim's own fit, V7's false rejects must be
`reject-degenerate`, not `reject-residual`.

| sigma | honest verdicts / 200 | false-reject breakdown |
|---|---|---|
| 0.1 / 0.5 / 1.0% | accept 200 | — |
| 2.0% | accept 190, reject-degenerate 10 | **degenerate 100%** |
| 5.0% | accept 18, reject-degenerate 182 | **degenerate 100%** |

**192/192 degenerate, zero residual. Mechanism confirmed.** The bound never
measured what it appeared to measure.

### The derived replacement

`derived-domain-predicate.py`: for each alternate pairing (derived automorphisms
+ the fixed ±1 shift), fit the alternate pairing of the anchors against
themselves and require `Σ(r_i/σ_u_i)² > chi2(REG_LEVEL, dof)`.

| case | span-ratio bound | derived predicate |
|---|---|---|
| graphene `u=x` | 0.105 → **OUT** | alt X² 86.5 vs q 36.3 → **CHECKABLE** |
| graphene `u=1/x` | 0.150 → **OUT** | alt X² 1626 vs q 36.3 → **CHECKABLE** |
| fixture-2 `u=x` | 0.0007 → IN | alt X² 15887 vs q 16.5 → CHECKABLE |
| V7 ir @1% | IN | 115.0 vs 14.1 → CHECKABLE |
| V7 ir @2% | OUT | 28.8 vs 14.1 → CHECKABLE (thin margin) |
| V7 ir @5% | OUT | 4.6 vs 14.1 → **UNCHECKABLE** |

The derived predicate reproduces the measured curve where the constant did not:
it stays checkable through 2% (measured false-reject 10/200 = 5%) and flips at 5%
(measured 182/200 = 91%), and its margin degrades smoothly with the measured
rate instead of stepping at an arbitrary 0.01.

**What made this legitimate was the DISCIPLINE, not the arithmetic.** The
derivation was incident-born — it started from graphene failing a bound — which
is the exact provenance this project treats as the fitting smell. It is
acceptable here only because of how it was run: the **kill condition was
registered before the run** (`residual-dominant ⇒ mechanism refuted, aggregator
question returns`), the evidence was **V7's synthetic sweep with graphene held
OUT of the validation set**, and graphene was then used as a **prediction** the
mechanism had to get right. The same arithmetic with graphene inside the oracle
set would have been cheating — identical numbers, identical conclusion, no
validity. Incident-triggered discovery with structure-validated response is
legitimate; incident-triggered discovery with incident-fitted validation is the
F4 pattern.

**Three wins, and they are compression, not addition:**
1. `VALIDATED_SIGMA_FRACTION` is **deleted** — replaced by a quantity computed
   from the constellation plus the already-registered `REG_LEVEL`. One fewer
   constant, no new knob.
2. The max-vs-median **aggregator question dissolves** — each anchor carries its
   own σ, so heteroscedasticity is handled by construction rather than by
   choosing a statistic.
3. V7's measured curve becomes **validation evidence FOR** the domain predicate
   instead of the source of a proxy bound.

### Consequence: the raman narrative re-inverts, now measured

Graphene is checkable after all. So `NO-SOURCE` becomes the binding reason raman
stays criteria-class — which is what the plan originally asserted, but it was
asserted, and the intervening measurement showed the asserted reason was not the
operative one. It is now measured in both directions.

**The heteroscedastic fixture stays blocking**, with a stronger job: it now tests
the DERIVED predicate directly rather than adjudicating an aggregator choice.

## 3. What actually generalised

Four scope defects found across three review rounds plus one probe, compressing
into **one** mechanism:

| instance | what supplied the check's scope |
|---|---|
| literal checker's value set | the claimant (`FAMILY: none` empties it) |
| sweep bounds | the sweep's own author |
| plateau reference battery | the parameter under test |
| §8.2(b)'s validation | a reference that never implemented the clause |

**One mechanism: the predicate was sound every time; the DOMAIN of the predicate
was the defect, and the domain was set by something with a stake or a blind
spot.** It predicts — for any check, ask what fixes its domain and whether that
thing is interested or blind. It is falsifiable: it predicts round 4 is another
scope defect, not a predicate defect.

Second compression, from the same evidence:
**agreement checks can only propagate content that at least one side already
possesses.** `port == reference`, `plan == spec`, `reviewer == reviewer` are the
same failure wearing three costumes. Only contact with the artifact adds content.
That is why running the numbers found in one probe what two review rounds could
not, and it is the general form of "a reference validated 11/11 is silent about
every clause it never implemented."

## 4. The root cause: n=1, and a transfer test that never left the task

Cross-lane relay (2026-08-21) put it as: the lane repeatedly dug the SAME
specific problem, which is the failure CLAUDE.md's induction rule exists to
prevent. Checked against the repo rather than accepted, and it is confirmed
twice, the second harder than stated:

**(a) The spec's own probe put raman in the class D&C does not address.**
`2026-08-20-dnc-design.md:123` classifies raman under the **GATE-shaped
stuckness class**; `:127` states *"D&C addresses only length-induced failure, a
minority sub-band"*; `:131` pools gate-shaped tasks into **NEITHER** arm of any
level-2 probe. §6 is a separate route for globally-coupled tasks, so this is not
self-contradiction — but the D&C **generality** claim lives in the length
sub-band (`path-tracing`, `write-compressor`, `tune-mjcf`,
`llm-inference-batching`), and that sub-band **has never been attacked.** The
spec's own sequencing (§6 first, level-2 "own go, after §6 and the second
fixture") is what routed the whole cycle into the n=1 task.

**(b) §8.1's transfer test — "one agreement is not transfer" — is satisfied by a
fixture we wrote ourselves.** `dnc-second-fixture-20260820/pre-registration.md`
declares it a *"synthetic resonance scan … generated by `make-fixture.ts` with
hardcoded seed 424242."* It is a second two-column numeric series with peaks,
authored by us to have peaks. It varies domain, family member, peak count and
noise texture — but never the artifact class, which is the only variable the
1/99 census found binding. **The transfer test never left the task.** n=1 wearing
n=2's clothes, and it satisfied the spec requirement written specifically to
prevent that.

**Why four disciplined review rounds could not catch this.** Every round was an
agreement check inside a frame — plan vs spec, reviewer vs reviewer — and §3's
own law says agreement propagates only content one side already possesses. The
frame ("make the raman gate correct") was never contacted with the corpus. The
census was the first artifact contact of the entire cycle, and it came **last**.
Correct-without-general is what repeated digging on one instance produces **by
construction**, however disciplined each round is.

## Consequence for the addressable-class census (registered but UNRUN)

Asking *"does my raman instrument generalise?"* is still facing raman — one more
meta-pass over the same pipeline. Its honest value was as a **stop/continue
decision**, and if the ruling is already "stop investing here", the census is
**moot and should be retired unrun** rather than defended by its author.
Retiring a pre-registration that never ran is clean; running it and then
discarding the result would not be.

The inductive move is the opposite direction: **attack a task never attacked
before**, and let the general divide emerge from the DIFFERENCES between instance
1 and instance 2. n=2 teaches what no amount of n=1 review can.

## 5. The authorship-boundary law (cross-lane, four instances, one mechanism)

Generalised from §4(b) by `meta-harness-1e` and checked here against the
session's other findings, where it turns out to subsume three of them:

> **Evidence generated inside the authorship boundary of the thing it tests
> measures the generator, not the world.**

| instance | authored by | what it actually measured |
|---|---|---|
| §8.1's "second fixture" transfer test | us (`make-fixture.ts`, seed 424242) | our fixture generator |
| the `6/99` series-bearing denominator | us (5 of 6 were our probe tasks) | our own habits |
| `evasion-cards.json` as the literal checker's bad set | us, same author, same sitting | our imagination of evasions |
| L-B replication as a value-truth witness | same model, same prompt | sampling stability, not truth |

The fourth is the spec's own demotion argument (shared training ⇒ shared prior ⇒
shared confident error), which was reached independently and never connected to
the other three. It is the same law at the level of witnesses rather than
fixtures. The third is this session's finding S5, also never connected.

**Consequence, binding on both lanes:** a transfer test's fixture must come from
**outside the authorship boundary of the thing under test**, or it is n=1 in
costume. Lane B's open second-fixture item for the scale-space criterion carries
the identical exposure — a self-generated gcode fixture with a varied string and
varied font parameters would discharge the requirement while measuring our
generator. This is the "detector validated on synthetics" lesson promoted from
detectors to transfer requirements, bad sets, denominators, and witnesses alike.

## 6. Where the leverage was actually lost

The n=1 spiral was **not** a discipline failure in any round — every round was
rigorous, and the reviews demonstrably worked (four real defects, three of them
critical or high). It was a **SEQUENCING decision** made once and early (§6
first, level-2 "own go, after §6 and the second fixture") that routed every
subsequent disciplined round into the same instance.

**The expensive choice is WHICH INSTANCE TO FACE, not how hard to review it.**
Review quality is not the scarce resource here — this cycle proved we have it.
Instance selection is where the leverage was lost, and it is a decision that
belongs to the principals, not to the lanes agreeing with each other.

## Honest summary

- **Method: compressed.** Many instances → one scope-defect mechanism, one
  agreement-check law, and a constant deleted in favour of a derived quantity.
- **Artifact: did not.** The gate engages on 1 of 99 real tasks. That is the 1:1
  ratio our own rule names as the tell, and no amount of engineering quality
  changes it.
