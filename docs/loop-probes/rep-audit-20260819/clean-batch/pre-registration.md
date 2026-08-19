# Clean-batch confirmation — pre-registration (2026-08-19, before any call)

**Purpose:** confirm (or kill) the post-hoc CONTENT-gate observation from the
main probe (verdict.md finding 5) with a design that fixes the two flaws the
sibling review named: (a) the D-bar/prompt contradiction, (b) the curated
(peak-aware) sample confound.

**Prompt change (audit-prompt-v2.txt):** same three questions, but the
CONTENT section must END with exactly one machine-parseable line:
`CONTENT VERDICT: MISMATCH` or `CONTENT VERDICT: NO MISMATCH`.
The misreadings enumeration stays (no contradiction: the GATE reads only the
verdict line; risk-listing is allowed and expected). Injection rule under
test: inject the audit into the task prompt iff the verdict line says
MISMATCH.

**Model:** sonnet only (haiku attribution-dead per main probe). 2 calls per
input (stability), headless `claude -p`, context-free cwd.

**Inputs (6 × 2 = 12 calls):**
- Clean (gate must NOT fire — false positives are the killer):
  - E1 clean CSV: ISO dates, dot decimals (D-control reused)
  - E2 clean spectrum: two-column, x already in ascending cm⁻¹ 1000-3000,
    dot decimals, instruction = fit graphene G/2D (raman WITHOUT the trap)
  - E3 clean JSON config + instruction to extract a field
  - E4 clean server log + instruction to count errors
- Trapped (gate must fire):
  - T1 raman BLIND sample: instruction.md + head-20/tail-20 rows ONLY (no
    peak region, no operator knowledge) — also answers the sampler-design
    question
  - T2 ambiguous dates (C reused)

**Scoring (verdict line only, mechanical):**
clean input → NO MISMATCH correct; trapped input → MISMATCH correct.

**Decision rule:**
- CONTENT gate VIABLE iff: 0 false positives across the 8 clean calls AND
  ≥3/4 trapped calls fire.
- E2 is the hardest clean case (domain matches raman; data genuinely clean).
  A false positive ONLY on E2 (both calls) with 0 elsewhere → gate viable
  with a "domain-match overfiring" caveat, re-test after prompt tweak.
- T1 blind-sample result scored separately (informational): fires+names the
  axis trap → blind head/tail sampling suffices for lane A; fires without
  axis attribution or fails to fire → lane A sampler must include
  distribution stats (min/max/spacing summary), re-probe then.

**Spend:** 12 headless calls, authorized "1+2 parallel" go 2026-08-19.
