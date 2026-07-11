# The Meta-Harness Evolution Loop

How meta-harness improves an opencode coding agent — the mechanism, the layers,
the feedback loop, and where it lives in the code.

> **Day-to-day usage** (commands, scoring, config, the bench CLI, troubleshooting):
> see [usage-manual.md](usage-manual.md). This doc is the architecture.

> **One line:** meta-harness never changes opencode's code or the model. It
> evolves the **system-prompt text** the agent runs under, and keeps only the
> rewrites that provably raise pass-rate.

---

## 1. What actually gets improved

The evolvable artifact is a set of small markdown files, one pair per layer:

- `system.md` — short behavioral rules (e.g. "read a file before editing it")
- `tools.md` — per-tool guidance, keyed by tool name

That text is injected into the agent's **system prompt on every session**. Better
text → better behavior → more tasks solved. Nothing else moves: not the model,
not opencode's source, not the tool set.

**Injection (opencode side)** — `opencode-plugin/src/index.ts`, the
`experimental.chat.system.transform` hook. For an `mh-*` agent it reads each
layer's active `system.md` (`readActiveSystem`) and pushes it into the model's
system prompt, then a combined `## Tool usage guidance` section, then the env
snapshot. So evolved rules actually reach the model on the next run.

**Injection (benchmark side)** — `term-bench2/runner.py:assemble_agents_md`
composes the same layer text into an `AGENTS.md` written into the task's `/app`
workspace before the run.

---

## 2. The four layers

A rule lives at the scope where it is true. Layers are composed general → specific,
then the env snapshot is appended.

| Layer | Root | Scope of rules |
|---|---|---|
| account-global | `~/.config/opencode/.meta-harness/global/` | true for ALL coding, ALL projects |
| project-global | `<repo>/.meta-harness/global/` | this project, all roles |
| account-role | `~/.config/opencode/.meta-harness/roles/<agent>/` | this role (e.g. `mh-build`), all projects |
| project-role | `<repo>/.meta-harness/roles/<agent>/` | this role in this project (most specific) |

Builder: `harness-store.ts:layersFor(worktree, agent)`. Each layer carries the
roots of the more-general layers (`higherRoots`); the proposer is shown those as
"already covered — do not repeat," so rules don't duplicate across layers.

Each layer store has the same on-disk shape:

```
<storeRoot>/
  active/
    system.md      current best behavioral prompt for this layer
    tools.md       current best tool guidance
    .version       "v0", "v1", …
    .trial         present only while a project-layer trial is in progress (JSON)
  candidates/
    vN/
      system.md
      tools.md
      score.json           { version, nPass, nFail, sessions: SessionRecord[] }
      traces/<sessionID>.json
      ab-verdict.json      written by the TB2 `ab` command (account candidates)
```

---

## 3. Two fitness signals

You cannot improve without a measure of "better." There are two, matched to the
two kinds of layer:

- **Everyday usage → project layers.** You work with an `mh-*` agent, then rate
  the session: `/mh-score good|bad [note]`. Pass/fail is the signal
  (`score.ts` + the `session.idle` handler in `index.ts`).
- **Terminal-Bench 2 → account layers.** Objective and human-free: run the task,
  the verifier reports pass/fail. Produced by `term-bench2/runner.py`.

Intended direction of travel: evolve **project** layers from daily use first, then
**promote** what generalizes up to **account** layers, where TB2 validates it.

---

## 4. The loop

```
 sessions run ──► scored (human /mh-score  or  TB2 verifier) ──► accumulate on the active version
      │
      ▼  threshold reached (project-role ≥5, project-global ≥10 scored sessions)
 PROPOSER (an LLM session) reads the traces for this layer:
     which sessions passed/failed, tool-usage patterns ("edit×4 read×0"), human notes
      │
      ▼
 writes ONE new gap-filling behavioral rule ──► new candidate vN
      │
      ▼  SELECTION GATE  (a candidate must PROVE it is better before it goes live)
     project layer:  TRIAL — vN goes live provisionally; after TRIAL_MIN_SESSIONS
                     scored sessions, kept iff its pass-rate ≥ the baseline's,
                     else auto-reverted to the previous version
     account layer:  vN stays INACTIVE; run `ab` (candidate vs active on tasks);
                     /mh-activate accepts it only if the verdict says it won
      │
      ▼
 PROMOTION (/mh-promote): lift a proven project-layer rule into the account
     candidate → it then faces the same TB2 gate before going account-wide
```

Key functions:

- Proposer: `propose.ts:triggerPropose` + `harness-store.ts:buildProposerContext`
- Trial: `harness-store.ts:startTrial` / `resolveTrial` (invoked from the
  `session.idle` handler in `index.ts`)
- Activation gate: `harness-store.ts:activateCandidate` + `readAbVerdict`,
  enforced by the `/mh-activate` command in `index.ts`
- Promotion: `propose.ts:triggerPromote`

**Why the gate matters.** Originally the proposer wrote a candidate and it went
live *immediately, unchecked* — a bad rule silently degraded the agent (mutation
without selection). The gate makes this real hill-climbing: a change sticks only
if it measurably helps, and a regression is reverted or refused.

---

## 5. A concrete cycle

1. The agent keeps failing tasks because it edits files blindly. Sessions are
   scored bad; traces show `edit` calls with no preceding `read`.
2. The proposer reads those traces, spots the pattern, and writes to `system.md`:
   *"Before editing a file, read it first."* → candidate `v4`.
3. Trial mode: `v4` is live for the next `TRIAL_MIN_SESSIONS` scored sessions.
4. If pass-rate holds or rises → **confirmed**, `v4` becomes the active rule and
   is injected into every future session. If it made things worse → **auto-revert**
   to `v3`, no harm done.

Over many cycles the prompt accumulates only rules that empirically raised
pass-rate. That accumulation *is* the improvement.

---

## 6. Commands (opencode plugin)

| Command | Effect |
|---|---|
| `/mh-score good\|bad [note]` | Rate the last session. Degenerate sessions (greetings / 0-turn) are filtered and never prompt. |
| `/mh-propose [scope]` | Trigger the proposer. Project scope → candidate + trial; account scope → inactive candidate awaiting a verdict. Scope: (none)=project-role, `project`=project-global, `role-global`=account-role, `account`=account-global. |
| `/mh-activate <scope> <vN> [--force]` | Activate a candidate. Account scopes require a winning `ab-verdict.json`; `--force` overrides. Project scopes are allowed freely (also a manual rollback). |
| `/mh-promote [global\|role]` | Promote proven project rules into the account candidate (then validate with `ab`). |
| `/mh-status` | Per-layer active version, scores, in-progress trials, pending verdicts. |

Auto-propose fires from the `session.idle` handler when a project layer reaches
its threshold and no trial is in progress.

---

## 7. The TB2 side (`term-bench2/`)

`runner.py` runs Terminal-Bench 2 tasks in a bwrap/tmpfs sandbox and composes the
harness into `AGENTS.md`. Relevant subcommands:

- `run` — run tasks through opencode, score, optionally record into the store.
  Flags added for evolution: `--agent NAME` (compose role layers), `--pin
  LAYER=vN` (evaluate a specific candidate instead of the active version).
- `ab` — the **account-layer referee**. Runs each task through two arms — arm A =
  all-active composition, arm B = the same but the target layer pinned to the
  candidate — interleaved per pair, then writes the verdict.

### `ab-verdict.json` — the cross-language contract

Written by Python `ab` into `candidates/<vN>/ab-verdict.json`; read by the plugin's
`/mh-activate` (`harness-store.ts:readAbVerdict`):

```json
{
  "layer": "account-global",
  "candidate": "v4",
  "baseline": "v3",
  "winner": "candidate",          // "candidate" | "active" | "tie"
  "candidateRate": 0.72,
  "activeRate": 0.61,
  "nTasks": 25,
  "k": 1,
  "taskResults": { "<task>": { "candidate": [1], "active": [0] } },
  "model": "anthropic/claude-sonnet-4-6",
  "timestamp": "…"
}
```

`/mh-activate` activates an account candidate only when `winner === "candidate"`.
Only arm B (the candidate) is recorded into the candidate's `score.json`; a 0-turn
run (timeout / transient failure) is never recorded, so it cannot pollute the
fitness signal.

Example:

```bash
# propose an account-global candidate, then referee it on the baseline
/mh-propose account
python3 term-bench2/runner.py ab \
    --layer account-global --candidate v4 --task-file term-bench2/baseline-tasks.txt --k 1
/mh-activate account v4        # honors the verdict
```

---

## 8. What this is NOT

- Not fine-tuning the model, not editing opencode's source, not changing tools.
- It is prompt-space search with an empirical fitness function. The published
  `agent.py` optimizations (env-bootstrap, native tool calls, marker polling)
  were themselves *discovered* by this kind of automated evolution — the same
  principle applied one level up.

---

## 9. File map

| Concern | File |
|---|---|
| Store layout, layers, trial/activation, verdict reader | `opencode-plugin/src/harness-store.ts` |
| Hooks: inject, score, resolve trial, auto-propose, commands | `opencode-plugin/src/index.ts` |
| Proposer + promoter (LLM sessions) | `opencode-plugin/src/propose.ts` |
| Human scoring prompt | `opencode-plugin/src/score.ts` |
| TB2 runner: compose harness, `run`, `ab`, pinning, roles | `term-bench2/runner.py` |
| TB2 store helpers (Python mirror) | `term-bench2/bench_store.py` |

---

## 10. Where this is headed

The loop's known weaknesses (noisy fitness gates, prompt-only search space,
no causal failure analysis, no held-out split, prompt bloat, sparse human signal)
and the research-backed plan to fix them are documented in
[enhancement-roadmap.md](enhancement-roadmap.md).

## 11. Phase 4: Evolvable artifacts and dense judge

**Evolvable knobs (project layers only)** — Beyond behavioral rules (system.md/tools.md),
the proposer can evolve configuration knobs that affect the agent's runtime environment:

- **agent-config.json** — bash execution timeout and other agent-level settings
  (`active/agent-config.json` per layer). Schema whitelisted; rides the candidate/trial/ab
  lifecycle just like system.md rules.
- **env-policy.json** — environment-snapshot probes (e.g., `lsPath`, `maxLsEntries`,
  `languageProbes`) that control what context is captured before each session
  (`active/env-policy.json` per layer). Whitelisted schema; project-layer-only scope
  (bench `ab` runs the inert build agent, so account-layer env-policy changes can't be
  measured). Both knobs are optional; absence is valid.

**Dense judge and calibration** — For project layers, manually scoring each session
(5-session trial gate) is noisy and expensive. A calibrated LLM judge can densify the
signal:

- **Shadow mode:** Set `judgeModel` in `~/.config/opencode/.meta-harness/config.json`
  (e.g., `{"judgeModel": "openrouter/google/gemini-2.5-flash"}`) to enable. The judge
  scores sessions in parallel with `/mh-score` (human ground truth).
- **Calibration:** Judge and human verdicts are compared. Once the judge agrees with
  humans on ≥20 sessions at ≥80% accuracy (`judgeCalibration`), it is **calibrated**.
- **Maker-checker mode:** Pre-fills the score prompt with the judge's suggested verdict
  for human approval/edit before saving (small change in score.ts).

**Anti-gaming audit:** `python3 term-bench2/runner.py judge-audit --layer <layer>
--candidate vN [--agent NAME] [--model <model>] [--limit N]` replays the judge on
bench trial sessions against verifier ground truth. Exit codes: `0` = clean (≥80%
agreement), `1` = alarm (< 80% — judge may be gameable), `2` = could-not-assess
(all judge calls failed or no scorable sessions). Runs before trusted judge-gated
decisions.

**Observability:** All loop events (ab, trial, activate, curate, rotate, judge) are
recorded to three sinks: `term-bench2/results/meta-metrics.jsonl` (bench),
`<repo>/.meta-harness/meta-metrics.jsonl` (project), and `~/.config/opencode/.meta-harness/meta-metrics.jsonl` (account)
with `append_meta_metric`/`appendMetaMetric`. Reporter: `python3 term-bench2/runner.py
report-loop [--json]` summarizes held-out pass-rate trajectory, accept/reject/inconclusive
counts, and cumulative judge-agreement rate. `/mh-status` shows last decision.

**Difficulty-band filtering + sentinels + plateau detection** (Phase 4 cost control): To focus
the `ab` gate on tasks the model struggles with (not the trivially easy ones), use `split make
--results` to compute per-task pass rates, then filter to a pass-rate band [0.2, 0.8] with a
small set of easy-task "sentinels" that ride held-out only as regression guards. `report-loop`
detects project plateau (4 trials without improvement) and writes an auto-pause flag that skips
auto-propose; unpause manually or via a fresh plateau-free verdict.

## 11b. Agentic proposer store access (2026-07-11)

The founding paper's core mechanism (Meta-Harness, arXiv 2603.28052) is a
proposer that reads the RAW archive — source, scores, full traces of prior
candidates — through the filesystem, because compressed digests lose the
evidence. Our proposer session always had file tools (it delivers artifacts by
writing staging files); the prompt just never told it to read.

Now it does: `propose.ts:buildStoreAccessSection` injects the layer's store
root, the on-disk layout, and a candidate index (per version: pass/fail,
trajectory count, diagnosis present) into the proposer AND curator prompts,
with the instruction to inspect full failing trajectories and prior candidates'
rules/scores before proposing — the embedded 5KB excerpts are demoted to an
index. The store is declared STRICTLY READ-ONLY to the session; staging remains
the only write target, and selection gates are untouched. Held-out trajectories
are never written to any store, so nothing leakable exists on disk for the
proposer to find. Because an exploring proposer runs longer, the staging wait
is now `proposerTimeoutMin` (config, default 20 min, was fixed 10).

## 12. Status & gotchas

- Selection gate, promotion, degenerate-session filter, role wiring, version
  pinning, and the `ab` referee are implemented and verified end-to-end.
- A meaningful `ab` verdict needs the full task set (`--task-file
  baseline-tasks.txt`, 43 tasks); a 2-task run cannot distinguish a winner.
- **Model IDs must be provider-prefixed** (`anthropic/claude-sonnet-4-6`). A bare
  name fails provider resolution under oauth and surfaces as a misleading
  "Unexpected server error" with zero turns. The runner defaults are prefixed.
- `term-bench2/retry_provider.py` re-runs a subcommand through a genuine provider
  *error* outage (backoff capped at 10 min); it treats a timeout as "up," so it
  will not spin on a slow task.
- **Calibration feedback loop:** once calibrated, prefilled decisions the human
  rubber-stamps still count toward the calibration window and can mask judge
  drift; `judge-audit` (replayed against verifier ground truth, not human
  agreement) is the independent safety net against this.
- `report-loop`'s default project sink (`default_meta_metrics_sinks`) assumes
  the worktree is this repo (`META_ROOT`); for other projects pass `--sink
  <worktree>/.meta-harness/meta-metrics.jsonl` explicitly.
- `_parse_ts`/`report-loop`'s timestamp parsing needs Python 3.11+ — earlier
  versions' `datetime.fromisoformat` rejects the `Z` suffix.
