/**
 * verifier.ts — copy-tests + run-verifier steps of the oracle (and later
 * run/ab) task lifecycle, against an already-created+started container.
 *
 * Mirrors term-bench2/runner.py's copy_tests/_copy_test_entry (:1208-1244)
 * and run_verifier (:1245-1264), reshaped for the podman one-container design
 * (see sandbox.ts's header): instead of copying files on the host into a
 * bwrap-mounted ~/bench/tests, everything happens via `podman cp` straight
 * from the host filesystem into the container's own /tests.
 *
 * Env-fidelity fix (docs/env-fidelity-spotcheck.md): `copyTests` used to
 * `podman exec cp -r` against a persistent, read-only /tb + /mh mount set up
 * by the container-create step. Agent (run/ab) containers no longer get
 * those mounts at all (cmd-run.ts's header), and this step's own timing
 * makes the mount unnecessary anyway — copyTests always runs AFTER the agent
 * phase, so switching it to `podman cp` (buildCpToArgv, host -> container,
 * no mount involved) is timing-safe and applies identically to BOTH the
 * agent path and cmd-oracle.ts (whose own container still keeps its /tb+/mh
 * mount for other steps — solve.sh, scripts-mode staging — unaffected here).
 * `execFn` is injectable (tests inject a fake to capture the cp argv without
 * spawning podman) — defaults to the real exec.ts funnel.
 *
 * Deliberate simplification vs. Python's per-file `_copy_test_entry` +
 * per-file "patch applied: <name>" log line: the container design copies the
 * whole tests/ and patches/<task>/ trees in one `podman cp` each (no need to
 * enumerate files across an exec boundary), so the patch-applied log is
 * logged once per task (naming the task), not once per patched file — this
 * is the shape the task brief's design section specifies for this step.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { podman, withTimeout } from "./exec.ts"
import { buildExecArgv, buildCpToArgv } from "./sandbox.ts"
import { BenchError, log, pyFixed } from "./util.ts"
import type { BenchPaths } from "./paths.ts"
import type { ExecFn } from "./staging.ts"

/**
 * Copy tests/ (from `<tbRoot>/<task>/tests` on the HOST, via `podman cp` —
 * no /tb mount involved) into /tests, then overlay `<patchesDir>/<task>/`
 * (also host-side, via `podman cp`) on top if it exists.
 *
 * The container's own /tests is pre-created empty by the caller's earlier
 * `mkdir -p` (cmd-run.ts/cmd-oracle.ts) — `podman cp` nests the source INSIDE
 * an already-existing destination directory rather than copying its contents
 * into it, so /tests is explicitly removed first, letting the first `podman
 * cp` create it fresh (contents copied in directly, verified podman cp
 * semantics). The patches overlay then targets that now-populated /tests
 * with a trailing-`/.` source (`<patchDir>/.`, built via string
 * concatenation — NOT `join()`, which normalizes the trailing `/.` away) so
 * its contents MERGE into /tests instead of nesting under a `<task>/`
 * subdirectory.
 *
 * rc discipline (reviewer fix, mirrors stageTaskRuntime's rc-check +
 * BenchError pattern): the /tests reset, the tests cp, and the patches
 * overlay cp are all FATAL on nonzero exit — a transient copy failure must
 * not silently degrade to runVerifier's "no test.sh found -> reward 0",
 * which is indistinguishable from a genuine task fail and corrupts the
 * scoring signal. Callers catch the BenchError and surface it as an infra
 * error (setup_failed), never a reward. ONLY the __pycache__/*.pyc cleanup
 * stays best-effort (its failure cannot lose test content — worst case a
 * stale .pyc survives into a tree pytest re-compiles anyway).
 */
export async function copyTests(
  paths: BenchPaths,
  name: string,
  task: string,
  execFn: ExecFn = podman,
): Promise<void> {
  const fail = (step: string, r: { rc: number; stderr: string }): never => {
    throw new BenchError(
      `copyTests(${task}): ${step} failed: exit ${r.rc}` +
        (r.stderr.trim() ? ` — ${r.stderr.trim()}` : ""),
    )
  }

  const rmResult = await execFn(buildExecArgv(name, ["rm", "-rf", "/tests"]))
  if (rmResult.rc !== 0) fail("rm -rf /tests reset", rmResult)

  const cpResult = await execFn(buildCpToArgv(name, join(paths.tbRoot, task, "tests"), "/tests"))
  if (cpResult.rc !== 0) fail("podman cp tests -> /tests", cpResult)

  // Best-effort (see the doc comment): log-and-continue on failure.
  const cleanupResult = await execFn(
    buildExecArgv(name, [
      "bash",
      "-c",
      `find /tests -name __pycache__ -type d -prune -exec rm -rf {} + ; find /tests -name "*.pyc" -delete`,
    ]),
  )
  if (cleanupResult.rc !== 0) {
    log(`  copyTests(${task}): pycache cleanup failed (non-fatal, best-effort): exit ${cleanupResult.rc}`)
  }

  const patchDir = join(paths.patchesDir, task)
  if (existsSync(patchDir)) {
    const patchResult = await execFn(buildCpToArgv(name, `${patchDir}/.`, "/tests"))
    if (patchResult.rc !== 0) fail("podman cp patches overlay -> /tests", patchResult)
    log(`  patch applied: ${task}`)
  }
}

/**
 * Run /tests/test.sh (if present) inside the container, then read back
 * /logs/verifier/reward.txt. Returns 0 or 1 — any missing test.sh, timeout,
 * non-"0"/"1" content, or read failure normalizes to 0 (Python parity:
 * runner.py's read_reward + run_verifier).
 */
export async function runVerifier(
  paths: BenchPaths,
  name: string,
  task: string,
  verifierTimeout: number,
): Promise<number> {
  const testShExists = await podman(buildExecArgv(name, ["test", "-f", "/tests/test.sh"]))
  if (testShExists.rc !== 0) {
    log("  WARNING: no test.sh found")
    return 0
  }

  log(`  verifier (timeout=${pyFixed(verifierTimeout, 0)}s)...`)
  const result = await podman(
    buildExecArgv(name, withTimeout(["bash", "/tests/test.sh"], verifierTimeout), { workdir: "/app" }),
  )
  if (result.timedOut) {
    log(`  verifier timed out after ${pyFixed(verifierTimeout, 0)}s`)
  }

  const rewardResult = await podman(buildExecArgv(name, ["cat", "/logs/verifier/reward.txt"]))
  if (rewardResult.rc !== 0) return 0
  const trimmed = rewardResult.stdout.trim()
  return trimmed === "0" || trimmed === "1" ? parseInt(trimmed, 10) : 0
}
