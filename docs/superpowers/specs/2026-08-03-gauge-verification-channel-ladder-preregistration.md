# Gauge verification-channel ladder — pre-registration (2026-08-03)

**Status:** DRAFT — constants freeze at the first channel-classification
datum (first `channel --go` record). Open rulings in §6.

## 1. The ladder (definitions — these are the law)

- **C1 (programmatic)**: the prompt's own text states a success condition
  mechanically checkable by a shell command against a named in-repo
  artifact. Existing gauge class C (extract path) and class B
  (floor-covered) both land here.
- **C2 (LLM-verifiable)**: a falsifiable completion criterion is stated
  in the prompt's own words, but checking it requires judgment over
  content (does this explanation answer the question asked; does this
  review cover the diff) — an LLM judge with ONLY the prompt + the final
  artifact could return pass/fail non-vacuously.
- **C3 (human-verifiable)**: a falsifiable criterion is stated but
  judging it needs information or authority outside any transcript
  (taste ruled out — "the user will know it when they see it" is NOT C3;
  C3 requires the criterion itself to be stated, only its judging needs
  the human). Mechanical floor for C3 = demonstrability: evidence
  surfaced in-transcript.
- **C4 (no criterion)**: no falsifiable completion criterion under any
  channel — unbounded adjectives ("better", "cleaner"), unstated scope,
  no boolean exit derivable FROM THE PROMPT'S OWN TEXT.
- **exempt**: class A1 (no evaluation needed) — outside the ladder.

## 2. Class → channel mapping (deterministic part)

A1→exempt · B→C1 · C→C1. A2 and D require a model refinement question
(§3) — they contain the C2/C3/C4 split this instrument exists to measure.

## 3. Refinement question

Verbatim prompt text lives in `cc-gate-plugin/src/gauge/channel.ts`
`buildChannelPrompt`; this spec fixes its CONCEPT: given the prompt text
alone — is a falsifiable completion criterion stated? If yes, could an
LLM judge decide pass/fail from prompt + final artifact alone (C2), or
does judging need a human (C3)? If no criterion is stated at all: C4.
Same blind-isolation discipline as the cls-ab label rubric: the question
never sees stored classes or arm outputs.

## 4. Measurement before actuation (binding order)

1. Batch-classify the existing corpus A2/D records (cost-fenced sized
   go). Script-tally the C2/C3/C4 distribution per host.
2. Only after the C4 base rate is a measured number does the nudge
   arming question go to the user, WITH that number in it.

## 5. Nudge policy (v1, PROPOSED)

- Soft only: UserPromptSubmit additionalContext nudge asking for a
  measurable exit + naming the cheapest channel. NEVER decision:"block"
  in v1. Hard-reject exists only as a §6 open ruling for a future
  loop-shaped band, out of v1 scope.
- Config-flagged: `gate.json` key `"channelNudge": true` arms it;
  absent/false = fully inert (no model call, no latency).
- Prompt-time classification budget: PROPOSED timeout 8s, fail-open
  (timeout/error = no nudge, never a block); heuristic prefilter
  (PROPOSED: prompt length >= 80 chars AND not starting with "/") so
  chat-shaped prompts never trigger a model call.

## 6. Open rulings

1. Nudge text final wording (Task 5 carries a PROPOSED draft).
2. Prompt-time model: opus (judgment rule, costly) vs cls-ab-winning
   cheap arm (only after that verdict lands + within its measured F1
   margin). PROPOSED: no prompt-time arming at all until cls-ab verdict.
3. Prefilter constants (80 chars, "/" exclusion) — freeze at first
   armed firing.
4. Over-refusal bar for the armed nudge, mirroring 7b §6: first N=30
   nudge firings, user-judged spurious rate <= 0.20; failing caps
   rollout, never silently loosens. (PROPOSED N and bar.)
5. Hard-reject band (loop-shaped prompts): entirely deferred; needs its
   own registration.

## 7. Falsification

If the measured C4 rate on the corpus is < 5%, the nudge's value is
marginal — registering now: a sub-5% C4 rate parks Task 5's arming
indefinitely (build stays inert) rather than lowering the trigger bar
to manufacture firings.
