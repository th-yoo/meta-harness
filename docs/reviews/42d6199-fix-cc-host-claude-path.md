# Review artifact — fix-cc-host-claude-path (bare "claude" argv[0] vs launchd PATH)

reviewed-range: fd9456f8d8867dbaa00ba7eca3960308d5bfb06e..42d61996e22e1206707e44dc50fceefa644ef8cc
reviewer: fresh-context-fable-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One-commit branch (built in an isolated worktree per user direction).
Defect: the daily km-crank sweep runs under launchd's minimal PATH; both
cc-host spawn seams (judge `runTextAgent`, detached proposer
`runTaskAgent`) passed bare `"claude"` as argv[0], and Bun resolves
argv[0] against the PATH captured at PROCESS START — every detached
proposer spawn on yoo-mac failed 4/4 days (`Executable not found in
$PATH: "claude"`, ~/.config/kkamak/runtime/cc/hook.log 2026-08-02..05).
The failure was silent-degradation grade: runTaskAgent logs a warn and
returns null, so the proposer lane simply never ran on this host.

Fix: exported `resolveClaudeArgv` (order: `KKAMAK_CLAUDE_BIN` override →
`Bun.which` → HOME/.local/bin → /usr/local/bin → /opt/homebrew/bin →
bare name unchanged so the original error still surfaces when nothing
resolves), applied inside BOTH real default spawn functions only —
injected test spawns keep seeing the bare `"claude"` argv contract, so
zero churn on existing assertions. 6 unit tests pin the contract; the
module-scoped Bun ambient type gains `which`.

Review independently traced: resolution order + early return correct
(each step has its own non-tautological test, incl. probe-order capture
and the missing-HOME guard against "undefined/..." paths); the env
divergence between the seams is sound (judge spawn passes no env to
Bun.spawn, which then inherits process.env — probe env and child env are
the same object; task spawn threads opts.env into both, and production
childEnv copies process.env so HOME/PATH always present); no other code
depends on argv[0] being literally "claude" (log strings hardcoded,
MH_CHILD_ENV independent); Bun ambient signature is a valid subset.

Verdict findings: 0 Critical, 0 Important. One informational note
(deferred, out of scope): `opencode-plugin/src/bench/drivers/
claude-code.ts:257,279` also emits bare "claude" argv[0], but in the
podman TB2 container context where a minimal-PATH failure is not
evidenced — not touched.

Suites at reviewed tip (worktree, darwin): opencode-plugin 0 fail
(1694 tests / 12 skip in the worktree environment) + tsc clean.
