// opencode-plugin/test/fleet-score.test.ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { cmdRoleScore } from "../src/fleet/score.ts"
import { writePending } from "../src/fleet/pending.ts"
import {
  accountRoleRoot,
  activateCandidate,
  createCandidate,
  readScore,
  writeActive,
} from "../src/harness-store.ts" // real reader name — score.json accessor

let home: string, project: string
const basePending = (id: string, payload = "## Use Cases\nx") => ({
  id, role: "analyzer", agent: "mh-analyzer", project: "", model: "anthropic/claude-haiku-4-5",
  turnCount: 3, toolUsage: { read: 2 }, payload, events: [{ type: "step_finish" }],
  renderStamp: { versions: { "account-role": "v1" }, harnessHash: "abc123", renderedAt: "2026-07-13T00:00:00Z" },
  nodePath: "root/demo/analyzer", sliceId: "demo-slice", ts: "2026-07-13T00:00:00Z",
})

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "mh-score-")); project = mkdtempSync(join(tmpdir(), "mh-score-proj-"))
  process.env.META_HARNESS_HOME = home
})
afterEach(() => { delete process.env.META_HARNESS_HOME; rmSync(home, { recursive: true, force: true }); rmSync(project, { recursive: true, force: true }) })

describe("role-score", () => {
  test("good score lands on the STAMPED version with fleet provenance; pending archived", async () => {
    // Prove immunity to activation drift for real: v1 is the stamped version
    // (what the pending session actually ran against), but v2 is made the
    // CURRENTLY ACTIVE candidate before scoring — a weaker test would just
    // check v1 while v1 happens to also be active. Here they diverge.
    const root = accountRoleRoot("mh-analyzer")
    createCandidate(root, "v1", "analyzer v1 body")
    writeActive(root, "v1", "analyzer v1 body")
    createCandidate(root, "v2", "analyzer v2 body")
    activateCandidate(root, "v2")

    writePending({ ...basePending("ses_a1"), project })
    await cmdRoleScore({ project, id: "ses_a1", verdict: "good", gate: "gate1", nodePath: "root/demo/analyzer" })

    const score = readScore(root, "v1")   // stamped v1, not whatever is active
    expect(score.nPass).toBe(1)
    const rec = score.sessions[0]!
    expect(rec.env?.["fleet"]).toMatchObject({ gate: "gate1", nodePath: "root/demo/analyzer" })

    // v2 is the ACTIVE version but was never pinned — must receive nothing.
    const activeScore = readScore(root, "v2")
    expect(activeScore.nPass).toBe(0)
    expect(activeScore.sessions.length).toBe(0)

    expect(existsSync(join(project, ".meta-harness/runtime/fleet/scored/ses_a1.json"))).toBe(true)
  })

  test("double-score refused; missing id dies listing pending", async () => {
    writePending({ ...basePending("ses_b2"), project })
    await cmdRoleScore({ project, id: "ses_b2", verdict: "bad", gate: "verdict" })
    await expect(cmdRoleScore({ project, id: "ses_b2", verdict: "good" })).rejects.toThrow(/pending|already/)
    // readPending's die() message is "no pending fleet session '<id>' — pending: [...]"
    // — assert on the "no pending" phrase actually thrown (brief's /ses_/ regex
    // doesn't match an empty-pending-list message; see file header discussion).
    await expect(cmdRoleScore({ project, id: "nope", verdict: "good" })).rejects.toThrow(/no pending/)
  })

  test("Refused payload is never scored", async () => {
    writePending({ ...basePending("ses_c3", "## Refused\nharmful"), project })
    await expect(cmdRoleScore({ project, id: "ses_c3", verdict: "bad" })).rejects.toThrow(/never scored/)
  })
})
