/**
 * verifier.ts — copy-tests + run-verifier steps of the oracle (and later
 * run/ab) task lifecycle, against an already-created+started container.
 *
 * Mirrors term-bench2/runner.py's copy_tests/_copy_test_entry (:1208-1244)
 * and run_verifier (:1245-1264), reshaped for the podman one-container design
 * (see sandbox.ts's header): instead of copying files on the host into a
 * bwrap-mounted ~/bench/tests, everything happens via `podman exec` against
 * the container's own /tests, using the read-only /tb and /mh mounts set up
 * by cmd-oracle.ts's container-create step.
 *
 * Deliberate simplification vs. Python's per-file `_copy_test_entry` +
 * per-file "patch applied: <name>" log line: the container design copies the
 * whole tests/ and patches/<task>/ trees in one `cp -r` exec each (no need to
 * enumerate files across an exec boundary), so the patch-applied log is
 * logged once per task (naming the task), not once per patched file — this
 * is the shape the task brief's design section specifies for this step.
 */
import { existsSync } from "node:fs"
import { join } from "node:path"
import { podman, withTimeout } from "./exec.ts"
import { buildExecArgv } from "./sandbox.ts"
import { log, pyFixed } from "./util.ts"
import type { BenchPaths } from "./paths.ts"

/**
 * Copy tests/ (from /tb/<task>/tests, the read-only tbRoot mount) into
 * /tests, then overlay patches/<task>/ (from /mh/patches/<task>, the
 * read-only termBenchDir mount) on top if it exists on the host.
 */
export async function copyTests(paths: BenchPaths, name: string, task: string): Promise<void> {
  const copyCmd = [
    "bash",
    "-c",
    `rm -rf /tests && mkdir -p /tests && cp -r /tb/${task}/tests/. /tests/ && ` +
      `find /tests -name __pycache__ -type d -prune -exec rm -rf {} + ; ` +
      `find /tests -name "*.pyc" -delete`,
  ]
  await podman(buildExecArgv(name, copyCmd))

  const patchDir = join(paths.patchesDir, task)
  if (existsSync(patchDir)) {
    await podman(buildExecArgv(name, ["bash", "-c", `cp -r /mh/patches/${task}/. /tests/`]))
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
