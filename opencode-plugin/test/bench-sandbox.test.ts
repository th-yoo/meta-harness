import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  makeBenchPaths,
  containerName,
  BENCH_IMAGE,
} from "../src/bench/paths.ts"
import {
  buildCreateArgv,
  buildStartArgv,
  buildExecArgv,
  buildCpToArgv,
  buildCpFromArgv,
  buildRmArgv,
  buildImageBuildArgv,
  type SandboxSpec,
} from "../src/bench/sandbox.ts"
import { BenchError, die, writeJsonAtomic } from "../src/bench/util.ts"

// ── paths ──────────────────────────────────────────────────────────────────

test("makeBenchPaths resolves metaRoot to the actual repo root", () => {
  const p = makeBenchPaths()
  expect(fs.existsSync(path.join(p.metaRoot, "term-bench2"))).toBe(true)
  expect(fs.existsSync(path.join(p.metaRoot, ".git"))).toBe(true)
  expect(p.termBenchDir).toBe(path.join(p.metaRoot, "term-bench2"))
  expect(p.termBenchDir.endsWith("term-bench2")).toBe(true)
  expect(p.resultsDir).toBe(path.join(p.termBenchDir, "results"))
  expect(p.patchesDir).toBe(path.join(p.termBenchDir, "patches"))
  expect(p.splitsFile).toBe(path.join(p.termBenchDir, "splits.json"))
  expect(p.baselineTasksFile).toBe(path.join(p.termBenchDir, "baseline-tasks.txt"))
})

test("makeBenchPaths defaults tbRoot to sibling terminal-bench-2", () => {
  const p = makeBenchPaths()
  expect(p.tbRoot).toBe(path.join(path.dirname(p.metaRoot), "terminal-bench-2"))
})

test("makeBenchPaths --tb-root override wins over the sibling default", () => {
  const override = "/some/other/tb-root"
  const p = makeBenchPaths({ tbRoot: override })
  expect(p.tbRoot).toBe(override)
})

test("BENCH_IMAGE is the expected localhost tag", () => {
  expect(BENCH_IMAGE).toBe("localhost/mh-bench:latest")
})

// ── containerName ─────────────────────────────────────────────────────────

test("containerName matches podman name rules", () => {
  const name = containerName("hello-world")
  expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
})

test("containerName embeds the task name", () => {
  const name = containerName("hello-world", "candidate-v4")
  expect(name).toContain("hello-world")
  expect(name).toContain("candidate-v4")
  expect(name.startsWith("mh-")).toBe(true)
})

test("containerName defaults the tag segment to 'run' when omitted", () => {
  const name = containerName("hello-world")
  expect(name).toContain("-run-")
})

test("containerName: two calls differ (uniqueness)", () => {
  const a = containerName("hello-world")
  const b = containerName("hello-world")
  expect(a).not.toBe(b)
})

test("containerName truncates a 60-char task to 40 chars", () => {
  const longTask = "a".repeat(60)
  const name = containerName(longTask)
  expect(name).toContain("a".repeat(40))
  expect(name).not.toContain("a".repeat(41))
  expect(name).toMatch(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/)
})

// ── sandbox argv builders ──────────────────────────────────────────────────

test("buildCreateArgv: representative spec with ro+rw mounts, env, network true", () => {
  const spec: SandboxSpec = {
    image: "localhost/mh-bench:latest",
    name: "mh-hello-run-123-abcd",
    mounts: [
      { host: "/host/tasks/hello", container: "/app", ro: false },
      { host: "/host/tb-root", container: "/tb-root", ro: true },
    ],
    env: { TB_ROOT: "/tb-root", SKIP_APT: "1" },
    workdir: "/app",
    network: true,
  }
  expect(buildCreateArgv(spec)).toEqual([
    "podman", "create", "--name", "mh-hello-run-123-abcd", "--init",
    "-v", "/host/tasks/hello:/app",
    "-v", "/host/tb-root:/tb-root:ro",
    "-e", "TB_ROOT=/tb-root",
    "-e", "SKIP_APT=1",
    "-w", "/app",
    "localhost/mh-bench:latest",
    "sleep", "infinity",
  ])
})

test("buildCreateArgv: network false adds --network none", () => {
  const spec: SandboxSpec = { image: "img", name: "n1", network: false }
  expect(buildCreateArgv(spec)).toEqual([
    "podman", "create", "--name", "n1", "--init",
    "--network", "none",
    "-w", "/app",
    "img",
    "sleep", "infinity",
  ])
})

test("buildCreateArgv: defaults (no mounts/env, network true, workdir /app)", () => {
  const spec: SandboxSpec = { image: "img", name: "n1" }
  expect(buildCreateArgv(spec)).toEqual([
    "podman", "create", "--name", "n1", "--init",
    "-w", "/app",
    "img",
    "sleep", "infinity",
  ])
})

test("buildStartArgv", () => {
  expect(buildStartArgv("mh-hello-run-123-abcd")).toEqual(["podman", "start", "mh-hello-run-123-abcd"])
})

test("buildExecArgv: no env/workdir defaults to -w /app", () => {
  expect(buildExecArgv("n1", ["bash", "solve.sh"])).toEqual([
    "podman", "exec", "-w", "/app", "n1", "bash", "solve.sh",
  ])
})

test("buildExecArgv: with env and workdir", () => {
  expect(
    buildExecArgv("n1", ["bash", "test.sh"], { env: { FOO: "bar" }, workdir: "/tests" }),
  ).toEqual(["podman", "exec", "-e", "FOO=bar", "-w", "/tests", "n1", "bash", "test.sh"])
})

test("buildCpToArgv", () => {
  expect(buildCpToArgv("n1", "/host/file.txt", "/app/file.txt")).toEqual([
    "podman", "cp", "/host/file.txt", "n1:/app/file.txt",
  ])
})

test("buildCpFromArgv", () => {
  expect(buildCpFromArgv("n1", "/app/reward.txt", "/host/reward.txt")).toEqual([
    "podman", "cp", "n1:/app/reward.txt", "/host/reward.txt",
  ])
})

test("buildRmArgv: force + zero timeout", () => {
  expect(buildRmArgv("n1")).toEqual(["podman", "rm", "-f", "-t", "0", "n1"])
})

test("buildImageBuildArgv", () => {
  expect(buildImageBuildArgv("term-bench2/Containerfile", "term-bench2", "localhost/mh-bench:latest")).toEqual([
    "podman", "build", "-f", "term-bench2/Containerfile", "-t", "localhost/mh-bench:latest", "term-bench2",
  ])
})

// ── writeJsonAtomic ─────────────────────────────────────────────────────────

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-write-json-"))
}

test("writeJsonAtomic writes parseable JSON matching Python's 2-indent + trailing newline format", () => {
  const dir = tmpDir()
  const file = path.join(dir, "out.json")
  const data = { a: 1, b: { c: 2 } }
  writeJsonAtomic(file, data)
  const text = fs.readFileSync(file, "utf-8")
  expect(text).toBe(JSON.stringify(data, null, 2) + "\n")
  expect(JSON.parse(text)).toEqual(data)
})

test("writeJsonAtomic leaves no *.tmp sibling", () => {
  const dir = tmpDir()
  const file = path.join(dir, "out.json")
  writeJsonAtomic(file, { x: 1 })
  const entries = fs.readdirSync(dir)
  expect(entries).toEqual(["out.json"])
})

test("writeJsonAtomic creates parent dirs", () => {
  const dir = tmpDir()
  const file = path.join(dir, "nested", "deep", "out.json")
  writeJsonAtomic(file, { ok: true })
  expect(fs.existsSync(file)).toBe(true)
  expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ ok: true })
})

test("writeJsonAtomic atomically replaces an existing file", () => {
  const dir = tmpDir()
  const file = path.join(dir, "out.json")
  writeJsonAtomic(file, { v: 1 })
  writeJsonAtomic(file, { v: 2 })
  expect(JSON.parse(fs.readFileSync(file, "utf-8"))).toEqual({ v: 2 })
  expect(fs.readdirSync(dir)).toEqual(["out.json"])
})

// ── BenchError / die ─────────────────────────────────────────────────────────

test("die throws a BenchError with the given message", () => {
  expect(() => die("boom")).toThrow(BenchError)
  try {
    die("boom")
    throw new Error("unreachable")
  } catch (e) {
    expect(e).toBeInstanceOf(BenchError)
    expect((e as BenchError).message).toBe("boom")
  }
})

test("BenchError is an Error subclass", () => {
  const e = new BenchError("x")
  expect(e).toBeInstanceOf(Error)
  expect(e).toBeInstanceOf(BenchError)
})
