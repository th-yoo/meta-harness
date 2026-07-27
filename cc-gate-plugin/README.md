# kkamak — Claude Code Completion Gate

## What it is

A Claude Code plugin that prevents the agent from saying "done" until a repo-configured check passes. Claude remains blocked with evidence until the check succeeds or exhausts allowed rounds. Once installed, every assistant turn ending checks your gate condition—fast checks only (300s timeout).

## Install (dev)

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

Run `/kkamak:init` in Claude Code to inspect your repo and generate a starter `gate.json`.

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

## Accepted v0.1 limitations

- **Crash window:** If the process crashes between persisting state and appending to the sensor, one round may be lost. Rounds are redeemed on the next turn.
- **No walk-up:** Launching `claude` in a subdirectory won't find a `gate.json` at the repo root. Use `claude` from the root or absolute `gate.json` paths.
- **Last-writer-wins:** Concurrent hook processes for the same session have no lock. The last process to write state wins; prior updates are lost. Data is never corrupted, only lasered.
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
