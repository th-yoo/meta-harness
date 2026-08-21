# Addendum 05 — prior-art reconciliation, and what the raw arm actually bought

User caught both lanes recommending an experiment already done. Prior-art check
run (now a standing rule); cross-lane assessment received and reconciled.

## PRIOR ART — what the log already held

`git log --all -i --grep="actuation"` / `--grep="card arm"`:

| commit | result |
|---|---|
| `7b1559e` | census generality — convention-audit **detection** generalizes beyond raman |
| `c0b2222` | **elf x haiku card arm: 5/5 vs 2/5 baseline**, mechanism 5/5 |
| `25ef950` | **gcode x haiku card arm: 0/5, acted 1/5** — haiku exploits the card's hedge |
| `a7d77b0` | **joint 2x2 grid — actuation is tier x hedge-sensitive** |
| `919d96c`, `7b03b7d` | v3-card and gate-enforcement arms, 0/5 each |

So the convention-audit CARD — not D&C — is the mechanism that addresses
representation, and it is measured across **three** cells:

| cell | class | baseline | card | verdict |
|---|---|---|---|---|
| raman x sonnet | data-surface (unit) | 0/48 | 3/6 | actuates |
| elf x haiku | instruction-criteria (scope) | 2/5 | **5/5** | actuates |
| gcode x haiku | data-surface (geometry) | 0/5 | 0/5 | **NULL** |

**The gcode null is the part both lanes missed entirely**, and its cause is a
design law: 4/5 trials **harvested the card's hedge as permission** to ship a
decoy. Recorded rule — *sonnet consumers TEST cards, haiku consumers COMPLY
SELECTIVELY; at weak tier a hedge is permission, not calibration. Cards for
production/haiku consumers must phrase uncertainty as MANDATORY disambiguation,
never as an open possibility.*

Stat honesty already banked there: elf REWARD 5/5-vs-2/5 is Fisher p=0.0833,
**suggestive not significant**; the load-bearing number is MECHANISM 5/5 vs 1/5,
p=0.0238.

## Cross-lane assessment — accepted, all four

1. **My reframe stopped one step short.** "Can the card be trusted without a
   verifier" is already answered by §8.8: numeric injection requires
   CROSSCHECKED; NO-SOURCE tasks get criteria-class only, numeric-literal-free
   by construction. Open items are narrower — the arming increment is
   spec-closed but unimplemented, and whether criteria-class-only cards actuate
   enough (elf says yes for its class).
2. **elf survives the authorship-boundary law.** The law binds the TEST
   artifact; `extract-elf`'s task and grader are unauthored. The card being our
   machinery's output is the thing under test, not the test. Real caveat is
   POWER, not authorship.
3. **Immunity must be scoped**: criteria cards are immune to numeric
   fabrication BY CONSTRUCTION, but misdirection is still possible and priceable
   only by outcome A/B. gcode's null is exactly misdirection.
4. **Prior-art check adopted** (below).

## What the raw arm actually bought — reclassified

The raw-representation arm was reported as a gate refutation. It is more than
that:

**Recall-under-friction is PRIOR-DRIVEN FABRICATION observed live, unconfounded.**
The model reported the textbook 2700 instead of computing 2670 — a plausible,
stable, memorized value, produced naturally with no adversary and no prompt
contamination.

§8.8 demoted the L-B replication rung on the argument that prior-driven
invention is a *stable generator*, citing F4's 532nm story **under a recorded
contamination confound**. This incident is the same class **without the
confound**, and it is the registered falsifier probe's prior-driven arm
occurring spontaneously. It strengthens the demotion's evidence base for free.

And the second half validates the ladder rather than only indicting the gate:
`mergeCheck` ACCEPTED that claim (`ok=true`, `a=-36.461`, `b=1.02446e7`), but
**the §8.8 ladder would have refused it anyway** — raman is single-artifact,
therefore NO-SOURCE, therefore no numeric authority. The strongest validation
that design has received.

## STANDING RULE — prior-art check

**A recommendation naming a concrete experiment is not issuable until a log
search for its key nouns has run and its output is quoted in the
recommendation.**

    git log --oneline --all -i --grep=<noun>
    ls docs/loop-probes/

Two commands, seconds each. "elf" or "actuation" would have surfaced `c0b2222`
instantly. This is corpus-check-before-register's dual: that rule verifies the
DATA exists before a question is registered; this one verifies the ANSWER does
not already exist before an experiment is recommended.

Root cause is the agreement-check law in a third costume: two agents CONCURRING
produced a recommendation neither checked against the artifact — and for "what
has been done", the artifact is the git log.

Follow-on (not built): `docs/loop-probes/` has no `INDEX.md`. One line per probe
(question, verdict, date) plus a drift-guard in the manifest-checker shape would
make this lookup a single Read.
