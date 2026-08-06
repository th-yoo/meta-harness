#!/usr/bin/env bun
/**
 * P1 event-density counters — thin CLI
 * (spec docs/superpowers/specs/2026-08-05-loop-fix-probe-program-design.md
 * §2; plan docs/superpowers/plans/2026-08-05-loop-probes.md Task 2). Zero
 * model calls. Window = trailing 7 calendar days (UTC), ending at run
 * time — a plain rolling 168h window; the "calendar" part is the UTC
 * day-bucketing (dayBucket) applied to events inside it, not aligned
 * bucket boundaries on the window itself.
 *
 * Reuses scripts/p0-signal-variance.ts's data-root resolution + git-log
 * helpers (same production-default rules: gate-outcomes ndjson reads the
 * MAIN checkout, not cwd-relative; reviews dir/TB2 verdict are
 * cwd-relative since they're committed and identical everywhere) so the
 * two CLIs never diverge on path/boundary logic. Every stats/boundary
 * decision still lives in km-crank/src/loop-probes.ts.
 *
 * Env overrides (test seam ONLY — production omits all of these):
 *   KKAMAK_PROBE_GATE_NDJSON, KKAMAK_PROBE_REVIEWS_DIR,
 *   KKAMAK_PROBE_GIT_DIRS (colon-separated repo paths — replaces the
 *   default [this repo, ~/z2/kkamak] pair used for S2 commits/day).
 */
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { execFileSync } from "node:child_process"
import { splitAtBoundaries, countStats, dayBucket, type GateLine } from "../km-crank/src/loop-probes.ts"
import {
  SPEC_PATH, OFFICE_BOUNDARIES, gateNdjsonPath, reviewsDirPath,
  readGateLines, deriveStampBoundaries, segmentBounds, findReviewFiles,
} from "./p0-signal-variance.ts"

const WINDOW_DAYS = 7
const WINDOW_MS = WINDOW_DAYS * 24 * 3600 * 1000
/** S4 boundary: check-string + durationMs regime split (plan Global
 * Constraints / spec §2 S4 bullet). */
const S4_BOUNDARY = 1785888548054

export interface RepoEntry { label: string; path: string }

export function defaultGitDirs(): RepoEntry[] {
  return [
    { label: "this-repo", path: process.cwd() },
    { label: "kkamak", path: path.join(os.homedir(), "z2", "kkamak") },
  ]
}

export function gitDirsFromEnv(): RepoEntry[] {
  const seam = process.env.KKAMAK_PROBE_GIT_DIRS
  if (!seam) return defaultGitDirs()
  return seam.split(":").filter(Boolean).map(p => ({ label: path.basename(p), path: p }))
}

export function commitsSince(repoPath: string, sinceIso: string): number {
  try {
    const out = execFileSync("git", ["-C", repoPath, "log", `--since=${sinceIso}`, "--format=%aI"], { encoding: "utf8" })
    return out.split("\n").map(s => s.trim()).filter(Boolean).length
  } catch {
    return 0
  }
}

/** `git log` at `repoPath` only sees commits reachable from the CURRENTLY
 * -checked-out ref at `repoPath` — for the default "this-repo" entry
 * that's whichever branch/worktree this CLI happens to be run from, not
 * necessarily `main`. Surfaced as a `branch` field (+ a `note` on the
 * "this-repo" entry specifically) so a downstream reader can see the
 * worktree-fragility caveat instead of silently trusting the count.
 * undefined (not thrown) on any git failure. */
export function currentBranch(repoPath: string): string | undefined {
  try {
    return execFileSync("git", ["-C", repoPath, "rev-parse", "--abbrev-ref", "HEAD"], { encoding: "utf8" }).trim()
  } catch {
    return undefined
  }
}

function byDayTally(tsOrIso: (string | number)[]): Record<string, number> {
  const byDay: Record<string, number> = {}
  for (const x of tsOrIso) {
    const d = dayBucket(x)
    byDay[d] = (byDay[d] ?? 0) + 1
  }
  return byDay
}

// ---------------------------------------------------------------------
// S1 — gate-outcomes lines/day (this repo), split at LIVE boundaries
// (spec §6: live iff ts falls inside the window AND applies to a
// stream/host/field actually read — so boundaries outside the window are
// dropped here, unlike B1's full-history split).
// ---------------------------------------------------------------------

export function buildS1(gateFile: string, windowStart: number, windowEnd: number) {
  const lines = readGateLines(gateFile).filter(l => l.ts >= windowStart && l.ts <= windowEnd)
  const allBoundaries = [...new Set([...OFFICE_BOUNDARIES, ...deriveStampBoundaries(lines)])]
  const liveBoundaries = allBoundaries.filter(b => b >= windowStart && b <= windowEnd).sort((a, b) => a - b)
  const bounds = segmentBounds(liveBoundaries)
  const segs = splitAtBoundaries(lines, liveBoundaries)
  return {
    source: gateFile,
    windowStart, windowEnd,
    n: lines.length,
    eventsPerDay: lines.length / WINDOW_DAYS,
    byDay: byDayTally(lines.map(l => l.ts)),
    boundaries: liveBoundaries,
    segments: segs.map((seg, i) => ({ index: i, boundaryLo: bounds[i]!.lo, boundaryHi: bounds[i]!.hi, n: seg.length })),
  }
}

// ---------------------------------------------------------------------
// S2 — commits/day, this repo AND ~/z2/kkamak (labeled separately)
// ---------------------------------------------------------------------

export function buildS2(windowStart: number, windowEnd: number) {
  const sinceIso = new Date(windowStart).toISOString()
  const repos = gitDirsFromEnv().map(r => {
    const commits = commitsSince(r.path, sinceIso)
    const branch = currentBranch(r.path)
    const note = r.label === "this-repo"
      ? "counts commits reachable from the CURRENT checkout's branch only (worktree fragility: commits on other branches/worktrees of the same repo, e.g. main after this worktree branched, are not counted here)"
      : undefined
    return { label: r.label, path: r.path, commits, commitsPerDay: commits / WINDOW_DAYS, branch, note }
  })
  return { windowStart, windowEnd, sinceIso, repos }
}

// ---------------------------------------------------------------------
// S3 — docs/reviews adds/day via git author date of each file's oldest
// add commit (tail -1 rule), dayBucket over the window.
// ---------------------------------------------------------------------

export function buildS3(reviewsDir: string, windowStart: number, windowEnd: number) {
  const files = findReviewFiles(reviewsDir)
  const inWindowIso: string[] = []
  for (const f of files) {
    if (!f.addedDateIso) continue
    const ts = Date.parse(f.addedDateIso)
    if (Number.isNaN(ts) || ts < windowStart || ts > windowEnd) continue
    inWindowIso.push(f.addedDateIso)
  }
  return {
    source: reviewsDir,
    windowStart, windowEnd,
    filesTotal: files.length,
    n: inWindowIso.length,
    addsPerDay: inWindowIso.length / WINDOW_DAYS,
    byDay: byDayTally(inWindowIso),
  }
}

// ---------------------------------------------------------------------
// S4 — gate-outcomes durationMs distribution + lines/day split at
// S4_BOUNDARY, within the window — descriptive, small-n declared.
// ---------------------------------------------------------------------

export function buildS4(gateFile: string, windowStart: number, windowEnd: number) {
  const lines = readGateLines(gateFile).filter(l => l.ts >= windowStart && l.ts <= windowEnd)
  const boundary = S4_BOUNDARY
  const inWindow = boundary >= windowStart && boundary <= windowEnd
  const segs = splitAtBoundaries(lines, [boundary])
  const bounds = segmentBounds([boundary])
  const segments = segs.map((seg: GateLine[], i: number) => {
    const durations = seg.map(l => (typeof l.durationMs === "number" ? l.durationMs : undefined)).filter((x): x is number => typeof x === "number")
    // Denominator = the segment's ACTUAL overlap with the window, not the
    // whole 7 days — a boundary hours before run time would otherwise make
    // the post segment's rate read ~25x too low (foreign-session review
    // finding, 2026-08-05: committed 2.43/day vs real ~88/day).
    const lo = Math.max(bounds[i]!.lo ?? windowStart, windowStart)
    const hi = Math.min(bounds[i]!.hi ?? windowEnd, windowEnd)
    const spanDays = Math.max((hi - lo) / 86_400_000, 0)
    return {
      index: i, boundaryLo: bounds[i]!.lo, boundaryHi: bounds[i]!.hi,
      n: seg.length, spanDays,
      linesPerDay: spanDays > 0 ? seg.length / spanDays : null,
      durationMs: countStats(durations), smallN: seg.length < 10,
    }
  })
  return { source: gateFile, windowStart, windowEnd, boundary, boundaryLiveInWindow: inWindow, segments }
}

// ---------------------------------------------------------------------
// main
// ---------------------------------------------------------------------

function main(): void {
  // KKAMAK_PROBE_NOW_TS: test seam ONLY (production omits it) — freezes
  // the window end so fixtures built relative to a fixed "now" stay
  // deterministic against the fixed S4_BOUNDARY. Added after the
  // wall-clock time bomb of 348cd5c's own test (post.spanDays < 1
  // expired one calendar day after commit).
  const nowSeam = Number(process.env.KKAMAK_PROBE_NOW_TS)
  const windowEnd = Number.isFinite(nowSeam) && nowSeam > 0 ? nowSeam : Date.now()
  const windowStart = windowEnd - WINDOW_MS
  const gateFile = gateNdjsonPath()
  const reviewsDir = reviewsDirPath()

  const output = {
    spec: SPEC_PATH,
    generatedAtTs: Date.now(),
    hostname: os.hostname(),
    window: { start: windowStart, end: windowEnd, days: WINDOW_DAYS },
    s1: buildS1(gateFile, windowStart, windowEnd),
    s2: buildS2(windowStart, windowEnd),
    s3: buildS3(reviewsDir, windowStart, windowEnd),
    s4: buildS4(gateFile, windowStart, windowEnd),
  }

  const outDir = path.join(process.cwd(), "docs", "loop-probes")
  fs.mkdirSync(outDir, { recursive: true })
  const outFile = path.join(outDir, `${os.hostname()}-p1-event-density.json`)
  fs.writeFileSync(outFile, JSON.stringify(output, null, 2) + "\n")
  console.log(`p1-event-density: wrote ${outFile}`)
}

if (import.meta.main) main()
