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
- **Trivial-but-tool-using sessions are recorded, not counted** (needs the dense judge
  enabled — see next section): a greeting, a single-file read, a one-liner lookup still
  passes the degenerate filter but tells you nothing about harness quality. When the judge
  rates such a session `trivial:true`, it's still written to `traces/`/`score.json`, but
  excluded from trial confirm/revert rates, auto-propose thresholds, and judge calibration.
  The confirmation toast adds *"— trivial: recorded, not counted toward fitness"*. Judge
  disabled or its verdict missing → no trivial marking, session counts as always.
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
bun term-bench2/runner.ts ab \
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
It replies inline with one JSON verdict `{passed, confidence, reasoning}`, plus an optional
`trivial` rating (see **cost control: triviality filtering** below).

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
(`{passed, confidence, mode: "shadow"|"prefill", agreed, trivial}`); the running agreement
lives in `~/.config/opencode/.meta-harness/judge-calibration.json`.

**Cost control: triviality filtering.** The same judge call also rates whether the session
was **informative** — would succeeding at it tell you anything about the harness's quality?
Greetings, single-file reads, one-liner lookups, and rote commands come back `trivial:true`;
anything requiring real multi-step work, judgment, or where failure was plausible comes back
`trivial:false` (the judge defaults to `false` when unsure, or when it omits the field
entirely). A `trivial:true` session is still recorded — its trace and `score.json` entry are
unchanged — but it is **excluded** from: trial confirm/revert rates (both the trial and the
baseline side), auto-propose session-count thresholds, and judge calibration (a trivial
agreement doesn't inflate the agreement stat). This needs the judge **enabled**; with the
judge off (or its verdict missing for a given session), nothing changes — every session
counts exactly as it did before this feature.

- Watch it: `grep '\[judge\]' ~/.local/share/opencode/log/opencode.log | tail -5` (a trivial
  session logs `[judge] trivial session — … (excluded from calibration/fitness)`).
- Cost: one judge LLM call per scored mh-* session while enabled — triviality rating adds
  **zero extra LLM cost** (it rides the same verdict call). To turn off the judge entirely,
  set `judgeModel` back to `""` or delete the config file.
- If the judge wanders or judges poorly, it's usually the model: haiku works but is
  middling; a stronger or cross-vendor model calibrates more reliably. The
  **…audit the judge for gaming?** how-to (next section) cross-checks it against verifier truth.

### …audit the judge for gaming?

Replay the judge on bench sessions where the verifier gives ground truth, and alarm on
divergence:

```bash
bun term-bench2/runner.ts judge-audit \
  --layer account-global --candidate v1 --limit 10
# role layers: add --agent mh-build ; override model with --model
```

Exit codes: **0** = clean (agreement ≥ 0.8), **1** = ALARM (judge diverges from the
verifier too often — possibly gameable), **2** = could-not-assess (all judge calls failed /
no scorable sessions). Needs bench trajectories — generate them with
`ab … --save-all-traj` (which persists passing-run trajectories too).

### …check whether the loop is actually working?

```bash
bun term-bench2/runner.ts report-loop        # human table
bun term-bench2/runner.ts report-loop --json  # machine summary
```

It merges three `meta-metrics.jsonl` sinks (bench, project, account) and reports ab-decision
counts, trial confirm/revert counts, held-out delta per split rotation, and judge agreement.
Notes: needs **Python 3.12+**; the default project sink assumes you're in this repo — for
another project pass `--sink <that-worktree>/.meta-harness/meta-metrics.jsonl`.

### …focus the loop on hard tasks (difficulty band)?

By default, `ab` evaluates all baseline tasks. To focus on tasks the current model struggles
with (difficulty-band filtering), create a difficulty-calibrated split:

```bash
# Generate/update results file with pass rates from prior runs
bun term-bench2/runner.ts run --all --agent mh-build --results-file results.json

# Create a split with tasks in pass-rate band [0.2, 0.8] (hard tasks)
# Exclude very easy tasks (rate ≥0.9); keep sentinels (easy-regression guards)
bun term-bench2/runner.ts split make --results results.json \
  --band 0.2,0.8 --sentinels 3 --sentinel-hi 0.9
```

Then use this split in `ab` runs: `ab --split-file term-bench2/splits.json …`

**What the band does:**
- **Held-in pool** (folds 1–3): only tasks in [band-lo, band-hi]. This focuses evaluation
  on the hard middle where the model is actually learning.
- **Unknown-rate tasks stay in** — if you haven't run a task yet, it can't be ruled out and
  stays in the fold (they're valuable for discovery).
- **Sentinels** (easy-regression guards, ~3 tasks): tasks with rate ≥ sentinel-hi (default
  0.9). They ride the held-out fold only, never held-in. This catches regressions on easy
  tasks where the model shouldn't slip.
- **Excluded** (very easy, or out of reach): tasks below band-lo and easy-task overflow stay
  out entirely; they're neither hard nor regression-guards.

**Sentinel role** — Sentinels are paired-compared separately (stratified gate) so they can
detect easy-task regressions *independently* of fold regression. If a candidate both arms
pass on sentinels, that's no signal; only sentinel-only regressions (arm A passes, arm B
fails) force a reject with reason "sentinel regression."

**Caveat: Excluded tasks have NO automatic graduation path.** They re-enter the fold only
via a future `split make --results` run with fresh pass-rate data on them. This requires
deliberately re-running those tasks. Don't expect the band to self-correct downward as the
model improves — you must refresh the calibration yourself.

### …know when to stop (plateau)?

The loop detects and flags project plateau — when recent trials and `ab` runs show no
meaningful progress. Check with:

```bash
bun term-bench2/runner.ts report-loop        # shows Plateau: section
bun term-bench2/runner.ts report-loop --json  # includes plateau verdict
```

**Plateau detection and auto-pause:**

- **Project plateau** (triggers auto-pause): last 4 resolved trials without strict improvement
  (no trial's pass-rate exceeded its prior active version's pass-rate). When detected,
  `report-loop` writes `<worktree>/.meta-harness/paused` with a timestamp. This signals the
  plugin to skip auto-propose (manual `/mh-propose` still works).
- **Per-layer bench advice** (REPORT-ONLY, no auto-pause): last 3 `ab` events all non-accept
  + held-IN delta slope ≤ 0 (larger sample, undiluted by sentinels). This suggests you should stop manual `ab` spending on that
  layer, but doesn't pause auto-propose.

**Unpause:** Remove the paused flag manually (`rm .meta-harness/paused`) or run another
`report-loop` with no plateau detected — it clears the flag. Meanwhile, `/mh-propose` and
manual `/mh-curate` still work (only auto-propose is paused).

**Caveat: Don't rerun `split make` while an `ab --resume` is in flight.** The active split
carries a hash that `ab --resume` validates. If you regenerate the split mid-run, the hash
won't match and `ab --resume` will refuse to continue (splitHash mismatch). **Restart the
`ab` instead** — a plain restart (no `--resume`) simply reruns the full comparison from
scratch under the new split — nothing carries over.

### …run the benchmark?

```bash
bun term-bench2/runner.ts prep --apply             # one-time host setup (sudo; dry-run without --apply)
bun term-bench2/runner.ts oracle                   # token-free pipeline check via solution scripts
bun term-bench2/runner.ts run --all --agent mh-build --layers project   # score real runs into the store
bun term-bench2/runner.ts run --tasks regex-log --pin project-role=v3   # test a specific candidate
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
| `proposerTimeoutMin` | `20` | minutes to wait for a proposer/promoter/curator to write its staging artifact (cap 120) |

Models must be `provider/model` — a bare name fails resolution under oauth.

### Choosing an agent driver — `--driver`

The `run` and `ab` subcommands accept `--driver {opencode|claude-code}` (default: `opencode`). The driver determines which agent binary runs the tasks in the bench container:

- **`--driver opencode`** (default) — runs `opencode run` inside the container. Model is specified as `<provider>/<model>` (e.g. `anthropic/claude-sonnet-4-6`).
- **`--driver claude-code`** — runs `claude` (the Claude Code CLI) inside the container. **Accepts only `anthropic/*` models**; other providers are rejected with an error. Model is specified the same way (`anthropic/claude-haiku-4-5-20251001`), and the prefix is stripped for the container invocation.

Both drivers implement the same contract (output parsing, tool tracking, attempt classification) so results are interchangeable within a single run/ab invocation — **`ab` enforces same-driver for both arms** (candidate and active), and **cross-driver `--resume` is refused** (resuming a claude-code run with `--driver opencode` or vice versa will error).

### Configuring providers (OpenRouter and others)

Anthropic is already wired via the `opencode-claude-auth` plugin (it reads Claude
Code's oauth and refreshes it). To use another provider — e.g. an OpenRouter model
as `judgeModel` — add its key through opencode's own auth store:

```bash
opencode auth login          # pick the provider (e.g. OpenRouter), paste the key
opencode auth list           # confirm it's stored alongside "Anthropic · oauth"
```

Then reference it provider-prefixed, e.g.
`{"judgeModel": "openrouter/google/gemini-2.5-flash"}` in the config above.

**Why `opencode auth login` and not an env var.** The key lands in
`~/.local/share/opencode/auth.json`, which reaches *all* consumers: the interactive
TUI, the plugin's judge/proposer sessions, the host-side `judge-audit`, **and** the
bench containers — the runner bind-mounts `~/.local/share/opencode` into every task
container, so the key propagates for free. A bare `OPENROUTER_API_KEY` export works
for everything *except* bench containers (the container-create call passes no `-e`
env), so it silently fails there. Put keys in `auth.json`.

- **Coexistence:** `opencode-claude-auth`'s refresh does a targeted rewrite of only
  the `anthropic` entry, so a hand-added `openrouter` key is preserved across its
  5-minute background sync.
- **Get an OpenRouter key:** https://openrouter.ai/settings/keys

### Claude Code agent container authentication

When `--driver claude-code` is used, the `claude` binary in the container needs Anthropic credentials. Two paths are supported:

**Path 1: API key (durable, zero mounts)**

Set `ANTHROPIC_API_KEY` on the host, e.g. `export ANTHROPIC_API_KEY=sk-ant-...`. The runner forwards it into the container as an env var, and claude-code uses it instead of oauth:

```bash
ANTHROPIC_API_KEY=sk-ant-... bun term-bench2/runner.ts run --driver claude-code --model anthropic/claude-haiku-4-5 --tasks hello_world
```

This is the simplest path for unattended runs and avoids any mount setup.

**Path 2: OAuth (refresh tokens, platform-specific)**

If `ANTHROPIC_API_KEY` is not set, the runner exports the host's Claude Code credentials into the container. The exact mechanism depends on the OS:

- **Linux** — The runner mounts the real `~/.claude/` directory read-write into the container at `/root/.claude`. The claude-code CLI reads `.credentials.json` (which already exists on linux hosts) and can rotate refresh tokens. Works out-of-the-box after `claude` or `opencode auth login` have been run on the host.
- **macOS** — Claude Code stores credentials in the Keychain (no `.credentials.json` on disk). The runner exports the Keychain item via `security find-generic-password -s "Claude Code-credentials" -w` into a temporary directory, mounts it read-write at `/root/.claude`, and shreds (overwrites with zeros) it after the run. Any refresh-token rotation inside the container is discarded — acceptable for single-task runs, but not for sequential multi-task workloads. For long-running benches, use the API key path (above) instead.

**Container setup (both paths)**

Both auth paths require:
- A onboarding-gate file `/root/.claude.json` containing `{"hasCompletedOnboarding":true}` (fixture-verified to be necessary for headless runs).
- The env var `IS_SANDBOX=1`, which tells claude-code to accept `--dangerously-skip-permissions` while running as root inside the container.

These are set automatically by the runner; no manual configuration is needed.

### Runner subcommands — `bun term-bench2/runner.ts <sub>` (top-level `--tb-root PATH`)

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
- **`split`** `{make,rotate,show}` `--seed` (42) `--folds` (4) `--source` (`baseline-tasks.txt`) `--split-file`, `--results PATH` (repeatable, enables difficulty band), `--band LO,HI` (0.2,0.8), `--sentinels N` (3), `--sentinel-hi HI` (0.9).
- **`oracle`** `[--tasks T…] [--results-file P]` — token-free pipeline validation via solution scripts.
- **`report-loop`** `[--json] [--sink PATH …]` `[--no-flag]` `[--plateau-ab-k K]` `[--plateau-trial-k K]` — merged loop observability + plateau detection (Python 3.12+).
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
- **Pause flag** (project plateau): `<worktree>/.meta-harness/paused` (present only when
  the project is detected as plateaued). Write/clear via `report-loop`; remove manually to
  unpause auto-propose.

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
| difficulty band default | 0.2, 0.8 | pass-rate range for held-in pool (LO, HI) |
| sentinel count default | 3 | easy-task regression guards in held-out |
| sentinel-hi threshold | 0.9 | pass rate at/above which a task qualifies as sentinel |
| plateau trial window | 4 | last K resolved trials for project plateau detection |
| plateau ab window | 3 | last K ab events per layer for bench plateau advice |

### Environment variables

- `XDG_CONFIG_HOME` — overrides the `~/.config` base for the account store + config.
- `MH_DEBUG=1` — runner dumps opencode stdout/stderr to `/tmp/mh_oc_<task>.txt` when a run
  produces 0 turns (debugging silent agent failures).

### Adding a driver

To add a new agent driver (e.g. a different CLI tool or agent framework), implement the AgentDriver interface:

**1. Create a driver file**

Add `opencode-plugin/src/bench/drivers/<id>.ts` implementing `AgentDriver`:

```typescript
export const myDriver: AgentDriver = {
  id: "my-agent",
  buildArgv: (opts) => { /* return ['bin', '--arg', opts.model, opts.instruction] */ },
  modelArg: (canonicalModel) => { /* validate/transform provider/model slug */ },
  harness: { kind: "workspace-file", filename: "AGENTS.md" },  // or "env-var"
  parseOutput: (stdout) => { /* return TrajEvent[] */ },
  classifyAttempt: (stdout, stderr) => { /* return "done" | "auth" | "transient" */ },
  prepareAuth: () => { /* return AgentAuthMounts */ },
  versionArgv: ["bin", "--version"],
}
```

See `drivers/opencode.ts` and `drivers/claude-code.ts` as references.

**2. Register the driver**

Edit `opencode-plugin/src/bench/drivers/index.ts`:

```typescript
import { myDriver } from "./my-agent.ts"

export const DRIVER_IDS = ["opencode", "claude-code", "my-agent"] as const

export function getDriver(id: string): AgentDriver {
  if (id === "my-agent") return myDriver
  // ... existing cases ...
}
```

**3. Add fixtures**

Create test fixtures in `opencode-plugin/test/fixtures/drivers/my-agent/` matching the success/auth-error/transient/tool-error cases. These are used by the contract suite.

**4. Add Containerfile layer**

Edit `term-bench2/Containerfile` to install your agent binary (if not already available):

```dockerfile
RUN apt-get install -y my-agent
# or: COPY my-agent /usr/local/bin/
```

**5. Contract suite**

Add a row to the `DRIVER_CASES` table in `opencode-plugin/test/bench-drivers-contract.test.ts`. The contract suite auto-validates every registered DRIVER_IDS entry via parameterized tests, so new drivers are immediately tested for output parsing, model-arg handling, and attempt classification across success/auth/transient/timeout scenarios.

The output contract is language-agnostic: return `TrajEvent[]` where each event is `{t: "tool" | "text" | "error", ...}`, count turns from a success result, and classify attempts by scanning stdout/stderr against `AUTH_ERROR_RE` and `TRANSIENT_RE` (see `agent-run.ts`).

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
