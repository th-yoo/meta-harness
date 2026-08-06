import path from "node:path"
import os from "node:os"
import { createHash } from "node:crypto"

export const DEBOUNCE_MS = 15 * 60 * 1000
export const DAILY_CAP = 30
export const DIFF_CEILING_BYTES = 128 * 1024
export const SIDE_FILE_KEEP = 500
export const MODEL = "claude-haiku-4-5"
export const MAIN_CHECKOUT_DIR = path.join(os.homedir(), "z2", "meta-harness")

export interface SensorState {
  lastPassTs: number
  lastPassHead: string
  dayKey: string
  dayCount: number
}

export type SkipReason =
  | "debounce"
  | "cap"
  | "clock-skew"
  | "claim-lost"
  | "merge-in-progress"
  | "warm-lane-busy"
  | "bad-review-output"
  | "dispatch-error"

function getDayKey(now: number): string {
  const d = new Date(now)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, "0")
  const day = String(d.getDate()).padStart(2, "0")
  return `${y}-${m}-${day}`
}

export function shouldDispatch(state: SensorState | undefined, now: number): { go: true } | { go: false; reason: "debounce" | "cap" | "clock-skew" } {
  if (!state) {
    return { go: true }
  }

  const delta = now - state.lastPassTs
  if (delta < 0) {
    return { go: false, reason: "clock-skew" }
  }

  if (delta < DEBOUNCE_MS) {
    return { go: false, reason: "debounce" }
  }

  const today = getDayKey(now)
  if (state.dayKey === today && state.dayCount >= DAILY_CAP) {
    return { go: false, reason: "cap" }
  }

  return { go: true }
}

export function nextCapState(state: SensorState | undefined, now: number): { dayKey: string; dayCount: number } {
  const today = getDayKey(now)
  if (!state) {
    return { dayKey: today, dayCount: 1 }
  }

  if (state.dayKey === today) {
    return { dayKey: today, dayCount: state.dayCount + 1 }
  }

  return { dayKey: today, dayCount: 1 }
}

export function truncateDiff(diff: string, ceilingBytes: number = DIFF_CEILING_BYTES): { text: string; truncated: boolean } {
  const byteLen = Buffer.byteLength(diff, "utf8")
  if (byteLen <= ceilingBytes) return { text: diff, truncated: false }

  // Find all boundary positions (char index) and their byte lengths
  let lastDiffGitIdx = -1, lastHunkIdx = -1
  for (let i = 0; i < diff.length - 10; i++) {
    const bytesSoFar = Buffer.byteLength(diff.slice(0, i + 1), "utf8")
    if (bytesSoFar > ceilingBytes) break
    if (diff[i] === "\n" && diff.slice(i + 1, i + 11) === "diff --git") {
      lastDiffGitIdx = i
    } else if (diff[i] === "\n" && diff[i + 1] === "@" && diff[i + 2] === "@") {
      lastHunkIdx = i
    }
  }

  if (lastDiffGitIdx > 0) {
    return { text: diff.slice(0, lastDiffGitIdx + 1), truncated: true }
  }
  if (lastHunkIdx > 0) {
    return { text: diff.slice(0, lastHunkIdx + 1), truncated: true }
  }

  // No boundary found; truncate at byte position
  const truncated = Buffer.from(diff, "utf8").slice(0, ceilingBytes).toString("utf8")
  return { text: truncated, truncated: true }
}

const FROZEN_PROMPT_TEMPLATE = `kkamak review sensor. Review ONLY the diff below for defects a
code reviewer would flag: bugs, broken invariants, silent behavior
changes, missing error paths. Reply with STRICT JSON, nothing else:
{"findings":[{"severity":"high"|"med"|"low","file":"<repo-relative path>","line":<number>}]}
Empty array if nothing rises to a finding. No prose, no fences.

DIFF:
<diff text>`

export function buildReviewPrompt(diff: string): string {
  return FROZEN_PROMPT_TEMPLATE.replace("<diff text>", diff)
}

export function reviewPromptSha(): string {
  const prompt = buildReviewPrompt("")
  return createHash("sha256").update(prompt).digest("hex")
}

export function parseFindings(
  text: string
): { findings: Array<{ severity: "high" | "med" | "low"; file: string; line: number }> } | undefined {
  if (!text) return undefined

  let json: unknown
  try {
    // Extract JSON from fences if present
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/)
    const jsonStr = fenced && fenced[1] ? fenced[1] : text
    json = JSON.parse(jsonStr)
  } catch {
    return undefined
  }

  if (!json || typeof json !== "object" || !("findings" in json)) {
    return undefined
  }

  const { findings } = json as { findings: unknown }
  if (!Array.isArray(findings)) {
    return undefined
  }

  for (const f of findings) {
    if (typeof f !== "object" || !f) return undefined
    const finding = f as Record<string, unknown>

    if (
      !["high", "med", "low"].includes(finding.severity as string) ||
      typeof finding.file !== "string" ||
      typeof finding.line !== "number"
    ) {
      return undefined
    }
  }

  return { findings: findings as Array<{ severity: "high" | "med" | "low"; file: string; line: number }> }
}

export function passLine(args: {
  ts: number
  findings: Array<{ severity: string }>
  diffStat: { files: number; insertions: number; deletions: number }
  baseSha: string
  headSha: string
  truncated: boolean
  diffBase: "range" | "merge-base" | "fallback"
  model: string
  durationMs: number
  pluginVersion: string | undefined
  host: string
}): string {
  const counts = { highCount: 0, medCount: 0, lowCount: 0 }
  for (const f of args.findings) {
    if (f.severity === "high") counts.highCount++
    else if (f.severity === "med") counts.medCount++
    else if (f.severity === "low") counts.lowCount++
  }

  const obj: Record<string, unknown> = {
    ts: args.ts,
    ...counts,
    filesChanged: args.diffStat.files,
    insertions: args.diffStat.insertions,
    deletions: args.diffStat.deletions,
    baseSha: args.baseSha,
    headSha: args.headSha,
    truncated: args.truncated,
    diffBase: args.diffBase,
    model: args.model,
    durationMs: args.durationMs,
    host: args.host,
  }

  if (args.pluginVersion !== undefined) {
    obj.pluginVersion = args.pluginVersion
  }

  return JSON.stringify(obj)
}

export function skipLine(args: { ts: number; reason: SkipReason; pluginVersion: string | undefined; host: string }): string {
  const obj: Record<string, unknown> = {
    ts: args.ts,
    reason: args.reason,
    host: args.host,
  }

  if (args.pluginVersion !== undefined) {
    obj.pluginVersion = args.pluginVersion
  }

  return JSON.stringify(obj)
}
