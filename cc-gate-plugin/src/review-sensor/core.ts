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
  const buf = Buffer.from(diff, "utf8")
  if (buf.length <= ceilingBytes) return { text: diff, truncated: false }

  // Find the last boundary marker of EITHER kind at or below the ceiling —
  // a file-header marker (`\ndiff --git`) or a hunk marker (`\n@@`). Both
  // scans always run: a multi-file diff whose bulk sits in a later file
  // must not be cut at that file's header when a later hunk boundary (its
  // own, or a subsequent file's) still fits within the ceiling.
  const diffGitMarker = Buffer.from("\ndiff --git")
  const hunkMarker = Buffer.from("\n@@")
  let lastDiffGitByte = -1, lastHunkByte = -1, idx = 0

  while ((idx = buf.indexOf(diffGitMarker, idx)) >= 0) {
    if (idx <= ceilingBytes) lastDiffGitByte = idx
    idx++
  }

  idx = 0
  while ((idx = buf.indexOf(hunkMarker, idx)) >= 0) {
    if (idx <= ceilingBytes) lastHunkByte = idx
    idx++
  }

  const cutByteOffset = Math.max(lastDiffGitByte, lastHunkByte)
  if (cutByteOffset > 0) {
    return { text: buf.slice(0, cutByteOffset + 1).toString("utf8"), truncated: true }
  }

  // No boundary found; truncate at byte position, backing off past continuation bytes
  let end = ceilingBytes
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--
  }
  return { text: buf.slice(0, end).toString("utf8"), truncated: true }
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
  const severityCounts = { high: 0, med: 0, low: 0 }
  for (const f of args.findings) {
    if (f.severity === "high") severityCounts.high++
    else if (f.severity === "med") severityCounts.med++
    else if (f.severity === "low") severityCounts.low++
  }

  const obj: Record<string, unknown> = {
    ts: args.ts,
    findingsCount: args.findings.length,
    severityCounts,
    diffStat: {
      files: args.diffStat.files,
      insertions: args.diffStat.insertions,
      deletions: args.diffStat.deletions,
    },
    baseSha: args.baseSha,
    headSha: args.headSha,
    truncated: args.truncated,
    diffBase: args.diffBase,
    model: args.model,
    durationMs: args.durationMs,
  }

  if (args.pluginVersion !== undefined) {
    obj.pluginVersion = args.pluginVersion
  }
  obj.host = args.host

  return JSON.stringify(obj)
}

export function skipLine(args: { ts: number; reason: SkipReason; pluginVersion: string | undefined; host: string }): string {
  const obj: Record<string, unknown> = {
    ts: args.ts,
    skipped: true,
    reason: args.reason,
  }

  if (args.pluginVersion !== undefined) {
    obj.pluginVersion = args.pluginVersion
  }
  obj.host = args.host

  return JSON.stringify(obj)
}
