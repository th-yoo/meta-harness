/** Falsification calibration (shadow-lane upstream fix, 2026-08-22).
 * One leg only — CAN the check fail: run the probe in a fresh sandbox dir
 * (never the repo — a probe constructs BAD state by design), then the check
 * in that same dir; calibrated iff the check exits nonzero there. The
 * passes-on-good-state leg is already measured for free by the shadow lane
 * itself (every sensor line is a good-state run), so it is not re-proven
 * here. Sandbox is a mkdtemp dir, removed on every path. */
import { spawnSync } from "node:child_process"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

export type CalibrationReason = "no-probe" | "probe-failed" | "vacuous-on-bad-state" | "check-fails-on-bad-state"

export function calibrateCheck(check: {
  cmd: string; timeoutMs: number; failProbe?: { cmd: string; timeoutMs: number }
}): { calibrated: boolean; reason: CalibrationReason } {
  if (!check.failProbe) return { calibrated: false, reason: "no-probe" }
  const dir = mkdtempSync(join(tmpdir(), "mh-check-calib-"))
  try {
    const probe = spawnSync("bash", ["-c", check.failProbe.cmd], { cwd: dir, timeout: check.failProbe.timeoutMs })
    if (probe.status !== 0) return { calibrated: false, reason: "probe-failed" }
    const chk = spawnSync("bash", ["-c", check.cmd], { cwd: dir, timeout: check.timeoutMs })
    return chk.status !== 0
      ? { calibrated: true, reason: "check-fails-on-bad-state" }
      : { calibrated: false, reason: "vacuous-on-bad-state" }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}
