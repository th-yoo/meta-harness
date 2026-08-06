# Review artifact — promote-acp (ACP subsystem promoted out of gauge/, stage one of npm extraction)

reviewed-range: e63d9202fda5cef282327992daf45a3ec284fb49..4fc2cf1
reviewer: fresh-context opus whole-branch reviewer + two scoped reviewers
fresh-context: true
verdict: approved
findings-count: 5 (0 Critical, 0 Important, 5 Minor — 3 fixed, 2 deferred)

Two independent pieces on this branch, plus two merges from main.

**`cc56cc8` — the promotion.** Six modules (`acp-wire`, `acp-paths`,
`acp-pool`, `acp-daemon`, `acp-client`, `warm-session`) moved from
`cc-gate-plugin/src/gauge/` to `cc-gate-plugin/src/acp/`, recorded by git as
R100 pure renames, plus a new `src/acp/index.ts` declaring the public surface
(`ensureDaemon`, `daemonCall`, `DaemonOutcome`, `WarmIsolation`,
`modelProvenBy`). Rationale: those six import nothing from the rest of the
repo — only node builtins, each other, and `@anthropic-ai/claude-agent-sdk` —
and exactly three production call sites cross the seam, one of them
type-only. This is stage one of a planned extraction to its own repo and npm
package (`@th-yoo/cc-api-daemon`); doing the seam in place means the
extraction is a directory move plus a package.json rather than archaeology.
It stays INSIDE the plugin dir deliberately: `claude plugin install` copies
only the plugin directory, so a top-level `acp/` would be unreachable from
the installed copy until published, degrading the warm lane and forcing a new
seat-regime boundary.

**`3881178` — a pre-existing test-isolation fix.**
`cc-gate-plugin/test/anthropic-cli-warm.test.ts` asserted the process-global
provider registry was empty. `minimal/llm-acp.ts:120` registers
`anthropic-cli-warm` into that registry (`send-prompt.ts:81`), bun runs all
test files in one process, and the registry is never reset — so the assertion
only held when the file ran without `minimal/llm-acp.ts` present. Verified
failing at `8c53f46` AND `e010c44`, both before this branch's work: not a
regression from the promotion. Only a repo-root `bun test` puts both files in
one process, which is why per-package runs and the gate's per-package tiers
never surfaced it. Fixed by asserting a same-tick before/after delta around
the synchronous factory call instead of global emptiness.

**`4fc2cf1` — review follow-ups**, three Minors from the whole-branch review:
the `gate-check-core` unit-test fixture now asserts over real `src/acp/`
paths (it previously proved the pull-in rules only over paths that no longer
exist); a duplicated import in `anthropic-cli-warm.ts` merged; and
`send-prompt.ts`'s header now states that its `import type` of the ACP barrel
is load-bearing — the barrel value-re-exports `acp-client.ts`, so widening it
to a value import would silently break the module's documented isolation
while the old comment still read as satisfied.

Constraints verified by the whole-branch reviewer, several by execution
rather than inspection: no production behaviour change (the only non-test
source edits on the branch are three import lines and comment blocks);
`cc-gate-plugin/src/core/` and `vendor/` — the MECHANISM_PATHS — untouched,
so no calibration staleness; every production importer of `src/acp/` goes
through `index.ts`; `src/acp/` still imports nothing from the repo, which is
the property the npm extraction depends on. The gate's slow-source pull-in
survived the move because its patterns are basename-anchored
(`/(^|\/)acp-daemon\.ts$/`) — confirmed by running
`slowCcgateTestsForChangedPaths` against the new paths, not by reading the
regexes. `acp-client.ts:327`'s `DAEMON_ENTRY` is a module-relative sibling
resolve and moved with the file.

Suite at the reviewed tip: 3111 pass / 12 skip / 0 fail; `tsc --noEmit`
silent in all three packages; doc-check 163 files / 0 violations.

DEFERRED (2 Minor, neither blocking):

1. `src/acp/index.ts` has no tier-0 blocking coverage — TIA maps
   `^cc-gate-plugin/` to `ccgate`, whose tier 0 excludes the slow ACP tests,
   so renaming an export in the seam file would not be caught before the
   background debt gate. This sits inside `gate-check-core.ts:146-149`'s
   documented decision not to chase two-hop chains, with the bg debt gate
   named as the safety net. Adding an `index.ts` rule is a gate-policy change
   and carries the `KKAMAK_DEV_CHECKS` drift-guard obligation — it belongs to
   whoever owns the gate, not to this branch.
2. The rewritten registry test cannot catch a hypothetical UNCONDITIONAL
   top-level `registerProvider` added to `anthropic-cli-warm.ts`, since this
   test file imports that module before the snapshot is taken. Inherent to
   any reset-free order-independent design. Moot today: that module contains
   zero `registerProvider` calls.

KNOWN WART, deliberately left for the extraction: `GAUGE_ISOLATION` still
lives in `acp-wire.ts` — a gauge-specific constant inside what is meant to
become a standalone package. Not exported from `index.ts`, no production
consumer outside `src/acp/`, and documented in `index.ts` as a publish-time
problem rather than a merge-time one.

NOT THIS BRANCH, flagged so it is not mistaken for move damage:
`src/acp/acp-paths.ts:2-4` claims `hook-cli.ts` imports `acp-client.ts` on
SessionStart; `hook-cli.ts` contains no ACP reference at all. Stale in the
byte-identical pre-move file.
