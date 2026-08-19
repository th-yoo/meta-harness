# Revalidation wire-format adherence probe — pre-registration (2026-08-19, `yoo-dev`)

Gate before building the increment-2 revalidator parser: the user chose
"probe adherence first, then decide" on the wire format. Measures whether
sonnet emits a **parseable, derived** machine claim for a numeric-trap card,
and in which register — so the parser targets the model's real output, not a
guessed grammar. Mirrors sibling `meta-harness-1e`'s join-probe discipline
(pre-reg committed + dry-runs green before any call + explicit N-call go).

## Rung separation (the recorded discipline — never one pass/fail)
- **FORMAT rung:** does a call emit a claim a deterministic parser can extract
  (transform + single constant + ≥2 landings)? Measured per register.
- **CONTENT rung:** for parseable claims — do the landing `input` values TRACE
  to numbers present in the sample (DERIVED) or are they invented (GUESSED,
  the sibling's B2 cell=2mm class)? Is there ONE fixed constant landing ≥2
  within the stated Δ?
- **CONTROL rung:** on a CLEAN numeric input (no real mismatch), does it
  correctly emit NO claim / `none` (not a spurious confident table)?

## Design
- Model/transport: **sonnet via `claude -p` toolless** (matches the gen4
  fixture provenance + the shipped auditor's toolless tier).
- Base prompt: shipped `convention-audit-prompt.txt` (lane-a-v2) + one added
  emission line per register variant.
- Register variants:
  - **V-table:** "emit a markdown transform table: `| transform | constant |
    input | computed | canonical | Δ | discriminates-misreading | verdict |`"
    (the model's proven natural register — both gen4 fixtures used a pipe
    table). The `discriminates-misreading` column ties each row to the card's
    MISREADINGS section (sibling seam→misreading tie, kills fabricated rows).
  - **V-block:** the compact fenced `REVALIDATION:` block.
- Cells: raman-trap (`input-A-raman.txt`) × {V-table, V-block} × k=2 = 4 calls;
  + clean control (`input-D-control.txt`) × V-table × k=2 = 2 calls.
  **Total = 6 sonnet calls.**

## Dry-run green BEFORE any call (zero spend)
Write both parsers (`parse_table`, `parse_block`) and run them against the
EXISTING `generator/out-gen4-r{1,2}.json` fixtures offline — confirm the table
parser extracts gen4-r2's rows and that the one-fixed-constant test separates
r2 (pass) from r1 (reject). Only spend after the offline parser is green on
real prior output.

## Pre-registered decision rule
- **Wire format** = the register with higher FORMAT-rung adherence; tie →
  **V-table** (natural register, gen4 fixtures become real parser tests,
  higher adherence by construction).
- If FORMAT adherence < ~50% for BOTH registers → the structured-emission
  approach is unreliable at this tier; fall back to parsing the inline prose
  arithmetic the model already shows, or defer the revalidator. (Prior from
  sibling join-probe: structured one-line demands complied 4/4 → expect high.)
- **CONTENT rung → sampler contract:** if parseable cards GUESS the constant
  (input values not traceable to the sample), the lane-A sampler must carry a
  **calibration-sweep block** for any predicate family the card parameterizes
  (sibling's 5th fix-the-evidence instance) — the generative half that makes
  the revalidator's job clean. Banked into the spec regardless; the probe
  measures how load-bearing it is.
- **CONTROL:** any spurious claim on clean input confirms the gate must
  fail-closed on unparseable/unverifiable blocks (already adopted).

## Out of scope
End-task reward (no bench run here); compute-transport (increment-3);
haiku-tier. This probe measures EMISSION register + derive-vs-guess only.
