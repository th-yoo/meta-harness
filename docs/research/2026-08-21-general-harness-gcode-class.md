# General harness/workflow for the gcode-class problem — survey (2026-08-21)

Correction of scope from the previous survey (which checked our design
defenses): THIS one answers the actual question — what GENERAL harness or
workflow lets an agent solve gcode-to-text-class tasks (text-encoded spatial
artifact → recover meaning) with NO task-specific machinery. Answer: the
pattern exists, has a name, and has measured results on a near-twin task
class.

## 1. The general pattern: Whiteboard-of-Thought (WoT)

Menon, Zemel & Vondrick, "Whiteboard-of-Thought: Thinking Step-by-Step
Across Modalities" (arXiv 2406.14562, Columbia 2024): give a multimodal LLM
a metaphorical whiteboard — it WRITES CODE (matplotlib/turtle) to draw its
intermediate representation, the rendered image is fed BACK to the model,
and it reasons from its own drawing. Zero-shot, no demonstrations, no
task-specific modules — exactly the generality bar §1 sets.

Measured: on BIG-Bench **ASCII-art understanding** (the nearest published
twin of gcode-to-text: text-encoded visual → read it) and spatial
reasoning, GPT-4o CoT scores 0% in multiple settings; **WoT reaches up to
92%** on the same settings.

Our glyph probe is the local replication of WoT's premise: once rendered,
whole-string reading was 26/26. The SUT's gcode failures are the MISSING
WoT loop — the agent never externalizes to the visual modality.

## 2. The family and its trajectory

Survey framing (multimodal visualization-of-thought): three stages —
(i) external visual tools, (ii) **programmatic visual manipulation** (WoT;
where the gcode-class fix lives), (iii) intrinsic visual imagination.
Related: Visual Sketchpad (2406.09403); VoT "mind's eye" text-grid
visualization (NeurIPS 2024) — weaker, text-only intermediates, but
documents SELF-REFINE cases where a wrong visualization was redrawn and the
answer corrected. Caveat literature: "Chain-of-Thought DEGRADES visual
spatial reasoning" (ACL 2026 short) — reasoning textually about spatial
data actively hurts; render-then-look is not just an alternative, textual
decoding is the WRONG modality for this class. (Matches the bench trajs:
agents deriving glyphs from coordinate lists in text.)

## 3. Tool-making: the reusable-renderer loop is also general

- **LATM** (LLMs As Tool Makers, ICLR 2024): tool-maker model writes a
  reusable Python utility; tool-user (cheaper model) applies it; tools
  cached across requests. The renderer an agent writes for one
  spatial-format task is LATM's "tool" — produced BY THE AGENT at
  task-time, which keeps the harness answer-free.
- **Voyager / CREATOR / skill-library pattern**: agent-written programs
  stored and composed; catalogued pattern "agent-to-rule-distillation" —
  capture recurring solutions OUTSIDE the agent into governed rules — is
  the literature's name for our playbook/proposer loop.
- **Skill compilation** finding (skills survey 2026): multi-agent systems
  often compile into single-agent skill libraries at lower cost — same
  direction as our L1-bullets-over-orchestration results.
- Security: SKILL.md prompt-injection studies (2025-26) — the
  skill/verifier injection class we already carry as an arming item.

## 4. What this means for the bench, by §1 tier

1. **Behavior (L1 bullet, ab-testable):** sibling's proposed bullet —
   "artifact is spatial/geometric → render it and look at it" — is WoT as
   one sentence. External evidence (0%→92% on the ASCII twin class) plus
   our local ceiling measurement (render → 26/26) now both back it. It
   stays general: applies to meshes, plots, layouts, ASCII art, gcode.
2. **Infrastructure (legitimate harness fix, carries no task knowledge):**
   the WoT loop needs (a) code execution, (b) an image-capable read-back
   channel, (c) plotting libs PRESENT in the task container. The bench has
   (a) and (b) (delivery-channel probe: PNG bytes through the trajectory,
   3/3). Whether (c) holds across the band is a checkable infrastructure
   question — a missing matplotlib is a transport gap, not task knowledge,
   and fixing it universally is §1-legitimate.
3. **NOT to build:** any gcode renderer in the harness. The agent writes
   its own renderer at task time (LATM shape); the harness only guarantees
   the loop is POSSIBLE. That is precisely WHY the pattern stays
   answer-free — the moment the harness supplies a format-specific
   renderer it crosses back over §1. The bullet's wording stays
   MODALITY-level ("draw it and look"), never naming a format.

## 4b. Cautions before the bullet ships (cross-lane review, adopted)

- **Expectation anchor:** 0→92% is GPT-4o on BIG-Bench, not sonnet on TB2.
  External numbers are motivation, never a prior for calling the ab early —
  the ab verdict is the only evidence that counts locally (the
  no-reason-drift rule applied to literature).
- **Sequencing rule (the F1/F2 lesson at loop level):** the libs AUDIT is
  zero-spend and safe anytime; its REMEDY is not attribution-neutral. If
  plotting libs are missing and get added to band images, that env change
  alters what EVERY arm can do — shipped in the same window as the bullet,
  the ab measures bullet+env and attributes both to the bullet. Sequence:
  audit → if missing, env fix as its OWN change with a re-baseline (or at
  minimum a recorded env-delta) → THEN the bullet ab on the stable
  environment. Libs already present → the audit just closes the risk.

## 5. Falsifiable expectation (registered thought, not a run)

If the render bullet ships through the standard proposer/ab path, the
gcode-class prediction is: lift concentrated on tasks whose artifact is
spatial/visual (gcode-to-text, extract-moves-from-video-class,
code-from-image), null elsewhere — a Regression-Tax paired report would
show gains clustered in that class with regressions near zero if the
trigger is signature-based (G2 guard). WoT's own error sources (correct
drawing, wrong reading; wrong drawing) are the residual class to watch.

Sources: arXiv 2406.14562 (+ project page), 2406.09403, VoT NeurIPS 2024
(2404.03622), ACL 2026 short (CoT degrades visual-spatial), emergentmind
MVoT survey, LATM 2305.17126 (ICLR 2024), Voyager 2305.16291, agent-skills
survey (Xu & Yan 2026), agentpatterns skill-library page.
