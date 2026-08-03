/**
 * Tests for the 7b process-gate checker (spec:
 * docs/superpowers/specs/2026-08-03-process-gate-7b-draft.md, §7 rulings
 * DECIDED 2026-08-03). Each test builds a throwaway git repo.
 */
import { describe, test, expect, afterAll } from "bun:test"
import { execFileSync } from "node:child_process"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { checkReviewArtifact } from "./check-review-artifact.ts"

const AUTHOR_NAME = "Test Author"
const AUTHOR_EMAIL = "author@example.com"

const tempDirs: string[] = []
afterAll(() => {
  for (const d of tempDirs) rmSync(d, { recursive: true, force: true })
})

function git(repo: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: AUTHOR_NAME,
      GIT_AUTHOR_EMAIL: AUTHOR_EMAIL,
      GIT_COMMITTER_NAME: AUTHOR_NAME,
      GIT_COMMITTER_EMAIL: AUTHOR_EMAIL,
    },
  }).trim()
}

function commitFile(repo: string, rel: string, content: string, msg: string): string {
  const abs = join(repo, rel)
  mkdirSync(join(abs, ".."), { recursive: true })
  writeFileSync(abs, content)
  git(repo, "add", rel)
  git(repo, "commit", "-q", "-m", msg)
  return git(repo, "rev-parse", "HEAD")
}

/** repo with a base commit; returns [repoDir, baseSha] */
function mkRepo(): [string, string] {
  const repo = mkdtempSync(join(tmpdir(), "cra-test-"))
  tempDirs.push(repo)
  git(repo, "init", "-q", "-b", "main")
  const base = commitFile(repo, "README.md", "base\n", "base")
  return [repo, base]
}

function artifactBody(fields: Record<string, string>): string {
  const defaults: Record<string, string> = {
    reviewer: "fresh-context-agent",
    "fresh-context": "true",
    verdict: "approved",
    "findings-count": "0",
  }
  const merged = { ...defaults, ...fields }
  return (
    Object.entries(merged)
      .filter(([, v]) => v !== "")
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n") + "\n\nProse body of the review.\n"
  )
}

/** base -> work commit -> artifact commit naming base..work; returns shas */
function mkReviewedBranch(
  repo: string,
  base: string,
  fields: Record<string, string> = {},
): { work: string; short: string } {
  const work = commitFile(repo, "src/feature.ts", "export const x = 1\n", "work")
  const short = git(repo, "rev-parse", "--short", work)
  const body = artifactBody({ "reviewed-range": `${base}..${work}`, ...fields })
  commitFile(repo, `docs/reviews/${short}-feature.md`, body, "review artifact")
  return { work, short }
}

describe("checkReviewArtifact", () => {
  test("passes: trailing artifact commit naming merge-base..work-tip", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base)
    const head = git(repo, "rev-parse", "HEAD")
    const r = checkReviewArtifact(repo, base, head)
    expect(r.errors).toEqual([])
    expect(r.ok).toBe(true)
  })

  test("passes: reviewed-commit single-sha form", () => {
    const [repo, base] = mkRepo()
    const work = commitFile(repo, "src/a.ts", "a\n", "work")
    const short = git(repo, "rev-parse", "--short", work)
    commitFile(
      repo,
      `docs/reviews/${short}-a.md`,
      artifactBody({ "reviewed-commit": work }),
      "review artifact",
    )
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(true)
  })

  test("fails: no artifact file at the expected path", () => {
    const [repo, base] = mkRepo()
    commitFile(repo, "src/a.ts", "a\n", "work")
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("no review artifact")
  })

  test("fails: artifact present in working tree but not committed", () => {
    const [repo, base] = mkRepo()
    const work = commitFile(repo, "src/a.ts", "a\n", "work")
    const short = git(repo, "rev-parse", "--short", work)
    mkdirSync(join(repo, "docs/reviews"), { recursive: true })
    writeFileSync(
      join(repo, `docs/reviews/${short}-a.md`),
      artifactBody({ "reviewed-range": `${base}..${work}` }),
    )
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
  })

  test("fails: recorded range does not resolve to merge-base..reviewed-tip", () => {
    const [repo, base] = mkRepo()
    const work = commitFile(repo, "src/a.ts", "a\n", "work")
    const short = git(repo, "rev-parse", "--short", work)
    commitFile(
      repo,
      `docs/reviews/${short}-a.md`,
      artifactBody({ "reviewed-range": `${base}..${base}` }),
      "review artifact",
    )
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("reviewed-range")
  })

  test("fails: missing reviewer field", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base, { reviewer: "" })
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("reviewer")
  })

  test("fails: fresh-context not true", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base, { "fresh-context": "false" })
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("fresh-context")
  })

  test("fails: verdict outside the closed set", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base, { verdict: "lgtm" })
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("verdict")
  })

  test("fails: findings-count not a non-negative integer", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base, { "findings-count": "-1" })
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("findings-count")
  })

  test("fails: reviewer string-equals a commit author in range (self-review)", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base, { reviewer: AUTHOR_EMAIL })
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("self-review")
  })

  test("fails: non-exempt commit AFTER the reviewed tip (sneak code)", () => {
    const [repo, base] = mkRepo()
    mkReviewedBranch(repo, base)
    commitFile(repo, "src/sneak.ts", "export const y = 2\n", "sneak")
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("no review artifact")
  })

  test("passes vacuously: branch contains only docs/reviews/** commits", () => {
    const [repo, base] = mkRepo()
    commitFile(repo, "docs/reviews/deadbeef-old.md", artifactBody({ "reviewed-commit": base }), "artifact only")
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(true)
    expect(r.vacuous).toBe(true)
  })

  test("fails: merge commit carrying code is non-exempt (F1 — evil-merge sneak)", () => {
    const [repo, base] = mkRepo()
    const { work } = mkReviewedBranch(repo, base)
    // side branch touches ONLY docs/reviews/** — exempt-looking on its own
    git(repo, "checkout", "-q", "-b", "side", base)
    commitFile(repo, "docs/reviews/000000-side-note.md", "side note\n", "side docs")
    git(repo, "checkout", "-q", "main")
    // evil merge: sneak src/evil.ts into the merge commit itself — the change
    // exists in NO individual commit of the range, only in the merge's diff
    git(repo, "merge", "-q", "--no-ff", "--no-commit", "side")
    writeFileSync(join(repo, "src/evil.ts"), "export const evil = true\n")
    git(repo, "add", "src/evil.ts")
    git(repo, "commit", "-q", "-m", "merge side (evil)")
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    // effective tip must be the merge commit, not the earlier reviewed work commit
    expect(r.errors.join("\n")).toContain("no review artifact")
    expect(r.errors.join("\n")).not.toContain(`${git(repo, "rev-parse", "--short", work)}-`)
  })

  test("fails: two committed artifacts match the reviewed-tip prefix (F2 — ambiguity)", () => {
    const [repo, base] = mkRepo()
    const work = commitFile(repo, "src/a.ts", "a\n", "work")
    const short = git(repo, "rev-parse", "--short", work)
    // clean decoy sorts first; violating artifact sorts second
    commitFile(
      repo,
      `docs/reviews/${short}-aaa-decoy.md`,
      artifactBody({ "reviewed-range": `${base}..${work}` }),
      "decoy artifact",
    )
    commitFile(
      repo,
      `docs/reviews/${short}-zzz-real.md`,
      artifactBody({ "reviewed-range": `${base}..${work}`, reviewer: AUTHOR_EMAIL }),
      "violating artifact",
    )
    const r = checkReviewArtifact(repo, base, git(repo, "rev-parse", "HEAD"))
    expect(r.ok).toBe(false)
    expect(r.errors.join("\n")).toContain("ambiguous")
  })

  test("fails: bad sha arguments", () => {
    const [repo, base] = mkRepo()
    const r = checkReviewArtifact(repo, base, "0000000000000000000000000000000000000000")
    expect(r.ok).toBe(false)
  })
})
