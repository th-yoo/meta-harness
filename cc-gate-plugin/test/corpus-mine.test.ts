import { describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { mineJsonl, dedupeEarliest, sha256Hex, type MineOptions } from "../src/gauge/corpus-mine.ts"
import { CORPUS_FILE_REL, type CorpusRecord } from "../src/gauge/corpus-store.ts"

const REPO = "/repo/example"

function line(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    type: "user",
    sessionId: "sess-1",
    timestamp: "2026-07-31T00:00:00.000Z",
    cwd: REPO,
    message: { content: "fix the login bug in src/auth.ts" },
    ...over,
  })
}

function opts(over: Partial<MineOptions> = {}): MineOptions {
  return { floorCheckFor: () => "", now: 1000, ...over }
}

describe("mineJsonl — filter matrix", () => {
  test("human line: mined", () => {
    const records = mineJsonl(line(), opts())
    expect(records.length).toBe(1)
    expect(records[0]!.prompt).toBe("fix the login bug in src/auth.ts")
    expect(records[0]!.stage).toBe("mined")
    expect(records[0]!.provenance).toBe("corpus-transcript")
  })

  test("isSidechain:true — excluded", () => {
    const records = mineJsonl(line({ isSidechain: true }), opts())
    expect(records.length).toBe(0)
  })

  test("isMeta:true — excluded", () => {
    const records = mineJsonl(line({ isMeta: true }), opts())
    expect(records.length).toBe(0)
  })

  test("non-task-shaped text — excluded", () => {
    const records = mineJsonl(
      line({ message: { content: "what do you think about this?" } }),
      opts(),
    )
    expect(records.length).toBe(0)
  })

  test("array-content: text block extracted, tool_result block excluded", () => {
    const records = mineJsonl(
      line({
        message: {
          content: [
            { type: "tool_result", content: "irrelevant tool output" },
            { type: "text", text: "add a new field to db/schema.sql" },
          ],
        },
      }),
      opts(),
    )
    expect(records.length).toBe(1)
    expect(records[0]!.prompt).toBe("add a new field to db/schema.sql")
  })

  test("origin present with kind !== 'human' — excluded", () => {
    const records = mineJsonl(line({ origin: { kind: "coordinator" } }), opts())
    expect(records.length).toBe(0)
  })

  test("origin ABSENT — still mined (no hard gate)", () => {
    const records = mineJsonl(line(), opts())
    expect(records.length).toBe(1)
  })

  test("origin present with kind === 'human' — mined", () => {
    const records = mineJsonl(line({ origin: { kind: "human" } }), opts())
    expect(records.length).toBe(1)
  })

  test("type !== 'user' — excluded", () => {
    const records = mineJsonl(line({ type: "assistant" }), opts())
    expect(records.length).toBe(0)
  })

  test("malformed JSON line — skipped silently, valid lines still parsed", () => {
    const text = ["not json at all {{{", line()].join("\n")
    const records = mineJsonl(text, opts())
    expect(records.length).toBe(1)
  })
})

describe("mineJsonl — field construction", () => {
  test("sessionId casing: raw lowercase-d key preserved on the record", () => {
    const records = mineJsonl(line({ sessionId: "SESSION-Abc123" }), opts())
    expect(records.length).toBe(1)
    expect(records[0]!.sessionId).toBe("SESSION-Abc123")
  })

  test("promptSha256 is sha256 hex of the extracted prompt text", () => {
    const records = mineJsonl(line(), opts())
    expect(records[0]!.promptSha256).toBe(sha256Hex("fix the login bug in src/auth.ts"))
  })

  test("promptTs is Date.parse of the raw timestamp", () => {
    const records = mineJsonl(line({ timestamp: "2026-07-31T12:34:56.000Z" }), opts())
    expect(records[0]!.promptTs).toBe(Date.parse("2026-07-31T12:34:56.000Z"))
  })

  test("floorCheck present: lookup returns the repo's gate.json check", () => {
    const records = mineJsonl(line(), opts({ floorCheckFor: (repo) => (repo === REPO ? "bun test" : "") }))
    expect(records[0]!.floorCheck).toBe("bun test")
    expect(records[0]!.floorCheckMinedAt).toBe(1000)
  })

  test("floorCheck absent: lookup returns empty string", () => {
    const records = mineJsonl(line(), opts({ floorCheckFor: () => "" }))
    expect(records[0]!.floorCheck).toBe("")
  })
})

describe("dedupeEarliest", () => {
  function rec(over: Partial<CorpusRecord> = {}): CorpusRecord {
    return {
      provenance: "corpus-transcript",
      stage: "mined",
      repo: REPO,
      sessionId: "sess-1",
      promptTs: 1000,
      prompt: "fix the thing",
      promptSha256: "sha-a",
      floorCheck: "",
      floorCheckMinedAt: 1000,
      ...over,
    }
  }

  test("keeps the earliest promptTs among duplicate (repo, promptSha256)", () => {
    const records = [rec({ promptTs: 2000 }), rec({ promptTs: 500 }), rec({ promptTs: 1500 })]
    const out = dedupeEarliest(records)
    expect(out.length).toBe(1)
    expect(out[0]!.promptTs).toBe(500)
  })

  test("distinct (repo, promptSha256) keys both survive", () => {
    const records = [rec({ promptSha256: "sha-a" }), rec({ promptSha256: "sha-b" })]
    expect(dedupeEarliest(records).length).toBe(2)
  })

  test("same sha, different repo: both survive", () => {
    const records = [rec({ repo: "/repo/a" }), rec({ repo: "/repo/b" })]
    expect(dedupeEarliest(records).length).toBe(2)
  })
})

describe("mine CLI — real subprocess", () => {
  function mkdir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "km-corpus-mine-"))
  }

  test("bun replay-cli.ts mine <cwd> scans KKAMAK_CLAUDE_PROJECTS_DIR, skips subagents/, writes records.ndjson", async () => {
    const projectsDir = mkdir()
    const sourceRepo = mkdir()
    const storeCwd = mkdir()

    fs.writeFileSync(path.join(sourceRepo, "gate.json"), JSON.stringify({ check: "bun test" }))

    const slugDir = path.join(projectsDir, "-repo-example-slug")
    fs.mkdirSync(slugDir, { recursive: true })
    fs.writeFileSync(
      path.join(slugDir, "session-1.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "SESSION-Abc123",
        timestamp: "2026-07-31T00:00:00.000Z",
        cwd: sourceRepo,
        message: { content: "fix the login bug in src/auth.ts" },
      }) + "\n",
    )

    // subagents/ subdir must be skipped even though it holds a valid,
    // differently-worded task-shaped line.
    const subagentsDir = path.join(slugDir, "subagents")
    fs.mkdirSync(subagentsDir, { recursive: true })
    fs.writeFileSync(
      path.join(subagentsDir, "sub-1.jsonl"),
      JSON.stringify({
        type: "user",
        sessionId: "sub-sess",
        timestamp: "2026-07-31T00:00:00.000Z",
        cwd: sourceRepo,
        message: { content: "refactor the subagent helper in lib/helper.ts" },
      }) + "\n",
    )

    const cliPath = path.join(import.meta.dir, "../src/gauge/replay-cli.ts")
    const proc = Bun.spawn(["bun", cliPath, "mine", storeCwd], {
      env: { ...process.env, KKAMAK_CLAUDE_PROJECTS_DIR: projectsDir },
      stdout: "pipe",
      stderr: "pipe",
    })
    const code = await proc.exited
    expect(code).toBe(0)

    const storePath = path.join(storeCwd, CORPUS_FILE_REL)
    const lines = fs
      .readFileSync(storePath, "utf-8")
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as CorpusRecord)

    expect(lines.length).toBe(1)
    expect(lines[0]!.repo).toBe(sourceRepo)
    expect(lines[0]!.sessionId).toBe("SESSION-Abc123")
    expect(lines[0]!.prompt).toBe("fix the login bug in src/auth.ts")
    expect(lines[0]!.promptSha256).toBe(sha256Hex("fix the login bug in src/auth.ts"))
    expect(lines[0]!.floorCheck).toBe("bun test")
    expect(lines[0]!.stage).toBe("mined")
    expect(lines[0]!.provenance).toBe("corpus-transcript")
  }, 20_000)
})
