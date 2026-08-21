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

**All six are raman variants reading the same `graphene.dat`** (`raman-fitting`
plus the four `raman-fitting-*` probe tasks we ourselves created, plus
`raman-peak-report` which yields only 1 anchor). **91 of 99 tasks have no
two-column numeric series at all.**

Of genuine benchmark tasks, the count is **one: `raman-fitting`.**

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

## Honest summary

- **Method: compressed.** Many instances → one scope-defect mechanism, one
  agreement-check law, and a constant deleted in favour of a derived quantity.
- **Artifact: did not.** The gate engages on 1 of 99 real tasks. That is the 1:1
  ratio our own rule names as the tell, and no amount of engineering quality
  changes it.
