# ACP Warm Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-global warm daemon holding ONE Agent-SDK streaming `Query`, exposed over the Agent Client Protocol (JSON-RPC) on a Unix socket, so every gauge derivation — live Stop-hook AND batch — pays ~20 ms of `/clear` recycling instead of ~1.25-1.46 s of CLI respawn.

**Architecture:** Three layers with the protocol as interface, not implementation: (1) `WarmSession` wraps the SDK streaming-input `Query` and owns the measured instrument invariants (isolation options, per-turn call accounting, caller-directed `/clear` recycling sequenced on the SDK's own `conversation_reset` message, `interrupt()` turn timeout); (2) `acp-daemon.ts` binds an ACP-conformant JSON-RPC dispatcher to a Unix socket with an idle self-exit; (3) `acp-client.ts` gives callers connect-or-spawn with a THREE-WAY outcome contract — `ok` / `no-call` / `call-consumed` — because a fail-open fallback is only safe when the daemon provably burned no model call. One classification law (§6e's **wire-send boundary law**) governs every layer. The live flip is gated exactly like §6d: registration first (§6e), paired validation on real spend (own sized go), flip with boundary ts only on a bar pass.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (already a dependency; streaming-input mode), `node:net` Unix domain sockets, hand-rolled newline-delimited JSON-RPC 2.0 conformant to the ACP wire shapes (agentclientprotocol.com — no new runtime dependency; see Task 2 rationale).

## Global Constraints

- **User-directed scope (2026-08-04).** This plan implements three verbatim user rulings quoted in full in Task 1's §6e text. They supersede §6d's "Selection is PER-CALLER" BINDING sentence and the 2026-08-03 "batch-only, live must not use it" agreed shape. They do NOT supersede the bar gate (no live flip without a §6e PASS) or the fail-open requirement. The 2026-08-04 "ask before ANY daemon implementation work" rule is SATISFIED: this plan is the user-initiated daemon work.
- **Isolation set is law, pinned server-side, never client-negotiable.** Byte-measured 2026-08-03, `agent-transport.ts:119-132`, TEN keys: `model`, `systemPrompt: ""`, `settingSources: []`, `settings: { autoMemoryEnabled: false }`, `persistSession: false`, `strictMcpConfig: true`, `tools: []`, `title: "kkamak-gauge"`, `thinking: { type: "disabled" }`, `env` (full replacement).
  **TWO declared deltas (do not paper over them):**
  1. **Removed:** the one-shot lane additionally sets `maxTurns: 1` and `abortController`. Both are QUERY-scoped and cannot transfer to a many-turn warm session — `maxTurns` (sdk.d.ts:1675-1678) would stop the whole `Query` after record #1, and aborting the shared controller would kill every future turn. They are replaced by (a) the per-turn model-call accounting rule in `WarmSession` and (b) `interrupt()` as the per-turn cancel.
  2. **Added:** an explicit neutral `cwd` (`os.tmpdir()` unless overridden) so the daemon's context does not depend on which session happened to spawn it. §6d measured a neutral `cwd` as PAYLOAD-NEUTRAL (spec table line 690: "no further change") and `agent-transport.ts:41-44` therefore omits it as redundant/dead configuration for a one-shot. For a host-global daemon it is not redundant — it is the difference between a fixed instrument and one that varies with its spawner.
  Both deltas are registered in §6e; this is NOT "the §6d set verbatim" and the plan never claims so.
- **Env is part of the instrument, and the daemon proves which env it has.** `env` is one of the ten pinned keys and a daemon freezes it at spawn time. A small enumerated env subset is therefore hashed into the default socket filename AND echoed by `initialize`; a client whose fingerprint differs refuses (`no-call`) rather than deriving through a daemon configured differently. See §6e "Instrument fingerprint" and Task 5.
- **Exactly one model call per record (§4, binding) — and the fallback must not break it.** `/clear` makes no model call (measured 2026-08-03); one prompt turn = one call. Every daemon turn resolves as `ok`, `no-call`, or `call-consumed` per the **§6e wire-send boundary law** (Task 1, stated ONCE and referenced by Tasks 2/4/5/6/7). **Fallback to the one-shot lane is permitted ONLY on `no-call`.** On `call-consumed` the deriver returns `undefined` and the record stays pending/retryable — a second lane call would make `--go N` mean up to `2N` calls.
- **Live derive path stays pinned to `"sdk"`** (test-locked, `test/gauge-refiner-cli.test.ts:105`, and asserted again at `:56-86` and `test/gauge-wiring.test.ts:102`) through Tasks 1-9. Only Task 10, after a §6e bar PASS and on its own go, may touch the pin.
- **Fail-open everywhere**: daemon absent/slow/dead → the caller degrades within ONE wall-clock budget (below); the SessionStart hook always exits 0. Fail-open never means fail-open-into-double-spend: an ambiguity after the prompt frame was sent is `call-consumed`, not `no-call`.
- **One budget, not two, and the arithmetic is locked by a test.** `callModelDerive` owns a single 60 s wall-clock budget per record (the incumbent `CALL_TIMEOUT_MS`). All timing constants live in ONE exported object, `ACP_BUDGET` in `acp-wire.ts` (Task 2), because the client leg MUST exceed the daemon's worst case or a client timeout would misclassify a turn the daemon is still legitimately running:

  | constant | ms | owner | meaning |
  |---|---|---|---|
  | `queueWaitMs` | 6 000 | daemon | a turn still in the FIFO queue at this point is dropped, provably unsent |
  | `clearTimeoutMs` | 4 000 | daemon | `/clear` must be confirmed by `conversation_reset` within this |
  | `turnTimeoutMs` | 16 000 | daemon | generation budget, measured from the prompt push |
  | `hardGraceMs` | 4 000 | daemon | extra grace before destroying the `Query` if `interrupt()` hangs |
  | `daemonWorstCaseMs` | 30 000 | derived | = 6 000 + 4 000 + 16 000 + 4 000 |
  | `daemonLegMs` | 33 000 | client | MUST be > `daemonWorstCaseMs` |
  | `minFallbackMs` | 10 000 | client | below this remaining, do not start a fallback at all |
  | `recordBudgetMs` | 60 000 | client | today's `CALL_TIMEOUT_MS`; per-record latency never exceeds it |

  Locked by `acp-wire.test.ts`: the four daemon legs sum to `daemonWorstCaseMs`, `daemonLegMs > daemonWorstCaseMs`, and `daemonLegMs + minFallbackMs <= recordBudgetMs`.
- **F1/F2**: all new source under `cc-gate-plugin/src/gauge/` plus `hooks/hooks.json` and a `SessionStart` branch in `src/hook-cli.ts` — all outside every MECHANISM_PATH (`km-crank/src/calibration.ts:65-72` = `minimal/{complete-gate,mutate,spec-probe,session2}.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`); the `hook-cli.ts` wiring precedent is Phase-2 fixture harvest. Socket/lock/runtime state under `~/.config/kkamak/` — the repo's documented host-local store (CLAUDE.md; `~/.kkamak/` does NOT exist and is not a repo convention). Counts travel, prompts do not.
- **Pre-existing test files: FIVE DECLARED EXCEPTIONS, and no others.** Every other pre-existing test must pass byte-unmodified.
  1. `test/gauge-agent-transport.test.ts:49` — `expect(GAUGE_TRANSPORTS).toEqual(["cli","sdk","agent-sdk"])` → four literals (Task 3). *Assertion change.*
  2. `test/gauge-agent-transport.test.ts` — APPEND one new test (Task 3). *No existing assertion touched.*
  3. `test/paired-validation.test.ts` — APPEND two new tests (Task 3). *No existing assertion touched.*
  4. `test/gauge-agent-transport.test.ts:23-45`, `:92-103`, `:116-145` — MOVE `hasClaudeCodeCredentials`/`HAS_CLAUDE_CODE_CREDENTIALS`/`NO_CREDENTIALS_SKIP_REASON`, `sseText`, `withCaptureStub` into `test/agent-cli-stub.ts` and re-import (Task 4 Step 0). *No assertion changes; `bun test` 0-fail before and after.*
  5. Task 10 ONLY, and only on an earned bar pass: the three live-pin assertions at `test/gauge-refiner-cli.test.ts:56-86` / `:105` and `test/gauge-wiring.test.ts:102` (Task 10 Step 3 enumerates all three). *Assertion changes.*

  **`test/sdk-stub.ts` is NOT widened.** Its handler type is `(captured: Captured) => Response` (`test/sdk-stub.ts:19`) — synchronous, no promise. Every never-answering stub in this plan uses raw `Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })`, the established precedent at `gauge-agent-transport.test.ts:252`. Any OTHER pre-existing test that needs editing means the change is wrong — fix the change, not the test.
- `cd cc-gate-plugin && bun test` → 0 fail and `bunx tsc --noEmit` clean at every task's end. `bun scripts/doc-check.ts` before every docs commit.
- TDD per task. Tests that spawn the bundled CLI use the existing `hasClaudeCodeCredentials()` skip-guard AND an explicit per-test timeout (`CLI_TEST_TIMEOUT_MS`) — bun:test's 5 s default is shorter than observed spawn latency, and a credential-less host must SKIP, not FAIL (`gauge-agent-transport.test.ts:13-22`). Zero real model calls anywhere in Tasks 1-8.
- Env vars introduced here: `KKAMAK_ACP_SOCKET` (override socket path; default `~/.config/kkamak/acp-<envFingerprint>.sock`), `KKAMAK_ACP_IDLE_MS` (default `900000`), `KKAMAK_ACP_TEST_SPAWN_LOG` (test seam), `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` (selects the lane).
- **Merge discipline (7b is ARMED):** one branch, per-task reviews, whole-branch fresh-context review, merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md`. See Post-plan.

---

### Task 1: Register §6e (pre-data) — the daemon lane, the classification law, the residue, the supersession, and the flip gate

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md`

**Interfaces:**
- Produces: the registered literal `"agent-sdk-daemon"`, the wire-send boundary law, the instrument fingerprint, the bar, and the flip rule that Tasks 3-10 implement. Registration precedes build (spec-is-law).

- [ ] **Step 1: Append §6e at the END of §6d** — i.e. after the current line 744 (`**What would falsify this change.** …` paragraph, the last of §6d) and IMMEDIATELY BEFORE `## 7. Known risks` (currently line 746; verified against the file 2026-08-04). Do NOT insert after the §6d OUTCOME block (line ~607): §6d continues for another ~137 lines past it, and inserting there would re-parent the schema-enforcement note, the retry/output-cap asymmetries, the PER-CALLER ruling, Deploy, context isolation, the `--bare` ruling and the residual under a §6e heading.

Content, exactly:

```markdown
## 6e. Amendment (pre-data, 2026-08-04): warm-daemon lane → `agent-sdk-daemon`

**Governing rulings (2026-08-04, user — verbatim).** This amendment exists
because the user directed it in today's session:

1. "Daemon first. Can we make it ACP server?"
2. "ACP is just interface not implementation. We do this under interface"
   — given in response to five objections to taking on the official ACP
   SDK; the direction is an OWN implementation of the ACP interface.
3. "I don't want to distinguish batch and daily use. We can hook the start
   and the end of CC process. On start, connect or instantiate ACP server.
   ACP server itself has kill timeout, say 15min, on timed out, APC server
   exit to close the ACP process."

**What these supersede, explicitly.** Ruling 3 is a UNIFIED-LANE
instruction. It withdraws, as of 2026-08-04: (a) §6d's "Selection is
PER-CALLER, not a global default" BINDING sentence — "the live path stays
pinned to `transport: "sdk"`"; and (b) the 2026-08-03 agreed daemon shape
recorded in `docs/resume.md` — "in-process singleton for BATCH only … Live
path must NOT use it". The supersession is scoped to THIS lane: the
`"sdk"` and `"agent-sdk"` literals, their records, and §6d's OUTCOME are
untouched, and `KKAMAK_GAUGE_TRANSPORT=agent-sdk` remains exactly what §6d
made it.

**The "end" half of ruling 3, deliberately NOT implemented — registered
here rather than left in a plan step.** Ruling 3 says "hook the start and
the end of CC process". Only the START is hooked (a `SessionStart` branch
that ensures a daemon). No `SessionEnd` hook is added, because the same
ruling gives the daemon its OWN kill timeout, and a per-session shutdown
hook would be actively wrong for a HOST-GLOBAL daemon: closing one CC
window would tear down the warm session other windows and any running
batch are still using, re-imposing the ~1.25-1.46 s respawn this lane
exists to remove. The 15-minute idle self-exit owns shutdown, and it is
strictly safer (it fires only when nothing is in flight). If a future
reading wants deterministic teardown, the correct shape is a reference
count over live connections, not a SessionEnd hook — recorded so a later
reader sees a decision, not an omission.

**What changes.** A fourth derive transport literal, `transport:
"agent-sdk-daemon"`: the same Agent-SDK lane §6d validated, but through a
host-global warm daemon (one streaming CLI session, `/clear` between
records) speaking the Agent Client Protocol over a Unix socket. Selected
per process by `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon`; absent or any
other value keeps the current behaviour byte-for-byte.

**Why.** §6d measured the one-shot agent lane at +1.25-1.46 s subprocess
spawn per record (~25% end-to-end). The daemon amortizes that to one spawn
per warm period. Indicative measurement 2026-08-03 (recorded in
`docs/resume.md`, scratch probe, NO in-tree artifact and NOT taken with
this amendment's isolation option set or streaming-input `Query`): first
record 838 ms then ~20 ms per record, `/clear` handled CLI-side with no
model call. Treat those numbers as indicative only; the plan's Task 4
tests re-derive them under the real option set.

**Declared residue.** Each post-`/clear` turn carries ~423 B of constant
`<local-command-caveat>`/`<command-name>/clear</command-name>` echo that a
fresh-spawn context does not (same indicative-measurement caveat). It is
constant per record, so it cannot bias one classification against another
— but it makes the daemon context MEASURABLY DIFFERENT from the
§6d-validated fresh-spawn context, which is why this literal gets its own
bar rather than inheriting §6d's result. The residue's exact SHAPE (folded
into the next user message vs carried as its own message) was never
measured; Task 4 records the observed value rather than asserting one.

**Instrument invariants (pinned in daemon code, not client-negotiable).**
The §6d isolation option set, with TWO registered deltas:
(a) REMOVED — `maxTurns: 1` and `abortController` are query-scoped and
cannot transfer to a many-turn warm session (`maxTurns` would stop the
whole `Query` after the first record; aborting the shared controller would
kill every later turn). They are replaced by per-turn model-call
accounting plus `interrupt()` as the per-turn cancel.
(b) ADDED — an explicit neutral `cwd`. §6d measured a neutral `cwd` as
payload-neutral and therefore redundant for a one-shot; for a host-global
daemon it is the difference between a fixed instrument and one that varies
with whichever session spawned it.
Also pinned: the outgoing text is built by the SAME builder the §6d
one-shot lane uses, including its trailing schema instruction — the two
lanes must differ in transport only, never in prompt bytes. One turn in
flight at a time (FIFO across all connected callers).

**Instrument fingerprint (binding).** A daemon freezes its subprocess `env`
— one of the ten pinned isolation keys — at spawn time, so "which env"
would otherwise depend on which process happened to start it (a wrapper
exporting `ANTHROPIC_BASE_URL` would silently redirect every derivation).
An enumerated FIVE-key subset is therefore hashed into the instrument:

  - `ANTHROPIC_BASE_URL` (value)
  - `CLAUDE_CONFIG_DIR` (value)
  - `KKAMAK_GAUGE_MODEL` (value)
  - `ANTHROPIC_API_KEY` (PRESENCE only — `set`/`unset`, never the value)
  - `ANTHROPIC_AUTH_TOKEN` (PRESENCE only — `set`/`unset`, never the value)

`envFingerprint` = first 12 hex chars of sha256 over `k=v\n` lines in that
order. It is baked into the DEFAULT socket filename
(`~/.config/kkamak/acp-<fp>.sock`) and echoed in `initialize`'s result;
a client whose own fingerprint differs REFUSES the daemon and reports
`no-call` (a pre-send condition — the fallback is safe). Secrets never
appear in a filename, a log, or a wire frame; only their presence does.

**The wire-send boundary law (binding — stated ONCE here; the wire, the
daemon, the client and the deriver all implement THIS text).** Every turn
resolves as exactly one of `ok`, `no-call`, or `call-consumed`. The
dividing line is whether the `session/prompt` bytes crossed the boundary
toward the model.

  L1. CLIENT — any failure BEFORE the `session/prompt` frame is fully
      written to the socket is `no-call`: no socket, connect refused,
      socket-dir creation failure, `initialize`/`session/new` failure,
      env-fingerprint mismatch, write error.
  L2. CLIENT — any ambiguity AFTER that frame is written is
      `call-consumed`: client budget expiry, socket closed mid-turn,
      unparseable response, unrecognized error code, missing or
      non-boolean `data.callConsumed`. The conservative side of an
      ambiguity is always "consumed"; the cost is one retryable record,
      and the alternative cost is a second model call.
  L3. CLIENT — `error.data.callConsumed` is AUTHORITATIVE when present and
      boolean. The numeric code (`ACP_ERR_NO_CALL` / `ACP_ERR_CALL_CONSUMED`)
      is the fallback for a daemon that omitted it. Anything else post-send
      falls to L2.
  L4. DAEMON — a turn that never pushed its prompt is a PROVABLE `no-call`:
      still in the FIFO queue when its queue-wait cap expired, `/clear`
      never confirmed, or the `Query` could not be started at all.
  L5. DAEMON — once the prompt is pushed, any non-success ending is
      `call-consumed`, with ONE exception: if the only failure signal the
      SDK ever produced was connection-level (`api_retry` with
      `error_status === null`, which sdk.d.ts documents as "null for
      connection errors (e.g. timeouts) that had no HTTP response"), with
      no `assistant` output and no non-null-status retry, nothing reached
      the model and the turn is `no-call`.
  L6. DAEMON — `api_retry` with `error_status !== null` means the API
      answered, so the call is CONSUMED; the turn is cancelled at that
      moment because the CLI's own internal retry would be call #2 (§6d,
      `agent-transport.ts:135-145`).
  L7. DAEMON — a cancelled or timed-out turn settles from its OWN terminal
      `result` message, never at the instant of cancellation, so a trailing
      message can never be attributed to the NEXT turn. If `interrupt()`
      itself hangs past the hard grace, the whole `Query` and its
      subprocess are destroyed instead (which also makes a stale message
      impossible).

A caller may fall back to the one-shot lane ONLY on `no-call`. On
`call-consumed` the deriver returns undefined and the record stays
pending/retryable. Without this split, a fail-open fallback would issue a
second model call for the same record, breaking §4's exactly-one-call rule
and making the `--go N` cost fence mean up to `2N` calls.

**Budget rule (binding, and the reason L2 is not a loophole).** The
client's daemon-leg budget MUST exceed the daemon's worst-case per-turn
wall clock, or an ordinary slow-but-legitimate turn would trip L2 and cost
the record. Registered values: daemon queue-wait 6 s + `/clear` confirm
4 s + generation 16 s + hard grace 4 s = 30 s worst case; client leg 33 s;
minimum fallback leg 10 s; total per-record budget 60 s (unchanged from
today's `CALL_TIMEOUT_MS`). Per-record latency therefore never exceeds
today's. The arithmetic is locked by a unit test, not by prose.

**Fail-open provenance rule (binding).** A caller selecting
`agent-sdk-daemon` that falls back derives via the direct lane instead and
the record stamps the transport THAT ACTUALLY RAN, and the model the lane
actually used. A stamp may therefore differ from the selection; the stamp
is the truth. Silent mislabeling here is the §6d cls-ab defect all over
again — the paired-validation partition reads stamps, so a lie in the
stamp corrupts the §6e bar itself.

**Which field proves the model (binding).** The AUTHORITATIVE source for a
turn's model is the keys of `modelUsage` on the SDK's terminal success
result (sdk.d.ts:4312). The `model` field of the turn's assistant messages
is CORROBORATION only. A caller-supplied model is never evidence of
anything — echoing the request back would make the check a tautology. A
turn that produced text but cannot prove which model produced it is
reported `call-consumed` (the call happened; the record must not be
stamped). A client whose requested model differs from the proven model
discards the derivation.

**Pooling bar (reused verbatim from §6c/§6d, baseline `"sdk"`).**
- Positive agreement on C: `|C_sdk ∩ C_daemon| / |C_sdk ∪ C_daemon| >= 0.80`, AND
- Missed-C cap: records `"sdk"` calls C that `"agent-sdk-daemon"` calls
  not-C, `<= ceil(0.10 × |C_sdk|)`.
Both hold → pooling permitted, split still reported. Either fails → the
literal stays selectable with split readings, and the live flip DOES NOT
HAPPEN.

**Power limitation, declared pre-data.** On `yoo-dev` the entire
`"sdk"`-derived class-C stratum is 5 records (measured 2026-08-04: 109
`transport:"sdk"` records, 5 of class C), so the sample is 5 C + 5 not-C
and the cap is `ceil(0.5) = 1`. Agreement ≥ 0.80 over a union of 5 means
4/5. §6d already landed on both edges with zero slack. This bar therefore
has NO power to separate a small real effect from a single coin flip, and
that is registered here BEFORE the data rather than argued afterwards. A
PASS licenses the flip because the flip is user-directed and reversible by
one env var; it does not license a claim that the warm residue is
behaviourally neutral.

**Validation-run instrument parameters, registered pre-data.** The §6e
validation run sets `KKAMAK_ACP_IDLE_MS` above the expected batch duration
and re-proves daemon liveness inside the same script that spends, so the
idle reaper cannot fire between a liveness check and record #1. That is an
operational parameter of the run, not a change to the bar.

**Pooling is not transitive, and the post-flip live stream is split three
ways.** §6d permits pooling `sdk` with `agent-sdk` at exactly 0.800; a
§6e pass would permit pooling `sdk` with `agent-sdk-daemon` at ≥ 0.80.
Neither licenses pooling `agent-sdk` with `agent-sdk-daemon`. After a
flip, the live derive path emits `"agent-sdk-daemon"` when the daemon
serves the turn and `"agent-sdk"` when it fell back on a `no-call` — the
lane is chosen by daemon availability, which is not independent of host
state or time of day. Every post-flip reading is therefore split THREE
ways (`sdk` pre-boundary, `agent-sdk-daemon`, `agent-sdk`), and the
fallback mixture is itself a registered source of variance.

**Live flip gate.** The live derive path (refiner-cli.ts) stays pinned to
`"sdk"` until: (1) this bar passes, (2) the flip ships with the fail-open
fallback and the wire-send boundary law above, and (3) the boundary ts is
logged in `docs/2026-08-01-gauntlet-adoption-ledger.md` at the flip commit
— behaviour changes while `pluginVersion` does not. A bar FAIL is a
complete, successful outcome: the daemon stays available for any caller
that opts in with split readings, and live keeps `"sdk"`.

**Boundary ts for batch, too.** §6d's Deploy clause requires a boundary ts
when the first BATCH caller opts in. The §6e validation run (a shadow-store
derive) is instrument validation, not a production reading, and does NOT
trigger it. The first `agent-sdk-daemon` derive against a REAL store does,
whether or not the live flip ever happens.

**Known reporting gap, re-recorded.** `cls-ab.ts`'s `transportTally`
(lines 375-383, the `if/else` at 379-380) buckets records as `if
(transport === "sdk") sdk++ else cli++`. §6d recorded this for
`"agent-sdk"`; it applies identically to `"agent-sdk-daemon"`, which will
also be miscounted as CLI in the classifier A/B report. Display miscount
only, still out of scope, fix it when cls-ab is next opened.

**What would falsify this design.** If warm-lane derivations disagree with
fresh-spawn agent-lane derivations more than fresh-spawn disagrees with
the API lane (i.e. the `/clear` residue is NOT behaviourally neutral), the
daemon is retained as a convenience only and the live flip is off the
table for it. NOTE ON MEASURABILITY: the pv machinery compares a real-store
baseline against a shadow arm, so it cannot compare two shadow arms
directly. This criterion is therefore evaluated on the class-C stratum
ONLY — the same 5 baseline keys appear in both the §6d and §6e samples —
against the per-key classes recorded in
`docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json`. The not-C stratum
is an independent random draw in each run and is NOT comparable across
them.
```

- [ ] **Step 2: Verify no dead links**

Run: `bun scripts/doc-check.ts`
Expected: `doc-check: OK — <N> tracked file(s), 0 violations`
(doc-check enforces relative-link integrity + fence balance only; the §6e text has no markdown links and no nested fences, and every backticked path it names exists.)

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "docs(spec): register 6e warm-daemon lane (pre-data, user-directed supersession)"
```

### Task 2: Pin the ACP wire subset + the budget arithmetic — conformance fixtures, no new dependency

**Why hand-rolled.** Per the user's ruling 2 ("ACP is just interface not
implementation. We do this under interface"). The supporting engineering
reason is LIFECYCLE, not transport binding: the official
`@agentclientprotocol/sdk` takes a generic bidirectional stream
(`new AgentSideConnection(toAgent, stream: Stream)`), so it is NOT
stdio-bound — `ndJsonStream` is merely its usual stdio helper and the same
pair works over a socket. What does not fit is the lifecycle: the SDK's
shape is a connection object per client, while our endpoint is a socket
that OUTLIVES every client and serves many of them against one warm
session. We implement the ACP WIRE CONTRACT (JSON-RPC 2.0,
newline-delimited, the methods we serve) with zero new runtime
dependencies and lock it with fixtures transcribed from the spec
(agentclientprotocol.com/protocol/*).

**Scope honesty: this is a PRIVATE INSTRUMENT PROFILE of the ACP wire, not
a general-purpose ACP agent.** `session/prompt` REQUIRES `_meta.model`,
which no standard editor client sends; `session/new`'s `cwd` is accepted
and ignored because the instrument pins a neutral `cwd`. The dispatcher is
transport-agnostic and a `--stdio` binding is a flag rather than a rewrite
— but that binding serves the SAME private profile (our own tooling over
stdio), NOT off-the-shelf editors. Anyone wanting real editor
interoperability must relax `_meta.model` and honour `session/new.cwd`,
which would change the instrument and needs its own amendment.

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-wire.ts`
- Test: `cc-gate-plugin/test/acp-wire.test.ts`

**Interfaces:**
- Produces:
  - `interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown }`
  - `interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: JsonRpcError }`
  - `interface JsonRpcError { code: number; message: string; data?: { callConsumed: boolean; model?: string } }`
  - `encodeFrame(msg: object): string` — `JSON.stringify(msg) + "\n"`
  - `class FrameDecoder { constructor(opts?: { maxLineBytes?: number }); push(chunk: Buffer | string): object[]; malformed: number }` — buffers partial lines; a malformed JSON line increments `malformed` and is dropped (never a throw — a broken client must not kill the daemon); a line exceeding `maxLineBytes` (default 4 MiB) also counts as malformed AND resets the buffer, so a client that never sends `\n` cannot grow the daemon's memory without bound.
  - Method-name constants: `ACP_INITIALIZE = "initialize"`, `ACP_SESSION_NEW = "session/new"`, `ACP_SESSION_PROMPT = "session/prompt"`, `ACP_SESSION_CANCEL = "session/cancel"`, `ACP_SESSION_UPDATE = "session/update"` (notification).
  - `ACP_BUDGET` — the ONE timing-constant object (Global Constraints table). It lives here, in the module BOTH sides already import, because the client's leg and the daemon's worst case are a single contract: split across two files they drift, and a drift silently converts §6e law L5 into law L2 (a `no-call` that should have been `call-consumed`, i.e. a double model call).
  - Instrument error codes — these ARE the call-consumption channel on the wire:
    - `ACP_ERR_NO_CALL = -32000` — §6e law L4. `data.callConsumed === false`.
    - `ACP_ERR_CALL_CONSUMED = -32001` — §6e law L5/L6. `data.callConsumed === true`.
    Both sit in JSON-RPC 2.0's RESERVED implementation-defined SERVER-ERROR band (`-32099..-32000`), which is where a server's own error semantics belong; true application-defined codes must live OUTSIDE `-32768..-32000`. Recorded precisely because a later reader will otherwise "fix" them into the wrong band. `data.callConsumed` is AUTHORITATIVE over the code (§6e law L3) so a code collision with a future ACP assignment degrades gracefully rather than into a double call.
  - Param/result shapes (types only, used by Tasks 5-6):
    `AcpInitializeResult { protocolVersion: number; agentCapabilities: { loadSession: false }; _meta: { envFingerprint: string } }` — the fingerprint echo §6e requires.
    `AcpNewSessionResult { sessionId: string }`,
    `AcpPromptParams { sessionId: string; prompt: Array<{ type: "text"; text: string }>; _meta: { model: string } }` — `_meta.model` is REQUIRED, not optional: the daemon must never silently substitute its own env's model for the caller's (see Task 5). This is the private-profile constraint noted above.
    `AcpPromptResult { stopReason: "end_turn"; _meta: { model: string; callConsumed: true } }` — `_meta.model` is the model the turn is PROVEN to have run on (`modelUsage` keys, sdk.d.ts:4312), echoed back for the caller's stamp; never the model the caller asked for.
    `AcpUpdateParams { sessionId: string; update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } } }`.
  - **Deliberate protocol note:** a daemon-side failure is a JSON-RPC ERROR, never `stopReason: "refusal"`. In ACP, `refusal` means the model refused; overloading it would make "daemon died" indistinguishable from "model refused" for any real client, and would give this instrument no place to carry `callConsumed`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
} from "../src/gauge/acp-wire.ts"

describe("acp-wire framing", () => {
  test("round-trips a request frame", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }))
    expect(frames.length).toBe(1)
    expect((frames[0] as { method: string }).method).toBe("initialize")
  })
  test("reassembles frames split across chunks", () => {
    const d = new FrameDecoder()
    const wire = encodeFrame({ jsonrpc: "2.0", id: 2, method: "session/new", params: { cwd: "/x" } })
    expect(d.push(wire.slice(0, 10)).length).toBe(0)
    expect(d.push(wire.slice(10)).length).toBe(1)
  })
  test("two frames in one chunk", () => {
    const d = new FrameDecoder()
    const frames = d.push(encodeFrame({ jsonrpc: "2.0", id: 3, method: "a" }) + encodeFrame({ jsonrpc: "2.0", id: 4, method: "b" }))
    expect(frames.length).toBe(2)
  })
  test("malformed line counts, never throws, stream survives", () => {
    const d = new FrameDecoder()
    const frames = d.push("not json\n" + encodeFrame({ jsonrpc: "2.0", id: 5, method: "ok" }))
    expect(frames.length).toBe(1)
    expect(d.malformed).toBe(1)
  })
  test("an unterminated giant line is dropped, not buffered forever", () => {
    const d = new FrameDecoder({ maxLineBytes: 64 })
    expect(d.push("x".repeat(200)).length).toBe(0)
    expect(d.malformed).toBe(1)
    // buffer was reset: a well-formed frame right after still decodes
    expect(d.push(encodeFrame({ jsonrpc: "2.0", id: 6, method: "ok" })).length).toBe(1)
  })
  test("the two instrument error codes are distinct, stable, and inside the reserved server-error band", () => {
    expect(ACP_ERR_NO_CALL).toBe(-32000)
    expect(ACP_ERR_CALL_CONSUMED).toBe(-32001)
    for (const c of [ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED]) {
      expect(c).toBeLessThanOrEqual(-32000)
      expect(c).toBeGreaterThanOrEqual(-32099)
    }
  })
})

// §6e budget rule, locked as arithmetic rather than prose: if the client
// leg ever stops exceeding the daemon's worst case, an ordinary slow turn
// trips law L2 and the record costs TWO model calls.
describe("ACP_BUDGET arithmetic (§6e budget rule)", () => {
  test("the four daemon legs sum to the declared worst case", () => {
    const b = ACP_BUDGET
    expect(b.queueWaitMs + b.clearTimeoutMs + b.turnTimeoutMs + b.hardGraceMs).toBe(b.daemonWorstCaseMs)
  })
  test("the client leg strictly exceeds the daemon worst case", () => {
    expect(ACP_BUDGET.daemonLegMs).toBeGreaterThan(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("daemon leg + minimum fallback still fits the per-record budget", () => {
    expect(ACP_BUDGET.daemonLegMs + ACP_BUDGET.minFallbackMs).toBeLessThanOrEqual(ACP_BUDGET.recordBudgetMs)
  })
  test("the per-record budget is unchanged from the incumbent 60s", () => {
    expect(ACP_BUDGET.recordBudgetMs).toBe(60_000)
  })
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts`
Expected: FAIL — `Export named 'FrameDecoder' not found`

- [ ] **Step 3: Implement `acp-wire.ts`**

```typescript
// §6e ACP wire subset. Hand-rolled, dependency-free (user ruling: "ACP is
// just interface not implementation"): JSON-RPC 2.0, newline-delimited,
// the methods this daemon serves. Wire shapes transcribed from
// agentclientprotocol.com (protocol/session-setup, protocol/prompt-turn);
// fixtures in acp-wire.test.ts are the conformance record.
//
// SCOPE: a PRIVATE INSTRUMENT PROFILE of the ACP wire, not a
// general-purpose ACP agent — `_meta.model` is REQUIRED on session/prompt
// and `session/new.cwd` is accepted-and-ignored (the instrument pins a
// neutral cwd). Off-the-shelf editor clients are explicitly out of scope.
//
// Transport-agnostic: the daemon binds it to a Unix socket, and a --stdio
// flag binds the same dispatcher to stdin/stdout for our own tooling.
export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  /** §6e law L3: AUTHORITATIVE call-consumption channel. The numeric code
   * is only the fallback for a daemon that omitted this. */
  data?: { callConsumed: boolean; model?: string }
}

export interface JsonRpcResponse {
  jsonrpc: "2.0"
  id: number | string
  result?: unknown
  error?: JsonRpcError
}

export const ACP_INITIALIZE = "initialize"
export const ACP_SESSION_NEW = "session/new"
export const ACP_SESSION_PROMPT = "session/prompt"
export const ACP_SESSION_CANCEL = "session/cancel"
export const ACP_SESSION_UPDATE = "session/update"

/** §6e law L4 — the turn never pushed its prompt. The caller MAY fall back
 * to the one-shot lane without breaking §4's exactly-one-call rule. */
export const ACP_ERR_NO_CALL = -32000
/** §6e law L5/L6 — a model request went out (or may have) and the turn
 * still failed. The caller MUST NOT fall back; the record stays
 * pending/retryable. */
export const ACP_ERR_CALL_CONSUMED = -32001

/** §6e budget rule. ONE object, in the module both sides import, because
 * `daemonLegMs > daemonWorstCaseMs` is a CONTRACT: split these across two
 * files and a drift silently converts a `call-consumed` into a `no-call`,
 * i.e. two model calls for one record. Locked by acp-wire.test.ts. */
export const ACP_BUDGET = {
  /** daemon: a turn still queued at this point never reached execute() */
  queueWaitMs: 6_000,
  /** daemon: `/clear` must be confirmed by conversation_reset within this */
  clearTimeoutMs: 4_000,
  /** daemon: generation budget, measured from the prompt push */
  turnTimeoutMs: 16_000,
  /** daemon: grace before destroying the Query when interrupt() hangs */
  hardGraceMs: 4_000,
  /** derived: 6 000 + 4 000 + 16 000 + 4 000 */
  daemonWorstCaseMs: 30_000,
  /** client: MUST exceed daemonWorstCaseMs */
  daemonLegMs: 33_000,
  /** client: below this remaining, do not start a fallback at all */
  minFallbackMs: 10_000,
  /** client: today's CALL_TIMEOUT_MS — per-record latency never exceeds it */
  recordBudgetMs: 60_000,
} as const

export interface AcpInitializeResult {
  protocolVersion: number
  agentCapabilities: { loadSession: false }
  /** §6e instrument fingerprint — the client refuses a daemon whose
   * fingerprint differs from its own (pre-send => law L1 => no-call). */
  _meta: { envFingerprint: string }
}
export interface AcpNewSessionResult { sessionId: string }
export interface AcpPromptParams {
  sessionId: string
  prompt: Array<{ type: "text"; text: string }>
  /** REQUIRED: the daemon never substitutes its own env's model for the
   * caller's — a silent substitution would make the record's `model` stamp
   * a lie (§6e provenance rule). */
  _meta: { model: string }
}
export interface AcpPromptResult {
  stopReason: "end_turn"
  /** `model` is the model the turn is PROVEN to have run on (result
   * `modelUsage` keys, sdk.d.ts:4312) — never the requested model, which
   * would make the caller's check a tautology. */
  _meta: { model: string; callConsumed: true }
}
export interface AcpUpdateParams {
  sessionId: string
  update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
}

export function encodeFrame(msg: object): string {
  return JSON.stringify(msg) + "\n"
}

const DEFAULT_MAX_LINE_BYTES = 4 * 1024 * 1024

/** Newline-delimited JSON-RPC decoder. Malformed lines (and lines longer
 * than `maxLineBytes`, which also reset the buffer) increment `malformed`
 * and are dropped — a broken or hostile client never kills the daemon and
 * never grows its memory without bound. */
export class FrameDecoder {
  private buf = ""
  private readonly maxLineBytes: number
  malformed = 0

  constructor(opts: { maxLineBytes?: number } = {}) {
    this.maxLineBytes = opts.maxLineBytes ?? DEFAULT_MAX_LINE_BYTES
  }

  push(chunk: Buffer | string): object[] {
    this.buf += chunk.toString()
    const out: object[] = []
    let nl: number
    while ((nl = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, nl)
      this.buf = this.buf.slice(nl + 1)
      if (!line.trim()) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (typeof parsed === "object" && parsed !== null) out.push(parsed)
        else this.malformed++
      } catch {
        this.malformed++
      }
    }
    if (this.buf.length > this.maxLineBytes) {
      this.malformed++
      this.buf = ""
    }
    return out
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-wire.test.ts` — 0 fail. `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-wire.ts cc-gate-plugin/test/acp-wire.test.ts
git commit -m "feat(gauge): ACP wire subset — framing, method constants, call-consumption codes, budget arithmetic"
```

### Task 3: Widen the transport literal to `agent-sdk-daemon`

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (`GAUGE_TRANSPORTS`, line 167)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts:49` (DECLARED EXCEPTION #1) + append one test (DECLARED EXCEPTION #2)
- Modify: `cc-gate-plugin/test/paired-validation.test.ts` (append two tests — DECLARED EXCEPTION #3)

**Interfaces:**
- Consumes: `GAUGE_TRANSPORTS`, `GaugeTransport` (currently `["cli","sdk","agent-sdk"]`, `src/types.ts:167-168`).
- Produces: `GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const` (incumbent-first order preserved) and the derived union. Everything downstream (`parsePairFlag` at `paired-validation.ts:349-362`, `PvPairing`, `arms` fields, `derivedOn`, `parsePvCountsFile`'s arms validation at `:638`) picks the new literal up structurally — the §6d plan parameterized them over `GAUGE_TRANSPORTS` for exactly this reason.

- [ ] **Step 1: Write the failing tests** (in the files that already import these symbols — `gauge-agent-transport.test.ts` owns `GAUGE_TRANSPORTS`/`selectTransport`, `paired-validation.test.ts` already imports `parsePairFlag` and `isCliDerived` at `:8`/`:21`; do NOT put them in `gauge-wiring.test.ts`, which is a hook-to-refiner E2E file that imports neither)

```typescript
// test/gauge-agent-transport.test.ts — EXTEND the existing literal-list
// assertion at line 49 (declared exception #1): a fourth registered literal
// necessarily invalidates a toEqual on the old three.
test("four transports are recognized, incumbent order preserved (§6e)", () => {
  expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk", "agent-sdk-daemon"])
})

// test/paired-validation.test.ts (declared exception #3 — append only)
test("parsePairFlag accepts the §6e literal structurally", () => {
  const p = parsePairFlag(["--pair", "sdk:agent-sdk-daemon"])!
  expect(p.shadowTransport).toBe("agent-sdk-daemon")
  expect(p.baselineLabel).toBe("sdk")
})
test("an agent-sdk-daemon record is NOT CLI-derived", () => {
  expect(isCliDerived({ derivation: { transport: "agent-sdk-daemon", class: "C" } } as never)).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts test/paired-validation.test.ts`
Expected: FAIL — array does not contain `"agent-sdk-daemon"`.

- [ ] **Step 3: Widen the literal in `types.ts:167`**

```typescript
/** §6d: a third transport joins the §6c pair. §6e: a fourth, the warm
 * daemon lane. Order is incumbent-first so existing readings that sort by
 * this array do not reshuffle. */
export const GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const
export type GaugeTransport = (typeof GAUGE_TRANSPORTS)[number]
```

- [ ] **Step 4: Full suite green**

Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Grep-verify no OTHER literal-list assertion exists:
`grep -rn 'GAUGE_TRANSPORTS' cc-gate-plugin/test/` — expect exactly two hits in `gauge-agent-transport.test.ts` (the import at `:6` and the one updated assertion at `:49`). Any other hit is an undeclared exception — stop and report.
`isCliDerived` (`paired-validation.ts:56-59`) already reads `"cli"`-or-absent, so the new literal cannot fall into the CLI baseline; the appended test pins that.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/test/gauge-agent-transport.test.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): widen transport literal to agent-sdk-daemon"
```

### Task 4: `WarmSession` — warm streaming Query, persistent pump, lossless feed, sequenced recycle

**Files:**
- Create: `cc-gate-plugin/test/agent-cli-stub.ts` (helper extraction, Step 0 — DECLARED EXCEPTION #4)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (import the extracted helpers instead of defining them — a MOVE, no assertion changes)
- Create: `cc-gate-plugin/src/gauge/warm-session.ts`
- Test: `cc-gate-plugin/test/warm-session.test.ts`

**Interfaces:**
- Consumes: `query`, `Query`, `SDKMessage`, `SDKUserMessage` from `@anthropic-ai/claude-agent-sdk` (lazy-imported inside `ensure()`, same rationale as `agent-transport.ts:104-108`'s ~84 ms finding); `ACP_BUDGET` from `acp-wire.ts`; the isolation option set from `agent-transport.ts:119-132` (copy the object literal, cite it — do NOT import agent-transport's private internals).
- Produces:
  ```typescript
  export type TurnOutcome =
    | { kind: "ok"; text: string; model: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  export type CancelResult = "queued-dropped" | "interrupted" | "unknown"

  export class WarmSession {
    constructor(
      env: Record<string, string | undefined>,
      opts?: {
        turnTimeoutMs?: number
        queueWaitMs?: number
        clearTimeoutMs?: number
        hardGraceMs?: number
        cwd?: string
      },
    )
    /** ONE serialized turn, resolving per §6e's wire-send boundary law.
     * `recycle` is the CALLER's decision (the daemon passes true when the
     * sessionId differs from the last one served), so a multi-prompt ACP
     * session keeps its context — see Task 5. `tag` is an opaque handle for
     * `cancel`. Never two turns in flight: calls queue FIFO. NEVER throws,
     * ALWAYS resolves. */
    oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome>
    /** Cancel by tag. A QUEUED turn is dropped and resolves `no-call`
     * (provably unsent, law L4); the IN-FLIGHT turn is interrupted only if
     * it carries this tag — never another caller's turn. */
    cancel(tag: string): CancelResult
    isWarm(): boolean
    turnInFlight(): boolean
    /** ms since the last COMPLETED turn — the idle reaper reads this. */
    idleMs(): number
    /** Terminate the Query and subprocess, and settle every outstanding
     * caller (queued turns resolve `no-call`). Idempotent. */
    close(): void
  }
  ```

**Design (locked by sdk.d.ts and by §6e's law, not by prose):**
- ONE `query({ prompt: pushable.stream(), options })`; the same `Query` serves many turns.
- **ONE persistent pump.** `Query extends AsyncGenerator<SDKMessage, void>` (sdk.d.ts:2279). Returning or breaking out of a `for await` calls `iterator.return()` and TERMINATES the generator — so a per-turn `for await` kills the warm session at the end of turn #1. The pump is a single loop for the `Query`'s whole lifetime that never breaks and never returns; it routes each message to `this.current`.
- **Lossless feed.** The input side is a pushable queue with an optional waiting resolver, NOT a bare one-shot promise slot. A single re-armed resolver silently drops the second of two same-tick pushes.
- **Exactly TWO resolver slots per turn, written exactly once each.** `turn.notifyCaller` is installed at ENQUEUE (it resolves the caller's `oneShot`) and `turn.settle` is installed by `execute` (it resolves the drain loop's internal wait). They are never the same field: a design that reuses one slot for both loses the queued caller's resolver when `execute` overwrites it, and that caller's promise never settles. Both are fired through the single `finish()` funnel, which is `done`-guarded, so double-settle is impossible.
- **Recycle is SEQUENCED, not fire-and-forget.** `/clear` is pushed only when the caller asks for it AND the `Query` is not brand-new, and `execute` then WAITS for `SDKConversationResetMessage` (`type: 'conversation_reset'`, sdk.d.ts:3838-3846: *"Emitted by /clear, plan-mode exit, and fresh-session flows"*), which is in the `SDKMessage` union (sdk.d.ts:4019). This is the SDK's own typed proof the recycle landed — we do not have to trust "/clear emits no result", and the prompt cannot be pushed into a half-cleared context. An unconfirmed clear within `clearTimeoutMs` destroys the `Query` (the next turn respawns, which is a clean context by construction) and reports `no-call` — nothing was sent to the model.
- **A turn settles ONLY from its own terminal `result`** (§6e law L7). `api_retry` and the turn timeout mark the turn `doomed` and call `interrupt()`, but do not settle; the terminal `result` does. The drain loop does not advance until then, so a trailing message can never be attributed to the next turn. A `result` arriving while `turn.sent === false` belongs to the `/clear` or to a previous turn's tail and is dropped (counted in `strayMessages`). If `interrupt()` hangs past `hardGraceMs`, the whole `Query` + subprocess is destroyed, which also makes a stale message impossible.
- **Classification is §6e's law, mechanically.** `sent` is the boundary. `sawModelActivity` (an `assistant` message) and `sawApiResponse` (an `api_retry` whose `error_status !== null`, sdk.d.ts:2842-2852) are the two consumption witnesses. `connectionOnly` (an `api_retry` with `error_status === null`, which sdk.d.ts:2839-2841 documents as "null for connection errors (e.g. timeouts) that had no HTTP response") is the single provable-unsent witness of law L5. `stream_event` is deliberately NOT consulted: `SDKPartialAssistantMessage` is only emitted with `includePartialMessages: true` (sdk.d.ts:1629-1631), which this option set does not set, so such a branch would be unreachable code pretending to be a guard.
- **Success requires `subtype === "success" && is_error !== true && !doomed`.** `SDKResultError` (sdk.d.ts:4269-4288) has NO `result` field, and an interrupted assistant message is flagged `aborted` (sdk.d.ts:2871). No partial text is ever accumulated, let alone persisted.
- **The model is PROVEN, not echoed.** `modelUsage` keys on the success result (sdk.d.ts:4312) are authoritative; the last assistant `message.model` corroborates. A successful turn that cannot prove its model reports `call-consumed` — the call happened, but no honest stamp is available.
- Model switching: `setModel(model)` (sdk.d.ts:2327, streaming-only) before a turn whose model differs from the current one.

- [ ] **Step 0: Extract the CLI-stub helpers (DECLARED EXCEPTION #4 — a MOVE, no behaviour change)**

Move `hasClaudeCodeCredentials()` / `HAS_CLAUDE_CODE_CREDENTIALS` / `NO_CREDENTIALS_SKIP_REASON` (`test/gauge-agent-transport.test.ts:23-45`), `sseText()` (`:92-103`) and `withCaptureStub()` (`:116-145`) into `test/agent-cli-stub.ts` and re-import them in `gauge-agent-transport.test.ts`. No assertion in that file changes; `bun test` must be 0-fail before and after. (`test/agent-cli-stub.ts` is not matched by bun's test glob, same as the existing `test/sdk-stub.ts`.)
**Why this is mandatory, not tidiness:** `sseText` is load-bearing. The spawned CLI always sends `stream: true`, and a plain `Response.json(...)` makes it silently fall back to a SECOND, non-streaming request (`gauge-agent-transport.test.ts:67-91`). Every request-count assertion in Tasks 4-6 is meaningless without an SSE-shaped stub. And `withCaptureStub()` is per-test on purpose (`:107-115`): a killed test's subprocess can land mid-next-test, so a module-level shared `CAPTURED` corrupts unrelated counts. Tests below that need their own capture array build one with `stubServer` directly and follow the same per-test discipline.
**Also add to `agent-cli-stub.ts`** the never-answering stub helper, built on raw `Bun.serve` (precedent: `gauge-agent-transport.test.ts:252`) because `stubServer`'s handler type is synchronous `(c: Captured) => Response` and must NOT be widened:

```typescript
/** A server that accepts the connection and never answers. `stubServer`'s
 * handler type is `(c: Captured) => Response` — synchronous — so a hanging
 * stub cannot be expressed through it without widening a shared helper.
 * Raw Bun.serve is the established precedent (gauge-agent-transport.test.ts:252). */
export function silentServer(): { url: string; stop: () => void } {
  const s = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true) }
}

/** A server whose FIRST request hangs forever and whose later requests are
 * answered normally — the shape the turn-timeout test needs. */
export function hangFirstServer(text: string): { url: string; stop: () => void; count: () => number } {
  let n = 0
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text()
      if (!body) return new Response(null, { status: 200 })   // HEAD /api/hello probe
      n++
      if (n === 1) return new Promise<Response>(() => {})
      return sseText(text)
    },
  })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true), count: () => n }
}
```

- [ ] **Step 1: Write the failing tests** (every one obeys §6e's law; every one carries `CLI_TEST_TIMEOUT_MS` and the credentials skip-guard)

```typescript
import { describe, expect, test } from "bun:test"
import { WarmSession } from "../src/gauge/warm-session.ts"
import {
  HAS_CLAUDE_CODE_CREDENTIALS, sseText, silentServer, hangFirstServer,
} from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

const CLI_TEST_TIMEOUT_MS = 60_000
const HAIKU = "claude-haiku-4-5"

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("WarmSession (spawns bundled CLI)", () => {
  test("two records reuse one subprocess; the second context is clean; exactly one call each", async () => {
    let n = 0
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText(`ANSWER-${++n}`) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r1 = await ws.oneShot("first record prompt", HAIKU, { recycle: true })
      const r2 = await ws.oneShot("second record prompt", HAIKU, { recycle: true })
      expect(r1.kind).toBe("ok")
      expect(r2.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)                        // exactly 1 model call per record
      const m2 = CAPTURED[1] as { messages: unknown[] }
      // THE binding assertion: the first record's text is gone from the
      // second turn's context — that is what "/clear reset the context"
      // means. The exact MESSAGE COUNT is NOT asserted: §6e registers a
      // ~423 B `/clear` echo residue whose shape (folded into the next user
      // message vs its own message) was never measured, and a hard toBe(1)
      // would fail a correct implementation. Record the observed count in
      // the SDD progress note (Step 4) and pin it there once measured.
      expect(JSON.stringify(m2.messages)).not.toContain("first record prompt")
      expect(JSON.stringify(m2.messages)).toContain("second record prompt")
      expect(m2.messages.length).toBeLessThanOrEqual(2)      // bulk-history regression guard
      expect(ws.isWarm()).toBe(true)                         // no respawn between records
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("recycle:false keeps context (ACP multi-prompt session semantics)", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER") })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      await ws.oneShot("turn one marker", HAIKU, { recycle: true })
      await ws.oneShot("turn two", HAIKU, { recycle: false })
      expect(JSON.stringify((CAPTURED[1] as { messages: unknown[] }).messages)).toContain("turn one marker")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5: a SENT turn that times out is call-consumed (never partial text); session stays warm", async () => {
    // The endpoint ACCEPTS the connection and never answers: the request is
    // in flight at the API, so the conservative side of the ambiguity is
    // "consumed" — the caller must NOT fall back.
    const cap = hangFirstServer("ANSWER")
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 2_000, hardGraceMs: 2_000 })
    try {
      const r1 = await ws.oneShot("hanging record", HAIKU, { recycle: true })
      expect(r1.kind).toBe("call-consumed")                  // NOT ok, NOT no-call
      expect("text" in r1).toBe(false)                       // no truncated text escapes
      const r2 = await ws.oneShot("normal record", HAIKU, { recycle: true })
      expect(r2.kind).toBe("ok")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L6: a 500 (api_retry, error_status non-null) is call-consumed and the retry is never consumed as a result", async () => {
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER")))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("retry-provoking record", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
      expect(n).toBeLessThanOrEqual(2)   // the abort races an in-flight retry; a THIRD request means it never landed
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5 exception: connection-only failure (no HTTP response ever) is no-call", async () => {
    // sdk.d.ts:2839-2841 — api_retry carries `error_status: null` for
    // connection errors that had NO HTTP response, and the CLI is
    // documented to retry a refused connection internally
    // (gauge-agent-transport.test.ts:230-241). Nothing reached the model.
    //
    // IF a future CLI stops announcing connection retries, this turn
    // produces no witness at all and the law's conservative default makes
    // it `call-consumed`. That costs one lost fallback, never a double
    // call — so it is the TEST that must then be updated, not the law.
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      { turnTimeoutMs: 2_000, hardGraceMs: 2_000 })
    try {
      const r = await ws.oneShot("x", HAIKU, { recycle: true })
      expect(r.kind).toBe("no-call")
    } finally { ws.close() }
  }, CLI_TEST_TIMEOUT_MS)

  test("FIFO: concurrent oneShots serialize; BOTH resolve; two calls total", async () => {
    // The queued caller's promise must resolve. A design that lets execute()
    // overwrite the queue-waiter's resolver deadlocks here.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER") })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const [a, b] = await Promise.all([
        ws.oneShot("record A", HAIKU, { recycle: true }),
        ws.oneShot("record B", HAIKU, { recycle: true }),
      ])
      expect(a.kind).toBe("ok")
      expect(b.kind).toBe("ok")
      expect(CAPTURED.length).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L4: a turn still queued at its queue-wait cap resolves no-call, provably unsent", async () => {
    const cap = hangFirstServer("ANSWER")
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 6_000, hardGraceMs: 2_000, queueWaitMs: 500 })
    try {
      const first = ws.oneShot("occupies the session", HAIKU, { recycle: true })
      const queued = await ws.oneShot("never gets its turn", HAIKU, { recycle: true })
      expect(queued.kind).toBe("no-call")        // never reached execute()
      await first                                 // drain, whatever it becomes
      expect(cap.count()).toBe(1)                 // the queued turn sent NOTHING
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel(tag) drops only that caller's turn, never the other caller's in-flight turn", async () => {
    const cap = hangFirstServer("ANSWER")
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 6_000, hardGraceMs: 2_000, queueWaitMs: 30_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "B" })
      expect(ws.cancel("B")).toBe("queued-dropped")
      expect((await queued).kind).toBe("no-call")
      expect(ws.cancel("nobody")).toBe("unknown")     // must not touch A
      const a = await inflight
      expect(a.kind).toBe("call-consumed")            // A ended on its OWN timeout, not B's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("the reported model is PROVEN from the result, not echoed from the request", async () => {
    const cap = stubServer(() => sseText("ANSWER"))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("x", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      // sseText's message_start declares model claude-haiku-4-5, so the
      // proven model and the requested model coincide here. What this pins
      // is that a model is REPORTED AT ALL from the result path; the fake
      // daemon in Task 7 pins the divergence branch.
      expect(r.kind === "ok" && r.model).toBe(HAIKU)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("close() settles every outstanding caller — no hanging promises", async () => {
    const cap = hangFirstServer("ANSWER")
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 30_000, hardGraceMs: 5_000, queueWaitMs: 30_000 })
    const inflight = ws.oneShot("A", HAIKU, { recycle: true })
    const queued = ws.oneShot("B", HAIKU, { recycle: true })
    await new Promise((r) => setTimeout(r, 1_500))
    ws.close()
    const [a, b] = await Promise.all([inflight, queued])
    expect(a.kind === "call-consumed" || a.kind === "no-call").toBe(true)
    expect(b.kind).toBe("no-call")                  // queued: provably unsent
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts`
Expected: FAIL — `Export named 'WarmSession' not found`

- [ ] **Step 3: Implement `warm-session.ts`** — this skeleton is the design, not a sketch

```typescript
// §6e WarmSession: one streaming-input Query, ONE persistent message pump,
// a lossless pushable input queue, /clear recycling SEQUENCED on the SDK's
// own conversation_reset message, FIFO turns, and three-way outcomes that
// implement §6e's wire-send boundary law mechanically.
//
// Isolation options are the §6d set (agent-transport.ts:119-132) with TWO
// registered deltas (§6e):
//  (a) REMOVED `maxTurns: 1` + `abortController` — query-scoped, cannot
//      transfer to a many-turn session (maxTurns would stop the whole Query
//      after record #1; aborting the shared controller would kill every
//      later turn). Replaced by per-turn call accounting + interrupt().
//  (b) ADDED a neutral `cwd` — §6d measured it payload-neutral (spec line
//      690) and agent-transport.ts:41-44 omits it as redundant for a
//      one-shot; for a host-global daemon it is what stops the instrument
//      varying with whichever session spawned it.
//
// Lazy SDK import (hook processes must not pay the ~84 ms package load;
// same finding as agent-transport.ts:104-108).
import os from "node:os"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ACP_BUDGET } from "./acp-wire.ts"

export type TurnOutcome =
  | { kind: "ok"; text: string; model: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

export type CancelResult = "queued-dropped" | "interrupted" | "unknown"

interface Turn {
  text: string
  model: string
  recycle: boolean
  tag: string | undefined
  /** THE §6e send boundary, daemon-side: true once this turn's prompt frame
   * has been pushed into the CLI's input stream. */
  sent: boolean
  /** consumption witness: model output observed (assistant message) */
  sawModelActivity: boolean
  /** consumption witness: the API answered, even with an error
   * (api_retry, error_status !== null — sdk.d.ts:2842-2852) */
  sawApiResponse: boolean
  /** provable-unsent witness (law L5 exception): api_retry with
   * error_status === null, i.e. a connection error with NO HTTP response
   * (sdk.d.ts:2839-2841) */
  connectionOnly: boolean
  /** interrupted / retry-cancelled: settle from the TERMINAL result, never
   * `ok`, and never at the moment of cancellation (law L7) */
  doomed: boolean
  done: boolean
  /** the model this turn is PROVEN to have run on */
  observedModel: string
  /** resolves this caller's oneShot(). Written ONCE, at enqueue. */
  notifyCaller: (o: TurnOutcome) => void
  /** resolves execute()'s internal wait. Written ONCE, by execute().
   * DELIBERATELY a different field from notifyCaller: one shared slot loses
   * the queued caller's resolver and deadlocks that caller forever. */
  settle: (o: TurnOutcome) => void
  queueTimer?: ReturnType<typeof setTimeout>
  timer?: ReturnType<typeof setTimeout>
  hardTimer?: ReturnType<typeof setTimeout>
}

/** Lossless pushable async iterable. N pushes in one synchronous tick all
 * land; a single re-armed promise resolver would drop every push after the
 * first (this is the defect that killed the first draft of this design). */
class Pushable {
  private queue: SDKUserMessage[] = []
  private waiter: ((m: SDKUserMessage | undefined) => void) | undefined
  private closed = false

  push(m: SDKUserMessage): void {
    if (this.closed) return
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(m)
      return
    }
    this.queue.push(m)
  }

  close(): void {
    this.closed = true
    const w = this.waiter
    if (w) {
      this.waiter = undefined
      w(undefined)
    }
  }

  async *stream(): AsyncGenerator<SDKUserMessage> {
    for (;;) {
      const next = this.queue.shift()
      if (next !== undefined) {
        yield next
        continue
      }
      if (this.closed) return
      const m = await new Promise<SDKUserMessage | undefined>((res) => {
        this.waiter = res
      })
      if (m === undefined) return
      yield m
    }
  }
}

function userMsg(text: string): SDKUserMessage {
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

/** Corroborating model id off an assistant message (`message.model`). The
 * AUTHORITATIVE source is the terminal result's `modelUsage` keys
 * (sdk.d.ts:4312) — see route(). */
function assistantModel(m: SDKMessage): string {
  const model = (m as { message?: { model?: unknown } }).message?.model
  return typeof model === "string" ? model : ""
}

export class WarmSession {
  private q: Query | undefined
  private feed: Pushable | undefined
  private pump: Promise<void> | undefined
  private pending: Turn[] = []
  private draining = false
  private current: Turn | undefined
  private resetWaiter: ((ok: boolean) => void) | undefined
  private fresh = true
  private closed = false
  private currentModel = ""
  private lastActivity = Date.now()
  /** diagnostics only: messages that arrived with no turn to own them */
  strayMessages = 0
  private readonly turnTimeoutMs: number
  private readonly queueWaitMs: number
  private readonly clearTimeoutMs: number
  private readonly hardGraceMs: number
  private readonly cwd: string

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: {
      turnTimeoutMs?: number
      queueWaitMs?: number
      clearTimeoutMs?: number
      hardGraceMs?: number
      cwd?: string
    } = {},
  ) {
    this.turnTimeoutMs = opts.turnTimeoutMs ?? ACP_BUDGET.turnTimeoutMs
    this.queueWaitMs = opts.queueWaitMs ?? ACP_BUDGET.queueWaitMs
    this.clearTimeoutMs = opts.clearTimeoutMs ?? ACP_BUDGET.clearTimeoutMs
    this.hardGraceMs = opts.hardGraceMs ?? ACP_BUDGET.hardGraceMs
    this.cwd = opts.cwd ?? os.tmpdir()
  }

  oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome> {
    return new Promise<TurnOutcome>((resolveCaller) => {
      const turn: Turn = {
        text: messageText,
        model,
        recycle: opts.recycle,
        tag: opts.tag,
        sent: false,
        sawModelActivity: false,
        sawApiResponse: false,
        connectionOnly: false,
        doomed: false,
        done: false,
        observedModel: "",
        notifyCaller: resolveCaller,   // written ONCE, here, never again
        settle: () => {},
      }
      if (this.closed) {
        this.finish(turn, { kind: "no-call" })
        return
      }
      this.pending.push(turn)
      // Law L4: a turn still PENDING when this fires never reached
      // execute(), so nothing was pushed — a PROVABLE no-call. This is what
      // keeps FIFO contention on the SAFE side of the fallback rule.
      turn.queueTimer = setTimeout(() => {
        const i = this.pending.indexOf(turn)
        if (i < 0) return                       // already started; its own timers own it
        this.pending.splice(i, 1)
        this.finish(turn, { kind: "no-call" })
      }, this.queueWaitMs)
      void this.drain()
    })
  }

  cancel(tag: string): CancelResult {
    const i = this.pending.findIndex((t) => t.tag === tag)
    if (i >= 0) {
      const [t] = this.pending.splice(i, 1)
      if (t) this.finish(t, { kind: "no-call" })   // never sent -> provable no-call
      return "queued-dropped"
    }
    const c = this.current
    if (c && !c.done && c.tag !== undefined && c.tag === tag) {
      c.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
      return "interrupted"
    }
    // A cancel that names nobody must NEVER interrupt whoever happens to be
    // in flight — with one global FIFO that would be another caller's turn.
    return "unknown"
  }

  isWarm(): boolean { return this.q !== undefined }
  /** Includes the shift->execute window (`draining`), so the idle reaper
   * cannot exit between a turn leaving the queue and becoming `current`. */
  turnInFlight(): boolean { return this.current !== undefined || this.pending.length > 0 || this.draining }
  idleMs(): number { return Date.now() - this.lastActivity }

  close(): void {
    this.closed = true
    this.hardReset()
    const c = this.current
    if (c && !c.done) this.finish(c, { kind: this.consumed(c) ? "call-consumed" : "no-call" })
    const queued = this.pending.splice(0, this.pending.length)
    for (const t of queued) this.finish(t, { kind: "no-call" })   // provably unsent
  }

  // ── internals ────────────────────────────────────────────────────────

  /** §6e law L5, mechanically: a SENT turn is consumed unless the only
   * failure signal ever seen was connection-level with no HTTP response
   * and no model output. An UNSENT turn is never consumed (law L4). */
  private consumed(t: Turn): boolean {
    if (!t.sent) return false
    if (t.sawModelActivity || t.sawApiResponse) return true
    return !t.connectionOnly
  }

  /** The ONE settle funnel. `done`-guarded, so double-settle is impossible,
   * and it fires BOTH resolver slots so no caller can ever hang. */
  private finish(turn: Turn, outcome: TurnOutcome): void {
    if (turn.done) return
    turn.done = true
    if (turn.queueTimer) clearTimeout(turn.queueTimer)
    if (turn.timer) clearTimeout(turn.timer)
    if (turn.hardTimer) clearTimeout(turn.hardTimer)
    if (this.current === turn) this.current = undefined
    this.lastActivity = Date.now()
    turn.notifyCaller(outcome)
    turn.settle(outcome)
  }

  private hardReset(): void {
    try { this.q?.close() } catch { /* idempotent */ }
    this.feed?.close()
    const w = this.resetWaiter
    this.resetWaiter = undefined
    w?.(false)
    this.q = undefined
    this.feed = undefined
    this.pump = undefined
    this.fresh = true
    this.currentModel = ""
  }

  /** FIFO driver. Exactly one drain runs at a time and it resolves NOBODY —
   * every caller is resolved by finish(), which is why the queued caller's
   * resolver can never be clobbered. */
  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true
    try {
      for (;;) {
        const turn = this.pending.shift()
        if (turn === undefined) break
        if (turn.done) continue                // queue-wait cap or cancel got it first
        if (turn.queueTimer) { clearTimeout(turn.queueTimer); turn.queueTimer = undefined }
        await this.execute(turn)               // ALWAYS resolves, via finish()
      }
    } finally {
      this.draining = false
    }
  }

  /** Ensure a live Query + pump. Returns false when the session cannot be
   * started at all (law L4 — nothing was pushed). */
  private async ensure(model: string): Promise<boolean> {
    if (this.closed) return false
    if (this.q) return true
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk")
      const subprocessEnv: Record<string, string> = {}
      for (const [k, v] of Object.entries(this.env)) if (v !== undefined) subprocessEnv[k] = v
      const feed = new Pushable()
      const q = query({
        prompt: feed.stream(),
        options: {
          model,
          systemPrompt: "",
          settingSources: [],
          settings: { autoMemoryEnabled: false },
          persistSession: false,
          strictMcpConfig: true,
          tools: [],
          title: "kkamak-gauge",
          thinking: { type: "disabled" },
          cwd: this.cwd,
          env: subprocessEnv,
        },
      })
      this.q = q
      this.feed = feed
      this.currentModel = model
      this.fresh = true
      this.pump = this.runPump(q)
      return true
    } catch {
      this.hardReset()
      return false
    }
  }

  /** THE ONE PUMP. Never breaks, never returns early — `Query` is an
   * AsyncGenerator (sdk.d.ts:2279), so exiting a `for await` calls
   * `.return()` and terminates it. A per-turn loop would kill the warm
   * session at the end of record #1. */
  private async runPump(q: Query): Promise<void> {
    try {
      for await (const m of q) this.route(m)
    } catch {
      /* the query died; settled below */
    } finally {
      const w = this.resetWaiter
      this.resetWaiter = undefined
      w?.(false)
      const t = this.current
      if (t && !t.done) this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })
      this.hardReset()
    }
  }

  private route(m: SDKMessage): void {
    // /clear confirmation. SDKConversationResetMessage (sdk.d.ts:3838-3846:
    // "Emitted by /clear, plan-mode exit, and fresh-session flows"; in the
    // SDKMessage union at sdk.d.ts:4019) is the SDK's OWN typed proof the
    // recycle landed — we sequence on it instead of trusting "/clear emits
    // no result", which was only ever an indicative scratch observation.
    if (m.type === "conversation_reset") {
      const w = this.resetWaiter
      this.resetWaiter = undefined
      w?.(true)
      return
    }

    const t = this.current
    if (!t || t.done) { this.strayMessages++; return }

    if (m.type === "assistant") {
      t.sawModelActivity = true
      t.connectionOnly = false
      const am = assistantModel(m)
      if (am) t.observedModel = am               // corroboration; result wins below
    }

    if (m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") {
      // sdk.d.ts:2839-2841 — "error_status is null for connection errors
      // (e.g. timeouts) that had no HTTP response". Non-null => the API
      // ANSWERED => law L6, consumed. Null with nothing else seen => law
      // L5's exception, provably unsent.
      const status = (m as { error_status?: number | null }).error_status
      if (status !== null && status !== undefined) {
        t.sawApiResponse = true
        t.connectionOnly = false
      } else if (!t.sawModelActivity && !t.sawApiResponse) {
        t.connectionOnly = true
      }
      // The CLI auto-retries internally; that retry would be call #2 (§6d
      // finding, agent-transport.ts:135-145). Cancel now — but DO NOT
      // settle: law L7 settles from the turn's OWN terminal result, so no
      // trailing message can ever be attributed to the NEXT turn.
      t.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
      return
    }

    if (m.type === "result") {
      // A result arriving before THIS turn's prompt went out belongs to the
      // /clear or to a previous turn's tail — never to this turn.
      if (!t.sent) { this.strayMessages++; return }
      const r = m as {
        subtype?: string
        is_error?: boolean
        result?: unknown
        modelUsage?: Record<string, unknown>
      }
      // AUTHORITATIVE model (§6e provenance): the keys of `modelUsage` on
      // the result (sdk.d.ts:4312). `message.model` above is corroboration.
      const usageModels = r.modelUsage ? Object.keys(r.modelUsage) : []
      if (usageModels.length === 1 && usageModels[0]) t.observedModel = usageModels[0]

      const success = r.subtype === "success" && r.is_error !== true && !t.doomed
      if (success && typeof r.result === "string" && r.result) {
        if (!t.observedModel) {
          // The call happened but the turn cannot prove which model ran it;
          // an unprovable stamp is worse than a retryable record.
          this.finish(t, { kind: "call-consumed" })
          return
        }
        this.finish(t, { kind: "ok", text: r.result, model: t.observedModel })
        return
      }
      // SDKResultError carries no `result` (sdk.d.ts:4269-4288) and an
      // interrupted assistant message is `aborted` (sdk.d.ts:2871) — no
      // partial text is ever accumulated here, let alone persisted.
      this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })
    }
  }

  /** Push `/clear` and WAIT for conversation_reset. Nothing has been sent
   * to the model at this point, so every failure here is law L4. */
  private async awaitClear(): Promise<boolean> {
    const feed = this.feed
    if (!feed) return false
    const done = new Promise<boolean>((res) => { this.resetWaiter = res })
    const timer = setTimeout(() => {
      const w = this.resetWaiter
      this.resetWaiter = undefined
      w?.(false)
    }, this.clearTimeoutMs)
    feed.push(userMsg("/clear"))
    try {
      return await done
    } finally {
      clearTimeout(timer)
    }
  }

  private async execute(turn: Turn): Promise<void> {
    // execute()'s OWN wait slot — never the caller's.
    const settled = new Promise<TurnOutcome>((res) => { turn.settle = res })

    if (!(await this.ensure(turn.model))) { this.finish(turn, { kind: "no-call" }); return }

    if (turn.model !== this.currentModel) {
      try {
        await this.q!.setModel(turn.model)   // streaming-only (sdk.d.ts:2327)
        this.currentModel = turn.model
      } catch {
        this.hardReset()
        this.finish(turn, { kind: "no-call" })
        return
      }
    }

    this.current = turn

    // Recycle FIRST and SEQUENCED. Recycle is the CALLER's decision so a
    // multi-prompt ACP session keeps its context.
    if (turn.recycle && !this.fresh) {
      const cleared = await this.awaitClear()
      if (turn.done) return                      // cancel/close raced us
      if (!cleared) {
        // Never derive on a possibly-half-cleared context. Destroying the
        // Query is the strictly safer failure: the next turn respawns, which
        // is a clean context by construction, and nothing was sent.
        this.hardReset()
        this.finish(turn, { kind: "no-call" })
        return
      }
    }
    this.fresh = false

    const feed = this.feed
    if (!feed) { this.finish(turn, { kind: "no-call" }); return }
    feed.push(userMsg(turn.text))
    turn.sent = true                             // THE send boundary crosses here

    // Timers start AFTER the push, so the generation budget measures
    // generation and the /clear has its own separate cap (§6e budget rule).
    turn.timer = setTimeout(() => {
      turn.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
    }, this.turnTimeoutMs)
    turn.hardTimer = setTimeout(() => {
      // interrupt() itself hung. Destroy the Query + subprocess so no
      // trailing message can ever reach the NEXT turn, then settle.
      const consumed = this.consumed(turn)
      this.hardReset()
      this.finish(turn, { kind: consumed ? "call-consumed" : "no-call" })
    }, this.turnTimeoutMs + this.hardGraceMs)

    await settled
  }
}
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts` — 0 fail (on this credentialed host, none skipped).
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Record in the SDD progress notes: (a) the measured first-record and steady-state per-record latency — §6e registered the 838 ms / ~20 ms figures as INDICATIVE and this is where they get their in-tree measurement; (b) the OBSERVED `messages[]` length and byte size of a post-`/clear` turn, which is the §6e residue's unmeasured shape. Once (b) is measured, tighten the `toBeLessThanOrEqual(2)` guard to the exact value in a follow-up commit.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/warm-session.ts cc-gate-plugin/test/warm-session.test.ts cc-gate-plugin/test/agent-cli-stub.ts cc-gate-plugin/test/gauge-agent-transport.test.ts
git commit -m "feat(gauge): WarmSession — persistent pump, sequenced /clear, three-way outcomes per 6e law"
```

### Task 5: `acp-paths.ts` + `acp-daemon.ts` — socket server, ACP dispatcher, idle self-exit

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-paths.ts`
- Create: `cc-gate-plugin/src/gauge/acp-daemon.ts`
- Test: `cc-gate-plugin/test/acp-paths.test.ts`, `cc-gate-plugin/test/acp-daemon.test.ts`

**Why a separate `acp-paths.ts`.** `acp-client.ts` (Task 6) needs `socketPath`/`ensureSocketDir`/`envFingerprint`, and `hook-cli.ts` imports `acp-client.ts` on SessionStart. If those helpers lived in `acp-daemon.ts`, the hook would transitively import the daemon module — and any top-level side effect there (a `net.createServer`, the reaper's `setInterval`) would run INSIDE the hook process, on the one code path whose prime directive is to never affect a session. `acp-daemon.ts` additionally guards all of its runtime behaviour behind `if (import.meta.main)`.

**Interfaces (`acp-paths.ts`):**
- `ACP_ENV_KEYS` — the enumerated §6e fingerprint subset, in order:
  `["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "KKAMAK_GAUGE_MODEL"]` by VALUE and
  `["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"]` by PRESENCE (`set`/`unset`).
- `envFingerprint(env: Record<string, string | undefined>): string` — first 12 hex of `sha256` over `k=v\n` lines in that fixed order. Secrets contribute presence only; the value never enters a filename, a log, or a frame.
- `socketPath(env): string` — `env.KKAMAK_ACP_SOCKET` when set; else on `win32` the named pipe `\\.\pipe\kkamak-acp-${os.userInfo().username}-${envFingerprint(env)}`; else `path.join(homedir(), ".config", "kkamak", "acp-${envFingerprint(env)}.sock")` — the repo's documented host-local store (CLAUDE.md). `~/.kkamak/` is NOT used: it does not exist and is not a repo convention. **The fingerprint in the filename is a convenience, not the guarantee**: `KKAMAK_ACP_SOCKET` bypasses it, so the binding check is the `initialize` echo (Task 6), which always runs.
- `spawnLockPath(env): string` / `bindLockPath(env): string` — `<socketPath>.spawn.lock` / `<socketPath>.bind.lock`. **Two distinct files, deliberately.** The client holds the SPAWN lock across "decide to spawn → daemon answers initialize"; the daemon holds the BIND lock across "probe → unlink → rebind". One shared file would deadlock: the client would still be holding it while the daemon it just started tried to take it to bind.
- `ensureSocketDir(p: string): void` — `mkdirSync(dirname(p), { recursive: true, mode: 0o700 })` before any `listen` or lock create. Without this the default path fails `ENOENT` on a fresh host. No-op for a named pipe.
- `ACP_LOCK_STALE_MS = 30_000`, plus `tryCreateLock` / `isLockStale` / `releaseLock` shaped EXACTLY on `corpus-store.ts:145-176` (`isLockStale` at `:149-158`, `acquireLock`'s unlink-then-one-retry at `:164-176`; the bare `wx` create helper is `tryCreateLock` at `:134-143`). Content `{ pid, ts }`; stale / vanished / torn all collapse to the same takeover path; losing the retry race is a refusal, never "overwrite and assume ownership".

**Interfaces (`acp-daemon.ts`):**
- Runnable ONLY under `import.meta.main`: `bun src/gauge/acp-daemon.ts` (socket mode, default) and `bun src/gauge/acp-daemon.ts --stdio` (same dispatcher bound to stdin/stdout, serving the SAME private instrument profile — see Task 2's scope note; NOT for off-the-shelf editors).
- Filesystem hygiene is platform-gated behind `isPipe = p.startsWith("\\\\.\\pipe\\")`: `chmod 0600` and stale-file takeover apply only to the Unix path (named pipes carry no file mode and vanish with their last handle). Current hosts are WSL2 and macOS — the Unix path is what Tasks 5-10 execute and test; the win32 branch is a compile-checked seam with a unit test on the path string only. Bun named-pipe status (researched 2026-08-04): `node:net` named pipes are SUPPORTED (Bun v1.1.28; name normalization fixed v1.1.35; oven-sh/bun#11820 closed), but the neighbouring `node:http` pipe-listen bug is still open (oven-sh/bun#24682) — we use raw `node:net` only, never `node:http`, and a first native-Windows host still runs one live round-trip verify.
- **The daemon's `WarmSession` is constructed with EXPLICIT budget arguments**, never defaults-by-omission:
  ```typescript
  const warm = new WarmSession(process.env, {
    turnTimeoutMs: Number(process.env.KKAMAK_ACP_TURN_TIMEOUT_MS) || ACP_BUDGET.turnTimeoutMs,
    queueWaitMs: ACP_BUDGET.queueWaitMs,
    clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
    hardGraceMs: ACP_BUDGET.hardGraceMs,
  })
  ```
  These are the numbers `ACP_BUDGET.daemonWorstCaseMs` sums, and the client's `daemonLegMs` is proven to exceed them by the Task 2 arithmetic test. `KKAMAK_ACP_TURN_TIMEOUT_MS` exists ONLY as a test seam; raising it in production without raising `daemonLegMs` re-opens the double-call hole §6e law L2 closes.
- **ACP behaviour:**
  - `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false }, _meta: { envFingerprint: envFingerprint(process.env) } }`.
  - `session/new` → mints a UUID sessionId and records it (cheap: no model work, no recycle — an abandoned `session/new` costs nothing). `params.cwd` is ACCEPTED AND IGNORED: the instrument pins a neutral `cwd` (§6e delta (b)). Stated here so it is a decision, not a silent divergence.
  - `session/prompt` → requires `params._meta.model` (a non-empty string); a missing/non-string model is an `ACP_ERR_NO_CALL` error (law L4 — nothing is pushed), never a silent substitution of the daemon's own env. Computes `recycle = (params.sessionId !== lastServedSessionId)` and calls `warm.oneShot(text, model, { recycle, tag: <this request's id> })`. **This is what keeps the ACP facade honest:** two prompts in the SAME session share context, while the deriver — which opens a fresh session per record — always gets a clean one.
    - `ok` → emit ONE `session/update` notification with the full text as an `agent_message_chunk`, then answer `{ stopReason: "end_turn", _meta: { model: <the PROVEN model from TurnOutcome.model>, callConsumed: true } }`.
    - `no-call` → JSON-RPC error `{ code: ACP_ERR_NO_CALL, message, data: { callConsumed: false } }`, no update.
    - `call-consumed` → JSON-RPC error `{ code: ACP_ERR_CALL_CONSUMED, message, data: { callConsumed: true } }`, no update.
    - `data.callConsumed` is ALWAYS set (law L3 makes it authoritative over the code).
  - `session/cancel` → `warm.cancel(<the tag of THIS sessionId's outstanding turn>)`; answers `{}`. **Never a bare `interrupt()`**: with one global FIFO across all connected callers, an unscoped interrupt would kill a DIFFERENT caller's in-flight turn — destroying their record and consuming their model call while telling them nothing. The daemon keeps `Map<sessionId, tag>` for outstanding turns and cancels only its own; a cancel naming an unknown/finished session is a no-op that still answers `{}`.
  - Unknown method → JSON-RPC `-32601`, connection stays open.
- Idle reaper: ticks at `Math.max(250, Math.min(60_000, idleMs / 3))` — a fixed 60 s tick could never observe a short `KKAMAK_ACP_IDLE_MS` (the test uses 1 500 ms), and would make the reaper untestable. On a tick where `warm.idleMs() > KKAMAK_ACP_IDLE_MS` AND `!warm.turnInFlight()` → **stop accepting new connections first**, then close open connections, then `warm.close()`, release the bind lock, unlink the socket, `process.exit(0)`. Unlinking before draining races a client that has already written a `session/prompt`.
- Lifecycle hygiene: `chmod 0600` after listen; `SIGTERM`/`SIGINT` → same drain-then-unlink-then-exit path.
- **Stale-socket takeover, race-free:** the whole probe→unlink→rebind sequence runs while holding the BIND lock (`<socket>.bind.lock`, `wx`-created, `corpus-store.ts:145-176` staleness rule, released after a successful `listen` and on every exit path). Sequence: `listen` → on `EADDRINUSE`, `net.connect` the path → answered ⇒ another daemon is live, release the lock and exit 0 quietly; `ECONNREFUSED`/`ENOENT` ⇒ unlink and ONE rebind attempt. Without the lock two starters can both see `ECONNREFUSED`, both unlink, and the loser's unlink removes the winner's LIVE path — leaving a listening-but-unreachable daemon and every caller silently falling back forever.
- Test seam: when `env.KKAMAK_ACP_TEST_SPAWN_LOG` is set, append one line (`pid` + ISO ts) to that file **AFTER a successful `listen` + `chmod`** — never at boot. A starter that loses the bind race and exits 0 writes NOTHING, so "exactly one line" means "exactly one daemon is serving", which is the property Tasks 6 and 8 actually want to assert and which holds even when two processes were launched.
- **One structural rule:** the dispatcher must never `throw` across a connection handler — every error path answers a JSON-RPC error frame. The daemon dying on a bad frame is a fail-open violation.

- [ ] **Step 1: Write the failing tests** (drive the real daemon as a child over a temp socket; SSE stub for the model side; credentials skip-guard on everything that reaches a model)

```typescript
// test/acp-paths.test.ts — no daemon, no CLI, no credentials needed.
import { describe, expect, test } from "bun:test"
import { envFingerprint, socketPath, spawnLockPath, bindLockPath, ACP_ENV_KEYS } from "../src/gauge/acp-paths.ts"

describe("acp-paths", () => {
  test("the fingerprint subset is exactly the five §6e keys", () => {
    expect(ACP_ENV_KEYS.value).toEqual(["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "KKAMAK_GAUGE_MODEL"])
    expect(ACP_ENV_KEYS.presence).toEqual(["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"])
  })
  test("a different base URL is a different instrument", () => {
    expect(envFingerprint({ ANTHROPIC_BASE_URL: "http://a" }))
      .not.toBe(envFingerprint({ ANTHROPIC_BASE_URL: "http://b" }))
  })
  test("secrets contribute PRESENCE only — the value never changes the fingerprint", () => {
    const a = envFingerprint({ ANTHROPIC_API_KEY: "sk-aaa" })
    const b = envFingerprint({ ANTHROPIC_API_KEY: "sk-bbb" })
    const none = envFingerprint({})
    expect(a).toBe(b)
    expect(a).not.toBe(none)
  })
  test("unrelated env keys do not change the fingerprint", () => {
    expect(envFingerprint({ PATH: "/x" })).toBe(envFingerprint({ PATH: "/y" }))
  })
  test("the default socket path carries the fingerprint; the override wins verbatim", () => {
    const p = socketPath({ ANTHROPIC_BASE_URL: "http://a" })
    expect(p).toContain(".config/kkamak/acp-")
    expect(p.endsWith(".sock")).toBe(true)
    expect(socketPath({ KKAMAK_ACP_SOCKET: "/tmp/x.sock" })).toBe("/tmp/x.sock")
  })
  test("the spawn lock and the bind lock are DIFFERENT files (they guard different critical sections)", () => {
    const env = { KKAMAK_ACP_SOCKET: "/tmp/x.sock" }
    expect(spawnLockPath(env)).not.toBe(bindLockPath(env))
  })
})
```

```typescript
// test/acp-daemon.test.ts
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText } from "./agent-cli-stub.ts"
import { ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED } from "../src/gauge/acp-wire.ts"

const DAEMON_TEST_TIMEOUT_MS = 40_000

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-daemon over unix socket", () => {
  test("initialize -> session/new -> session/prompt round-trip, fingerprint and model echoed", async () => {
    const sock = `${tmpdir()}/kkamak-acp-test-${process.pid}-${Date.now()}.sock`
    const child = spawnDaemon(sock, { ANTHROPIC_BASE_URL: stubUrl })
    try {
      const c = await connectNdjson(sock)          // helper: net.connect + FrameDecoder
      const init = await c.request("initialize", { protocolVersion: 1 })
      expect(init.protocolVersion).toBe(1)
      expect(typeof init._meta.envFingerprint).toBe("string")   // §6e fingerprint echo
      const s = await c.request("session/new", { cwd: process.cwd(), mcpServers: [] })
      expect(typeof s.sessionId).toBe("string")
      const updates: string[] = []
      c.onNotification("session/update", (p) => updates.push(p.update.content.text))
      const r = await c.request("session/prompt", {
        sessionId: s.sessionId,
        prompt: [{ type: "text", text: "classify me" }],
        _meta: { model: "claude-haiku-4-5" },
      })
      expect(r.stopReason).toBe("end_turn")
      expect(r._meta.model).toBe("claude-haiku-4-5")   // PROVEN from modelUsage, not echoed
      expect(r._meta.callConsumed).toBe(true)
      expect(updates.join("")).toContain("ANSWER")
    } finally { child.kill() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a second SESSION recycles (clean context); a second PROMPT in one session does not", async () => {
    // session/new + prompt, then session/new + prompt on the same daemon:
    // assert CAPTURED.length === 2 and the first prompt's marker ABSENT from
    // the second body (message COUNT is not asserted — §6e residue shape,
    // same reason as Task 4). Then a THIRD prompt reusing the SECOND
    // sessionId: assert the second prompt's marker IS present.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("missing _meta.model -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    // law L4: nothing was pushed. assert error.code === ACP_ERR_NO_CALL,
    // error.data.callConsumed === false, and the stub captured 0 requests.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a 500 -> ACP_ERR_CALL_CONSUMED with data.callConsumed true, no update", async () => {
    // law L6. stub: 500 then success. assert error.code === ACP_ERR_CALL_CONSUMED
    // AND error.data.callConsumed === true (L3's authoritative channel).
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel is SCOPED: cancelling session B never disturbs session A's in-flight turn", async () => {
    // two connections, two sessions; A's prompt hangs (silentServer), B
    // sends session/cancel for ITS OWN (queued) prompt. Assert B gets
    // ACP_ERR_NO_CALL and A still ends on its own turn timeout with
    // ACP_ERR_CALL_CONSUMED — never cancelled by B.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("unknown method -> -32601 and the connection survives", async () => {
    // assert the error code, then a following `initialize` still answers.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a malformed frame does not kill the daemon", async () => {
    // write "garbage\n", then a valid initialize on the SAME socket: answers.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("idle reaper drains, exits, and removes the socket", async () => {
    // spawn with KKAMAK_ACP_IDLE_MS=1500, do one prompt, wait ~4s:
    // child exited 0, fs.existsSync(sock) === false. This is why the reaper
    // ticks at min(60s, idleMs/3) rather than a fixed 60s.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("stale socket file is taken over under the BIND lock", async () => {
    // pre-create a dead socket file at the path, spawn daemon, initialize succeeds
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a LIVE socket is not taken over: the second starter exits 0, writes NO spawn-log line, and the first still answers", async () => {
    // this is the race the bind lock exists to prevent, and the reason the
    // spawn log is written post-listen rather than at boot.
  }, DAEMON_TEST_TIMEOUT_MS)
})
```
(The sketched bodies are written out in full by the implementer following the first test's helper pattern — same `spawnDaemon`/`connectNdjson` helpers, different assertions; the assertions named in the comments are the required ones.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/acp-paths.test.ts test/acp-daemon.test.ts`
Expected: FAIL — path helpers and daemon entry do not exist.

- [ ] **Step 3: Implement `acp-paths.ts` then `acp-daemon.ts`**

```typescript
// acp-paths.ts — endpoint + lock + fingerprint seam. Deliberately SEPARATE
// from acp-daemon.ts: acp-client.ts needs these, hook-cli.ts imports
// acp-client.ts on SessionStart, and the hook must never transitively pull
// in a module that can start a server.
import crypto from "node:crypto"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/** §6e instrument fingerprint subset. VALUE keys change the instrument;
 * PRESENCE keys are credentials whose value must never reach a filename,
 * a log, or a wire frame. */
export const ACP_ENV_KEYS = {
  value: ["ANTHROPIC_BASE_URL", "CLAUDE_CONFIG_DIR", "KKAMAK_GAUGE_MODEL"],
  presence: ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"],
} as const

export function envFingerprint(env: Record<string, string | undefined>): string {
  const lines: string[] = []
  for (const k of ACP_ENV_KEYS.value) lines.push(`${k}=${env[k] ?? ""}`)
  for (const k of ACP_ENV_KEYS.presence) lines.push(`${k}=${env[k] ? "set" : "unset"}`)
  return crypto.createHash("sha256").update(lines.join("\n") + "\n").digest("hex").slice(0, 12)
}

export function socketPath(env: Record<string, string | undefined>): string {
  if (env.KKAMAK_ACP_SOCKET) return env.KKAMAK_ACP_SOCKET
  const fp = envFingerprint(env)
  if (process.platform === "win32") return `\\\\.\\pipe\\kkamak-acp-${os.userInfo().username}-${fp}`
  return path.join(os.homedir(), ".config", "kkamak", `acp-${fp}.sock`)
}

/** TWO locks, deliberately. The CLIENT holds `.spawn.lock` from "decide to
 * spawn" until the daemon answers `initialize`; the DAEMON holds
 * `.bind.lock` across probe->unlink->rebind. One shared file deadlocks: the
 * client would still hold it while the daemon it started tried to bind. */
export function spawnLockPath(env: Record<string, string | undefined>): string {
  return `${socketPath(env)}.spawn.lock`
}
export function bindLockPath(env: Record<string, string | undefined>): string {
  return `${socketPath(env)}.bind.lock`
}

export function isPipe(p: string): boolean { return p.startsWith("\\\\.\\pipe\\") }

export function ensureSocketDir(p: string): void {
  if (isPipe(p)) return
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
}

/** Staleness discipline shaped EXACTLY on corpus-store.ts:145-176 —
 * `isLockStale` (:149-158) collapses stale/vanished/torn to one takeover
 * path, and `acquireLock` (:164-176) does unlink + ONE fresh `wx` retry,
 * treating a lost retry race as a refusal rather than an assumed ownership.
 * The bare `wx` create helper is corpus-store.ts:134-143. */
export const ACP_LOCK_STALE_MS = 30_000
export function tryCreateLock(lockPath: string): boolean { /* wx create {pid, ts} */ }
export function isLockStale(lockPath: string, now: number): boolean { /* per the rule above */ }
export function acquireAcpLock(lockPath: string, now: number): boolean { /* wx -> stale? -> unlink -> ONE retry */ }
export function releaseAcpLock(lockPath: string): void { /* unlink, ENOENT-tolerant, never throws */ }
```

```typescript
// acp-daemon.ts — §6e ACP daemon: one WarmSession behind the ACP wire
// subset, implementing the §6e wire-send boundary law.
//
// session/new is cheap (UUID mint) and its `cwd` is accepted-and-IGNORED
// (the instrument pins a neutral cwd, §6e delta (b)); the /clear recycle
// happens at a prompt whose sessionId differs from the last one served — so
// a multi-prompt ACP session keeps its context while the deriver (fresh
// session per record) always gets a clean one.
// One turn in flight globally (WarmSession FIFO).
// Failure is a JSON-RPC ERROR carrying data.callConsumed (law L3's
// authoritative channel), never a fake stopReason.
//
// EVERY runtime side effect below is behind `import.meta.main`. acp-client
// imports NOTHING from this file (see acp-paths.ts).
import net from "node:net"
import fs from "node:fs"
import os from "node:os"
import crypto from "node:crypto"
import { WarmSession, type TurnOutcome } from "./warm-session.ts"
import {
  socketPath, ensureSocketDir, bindLockPath, envFingerprint, isPipe,
  acquireAcpLock, releaseAcpLock,
} from "./acp-paths.ts"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET,
  ACP_INITIALIZE, ACP_SESSION_NEW, ACP_SESSION_PROMPT, ACP_SESSION_CANCEL, ACP_SESSION_UPDATE,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
} from "./acp-wire.ts"

// ... exported, side-effect-free: `createDispatcher(warm, env)` returning a
// per-connection handler (FrameDecoder in, encodeFrame out); sessions
// Map<string, { createdAt: number }>; `lastServedSessionId`; an
// outstanding Map<sessionId, tag> so session/cancel is SCOPED to its own
// session and can never interrupt another caller's turn;
// on session/prompt: validate params._meta.model is a non-empty string
// (else ACP_ERR_NO_CALL — law L4), recycle = sessionId !== lastServedSessionId,
// then map TurnOutcome -> result | ACP_ERR_NO_CALL | ACP_ERR_CALL_CONSUMED,
// always populating data.callConsumed.
//
// if (import.meta.main) { ... and ONLY here:
//   ensureSocketDir(p); acquireAcpLock(bindLockPath(env)); listen ->
//   on EADDRINUSE probe-then-(unlink + ONE rebind) or exit 0 quietly;
//   chmod 0600; releaseAcpLock; append the spawn-log line POST-LISTEN;
//   idle reaper setInterval(Math.max(250, Math.min(60_000, idleMs / 3)));
//   SIGTERM/SIGINT -> stop accepting, drain, warm.close(), unlink, exit 0. }
```

The implementer writes the full dispatcher (~200 lines) against the Task 2 types; every branch has a test from Step 1.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-paths.test.ts test/acp-daemon.test.ts` — 0 fail.
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Hygiene check: `ls ~/.config/kkamak/` — no `acp-*.sock` may exist (every test used a temp socket).
Import-purity check: `bun -e 'import("./cc-gate-plugin/src/gauge/acp-paths.ts").then(() => console.log("clean"))'` returns immediately and leaves no listening socket — proving the hook's import path cannot start a daemon.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-paths.ts cc-gate-plugin/src/gauge/acp-daemon.ts cc-gate-plugin/test/acp-paths.test.ts cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(gauge): ACP daemon — socket server, scoped cancel, fingerprint echo, idle self-exit"
```

### Task 6: `acp-client.ts` — connect-or-spawn, three-way outcome, shared outgoing text

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-client.ts`
- Modify: `cc-gate-plugin/src/gauge/agent-transport.ts` (EXPORT the existing `buildOutgoingText`, renamed `buildAgentOutgoingText` — no behaviour change, no new logic)
- Test: `cc-gate-plugin/test/acp-client.test.ts`

**Interfaces:**
- Consumes: `socketPath`, `ensureSocketDir`, `spawnLockPath`, `envFingerprint`, `acquireAcpLock`, `releaseAcpLock` (Task 5's `acp-paths.ts` — NOT `acp-daemon.ts`); wire pieces + error codes + `ACP_BUDGET` (Task 2); `buildAgentOutgoingText` (this task).
- Produces:
  ```typescript
  /** Mirrors WarmSession's TurnOutcome across the wire so §6e's law
   * survives the process boundary. */
  export type DaemonOutcome =
    | { kind: "ok"; text: string; model: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  /** One record through the daemon. Connect (never spawn) -> initialize
   * (+ fingerprint check) -> session/new -> session/prompt -> collect the
   * update -> close socket.
   *
   * §6e law, client side: `no-call` for EVERY failure that happens BEFORE
   * the session/prompt frame is fully written (L1: no socket, connect
   * refused, initialize/session-new failure, fingerprint mismatch, write
   * error). `call-consumed` for EVERY ambiguity after it (L2: budget
   * expiry, socket closed mid-turn, unparseable frame, unrecognized error
   * code). `error.data.callConsumed` is authoritative when present and
   * boolean; the numeric code is the fallback (L3). NEVER throws. */
  export function daemonCall(
    outgoingText: string,
    model: string,
    env: Record<string, string | undefined>,
    opts?: { budgetMs?: number },   // default ACP_BUDGET.daemonLegMs = 33_000
  ): Promise<DaemonOutcome>

  /** Ensure a daemon is reachable. `waitMs` DEFAULTS TO 0 = kick and return
   * false immediately (the SessionStart hook's mode). Otherwise poll-connect
   * up to waitMs. Returns true when a daemon answered `initialize` with a
   * MATCHING fingerprint. NEVER throws. The spawn is guarded by the CLIENT
   * lock (`<socket>.spawn.lock`, acp-paths.ts) — a DIFFERENT file from the
   * daemon's bind lock, so holding it while waiting for the daemon to answer
   * cannot deadlock the daemon's own bind sequence. */
  export function ensureDaemon(
    env: Record<string, string | undefined>,
    opts?: { waitMs?: number },     // default 0
  ): Promise<boolean>

  /** Re-exported from ACP_BUDGET so callers name one constant, not two. */
  export const DAEMON_LEG_MS = ACP_BUDGET.daemonLegMs
  ```
- **Spawn idiom (repo-established, `hook-cli.ts:149-153`):**
  ```typescript
  const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  ```
  Bun's `spawn` has no `detached` option and no string `stdio`; and without `nohup` the daemon dies with the hook process that started it.
- **`ensureDaemon`'s exact sequence** (the "exactly one daemon SERVING" property, given the post-listen spawn log from Task 5):
  1. probe: connect + `initialize`; fingerprint matches ⇒ return true.
  2. `acquireAcpLock(spawnLockPath(env))`. Held (fresh) ⇒ another caller is mid-spawn: skip to step 5.
  3. holding the lock, RE-probe (a winner may have finished between 1 and 2) ⇒ release + return true.
  4. spawn per the idiom above.
  5. if `waitMs === 0`: release the lock immediately and return false (kick-and-go). Else poll-connect until `waitMs`, then release the lock in a `finally` and return the probe result.
  Holding the client lock across step 5's wait is safe precisely because the daemon takes the *bind* lock, not this one. With `waitMs: 0` two racing callers can both spawn — but only one can BIND, the loser exits 0 quietly and writes no spawn-log line, so "exactly one daemon serving" and "exactly one spawn-log line" both hold.
- **Deliberate split:** `daemonCall` never spawns. Spawning is `ensureDaemon`'s job (SessionStart hook, Task 8; batch runs call it once up front with a real `waitMs`). A Stop-hook deriver whose daemon is missing gets `no-call`, falls back this record, and the next session's hook re-ensures — no derivation ever waits out a daemon boot.
- **Shared outgoing text (§6e "the two lanes must differ in transport only"):** `agent-transport.ts`'s private `buildOutgoingText` (`:85-88`) appends the trailing schema instruction that IS the agent lane's entire schema-enforcement mechanism (spec §6d, "Schema enforcement differs between the arms"). It is exported here as `buildAgentOutgoingText(messageText, schema)` so `callModelDerive` builds ONE string used byte-identically by `daemonCall` and `agentSdkCall`. `agentSdkCall` keeps calling it internally and is byte-unchanged for its existing callers.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { daemonCall, ensureDaemon, DAEMON_LEG_MS } from "../src/gauge/acp-client.ts"
import { buildAgentOutgoingText } from "../src/gauge/agent-transport.ts"
import { ACP_BUDGET, ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED } from "../src/gauge/acp-wire.ts"
import { envFingerprint } from "../src/gauge/acp-paths.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS } from "./agent-cli-stub.ts"

// These tests talk to SCRIPTED FAKE daemons (net.createServer answering
// canned frames) — no WarmSession, no CLI, no credentials, no model. They
// pin the CLIENT half of the wire contract independently of Task 5, so a
// Task 5 regression cannot mask a Task 6 one.
describe("acp-client (fake daemons only — no CLI, no model)", () => {
  test("law L1: no daemon at all -> no-call, fast", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", {
      ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock`,
    })
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test("round-trips against a scripted fake daemon -> ok, text, model", async () => {
    // fake answers initialize (with OUR fingerprint), session/new,
    // session/prompt (+ a session/update carrying the text)
    // -> { kind: "ok", text: "ANSWER", model: "claude-haiku-4-5" }
  })
  test("law L3: ACP_ERR_CALL_CONSUMED maps to call-consumed, NOT no-call", async () => {
    // fake answers session/prompt with that code + data.callConsumed true:
    // expect(r.kind).toBe("call-consumed")   // this is what stops a double call
  })
  test("law L3: ACP_ERR_NO_CALL maps to no-call", async () => {
    // + data.callConsumed false; expect(r.kind).toBe("no-call")
  })
  test("law L3: data.callConsumed OVERRIDES a mismatched code", async () => {
    // fake answers code ACP_ERR_NO_CALL but data.callConsumed === true:
    // expect(r.kind).toBe("call-consumed")   // the data field is authoritative
  })
  test("law L2: an UNRECOGNIZED error code after the prompt was sent is call-consumed", async () => {
    // fake answers session/prompt with code -32603 and NO data:
    // expect(r.kind).toBe("call-consumed")   // never no-call — that would double-spend
  })
  test("law L2: budget expiry after the prompt was sent is call-consumed", async () => {
    // fake accepts, answers initialize + session/new, then NEVER answers the
    // prompt; budgetMs 500 -> call-consumed, elapsed < 1.5s
  })
  test("law L1: a daemon that dies before session/prompt is written is no-call", async () => {
    // fake answers initialize + session/new then destroys the socket:
    // expect(r.kind).toBe("no-call")
  })
  test("law L1: a fingerprint mismatch refuses BEFORE sending anything", async () => {
    // fake echoes envFingerprint of a DIFFERENT env in initialize._meta:
    // expect(r.kind).toBe("no-call") and the fake saw NO session/prompt frame
  })
  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    // fake captures params: _meta.model === "claude-haiku-4-5",
    // prompt[0].text === the exact outgoing string passed in
  })
  test("the default budget is the contract constant, not a local literal", () => {
    expect(DAEMON_LEG_MS).toBe(ACP_BUDGET.daemonLegMs)
  })
  test("buildAgentOutgoingText is the SAME builder the one-shot lane uses", () => {
    const s = { type: "object" } as Record<string, unknown>
    expect(buildAgentOutgoingText("P", s)).toContain("Respond with ONLY a JSON object matching this schema")
    expect(buildAgentOutgoingText("P", undefined)).toBe("P")
  })
  test("ensureDaemon spawns exactly ONE serving daemon under concurrent callers", async () => {
    // two ensureDaemon(env, { waitMs: 5_000 }) racing on one socket path:
    // both resolve true, and KKAMAK_ACP_TEST_SPAWN_LOG has exactly ONE line
    // (the log is written POST-LISTEN, so a losing starter contributes none)
  }, 20_000)
  test("ensureDaemon() defaults to waitMs 0: returns false immediately and still kicks a spawn", async () => {
    // < 500ms, returns false, spawn log eventually gains a line
  }, 20_000)
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-client e2e (real daemon + SSE stub)", () => {
  test("ensureDaemon + daemonCall against the real daemon", async () => {
    // full path: ensureDaemon spawns real acp-daemon.ts (stub ANTHROPIC_BASE_URL),
    // daemonCall returns { kind:"ok" }; SIGTERM the daemon at the end and
    // assert the socket file is gone.
  }, 40_000)
})
```

- [ ] **Step 2: Run to verify they fail** — `bun test test/acp-client.test.ts`, FAIL on missing exports.

- [ ] **Step 3: Implement** (~180 lines: `net.connect` with its own `FrameDecoder`, request-id counter, pending-response map, notification handler collecting `session/update` text, ONE overall deadline; a single `sentPrompt` boolean that IS §6e's client-side send boundary — every failure path consults it and nothing else to choose between `no-call` and `call-consumed`; `error.data.callConsumed` checked before `error.code`; `ensureDaemon` per the exact sequence above). In `agent-transport.ts`, add `export` to `buildOutgoingText` and rename it `buildAgentOutgoingText` at its definition (`:85`) and its one internal call site (`:118`) — nothing else changes in that file.

- [ ] **Step 4: Run to verify green** — file suite, then full `bun test` 0 fail, `bunx tsc --noEmit` clean. Re-run `bun test test/gauge-agent-transport.test.ts` explicitly: the rename must leave every §6d assertion passing unmodified.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-client.ts cc-gate-plugin/src/gauge/agent-transport.ts cc-gate-plugin/test/acp-client.test.ts
git commit -m "feat(gauge): ACP client — send-boundary outcome mapping, fingerprint refusal, shared outgoing text"
```

### Task 7: Route the transport — selection, safe fallback, honest stamping

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (`selectTransport` allow-list + `callModelDerive`)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts` (`deriveRecord` stamps the actual lane AND the actual model)
- Test: `cc-gate-plugin/test/gauge-transport-daemon.test.ts` (new file)

**Interfaces:**
- Consumes: `daemonCall`, `DaemonOutcome`, `DAEMON_LEG_MS` (Task 6); `buildAgentOutgoingText` (Task 6); `ACP_BUDGET` (Task 2); `agentSdkCall`, `sdkCall`, `resolveModelId`, `DERIVATION_SCHEMA`, `buildRefinerPrompt` (existing).
- **`selectTransport` is currently a TERNARY, not an allow-list** (`transport.ts:44-46`: `return env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk" ? "agent-sdk" : "sdk"`). This task creates the allow-list:
  ```typescript
  export function selectTransport(env: Record<string, string | undefined>): GaugeTransport {
    const v = env.KKAMAK_GAUGE_TRANSPORT
    // Explicit allow-list, never a ternary chain: "cli" is retired and must
    // stay unselectable, and an unrecognized value must fall to the
    // incumbent rather than onto whichever literal a ternary happens to
    // leave in the else branch.
    return v === "agent-sdk" || v === "agent-sdk-daemon" ? v : "sdk"
  }
  ```
  The three existing `selectTransport` tests (`gauge-agent-transport.test.ts:53-65`) must pass UNMODIFIED.
- Produces:
  ```typescript
  /** Derive-path call that reports which lane actually ran AND on which
   * model. Existing `callModelSdk` keeps its signature and behaviour for
   * every other caller (refiner-cli.ts:55 until Task 10, and cls-ab's
   * cls-run, which is pinned to "sdk" by its own liveEnv strip at
   * cls-ab.ts:746). */
  export interface DeriveCallResult {
    raw: string
    transport: GaugeTransport
    /** The model the lane ACTUALLY ran on — the record stamps THIS, not the
     * caller's guess (§6e provenance rule). */
    model: string
  }
  export function callModelDerive(
    prompt: string,
    floorCheck: string,
    env: Record<string, string | undefined>,
    authDeps?: AuthTokenDeps,
    opts?: SdkCallOptions,
  ): Promise<DeriveCallResult | undefined>
  ```
  **Behaviour, exactly:**
  1. `model = resolveModelId(opts?.model ?? env.KKAMAK_GAUGE_MODEL ?? "haiku")`; `messageText = buildRefinerPrompt(prompt, floorCheck, opts?.promptVariant ?? "base")`.
  2. `selectTransport(env) !== "agent-sdk-daemon"` → today's behaviour byte-for-byte: `await callModelSdk(prompt, floorCheck, env, authDeps, opts)`, stamped with `selectTransport(env)` and `model`. No outgoing text is pre-built on this path — `callModelSdk` owns it, exactly as today.
  3. Daemon selected → build the shared text ONCE, then run the two legs inside one record budget:
     ```typescript
     const outgoing = buildAgentOutgoingText(
       messageText,
       DERIVATION_SCHEMA as unknown as Record<string, unknown>,   // same double cast as transport.ts:238/242
     )
     const started = Date.now()
     const d = await daemonCall(outgoing, model, env, { budgetMs: DAEMON_LEG_MS })
     if (d.kind === "ok") {
       // §6e provenance: a lane that silently changed the model must not
       // produce a stamped record. `d.model` is PROVEN daemon-side from the
       // result's modelUsage keys, so this comparison is real, not a
       // tautology against our own request.
       if (d.model !== model) return undefined
       return { raw: d.text, transport: "agent-sdk-daemon", model }
     }
     // §6e law: fallback ONLY on no-call. A `call-consumed` fallback would
     // be model call #2 for one record and would make `--go N` mean 2N.
     if (d.kind === "call-consumed") return undefined
     const remaining = ACP_BUDGET.recordBudgetMs - (Date.now() - started)
     if (remaining < ACP_BUDGET.minFallbackMs) return undefined
     const raw = await agentSdkCall(outgoing, model, env, { timeoutMs: remaining })
     return raw === undefined ? undefined : { raw, transport: "agent-sdk", model }
     ```
     `agentSdkCall` is called WITHOUT a schema because `outgoing` already carries the trailing schema instruction — `buildOutgoingText(messageText, undefined)` returns its input verbatim, so the fallback leg's bytes are identical to the daemon leg's.
- `deriveRecord` (`corpus-replay.ts:41-79`) switches from `callModelSdk` + two independent stamps to `callModelDerive`'s returned `transport` AND `model` — selection, stamp and model can no longer diverge (the §6d cls-ab lesson, now structural). `corpus-replay.ts:73`'s `model: resolveModelId(process.env.KKAMAK_GAUGE_MODEL ?? "haiku")` and `:75`'s `transport: selectTransport(process.env)` both become reads off the result. **`resolveModelId` and `selectTransport` then become unused in that file — remove them from the import at `corpus-replay.ts:26`** (leaving `callModelDerive`), and update the file-header comment at `:5-9` which currently names `callModelSdk` as the one shared transport.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { selectTransport, callModelDerive } from "../src/gauge/transport.ts"
import { deriveRecord } from "../src/gauge/corpus-replay.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText, silentServer } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

const CLI_TEST_TIMEOUT_MS = 90_000   // fallback tests spawn the bundled CLI

// selectTransport is pure — no CLI, no credentials, no timeout needed.
describe("selectTransport allow-list (§6e)", () => {
  test("accepts the new literal; defaults and the retired literal are unchanged", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe("agent-sdk-daemon")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "nonsense" })).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "cli" })).toBe("sdk")
  })
})

// The daemon-lane routing tests reach agentSdkCall on the fallback path,
// which spawns the REAL bundled CLI — so this block carries the credentials
// skip-guard AND an explicit per-test timeout. bun:test's 5s default is
// shorter than observed spawn latency, and a credential-less host must SKIP,
// not FAIL (gauge-agent-transport.test.ts:13-22).
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("agent-sdk-daemon routing (§6e)", () => {
  /** The env every routing test starts from. Both endpoints are stubbed, so
   * the suite still makes ZERO real model calls: ANTHROPIC_BASE_URL catches
   * the fallback lane's spawned CLI (SSE-shaped — a JSON-bodied stub would
   * silently double the observed call count), KKAMAK_GAUGE_SDK_BASE_URL
   * catches the direct API lane, and KKAMAK_ACP_SOCKET points at whichever
   * fake/dead socket the test wants. */
  function stubEnv(agentUrl: string, sdkUrl: string, sock: string) {
    return {
      ...process.env,
      KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon",
      ANTHROPIC_BASE_URL: agentUrl,
      KKAMAK_GAUGE_SDK_BASE_URL: sdkUrl,
      KKAMAK_GAUGE_AUTH_TOKEN: "tok-test",
      KKAMAK_ACP_SOCKET: sock,
    }
  }

  test("no-call fallback stamps agent-sdk, not agent-sdk-daemon", async () => {
    // deadSock (never created) -> law L1 no-call -> fallback runs
    const r = await callModelDerive("p", "check", stubEnv(agentStub.url, sdkStub.url, deadSock))
    expect(r?.transport).toBe("agent-sdk")
    expect(r?.model).toBe("claude-haiku-4-5")
  }, CLI_TEST_TIMEOUT_MS)

  test("call-consumed does NOT fall back — undefined, and the one-shot endpoint is never hit", async () => {
    // fake daemon answers ACP_ERR_CALL_CONSUMED; the agent stub counts requests
    const r = await callModelDerive("p", "check", stubEnv(agentStub.url, sdkStub.url, consumedSock))
    expect(r).toBeUndefined()
    expect(agentStub.captured.length).toBe(0)   // THE binding assertion: never a second call
  }, CLI_TEST_TIMEOUT_MS)

  test("daemon success stamps agent-sdk-daemon and carries the PROVEN model", async () => {
    const r = await callModelDerive("p", "check", stubEnv(agentStub.url, sdkStub.url, fakeSock))
    expect(r?.transport).toBe("agent-sdk-daemon")
    expect(r?.model).toBe("claude-haiku-4-5")
    expect(agentStub.captured.length).toBe(0)   // the daemon served it; no spawn
  }, CLI_TEST_TIMEOUT_MS)

  test("a daemon that reports a DIFFERENT model produces no record", async () => {
    // wrongModelSock's fake answers _meta.model "claude-opus-5" for a haiku
    // request. This is the branch a request-echo design could never test:
    // daemon-side the model is PROVEN from modelUsage, so it CAN diverge.
    const r = await callModelDerive("p", "check", stubEnv(agentStub.url, sdkStub.url, wrongModelSock))
    expect(r).toBeUndefined()
  }, CLI_TEST_TIMEOUT_MS)

  test("both agent legs receive byte-identical outgoing text", async () => {
    // run once against fakeSock (capturing prompt[0].text) and once against
    // deadSock (capturing the agent stub's messages[0].content); assert equal,
    // and that both contain the schema instruction.
  }, CLI_TEST_TIMEOUT_MS)

  test("total budget: a dead daemon + a never-answering one-shot stays within the record budget", async () => {
    // deadSock + silentServer() as ANTHROPIC_BASE_URL. The daemon leg fails
    // in ms, so the fallback gets ~60s: the honest bound is the record budget
    // PLUS the CLI's own spawn/abort overhead, not a bare < 60_000 knife edge.
    const t0 = Date.now()
    const r = await callModelDerive("p", "check", stubEnv(silent.url, sdkStub.url, deadSock))
    expect(r).toBeUndefined()
    expect(Date.now() - t0).toBeLessThan(ACP_BUDGET.recordBudgetMs + 5_000)
  }, CLI_TEST_TIMEOUT_MS)
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("deriveRecord stamps the lane and model that actually ran", () => {
  test("fake daemon -> derivation.transport agent-sdk-daemon", async () => { /* ... */ }, CLI_TEST_TIMEOUT_MS)
  test("dead socket -> derivation.transport agent-sdk (fallback)", async () => { /* ... */ }, CLI_TEST_TIMEOUT_MS)
})

// The default path touches no CLI, so it needs neither guard nor timeout —
// and it is the regression guard for corpus-replay.test.ts:86/:170.
test("default env -> derivation.transport sdk (unchanged)", async () => { /* ... */ })
```

- [ ] **Step 2: Run to verify they fail** — missing export.

- [ ] **Step 3: Implement.** ~70 lines in `transport.ts`, ~8 changed lines in `corpus-replay.ts` (including the import trim and the header comment). **The live-path pin tests (`gauge-refiner-cli.test.ts:56-86`, `:105`, `gauge-wiring.test.ts:102`) must stay green untouched** — `refiner-cli.ts:54` still strips the env var, so live derives keep running `"sdk"` regardless of this task.
Grep-verify: `grep -rn 'transport: selectTransport' cc-gate-plugin/src/` — currently TWO hits (`refiner-cli.ts:85`, `corpus-replay.ts:75`); expect exactly ONE afterwards (`refiner-cli.ts:85`, the live pin). `corpus-replay.ts:75` must no longer appear.

- [ ] **Step 4: Full suite green** — `bun test` 0 fail, `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts cc-gate-plugin/test/gauge-transport-daemon.test.ts
git commit -m "feat(gauge): route agent-sdk-daemon, fallback only on no-call, honest lane+model stamp"
```

### Task 8: SessionStart ensure-hook (through the existing dispatcher)

**Files:**
- Modify: `cc-gate-plugin/src/hook-cli.ts` (add `"SessionStart"` to `KNOWN_EVENTS` at line 36 + one early branch)
- Modify: `cc-gate-plugin/hooks/hooks.json` (add a SessionStart entry, `timeout: 30`)
- Test: `cc-gate-plugin/test/acp-ensure.test.ts`

**Why NOT a standalone CLI.** `test/packaging.test.ts:64-75` asserts that **every** hook command references `src/hook-cli.ts` and that the file exists; `:86-95` asserts every non-`Stop` entry has `timeout === 30`. A `hooks.json` entry pointing at `src/gauge/acp-ensure-cli.ts` turns that test red, which the Global Constraints forbid. Routing through the existing dispatcher keeps both assertions green, matches the shape of all three existing entries, and is F1-clean (`hook-cli.ts` is not a MECHANISM_PATH; the Phase-2 fixture harvest set the "hook-cli.ts wiring" precedent).

**Interfaces:**
- Consumes: `ensureDaemon` (Task 6).
- Produces: `bun "${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts" SessionStart` — fire-and-forget. The branch sits **before** `readGateConfigRaw`/`FileStateStore` (a daemon kick must not depend on gate config), runs only when `process.env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk-daemon"` (any other value = instant no-op), calls `await ensureDaemon(process.env, { waitMs: 0 })` inside a try/catch, and returns. Self-budget < 500 ms; the process always exits 0 via `hook-cli.ts`'s existing `.catch(...) → process.exit(0)` discipline (`:339-346`). SessionStart's CC payload carries `session_id` and `cwd`, so the dispatcher's existing string checks at `:116-117` pass unchanged.
- **No SessionEnd hook** — registered in §6e, not decided here: the daemon is HOST-GLOBAL, so tearing it down when one CC window closes would kill the warm session other windows and any running batch still need. The 15-minute idle self-exit owns shutdown and fires only when nothing is in flight.
- `ensureDaemon` is imported LAZILY inside the branch (`await import("./gauge/acp-client.ts")`) so the other three hook events pay nothing for it. `acp-client.ts` imports its path helpers from `acp-paths.ts`, never from `acp-daemon.ts`, so this import can never start a server inside the hook process (Task 5's import-purity check).

- [ ] **Step 1: Write the failing tests**

```typescript
const HOOK_CLI = path.join(pluginRoot, "src/hook-cli.ts")
const SESSION_START_STDIN = JSON.stringify({ session_id: "s1", cwd: process.cwd() })

/** Build a child env by explicit deletion — spreading `{...process.env,
 * K: undefined}` into Bun.spawn does NOT reliably drop the key, and an
 * inherited KKAMAK_GAUGE_TRANSPORT would make this test fork a REAL daemon
 * at the host's default socket. */
function envWithout(keys: string[], extra: Record<string, string> = {}): Record<string, string> {
  const e = { ...process.env } as Record<string, string>
  for (const k of keys) delete e[k]
  return { ...e, ...extra }
}

/** Poll a file for exactly `n` non-empty lines, up to `ms`. The spawn is
 * detached and asynchronous, so a bare read races it; the daemon writes its
 * line POST-LISTEN (Task 5), so "one line" means "one daemon serving". */
async function waitForLines(file: string, n: number, ms: number): Promise<string[]> { /* ... */ }

describe("SessionStart ensure-daemon hook", () => {
  test("no-op exit 0 when the transport is not the daemon lane", () => {
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout(["KKAMAK_GAUGE_TRANSPORT"], { KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(fs.existsSync(SPAWN_LOG)).toBe(false)   // nothing was spawned
  })
  test("exit 0 even when the socket dir is unwritable (fail-open)", () => {
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }),
    })
    expect(p.exitCode).toBe(0)
  })
  test("armed: exits 0 fast AND kicks exactly one serving daemon", async () => {
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)   // waitMs 0: kick and go
    // The name of this test is also its assertion: poll for the post-listen
    // line rather than asserting nothing, and prove no SECOND daemon bound.
    const lines = await waitForLines(SPAWN_LOG, 1, 15_000)
    expect(lines.length).toBe(1)
  }, 25_000)
})

test("packaging invariants still hold with the new entry", () => {
  const h = JSON.parse(fs.readFileSync(hooksJsonPath, "utf8"))
  expect(h.hooks.SessionStart).toBeDefined()
  for (const b of h.hooks.SessionStart) for (const e of b.hooks) {
    expect(e.command).toContain("src/hook-cli.ts")
    expect(e.timeout).toBe(30)
  }
})
```
Every test sets `KKAMAK_ACP_SOCKET` to a per-test temp path, and an `afterEach` kills anything listening there and removes the spawn log and both lock files — no test may ever touch `~/.config/kkamak/acp-*.sock`.

- [ ] **Step 2: Run to verify they fail** — `SessionStart` is not in `KNOWN_EVENTS` (`hook-cli.ts:36`), so the hook exits 0 silently at `:94`, the spawn-log poll times out, and the packaging assertion fails on a missing key.

- [ ] **Step 3: Implement** the `KNOWN_EVENTS` addition, the early branch, and the `hooks.json` entry:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts\" SessionStart", "timeout": 30 }] }]
```

- [ ] **Step 4: Full suite green** — `bun test` 0 fail (including `packaging.test.ts` UNMODIFIED), `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/hook-cli.ts cc-gate-plugin/hooks/hooks.json cc-gate-plugin/test/acp-ensure.test.ts
git commit -m "feat(gauge): SessionStart ensure-daemon via hook-cli dispatcher (opt-in, fail-open)"
```

### Task 9: Paired validation of the daemon lane (REAL SPEND — own sized go)

- [ ] **Step 1: Preserve the §6d arm BEFORE anything else.** `pv-sample --reset` `rmSync`s the shadow root (`paired-validation.ts:218`), and `.km/gauge-corpus-shadow/` currently holds the ONLY record-level `agent-sdk` derivations on this host (verified 2026-08-04: 10 records; zero `agent-sdk` records anywhere else). Copy it aside host-locally first:

```bash
cp -a .km/gauge-corpus-shadow /mnt/d/tmp/gauge-corpus-shadow-6d-$(date +%s)
```

This is the data §6e's falsification criterion reads (C-stratum only; the not-C stratum is an independent draw in each run and is not comparable). The committed `docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json` carries the per-key classes that travel.

- [ ] **Step 2: STOP and report before spending.** Run `bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk-daemon --reset` (token-free) and report: the printed sample size (expected 5 C + 5 not-C = 10, since the whole sdk-derived C stratum is 5 — measured 2026-08-04), the model (haiku unless overridden), that the shadow derive is real spend, and that §6e registers this bar as having no power to separate a small effect (5-record C stratum, cap 1, zero slack). **Do not proceed without an explicit sized go.**

  **Note the liveness gate is NOT here.** A daemon proved alive before a human stop-gate is stale by the time the go arrives: the idle reaper would have fired, record #1 would fall back to `"agent-sdk"`, `wrongTransport` would be non-zero, `evaluatePvBar` would return NOT-EVALUATED (`paired-validation.ts:473-481`), and the only recovery is a full `pv-sample --reset` plus a fresh 10-record spend on a new go. The proof therefore lives INSIDE the spend script (Step 3), moments before the first record.

- [ ] **Step 3: On a granted go, run ONE script — liveness proof and spend in the same process.**

```bash
set -e
export KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon
# §6e validation-run instrument parameter: keep the daemon alive across the
# whole batch. Registered pre-data; not a bar change.
export KKAMAK_ACP_IDLE_MS=3600000

# Token-free liveness gate, immediately before the spend. A `false` here
# exits non-zero and `set -e` stops the script BEFORE any model call.
bun -e 'import("./cc-gate-plugin/src/gauge/acp-client.ts").then(async (m) => {
  const up = await m.ensureDaemon(process.env, { waitMs: 10_000 })
  console.log("daemon ready:", up); process.exit(up ? 0 : 1)
})'

bun cc-gate-plugin/src/gauge/replay-cli.ts derive \
  /home/th-yoo/z2/meta-harness/.km/gauge-corpus-shadow --go 10
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk-daemon
```

There is NO subset re-derive: `runDerive` refuses unless `go === pending.length` (`corpus-replay.ts:151-157`) and a fallback-derived record is already stage `"derived"`.

- [ ] **Step 4: Sanity BEFORE reading the verdict:** `wrongTransport` must be 0. Non-zero means records fell back to `"agent-sdk"` (daemon died mid-batch) or the stamp plumbing broke, and `evaluatePvBar` returns NOT-EVALUATED. **Be honest about the cost:** there is no partial re-derive; recovery is a full `pv-sample --reset` and a fresh 10-record spend, which needs its own new go. Diagnose the cause (is the daemon process still alive? did the idle reaper fire despite `KKAMAK_ACP_IDLE_MS`? does the spawn log show a second daemon binding mid-batch?) before requesting it. This is why Task 7's stamp honesty is load-bearing: the partition SEES the fallback instead of silently absorbing it.

- [ ] **Step 5: Commit the counts** to `docs/gauge-pv/<hostname>-sdk-vs-agent-sdk-daemon-pv-counts.json` (F2: counts travel, prompts do not). `bun scripts/doc-check.ts` before the docs commit.

### Task 10: Verdict, and the live flip ONLY on a pass

> **OPEN QUESTION FOR THE USER, answer before Step 3 runs.** §6e registers
> that this bar has no statistical power: the whole `"sdk"`-derived class-C
> stratum on `yoo-dev` is 5 records, the missed-C cap is 1, and agreement
> ≥ 0.80 over a union of 5 means 4/5 — §6d already landed on both edges
> with zero slack. The flip is user-directed and reversible with one env
> var, so a PASS is sufficient under the rulings as given. **Do you want
> the live flip to additionally wait until the sdk-derived C stratum is
> materially larger (more live derivations accumulated), or to proceed on
> the 10-record result?** This is a question, not a bar change: the §6e bar
> constants are registered pre-data and are not being touched either way.

- [ ] **Step 1: Script-tally the verdict** (counts only, never quote notes): re-run `pv-compare --pair sdk:agent-sdk-daemon`, record agreement and missed-C against the §6e bar.

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6e, state that the daemon stays available with split readings and that live keeps `"sdk"`, STOP. Complete outcome.

- [ ] **Step 3: If the bar PASSES (and the OPEN QUESTION is answered "proceed") — flip the live pin, WITH the safe fallback.**
In `refiner-cli.ts`: replace the `liveEnv` strip (`:54`) with a `liveEnv` that FORCES `KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon"` (still never mutating `process.env`), call `callModelDerive`, and stamp `transport` AND `model` from its result (`:80`, `:85`). The Task 7 chain — daemon → (only on `no-call`) one-shot agent → undefined — IS the live behaviour, and `call-consumed` still means "no gauge file this turn", which is already an ordinary M0 miss on this path.

**Update these THREE pre-existing live-path assertions (declared exception #5) — a `toBe("sdk")` grep alone finds two of them, so use both patterns:**
`grep -rn 'transport).toBe("sdk")' cc-gate-plugin/test/` AND `grep -rn 'transport === "sdk"' cc-gate-plugin/test/`.
  1. `test/gauge-refiner-cli.test.ts:56-86` — the default-path E2E. It asserts `gauge.transport === "sdk"` (`:78`), `srv.captured.length === 1` (`:82`) and `body.output_config.format.type` (`:85`). Post-flip the live path no longer uses the API-SDK lane at all. Repoint it: force `KKAMAK_ACP_SOCKET` to a dead path so the record takes the `no-call` fallback, and assert `gauge.transport === "agent-sdk"`.
     **DELETE the `output_config` assertion outright — do NOT "move it onto a `KKAMAK_GAUGE_TRANSPORT=sdk`-pinned sibling".** Such a sibling is impossible by construction: item 2 below pins that the flipped `refiner-cli.ts` FORCES its own transport and is env-independent, so an env-pinned sibling would take the daemon lane too and never produce an `output_config` request. It is also unnecessary: the direct API-SDK lane's `output_config` shape already has dedicated, unaffected coverage at `test/gauge-transport.test.ts:163`, `:352`, `:369` and `:485`. Cite those lines in the deletion comment so a later reader sees coverage moved, not lost.
  2. `test/gauge-refiner-cli.test.ts:105` — the §6d PIN test. Its new invariant: live selection is `agent-sdk-daemon`, env-independent (an adversarial `KKAMAK_GAUGE_TRANSPORT=sdk` must NOT reroute it), and with a dead daemon socket the record is stamped `"agent-sdk"` (fallback proof, stub-only, no spend).
  3. `test/gauge-wiring.test.ts:102` — the hook→detached-refiner E2E. Same treatment as (1).
**Every one of these MUST set `KKAMAK_ACP_SOCKET` to a guaranteed-dead temp path.** Left unset they resolve to `~/.config/kkamak/acp-<fingerprint>.sock`, which the Task 8 hook makes likely to be LIVE on a dev host — the assertions would then flap between `agent-sdk` and `agent-sdk-daemon` depending on whether a daemon happened to be up.

Also: `test/corpus-replay.test.ts:86` (`expect(d.transport).toBe("sdk")`, a single-record assertion) and `:170` (`.every(...)`-shaped) both assert `"sdk"` on the DEFAULT env and are unaffected — `selectTransport({})` still returns `"sdk"`. Verify, do not edit.

Log the boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` in the flip commit, and note that `KKAMAK_GAUGE_TRANSPORT=sdk` does NOT roll this back (the live path forces its own value): the rollback is reverting the flip commit, and that must be written into the ledger row.

- [ ] **Step 4: Full suite green, commit:**

```bash
cd cc-gate-plugin && bun test && bunx tsc --noEmit
cd .. && bun scripts/doc-check.ts
git add cc-gate-plugin/src/gauge/refiner-cli.ts cc-gate-plugin/test/gauge-refiner-cli.test.ts cc-gate-plugin/test/gauge-wiring.test.ts docs/2026-08-01-gauntlet-adoption-ledger.md docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "feat(gauge): live derive flips to agent-sdk-daemon (6e bar pass, boundary ts logged)"
```

---

## Post-plan (recorded so the executor does not invent it)

1. **Branch + merge**: one branch `acp-warm-daemon`; per-task reviews; final fresh-context whole-branch review; merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md` carrying the 5 required fields (reviewed-range/reviewed-commit, reviewer, fresh-context, verdict ∈ approved|fix-first|blocked, findings-count). The 7b gate is ARMED — plain `git merge` bypasses the floor and this merge is a §6 ledger row.
2. **Ordering**: Task 1 must land before any code. Task 9's shadow-store preservation (Step 1) must land before any `pv-sample --reset`.
3. **Boundary ts obligations**: one when the first `agent-sdk-daemon` derive runs against a REAL store (§6d Deploy clause, batch opt-in), one at the live flip (§6e). They are separate rows.
4. **Not in scope**: `cls-ab.ts` and `channel-run.ts`. `cls-run` is pinned to `"sdk"` by its own `liveEnv` strip (`cls-ab.ts:746`) and stamps `ClsArmRow.transport: "sdk"` unconditionally; `channel-run.ts` calls `sdkCall` directly and is never env-routed. `callModelSdkLabel` (`transport.ts:256`) is deliberately not env-routed either. Neither is touched. `cls-ab.ts`'s `transportTally` miscount (`:375-383`) is re-recorded in §6e, not fixed here.
5. **Host-local artifacts that do NOT travel**: `~/.config/kkamak/acp-<fp>.sock`, its `.spawn.lock` / `.bind.lock`, `.km/gauge-corpus-shadow/`, the §6d shadow copy under `/mnt/d/tmp/`. Only `docs/gauge-pv/*.json` counts travel.

## Self-Review Notes (kept in-plan deliberately)

- **Type-consistency check, re-run after revision 2.**
  - T2 `acp-wire.ts` produces `ACP_BUDGET`, `ACP_ERR_NO_CALL`, `ACP_ERR_CALL_CONSUMED`, `FrameDecoder`, `encodeFrame`, the method constants, and the `Acp*` shapes → consumed by T4 (`ACP_BUDGET` only), T5 (all), T6 (all), T7 (`ACP_BUDGET`).
  - T3 `GAUGE_TRANSPORTS`/`GaugeTransport` → consumed by T7 (`selectTransport`'s return type, `DeriveCallResult.transport`) and T9 (`--pair` validation).
  - T4 `warm-session.ts` produces `TurnOutcome` (`ok`/`no-call`/`call-consumed`), `CancelResult`, and `WarmSession` with `oneShot(text, model, {recycle, tag?})` / `cancel(tag)` / `isWarm()` / `turnInFlight()` / `idleMs()` / `close()` → consumed by T5 only. T5's `session/cancel` uses `cancel(tag)`; T5's reaper uses `idleMs()` + `turnInFlight()`; T5's shutdown uses `close()`.
  - T5 `acp-paths.ts` produces `ACP_ENV_KEYS`, `envFingerprint`, `socketPath`, `spawnLockPath`, `bindLockPath`, `isPipe`, `ensureSocketDir`, `ACP_LOCK_STALE_MS`, `acquireAcpLock`, `releaseAcpLock` → consumed by `acp-daemon.ts` (bind lock) and T6 `acp-client.ts` (spawn lock, socket path, fingerprint). **`acp-client.ts` imports NOTHING from `acp-daemon.ts`** — that is the whole reason `acp-paths.ts` exists.
  - T6 produces `DaemonOutcome` (same three spellings as `TurnOutcome`), `daemonCall`, `ensureDaemon`, `DAEMON_LEG_MS` (= `ACP_BUDGET.daemonLegMs`), and `buildAgentOutgoingText` (from `agent-transport.ts`) → consumed by T7 (`daemonCall`, `DAEMON_LEG_MS`, `buildAgentOutgoingText`) and T8 (`ensureDaemon`) and T9 Step 3 (`ensureDaemon`).
  - T7 produces `DeriveCallResult`/`callModelDerive` → consumed by `corpus-replay.ts` (T7 itself) and by `refiner-cli.ts` in T10.
  - The three outcome kinds use identical spellings in T4's `TurnOutcome`, T2's two error codes, T6's `DaemonOutcome` and T7's branching. `model` means "the model PROVEN to have run" in T4's `TurnOutcome.ok`, T2's `AcpPromptResult._meta.model`, T6's `DaemonOutcome.ok`, and T7's comparison — never "the model requested" anywhere.
  - Budget names are single-sourced: no task defines a local `DAEMON_LEG_MS`, `turnTimeoutMs` or `recordBudgetMs` literal; every one reads `ACP_BUDGET`.
- **§6e's wire-send boundary law is the plan's structural core**, and it is stated exactly ONCE (Task 1) and referenced everywhere else. It is encoded in the wire (two codes + the authoritative `data.callConsumed`), implemented daemon-side by `WarmSession`'s `sent`/`sawModelActivity`/`sawApiResponse`/`connectionOnly` witnesses, mirrored client-side by `daemonCall`'s single `sentPrompt` boolean, and enforced by `callModelDerive` — with a test at each layer, including the one that asserts the one-shot endpoint receives ZERO requests after a `call-consumed`. The budget rule (`daemonLegMs > daemonWorstCaseMs`) is what stops the law's L2 branch from firing on ordinary slow turns, and it is locked as arithmetic in `acp-wire.test.ts`, not as prose.
- **The Task 4 skeleton is the design, not a sketch.** The persistent pump exists because `Query` is an AsyncGenerator whose `.return()` fires on any early loop exit. The pushable queue exists because a single re-armed resolver drops the second of two same-tick pushes. The TWO separate resolver slots (`notifyCaller` at enqueue, `settle` in `execute`) exist because one shared slot loses the queued caller's resolver and hangs that caller forever. `conversation_reset` sequencing exists because "/clear emits no result" was an indicative scratch observation and the SDK ships a typed signal instead. Settling only from a turn's own terminal `result` exists because settling at cancellation time hands the next turn a stale result. Every one of these is covered by a test a wrong implementation cannot pass.
- **`/clear`-makes-no-model-call is re-locked by request-count assertions rather than trusted; the `/clear` residue SHAPE is measured and recorded rather than asserted** (§6e registers ~423 B but never measured whether it is its own message). Every stub in this plan is SSE-shaped; a JSON-bodied stub silently doubles the observed call count. Never-answering stubs use raw `Bun.serve`, not a widened shared helper.
- **Architect review 1 (31 findings: 7 critical, 16 important, 8 minor) applied in full.** The load-bearing ones: the fail-open fallback could spend a second model call per record (now split zero-call vs consumed-call at every layer); §6e contradicted a registered user BINDING (now carries the verbatim 2026-08-04 supersession rulings); the SessionStart hook would have failed `packaging.test.ts:64` (now routed through `hook-cli.ts`); the `WarmSession` skeleton killed its own Query after one turn and dropped every second same-tick push; the daemon would have silently substituted its own model and env; the daemon lane would have sent a different prompt than the §6d-validated lane (shared builder now exported); and an interrupted turn returned truncated text as a derivation.
- **Architect review 2 (29 findings: 4 critical, 13 important, 12 minor) applied in full.** The load-bearing ones: (C1) `drain()` and `execute()` both wrote `turn.settle`, so every QUEUED caller's `oneShot()` promise was orphaned and the FIFO test would hang — now two write-once slots funnelled through `finish()`; (C2) the 20 s client leg was SHORTER than the 45 s daemon turn timeout, so an ordinary in-flight turn read as `no-call` and the fallback spent a second call — now one `ACP_BUDGET` object with `daemonLegMs > daemonWorstCaseMs` locked by arithmetic tests; (C3) `api_retry` was treated as model activity unconditionally, which contradicted §6e's own "connect failure = no-call" rule and its own test — now split on `error_status`, per sdk.d.ts:2839-2841; (C4) turns were settled at cancellation time while their terminal `result` was still in flight, poisoning the next turn — now settled only from their own `result`, with `/clear` sequenced on `SDKConversationResetMessage` (sdk.d.ts:3838-3846); (I5) the "model that ran" was the caller's own request echoed back, making the provenance check a tautology — now proven from `modelUsage` keys (sdk.d.ts:4312); (I6) one lock file guarded two different critical sections in two different processes — now `.spawn.lock` and `.bind.lock`; (I7) a fixed 60 s reaper tick could never satisfy its own 1.5 s idle test; (I8) Task 10's `output_config` remedy contradicted Task 10's own env-independence invariant and duplicated coverage that already exists at `gauge-transport.test.ts:163/352/369/485`; (I9) the sketched hanging stub did not type-check against `stubServer`'s synchronous handler; (I10) Task 7's CLI-spawning tests had neither skip-guard nor timeout and asserted a budget bound the design guarantees to exceed; (I11) a REQUIRED `_meta.model` is incompatible with the "standard editor clients" claim, now dropped in favour of an explicit private-profile scope; (I14) the daemon's `env` — a pinned isolation key — was whatever its spawner happened to have, now fingerprinted into the socket name and checked on `initialize`; (I15) the "exactly two declared exceptions" constraint omitted three real test-file edits; (I16) `session/cancel` interrupted whoever was in flight, including another caller's turn.

## Disposition of review-2 findings (traceability)

| # | Sev | Applied where |
|---|-----|---------------|
| C1 | Critical | T4 Turn `notifyCaller`+`settle`, `finish()` funnel, `drain()` resolves nobody; FIFO + queue-cap + close tests |
| C2 | Critical | `ACP_BUDGET` in T2 + arithmetic tests; T5 explicit daemon budgets; T7 remaining-budget math; §6e budget rule |
| C3 | Critical | §6e law L5/L6; T4 `sawApiResponse`/`connectionOnly` off `error_status`; two matching T4 tests |
| C4 | Critical | §6e law L7; T4 `doomed`, `sent` guard, `awaitClear()` on `conversation_reset`, hardTimer destroys the Query |
| I5 | Important | §6e "Which field proves the model"; T4 `observedModel` from `modelUsage`; T7 divergence branch + fake-daemon test |
| I6 | Important | `acp-paths.ts` `spawnLockPath`/`bindLockPath`; T5 bind sequence; T6 `ensureDaemon` 5-step sequence |
| I7 | Important | T5 reaper tick `max(250, min(60_000, idleMs/3))` |
| I8 | Important | T10 Step 3 item 1: delete the assertion, cite `gauge-transport.test.ts:163/352/369/485` |
| I9 | Important | `silentServer`/`hangFirstServer` on raw `Bun.serve` in `agent-cli-stub.ts`; `sdk-stub.ts` explicitly NOT widened |
| I10 | Important | T7 `describe.skipIf` + `CLI_TEST_TIMEOUT_MS` + `stubEnv()`; budget bound `recordBudgetMs + 5_000` |
| I11 | Important | T2 scope note (private instrument profile); T5 `session/new.cwd` accepted-and-ignored |
| I12 | Important | §6e law L3 (`data.callConsumed` authoritative) + L2 (unrecognized code ⇒ consumed); T6 tests for both |
| I13 | Important | T9 Step 3: liveness gate inside the spend script under `set -e`; `KKAMAK_ACP_IDLE_MS` override registered in §6e |
| I14 | Important | §6e "Instrument fingerprint"; `acp-paths.ts` `envFingerprint`; `initialize._meta`; T6 mismatch refusal |
| I15 | Important | Global Constraints: five numbered declared exceptions + the no-widening rule |
| I16 | Important | T5 `Map<sessionId, tag>`, `warm.cancel(tag)`; T4 `cancel()` scoping test; T5 cross-session cancel test |
| I17 | Important | T4 test 1: marker-absent binding assertion, `toBeLessThanOrEqual(2)` guard, count recorded in Step 4 |
| M18 | Minor | T2 "Why hand-rolled" rewritten to the lifecycle reason; SDK's generic `stream: Stream` acknowledged |
| M19 | Minor | T2 error-code note: reserved implementation-defined server-error band, plus a test asserting the band |
| M20 | Minor | Cites now `corpus-store.ts:145-176` (with `:134-143` for the bare `wx` helper) |
| M21 | Minor | T10: `:86` described as a single-record assertion, `:170` as `.every(...)`-shaped |
| M22 | Minor | "TWO declared deltas" in Global Constraints, §6e and the T4 header |
| M23 | Minor | `results` Map gone; single stub in T4 test 1; `withCaptureStub` not imported unused; `stream_event` branch removed with a reason |
| M24 | Minor | `acp-paths.ts` split out; `import.meta.main` guard stated; T5 Step 4 import-purity check |
| M25 | Minor | T7 `DERIVATION_SCHEMA as unknown as Record<string, unknown>`; `corpus-replay.ts:26` import trim + header comment |
| M26 | Minor | T8 armed test polls the post-listen spawn log and asserts exactly one line |
| M27 | Minor | T6 `ensureDaemon` `waitMs` default 0, stated in the signature comment and pinned by a test |
| M28 | Minor | §6e "The 'end' half of ruling 3, deliberately NOT implemented" |
| M29 | Minor | T4 `close()` settles current + every queued turn; dedicated test |
