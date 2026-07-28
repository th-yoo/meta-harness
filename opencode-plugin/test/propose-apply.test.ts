import { test, expect, beforeEach, afterEach } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import {
  applyStagedArtifact,
  triggerPropose,
  type ApplyResult,
} from "../src/propose.ts"
import {
  writeActive,
  bootstrapStore,
  activeVersion,
  listVersions,
  readTrial,
  candidatePath,
  readRejectedLedger,
  type StoreLayer,
} from "../src/harness-store.ts"
import type { HarnessHost, StagedArtifactDescriptor } from "../src/host.ts"

// ── review-gate (RG3) fixtures — PASS_CHECKS style copied from
// test/review-gate.test.ts, since applyProposeArtifact now runs added
// bullets through reviewAddedBullets() before createCandidate. ─────────────
const REVIEW_PASS = `ok
{"checks":{"category":{"pass":true,"category":"iteration-discipline","quote":"…"},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"}},"confidence":0.8}`

const REVIEW_FAIL = `not quite
{"checks":{"category":{"pass":false,"category":"","quote":""},
"domain_swap":{"pass":true,"swapped_bullet":"When a SQL migration fails twice, change the diagnosis."},
"behavior_level":{"pass":true,"restatement":"Agent changes approach after repeated failure."},
"duplicate":{"pass":true,"match":"none"}},"confidence":0.4}`

// Hermetic: no real claude, no opencode. We seed staging files by hand (as a
// finished child would) and drive the EXTRACTED apply body directly, plus the
// opencode inline path via triggerPropose with a fake host.

let home: string
let worktree: string
let prevHome: string | undefined

beforeEach(() => {
  prevHome = process.env["META_HARNESS_HOME"]
  home = fs.mkdtempSync(path.join(os.tmpdir(), "mh-apply-home-"))
  worktree = fs.mkdtempSync(path.join(os.tmpdir(), "mh-apply-wt-"))
  process.env["META_HARNESS_HOME"] = home
})
afterEach(() => {
  if (prevHome === undefined) delete process.env["META_HARNESS_HOME"]
  else process.env["META_HARNESS_HOME"] = prevHome
  fs.rmSync(home, { recursive: true, force: true })
  fs.rmSync(worktree, { recursive: true, force: true })
})

interface Rec { notes: string[]; logs: string[] }
function fakeHost(rec: Rec, over: Partial<HarnessHost> = {}): HarnessHost {
  return {
    platform: "test",
    projectRoot: worktree,
    log: (_l, m) => { rec.logs.push(m) },
    notify: (m) => { rec.notes.push(m) },
    showScorePrompt: async () => {},
    runTextAgent: async () => null,
    runTaskAgent: async () => ({ id: "child-1" }),
    exec: async () => ({ stdout: "", exitCode: 0 }),
    ...over,
  } as HarnessHost
}

/** Always answers runTextAgent with a passing rubric reply — for tests whose
 * added bullets must clear the review gate to reach the old assertions. */
function reviewPassHost(rec: Rec): HarnessHost {
  return fakeHost(rec, { runTextAgent: async () => REVIEW_PASS })
}

/** Scripted runTextAgent reply queue (review-gate.test.ts's fakeHost pattern). */
function scriptedHost(rec: Rec, replies: (string | null)[]): HarnessHost {
  return fakeHost(rec, {
    runTextAgent: async () => {
      if (replies.length === 0) throw new Error("scriptedHost: no more scripted replies")
      return replies.shift()!
    },
  })
}

/** Fails loudly if the review gate calls runTextAgent at all — for the
 * legacy/no-added-bullet/no-op paths, which must skip review entirely. */
function noLlmHost(rec: Rec): HarnessHost {
  return fakeHost(rec, {
    runTextAgent: async () => { throw new Error("runTextAgent must NOT be called on this path") },
  })
}

function stagingBase(): string {
  const b = path.join(worktree, ".kkamak", "staging")
  fs.mkdirSync(b, { recursive: true })
  return b
}

function descriptor(over: Partial<StagedArtifactDescriptor> & { layer: StoreLayer; version: string }): StagedArtifactDescriptor {
  return {
    kind: "propose",
    worktree,
    playbookMode: false,
    proposerModel: "anthropic/claude-opus-4-8",
    proposerVariant: "high",
    sessionId: "child-1",
    spawnedAt: Date.now(),
    timeoutMs: 20 * 60 * 1000,
    pid: process.pid,
    ...over,
  }
}

// ── applyStagedArtifact: propose (legacy system.md) ─────────────────────────

test("applyProposeArtifact: legacy system.md → project-role trial started, staging consumed", async () => {
  const root = path.join(home, "stores", "pr")
  writeActive(root, "v1", "- baseline rule", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- improved rule\n")
  fs.writeFileSync(path.join(b, "project-role-v2-diagnosis.json"),
    JSON.stringify({ failures: [{ sessionID: "s", taxonomy: "wrong-plan", rootCause: "x", firstUnrecoverableStep: "y" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res: ApplyResult = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2" }))

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  // project layer → provisional trial live
  expect(readTrial(root)).not.toBeNull()
  expect(activeVersion(root)).toBe("v2")
  // staging consumed
  expect(fs.existsSync(path.join(b, "project-role-v2-system.md"))).toBe(false)
  expect(fs.existsSync(path.join(b, "project-role-v2-diagnosis.json"))).toBe(false)
  // diagnosis relocated into the candidate
  expect(fs.existsSync(candidatePath(root, "v2", "diagnosis.json"))).toBe(true)
  expect(rec.notes.some((n) => n.includes("Trial started"))).toBe(true)
})

test("applyProposeArtifact: account layer → INACTIVE candidate, no trial, awaiting ab", async () => {
  const root = path.join(home, "stores", "ag")
  writeActive(root, "v1", "- baseline", "")
  const layer: StoreLayer = { root, scope: "account-global", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "account-global-v2-system.md"), "- universal rule\n")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2" }))

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  expect(readTrial(root)).toBeNull()             // account: no trial
  expect(activeVersion(root)).toBe("v1")         // stays inactive
  expect(rec.notes.some((n) => n.includes("validate with bun term-bench2"))).toBe(true)
})

test("applyProposeArtifact: primary artifact absent → 'pending', nothing created", async () => {
  const root = path.join(home, "stores", "pr2")
  writeActive(root, "v1", "- baseline", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }
  stagingBase() // dir exists, but no artifact

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2" }))

  expect(res).toBe("pending")
  expect(listVersions(root)).not.toContain("v2")
  expect(readTrial(root)).toBeNull()
})

// ── applyStagedArtifact: propose (playbook ops mode) ────────────────────────

test("applyProposeArtifact: playbook ops.json → candidate with edited playbook", async () => {
  const root = path.join(home, "stores", "pb")
  // Seed an active playbook by writing a playbook.json alongside active.
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // RG3 adaptation: added bullet must clear the review gate now, so its text
  // must satisfy layer1's trigger-form check ("When …, …") — the bare
  // "new behavioral rule" text used pre-RG3 would layer1-free-fail and block
  // candidate creation entirely. Kept the "new behavioral rule" substring so
  // the existing assertion below still targets the same content.
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "When behavior changes, apply the new behavioral rule." }] }))
  fs.writeFileSync(path.join(b, "project-role-v2-diagnosis.json"), JSON.stringify({ failures: [] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  expect(fs.existsSync(path.join(b, "project-role-v2-ops.json"))).toBe(false)
  const sys = fs.readFileSync(candidatePath(root, "v2", "system.md"), "utf-8")
  expect(sys).toContain("new behavioral rule")
})

// ── applyStagedArtifact: propose (per-bullet generality tag) ───────────────

test("applyProposeArtifact: tagged add op → candidate bullet carries generality + slice", async () => {
  const root = path.join(home, "stores", "pbtag1")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // RG3 adaptation: renamed to a layer1-passing trigger-form bullet (was the
  // bare "vendor-tagged rule", which layer1 rejects for lacking a "When …"
  // trigger) so this add op clears the review gate; assertion below updated
  // to the same new exact text.
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "When a vendor quirk appears, use vendor-tagged handling.", generality: "vendor", slice: "anthropic" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  const pb = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "playbook.json"), "utf-8"))
  const bullet = pb.bullets.find((x) => x.text === "When a vendor quirk appears, use vendor-tagged handling.")
  expect(bullet.generality).toBe("vendor")
  expect(bullet.slice).toBe("anthropic")
})

test("applyProposeArtifact: untagged add op → generality absent, render byte-identical to a tagged op's render", async () => {
  const rootUntagged = path.join(home, "stores", "pbtag2-untagged")
  const rootTagged = path.join(home, "stores", "pbtag2-tagged")
  for (const root of [rootUntagged, rootTagged]) {
    writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
      { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
    ] })
  }
  const layerUntagged: StoreLayer = { root: rootUntagged, scope: "project-role", higherRoots: [] }
  const layerTagged: StoreLayer = { root: rootTagged, scope: "project-role", higherRoots: [] }
  const rec: Rec = { notes: [], logs: [] }

  // RG3 adaptation: "shared rule text" alone fails layer1's trigger-form
  // check — renamed to a When-form bullet that still carries the substring
  // "shared rule text" so both the exact-match assertion and the byte-
  // identical-render comparison below keep the same intent. Both applies use
  // reviewPassHost so the add clears the gate identically either way.
  const SHARED_TEXT = "When a shared situation occurs, apply shared rule text."

  const b1 = stagingBase()
  fs.writeFileSync(path.join(b1, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: SHARED_TEXT }] }))
  const resUntagged = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer: layerUntagged, version: "v2", playbookMode: true }))

  const b2 = stagingBase()
  fs.writeFileSync(path.join(b2, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: SHARED_TEXT, generality: "vendor", slice: "anthropic" }] }))
  const resTagged = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer: layerTagged, version: "v2", playbookMode: true }))

  expect(resUntagged).toBe("applied")
  expect(resTagged).toBe("applied")

  const pbUntagged = JSON.parse(fs.readFileSync(candidatePath(rootUntagged, "v2", "playbook.json"), "utf-8"))
  const untaggedBullet = pbUntagged.bullets.find((x) => x.text === SHARED_TEXT)
  expect(untaggedBullet.generality).toBeUndefined()

  // renderPlaybook ignores generality/slice entirely — tagged and untagged
  // adds of the SAME text must render byte-identical system.md.
  const sysUntagged = fs.readFileSync(candidatePath(rootUntagged, "v2", "system.md"), "utf-8")
  const sysTagged = fs.readFileSync(candidatePath(rootTagged, "v2", "system.md"), "utf-8")
  expect(sysUntagged).toBe(sysTagged)
})

test("applyProposeArtifact: invalid generality coerces to universal, oversized slice caps to 64 chars", async () => {
  const root = path.join(home, "stores", "pbcoerce")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // RG3 adaptation: renamed both bullets to layer1-passing trigger-form text
  // (bare "bogus-tag rule"/"long-slice rule" fail the trigger-form check);
  // assertions below match the same renamed exact text.
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [
      { op: "add", text: "When a bogus tag appears, apply the bogus-tag rule.", generality: "bogus" },
      { op: "add", text: "When a long slice appears, apply the long-slice rule.", slice: "x".repeat(100) },
    ] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  const pb = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "playbook.json"), "utf-8"))
  const bogus = pb.bullets.find((x) => x.text === "When a bogus tag appears, apply the bogus-tag rule.")
  expect(bogus.generality).toBe("universal")
  const longSlice = pb.bullets.find((x) => x.text === "When a long slice appears, apply the long-slice rule.")
  expect(longSlice.slice.length).toBe(64)
})

test("applyProposeArtifact: candidate meta.json generalityRollup matches active bullets bucketed by generality", async () => {
  const root = path.join(home, "stores", "pbrollup")
  writeActive(root, "v1", "- untagged rule\n- vendor rule\n- model rule", "", { version: 1, bullets: [
    { id: "b1", text: "untagged rule", status: "active", helpful: 0, harmful: 0 },
    { id: "b2", text: "vendor rule", status: "active", helpful: 0, harmful: 0, generality: "vendor" },
    { id: "b3", text: "model rule", status: "active", helpful: 0, harmful: 0, generality: "model" },
    { id: "b4", text: "pruned vendor rule", status: "pruned", helpful: 0, harmful: 0, generality: "vendor" },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // RG3 adaptation: renamed to layer1-passing trigger-form text (bare
  // "new universal rule"/"new vendor rule" fail the trigger-form check); no
  // assertion below depends on the exact bullet text, so any When-form works.
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [
      { op: "add", text: "When a universal case appears, apply the new universal rule.", generality: "universal" },
      { op: "add", text: "When a vendor case appears, apply the new vendor rule.", generality: "vendor" },
    ] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  const meta = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "meta.json"), "utf-8"))
  // active bullets: untagged(→universal) + vendor + model + new-universal + new-vendor; pruned b4 excluded
  expect(meta.generalityRollup).toEqual({ universal: 2, vendor: 2, model: 1 })
})

test("applyProposeArtifact: update op changing ONLY generality (same text) → candidate created, not skipped as no-op (I1 fix)", async () => {
  const root = path.join(home, "stores", "pbretag")
  writeActive(root, "v1", "- keep rule", "", { version: 1, bullets: [
    { id: "b1", text: "keep rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "update", id: "b1", text: "keep rule", generality: "vendor", slice: "acme" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  // NOT the no-op short-circuit: a candidate (and project-layer trial) exists.
  expect(listVersions(root)).toContain("v2")
  expect(readTrial(root)).not.toBeNull()
  expect(rec.logs.some((l) => l.includes("no-op proposal"))).toBe(false)
  const pb = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "playbook.json"), "utf-8"))
  const bullet = pb.bullets.find((x) => x.id === "b1")
  expect(bullet.text).toBe("keep rule")
  expect(bullet.generality).toBe("vendor")
  expect(bullet.slice).toBe("acme")
})

test("applyProposeArtifact: playbook-mode grace (system.md, no ops.json) identical to active → no-op guard skips without NPE", async () => {
  const root = path.join(home, "stores", "pbgrace")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // Grace path: proposer wrote a whole system.md instead of ops.json even
  // though this store is in playbook mode — legacy branch, newPlaybook stays
  // undefined; the guard must not dereference it (I1-fix regression check).
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- b1 rule\n")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")
  expect(readTrial(root)).toBeNull()
  expect(rec.logs.some((l) => l.includes("no-op proposal"))).toBe(true)
})

test("applyProposeArtifact: corrupt ops.json → no crash, no-op detected → NO candidate", async () => {
  const root = path.join(home, "stores", "pbc")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"), "{ this is not json")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  // corrupt ops → empty ops → playbook renders identical to active → the no-op
  // guard skips create+trial (review 2026-07-16), rather than minting a
  // byte-identical v2 that would burn TRIAL_MIN_SESSIONS proving nothing.
  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")
  expect(readTrial(root)).toBeNull()
  expect(rec.logs.some((l) => l.includes("no-op proposal"))).toBe(true)
})

test("applyProposeArtifact: empty ops {ops:[]} → no-op guard, no candidate, no trial", async () => {
  const root = path.join(home, "stores", "noop")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"), JSON.stringify({ ops: [] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")   // byte-identical → skipped
  expect(readTrial(root)).toBeNull()
  expect(rec.notes.some((n) => n.includes("no change proposed"))).toBe(true)
  // staging still consumed (not left to re-fire)
  expect(fs.existsSync(path.join(b, "project-role-v2-ops.json"))).toBe(false)
})

test("applyProposeArtifact: legacy system.md IDENTICAL to active → no-op guard skips", async () => {
  const root = path.join(home, "stores", "noop-legacy")
  writeActive(root, "v1", "- baseline rule", "")
  const layer: StoreLayer = { root, scope: "account-global", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "account-global-v2-system.md"), "- baseline rule\n") // same as active

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ layer, version: "v2" }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")
  expect(rec.logs.some((l) => l.includes("no-op proposal"))).toBe(true)
})

// ── applyStagedArtifact: promote ────────────────────────────────────────────

test("applyPromoteArtifact: merged system.md → INACTIVE account candidate with source meta", async () => {
  const target = path.join(home, "stores", "acct-role")
  writeActive(target, "v1", "- base account-role", "")
  const source = path.join(home, "stores", "proj-role")
  writeActive(source, "v3", "- proven project rule", "")
  const targetLayer: StoreLayer = { root: target, scope: "account-role", higherRoots: [] }
  const sourceLayer: StoreLayer = { root: source, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "promote-account-role-v2-system.md"), "- merged general rule\n")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec),
    descriptor({ kind: "promote", layer: targetLayer, source: sourceLayer, version: "v2" }))

  expect(res).toBe("applied")
  expect(listVersions(target)).toContain("v2")
  expect(activeVersion(target)).toBe("v1") // inactive
  const meta = JSON.parse(fs.readFileSync(candidatePath(target, "v2", "meta.json"), "utf-8"))
  expect(meta.kind).toBe("promote")
  expect(meta.source).toBe("project-role")
  expect(rec.notes.some((n) => n.includes("Promotion candidate"))).toBe(true)
})

test("applyPromoteArtifact: system.md absent → 'pending'", async () => {
  const target = path.join(home, "stores", "acct-role2")
  writeActive(target, "v1", "- base", "")
  const targetLayer: StoreLayer = { root: target, scope: "account-role", higherRoots: [] }
  stagingBase()
  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec),
    descriptor({ kind: "promote", layer: targetLayer, version: "v2" }))
  expect(res).toBe("pending")
  expect(listVersions(target)).not.toContain("v2")
})

test("applyPromoteArtifact: merged IDENTICAL to active target → no-op (no wasted ab)", async () => {
  const target = path.join(home, "stores", "acct-role-noop")
  writeActive(target, "v1", "- base account-role", "")
  const source = path.join(home, "stores", "proj-role-noop")
  writeActive(source, "v3", "- proven project rule", "")
  const targetLayer: StoreLayer = { root: target, scope: "account-role", higherRoots: [] }
  const sourceLayer: StoreLayer = { root: source, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // merged result equals the active target system.md → nothing new generalized
  fs.writeFileSync(path.join(b, "promote-account-role-v2-system.md"), "- base account-role\n")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec),
    descriptor({ kind: "promote", layer: targetLayer, source: sourceLayer, version: "v2" }))

  expect(res).toBe("applied")
  expect(listVersions(target)).not.toContain("v2")   // identical → skipped, no ab wasted
  expect(rec.logs.some((l) => l.includes("no-op"))).toBe(true)
})

// ── applyStagedArtifact: curate ─────────────────────────────────────────────

test("applyCurateArtifact: ops.json → curated playbook trial (project layer)", async () => {
  const root = path.join(home, "stores", "cur")
  writeActive(root, "v1", "- b1\n- b2", "", { version: 1, bullets: [
    { id: "b1", text: "b1", status: "active", helpful: 0, harmful: 0 },
    { id: "b2", text: "b2", status: "active", helpful: 0, harmful: 5 },
  ] })
  const layer: StoreLayer = { root, scope: "project-global", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "curate-project-global-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "delete", id: "b2" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ kind: "curate", layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(readTrial(root)).not.toBeNull()
  expect(fs.existsSync(path.join(b, "curate-project-global-v2-ops.json"))).toBe(false)
  expect(rec.notes.some((n) => n.includes("Curation trial"))).toBe(true)
})

test("applyCurateArtifact: candidate meta.json generalityRollup matches active bullets after curation", async () => {
  const root = path.join(home, "stores", "curollup")
  writeActive(root, "v1", "- c1\n- c2\n- c3\n- c4", "", { version: 1, bullets: [
    { id: "c1", text: "c1", status: "active", helpful: 0, harmful: 0 },
    { id: "c2", text: "c2", status: "active", helpful: 0, harmful: 0, generality: "vendor" },
    { id: "c3", text: "c3", status: "active", helpful: 0, harmful: 0, generality: "model" },
    { id: "c4", text: "c4", status: "active", helpful: 0, harmful: 5, generality: "vendor" },
  ] })
  const layer: StoreLayer = { root, scope: "project-global", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "curate-project-global-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "delete", id: "c4" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ kind: "curate", layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  const meta = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "meta.json"), "utf-8"))
  // c4 pruned by the delete op; remaining active: c1(→universal), c2(vendor), c3(model)
  expect(meta.generalityRollup).toEqual({ universal: 1, vendor: 1, model: 1 })
})

test("applyCurateArtifact: no-op curation (empty ops) → no candidate, no trial", async () => {
  const root = path.join(home, "stores", "cur-noop")
  writeActive(root, "v1", "- b1", "", { version: 1, bullets: [
    { id: "b1", text: "b1", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-global", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "curate-project-global-v2-ops.json"), JSON.stringify({ ops: [] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(fakeHost(rec), descriptor({ kind: "curate", layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")   // identical playbook → skipped
  expect(readTrial(root)).toBeNull()
  expect(rec.logs.some((l) => l.includes("no-op curation"))).toBe(true)
})

// ── opencode inline parity: triggerPropose without stageArtifactApply ────────

test("triggerPropose (opencode path): no stageArtifactApply → waits inline, applies via the extracted body", async () => {
  const root = path.join(home, "stores", "oc")
  bootstrapStore(root, "- baseline") // v0 candidate + active → nextVersion = v1
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  // seedPlaybook auto-seeds playbook mode from the baseline, so the proposer's
  // primary artifact is ops.json. Pre-seed it so inline waitForFile returns at once.
  // RG3 adaptation: renamed to a layer1-passing trigger-form bullet (bare
  // "inline-applied rule" fails the trigger-form check); no assertion below
  // depends on the exact text.
  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v1-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "When an inline apply happens, apply the inline-applied rule." }] }))

  const rec: Rec = { notes: [], logs: [] }
  // Host WITHOUT stageArtifactApply/proposerInFlight → opencode inline path.
  await triggerPropose(reviewPassHost(rec), worktree, layer)

  expect(listVersions(root)).toContain("v1")
  expect(readTrial(root)).not.toBeNull()
  expect(rec.notes.some((n) => n.includes("Trial started"))).toBe(true)
})

test("triggerPropose (CC path): stageArtifactApply present → defers, no inline apply, descriptor handed over", async () => {
  const root = path.join(home, "stores", "ccdefer")
  bootstrapStore(root, "- baseline") // → nextVersion = v1
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  // Seed the artifact too — to prove the CC path does NOT apply inline even when present.
  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v1-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "should-not-apply-inline" }] }))

  let staged: StagedArtifactDescriptor | undefined
  const rec: Rec = { notes: [], logs: [] }
  const host = fakeHost(rec, { stageArtifactApply: (d) => { staged = d } })
  await triggerPropose(host, worktree, layer)

  // Deferred: candidate NOT created inline; descriptor captured.
  expect(listVersions(root)).not.toContain("v1")
  expect(staged).toBeDefined()
  expect(staged!.kind).toBe("propose")
  expect(staged!.version).toBe("v1")
  expect(staged!.layer.root).toBe(root)
  expect(staged!.playbookMode).toBe(true)
  // Artifact still on disk (will be applied on a later event).
  expect(fs.existsSync(path.join(b, "project-role-v1-ops.json"))).toBe(true)
})

test("triggerPropose: proposerInFlight true → skips (cross-process double-fire guard)", async () => {
  const root = path.join(home, "stores", "inflight")
  writeActive(root, "v1", "- baseline", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  let spawned = 0
  const rec: Rec = { notes: [], logs: [] }
  const host = fakeHost(rec, {
    proposerInFlight: () => true,
    runTaskAgent: async () => { spawned++; return { id: "x" } },
    stageArtifactApply: () => {},
  })
  await triggerPropose(host, worktree, layer)

  expect(spawned).toBe(0)
  expect(rec.logs.some((l) => l.includes("already has a session in flight"))).toBe(true)
})

// ── applyProposeArtifact: review gate (RG3) ─────────────────────────────────
// Behavior contract from .superpowers/sdd/rg3-brief.md — one test per bullet.

test("review gate 1: all added bullets pass review → candidate + trial created exactly as before", async () => {
  const root = path.join(home, "stores", "rg-pass")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "When a review passes, stage the reviewed rule." }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(reviewPassHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  expect(readTrial(root)).not.toBeNull() // project layer → trial as before
  const pb = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "playbook.json"), "utf-8"))
  expect(pb.bullets.some((x: { text: string }) => x.text === "When a review passes, stage the reviewed rule.")).toBe(true)
})

test("review gate 2: added bullet final-fails → NO candidate, NO trial, ledger entry, notify contains review-rejected", async () => {
  const root = path.join(home, "stores", "rg-reject")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  // No "When …"/"Do not … until …" trigger form → layer1 free-fails without
  // any LLM call, so this reaches "final-fail" deterministically (no revision
  // is attempted for a layer1 fail — review-gate.ts's revise() abstains
  // immediately on a layer1 violation).
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: "generic rule with no trigger form" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(noLlmHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")
  expect(readTrial(root)).toBeNull()
  const ledger = readRejectedLedger(root)
  expect(ledger.length).toBe(1)
  expect(ledger[0]!.bullet).toBe("generic rule with no trigger form")
  expect(ledger[0]!.source).toBe("review-gate")
  expect(ledger[0]!.scope).toBe("project-role")
  expect(ledger[0]!.violations.length).toBeGreaterThan(0)
  expect(rec.notes.some((n) => n.includes("review-rejected"))).toBe(true)
})

test("review gate 3: a bullet revised by review replaces the original text in the staged playbook", async () => {
  const root = path.join(home, "stores", "rg-revise")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const ORIGINAL = "When a flaky test fails once, retry it before reporting failure."
  const REVISED = "When a flaky test fails once, retry it and log the retry before reporting failure."
  const REVISE_REPLY = `{"action":"propose","reason":"tightened wording","bullet":{"text":"${REVISED}"}}`

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "add", text: ORIGINAL }] }))

  const rec: Rec = { notes: [], logs: [] }
  // rubric fail on round 0 → revise (layer1 passed, so an LLM revision call
  // happens) → rubric pass on the revised text.
  const res = await applyStagedArtifact(
    scriptedHost(rec, [REVIEW_FAIL, REVISE_REPLY, REVIEW_PASS]),
    descriptor({ layer, version: "v2", playbookMode: true }),
  )

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  const pb = JSON.parse(fs.readFileSync(candidatePath(root, "v2", "playbook.json"), "utf-8"))
  expect(pb.bullets.some((x: { text: string }) => x.text === REVISED)).toBe(true)
  expect(pb.bullets.some((x: { text: string }) => x.text === ORIGINAL)).toBe(false)
  const sys = fs.readFileSync(candidatePath(root, "v2", "system.md"), "utf-8")
  expect(sys).toContain(REVISED)
  expect(sys).not.toContain(ORIGINAL)
})

test("review gate 4: legacy (non-playbook) proposal → review skipped, log contains skipped (legacy mode)", async () => {
  const root = path.join(home, "stores", "rg-legacy")
  writeActive(root, "v1", "- baseline rule", "")
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-system.md"), "- improved rule\n")

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(noLlmHost(rec), descriptor({ layer, version: "v2" })) // playbookMode: false (default)

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2")
  expect(readTrial(root)).not.toBeNull() // behavior otherwise unchanged
  expect(rec.logs.some((l) => l.includes("review-gate") && l.includes("skipped (legacy mode)"))).toBe(true)
})

test("review gate 5: proposal with only non-add ops → review skipped (no added bullets)", async () => {
  const root = path.join(home, "stores", "rg-noadd")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"),
    JSON.stringify({ ops: [{ op: "update", id: "b1", text: "b1 rule", generality: "vendor", slice: "acme" }] }))

  const rec: Rec = { notes: [], logs: [] }
  const res = await applyStagedArtifact(noLlmHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).toContain("v2") // update-only op still applies as before
  expect(rec.logs.some((l) => l.includes("review-gate") && l.includes("skipped (no added bullets)"))).toBe(true)
})

test("review gate 6: no-op proposal → review runs AFTER the no-op guard, zero runTextAgent calls", async () => {
  const root = path.join(home, "stores", "rg-noop")
  writeActive(root, "v1", "- b1 rule", "", { version: 1, bullets: [
    { id: "b1", text: "b1 rule", status: "active", helpful: 0, harmful: 0 },
  ] })
  const layer: StoreLayer = { root, scope: "project-role", higherRoots: [] }

  const b = stagingBase()
  fs.writeFileSync(path.join(b, "project-role-v2-ops.json"), JSON.stringify({ ops: [] }))

  const rec: Rec = { notes: [], logs: [] }
  // noLlmHost throws if runTextAgent is ever invoked — the no-op guard must
  // return before the review gate is reached, so this must not throw.
  const res = await applyStagedArtifact(noLlmHost(rec), descriptor({ layer, version: "v2", playbookMode: true }))

  expect(res).toBe("applied")
  expect(listVersions(root)).not.toContain("v2")
  expect(rec.logs.some((l) => l.includes("no-op proposal"))).toBe(true)
})
