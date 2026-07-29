// km-gauge refiner (pre-reg §2.2, v2 design 2026-07-29) — pure pieces of the
// derivation step: prompt construction + output parsing. The actual claude
// spawn lives in refiner-cli.ts (detached child); nothing here touches IO.
//
// v2 EXTRACTS ONLY: the refiner classifies the prompt (A1/A2/B/C/D) and, for
// class C only, extracts a check verbatim-anchored to the prompt. It never
// invents a check. Enforcement of the extraction discipline (check-iff-C,
// path-in-prompt, in-repo-scope, …) happens in code — validate.ts — never
// here; parseRefinerOutput below is SHAPE validation only.
import type { GaugeHorizon, GaugePromptClass } from "../types.ts"

/** Refiner's parsed derivation — becomes the persisted gauge file payload
 * once run through validate.ts. */
export interface GaugeDerivation {
  goalSummary: string
  class: GaugePromptClass
  reason: string | null
  criteria: string[]
  check: string | null
  horizon: GaugeHorizon | null
  confidence: number
}

const CLASS_LITERALS: readonly string[] = ["A1", "A2", "B", "C", "D"]
const HORIZON_LITERALS: readonly string[] = ["single-turn", "multi-turn"]

// TEMPORARY(v2-T2): the "" default exists only so refiner-cli.ts's current
// single-arg call site (Task 2/3 scope, not touched here) keeps compiling
// against this Task-1 signature change. Task 2 must drop this default once
// refiner-cli.ts is wired to pass cfg.check explicitly — an unarmed floor
// should be an explicit "" argument from the caller, not a silent fallback.
export function buildRefinerPrompt(userPrompt: string, floorCheck = ""): string {
  return [
    "You classify a coding-agent task prompt and, ONLY when possible, EXTRACT a completion check from it.",
    "Output ONLY a JSON object, no prose, no markdown fences:",
    '{"goalSummary": string, "class": "A1"|"A2"|"B"|"C"|"D", "reason": string|null, "criteria": string[], "check": string|null, "horizon": "single-turn"|"multi-turn"|null, "confidence": number}',
    "",
    "Pick exactly one class, by where the completion criterion lives:",
    '- "A1": no evaluation needed (greeting, chat, trivial acknowledgement). reason "no-eval-needed".',
    '- "A2": the criterion is the QUALITY of the reply or judgment (research, review, explanation, planning) — real, but not checkable by a shell command. reason "not-shell-checkable".',
    '- "B": the criterion is already covered by the repo\'s own gate check shown below (e.g. "fix the failing tests", "make the build green"). reason "floor-covered".',
    '- "C": the prompt ITSELF states an observable property of a file or path inside this repo AND names that path literally. Only then extract a check.',
    '- "D": a criterion exists, but writing a check would require inventing paths or conventions not present in the prompt (reason "not-extractable"), or observing something outside this repo (reason "out-of-scope").',
    "",
    `The repo's own gate check (for class B): ${floorCheck === "" ? "(none armed)" : floorCheck}`,
    "",
    "Extraction discipline (class C only — violations are detected in code and discarded):",
    "- check: ONE cheap read-only shell command run from the repo root; exit 0 iff the work is done, non-zero otherwise (<30s, no network, no writes, no interactivity).",
    "- Every file or directory path in the check MUST appear verbatim, character for character, in the task prompt below. If the prompt names no usable path, the class is D and check is null.",
    "- The check must test a property the prompt itself states — never a guessed proxy (no git-status dirtiness, no repo-wide greps for something the prompt scoped to one file).",
    "- When in doubt between C and D, choose D. null beats a guess.",
    "- check MUST be null for every class except C.",
    "",
    "horizon (class C only, null for all other classes):",
    '- "single-turn": plausibly completable in one assistant turn.',
    '- "multi-turn": a larger task; its check should only be trusted after more than one turn of work.',
    "",
    "- goalSummary: one sentence, what outcome the user asked for.",
    "- criteria: 1-5 testable acceptance statements (unambiguous, observable).",
    "- confidence: 0..1, how well class+check capture the prompt's intent.",
    "",
    "Task prompt:",
    "<<<PROMPT",
    userPrompt,
    "PROMPT",
  ].join("\n")
}

/** Model text → SHAPE-validated derivation; undefined on any malformed shape.
 * Does NOT enforce check-iff-C, path-in-prompt, or any other extraction
 * discipline — that's validate.ts's job so violations are recorded
 * downgrades, not silently vanished. */
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
  if (typeof r.class !== "string" || !CLASS_LITERALS.includes(r.class)) return undefined
  const cls = r.class as GaugePromptClass

  const check = typeof r.check === "string" && r.check.trim() ? r.check.trim() : null

  const confidence =
    typeof r.confidence === "number" && Number.isFinite(r.confidence)
      ? Math.min(1, Math.max(0, r.confidence))
      : 0.5

  const reason = typeof r.reason === "string" && r.reason.trim() ? r.reason.trim() : null

  const horizon =
    typeof r.horizon === "string" && HORIZON_LITERALS.includes(r.horizon)
      ? (r.horizon as GaugeHorizon)
      : null

  return {
    goalSummary: r.goalSummary,
    class: cls,
    reason,
    criteria: r.criteria as string[],
    check,
    horizon,
    confidence,
  }
}
