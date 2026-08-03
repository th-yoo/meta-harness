/**
 * 7b process-gate floor: "a review artifact exists, is committed, and its
 * recorded fields match the merged range." Spec + rulings:
 * docs/superpowers/specs/2026-08-03-process-gate-7b-draft.md (§7 DECIDED
 * 2026-08-03: pre-merge placement, docs/reviews/<short-sha>-<slug>.md,
 * 5 fields, approved/fix-first/blocked, string-inequality no-self-review).
 *
 * Effective-tip mechanic (pre-data amendment, recorded in spec §1): the
 * artifact commit itself moves the branch tip, so trailing commits that
 * touch ONLY docs/reviews/** are exempt from "reviewed"; the artifact must
 * name merge-base..<newest non-exempt commit>. Any non-exempt commit after
 * the reviewed tip therefore fails (sneak-code closed).
 *
 * Usage: bun scripts/check-review-artifact.ts <merge-base-sha> <head-sha>
 * Exit 0 = floor met; exit 1 = block, reasons on stdout.
 * Floor only — verdict content, review quality, actual independence are
 * the judgment layer's problem, never checked here.
 */
import { execFileSync } from "node:child_process"

const VERDICTS = new Set(["approved", "fix-first", "blocked"])
const REQUIRED_ALWAYS = ["reviewer", "fresh-context", "verdict", "findings-count"]

export interface CheckResult {
  ok: boolean
  errors: string[]
  /** true when the range holds only docs/reviews/** commits — nothing to review */
  vacuous?: boolean
}

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: repo, encoding: "utf8" }).trim()
}

function revParse(repo: string, ref: string): string | undefined {
  try {
    return git(repo, "rev-parse", "--verify", "--quiet", `${ref}^{commit}`)
  } catch {
    return undefined
  }
}

/** newest commit in base..head whose diff touches anything outside docs/reviews/ */
function effectiveReviewedTip(repo: string, base: string, head: string): string | undefined {
  const shas = git(repo, "rev-list", `${base}..${head}`).split("\n").filter(Boolean)
  for (const sha of shas) {
    const files = git(repo, "diff-tree", "--no-commit-id", "--name-only", "-r", "--root", sha)
      .split("\n")
      .filter(Boolean)
    if (files.some((f) => !f.startsWith("docs/reviews/"))) return sha
  }
  return undefined
}

function parseFields(text: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const line of text.split("\n")) {
    const m = line.match(/^([a-z-]+):\s*(.+?)\s*$/)
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!)
  }
  return fields
}

export function checkReviewArtifact(repo: string, baseRef: string, headRef: string): CheckResult {
  const errors: string[] = []
  const base = revParse(repo, baseRef)
  const head = revParse(repo, headRef)
  if (!base || !head) {
    return { ok: false, errors: [`unresolvable sha(s): base=${baseRef} head=${headRef}`] }
  }

  const tip = effectiveReviewedTip(repo, base, head)
  if (tip === undefined) {
    return { ok: true, errors: [], vacuous: true }
  }
  const short = git(repo, "rev-parse", "--short", tip)

  // artifact must be COMMITTED at head (working-tree files do not count)
  const committed = git(repo, "ls-tree", "-r", "--name-only", head, "--", "docs/reviews/")
    .split("\n")
    .filter(Boolean)
  const matches = committed.filter(
    (f) => f.startsWith(`docs/reviews/${short}-`) && f.endsWith(".md"),
  )
  if (matches.length === 0) {
    errors.push(
      `no review artifact: expected committed docs/reviews/${short}-*.md naming reviewed tip ${short}`,
    )
    return { ok: false, errors }
  }
  const artifactPath = matches[0]!
  const text = git(repo, "show", `${head}:${artifactPath}`)
  const fields = parseFields(text)

  // range/commit field: exact commit identity (spec §4 — no fuzzy match)
  const range = fields.get("reviewed-range")
  const single = fields.get("reviewed-commit")
  if (range !== undefined) {
    const [a, b, ...rest] = range.split("..")
    const ra = a ? revParse(repo, a) : undefined
    const rb = b ? revParse(repo, b) : undefined
    if (rest.length > 0 || ra !== base || rb !== tip) {
      errors.push(
        `reviewed-range "${range}" does not resolve to ${base.slice(0, 7)}..${tip.slice(0, 7)}`,
      )
    }
  } else if (single !== undefined) {
    if (revParse(repo, single) !== tip) {
      errors.push(`reviewed-commit "${single}" does not resolve to reviewed tip ${short}`)
    }
  } else {
    errors.push(`missing field: reviewed-commit or reviewed-range in ${artifactPath}`)
  }

  for (const f of REQUIRED_ALWAYS) {
    if (!fields.has(f)) errors.push(`missing field: ${f} in ${artifactPath}`)
  }

  const fresh = fields.get("fresh-context")
  if (fresh !== undefined && fresh !== "true") {
    errors.push(`fresh-context must attest "true" (got "${fresh}")`)
  }
  const verdict = fields.get("verdict")
  if (verdict !== undefined && !VERDICTS.has(verdict)) {
    errors.push(`verdict "${verdict}" not in closed set ${[...VERDICTS].join("/")}`)
  }
  const count = fields.get("findings-count")
  if (count !== undefined && !/^\d+$/.test(count)) {
    errors.push(`findings-count "${count}" is not a non-negative integer`)
  }

  // no-self-review: string inequality vs every author name/email in range
  const reviewer = fields.get("reviewer")?.trim().toLowerCase()
  if (reviewer) {
    const authors = git(repo, "log", "--format=%an%n%ae", `${base}..${tip}`)
      .split("\n")
      .filter(Boolean)
      .map((s) => s.trim().toLowerCase())
    if (authors.includes(reviewer)) {
      errors.push(`self-review: reviewer "${reviewer}" matches a commit author in range`)
    }
  }

  return { ok: errors.length === 0, errors }
}

if (import.meta.main) {
  const [baseArg, headArg] = process.argv.slice(2)
  if (!baseArg || !headArg) {
    console.log("usage: bun scripts/check-review-artifact.ts <merge-base-sha> <head-sha>")
    process.exit(1)
  }
  const r = checkReviewArtifact(process.cwd(), baseArg, headArg)
  if (r.vacuous) console.log("check-review-artifact: OK (vacuous — docs/reviews-only range)")
  else if (r.ok) console.log("check-review-artifact: OK")
  else {
    console.log("check-review-artifact: BLOCK")
    for (const e of r.errors) console.log(`  - ${e}`)
  }
  process.exit(r.ok ? 0 : 1)
}
