// Task 6: seed the hook-rule lane — 4 structural, portable-subset shadow
// rules mapped 1:1 to measured incident classes (CLAUDE.md store-deletion
// rule, ndjson truncation, blind store-sync export 2026-08-17 split-brain,
// shared-branch history rewrite). Ops carry no `mode` — the store stamps
// "shadow" on every add (harness-store.ts applyPlaybookOps); screenHookRule
// rejects any op that tries to smuggle `mode` in.
//
// Three of the brief's four literal patterns needed a portable-subset fix to
// clear screenHookRule's anchor gate (^-leading OR $-terminal per
// hook-rule-screen.ts's isPortablePattern/anchor check) — see the per-rule
// comments below. Verified against the brief's match/no-match table under
// the real evalHookRules (test/seed-hook-rules-patterns.test.ts).
import type { PlaybookOp } from "../src/harness-store.ts"
import { applyAuthoredOps } from "./authored-ops.ts"

export const SEED_OPS: PlaybookOp[] = [
  // Incident class: store deletion/overwrite without reading (CLAUDE.md rule;
  // poisoned-rejected.json + v0-junk-bak precedents). Already ^-anchored —
  // unchanged from the brief.
  { op: "add",
    text: "Do not delete or move evolution-store paths until you have read the target and named what it holds.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^(rm|mv) .*(kkamak|rejected.json|candidates/|.km/)",
      feedback: "Store state: read the target first (ls/cat), prefer archiving over deleting." } },
  // Incident class: single-> redirect truncating append-only ndjson stores.
  // DEVIATION: brief's pattern had no ^ and no terminal $, so it was rejected
  // by screenHookRule's anchor check (hook-screen:pattern-unanchored). Added
  // a trailing `$` (file paths are the tail of a redirect command anyway).
  { op: "add",
    text: "Do not overwrite an append-only ndjson store with a bare redirect; append or write a new file.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "[^>]> *[a-zA-Z0-9_./-]*ndjson$",
      feedback: "That ndjson is append-only telemetry — a single > truncates it." } },
  // Incident class: blind store-sync export (measured 381-deletion split-brain, 2026-08-17).
  // DEVIATION: same anchor problem as above — added a trailing `$` (the
  // subcommand is the tail of the invocation).
  { op: "add",
    text: "Do not run a bulk store-sync export without reviewing the diff first.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "store-sync.sh +export$",
      feedback: "Blind export is the data-loss trap — diff first, sync surgically." } },
  // Incident class: history rewrite on shared main (repo rule: explicit go).
  // DEVIATION: same anchor problem — added a leading `^` (matches the brief's
  // own style for rule 1; the command always starts with `git`).
  { op: "add",
    text: "Do not force-push or hard-reset shared branches without an explicit go.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^git .*(push[^|]*--force|reset +--hard +origin)",
      feedback: "History rewrite on a shared branch needs an explicit go." } },
]

if (import.meta.main) {
  const r = applyAuthoredOps({
    storeRoot: ".kkamak/global",
    repoRoot: process.cwd(),
    ops: SEED_OPS,
    provenance: "seed-hook-rules-20260822",
  })
  if (!r.applied) { console.error("REFUSED:\n  " + r.refusals.join("\n  ")); process.exit(1) }
}
