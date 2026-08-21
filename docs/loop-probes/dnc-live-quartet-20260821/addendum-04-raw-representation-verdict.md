# Addendum 04 — raw-representation arm: VERDICT (2026-08-21)

**Pre-registered outcome B. My registered prediction is REFUTED — the third
refuted prediction of the day, and the most informative single call of the
session.**

## What changed, and what did not

One variable: the four anchors were presented in the REAL fixture's conventions
(EU decimal commas, descending file order) instead of parsed ascending floats.
Same question wording, same anchors, peak-finding still done.

## Result

The model handled the representation **without difficulty** — it read
`7411,503835` as `x=7411.50`, noted the descending order explicitly, and
correctly identified the family as `inv-x`. It then mapped each anchor to the
right band by ordering.

**But it did not COMPUTE. It RECALLED.**

| band | true (1e7/x) | PARSED arm | err | RAW arm | err | verifier (+-5) |
|---|---|---|---|---|---|---|
| D | 1349.25 | 1349.254 | 0.000 | **1350** | 0.75 | PASS |
| G | 1580.39 | 1580.392 | 0.000 | **1580** | 0.39 | PASS |
| D' | 1619.46 | 1619.465 | 0.003 | **1620** | 0.54 | PASS |
| 2D | 2670.17 | 2670.169 | 0.000 | **2700** | **29.83** | **FAIL** |

**PARSED arm: 4/4, task PASSES. RAW arm: 3/4, task FAILS** — the 2D band off by
29.8 cm^-1, six times the tolerance, because the textbook nominal for 2D is
"~2700" while THIS spectrum's 2D sits at 2670.

Same model, same day, same question, same anchors. **Only the representation
changed, and the behaviour switched from COMPUTE to RECALL.**

## Why the prediction was wrong, and what it means

Registered: *"the model will still convert correctly … decimal-comma parsing is
not hard."* The parsing was indeed not hard — that half was right. What was
wrong was the assumption that ease-of-parsing implies same-behaviour.
**Friction in the representation did not block the answer; it shifted the
strategy.** Clean floats invite arithmetic; comma-decimal strings in reverse
order invite recall.

This SUPPORTS the cross-lane n=2 law rather than falsifying it: the mechanical
half is load-bearing, and not for the reason either lane argued. It is not that
the model cannot parse. It is that **doing the mechanical work for the model
keeps it computing from the artifact instead of substituting a memorized
prior.** That is a sharper mechanism than "failure lives upstream in the
mechanics", and it is measured, not argued.

Rung 0 now fits the same frame: value asserted inline, nothing to compute from,
prior substitutes, 0/5.

## The gate accepted a task-FAILING claim — live, not synthetic

`mergeCheck: ok=true`, `a=-36.461`, `b=1.02446e7`. The fit absorbed the 2D
discrepancy into a slightly wrong slope and intercept and passed.

This is the T6 class occurring **naturally**, without an adversary constructing
it. The earlier 11x fabrication demo was mine; this one is a real model doing a
reasonable thing. It is the strongest available evidence that the merge half
cannot protect the task:

**a claim the task's own verifier fails, produced by an honest model, passes the
gate.**

Note the shape: this is not deception. It is a memorized prior standing in for
measurement — plausible, self-consistent, textbook-grounded, and wrong. The gate
has no purchase on it because the claim is conversion-shaped and therefore fits
by identity up to the small offset the prior introduces.

## Consequences

1. **The divide's mechanical half is validated** — and by a mechanism nobody
   registered in advance: it suppresses prior-substitution.
2. **The merge half's failure is now demonstrated on live data**, not synthetic.
3. **My "framing carried it" hypothesis is dead.** Framing was held constant
   across both arms and the outcome flipped.
4. The broader scaffolding law I proposed still stands but loses this as
   evidence: representation and framing are BOTH load-bearing, and this arm
   isolates representation.
