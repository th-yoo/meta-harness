# Review artifact — gauge-cliwarm-swap (the last dogfood consumer)

reviewed-range: ec424729c690fcd92235e4468dfb230ac9175c92..520022ad5c53507aa04e4f7b3caeaafbcb8c198f
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 1

The final consumer in the dogfood plugin moves off the in-repo ACP client onto the
published `@th-yoo/cc-api-daemon`. `cc-gate-plugin` IS the installed plugin
(`kkamak@kkamak-local`, source `/Users/yoo/z2/meta-harness/cc-gate-plugin`), so after this
range every runtime ACP consumer in the dogfood path runs on the package and
`cc-gate-plugin/src/acp/` is purely historical — retained, still tested, no longer called.

**`797ae3b`** — repoints `gauge/providers/anthropic-cli-warm.ts`, routed through
`src/acp-client-singleton.ts` rather than importing the package directly. That was the
right call: the singleton exists precisely so one plugin process talks to ONE daemon
(discovery is keyed by `envFingerprint`, so two consumers with slightly different envs
reach different daemons, each with its own pool and ~330MB/session RSS), and its own
header already named this file as the future second consumer. Also ports
`test/anthropic-cli-warm.test.ts` onto the package's WebSocket fake.

**`69a938e`** — ports `opencode-plugin/test/minimal-llm-acp.test.ts`. Not optional: that
file drives `seatCall` -> this provider, so the swap broke it (1869/2 fail). The two
mechanisms it isolated with were both dead against the new client — `KKAMAK_ACP_SOCKET`
is retired upstream (on the fingerprint denylist, no implementation) and the in-repo fake
speaks unix sockets, not WebSocket.

**`520022a`** — the finding, below.

## A budget cliff that became live at the moment of the swap

The new client returns `no-call` when the daemon's advertised `daemonWorstCaseMs`
(32 000) is `>=` the call's `budgetMs`; the old client had no such check. This provider
maps `sendOpts.timeoutMs` onto `budgetMs`, so post-swap ANY caller passing
`timeoutMs <= 32_000` would silently no-call forever, with no error. Today's only caller
passes 300 000 — luck, not a guarantee. A guard now catches it before `ensureDaemon`,
reading the floor live off the package's exported `ACP_BUDGET.daemonWorstCaseMs` rather
than hardcoding 32000, and logs both values. Reviewer confirmed the comparison mirrors the
client's own `>=` refusal and that its three tests fail if the guard is removed.

This is the same cliff that scoped down `docs/reviews/a499848-acp-budget-floor-guard.md`:
it was unreachable then because this file was still on the old client. The swap is what
made it reachable.

## A deliberate reversal, recorded

`minimal-llm-acp.test.ts` previously imported `envFingerprint` from the deep in-repo
`acp-paths.ts`, and an earlier proposal to move it was REJECTED with measurement — the two
implementations agree on a plain env but diverge once `ACP_IDLE_MS` is set (old hashes it,
new denylists it). That rejection was correct while the provider under test sat on the old
client. It no longer does, so the fake must match the package's fingerprint. The same
change that was wrong before is required now. Reviewer verified both denylists directly
rather than accepting the reasoning.

## Isolation, which stopped being theoretical

A live daemon was running on this host during the work (pid 88054, `127.0.0.1:51261`) with
a populated `~/.config/acpd/`. The package's `discoveryPath` falls back to `os.homedir()`
when `env.HOME` is absent, and a fake's `stop()` DELETES the discovery file it wrote — so a
mis-isolated test can destroy a real daemon's entry. Every env in both ported files now
carries a throwaway `HOME`; `cleanupTempHomes()`/`reapDaemons()` run in `afterEach`; and
`resetAcpClientSingleton()` is called in both, since the provider now routes through a
process-wide singleton. The retired socket-name leak check was REPLACED, not deleted, by a
bidirectional delta check against the real `~/.config/acpd/`.

**Nothing was weakened to make tests pass** — verified explicitly, because two tests were
red before the port. Test 2 still asserts the warm lane serves the call with
`srv.captured.length === 0`; test 4 still asserts the call-consumed throw plus zero HTTP
(the no-double-spend pin). Both survived unedited.

## THE FINDING (Important, fixed in `520022a`)

Test 1 was redesigned rather than ported — its old mechanism (a broken
`KKAMAK_ACP_SOCKET` aimed at an unwritable path) has no successor. The redesign asserted
"no discovery file exists" immediately after `seatCall`. That could not detect the
regression it guards: `spawnDaemonProcess` is `Bun.spawn(...).unref()` and returns
instantly, so a real cold start could not have published discovery within the assertion
window — a near-deterministic FALSE PASS. Worse, in that scenario a real daemon would be
spawned carrying the host's ambient credentials and left orphaned for the full 900s idle
budget, untracked. Fixed by giving test 1 the `ACP_TEST_SPAWN_LOG` + `LIVE_DAEMONS`
backstop test 2 already used, so a regression is both detectable (`waitForLines`) and
reaped. The discovery assertions were kept alongside, not replaced.

Verified: `cc-gate-plugin` 1141 pass / 0 fail; `opencode-plugin` 1871 pass / 1
pre-existing skip / 0 fail; tsc clean in both; `git diff cc-gate-plugin/src/acp/` EMPTY;
no stray daemons and nothing left in the real `~/.config/acpd/`.

**Flake note:** a run with both suites executing CONCURRENTLY reported 2 cc-gate-plugin
failures — a real-daemon e2e at 21.6s and a subprocess check at exactly 5002.88ms.
Re-run alone: 1141/0. Same CPU-contention signature as the km-panic flake fixed in
`3fc52ab` and Lane A's false "gate exhausted" earlier. Do not run these two suites in
parallel on this host.
