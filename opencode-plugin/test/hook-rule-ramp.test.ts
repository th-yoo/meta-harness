import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { rampScan } from "../src/hook-rule-ramp"
import { readPlaybook, type Playbook } from "../src/harness-store"
import { HOOK_RULES_EXPORT_REL } from "../src/hook-rules-export"

let repoRoot: string
let storeRoot: string

function seedActive(mode: "shadow" | "warn" | "deny"): void {
  const pb: Playbook = {
    schemaVersion: 1,
    nextId: 2,
    bullets: [
      {
        id: "b1",
        text: "when containerizing use podman",
        helpful: 0,
        harmful: 0,
        addedBy: "test",
        status: "active",
        createdAt: "2026-08-15T00:00:00.000Z",
        updatedAt: "2026-08-15T00:00:00.000Z",
        hookRule: { event: "PreToolUse", toolMatcher: "Bash", inputPattern: "^docker ", feedback: "use podman", mode },
      },
    ],
  }
  mkdirSync(join(storeRoot, "active"), { recursive: true })
  writeFileSync(join(storeRoot, "active", "playbook.json"), JSON.stringify(pb))
}

/** Sensor stream: `sessions` sessions; each has `obsPerSession` b1 matches;
 * the first `passed` of them have accepted:true. */
function seedStream(sessions: number, obsPerSession: number, passed: number): void {
  const lines: string[] = []
  for (let s = 0; s < sessions; s++) {
    const outcomes = Array.from({ length: obsPerSession }, () => ({ id: "b1", matched: true, mode: "shadow", ms: 0.1 }))
    lines.push(
      JSON.stringify({
        ts: 1786700000000 + s,
        sessionID: `sess-${s}`,
        accepted: s < passed,
        hookRules: outcomes,
      }),
    )
  }
  mkdirSync(join(repoRoot, ".km"), { recursive: true })
  writeFileSync(join(repoRoot, ".km", "gate-outcomes.ndjson"), lines.join("\n") + "\n")
}

beforeEach(() => {
  repoRoot = mkdtempSync(join(tmpdir(), "ramp-repo-"))
  storeRoot = mkdtempSync(join(tmpdir(), "ramp-store-"))
})
afterEach(() => {
  rmSync(repoRoot, { recursive: true, force: true })
  rmSync(storeRoot, { recursive: true, force: true })
})

describe("rampScan shadow->warn", () => {
  test("promotes exactly at N=20 obs / K=5 sessions / fp<=0.25", () => {
    seedActive("shadow")
    seedStream(5, 4, 1) // 20 obs, 5 sessions, fp=1/5=0.2
    const applied = rampScan(repoRoot, storeRoot)
    expect(applied.length).toBe(1)
    expect(applied[0]!.to).toBe("warn")
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("warn")
  })

  test("19 obs -> no promotion", () => {
    seedActive("shadow")
    seedStream(5, 4, 1)
    // Remove one observation from the last session's line.
    const p = join(repoRoot, ".km", "gate-outcomes.ndjson")
    const lines = readFileSync(p, "utf-8").trim().split("\n")
    const last = JSON.parse(lines[4]!)
    last.hookRules.pop()
    lines[4] = JSON.stringify(last)
    writeFileSync(p, lines.join("\n") + "\n")
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("shadow")
  })

  test("20 obs across only 4 sessions -> no promotion", () => {
    seedActive("shadow")
    seedStream(4, 5, 1)
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
  })

  test("fp counts SESSIONS not observations: 2 of 5 sessions passed -> fp 0.4 -> no promotion", () => {
    seedActive("shadow")
    seedStream(5, 4, 2)
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
  })

  test("promotion re-exports the compiled table", () => {
    seedActive("shadow")
    seedStream(5, 4, 1)
    rampScan(repoRoot, storeRoot)
    const table = JSON.parse(readFileSync(join(repoRoot, HOOK_RULES_EXPORT_REL), "utf-8"))
    expect(table.rules[0].mode).toBe("warn")
  })
})

describe("rampScan deny->shadow demotion", () => {
  test("deny rule with fp breach demotes automatically", () => {
    seedActive("deny")
    seedStream(5, 4, 3) // fp 0.6 > 0.25
    const applied = rampScan(repoRoot, storeRoot)
    expect(applied.length).toBe(1)
    expect(applied[0]!.from).toBe("deny")
    expect(applied[0]!.to).toBe("shadow")
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("shadow")
  })

  test("deny rule under theta stays deny; fewer than K sessions never demotes", () => {
    seedActive("deny")
    seedStream(5, 4, 1) // fp 0.2
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    seedStream(3, 4, 3) // fp 1.0 but only 3 sessions
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("deny")
  })
})

describe("rampScan safety", () => {
  test("warn rules are never auto-transitioned", () => {
    seedActive("warn")
    seedStream(10, 4, 0)
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("warn")
  })

  test("missing or garbage stream -> no transitions, no throw", () => {
    seedActive("shadow")
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    mkdirSync(join(repoRoot, ".km"), { recursive: true })
    writeFileSync(join(repoRoot, ".km", "gate-outcomes.ndjson"), "NOT JSON\n{broken\n")
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
  })
})

describe("rampScan lock discipline", () => {
  test("skips entirely while a live proposer lock exists for this root", async () => {
    const { writeProposerLock } = await import("../src/adapters/claude-code/proposer")
    seedActive("shadow")
    seedStream(5, 4, 1) // would promote
    writeProposerLock({
      worktree: repoRoot,
      layer: { root: storeRoot, scope: "project-global" },
      spawnedAt: Date.now(),
      timeoutMs: 600_000,
      version: "v1",
    } as never)
    expect(rampScan(repoRoot, storeRoot).length).toBe(0)
    expect(readPlaybook(storeRoot)!.bullets[0]!.hookRule!.mode).toBe("shadow")
  })
})
