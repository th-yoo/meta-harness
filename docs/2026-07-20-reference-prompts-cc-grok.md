# Reference Prompts for the Workflow Loop — extracted from CC + grok-build (2026-07-20)

Proven prompt wording to lift into the workflow-loop node prompts
(`2026-07-20-workflow-loop-design.md`, Component 2). Extracted from three SOTA coding
agents; **both Claude Code and grok-build independently ship our exact loop** (frozen
extract-contract → implement → adversarial verifier → retry-on-gaps, harness-owned), which
strongly validates the design. Sources were shallow-clones (volatile `/tmp`); this file is
the durable capture. Verbatim excerpts with citations; adapt wording, don't copy blindly.

## `[extract]` node — a frozen acceptance-criteria + verification-plan CONTRACT
The extract step should emit a durable contract the harness re-checks against **each** retry
(not re-derived per attempt).

**grok `crates/codegen/xai-grok-shell/src/session/templates/goal_planner_prompt.md`** — the
best structural match. Output shape:
```
# Plan: <one-sentence headline>
## Acceptance criteria
1. <gating, outcome-based criterion>
## Verification plan
1. <gating|evidence: action + the observations that MUST be present to pass>
## Non-goals
## Task checklist
- [ ] <first concrete step>
```
- "**Acceptance criteria** — the GATING set: every one must hold to pass, so keep it SMALL
  (aim 3-5) and satisficing. Numbered, concrete, one outcome each, anchored to the LITERAL
  objective: do NOT invent scope."
- "Each criterion must be **atomic and independently checkable** from near its own start
  state: never write a single holistic end-to-end gate — decompose into separate checks."
- "**Verification plan** — the shared procedure the implementer and the verifiers both
  follow, so all judge by the SAME observable bar. Tag each step `gating`/`evidence`. Each
  step gives the **action** (run the tests, exercise the entry point, read the artifact) and
  the **observations that MUST be present to pass**."
- "Specify **OUTCOMES, not architecture** … never a named artifact." (so checks test
  behavior, not file layout.)
- Per-deliverable check recipes: CLI → "run the real command … assert the actual output
  CONTENT, not just that it ran"; Server → "assert the response BODY is sane, not just an
  HTTP 200"; Library → "assert a real call's RETURN VALUE."

**CC `src/components/agents/generateAgent.ts`** — requirement intake:
- "**Extract Core Intent**: Identify the fundamental purpose, key responsibilities, and
  success criteria … both explicit requirements and implicit needs."

**CC `src/tools/TodoWriteTool/prompt.ts`** — infer implicit criteria: the dark-mode example
"inferred that tests and build need to pass by adding 'Ensure tests and build succeed' as
the final task."

## `[verify]` node — a SEPARATE adversarial verifier agent (chosen design)
An independent agent that AUDITS the implementer's work + evidence and emits a
machine-parseable verdict. It cannot edit project files.

**CC `src/tools/AgentTool/built-in/verificationAgent.ts`** — near drop-in:
- Framing: "You are a verification specialist. **Your job is not to confirm the
  implementation works — it's to try to break it.**" Two documented failure patterns:
  **verification avoidance** ("you find reasons not to run it … write 'PASS,' and move on")
  and **seduced by the first 80%** ("you see a passing test suite and feel inclined to pass
  it, not noticing half the buttons do nothing … The last 20% is your entire value").
- Anti-rationalization: "'The code looks correct based on my reading' — **reading is not
  verification. Run it.**"; "'The implementer's tests already pass' — the implementer is an
  LLM. Verify independently."; "If you catch yourself writing an explanation instead of a
  command, stop. Run the command."
- Required baseline: read CLAUDE.md/README for commands; "Run the build … A broken build is
  an automatic FAIL"; "Run the test suite … Failing tests are an automatic FAIL"; linters;
  regressions. "**Test suite results are context, not evidence.**"
- Adversarial probes (concurrency / boundary / idempotency / orphan ops): "Your report must
  include **at least one adversarial probe you ran** … If all your checks are 'returns 200'
  or 'test suite passes,' you have confirmed the happy path, not verified correctness."
- OUTPUT FORMAT (machine-parseable): each check = `### Check` → `**Command run:**` →
  `**Output observed:**` (copy-paste, not paraphrased) → `**Result: PASS|FAIL**`. "A check
  without a Command-run block is **not a PASS — it's a skip**." Terminal line parsed by the
  caller: `VERDICT: PASS` / `VERDICT: FAIL` / `VERDICT: PARTIAL` (PARTIAL = environmental
  limitation only, not "I'm unsure").
- Guard: "This is a VERIFICATION-ONLY task. You CANNOT edit … files IN THE PROJECT DIRECTORY
  (tmp is allowed for ephemeral test scripts)."

**grok `.../templates/goal_verifier_prompt.md`** — the "no test theater" + default-to-refute
teeth (directly counters the research's self-verifier-gaming / 16.3% false-positive risk):
- "You are an **adversarial verifier** … Your job is to **refute** that the objective has
  been met. **Default to `refuted: true` if uncertain** — a false-positive (passing broken
  work) ends the loop wrongly and is far worse than one more iteration."
- "**Audit, don't author** — AUDIT the evidence the implementer already produced; do NOT
  build your own. Judge whether the tests are HONEST, not HACKY: do they drive the real
  shipped code on the real path, or are they faked — hardcoded expected values, the unit
  under test mocked out, skipped / `#[ignore]` / `todo!()`."
- Anti-over-refute (so the verifier doesn't invent new requirements): "A criterion whose
  evidence holds is PASSED — do NOT refute it for missing edge cases. **Inventing
  requirements beyond the contract is the most common FALSE refute.**"

**grok `.../skills/check-work/SKILL.md`** — "Do not accept proxy signals as proof of
completion. Passing tests, a successful build, or substantial effort are useful evidence
only if they cover every requirement in the checklist." "**Verify outcomes, not just
code.**"

## `[retry]` node — feed the verifier's gaps back, re-check against the SAME plan
**grok `.../session/acp_session_impl/goal_support.rs` (`render_verifier_gaps_block`)** — the
literal feedback string:
> "Verification REJECTED your last `{goal_tool}(completed: true)` claim. Fix every gap the
> skeptic panel flagged below — these take priority — before claiming completion again:
> \n{gaps}"

**grok `.../templates/goal_continuation_directive.md`** — "run the plan's `## Verification
plan` steps yourself and confirm the observations it lists hold — the harness **re-checks
against those SAME steps each attempt** and inlines any outstanding verifier gaps."

**CC `src/constants/prompts.ts:394`** — "On FAIL: fix, resume the verifier with its findings
plus your fix, **repeat until PASS**."

**CC `src/constants/prompts.ts:233`** — diagnose, don't blind-retry: "If an approach fails,
diagnose why before switching tactics — read the error, check your assumptions, try a
focused fix. Don't retry the identical action blindly."

**grok `.../templates/goal_strategist_prompt.md`** — escalation after N stalled rounds
(optional, for the bounded loop's tail): "You run after the implementer has failed
verification several rounds in a row … Diagnose WHY it is stuck and recommend ONE concrete
STRUCTURAL change … refactor for testability, split a monolith into small pure units."

## Completion / "definition of done" (system-prompt-level, informs framing)
- **CC `prompts.ts:211`** — "Before reporting a task complete, verify it actually works: run
  the test, execute the script, check the output. … If you can't verify … say so explicitly
  rather than claiming success."
- **CC `prompts.ts:240`** — "Report outcomes faithfully: if tests fail, say so … never claim
  'all tests pass' when output shows failures, never suppress or simplify failing checks …
  never characterize incomplete or broken work as done."
- **CC `TodoWriteTool/prompt.ts:162-171`** — "ONLY mark a task as completed when you have
  FULLY accomplished it … Never mark completed if: Tests are failing / Implementation is
  partial / unresolved errors."
- **grok `.../templates/goal_rules.md`** — "VERIFY AS YOU GO … TEST PROACTIVELY … **NO TEST
  THEATER**: a passing test must prove the SHIPPED code works on the real path."

## Provenance
Extracted 2026-07-20 from shallow clones: `yasasbanukaofficial/claude-code` (reconstructed
CC, deobfuscated `src/`), `anthropics/claude-code` (`plugins/`), `xai-org/grok-build`
(plaintext Jinja templates under `crates/codegen/*/templates/`; also XOR-shipped, but the
templates are the authoritative source). Line numbers are from that snapshot.
