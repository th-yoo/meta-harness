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
 * for completeness / testability. */
export type SitrepAction =
  | { kind: "skipped" }
  | { kind: "proposed-staged"; scope: string; version: string; bulletText: string; falsifyIf?: string }
  | { kind: "review-rejected"; reason: string }
  | { kind: "proposer-timeout" }
  | { kind: "no-op" }
  | { kind: "failure"; message: string }

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
        "Next step: check ~/.config/meta-harness/km-crank/crank.log and the proposer's own runtime log; " +
          "positions were NOT advanced, so this round's sensor lines stay pending for the next run.",
      )
      break
    case "no-op":
      lines.push("*Action:* NO-OP — proposer ran, found nothing new to propose vs. the active layer")
      break
    case "failure":
      lines.push(`*Action:* FAILURE — ${o.action.message}`)
      lines.push("")
      lines.push("Next step: check ~/.config/meta-harness/km-crank/crank.log for the stack trace; re-run with --force once resolved.")
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
