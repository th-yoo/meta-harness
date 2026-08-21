# Addendum 02 — where the gate rejects TRUE claims (2026-08-21)

Prompted by a challenge to the verdict's line *"the gate does not reject a true
claim on one fixture."* That line understates: it holds for the one geometry the
fixture was built to have. Mapped the space instead. Zero spend.

Method: feed `mergeCheck` the EXACT TRUE claim (`a = 0`, `b = 1e7` on `u = 1/x`)
at varying anchor counts and geometries. Any reject is a false reject of a
correct answer — pre-registered outcome **B**, which this probe's own
registration called "the most serious possible finding."

| geometry | n | exact TRUE claim |
|---|---|---|
| irregular | **3** | **FALSE-REJECT** (degenerate-constellation) |
| irregular | 4-8 | accept |
| equal-spaced in u | 3, 4, 5, 6 | **FALSE-REJECT** (all) |
| symmetric irregular | 5 | **FALSE-REJECT** |

## Two of the three are correct behaviour

Equal-spaced and mirror-symmetric constellations are GENUINELY undecidable: a
wrong pairing fits exactly as well as the right one, so no evidence in the
artifact separates them. Fail-closed is the right answer and the design language
already says so — uncheckable is not wrong. These are the V2 and V6/T10 cases
from the validated matrix, behaving as validated.

## The n=3 case is NOT a code defect — the SPEC's floor is unachievable

At n=3 against a 2-parameter family there is exactly ONE residual. The
+-1-shift alternate uses only `n-1 = 2` anchors, and two points always fit an
affine EXACTLY — so that alternate can never fail, and including it would force
a reject on every claim. The `n - 1 >= 3` guard exists to suppress that vacuous
comparison. Suppressing it empties the alternate set, and an empty set rejects
too.

**n=3 is unreachable by construction. The distinguishability question cannot be
posed with one residual.** The code is correct; §6's repeated "n >= 3" is wrong.
The true requirement of this check design is **n >= 4**.

## Corrections to earlier statements of mine

1. `dnc-minimal-runnable-20260821/verdict.md` calls this a "MEASURED DEFECT —
   the documented floor and the operable floor disagree", implying the code is at
   fault. **It is not.** The spec's floor is unachievable and the code's
   behaviour is its correct consequence. The measurement stands; the attribution
   was wrong.
2. Building `raman-quartet-report` with four bands was therefore not a
   workaround for a bug. **n=4 is the genuine minimum at which the method can say
   anything at all** — three anchors is not a small sample for it, it is no
   sample.
3. The live verdict's "the gate does not reject a true claim on one fixture" is
   true as written but reads as a general property. It is not: false rejects
   exist in three regions, two by design and one by the floor above.

## Consequence for the spec

§6 and the arming plan both state n >= 3 (`mergeCheck` guards
`anchorsU.length < 3 -> insufficient-anchors`). That guard admits a class of
input on which acceptance is impossible, so it reports the wrong reason:
a 3-anchor claim fails as `degenerate-constellation` when the honest reason is
`insufficient-anchors`. Raising the guard to n >= 4 would make the refusal
truthful. Recorded, not changed — shipped code stays untouched here.

## Addendum 02b — the divide LAUNDERS the representation

Challenge raised: isn't the live run's success a representation (locale,
convention) regression? Measured, and yes.

`parseSeries` handles every trap the real fixture carries — comma decimals,
CRLF, descending order — 3000/3000 parsed in each variant, same 4 anchors, gate
accepts in all:

| variant | parsed | anchors | gate |
|---|---|---|---|
| REAL rung 2 (comma+CRLF+desc) | 3565/3565 | 17 | accept |
| quartet + comma only | 3000/3000 | 4 | accept |
| quartet + CRLF only | 3000/3000 | 4 | accept |
| quartet + descending only | 3000/3000 | 4 | accept |

That robustness IS the problem. The model in the live run received
`1: 3745.082` — never `47183,554644`, never CRLF, never descending, and never
the question of which points are peaks. Of the real task's four traps — unit
convention, decimal comma, row order, find-the-peaks — **the divide removes
three and reframes the fourth**, before the model is consulted. The quartet
fixture separately dropped comma/order at generation, so the laundering is
doubled: once in the fixture, once in the divide.

**Correction to the live verdict's attribution.** It credits the result to
framing alone ("enumerating the anchors converts an assert-and-defer framing
into an identify-the-convention framing"). Framing is real — the rung-0
comparison survives, because rung 0 has no data file and therefore no locale or
order trap. But representation laundering is a SECOND, independent cause that
the verdict did not separate. The live run measured a model on a
representation-cleaned view of a representation task.

Decisive one-call test, not yet run: hand the model the raw EU-comma descending
lines instead of parsed floats, same question. If it still converts, framing
carries it; if not, the divide's apparent value was the parser's.
