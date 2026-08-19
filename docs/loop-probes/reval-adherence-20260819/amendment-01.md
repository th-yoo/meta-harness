# Amendment 01 — pre-registration correction BEFORE any spend (2026-08-19, `yoo-dev`)

The original `pre-registration.md` was written as a gate **before** building the
revalidator parser ("probe adherence first, then decide the wire format"). The
increment-2 build then shipped (main `64c0a13`→`fbe48ec`) and **already imposed
one schema**. This amendment records the resulting deviations BEFORE any call is
spent, so the probe stays pre-registered rather than retro-fitted. N is unchanged
at **6 calls**.

## D1 — the two registers have collapsed; there is one shipped schema
Original design: **V-table** vs **V-block** × k=2, pick the wire format by
adherence. Moot — `convention-audit-prompt.txt` (`AUDIT_PROMPT_VERSION`
`lane-a-v3`) ships a single **hybrid** shape: the `REVALIDATION:` marker +
`TRANSFORM/CONSTANT/DELTA` header lines + a 4-column pipe table
(`| input | computed | canonical | discriminates |`). The live question is no
longer *which register* but **does sonnet adhere to the shipped schema**.

→ All 4 trap cells run the shipped `lane-a-v3` prompt verbatim. The
`V-table`/`V-block` arm is **dropped**, not silently reinterpreted.

## D2 — the original's provenance claim is FALSE (corrected)
Original: "sonnet via `claude -p` toolless (matches the gen4 fixture provenance
+ the shipped auditor's toolless tier)". The gen4 fixtures were **not** toolless:
`generator/generator-prompt-v2.txt` states *"You have shell access for
calculations"*, so gen4-r2's verified reciprocal table was **compute-backed**.
The shipped auditor is toolless by the daemon's security invariant (`tools: []`
in `AUDIT_ISOLATION`), which is exactly why `lane-a-v2` reframed the prompt to
*"You have NO code-execution tool … SHOW it inline"*.

→ gen4 is a **compute-backed ceiling, not a same-transport prior**. The
join-probe's "structured one-line demands complied 4/4" prior is likewise from a
different setup and is NOT carried in. Degradation vs gen4 is an expected
outcome, not an anomaly — measuring it toolless is the point.

## D3 — transport is the shipped path, not `claude -p`
Calls go through the shipped audit transport: `@th-yoo/cc-api-daemon`
`daemonCall` under `AUDIT_ISOLATION` (`tools: []`, `persistSession: false`,
`thinking: disabled`, `settingSources: []`), model `anthropic/claude-sonnet-5`
(`DEFAULT_BENCH_MODEL`), `ACP_TURN_TIMEOUT_MS=120000`. Measuring the deployed
transport is the only thing that can gate an arm of the deployed gate.

**429 blindness (carried from the transport memo):** `daemonCall` cannot report a
429 — it surfaces as a generic non-`ok`/ERROR outcome. Any ERROR cell is
therefore **excluded, never scored as a FORMAT failure**, until the daemon log is
checked. A transport pre-step (one throwaway trivial call) runs first; if it does
not come back `ok`, the probe aborts with **zero** measured cells spent.

## D4 — stimuli are real production sampler output (recorded)
Both cells are built by the shipped `buildSample()`, not by hand, so the model
sees exactly the production bytes (including the `first-col-range=[…]` line the
revalidator reads back).

| cell | tbRoot / task | bytes | `first-col-range` | sha256 |
|---|---|---|---|---|
| TRAP | `term-bench2/probe-tasks` / `raman-fitting-gate` | 5195 | `[1648.724404, 47183.554644]` | `715ab763…83f90e` |
| CTRL | `opencode-plugin/test/fixtures/conv-audit` / `clean` | 456 | `[1, 50]` | `9678d575…59ff2` |

`raman-fitting-gate` is used because `raman-fitting-audit`'s `instruction.md`
already carries a baked-in REFERENCE CARD — sampling it would feed the auditor a
prior card and contaminate the measurement. Verified card-free at build time.

**Cells:** TRAP × k=4, CTRL × k=2 = **6 sonnet calls** (unchanged total; the
k=2×2-register split is reallocated to k=4 on one schema).

## D5 — dry-run gate (satisfied before this amendment was written, zero spend)
`opencode-plugin/test/bench-reval-adherence-dryrun.test.ts`, 5/5 green, run
against the **real bytes** of `out-gen4-r{1,2}.json`:
- the parser reads both real pre-schema fixtures as `absent` (fail-closed — it
  never mines a claim out of unstructured prose);
- gen4-r2's own numbers transcribed into the imposed shape parse to a `claim` and
  `revalidate` **PASSES** (reciprocal 1e7: 19139.420→522.479 vs Si 520.7, Δ1.78;
  3745.339→2669.987 vs 2D 2700, Δ30.01; DELTA 35);
- gen4-r1's per-peak fitted constant (3.028e7 from x1→G) parses and is
  **REJECTED** `only-1-landed-under-one-constant`;
- `stripRevalBlock` leaves no block residue in the injected card.
Full suite: **2241 pass / 0 fail** (2242 incl. 1 skip). The pre-registered
requirement "offline parser green on real prior output" is met.

## Scoring — restated for the single-schema case (unchanged rungs)
- **FORMAT** = of 4 TRAP cells, the fraction whose raw output `parseRevalBlock`
  reads as `kind: "claim"`. `absent` / `malformed` / `none`-on-a-numeric-trap all
  score as non-adherence, recorded separately (the failure *shape* is the signal).
- **CONTENT**, over parsed claims only: (a) does every landing `input` **trace**
  to a number present in the sample (head/tail rows or the peak-finder lines) —
  untraceable = **GUESSED**, the sibling B2 class; (b) what does `revalidate()`
  return under the sample's real range?
- **CONTROL** = neither CTRL cell may emit a numeric claim. Expected
  `CONTENT VERDICT: NO MISMATCH` with `absent` or `TRANSFORM: none`.

## Pre-registered decision rule (single-schema)
- **FORMAT ≥ 3/4** → schema adherence adequate; the arm is not blocked on wire
  format (remaining pre-arm blocker stays the §10 anti-fabrication item).
- **FORMAT = 2/4** → one prompt-fix round on the emission clause, then re-probe;
  no arm on a coin-flip schema.
- **FORMAT ≤ 1/4** → structured emission is unreliable at the shipped toolless
  tier; fall back to parsing the inline prose arithmetic the model already shows,
  or defer the arm. (Explicitly a live outcome, given D2.)
- **CONTENT**: a parsed claim that `revalidate` REJECTS is the gate **working**,
  recorded as such — not a probe failure. Any **GUESSED** input makes the lane-A
  sampler's calibration-sweep block load-bearing (spec item, sibling's 5th
  fix-the-evidence instance) rather than merely banked.
- **CONTROL**: any spurious numeric claim on clean input re-confirms fail-closed
  on unparseable/unverifiable blocks (already adopted) and is reported.

## Unchanged from the original
Out of scope: end-task reward, compute transport (increment-3), haiku tier. The
**PRE-ARM HARDENING** item (spec §10 residual: head/tail near-match +
MISREADINGS cross-check — implement or accept-and-document) is untouched by this
amendment and remains a separate blocker with its own go.
