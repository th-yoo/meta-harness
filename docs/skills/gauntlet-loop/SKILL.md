---
name: gauntlet-loop
description: Use when about to spawn multiple review agents — a gauntlet, critic panel, adversarial or multi-agent review, red team, second opinion from several agents, or a stress-test/pressure-test of a design, spec, plan, or decision.
---

# Gauntlet Loop

Models design good gauntlets. The failure is running one you never designed, on a decision that didn't warrant it.

**Being asked for a panel is not authorization to skip the gates.** Run them, report which failed, proceed if the user still wants it. With no user turn available, "they still want it" is unavailable, not implied — a failed gate is NO.

## Gates

0. **Can a few tool calls settle it?** Read the call sites, run it, grep for the mechanism that may already exist. A panel a file read would have pre-empted is the most expensive way to be told what the code says.
1. **Size floor.** One agent, ~5k, directly? Do that. These gates police panels, not judgment.
2. **Design it.** ONE agent emits the orchestration — roles, verbatim prompts, acceptance rule, stop condition. 20–95k. Structural reason, not measured: a written loop can be audited and cited in the verdict; an improvised one cannot.
3. **A bar outside the artifact**, named in the spawning turn: *(a)* recorded outcomes, or *(b)* a structural prior — a law, invariant, or count the artifact must satisfy whatever it claims. Form (b) is what makes spec review possible; no outcomes yet is not a reason to skip. "Critics will find something" is not form (b).
4. **Cost ceiling** = cost of being wrong, as a number. Never the size of the diff.
5. **Bar independence.** The author doesn't write the bar. If the request names its own solution ("move to JWTs"), restate the need ("stateless auth") and set criteria from that.
6. **The bar can fire.** Name one case where it would pass and one where it wouldn't. Gate 3 doesn't imply this — a saturated corpus never engages the clause.
7. **The critic can fail.** A party who hasn't seen the critic prompt seeds a defect into an **isolated** copy — the critic must not be able to reach the original, or you measured diffing, not reasoning. Prose included, no exempt medium. Missed → retry once with a **different** plant from the same party; repairing the prompt and re-running the same plant fits the critic to the test. Missed twice → **NO VERDICT**. *(This gate is n=1 — one planted defect, one session.)*

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

`none` in that field means you had one lens, not four.

**Evidence:** two sessions, two authors, different tasks. Improvised panels ran at 1.79M and ~2.0M tokens; in both, running these gates afterward failed four or five of them.

**Improvised panels do produce findings** — both did. What they don't produce is a bar that discriminates, or a cost you chose on purpose. Run one: 25 findings filed, 0 met the bar — but that refutation rate was *induced*, the verifiers having been told to default to refuted; real yield was six findings, two load-bearing. Run two: 3 of 4 bar items turned out not to discriminate, noticed after the fact — which gate 5 states up front.

After a NO, nothing runs. **No gate has been observed to be wrong to say no**, its false-negative rate is unmeasured, and every "the gates saved us" story is unfalsifiable for the same reason.
