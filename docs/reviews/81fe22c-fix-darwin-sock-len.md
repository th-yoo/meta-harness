# Review artifact — fix-darwin-sock-len (darwin sun_path test sockets + probe timeout fallback)

reviewed-range: 7dcfd05b14ef6c769fff2fad0b87fdb3ee8ffccb..81fe22cdf112be6d10e5ba96e2baa8c066358427
reviewer: fresh-context-fable-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

Two-commit darwin-portability branch, first MacBook suite re-run after the
08-05 ACP merges. (Reviewer was dispatched on range 5ae2043..81fe22c — a
strict superset of this merge range 7dcfd05..81fe22c that additionally
covers only the docs-only handoff commit 7dcfd05; the two code commits
reviewed are exactly this range's.) `ba148e7`: 35 darwin test failures (33 cc-gate-plugin,
2 opencode-plugin) had ONE root cause — AF_UNIX `sun_path` caps socket
paths at 104 bytes on darwin, and the test helpers' long
`kkamak-acp-<file>-<tag>-<pid>-<Date.now()>-<rand>` names under darwin's
~49-byte `/var/folders` tmpdir reached ~121 bytes; bind fails, the ACP
client maps the dead socket to `no-call`, and every fake-daemon test
silently degrades into the fallback leg (warm seat tests resolved via api
fallback instead of the warm lane). Fix: shared
`cc-gate-plugin/test/sock-path.ts` (`shortBase`/`shortSock`, pid+6 random
base36 uniqueness, hard 100-byte `Buffer.byteLength` assert that throws
loud instead of degrading), all four socket-building test helpers routed
through it. `81fe22c`: `probe_models` died exit 127 on stock darwin (no
coreutils `timeout`); `command -v` fallback timeout → gtimeout → bare.

Review independently traced: all four call sites use distinct tags (random
suffix is belt, not load-bearing); no test parses/asserts the socket-name
format (grepped toMatch/toContain/startsWith/endsWith); 100B assert is a
live byte measurement against the host tmpdir, safely under the 104B cap
incl. NUL; `.spawnlog`/lock siblings are plain files, not bind targets, so
their length is irrelevant; no production socket-path construction touched
(prod default `~/.config/kkamak/acp-*.sock` ≈ 40B); `acp-paths`/`acp-pool`
tests use short literals, explaining why they never failed; no other
`tmpdir()`+`.sock` construction remains in either plugin's tests. Probe
fix: `local TO=""` is set-u-safe, unquoted `$TO` word-splitting is the
intended mechanism, Linux behavior byte-identical (`timeout` resolves),
`maxRetries: 0` single-shot probe-fidelity rule untouched.

Verdict findings: 0 Critical, 0 Important, 0 Minor at reporting bar. One
informational note recorded: `opencode-plugin/tsconfig.json` includes only
`src/`, so `test/`'s cross-package imports are never typechecked — a
PRE-EXISTING exposure (same lines already import `fakeDaemon`/`stubServer`
cross-package), not a regression of this range.

Suites at reviewed tip on darwin: cc-gate-plugin 1043/0, opencode-plugin
1776/1 skip, tsc clean both (expected office parity restored). Premium
probe live result on this host post-fix: haiku=OK, sonnet=429, opus=429.
