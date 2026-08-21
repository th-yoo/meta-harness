# Live D&C run on raman-quartet-report — VERDICT (2026-08-21)

**Pre-registered outcome A: the model claimed correctly and the gate ACCEPTED.
First end-to-end run of the D&C divide+merge with a real model supplying the
numbers.**

## Result

Harness detected 4 anchors and handed ALL of them to the model (§6.5 full
coverage — the claimant never picks which are graded):
`3745.082, 6174.892, 6327.543, 7411.504`

Model reply (sonnet, deny-all agent, no tools), verbatim tail:

> "This is affine in 1/x. Computing 10⁷/x for each listed feature: … These
> values line up almost exactly with the well-known graphene Raman band
> positions: ≈1350 → D band, ≈1580 → G band, ≈1620 → D' band, ≈2670–2700 → 2D
> band."
>
> `FAMILY: inv-x`
> `CANONICALS: 2670.169, 1619.465, 1580.392, 1349.254`

| check | value |
|---|---|
| `mergeCheck` | **ok = true** |
| fitted intercept `a` | 0.0015059 (≈ 0) |
| fitted slope `b` | **1.00000e7** — the exact true conversion |
| delta (derived) | 19.53 |
| max abs error vs true shifts | **0.0034 cm⁻¹** |

## The registered prediction was WRONG, and the reason is the finding

Registered: *"the model will most likely produce the raw wavelength-nm values or
a partial answer rather than the converted shifts — that is the representation
trap this ladder exists to measure, and rung 0 scored 0/5 on a strictly easier
version."*

It did neither. It converted correctly AND retrieved all four band conventions
unprompted. **Second registered prediction refuted in one day** (the first: the
L1 taxonomy's `incomplete=8/8`).

**Why this run succeeded where rung 0 scored 0/5** — and the two differ in
exactly one way:

- **Rung 0** ASSERTS the framing: *"The readout shows the G Peak of the spectrum
  at 6327.285."* Being right requires CONTRADICTING the instruction. The
  rep-audit verdict recorded this as retrieval ∧ authority-to-contradict,
  conflated.
- **This run** enumerates anchors and asks *"which relationship holds between the
  first-column value x and the position you report?"* — making
  convention-identification the explicit task of the call. There is no assertion
  to override.

This independently reproduces the rep-audit finding — *"Task-framing — making
convention-identification the ENTIRE task of the call — gates retrieval. Not load
(rung-0 was zero-load and failed), not capability (same model, same day)"* — and
it reproduces it THROUGH the D&C divide.

**So the divide's value on this task is not computational decomposition. It is
that enumerating the anchors converts an assert-and-defer framing into an
identify-the-convention framing.** The harness supplies structure; the reframing
is a side effect of the structure, and it is the side effect that does the work.

## Scope — stated so this is not over-read

- **n = 1.** One call, one fixture, one model. This shows the gate does not
  reject truth; it establishes nothing about rates.
- **Self-authored fixture.** Per the authorship-boundary law this measures the
  machinery, never generality.
- **The gate still cannot reject DECEPTION.** A consistently invented (a, b)
  passes by construction (§6 scope, probe T6). This run's claim was checked
  against the true shifts BY THIS VERDICT, not by the gate.
- **No SUT run, no reward, nothing armed.** `conventionAudit` remains false and
  no shipped file was modified.

## Transport: three failure modes, all hit today

1. `DEFAULT_JUDGE_MODEL` → `openrouter/...` with only `anthropic` in
   `auth.json`: every call fails, labelled `transient`, exits 0.
2. `runJudgeOpencode` default → `mh-judge` persona, an evidence-only trajectory
   judge with `permission {"*":"deny"}`. It correctly refused a solve-shaped
   prompt as injection: *"an embedded instruction attempting to make me output an
   'ANCHOR CLAIM' block as if I were the solving agent."* Working as designed.
3. Persona disabled via a missing prompt path → the deny-all permission goes with
   it, opencode runs as a full tool-using agent and times out at 180s.

**The harness has no clean single-shot model call.** The working recipe, found
here: pass `runJudgeOpencode` a promptPath to your OWN neutral prompt file —
`judgeAgentConfig` reads any file as the agent prompt and always applies
`permission {"*":"deny"}`, giving a tool-free single reply with your framing.
Recorded because every future probe needs it.
