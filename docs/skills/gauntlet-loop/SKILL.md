---
name: gauntlet-loop
description: Use when about to spawn multiple review agents — a gauntlet, critic panel, adversarial or multi-agent review, red team, second opinion from several agents, or a stress-test/pressure-test of a design, spec, plan, or decision.
---

# Gauntlet Loop

Models design good gauntlets. The failure is running one you never designed, on a decision that didn't warrant it.

**Being asked is not authorization to skip the gates.** Run them, report which failed, proceed if the user still wants it. With no user turn available, "they still want it" is unavailable, not implied — a failed gate is NO.

**Arguing about what a gate means = that gate FAILS.** *Panel* = any spawn of ≥2 review agents. *Author* = whoever wrote it, including you.

## Gates

**0. Can a few tool calls settle it?** Read the call sites, run it, grep for the mechanism that may already exist. A panel a file read would have pre-empted is the most expensive way to be told what the code says.

**1. One agent is the default.** A panel is the exception, and taking it means naming what one agent *cannot do*. "It governs a safety invariant", "three prior designs died here" are facts about the artifact; none is a reason one careful reviewer fails. If the reason doesn't survive being rewritten as *"one agent would miss X, because one agent Y"*, there is no reason.

This gate stays self-run — it has to, to stay free — so it's tested on the **form** of the reason, not its truth. It also binds the ceremony: full compliance is five agents before anyone reads the artifact, priced once at 1.1M for a 344-line spec. **When the gates would exceed gate 4's number, run fewer and say which.** Gates 0 and 1 are free and always run, so the sequence can always refuse without paying.

**Gate 1 refuses INTO a named shape, not into "one agent".** A loop at width 1: blind bar · anchor rule · **one** critic · one grounding verifier · the narrowing pass **minus cross-check**, the only part that needs a second lens. Verdict carries `N-1 lenses uncalibrated`. Measured: five real defects, one fatal to the artifact's central claim, ~150k against 1.1M.

**2. Design it — the entry point, not a step.** ONE agent emits the orchestration: roles, verbatim prompts, acceptance rule, stop condition, **and the answers to gates 3, 5, 6, 7**. 20–95k.

You run 0, 1 and 4; only you know what being wrong costs. **Gates 3 and 5–7 are not self-run**, because otherwise each is graded by the party with an incentive to pass it: gate 5 says the author doesn't write the bar, but the author picks the bar-writer; gate 7 says the seeder mustn't see the critic prompt, but one operator wires both. Additive and forgeable — a property the operator adds, not one the run cannot lose. Gate 2's output is the only artifact a different party produces.

**3. A bar outside the artifact**, named in the spawning turn: *(a)* recorded outcomes, or *(b)* a structural prior — a law, invariant, or count the artifact must satisfy whatever it claims. Form (b) is what makes spec review possible. "Critics will find something" is not form (b).

**4. Cost ceiling** = cost of being wrong, as a number. Never the size of the diff.

**5. Bar independence.** The author doesn't write the bar. If the request names its own solution ("move to JWTs"), restate the need ("stateless auth") and set criteria from that.

**6. The bar can fire.** Name one case where it passes and one where it doesn't. Gate 3 doesn't imply this — a saturated corpus never engages the clause.

**7. The critic can fail.** A party who hasn't seen the critic prompt seeds a defect into an **isolated** copy. Prose included, no exempt medium.

- **Calibrate the critic you deploy** — byte-identical prompt, same model, same effort. A stand-in measures a critic nobody is using and reads as rigour.
- **Gate 2 picks *which* lens gets calibrated, and says why: the one where a miss is most expensive.** For a spec that is almost always the acceptance criteria — a criterion that cannot fail silently licenses everything downstream of it. Defaulting to whichever lens is listed first buys consistent targeting aimed at the wrong lens.
- **The seeder is told that critic's lane and plants inside it.** Otherwise this contradicts `critic-prompt.md`: a critic under "stay in your lane" is *instructed* not to file what lands outside it, so the run measures obedience, not capability.
- **VOID ≠ miss.** Reaching the original, or a plant in the wrong lane, means the measurement never happened — it cannot consume the retry. Re-run the **same defect kind with the cause corrected**: isolation rebuilt for a leak, location moved in-lane for a lane fault. **Diagnose the leak channel first** — if the removed text is recoverable from public sources or the model's own prior, no sandbox closes it and a tighter re-run yields a *false pass*; re-seed with ground truth that isn't recallable. Reusing the defect is safe because the critic was never shown it. **Two VOIDs → NO VERDICT.**
- **A genuine miss consumes the retry**, and that retry uses a **different** plant — repairing the prompt and re-running the same one fits the critic to the test. **Missed twice → NO VERDICT.**
- **Make the leak checkable:** the sealed note records the verbatim text the seeder removed; the judge greps the critic's output for those strings. A match proves it reached the original.
- **One calibrated critic licenses one critic.** Calibrating L1 grounds L1, not a verdict computed from L1–L4. Calibrate every deployed lens, or carry `N-1 lenses uncalibrated`. *(n=1 — one planted defect, one session.)*

**A halted run's blind artifacts survive it.** A bar written by an agent that never saw the artifact is still blind tomorrow; gate 5 doesn't need re-paying. Carry it into the rerun. Re-deriving it turns one halt into two full prices.

## Shape

| | build | judge |
|---|---|---|
| bar | reference exemplar, blind A/B | frozen criteria + gate 3 prior |
| stop | diminishing returns; gate 4 binds | ≤2 rounds, terminal |
| fails by | stopping at "good for AI" | refuting everything |

## Running the panel

**Protocol lives elsewhere:** `docs/superpowers/plans/2026-08-01-gauntlet-adoption-loop.md` — frozen bars, ≤2 rounds terminal, fresh-context critics per round, builder never grades itself. That is the authority **for those four properties, and only those**: its topology is one builder against one critic on an adopt/drop decision, not a panel. It says nothing about how many agents a panel spawns or in what order. `critic-prompt.md` gives prompt *bodies* — critic, round 2, verifier — and no roster either. So the roster lives here, because it lives nowhere else.

**Roster — what actually gets spawned.** Every gate that is not self-run is a separate agent; that IS the mechanism. Run in one context, gates 3 and 5–7 are graded by the party with an incentive to pass them, and the verdict measures nothing.

| # | agent | must NOT have seen |
|---|---|---|
| 1 | gate-2 designer — emits the orchestration | — |
| 2 | bar writer (gate 5) | the artifact |
| 3 | seeder (gate 7) | the critic prompt |
| 4 | calibration critic — byte-identical to a deployed critic, same model, same effort | that it is being calibrated |
| 5–8 | 2–4 panel critics, one lens each | each other |
| 9 | grounding verifier | — |
| 10–13 | round 2 — same lenses, FRESH context | — |

Full run ≈ 9–13 spawns; that is what 1.1M buys. **Gate 1's width-1 refusal is ≈ 3 spawns** — bar writer, one critic, verifier, no cross-check — not zero. **Only gate 0 refuses to zero agents.** Conflating the two is how a run gets talked out of existing.

Dispatch each round's critics in ONE message so they run concurrently. Round 2 is a **fresh spawn** holding the pooled findings plus the verifier report — never a continuation of a round-1 critic, which defends its own findings instead of cross-checking them.

What this file adds beyond the roster:

- **2–4 critics — a cost cap, not an accuracy plateau.** Agent count is monotonic (Du et al. 2305.14325 §3.3); *rounds* plateau, ~4. A 5th critic needs a lens you can name.
- **Truth-seeking — never refute-by-default, never reward agreement.** Both measured below a single agent (2510.20963, Finding 2): competitive up to −15pp; consensus suppresses disagreement. The +4pp protocol *retains* the adversarial role.
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
| "This artifact is high-stakes / complex / load-bearing" | Facts about the artifact, not reasons one reviewer fails. Gate 1. |

## Reporting

Zero surviving findings is not a clean sheet until the refutation bodies are read.

`PASS — no critic broke it under <framing>. Untested shared belief: <the premise every critic assumed>.`

`none` there means you had one lens, not four. Append `N-1 lenses uncalibrated` when gate 7 grounded fewer critics than you deployed.

**Don't collapse two verdicts.** A miss stands even when the targeting was faulty, *and* a pass from that configuration is untrustworthy. Both at once.

## Evidence

Two sessions, two authors, different tasks.

- Improvised panels: **1.79M** and **~2.0M** tokens. Running these gates afterward failed 4–5 of them each time.
- They **did** produce findings — what they didn't produce is a bar that discriminates or a cost chosen on purpose. Run one: 25 filed, 0 met the bar, but that refutation rate was *induced* (verifiers told to default to refuted); real yield six findings, two load-bearing. Run two: 3 of 4 bar items didn't discriminate.
- First end-to-end run under gate 2: **NO VERDICT at gate 7**, panel never spawned, 5 agents / 316k. The critic quoted exactly the right law at the wrong criterion — the prompt worked, the targeting didn't.
- **Gate 1 is the one that gets argued past.** One operator failed it four consecutive times, each with a true statement about the artifact. ~391k bought zero reviews of a spec one agent could read for ~15k.
- **One false negative on record.** An improvised round 1 these gates would have refused produced the best finding of either lane. The refusal that followed was cheap *because that run had already paid.* Past that single case the false-negative rate is unmeasured, and every "the gates saved us" story is unfalsifiable — after a NO, nothing runs.
- **This file gained roughly one clause per failure.** Structurally derivable is not structurally motivated. Both authors have done this while quoting the rule against it. No clause was added in response; the observation *is* the record, and the next one should be weighed against it.
