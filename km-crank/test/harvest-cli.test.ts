import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { harvestFixture } from "../src/harvest-cli"

function sh(dir: string, c: string) {
  const r = Bun.spawnSync(["bash", "-c", c], { cwd: dir })
  if (r.exitCode !== 0) {
    throw new Error(`setup command failed (${r.exitCode}): ${c}\n${r.stderr?.toString() ?? ""}`)
  }
}

function scratchRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-e2e-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// failing test placeholder\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  // A TRACKED placeholder inside .km/ — git never tracks empty dirs, so
  // without a real file here the archived tree would never contain .km/
  // at all and the strip-.km assertion below would pass vacuously.
  fs.writeFileSync(path.join(dir, ".km", "runtime-state.json"), "{}\n")
  fs.writeFileSync(path.join(dir, ".env.local"), "SECRET=shh\n")
  sh(dir, "git add -A && git commit -qm init")
  // fixture ref via the same plumbing Task 1 uses
  sh(dir, "git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(dir, `git update-ref refs/kkamak/fixtures/100-scratch-r1 ${treeSha}`)
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, check: "exit 1",
      headSha: "x", treeSha, ref: "refs/kkamak/fixtures/100-scratch-r1" }) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, roundsMax: 2,
      check: "exit 1", excerpt: "synthetic failure output" }) + "\n")
  return dir
}

/** Two fixture-ref records: an OLDER valid one and a NEWER bailed one (empty
 * treeSha/ref, bail set). Auto-selection must pick the older valid record —
 * bailed records are never auto-picked regardless of recency. */
function scratchRepoWithBail(): { dir: string; validRef: string; treeSha: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-bail-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// t\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  sh(dir, "git add -A && git commit -qm init")
  sh(dir, "git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  const validRef = "refs/kkamak/fixtures/100-scratch-r1"
  sh(dir, `git update-ref ${validRef} ${treeSha}`)
  const records = [
    { ts: 100, sessionID: "s1", round: 1, check: "exit 1", headSha: "x", treeSha, ref: validRef },
    { ts: 200, sessionID: "s1", round: 2, check: "exit 1", headSha: "x", treeSha: "", ref: "", bail: "rebase-merge" },
  ]
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"), records.map((r) => JSON.stringify(r)).join("\n") + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"), "")
  return { dir, validRef, treeSha }
}

/** Bare repo with a valid commit/tree but NO test/tests/__tests__ dirs —
 * exercises the empty-pristine-archive branch. */
function scratchRepoNoTests(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-notests-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  sh(dir, "git add -A && git commit -qm init")
  sh(dir, "git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(dir, `git update-ref refs/kkamak/fixtures/100-scratch-r1 ${treeSha}`)
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, check: "exit 1",
      headSha: "x", treeSha, ref: "refs/kkamak/fixtures/100-scratch-r1" }) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"), "")
  return dir
}

/** Valid repo + a fixture-ref record carrying a `treeSha` override and an
 * optional `transcriptPath` — for exercising the treeSha-validation /
 * materialize-failure paths and the transcript-read paths without
 * duplicating the whole scratch-repo setup per case. */
function scratchRepoWithOverrides(over: { treeSha?: string; transcriptPath?: string }): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-ov-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// t\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  sh(dir, "git add -A && git commit -qm init")
  sh(dir, "git add -A && git write-tree > .treesha")
  const realTreeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(dir, `git update-ref refs/kkamak/fixtures/100-scratch-r1 ${realTreeSha}`)
  const record = {
    ts: 100, sessionID: "scratchsess", round: 1, check: "exit 1", headSha: "x",
    treeSha: over.treeSha ?? realTreeSha, ref: "refs/kkamak/fixtures/100-scratch-r1",
    ...(over.transcriptPath !== undefined ? { transcriptPath: over.transcriptPath } : {}),
  }
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"), JSON.stringify(record) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"), "")
  return dir
}

/** Nested secrets at depth 2 (`packages/sub/.env`) plus a top-level
 * `.npmrc` — exercises the RECURSIVE hygiene strip (finding I2). A sibling
 * file in the same nested dir proves the strip removes only the matched
 * files, not the directory tree around them. */
function scratchRepoWithNestedSecrets(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-secrets-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// t\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  fs.writeFileSync(path.join(dir, ".km", "runtime-state.json"), "{}\n")
  fs.mkdirSync(path.join(dir, "packages", "sub"), { recursive: true })
  fs.writeFileSync(path.join(dir, "packages", "sub", ".env"), "SECRET=deep\n")
  fs.writeFileSync(path.join(dir, "packages", "sub", "index.ts"), "export const y = 2\n")
  fs.writeFileSync(path.join(dir, ".npmrc"), "//registry.npmjs.org/:_authToken=shh\n")
  fs.writeFileSync(path.join(dir, ".netrc"), "machine example.com login x password shh\n")
  sh(dir, "git add -A && git commit -qm init")
  sh(dir, "git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(dir, `git update-ref refs/kkamak/fixtures/100-scratch-r1 ${treeSha}`)
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, check: "exit 1",
      headSha: "x", treeSha, ref: "refs/kkamak/fixtures/100-scratch-r1" }) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"), "")
  return dir
}

/** Fixture-ref record carrying a `check` override — for exercising the
 * empty/whitespace-check rejection (finding M8). */
function scratchRepoWithCheck(check: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harvest-check-"))
  sh(dir, "git init -q && git config user.email t@t && git config user.name t")
  fs.mkdirSync(path.join(dir, "test"))
  fs.writeFileSync(path.join(dir, "test", "x.test.ts"), "// t\n")
  fs.writeFileSync(path.join(dir, "app.ts"), "export const x = 1\n")
  fs.mkdirSync(path.join(dir, ".km"), { recursive: true })
  sh(dir, "git add -A && git commit -qm init")
  sh(dir, "git add -A && git write-tree > .treesha")
  const treeSha = fs.readFileSync(path.join(dir, ".treesha"), "utf-8").trim()
  sh(dir, `git update-ref refs/kkamak/fixtures/100-scratch-r1 ${treeSha}`)
  fs.writeFileSync(path.join(dir, ".km", "fixture-refs.ndjson"),
    JSON.stringify({ ts: 100, sessionID: "scratchsess", round: 1, check,
      headSha: "x", treeSha, ref: "refs/kkamak/fixtures/100-scratch-r1" }) + "\n")
  fs.writeFileSync(path.join(dir, ".km", "check-output.ndjson"), "")
  return dir
}

describe("harvestFixture", () => {
  test("refuses repos outside the allowlist", async () => {
    const dir = scratchRepo()
    await expect(harvestFixture({ repoPath: dir, outDir: fs.mkdtempSync(path.join(os.tmpdir(), "out-")), allowedRepos: [] }))
      .rejects.toThrow(/per-repo inclusion/)
  })

  test("end-to-end: materializes full task dir, strips .km + .env*", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    for (const f of ["task.toml", "instruction.md", "fixture.json", "environment/Dockerfile",
      "environment/repo/app.ts", "tests/test.sh", "tests/pristine.tar"])
      expect(fs.existsSync(path.join(taskDir, f))).toBe(true)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.km"))).toBe(false)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.km/runtime-state.json"))).toBe(false)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.env.local"))).toBe(false)
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.excerpt).toBe("synthetic failure output")
    expect(fx.repoPath).toBe(path.basename(dir))
    expect(typeof fx.generatedAt).toBe("string")
    expect(Number.isNaN(Date.parse(fx.generatedAt))).toBe(false)
    expect(fx.ref.ref).toBe("refs/kkamak/fixtures/100-scratch-r1")
    // pristine.tar actually contains the captured test/ dir
    const tarList = Bun.spawnSync(["tar", "-tf", path.join(taskDir, "tests", "pristine.tar")]).stdout.toString()
    expect(tarList).toContain("test/x.test.ts")
    // task dir name derives from the record's ts (UTC epoch ms=100), not wall clock
    expect(path.basename(taskDir)).toBe(`harvested-${path.basename(dir)}-19700101-000000`)
  })

  test("--ref selection: bailed records are never auto-picked", async () => {
    const { dir, validRef } = scratchRepoWithBail()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.ref.ref).toBe(validRef)
  })

  test("explicit refName selects by exact ref string", async () => {
    const { dir, validRef } = scratchRepoWithBail()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], refName: validRef })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.ref.ref).toBe(validRef)
  })

  test("taskName option overrides the derived default", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], taskName: "my-custom-task" })
    expect(path.basename(taskDir)).toBe("my-custom-task")
  })

  test("no test/tests/__tests__ dirs -> empty pristine.tar, harvest still succeeds", async () => {
    const dir = scratchRepoNoTests()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    expect(fs.existsSync(path.join(taskDir, "tests/pristine.tar"))).toBe(true)
    const list = Bun.spawnSync(["tar", "-tf", path.join(taskDir, "tests", "pristine.tar")]).stdout.toString().trim()
    expect(list).toBe("")
  })

  test("transcript read: happy path populates firstUser/lastUser in fixture.json", async () => {
    const dir = scratchRepoWithOverrides({})
    const transcriptPath = path.join(dir, "transcript.jsonl")
    fs.writeFileSync(transcriptPath,
      JSON.stringify({ type: "user", timestamp: "1970-01-01T00:00:00.050Z",
        message: { role: "user", content: "please fix the bug" } }) + "\n")
    // rewrite the ref record with transcriptPath (ts stays 100, transcript line at 50ms is before cutoff)
    const refsPath = path.join(dir, ".km", "fixture-refs.ndjson")
    const rec = JSON.parse(fs.readFileSync(refsPath, "utf-8").trim())
    fs.writeFileSync(refsPath, JSON.stringify({ ...rec, transcriptPath }) + "\n")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.firstUser).toBe("please fix the bug")
    expect(fx.lastUser).toBe("please fix the bug")
  })

  test("transcript read: unreadable path -> harvest still succeeds with empty prompt context", async () => {
    const dir = scratchRepoWithOverrides({ transcriptPath: path.join(fs.mkdtempSync(path.join(os.tmpdir(), "harvest-ghost-")), "does-not-exist.jsonl") })
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.firstUser).toBeUndefined()
    expect(fx.lastUser).toBeUndefined()
  })

  test("invalid-format treeSha throws before any subprocess runs", async () => {
    const dir = scratchRepoWithOverrides({ treeSha: "not-a-sha" })
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] }))
      .rejects.toThrow(/treeSha/)
  })

  test("valid-format but nonexistent treeSha: git archive failure throws, not masked by pipefail", async () => {
    const dir = scratchRepoWithOverrides({ treeSha: "0".repeat(40) })
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] }))
      .rejects.toThrow()
  })

  test("recursive hygiene: nested .env, .npmrc, .netrc stripped at any depth (finding I2)", async () => {
    const dir = scratchRepoWithNestedSecrets()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    expect(fs.existsSync(path.join(taskDir, "environment/repo/packages/sub/.env"))).toBe(false)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.npmrc"))).toBe(false)
    expect(fs.existsSync(path.join(taskDir, "environment/repo/.netrc"))).toBe(false)
    // sibling file in the same nested dir survives — only matched names are stripped
    expect(fs.existsSync(path.join(taskDir, "environment/repo/packages/sub/index.ts"))).toBe(true)
  })

  test("collision: harvesting into an already-existing task dir throws (finding M7)", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], taskName: "dup-task" })
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], taskName: "dup-task" }))
      .rejects.toThrow(/already exists/)
  })

  test("empty check throws before assembly, no task dir created (finding M8)", async () => {
    const dir = scratchRepoWithCheck("")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const before = fs.readdirSync(out)
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] }))
      .rejects.toThrow(/check/)
    expect(fs.readdirSync(out)).toEqual(before)
  })

  test("whitespace-only check throws before assembly, no task dir created (finding M8)", async () => {
    const dir = scratchRepoWithCheck("   ")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const before = fs.readdirSync(out)
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] }))
      .rejects.toThrow(/check/)
    expect(fs.readdirSync(out)).toEqual(before)
  })

  // Validity probe (47M ruling 2026-08-10): a fixture whose check PASSES in a
  // fresh container is vacuous (reward 1 with zero agent work) — the harvested
  // failure class did not survive re-materialization (e.g. stale host
  // node_modules). The probe must refuse it and leave nothing behind.
  test("probe: vacuous fixture (check exits 0 in container) is refused and the task dir removed", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await expect(harvestFixture({
      repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], taskName: "vacuous-task",
      prober: async () => ({ buildOk: true, checkExitCode: 0, output: "all green" }),
    })).rejects.toThrow(/vacuous/)
    expect(fs.existsSync(path.join(out, "vacuous-task"))).toBe(false)
  })

  test("probe: image build failure is refused and the task dir removed", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await expect(harvestFixture({
      repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)], taskName: "buildfail-task",
      prober: async () => ({ buildOk: false, output: "build exploded" }),
    })).rejects.toThrow(/build/)
    expect(fs.existsSync(path.join(out, "buildfail-task"))).toBe(false)
  })

  test("probe: genuinely failing check keeps the task dir and records the probe in fixture.json", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    let seen: { envDir: string; check: string } | undefined
    const taskDir = await harvestFixture({
      repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)],
      prober: async (a) => { seen = { envDir: a.envDir, check: a.check }; return { buildOk: true, checkExitCode: 1, output: "1 fail" } },
    })
    expect(fs.existsSync(taskDir)).toBe(true)
    // prober was pointed at the materialized environment/ and the record's check
    expect(seen?.envDir).toBe(path.join(taskDir, "environment"))
    expect(seen?.check).toBe("exit 1")
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.probe).toEqual({ checkExitCode: 1 })
  })

  test("probe: no prober option -> no probe, fixture.json carries no probe field", async () => {
    const dir = scratchRepo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.probe).toBeUndefined()
  })

  // Ruling C (2026-08-10): history-coupled checks (gate-check's calibration
  // drift guard reads real `git log` history) can never pass in a
  // single-synthetic-commit image — such fixtures fail environmentally
  // forever. They are ruled un-harvestable; only tree-pure checks harvest.
  test("ruling C: explicit --ref to an un-harvestable check refuses before materialization, nothing created", async () => {
    const dir = scratchRepoWithCheck("bun scripts/gate-check.ts")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const before = fs.readdirSync(out)
    await expect(harvestFixture({
      repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)],
      refName: "refs/kkamak/fixtures/100-scratch-r1",
    })).rejects.toThrow(/un-harvestable|history/)
    expect(fs.readdirSync(out)).toEqual(before)
  })

  test("ruling C: auto-pick skips un-harvestable records and selects an older tree-pure one", async () => {
    const dir = scratchRepo()
    // append a NEWER record with a history-coupled check; auto-pick must
    // fall through to the older tree-pure `exit 1` record
    const refsPath = path.join(dir, ".km", "fixture-refs.ndjson")
    const pure = JSON.parse(fs.readFileSync(refsPath, "utf-8").trim())
    const impure = { ...pure, ts: 999, round: 2, check: "bun scripts/gate-check.ts", ref: "refs/kkamak/fixtures/999-scratch-r2" }
    fs.writeFileSync(refsPath, [JSON.stringify(pure), JSON.stringify(impure)].join("\n") + "\n")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    const taskDir = await harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] })
    const fx = JSON.parse(fs.readFileSync(path.join(taskDir, "fixture.json"), "utf-8"))
    expect(fx.ref.ref).toBe("refs/kkamak/fixtures/100-scratch-r1")
    expect(fx.ref.check).toBe("exit 1")
  })

  test("ruling C: all records un-harvestable -> no-eligible error, not a silent pick", async () => {
    const dir = scratchRepoWithCheck("bun scripts/gate-check.ts")
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "out-"))
    await expect(harvestFixture({ repoPath: dir, outDir: out, allowedRepos: [path.basename(dir)] }))
      .rejects.toThrow(/no eligible/)
  })
})
