# Proposer loop + bullet Reviewer — design (2026-07-24)

Motivated by R4: a domain-level bullet (asyncio cancellation mechanics) passed the
proposer's own rule-3b self-check and reached a ~50-min experiment before the human
kill window caught it. The CRITIC lesson applies to the proposer itself: self-assessment
is not verification — the bullet needs an external, spec-grounded check before spend.

## 1. Flow

```
propose(evidence, harness, ledger) ──► bullet₀
                                          │
                 ┌────────────────────────┘
                 ▼
        review(bulletᵣ)  ──── PASS ──► stage candidate ──► experiment ──► gate (unchanged)
                 │
               FAIL(violations + artifacts)
                 │
       r < R?  ──yes──► revise(bulletᵣ, violations) ──► bulletᵣ₊₁ ──► review …
                 │
                no
                 ▼
        ABSTAIN — action coerced, candidate NOT staged,
        full review trail persisted as a finding
```

- `R` = max revision rounds, default **1** (initial + one revision, two reviews total).
- Revision keeps the DIAGNOSIS frozen — only the rule is reformed. The revision call
  gets: original bullet, its reason, the violations + reviewer artifacts, rule 3b, the
  ledger. It does NOT get the trajectories again (cheap, and prevents silent
  re-diagnosis mid-loop).

## 2. Reviewer seat (`minimal/review.ts`)

CLI: `bun minimal/review.ts <proposal.json> [--harness f] [--rejected f] [--task id]
[--driver opencode|claude-code] [--model id]`
Core logic exported as `reviewBullet()` so propose.ts imports it in-process; the CLI is
a thin wrapper for standalone use.

**Reviewer context: bullet + rubric + harness + ledger + task id. NO trajectories** —
the seat judges the rule, not the evidence, staying independent of the proposer's
diagnosis bias.

### Layer 1 — deterministic checks (code, free)

| check | rule |
|---|---|
| length | ≤ 60 words |
| form | trigger form (`When …, …`) or hard-gate form (`Do not … until …`) |
| leakage | bullet contains no task-id fragment, no path-like token, no quoted literal from the task id. Path-like (amended 2026-07-30 after a live false positive on "filters/qualifies"): known file extension, anchored slash (`./ ../ ~/ /abs`), 2+ slashes, non-alphabetic slash side, or a source-tree word side (`src/`, `docs/`, … — PATH_WORDS in `minimal/review.ts`). A single slash between two plain non-PATH_WORDS English words is prose and passes. **Accepted residuals (ruled 2026-07-30):** (a) a bare word/word path with both sides plain English non-PATH_WORDS (e.g. `kernel/gate`) passes layer 1, and layer 2 has no leak check; (b) prose pairs colliding with PATH_WORDS (`internal/external`, `public/private`, `build/verify`) are false-flagged — fail-closed, one revision round, and always flagged under the pre-amendment all-slashes rule; (c) multi-segment prose chains (`read/write/execute`) are false-flagged. All three documented trade-offs |

### Layer 2 — LLM rubric call (one small call, ~3k tokens)

The model fills a per-check object; **the verdict is computed in CODE as the
conjunction of checks** — the model never emits a bare pass/fail for the whole bullet.
Every check is evidence-forced: an artifact, not an opinion.

```json
{"checks": {
   "category":       {"pass": true,  "category": "verification-design", "quote": "..."},
   "domain_swap":    {"pass": true,  "swapped_bullet": "<bullet rewritten for a different domain — must parse>"},
   "behavior_level": {"pass": true,  "restatement": "<one sentence: what the AGENT does differently>"},
   "duplicate":      {"pass": true,  "match": "none|<quoted harness/ledger line>"}
 },
 "confidence": 0.9}
```

- `domain_swap`: reviewer must WRITE the swapped bullet (e.g. async→SQL). Unwritable
  or nonsensical ⇒ fail. This is the R4 killer.
- `behavior_level`: if the restatement describes what the CODE should do, fail.
- `duplicate`: must quote the matching current-harness/ledger line, or state none.
- `confidence` is advisory metadata only — never part of the pass condition.

**PASS ⟺ every layer-1 and layer-2 check passes. Fail-closed:** a false FAIL costs one
revision round (~2 small calls); a false PASS costs a ~50-min scope-invalid experiment.

## 3. propose.ts wiring

- Review ON by default; `--no-review` escape hatch; `--review-rounds N` (default 1);
  `--review-driver/--review-model` (default: proposer's driver/model; cross-model
  recommended for independence — both seats sharing one model = correlated bias).
- Every round appended to the proposal JSON:
  `review_trail: [{round, bullet, review}, …]` — the Zeller logbook, auditable.
- Final-fail ⇒ `action` coerced to `"abstain"`, reason `review-fail: <violations>`;
  the original propose intent stays in the JSON as a finding.
- Chain scripts unchanged: the existing `PROPOSER-ACTION != propose → stop` branch
  already handles review-abstain.

## 4. Invariants (unchanged)

1. Gate remains the SOLE adopter — the reviewer can only block/reshape spend.
2. Single-Rule delta preserved — revision reforms the one rule, never adds a second.
3. Rejected ledger untouched by the reviewer; entries gain optional `reviewOutcome`.
4. Scorer→Agent = ∅ at runtime: reviewer sees no scorer source, no trajectories.

## 5. Seat kill criterion (pre-registered)

The reviewer must earn its seat the way bullets do. Ledger tracks
(review outcome → gate outcome) pairs. After 5 gated bullets under review: if
review-passed bullets null/reject at the gate at the same rate as the pre-reviewer
baseline (3/3 rejects so far), the seat adds nothing measurable → remove it.
Secondary metric: at least one review-FAIL that a human agrees was a true scope
violation (R4-class catch) also justifies the seat.

## 6. Escalation path (NOT in v1)

Borderline flip-flops (same bullet passing/failing across runs) → 3-vote
unanimous-on-domain-swap, adversarial-verify style. Only if measured need; kernel
minimalism — the seat starts as one call.

## 7. Proposer backlog (scheduled 2026-07-24, ranked; do after the placement verdict)

1. ~~Placement power~~ — IN FLIGHT as R7: R3's bullet verbatim in the SYSTEM
   slot (content held constant, channel = the one variable). Decides whether
   "prose exhausted" was about content or channel.
2. Actuator-aware proposals — proposer emits completion-gate CHECK SPECS
   ("done requires: X ran and passed") once the binding actuator exists;
   immune to instruction decay. Blocked on the actuator build.
3. Timeout/void blindness — suspect/0-turn trials are dropped from evidence;
   proposer cannot diagnose timeout classes (ledgered blind spot).
4. Review-trail feedforward — feed past rounds' review trails (not just final
   ledger verdicts) into the initial propose call; preempts round-0 duplicates.
5. True reviewer diversity — different model FAMILY for the reviewer (both
   seats are opus today; correlated weights = correlated blindness).
6. Deferred until a residual is prose-reachable again: best-of-N + judge
   panel, traj-cap tuning, calibration formalization.

## 8. Tests (TDD, with the main suite)

`opencode-plugin/test/minimal-review.test.ts`: layer-1 checks (length/form/leakage);
verdict-conjunction (model says pass, code says fail); revision-loop control with an
injectable runner (pass-first-round, fail-then-pass, fail-fail→abstain); trail
persistence; `--no-review` bypass.
