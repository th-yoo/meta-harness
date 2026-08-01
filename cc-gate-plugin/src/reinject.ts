// §4.4 mechanism experiment — reinject wording.
// Pre-registration §4b: docs/superpowers/specs/
//   2026-07-28-kkamak-scorecard-preregistration.md
//
// The vendored kernel ends its block message with "…and re-run it." Correct
// for term-bench2, where the agent owns verify.sh; wrong for kkamak, where
// the GATE runs the check — the agent re-running it raises a permission
// prompt and stalls the fix loop (SM2 dogfood finding). The kernel is shared
// and drift-guarded, so the wording is adjusted HERE, in kkamak's own layer.
//
// Assignment is a deterministic hash of sessionID, ~50/50, so both arms
// accumulate CONCURRENTLY over the same workload. Interleaving is what lets
// the comparison survive workload drift without §4.3's full machinery.
//
// v2 (Gauntlet Loop F) is env-gated behind KKAMAK_REINJECT_V2=1 — the live
// v0/v1 assignment stays untouched until the user rules on the §4.4
// registration amendment adding a third arm.

export const REINJECT_VARIANTS = ["v0", "v1", "v2"] as const
export type ReinjectVariant = (typeof REINJECT_VARIANTS)[number]

/** Kernel's tail length for check output (vendor/complete-gate.ts OUT_TAIL,
 * unexported — same redeclaration precedent as gate-plugin/src/core.ts). */
const OUT_TAIL = 600

/** v1's next-action sentence: says who owns the check, who runs it, what to
 * do. Replaces (never joins) the kernel's bench-context instruction. */
const V1_SENTENCE =
  "This check is configured by the repository (gate.json); the gate runs it " +
  "automatically when you finish. Do not run it yourself — fix the failures " +
  "above and end your turn."

/** v2's gap-line detector: first rawOut line that looks like the decisive
 * failure. Mechanical on purpose — no model call, no heuristics beyond one
 * regex, so the arm stays deterministic and free. */
const V2_GAP_RE = /error|fail|FAIL|✗|assert/i

/** v2's gap-line length cap: a "single decisive failure" that needs more
 * than 200 chars is a paragraph, not a headline. */
const V2_GAP_MAX = 200

/** First rawOut line matching V2_GAP_RE, else the last non-empty line —
 * trimmed and capped to V2_GAP_MAX. Empty string only if rawOut is all
 * whitespace (callers fail open before that on truly empty rawOut). */
function biggestGapLine(rawOut: string): string {
  const lines = rawOut.split("\n")
  const hit = lines.find((l) => V2_GAP_RE.test(l))
  const nonEmpty = lines.filter((l) => l.trim() !== "")
  const line = hit ?? nonEmpty[nonEmpty.length - 1] ?? ""
  return line.trim().slice(0, V2_GAP_MAX)
}

/** FNV-1a: tiny, stable across processes and hosts (Math.random is not). */
function hash(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h >>> 0
}

/**
 * Arm for this session. Deterministic, so every round of one gate cycle —
 * and every cycle in one session — sees the same wording; a session that
 * flip-flopped mid-experiment would contaminate both arms.
 */
export function pickReinjectVariant(
  sessionID: string,
  env: Record<string, string | undefined> = process.env,
): ReinjectVariant {
  const forced = env["KKAMAK_REINJECT"]
  if (forced === "v0" || forced === "v1" || forced === "v2") return forced
  // Third arm is opt-in only (KKAMAK_REINJECT_V2=1): without the flag the
  // live 50/50 v0/v1 assignment is byte-identical to pre-v2 behaviour.
  if (env["KKAMAK_REINJECT_V2"] === "1") {
    return REINJECT_VARIANTS[hash(sessionID) % 3]!
  }
  return hash(sessionID) % 2 === 0 ? "v0" : "v1"
}

/**
 * Produce the arm's block message.
 *
 * v0 = kernel evidence VERBATIM (deployed baseline).
 * v1 = COMPOSED FRESH from the raw check output — never reads or edits the
 * kernel's prose, so text-collision edge cases (self-referential output,
 * idempotency, unknown shapes) cannot exist. Fail-open: without rawOut the
 * kernel evidence passes through untransformed.
 * v2 = v1's composition with a "biggest gap:" headline FIRST — one line
 * naming the single decisive failure, extracted mechanically from rawOut —
 * so the agent reads the gap before the evidence dump. Same fail-open rule.
 */
export function applyReinjectVariant(
  evidence: string,
  variant: ReinjectVariant,
  rawOut?: string,
): string {
  if (variant === "v0") return evidence
  if (rawOut === undefined || rawOut === "") return evidence // fail-open
  const gap = variant === "v2" ? `biggest gap: ${biggestGapLine(rawOut)}\n` : ""
  return (
    gap +
    "not done: the repository's completion check failed:\n" +
    rawOut.slice(-OUT_TAIL) +
    "\n" +
    V1_SENTENCE
  )
}
