# F3 cell-contract probe — pre-registration (2026-08-20, `yoo-dev`)

Written before any call. Decides finding **F3** of
`docs/loop-probes/reval-adherence-20260819/verdict.md`: the shipped prompt orders
the auditor to SHOW its arithmetic inline (the lane-a-v2 toolless
anti-fabrication fix) while `parseRevalBlock` requires bare numeric cells. Shape
adherence was 4/4, parse 0/4. Three candidate resolutions, and this probe
measures which one — or which combination — actually parses.

## The three options

- **O1 — tolerant parser.** Prompt unchanged. The parser extracts the last
  `= <number>` from a derivation cell and strips unit suffixes from `input`.
  Cheapest; the risk is that a parser guessing at prose silently extracts the
  WRONG number, which is the failure the block existed to prevent.
- **O2 — split channels.** Parser unchanged. Prompt moves the arithmetic to
  prose ABOVE the block and states that block cells must be bare numbers, with
  the shown work being what the prose is for.
- **O3 — derivation column.** Both change. The block gains an explicit
  `derivation` column the parser ignores, so showing the work has a home that is
  not a numeric field.

## Design — 2 arms of spend, 6 scored combinations

O1 needs **no call**: it is a parser change scored against the four raw cells
already committed at `out-TRAP-r{1..4}.json`, which are real toolless sonnet
output under the shipped prompt. Only O2 and O3 need new calls.

Every output is then scored under BOTH parsers, strict and tolerant, giving the
full matrix from two arms:

| | strict parser | tolerant parser |
|---|---|---|
| shipped prompt | measured (0/4, the F3 finding) | **O1** (free) |
| O2 prompt | **O2** | O2+O1 |
| O3 prompt | **O3** | O3+O1 |

- Stimulus: `raman-peak-report` via the shipped `buildSample`, byte-identical to
  the arm that produced the existing cells, and passing `assertCleanStimulus`.
- Transport: shipped path, post-fix (bare `claude-sonnet-5`, derived client
  budget). k=4 per arm to match the existing arm. **Total = 8 calls.**

## Pre-registered metrics

1. **PARSE RATE** (primary): fraction of cells `parseRevalBlock` reads as
   `kind: "claim"`.
2. **MISPARSE RATE** (safety, O1 only): of cells the tolerant parser accepts,
   the fraction where an extracted number does NOT match what the cell's own
   prose asserts, checked by hand against the raw text. **A single silent
   misparse disqualifies O1 as a standalone fix**, regardless of parse rate — a
   parser that invents a landing is strictly worse than one that refuses.
3. **SHAPE RETENTION** (regression guard): O2/O3 must not lose the 4/4 block
   shape the shipped prompt already achieves. An arm that parses better by
   emitting fewer blocks has not won.

## Pre-registered decision rule

- Any option reaching **parse ≥ 3/4 with zero misparses** is adoptable.
- If several qualify, prefer the one changing the FEWEST moving parts, in order
  O1 < O2 < O3, since each change is a new surface to be wrong about.
- If O1 qualifies on parse rate but records **any** misparse, it is rejected
  standalone and may only ride on top of an arm that already parses — its value
  then is redundancy, not rescue.
- If no option reaches 3/4, F3 is not a formatting problem and the block itself
  is the wrong instrument; report that rather than iterating prompts.

## Scope — what this probe does NOT decide

**F3 is necessary, not sufficient.** Fixing the cell contract converts
`malformed` into a parsed claim that then still faces **F5** (three of four
cited inputs do not exist in the sample; the peak is structurally invisible in a
head-20/tail-20 window) and **F4** (the real transform is reciprocal∘offset,
which the single-op whitelist cannot express). So a parsed claim here is
expected to FAIL `revalidate` on content, and that failure is not evidence
against the winning option. Reported separately, never pooled with parse rate.

No arm, no activation, no adoption follows from this probe on its own.

---

## AMENDMENT 01 — the O2+O3 combination arm (O4), added 2026-08-20 before its spend

O2 and O3 are **not** mutually exclusive: O3 already carries O2's bare-numeric
cell contract and differs only in where the arithmetic lives (prose above vs an
in-block column). The combination worth testing is therefore not "both prompts"
but **O3's derivation column made CHECKABLE** — the objection raised against O3
standing alone was that an unchecked field inside a machine-checked block is
decoration shaped like evidence, and can contradict the checked numbers with no
consequence.

**Free result, scored offline on the existing O3 cells before this arm was
written.** A cross-check asking "does the declared `CONSTANT` appear in each
row's derivation?" is non-vacuous — it fires on real defects and passes clean
cells:

| variant | fires on | verdict |
|---|---|---|
| strict (exact token match) | **O3-r1, O3-r2** | correct on both |
| lenient (power-of-ten tolerance) | O3-r1 only | **masks r2 — the weaker check** |

`O3-r1` declares `CONSTANT: 633` and derives row 2 with `1/532`. `O3-r2`
declares `CONSTANT: 5320000` while every derivation uses 532. The lenient variant
accepted r2 by treating 5320000 as 532 scaled — the same "check that cannot
fail" error this arc has been cataloguing, committed inside the checker itself.
**Strict is adopted; the tolerance is rejected.**

### O4 arm
Prompt = O3's five-column block + O2's bare-numeric contract + an explicit
statement that the `derivation` MUST use the declared `CONSTANT` and that a
mismatch is a rejection. k=4, same stimulus and transport. **4 calls.**

### Pre-registered metrics
1. **PARSE RATE** (column-aware), as before.
2. **CONSTANT-CONSISTENCY**: fraction of cells whose every derivation row
   contains the declared constant, under the STRICT check. Baseline to beat is
   O3's measured **2/4**.
3. **MISPARSE**: must stay 0.

### Pre-registered decision rule
- O4 consistency **4/4** → announcing the check fixes the inconsistency; adopt
  the cross-check as a gate rule and O3's column with it.
- O4 consistency **≤2/4** → the inconsistency is NOT prompt-fixable, and the
  prediction below is confirmed.

### Registered prediction (stated before the spend, so it can be wrong)
O4 will **not** reach 4/4, because the root cause is **F4, not F3**: the true
transform needs TWO constants (laser wavelength and 1e7) and the schema affords
one, so the model puts something arbitrary in `CONSTANT`. If that is right, the
cross-check is detecting an F4 symptom and the fix belongs in the whitelist, not
the prompt.
