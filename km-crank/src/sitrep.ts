/**
 * sitrep.ts — formatSitrep (PURE) + postSlack (impure, the ONLY place the
 * Slack bot token is read — never logged, never returned, never passed
 * anywhere else).
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

/** Action taken this round. The four kinds named in the brief
 * (skipped/proposed-staged/review-rejected/proposer-timeout), plus two
 * additions this composition needs to represent real propose.ts outcomes
 * faithfully (see crank.ts's outcome-detection comment):
 *   - "no-op": the proposer ran to completion but its content was identical
 *     to active (propose.ts's own no-op guard) — no candidate, no rejection.
 *   - "failure": the top-level catch-all for any thrown error.
 * "skipped" itself is never passed to formatSitrep from crank.ts (routine
 * skips print a log line and never post to Slack) but is kept in the union
 * for completeness / testability. Same for "skip-trial" / "skip-inflight"
 * (FIX 1 / FIX 2, gate.ts's decideGate outcomes): both are routine skips —
 * crank.ts prints a distinct log line and returns WITHOUT calling
 * formatSitrep/postSlack at all. They exist here only for formatting
 * symmetry with the other skip kind and so the render logic is testable in
 * isolation.
 *
 * §4.3 trial kinds (plan Task 6): every gate-outcomes trial transition posts
 * a SITREP (spec §6, "auto with post-hoc veto" — the SITREP is the veto's
 * eyes). Each carries an optional TrialSitrepDetail so the render can show
 * the per-arm N_eff triplet and per-host coverage (spec §3/§7). */
export type SitrepAction =
  | { kind: "skipped" }
  | { kind: "skip-trial" }
  | { kind: "skip-inflight" }
  | { kind: "proposed-staged"; scope: string; version: string; bulletText: string; falsifyIf?: string }
  | { kind: "review-rejected"; reason: string }
  | { kind: "proposer-timeout" }
  | { kind: "no-op" }
  | { kind: "failure"; message: string }
  | { kind: "trial-keep"; scope: string; trial: string; detail?: TrialSitrepDetail }
  | { kind: "trial-rollback"; scope: string; trial: string; reason: string; detail?: TrialSitrepDetail }
  | { kind: "trial-deferred"; scope: string; reason: string; detail?: TrialSitrepDetail }
  | { kind: "trial-pending"; scope: string; projection: string; detail?: TrialSitrepDetail }
  | { kind: "trial-abandoned"; scope: string; reason: string; detail?: TrialSitrepDetail }

/** §3 N_eff: three denominators, printed separately so a thin arm cannot
 * hide behind a healthier-looking one. */
export interface TrialArmTriplet {
  cycleCount: number
  sessionCount: number
  sessionsWithGateCycle: number
}

export interface TrialSitrepDetail {
  perArm: { baseline: TrialArmTriplet; trial: TrialArmTriplet }
  /** Distinct hosts observed in the sensor stream read for the verdict (§7:
   * a stale or one-host-only read must be visible, not silently complete). */
  hosts: string[]
}

export interface RepoSummary {
  repo: string
  newLines: number
  cleanAccepts: number
  fixCycles: number
  exhausted: number
  interrupted: number
  medianDurationMs: number
}

export interface SitrepOutcome {
  generatedAt: number
  repos: RepoSummary[]
  targetRepo?: string
  action: SitrepAction
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`
}

/** Per-arm N_eff triplet + per-host coverage note for trial-* actions. */
function trialDetailLines(d?: TrialSitrepDetail): string[] {
  if (!d) return []
  const t = (a: TrialArmTriplet) =>
    `cycles ${a.cycleCount} · sessions ${a.sessionCount} · sessions-with-gate-cycle ${a.sessionsWithGateCycle}`
  return [
    `per-arm N_eff — baseline: ${t(d.perArm.baseline)} | trial: ${t(d.perArm.trial)}`,
    `host coverage: ${d.hosts.length ? d.hosts.join(", ") : "(no sensor lines read)"} — a one-host-only read is visible here, never silently treated as complete`,
  ]
}

/** PURE. markdown-ish Slack text (mrkdwn: *bold*, `code`, > quote). */
export function formatSitrep(o: SitrepOutcome): string {
  const lines: string[] = []
  lines.push(`*km-crank SITREP* — ${new Date(o.generatedAt).toISOString()}`)

  if (o.repos.length > 0) {
    lines.push("")
    lines.push("*Aggregates (new lines this round):*")
    for (const r of o.repos) {
      const mark = o.targetRepo === r.repo ? " ← target" : ""
      lines.push(
        `- ${r.repo}: ${r.newLines} new | clean=${r.cleanAccepts} fix=${r.fixCycles} ` +
          `exhausted=${r.exhausted} interrupted=${r.interrupted} median=${fmtMs(r.medianDurationMs)}${mark}`,
      )
    }
  }

  lines.push("")
  switch (o.action.kind) {
    case "skipped":
      lines.push("*Action:* SKIPPED (below threshold, recent run)")
      break
    case "skip-trial":
      lines.push("*Action:* SKIPPED (trial already in progress for the target layer)")
      break
    case "skip-inflight":
      lines.push("*Action:* SKIPPED (proposer already in flight for the target layer)")
      break
    case "proposed-staged": {
      lines.push(`*Action:* PROPOSED+STAGED — candidate \`${o.action.version}\` (${o.action.scope})`)
      lines.push("")
      lines.push(`> ${o.action.bulletText.trim().slice(0, 1000)}`)
      if (o.action.falsifyIf) lines.push(`\nfalsify_if: ${o.action.falsifyIf}`)
      lines.push("")
      lines.push(
        `Next step: review the staged candidate, then launch a trial manually ` +
          `(\`bun term-bench2/runner.ts ab\` or your usual A/B flow) for ${o.action.scope} ${o.action.version}.`,
      )
      break
    }
    case "review-rejected":
      lines.push(`*Action:* REVIEW-REJECTED — ${o.action.reason}`)
      lines.push("")
      lines.push("No candidate was created; the rejected bullet was recorded in the layer's rejected.json ledger.")
      break
    case "proposer-timeout":
      lines.push("*Action:* PROPOSER-TIMEOUT — no staged artifact within the 10-minute window")
      lines.push("")
      lines.push(
        "Next step: check ~/.config/kkamak/km-crank/crank.log and the proposer's own runtime log; " +
          "positions were NOT advanced, so this round's sensor lines stay pending for the next run.",
      )
      break
    case "no-op":
      lines.push("*Action:* NO-OP — proposer ran, found nothing new to propose vs. the active layer")
      break
    case "failure":
      lines.push(`*Action:* FAILURE — ${o.action.message}`)
      lines.push("")
      lines.push("Next step: check ~/.config/kkamak/km-crank/crank.log for the stack trace; re-run with --force once resolved.")
      break
    case "trial-keep":
      lines.push(`*Action:* TRIAL-KEEP — trial \`${o.action.trial}\` kept at ${o.action.scope}`)
      lines.push('KEEP means "not measurably worse than baseline", never "better" (spec §5 adoption semantics).')
      lines.push(...trialDetailLines(o.action.detail))
      break
    case "trial-rollback":
      lines.push(`*Action:* TRIAL-ROLLBACK — trial \`${o.action.trial}\` rolled back at ${o.action.scope}`)
      lines.push(`> ${o.action.reason}`)
      lines.push("Baseline snapshot restored; the candidate remains re-proposable (no rejected-ledger entry, spec §5).")
      lines.push(...trialDetailLines(o.action.detail))
      break
    case "trial-deferred":
      lines.push(`*Action:* TRIAL-DEFERRED — ${o.action.scope}: ${o.action.reason}`)
      lines.push("Floors met but a needed metric is null — nothing enacted, the trial stays live (never coerced to 0).")
      lines.push(...trialDetailLines(o.action.detail))
      break
    case "trial-pending":
      lines.push(`*Action:* TRIAL-PENDING — ${o.action.scope}: ${o.action.projection}`)
      lines.push("Nothing enacted; proposing stays paused for this layer while the trial is live.")
      lines.push(...trialDetailLines(o.action.detail))
      break
    case "trial-abandoned":
      lines.push(`*Action:* TRIAL-ABANDONED — ${o.action.scope}: ${o.action.reason}`)
      lines.push("Trial cleared without a KEEP/ROLLBACK verdict (spec §5 abandon class).")
      lines.push(...trialDetailLines(o.action.detail))
      break
  }

  return lines.join("\n")
}

/**
 * Impure: read the Slack bot token from ~/.squad/ccacp-slack.env (the ONLY
 * place this module touches that file) and POST to chat.postMessage. Throws
 * on any failure (missing token, network error, `!ok` response) — crank.ts's
 * top-level catch turns that into a best-effort failure log, never a crash
 * that leaves stale in-flight state.
 */
export async function postSlack(text: string): Promise<void> {
  const envPath = path.join(os.homedir(), ".squad", "ccacp-slack.env")
  const raw = fs.readFileSync(envPath, "utf-8")
  let token: string | undefined
  for (const line of raw.split("\n")) {
    const m = line.match(/^SLACK_BOT_TOKEN=(.+)$/)
    if (m) {
      token = m[1]!.trim()
      break
    }
  }
  if (!token) throw new Error("postSlack: SLACK_BOT_TOKEN not found in ~/.squad/ccacp-slack.env")

  const res = await fetch("https://slack.com/api/chat.postMessage", {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({ channel: "D0BJ3K33NNP", text }),
  })
  const json = (await res.json()) as { ok: boolean; error?: string }
  if (!json.ok) throw new Error(`postSlack: chat.postMessage failed (${json.error ?? "unknown error"})`)
}
