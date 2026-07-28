# kkamak scorecard — pre-registration (2026-07-28)

**Status:** DRAFT — definitions below are fixed BEFORE the data is looked at.
**Purpose:** turn the `.km/gate-outcomes.ndjson` sensor stream into a
measurement, so a mechanism change (§4.4) has something to move.

## 0. The question this does and does not answer

It answers: **is kkamak getting less wrong and less annoying over time?**
It does NOT answer: *is kkamak worth running?* — that needs a counterfactual
(what the agent would have shipped with no gate) which the sensor cannot
observe. See §4.

## 1. Unit of analysis

One **cycle** = one sensor line, except: lines with `rounds: []` are km-gauge
shadow lines fabricated on a fast-path Stop (no gate cycle ran) and are
EXCLUDED from every gate metric. They feed the gauge metrics only.

Cycle taxonomy (mutually exclusive, in this precedence order):

| Class | Predicate | Meaning |
|---|---|---|
| `interrupted` | `interrupted === true` | user preempted an open cycle |
| `exhausted` | `gateExhausted === true` | rounds budget spent, auto-allowed |
| `catch` | last round `accepted` AND ≥1 earlier `verify-failed` | gate blocked, agent fixed, converged |
| `clean` | `rounds === ["accepted"]` | nothing was wrong |

`accepted` is true on BOTH `catch` and `exhausted` lines (schema parity with
the opencode plugin), so `accepted` alone must never be read as success.

## 2. Metrics

Over gate cycles only, reported per `(check, host)` group and pooled:

- **M-catch** = catch / (catch + clean + exhausted). The value event.
- **M-exhaust** = exhausted / (catch + clean + exhausted). Gate failed to
  converge. **Ambiguous by construction**: either the gate was wrong (false
  block) or the agent could not fix it. Not separable from the sensor alone;
  only ever reported, never interpreted as one or the other.
- **M-interrupt** = interrupted / all cycles. Gate was in the way.
- **M-tax** = median `durationMs` over `clean` cycles — the cost paid when
  nothing was wrong. Median, not mean: SM2 showed `durationMs` inflates with
  human approval wait, so the tail is contaminated.
- **M-rounds** = distribution of `rounds.length` over `catch` cycles.

## 3. Grouping — kkamak-dev data reports SEPARATELY

Cycles are grouped by the `check` string (a proxy for repo+config) and
`host`. The meta-harness/kkamak repo's own check is a distinct value, so
**kkamak-dev cycles never pool with real-work cycles by default.** This is
deliberate: on this repo the agent is editing the gate itself, and derived
checks/blocks there are unrepresentative (the §4.3 workload confound in
miniature). Pooling requires an explicit flag and must be stated in any
claim.

## 4. What counts as an improvement claim

**Claimable from this data alone:** a fall in **M-exhaust** or **M-interrupt**
at non-decreasing **M-catch**, within a `(check, host)` group. Neither needs
a counterfactual — they measure kkamak being wrong or annoying.

**NOT claimable:** any statement about M-catch in isolation, or about
kkamak's value. M-catch moves with workload (how often the agent breaks
things), not only with kkamak. Attributing it requires §4.3 trial mode.

**Power:** single-user data. Loop-1 reached a provable null after a large
spend; assume these rates are underpowered for months. The scorecard reports
counts alongside every rate, and refuses to print a rate below `MIN_N`
cycles (default 20) — a rate over 6 cycles is noise wearing a percentage
sign.

## 5. Non-goals (v0)

No time-series/regression. No significance testing (counts only — the
project's SPRT-spec rule applies: no p-values without a pre-registered
sequential design). No automatic adoption; the scorecard informs, `gate.ts`
remains the sole adopter. No writes — read-only over the sensor.
