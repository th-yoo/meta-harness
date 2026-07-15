# Auth delegation & concurrency — design note (2026-07-16)

Settles a recurring question: does the harness need to abstract the auth backend
(Anthropic OAuth vs OpenAI-compatible API key vs …)? **No.** And how do we treat
the one place delegation breaks (parallel credential access)? **Surface it, don't
handle it — let the user choose.**

## Principle: delegate the auth backend to the agent; the harness only DELIVERS credentials

The agents we drive — **opencode** (via the `opencode-claude-auth` plugin),
**Claude Code** (native), **OpenClaw** — OWN the auth protocol: OAuth refresh,
token rotation, provider resolution (`provider/model`), the API call itself. The
harness does NOT re-implement any of it, and **must not add a provider-agnostic
auth / token-manager layer** — that would duplicate what the agents already do.

The harness's ONLY auth job is **credential DELIVERY into the podman sandbox**.
Because the container is isolated, the harness mounts the host credential
(`.credentials.json` / `auth.json`) or sets the provider key env
(`ANTHROPIC_API_KEY`, …) so the agent can read it, then delegates. `agent-auth.ts`
is exactly this — thin, driver-specific glue, **not a backend abstraction**.

Consequence: adding a new backend (an OpenAI-compatible provider, etc.) = pass the
right `--model` + deliver that provider's key. There is no abstraction to build.
**Static API keys are the simple case** (no refresh, no rotation, no concurrency
hazard); OAuth subscription is the only path that carries a complication.

## The one gap: parallel credential access

Delegation holds for a **single process** — which is what opencode / CC / OpenClaw
are built for. It **breaks under `--parallel`**: N sandboxed agents sharing one
credential store race the OAuth refresh-token rotation.

CONFIRMED (Anthropic `claude-code` issues [#22600](https://github.com/anthropics/claude-code/issues/22600),
[#48786](https://github.com/anthropics/claude-code/issues/48786); local `~/.claude`
`expiresAt` ≈ 8h): the OAuth **refresh token is single-use** — a refresh rotates it
server-side and invalidates every other holder, and neither CC nor this harness
locks the shared credential file. First container refreshes → the rest hold an
invalidated token → auth failure.

Precise: the race fires **per refresh (~8h access-token expiry), NOT per task**. So
short parallel runs that finish within the token TTL are safe; only long / overnight
sweeps cross the boundary and hit it.

## DECISION: surface, don't handle

**We do NOT build handling** — no refresh coordinator, no file lock, no retry. That
would re-implement the coordination the agents themselves lack (against the
delegation principle) and add complexity for a narrow window.

**We SURFACE it and let the USER choose.** The `--parallel` guard (`validateParallel`,
`cli.ts` — shared by `run` and `ab`) REJECTS oauth+parallel UP FRONT with an
actionable message (`export ANTHROPIC_API_KEY … or drop --parallel`). The user then
chooses:
- **run tasks SEQUENTIALLY** (drop `--parallel` — oauth is safe serial), or
- **supply a static API key** — the `keyOnly` path: no refresh, no rotation, no race,
  parallel-safe. keyOnly removes the shared rw `auth.json` mount
  (`/root/.local/share/opencode`) — the exact race surface — entirely.

Tested: `bench-cli-ab.test.ts` (the `ab --parallel` guard fires) +
`bench-agent-auth.test.ts` (keyOnly removes the race surface) — commit `46131ec`.

## Rejected alternatives

- **Single-flight refresh coordinator** (host lock: one container refreshes, others
  wait + re-read) — the fix CC #22600 itself proposes. Rejected: re-implements
  agent-side coordination; complexity for a narrow window. Surface-and-choose is
  simpler and keeps the harness out of the auth protocol.
- **Duration-gated oauth+parallel** (allow when estimated run < token-remaining) —
  rejected: run-duration prediction is fragile; the fail-safe blanket guard is
  simpler and safe by construction.

## Scope note

This is about the harness delivering credentials to sandboxed *bench* agents. The
`agent-auth.ts:33` module comment historically said rotation happens "on use"
(implies per-request); the accurate statement is "on refresh (~8h expiry)" — which
is why short parallel runs are safe and only long sweeps hit the race.
