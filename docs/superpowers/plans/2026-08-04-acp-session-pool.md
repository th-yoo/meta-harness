# ACP Session Pool — one warm LLM server for every caller

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.

**Relationship to the daemon plan.** This supersedes the DAEMON SHAPE in
`2026-08-04-acp-warm-daemon.md` (singleton → pool) and leaves that plan's
Tasks 1-4 and 7-10 standing. Read this document's §A before touching either.

**Goal:** Turn the §6e warm daemon from a gauge-only singleton into a
conformant ACP agent whose sessions are real containers with per-session
profiles, so every LLM caller in this repo — gauge (live + batch), proposer,
reviewer, judge — can share one warm, policy-centralised server.

**Architecture:** `session/new` allocates its own `WarmSession` (own `Query`,
own subprocess, own transcript) carrying a PROFILE (model, isolation option
set, cwd). `session/prompt` runs on that session's transcript only.
`session/close` frees it; an idle reaper evicts the rest. Concurrency equals
pool size; the FIFO stays *inside* one session because one transcript cannot
serve two turns (sdk.d.ts:3487 — queued messages are "dequeued and coalesced
into one turn", which for an instrument is silent data corruption, not a
race). Custom behaviour rides ACP's own extension mechanisms.

**Tech Stack:** unchanged from the daemon plan — Bun, `@anthropic-ai/claude-agent-sdk`
streaming input, `node:net`, hand-rolled JSON-RPC 2.0.

---

## §A. Why this shape, and what I argued against (recorded, not buried)

**User directive (2026-08-04):** "Update plan to implement ACP server for
other LLM (proposer, refiner, etc)." That is the governing instruction.

**My prior recommendation was narrower, and it was partly wrong.** I argued
that proposer/judge should take the agent-SDK *transport* (for premium access
during a 429 wall) but NOT the daemon, because the daemon's product is spawn
amortisation and a 1.4 s spawn is noise against a proposer call that spends
minutes generating from a 0.5 MB prompt. That cost argument still stands. Two
things I missed make the pooled server worth building anyway:

1. **The claude-code proposer driver inherits the FULL CC coding-agent
   harness, undeclared** (`minimal/llm.ts`). It is a bare
   `claude -p --model M --output-format json`, so the proposer's effective
   system prompt is Claude Code's own ~28k-token agent preamble — the same
   one §6c stripped out of the gauge for exactly this reason. Nobody chose
   that; it is what `claude -p` does by default. A session PROFILE makes the
   proposer's isolation set an explicit, recorded decision.
   (The opencode driver is out of scope by user direction, 2026-08-04.)
2. **Policy centralisation.** Model choice, auth, isolation, premium routing
   and call accounting currently live in four places (`transport.ts`,
   `agent-transport.ts`, `minimal/llm.ts`, the bench drivers). One server with
   typed profiles is one place to change them and one place to observe them.

**What is still NOT in scope, and why.** The bench drivers
(`opencode-plugin/src/bench/drivers/*`) stay out permanently. The subject
agent under measurement needs its real harness, real tools, its own sandbox
and auth; routing it through an instrument's server would change what the
benchmark measures. That is a validity argument, not a throughput one.

**Registration consequence, and it is not optional.** Moving the proposer off
bare `claude -p` onto an explicit profile CHANGES THE PROPOSER'S CONTEXT, and
proposer output is the thing the A/B loop measures. That is an instrument
change for the LOOP, not for the gauge, so §6e does not cover it. Task P0
below records it as a boundary before any proposal is generated through the
new path.

---

## §B. Conformance: what becomes standard, what stays an extension

Verified against agentclientprotocol.com (`schema.mdx`, session-setup,
session-modes, extensibility) on 2026-08-04.

**Becomes standard (we stop deviating):**

| Behaviour | Spec basis |
|---|---|
| Session = independent conversation context with own history and state | `session/new` description, verbatim |
| Profile at creation: `cwd` (REQUIRED, absolute), `mcpServers` (REQUIRED), `additionalDirectories?` | `NewSessionRequest` |
| `cwd` MUST be used for the session regardless of where the agent subprocess was spawned | session-setup, normative MUST |
| Model as session-scoped config, not per-prompt | `session/set_config_option`; `SessionConfigOptionCategory` names the model selector |
| Per-session teardown | `session/close` under `sessionCapabilities.close` |

**Stays an extension — and rides ACP's sanctioned mechanisms:**

| Ours | Sanctioned home |
|---|---|
| Within-session context reset (`/clear`) | extension method `_kkamak/session/clear` — the spec reserves every `_`-prefixed method name; unknown ones answer `-32601`, which our dispatcher already does |
| Call-consumption (`no-call` / `call-consumed`) | JSON-RPC `error.data` (JSON-RPC's own free-form slot) plus `_meta` on the prompt result |
| Instrument fingerprint | `agentCapabilities._meta.kkamak` at `initialize`, per the spec's capability-advertisement example |

**Two rules we must not break** (extensibility page):
- *"Implementations MUST NOT add any custom fields at the root of a type that
  is part of the specification."* Everything custom goes inside `_meta`. The
  daemon plan already complies; this plan keeps that.
- `traceparent` / `tracestate` / `baggage` at `_meta` root are reserved for
  W3C trace context. Never squat them.
- **Namespace every custom `_meta` key under `kkamak`.** The daemon plan's
  bare `_meta.model` / `_meta.envFingerprint` are collision risks against
  future protocol versions; the spec's own examples key by vendor
  (`zed.dev/debugMode`). This is a required change, not a preference.

---

## Global Constraints

- Everything in the daemon plan's Global Constraints still binds unless
  contradicted here: the §6e wire-send boundary law, `ACP_BUDGET` arithmetic,
  `CLI_SPAWN_BUDGET_MS`, zero-real-model-calls, the five declared test
  exceptions, F1/F2, doc-check, TDD, and merge via `scripts/merge-with-gate.sh`.
- **`WarmSession` (daemon plan Task 4) is reused with EXACTLY ONE ADDITIVE
  PARAMETER — not unchanged (review finding C1).** It is the right unit (one
  `Query`, one transcript, one FIFO, generation-guarded pump, sequenced
  `/clear`, three-way outcomes) and the pool holds N of them, but its
  `ensure()` HARDCODES the isolation set inline (`systemPrompt: ""`,
  `tools: []`, `title: "kkamak-gauge"`, `thinking: {type:"disabled"}` —
  daemon plan Task 4 Step 3). A `reasoning` profile with a real system prompt
  cannot be expressed through that literal, so profiles are undeliverable
  until it is parameterised. **Task S0 does exactly that and nothing else.**
  Do not fork or reimplement `WarmSession`; do not widen the change beyond
  S0's one parameter.
- **A session's profile is immutable after `session/new` except through
  `session/set_config_option`.** The isolation option set is chosen from a
  server-side registry of NAMED profiles; a client picks a profile by id, it
  never supplies raw SDK options. A client that could hand-craft
  `systemPrompt`/`tools` could silently un-isolate the gauge.
- **The gauge profile is exactly the §6d/§6e isolation set** and is
  fingerprint-bound as today. Other profiles are free to differ, but a
  session's profile id is stamped on every record its turns produce.
- **`gaugeEligible` is ENFORCED IN CODE at one named point, not merely
  declared (review finding I2).** `session/prompt` echoes the serving
  session's `profile` in `_meta.kkamak.profile`; `DaemonOutcome.ok` carries
  it; and `callModelDerive` (daemon plan Task 7) REFUSES — returns
  `undefined`, no stamp, no fallback — when a daemon-lane result reports a
  profile that is not `gaugeEligible`. A proposal is not a derivation and
  must never enter the §6e partition, and the only way to guarantee that is a
  check on the path that writes the stamp. Test: a fake daemon answering
  `ok` with `profile: "reasoning"` produces NO record.
- Pool cap `KKAMAK_ACP_MAX_SESSIONS` (default 4, and see the sizing note in
  S2). At the cap, `session/new` answers **`ACP_ERR_POOL_EXHAUSTED = -32002`**
  with `_meta.kkamak.reason = "pool-exhausted"` — never a silent queue,
  because a caller blocked behind an unrelated session is the failure mode
  this whole redesign exists to remove.
  **It is -32002, NOT -32000 (review finding C2).** `-32000` is already
  `ACP_ERR_NO_CALL` and `-32001` already `ACP_ERR_CALL_CONSUMED` (daemon plan
  Task 2, `acp-wire.ts`). Reusing `-32000` here would hand a `session/new`
  failure a code whose entire registered meaning is "no MODEL call happened,
  the fallback is safe" — a §6e law-L3 statement about a request that never
  involved a prompt. Add `ACP_ERR_POOL_EXHAUSTED` to `acp-wire.ts` beside the
  other two, and extend that file's existing code test to assert all THREE
  are distinct and inside the reserved implementation-defined server-error
  band (`-32099..-32000`).
- Per-session idle eviction (`KKAMAK_ACP_SESSION_IDLE_MS`, default 900000)
  replaces the daemon-wide reaper for sessions; the daemon still self-exits
  when it holds zero sessions and has been idle for `KKAMAK_ACP_IDLE_MS`.

---

### Task S0: Parameterise `WarmSession`'s isolation options — one additive change

**Why this is its own task.** Everything below depends on a session choosing
its option set, and `WarmSession.ensure()` currently hardcodes it (daemon plan
Task 4 Step 3). This task changes that ONE thing, proves the gauge's bytes did
not move, and stops. Doing it inside S2 would mix a hardened-file edit into a
new-file task and make the review of both worse.

**Files:** modify `cc-gate-plugin/src/gauge/warm-session.ts`; modify
`cc-gate-plugin/test/warm-session.test.ts` (APPEND only — this is a SIXTH
declared test exception on top of the daemon plan's five, and it adds
assertions rather than changing any).

**Interfaces:**

```typescript
// `WarmIsolation` and `GAUGE_ISOLATION` are DECLARED IN `acp-wire.ts`
// (daemon plan Task 2), not here. `WarmIsolation` is the per-session slice of
// the SDK option set — `model`, `cwd` and `env` stay separate, being
// per-session VALUES where this is the session's POLICY — and
// `GAUGE_ISOLATION` is the §6d set as its canonical value, byte-identical to
// the literal `ensure()` used before this task.
//
// They live there so that S0 and S1 do NOT form a chain: S1's
// `AcpProfile.options` IS a `WarmIsolation`, so declaring the type here would
// put S1 behind S0 on the project's longest path. Both already import
// `acp-wire.ts`; see the DAG's §7.
import { type WarmIsolation, GAUGE_ISOLATION } from "./acp-wire.ts"

export class WarmSession {
  constructor(
    env: Record<string, string | undefined>,
    opts?: { /* …every existing option, unchanged… */ isolation?: WarmIsolation },
  )
  /** The isolation set this session will spawn under. READONLY and declared
   * (review finding I5): S2's wiring test and S0's default test both need to
   * read it, and an undeclared test-only accessor bolted onto a hardened file
   * is how that file starts drifting. Not a getter for mutation — the value
   * is fixed at construction. */
  readonly isolation: WarmIsolation
}
```

`ensure()` spreads `this.isolation` (default `GAUGE_ISOLATION`) in place of the
inline literal. Nothing else in the file changes — not the pump, not the
generation guard, not `finish()`, not the timers, not the §6e law.

- [ ] **Step 1: Write the failing tests** (append to the existing file)

```typescript
test("GAUGE_ISOLATION is the §6d set, field for field", () => {
  expect(GAUGE_ISOLATION).toEqual({
    systemPrompt: "",
    settingSources: [],
    settings: { autoMemoryEnabled: false },
    persistSession: false,
    strictMcpConfig: true,
    tools: [],
    title: "kkamak-gauge",
    thinking: { type: "disabled" },
  })
})

test("the DEFAULT isolation is the gauge one — omitting the option changes nothing", () => {
  // The regression guard for §6d/§6e: every existing caller constructs
  // WarmSession without `isolation` and must keep the exact wire shape the
  // daemon plan's Task 4 tests already pin.
  const ws = new WarmSession(stubEnv())
  expect(ws.isolation).toEqual(GAUGE_ISOLATION)
  ws.close()
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("a custom isolation reaches the wire", () => {
  test("a non-empty systemPrompt is what the request carries", async () => {
    // The capability the whole pool plan rests on: a `reasoning` profile is
    // undeliverable if this literal stays hardcoded (review finding C1).
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU_DATED) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url }, {
      isolation: { ...GAUGE_ISOLATION, systemPrompt: "MARKER-SYSTEM-PROMPT", title: "kkamak-reasoning" },
    })
    try {
      expect((await ws.oneShot("hi", HAIKU, { recycle: true })).kind).toBe("ok")
      expect(JSON.stringify(CAPTURED[0])).toContain("MARKER-SYSTEM-PROMPT")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)
})
```

- [ ] **Step 2:** run — FAIL (`GAUGE_ISOLATION` not exported).
- [ ] **Step 3:** implement; `ensure()` spreads `this.isolation`.
- [ ] **Step 4:** `bun test` 0 fail — **every daemon-plan Task 4 test must pass
  BYTE-UNMODIFIED**; that is the proof the gauge lane did not move. `tsc` clean.
- [ ] **Step 5:** commit `feat(gauge): WarmSession takes its isolation set, defaulting to the gauge one`.

### Task S1: Session profiles — the named registry

**Files:** create `cc-gate-plugin/src/gauge/acp-profiles.ts`; test
`cc-gate-plugin/test/acp-profiles.test.ts`.

**Produces:**

```typescript
/** A named, server-side instrument configuration. Clients pick a profile by
 * ID; they never supply raw SDK options, because a client that could set
 * `systemPrompt`/`tools` could silently un-isolate the gauge. */
export interface AcpProfile {
  id: string
  /** SDK options this profile pins, minus `model`/`env`/`cwd` (per-session).
   * The type is `WarmIsolation` from `acp-wire.ts` (daemon plan Task 2) — NOT
   * re-declared here, and not imported from `warm-session.ts`, so that S1 does
   * not depend on S0. */
  options: WarmIsolation
  /** Default model when the session does not set one. */
  defaultModel: string
  /** Whether records derived on this profile may carry a gauge transport
   * stamp. FALSE for every non-gauge profile — a proposal is not a
   * derivation and must never enter the §6e partition. */
  gaugeEligible: boolean
}

export const ACP_PROFILES: Record<string, AcpProfile>
/** THE single source of truth for review finding I2's enforcement. Derived
 * from ACP_PROFILES — never a second hand-maintained set, because two lists
 * of "which profiles may write a §6e stamp" is exactly the drift the
 * `gaugeEligible` flag exists to prevent. An unknown id is NOT eligible. */
export function isGaugeEligible(profileId: string): boolean
/** STRICT: an unknown or absent id resolves undefined. It never falls back to
 * a default, because a typo that silently yields the gauge profile would run
 * a proposer's prompt under the gauge's empty system prompt — or worse, mark
 * its output gauge-eligible. The DEFAULT is applied by the caller, before
 * resolution, and only for a genuinely absent id (review finding I3). */
export function resolveProfile(id: string | undefined): AcpProfile | undefined
/** What `session/new` uses when the client sends no profile at all. */
export const DEFAULT_PROFILE_ID = "gauge"
```

Three profiles ship:
- **`gauge`** — the §6d/§6e set verbatim (`systemPrompt: ""`, `tools: []`,
  thinking disabled, `title: "kkamak-gauge"`), `defaultModel` haiku,
  `gaugeEligible: true`.
- **`reasoning`** — for proposer/reviewer/judge. Same isolation shell
  (`tools: []`, `settingSources: []`, no auto-memory) but a REAL system
  prompt: the same text `minimal/llm.ts` gives the opencode driver ("You are
  a careful reasoning assistant. Answer directly in plain text… Do not use
  tools, read or modify files, or run commands."). `defaultModel`
  `claude-opus-5`. `gaugeEligible: false`.
- **`reasoning-thinking`** — identical to `reasoning` with thinking enabled,
  for callers that want it. `gaugeEligible: false`.

- [ ] **Step 1: Failing tests**

```typescript
test("the gauge profile is the §6d isolation set, verbatim", () => {
  const p = ACP_PROFILES.gauge!
  expect(p.options.systemPrompt).toBe("")
  expect(p.options.tools).toEqual([])
  expect(p.options.settingSources).toEqual([])
  expect(p.options.settings).toEqual({ autoMemoryEnabled: false })
  expect(p.options.persistSession).toBe(false)
  expect(p.options.strictMcpConfig).toBe(true)
  expect(p.options.title).toBe("kkamak-gauge")
  expect(p.options.thinking).toEqual({ type: "disabled" })
  expect(p.gaugeEligible).toBe(true)
})
test("ONLY the gauge profile is gauge-eligible", () => {
  for (const [id, p] of Object.entries(ACP_PROFILES)) {
    expect(p.gaugeEligible).toBe(id === "gauge")
  }
})
test("the reasoning profile declares a real system prompt and no tools", () => {
  const p = ACP_PROFILES.reasoning!
  expect(p.options.systemPrompt).toContain("careful reasoning assistant")
  expect(p.options.tools).toEqual([])          // design-time seats never execute
  expect(p.defaultModel).toBe("claude-opus-5")
})
test("an unknown profile id resolves undefined — never a silent default", () => {
  expect(resolveProfile("nope")).toBeUndefined()
  expect(resolveProfile(undefined)).toBeUndefined()
})
test("isGaugeEligible is derived from the registry, and unknown ids are NOT eligible", () => {
  // The §6e partition guard (finding I2/C3). One source of truth: this must
  // agree with the flag for every registered profile, and refuse anything it
  // does not know rather than defaulting open.
  for (const [id, p] of Object.entries(ACP_PROFILES)) expect(isGaugeEligible(id)).toBe(p.gaugeEligible)
  expect(isGaugeEligible("nope")).toBe(false)
  expect(isGaugeEligible("")).toBe(false)
})
```

- [ ] **Step 2: run — FAIL (module missing).**
- [ ] **Step 3: implement.**
- [ ] **Step 4:** `bun test` 0 fail; `bunx tsc --noEmit` clean.
- [ ] **Step 5:** commit `feat(gauge): named ACP session profiles`.

### Task S2: `SessionPool` — sessions become containers

**Files:** create `cc-gate-plugin/src/gauge/acp-pool.ts`; test
`cc-gate-plugin/test/acp-pool.test.ts`.

**Consumes:** `WarmSession` + `WarmIsolation` + `TurnOutcome` — **as amended
by Task S0**, NOT the daemon plan's original (that version hardcodes its
isolation literal and cannot serve a non-gauge profile); `AcpProfile` +
`resolveProfile` (S1); `ACP_BUDGET` (daemon plan Task 2).

**THE WIRING, and it is the point of this task (review finding C4).** S0 gives
`WarmSession` an `isolation` parameter and S1 defines profiles that carry one;
nothing joins them until here. `open()` constructs:

```typescript
new WarmSession(this.env, {
  isolation: profile.options,   // <- S1's profile becomes S0's parameter
  cwd,                          // <- the session's own cwd, spec-required
  // …the five ACP_BUDGET legs, exactly as the daemon's own construction
})
```

A pool that omits `isolation` silently serves every profile under the GAUGE
system prompt — the failure would look like a working daemon producing
strangely terse proposals, which is why it gets its own test below.

**Produces:**

```typescript
export interface PooledSession {
  id: string
  profile: AcpProfile
  model: string
  cwd: string
  warm: WarmSession
  createdAt: number
}

export class SessionPool {
  constructor(env: Record<string, string | undefined>, opts?: { max?: number; sessionIdleMs?: number })
  /** Allocates a session AND its own WarmSession.
   *
   * Returns a DISCRIMINATED result, not `undefined` (review finding I1): the
   * dispatcher must answer -32002 for a full pool and -32602 for an unknown
   * profile, and a bare `undefined` cannot tell those apart. It never queues,
   * because a caller blocked behind an unrelated session is exactly the
   * failure this design removes. */
  open(profileId: string, model: string | undefined, cwd: string):
    | { ok: true; session: PooledSession }
    | { ok: false; reason: "pool-exhausted" | "unknown-profile" }
  get(id: string): PooledSession | undefined
  /** session/close: settle outstanding turns, close the Query, drop it. */
  close(id: string): boolean
  /** Evict sessions idle past sessionIdleMs. Returns ids evicted. */
  reap(now: number): string[]
  size(): number
  /** True when no session holds an in-flight turn — the daemon's own
   * self-exit gate. */
  quiescent(): boolean
  closeAll(): void
}
```

**Design notes that are load-bearing:**
- One `WarmSession` per pooled session. Each has its own CLI subprocess and
  transcript, so two sessions' turns can run concurrently with no coalescing
  hazard — the hazard is intra-transcript, and `WarmSession`'s FIFO already
  owns it.
- `open()` does NOT spawn eagerly. `WarmSession.ensure()` spawns on the first
  turn, so an abandoned `session/new` costs nothing (same property the daemon
  plan's `session/new` had).
- Eviction closes a session only when `warm.turnInFlight()` is false; an idle
  timer that fires mid-turn defers to the next tick.

- [ ] **Step 1: Failing tests** (fake `WarmSession` via dependency injection —
  no CLI, no credentials; the real-CLI path is covered in S3):

```typescript
test("two sessions get DIFFERENT WarmSessions", () => {
  const pool = new SessionPool(env)
  const a = pool.open("gauge", undefined, "/tmp")
  const b = pool.open("gauge", undefined, "/tmp")
  expect(a.ok && b.ok).toBe(true)
  expect(a.ok && b.ok && a.session.id !== b.session.id).toBe(true)
  // the whole point: separate transcripts
  expect(a.ok && b.ok && a.session.warm !== b.session.warm).toBe(true)
})
test("the two refusal reasons are DISTINGUISHABLE — the dispatcher owes different codes", () => {
  // -32002 pool-exhausted vs -32602 unknown-profile. A bare `undefined`
  // return made these indistinguishable (review finding I1).
  const pool = new SessionPool(env, { max: 1 })
  expect(pool.open("gauge", undefined, "/tmp").ok).toBe(true)
  expect(pool.open("gauge", undefined, "/tmp")).toEqual({ ok: false, reason: "pool-exhausted" })
  expect(new SessionPool(env).open("nope", undefined, "/tmp")).toEqual({ ok: false, reason: "unknown-profile" })
})
test("a reasoning session's WarmSession carries the REASONING isolation", () => {
  // finding C4: S0 builds the parameter, S1 defines the options, and this is
  // the only place they meet. Omitting it runs proposals under the gauge's
  // empty system prompt and nothing else would catch it.
  const pool = new SessionPool(env)
  const r = pool.open("reasoning", undefined, "/tmp")
  expect(r.ok && r.session.warm.isolation).toEqual(ACP_PROFILES.reasoning!.options)
  const g = pool.open("gauge", undefined, "/tmp")
  expect(g.ok && g.session.warm.isolation).toEqual(GAUGE_ISOLATION)
})
test("the session's model defaults from its profile", () => {
  const pool = new SessionPool(env)
  const r = pool.open("reasoning", undefined, "/tmp")
  const g = pool.open("gauge", undefined, "/tmp")
  expect(r.ok && r.session.model).toBe("claude-opus-5")
  expect(g.ok && g.session.model).toBe("claude-haiku-4-5")
})
test("close frees the slot; reap evicts only idle sessions", () => { /* ... */ })
test("reap does NOT evict a session with a turn in flight", () => { /* ... */ })
test("quiescent() is false while any session holds a turn", () => { /* ... */ })
```

- [ ] **Step 2: run — FAIL.**
- [ ] **Step 3: implement.**
- [ ] **Step 4:** full suite + tsc.
- [ ] **Step 5:** commit `feat(gauge): SessionPool — one WarmSession per ACP session`.

### Task S3: Rewrite the daemon dispatcher onto the pool

**Files:** modify `cc-gate-plugin/src/gauge/acp-daemon.ts` (replaces that
file's singleton design from the daemon plan's Task 5); modify
`cc-gate-plugin/test/acp-daemon.test.ts`.

**Replaces, from the daemon plan's Task 5:** the single `WarmSession`, the
`lastServedSessionId` recycle key, `sessions: Map<id,{createdAt}>`, and the
required per-prompt `_meta.model`. **Keeps unchanged:** `acp-paths.ts`, the
bind lock, stale-socket takeover, the spawn log, `setEncoding("utf8")`, the
`import.meta.main` guard, and the wire-send boundary law's error mapping.

**Method surface:**
- `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false,
  sessionCapabilities: { close: {} }, _meta: { kkamak: { envFingerprint,
  profiles: [...ids], callConsumption: true, clear: true } } } }`. Custom
  capability advertisement goes in `_meta` per the extensibility page.
- `session/new` → params `{ cwd (required, absolute), mcpServers (required),
  _meta?: { kkamak?: { profile?: string; model?: string } } }`.
  Profile resolution is exactly two steps, in this order (review finding
  I3): an ABSENT `profile` becomes `DEFAULT_PROFILE_ID`, then
  `resolveProfile` is called; an id it does not know → `-32602`.
  `resolveProfile` itself never defaults — see S1. `mcpServers`
  MUST be empty for every shipped profile (`strictMcpConfig: true`,
  `tools: []`); a non-empty list is `-32602` rather than a silent ignore.
  **`cwd` is now HONOURED, not ignored** — it is the session's `WarmSession`
  cwd. The gauge's callers pass `os.tmpdir()` to preserve §6e delta (b).
  Response carries `sessionId` plus `_meta.kkamak.{profile,model}`.
- `session/prompt` → params `{ sessionId, prompt }`; `_meta.kkamak.model` is
  now OPTIONAL and, when present, must equal the session's model (a mismatch
  is `-32602`, never a silent per-turn `setModel`). Runs
  `pool.get(id).warm.oneShot(text, session.model, { recycle: false, tag })` —
  **`recycle: false`, because each session owns its transcript.** Outcome
  mapping is the daemon plan's, unchanged, with `_meta.kkamak.{model,
  canonicalModel,callConsumed,profile}` on success.
- `session/close` → `pool.close(id)`; `{}`.
- `session/set_config_option` → `configId: "model"` sets the session's model
  (calls `warm.setModel` through its existing capped path). Any other
  `configId` → `-32602`.
- `_kkamak/session/clear` → within-session reset: `warm` pushes `/clear` and
  waits for `conversation_reset`, exactly as the daemon plan's `awaitClear`.
  This is the ONLY custom method, and the spec reserves `_`-prefixed names
  for precisely this.
- Unknown method → `-32601` (also the spec's prescribed answer for an
  unrecognised extension method).

- [ ] **Step 1: Failing tests** — carry over every wire-behaviour test from
  the daemon plan's Task 5 (they still apply), and ADD:

```typescript
test("two concurrent sessions do NOT share a transcript", async () => {
  // A: prompt with MARKER-A. B: prompt with MARKER-B, overlapping in time.
  // Assert neither captured body contains the other's marker, and that BOTH
  // resolve ok. Under the singleton this test is unsatisfiable by
  // construction — it is the acceptance test for this whole plan.
}, DAEMON_TEST_TIMEOUT_MS)

test("session/new HONOURS cwd", async () => {
  // spec: cwd MUST be used regardless of where the subprocess was spawned.
})

test("a non-empty mcpServers list is refused, not ignored", async () => {
  // -32602. Silent ignore would let a client believe it had tools.
})

test("session/prompt with a model that differs from the session's is refused", async () => {
  // -32602 — never a silent per-turn setModel on someone else's session.
})

test("session/set_config_option configId 'model' changes the session model", async () => { /* ... */ })

test("session/close frees a pool slot", async () => {
  // fill to cap, close one, open one more: succeeds.
})

test("pool exhaustion answers pool-exhausted, never blocks", async () => {
  // at cap, session/new returns -32000 with _meta.kkamak.reason within 1s.
})

test("_kkamak/session/clear resets THAT session only", async () => {
  // A cleared; B's next prompt still carries B's earlier marker.
})

test("initialize advertises profiles and sessionCapabilities.close", async () => { /* ... */ })

test("every custom field lives under _meta.kkamak — no root-level custom keys", async () => {
  // Spec: MUST NOT add custom fields at the root of a spec type. Assert the
  // initialize/new/prompt results have no unexpected root keys.
})
```

- [ ] **Step 2-4:** implement, full suite, tsc, plus the daemon plan's
  hygiene, stray-daemon and import-purity checks.
- [ ] **Step 5:** commit `feat(gauge): ACP daemon serves a session pool with profiles`.

### Task S4: Client — session-scoped API

**Files:** modify `cc-gate-plugin/src/gauge/acp-client.ts`; modify
`cc-gate-plugin/test/acp-fake-daemon.ts` and `acp-client.test.ts`.

**Keeps:** `ensureDaemon` (argv + env explicit, `held`-tracked spawn lock),
the write-callback send boundary, the L3 three-step outcome mapping, the
fingerprint refusal.

**Produces, in addition to the existing one-shot `daemonCall`:**

```typescript
/** An open session a caller can prompt repeatedly. Callers that want the
 * daemon plan's one-shot semantics keep using `daemonCall`, which is now a
 * thin wrapper: open(gauge) -> prompt -> close. */
export interface DaemonSession {
  id: string
  prompt(text: string, opts?: { budgetMs?: number }): Promise<DaemonOutcome>
  clear(): Promise<boolean>
  setModel(model: string): Promise<boolean>
  close(): Promise<void>
}
export function openSession(
  env: Record<string, string | undefined>,
  opts: { profile: string; model?: string; cwd?: string; waitMs?: number },
): Promise<DaemonSession | undefined>
```

`openSession` returns `undefined` (never throws) on: no daemon, fingerprint
mismatch, unknown profile, pool exhaustion. Callers fall back to their own
direct path — the fail-open rule is unchanged.

**`DaemonOutcome.ok` gains `profile: string`** — the id of the session that
actually served the turn, echoed from `_meta.kkamak.profile`. That field is
what makes review finding I2's enforcement possible, and this task is where it
enters the client type.

**Gauge-eligibility enforcement (review finding I2) — the one named point.**
`callModelDerive` (daemon plan Task 7, daemon branch) adds, immediately beside
its existing `modelProvenBy` check:

```typescript
// A proposal is not a derivation. `gaugeEligible` is declared in the profile
// registry (S1) and echoed per turn (S3); THIS is where it is enforced,
// because this is the only path that writes a §6e transport stamp. Refuse
// rather than fall back: the call was consumed, and a record stamped from a
// non-gauge context would silently corrupt the §6e partition.
if (!isGaugeEligible(d.profile)) return undefined
```

`isGaugeEligible` is imported from `acp-profiles.ts` (S1) — the ONE source of
truth. Do not build a local set of eligible ids here; two lists drift.

Tests (fake daemon, no model): a daemon answering `ok` with
`_meta.kkamak.profile = "reasoning"` produces NO record and the one-shot
fallback endpoint receives ZERO requests; an `ok` with an UNKNOWN profile id
is likewise refused (`isGaugeEligible` is false for anything it does not
know); and `profile: "gauge"` still produces a normal stamped record.

- [ ] **Steps 1-5** as the daemon plan's Task 6, with fake-daemon variants
  added for `pool-exhausted` and `unknown-profile`.

### Task P0: Register the proposer instrument change — BEFORE any proposal runs through it

**Files:** modify the loop's own preregistration/spec doc (NOT §6e — the
proposer is not part of the gauge instrument) and
`docs/2026-08-01-gauntlet-adoption-ledger.md`.

Record, pre-data:
- Today the claude-code driver runs bare `claude -p`, inheriting the FULL CC
  coding-agent harness, while the opencode driver runs under an explicit
  "careful reasoning assistant, no tools" system prompt. **The two drivers
  are therefore not the same instrument**, and that was never declared.
- Moving to the `reasoning` profile makes both explicit and identical.
- Proposals feed the A/B loop, so this is an instrument change for the LOOP:
  log a boundary ts, and do not pool proposals generated before and after it
  without splitting the reading.
- What would falsify the change: if proposals generated under the explicit
  profile score materially worse than harness-inheriting ones, the profile is
  wrong, not the loop.

- [ ] **Step 1:** write the amendment. **Step 2:** `bun scripts/doc-check.ts`.
  **Step 3:** commit.

### Task P1: Route `minimal/llm.ts`'s claude-code driver through the pool

**Files:** modify `cc-gate-plugin/src/gauge/acp-client.ts` consumers via a new
`minimal/llm-acp.ts`; modify `minimal/llm.ts`; test `minimal/llm-acp.test.ts`.

**The blocker is CLEARED — done 2026-08-04, ahead of this task.**
`llmCall` was `Bun.spawnSync`; it is now `async` on `Bun.spawn` and returns
`Promise<string>`, with an `opts: { binPath?, env? }` seam. Only two call
sites needed `await` (`propose.ts:267`, `:324`); the three callback sites
were already async-tolerant, because `reviewBullet.call` is typed
`string | Promise<string>` and awaited at `review.ts:262`. Covered by
`opencode-plugin/test/minimal-llm.test.ts` (9 tests, fake binary, zero model
calls). What remains for this task is only the pool routing below.

**A measured trap the seam exists to prevent.** On Bun 1.3.1 an executable is
resolved from the PATH captured at PROCESS START, not from a mutated
`process.env.PATH`. A test that prepends a temp dir to `process.env.PATH` and
spawns `"claude"` therefore runs the REAL CLI — silently, at real cost. That
happened once while writing these tests. `binPath` (absolute) is the only
honest fake; an explicit `env` also works.

**Produces:**

```typescript
/** Async sibling of llmCall. Tries the ACP pool with the `reasoning`
 * profile; on ANY failure (no daemon, exhausted, refused) falls back to the
 * existing synchronous llmCall so the loop never blocks on daemon health. */
export async function llmCallAsync(
  driverId: ProposerDriverId, model: string, prompt: string,
): Promise<string>
```

- The opencode driver NEVER goes through the pool — it is a different agent
  with its own isolation recipe. `llmCallAsync("opencode", …)` delegates to
  `llmCall` verbatim.
- A >0.5 MB prompt is fine over the socket (the argv limit that forced stdin
  does not apply); `FrameDecoder`'s `maxLineChars` (4 MiB) covers it, and a
  test pins a 1 MB prompt round-trip.

- [ ] **Step 1: Failing tests** — fake daemon: `reasoning` profile requested,
  prompt echoed verbatim, 1 MB prompt survives, and a dead socket falls back
  to `llmCall` (asserted by a spawn counter, not by output).
- [ ] **Step 2-4:** implement; full suite; tsc. (The call-site migration is
  already done — see above.)
- [ ] **Step 5:** commit `feat(minimal): proposer/reviewer via the ACP pool, fail-open to claude -p`.

### Task P2 (OPTIONAL, own go): judge

Same shape as P1 for `opencode-plugin/src/bench/judge-audit.ts`'s model call,
`reasoning` profile. Deferred by default: the judge runs inside bench flows
that already have their own auth and sandbox assumptions, and it is not on
the critical path for either loop.

---

## Post-plan

1. One branch `acp-session-pool`, per-task reviews, whole-branch fresh-context
   review, merge via `scripts/merge-with-gate.sh` + committed
   `docs/reviews/<sha>-acp-session-pool.md`. 7b is ARMED.
2. **Ordering:** the daemon plan's Task 4 Step 1a probe (the `/clear`-through-
   streaming-input + `modelUsage` gate) must PASS before any of this is built —
   this plan inherits `WarmSession` wholesale and has the same single point of
   failure. Then **S0 → S1 → S2 → S3 → S4**, then P0 before P1. S0 is first because
   every later task needs a `WarmSession` that can carry a profile's options.
3. **Not in scope:** bench drivers, permanently (§A). `cls-ab` and
   `channel-run` keep their pinned direct paths until someone measures a
   reason to move them.
4. The gauge's §6e bar, its sized-go gates and its live-flip decision are
   UNCHANGED by this plan. A pooled daemon does not alter what §6e measures;
   it only changes what else can share the process.

## Self-review pass (2026-08-04, by the author, no subagent)

2 critical, 4 important, 3 minor found; **C1, C2, I1, I2, I3 applied above**.
- **C1** — "`WarmSession` REUSED UNCHANGED" was false: `ensure()` hardcodes
  the isolation literal, so a `reasoning` profile was undeliverable. Now Task
  S0, one additive parameter, with `GAUGE_ISOLATION` as the byte-identity proof.
- **C2** — pool-exhaustion reused `-32000`, already `ACP_ERR_NO_CALL`. Now
  `ACP_ERR_POOL_EXHAUSTED = -32002` with a three-way distinctness test.
- **I1** — `open()` collapsed pool-exhausted and unknown-profile into one
  `undefined` though the dispatcher owes different codes. Now discriminated.
- **I2** — `gaugeEligible` was declared and never enforced. Now enforced in
  `callModelDerive` with a named test.
- **I3** — S1 pinned "never a silent default" while S3 said "defaults to
  gauge". Now: caller applies `DEFAULT_PROFILE_ID` for an ABSENT id, then
  `resolveProfile` (still strict) runs.

**Second pass (same day), 2 critical + 3 important, ALL APPLIED.** Every
critical was introduced by the first pass's own fixes, which is the signature
of patching without re-reading:
- **C3** — the I2 enforcement snippet called `GAUGE_ELIGIBLE_PROFILES`, a
  symbol no task exports. Now `isGaugeEligible()` from S1, derived from
  `ACP_PROFILES`, with unknown ids refused and a test that it agrees with the
  flag for every registered profile.
- **C4** — S0 built the `isolation` parameter and S1 defined profile options,
  and NOTHING joined them: S2 constructed a `WarmSession` without passing
  either, and still called Task 4 "unchanged" one section below C1's fix. The
  wiring is now S2's stated purpose, with a test that a `reasoning` session
  really carries the reasoning isolation.
- **I5** — `isolationForTest()` was invented in an S0 test and declared
  nowhere; now a declared `readonly isolation` field.
- **I6** — the daemon plan's supersession note claimed Tasks 7-10 were reused
  "verbatim" while S4 modifies Task 7. That note now separates verbatim
  (1-3, 8-10) from verbatim-plus-delta (4 and 7).
- **I7** — S0's edit to `warm-session.test.ts` was declared a "sixth
  exception" from this document, which the daemon plan's own list forbids.
  The exception is now declared IN that list, where its implementer reads.

**Still NOT applied, and why:** I4 (the pool cap of 4 is asserted, not measured —
size it from the RSS of one warm `Query` during the daemon plan's Step 1a
probe, which already spawns one); the `reasoning` prompt text is still cited
via the out-of-scope opencode driver instead of quoted; and no task yet owns
the `_meta` → `_meta.kkamak` namespacing that §B calls required. All three are
cheap and none blocks S0.

## Open question for the user

The daemon plan's Task 10 live flip is still gated on the §6e bar. My own
review of that flip found it optimises ~0.03% of a median 17.2 s live
derivation and makes the live path slower than today's direct API call. This
plan does not change that arithmetic. **Recommend: build S1-S4 + P0/P1 for
the proposer's benefit, and leave the live gauge path on `sdk` regardless of
how the §6e bar lands** — the pool's value is policy centralisation and
premium reach for the slow callers, not latency for the fast one.
