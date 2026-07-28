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

export const REINJECT_VARIANTS = ["v0", "v1"] as const
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
  if (forced === "v0" || forced === "v1") return forced
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
 */
export function applyReinjectVariant(
  evidence: string,
  variant: ReinjectVariant,
  rawOut?: string,
): string {
  if (variant === "v0") return evidence
  if (rawOut === undefined || rawOut === "") return evidence // fail-open
  return (
    "not done: the repository's completion check failed:\n" +
    rawOut.slice(-OUT_TAIL) +
    "\n" +
    V1_SENTENCE
  )
}
