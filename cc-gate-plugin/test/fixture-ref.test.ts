import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { buildFixtureRef, FIXTURE_REF_REL_PATH, type GitRunner } from "../src/fixture-ref"

function fakeRunner(outputs: Record<string, string>): GitRunner {
  return async (argv) => {
    const key = argv.join(" ")
    for (const [prefix, out] of Object.entries(outputs)) {
      if (key.startsWith(prefix)) return { code: 0, out }
    }
    return { code: 128, out: "" }
  }
}

describe("buildFixtureRef", () => {
  test("happy path: write-tree + update-ref, record carries both shas", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1785400000000, sessionID: "abcd1234-x", round: 1, check: "bun test" },
      fakeRunner({
        "rev-parse HEAD": "headsha000\n",
        "add -A": "",
        "write-tree": "treesha111\n",
        "update-ref": "",
      }),
    )
    expect(rec.treeSha).toBe("treesha111")
    expect(rec.headSha).toBe("headsha000")
    expect(rec.ref).toBe("refs/kkamak/fixtures/1785400000000-abcd1234-r1")
    expect(rec.bail).toBeUndefined()
  })

  test("bails mid-rebase without running any git mutation", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git", "rebase-merge"), { recursive: true })
    let calls = 0
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => { calls++; return { code: 0, out: "" } },
    )
    expect(rec.bail).toBe("rebase-merge")
    expect(rec.treeSha).toBe("")
    expect(calls).toBe(0)
  })

  test("bails not-a-repo when .git missing", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => ({ code: 0, out: "" }),
    )
    expect(rec.bail).toBe("not-a-repo")
  })

  test("git failure surfaces as bail, never throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-"))
    fs.mkdirSync(path.join(dir, ".git"))
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
      async () => ({ code: 128, out: "boom" }),
    )
    expect(rec.bail).toMatch(/^git-failed: /)
  })
})

describe("integration (real git)", () => {
  test("snapshots dirty tree without touching working index", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-int-"))
    const sh = (cmd: string) => Bun.spawnSync(["bash", "-c", cmd], { cwd: dir })
    sh("git init -q && git config user.email t@t && git config user.name t")
    fs.writeFileSync(path.join(dir, "a.txt"), "committed\n")
    sh("git add -A && git commit -qm init")
    fs.writeFileSync(path.join(dir, "a.txt"), "DIRTY\n")           // unstaged edit
    fs.writeFileSync(path.join(dir, "new.txt"), "untracked\n")      // untracked file
    const { buildFixtureRef, bunGitRunner } = await import("../src/fixture-ref")
    const rec = await buildFixtureRef(
      { cwd: dir, ts: 42, sessionID: "sessAAAA-1", round: 2, check: "bun test" }, bunGitRunner)
    expect(rec.bail).toBeUndefined()
    // tree contains BOTH the dirty edit and the untracked file
    const show = sh(`git cat-file -p ${rec.treeSha}`)
    expect(show.stdout.toString()).toContain("new.txt")
    // working index untouched: status still shows the edit as unstaged
    expect(sh("git status --porcelain").stdout.toString()).toContain(" M a.txt")
    // ref resolvable
    expect(sh(`git rev-parse ${rec.ref}`).stdout.toString().trim()).toBe(rec.treeSha)
  })
})

describe("F2 tripwire", () => {
  test("fixture-refs.ndjson never enters km-sensors-sync FILES", () => {
    const sync = fs.readFileSync(path.join(import.meta.dir, "../../scripts/km-sensors-sync.sh"), "utf-8")
    expect(sync).not.toContain("fixture-refs")
  })
})
