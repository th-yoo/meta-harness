import { test, expect } from "bun:test"
import { calibrateCheck } from "../src/check-calibrate.ts"

test("no probe → uncalibrated", () => {
  expect(calibrateCheck({ cmd: "true", timeoutMs: 5000 }).reason).toBe("no-probe")
})

test("vacuous check: passes even on probed-bad state", () => {
  const r = calibrateCheck({ cmd: "jobs -r | wc -l", timeoutMs: 5000,
    failProbe: { cmd: "echo garbage > corrupt.json", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(false)
  expect(r.reason).toBe("vacuous-on-bad-state")
})

test("falsifiable check: probe constructs bad state, check fails on it", () => {
  const r = calibrateCheck({
    cmd: `for f in *.json; do [ -e "$f" ] || exit 0; python3 -c "import json;json.load(open('$f'))" || exit 1; done`,
    timeoutMs: 10000,
    failProbe: { cmd: "echo '{bad' > corrupt.json", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(true)
  expect(r.reason).toBe("check-fails-on-bad-state")
})

test("probe itself failing is its own verdict, not a calibration", () => {
  const r = calibrateCheck({ cmd: "true", timeoutMs: 5000,
    failProbe: { cmd: "exit 3", timeoutMs: 5000 } })
  expect(r.calibrated).toBe(false)
  expect(r.reason).toBe("probe-failed")
})
