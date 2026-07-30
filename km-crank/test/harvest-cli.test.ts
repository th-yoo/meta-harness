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
})
