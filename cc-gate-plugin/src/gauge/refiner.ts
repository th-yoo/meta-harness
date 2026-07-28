// km-gauge refiner (pre-reg §2.2) — pure pieces of the derivation step:
// prompt construction + output parsing. The actual claude spawn lives in
// refiner-cli.ts (detached child); nothing here touches IO.

/** Refiner's parsed derivation — becomes the persisted gauge file payload. */
export interface GaugeDerivation {
  goalSummary: string
  criteria: string[]
  check: string | null
  confidence: number
}

export function buildRefinerPrompt(userPrompt: string): string {
  return [
    "You derive an acceptance gauge from a coding-agent task prompt.",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"goalSummary": string, "criteria": string[], "check": string|null, "confidence": number}',
    "- goalSummary: one sentence, what outcome the user asked for.",
    "- criteria: 1-5 testable acceptance statements (EARS-style: unambiguous, observable).",
    "- check: ONE cheap shell command run from the repo root; exit 0 iff the",
    "  work is done, non-zero otherwise (<30s, no network, no interactivity).",
    "  Use null when no reliable executable check exists — null beats a guess.",
    "- confidence: 0..1, how well the criteria capture the prompt's intent.",
    "",
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

/** Model text → validated derivation; undefined on any malformed shape. */
export function parseRefinerOutput(text: string): GaugeDerivation | undefined {
  // Tolerate fences and surrounding prose: take first "{" to last "}".
  const start = text.indexOf("{")
  const end = text.lastIndexOf("}")
  if (start < 0 || end <= start) return undefined

  let j: unknown
  try {
    j = JSON.parse(text.slice(start, end + 1))
  } catch {
    return undefined
  }
  if (typeof j !== "object" || j === null || Array.isArray(j)) return undefined
  const r = j as Record<string, unknown>

  if (typeof r.goalSummary !== "string" || !r.goalSummary) return undefined
  if (!Array.isArray(r.criteria) || r.criteria.length === 0) return undefined
  if (!r.criteria.every((c) => typeof c === "string" && c)) return undefined

  const check =
    typeof r.check === "string" && r.check.trim() ? r.check.trim() : null

  const confidence =
    typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0.5

  return { goalSummary: r.goalSummary, criteria: r.criteria as string[], check, confidence }
}
