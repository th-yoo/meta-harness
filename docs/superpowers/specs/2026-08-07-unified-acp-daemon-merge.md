# Unified ACP daemon — merge cc-api-daemon + ACP daemon (design spec)

**Status:** design, awaiting build (next session). Author handoff 2026-08-07.

**Goal:** one ACP daemon that routes by model — cheap/haiku over the API SDK,
everything else over the Agent SDK (subscription lane) — on a WebSocket
transport, with the heavy (subprocess) backend held in an adaptive pool.

Merges the two daemons proven this session: `~/z2/cc-api-daemon` (WebSocket +
bare-SDK `ApiSession` + `DispatchableSession` swap-contract + `models/list`)
and `meta-harness/cc-gate-plugin/src/acp` (Agent SDK `WarmSession` =
subscription lane = opus). The `DispatchableSession` + `makeSession` seam was
built for exactly this.

---

## The three requirements, resolved

### 1. Transport: WebSocket
Take cc-api-daemon's transport wholesale — localhost WebSocket + discovery file
(`~/.config/kkamak/acp-<fp>.json`, kernel-assigned port published post-bind).
Live-proven this session (2ms transport overhead, 113ms spawn+bind). Keep the
`--stdio` path with its `FrameDecoder` — stdio is the spec-canonical ACP
transport and must survive.

### 2. Route by model: haiku → API SDK, others → Agent SDK
The daemon picks the backend per `session/prompt`, keyed on the requested model:

| model | backend | mechanism | cost |
|---|---|---|---|
| `claude-haiku-*` | **`ApiSession`** (bare `messages.create`) | in-process fetch, NO subprocess | ~0 RSS, one HTTP call |
| everything else | **`WarmSession`** (Agent SDK `query()`) | pooled `claude` subprocess | ~140MB private/child, subscription lane |

Both already implement `DispatchableSession`. Route at dispatch, not at pool
construction: `makeSession` (or a dispatch-time selector) chooses the class by
model tier.

**Why this routing is right for the workload (the sharp consequence):**
`ApiSession` is bare fetch IN the daemon host — it spawns NO subprocess, costs
~0 incremental RSS. The gauge BASELINE is haiku ([[tb2-baseline-account-global]]),
so the highest-volume traffic routes to the zero-subprocess lane. Only opus
CANDIDATE runs need the heavy Agent-SDK pool. The routing collapses the pool's
memory footprint to just the non-haiku turns.

**MUST VERIFY before adopting (unresolved):** whether haiku-via-bare-SDK on the
OAuth token bills SUBSCRIPTION or API-TIER pay-go. Measured 2026-08-07: haiku
returned HTTP 200 on bare SDK (sonnet-5/opus-5/fable-5 429'd). But 200 ≠ known
billing lane. If it bills API-tier pay-go, routing haiku there SPENDS real
dollars (haiku $1/$5 per Mtok) and needs billing configured; if it draws
subscription, it's free. Probe: run one haiku turn on bare SDK, check whether
it decrements the subscription 5h window or bills API. This decides whether the
routing saves memory for free or trades pennies for it.

### 3. Adaptive pool — grow to max on demand, shrink on idle
Applies ONLY to the Agent-SDK (`WarmSession`/subprocess) backend. `ApiSession`
is stateless bare fetch — no pool needed (a bare concurrency limiter at most).

```
min      = 0        reap fully between the sparse gauge/sensor bursts
max      = peak concurrency of the AGENT-SDK lane (UNMEASURED — see below)
grow     = all warm entries busy AND queue depth > 0 → spawn one (up to max)
shrink   = entry idle > TTL → reap it (SIGTERM the claude subprocess)
TTL      = ~30-60s  (exceed intra-burst gap; anti-flap)
```

The pool already tracks `idleMs()`; it just doesn't reap on it. Add the reaper.
Grow on **queue depth**, not arrival rate (a burst of quick turns must not
trigger spawns that finish before use).

**`max` is the one unmeasured parameter.** Grep the gauge/candidate dispatch:
does it run non-haiku derivations serially or fan out? Serial → max=1 (pool
degenerates to warm/not). Fan-out → max=peak batch width. This is the only
free knob; everything else is determined. Measured this session: fresh child =
85MB host + 140MB private/child, cold spawn 113ms — so the cost of an
over-sized max is bounded and the cost of an under-sized one is serialization.

---

## Architecture

```
WS client ──ws/JSON-RPC──► unified daemon
                             session/prompt(model) ──route──┐
                                                            │
                    haiku*  ─────────────► ApiSession (in-proc bare SDK, API tier)
                    else    ─► adaptive pool ─► WarmSession (Agent SDK query(), subscription)
```

- ONE daemon host (bun, ~85MB), WebSocket transport, discovery file.
- `DispatchableSession` contract unchanged — both backends already satisfy it.
- `kkamak/models/list` via native `query().supportedModels()` (control channel,
  subscription lane, no bill) with REST `GET /v1/models` as fallback. Namespaced
  per the ACP `_meta.kkamak` rule; codes -32004/-32005.
- Ports FROM cc-api-daemon: WebSocket transport, discovery file, `ApiSession`,
  `DispatchableSession`, `models/list`, `.system` override.
- Ports FROM ACP daemon: `WarmSession`, `selectEvidence`/`ModelEvidence`
  (reconciles `query()`'s modelUsage map — needed for the Agent-SDK lane).

## Which repo is the base?
Build the merge IN the ACP location that's deployed and load-bearing
(`meta-harness/cc-gate-plugin/src/acp`), pulling cc-api-daemon's pieces in —
NOT the reverse. The ACP daemon has the lane (can't be ported) and the live
consumers (review-sensor, gauge). cc-api-daemon becomes the source of the
WebSocket/ApiSession/contract code, then can be retired or kept as the
standalone API-tier reference.

## Open decisions for the builder
1. **Haiku billing lane** (blocking — see §2). Probe before committing the route.
2. **max** (grow ceiling) — measure agent-SDK-lane peak concurrency.
3. **One pool or two?** ApiSession needs none; WarmSession needs the adaptive
   pool. Likely: pool only the WarmSession side, route haiku around it entirely.
4. **Deployed-instrument change:** this touches the live ACP daemon that the
   review-sensor rides mid-checkpoint (2026-08-13). Needs boundary ts + merge
   go + the plugin version bump (merging ≠ deploying — the version-keyed cache
   bit twice before). Don't land it hot without the checkpoint accounted.
