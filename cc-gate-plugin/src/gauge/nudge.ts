// cc-gate-plugin/src/gauge/nudge.ts — pure pieces of the C4 nudge (spec §5:
// soft-only, config-flagged, fail-open). Model call + emission live in
// hook-cli's UserPromptSubmit branch; nothing here touches IO.

/** Spec §5 prefilter constants — FROZEN at first armed firing. */
const MIN_PROMPT_CHARS = 80

export function shouldConsiderPrompt(prompt: string): boolean {
  return prompt.length >= MIN_PROMPT_CHARS && !prompt.startsWith("/")
}

/** additionalContext text (spec §6 ruling 1 carries final wording; this is
 * the PROPOSED draft). Soft guidance to the model, invisible-to-user by
 * hook semantics; asks for a measurable exit, never refuses work. */
export function buildNudgeContext(channel: "C4"): string {
  return [
    "kkamak gauge: this prompt states no verifiable completion criterion",
    "(no programmatic check, no LLM-judgeable condition, no human-decidable",
    "condition in the prompt's own words). Before starting, restate the goal",
    "with a measurable, verifiable exit — e.g. name the artifact and the",
    "observable property that will hold when done — and confirm it with the",
    "user if the restatement changes scope.",
  ].join(" ")
}
