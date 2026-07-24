# minimal/ evolution history

Append-only round log for the minimal loop (kernel: [`docs/minimal-loop-ood.md`](../docs/minimal-loop-ood.md)).
One entry per gate verdict. The Gate (`gate.ts` since adoption-1) is the sole
mutator of the active base; `rejected.json` is the machine-form rejection ledger
(invariant 5 — permanent proposer input). This file is the human-readable lineage.

**Active base:** `harness/system-v0.md` (`--system`) + `harness/seed-v0.md` (`--harness`)
— since adoption-1 (2026-07-23, commit `4fc9d68`). Unchanged through round 3
(R2 and R3 both rejected; every post-adoption bullet so far has been null).

| # | Date | Candidate | Arms (sparql k=10 unless noted) | p | Guards | Verdict |
|---|---|---|---|---|---|---|
| R1 | 2026-07-23 | machine bullet (script-verify) on bare | bare 4/10 vs 5/10 | 1.0 | — | REJECT null |
| SG | 2026-07-23 | system-v0 + seed-v0 vs bare | 6/20 vs 17/20 (pooled) | 0.00106 | deferred | certified, not adopted (zero guards) |
| A1 | 2026-07-23 | system-v0 + seed-v0 (guard arms) | (lift from SG) | 0.00106 | cdt 3/3, chess 3/3 | **ADOPT** — first in project history |
| HO | 2026-07-23 | adopted base, held-out tasks | cancel-async 3/10→5/10; headless 7/11→7/8 | 0.65 / 0.34 | re-held | directional, uncertified (context only) |
| R2 | 2026-07-24 | scope-leak bullet ON adopted base | 9/10 vs 10/10 | 1.0 | cdt 3/3, chess 3/3 | REJECT null |
| HO2 | 2026-07-24 | adopted base, cancel-async office pair | bare 2/10 vs adopted 6/10 (k=10) | 0.17 | — | directional, uncertified |
| R3 | 2026-07-24 | signal-verification bullet ON adopted base | cancel-async 6/10 vs 3/10 | 0.37 | cdt 3/3, chess 3/3, sparql-info 3/3 | REJECT null (negative direction) |
| R4 | 2026-07-24 | asyncio-cancellation bullet (iteration 1) | killed at ~6 attempts (4/4 pre-kill) | — | — | REJECT scope-veto, never gated (rule 3b born here) |

---

## R1 — round-1 machine bullet (2026-07-23, office) — REJECT

- **Evidence:** 1 failing traj (thin; proposer self-flagged low confidence).
- **Bullet:** compute qualifying sets with a script rather than eyeballing.
- **Arms (bare base):** 4/10 vs 5/10, Fisher p=1.0. Its own `falsify_if` fired —
  first calibration point for proposer predictions.
- **Mechanism:** winners already scripted logic in both arms; bullet mandated
  default behavior. Ledgered as `rejected.json` entry 1.

## SG — system gate (2026-07-23, office) — certified lift, adoption deferred

- **Candidate:** `system-v0.md` (72-line replacement system prompt; DoD as
  required emitted procedure) + `seed-v0.md` (2 DoD bullets). Composite —
  attribution = assembly, not either piece (decomposition still open).
- **Arms:** bare 6/20 (30%) vs candidate 17/20 (85%), pooled Fisher p=0.00106;
  unbiased replication batch alone 3/10 vs 9/10, p=0.0198. Largest lift in
  project history. NOT adopted at this point: zero guard tasks measured (v9 lesson).

## A1 — adoption-1 (2026-07-23, MacBook) — ADOPT (first in project history)

- **Decided by `gate.ts`** (built that session, TDD 17 tests; guard-less
  adoption structurally forbidden — hole found on first E2E run).
- **Guards:** count-dataset-tokens 3/3, chess-best-move 3/3, zero voids
  (`results/adoption-1-verdict.json`). Commit `4fc9d68`.
- **Forensics (free, pre-gate):** 17/20 candidate trials emit the DoD procedure
  vs 0/20 bare; verbatim mid-flight scope-leak catch (10-50 a2); the 3 candidate
  fails all complied → residual = held-out-only interpretation variants;
  anthropic.txt-removal hypothesis weakened.
- **Caveats standing:** n=1 target task; lift arms office-host, guard arms
  MacBook (each internally same-host).

## HO — held-out generalization (2026-07-23, MacBook) — directional, uncertified

- cancel-async-tasks bare 3/10 vs adopted 5/10 (p=0.65); headless-terminal
  bare 7/11 vs adopted 7/8 (p=0.34). Both positive, neither certified;
  informal cross-task pool 10/30 vs 13/18 p=0.016 — context only, gate.ts
  refuses cross-task pooling by design. Guards re-held. Commit `0119619`.
- Confidence "improves the agent, not just sparql": ~85%.

## R2 — round-2 scope-leak bullet on adopted base (2026-07-24, office) — REJECT

- **Evidence:** round-2 proposer (CC, 10-traj bare-arm evidence + ledger)
  diagnosed qualification-filter leak into output projection. Triple-confirmed:
  CC proposer, opencode proposer parity replay (`7517f72` — proposer seat now
  driver-configurable, opencode default `f12d515`), human desk-check.
- **First stacking test post-adoption.** Candidate `harness/candidate-r2-scope-leak.md`
  = seed-v0 + bullet, system-v0 unchanged. Fresh office arms.
- **Arms:** baseline (adopted base) 9/10 vs candidate 10/10, Fisher p=1.0 —
  null; regression ruled out. Guards cdt 3/3 + chess 3/3 hold (fresh office
  screens). Zero voids. `results/r2-gate-verdict.json`, commit `3367399`.
- **falsify_if fired as pre-registered** — second calibration point.
- **Mechanism (ledgered, entry 2):** diagnosis correct but the adopted base's
  DoD procedure already covers the class; baseline 9/10 = no headroom at k=10.
- **Process lesson:** the bullet's evidence was PRE-adoption bare-arm trials.
  Propose against the ACTIVE base's residual failures — stale evidence from a
  weaker base proposes fixes the base already has.
- **Side result:** adopted base re-confirmed 19/20 pooled on fresh office arms
  (third host-day replication).

## HO2 + R3 — cancel-async chain (2026-07-24, office) — directional + REJECT

One auto-chained run (user-approved single go): harvest → proposer → gate.

- **HO2 (certification leg):** fresh office pair, cancel-async bare 2/10 vs
  adopted 6/10, Fisher p=0.17 — directional, uncertified (needed 8/10).
  Second same-sign host-day for cancel-async (MacBook 3/10→5/10). Pass/fail
  duration signature strong: passes grind (up to 19 min), fails bail fast.
- **R3 (first ACTIVE-base-residual proposal — R2's process fix applied):**
  proposer (opencode driver, parser hardened `a642db1` after a pretty-printed
  JSON contract killed the first call post-spend) diagnosed: fails self-verify
  with in-process signal proxies unrepresentative of the grader's real
  signal-to-subprocess delivery, then dismiss the mismatch. Bullet: reproduce
  the grader's actual trigger before declaring done.
- **Arms:** adopted 6/10 vs +bullet 3/10, p=0.37 — REJECT null, negative
  direction. Guards cdt 3/3 + chess 3/3 hold; sparql informational 3/3.
  falsify_if fired (third calibration point). `results/r3-gate-verdict.json`.
- **Mechanism (ledgered, entry 3):** cancel-async residual now 2x
  proposer-resistant; the negative hint suggests "distrust your self-test"
  buys re-verification churn, not interpretation fixes. Next content must come
  from divergence forensics on the flipped trajectories (what the 6 baseline
  passes did at the signal step that the 4 fails did not), not another
  procedure bullet.

## R4 — iteration 1, asyncio bullet (2026-07-24, office) — REJECT scope-veto, never gated

- **Iteration 1 = R3's full result fed back:** evidence = adopted arm (6P/4F) +
  R3's rejected-bullet arm (3P/7F), ledger 3 entries. Proposer executed the
  divergence read and found the mechanism: failers truncate cleanup by
  re-cancelling children already unwinding — but emitted it as an asyncio
  solution recipe (shield/absorb during cancellation).
- **User design rule born here** (mid-arm, run killed at ~6 attempts, 4/4
  observed pre-kill): *the proposer guides systematic problem-solving and
  general SWE method, never domain knowledge or specific manuals.* Encoded as
  propose.ts rule 3b (`0e65a2a`), research-grounded rev (`1715c68`: process
  categories, hard-gate form, domain-swap litmus). Ledgered as entry 4
  (scope-veto; no gate verdict; partial arm not comparable).
- **Structural finding:** guards are domain-irrelevant, so they hold trivially
  under a domain bullet — the stats gate structurally cannot catch scope
  bloat. Scope control = proposer rule + Reviewer seat + human veto.
- **Reviewer seat built in response** (`b738624`, design `bfd0371`): layer-1
  deterministic checks + evidence-forced rubric, code-conjuncted verdict,
  bounded revise loop with frozen diagnosis. Retroactive: layer 1 kills R4's
  bullet for free (task-id fragment leak); R3's passes to the rubric.
- **Diagnosis stays live** — the 4/4 pre-kill hot start weakly corroborates
  that the residual is this mechanism and is context-reachable. Wanted next:
  behavior-level reform (verification-design / completion-criteria) or an
  honest domain-only ABSTAIN, which escalates toward a binding actuator.
