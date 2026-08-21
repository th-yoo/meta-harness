import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { buildRuleCheckReport, tallySensorStream } from "../scripts/rule-check-report.ts"

function playbookStore(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-rcr-store-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "playbook.json"), JSON.stringify({
    schemaVersion: 1, nextId: 3,
    bullets: [
      {
        id: "b1", text: "falsifiable check", helpful: 0, harmful: 0, addedBy: "test",
        status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        check: {
          cmd: `for f in *.json; do [ -e "$f" ] || exit 0; python3 -c "import json;json.load(open('$f'))" || exit 1; done`,
          timeoutMs: 10000, state: "shadow",
          failProbe: { cmd: "echo '{bad' > corrupt.json", timeoutMs: 5000 },
        },
      },
      {
        id: "b3", text: "no-probe check", helpful: 0, harmful: 0, addedBy: "test",
        status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        check: { cmd: "true", timeoutMs: 5000, state: "shadow" },
      },
      {
        id: "b4", text: "pruned, should be excluded", helpful: 0, harmful: 0, addedBy: "test",
        status: "pruned", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
        check: { cmd: "true", timeoutMs: 5000, state: "shadow" },
      },
    ],
  }))
  return root
}

function sensorFile(): string {
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mh-rcr-sensor-")), "gate-outcomes.ndjson")
  const lines = [
    JSON.stringify({ ruleChecks: [{ id: "b1", pass: true, ms: 10 }, { id: "b3", skipped: true }] }),
    JSON.stringify({ ruleChecks: [{ id: "b1", pass: false, ms: 12 }] }),
    JSON.stringify({ ruleChecks: [{ id: "b1", refused: true }, { id: "b9", pass: true, ms: 5 }] }),
  ]
  fs.writeFileSync(p, lines.join("\n") + "\n")
  return p
}

test("tallySensorStream: per-id pass/fail/skip/refused tallies from a 3-line ndjson", () => {
  const t = tallySensorStream(sensorFile())
  expect(t.get("b1")).toEqual({ pass: 1, fail: 1, skip: 0, refused: 1 })
  expect(t.get("b3")).toEqual({ pass: 0, fail: 0, skip: 1, refused: 0 })
  expect(t.get("b9")).toEqual({ pass: 1, fail: 0, skip: 0, refused: 0 })
})

test("tallySensorStream: missing sensor file → empty map, not a throw", () => {
  const t = tallySensorStream(path.join(os.tmpdir(), "does-not-exist-" + Date.now(), "gate-outcomes.ndjson"))
  expect(t.size).toBe(0)
})

test("buildRuleCheckReport: prints calibration + sensor tallies per rule-check id", () => {
  const report = buildRuleCheckReport(playbookStore(), sensorFile())
  expect(report).toContain("b1: calibrated=true reason=check-fails-on-bad-state pass=1 fail=1 skip=0 refused=1")
  expect(report).toContain("b3: calibrated=false reason=no-probe pass=0 fail=0 skip=1 refused=0")
  // b9 has sensor data but no matching playbook check.
  expect(report).toContain("b9: calibrated=n/a reason=not-in-playbook pass=1 fail=0 skip=0 refused=0")
  // pruned b4 must not appear at all.
  expect(report).not.toContain("b4:")
})
