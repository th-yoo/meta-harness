// test/prompt-check-cli.test.ts — integration tests that spawn the real
// prompt-check-cli.ts process (bun prompt-check-cli.ts <cwd> <sessionID>
// <spawnTs>) against hermetic tmp repos, exactly as prompt-check-spawn.ts's
// nohup double-fork would invoke it. Real subprocess runs, not unit calls
// against an imported function — the brief pins this as an integration seam
// (Phase 3 Task 3).
import { test, expect } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import { LOCK_REL_PATH } from "../src/prompt-check-spawn.ts"
import { DEFAULT_SENSOR_REL_PATH } from "../src/sensor-append.ts"

const CLI = path.join(import.meta.dir, "..", "src", "prompt-check-cli.ts")

function mkRepo(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "km-prompt-check-cli-"))
}

function writeGate(repo: string, cfg: Record<string, unknown>): void {
  fs.writeFileSync(path.join(repo, "gate.json"), JSON.stringify(cfg))
}

function sensorPath(repo: string): string {
  return path.join(repo, DEFAULT_SENSOR_REL_PATH)
}

function lockPath(repo: string): string {
  return path.join(repo, LOCK_REL_PATH)
}

function readSensorLines(repo: string): Record<string, unknown>[] {
  if (!fs.existsSync(sensorPath(repo))) return []
  const txt = fs.readFileSync(sensorPath(repo), "utf-8")
  return txt
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l))
}

async function runCli(args: string[]): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", CLI, ...args], { stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout as ReadableStream<Uint8Array>).text(),
    new Response(proc.stderr as ReadableStream<Uint8Array>).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

test("pass variant: exit 0 check -> exactly one line, accepted:true, promptCheck/spawnTs/rounds/host/pluginVersion, no reinject/forced/checkMs", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })

  const { exitCode } = await runCli([repo, "sess-1", "12345"])
  expect(exitCode).toBe(0)

  const lines = readSensorLines(repo)
  expect(lines.length).toBe(1)
  const rec = lines[0]!
  expect(rec.promptCheck).toBe(true)
  expect(rec.spawnTs).toBe(12345)
  expect(rec.accepted).toBe(true)
  expect(rec.rounds).toEqual([])
  expect(rec.sessionID).toBe("sess-1")
  expect(rec.gateExhausted).toBe(false)
  expect(rec.interrupted).toBe(false)
  expect(rec.marker).toBe(false)
  expect(typeof rec.host).toBe("string")
  expect((rec.host as string).length).toBeGreaterThan(0)
  expect(typeof rec.pluginVersion === "string" || rec.pluginVersion === undefined).toBe(true)
  expect("reinject" in rec).toBe(false)
  expect("forced" in rec).toBe(false)
  expect("checkMs" in rec).toBe(false)
})

test("fail variant: exit 1 check -> accepted:false, still exactly one line", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 1" })

  const { exitCode } = await runCli([repo, "sess-2", "22222"])
  expect(exitCode).toBe(0)

  const lines = readSensorLines(repo)
  expect(lines.length).toBe(1)
  expect(lines[0]!.accepted).toBe(false)
  expect(lines[0]!.spawnTs).toBe(22222)
})

test("timeout variant: sleeping check under a tiny checkTimeoutMs -> STILL appends, accepted:false", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "sleep 30", checkTimeoutMs: 300 })

  const { exitCode } = await runCli([repo, "sess-3", "33333"])
  expect(exitCode).toBe(0)

  const lines = readSensorLines(repo)
  expect(lines.length).toBe(1)
  expect(lines[0]!.accepted).toBe(false)
  expect(lines[0]!.promptCheck).toBe(true)
}, 15_000)

test("lock ownership: matching spawnTs lock is removed after the run", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })
  const lp = lockPath(repo)
  fs.mkdirSync(path.dirname(lp), { recursive: true })
  fs.writeFileSync(lp, JSON.stringify({ pid: 1, spawnTs: 44444 }))

  await runCli([repo, "sess-4", "44444"])

  expect(fs.existsSync(lp)).toBe(false)
})

test("lock ownership: foreign lock with a DIFFERENT spawnTs survives the run", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })
  const lp = lockPath(repo)
  fs.mkdirSync(path.dirname(lp), { recursive: true })
  fs.writeFileSync(lp, JSON.stringify({ pid: 1, spawnTs: 99999 }))

  await runCli([repo, "sess-5", "55555"])

  expect(fs.existsSync(lp)).toBe(true)
  const lock = JSON.parse(fs.readFileSync(lp, "utf-8"))
  expect(lock.spawnTs).toBe(99999)
})

test("garbage argv: missing spawnTs -> exit 0, no line", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })

  const { exitCode } = await runCli([repo, "sess-6"])
  expect(exitCode).toBe(0)
  expect(readSensorLines(repo).length).toBe(0)
})

test("garbage argv: non-numeric spawnTs -> exit 0, no line", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })

  const { exitCode } = await runCli([repo, "sess-7", "not-a-number"])
  expect(exitCode).toBe(0)
  expect(readSensorLines(repo).length).toBe(0)
})

test("garbage argv: no args at all -> exit 0, no line, no throw", async () => {
  const repo = mkRepo()
  writeGate(repo, { check: "exit 0" })

  const { exitCode } = await runCli([])
  expect(exitCode).toBe(0)
  expect(readSensorLines(repo).length).toBe(0)
})

test("no gate.json / no check configured -> exit 0, no line, no throw", async () => {
  const repo = mkRepo()

  const { exitCode } = await runCli([repo, "sess-8", "66666"])
  expect(exitCode).toBe(0)
  expect(readSensorLines(repo).length).toBe(0)
})
