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
import { copyTests } from "../src/bench/verifier.ts"
import { buildExecArgv, buildCpToArgv } from "../src/bench/sandbox.ts"
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

test("copyTests: execFn defaults to the real exec.ts podman funnel when omitted (signature-level check, never invoked here)", () => {
  // copyTests(paths, name, task) with no 4th arg must still type-check and
  // resolve to a callable function — this is a compile-time/shape guard, not
  // a runtime exercise (calling it for real would spawn actual podman).
  expect(typeof copyTests).toBe("function")
  expect(copyTests.length).toBeLessThanOrEqual(4)
})
