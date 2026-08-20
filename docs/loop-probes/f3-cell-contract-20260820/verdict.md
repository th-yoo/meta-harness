# F3 cell-contract probe — verdict (2026-08-20, `yoo-dev`)

Scored against `pre-registration.md`, written before any call. 8 sonnet calls
(O2 ×4, O3 ×4); O1 cost nothing, scored offline against the four committed
`out-TRAP-r*.json` cells. Scorer: `score-f3.ts`.

**Winner: O2 (split channels) — a prompt-only change, adopted by the
pre-registered fewest-moving-parts rule. O3 is the runner-up and carries one
finding O2 cannot.**

## The matrix

| arm | shape | strict parse | +tolerant (O1) | misparses |
|---|---|---|---|---|
| shipped prompt | 4/4 | **0/4** | 4/4 | **4** |
| **O2** split-channels | 3/4 | **3/4** | 3/4 | **0** |
| **O3** derivation-column | 4/4 | 0/4 † | **4/4** | **0** |

† O3 emits five columns; `parseRevalBlock` requires exactly four, so the shipped
parser rejects it by construction. O3 was defined as "both change", so 0/4 under
an unchanged parser is not its score — column-aware, it is 4/4 with zero
misparses.

## O1 — rejected standalone, as the safety metric required

Parse rate 4/4 on real cells, and **4 silent misparses**, two classes:

- **range collapse:** `"2670-2700 cm^-1 (2D band)"` → 2670. The prose asserts
  2700. At the model's own `DELTA: 5` this **flips the landing from pass to
  fail** — the misparse changes the verdict, it does not merely annoy.
- **digit taken from a word:** `"far beyond 2D band (~2700 cm^-1), shows range
  spans past graphene features"` → **2**, from the "2" in "2D". The cell says
  the value does not land; the parser invents `canonical = 2.0`.

Pre-registered rule: a single silent misparse disqualifies O1 regardless of
parse rate, because a parser that invents a landing is strictly worse than one
that refuses. Both classes are now encoded structurally in `score-f3.ts`, so the
same rule judged O2 and O3 rather than my eye.

## O2 — the winner

One prompt clause moved the model from unparseable prose to clean numerics on
the same stimulus:

```
shipped:  | 5811.9 (Å) | 1e7/532 - 1e7/(5811.9/10) = 18796.99 - 17206.87 = 1590.1 | 1580-1590 cm^-1 (G band) |
O2:       | 5808.5 | 1580.0 | 1580.0 | MisreadingA |
```

Ranges disappear too — the exact construct that defeated O1's canonical
extraction. **Zero misparses; the tolerant parser buys nothing here, which is
the point: cells that are already bare need no tolerance.**

**The 4th cell is not a malformation.** `O2-r2` emitted `TRANSFORM: none` after
reasoning that the laser wavelength is not derivable from the sample, and took
the criteria-class reading instead. That is the anti-fabrication design working,
and it is **F5 showing through the seam** — the model declining to invent a
constant the evidence cannot supply. Counting it as a loss would punish the
behaviour the lane wants. Honest score: 3 claims + 1 principled abstention.

## O3 — runner-up, and the one thing it sees that O2 cannot

O3 matches O2 on cell cleanliness (4/4, zero misparses) and adds an audit trail.
That trail immediately exposed a fabrication class **O2 structurally conceals**:

- `O3-r1` declares `CONSTANT: 633`, then derives row 2 with `1/532` — **two
  different constants inside one claim**, the gen4-r1 confident-wrong class,
  visible only because the derivation is printed.
- `O3-r2` declares `CONSTANT: 5320000` while deriving with 532 and ×1e7.

Under O2 those cells are bare numbers and the inconsistency leaves no trace.
The gate still **rejects** both mechanically — see below — but rejection without
evidence of *why* is what makes a failing arm hard to diagnose.

## Every arm still fails `revalidate`, exactly as pre-registered

The declared constant reproduces the claimed `computed` in **0 of 7** numeric
claims across both arms, because every one of them means
`1e7 × (1/C − 1/x)` — reciprocal composed with offset, **two operations**, which
the single-op whitelist cannot express. This is **F4**, untouched by any cell
contract, and it was pre-registered as out of scope so it is reported and not
pooled with parse rate. F5 likewise stands: the cited peaks remain largely
absent from a head-20/tail-20 sample.

## Decision

1. **Adopt O2** — prompt-only, 3/4 + a correct abstention, zero misparses,
   fewest moving parts. Needs its own implement-and-merge go.
2. **Do not adopt O1 standalone.** It may later ride on top of O2 as redundancy,
   but on O2's output it has nothing to do.
3. **Hold O3 as the upgrade path**, and revisit it when F4 is settled: if the
   whitelist gains the two-op form, the derivation column becomes the natural
   place to audit which constant was actually used.
4. **F3 is resolved as a formatting question and is no longer the blocker.**
   The blockers are now F4 (whitelist expressivity) and F5 (sampler evidence),
   in that order — F4 first, because until it lands no correct audit of this
   trap class can pass regardless of how cleanly it is formatted.
