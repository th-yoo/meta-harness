# P2 Task 1 — in-container CC capability probe

Gate decision for A3 (binding-arm mechanism) and A4 (turn-cap mechanism).
Per F2: commands, exit codes, marker presence, and counts only — no reply
or transcript text is recorded below.

Host: darwin (macOS), podman 5.8.5, image `localhost/mh-bench:latest`
(`claude --version` inside container: `2.1.207 (Claude Code)` — matches the
driver's pinned/captured-fixture version).

Container: created and started exactly as `cmd-run.ts`'s create step does
(`sandbox.ts` `buildCreateArgv`/`buildStartArgv` shape) — `podman create
--name <name> --init -v <auth mounts> -e IS_SANDBOX=1 -w /app
localhost/mh-bench:latest sleep infinity`, then `podman start <name>`.
Auth mounts came from the repo's own `prepareClaudeCodeAuth()`
(`opencode-plugin/src/bench/agent-auth.ts`) run via `bun` — the exact
mechanism `cmd-run.ts` uses for the claude-code driver (macOS branch:
Keychain item `Claude Code-credentials` exported into a fresh 0700 temp
dir, `.credentials.json` 0600, mounted rw at `/root/.claude`; plus a
read-only `/root/.claude.json` onboarding-gate mount and `IS_SANDBOX=1`
env). No host keychain data was copied anywhere outside the container;
the exported credential file was zero-shredded and the temp dir removed
after the probe (see Cleanup).

Container name: `p2-probe-1786010499` (removed at end of probe — see
Cleanup). Never pkill'd; removed by name via `podman rm -f -t 0`.

## Probe A — do Stop hooks in `/app/.claude/settings.json` fire under
one-shot `claude -p`?

Settings file copied to `/app/.claude/settings.json` (via `podman cp`,
after `podman exec <c> mkdir -p /app/.claude`):

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "touch /app/HOOK-FIRED && exit 0" } ] }
    ]
  }
}
```

Commands run (driver argv shape reproduced from
`opencode-plugin/src/bench/drivers/claude-code.ts:252` `buildArgv`, model
pinned to `claude-haiku-4-5` per spend authorization):

| # | Command | Exit code |
|---|---|---|
| 1 | `podman exec <c> mkdir -p /app/.claude` | 0 |
| 2 | `podman cp settings.json <c>:/app/.claude/settings.json` | 0 |
| 3 | `podman exec <c> cat /app/.claude/settings.json` (verify copy) | 0 |
| 4 | `podman exec -e IS_SANDBOX=1 -w /app <c> claude -p "reply with the word ok" --output-format stream-json --verbose --model claude-haiku-4-5 --dangerously-skip-permissions` | 0 |
| 5 | `podman exec <c> ls -la /app/HOOK-FIRED` | 0 |

**Marker present: YES.** `ls -la /app/HOOK-FIRED` returned exit 0 with a
0-byte file owned by root, timestamped after command #4. NDJSON event-type
counts from command #4's stdout (types only, no content): 4 `system`,
2 `assistant`, 3 `message`, 1 `text`, 1 `thinking`, 1 `rate_limit_event`,
1 `result` — 8 lines total, `num_turns:1` in the `result` event.

**Verdict A: Stop hooks DO fire under one-shot `claude -p`.**

## Probe B — is `--max-turns` supported in `-p` mode?

Step 1 (free, no model call) — check documented flags:

| Command | Exit code |
|---|---|
| `podman exec <c> claude --help > help.txt` | 0 |
| `grep -i max-turns help.txt` | 1 (no match) |
| `grep -i turns help.txt` | 1 (no match) |

`--max-turns` does not appear anywhere in `claude --help`'s Options list
for this CLI version (2.1.207).

Step 2 — live call with `--max-turns 1` appended to the same driver argv
(model `claude-haiku-4-5`):

| Command | Exit code |
|---|---|
| `podman exec -e IS_SANDBOX=1 -w /app <c> claude -p "reply with the word ok" --output-format stream-json --verbose --model claude-haiku-4-5 --dangerously-skip-permissions --max-turns 1` | 0 |

No stderr output; NDJSON stream well-formed (8 lines, same event-type
shape as Probe A's call above, `result` event present with
`num_turns:1`).

Step 3 (negative control, free, no model call) — confirm the CLI's parser
actually rejects genuinely-unknown flags before spawning a model call, so
that Step 2's exit 0 is meaningful evidence of acceptance rather than the
CLI silently swallowing anything:

| Command | Exit code |
|---|---|
| `podman exec -e IS_SANDBOX=1 -w /app <c> claude -p "reply with the word ok" --output-format stream-json --verbose --model claude-haiku-4-5 --dangerously-skip-permissions --this-flag-does-not-exist-xyz` | 1 |

stderr: `error: unknown option '--this-flag-does-not-exist-xyz'` (no
stdout, no NDJSON, no API call made — the parser fails fast on a truly
unrecognized flag).

**Verdict B: `--max-turns` is UNDOCUMENTED (absent from `claude --help`'s
Options list) but IS ACCEPTED by the CLI's argument parser in `-p` mode**
— the live call with `--max-turns 1` exited 0 with a well-formed
stream-json result, in contrast to the negative-control call with a
genuinely-unknown flag, which the same parser rejected immediately (exit
1, `error: unknown option ...`, before any model call). This probe did
not test *enforcement* (a task needing >1 turn to see whether the cap
actually truncates it) — only that the flag is parsed and does not error.

## Decision gate (per brief Step 4)

- **Probe A → hooks fire.** A3 = Stop-hook settings copy-in (Task 4's
  default path) is viable; no user ruling needed on this axis.
- **Probe B → `--max-turns` is accepted (not absent), though undocumented
  in `--help`.** Per the brief's literal gate ("`--max-turns` absent →
  A4's turn cap falls back to instruction text + recorded deviation"):
  it is not absent, so A4 can use `--max-turns` directly rather than
  falling back to instruction-text turn-cap phrasing. Flagged as a minor
  deviation from a strict reading of the brief's binary framing (help-text
  absence vs. actual CLI acceptance diverge here) — recorded, not silent;
  Task 4 should re-verify enforcement (not just acceptance) if the turn
  cap is load-bearing for A4's design.

## Cleanup

| Command | Exit code |
|---|---|
| `podman rm -f -t 0 p2-probe-1786010499` | 0 |
| `podman ps -a --filter name=p2-probe` (post-rm check) | 0, empty list |
| Zero-shred of exported `.credentials.json` (510 bytes) + `rm -rf` of the per-run auth temp dir | 0 |

No containers named `p2-probe*` remain on the host after this probe. The
exported Keychain credential temp dir was shredded and removed; nothing
was copied outside the container beyond that single per-run temp mount
source, which no longer exists.

## Spend

2 of 4 authorized `claude-haiku-4-5` calls used (Probe A's live call +
Probe B's `--max-turns` live call). Probe B's `--help` grep and the
negative-control unknown-flag call are free (no model invocation).

## Probe C (blocking consequence, post-C1 fix)

Final whole-branch review finding C1 (confidence 95): the A3 arm's
`assets/stop-gate-settings.json` shipped with `exit 1` in its Stop-hook
command. Claude Code hook semantics block a Stop event on **exit 2** only
(stderr fed back to the agent as continuation instructions); exit 1 is
non-blocking (agent stops normally, stderr shown to the user only) — see
`cc-gate-plugin/src/output.ts`'s `exit2-stderr` mode (`exitCode: 2`) and
`cc-gate-plugin/src/hook-cli.ts:10-11`. As shipped, the A3 arm never
blocked. Fixed to `exit 2` in the same commit as this probe (Part 1 of the
C1 fix wave). This probe verifies the CORRECTED asset actually blocks,
using the exact container/auth recipe from Probe A/B above
(`prepareClaudeCodeAuth()`, `sandbox.ts`'s argv builders, the claude-code
driver's `buildArgv` shape) — real spend, 1 of the 2 remaining authorized
`claude-haiku-4-5` calls (2 already consumed by Probe A/B above; this is
call 3 of the total 4-call budget).

Container: `mh-p2-probec-run-1786024920924-3063` (removed at end of probe
via `podman rm -f -t 0`; auth temp dir shredded and removed by
`prepareClaudeCodeAuth()`'s returned `cleanup()` — verified post-run: no
`p2-probe*`/`p2-probec*` container remains, no non-test
`mh-bench-cc-auth-*` temp dir newer than the probe remains).

Settings copied into the container were the repo's actual (post-fix)
`opencode-plugin/src/bench/p2/assets/stop-gate-settings.json` via
`buildCpToArgv` (not a hand-typed inline copy) — `cat` of the in-container
file confirmed it contains `exit 2` and does not contain `exit 1` before
the model call.

| # | Command | Exit code |
|---|---|---|
| 1 | `podman create --name <c> --init -v <auth mounts (/root/.claude.json ro, /root/.claude rw)> -e IS_SANDBOX=1 -w /app localhost/mh-bench:latest sleep infinity` | 0 |
| 2 | `podman start <c>` | 0 |
| 3 | `podman exec <c> mkdir -p /app/.claude` | 0 |
| 4 | `podman cp opencode-plugin/src/bench/p2/assets/stop-gate-settings.json <c>:/app/.claude/settings.json` | 0 |
| 5 | `podman exec <c> cat /app/.claude/settings.json` (verify: contains `exit 2`, does not contain `exit 1`) | 0 |
| 6 | `podman exec -e IS_SANDBOX=1 -w /app <c> claude -p "reply with the word ok" --output-format stream-json --verbose --model claude-haiku-4-5 --dangerously-skip-permissions` | 0 |
| 7 | `podman exec <c> ls -la /app/DONE-CHECK.txt` | 0 |
| 8 | `podman rm -f -t 0 <c>` | 0 |
| 9 | `podman ps -a --filter name=<c>` (post-rm check) | 0, empty |

**Marker present: YES.** `/app/DONE-CHECK.txt` exists after the run (`ls
-la` exit 0) even though the instruction given ("reply with the word ok")
never asked the agent to write it — the file only appeared because the
Stop-hook blocked the first stop attempt and fed the rule text back as
continuation instructions, and the agent then acted to satisfy the gate.

NDJSON event-type counts from command #6's stdout (types only, no
content, per F2): 38 lines total — `system`: 26, `assistant`: 7, `user`:
3, `rate_limit_event`: 1, `result`: 1 (`num_turns: 4`, `subtype:
"success"`). Contrast with Probe A/B's control shape above (immediate
stop: 8 lines, `num_turns: 1`, one `assistant`/`text` pair, no
DONE-CHECK.txt requirement in that hook's config) — Probe C's run took 4
turns and interleaved `system` events (hook feedback) with
`assistant`/`user` pairs, consistent with at least one Stop block-and-
reprompt cycle before the agent satisfied the gate and the run reached
`result`/`success`.

**Verdict C: the CORRECTED (`exit 2`) Stop-gate DOES block** — the run did
not terminate at the first Stop (`num_turns: 4` vs. the 1-turn control
shape), and `/app/DONE-CHECK.txt` exists post-run despite an instruction
that never mentioned it. The A3 binding mechanism is live after the C1
fix; not a no-op.

### Probe C cleanup

| Command | Exit code |
|---|---|
| `podman rm -f -t 0 mh-p2-probec-run-1786024920924-3063` | 0 |
| `podman ps -a --filter name=p2-probe` (post-rm check) | 0, empty list |
| `prepareClaudeCodeAuth()` cleanup (Keychain-exported `.credentials.json` shred + per-run temp dir `rm -rf`) | ran, no error |

No containers named `p2-probe*`/`p2-probec*` remain on the host after this
probe.

### Probe C spend

1 of the remaining 2 authorized `claude-haiku-4-5` calls used (Task 6's
granted ≤4-call probe budget: 2 consumed by Probe A/B, 1 consumed here —
3 of 4 total; 1 call remains unspent/unneeded, this probe's single call
was sufficient to observe the blocking effect).
