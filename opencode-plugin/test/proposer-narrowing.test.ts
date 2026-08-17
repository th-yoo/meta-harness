import { test, expect } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import * as os from "node:os"
import { buildProposerPrompt } from "../src/propose.ts"
import { buildReviewPrompt } from "../../minimal/review.ts"
import { narrowingInvitedText } from "../src/review-gate.ts"
import { writeActive, type StoreLayer, type RejectedEntry } from "../src/harness-store.ts"

// Token-free render tests for the rule-8 exception surfaces (gauntlet spec):
// a narrowing-stamped ledger entry must (1) leave the proposer's do-not-
// re-derive list and appear under the narrowing-invited heading, (2) reach
// the reviewer prompt as a "Narrowing INVITED" section with the duplicate-
// check exception, and (3) the guards section must carry the V-B scope
// requirement.

function tmpDir(name: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `mh-narrowing-${name}-`))
}

const STAMPED: RejectedEntry = {
  rejectedAt: "2026-08-16",
  scope: "account-global",
  version: "v2",
  bullet: "When the same end-to-end attempt fails twice with an identical uninformative symptom, do not start a third attempt until you have read the artifact bytes.",
  violations: ["duplicate: failed"],
  source: "review-gate",
  narrowing: {
    invited: true,
    mechanism: "predicted-improve tasks came true (net +3) while strong guards regressed (net -8)",
    attributedBy: "operator:gen-2-trajectory-investigation",
  },
}

const PLAIN: RejectedEntry = {
  rejectedAt: "2026-08-14",
  scope: "account-global",
  version: "v1",
  bullet: "When reverse-engineering a binary, do not scale to the full input until a single case passes.",
  violations: ["leak: path-like or file-extension token"],
  source: "review-gate",
}

function renderProposer(ledger: RejectedEntry[], guards?: unknown[]): string {
  const worktree = tmpDir("worktree")
  const storeRoot = tmpDir("store")
  writeActive(storeRoot, "v1", "- some rule", "")
  fs.writeFileSync(path.join(storeRoot, "rejected.json"), JSON.stringify(ledger, null, 1))
  if (guards) fs.writeFileSync(path.join(storeRoot, "guards.json"), JSON.stringify(guards, null, 1))
  const layer: StoreLayer = { root: storeRoot, scope: "account-global", higherRoots: [] }
  const base = path.join(worktree, ".kkamak", "staging")
  return buildProposerPrompt(
    layer, "v9", "",
    path.join(base, "s.md"), path.join(base, "t.md"), path.join(base, "d.json"),
    path.join(base, "o.json"), path.join(base, "a.json"), path.join(base, "e.json"),
    worktree, null,
  )
}

test("proposer prompt: narrowing-stamped entry moves to the invited block, out of do-not-re-derive", () => {
  const prompt = renderProposer([STAMPED, PLAIN])
  expect(prompt).toContain("TRIGGER OVERREACH with the mechanism CERTIFIED")
  expect(prompt).toContain("rule-8 exception")
  expect(prompt).toContain(STAMPED.narrowing!.mechanism)
  // The stamped bullet must appear ONLY under the invited heading — never in
  // the do-not-re-derive block.
  const rederiveIdx = prompt.indexOf("do NOT re-derive or rephrase")
  const rederiveBlock = prompt.slice(rederiveIdx, prompt.indexOf("##", rederiveIdx + 10))
  expect(rederiveBlock).not.toContain("identical uninformative symptom")
  expect(rederiveBlock).toContain("reverse-engineering a binary")
})

test("proposer prompt: no stamped entries => no invited block", () => {
  const prompt = renderProposer([PLAIN])
  expect(prompt).not.toContain("rule-8 exception")
})

test("proposer prompt: guards section carries the V-B scope requirement", () => {
  const prompt = renderProposer([PLAIN], [{ task: "polyglot-rust-c", rate: 1.0, n: 5 }])
  expect(prompt).toContain("SCOPE REQUIREMENT")
  expect(prompt).toContain("OBSERVABLE RUN-STATE")
  expect(prompt).toContain("mutates graded state")
})

test("narrowingInvitedText: renders stamped entries only, undefined when none", () => {
  expect(narrowingInvitedText([PLAIN])).toBeUndefined()
  const text = narrowingInvitedText([STAMPED, PLAIN])!
  expect(text).toContain("identical uninformative symptom")
  expect(text).toContain("operator:gen-2-trajectory-investigation")
  expect(text).not.toContain("reverse-engineering")
})

test("reviewer prompt: narrowingInvited param renders the exception section + amended duplicate check", () => {
  const withBlock = buildReviewPrompt({
    bullet: "When a check fails twice with the same symptom on the same artifact, read the artifact bytes before a third attempt.",
    reason: "diag",
    harness: "- rule",
    rejected: "(none recorded)",
    taskId: "",
    narrowingInvited: narrowingInvitedText([STAMPED]),
  })
  expect(withBlock).toContain("## Narrowing INVITED")
  expect(withBlock).toContain("STRICTLY NARROWER")
  expect(withBlock).toContain("EXCEPTION: if the closest match is listed")
  const without = buildReviewPrompt({
    bullet: "b", reason: "r", harness: "h", rejected: "(none recorded)", taskId: "",
  })
  expect(without).not.toContain("## Narrowing INVITED")
  // The duplicate-check text always documents the exception path so the
  // rubric parses identically either way.
  expect(without).toContain("EXCEPTION: if the closest match is listed")
})
