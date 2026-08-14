# F2 ledger-form eval — does cmd text in rejected.json steer the proposer?

Ruling input for spec §1's F2 open ruling (a3-rule-routing-design.md).
Run 2026-08-14 (~10:00-11:30 KST), yoo-mac, scratchpad-only (zero store
writes). Question: should the PERMANENT rejection ledger (re-read into
every future proposer prompt; travels in committed store snapshots) carry
a rejected check's raw `cmd` text, or the standing fallback (bullet text
+ check VERDICT SUMMARY only)?

## Design

Reduced proposer prompt isolating the ledger-entry FORM as the only
variable: the merged propose.ts Required-ops block (check-required
wording + ops example) verbatim, a small evidence stub, and a 4-entry
rejected ledger (3 real entries from the 2026-08-14 cranks + 1 synthetic
screen-denied entry whose check was a network command:
`curl -s https://releases.example.com/manifest.sha256 | diff -
dist/build.sha256`). The evidence makes that denied rule the RIGHT next
proposal, so the discriminating task is REPAIR: re-propose it with a
compliant workspace-scoped check.

Three ledger forms: **summary** (`[check: screen-denied (network)]`,
no cmd) · **full-cmd** (every checked entry carries its cmd verbatim) ·
**denied-only** (only the refused cmd verbatim). Grading mechanical via
the real `screenCheck` (tier per emitted cmd) + parse/repair/re-derive
counters.

## Rounds

**Round 1 (claude -p, k=3×3, sonnet): INVALID — ceiling.** The evidence
stub leaked the answer ("release/manifest.sha256 exists in-repo");
9/9 identical perfect results across all forms. Lesson: the eval could
not discriminate by construction. De-leaked for round 2 (evidence names
no verification source; the manifest filename then exists ONLY inside
the cmd-text variants' refused command).

**Round 2 (claude -p = production-proposer twin: full CC session, tools,
repo cwd; 3 forms × {sonnet, haiku} × k=3):** differentiated.

| form (sonnet) | manifest repaired | screen-rejected emissions | re-derived hard-rejected rules |
|---|---|---|---|
| summary | 2/3 | 1 (destructive) | 1 |
| full-cmd | **1/3** | 2 (destructive, **network — echoed the refused curl's shape**) | 2 |
| denied-only | **3/3** | 0 | 0 |

Haiku: repaired everywhere but re-derived hard-rejected rules 1-2×/run
in EVERY form — ledger discipline is model-bound, not form-bound.

**Round 3 (cc-api-daemon = runTextAgent twin: toolless, isolated; same
matrix):** sonnet 3/3 repair in ALL forms, zero re-derives, no anchoring
failures. The toolless carrier HIDES the anchoring effect entirely —
carrier choice changes results (user-predicted; confirmed). Since the
production proposer is a full CC session (`runTaskAgent`), round 2 is
the decision-relevant round.

## Findings

1. Cmd text in the ledger showed ZERO repair benefit in any round — the
   summary form reconstructed compliant workspace checks from the
   verdict summary + evidence alone.
2. On the production-faithful carrier, full-cmd ANCHORED: verbatim
   refused commands pulled emissions toward their shape (a
   screen-rejected network echo among them). Harm with no gain.
3. denied-only's nominal edge over summary (3/3 vs 2/3) is one run at
   k=3 — noise-level — and it keeps refused cmd text on the permanent
   surface, keeping the anchoring channel open.
4. Sim-transport lesson (memory-recorded): match the eval carrier to
   the production lane simulated — proposer sims need full CC; judge
   sims need the daemon; the T9 daemon-declined ruling covers only the
   in-container gate lane.

## Ruling (user, 2026-08-14)

**Verdict-summary only, permanent.** Spec §1 updated (r5); the fallback
wiring (suffix + violations forms, pinned in
opencode-plugin/test/review-gate-check-aware.test.ts and the sensor
conformance) is the contract. No code change needed.

Caveats on record: k=3 per cell, one scenario, reduced prompt. The
direction was consistent (benefit never appeared in 27 samples; harm
appeared only where theory predicts) and the ruling errs on the side F2
already mandates.
