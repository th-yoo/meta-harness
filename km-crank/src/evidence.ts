/**
 * evidence.ts — PURE: render the evidence markdown handed to the proposer
 * (via propose.ts's `evidenceDir` mechanism, see crank.ts) and left on disk
 * for a human to read.
 *
 * Placement note (crank.ts, not here): opencode-plugin/src/evidence.ts's
 * `buildExternalEvidenceSection`/`validateEvidenceDir` only discover files
 * laid out as `<dir>/<task>/<agent>.md` (listEvidenceFiles enumerates
 * SUBDIRECTORIES of `dir`, then .md files inside each) — a flat file sitting
 * directly at the evidence-dir root is invisible to it. crank.ts therefore
 * writes this module's output to `<evidenceDir>/kkamak-sensors/km-crank.md`
 * (one task "kkamak-sensors", one agent "km-crank") rather than
 * `<evidenceDir>/*.md`, so the proposer prompt's external-evidence section
 * actually indexes it instead of silently rendering empty. This module stays
 * agnostic to that placement — it only renders content.
 */
import type { Aggregate, SensorLine } from "./scan.ts"

export interface RepoEvidence {
  repo: string
  newLines: SensorLine[]
  aggregate: Aggregate
  notableLines: SensorLine[]
}

function fmtMs(ms: number): string {
  return `${Math.round(ms)}ms`
}

function renderRepoSection(r: RepoEvidence): string {
  const a = r.aggregate
  const lines: string[] = [
    `## ${r.repo}`,
    "",
    `- total new sensor lines: ${a.total}`,
    `- clean accepts (single round, "accepted"): ${a.cleanAccepts}`,
    `- fix cycles (verify-failed then accepted): ${a.fixCycles}`,
    `- gate-exhausted: ${a.exhausted}`,
    `- interrupted: ${a.interrupted}`,
    `- median duration: ${fmtMs(a.medianDurationMs)}`,
    "",
    `### Notable sessions (${r.notableLines.length})`,
    "",
  ]
  if (r.notableLines.length === 0) {
    lines.push("(none)")
  } else {
    for (const l of r.notableLines) {
      const flags = [l.gateExhausted ? "EXHAUSTED" : null, l.interrupted ? "INTERRUPTED" : null]
        .filter(Boolean)
        .join(",")
      lines.push(
        `- \`${l.sessionID}\` | ${l.check} | rounds=[${l.rounds.join(",")}] | accepted=${l.accepted} | ${fmtMs(l.durationMs)}${flags ? ` | ${flags}` : ""}`,
      )
    }
  }
  lines.push("", "### Raw notable lines (ndjson)", "", "```")
  for (const l of r.notableLines) lines.push(JSON.stringify(l))
  lines.push("```")
  return lines.join("\n")
}

/**
 * Render the full evidence markdown: an aggregate + notable-session section
 * per repo, followed by a pointer note. Deterministic given `generatedAt` —
 * no I/O, no clock reads.
 */
export function renderEvidence(repos: RepoEvidence[], generatedAt: number): string {
  const header = `# km-crank evidence — ${new Date(generatedAt).toISOString()}\n\n`
  const body = repos.map(renderRepoSection).join("\n\n")
  const pointer =
    "\n\n---\n\n" +
    "Full CC session transcripts for any sessionID above live under `~/.claude/projects/` " +
    "on the host that ran them (path-encoded by project + session id). This file carries " +
    "only the raw sensor line — read the transcript directly with your file tools if a " +
    "session's failure mode isn't clear from the summary above.\n"
  return header + body + pointer
}
