# a3 rule routing — checked rules on the stop-gate carrier (2026-08-13)

Status: DRAFT (brainstorm-approved sections; architect round-1 findings
applied — see §8 revision log)

Successor to the P2 actuator-binding probe. P2's adoption ruling
(2026-08-13, resume.md; verdict `docs/loop-probes/p2/yoo-mac.local-p2-verdict.json`)
ROUTED a3 — the in-container Stop-hook gate (exit 2 + mechanical check) —
as the eligible rule-delivery carrier. Per P2 spec §5, "earns routing"
deployed nothing; THIS design is the deployment: proposer→actuator
routing for rules that admit a mechanical check.

## 0. Rulings (brainstorm Q&A, 2026-08-13, user)

1. Consumers: BOTH the TB2 evolution loop and live dogfood sessions
   (user chose (c) over TB2-only). Cost acknowledged: two consumers =
   two instrument boundaries; sensor/record separation per consumer.
   Build order: TB2 adapter first, live adapter second.
2. Live-side mechanism: EXTEND the kkamak gate (option (a)) — rule
   checks ride the existing installed Stop hook and the one
   `.km/gate-outcomes.ndjson` stream. NO second settings.json hook
   (double-gating: two exit-2 sources, un-attributable blocks).
3. Check authorship: STAGED (option (c)). Proposer emits bullet +
   draft check; TB2 trial arms take checks immediately (the ab gate is
   the empirical validator); live takes the same check SHADOW-FIRST,
   blocking only after a per-rule promotion go. Review-gate layer-1
   gains deterministic check screens; no LLM judgment on checks.
4. Check storage: BULLET SCHEMA EXTENSION (option (a)) — optional
   `check` field on the playbook bullet, no separate registry.

## 1. Contract — CheckedRule

Playbook bullet schema (harness-store) gains one optional field:

```jsonc
{
  "text": "…rule text…",          // existing
  // …existing bullet fields…
  "check": {                       // OPTIONAL — absent = prose-only
    "cmd": "…",                    // mechanical verification command
    "timeoutMs": 30000,
    "state": "shadow" | "blocking", // live-consumer state; TB2 ignores
                                    // (trial arms always enforce)
    "liveEligible": false           // SCREEN-STAMPED (§2 Tier L), never
                                    // proposer-set
  }
}
```

EMISSION INVARIANTS: proposer-emitted checks are ALWAYS
`state: "shadow"`; the review gate rejects a proposal carrying
`state: "blocking"` (blocking is a post-shadow promotion state, §4).
`liveEligible` is written by the screen, never by the proposer.

- Absent `check` = today's bullet, byte-compatible: every existing
  playbook, candidate, snapshot and rejected.json parses unchanged.
- SCHEMA PLUMBING IS REAL WORK, named here (round-1 finding 8): the
  `PlaybookOp` add/update variants, `applyPlaybookOps`, the propose
  artifact parser, and `reviewAddedBullets`' `bullets: string[]`
  signature are all TEXT-ONLY today. The plan must thread a structured
  bullet (text + optional check) through proposer output → review gate
  → PlaybookOp → store. Layer-1 text checks (`minimal/review.ts`)
  keep operating on `text`; check screens are a NEW parallel layer-1
  stage on the structured field.
- F2: check text lives in playbook.json (store), never in
  gate-outcomes.ndjson. Sensor lines and TB2 record annotations carry
  OUTCOMES only (rule id, pass/fail, ms) — no command text.
- F2 OPEN RULING (round-1 finding 5): rejected.json is re-read into
  every future proposer prompt — a permanent exposure surface; the
  2026-08-09 sidecar exception does NOT cover it. Until the user rules,
  a check-rejected bullet is ledgered with its TEXT plus a check
  VERDICT SUMMARY only (e.g. `check: screen-denied (network)`), never
  the command text.
- One check per bullet (multi-check = explicitly-not-now §6).
- PROVENANCE (round-1 finding 2): `harnessHash` hashes the RENDERED
  MARKDOWN (bullet text lines only) and structurally cannot cover
  `check` — do not extend it. New identity field `checksHash` =
  sha256 over `canonicalChecksJson(checks)` — a NAMED helper: array
  sorted by bulletId, objects serialized with FIXED key order
  (bulletId, cmd, timeoutMs); no ad-hoc JSON.stringify (the FNV-1a
  bit-parity incident is the precedent for naming this). Stamped into
  the run/ab env block beside `harnessHash` and included in the ab
  verdict.
  LEGACY COALESCING (round-2 finding 1): define the constant
  `EMPTY_CHECKS_HASH = sha256(canonicalChecksJson([]))`. A zero-check
  candidate stamps EXACTLY this value, and budget-identity comparison
  coalesces an ABSENT field to EXACTLY this value — absent = legacy =
  zero checks = EMPTY_CHECKS_HASH, all four equal, test-pinned.
  Otherwise every ordinary zero-check candidate ab'd against a
  legacy baseline would budget-mismatch at /mh-activate (the dominant
  near-term case).
  DELIBERATE EXCLUSION (round-3 finding 2): `canonicalChecksJson`
  serializes ONLY `(bulletId, cmd, timeoutMs)` — `state` and
  `liveEligible` are EXCLUDED from the identity hash ON PURPOSE: TB2
  enforces regardless of either, and including them would mint
  spurious budget-identity mismatches when promotion later flips
  `state`. Do not "complete" the serializer.

## 2. Proposer + review gate

- Proposer contract: MAY emit `check` alongside a bullet. Rule 3b
  unchanged — the check verifies the BEHAVIOR the bullet mandates
  (e.g. "a verification command ran before done"), never domain
  assertions. Prompt addition states the check is optional and that
  unverifiable rules stay prose-only (no forced check invention —
  gauge-M2 lesson: invention beyond the information bound).
- Review gate layer-1 gains deterministic check screens, TWO TIERS
  (round-1 finding 3 — live executes shadow checks in the user's REAL
  repo, so live eligibility is guard-strict):
  - **Tier B (bench-eligible):** parseable, non-empty, timeout within
    bounds; DENY store paths (`.kkamak`, `.km`, `term-bench2/store`),
    network use, package installation, destructive patterns reaching
    outside the task workspace. Workspace writes ALLOWED (disposable
    container; TB2 verifiers write there too).
  - **Tier L (live-eligible):** Tier B AND passes the SAME policy as
    `cc-gate-plugin/src/gauge/guard.ts` `unsafeReason()` — the proven
    screen for model-generated shell executed with user permissions in
    a real repo (deny rm/mv/cp/chmod/dd, in-place edits, any
    redirection except /dev/null, mutating git/package subcommands,
    eval/exec, even workspace-scoped).
    PLACEMENT DECISION (round-2 finding 4 — "shared or vendored" was
    not a decision): RELOCATE `unsafeReason()` to `minimal/guard.ts`
    (the shared-kernel home). cc-gate-plugin VENDORS a byte-copy per
    the existing vendor/ pattern and ADDS it to
    `self-contained.test.ts`'s byte-identity list; opencode-plugin's
    Tier L screen imports `minimal/guard.ts` directly (precedent:
    `review-gate.ts` importing `minimal/review.ts`). No cross-plugin
    runtime import in either direction (reimplement-not-import policy
    respected via the kernel relocation).
  - Screen result stamps the bullet: fails Tier B → bullet REJECTED,
    ledgered (verdict summary only, see §1); passes B not L →
    `liveEligible: false` recorded on the check — rides TB2 arms,
    NEVER evaluated by the live adapter; passes both →
    `liveEligible: true`.
- No LLM review of check semantics: the empirical validators are
  downstream (TB2 ab grader; live shadow evidence).

## 3. TB2 adapter (build FIRST) — claude-code driver ONLY

Generalizes P2's a3 assets (`assets/stop-gate-settings.json`, the
exit-2 lesson from C1, per-attempt injection).

- **DRIVER SCOPE (round-1 finding 1):** the Stop-hook carrier exists
  only for the `claude-code` driver (`claude -p` fires Stop hooks —
  P2 PROBE C proved it in this container recipe). The DEFAULT TB2
  driver is opencode, whose in-container batch `opencode run` has NO
  hook mechanism — the carrier is structurally inapplicable there.
  RULE: a run/ab/trial invocation whose candidate carries checked
  bullets REFUSES to start (loud, names the bullet) unless
  `--driver claude-code` is set (one driver flag governs both arms —
  cmd-ab has no per-arm driver). No silent degrade, no inert-file
  injection. INSERTION POINT (round-2 finding 7): the refusal runs
  immediately after `readPlaybook` / harness assembly resolves the
  candidate's checked bullets and BEFORE `inContainerAgentVersion()`
  — the existing die-check location would burn a throwaway container
  first; this one is genuinely pre-container. Checked-rule evolution
  therefore runs on the claude-code driver lane; prose-only
  candidates are unaffected on either driver.
- When a trial/ab arm's candidate playbook contains checked bullets,
  the runner builds an in-container `.claude/settings.json` Stop-hook
  gate from those checks: on Stop, run each check; any failure →
  exit 2 with the failing check's stderr/stdout as evidence;
  all-pass → allow.
- **ROUND BOUND (round-1 finding 7):** P2's static asset had NO round
  cap (wall-clock only) — not a precedent to reuse. The injected gate
  carries its OWN persisted round counter (state file inside the
  container workspace), cap = 2 blocks per Stop cycle mirroring
  cc-gate-plugin `rounds` semantics; at cap → allow + record
  `gateExhausted` in the annotation. Consumers stay behaviorally
  parallel.
- **INJECTION SYMMETRY (round-2 finding 2 — playbooks are CUMULATIVE
  snapshots, so "candidate-arm-only" would permanently handicap every
  future candidate with previously-adopted foreign checks):** the
  enforced set is computed per ARM from that arm's OWN playbook —
  the ACTIVE arm enforces the active playbook's checked bullets, the
  CANDIDATE arm enforces the candidate playbook's. Both sets are
  injected (per-attempt `podman cp`, never baked into the shared
  bench image — P2 fresh-review Important 2). The DELTA UNDER TEST is
  therefore exactly the candidate's new/changed checks, mirroring how
  prose bullets already work (both arms carry the inherited playbook;
  the candidate differs by its addition). First checked-rule ab has
  active set = empty, so it degenerates to candidate-only injection.
  Each arm's `checksHash` covers its own enforced set.
  Single-harness `run` (no arm split; round-3 finding 3): degenerate
  case — the one assembled playbook's checked bullets are the
  enforced set; same injection, same driver refusal, no second arm.
- Candidate = rule + carrier BUNDLE; the active arm runs its OWN
  unmodified playbook (checks included once any are adopted).
  **ATTRIBUTION CAVEAT (round-1 finding 6, pre-registered like P2's
  computeBonusCaveat):** the bundle adds a second failure axis (the
  check itself — bugs, false blocks, timeouts). A checked-candidate
  verdict CANNOT attribute a regression between "bad rule" and "bad
  check"; every checked-rule ab verdict carries a
  `checkBundleCaveat` string stating exactly that, plus the per-rule
  block/exhaust counts that make a check-implicated regression
  visible. Optional diagnostic (own sized go, never automatic): re-run
  the candidate PROSE-ONLY (checks stripped) as a check-ablation arm.
- Instrument: the first checked-rule ab stamps a boundary ts in the
  adoption ledger. `checksHash` (§1) rides the env/identity block.
- Record: per-attempt annotation gains `ruleChecks` (rule id, rounds,
  blocked count, gateExhausted, final state) parallel to P2's a3
  fields.

## 4. Live adapter (build SECOND) — kkamak gate reads an exported file

**PLUMBING (round-1 finding 4 — designed, not assumed):**
cc-gate-plugin is standalone and knows nothing of store layers; it
stays that way. The bridge is a FILE CONTRACT, meta-harness-side
producer:

- **Producer (round-3 finding 1 — NOT activation-only):** the export
  is a `writeActive`-ADJACENT SIDE EFFECT: every `writeActive` call
  site that carries a playbook, PLUS `resolveTrial`'s confirm branch
  (playbook already live there — the export must still be reaffirmed,
  not skipped), (re)writes `.km/rule-checks.json`. Code-verified
  surface: `activateCandidate`
  (account path, /mh-activate), `startTrial` (project-layer proposer
  pipeline — makes the trial playbook live IMMEDIATELY),
  `resolveTrial` both branches (confirm clears trial with playbook
  already live — export must be re-derived, not skipped; revert
  restores baselinePlaybook), and `resolveGateTrial` rollback/abandon
  branches. `cmdRolesImport` passes a null playbook — no export
  needed but harmless to route through the same helper. Implementation
  shape: one `exportRuleChecks(repoRoot, activePlaybook)` helper
  called wherever the active playbook changes — NOT scattered
  re-implementations. File: `.km/rule-checks.json` `{version,
  writtenTs, rules: [{id, cmd, timeoutMs, state}]}`, containing ONLY
  `liveEligible: true` checks from the now-active playbook; empty
  rules array when none. Gitignored, host-local, EXCLUDED from
  km-sensors-sync FILES (test-locked — code-bearing text; F2
  discipline). Trial semantics note: a project-layer TRIAL arm's
  checked bullets therefore shadow-evaluate live during the trial —
  that is by design (shadow is observation-only and is exactly the
  evidence stream §4.3-style promotion needs).
- **Consumer:** the kkamak gate (cc-gate-plugin hook path) re-reads
  `.km/rule-checks.json` per hook call exactly like gate.json (locked
  re-read invariant). Absent file ⇒ byte-identical behavior,
  test-pinned. Present: after the existing gate.json check flow,
  evaluate each rule check and append outcomes to the SENSOR LINE
  (new OPTIONAL field `ruleChecks: [{id, pass, ms}]` — outcomes only,
  F2-clean). SHADOW: never blocks, never reinjects.
- **SHADOW COST BUDGET (round-2 finding 3 — the two-tier gate-check
  work exists precisely to keep Stops fast; shadow must not undo
  it):** hard caps, enforced by the consumer: at most
  `RULE_CHECKS_MAX = 8` rules evaluated per Stop (file order; excess
  recorded `skipped`), and an AGGREGATE wall budget
  `RULE_CHECKS_BUDGET_MS = 5000` per Stop — each check runs with
  `min(check.timeoutMs, remaining budget)`; budget exhausted ⇒
  remaining rules recorded `skipped`, never run. Skips appear in
  `ruleChecks` as `{id, skipped: true}` so starvation is visible in
  the stream, not silent. Constants live beside the gate's other
  config defaults; raising them is an instrument change (boundary
  ts).
- **Defense in depth:** the consumer re-runs the guard.ts screen on
  each cmd at evaluation time (the file is host-local and editable —
  the screen at review time is not sufficient provenance); a cmd
  failing the runtime screen is recorded `refused`, not executed.
  Gauge read-only-guard precedent.
- **SensorLine contract (round-1 finding 4b):** `ruleChecks` is an
  addition to the FROZEN contract shared by cc-gate-plugin and
  ~/z2/kkamak's conformance suites. The change ships as a coordinated
  contract rev: golden vectors updated in BOTH repos in the same
  change window, absent-field back-compat pinned (old lines parse
  forever), per the item-10 consistency rules. ENFORCEMENT CAVEAT
  (round-2 finding 6): the existing cross-repo parity test SKIPS with
  a console notice when the kkamak fixture is absent — it is advisory
  on hosts without a kkamak clone (yoo-mac has none). Therefore this
  contract rev is VERIFIED ON yoo-dev (where ~/z2/kkamak exists), and
  the change window includes upgrading that skip to a HARD FAIL for
  the `ruleChecks` vector specifically, so the rev cannot land
  half-updated silently. Real cross-repo work, costed in the plan.
- `state: "blocking"` is honored ONLY after a per-rule user promotion
  go, backed by §4.3-style evidence (shadow pass/fail history at
  MIN_N-class floors; spurious-block bar per the 7d ladder). Promotion
  mechanics = separate design; this spec ships shadow only.
- F1/instrument discipline: cc-gate-plugin change ⇒ version bump in
  the SAME change (merging ≠ deploying), boundary ts in the adoption
  ledger, both-host cache refresh, suite proven in the extended state.

## 5. Order, probes, testing

1. TB2 adapter: TDD; before any spend, probe-the-consequence — a real
   claude-code-driver container with an injected failing check must
   BLOCK a `claude -p` Stop (P2 PROBE C pattern: num_turns delta +
   unprompted fix) AND the round cap must be observed (2 blocks →
   exhausted-allow). ≤4 haiku calls, own sized go.
2. Live adapter: TDD against the SensorLine contract rev (§4); shadow
   invariant test-locked (would-block ⇒ exit 0, no block payload);
   absent-file byte-identity test; runtime-screen refusal test.
3. First production use: next crank's candidate that carries a check
   rides the TB2 adapter on the claude-code driver lane; its ab
   verdict (with checkBundleCaveat + checksHash) is the carrier's
   first production datum. Live shadow accumulates silently after
   any playbook-mutating store transition (activation, trial start,
   trial confirm/revert, gate-trial resolution) writes the export.

## 6. Explicitly not now

- TB2 OPENCODE-DRIVER arms for checked rules (round-1 finding 10:
  named as the in-scope exclusion — the carrier is structurally
  claude-code-only; opencode-driver checked-rule delivery would need
  a different chokepoint and is NOT designed here).
- Auto-promotion shadow→blocking (needs its own pre-registration).
- Multi-check bullets; check composition.
- Live opencode-plugin session gating (distinct from the bench driver
  above; opencode plugin untouched).
- Check evolution by the loop itself.
- Cross-host trial-state transfer (separate A/A ruling pending).

## 7. Success criteria

- A checked-rule candidate flows propose → review (screens, tiers) →
  trial ab on the claude-code driver (gate enforced in candidate arm,
  round-capped) → verdict carrying `checksHash` + `checkBundleCaveat`
  + per-rule `ruleChecks`, end-to-end, active arm untouched.
- A checked-rule ab attempted on the opencode driver REFUSES loudly
  pre-container.
- EVERY playbook-mutating store transition (activation, trial start,
  trial confirm/revert, gate-trial resolution) writes
  `.km/rule-checks.json` (live-eligible checks only) — the §4
  producer surface, not activation alone; live sessions emit
  `ruleChecks` shadow outcomes with zero behavior change; absent
  file = byte-identical (test-pinned).
- Removing every `check` field reproduces today's behavior in both
  consumers (back-compat pinned by test).

## 8. Revision log

- r1 (2026-08-13): architect round-1 FIX-FIRST applied — driver scope
  narrowed to claude-code with loud refusal (F1); harnessHash claim
  retracted, `checksHash` added (F2); two-tier screens reusing
  guard.ts `unsafeReason()` for live eligibility (F3); live plumbing
  designed as activation-written `.km/rule-checks.json` file contract
  + runtime re-screen (F4); rejected.json F2 exposure = OPEN RULING,
  verdict-summary-only until ruled (F5); checkBundleCaveat +
  optional check-ablation arm (F6); explicit round cap 2 +
  gateExhausted, P2-bound claim corrected (F7); schema plumbing named
  as real work (F8); whole-proposal phrasing dropped (F9); TB2
  opencode-driver exclusion named in §6 (F10).
- r2 (2026-08-13): architect round-2 FIX-FIRST applied —
  `EMPTY_CHECKS_HASH` constant + absent-coalescing rule (F1);
  per-arm own-playbook injection symmetry, delta = candidate's new
  checks (F2); live shadow caps RULE_CHECKS_MAX=8 +
  RULE_CHECKS_BUDGET_MS=5000 + visible skips (F3); guard placement
  DECIDED — relocate `unsafeReason()` to `minimal/guard.ts`, vendor
  into cc-gate-plugin, opencode-plugin imports minimal/ (F4);
  `liveEligible` added to the §1 schema, screen-stamped (F5);
  contract rev verified on yoo-dev + advisory skip upgraded to hard
  fail for the ruleChecks vector (F6); refusal insertion point fixed
  before `inContainerAgentVersion()` (F7); sole-base-mutator claim
  scoped to playbook-bearing layers (F8); `canonicalChecksJson`
  helper named (F9); emission invariants — proposer checks always
  shadow, blocking rejected at review (F10).
- r3 (2026-08-13): architect round-3 applied — producer rescoped from
  activation-only to a `writeActive`-adjacent `exportRuleChecks`
  helper covering `activateCandidate`, `startTrial`, `resolveTrial`
  both branches, `resolveGateTrial` rollback/abandon (the
  project-layer trial pipeline was the missed mutation surface;
  trial-arm shadow evaluation declared by-design) (F1);
  canonicalChecksJson exclusion of state/liveEligible declared
  deliberate (F2); single-harness `run` degenerate case named (F3).
- r4 (2026-08-13): round-4 scoped verification confirmed r3 fixes
  correct + producer surface exhaustive vs every writeActive call
  site; two prose minors fixed — §5.3/§7 reworded off "activation
  writes" to the full §4 producer surface (F1); §4 topic sentence no
  longer overreaches its own confirm-branch exception (F2).
