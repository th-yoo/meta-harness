# Meta-Harness Usage Manual

Day-to-day guide to running the meta-harness self-improvement loop: enable it, score
sessions, evolve prompts, gate candidates, enable the dense judge, and run the bench.

For **how it works** (the four layers, the two fitness signals, the loop mechanics) see
[evolution-loop.md](evolution-loop.md). For **why** it's built this way see
[enhancement-roadmap.md](enhancement-roadmap.md). For a **guided first run** see
[tier3-testing-manual.md](tier3-testing-manual.md). This doc is the how-to reference.

---

## Quickstart (5 minutes)

1. The opencode plugin is already registered in this repo (`opencode.json` →
   `"plugin": ["./opencode-plugin/src/index.ts"]`). For another project, add the same
   `plugin` array to that project's `opencode.json` or to `~/.config/opencode/opencode.json`.
2. Open opencode in the repo. Select a primary agent whose name starts with `mh-`
   (e.g. **mh-build**) — that, and only that, turns the harness on. Confirm the footer
   shows the mh-* agent **before** you send the first message.
3. Give the agent a real task (it must use a tool — read/edit/bash). When it finishes and
   the session goes idle, the prompt box pre-fills `/mh-score good` and a toast asks you to
   rate it. Edit to `good` or `bad [note]`, press Enter.
4. Run `/mh-status` any time to see per-layer state.

That's the whole inner loop: **use an mh-\* agent → do work → /mh-score**. Everything else
(propose, trial, promote, judge) builds on those scored sessions.

---

## How do I…

### …enable the harness for a session?

The harness activates for any **primary agent named `mh-*`** (`mh-build`, `mh-review`,
`mh-debug`, …). Nothing else enables it — no flag, no config.

- **Select the mh-\* agent before the first message.** The plugin injects the evolved
  system prompt at the start of the session.
- **Switching agents mid-session is honored:** switch **to** an mh-* agent → toast
  *"Harness active for mh-build from this turn — the session will be scored on work from
  here."* and the session's fitness counters reset (only post-switch work is scored).
  Switch **away** to a built-in primary agent (`build`/`plan`) → toast *"harness inactive;
  this session will no longer be scored."* (Switch detection only fires between recognized
  primary agents — `mh-*`, `build`, `plan` — not arbitrary custom agent names.)
- Verify the current session's state: `/mh-status` header shows
  `this session: agent=mh-build, scoring ON` (or `— not scored (switch to an mh-* agent…)`).

### …score a session?

When an mh-* session goes idle after substantive work, the plugin toasts *"rate this
session"* and pre-fills `/mh-score good`. Type your verdict:

- Accepted PASS tokens: `good`, `1`, `yes`, `y`, `ok`, `pass`. FAIL: `bad`, `0`, `no`, `n`, `fail`.
- Optional note: `/mh-score bad forgot to check python3`.
- **One score per cycle.** The session re-bootstraps after each score, so a long opencode
  session doing several tasks gets scored several times; re-scores are stored under
  distinct ids (`<sessionID>#2`, `#3`).
- **Degenerate sessions are auto-skipped** (never pollute the signal): 0 turns, or 0 tool
  calls **and** a <50-char response → toast *"session skipped (no substantive work)"*.
- The score prompt times out after **5 minutes** (session skipped).
- The score feeds **all four layers** at once. Confirmation toast:
  `Score recorded: ✓ good (mh-build project-role: 3/5)`.

### …see what the system is doing?

`/mh-status` — one line per layer plus a trailing `last:` loop event. Decode a layer line:

```
project-role: active=v2 (4/5) [6 bullets] | TRIAL v3 vs v2 (2/5) | candidate v3: accept (held-in delta=+0.25 p=0.03 …)
              └active ver└pass/total └playbook  └in-flight trial (have/min)   └newest candidate's ab-verdict
```

- `[N bullets — over budget, /mh-curate]` appears when a playbook exceeds 25 bullets.
- The `last:` line comes from the project meta-metrics log (last propose/curate/trial/activate/ab event; judge events are logged but not shown here).
- Ground truth is always in the opencode log:
  `grep -E 'meta-harness|hook:event|Trial|proposer|judge' ~/.local/share/opencode/log/opencode.log | tail -40`

### …evolve the prompt? (project layers)

Scored sessions drive proposals automatically:

- **Auto-propose** fires when a project layer reaches its threshold and no trial is in
  flight: **project-role @ 5** scored sessions, **project-global @ 10**. Or trigger
  manually any time: `/mh-propose role` (or `project`).
- The proposer (pinned `anthropic/claude-opus-4-8`, background, ~1 min) diagnoses the
  failures and edits the playbook. **Score at least one session `bad`** first so it has a
  real failing trajectory to diagnose.
- For **project layers the candidate goes live provisionally as a trial** — toast
  `Trial started: project-role v3 (baseline v2)`. It resolves after **5** more scored
  sessions: `Trial confirmed: … kept (x% vs baseline y%)` (candidate stays active) or
  `Trial reverted: … back to v2` (rolled back). No `ab` needed — everyday usage is the gate.
- Evolved playbook bullets and any proposed knobs (`agent-config.json`, `env-policy.json`)
  ride the trial together and are carried forward across generations.

### …curate a bloated playbook?

When a project layer passes **25 active bullets**, `/mh-status` and an idle toast suggest
`/mh-curate`. Run `/mh-curate role` (or `project`): the curator (opus, background) merges
duplicates and prunes net-harmful bullets, and its result **goes through the same trial
gate** (a new candidate + trial) — never a silent mutation. Only run it when no trial is
already in flight.

### …promote proven rules up to the account layer?

`/mh-promote global` (project-global → account-global) or `/mh-promote role` (project-role →
account-role). Requires **≥3 scored sessions on the source active version and ≥1 pass**.
Promotion generalizes project-specific rules and creates an **inactive account candidate** —
it does NOT auto-activate. Validate it with `ab`, then `/mh-activate` (next two sections).

### …validate and activate an account candidate?

Account layers are gated by the statistical A/B test, not everyday usage. First run the
gate (spends tokens — real bench tasks):

```bash
python3 term-bench2/runner.py ab \
  --layer account-global --candidate v1 \
  --model anthropic/claude-sonnet-4-6 --k 2
# (for account-role add: --agent mh-build)
```

This writes `candidates/v1/ab-verdict.json` with a decision: **accept** / **reject** /
**inconclusive**. `inconclusive` is a *statistically correct refusal* on too small a
sample — not a failure; add tasks or `--k`, or accept the tie. Then activate:

```
/mh-activate account v1
```

Account activation **refuses unless the verdict is `accept`** (or pass `--force`). Scope
keywords: `account`=account-global, `role-global`=account-role, `project`=project-global,
`role`=project-role. Project candidates skip the ab gate entirely (they're validated by
trials), so `/mh-activate role v3` activates directly — `--force` is only meaningful for
account scopes.

### …enable the dense judge?

The judge is a second LLM that scores every session **in parallel with you** — a dense,
per-session signal to complement your sparse `/mh-score`. It runs as a dedicated
**evidence-only evaluator**, not a coding agent: its entire system prompt is replaced with
a judge persona, it has **zero tools** (can't read files, run commands, or use MCP/browser
tools), and it judges *only* from the session's recorded trajectory — treating that
trajectory as untrusted data, not instructions (so a task agent can't steer the verdict).
It replies inline with one JSON verdict `{passed, confidence, reasoning}`.

**OFF by default.** Enable it by setting `judgeModel` in
`~/.config/opencode/.meta-harness/config.json`:

**Option A — works now, zero setup** (same vendor, cheap; weaker anti-gaming):
```json
{ "judgeModel": "anthropic/claude-haiku-4-5" }
```

**Option B — recommended, cross-vendor** (strongest anti-gaming; needs the OpenRouter
provider configured in opencode first — `opencode auth login` → OpenRouter, or set
`OPENROUTER_API_KEY`):
```json
{ "judgeModel": "openrouter/google/gemini-2.5-flash" }
```

The config *value* is read fresh each scored session (change the model without a restart),
but the judge only exists if the running plugin build has it — after **updating the plugin**,
restart opencode once. It only sets the judge; the proposer stays pinned to opus.

**The three-stage lifecycle:**

1. **Shadow** — the judge scores in the background and records whether it AGREED with your
   `/mh-score`. It **never touches or delays your score**. Log line per session:
   `[judge] AGREE|DISAGREE judge=<t/f> human=<t/f> — calibration <n>/20 @ <x>%`
   (plus `[judge] system prompt replaced …` confirming the persona swap fired).
2. **Calibrated** — once agreement is ≥ **`judgeMinAgreement`** (0.8) over the last ≥
   **`judgeMinSessions`** (20) decisions. A judge that can't reach that bar **never graduates**
   — it stays shadow-only, so a weak judge is safe, just unhelpful.
3. **Maker-checker** — from then on, the score box **pre-fills the judge's suggestion**:
   `/mh-score good judge: <short reason>` (or `bad`). You approve it (Enter) or **override**
   it — the judge proposes, you remain the final checker. Your submitted verdict is what's
   recorded, never the judge's.

**What to expect:** verdicts land in ~1–3 s. A good judge genuinely **disagrees** sometimes
(and agrees on real failures) — that discrimination is the point; if it agreed with
everything it'd be worthless. When it's wrong in maker-checker mode, just edit the prefill.
Each scored session's verdict is stored on its trace as `record.judge`
(`{passed, confidence, mode: "shadow"|"prefill", agreed}`); the running agreement lives in
`~/.config/opencode/.meta-harness/judge-calibration.json`.

- Watch it: `grep '\[judge\]' ~/.local/share/opencode/log/opencode.log | tail -5`.
- Cost: one judge LLM call per scored mh-* session while enabled. To turn off, set
  `judgeModel` back to `""` or delete the config file.
- If the judge wanders or judges poorly, it's usually the model: haiku works but is
  middling; a stronger or cross-vendor model calibrates more reliably. The
  **…audit the judge for gaming?** how-to (next section) cross-checks it against verifier truth.

### …audit the judge for gaming?

Replay the judge on bench sessions where the verifier gives ground truth, and alarm on
divergence:

```bash
python3 term-bench2/runner.py judge-audit \
  --layer account-global --candidate v1 --limit 10
# role layers: add --agent mh-build ; override model with --model
```

Exit codes: **0** = clean (agreement ≥ 0.8), **1** = ALARM (judge diverges from the
verifier too often — possibly gameable), **2** = could-not-assess (all judge calls failed /
no scorable sessions). Needs bench trajectories — generate them with
`ab … --save-all-traj` (which persists passing-run trajectories too).

### …check whether the loop is actually working?

```bash
python3 term-bench2/runner.py report-loop        # human table
python3 term-bench2/runner.py report-loop --json  # machine summary
```

It merges three `meta-metrics.jsonl` sinks (bench, project, account) and reports ab-decision
counts, trial confirm/revert counts, held-out delta per split rotation, and judge agreement.
Notes: needs **Python 3.12+**; the default project sink assumes you're in this repo — for
another project pass `--sink <that-worktree>/.meta-harness/meta-metrics.jsonl`.

### …run the benchmark?

```bash
python3 term-bench2/runner.py prep --apply             # one-time host setup (sudo; dry-run without --apply)
python3 term-bench2/runner.py oracle                   # token-free pipeline check via solution scripts
python3 term-bench2/runner.py run --all --agent mh-build --layers project   # score real runs into the store
python3 term-bench2/runner.py run --tasks regex-log --pin project-role=v3   # test a specific candidate
```

See the Reference below for every flag.

---

## Reference

### Slash commands

| Command | Args | Effect |
|---|---|---|
| `/mh-score` | `good\|bad [note]` | rate the last session (good/1/yes/y/ok/pass · bad/0/no/n/fail) |
| `/mh-propose` | `[role\|project\|role-global\|account]` (default `role`) | trigger the proposer for that layer |
| `/mh-activate` | `<scope> <vN> [--force]` | activate a candidate; account scopes need an `accept` ab-verdict |
| `/mh-promote` | `[global\|role]` (default `global`) | promote proven project rules to an inactive account candidate |
| `/mh-curate` | `[scope]` | consolidate/prune a layer's playbook, through the gate |
| `/mh-status` | — | per-layer active version, scores, trials, verdicts, bullets, last event |

**Scope keywords:** `role`/`project-role` = project-role · `project`/`project-global` =
project-global · `role-global`/`account-role` = account-role · `account`/`account-global` =
account-global. (`/mh-promote` uses only `global`/`role`.)

### Config — `~/.config/opencode/.meta-harness/config.json`

Read fresh every scored session (no restart). File need not exist; defaults apply.

| Key | Default | Meaning |
|---|---|---|
| `proposerModel` | `anthropic/claude-opus-4-8` | proposer/promoter/curator model (provider-prefixed) |
| `proposerVariant` | `high` | proposer variant |
| `judgeModel` | `""` (OFF) | dense-judge model; `""` disables |
| `judgeVariant` | `""` | judge variant |
| `judgeMinSessions` | `20` | shadow decisions before the judge can calibrate |
| `judgeMinAgreement` | `0.8` | judge/human agreement needed to calibrate |

Models must be `provider/model` — a bare name fails resolution under oauth.

### Runner subcommands — `python3 term-bench2/runner.py <sub>` (top-level `--tb-root PATH`)

- **`prep`** `[--apply] [--uninstall] [--clean-mountpoints]` — host setup (mkdir + apt);
  dry-run unless `--apply`.
- **`run`** `--tasks T… | --task-file P | --all`, `--model` (default
  `anthropic/claude-sonnet-4-6`), `--variant`, `--k` (1), `--layers {global,account,project,none}`
  (global), `--agent NAME`, `--pin LAYER=vN` (repeatable), `--no-store`, `--save-all-traj`,
  `--no-harness`, `--results-file P` (implies `--no-store`), `--label`, `--max-agent-timeout SEC`,
  `--resume`.
- **`ab`** `--layer {account-global,project-global,account-role,project-role}` + `--candidate vN`
  (both required); split via `--split-file` (default `term-bench2/splits.json`) or legacy
  `--tasks/--task-file/--all` (never accepts); `--model` (sonnet-4-6), `--variant`, `--k` (2),
  `--layers {global,account,project}`, `--agent` (required for role layers), `--alpha` (0.05),
  `--nonregress-margin` (0.05), `--min-tasks-before-stop` (12), `--no-early-stop`,
  `--max-agent-timeout`, `--resume`, `--no-store`, `--save-all-traj`, `--results-file`.
- **`split`** `{make,rotate,show}` `--seed` (42) `--folds` (4) `--source` (`baseline-tasks.txt`) `--split-file`.
- **`oracle`** `[--tasks T…] [--results-file P]` — token-free pipeline validation via solution scripts.
- **`report-loop`** `[--json] [--sink PATH …]` — merged loop observability (Python 3.12+).
- **`judge-audit`** `--layer L --candidate vN [--agent A] [--model M]` (default
  `openrouter/google/gemini-2.5-flash`) `[--limit 10]` — exit **0** clean / **1** alarm / **2** could-not-assess.

### Store layout

Four layer roots (injection order general → specific → env snapshot):

```
~/.config/opencode/.meta-harness/global/        (account-global)   most general
<worktree>/.meta-harness/global/                (project-global)
~/.config/opencode/.meta-harness/roles/<agent>/ (account-role)
<worktree>/.meta-harness/roles/<agent>/         (project-role)     most specific (wins)
```

```
<storeRoot>/
  active/       system.md  tools.md  .version  playbook.json  agent-config.json  env-policy.json  .trial
  candidates/vN/  (above artifacts) + score.json  meta.json  diagnosis.json  ab-verdict.json
                  traces/<recordID>.json          traj/<recordID>.ndjson
```

- `active/` = the currently-injected copy; `candidates/vN/` = a proposal plus its scores/traces.
- `agent-config.json` / `env-policy.json` are **project-layer only** (evolvable bash-timeout
  and env-snapshot knobs; account layers can't be measured by the bench's inert `build` agent).
- `recordID` = the raw sessionID, or `<sessionID>#N` on re-scores. Trajectories: failures
  always kept, passes only with `--save-all-traj`; pruned to last 20 failures / 5 passes.
- **Metrics sinks** (merged by `report-loop`): `term-bench2/results/meta-metrics.jsonl`
  (bench), `<worktree>/.meta-harness/meta-metrics.jsonl` (project),
  `~/.config/opencode/.meta-harness/meta-metrics.jsonl` (account). Judge decisions:
  `~/.config/opencode/.meta-harness/judge-calibration.json`.

### Thresholds

| Constant | Value | Meaning |
|---|---|---|
| project-role auto-propose | 5 | scored project-role sessions before auto-propose |
| project-global auto-propose | 10 | scored project-global sessions before auto-propose |
| trial min sessions | 5 | scored sessions before a project trial confirms/reverts |
| promote min evidence | 3 (+≥1 pass) | scored sessions on source before `/mh-promote` |
| curator budget | 25 | active bullets/layer before curation is suggested |
| proposer timeout | 10 min | background proposer/promoter/curator wait |
| score-prompt timeout | 5 min | human score prompt before the session is skipped |

### Environment variables

- `XDG_CONFIG_HOME` — overrides the `~/.config` base for the account store + config.
- `MH_DEBUG=1` — runner dumps opencode stdout/stderr to `/tmp/mh_oc_<task>.txt` when a run
  produces 0 turns (debugging silent agent failures).

---

## Troubleshooting

- **The `/mh-score` prompt never appears.** You weren't on an mh-* agent when the message
  was sent (check `/mh-status` session state / `grep 'session.idle' …opencode.log | tail -1`
  for `agent=mh-build`); or the session was degenerate (no tool call); or the 5-min prompt
  timed out. New sessions start on the default `build` agent — select mh-build **before** the
  first message.
- **A slash command "did nothing."** Older plugin build (commands surface via toast now); and
  the plugin loads at opencode **startup** — restart opencode after editing plugin source.
- **Headless model errors / 0-turn runs.** The model must be provider-prefixed
  (`anthropic/claude-sonnet-4-6`); bare names fail under oauth. Set `MH_DEBUG=1` to capture output.
- **The judge never calibrates.** It needs `judgeModel` set **and** ≥20 scored sessions;
  check `judge-calibration.json` and the `[judge]` log lines for the running agreement.
- **`report-loop` shows nothing.** Events only exist after loop activity; and it may be
  reading the wrong sink (three locations — off-repo, pass `--sink`).
- **`ab` says INCONCLUSIVE.** That's the gate correctly refusing an underpowered sample, not
  a bug — add tasks or `--k`, or accept the tie.
- **Logs:** `~/.local/share/opencode/log/opencode.log` (the plugin logs there); grep for
  `meta-harness`, `hook:event`, `Trial`, `proposer`, `[judge]`.
