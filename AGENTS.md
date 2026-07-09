# AGENTS.md

## What this repo is

A Terminal-Bench 2.0 agent harness. The single class `AgentHarness` in `agent.py` subclasses `Terminus2` (from the `harbor` package) and adds:
- **Environment bootstrapping**: gathers a sandbox snapshot before the first turn so the agent doesn't waste turns on `ls`/`which`.
- **Native tool calling**: bypasses harbor's JSON/XML parsing in favor of the LiteLLM `tools` parameter.
- **Marker-based polling**: sends an `echo '__CMDEND__N__'` after each command and returns early when the marker appears, reducing idle wait.

Entry point: `agent:AgentHarness` (imported by the `harbor run` CLI).

Beyond the published agent, the repo also hosts a **self-improving evolution
system** (`term-bench2/` + `opencode-plugin/` + `.meta-harness/`) that evolves the
agent's layered system prompt and validates candidates against Terminal-Bench 2.
See [docs/evolution-loop.md](docs/evolution-loop.md) for how that works.

## Running the harness

```bash
pip install harbor

export ANTHROPIC_API_KEY=<key>

harbor run \
  --agent-import-path agent:AgentHarness \
  -d terminal-bench@2.0 \
  -m anthropic/claude-opus-4-6 \
  -e runloop \
  -n 20 \
  --n-attempts 5
```

There is no local test suite. Verification = running the harness against Terminal-Bench tasks.

## Key files

| File | Purpose |
|---|---|
| `agent.py` | Entire agent implementation (`AgentHarness`) |
| `anthropic_caching.py` | Adds `cache_control: ephemeral` to the 3 most recent messages for Anthropic models |
| `prompt-templates/terminus-kira.txt` | System prompt template; uses `{instruction}` and `{terminal_state}` placeholders |
| `pyproject.toml` | Dependency list; requires Python ≥ 3.12 |

## Dependencies

- `harbor>=0.1.44` — provides `Terminus2`, `TmuxSession`, `Chat`, trajectory models
- `litellm<1.82.7` — LLM calls (pinned upper bound; do not exceed)
- `anthropic` — for Anthropic-specific caching headers
- `tenacity` — retry logic on LLM calls

## Tool schema (tools the agent exposes to the LLM)

Three tools defined in `TOOLS` (agent.py:142):
- `execute_commands` — required fields: `analysis`, `plan`, `commands[]`; each command has `keystrokes` (required) and `duration` (default 1.0, max 60s)
- `task_complete` — signals task is done; triggers a confirmation checklist before finalizing
- `image_read` — reads an image file via `base64` exec, sends it multimodal; only for image formats (PNG/JPG/GIF/WEBP)

## Important implementation details

- **`reasoning_effort` requires `temperature=1`** (agent.py:633) — enforced automatically; do not override separately.
- **Output truncated at 30 000 bytes** per turn (`_limit_output_length`, agent.py:334).
- **Block timeout**: any infrastructure API call blocked >600 s raises `BlockError`.
- **`task_complete` double-confirmation**: calling `task_complete` once sends a checklist prompt; calling it a second time actually terminates.
- **Marker lines are stripped** from terminal output before the LLM sees it (agent.py:283–288); do not confuse them with real output.
- **Context overflow**: on `ContextLengthExceededError`, the agent unwinds messages and summarizes; on `OutputLengthExceededError`, it retries with a shorter-response prompt.
- **Anthropic caching**: applied only when model name contains `anthropic` or `claude`; patches the 3 most recent messages (anthropic_caching.py:21).

## Conventions

- All LLM calls go through `_call_llm_with_tools` (bypasses harbor's `Chat`); token counts are manually updated on `chat._cumulative_*` fields.
- Prompt template path is resolved relative to `__file__` (agent.py:311); keep `prompt-templates/terminus-kira.txt` co-located with `agent.py`.
- The agent name string returned by `name()` is `"terminus-kira-env-bootstrap"` — this is recorded in trajectories.

## opencode plugin (TypeScript port)

`opencode-plugin/` is a TypeScript opencode plugin that ports the three core optimisations into opencode's hook system.

### File map

| File | Ports |
|---|---|
| `opencode-plugin/src/index.ts` | Plugin entry point; wires hooks |
| `opencode-plugin/src/env-snapshot.ts` | `_gather_env_snapshot()` — runs bootstrap cmd via Bun shell |
| `opencode-plugin/src/bash-timeout.ts` | Marker-based polling heuristic — lowers timeout on fast commands |
| `opencode-plugin/package.json` | `@opencode-ai/plugin` dep; `bun run typecheck` |
| `opencode-plugin/tsconfig.json` | Bun + ESNext + bundler resolution |

### How each feature maps

| Python harness | opencode hook | Notes |
|---|---|---|
| `_gather_env_snapshot()` → prepend to first prompt | `chat.message` hook; `output.parts.unshift(...)` | Fires once per session (tracked by `bootstrappedSessions` set); injected part must have `id`, `sessionID`, `messageID` set manually — `assign()` ran before the hook |
| Marker-based polling (early exit) | `tool.execute.before` on `"bash"` tool; lowers `args.timeout` | Heuristic only — opencode's bash tool already exits as soon as the process ends; this caps maximum wait for known-fast commands (cd, ls, echo, …) |
| `anthropic_caching.py` | Built into opencode `transform.ts:applyCaching()` | No hook needed; caching is automatic for Anthropic/Claude models |

### Activating the plugin

Add to `opencode.json` in the project root (or `~/.config/opencode/opencode.json` for global):

```json
{
  "plugin": ["./opencode-plugin/src/index.ts"]
}
```

### Typecheck

```bash
cd opencode-plugin && bun install && bun run typecheck
```

### What is NOT ported (requires opencode source changes)

- **Exact marker polling**: appending `echo '__CMDEND__N__'` and polling for it requires modifying the bash tool's execution loop in `packages/opencode/src/tool/shell.ts`. The plugin-level heuristic is the best approximation available without source changes.
- **`task_complete` double-confirmation checklist**: opencode has no equivalent hook; would need a new hook in the session loop.
- **Context summarization / unwind logic**: opencode has its own compaction system (`experimental.session.compacting` hook); the Python strategy is superseded.
