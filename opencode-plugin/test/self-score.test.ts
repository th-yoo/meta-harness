import { describe, expect, test } from "bun:test"
import { readSelfScore, SELF_SCORE_PATH, SELF_CHECK_INSTRUCTION } from "../src/bench/self-score.ts"
import type { ExecResult } from "../src/bench/exec.ts"

const ok = (stdout: string): ExecResult => ({ rc: 0, stdout, stderr: "", timedOut: false })
const fail = (): ExecResult => ({ rc: 1, stdout: "", stderr: "no such file", timedOut: false })

describe("readSelfScore", () => {
  test("parses passed/total into a 0..1 fraction", async () => {
    expect(await readSelfScore("c", async () => ok("28/32\n"))).toBeCloseTo(0.875, 5)
    expect(await readSelfScore("c", async () => ok("32/32"))).toBe(1)
    expect(await readSelfScore("c", async () => ok("0/5"))).toBe(0)
    expect(await readSelfScore("c", async () => ok("  7 / 10  "))).toBeCloseTo(0.7, 5)
  })

  test("absent file (agent skipped self-check) → null", async () => {
    expect(await readSelfScore("c", async () => fail())).toBeNull()
  })

  test("malformed content → null (no throw)", async () => {
    for (const junk of ["PASS", "3", "abc/def", "", "3/", "/4", "3/4 extra"]) {
      expect(await readSelfScore("c", async () => ok(junk))).toBeNull()
    }
  })

  test("total=0 → null (no div-by-zero)", async () => {
    expect(await readSelfScore("c", async () => ok("0/0"))).toBeNull()
  })

  // R3#1: passed>total (>1.0) would count as "self-PASS" at threshold 1.0 and
  // poison the correlation/argmax — reject to null, same class as R2#1.
  test("passed>total (score>1) → null", async () => {
    expect(await readSelfScore("c", async () => ok("8/4"))).toBeNull()
    expect(await readSelfScore("c", async () => ok("5/0"))).toBeNull()
  })

  test("execFn is called with a cat of the fixed self-score path", async () => {
    let seen: string[] = []
    await readSelfScore("mh-task-123", async (argv) => { seen = argv; return ok("1/1") })
    expect(seen).toContain("cat")
    expect(seen).toContain(SELF_SCORE_PATH)
    expect(seen).toContain("mh-task-123") // container name threaded into buildExecArgv
  })
})

describe("SELF_CHECK_INSTRUCTION", () => {
  test("instructs writing the fraction to the fixed path, real checks", () => {
    expect(SELF_CHECK_INSTRUCTION).toContain(SELF_SCORE_PATH)
    expect(SELF_CHECK_INSTRUCTION).toContain("<passed>/<total>")
    expect(SELF_CHECK_INSTRUCTION).toMatch(/WRITE AND RUN/)
  })
})
