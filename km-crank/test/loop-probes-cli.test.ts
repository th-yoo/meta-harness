/** Integration-lite tests for scripts/p0-signal-variance.ts and
 * scripts/p1-event-density.ts (task-2 brief). Both CLIs run as real
 * subprocesses against hermetic temp-dir fixtures via the env seams
 * (KKAMAK_PROBE_GATE_NDJSON, KKAMAK_PROBE_FOREIGN_NDJSON,
 * KKAMAK_PROBE_REVIEWS_DIR, KKAMAK_PROBE_TB2_VERDICT,
 * KKAMAK_PROBE_SKIP_B3, KKAMAK_PROBE_GIT_DIRS) — never the real streams.
 * cwd is always a throwaway temp dir, so each CLI's own
 * docs/loop-probes/<hostname>-*.json output lands there too, never in the
 * repo. A few pure-ish helpers are also exercised directly (no subprocess)
 * for cheap, fast coverage of the trickier parsing bits. */
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { tmpdir } from "node:os"
import { execFileSync, spawnSync } from "node:child_process"
import { deriveStampBoundaries, parseClassRateLines, replayCliCwd, MAIN_CHECKOUT_DIR_DEFAULT, SPEC_PATH } from "../../scripts/p0-signal-variance.ts"

const P0 = path.join(import.meta.dir, "..", "..", "scripts", "p0-signal-variance.ts")
const P1 = path.join(import.meta.dir, "..", "..", "scripts", "p1-event-density.ts")

const CLEANUP: string[] = []
afterEach(() => {
  for (const d of CLEANUP.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

function mkTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(tmpdir(), prefix))
  CLEANUP.push(dir)
  return dir
}

function writeJsonl(file: string, objs: unknown[]): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, objs.map(o => JSON.stringify(o)).join("\n") + "\n")
}

/** A committed-review temp git repo: each file gets its own commit with a
 * caller-controlled author date, so gitAddedDateIso is deterministic. */
function mkReviewsRepo(files: { name: string; findingsCount: number; authorDateIso: string }[]): string {
  const dir = mkTmp("loop-probes-reviews-")
  execFileSync("git", ["init", "-q"], { cwd: dir })
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"], { cwd: dir })
  for (const f of files) {
    fs.writeFileSync(path.join(dir, f.name), `# review\n\nfindings-count: ${f.findingsCount}\n`)
    execFileSync("git", ["add", f.name], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `add ${f.name}`], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: f.authorDateIso, GIT_COMMITTER_DATE: f.authorDateIso },
    })
  }
  return dir
}

function mkGitRepoWithCommits(dates: string[]): string {
  const dir = mkTmp("loop-probes-git-")
  execFileSync("git", ["init", "-q"], { cwd: dir })
  for (let i = 0; i < dates.length; i++) {
    fs.writeFileSync(path.join(dir, `f${i}.txt`), String(i))
    execFileSync("git", ["add", `f${i}.txt`], { cwd: dir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", `c${i}`], {
      cwd: dir,
      env: { ...process.env, GIT_AUTHOR_DATE: dates[i]!, GIT_COMMITTER_DATE: dates[i]! },
    })
  }
  return dir
}

interface RunResult { stdout: string; stderr: string; status: number | null }
function run(script: string, cwd: string, env: Record<string, string>): RunResult {
  const r = spawnSync("bun", [script], { cwd, encoding: "utf8", env: { ...process.env, ...env } })
  return { stdout: r.stdout ?? "", stderr: r.stderr ?? "", status: r.status }
}

// ---------------------------------------------------------------------
// Direct-function tests (no subprocess) — cheap coverage of the trickier
// parsing bits.
// ---------------------------------------------------------------------

describe("deriveStampBoundaries", () => {
  test("returns only the transition-point timestamps, ts-sorted input", () => {
    const lines = [
      { ts: 30, pluginVersion: "0.3.0" },
      { ts: 10, pluginVersion: "0.2.0" },
      { ts: 20, pluginVersion: "0.2.1" },
      { ts: 25, pluginVersion: "0.2.1" }, // no change -> not a boundary
    ]
    expect(deriveStampBoundaries(lines)).toEqual([20, 30])
  })
  test("missing pluginVersion treated as its own 'unknown' value", () => {
    const lines = [{ ts: 1 }, { ts: 2, pluginVersion: "0.3.0" }, { ts: 3 }]
    expect(deriveStampBoundaries(lines)).toEqual([2, 3])
  })
  test("no transitions -> []", () => {
    expect(deriveStampBoundaries([{ ts: 1, pluginVersion: "0.3.0" }, { ts: 2, pluginVersion: "0.3.0" }])).toEqual([])
  })
})

describe("replayCliCwd", () => {
  test("defaults to MAIN_CHECKOUT_DIR_DEFAULT (home-anchored, NOT process.cwd()-relative), env seam overrides", () => {
    const prev = process.env.KKAMAK_PROBE_REPLAY_CWD
    try {
      delete process.env.KKAMAK_PROBE_REPLAY_CWD
      expect(replayCliCwd()).toBe(MAIN_CHECKOUT_DIR_DEFAULT)
      process.env.KKAMAK_PROBE_REPLAY_CWD = "/tmp/some-fixture-repo"
      expect(replayCliCwd()).toBe("/tmp/some-fixture-repo")
    } finally {
      if (prev === undefined) delete process.env.KKAMAK_PROBE_REPLAY_CWD
      else process.env.KKAMAK_PROBE_REPLAY_CWD = prev
    }
  })
})

describe("parseClassRateLines", () => {
  test("parses both live and corpus-transcript class-rate lines", () => {
    const stdout = [
      "class-rate (descriptive, no bar - by provenance):",
      "  live               A1 2  A2 1  B 0  C 3  D 0  (total 6)",
      "  corpus-transcript  A1 0  A2 0  B 1  C 0  D 0  (total 1)",
    ].join("\n")
    expect(parseClassRateLines(stdout)).toEqual({
      live: { A1: 2, A2: 1, B: 0, C: 3, D: 0, total: 6 },
      corpusTranscript: { A1: 0, A2: 0, B: 1, C: 0, D: 0, total: 1 },
    })
  })
  test("all-zero output (no records) still parses", () => {
    const stdout = "  live               A1 0  A2 0  B 0  C 0  D 0  (total 0)\n  corpus-transcript  A1 0  A2 0  B 0  C 0  D 0  (total 0)\n"
    const parsed = parseClassRateLines(stdout)
    expect(parsed.live).toEqual({ A1: 0, A2: 0, B: 0, C: 0, D: 0, total: 0 })
    expect(parsed.corpusTranscript).toEqual({ A1: 0, A2: 0, B: 0, C: 0, D: 0, total: 0 })
  })
})

// ---------------------------------------------------------------------
// P0 — subprocess, hermetic fixtures
// ---------------------------------------------------------------------

describe("p0-signal-variance CLI", () => {
  test("wires B1/B1-foreign/B2/B3(skip)/B4 into a valid output json with known computed values", () => {
    const cwd = mkTmp("loop-probes-p0-")

    // B1: 12 lines, 5 accepted=false / 7 true (n=12>=10, minority=5>=3 ->
    // VIABLE), all ts far past the last office boundary and sharing one
    // pluginVersion (no derived stamp boundary), so all 12 land in the
    // single latest segment.
    const gateFile = path.join(cwd, "gate.ndjson")
    const baseTs = 1785892022908 + 10_000
    const acceptedFlags = [false, false, false, false, false, true, true, true, true, true, true, true]
    writeJsonl(gateFile, acceptedFlags.map((accepted, i) => ({
      ts: baseTs + i * 1000, accepted, gateExhausted: false,
      rounds: accepted ? ["accepted"] : [], durationMs: 100 + i * 10, pluginVersion: "0.3.0",
    })))

    // B1-foreign: 0.2.0 (pre-boundary), 0.2.1 pre-boundary, 0.2.1
    // post-boundary — 3 distinct regimes.
    const foreignFile = path.join(cwd, "foreign.ndjson")
    const FB = 1785711630125
    writeJsonl(foreignFile, [
      { ts: FB - 2_000_000, accepted: true, gateExhausted: false, rounds: ["accepted"], durationMs: 10, pluginVersion: "0.2.0" },
      { ts: FB - 1_000_000, accepted: false, gateExhausted: false, rounds: [], durationMs: 20, pluginVersion: "0.2.0" },
      { ts: FB - 500_000, accepted: true, gateExhausted: false, rounds: ["accepted"], durationMs: 30, pluginVersion: "0.2.1" },
      { ts: FB + 100_000, accepted: true, gateExhausted: false, rounds: ["accepted"], durationMs: 40, pluginVersion: "0.2.1" },
      { ts: FB + 200_000, accepted: false, gateExhausted: true, rounds: [], durationMs: 50, pluginVersion: "0.2.1" },
    ])

    // B2: 3 reviews, known findings-count.
    const reviewsDir = mkReviewsRepo([
      { name: "a-review.md", findingsCount: 2, authorDateIso: "2026-07-01T00:00:00+00:00" },
      { name: "b-review.md", findingsCount: 5, authorDateIso: "2026-07-02T00:00:00+00:00" },
      { name: "c-review.md", findingsCount: 8, authorDateIso: "2026-07-03T00:00:00+00:00" },
    ])

    // B4: 5 tasks x k=2 candidate arrays -> 10 trials, 6 successes / 4
    // failures (n>=10, both classes >=3 -> VIABLE).
    const tb2File = path.join(cwd, "ab-verdict.json")
    fs.writeFileSync(tb2File, JSON.stringify({
      taskResults: {
        t1: { candidate: [1, 1] },
        t2: { candidate: [1, 0] },
        t3: { candidate: [0, 0] },
        t4: { candidate: [1, 1] },
        t5: { candidate: [0, 1] },
      },
    }))

    const fakeReplayCwd = path.join(cwd, "fake-main-checkout")
    const r = run(P0, cwd, {
      KKAMAK_PROBE_GATE_NDJSON: gateFile,
      KKAMAK_PROBE_FOREIGN_NDJSON: foreignFile,
      KKAMAK_PROBE_REVIEWS_DIR: reviewsDir,
      KKAMAK_PROBE_TB2_VERDICT: tb2File,
      KKAMAK_PROBE_SKIP_B3: "1",
      KKAMAK_PROBE_REPLAY_CWD: fakeReplayCwd,
    })
    expect(r.status).toBe(0)

    const outFile = path.join(cwd, "docs", "loop-probes", `${os.hostname()}-p0-signal-variance.json`)
    expect(fs.existsSync(outFile)).toBe(true)
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))

    expect(out.spec).toBe(SPEC_PATH)
    expect(typeof out.generatedAtTs).toBe("number")
    expect(out.hostname).toBe(os.hostname())

    // B1: boolean viability on the latest (only) segment.
    expect(out.b1.linesTotal).toBe(12)
    expect(out.b1.accepted.n).toBe(12)
    expect(out.b1.accepted.stats.trueCount).toBe(7)
    expect(out.b1.accepted.stats.falseCount).toBe(5)
    expect(out.b1.accepted.viability).toBe("VIABLE")
    expect(out.b1.roundsLength.family).toBe("count")
    expect(out.b1.durationMs.family).toBe("count")

    // B1-foreign: 3 regimes, no viability verdicts.
    expect(out.b1Foreign.linesTotal).toBe(5)
    expect(out.b1Foreign.viability).toBeNull()
    const regimeKeys = out.b1Foreign.regimes.map((r: { key: string }) => r.key)
    expect(regimeKeys).toEqual(["0.2.0@0", "0.2.1@0", "0.2.1@1"])
    expect(out.b1Foreign.regimes[0].n).toBe(2)
    expect(out.b1Foreign.regimes[1].n).toBe(1)
    expect(out.b1Foreign.regimes[2].n).toBe(2)

    // B2: n=3, exact findings-count values, dates round-tripped, source
    // discloses which reviews dir was actually read.
    expect(out.b2.n).toBe(3)
    expect(out.b2.source).toBe(reviewsDir)
    expect(out.b2.stats.mean).toBeCloseTo((2 + 5 + 8) / 3, 10)
    const files = out.b2.files as { file: string; findingsCount: number; addedDateIso: string }[]
    expect(files.map(f => f.findingsCount)).toEqual([2, 5, 8])
    expect(files[0]!.addedDateIso).toContain("2026-07-01")
    expect(out.b2.viability).toBe("UNKNOWN") // n=3 < 10

    // B3: skipped per the env seam, but `source` still discloses which
    // data root the (skipped) replay-cli report WOULD have read.
    expect(out.b3.skipped).toBe(true)
    expect(out.b3.family).toBe("categorical")
    expect(out.b3.source).toBe(fakeReplayCwd)

    // B4: pooled candidate-arm trials.
    expect(out.b4.family).toBe("rate")
    expect(out.b4.arm).toBe("candidate")
    expect(out.b4.n).toBe(10)
    expect(out.b4.stats.successes).toBe(6)
    expect(out.b4.stats.failures).toBe(4)
    expect(out.b4.viability).toBe("VIABLE")
  })

  test("missing gate ndjson / tb2 verdict degrade to empty/zero, not a crash", () => {
    const cwd = mkTmp("loop-probes-p0-missing-")
    const reviewsDir = mkReviewsRepo([])
    const r = run(P0, cwd, {
      KKAMAK_PROBE_GATE_NDJSON: path.join(cwd, "nope.ndjson"),
      KKAMAK_PROBE_FOREIGN_NDJSON: path.join(cwd, "nope2.ndjson"),
      KKAMAK_PROBE_REVIEWS_DIR: reviewsDir,
      KKAMAK_PROBE_TB2_VERDICT: path.join(cwd, "nope3.json"),
      KKAMAK_PROBE_SKIP_B3: "1",
    })
    expect(r.status).toBe(0)
    const outFile = path.join(cwd, "docs", "loop-probes", `${os.hostname()}-p0-signal-variance.json`)
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))
    expect(out.b1.linesTotal).toBe(0)
    expect(out.b1.accepted.viability).toBe("UNKNOWN")
    expect(out.b4.n).toBe(0)
    expect(out.b4.error).toBe("file not found")
    // No KKAMAK_PROBE_REPLAY_CWD override here -> b3.source falls back to
    // MAIN_CHECKOUT_DIR_DEFAULT (proves the default wiring, not just the
    // override seam exercised by the other test).
    expect(out.b3.source).toBe(MAIN_CHECKOUT_DIR_DEFAULT)
  })
})

// ---------------------------------------------------------------------
// P1 — subprocess, hermetic fixtures, dynamic (Date.now()-relative)
// timestamps so the trailing-7-day window is always satisfied regardless
// of when the test runs.
// ---------------------------------------------------------------------

describe("p1-event-density CLI", () => {
  test("wires S1-S4 into a valid output json with known computed values", () => {
    const cwd = mkTmp("loop-probes-p1-")
    const now = Date.now()
    const day = 24 * 3600 * 1000

    // S1/S4: 6 lines inside the 7-day window, spread across 3 distinct
    // UTC days; all with ts well past S4_BOUNDARY (2026-08-05T00:09Z) so
    // they land in S4's post-boundary segment. 2 lines further in the
    // past (9 days ago) must NOT be counted (outside the window).
    const gateFile = path.join(cwd, "gate.ndjson")
    writeJsonl(gateFile, [
      { ts: now - 9 * day, accepted: true, durationMs: 1 }, // outside window
      { ts: now - 6 * day, accepted: true, durationMs: 111 },
      { ts: now - 5 * day, accepted: true, durationMs: 222 },
      { ts: now - 3 * day, accepted: false, durationMs: 333 },
      { ts: now - 1 * day, accepted: true, durationMs: 444 },
      { ts: now - 1 * day, accepted: true, durationMs: 555 },
      { ts: now, accepted: true, durationMs: 666 },
    ])

    // S2: two temp git repos, known commit counts within the window.
    const iso = (daysAgo: number) => new Date(now - daysAgo * day).toISOString()
    const repoA = mkGitRepoWithCommits([iso(6), iso(4), iso(1)]) // 3 commits in-window
    const repoB = mkGitRepoWithCommits([iso(10), iso(2)]) // 1 commit in-window, 1 outside

    // S3: 2 reviews inside the window, 1 outside.
    const reviewsDir = mkReviewsRepo([
      { name: "in-window-1.md", findingsCount: 1, authorDateIso: iso(5) },
      { name: "in-window-2.md", findingsCount: 2, authorDateIso: iso(2) },
      { name: "outside.md", findingsCount: 3, authorDateIso: iso(20) },
    ])

    const r = run(P1, cwd, {
      KKAMAK_PROBE_GATE_NDJSON: gateFile,
      KKAMAK_PROBE_REVIEWS_DIR: reviewsDir,
      KKAMAK_PROBE_GIT_DIRS: `${repoA}:${repoB}`,
    })
    expect(r.status).toBe(0)

    const outFile = path.join(cwd, "docs", "loop-probes", `${os.hostname()}-p1-event-density.json`)
    expect(fs.existsSync(outFile)).toBe(true)
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))

    expect(out.spec).toBe(SPEC_PATH)
    expect(out.hostname).toBe(os.hostname())
    expect(out.window.days).toBe(7)

    // S1: 6 in-window lines (the 9-days-ago one excluded).
    expect(out.s1.n).toBe(6)
    expect(out.s1.eventsPerDay).toBeCloseTo(6 / 7, 10)

    // S2: repoA 3 commits, repoB 1 commit, both /7 per day.
    expect(out.s2.repos).toHaveLength(2)
    const byPath = Object.fromEntries(out.s2.repos.map((r: { path: string; commits: number }) => [r.path, r.commits]))
    expect(byPath[repoA]).toBe(3)
    expect(byPath[repoB]).toBe(1)

    // S3: 2 in-window review adds.
    expect(out.s3.n).toBe(2)
    expect(out.s3.filesTotal).toBe(3)
    expect(out.s3.addsPerDay).toBeCloseTo(2 / 7, 10)

    // S4: boundary (2026-08-05T00:09Z) sits only a few hours before "now"
    // in this environment's clock, so the fixture's 0-days-ago line lands
    // post-boundary and the rest (1/3/5/6 days ago) land pre-boundary.
    // Both segments are small-n (< 10) either way.
    expect(out.s4.segments).toHaveLength(2)
    const [pre, post] = out.s4.segments
    expect(pre.n + post.n).toBe(6)
    expect(pre.smallN).toBe(true)
    expect(post.smallN).toBe(true)
    expect(post.durationMs.n).toBe(post.n)
  })

  test("S2's this-repo-labeled entry carries a branch + worktree-fragility note; a differently-labeled entry does not", () => {
    const cwd = mkTmp("loop-probes-p1-s2-")
    const gateFile = path.join(cwd, "gate.ndjson")
    writeJsonl(gateFile, [])
    const reviewsDir = mkReviewsRepo([])

    // KKAMAK_PROBE_GIT_DIRS labels entries by path.basename — naming this
    // temp repo's dir literally "this-repo" hits the SAME label the
    // production default uses, hermetically (no real git dirs touched).
    const parent = mkTmp("loop-probes-p1-s2-repos-")
    const thisRepoDir = path.join(parent, "this-repo")
    fs.mkdirSync(thisRepoDir)
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: thisRepoDir })
    fs.writeFileSync(path.join(thisRepoDir, "f.txt"), "x")
    execFileSync("git", ["add", "f.txt"], { cwd: thisRepoDir })
    execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "c"], { cwd: thisRepoDir })
    const otherRepo = mkGitRepoWithCommits([new Date().toISOString()])

    const r = run(P1, cwd, {
      KKAMAK_PROBE_GATE_NDJSON: gateFile,
      KKAMAK_PROBE_REVIEWS_DIR: reviewsDir,
      KKAMAK_PROBE_GIT_DIRS: `${thisRepoDir}:${otherRepo}`,
    })
    expect(r.status).toBe(0)
    const outFile = path.join(cwd, "docs", "loop-probes", `${os.hostname()}-p1-event-density.json`)
    const out = JSON.parse(fs.readFileSync(outFile, "utf8"))
    const repos = out.s2.repos as { label: string; path: string; branch?: string; note?: string }[]
    const thisRepoEntry = repos.find(x => x.label === "this-repo")!
    const otherEntry = repos.find(x => x.path === otherRepo)!

    expect(thisRepoEntry.branch).toBe("main")
    expect(typeof thisRepoEntry.note).toBe("string")
    expect(thisRepoEntry.note).toContain("worktree fragility")
    expect(otherEntry.note).toBeUndefined()
    expect(typeof otherEntry.branch).toBe("string")
  })
})
