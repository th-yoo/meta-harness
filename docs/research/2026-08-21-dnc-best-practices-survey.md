# External best-practices survey vs the D&C/verification design (2026-08-21)

Parallel-search sweep over four topics matching the open design work (derived
thresholds, value-truth verification, decomposition preconditions,
orchestration). Purpose: check our probe-derived rules against published
practice BEFORE the arming increment. Net: six independent convergences, three
refinements to adopt, one prior-art naming.

## 1. Decomposition — the literature says what the probes measured

- **Monolith-vs-chain practice** (industry decision frameworks): lean single
  call when the task fits effective context, has no natural sequential
  structure, or the model is reasoning-native; chain when stages are genuinely
  distinct, intermediates need validation, or error localization matters. The
  named "most underused technique": **measure end-to-end against a monolith
  baseline** — which is exactly our arm-W control (and it won).
- **Effective context ≠ advertised context**: degradation from ~60-70% of the
  limit; "lost in the middle" persists at 1M. Supports the L2 length sub-band
  as the only decomposition-relevant failure class.
- **Prior art for the glyph result**: the **word-superiority effect** (Cattell
  1886; Reicher 1969; Wheeler 1970) — letters are recognized BETTER in words
  than in isolation, under degradation. Our whole-vs-glyph delta is a
  140-year-old cognitive result reproduced in an LLM reader. Nuance to carry:
  a **word-inferiority effect** also exists (context can inhibit, task-
  dependent) — the coupling-delta instrument measures the direction rather
  than assuming it, which the literature says is the right posture.
- **"The Regression Tax" (2025/26)**: skill/guidance libraries' gross gains
  offset 59% by regressions; mechanisms = description osmosis (presence-only
  behavior shifts), grounding displacement, **verification displacement**
  (procedure suppresses checks the agent would have run). Matches our v18
  lexical-trigger regression and O4-announcement Goodhart as instances of a
  named, measured class. Their method — **paired decomposition of outcomes
  (gain / regression / residual / retained) instead of net pass rate** — is
  directly applicable to our ab verdicts.

## 2. Derived thresholds — practice agrees, and names our circularity trap

- Standard robust practice: estimate noise scale with **MAD × 1.4826 /
  sigma-clipping** (astropy-class tooling), never raw std when outliers exist;
  bootstrap for parameter uncertainty.
- **Chi-squared acceptance requires KNOWN sigma**; the literature explicitly
  flags the common misuse where "supposedly-known σ values are clearly
  inconsistent with the spread of the data around the fit" — i.e. sigma
  quietly estimated from the residuals being judged. That is the
  downstream-of-decision law in statistics clothing, and it constrains
  `delta_fit`: **the noise floor must come from OUTSIDE the claim** (e.g. the
  detector's own smoothing residuals on the raw series), never from the
  claim's fit residuals.
- Condition-number practice supports the consolidation hypothesis direction
  (acceptance criteria tied to the fit's conditioning are standard numerics).

## 3. Verification — independent confirmation of the error/deception split

A production-verification taxonomy (grounding / self-verification /
cross-model / external layers) states, independently, our T6 boundary and
threat-model sentence:

- "**A consistent wrong belief is consistent; consistency cannot distinguish
  it from a consistent right one**" — self-verification cannot catch
  confidently-held systematic error. (= geometry checks pairing, never truth.)
- "**A verification step that can see the draft tends to ratify it**" — the
  downstream-of-decision law, fourth independent derivation, from industry.
- Grounding checks verify **faithfulness to evidence, not truth** — the exact
  scope our source_crosscheck primary must carry (stale/wrong source → faithful
  output passes).
- **Prompt injection into the verifier**: "a verifier that can be talked into
  approving is worse than no verifier" — the class our VOID finding hit
  (raman-fitting-gate hijacking the auditor); named hardening item for arming.
- LLM-as-judge practice: split criteria into separate evaluators, counter
  positional bias, judge consistency checks — consistent with our
  no-LLM-judge-in-scorer probe rule and diverse-lens verification.

## 4. Orchestration — the ladder's provenance and its production caveats

- Anthropic's building-effective-agents: simplest-that-solves confirmed as the
  source doctrine; "add complexity ONLY when it demonstrably improves
  outcomes" = our rung-by-measured-shape principle.
- **MAST taxonomy** (Cemri et al., NeurIPS 2025): 14 multi-agent failure modes
  in three clusters — specification, inter-agent misalignment, task
  verification — over 1,600 traces; "performance gains often minimal." Worth
  citing from spec §2.
- **Cognition's "Don't Build Multi-Agents" + follow-up**: safe envelope =
  multiple agents contributing intelligence with **writes single-threaded** —
  precisely the shared-checkout serialization + read-pipelining ruling we
  arrived at independently.
- Anthropic's multi-agent research system: ~15× token cost of chat — the
  overhead our batching/pipelining discipline exists to justify.

## Adoptions (each lands where the work already lives)

1. **`delta_fit` derivation constraint (into the derived-thresholds go):**
   noise floor estimated robustly (MAD-class) from the RAW SERIES outside any
   claim — never from claim residuals; the chi-squared-misuse literature is
   the external citation for why.
2. **Regression-Tax paired outcome decomposition (into ab reporting):** report
   gains/regressions/residual/retained per arm, not only net — our crank
   verdicts already trend this way; make it the standard shape.
3. **Verifier-injection hardening (into the arming spec):** the VOID
   assertCleanStimulus class generalized — the verifier's inputs are
   attacker-influenceable and need the same containment as the sampler.
4. Cite MAST + word-superiority as prior art in the D&C spec's provenance;
   the glyph probe's finding has a literature name.

Sources: tianpan.co monolith-vs-chain (2026-04); themoonlight.io Regression
Tax review; ScienceDirect letter-recognition overview (WSE/word-inferiority);
PromptHub least-to-most guide; Decomposed Prompting (ICLR 2023);
stats.stackexchange chi-squared-with-unknown-sigma threads; astropy robust
stats docs; hidekazu-konishi.com LLM output-verification patterns (2026-08);
KnowHalu (arXiv 2404.02935); Patronus LLM-as-judge guide; Anthropic
building-effective-agents + multi-agent research system; MAST (arXiv
2503.13657); Cognition don't-build-multi-agents + follow-up; Lyzr/Dataiku
single-vs-multi comparisons.
