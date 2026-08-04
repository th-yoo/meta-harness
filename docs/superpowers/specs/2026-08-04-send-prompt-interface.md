# send-prompt — the interface every LLM caller actually wants

**Status:** DESIGN NOTE (2026-08-04). Supersedes the caller-facing half of
`plans/2026-08-04-acp-session-pool.md` (Tasks S1-S4, P0-P2). Does NOT touch
§6e's gauge gating, nor the already-built `acp-wire.ts` / `warm-session.ts` /
`acp-paths.ts`.

**Deliberately short.** Four review rounds on a 2,900-line plan established
that long plan prose stops converging — each pass's fixes generated the next
pass's defects. This note fixes the shape and the node boundaries; the detail
belongs in the nodes.

---

## 1. The ruling

> "session ideas for proposer, reviewer, judge, refiner, ... is just
> keep-alive." — user, 2026-08-04

If a session is only keep-alive, **no caller should ever see one.** The shape
every one of those seats wants is the one the OpenAI SDK exposes: one call,
model per call, text out.

```ts
const response = await openai.chat.completions.create({
  model: "gpt-4o-mini",
  messages: [{ role: "user", content: "Hello, world!" }],
})
```

`minimal/llm.ts`'s five call sites already have exactly this shape — which is
why converting it to async was two `await`s and nothing else.

## 2. The interface

```ts
/** ONE model call. Keep-alive, connection reuse, warm subprocesses and
 * session lifecycles are provider-internal and invisible here. */
export function sendPrompt(
  prompt: string,
  opts: {
    model: string
    /** The isolation set (acp-wire.ts's WarmIsolation). Two shipped values:
     * GAUGE_ISOLATION (systemPrompt "") and REASONING_ISOLATION (a real
     * "careful reasoning assistant, no tools" prompt). A VALUE, not an id —
     * there is no registry and nothing to look up on a wire. */
    isolation: WarmIsolation
    /** Explicit, never inferred from the model string. Magic provider
     * selection is how a haiku call silently becomes an OpenAI call. */
    provider: ProviderId
    timeoutMs?: number
    maxTokens?: number
    schema?: Record<string, unknown>
  },
): Promise<SendOutcome>

export type SendOutcome =
  | { ok: true; text: string; model: string; canonicalModel: string }
  | { ok: false; kind: "no-call" | "call-consumed" }
```

**`SendOutcome` keeps §6e's wire-send boundary law at the top level, not
buried in a provider.** `no-call` means the prompt bytes never reached the
model and a caller may retry or fall back; `call-consumed` means they did and
it must not. That distinction is the whole reason the gauge lane can fail open
without ever spending twice on one record, and it must survive the
abstraction. A caller that prefers exceptions wraps this; the interface itself
never throws.

**Amendment, 2026-08-05, pre-consumption.** `maxTokens?: number` added to
`SendPromptOptions`. Reason: the design-time seats (proposer/reviewer/
revision, N5) produce multi-KB replies; N2's transport defaults `max_tokens`
to 2048, so migrating those seats without an output-length knob would
silently truncate them — an instrument downgrade this spec never intended.
The interface had zero consumers at the time of this amendment, so it is a
pre-data change, not a breaking one: the provider default stays 2048, so
every existing gauge-lane request is byte-unchanged when the field is
absent.

## 3. Providers

| id | transport | keep-alive is… | premium reach |
|---|---|---|---|
| `anthropic-api` | Messages API via `@anthropic-ai/sdk` (today's `sdkCall`) | HTTP connection reuse — nothing to manage | walled when the tier is 429 |
| `anthropic-cli-warm` | bundled `claude` CLI via the ACP daemon | a pool of `WarmSession`s, `/clear` between calls | **reaches sonnet/opus during a raw-API 429 wall** (measured 2026-08-04) |
| `openai` | `openai` SDK chat completions | HTTP connection reuse | n/a — bills per token, no subscription pool |

Only `anthropic-cli-warm` has anything to keep warm in the process sense.
That is the entire justification for `WarmSession`, the pool, and the daemon —
and none of it is visible above this table.

## 4. What survives, what collapses

**Survives, already built and reviewed:**
- `acp-wire.ts` — framing, `ACP_BUDGET`, the two error codes, `modelProvenBy`,
  `WarmIsolation`/`GAUGE_ISOLATION`, `_meta.kkamak` namespacing.
- `warm-session.ts` — one warm `Query`, generation-bound pump, sequenced
  `/clear`, three-way outcomes. It is now the `anthropic-cli-warm` provider's
  engine rather than a thing callers touch.
- `acp-paths.ts` — socket path, whole-env fingerprint, the two locks.
- ACP stays the wire between client lib and daemon (user ruling, 2026-08-04).
  The daemon mints and retires session ids **internally, one per request**;
  they never appear in a caller's code.

**Collapses:**
- **S1's profile registry** → two exported `WarmIsolation` values. No ids, no
  `resolveProfile`, no `isGaugeEligible` lookup — the caller passes the value
  it wants, and gauge-eligibility becomes a property of the CALL SITE
  (`callModelDerive` alone stamps §6e records), which is where it was always
  enforceable anyway.
- **S4's session API** — `openSession`, `DaemonSession`, `close()`. Gone.
- **S3's `session/set_config_option` and `session/close`** — nothing external
  drives a session's lifetime any more.
- **P1's migration** → a provider swap at five call sites.

**Unchanged:** §6e's bar, its sized-go gates, and the live-flip decision. This
note changes who can call what, not what the gauge measures.

## 5. Node boundaries (replacing S1-S4, P0-P2)

| id | node | writes | deps | cost |
|---|---|---|---|---|
| **N1** | `send-prompt.ts` — types, `SendOutcome`, `REASONING_ISOLATION`, provider registry (no providers) | `src/gauge/send-prompt.ts` + test | acp-wire | M |
| **N2** | `anthropic-api` provider — wraps today's `sdkCall` | `src/gauge/providers/anthropic-api.ts` + test | N1 | M |
| **N3** | `anthropic-cli-warm` provider — pool + daemon + client, ACP on the wire, sessions internal | `acp-pool.ts`, `acp-daemon.ts`, `acp-client.ts` + tests | N1, T4, T5a | **C** |
| **N4** | `openai` provider — own go, bills real money | `src/gauge/providers/openai.ts` + test | N1 | M + $ |
| **N5** | callers migrate — `llmCall` → `sendPrompt`, five sites | `minimal/llm.ts`, `minimal/llm-acp.ts` | N2 (N3 optional) | M |

**N2 before N3 deliberately.** It proves the interface against a transport
that already works, so when N3's warm path misbehaves the interface is not
also on trial.

**N5 needs only N2.** The proposer gets an explicit isolation set — closing
the undeclared-harness finding from the pool plan's §A — without waiting for
any warm-process machinery.

## 6. Open items

- **Pool cap.** `KKAMAK_ACP_MAX_SESSIONS` has been an asserted 4 since it was
  written. T4's Step-4 measurements now carry the RSS figures to size it. Do
  that in N3, not by assertion.
- **Proposer instrument registration.** Moving the proposer onto an explicit
  isolation set changes its context, and proposals feed the A/B loop — so it
  needs a boundary ts in the LOOP's record (not §6e). Fold into N5; the old P0
  never resolved which doc owns it, and that ambiguity is still open.
- **OpenAI cost.** N4 bills per token with no subscription pool behind it. It
  is the one node here that spends, and it needs its own sized go.

## 7. Why this is smaller than what it replaces

The pooled-session plan modelled sessions as containers because ACP does, and
ACP does because editors need conversations. Our callers do not have
conversations — they have one prompt and one answer, and they wanted the
process kept warm between them. Modelling that as a session forced profiles,
ids, lifecycle methods, cancel scoping and eviction policy into the caller's
view, and every one of those was a place to get something wrong. Deleting the
abstraction deletes its failure modes.
