# Lane A — increment-2: mechanical propose-verify revalidator (design)

**Status:** design, 2026-08-19, `yoo-dev`. Architectural. Two code-architect
reviews absorbed. Deterministic core is buildable with ZERO bench/model spend
(TDD over fixtures); the adherence probe + first arm are separate spend gos.
**Depends on:** increment-1 (SHIPPED, `a97156a`) — the convention-audit staging
step, OFF by default.
**Evidence base:** `docs/loop-probes/rep-audit-20260819/verdict.md` (the
propose-verify split, Sibling round-5, lines 389-396/452), the two golden cards
`.../generator/out-gen4-r{1,2}.json`, and the offline algorithm dry-run
(gen4-r2 PASS 2/2, gen4-r1 REJECT 1/2 under one fixed constant).

## 1. Purpose
Before a NUMERIC convention card is injected, the harness deterministically
re-checks the card's own claimed transform and rejects the "confident-wrong"
class (gen4-r1: per-peak fitted constants that never jointly land). This is the
#1 arming blocker: increment-1's caveat 2 says "do not arm before increment 2."
Injection gate becomes **`CONTENT MISMATCH ∧ revalidation ∈ {PASS, N/A}`**.

## 2. Grounding (measured, not assumed)
- **Algorithm** (dry-run, zero spend): apply the card's claimed transform with
  ONE fixed constant to its claimed input peaks; require ≥2 land within the
  claimed Δ of their canonical refs. gen4-r2 reciprocal `1e7/x` lands 522.5
  (Si 520.7, Δ1.8) and 2670.0 (2D 2700, Δ30) simultaneously → PASS. gen4-r1's
  per-peak constants (k=3.028e7 vs 5.168e7) never jointly land → REJECT (1/2).
- **Wire format = pipe-table** (the model's natural register): both gen4
  fixtures, unprompted, emitted a markdown transform table — but with
  DIFFERENT free-form columns. So the prompt must IMPOSE a fixed column
  schema; adherence to the imposed schema is the one unmeasured quantity →
  the pre-arm adherence probe (§9).
- **Structured-emission complies** (sibling `meta-harness-1e` join-probe,
  2026-08-19, 4 sonnet calls): a one-line structured-emission demand complied
  4/4. Prior: imposed-schema adherence is high; the probe confirms for the
  raman table specifically.
- **Cards guess params the evidence doesn't carry** (sibling B2, same probe):
  a card invented `cell=2mm` (confident-wrong) where the sample carried no
  component-count evidence; cards calibrated CORRECTLY where the sample's own
  counts made the value derivable. → the sampler calibration-sweep contract
  (§7), the generative half of this gate.

## 3. Architecture
All in `opencode-plugin/src/bench/convention-audit.ts` (+ its prompt + test).
No new module; no compute transport (that is increment-3). Pure, testable fns:

```
type RevalTransform = "reciprocal" | "scale" | "offset" | "identity"
interface RevalLanding { input: number; claimed: number; canonical: number; discriminates: string }
interface RevalClaim { transform: RevalTransform; constant: number; delta: number; landings: RevalLanding[] }

type ParsedReval =
  | { kind: "none" }                    // EXPLICIT "no numeric claim" — criteria-class
  | { kind: "absent" }                  // header/table missing on a MISMATCH — FAIL-CLOSED
  | { kind: "malformed"; raw: string }  // present but unparseable — FAIL-CLOSED
  | { kind: "claim"; claim: RevalClaim }

parseRevalTable(raw): ParsedReval                 // pure — parses the imposed pipe-table schema
stripRevalTable(raw): string                      // pure — removes the table for injection
revalidate(claim, sample): {ok:true} | {ok:false; reason}   // pure
```

- **Transforms (closed whitelist, single constant, NO eval):** `reciprocal`
  `C/in`, `scale` `C*in`, `offset` **`C − in`** (pinned; both fixtures use
  laser-line subtraction — signed-both is dropped, it doubles false-match
  surface), `identity`.
- **`revalidate`:** apply `transform(input, THE ONE constant)` per landing;
  require ≥2 within `delta` of `canonical` under that single constant — this
  **one-fixed-constant test is the PRIMARY guard** (it is what rejects gen4-r1).
  **Anti-fabrication (defense-in-depth, explicitly partial):** (a) each `input`
  within the sample's `first-col-range`; (b) each `input` near-matches a number
  in the sample's head/tail-20 text where present — PARTIAL by construction:
  head/tail catch the extreme peaks (raman is x-sorted) but miss mid-file peaks,
  because the shipped sampler emits no peak list (full peak-list anti-fabrication
  needs the deferred sampler peak-emission, §7/§9). The weight against the
  reverse-solve hole is therefore carried by (a) + the one-fixed-constant test +
  the misreading-tie below, not by (b) alone. If `first-col-range` is unavailable
  (post comma-decimal fix) → `reval:"FAIL"` reason `range-unavailable`
  (fail-closed, NOT graceful).
- **seam→misreading tie:** every landing row names which MISREADING (from the
  card's own MISREADINGS section) it discriminates (the `discriminates`
  column). A fabricated landing has no real misreading to cite — the
  padding-kill from the sibling's seam-depth datum, reused as fabrication-kill.

## 4. Injected bytes — STRIP the table
Today `cardFrom(raw)=raw.trim()` (`:179-181`) injects the whole audit verbatim.
The table must be **parsed but never injected**: `cardFrom` returns only the
human SURFACE/CONTENT/MISREADINGS prose (via `stripRevalTable`). Two reasons:
(1) leak/byte discipline (host-internal verification state ≠ agent-directed
prose); (2) stronger — a bare `constant`/`landings` in the instruction invites
the agent to PARROT it as an answer key, regressing the arm-1/arm-2 finding
that the actuator is the agent's own empiricism. The prompt therefore keeps the
falsifiable-prediction numbers in the PROSE body too (redundant with the
table), preserving the "test this transform, watch both land" framing that
arm-2/arm-3 proved is the actuator (mechanism 6/6).

**strip rule:** first whole-line match of the table header
(`/^\s*\|?\s*transform\s*\|/im` anchored), strip to end-of-string; bias toward
OVER-stripping (a table leak into the SUT is worse than losing trailing prose).
The prompt instructs the table is LAST, nothing after it.

## 5. Gate wiring
Widen `AuditResult` so a MISMATCH verdict may carry `card:null`:
```
| { card: string; rawAudit; verdict:"MISMATCH"; reval:"PASS"|"N/A"; sample; truncated }
| { card: null;   rawAudit; verdict:"NO_MISMATCH"|"ERROR"|"MISMATCH"; reval?:"FAIL"; revalReason?; sample; truncated }
```
Insert parse+revalidate right after the `cardFrom` call in `runAuditUncached`
(restructure the two `return`s at `:285-286` into an intermediate binding —
mechanical, not a one-line splice). Inside the single-flight cache already, so
no new concurrency. `writeAuditTrail` (`:305-317`) gains `reval`/`revalReason`
(additive ndjson; pre-increment rows lack them → downstream treats missing as
"not evaluated"). **No call-site changes** — `cmd-run.ts:470` `card = r.card ??
""` already handles any `card:null`. Bump `AUDIT_PROMPT_VERSION` in the SAME
change as the prompt (cache is task-keyed + process-scoped → the version and
prompt are inherently build-coupled; no cache-invalidation work needed).

## 6. Fail-closed contract (the headline correctness rule)
Only an EXPLICIT "no numeric claim" declaration → `none` → criteria-class →
inject on content gate alone (elf path, validated 5/5). Header/table ABSENT on
a MISMATCH verdict is `absent`, NOT `none` → **no injection**. Otherwise a
numeric confident-wrong card evades by simply omitting the table. `malformed`
(present but unparseable / unknown transform / <2 landings) → no injection.
Every fail-closed outcome is audit-trailed with its reason.

## 7. Sampler calibration-sweep contract (banked from sibling, generative half)
The lane-A sampler (`buildSample`/`summarizeFile`) contract gains, for the
per-format structure profile: **calibration sweeps for any predicate family a
card may parameterize** — so the card DERIVES the parameter instead of guessing
it (sibling B2's `cell=2mm` class; 5th fix-the-evidence instance). Full sampler
contract of record: structure profile + affine-dependence + spacing family +
eigenvector loadings + calibration sweeps.
**Build scope for increment 2:** the sweep block (and peak-list emission) are
CONTRACT-OF-RECORD, deferred to their own follow-up — they are the GENERATIVE
half (reduce guessing at card-generation) and are NOT required for the
defensive revalidator gate to function or to unblock arming. This increment
BUILDS only the **comma-decimal prerequisite fix** below (the one sampler change
the §3 range check actually needs). General per-domain sweeps are increment-3.
**Prerequisite bug fix (blocks §3 anti-fabrication):** `summarizeFile`
(`:105-111`) uses bare `Number()` → `NaN` on EU comma-decimals (the raman
locale), silently disabling `first-col-range`. Normalize comma-decimals before
`Number()`.

## 8. Testing (TDD, unit-first, no live model)
- `revalidate`: hand-transcribed claims from gen4-r{1,2} → r2 PASS, r1 REJECT
  (label the fixtures explicitly as hand-authored translations of measured
  algorithm behavior, NOT evidence of live prompt-adherence — that is the
  probe's job).
- transform primitives: pure unit tests (incl. `offset` = `C − in`).
- `parseRevalTable`: 4-way return over ADVERSARIAL fixtures — well-formed
  table; explicit no-claim (`none`); header-absent-on-MISMATCH (`absent`);
  missing/empty landings, unknown transform keyword, unparseable constant
  (`malformed`). Fixture-adequacy is a review gate, not implicit.
- `stripRevalTable`: injected card never contains table tokens even when the
  raw body does (mirrors the byte-identity style at
  `test/bench-convention-audit.test.ts:120-140`); adversarial: trailing prose,
  repeated header, mid-answer table.
- gate wiring via the existing `deps` seam (`test/...:61-75`, no live model):
  MISMATCH+PASS→card present; MISMATCH+FAIL→card null+reason; MISMATCH+absent→
  card null; MISMATCH+malformed→card null; explicit none→criteria-class inject
  (no regression to elf path).
- `summarizeFile` comma-decimal fix: `Number("47183,554644")` path yields a
  numeric range.
- regression: the existing `runAgent` byte-identity test unchanged.

## 9. Scoped OUT of increment 2 (own gos)
- **Adherence probe** (`docs/loop-probes/reval-adherence-20260819/pre-registration.md`):
  6 sonnet `claude -p` calls, rung-separated (FORMAT/CONTENT/CONTROL). A
  **pre-arm gate** — the deterministic core ships first; the probe validates
  the imposed-schema adherence + derive-vs-guess before the FIRST measured arm.
- Compute transport for the auditor (increment-3).
- General per-domain sampler sweeps beyond the raman/numeric family.
- Any board wiring / auto-running in the loop; haiku-tier.

## 10. Readiness caveats (on the record)
1. Imposed-schema adherence is UNMEASURED until the §9 probe; fail-closed means
   any adherence miss = silent suppression of unknown rate. The probe is a
   mandatory pre-arm gate, not optional.
2. Anti-fabrication is defense-in-depth, not a proof; a card that both derives
   real sample peaks AND finds one constant landing ≥2 on textbook canonicals
   is, by construction, a correct card. The residual is a card citing a real
   pair under a coincidental constant — bounded by the head/tail near-match +
   misreading-tie, accepted for this increment.
