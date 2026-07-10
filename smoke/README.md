# tmux TUI smoke harness

Automated smoke tests for the meta-harness opencode **plugin's TUI surfaces** —
the toasts (`client.tui.showToast`) and the `/mh-score` input-box autofill
(`client.tui.appendPrompt`) that only render in the real interactive TUI.
Headless `opencode run` publishes those bus events but nothing renders them and
scoring never completes, so `bun test` / `pytest` structurally cannot reach this
layer. This suite drives the real opencode TUI in a detached **tmux** pane (tmux
is the VT parser; `capture-pane` reads the rendered grid) and asserts on it.

## Run it

```bash
bash smoke/run.sh                 # Tier A only (token-free, no model calls)
MH_SMOKE_LIVE=1 bash smoke/run.sh # + Tier B (one cheap Haiku session)
```

Exits nonzero if any scenario fails; skips cleanly (exit 0) if `tmux` or
`opencode` is missing. Requires: `tmux`, `opencode`, and — for Tier B — working
opencode auth (`~/.local/share/opencode/auth.json`).

## What it covers

**Tier A — token-free** (slash commands never call the model):

| scenario | asserts |
|---|---|
| `s1-status-layers` | `/mh-status` renders the 4-layer report |
| `s2-status-trial`  | `/mh-status` shows `TRIAL v1 vs v0` when a trial is seeded |
| `s3-status-paused` | `/mh-status` shows the `PAUSED` line when the plateau flag exists |
| `s4-activate-error`| `/mh-activate account v1` is refused (no ab-verdict) |
| `s5-activate-success` | `/mh-activate role v1` activates a project candidate |
| `s6-propose-guard` | `/mh-propose role` acks **and spawns no proposer** (trial-guarded) |
| `s7-curate-guard`  | `/mh-curate role` acks **and spawns no curator** (trial-guarded) |
| `s8-promote-gate`  | `/mh-promote role` acks **and spawns no promoter** (evidence-gated) |

**Tier B — live** (gated by `MH_SMOKE_LIVE=1`, ~$0.01 of Haiku):

| scenario | asserts |
|---|---|
| `autofill` | on session-idle the plugin prefills `/mh-score good`; submitting it renders the `Score recorded` toast |

## Isolation — the real store is never touched

Every scenario runs in a throwaway env built by `lib/oc-env.sh`:

- temp `XDG_CONFIG_HOME` + `XDG_DATA_HOME` + a **git-init'd** temp project
  (opencode derives the project root by walking up for `.git`; without one the
  plugin resolves its store to `/.meta-harness` and fails to load);
- the mh plugin is loaded by **absolute path**; the repo's `.opencode/` (agents,
  slash commands, plugin deps) is symlinked **read-only**; auth is copied;
- the store lives under the temp dirs, so the real
  `~/.config/opencode/.meta-harness` and `<repo>/.meta-harness` are untouched.

The propose/curate/promote scenarios additionally assert **no background LLM
session spawned** (`assert_no_spawn` — the isolated log must have exactly one
created session), which is the token-free guarantee: those commands always ack
`"cycle started ✓"` then fire a background trigger whose guard (trial-in-flight
or the promote evidence gate) is what prevents an opus spawn.

## Driving the TUI yourself (or as the agent)

The primitives in `lib/oc-driver.sh` are reusable outside the suite:

```bash
source smoke/lib/oc-driver.sh
mk_oc_env                         # isolated env  (or point OC_PROJ at a real dir)
oc_start                          # launch opencode --agent mh-build, wait for paint
oc_run_command "/mh-status" "active="   # type + Enter-until-toast
oc_capture                        # dump the rendered pane
oc_key Escape; oc_key Tab         # raw special keys
oc_kill; rm_oc_env
```

Two timing rules the primitives encode (do not fight them):

- **No foreground `sleep`** here — every wait polls `capture-pane` (the subprocess
  forks are the wall-clock). Shell no-op loops burn microseconds, not time.
- **First keystrokes after paint are dropped** — `oc_type` send-verifies (retries
  until the text appears). And toasts are **ephemeral** (4–30 s); poll for them
  immediately. Only the `/mh-score` autofill is persistent.

**MCP:** the repo `.mcp.json` registers `tmux-mcp` for the Claude Code client so
the agent can drive a pane via typed tools (`capture-pane`, `execute-command`,
session mgmt). MCP servers load at session start, so those tools appear on the
**next** Claude Code session; the `oc-driver.sh` primitives work now.
