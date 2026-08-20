# Addendum 01 — O4 arm formally scored (spec §8.7)

The O4 arm (pre-registration.md AMENDMENT 01) was run 2026-08-20 — four cells,
`out-O4-r{1..4}.json` — but the run was never scored against its own
pre-registered decision rule and never entered into `verdict.md`. This gap was
found by the architect review of the D&C spec, finding F4. This addendum
scores it now, from the already-committed cells, against the already-registered
rule. Nothing new is registered here and `verdict.md` is not edited.

## Scorer output (verbatim)

Produced by `docs/loop-probes/f3-cell-contract-20260820/score-o4.py`, run
2026-08-20 from the repo root:

```
O4 CONSTANT-CONSISTENCY (strict): 3/4  [registered baseline: O3 2/4]
  out-O4-r1.json: CONSTANT=18797.0 derivation-rows=2 consistent=True (strictBlock=malformed — parse metric, reported not scored)
  out-O4-r2.json: CONSTANT=18796.99 derivation-rows=2 consistent=True (strictBlock=malformed — parse metric, reported not scored)
  out-O4-r3.json: CONSTANT=None derivation-rows=0 consistent=False (strictBlock=none — parse metric, reported not scored)
  out-O4-r4.json: CONSTANT=532 derivation-rows=2 consistent=True (strictBlock=malformed — parse metric, reported not scored)
registered rule: consistency 4/4 -> adopt cross-check + column; <=2/4 -> confirms prediction (root cause F4, not F3); 3/4 -> INDETERMINATE under the registered rule
outcome: INDETERMINATE
```

## Registered rule (quoted from `pre-registration.md` AMENDMENT 01)

> ### Pre-registered decision rule
> - O4 consistency **4/4** → announcing the check fixes the inconsistency; adopt
>   the cross-check as a gate rule and O3's column with it.
> - O4 consistency **≤2/4** → the inconsistency is NOT prompt-fixable, and the
>   prediction below is confirmed.

The rule as registered names only these two branches. It does not name a 3/4
outcome, so 3/4 falls into neither — it is INDETERMINATE under the registered
rule, not silently rounded into either branch.

## Reading

The scorer measured **3/4** — one better than O3's baseline (2/4), but short
of the 4/4 needed to adopt the cross-check, and not low enough to confirm the
registered prediction (F4-not-F3, ≤2/4). The registered rule does not cover
this outcome, so the correct reading is: **INDETERMINATE**. This addendum does
not round 3/4 down to "confirms prediction" — doing so would retroactively
apply a threshold the pre-registration never set.

What the rule does cover, and what actually moved, is the divergence between
the two pre-registered metrics: **PARSE RATE (`strictBlock`) was 0/4** — every
cell's block was either `malformed` (r1, r2, r4) or `none` (r3, which emitted
no revalidation table at all) — **while CONSTANT-CONSISTENCY was 3/4**. The
announced, machine-checkable metric (parse) moved to zero while the underlying
behavior it was meant to proxy (does the derivation actually use the declared
constant) stayed mostly intact. That divergence — not either single number —
is what the D&C spec's G1 cites: the announced metric moving independently of
the underlying behavior it is supposed to track. Because the outcome is
INDETERMINATE, G1 cites the divergence plus the four raw cells directly,
rather than a single adopt/reject verdict this arm cannot produce.

`out-O4-r3.json` has no `CONSTANT:` line and no revalidation table at all
(`TRANSFORM: none`, zero derivation rows) — it is scored **inconsistent, not
vacuously consistent**, because the check is fail-closed like every other gate
in this design: an empty block must not be able to outscore a populated one
merely by declaring nothing to contradict.
