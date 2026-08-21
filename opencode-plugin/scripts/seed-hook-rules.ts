// Task 6: seed the hook-rule lane — 4 structural, portable-subset shadow
// rules mapped 1:1 to measured incident classes (CLAUDE.md store-deletion
// rule, ndjson truncation, blind store-sync export 2026-08-17 split-brain,
// shared-branch history rewrite). Ops carry no `mode` — the store stamps
// "shadow" on every add (harness-store.ts applyPlaybookOps); screenHookRule
// rejects any op that tries to smuggle `mode` in.
//
// All four literal patterns from the brief needed a portable-subset fix to
// clear screenHookRule's anchor gate (^-leading OR $-terminal per
// hook-rule-screen.ts's isPortablePattern/anchor check) AND, per review
// (2026-08-22), to not be compound-command blind: `^pattern` alone misses
// the routine `cd x && rm ...` / `... | tail` / `a && b` shapes real agent
// turns actually run, which would silently degrade the shadow lane's
// denominator (rules exist to collect match data — a rule that only fires
// on the bare, unchained form undercounts). Fixed by allowing an optional
// `(.*[;&|] *)?` separator-gated prefix (rules 0/3) or dropping the
// requirement that the match reach the literal end of the command (rules
// 1/2, via a leading `^.*` instead of a trailing `$`) so mid-command and
// tail-piped occurrences still match. Verified against the brief's
// must/must-not table PLUS compound-command probes and a mid-word decoy
// under the real evalHookRules (test/seed-hook-rules-patterns.test.ts).
import type { PlaybookOp } from "../src/harness-store.ts"
import { applyAuthoredOps } from "./authored-ops.ts"

export const SEED_OPS: PlaybookOp[] = [
  // Incident class: store deletion/overwrite without reading (CLAUDE.md rule;
  // poisoned-rejected.json + v0-junk-bak precedents). Optional leading
  // `(.*[;&|] *)?` catches `cd /tmp && rm -rf .kkamak/global`-shaped compound
  // commands without matching the mid-word decoy `echo confirm .kkamak/global`
  // (no `;`/`&`/`|` separator precedes the accidental "rm" substring there).
  { op: "add",
    text: "Do not delete or move evolution-store paths until you have read the target and named what it holds.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^(.*[;&|] *)?(rm|mv) .*(kkamak|rejected.json|candidates/|.km/)",
      feedback: "Store state: read the target first (ls/cat), prefer archiving over deleting." } },
  // Incident class: single-> redirect truncating append-only ndjson stores.
  // Leading `^.*` (not a trailing `$`) so a trailing `&& ls` / pipe after the
  // redirect still matches — the redirect need not be the last thing on the line.
  { op: "add",
    text: "Do not overwrite an append-only ndjson store with a bare redirect; append or write a new file.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^.*[^>]> *[a-zA-Z0-9_./-]*ndjson",
      feedback: "That ndjson is append-only telemetry — a single > truncates it." } },
  // Incident class: blind store-sync export (measured 381-deletion split-brain, 2026-08-17).
  // Leading `^.*` so `store-sync.sh export 2>&1 | tail -5` (piped/redirected
  // tail) still matches, not just the bare invocation.
  { op: "add",
    text: "Do not run a bulk store-sync export without reviewing the diff first.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^.*store-sync.sh +export",
      feedback: "Blind export is the data-loss trap — diff first, sync surgically." } },
  // Incident class: history rewrite on shared main (repo rule: explicit go).
  // Same optional separator-gated prefix as rule 0, so `cd repo && git push
  // origin main --force` matches.
  { op: "add",
    text: "Do not force-push or hard-reset shared branches without an explicit go.",
    hookRule: { event: "PreToolUse", toolMatcher: "Bash",
      inputPattern: "^(.*[;&|] *)?git .*(push[^|]*--force|reset +--hard +origin)",
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
