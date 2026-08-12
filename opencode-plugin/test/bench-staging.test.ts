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
import { test, expect, spyOn } from "bun:test"
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { makeBenchPaths } from "../src/bench/paths.ts"
import type { BenchPaths } from "../src/bench/paths.ts"
import { parseTaskDockerfile, stageTaskRuntime, execNetStep, taskWorkdir, STAGING_MAX_ATTEMPTS, type StagingStep } from "../src/bench/staging.ts"
import { buildExecArgv, buildCpToArgv } from "../src/bench/sandbox.ts"
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

// Env-fidelity fix: every stageTaskRuntime call now brackets its step execs
// with a `podman cp <tbRoot>/<task>/environment -> /.mh-stage` FIRST call and
// a `rm -rf /.mh-stage` LAST call (see staging.ts's module header / STAGE_DIR).
// Asserts both bracket calls and returns the MIDDLE (actual staging step)
// argvs, so existing per-step assertions below can index into them unchanged.
function expectStageBracketAndUnwrap(recordedArgvs: string[][], containerName: string, fakePaths: BenchPaths, task: string): string[][] {
  expect(recordedArgvs.length).toBeGreaterThanOrEqual(2)
  expect(recordedArgvs[0]).toEqual(
    buildCpToArgv(containerName, path.join(fakePaths.tbRoot, task, "environment"), "/.mh-stage"),
  )
  expect(recordedArgvs[recordedArgvs.length - 1]).toEqual(buildExecArgv(containerName, ["rm", "-rf", "/.mh-stage"]))
  return recordedArgvs.slice(1, -1)
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
  // the apt-get install line must not surface as any step at all — it's
  // extracted into aptPackages instead (Option A), installed as its own
  // first exec, not part of the `steps` pipeline.
  expect(staging.steps.some((s) => (s.cmd ?? "").includes("apt"))).toBe(false)
  // manifest.json's git-multibranch "apt" field (sorted+deduped) is the
  // ground truth this extraction must match exactly.
  expect(staging.aptPackages).toEqual([
    "ca-certificates", "curl", "git", "net-tools", "nginx", "openssh-server", "openssl", "python3", "python3-pip",
  ])
})

// term-bench2/tasks/build-cython-ext/setup_deps.sh:36-41 — non-ubuntu base
// image (logged, never pulled/built) + a single pip package with its version
// pin preserved verbatim, combined into ONE pip step (no COPY at all).
test.skipIf(!tbRootExists)("parseTaskDockerfile: build-cython-ext (pip + non-ubuntu base image)", () => {
  const staging = parseTaskDockerfile(paths, "build-cython-ext")
  expect(staging.baseImage).toBe("python:3.13-slim-bookworm")
  expect(staging.envs).toEqual({})
  expect(staging.steps).toEqual([{ kind: "pip", packages: ["numpy==2.3.0"] }])
  // manifest.json: "build-cython-ext": {"apt": ["build-essential", "git", "libgl1"], ...}
  // — also exercises the Ubuntu 24.04 rename table (libgl1-mesa-glx -> libgl1).
  expect(staging.aptPackages).toEqual(["build-essential", "git", "libgl1"])
})

// term-bench2/tasks/build-pmars/environment/Dockerfile:5 — a single combined
// `apt-get update && apt-get install -y tmux asciinema` line; not in the
// Gate-B 43-task baseline but a clean, real second apt-extraction vector
// (manifest.json: "build-pmars": {"apt": ["asciinema", "tmux"], ...}).
test.skipIf(!tbRootExists)("parseTaskDockerfile: build-pmars (apt extraction — simple package list)", () => {
  const staging = parseTaskDockerfile(paths, "build-pmars")
  expect(staging.baseImage).toBe("debian:13.0-slim")
  expect(staging.aptPackages).toEqual(["asciinema", "tmux"])
})

// term-bench2/tasks/feal-linear-cryptanalysis/setup_deps.sh:29-49 — a
// directory COPY (task-deps/ -> /app/, contents-copy since both dst ends in
// "/" AND the source is a real directory on disk), one pip package, and
// three verbatim raw RUN steps. The Dockerfile's final two RUN lines (`RUN rm
// orig_plaintexts.txt` / `RUN rm gen.py`) are file-deleting cleanup lines —
// env-fidelity fix (docs/env-fidelity-spotcheck.md): these now surface as
// their own best-effort "run" steps (EXECUTED, not dropped) rather than being
// discarded the way gen_setup_deps.py's generator drops them.
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
    { kind: "run", cmd: "rm orig_plaintexts.txt", bestEffort: true },
    { kind: "run", cmd: "rm gen.py", bestEffort: true },
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
  // the bare "apt-get update" (no install) contributes nothing; the second
  // RUN ("apt-get install -y gcc") is the only source of aptPackages —
  // matches manifest.json's "circuit-fibsqrt": {"apt": ["gcc"], ...}.
  expect(staging.aptPackages).toEqual(["gcc"])
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

test("parseTaskDockerfile: CMD/ENTRYPOINT/EXPOSE are ignored, not classified as exotic (WORKDIR/ARG are now honored — see A1/A2 tests)", () => {
  const dir = tmpDir()
  const task = "ignorable-directives"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    'FROM ubuntu:24.04\nWORKDIR /somewhere-else\nEXPOSE 8080\nCMD ["true"]\n',
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.baseImage).toBe("ubuntu:24.04")
  // WORKDIR itself never emits a step (it just updates the tracked cwd for
  // subsequent run/copy steps — see A2 tests); with no RUN/COPY after it and
  // no ARG at all, there is nothing left to emit.
  expect(staging.steps).toEqual([])
})

// ── A1: ARG-with-default -> prelude env (bn-fit-modify) ──────────────────
// bn-fit-modify/environment/Dockerfile: `ARG BN_URL=https://...` followed by
// `RUN curl -fsSL "${BN_URL}" -o bn_sample_10k.csv` — Docker makes a
// build-time ARG's default available to subsequent RUN steps exactly like
// ENV. Without this, `${BN_URL}` is unbound under `set -u` and the RUN trips
// `bash: line 2: BN_URL: unbound variable`.

test("parseTaskDockerfile: ARG NAME=default is exported like ENV; bare ARG NAME (no default) is NOT", () => {
  const dir = tmpDir()
  const task = "arg-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nARG X=y\nARG Z\nRUN echo $X\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  // X (has a default) accumulates into envs exactly like ENV would; bare Z
  // (no default — would be build-arg-supplied, and none of our tasks pass
  // build args) contributes nothing.
  expect(staging.envs).toEqual({ X: "y" })
  expect(staging.steps).toEqual([
    { kind: "env", key: "X", value: "y" },
    { kind: "run", cmd: "echo $X" },
  ])
})

test("stageTaskRuntime: ARG-with-default's export lands in the RUN step's prelude (bn-fit-modify shape)", async () => {
  const dir = tmpDir()
  const task = "arg-prelude-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    'FROM ubuntu:24.04\nWORKDIR /app\nARG BN_URL=https://example.com/x.csv\nRUN curl -fsSL "${BN_URL}" -o x.csv\n',
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(1)
  const script = steps[0]![steps[0]!.length - 1]!
  expect(script).toContain('export BN_URL="https://example.com/x.csv"')
  expect(script).toContain('curl -fsSL "${BN_URL}" -o x.csv')
})

// ── A2: WORKDIR as persistent cwd (crack-7z-hash) ─────────────────────────
// crack-7z-hash/environment/Dockerfile: `WORKDIR /app/john/src` then
// `RUN ./configure --without-openssl && make` must run in /app/john/src, not
// /app — Docker semantics: WORKDIR persists for all subsequent RUN/COPY-dest
// until changed; relative WORKDIR is relative to the previous one.

test("parseTaskDockerfile: WORKDIR sets cwd on subsequent RUN steps", () => {
  const dir = tmpDir()
  const task = "workdir-run-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /a/b\nRUN ./configure\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([{ kind: "run", cmd: "./configure", cwd: "/a/b" }])
})

test("parseTaskDockerfile: two WORKDIRs (absolute then relative) compose", () => {
  const dir = tmpDir()
  const task = "workdir-compose-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /a/b\nWORKDIR c\nRUN make\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([{ kind: "run", cmd: "make", cwd: "/a/b/c" }])
})

test("parseTaskDockerfile: WORKDIR then COPY x . lands under the workdir", () => {
  const dir = tmpDir()
  const task = "workdir-copy-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "x"), "data")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /a/b\nCOPY x .\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([
    { kind: "copy", src: "x", dst: "/a/b/", srcIsDir: false, dirTarget: true, contentsOnly: false },
  ])
})

test("parseTaskDockerfile: WORKDIR resets back after a later absolute WORKDIR (crack-7z-hash shape: /app/john/src then /app)", () => {
  const dir = tmpDir()
  const task = "workdir-reset-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "x"), "data")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /app/john/src\nRUN ./configure && make\nWORKDIR /app\nCOPY x .\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  // fixed phase order (copy before run — see module header), NOT Dockerfile
  // source order; the point under test is that the RUN step still carries
  // the earlier /app/john/src cwd while the COPY resolves against the later
  // (reset-back) /app cwd.
  expect(staging.steps).toEqual([
    { kind: "copy", src: "x", dst: "/app/", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "run", cmd: "./configure && make", cwd: "/app/john/src" },
  ])
})

test("stageTaskRuntime: a non-default cwd RUN step mkdir -p's and cd's into the workdir before the command", async () => {
  const dir = tmpDir()
  const task = "workdir-exec-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /app/john/src\nRUN ./configure\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(1)
  const script = steps[0]![steps[0]!.length - 1]!
  expect(script).toContain('mkdir -p "/app/john/src"')
  expect(script).toContain('cd "/app/john/src"')
  expect(script).toContain("./configure")
})

test("stageTaskRuntime: default cwd (/app, no WORKDIR) emits no extra mkdir/cd wrapper (unchanged behavior)", async () => {
  const dir = tmpDir()
  const task = "workdir-default-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN echo hi\n")
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  const script = steps[0]![steps[0]!.length - 1]!
  expect(script).not.toContain("mkdir -p")
  expect(script).not.toContain("cd \"")
})

// ── A3: multi-source COPY (build-pmars) ───────────────────────────────────
// build-pmars/environment/Dockerfile: `COPY warriors/flashpaper.red
// warriors/rave.red /app/` — a genuine 2-source COPY into a directory dest.
// gen_setup_deps.py bug-for-bug keeps only parts[0]/parts[-1] (dropping any
// middle sources); this port deliberately DEVIATES for correctness on
// non-vendored tasks: ALL sources copy into a directory dest.

test("parseTaskDockerfile: 3-source COPY into dest/ copies all three sources", () => {
  const dir = tmpDir()
  const task = "multi-copy-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "a.txt"), "a")
  writeFileSync(path.join(dir, task, "environment", "b.txt"), "b")
  writeFileSync(path.join(dir, task, "environment", "c.txt"), "c")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nCOPY a.txt b.txt c.txt dest/\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([
    { kind: "copy", src: "a.txt", dst: "dest/", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "copy", src: "b.txt", dst: "dest/", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "copy", src: "c.txt", dst: "dest/", srcIsDir: false, dirTarget: true, contentsOnly: false },
  ])
})

test("parseTaskDockerfile: single-source COPY behavior unchanged (2 parts = src, dst — not multi-source)", () => {
  const dir = tmpDir()
  const task = "single-copy-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "a.txt"), "a")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nCOPY a.txt /app/\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([
    { kind: "copy", src: "a.txt", dst: "/app/", srcIsDir: false, dirTarget: true, contentsOnly: false },
  ])
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
  // never its own exec call. Bracketed by a `podman cp` (environment ->
  // /.mh-stage) first and a `rm -rf /.mh-stage` last (env-fidelity fix).
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(4)
  for (const argv of steps) {
    expect(argv[0]).toBe("podman")
    expect(argv).toContain("container-1")
  }

  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  // step 1: the COPY
  expect(scripts[0]).toContain('export FOO="bar"')
  expect(scripts[0]).toContain("mkdir -p")
  expect(scripts[0]).toContain(`/.mh-stage/adir/.`)
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
  expect(steps[0]).toEqual(buildExecArgv("container-1", ["bash", "-c", scripts[0]!]))
})

test("stageTaskRuntime: apt install runs FIRST, ahead of copy/pip/run, when the Dockerfile has an apt-get install line", async () => {
  const dir = tmpDir()
  const task = "apt-first-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  mkdirSync(path.join(dir, task, "environment", "adir"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "adir", "f.txt"), "x")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM ubuntu:24.04",
      "RUN apt-get update && apt-get install -y git build-essential libgl1-mesa-glx && rm -rf /var/lib/apt/lists/*",
      "RUN pip install somepkg",
      "COPY adir/ /app/",
      "RUN echo raw-step",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)

  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // apt install, then copy, then the combined pip install, then the raw run.
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(4)
  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  expect(scripts[0]).toContain("apt-get update && apt-get install -y --no-install-recommends")
  // deduped + sorted + Ubuntu-24.04-renamed (libgl1-mesa-glx -> libgl1),
  // same rules as manifest.json's build-cython-ext "apt" field.
  expect(scripts[0]).toContain("build-essential git libgl1")
  expect(scripts[0]!.startsWith("set -euo pipefail\n")).toBe(true)
  expect(scripts[1]).toContain("mkdir -p")
  expect(scripts[1]).toContain('"/app/"')
  expect(scripts[2]).toContain("uv pip install")
  expect(scripts[3]).toContain("echo raw-step")
})

test("stageTaskRuntime: empty apt list — no apt exec at all", async () => {
  const dir = tmpDir()
  const task = "no-apt-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "RUN echo hello"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)

  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // exactly one exec (the raw "echo hello" run) — no apt-get anywhere.
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(1)
  expect(steps[0]![steps[0]!.length - 1]).not.toContain("apt-get")
})

test("stageTaskRuntime: a nonzero apt install exit throws BenchError naming it as an apt install failure", async () => {
  const dir = tmpDir()
  const task = "apt-fail-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "RUN apt-get update && apt-get install -y gcc"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  // The initial `podman cp` (environment -> /.mh-stage) must succeed so
  // execution actually reaches the apt install step under test — only the
  // apt exec itself fails.
  const fakeExec = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "cp" ? { rc: 0, stdout: "", stderr: "", timedOut: false } : { rc: 100, stdout: "", stderr: "boom", timedOut: false }

  await expect(stageTaskRuntime(fakePaths, "container-1", task, fakeExec)).rejects.toThrow(BenchError)
  try {
    await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
    throw new Error("unreachable")
  } catch (e) {
    expect((e as BenchError).message).toContain("apt install")
    expect((e as BenchError).message).toContain("gcc")
    expect((e as BenchError).message).toContain("boom")
  }
})

test("stageTaskRuntime: a nonzero step exit throws BenchError naming the step", async () => {
  const dir = tmpDir()
  const task = "fail-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN exit-with-failure\n")
  const fakePaths = fakeBenchPaths(dir)

  // The initial `podman cp` must succeed so execution reaches the run step
  // under test — only the run exec itself fails.
  const fakeExec = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "cp" ? { rc: 0, stdout: "", stderr: "", timedOut: false } : { rc: 1, stdout: "", stderr: "boom", timedOut: false }

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

test("stageTaskRuntime: no REAL podman spawned when execFn is injected (never touches real exec.ts's podman) — only the cp/rm stage bracket for a bare FROM-only Dockerfile", async () => {
  const dir = tmpDir()
  const task = "noop-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\n")
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  await stageTaskRuntime(fakePaths, "c1", task, async (argv) => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  })
  // no staging STEPS at all for a bare FROM-only Dockerfile, but the
  // env-fidelity stage/purge bracket (podman cp + rm -rf) always runs.
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "c1", fakePaths, task)
  expect(steps.length).toBe(0)
})

test("stageTaskRuntime: every step's script (copy, pip, run) starts with `set -euo pipefail` — a `;`-joined RUN body can't silently swallow a mid-command failure", async () => {
  const dir = tmpDir()
  const task = "set-e-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  mkdirSync(path.join(dir, task, "environment", "adir"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "adir", "f.txt"), "x")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "COPY adir/ /app/", "RUN pip install somepkg", "RUN false; true"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)

  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }

  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // copy, the combined pip install, and the raw run — one exec call each
  // (the bracketing `podman cp`/`rm -rf` calls are not "scripts" — see
  // expectStageBracketAndUnwrap).
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(3)
  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  for (const script of scripts) {
    expect(script.startsWith("set -euo pipefail\n")).toBe(true)
  }
  // the raw RUN step is the `false; true` body: without the whole-script
  // `set -euo pipefail` prefix, this `;`-joined command would exit 0 even
  // though `false` failed midway — the guard is what makes it fail loud.
  expect(scripts[2]).toContain("false; true")
})

// ── B2 live diagnosis fix (part 1): a later RUN step sources the pip venv ──
// A plain (non-`--break-system-packages`) `RUN pip install <pkg>` isolates
// into /opt/.venv; a SEPARATE later `RUN python3 ...` (its own podman exec)
// needs that venv sourced to see the package. Without the guard, the later
// run's own exec never inherits the earlier `source .venv/bin/activate`, so a
// `from <pkg> import ...` fails with ModuleNotFoundError even though staging
// "worked". (The chess-best-move Dockerfile itself uses --break-system-
// packages, which routes system-wide instead — see the part-2 tests below.)

test("stageTaskRuntime: a run step sources /opt/.venv if a plain pip step already created it", async () => {
  const dir = tmpDir()
  const task = "pip-then-run-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM ubuntu:24.04",
      "RUN pip3 install somelib==1.0.0",
      "RUN python3 make.py",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // one combined venv pip step, then the raw run — the run step's script must
  // source the venv (guarded so a Dockerfile with NO pip step at all, the
  // common case, doesn't fail on a missing /opt/.venv under set -e).
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(2)
  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  expect(scripts[0]).toContain("uv pip install")
  expect(scripts[0]).toContain('"somelib==1.0.0"')
  expect(scripts[1]).toContain('if [ -f "/opt/.venv/bin/activate" ]; then source "/opt/.venv/bin/activate"; fi')
  expect(scripts[1]).toContain("python3 make.py")
})

// ── B1 live diagnosis fix: the pip venv lives OUTSIDE /app ────────────────
// fix-code-vulnerability/environment/Dockerfile: `RUN git clone ... /app`
// followed (later in Dockerfile source order) by `RUN pip install
// --upgrade pip==24.2 && pip install flit==3.12.0`. This port's FIXED phase
// order (copy -> pip -> run, matching gen_setup_deps.py's own section order
// — see the module header) runs the combined pip step BEFORE the git-clone
// run step regardless of their Dockerfile source order. If the venv were
// created at /app/.venv (the old location), /app would already contain a
// stray `.venv` by the time `git clone ... /app` runs, and git refuses to
// clone into a non-empty directory — even though /app genuinely WAS empty
// at the point this exact RUN line appears in the Dockerfile.

test("stageTaskRuntime: the pip step's venv lives at /opt/.venv, not /app/.venv (fix-code-vulnerability shape: RUN git clone .../app then RUN pip install)", async () => {
  const dir = tmpDir()
  const task = "clone-then-pip-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM python:3.11-slim",
      "WORKDIR /app",
      "RUN git clone -o origin --single-branch https://example.com/repo.git /app",
      "RUN pip install --upgrade pip==24.2 && pip install flit==3.12.0",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)

  // fixed phase order still runs pip before run (unchanged — see A2/B2
  // tests); what changed is WHERE the venv lands, so it never collides with
  // a later (in this fixed order) run step's own use of /app.
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(2)
  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  expect(scripts[0]).toContain('uv venv --python python3 "/opt/.venv"')
  expect(scripts[0]).not.toContain('"/app/.venv"')
  expect(scripts[1]).toContain("git clone")
})

test("stageTaskRuntime: the venv-source guard is present even with no pip step at all (harmless no-op — missing venv doesn't trip set -e)", async () => {
  const dir = tmpDir()
  const task = "no-pip-run-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN echo hi\n")
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  const script = steps[0]![steps[0]!.length - 1]!
  expect(script).toContain('if [ -f "/opt/.venv/bin/activate" ]; then source "/opt/.venv/bin/activate"; fi')
  expect(script).toContain("echo hi")
})

// ── B2 live diagnosis fix (part 2): --break-system-packages → SYSTEM pip ──
// chess-best-move / make-mips-interpreter / make-doom-for-mips all use `RUN
// pip3 install <pkgs> --break-system-packages`. That flag is Docker/PEP-668's
// explicit request to install into the SYSTEM python (not an isolated venv).
// The task's own solution/solve.sh then runs bare `python3 solve.py` — which
// only sees those packages if they went system-wide. Isolating them into
// /opt/.venv (the default for a plain `pip install`) leaves bare python3
// without them, so the oracle fails at solve time even though staging
// "succeeded". Fix: a pip line carrying --break-system-packages installs its
// packages system-wide via `pip3 install --break-system-packages`, NOT into
// the venv.

test("parseTaskDockerfile: a --break-system-packages pip line yields a system-wide pip step (systemWide flag), not the venv pip step", () => {
  const dir = tmpDir()
  const task = "break-sys-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nRUN pip3 install pillow==11.2.1 --break-system-packages\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([
    { kind: "pip", packages: ["pillow==11.2.1"], systemWide: true },
  ])
})

test("parseTaskDockerfile: plain pip (no flag) stays a venv pip step; both kinds can coexist as two separate pip steps", () => {
  const dir = tmpDir()
  const task = "mixed-pip-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM ubuntu:24.04",
      "RUN pip install scipy==1.15.3",
      "RUN pip3 install pillow==11.2.1 --break-system-packages",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  // system-wide step first, then the venv step (both in the pip phase slot)
  expect(staging.steps).toEqual([
    { kind: "pip", packages: ["pillow==11.2.1"], systemWide: true },
    { kind: "pip", packages: ["scipy==1.15.3"] },
  ])
})

test("stageTaskRuntime: a systemWide pip step runs `pip3 install --break-system-packages` with NO venv (chess-best-move shape)", async () => {
  const dir = tmpDir()
  const task = "break-sys-exec-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "RUN pip3 install pillow==11.2.1 --break-system-packages", "RUN python3 make.py"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(2)
  const scripts = steps.map((argv) => argv[argv.length - 1]!)
  // system-wide install: plain pip3 with the flag, NO uv venv creation/source
  expect(scripts[0]).toContain("pip3 install --break-system-packages")
  expect(scripts[0]).toContain('"pillow==11.2.1"')
  expect(scripts[0]).not.toContain("uv venv")
  expect(scripts[0]).not.toContain("/opt/.venv")
  // the later run step still runs (bare python3 will now see system pillow)
  expect(scripts[1]).toContain("python3 make.py")
})

// ── env-fidelity fix, Bug B: file-deleting cleanup lines are EXECUTED ────
// docs/env-fidelity-spotcheck.md's path-tracing finding: the official
// Dockerfile's `RUN rm /app/orig.c` deletes the answer-key reference
// renderer source after it's used to render the fixture image — dropping
// that line (the old CLEANUP_ONLY_RE behavior) left orig.c present at agent
// time. `apt-get clean`/`apt-get autoremove` remain dropped (zero fidelity
// impact — see the module header's split).

test("parseTaskDockerfile: path-tracing shape — `RUN rm /app/orig.c` after COPY+gcc+run yields a bestEffort run step, not a dropped one", () => {
  const dir = tmpDir()
  const task = "path-tracing-shape-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "orig.c"), "int main(){return 0;}")
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    [
      "FROM ubuntu:24.04",
      "WORKDIR /app",
      "COPY orig.c /app",
      "RUN gcc -o orig /app/orig.c -lm",
      "RUN ./orig",
      "RUN rm /app/orig.c",
    ].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const staging = parseTaskDockerfile(fakePaths, task)
  expect(staging.steps).toEqual([
    { kind: "copy", src: "orig.c", dst: "/app", srcIsDir: false, dirTarget: true, contentsOnly: false },
    { kind: "run", cmd: "gcc -o orig /app/orig.c -lm" },
    { kind: "run", cmd: "./orig" },
    { kind: "run", cmd: "rm /app/orig.c", bestEffort: true },
  ])
})

test("stageTaskRuntime: a `RUN rm ...` cleanup line IS executed (appears in the exec'd script) — not silently dropped", async () => {
  const dir = tmpDir()
  const task = "rm-executed-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN rm /app/orig.c\n")
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(1)
  expect(steps[0]![steps[0]!.length - 1]).toContain("rm /app/orig.c")
})

test("stageTaskRuntime: `find ... -delete` cleanup lines are also EXECUTED (not dropped)", async () => {
  const dir = tmpDir()
  const task = "find-delete-executed-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nRUN find /app -name '*.tmp' -delete\n",
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(1)
  expect(steps[0]![steps[0]!.length - 1]).toContain("find /app -name '*.tmp' -delete")
})

test("stageTaskRuntime: `apt-get clean` / `apt-get autoremove` lines are STILL dropped (zero fidelity impact)", async () => {
  const dir = tmpDir()
  const task = "apt-cache-cleanup-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "RUN apt-get clean", "RUN apt-get autoremove", "RUN echo done"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  await stageTaskRuntime(fakePaths, "container-1", task, fakeExec)
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  // only the "echo done" raw run — the two cache-cleanup lines never surface
  expect(steps.length).toBe(1)
  expect(steps[0]![steps[0]!.length - 1]).toContain("echo done")
})

test("stageTaskRuntime: a failing bestEffort `rm` cleanup step is NON-FATAL — staging continues and completes (logged, not thrown)", async () => {
  const dir = tmpDir()
  const task = "rm-nonfatal-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, task, "environment", "Dockerfile"),
    ["FROM ubuntu:24.04", "RUN rm /app/already-gone.txt", "RUN echo after-cleanup"].join("\n"),
  )
  const fakePaths = fakeBenchPaths(dir)
  const recordedArgvs: string[][] = []
  const fakeExec = async (argv: string[]): Promise<ExecResult> => {
    recordedArgvs.push(argv)
    // the `rm` step's own exec fails (target already absent, e.g.); every
    // other exec (cp, the later "echo" run, the final rm -rf /.mh-stage)
    // succeeds.
    if (argv[1] === "exec" && argv.some((a) => typeof a === "string" && a.includes("rm /app/already-gone.txt"))) {
      return { rc: 1, stdout: "", stderr: "No such file or directory", timedOut: false }
    }
    return { rc: 0, stdout: "", stderr: "", timedOut: false }
  }
  const logSpy = spyOn(console, "log").mockImplementation(() => {})
  try {
    await expect(stageTaskRuntime(fakePaths, "container-1", task, fakeExec)).resolves.toBeUndefined()
  } finally {
    logSpy.mockRestore()
  }
  const steps = expectStageBracketAndUnwrap(recordedArgvs, "container-1", fakePaths, task)
  expect(steps.length).toBe(2)
  expect(steps[0]![steps[0]!.length - 1]).toContain("rm /app/already-gone.txt")
  // the SECOND step (a normal, non-bestEffort run) still ran despite the
  // first step's failure — non-fatal really means execution continues.
  expect(steps[1]![steps[1]!.length - 1]).toContain("echo after-cleanup")
})

test("stageTaskRuntime: a failing NON-bestEffort run step still throws fatally (unchanged — only file-delete cleanup lines are best-effort)", async () => {
  const dir = tmpDir()
  const task = "non-besteffort-fail-task"
  mkdirSync(path.join(dir, task, "environment"), { recursive: true })
  writeFileSync(path.join(dir, task, "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN gcc -o orig orig.c\n")
  const fakePaths = fakeBenchPaths(dir)
  const fakeExec = async (argv: string[]): Promise<ExecResult> =>
    argv[1] === "cp" ? { rc: 0, stdout: "", stderr: "", timedOut: false } : { rc: 1, stdout: "", stderr: "compile error", timedOut: false }
  await expect(stageTaskRuntime(fakePaths, "container-1", task, fakeExec)).rejects.toThrow(BenchError)
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

// ── execNetStep: bounded retry on transient-network staging failures ──────
// Motivated live: db-wal-recovery's `apt install` hit "Network is unreachable"
// on one pair → setup_failed → task dropped from the ab verdict, with no retry
// (staging was fail-fast, unlike the agent phase's attempt loop).

const noSleep = async (_s: number): Promise<void> => {}

test("execNetStep: success on first try — one exec, no retry", async () => {
  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return { rc: 0, stdout: "installed", stderr: "", timedOut: false }
  }
  const res = await execNetStep(execFn, ["bash", "-c", "apt"], "apt install x", noSleep)
  expect(res.rc).toBe(0)
  expect(calls).toBe(1)
})

test("execNetStep: transient network failure then success — retries, sleeps, returns rc 0", async () => {
  let calls = 0
  let slept = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    if (calls === 1)
      return { rc: 100, stdout: "", stderr: "Failed to fetch ... Could not connect to archive.ubuntu.com:80 — Network is unreachable", timedOut: false }
    return { rc: 0, stdout: "installed", stderr: "", timedOut: false }
  }
  const res = await execNetStep(execFn, ["bash", "-c", "apt"], "apt install x", async () => {
    slept++
  })
  expect(res.rc).toBe(0)
  expect(calls).toBe(2)
  expect(slept).toBe(1)
})

test("execNetStep: persistent transient failure — exhausts attempts, returns last failure", async () => {
  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return { rc: 100, stdout: "", stderr: "connection timed out", timedOut: false }
  }
  const res = await execNetStep(execFn, ["bash", "-c", "apt"], "apt install x", noSleep)
  expect(res.rc).toBe(100)
  expect(calls).toBe(STAGING_MAX_ATTEMPTS) // 1 initial + (MAX-1) retries
})

test("execNetStep: non-transient failure (real dep error) — NO retry, returns immediately", async () => {
  let calls = 0
  const execFn = async (): Promise<ExecResult> => {
    calls++
    return { rc: 100, stdout: "", stderr: "E: Unable to locate package nonexistent-pkg", timedOut: false }
  }
  const res = await execNetStep(execFn, ["bash", "-c", "apt"], "apt install nonexistent-pkg", noSleep)
  expect(res.rc).toBe(100)
  expect(calls).toBe(1) // a genuine dep error must not waste retries
})

// ── taskWorkdir — the verifier/agent cwd must honor the task Dockerfile ────
// (2026-08-12 prove-plus-comm finding: Dockerfile WORKDIR /workspace seeds
// /workspace/plus_comm.v; the bench hardcoded /app for BOTH the agent's
// container workdir and the verifier exec, so relative-path graders looked in
// the wrong directory — 3 of 4 clean proofs scored passed:false.)

test("taskWorkdir: no WORKDIR directive → /app default", () => {
  const dir = tmpDir()
  mkdirSync(path.join(dir, "t", "environment"), { recursive: true })
  writeFileSync(path.join(dir, "t", "environment", "Dockerfile"), "FROM ubuntu:24.04\nRUN echo hi\n")
  expect(taskWorkdir(fakeBenchPaths(dir), "t")).toBe("/app")
})

test("taskWorkdir: absolute WORKDIR wins (prove-plus-comm shape)", () => {
  const dir = tmpDir()
  mkdirSync(path.join(dir, "t", "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, "t", "environment", "Dockerfile"),
    "FROM coqorg/coq:8.18\nWORKDIR /workspace\nCOPY partial_proof.v /workspace/plus_comm.v\n",
  )
  expect(taskWorkdir(fakeBenchPaths(dir), "t")).toBe("/workspace")
})

test("taskWorkdir: relative WORKDIR chains against the previous cwd; missing Dockerfile → /app", () => {
  const dir = tmpDir()
  mkdirSync(path.join(dir, "t", "environment"), { recursive: true })
  writeFileSync(
    path.join(dir, "t", "environment", "Dockerfile"),
    "FROM ubuntu:24.04\nWORKDIR /app\nWORKDIR john/src\n",
  )
  expect(taskWorkdir(fakeBenchPaths(dir), "t")).toBe("/app/john/src")
  expect(taskWorkdir(fakeBenchPaths(dir), "no-such-task")).toBe("/app")
})
