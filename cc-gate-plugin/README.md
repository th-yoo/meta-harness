# kkamak — Claude Code Completion Gate

## What it is

A Claude Code plugin that prevents the agent from saying "done" until a repo-configured check passes. Claude remains blocked with evidence until the check succeeds or exhausts allowed rounds. Once installed, every assistant turn ending checks your gate condition—fast checks only (300s timeout).

## Install

**Permanent (auto-loads in every session)** — required if you want the gate
to run without remembering a flag:

```bash
claude plugin marketplace add /path/to/cc-gate-plugin
claude plugin install kkamak@kkamak-local
```

Installation is per-host: it does NOT travel with the repo, so each machine
runs these two commands once. After changing plugin source, refresh the
installed copy with `claude plugin marketplace update kkamak-local` followed
by uninstall + install (the install is a *copy*, not a live reference).

**One-off (dev)** — loads for a single launch only:

```bash
claude --plugin-dir /path/to/cc-gate-plugin
```

**Prerequisite:** `bun` must be on `PATH`. Hook processes spawned by Claude may inherit a different shell environment than your terminal (e.g., GUI-launched Claude has no `~/.bashrc`). Verify: `bun -v` in a fresh shell context, or the plugin's hook will fail silently and allow by default (fail-open).

## Configure

Place `gate.json` at your repo root (same level as `.git/`):

```json
{
  "check": "bash path/to/check.sh",
  "rounds": 2,
  "marker": false,
  "sensor": ".km/gate-outcomes.ndjson",
  "checkTimeoutMs": 300000
}
```

| Field | Type | Default | Notes |
|-------|------|---------|-------|
| `check` | string | *required* | Shell command to run; keep it cheap (it runs after every edited turn). Exit 0 = pass, non-zero = fail. |
| `rounds` | number | `2` | Max failed checks before auto-allow. Total check invocations: `rounds + 1`. |
| `marker` | boolean | `false` | If `true`, successful runs inject a hygiene marker into Claude's context. |
| `sensor` | string | `.km/gate-outcomes.ndjson` | Where to log check outcomes (append-only NDJSON). Relative to repo root. |
| `checkTimeoutMs` | number | `300000` | Hook timeout is 600s; internal timeout (kill + fail) is this value. Timeout counts as a failed check. |

Run `/kkamak:init` in Claude Code to inspect your repo and generate a starter `gate.json` interactively, or run `bun "${CLAUDE_PLUGIN_ROOT:-cc-gate-plugin}/src/init-cli.ts" [--check <cmd>] [--gauge] [--force] [--dry-run]` for the token-free equivalent (no model call).

## What kkamak can and cannot touch

The plugin never modifies tracked files. Its entire write surface is `.km/`
(gitignored runtime state + sensor log); everything else is read-only — it
reads `gate.json` and runs the check command **you** configured, nothing
else. Launching `claude --plugin-dir …` in any directory changes nothing by
itself: no `gate.json` in the repo means the plugin is inert beyond a single
file-stat per turn.

The alteration risk in an interactive session is the one every Claude Code
session already has — it edits files when you ask and permissions allow —
and that is independent of this plugin. If anything, the gate shrinks that
damage class: broken edits get caught and fixed before "done" instead of
being discovered later.

Trust boundary to be aware of: the check command in `gate.json` is arbitrary
shell, executed with your permissions. It is your own repo's config, same
trust model as a Makefile or package.json script — but review it in repos
you didn't author.

## Runtime artifacts

All runtime state lives under `.km/` (gitignore this directory):

- `.km/cc-gate/<session-id>.json` — per-session state (edited flag, round count, fail streak, outcomes)
- `.km/gate-outcomes.ndjson` — sensor log (append-only; one line per gate evaluation)

**Add to `.gitignore`:**
```
.km/
```

**Sensor line schema** (NDJSON):
```json
{
  "ts": 1722100000000,
  "sessionID": "...",
  "check": "bash check.sh",
  "accepted": false,
  "gateExhausted": false,
  "rounds": ["verify-failed"],
  "interrupted": false,
  "marker": false,
  "durationMs": 1234,
  "host": "macbook",
  "app": "claude-code"
}
```

## Delivery modes

Control how blocked turns surface evidence to Claude via the `KKAMAK_DELIVERY` env variable:

- **`block-json`** (default) — Return JSON block decision; evidence in the JSON.
- **`exit2-stderr`** — Exit with code 2 and send evidence to stderr.
- **`block-json+context`** — JSON block + inject evidence as continuation context.

Only blocks are affected. Successful turns (allow, allow-with-marker, allow-exhausted) always exit 0 and never change behavior based on this setting.

## km-gauge (shadow PoC, opt-in)

Per-task derived acceptance checks, SHADOW ONLY — never blocks, never changes
any gate decision. Pre-registration: `docs/superpowers/specs/
2026-07-28-km-gauge-poc-preregistration.md` (metrics M0–M3 locked).

Opt in per repo via `"gauge": true` in `gate.json`. On each task-shaped user
prompt (deterministic classifier — imperative verb or file path, not
question-only), a detached refiner makes one direct Anthropic-API call
(§6c amendment 2026-08-02 — previously a `claude -p` child; default model
`haiku` → `claude-haiku-4-5`, override `KKAMAK_GAUGE_MODEL`) deriving
`{goalSummary, criteria[], check|null, confidence}` into `.km/gauge/`, with
structured outputs and `transport: "sdk"` provenance on the record. Auth is
Claude Code's own OAuth token (macOS keychain / `~/.claude/.credentials.json`;
override `KKAMAK_GAUGE_AUTH_TOKEN`). At the
next cycle-ending Stop the derived check runs shadow (30s timeout) and the
sensor line gains a `gauge` field (`present/executable/pass/wouldBlock/
agreesWithFloor/...`). Fast-path Stops with a pending gauge log a gauge-only
line, marked by `rounds: []`. Evaluated derivations live on as
`.km/gauge/*.done.json` (audit trail).

Fencing: 30 refiner calls/day per repo (`.km/gauge/daily-count`, fail-closed),
kill-switch `KKAMAK_GAUGE=off`; exactly one API request per derivation (no
HTTP retries), 60s timeout, every failure swallowed fail-open.

**Safety guard.** A derived check is model-generated shell run with your
permissions — shadow mode stops it from changing a gate decision, not from
touching your disk. Before any derived check runs, `src/gauge/guard.ts`
refuses anything that is not plainly read-only (writes, `sudo`, network,
state-changing `git`/package commands, in-place editors, redirection to a
file, shell-escape, process control). Refusals are logged as
`gauge.refused: "<reason>"` with `executable: false` and never execute. All
four checks haiku produced during the live smoke passed the guard unchanged.

## Scorecard

```bash
bun cc-gate-plugin/src/score-cli.ts [sensor.ndjson ...] [--min-n N] [--pool] [--json]
```

Read-only aggregation of the sensor stream into four rates — **M-catch**
(gate blocked, agent fixed, converged), **M-exhaust** (never converged),
**M-interrupt** (you preempted), **M-tax** (median cost when nothing was
wrong). Grouped by `(check, host)`, so a repo's own dev sessions never pool
with real work unless you pass `--pool`. Rates are suppressed below `--min-n`
(default 20) rather than printed as noise.

What it can support: *a fall in M-exhaust or M-interrupt at non-decreasing
M-catch* — both measure kkamak being wrong or annoying, and neither needs a
counterfactual. What it cannot: any claim about M-catch alone, or about
whether kkamak is worth running — the sensor never observes what the agent
would have shipped ungated. Definitions and limits:
`docs/superpowers/specs/2026-07-28-kkamak-scorecard-preregistration.md`.

## Escape hatch — stopping kkamak mid-session

`gate.json` is re-read on every hook call, so the gate can be stopped from
*inside* a running session with no restart and no lost context. Run from the
repo whose gate you want to stop (`scripts/km-panic.sh` in this monorepo):

| Command | Effect | Scope |
|---------|--------|-------|
| `km-panic.sh status` | what is armed right now | read-only |
| `km-panic.sh gauge-off` | stops km-gauge refiner spend, gate keeps running | next turn |
| `km-panic.sh off` | disables the gate entirely (moves `gate.json` aside) | next turn |
| `km-panic.sh restore` | undoes `off` | next turn |
| `km-panic.sh nuke` | prints full plugin-removal commands | needs `/reload-plugins` |

`KKAMAK_GAUGE=off` is read from the Claude Code process's environment, so it
only applies if set **before** launching `claude` — it cannot stop a session
already in flight. Use `gauge-off` for that.

Built-in limits that already bound the damage: a cycle auto-allows after
`rounds + 1` failed checks, Claude Code force-ends the turn after 8
consecutive blocks, sending a new prompt preempts an open cycle, and 3
consecutive internal errors disarm the gate for the session.

## Accepted v0.1 limitations

- **Crash window:** If the process crashes between persisting state and appending to the sensor, one round may be lost. Rounds are redeemed on the next turn.
- **No walk-up:** Launching `claude` in a subdirectory won't find a `gate.json` at the repo root. Use `claude` from the root or absolute `gate.json` paths.
- **Compare-and-swap on writes:** Concurrent hook processes for the same session serialize on a best-effort lockfile and compare-and-swap on the record's `updatedAt`. A save that raced and lost — a newer write landed while a check was running — is refused rather than allowed to clobber it. A refused *block* write fails open (the turn is allowed, exactly as it would on ENOSPC), and a refused *reset* retries once against fresh state, since a reset is unconditional (the cycle is over). The lock is best-effort: if it cannot be acquired within a bounded window it degrades to CAS-only. A crashed holder's lock is reclaimed only once it is both stale and its recorded pid is confirmed dead, so a merely-slow live holder is never robbed.
- **3-strike disarm:** After 3 consecutive internal errors (e.g., check throws, state I/O fails), the gate disarms for the session with a visible message. Resume by restarting Claude.

## How it works

1. **PostToolUse hook** (after Edit/Write/MultiEdit/NotebookEdit) — Mark the session as "edited."
2. **Stop hook** (end of each assistant turn):
   - No edits since last Stop? Allow immediately.
   - Run `check` command (with internal `checkTimeoutMs` timeout).
   - ✅ Check passes → Allow (optionally inject marker). Reset state.
   - ❌ Check fails and rounds remain → Block with evidence. Increment round counter, persist state.
   - ❌ Check fails and no rounds left → Auto-allow with `systemMessage` "gate exhausted." Reset state.
   - Either way → Append an NDJSON line to the sensor.
3. **UserPromptSubmit hook** — If Claude tries to send a new prompt while blocked, interrupt the gate cycle cleanly (log as interrupted, reset).

State persists across turns but resets after accept, exhaustion, or preemption. Use the sensor log to audit gate behavior and tune your check.
