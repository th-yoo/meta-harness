import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {
  appendFixtureRef,
  buildFixtureRef,
  captureFixtureRef,
  FIXTURE_REF_REL_PATH,
  type FixtureRefRecord,
  type GitRunner,
} from "../src/fixture-ref"

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

const BASE_REC: FixtureRefRecord = {
  ts: 1000, sessionID: "s1", round: 1, check: "bun test",
  headSha: "h", treeSha: "t", ref: "refs/kkamak/fixtures/1000-s1-r1",
}

describe("appendFixtureRef", () => {
  test("appends one ndjson line, mkdir -p as needed", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-append-"))
    try {
      appendFixtureRef(dir, BASE_REC, () => {})
      appendFixtureRef(dir, { ...BASE_REC, round: 2 }, () => {})
      const lines = fs
        .readFileSync(path.join(dir, FIXTURE_REF_REL_PATH), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      expect(lines.length).toBe(2)
      expect(lines[0]).toMatchObject(BASE_REC)
      expect(lines[1].round).toBe(2)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("swallows write failure and logs (fail-open)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-append-"))
    try {
      // Make the sidecar PATH a directory so appendFileSync fails (EISDIR).
      fs.mkdirSync(path.join(dir, FIXTURE_REF_REL_PATH), { recursive: true })
      const logs: string[] = []
      expect(() => appendFixtureRef(dir, BASE_REC, (m) => logs.push(m))).not.toThrow()
      expect(logs.length).toBe(1)
      expect(logs[0]).toContain("fixture-ref")
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("captureFixtureRef", () => {
  test("end-to-end: builds + appends via a fake runner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-capture-"))
    fs.mkdirSync(path.join(dir, ".git"))
    try {
      await captureFixtureRef(
        { cwd: dir, ts: 5, sessionID: "abcd1234-x", round: 3, check: "bun test" },
        fakeRunner({
          "rev-parse HEAD": "headsha000\n",
          "add -A": "",
          "write-tree": "treesha111\n",
          "update-ref": "",
        }),
        () => {},
      )
      const lines = fs
        .readFileSync(path.join(dir, FIXTURE_REF_REL_PATH), "utf-8")
        .trim()
        .split("\n")
        .map((l) => JSON.parse(l))
      expect(lines.length).toBe(1)
      expect(lines[0]).toMatchObject({ ts: 5, sessionID: "abcd1234-x", round: 3, treeSha: "treesha111" })
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  test("never throws even when the runner itself throws", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fxref-capture-"))
    fs.mkdirSync(path.join(dir, ".git"))
    try {
      const logs: string[] = []
      const throwingRunner: GitRunner = async () => { throw new Error("git binary missing") }
      await expect(
        captureFixtureRef(
          { cwd: dir, ts: 1, sessionID: "s", round: 1, check: "c" },
          throwingRunner,
          (m) => logs.push(m),
        ),
      ).resolves.toBeUndefined()
      expect(logs.length).toBeGreaterThan(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
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
