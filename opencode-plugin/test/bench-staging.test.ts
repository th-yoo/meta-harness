/**
 * bench-staging.test.ts — staging.ts (P4: runtime Dockerfile staging).
 *
 * Two kinds of ground truth here:
 *  - Pure-parse tests run against the REAL upstream `terminal-bench-2`
 *    checkout's Dockerfiles (skipped cleanly if that checkout is absent —
 *    this suite must never require the clone to exist, mirroring
 *    bench-toml-audit.test.ts's pattern). Expectations are derived from the
 *    COMMITTED, gen_setup_deps.py-generated setup_deps.sh for each task
 *    (cited by path/line below), which is the ground truth of the
 *    *observable behavior* staging.ts must reproduce — NOT always the exact
 *    same shell text (e.g. large-scale-text-editing's raw RUN line is kept
 *    verbatim from the Dockerfile here, whereas the generated script
 *    cosmetically rewrites "/app" to "$WORKDIR"; both resolve to the same
 *    real path since this runner's WORKDIR is always literally /app).
 *  - Everything else (execution order, flag plumbing) is injected/fake —
 *    no podman is ever spawned by this file.
 */
import { test, expect } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { makeBenchPaths } from "../src/bench/paths.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import { parseTaskDockerfile, stageTaskRuntime, type StagingStep } from "../src/bench/staging.ts"
import { buildExecArgv } from "../src/bench/sandbox.ts"
import { cmdOracle, type RunOneOracleTask } from "../src/bench/cmd-oracle.ts"
import { main } from "../src/bench/cli.ts"
import { BenchError } from "../src/bench/util.ts"
import type { ExecResult } from "../src/bench/exec.ts"

const paths = makeBenchPaths()
const tbRootExists = existsSync(paths.tbRoot)

function tmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), "mh-bench-staging-"))
}

function fakeBenchPaths(tbRoot: string): BenchPaths {
  return {
    metaRoot: path.dirname(tbRoot),
    termBenchDir: path.join(path.dirname(tbRoot), "term-bench2"),
    tbRoot,
    resultsDir: path.join(tbRoot, "results-unused"),
    patchesDir: path.join(tbRoot, "patches-unused"),
    baselineTasksFile: path.join(tbRoot, "baseline-unused.txt"),
    splitsFile: path.join(tbRoot, "splits-unused.json"),
  }
}

// ── pure parse: 5 representative tasks against the real checkout ─────────

test.skipIf(!tbRootExists)(
  "terminal-bench-2 checkout found with the 5 representative task Dockerfiles",
  () => {
    for (const t of [
      "adaptive-rejection-sampler",
      "git-multibranch",
      "build-cython-ext",
      "feal-linear-cryptanalysis",
      "large-scale-text-editing",
    ]) {
      expect(existsSync(path.join(paths.tbRoot, t, "environment", "Dockerfile"))).toBe(true)
    }
  },
)

// term-bench2/tasks/adaptive-rejection-sampler/setup_deps.sh:29-31 — a single
// COPY of a *file* (protected.tar.gz.enc) to a dest outside /app
// (/protected/protected.tar.gz.enc); dst has no trailing slash and isn't a
// known-dir path, so this is a file->file copy (mkdir -p the PARENT, not the
// dest itself). EXTRAS_ROOT is dead: the generated script's
// "${EXTRAS_ROOT:-}/protected/..." is now just the real container path.
test.skipIf(!tbRootExists)("parseTaskDockerfile: adaptive-rejection-sampler (COPY outside /app)", () => {
  const staging = parseTaskDockerfile(paths, "adaptive-rejection-sampler")
  expect(staging.baseImage).toBe("ubuntu:24.04")
  expect(staging.envs).toEqual({})
  expect(staging.steps).toEqual([
    {
      kind: "copy",
      src: "protected.tar.gz.enc",
      dst: "/protected/protected.tar.gz.enc",
      srcIsDir: false,
      dirTarget: false,
      contentsOnly: false,
    },
  ])
})

// term-bench2/tasks/git-multibranch/setup_deps.sh:38-45 — apt-get install
// line dropped entirely (informational only; the shared image's package
// union covers it — this port never runs apt). The two non-apt RUN lines
// (openssl self-signed cert generation, mkdir for /var/www) are kept
// VERBATIM as run steps — script's "# RAW:" lines at :44/:46 match exactly
// (git-multibranch/environment/Dockerfile:18-24 is a backslash-continued
// RUN that collapses to one space-joined logical line).
test.skipIf(!tbRootExists)("parseTaskDockerfile: git-multibranch (verbatim RUNs + no ENV)", () => {
  const staging = parseTaskDockerfile(paths, "git-multibranch")
  expect(staging.baseImage).toBe("ubuntu:24.04")
  expect(staging.envs).toEqual({})

  const opensslCmd =
    'mkdir -p /etc/ssl/certs && mkdir -p /etc/ssl/private && openssl req -x509 -nodes -days 365 ' +
    '-subj "/CN=localhost" -newkey rsa:2048 -keyout /etc/ssl/private/nginx-selfsigned.key ' +
    "-out /etc/ssl/certs/nginx-selfsigned.crt"

  expect(staging.steps).toEqual([
    {
      kind: "copy",
      src: "default.conf",
      dst: "/etc/nginx/sites-available/default",
      srcIsDir: false,
      dirTarget: false,
      contentsOnly: false,
    },
    { kind: "run", cmd: opensslCmd },
    { kind: "run", cmd: "mkdir -p /var/www/html /var/www/dev" },
  ])
  // the apt-get install line must not surface as any step at all
  expect(staging.steps.some((s) => (s.cmd ?? "").includes("apt"))).toBe(false)
})

// term-bench2/tasks/build-cython-ext/setup_deps.sh:36-41 — non-ubuntu base
// image (logged, never pulled/built) + a single pip package with its version
// pin preserved verbatim, combined into ONE pip step (no COPY at all).
test.skipIf(!tbRootExists)("parseTaskDockerfile: build-cython-ext (pip + non-ubuntu base image)", () => {
  const staging = parseTaskDockerfile(paths, "build-cython-ext")
  expect(staging.baseImage).toBe("python:3.13-slim-bookworm")
  expect(staging.envs).toEqual({})
  expect(staging.steps).toEqual([{ kind: "pip", packages: ["numpy==2.3.0"] }])
})

// term-bench2/tasks/feal-linear-cryptanalysis/setup_deps.sh:29-49 — a
// directory COPY (task-deps/ -> /app/, contents-copy since both dst ends in
// "/" AND the source is a real directory on disk), one pip package, and
// three verbatim raw RUN steps. The two `RUN rm ...` cleanup lines
// (Dockerfile's final two RUN lines) must NOT surface as steps at all —
// they are dropped exactly like the generated script drops them (absent
// from its raw section).
test.skipIf(!tbRootExists)("parseTaskDockerfile: feal-linear-cryptanalysis (dir COPY + pip + raw runs)", () => {
  const staging = parseTaskDockerfile(paths, "feal-linear-cryptanalysis")
  expect(staging.baseImage).toBe("python:3.13-slim-bookworm")
  expect(staging.envs).toEqual({})
  expect(staging.steps).toEqual([
    { kind: "copy", src: "task-deps/", dst: "/app/", srcIsDir: true, dirTarget: true, contentsOnly: true },
    { kind: "pip", packages: ["setuptools==80.9.0"] },
    { kind: "run", cmd: "gcc -O3 -o feal feal.c" },
    { kind: "run", cmd: "gcc -O3 -o decrypt decrypt.c" },
    { kind: "run", cmd: "python3 gen.py" },
  ])
})

// report.md:5-9 lists "circuit-fibsqrt: apt-get update" and
// "distribution-search: apt-get update" as unhandled RUN lines — a bare
// `apt-get update` (no "install") doesn't match has_apt, so it survives
// classification as a "raw" candidate; the generated script
// (term-bench2/tasks/circuit-fibsqrt/setup_deps.sh:38-40) then wraps it in
// `if [[ -z "$SKIP_APT" ]]; then apt-get update; fi`. Every current caller
// of scripts-mode sets SKIP_APT=1, so that's an observable no-op — this
// port matches it by dropping the step outright (never emitted at all,
// rather than emitted-then-guarded).
test.skipIf(!tbRootExists)("parseTaskDockerfile: circuit-fibsqrt — bare 'apt-get update' RUN drops to a no-op (report.md hard case)", () => {
  const staging = parseTaskDockerfile(paths, "circuit-fibsqrt")
  expect(staging.baseImage).toBe("python:3.13-slim-bookworm")
  // both RUN lines (bare "apt-get update" AND "apt-get install -y gcc") are
  // gone; only the two file COPYs remain as steps
  expect(staging.steps).toEqual([
    { kind: "copy", src: "tests/sim.c", dst: "/app", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "copy", src: "gates.txt", dst: "/app", srcIsDir: false, dirTarget: true, contentsOnly: false },
  ])
  expect(staging.steps.some((s) => (s.cmd ?? "").includes("apt"))).toBe(false)
})

// term-bench2/tasks/large-scale-text-editing/setup_deps.sh:36-44 — apt-get
// install dropped; COPY of a *file* into a directory dest (dst ends in "/"
// but the source itself is a file, so this is "copy the file INTO the dir",
// not a contents-copy); one raw RUN kept VERBATIM from the Dockerfile
// (report.md lists this exact line as one of the 22 hardest verbatim-RUN
// cases) — note the generated script cosmetically rewrites "/app" to
// "$WORKDIR" in its own raw section (both resolve to the same real path
// here, since this runner's WORKDIR is always /app; see this file's header).
test.skipIf(!tbRootExists)("parseTaskDockerfile: large-scale-text-editing (file-into-dir COPY + verbatim RUN)", () => {
  const staging = parseTaskDockerfile(paths, "large-scale-text-editing")
  expect(staging.baseImage).toBe("python:3.13-slim-bookworm")
  expect(staging.envs).toEqual({})
  expect(staging.steps).toEqual([
    { kind: "copy", src: "gen_large_csv.py", dst: "/app/", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "run", cmd: "python3 /app/gen_large_csv.py both && rm /app/gen_large_csv.py" },
  ])
})

// ── broad sweep: every task dir with environment/Dockerfile must parse ───

test.skipIf(!tbRootExists)("parseTaskDockerfile: sweep — every upstream task Dockerfile parses without throwing", () => {
  // Empirically discovered exotic allowlist: NONE. Every task Dockerfile in
  // the real 89-task terminal-bench-2 checkout — including
  // financial-document-processor's genuinely multi-stage (2x FROM) build
  // with a `COPY --from=build ...` referencing a named stage — parses
  // cleanly under this port's rules (see staging.ts's module header for why
  // COPY --from=<anything> is always a safe no-op here, not a throw).
  const EXOTIC_ALLOWLIST = new Set<string>([])

  const taskDirs = readdirSync(paths.tbRoot, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(path.join(paths.tbRoot, e.name, "environment", "Dockerfile")))
    .map((e) => e.name)
    .sort()

  expect(taskDirs.length).toBeGreaterThan(80) // sanity: this really ran against the full corpus

  const failures: string[] = []
  for (const task of taskDirs) {
    if (EXOTIC_ALLOWLIST.has(task)) continue
    try {
      parseTaskDockerfile(paths, task)
    } catch (e) {
      failures.push(`${task}: ${(e as Error).message}`)
    }
  }
  expect(failures).toEqual([])
})

test.skipIf(!tbRootExists)("parseTaskDockerfile: financial-document-processor's multi-stage Dockerfile doesn't throw", () => {
  // Two FROM stages + a `COPY --from=build /app/documents /app/documents`
  // referencing a named build stage (not uv) — the generator silently drops
  // any non-uv --from copy (see gen_setup_deps.py's COPY branch), and this
  // port matches that: skip entirely, never throw.
  expect(() => parseTaskDockerfile(paths, "financial-document-processor")).not.toThrow()
  const staging = parseTaskDockerfile(paths, "financial-document-processor")
  expect(staging.baseImage).toBe("ubuntu:24.04") // first FROM only
  expect(staging.steps.some((s) => s.kind === "copy" && s.dst === "/app/documents")).toBe(false)
})

// ── parseTaskDockerfile: fail-loud on an unclassifiable directive ─────────

test("parseTaskDockerfile: unclassifiable Dockerfile keyword throws BenchError naming it", () => {
  const dir = tmpDir()
  const task = "weird-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nSOMETHING_EXOTIC foo bar\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  expect(() => parseTaskDockerfile(fakePaths, task)).toThrow(BenchError)
  try {
    parseTaskDockerfile(fakePaths, task)
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toContain("SOMETHING_EXOTIC")
  }
})

test("parseTaskDockerfile: WORKDIR/ARG/CMD/ENTRYPOINT are ignored, not classified as exotic", () => {
  const dir = tmpDir()
  const task = "ignorable-directives"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nARG X=1\nWORKDIR /somewhere-else\nEXPOSE 8080\nCMD [\"true\"]\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.baseImage).toBe("ubuntu:24.04")
  expect(staging.steps).toEqual([])
})

// ── ENV: accumulation, later-wins, and the ${VAR:-} guard on execution ────

test("parseTaskDockerfile: ENV accumulates in a flat map, later key wins", () => {
  const dir = tmpDir()
  const task = "env-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nENV FOO=bar\nENV FOO=baz\nENV PYTHONPATH=/app:$PYTHONPATH\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.envs).toEqual({ FOO: "baz", PYTHONPATH: "/app:$PYTHONPATH" })
  expect(staging.steps).toEqual([
    { kind: "env", key: "FOO", value: "bar" },
    { kind: "env", key: "FOO", value: "baz" },
    { kind: "env", key: "PYTHONPATH", value: "/app:$PYTHONPATH" },
  ])
})

// ── stageTaskRuntime: execution order, via an injected fake exec ─────────

test("stageTaskRuntime: executes copy -> pip -> run in that fixed phase order, one podman exec per step", async () => {
  const dir = tmpDir()
  const task = "order-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  mkdirSync(path.join(dir, task, "environment", "adir"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "adir", "f.txt"), "x")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM ubuntu:24.04",
      "ENV FOO=bar",
      "RUN echo first-raw",
      "RUN pip install somepkg",
      "COPY adir/ /app/",
      "RUN echo second-raw",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)

  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // one exec call per non-env step, in fixed phase order: copy, then the
  // ONE combined pip step, then each raw run (its own step, in Dockerfile
  // encounter order) — env is folded into every script's export prelude,
  // never its own exec call.
  expect(recordedArgvs.length).toBe(4)
  for (const argv of recordedArgvs) {
    expect(argv[0]).toBe("podman")
    expect(argv).toContain("container-1")
  }

  const scripts = recordedArgvs.map((argv) => argv[argv.length - 1]!)
  // step 1: the COPY
  expect(scripts[0]).toContain('export FOO="bar"')
  expect(scripts[0]).toContain("mkdir -p")
  expect(scripts[0]).toContain(`/tb/${task}/environment/adir/.`)
  expect(scripts[0]).toContain('"/app/"')
  // step 2: the combined pip install
  expect(scripts[1]).toContain('export FOO="bar"')
  expect(scripts[1]).toContain("uv pip install")
  expect(scripts[1]).toContain('"somepkg"')
  // steps 3-4: the two raw runs, each its OWN step, in Dockerfile order
  expect(scripts[2]).toContain('export FOO="bar"')
  expect(scripts[2]).toContain("echo first-raw")
  expect(scripts[2]).not.toContain("echo second-raw")
  expect(scripts[3]).toContain('export FOO="bar"')
  expect(scripts[3]).toContain("echo second-raw")
  expect(scripts[3]).not.toContain("echo first-raw")

  // every exec uses the same argv shape as sandbox.ts's buildExecArgv
  expect(recordedArgvs[0]).toEqual(buildExecArgv("container-1", ["bash", "-c", scripts[0]!]))
})

test("stageTaskRuntime: a nonzero step exit throws BenchError naming the step", async () => {
  const dir = tmpDir()
  const task = "fail-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN exit-with-failure\n")
  const fakePaths = fakeBenchPaths(dir)

  const fakeExec = async (): Promise<ExecResult> => ({ rc: 1, stdout: "", stderr: "boom", timedOut: false })

  await expect(stageTaskRuntime(fakePaths, "container-1", task, fakeExec)).rejects.toThrow(BenchError)
  try {
    await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toContain(task)
    expect((e as BenchError).message).toContain("exit-with-failure")
    expect((e as BenchError).message).toContain("boom")
  }
})

test("stageTaskRuntime: no podman spawned when execFn is injected (never touches real exec.ts's podman)", async () => {
  const dir = tmpDir()
  const task = "noop-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\n")
  const fakePaths = fakeBenchPaths(dir)
  let calls = 0
  await stageTaskRuntime(fakePaths, "c1", task, async () => {
    calls++
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  })
  expect(calls).toBe(0) // no steps at all for a bare FROM-only Dockerfile
})

// ── flag plumbing: --staging scripts still routes to the old path ────────

function fakePathsWithTask(task: string): BenchPaths {
  const dir = tmpDir()
  const tbRoot = path.join(dir, "tb-root")
  mkdirSync(path.join(tbRoot, task), { recursive: true })
  writeFileSync(path.join(tbRoot, task, "task.toml"), "")
  return fakeBenchPaths(tbRoot)
}

test("cmdOracle: --staging scripts is threaded to runOneTask (3rd arg)", async () => {
  const seen: (string | undefined)[] = []
  const fake: RunOneOracleTask = async (_paths, _task, staging) => {
    seen.push(staging)
    return { reward: 1, elapsed: 1.0, error: "" }
  }
  await cmdOracle(fakePathsWithTask("whatever"), { tasks: ["whatever"], staging: "scripts" }, fake)
  expect(seen).toEqual(["scripts"])
})

test("cmdOracle: staging defaults to runtime when --staging is omitted", async () => {
  const seen: (string | undefined)[] = []
  const fake: RunOneOracleTask = async (_paths, _task, staging) => {
    seen.push(staging)
    return { reward: 1, elapsed: 1.0, error: "" }
  }
  await cmdOracle(fakePathsWithTask("whatever"), { tasks: ["whatever"] }, fake)
  expect(seen).toEqual(["runtime"])
})

test("cli main: --staging scripts parses and is accepted (rc not 2)", async () => {
  // Uses the real makeBenchPaths()'s tbRoot; "whatever" is not a real task,
  // so this exercises argv parsing only (rc 1 from the unknown-task die is
  // fine — the point is it's NOT rc 2, i.e. --staging parsed successfully).
  const rc = await main(["oracle", "--tasks", "whatever", "--staging", "scripts"])
  expect(rc).not.toBe(2)
})

test("cli main: --staging with an invalid value is a usage error (rc 2)", async () => {
  const rc = await main(["oracle", "--tasks", "whatever", "--staging", "bogus"])
  expect(rc).toBe(2)
})

test("cli main: --staging with no value is a usage error (rc 2)", async () => {
  const rc = await main(["oracle", "--staging"])
  expect(rc).toBe(2)
})
