import { test, expect } from "bun:test"
import * as fs from "node:fs"; import * as path from "node:path"; import * as os from "node:os"
import { BACKFILL_OPS } from "../scripts/backfill-mh-build-checks.ts"
import { screenCheck } from "../src/check-screen.ts"
import { calibrateCheck } from "../src/check-calibrate.ts"
import { applyAuthoredOps } from "../scripts/authored-ops.ts"

const addOp = BACKFILL_OPS.find((o) => o.op === "add")!
const b3Op = BACKFILL_OPS.find((o) => o.op === "update" && o.id === "b3")!

test("(a) new check and its failProbe both clear screenCheck (not rejected)", () => {
  const check = addOp.check!
  expect(screenCheck(check).tier).not.toBe("rejected")
  expect(screenCheck(check.failProbe!).tier).not.toBe("rejected")
})

test("(a) glob list includes bare *.json exactly, so the sandbox probe's corrupt.json is in scope", () => {
  expect(addOp.check!.cmd).toContain(" *.json")
})

test("(b) calibrateCheck proves the new check is falsifiable on bad state", () => {
  expect(calibrateCheck(addOp.check!)).toEqual({ calibrated: true, reason: "check-fails-on-bad-state" })
})

test("(c) the b3 op is a drop (check: null), not a keep and not a replace", () => {
  expect(b3Op.op).toBe("update")
  expect((b3Op as { id: string }).id).toBe("b3")
  expect(b3Op.check).toBeNull()
})

test("end-to-end: applying BACKFILL_OPS to a store carrying b3 drops its check and adds the calibrated one", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mh-backfill-store-"))
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), "mh-backfill-repo-"))
  fs.mkdirSync(path.join(root, "active"), { recursive: true })
  fs.writeFileSync(path.join(root, "active", "playbook.json"), JSON.stringify({
    schemaVersion: 1, nextId: 2,
    bullets: [{
      id: "b3", text: "old b3 text", helpful: 52, harmful: 0, addedBy: "test",
      status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
      check: { cmd: "jobs -r | wc -l", timeoutMs: 5000, state: "live" },
    }],
  }))

  const r = applyAuthoredOps({ storeRoot: root, repoRoot: repo, ops: BACKFILL_OPS, provenance: "test" })
  expect(r.applied).toBe(true)
  expect(r.refusals).toEqual([])

  const pb = JSON.parse(fs.readFileSync(path.join(root, "active", "playbook.json"), "utf8"))
  const b3 = pb.bullets.find((b: { id: string }) => b.id === "b3")
  expect(b3.check).toBeUndefined()
  const added = pb.bullets.find((b: { id: string }) => b.id !== "b3")
  expect(added.check.cmd).toBe(addOp.check!.cmd)
  expect(added.check.state).toBe("shadow")
})
