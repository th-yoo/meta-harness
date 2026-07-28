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
  readTrajectory,
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

    expect(existsSync(join(project, ".kkamak/runtime/fleet/scored/ses_a1.json"))).toBe(true)
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

  test("--gate merge scores an id squad-run's own verdict scoring already archived (a SECOND score of the same session)", async () => {
    // Reality this closes (fleet-integration.md §2/§5): squad-run's own
    // evaluator-verdict PASS branch already auto-scores the implementer
    // good/verdict BEFORE the "done" outcome is even printed — by the time
    // the fleet master calls `role-score --id <implementerSessionId> --gate
    // merge`, that id is long gone from pending/ (archivePending already
    // moved it into scored/). A merge-gate score must therefore be able to
    // read from scored/ instead of dying "no pending fleet session".
    const root = accountRoleRoot("mh-implementer")
    createCandidate(root, "v1", "implementer v1 body")
    writeActive(root, "v1", "implementer v1 body")

    writePending({ ...basePending("ses_impl1", "## Implementation Report\ndone"), role: "implementer", agent: "mh-implementer", project })
    await cmdRoleScore({ project, id: "ses_impl1", verdict: "good", gate: "verdict" }) // squad-run's own auto-score
    expect(existsSync(join(project, ".kkamak/runtime/fleet/scored/ses_impl1.json"))).toBe(true)

    // Master's merge-gate score, on the SAME id, post-done.
    await cmdRoleScore({ project, id: "ses_impl1", verdict: "good", gate: "merge" })

    const score = readScore(root, "v1")
    expect(score.nPass).toBe(2) // verdict score + merge score, both landed
    expect(score.sessions.length).toBe(2)
    expect(score.sessions.some((s) => s.env?.["fleet"] && (s.env["fleet"] as { gate?: string }).gate === "merge")).toBe(true)
  })

  test("double merge-score refused", async () => {
    const root = accountRoleRoot("mh-implementer")
    createCandidate(root, "v1", "implementer v1 body")
    writeActive(root, "v1", "implementer v1 body")

    writePending({ ...basePending("ses_impl2", "## Implementation Report\ndone"), role: "implementer", agent: "mh-implementer", project })
    await cmdRoleScore({ project, id: "ses_impl2", verdict: "good", gate: "verdict" })
    await cmdRoleScore({ project, id: "ses_impl2", verdict: "good", gate: "merge" })
    await expect(cmdRoleScore({ project, id: "ses_impl2", verdict: "good", gate: "merge" })).rejects.toThrow(/merge/)
  })

  test("bad verdict normalizes raw NDJSON events before writing the trajectory (not empty SAY lines)", async () => {
    const root = accountRoleRoot("mh-analyzer")
    createCandidate(root, "v1", "analyzer v1 body")
    writeActive(root, "v1", "analyzer v1 body")

    // Raw opencode NDJSON tool_use event shape (run.ts's parseNdjsonLines
    // output) — NOT the compact TrajEvent shape. Before the fix this was
    // cast straight through and collapsed to an empty "SAY: " line.
    const rawEvents = [
      {
        type: "tool_use",
        sessionID: "ses_d4",
        part: { tool: "bash", state: { status: "completed", input: "ls -la", output: "file1\nfile2" } },
      },
    ]
    writePending({ ...basePending("ses_d4"), project, events: rawEvents })
    await cmdRoleScore({ project, id: "ses_d4", verdict: "bad", gate: "verdict" })

    const traj = readTrajectory(root, "v1", "ses_d4")
    expect(traj.length).toBe(1)
    // Compact TrajEvent shape with the tool name intact — not a raw event
    // (which has no `.t`) collapsing to `{ t: undefined }` → "SAY: ".
    expect(traj[0]).toMatchObject({ t: "tool", tool: "bash", args: "ls -la", output: "file1\nfile2", error: false })
  })
})
