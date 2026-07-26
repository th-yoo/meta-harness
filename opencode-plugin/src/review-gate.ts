/** opencode-plugin/src/review-gate.ts — production Reviewer seat.
 * Core review logic lives in minimal/review.ts (injectable, code-computed
 * verdict); this file adapts it to HarnessHost + the playbook-ops shape and
 * writes nothing — callers own the ledger. Bounded revise: 1 round,
 * diagnosis frozen (docs/2026-07-24-proposer-review-loop.md). */
import { reviewBullet, reviewLoop, extractJsonObject, type ProposalLike } from "../../minimal/review.ts"
import type { HarnessHost } from "./host.ts"
import type { RejectedEntry } from "./harness-store.ts"

const REVISE_ROUNDS = 1

// runTextAgent's `system` REPLACES the child session's persona entirely
// (host.ts: "Judge transport: text-in/text-out, ALL tools denied, system
// prompt REPLACED"); the rubric + evidence go in the per-call prompt, built
// below via minimal/review.ts's buildReviewPrompt (inside reviewBullet).
const REVIEW_SYSTEM_PROMPT =
  "You are the Meta-Harness Bullet Reviewer: a strict, evidence-only external " +
  "check on a proposed playbook rule, before it is A/B tested at real compute " +
  "cost. You are NOT a coding agent; use no tools. Reply with a short " +
  "justification, then EXACTLY the one JSON object the prompt asks for."

export interface BulletReviewOutcome {
  bullet: string // final text (may differ from input after revision)
  staged: boolean // true = passed review (possibly revised)
  violations: string[] // final violations when staged=false
  trail: { round: number; bullet: string; verdict: "pass" | "fail" }[]
}

function ledgerText(ledger: RejectedEntry[]): string {
  if (ledger.length === 0) return "(none recorded)"
  return ledger
    .map((e) => `- [${e.rejectedAt} ${e.scope} ${e.version}] ${e.bullet} (violations: ${e.violations.join("; ")})`)
    .join("\n")
}

function revisionPrompt(p: ProposalLike, violations: string[], rejected: string): string {
  return `You are the LESSON PROPOSER in a REVISION round. Your previously proposed
rule failed external review. Your DIAGNOSIS is FROZEN — do not re-diagnose.
Reform ONLY the rule so it fixes the violations below, stays behavior-level
("When <trigger>, <action>." or "Do not X until Y", <=60 words, no task/domain
specifics), or abstain if impossible.

## Frozen diagnosis
${p.reason ?? ""}
## Your rejected rule
${p.bullet?.text ?? ""}
## Review violations
${violations.map((v) => `- ${v}`).join("\n")}
## Previously REJECTED lessons (do NOT re-derive)
${rejected}

Reply with EXACTLY ONE JSON object:
{"action":"propose"|"abstain","reason":"<one sentence>","bullet":{"text":"<the rule>"}}`
}

/**
 * Review every added-bullet text through minimal/review.ts's layer1 + rubric
 * + bounded-revise loop, adapted to HarnessHost.runTextAgent. Writes nothing
 * — the caller owns staging rejected-ledger entries for staged=false
 * outcomes (RG1: harness-store.ts appendRejectedLedger).
 */
export async function reviewAddedBullets(a: {
  host: HarnessHost
  bullets: string[] // texts of ops with type "add"
  diagnosisReason: string // frozen diagnosis (from diagnosis.json summary)
  activeSystem: string // current harness text for duplicate check
  ledger: RejectedEntry[] // rejected ledger for duplicate check
  scope: string
  reviewModel?: string
}): Promise<BulletReviewOutcome[]> {
  if (a.bullets.length === 0) return []
  const rejected = ledgerText(a.ledger)
  const call = async (prompt: string): Promise<string> => {
    const reply = await a.host.runTextAgent({
      title: `[meta-harness] review ${a.scope}`,
      system: REVIEW_SYSTEM_PROMPT,
      prompt,
      model: a.reviewModel,
    })
    return reply ?? "" // null (LLM down) → unparseable → fail-closed in computeVerdict
  }
  const out: BulletReviewOutcome[] = []
  for (const text of a.bullets) {
    const proposal: ProposalLike = { action: "propose", reason: a.diagnosisReason, bullet: { text } }
    const { final, staged, trail } = await reviewLoop({
      proposal,
      rounds: REVISE_ROUNDS,
      review: (bullet, reason) =>
        reviewBullet({ bullet, reason, harness: a.activeSystem, rejected, taskId: "", call }),
      revise: async (p, r) => {
        // Layer-1 fails are deterministic and cheap to detect — free-fail
        // fast with NO LLM call, matching reviewBullet's own free-fail path
        // (minimal/review.ts). Only rubric fails spend a revision round.
        if (!r.layer1.pass)
          return { action: "abstain", reason: `layer-1 free-fail: ${r.violations.join("; ")}` }
        const reply = await call(revisionPrompt(p, r.violations, rejected))
        return (
          (extractJsonObject(reply, /\{\s*"action"/) as ProposalLike) ?? {
            action: "abstain",
            reason: "revision reply unparseable",
          }
        )
      },
    })
    out.push({
      bullet: final.bullet?.text ?? text,
      staged,
      violations: staged ? [] : trail[trail.length - 1]!.review.violations,
      trail: trail.map((t) => ({ round: t.round, bullet: t.bullet, verdict: t.review.verdict })),
    })
  }
  return out
}
