# Review artifact — darwin-rss-measure (RSS probe darwin port + MacBook measurement)

reviewed-range: aaa6f1653b1bd5b53d9ecfc7ae6180ef8990e187..ca2e6898be63a4a7fc69008b39d04eb8afdbbe96
reviewer: fresh-context-fable-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One-commit branch: `cc-gate-plugin/test/warm-session-rss-measure.ts` was
/proc-only, so on darwin every reader silently returned `0`/`[]` and a run
would print a 0 MB measurement that looks real. Platform-branched three
readers (`vmRssKb` → `ps -o rss=`; `directChildren` → `ps -axo pid=,ppid=`
scan; `memAvailableKb` → `vm_stat` free+inactive approximation,
informational only) and appended the MacBook measurement section to
`docs/2026-08-05-warm-session-rss.md` (~330 MB/warm session marginal —
same band as WSL2; recycle flat +1.9 MB inside the 2 MB noise band; cap
ruling: `KKAMAK_ACP_MAX_SESSIONS` stays 4 on this 16 GB host, 8 NOT
permissible here).

Review verified: darwin `ps -o rss=` reports KB with `=` header
suppression and non-zero-exit→0 mapping matching the linux ENOENT→0
behavior; BSD ps reports rss=0 for zombies so the `vmRssKb>0` aliveness
test cannot SIGTERM or hang on a zombie in `waitForExit`/`forceCleanup`;
`-a`+`-x` covers detached/daemonized children; BFS `seen` set bounds the
descendant walk even under pid-reuse/self-parent edge cases; vm_stat
regexes match the long-stable output format and the value is
informational-only per the doc's caveats; the doc's MacBook arithmetic is
internally consistent with what the code measures; nothing outside the
probe script and the doc is in scope. Reviewer had no shell and could not
byte-verify the linux /proc branch unchanged; controller closed that gap
with `git diff aaa6f16..ca2e689` — the only removed lines are two doc
comment lines (reworded for both platforms), all /proc logic byte-intact.

Suites at reviewed tip on darwin: cc-gate-plugin 1043/0, opencode-plugin
1776/1 skip, tsc clean both — AND both suites additionally proven with
`KKAMAK_SEAT_PROVIDER=anthropic-cli-warm` set (activated-state proof per
the 2026-08-01 adoption-ledger standing rule, ahead of warm-lane
activation on this host). The probe file itself has no describe/test and
is outside the test glob.
