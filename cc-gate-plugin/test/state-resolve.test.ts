import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  resolveRecord,
  runResolve,
  findCycle,
  findFixtureRefCandidate,
  materializeTree,
  CHECK_TIMEOUT_MS,
  type ResolveDeps,
} from "../src/gauge/state-resolve.ts"
import { bunGitRunner, FIXTURE_REF_REL_PATH, type FixtureRefRecord } from "../src/fixture-ref.ts"
import { DEFAULT_SENSOR_REL_PATH } from "../src/sensor-append.ts"
import { runCheck as realRunCheck } from "../src/check-runner.ts"
import { readCorpus, writeCorpus, CORPUS_FILE_REL, type CorpusRecord } from "../src/gauge/corpus-store.ts"
import type { SensorLine } from "../src/types.ts"
import type { GaugeFile } from "../src/gauge/files.ts"

// --- scratch repo helpers ---

function sh(dir: string, cmd: string): string {
  const r = Bun.spawnSync(["bash", "-c", cmd], { cwd: dir })
  if (r.exitCode !== 0) {
    throw new Error(`sh failed (${cmd}) in ${dir}: ${r.stderr.toString()}`)
  }
  return r.stdout.toString()
}

function mkGitRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-state-resolve-repo-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  return dir
}

function commitFile(dir: string, name: string, content: string): { sha: string; treeSha: string; ct: number } {
  fs.writeFileSync(path.join(dir, name), content)
  sh(dir, "git add -A && git commit -q -m snap")
  const sha = sh(dir, "git rev-parse HEAD").trim()
  const treeSha = sh(dir, `git rev-parse ${sha}^{tree}`).trim()
  const ct = Number(sh(dir, "git log -1 --format=%ct").trim())
  return { sha, treeSha, ct }
}

function writeFixtureRefs(repo: string, refs: FixtureRefRecord[]): void {
  const p = path.join(repo, FIXTURE_REF_REL_PATH)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, refs.map((r) => JSON.stringify(r)).join("\n") + (refs.length ? "\n" : ""))
}

function writeSensorLines(repo: string, lines: SensorLine[]): void {
  const p = path.join(repo, DEFAULT_SENSOR_REL_PATH)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, lines.map((l) => JSON.stringify(l)).join("\n") + (lines.length ? "\n" : ""))
}

function fxRef(over: Partial<FixtureRefRecord> = {}): FixtureRefRecord {
  return {
    ts: 6000,
    sessionID: "s1",
    round: 1,
    check: "test -f a.txt",
    headSha: "",
    treeSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
    ref: "refs/kkamak/fixtures/6000-s1-r1",
    ...over,
  }
}

function sline(over: Partial<SensorLine> = {}): SensorLine {
  return {
    ts: 3000,
    sessionID: "s1",
    check: "test -f a.txt",
    accepted: true,
    gateExhausted: false,
    rounds: [],
    interrupted: false,
    marker: false,
    durationMs: 0,
    host: "host-a",
    app: "claude-code",
    ...over,
  }
}

function derivation(over: Partial<GaugeFile> = {}): GaugeFile {
  return {
    v: 2,
    sessionID: "s1",
    n: 1,
    ts: 1000,
    model: "haiku",
    derivationMs: 10,
    goalSummary: "g",
    criteria: ["c1"],
    check: "test -f a.txt",
    confidence: 0.9,
    class: "C",
    ...over,
  }
}

function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
  return {
    provenance: "corpus-transcript",
    stage: "derived",
    repo: "/tmp/does-not-matter",
    sessionId: "s1",
    promptTs: 1000,
    prompt: "fix the thing",
    promptSha256: "sha-a",
    floorCheck: "",
    floorCheckMinedAt: 1000,
    derivation: derivation(),
    ...over,
  }
}

function stubDeps(over: Partial<ResolveDeps> = {}): ResolveDeps {
  return {
    hostname: () => "host-a",
    git: bunGitRunner,
    runCheck: (cmd, cwd, timeoutMs) => realRunCheck(cmd, cwd, timeoutMs),
    bunInstall: async () => ({ code: 0 }),
    log: () => {},
    ...over,
  }
}

// --- findCycle / findFixtureRefCandidate (pure helper unit tests) ---

describe("findCycle", () => {
  test("smallest ts >= promptTs, excludes skippedStop markers", () => {
    const sensors = [
      sline({ ts: 500 }), // before promptTs — excluded
      sline({ ts: 4000, skippedStop: true }), // marker — excluded
      sline({ ts: 3000 }),
      sline({ ts: 3500 }),
      sline({ ts: 9000, sessionID: "other" }), // different session — excluded
    ]
    expect(findCycle(sensors, "s1", 1000)?.ts).toBe(3000)
  })

  test("no eligible line -> undefined", () => {
    expect(findCycle([sline({ ts: 500 })], "s1", 1000)).toBeUndefined()
  })
})

describe("findFixtureRefCandidate", () => {
  test("smallest ts within 24h, non-empty treeSha only", () => {
    const refs = [
      fxRef({ ts: 900 }), // before promptTs — excluded
      fxRef({ ts: 2000, treeSha: "" }), // bail — excluded
      fxRef({ ts: 5000 }),
      fxRef({ ts: 4000 }),
      fxRef({ ts: 1000 + 25 * 3600 * 1000 }), // outside 24h — excluded
    ]
    expect(findFixtureRefCandidate(refs, "s1", 1000)?.ts).toBe(4000)
  })
})

describe("materializeTree — pipefail on git archive failure", () => {
  test("bogus sha -> git archive fails -> pipe now reports failure despite bsdtar's empty-input exit 0", async () => {
    // Without `set -o pipefail` in the bash -c pipe, bash's exit status is
    // the LAST command's only: `git archive <bad-sha>` fails and writes
    // nothing to stdout, but `tar -x` on an EMPTY stdin exits 0 (bsdtar,
    // confirmed on this host) — so the whole pipe would report success
    // with nothing actually extracted. This proves the fix: a bogus sha
    // must now make materializeTree return false.
    const repo = mkGitRepo()
    commitFile(repo, "a.txt", "hi\n") // give the repo real history so this isn't "empty repo" noise
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "km-materialize-pipefail-test-"))
    try {
      const ok = await materializeTree(
        "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
        repo,
        dir,
      )
      expect(ok).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

// --- resolveRecord: join order + materialization + evaluateGauge delegation ---

describe("resolveRecord — fixture-ref happy path", () => {
  test("verified treeSha -> state.kind fixture-ref, joinKind clean, exec runs the real check", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    writeFixtureRefs(repo, [fxRef({ ts: 2000, treeSha })])
    // no sensor lines at all — nothing to guard against, nothing to mark "nearest"

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], [fxRef({ ts: 2000, treeSha })], stubDeps())

    expect(result.stage).toBe("resolved")
    expect(result.state?.kind).toBe("fixture-ref")
    expect(result.state?.treeSha).toBe(treeSha)
    expect(result.state?.joinKind).toBe("clean")
    expect(result.state?.materialized).toBe(true)
    expect(result.state?.error).toBeUndefined()
    expect(result.poolEligible).toBe(true)
    expect(result.exec?.executable).toBe(true)
    expect(result.exec?.pass).toBe(true)
    expect(result.exec?.timeoutMs).toBe(CHECK_TIMEOUT_MS)
  })
})

describe("resolveRecord — commit join", () => {
  test("host match + committer-ts within 7d window -> state.kind commit", async () => {
    const repo = mkGitRepo()
    const { sha, ct } = commitFile(repo, "a.txt", "hi\n")
    const cycleTs = ct * 1000 - 500 // cycle precedes the commit, within window
    const sensors = [sline({ ts: cycleTs, host: "host-a" })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, sensors, [], stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).toBe("commit")
    expect(result.state?.sha).toBe(sha)
    expect(result.state?.committerTs).toBe(ct * 1000)
    expect(result.state?.host).toBe("host-a")
    expect(result.state?.joinKind).toBeUndefined()
    expect(result.poolEligible).toBe(true)
  })

  test("host mismatch -> no commit join, falls to none", async () => {
    const repo = mkGitRepo()
    const { ct } = commitFile(repo, "a.txt", "hi\n")
    const sensors = [sline({ ts: ct * 1000 - 500, host: "host-b" })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, sensors, [], stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).toBe("none")
    expect(result.poolEligible).toBe(false)
    expect(result.exec).toBeUndefined()
  })

  test("commit outside the 7d window is skipped, no match -> none", async () => {
    const repo = mkGitRepo()
    const { ct } = commitFile(repo, "a.txt", "hi\n")
    const cycleTs = ct * 1000 + 8 * 24 * 3600 * 1000 // cycle is 8 days AFTER the only commit
    const sensors = [sline({ ts: cycleTs, host: "host-a" })]

    const record = rec({ repo, promptTs: cycleTs - 1000 })
    const result = await resolveRecord(record, sensors, [], stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).toBe("none")
  })

  test("commit >7d AFTER the cycle is skipped (upper cap) — cycle at T, commit at T+8d -> none", async () => {
    // The test above only exercises the LOWER-bound guard (committerTs <
    // cycle.ts): its cycle sits AFTER the only commit, so the loop's very
    // first `continue` fires before the upper-cap line is ever reached.
    // This test puts the cycle BEFORE the commit by >7d so the commit
    // clears the lower bound and the code must fall through to
    // `committerTs > cycle.ts + MS_7D` to reject it.
    const repo = mkGitRepo()
    const { ct } = commitFile(repo, "a.txt", "hi\n")
    const cycleTs = ct * 1000 - 8 * 24 * 3600 * 1000 // cycle is 8 days BEFORE the only commit
    const sensors = [sline({ ts: cycleTs, host: "host-a" })]

    const record = rec({ repo, promptTs: cycleTs - 1000 })
    const result = await resolveRecord(record, sensors, [], stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).toBe("none")
  })
})

describe("resolveRecord — none (descriptive-only)", () => {
  test("no fixture-ref, no sensor line at all -> kind none, not pool eligible", async () => {
    const repo = mkGitRepo()
    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], [], stubDeps())

    expect(result.state?.kind).toBe("none")
    expect(result.poolEligible).toBe(false)
    expect(result.exec).toBeUndefined()
    expect(result.stage).toBe("resolved")
  })
})

describe("resolveRecord — pruned-ref fallthrough", () => {
  test("cat-file -e fails on the candidate treeSha -> falls through to commit join", async () => {
    const repo = mkGitRepo()
    const { sha, ct } = commitFile(repo, "a.txt", "hi\n")
    const bogusTree = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef"
    const refs = [fxRef({ ts: 2000, treeSha: bogusTree })]
    const sensors = [sline({ ts: ct * 1000 - 500, host: "host-a" })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, sensors, refs, stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).toBe("commit")
    expect(result.state?.sha).toBe(sha)
  })
})

describe("resolveRecord — misattribution guard", () => {
  test("two mined prompts, one session: EARLIER prompt does not take the later ref; LATER prompt does", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    // one fixture-ref, at ts=6000, produced by promptB's own eventual block.
    const refs = [fxRef({ ts: 6000, treeSha })]
    // promptA's own cycle completed cleanly (accept) at ts=3000 — strictly
    // between promptA's promptTs (1000) and the ref (6000).
    const sensors = [sline({ ts: 3000, host: "host-b" })] // host-b so commit join can't rescue it either

    const promptA = rec({ repo, promptTs: 1000, promptSha256: "sha-a" })
    const promptB = rec({ repo, promptTs: 5000, promptSha256: "sha-b" })

    const resultA = await resolveRecord(promptA, sensors, refs, stubDeps({ hostname: () => "host-a" }))
    const resultB = await resolveRecord(promptB, sensors, refs, stubDeps({ hostname: () => "host-a" }))

    // A must NOT take the ref — its own (misattributing) cycle blocks it,
    // and the commit-join fallback also fails (host-b != host-a), so A
    // lands on "none".
    expect(resultA.state?.kind).toBe("none")
    // B has no intervening cycle after its own promptTs (3000 < 5000) and
    // legitimately takes the ref.
    expect(resultB.state?.kind).toBe("fixture-ref")
    expect(resultB.state?.treeSha).toBe(treeSha)
  })

  test("non-mined-turn case: a sensor cycle line from a NON-mined (filler) turn between prompt and ref also blocks the match", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 6000, treeSha })]
    // This sensor line has no corresponding mined CorpusRecord anywhere —
    // it represents a task-unshaped turn the miner filtered out, but it
    // still fully occupies a real completed cycle in the sensor stream.
    const sensors = [sline({ ts: 3000, host: "host-b" })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, sensors, refs, stubDeps({ hostname: () => "host-a" }))

    expect(result.state?.kind).not.toBe("fixture-ref")
  })
})

describe("resolveRecord — joinKind clean vs nearest", () => {
  test("clean: no skippedStop marker sits between promptTs and the matched ref", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 6000, treeSha })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], refs, stubDeps())

    expect(result.state?.kind).toBe("fixture-ref")
    expect(result.state?.joinKind).toBe("clean")
  })

  test("nearest: a skippedStop marker line sits between promptTs and the matched ref", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 6000, treeSha })]
    // skippedStop markers do NOT disqualify the match (they are not a
    // "completed cycle") but DO downgrade joinKind — the "honest residual".
    const sensors = [sline({ ts: 3000, skippedStop: true, host: "host-a" })]

    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, sensors, refs, stubDeps())

    expect(result.state?.kind).toBe("fixture-ref")
    expect(result.state?.joinKind).toBe("nearest")
  })
})

describe("resolveRecord — temp dir cleanup", () => {
  test("cleaned up after a normal completed check", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    let capturedDir: string | undefined
    const origMkdtemp = fs.mkdtempSync
    fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
      const d = origMkdtemp(...args)
      if (String(args[0]).includes("km-corpus-resolve-")) capturedDir = d as string
      return d
    }) as typeof fs.mkdtempSync

    try {
      const record = rec({ repo, promptTs: 1000 })
      await resolveRecord(record, [], refs, stubDeps())
    } finally {
      fs.mkdtempSync = origMkdtemp
    }

    expect(capturedDir).toBeDefined()
    expect(fs.existsSync(capturedDir!)).toBe(false)
  })

  test("cleaned up after a check timeout (code 124)", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    let capturedDir: string | undefined
    const origMkdtemp = fs.mkdtempSync
    fs.mkdtempSync = ((...args: Parameters<typeof fs.mkdtempSync>) => {
      const d = origMkdtemp(...args)
      if (String(args[0]).includes("km-corpus-resolve-")) capturedDir = d as string
      return d
    }) as typeof fs.mkdtempSync

    try {
      const record = rec({ repo, promptTs: 1000 })
      const deps = stubDeps({
        runCheck: async () => ({ code: 124, out: "[kkamak: check timed out]", ms: CHECK_TIMEOUT_MS }),
      })
      const result = await resolveRecord(record, [], refs, deps)
      expect(result.exec?.executable).toBe(true)
      expect(result.exec?.pass).toBe(false)
      expect(result.exec?.code).toBe(124)
    } finally {
      fs.mkdtempSync = origMkdtemp
    }

    expect(capturedDir).toBeDefined()
    expect(fs.existsSync(capturedDir!)).toBe(false)
  })
})

describe("resolveRecord — install-skip", () => {
  test("no bun lockfile in the materialized tree -> bunInstall never called", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n") // no bun.lock committed
    const refs = [fxRef({ ts: 2000, treeSha })]

    let installCalls = 0
    const deps = stubDeps({ bunInstall: async () => { installCalls++; return { code: 0 } } })
    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], refs, deps)

    expect(installCalls).toBe(0)
    expect(result.state?.error).toBeUndefined()
    expect(result.poolEligible).toBe(true)
  })

  test("bun lockfile present + install fails -> state.error, descriptive-only, not pool eligible", async () => {
    const repo = mkGitRepo()
    fs.writeFileSync(path.join(repo, "bun.lock"), "{}")
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    let installCalls = 0
    const deps = stubDeps({
      bunInstall: async () => {
        installCalls++
        return { code: 1 }
      },
    })
    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], refs, deps)

    expect(installCalls).toBe(1)
    expect(result.state?.error).toContain("bun install")
    expect(result.poolEligible).toBe(false)
    expect(result.exec).toBeUndefined()
  })
})

describe("resolveRecord — evaluateGauge delegation semantics", () => {
  test("null check -> present-but-not-executable, no pass/refused", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    const record = rec({ repo, promptTs: 1000, derivation: derivation({ check: null }) })
    const result = await resolveRecord(record, [], refs, stubDeps())

    expect(result.exec?.executable).toBe(false)
    expect(result.exec?.pass).toBeUndefined()
    expect(result.exec?.refused).toBeUndefined()
    expect(result.poolEligible).toBe(true)
  })

  test("unsafe check -> guard refusal, executable false, refused reason set, runCheck never invoked", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    let calls = 0
    const deps = stubDeps({ runCheck: async () => { calls++; return { code: 0, out: "", ms: 1 } } })
    const record = rec({ repo, promptTs: 1000, derivation: derivation({ check: "rm -rf /" }) })
    const result = await resolveRecord(record, [], refs, deps)

    expect(result.exec?.executable).toBe(false)
    expect(result.exec?.refused).toBe("destructive-command")
    expect(calls).toBe(0)
  })

  test("126/127 unrunnable exit codes -> executable false (M1 miss), not a pass/fail verdict", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    for (const code of [126, 127]) {
      const deps = stubDeps({ runCheck: async () => ({ code, out: "", ms: 1 }) })
      const record = rec({ repo, promptTs: 1000 })
      const result = await resolveRecord(record, [], refs, deps)
      expect(result.exec?.executable).toBe(false)
      expect(result.exec?.pass).toBeUndefined()
    }
  })

  test("non-zero, runnable exit code -> executable true, pass false, wouldBlock semantics via evaluateGauge", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    const deps = stubDeps({ runCheck: async () => ({ code: 1, out: "nope", ms: 3 }) })
    const record = rec({ repo, promptTs: 1000 })
    const result = await resolveRecord(record, [], refs, deps)

    expect(result.exec?.executable).toBe(true)
    expect(result.exec?.pass).toBe(false)
    expect(result.exec?.code).toBe(1)
  })

  test("runCheck is invoked with the pinned 30s timeout, not 60s or 300s", async () => {
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    const refs = [fxRef({ ts: 2000, treeSha })]

    let seenTimeout: number | undefined
    const deps = stubDeps({
      runCheck: async (cmd, cwd, timeoutMs) => {
        seenTimeout = timeoutMs
        return { code: 0, out: "", ms: 1 }
      },
    })
    const record = rec({ repo, promptTs: 1000 })
    await resolveRecord(record, [], refs, deps)

    expect(seenTimeout).toBe(30_000)
    expect(seenTimeout).toBe(CHECK_TIMEOUT_MS)
  })
})

describe("resolveRecord — no derivation (defensive no-op)", () => {
  test("record without a derivation is returned unchanged", async () => {
    const record = rec({ derivation: undefined, stage: "mined" })
    const result = await resolveRecord(record, [], [], stubDeps())
    expect(result).toEqual(record)
  })
})

// --- runResolve: batch + corpus store wiring ---

describe("runResolve", () => {
  test("resolves every stage:'derived' record, writes stage:'resolved' back, leaves other stages untouched", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "km-state-resolve-cwd-"))
    const repo = mkGitRepo()
    const { treeSha } = commitFile(repo, "a.txt", "hi\n")
    writeFixtureRefs(repo, [fxRef({ ts: 2000, treeSha })])

    const derived = rec({ repo, promptTs: 1000, promptSha256: "sha-derived" })
    const mined = { ...rec({ repo, promptSha256: "sha-mined" }), stage: "mined" as const, derivation: undefined }
    writeCorpus(cwd, [derived, mined], () => {})

    const logs: string[] = []
    const summary = await runResolve(cwd, (m) => logs.push(m), stubDeps())

    expect(summary).toEqual({ pending: 1, resolved: 1 })
    const after = readCorpus(cwd)
    const resolvedRec = after.find((r) => r.promptSha256 === "sha-derived")!
    const minedRec = after.find((r) => r.promptSha256 === "sha-mined")!
    expect(resolvedRec.stage).toBe("resolved")
    expect(resolvedRec.state?.kind).toBe("fixture-ref")
    expect(minedRec.stage).toBe("mined")
  })

  test("reads sensor lines + fixture-refs off disk from the RECORD's repo (not cwd) — host mismatch on the on-disk sensor line falls through to none", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "km-state-resolve-cwd-"))
    const repo = mkGitRepo()
    const { treeSha, ct } = commitFile(repo, "a.txt", "hi\n")
    // A pruned fixture-ref forces fallthrough to the commit join, so the
    // on-disk sensor line (host-b) is actually consulted and its mismatch
    // against deps.hostname() (host-a) is what decides the outcome.
    writeFixtureRefs(repo, [fxRef({ ts: 2000, treeSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef" })])
    writeSensorLines(repo, [sline({ ts: ct * 1000 - 500, host: "host-b" })])

    const record = rec({ repo, promptTs: 1000, promptSha256: "sha-disk" })
    writeCorpus(cwd, [record], () => {})

    const summary = await runResolve(cwd, () => {}, stubDeps({ hostname: () => "host-a" }))
    expect(summary).toEqual({ pending: 1, resolved: 1 })

    const after = readCorpus(cwd)[0]!
    expect(after.state?.kind).toBe("none")
  })

  test("lock already held: refuses, store untouched", async () => {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "km-state-resolve-cwd-"))
    const repo = mkGitRepo()
    writeCorpus(cwd, [rec({ repo })], () => {})
    const before = fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")

    const { acquireCorpusLock, releaseCorpusLock } = await import("../src/gauge/corpus-store.ts")
    expect(acquireCorpusLock(cwd, () => {})).toBe(true)
    try {
      const logs: string[] = []
      const summary = await runResolve(cwd, (m) => logs.push(m), stubDeps())
      expect(summary).toBeUndefined()
      expect(logs.some((l) => l.includes("REFUSING") && l.toLowerCase().includes("lock"))).toBe(true)
      expect(fs.readFileSync(path.join(cwd, CORPUS_FILE_REL), "utf-8")).toBe(before)
    } finally {
      releaseCorpusLock(cwd)
    }
  })
})
