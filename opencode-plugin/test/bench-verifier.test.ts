/**
 * bench-verifier.test.ts — verifier.ts's copyTests (env-fidelity fix:
 * docs/env-fidelity-spotcheck.md). copyTests used to `podman exec cp -r`
 * against a persistent, read-only /tb + /mh mount; it now uses `podman cp`
 * straight from the host filesystem, with no mount involved at all — see
 * verifier.ts's module header. These tests inject a fake execFn and never
 * spawn real podman.
 */
import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import type { BenchPaths } from "../src/bench/paths.ts"
import { copyTests, runVerifier } from "../src/bench/verifier.ts"
import { buildExecArgv, buildCpToArgv } from "../src/bench/sandbox.ts"
import { BenchError } from "../src/bench/util.ts"
import type { ExecResult } from "../src/bench/exec.ts"

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "mh-bench-verifier-"))
}

function fakeBenchPaths(termBenchDir: string, tbRoot?: string): BenchPaths {
  return {
    metaRoot: path.dirname(termBenchDir),
    termBenchDir,
    tbRoot: tbRoot ?? path.join(termBenchDir, "tb-root-unused"),
    resultsDir: path.join(termBenchDir, "results"),
    patchesDir: path.join(termBenchDir, "patches"),
    baselineTasksFile: path.join(termBenchDir, "baseline-tasks.txt"),
    splitsFile: path.join(termBenchDir, "splits.json"),
  }
}

test("copyTests: removes /tests, then podman cp's <tbRoot>/<task>/tests -> /tests (no /tb mount involved)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await copyTests(paths, "container-1", "sometask", execFn)

  // no patches dir on disk -> exactly 3 calls: rm -rf /tests, podman cp
  // tests/, the __pycache__/*.pyc cleanup exec.
  expect(recordedArgvs.length).toBe(3)
  expect(recordedArgvs[0]).toEqual(buildExecArgv("container-1", ["rm", "-rf", "/tests"]))
  expect(recordedArgvs[1]).toEqual(
    buildCpToArgv("container-1", path.join(tbRoot, "sometask", "tests"), "/tests"),
  )
  expect(recordedArgvs[2]![0]).toBe("podman")
  const cleanupScript = recordedArgvs[2]![recordedArgvs[2]!.length - 1]!
  expect(cleanupScript).toContain("__pycache__")
  expect(cleanupScript).toContain("*.pyc")
})

test("copyTests: overlays patches/<task>/ via podman cp with a trailing '/.' source (merges into /tests, doesn't nest)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)
  const patchDir = path.join(paths.patchesDir, "sometask")
  fs.mkdirSync(patchDir, { recursive: true })
  fs.writeFileSync(path.join(patchDir, "test_override.py"), "# patched")

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await copyTests(paths, "container-1", "sometask", execFn)

  // rm, cp(tests), pycache-cleanup, cp(patches) — the patch overlay is the
  // LAST call, after the tests copy has landed.
  expect(recordedArgvs.length).toBe(4)
  const patchCpArgv = recordedArgvs[3]!
  expect(patchCpArgv).toEqual(buildCpToArgv("container-1", `${patchDir}/.`, "/tests"))
  // trailing-`/.` built via string concatenation, not path.join (which would
  // normalize the dot away) — assert the literal argv content directly.
  expect(patchCpArgv[2]).toBe(`${patchDir}/.`)
  expect(patchCpArgv[2]!.endsWith("/.")).toBe(true)
})

test("copyTests: no patches dir on disk -> no patch-overlay cp call at all", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)
  // deliberately do NOT create paths.patchesDir/sometask

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await copyTests(paths, "container-1", "sometask", execFn)

  expect(recordedArgvs.length).toBe(3) // rm, cp(tests), pycache-cleanup — no 4th cp
  expect(recordedArgvs.every((a) => a[1] !== "cp" || a[2] !== `${path.join(paths.patchesDir, "sometask")}/.`)).toBe(true)
})

// ── rc checks: a transient copy failure must NOT silently degrade to
// "no test.sh -> reward=0" (indistinguishable from a genuine task fail —
// corrupted scoring signal). Mirrors stageTaskRuntime's rc-check + BenchError
// pattern: the /tests reset, the tests cp, and the patches-overlay cp all
// throw a distinguishable BenchError on nonzero exit; ONLY the pycache
// cleanup stays best-effort (its failure cannot lose test content).

test("copyTests: a failing tests podman cp THROWS BenchError naming the step (not silent reward-0 degradation)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)

  const execFn = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "cp"
      ? { rc: 125, stdout: "", stderr: "cp boom", timedOut: false }
      : { rc: 0, stdout: "", stderr: "", timedOut: false }

  await expect(copyTests(paths, "container-1", "sometask", execFn)).rejects.toThrow(BenchError)
  try {
    await copyTests(paths, "container-1", "sometask", execFn)
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toContain("copyTests(sometask)")
    expect((e as BenchError).message).toContain("tests")
    expect((e as BenchError).message).toContain("cp boom")
  }
})

test("copyTests: a failing `rm -rf /tests` reset THROWS BenchError (stale tests must never be scored)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)

  const execFn = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "exec" && argv.includes("rm")
      ? { rc: 1, stdout: "", stderr: "rm boom", timedOut: false }
      : { rc: 0, stdout: "", stderr: "", timedOut: false }

  await expect(copyTests(paths, "container-1", "sometask", execFn)).rejects.toThrow(BenchError)
})

test("copyTests: a failing patches-overlay podman cp THROWS BenchError (a silently-unpatched test suite must not score)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)
  const patchDir = path.join(paths.patchesDir, "sometask")
  fs.mkdirSync(patchDir, { recursive: true })
  fs.writeFileSync(path.join(patchDir, "test_override.py"), "# patched")

  const execFn = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "cp" && argv[2] === `${patchDir}/.`
      ? { rc: 125, stdout: "", stderr: "patch cp boom", timedOut: false }
      : { rc: 0, stdout: "", stderr: "", timedOut: false }

  await expect(copyTests(paths, "container-1", "sometask", execFn)).rejects.toThrow(BenchError)
  try {
    await copyTests(paths, "container-1", "sometask", execFn)
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toContain("copyTests(sometask)")
    expect((e as BenchError).message).toContain("patch")
    expect((e as BenchError).message).toContain("patch cp boom")
  }
})

test("copyTests: a failing pycache-cleanup exec is NON-FATAL (best-effort — cannot lose test content)", async () => {
  const dir = tmpDir()
  const termBenchDir = path.join(dir, "tb")
  const tbRoot = path.join(dir, "tb-root")
  const paths = fakeBenchPaths(termBenchDir, tbRoot)
  const patchDir = path.join(paths.patchesDir, "sometask")
  fs.mkdirSync(patchDir, { recursive: true })
  fs.writeFileSync(path.join(patchDir, "test_override.py"), "# patched")

  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    // only the pycache-cleanup bash -c exec fails; rm reset, tests cp, and
    // patches cp all succeed.
    if (argv[1] === "exec" && argv.some((a) => a.includes("__pycache__"))) {
      return { rc: 1, stdout: "", stderr: "find boom", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await expect(copyTests(paths, "container-1", "sometask", execFn)).resolves.toBeUndefined()
  // execution continued past the failing cleanup: the patches overlay cp
  // (the LAST call) still ran.
  expect(recordedArgvs[recordedArgvs.length - 1]).toEqual(
    buildCpToArgv("container-1", `${patchDir}/.`, "/tests"),
  )
})

test("copyTests: execFn defaults to the real exec.ts podman funnel when omitted (signature-level check, never invoked here)", () => {
  // copyTests(paths, name, task) with no 4th arg must still type-check and
  // resolve to a callable function — this is a compile-time/shape guard, not
  // a runtime exercise (calling it for real would spawn actual podman).
  expect(typeof copyTests).toBe("function")
  expect(copyTests.length).toBeLessThanOrEqual(4)
})

// ── runVerifier workdir (2026-08-12 prove-plus-comm fix): the test.sh exec
// must run from the task Dockerfile's WORKDIR, not a hardcoded /app —
// relative-path graders (os.path.exists("plus_comm.v")) look in the cwd.

test("runVerifier: execs test.sh with the given workdir", async () => {
  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    if (argv.includes("cat")) return { rc: 0, stdout: "1", stderr: "", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const reward = await runVerifier(fakeBenchPaths(tmpDir()), "cname", "t", 30, execFn, "/workspace")
  expect(reward).toBe(1)
  const testShExec = recordedArgvs.find((a) => a.includes("bash") && a.some((x) => x.includes("test.sh")))!
  expect(testShExec).toBeTruthy()
  const wIdx = testShExec.indexOf("-w")
  expect(wIdx).toBeGreaterThan(-1)
  expect(testShExec[wIdx + 1]).toBe("/workspace")
})

test("runVerifier: workdir omitted → /app (byte-identical default)", async () => {
  const recordedArgvs: string[][] = []
  const execFn = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    if (argv.includes("cat")) return { rc: 0, stdout: "1", stderr: "", timedOut: false }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await runVerifier(fakeBenchPaths(tmpDir()), "cname", "t", 30, execFn)
  const testShExec = recordedArgvs.find((a) => a.includes("bash") && a.some((x) => x.includes("test.sh")))!
  const wIdx = testShExec.indexOf("-w")
  expect(testShExec[wIdx + 1]).toBe("/app")
})
