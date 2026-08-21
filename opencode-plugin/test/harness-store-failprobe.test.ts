import { test, expect } from "bun:test"
import { applyPlaybookOps, type Playbook } from "../src/harness-store.ts"

const base: Playbook = { schemaVersion: 1, nextId: 1, bullets: [] }

test("add op carries failProbe through to the stored check", () => {
  const pb = applyPlaybookOps(base, [{
    op: "add", text: "When X, do Y.",
    check: { cmd: "test -f out.txt", timeoutMs: 5000,
      failProbe: { cmd: "rm -f out.txt", timeoutMs: 5000 } },
  }])
  expect(pb.bullets[0]!.check?.failProbe?.cmd).toBe("rm -f out.txt")
  expect(pb.bullets[0]!.check?.state).toBe("shadow") // store-owned stamp unchanged
})

test("update op with check object replaces failProbe; omitted field keeps the old check whole", () => {
  const withProbe = applyPlaybookOps(base, [{
    op: "add", text: "When X, do Y.",
    check: { cmd: "c1", timeoutMs: 1000, failProbe: { cmd: "p1", timeoutMs: 1000 } },
  }])
  const replaced = applyPlaybookOps(withProbe, [{
    op: "update", id: "b1", text: "When X, do Y2.",
    check: { cmd: "c2", timeoutMs: 1000 }, // no failProbe → new check has none
  }])
  expect(replaced.bullets[0]!.check?.cmd).toBe("c2")
  expect(replaced.bullets[0]!.check?.failProbe).toBeUndefined()
  const kept = applyPlaybookOps(withProbe, [{ op: "update", id: "b1", text: "When X, do Y3." }])
  expect(kept.bullets[0]!.check?.failProbe?.cmd).toBe("p1") // tri-state: omitted = keep
})
