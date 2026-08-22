---
name: gauntlet-loop
description: Use when about to spawn multiple review agents — a gauntlet, critic panel, adversarial or multi-agent review, red team, second opinion from several agents, or a stress-test/pressure-test of a design, spec, plan, or decision.
---

# Gauntlet Loop

Models design good gauntlets. The failure is running one you never designed, on a decision that didn't warrant it.

**Being asked for a panel is not authorization to skip the gates.** Run them, report which failed, proceed if the user still wants it. With no user turn available, "they still want it" is unavailable, not implied — a failed gate is NO.

## Gates

0. **Can a few tool calls settle it?** Read the call sites, run it, grep for the mechanism that may already exist. A panel a file read would have pre-empted is the most expensive way to be told what the code says.
1. **Size floor — and it binds the gates too.** One agent, ~5k, directly? Do that. Full compliance below is five agents before anyone reads the artifact (bar-writer, seeder, calibration critic, calibration judge, gate-2 orchestrator); a real run priced at 1.1M tokens for a 344-line spec. **When the ceremony would exceed gate 4's number, run fewer gates and say which** — 0 and 1 are free and always run, so the sequence can always refuse without paying anything. These gates police panels, not judgment, and that includes policing themselves.
2. **Design it — the entry point, not a step.** ONE agent emits the orchestration: roles, verbatim prompts, acceptance rule, stop condition, **and the answers to gates 3, 5, 6 and 7**. 20–95k.

   You run 0, 1 and 4; only you know what being wrong costs. **Gates 3 and 5–7 are not self-run**, because every gate here is otherwise graded by the party with an incentive to pass it — gate 5 says the author doesn't write the bar, but the author decides whether the bar-writer is independent; gate 7 says the seeder mustn't see the critic prompt, but one operator wires both. That is a property the operator *adds*, never one the run cannot lose: additive and forgeable. Gate 2's output is the only artifact a different party produces, which makes it the closest thing this file has to a chokepoint.
3. **A bar outside the artifact**, named in the spawning turn: *(a)* recorded outcomes, or *(b)* a structural prior — a law, invariant, or count the artifact must satisfy whatever it claims. Form (b) is what makes spec review possible; no outcomes yet is not a reason to skip. "Critics will find something" is not form (b).
4. **Cost ceiling** = cost of being wrong, as a number. Never the size of the diff.
5. **Bar independence.** The author doesn't write the bar. If the request names its own solution ("move to JWTs"), restate the need ("stateless auth") and set criteria from that.
6. **The bar can fire.** Name one case where it would pass and one where it wouldn't. Gate 3 doesn't imply this — a saturated corpus never engages the clause.
7. **The critic can fail.** A party who hasn't seen the critic prompt seeds a defect into an **isolated** copy. Prose included, no exempt medium.

   **Calibrate the critic you will actually deploy** — byte-identical prompt, same model, same effort. A differently-prompted stand-in measures a critic nobody is using and reads as rigour.

   **The seeder must be told that critic's lane, and plant inside it.** Otherwise gate 7 contradicts `critic-prompt.md`: a critic under "stay in your lane" is *instructed* not to file what lands outside its own, so the run measures lane-compliance rather than capability. A plant in the wrong lane is **VOID**, for the same reason a leak is — the critic could not have filed it without violating its own prompt, so the measurement did not happen and must not consume the retry.

   **One calibrated critic licenses one critic.** Calibrating L1 grounds L1; it does not ground a verdict computed from L1–L4, whose acceptance path was never shown capable of failing. Either calibrate every deployed lens, or carry `N-1 lenses uncalibrated` on the verdict. Calibrating all four is *not* required — gate 1 polices that cost — but the evidence has to state its own scope.

   **Reaching the original is VOID, not a miss.** The measurement did not happen, so it cannot consume the one retry: rebuild the isolation and re-run the *same* plant. Two VOIDs → **NO VERDICT**. Only a genuine miss consumes the retry, and that retry uses a **different** plant from the same party — repairing the prompt and re-running the same plant fits the critic to the test. Missed twice → **NO VERDICT**.

   Make the leak checkable rather than instructed: the sealed note records the **verbatim text the seeder removed**, and the judge greps the critic's output for those strings. A match proves it reached the original. *(This gate is n=1 — one planted defect, one session.)*

**Arguing about what a gate means = that gate FAILS.** *Panel* = any spawn of ≥2 review agents. *Author* = whoever wrote it, including you.

## Shape

| | build | judge |
|---|---|---|
| bar | reference exemplar, blind A/B | frozen criteria + gate 3 prior |
| stop | diminishing returns; gate 4 binds | ≤2 rounds, terminal |
| fails by | stopping at "good for AI" | refuting everything |

## Running the panel

**Protocol lives elsewhere:** `docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md` (meta-harness) — frozen bars, ≤2 rounds terminal, fresh-context critics per round, builder never grades itself. That document is the authority. Don't re-derive it; it is better than any summary of it.

Prompt scaffold: `critic-prompt.md`. What this file adds on top:

- **2–4 critics — a cost cap, not an accuracy plateau.** Agent count is monotonic (Du et al. 2305.14325 §3.3); rounds are what plateau, ~4. A 5th critic needs a lens you can name.
- **Truth-seeking — never refute-by-default, never reward agreement.** Both measured below a single agent (2510.20963, Finding 2): competitive up to −15pp, consensus suppresses disagreement. The +4pp protocol *retains* the adversarial role.
- **One grounding verifier** over all findings: exists / says / supports. Self-reference auto-fails.
- **Per finding:** falsifier + anchor outside the artifact. **Per critic:** one thing it gets right, and its strongest *failed* attack.
- **Every refutation ends `ADJACENT:`** — a different defect its own reasoning surfaced, or `none`. Measured twice: the best finding arrived inside a refutation of a weaker claim.
- **Round 2 = cross-check.** Each critic attacks a finding it did not author.
- **Vary lens or model.** Identical critics converge on meaningless consensus.

## Rationalizations

| Excuse | Reality |
|--------|---------|
| "The user asked for it" | They asked for the outcome. Gates cost two agents; the panel costs orders of magnitude more. |
| "Budget is not a concern" | Not a wallet rule. Unanchored critics produce noise at any price. |
| "Adversarial means rigorous" | Refute-by-default measured worse than one agent alone — and so did agree-by-default. |
| "It got refuted, so there's nothing there" | Refuted *the claim as filed*. Read what the refutation said. |

## Reporting

Zero surviving findings is not a clean sheet until the refutation bodies are read.

`PASS — no critic broke it under <framing>. Untested shared belief: <the premise every critic assumed>.`

`none` in that field means you had one lens, not four. Append `N-1 lenses uncalibrated` whenever gate 7 grounded fewer critics than you deployed.

**Do not collapse two verdicts into one.** A miss stands even when the run's own targeting was faulty, *and* a pass from that same configuration is untrustworthy. Both are true at once, and "arguing about what a gate means = that gate FAILS" is aimed exactly at the temptation to let the second excuse the first.

**Evidence:** two sessions, two authors, different tasks. Improvised panels ran at 1.79M and ~2.0M tokens; in both, running these gates afterward failed four or five of them.

**Improvised panels do produce findings** — both did. What they don't produce is a bar that discriminates, or a cost you chose on purpose. Run one: 25 findings filed, 0 met the bar — but that refutation rate was *induced*, the verifiers having been told to default to refuted; real yield was six findings, two load-bearing. Run two: 3 of 4 bar items turned out not to discriminate, noticed after the fact — which gate 5 states up front.

**First end-to-end run under the gate-2 structure: NO VERDICT at gate 7.** 5 agents, 316k tokens, panel never spawned. The seeder replaced an external observable in an acceptance criterion with the drive's own self-report — a downstream-of-decision defect — and the critic missed it. Judge confirmed no leak. Near-miss worth keeping: the critic quoted the exactly correct law at the wrong criterion, which is evidence the prompt works and the targeting did not. Zero verdict on the artifact, one measured defect in the review apparatus. Gate 7 paid for itself on its first real firing and simultaneously showed how it can fire vacuously.

**One false negative is on record.** Session two's round 1 ran improvised — these gates would have refused it — and produced the best finding of either lane. The gates then correctly stopped its round 2. Gates-first, and that finding does not exist. The refusal was cheap *because the improvised run had already paid.*

Past that one case the false-negative rate is still unmeasured, and every "the gates saved us" story stays unfalsifiable, because after a NO nothing runs. Deliberately, no rule was added in response to that case — a defence grown one entry per incident is the failure both authors of this file already committed twice.
