# Addendum 03 — raw-representation arm, PRE-REGISTRATION (2026-08-21)

Registered before the call. One model call, user go given.

## Question

The live run handed the model PARSED floats in ascending order with dot
decimals (`1: 3745.082`). It converted all four bands to within 0.0034 cm^-1.
Rung 0, with no data at all, scores 0/5.

**Did the earlier win come from the mechanics (parse/normalize/peak-find) or
from the FRAMING (asking "which relationship holds" instead of asserting the
answer)?**

## Design — one variable changed

Identical to the successful run except the anchor values are presented in the
REAL fixture's conventions: **EU decimal commas, descending file order**, exactly
as `raman-fitting`'s `graphene.dat` stores them. Peak-finding stays done (same
four anchors) so the ONLY difference is representation. The question wording is
held constant so framing is held constant.

## Registered prediction

**The model will still convert correctly.** Decimal-comma parsing is not hard for
sonnet, and the framing question is unchanged. If that holds, **framing carried
the earlier win, not the mechanics** — which falsifies the cross-lane n=2 law as
stated ("failure lives upstream in the mechanics") and supports the broader
form: the model is at ceiling and the failure is in the SCAFFOLDING, which fails
either by bad artifact preparation OR by bad framing.

## Outcomes

- **A: converts correctly.** Representation was not the barrier here. Framing
  carried it. The divide's transferable content is the REFRAME, which is cheap
  and applies far beyond one-numeric-series tasks.
- **B: fails or echoes raw values.** Representation mattered; the mechanical half
  is load-bearing and the n=2 law as stated survives.
- **C: partial** (some bands converted, some echoed) — representation degrades
  rather than blocks; record the split.
- **D: transport/parse failure** — infrastructure, recorded as such, never dressed
  as a result.

Rung 0 remains the standing counterexample to the mechanics-only reading: zero
mechanical work, still 0/5.
