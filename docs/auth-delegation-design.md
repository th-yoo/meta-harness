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

## DECISION: surface, don't handle → SUPERSEDED by the freshness gate (2026-07-16)

> **UPDATE 2026-07-16 — oauth+parallel is now SAFELY SUPPORTED, no API key needed.**
> The original "surface, don't handle — user picks serial or key" decision below was
> superseded by the **freshness gate** (commits `0a823bd` + `ec3b31f` + `aeabef1`;
> validated live on a real 2-concurrent oauth run). Insight: the refresh-token race
> only fires if a container's token *refreshes* mid-parallel-window (~8h access-token
> expiry). So we don't coordinate the write — we GUARANTEE no task runs across the
> refresh:
> 1. **pre-flight** (`validateParallel`) refuses oauth+parallel only if the token can't
>    outlive one task (`< maxAgentTimeout + 5min`); else allows;
> 2. oauth+parallel **requires an explicit `--max-agent-timeout`** so per-task duration
>    is bounded and the freshness math is exact;
> 3. the scheduler's **`canLaunch` launch-guard** stops launching new tasks as the token
>    nears expiry — in-flight ones finish before it → graceful stop → `--resume`
>    continues (re-login if needed);
> 4. under freshness-gated oauth+parallel the containers use the normal **oauth mount**
>    (not keyOnly — `useKeyOnlyForParallel`, paths.ts): safe because `auth.json` is
>    read-only throughout the window (no refresh → no write).
>
> This IS the "duration-gated" option the Rejected list below dismissed as fragile — but
> made SOUND: it's a **per-launch freshness check, NOT a whole-run duration prediction**.
> An oauth-only user now runs `--parallel` with no key, no race, self-limited to the
> token TTL. The original serial/key path still applies when the token is stale
> (re-login) or a key is set (keyOnly). Recipe: `resume.md`.

--- original decision (historical, pre-freshness-gate) ---

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
  initially rejected because predicting *whole-run* duration is fragile. **REVISITED +
  BUILT 2026-07-16 (the freshness gate above):** the sound form doesn't predict total
  duration — it's a **per-launch** check (never launch a task the token can't outlive)
  plus a launch-guard that stops before expiry. Safe by construction, no key. So the
  concern was real but only about the *whole-run* variant; the per-launch variant is
  what shipped.

## Scope note

This is about the harness delivering credentials to sandboxed *bench* agents. The
`agent-auth.ts:33` module comment historically said rotation happens "on use"
(implies per-request); the accurate statement is "on refresh (~8h expiry)" — which
is why short parallel runs are safe and only long sweeps hit the race.
