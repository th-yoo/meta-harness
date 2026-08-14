/** opencode-plugin/src/review-gate.ts — production Reviewer seat.
 * Core review logic lives in minimal/review.ts (injectable, code-computed
 * verdict); this file adapts it to HarnessHost + the playbook-ops shape and
 * writes nothing — callers own the ledger. Bounded revise: 1 round,
 * diagnosis frozen (docs/2026-07-24-proposer-review-loop.md). */
import { reviewBullet, reviewLoop, extractJsonObject, type ProposalLike } from "../../minimal/review.ts"
import type { HarnessHost } from "./host.ts"
import { isFormOnlyReject, type RejectedEntry } from "./harness-store.ts"
import { screenCheck } from "./check-screen.ts"

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
  bullet: string // final text (may differ from input after revision); for a
  // check-screen rejection this is the ORIGINAL text + " [check: screen-denied
  // (<slug>)]" — never the command text (it must be ledger-safe).
  staged: boolean // true = passed review (possibly revised)
  violations: string[] // final violations when staged=false
  trail: { round: number; bullet: string; verdict: "pass" | "fail" }[]
  // Present iff staged AND the input bullet carried a check — screen-stamped
  // liveEligible ("live" tier -> true, "bench" -> false). Never present on a
  // rejected outcome.
  check?: { cmd: string; timeoutMs: number; liveEligible: boolean }
}

function ledgerText(ledger: RejectedEntry[]): string {
  if (ledger.length === 0) return "(none recorded)"
  return ledger
    .map((e) => `- [${e.rejectedAt} ${e.scope} ${e.version}] ${e.bullet} (violations: ${e.violations.join("; ")})`)
    .join("\n")
}

function revisionPrompt(p: ProposalLike, violations: string[], rejected: string, checkCmd?: string): string {
  return `You are the LESSON PROPOSER in a REVISION round. Your previously proposed
rule failed external review. Your DIAGNOSIS is FROZEN — do not re-diagnose.
Reform ONLY the rule so it fixes the violations below, stays behavior-level
("When <trigger>, <action>." or "Do not X until Y", <=60 words, no task/domain
specifics), or abstain if impossible.

## Frozen diagnosis
${p.reason ?? ""}
## Your rejected rule
${p.bullet?.text ?? ""}${
    checkCmd
      ? `
## Attached check (RIDES WITH this rule — it will be attached to your revised
text verbatim. Your revised rule MUST still describe exactly the behavior this
command verifies; if no compliant rewrite can stay verified by it, abstain.)
\`${checkCmd}\``
      : ""
  }
## Review violations
${violations.map((v) => `- ${v}`).join("\n")}
## Previously REJECTED lessons (do NOT re-derive)
${rejected}

Reply with EXACTLY ONE JSON object:
{"action":"propose"|"abstain","reason":"<one sentence>","bullet":{"text":"<the rule>"}}`
}

/**
 * Review every added bullet through minimal/review.ts's layer1 + rubric +
 * bounded-revise loop, adapted to HarnessHost.runTextAgent. Writes nothing
 * — the caller owns staging rejected-ledger entries for staged=false
 * outcomes (RG1: harness-store.ts appendRejectedLedger).
 *
 * A bullet carrying `check` is screened (check-screen.ts) BEFORE layer-1: a
 * proposal smuggling a `state` key in the check object is rejected outright
 * (state is downstream-stamped only, never proposer-set — harness-store.ts);
 * a `"rejected"` screen tier rejects the WHOLE bullet, with the ledger-bound
 * text carrying " [check: screen-denied (<slug>)]" — never the raw command
 * (a3 routing T4). `"bench"`/`"live"` tiers let the bullet's TEXT proceed to
 * the normal flow; a staged outcome then carries `check.liveEligible`
 * (`"live"` -> true, `"bench"` -> false).
 */
export async function reviewAddedBullets(a: {
  host: HarnessHost
  bullets: Array<{ text: string; check?: { cmd: string; timeoutMs: number } }> // ops with type "add"
  diagnosisReason: string // frozen diagnosis (from diagnosis.json summary)
  activeSystem: string // current harness text for duplicate check
  ledger: RejectedEntry[] // rejected ledger for duplicate check
  scope: string
  // ModelSpec object (harness-store.ts parseModelSpec's return shape), NOT a
  // bare "provider/model" string — this IS what both host.runTextAgent
  // implementations expect in opts.model (cc-host.ts's isProviderModelSpec
  // guard, opencode-host.ts's `opts.model as {providerID,modelID}` cast).
  reviewModel?: { providerID: string; modelID: string }
}): Promise<BulletReviewOutcome[]> {
  if (a.bullets.length === 0) return []
  // Form-only rejects are rephrase-eligible (see isFormOnlyReject) — they
  // must not appear in the duplicate-check comparison set, or the rephrase
  // the proposer prompt invites gets killed as "duplicate" of its ancestor.
  const rejected = ledgerText(a.ledger.filter((e) => !isFormOnlyReject(e)))
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
  for (const b of a.bullets) {
    let tier: "bench" | "live" | undefined
    if (b.check) {
      // A well-formed proposer op never carries "state" (harness-store.ts:
      // BulletCheck.state is stamped downstream, applyPlaybookOps/check-
      // screen.ts only) — treat its presence as a smuggling attempt and
      // reject before spending a screen or an LLM call.
      if ((b.check as unknown as Record<string, unknown>)["state"] !== undefined) {
        out.push({ bullet: b.text, staged: false, violations: ["check-screen:state-not-proposer-set"], trail: [] })
        continue
      }
      const screened = screenCheck(b.check)
      if (screened.tier === "rejected") {
        out.push({
          bullet: `${b.text} [check: screen-denied (${screened.reason})]`,
          staged: false,
          violations: [`check-screen:${screened.reason}`],
          trail: [],
        })
        continue
      }
      tier = screened.tier
    }
    const proposal: ProposalLike = { action: "propose", reason: a.diagnosisReason, bullet: { text: b.text } }
    const { final, staged, trail } = await reviewLoop({
      proposal,
      rounds: REVISE_ROUNDS,
      review: (bullet, reason) =>
        reviewBullet({ bullet, reason, harness: a.activeSystem, rejected, taskId: "", checkCmd: b.check?.cmd, call }),
      revise: async (p, r) => {
        // Layer-1 fails are deterministic and cheap to detect — free-fail
        // fast with NO LLM call, matching reviewBullet's own free-fail path
        // (minimal/review.ts) — EXCEPT form-only fails: form is the one
        // violation class fixable by pure rephrasing, so it gets the same
        // single revision round rubric fails get (revisionPrompt states the
        // two accepted shapes). Word-cap/leak keep the free-fail: rephrasing
        // a leak risks laundering the leaked content instead of removing it.
        const formOnly = !r.layer1.pass && r.layer1.violations.every((v) => v.startsWith("form:"))
        if (!r.layer1.pass && !formOnly)
          return { action: "abstain", reason: `layer-1 free-fail: ${r.violations.join("; ")}` }
        const reply = await call(revisionPrompt(p, r.violations, rejected, b.check?.cmd))
        return (
          (extractJsonObject(reply, /\{\s*"action"/) as ProposalLike) ?? {
            action: "abstain",
            reason: "revision reply unparseable",
          }
        )
      },
    })
    out.push({
      // A judge-rejected CHECKED bullet ledgers with an F2-safe suffix noting
      // the check existed (tier only, never the command) — without it the
      // ledger reads as prose-only and future proposers/humans can't tell a
      // mechanized proposal was rejected on other axes.
      bullet:
        !staged && b.check && tier
          ? `${final.bullet?.text ?? b.text} [check: attached (${tier})]`
          : (final.bullet?.text ?? b.text),
      staged,
      violations: staged ? [] : trail[trail.length - 1]!.review.violations,
      trail: trail.map((t) => ({ round: t.round, bullet: t.bullet, verdict: t.review.verdict })),
      ...(staged && b.check ? { check: { cmd: b.check.cmd, timeoutMs: b.check.timeoutMs, liveEligible: tier === "live" } } : {}),
    })
  }
  return out
}
