# Review artifact — a1-cycle-tagging-port (implOnly / sameTurnCoEdit into cc-gate-plugin)

reviewed-range: 8bd7720c1210f53dfed366e31280c68dd04ace37..2cc4424a5739ed2ec9f684a2d89546bb9d10019f
reviewer: fresh-context-code-reviewer
fresh-context: true
verdict: approved
findings-count: 2

Ports A1 cycle tagging from the standalone kernel (`~/z2/kkamak` v0.6.0,
released same day with its own two-pass ralph-loop review lineage) into the
research build — the producer whose stream km-crank actually cranks on. Two
commits: `3397b71` (the port, 16 files, +33 tests RED-verified against
pre-port src) and `2cc4424` (review fix wave, classify parity).

**What ships.** PostToolUse's `tool_input.file_path` now reaches
`handlePostToolUse`; paths accumulate deduped in `CcGateState.touchedPaths`
(cap 200, `touchedTruncated` marks overflow, sticky). Cycle-CLOSING sensor
lines (stop accept/exhaust, prompt interrupted) carry derived
`implOnly`/`sameTurnCoEdit`; both ABSENT — never false — when the touched
set is empty or truncated; `skippedStop` diagnostic lines never carry them.
`gate.json` gains optional `testPathPattern` (malformed → default, never
throws, never disables). Version 0.4.2 → 0.4.3 in BOTH manifests in the
same range (the version-parity test caught a single-manifest bump live —
the 4 driven emission-conformance tests failed on `pluginVersion` mismatch
until package.json moved too).

**Binding constraints, all verified by the reviewer against file contents:**
telemetry-only (no `StopDecision`/state branch reads the tag machinery —
grep-confirmed the fields appear only in types/edits/classify/sensor);
privacy (raw paths never reach `buildSensorLine`; serialization tests
assert path substrings absent from the JSON line); absent-not-false
semantics pinned with the `"field" in obj` idiom; back-compat (legacy state
loads, `isInitialState` hardened per the checkMs precedent so a state
carrying only `touchedPaths` is never rmSync'd as initial-equivalent);
never-throw config discipline; no weakened existing assertions
(byte-compared pre/post).

**THE FINDINGS (round 1, both fixed in `2cc4424`, scoped re-review
ADDRESSED ×2 + approved):**
1. **Important — case-insensitivity silently dropped.** kkamak compiles
   every pattern with the `"i"` flag (its own tests pin
   `Tests/UnitTest1.cs` as a test path); the port compiled flag-less while
   its header claimed to mirror the kernel — capitalized .NET-style test
   dirs would classify as source, mislabeling `implOnly`. Fixed at both
   compile sites; pinned by 3 new case tests including the kernel's own
   canonical case.
2. **Minor — pattern-string divergences.** Plural filename forms
   (`tests.ts`, `foo_tests.go`, `component.specs.ts`) and `[^/]*$` tails
   lost in transcription; backslash normalization absent. Fixed by
   adopting the kernel's pattern verbatim — re-reviewer confirmed
   byte-identical to `~/z2/kkamak/src/kernel/classify.ts` — plus
   normalize-then-match order; all pinned. Re-review also cleared the one
   intentional design delta (compile-once vs kkamak's per-call recompile)
   as output-equivalent: no `g`/`y` flags, so no `lastIndex` state.

**MECHANISM_PATHS / instrument notes:** `src/core/` edits advance the
km-crank calibration mechanism rev — TM1-precedent telemetry-only class
(GA5 `checkMs` precedent): no gate decision changes, recorded pre-data
here. Additive sensor fields are metric-neutral for §4.3 (trial metrics
read cycles/blocks, never these fields); consumers scan.ts/score.ts parse
old and new lines alike (frozen-contract additive rule; the emission-
conformance suite bans no unknown fields — checked, not assumed).
Deploying the installed plugin (km-refresh) is a separate act from this
merge and stamps its own pluginVersion partition (0.4.3).

Suites at branch tip (darwin, worktree): cc-gate-plugin **1037 pass /
0 fail** (4806 expects, 58 files; baseline 1033 pre-fix-wave, 1028+5
before the parity fix), `tsc --noEmit` clean. RED-verification: the 33
port tests fail 8+1-module-error against pre-port src (stash/pop check).
Commits used explicit `git add <named files>` throughout — no `add -A`.
