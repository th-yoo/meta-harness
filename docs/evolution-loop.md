# The Meta-Harness Evolution Loop

How meta-harness improves an opencode coding agent — the mechanism, the layers,
the feedback loop, and where it lives in the code.

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

## 10. Status & gotchas

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
