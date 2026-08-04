# ACP Warm Daemon Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A host-global warm daemon holding ONE Agent-SDK streaming `Query`, exposed over the Agent Client Protocol (JSON-RPC) on a Unix socket, so every gauge derivation — live Stop-hook AND batch — pays ~20 ms of `/clear` recycling instead of ~1.25-1.46 s of CLI respawn.

**Architecture:** Three layers with the protocol as interface, not implementation: (1) `WarmSession` wraps the SDK streaming-input `Query` and owns the measured instrument invariants (isolation options, per-turn call accounting, caller-directed `/clear` recycling sequenced on the SDK's own `conversation_reset` message, `interrupt()` turn timeout); (2) `acp-daemon.ts` binds an ACP-conformant JSON-RPC dispatcher to a Unix socket with an idle self-exit; (3) `acp-client.ts` gives callers connect-or-spawn with a THREE-WAY outcome contract — `ok` / `no-call` / `call-consumed` — because a fail-open fallback is only safe when the daemon provably burned no model call. One classification law (§6e's **wire-send boundary law**) governs every layer. The live flip is gated exactly like §6d: registration first (§6e), paired validation on real spend (own sized go), flip with boundary ts only on a bar pass.

**Tech Stack:** Bun + TypeScript, `@anthropic-ai/claude-agent-sdk` (already a dependency; streaming-input mode), `node:net` Unix domain sockets, hand-rolled newline-delimited JSON-RPC 2.0 conformant to the ACP wire shapes (agentclientprotocol.com — no new runtime dependency; see Task 2 rationale).

> **SUPERSEDED IN PART (2026-08-04, same day).** The DAEMON SHAPE below is a
> singleton: one `WarmSession` shared by all ACP sessions, so sessions are a
> recycle key rather than a container. Per user directive, that shape is
> superseded by [2026-08-04-acp-session-pool.md](2026-08-04-acp-session-pool.md),
> which makes each session own its `WarmSession` and serves non-gauge callers
> (proposer, reviewer). Precisely which parts of THIS plan still stand:
> **Verbatim** — Tasks 1-3 (§6e registration, the wire subset + budget +
> `modelProvenBy`, the transport literal) and Tasks 8-10 (the ensure hook, the
> paired validation, the flip gate).
> **Verbatim PLUS a delta stated in the pool plan** — Task 4 (`WarmSession`
> gains ONE additive `isolation` parameter defaulting to the gauge set; pool
> plan Task S0, which requires every Task 4 test here to keep passing
> unmodified) and Task 7 (`callModelDerive` gains a gauge-eligibility refusal
> and reads `DaemonOutcome.profile`; pool plan Task S4).
> **Replaced** — Task 5's dispatcher and Task 6's client surface.
> Read the pool plan's §A and §B before implementing Tasks 4-7.

**RISK NOTE, READ BEFORE STARTING.** This plan's central mechanism — a `/clear` user message pushed into a **streaming-input** `Query` producing an `SDKConversationResetMessage` — has never been measured in this repo. The 2026-08-03 figures behind it came from a scratch probe that used neither this amendment's isolation option set nor streaming input. **Task 4 Step 1a is a token-free probe with an explicit STOP-and-report gate, and it is the FIRST thing implemented after Tasks 1-3.** If that probe fails, Tasks 4-10 do not proceed; the correct response is to stop and report, not to improvise a workaround. Step 1a ALSO records the terminal result's `modelUsage` keys, because the whole provenance chain turns on what those keys actually are (round-4 finding C1).

## Global Constraints

- **User-directed scope (2026-08-04).** This plan implements three verbatim user rulings quoted in full in Task 1's §6e text. They supersede §6d's "Selection is PER-CALLER" BINDING sentence and the 2026-08-03 "batch-only, live must not use it" agreed shape. They do NOT supersede the bar gate (no live flip without a §6e PASS) or the fail-open requirement. The 2026-08-04 "ask before ANY daemon implementation work" rule is SATISFIED: this plan is the user-initiated daemon work.
- **Isolation set is law, pinned server-side, never client-negotiable.** Byte-measured 2026-08-03, `agent-transport.ts:119-132`, TEN keys: `model`, `systemPrompt: ""`, `settingSources: []`, `settings: { autoMemoryEnabled: false }`, `persistSession: false`, `strictMcpConfig: true`, `tools: []`, `title: "kkamak-gauge"`, `thinking: { type: "disabled" }`, `env` (full replacement).
  **TWO declared deltas (do not paper over them):**
  1. **Removed:** the one-shot lane additionally sets `maxTurns: 1` and `abortController`. Both are QUERY-scoped and cannot transfer to a many-turn warm session — `maxTurns` (sdk.d.ts:1674-1678) would stop the whole `Query` after record #1, and aborting the shared controller would kill every future turn. They are replaced by (a) the per-turn model-call accounting rule in `WarmSession` and (b) `interrupt()` as the per-turn cancel.
  2. **Added:** an explicit neutral `cwd` (`os.tmpdir()` unless overridden) so the daemon's context does not depend on which session happened to spawn it. §6d measured a neutral `cwd` as PAYLOAD-NEUTRAL (spec table line 690: "no further change") and `agent-transport.ts:41-44` therefore omits it as redundant/dead configuration for a one-shot. For a host-global daemon it is not redundant — it is the difference between a fixed instrument and one that varies with its spawner.
  Both deltas are registered in §6e; this is NOT "the §6d set verbatim" and the plan never claims so.
- **Env is part of the instrument, and the daemon proves which env it has — over the WHOLE env, not a five-key sample.** `env` is one of the ten pinned keys and a daemon freezes it at spawn time. The instrument fingerprint therefore hashes the FULL environment minus a short, documented denylist of provably-volatile-or-non-instrument keys, and is echoed by `initialize`; a client whose fingerprint differs refuses (`no-call`) rather than deriving through a daemon configured differently. An enumerated five-key subset was rejected during review: it would leave `ANTHROPIC_MODEL`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY`, `ANTHROPIC_SMALL_FAST_MODEL` and every `CLAUDE_CODE_*` toggle free to change the instrument without changing the fingerprint. **Round-4 correction (I4):** `KKAMAK_GAUGE_TRANSPORT` (lane SELECTION) and `KKAMAK_ACP_SOCKET` (ENDPOINT ADDRESS) are also denylisted — neither can change a single byte the daemon sends to the model, and leaving `KKAMAK_GAUGE_TRANSPORT` in the hash makes the post-flip live path (which FORCES the value into a derived env) permanently unable to match a daemon started from an ambient env that does not carry it. See §6e "Instrument fingerprint" and Task 5.
- **Exactly one model call per record (§4, binding) — and the fallback must not break it.** `/clear` makes no model call (indicative 2026-08-03; re-locked by request-count assertions in Task 4). Every daemon turn resolves as `ok`, `no-call`, or `call-consumed` per the **§6e wire-send boundary law** (Task 1, stated ONCE and referenced by Tasks 2/4/5/6/7). **Fallback to the one-shot lane is permitted ONLY on `no-call`, and `no-call` means the prompt bytes were never pushed — there is no post-send exception on either side of the wire.** On `call-consumed` the deriver returns `undefined` and the record stays pending/retryable; a second lane call would make `--go N` mean up to `2N` calls.
- **Live derive path stays pinned to `"sdk"`** (test-locked, `test/gauge-refiner-cli.test.ts:105`, and asserted again at `:56-86` and `test/gauge-wiring.test.ts:102`) through Tasks 1-9. Only Task 10, after a §6e bar PASS and on its own go, may touch the pin.
- **The live derive lane and the SessionStart ensure gate are ONE predicate, never two (round-4 C2).** `liveDerivesOnDaemon(env)` is exported from `transport.ts` (Task 8) and read by BOTH `hook-cli.ts`'s SessionStart branch (whether to ensure a daemon) and, post-flip, `refiner-cli.ts` (which lane to force). The Task 10 flip changes that ONE function body and nothing else about lane selection, so the flip commit cannot ship a live path on the daemon lane with an ensure-hook that never fires. Without this, the flip is a pure regression: every live derive would find no daemon, take the `no-call` fallback, and pay the full ~1.25-1.46 s CLI spawn per Stop hook — strictly worse than today's ~5 ms direct API call — while stamping `"agent-sdk"`, a lane §6e never validated.
- **Fail-open everywhere**: daemon absent/slow/dead → the caller degrades within ONE wall-clock budget (below); the SessionStart hook always exits 0. Fail-open never means fail-open-into-double-spend: an ambiguity after the prompt frame was sent is `call-consumed`, not `no-call`.
- **One budget, not two, and the arithmetic is locked by a test.** `callModelDerive` owns a single 60 s wall-clock budget per record (the incumbent `CALL_TIMEOUT_MS`). All timing constants live in ONE exported object, `ACP_BUDGET` in `acp-wire.ts` (Task 2), because the client leg MUST exceed the daemon's worst case or a client timeout would misclassify a turn the daemon is still legitimately running:

  | constant | ms | owner | meaning |
  |---|---|---|---|
  | `queueWaitMs` | 6 000 | daemon | a turn still in the FIFO queue at this point is dropped, provably unsent |
  | `clearTimeoutMs` | 4 000 | daemon | `/clear` must be confirmed by `conversation_reset` within this |
  | `setModelMs` | 2 000 | daemon | `setModel()` is an un-timed SDK control round-trip; capped so a wedged subprocess cannot hang the FIFO forever |
  | `turnTimeoutMs` | 16 000 | daemon | generation budget, measured from the prompt push; MUST exceed the measured CLI spawn (below) |
  | `hardGraceMs` | 4 000 | daemon | extra grace before destroying the `Query` if `interrupt()` hangs |
  | `daemonWorstCaseMs` | 32 000 | derived | = 6 000 + 4 000 + 2 000 + 16 000 + 4 000 |
  | `daemonLegMs` | 36 000 | client | MUST be > `daemonWorstCaseMs`; the 4 000 ms of slack is the client's connect + `initialize` + `session/new` preamble, which the daemon's clock does not cover |
  | `minFallbackMs` | 10 000 | client | below this remaining, do not start a fallback at all |
  | `recordBudgetMs` | 60 000 | client | today's `CALL_TIMEOUT_MS`; per-record latency never exceeds it |

  Locked by `acp-wire.test.ts`: the five daemon legs sum to `daemonWorstCaseMs`, `daemonLegMs > daemonWorstCaseMs`, and `daemonLegMs + minFallbackMs <= recordBudgetMs`.
  **Honesty note (round-4 M4).** `daemonWorstCaseMs` does NOT include `await import("@anthropic-ai/claude-agent-sdk")` inside `ensure()` (~84 ms measured, `agent-transport.ts:102-108`), which is uncapped. The daemon's true worst case is `daemonWorstCaseMs + import`. That is left outside the sum deliberately: an import slow enough to eat the 4 000 ms of client slack trips law L2, which is `call-consumed` — a lost, retryable record, never a second model call. The budget rule's safety property (no double spend) holds; the "never exceeds" claim is about the client's own leg, not about a pathological module load.
- **A turn's timeout MUST exceed the CLI spawn — one constraint, stated once, applied to every test (round-4 C3/I10).** `WarmSession` arms a turn's timers at the PUSH, while the CLI subprocess is still coming up; §6d measured that spawn at **1.25-1.46 s** per record. Therefore **no `WarmSession` construction, in production or in any test, may use a `turnTimeoutMs` below `CLI_SPAWN_BUDGET_MS = 8_000`** (the measured spawn plus ~5.5x headroom for a loaded host). `ACP_BUDGET.turnTimeoutMs` (16 000) satisfies it. Every test in Task 4 that overrides `turnTimeoutMs` uses 8 000 and re-derives its expected wall clock from it; `hardGraceMs` may be tiny (it measures only how long `interrupt()` is given), and `queueWaitMs` may be tiny (it measures queue residency, not generation). A test that sets `turnTimeoutMs: 1_000` cannot distinguish "the implementation is wrong" from "the subprocess had not booted yet" — that is a broken instrument, not a strict test.
- **F1/F2**: all new source under `cc-gate-plugin/src/gauge/`, plus `cc-gate-plugin/src/types.ts` (one literal-list widening, Task 3), `hooks/hooks.json`, and a `SessionStart` branch in `src/hook-cli.ts` — all outside every MECHANISM_PATH (`km-crank/src/calibration.ts:65-72` = `minimal/{complete-gate,mutate,spec-probe,session2}.ts`, `cc-gate-plugin/src/core`, `cc-gate-plugin/vendor`); the `hook-cli.ts` wiring precedent is Phase-2 fixture harvest. Socket/lock/runtime state under `~/.config/kkamak/` — the repo's documented host-local store (CLAUDE.md; `~/.kkamak/` does NOT exist and is not a repo convention). Counts travel, prompts do not.
- **Pre-existing test files: FIVE DECLARED EXCEPTIONS, and no others.** Every other pre-existing test must pass byte-unmodified.
  1. `test/gauge-agent-transport.test.ts:49` — `expect(GAUGE_TRANSPORTS).toEqual(["cli","sdk","agent-sdk"])` → four literals (Task 3). *Assertion REPLACED in place, not duplicated.*
  2. `test/gauge-agent-transport.test.ts` — APPEND one new test: the §6e literal is a member of the `GaugeTransport` union and sorts LAST (Task 3 Step 1, written out in full there). *No existing assertion touched.*
  3. `test/paired-validation.test.ts` — APPEND two new tests (Task 3). *No existing assertion touched.*
  4. `test/gauge-agent-transport.test.ts:2-5`, `:23-45`, `:92-103`, `:116-145` — MOVE `hasClaudeCodeCredentials`/`HAS_CLAUDE_CODE_CREDENTIALS`/`NO_CREDENTIALS_SKIP_REASON`, `sseText`, `withCaptureStub` into `test/agent-cli-stub.ts`, re-import them, AND delete the four imports (`fs`, `os`, `path`, `execFileSync`) that become dead once `hasClaudeCodeCredentials` leaves the file — they have no other use in it (Task 4 Step 0). **`sseText` additionally gains ONE optional parameter, `model`, defaulting to the incumbent literal `"claude-haiku-4-5"`** — round-4 C1 needs a stub that declares a DATED model id, and every existing call site is byte-unchanged by an optional trailing parameter with the incumbent default. *No assertion changes; `bun test` 0-fail before and after.*
  5. Task 10 ONLY, and only on an earned bar pass — the live flip changes what `refiner-cli.ts` DOES, so it necessarily changes every test that runs `refiner-cli.ts`. The complete, enumerated list (Task 10 Step 3 walks each one):
     - `test/gauge-refiner-cli.test.ts` — the shared `runRefinerCli` helper (`:31-49`) gains two injected env vars, and SIX tests are affected: `:56-86` (assertion change **plus** the `srv.captured[0]!` reads at `:83-84`, which the flip empties — round-4 I5), `:105` (assertion change **plus** the `sdkSrv.captured[0]!` read at `:133`, same reason), `:138`, `:159`, `:178`, `:203` (stub-shape + guard changes only, assertions preserved). `:217` ("missing req file") is unaffected — it never reaches a transport.
     - `test/gauge-wiring.test.ts:84-109` — one assertion change, a stub-shape + guard change, **and a raise of `waitFor`'s 5 000 ms default deadline (`:75-82`)**, which now has to cover a detached refiner paying a full CLI spawn (round-4 I5).
     - `test/acp-ensure.test.ts` — created BY this plan (Task 8), so not a pre-existing file and not an exception; but the flip inverts its first test's meaning (the daemon lane stops being opt-in), and Task 10 Step 3 updates it in the same commit. Recorded here so it is not forgotten.
  6. `test/warm-session.test.ts` — APPEND ONLY, and ONLY when the ACP session
     pool is being built: pool plan Task S0 parameterises `WarmSession`'s
     isolation set and appends assertions that `GAUGE_ISOLATION` is the §6d
     set field-for-field, that omitting the parameter changes nothing, and
     that a custom `systemPrompt` reaches the wire. *No existing assertion in
     that file may change* — the whole point of S0 is proving the gauge lane
     did not move. Declared here rather than in the pool plan because THIS
     list is the one an implementer of this plan reads, and a second document
     cannot grant itself an exception to it.
     Anything beyond this list means the change is wrong — fix the change, not the test.

  **`test/sdk-stub.ts` is NOT widened.** Its handler type is `(captured: Captured) => Response` (`test/sdk-stub.ts:19`) — synchronous, no promise. Every never-answering stub in this plan uses raw `Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) })`, the established precedent at `gauge-agent-transport.test.ts:252`.
- **ZERO REAL MODEL CALLS, whole plan, no exceptions — including Task 10.** Every test that can reach a model endpoint must have BOTH endpoints stubbed: `KKAMAK_GAUGE_SDK_BASE_URL` for the direct API-SDK lane and `ANTHROPIC_BASE_URL` (SSE-shaped) for any lane that spawns the bundled CLI. This is not a Tasks-1-8 rule: the Task 10 flip moves the live path onto the CLI-spawning lane, so tests that were hermetic through an API-SDK stub stop being hermetic at that commit unless they are updated in the same commit. A test that would issue a real call is a stop-and-fix, never a "just this once".
- `cd cc-gate-plugin && bun test` → 0 fail and `bunx tsc --noEmit` clean at every task's end. `bun scripts/doc-check.ts` before every docs commit.
- TDD per task. Tests that spawn the bundled CLI use the existing `hasClaudeCodeCredentials()` skip-guard AND an explicit per-test timeout (`CLI_TEST_TIMEOUT_MS`) — bun:test's 5 s default is shorter than observed spawn latency, and a credential-less host must SKIP, not FAIL (`gauge-agent-transport.test.ts:13-22`). A test that only exercises the WIRE (fake daemons, path helpers, JSON-RPC framing) must NOT carry the credentials guard: over-skipping loses real coverage on a credential-less host (round-4 M6).
- **The hook's import path stays cheap.** `hook-cli.ts:24` imports `transport.ts` EAGERLY on every hook event, so `transport.ts` must NOT gain a top-level `import` of `acp-client.ts`: `daemonCall` is loaded with `await import("./acp-client.ts")` inside `callModelDerive`'s daemon branch only, exactly as `agent-transport.ts:102-108` lazy-loads the SDK for its measured ~84 ms. Timing constants and the model-proof predicate come from `acp-wire.ts` (a constants-only module whose sole import is `node:string_decoder`) and may be imported normally.
- Env vars introduced here: `KKAMAK_ACP_SOCKET` (override socket path; default `~/.config/kkamak/acp-<envFingerprint>.sock`), `KKAMAK_ACP_IDLE_MS` (default `900000`), `KKAMAK_ACP_TEST_SPAWN_LOG` (test seam), `KKAMAK_ACP_TURN_TIMEOUT_MS` (test seam), `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` (selects the lane).
- **Merge discipline (7b is ARMED):** one branch, per-task reviews, whole-branch fresh-context review, merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md`. See Post-plan.

---

### Task 1: Register §6e (pre-data) — the daemon lane, the classification law, the residue, the supersession, and the flip gate

**Files:**
- Modify: `docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md`

**Interfaces:**
- Produces: the registered literal `"agent-sdk-daemon"`, the wire-send boundary law, the instrument fingerprint, the model-proof rule, the bar, and the flip rule that Tasks 3-10 implement. Registration precedes build (spec-is-law).

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
reader sees a decision, not an omission. The same reasoning binds
OPERATIONS: no procedure in this amendment or its plan may terminate
daemons by pattern-matching the process table (`pkill -f acp-daemon`),
because that is the host-wide teardown this paragraph rejects. A run that
starts a daemon terminates THAT daemon, by the pid it recorded.

**What changes.** A fourth derive transport literal, `transport:
"agent-sdk-daemon"`: the same Agent-SDK lane §6d validated, but through a
host-global warm daemon (one streaming CLI session, `/clear` between
records) speaking the Agent Client Protocol over a Unix socket. Selected
per process by `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon`; absent or any
other value keeps the current behaviour byte-for-byte.

**Why, and what is still UNMEASURED.** §6d measured the one-shot agent
lane at +1.25-1.46 s subprocess spawn per record (~25% end-to-end). The
daemon amortizes that to one spawn per warm period. Indicative
measurement 2026-08-03 (recorded in `docs/resume.md`, scratch probe, NO
in-tree artifact): first record 838 ms then ~20 ms per record, `/clear`
handled CLI-side with no model call. Those numbers were NOT taken with
this amendment's isolation option set and NOT taken through a
streaming-input `Query` — the mode this lane requires. Whether a `/clear`
user message pushed into a streaming input stream is processed as a slash
command at all is therefore an OPEN QUESTION at registration time, gated
by a token-free probe before any of this lane is built. If the probe
fails, this amendment records a design that was not realizable and the
lane is not built; that is a complete outcome, not a failure to hide.

**Declared residue, and an open disagreement inside this spec.** Each
post-`/clear` turn is believed to carry ~423 B of constant
`<local-command-caveat>`/`<command-name>/clear</command-name>` echo. §6d's
PER-CALLER ruling above (the paragraph beginning "Routing it through
`agent-sdk` anyway") attributes that SAME ~423 B to the ONE-SHOT lane, on
every Stop hook. Both cannot be describing distinct facts: either the echo
is present in both lanes (in which case it cannot distinguish them) or
§6d's sentence is wrong about the one-shot lane. This is registered as an
OPEN DISCREPANCY rather than resolved by argument. It is resolved by
measurement: the plan's Task 4 records the request bytes of a post-`/clear`
warm turn AND of a fresh-spawn one-shot turn under the same option set, and
whichever of the two statements is wrong is corrected in the same commit
that records the measurement. Note that the separate §6e bar does not
depend on the outcome: a many-turn session that has served other prompts
is a different context from a fresh spawn whether or not the echo
distinguishes them, and that alone is why this literal gets its own bar
rather than inheriting §6d's result.

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
flight at a time (FIFO across all connected callers). A turn's generation
budget is measured from the PUSH while the CLI subprocess is still
starting, so that budget must always exceed the measured 1.25-1.46 s
spawn; the registered value is 16 s and no configuration, including a test
seam, may set it below 8 s.

**Instrument fingerprint (binding).** A daemon freezes its subprocess `env`
— one of the ten pinned isolation keys — at spawn time, so "which env"
would otherwise depend on which process happened to start it (a wrapper
exporting `ANTHROPIC_BASE_URL` would silently redirect every derivation).
The fingerprint therefore covers the WHOLE environment, minus an
enumerated denylist of keys that provably cannot change the instrument:

  `_`, `PWD`, `OLDPWD`, `SHLVL`, `RANDOM`, `LINES`, `COLUMNS`,
  `WINDOWID`, `TERM_SESSION_ID`, `ITERM_SESSION_ID`, `TMUX`,
  `TMUX_PANE`, `STY`, `SSH_AUTH_SOCK`, `SSH_AGENT_PID`,
  `SSH_CLIENT`, `SSH_CONNECTION`, `SSH_TTY`, `XDG_SESSION_ID`,
  `DBUS_SESSION_BUS_ADDRESS`, `KKAMAK_ACP_IDLE_MS`,
  `KKAMAK_ACP_TEST_SPAWN_LOG`, `KKAMAK_GAUGE_TRANSPORT`,
  `KKAMAK_ACP_SOCKET`

The denylist has two classes and both are stated so a later reader does
not "tidy" one into the other:
  · PER-PROCESS VOLATILE — the shell/terminal/ssh/tmux group above.
  · NOT AN INSTRUMENT PARAMETER — `KKAMAK_ACP_IDLE_MS` and
    `KKAMAK_ACP_TEST_SPAWN_LOG` are daemon OPERATING parameters;
    `KKAMAK_ACP_SOCKET` is an ENDPOINT ADDRESS; and
    `KKAMAK_GAUGE_TRANSPORT` is a LANE SELECTION. None of the four can
    change a single byte the daemon sends to the model. Denylisting
    `KKAMAK_GAUGE_TRANSPORT` is load-bearing rather than cosmetic: after
    the live flip the derive path FORCES that value into a derived env
    while the process that started the daemon carries whatever the user's
    shell had, so keeping it in the hash would make a client and its own
    daemon permanently unable to match. Denylisting `KKAMAK_ACP_SOCKET` is
    load-bearing for the same reason in tests and in any run that binds a
    dedicated socket.

`KKAMAK_ACP_TURN_TIMEOUT_MS` is RULED IN (not denylisted), deliberately:
it changes when a generation is cut off, which changes which turns produce
a derivation, which is an instrument property. A daemon running a
different turn budget is a different instrument and must not be adopted by
a client expecting the registered one.

Secrets never appear in a filename, a log, or a wire frame: any key whose
name matches `/(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` contributes
`NAME=set`/`NAME=unset` rather than its value. Everything else
contributes `NAME=value`. Keys are sorted by name; `envFingerprint` =
first 12 hex chars of sha256 over the `k=v\n` lines. It is baked into the
DEFAULT socket filename (`~/.config/kkamak/acp-<fp>.sock`) and echoed in
`initialize`'s result; a client whose own fingerprint differs REFUSES the
daemon and reports `no-call` (a pre-send condition — the fallback is
safe).

RESIDUAL, stated honestly and with the RIGHT failure mode: a whole-env
hash is sensitive to benign differences (a shell that exports one extra
variable produces a different fingerprint). For a process that can SPAWN —
`ensureDaemon` — that costs one extra daemon, which is the safe direction:
an extra daemon costs one spawn, a shared daemon with a different
instrument costs the measurement. For a process that CANNOT spawn — the
deriver, whose `daemonCall` never spawns by design — a mismatch is NOT an
extra daemon; it is a permanent, silent `no-call` on every record, i.e.
100% fallback to the one-shot lane with a correspondingly changed
`transport` stamp. That asymmetry is why the denylist above rules out
selection/endpoint/operating keys explicitly instead of leaving them to
"an extra daemon is harmless". A host that accumulates several
`acp-*.sock` files is behaving correctly; a deriver that never once
stamps `agent-sdk-daemon` is a fingerprint bug and must be diagnosed as
one.

**The wire-send boundary law (binding — stated ONCE here; the wire, the
daemon, the client and the deriver all implement THIS text).** Every turn
resolves as exactly one of `ok`, `no-call`, or `call-consumed`. The
dividing line is whether the `session/prompt` bytes crossed the boundary
toward the model. Both sides of the wire classify the SAME physics the
SAME way: there is no post-send `no-call` anywhere.

  L1. CLIENT — any failure BEFORE the `session/prompt` frame is fully
      written to the socket is `no-call`: no socket, connect refused,
      socket-dir creation failure, `initialize`/`session/new` failure,
      env-fingerprint mismatch, write error. "Fully written" means the
      socket's write callback reported success; a write that errors before
      that callback cannot have delivered a parseable frame (a partial
      line is held in the daemon's decoder and never dispatched), so it is
      `no-call`.
  L2. CLIENT — any ambiguity AFTER that frame is written is
      `call-consumed`: client budget expiry, socket closed mid-turn,
      unparseable response, an error frame carrying NEITHER a recognized
      instrument code NOR a boolean `data.callConsumed`, or a
      `data.callConsumed` that is present but not a boolean. The
      conservative side of an ambiguity is always "consumed"; the cost is
      one retryable record, and the alternative cost is a second model
      call.
  L3. CLIENT — the post-send decision procedure, in this exact order, with
      no other branches:
        (i)  `error.data.callConsumed` present AND `typeof === "boolean"`
             ⇒ AUTHORITATIVE, use it.
        (ii) otherwise, `error.code === ACP_ERR_NO_CALL` ⇒ `no-call`;
             `error.code === ACP_ERR_CALL_CONSUMED` ⇒ `call-consumed`.
             A recognized code with `data` absent is HONOURED — that is
             what "the numeric code is the fallback for a daemon that
             omitted it" means, and it is the only reading under which a
             conforming daemon that omits the optional field does not have
             its `no-call` silently upgraded.
        (iii) anything else ⇒ L2 ⇒ `call-consumed`.
      (Round-4 reconciliation: an earlier draft listed "missing
      `data.callConsumed`" under L2 while L3 made the code the fallback —
      a direct contradiction on the one branch that decides between one
      and two model calls. L2 now scopes its clause to "neither a
      recognized code nor a boolean field", and step (ii) above is the
      single authority for a recognized code with no data.)
  L4. DAEMON — a turn that never pushed its prompt is a PROVABLE `no-call`,
      and this is the ONLY daemon-side source of `no-call`: still in the
      FIFO queue when its queue-wait cap expired; cancelled while queued;
      cancelled after leaving the queue but BEFORE its prompt was pushed;
      `/clear` not confirmed by `conversation_reset` within its cap;
      `setModel` not confirmed within its cap; the session was closed
      before the push; or the `Query` could not be started at all.
  L5. DAEMON — once the prompt is pushed, EVERY non-success ending is
      `call-consumed`. There is no exception. An earlier draft carved out
      `api_retry` with `error_status === null`, reasoning that a
      connection-level failure proves nothing reached the model.
      sdk.d.ts:2839-2841 does not support that reading: it documents
      `error_status: null` for "connection errors (e.g. TIMEOUTS) that had
      no HTTP response", and a read timeout is precisely the case where
      the API received, processed and BILLED the request while no response
      came back. `SDKAssistantMessageError` (sdk.d.ts:2901) is a closed
      enum that reports `'unknown'` for both refusal and timeout, so the
      two are indistinguishable from the SDK surface. The carve-out was
      also worthless: a daemon and its clients are fingerprint-matched on
      the same endpoint and credentials, so an endpoint the daemon cannot
      reach the one-shot fallback cannot reach either — it would have
      bought no recoveries while risking the one invariant this law
      protects.
  L6. DAEMON — `api_retry` with `error_status !== null` means the API
      answered, so the call is CONSUMED; the turn is cancelled at that
      moment because the CLI's own internal retry would be call #2 (§6d,
      `agent-transport.ts:135-145`). `api_retry` with `error_status ===
      null` is likewise CONSUMED once the prompt was pushed (L5) and is
      likewise cancelled, for the same reason. An `api_retry` arriving
      while the CURRENT turn has NOT yet pushed its prompt belongs to the
      recycle leg, not to the turn: it is counted as a stray and MUST NOT
      poison an unsent turn or interrupt an in-flight `/clear`.
  L7. DAEMON — a cancelled or timed-out turn that was SENT settles from its
      OWN terminal `result` message, never at the instant of cancellation,
      so a trailing message can never be attributed to the NEXT turn. A
      cancel that arrives while the turn is UNSENT settles immediately as
      `no-call` (L4) and the turn is never pushed — cancelling a turn must
      never be the thing that causes it to spend a model call. If
      `interrupt()` itself hangs past the hard grace, the whole `Query` and
      its subprocess are destroyed. Destroying the `Query` is NOT by itself
      sufficient to prevent stale routing: the message pump is a separate
      object whose loop unwinds asynchronously, so the implementation must
      additionally bind every pump to the generation of `Query` it was
      started for and make a superseded pump a no-op — both while routing
      and while tearing down. A pump that outlives its `Query` and settles
      whatever turn is current would destroy a FRESH record. For the same
      reason a session `close()` must be observed after EVERY suspension
      point inside a turn's execution, not only at its entry: a `close()`
      that lands while a turn is awaiting the SDK package import would
      otherwise be followed by a fresh subprocess spawn and a real model
      call on a session the caller already terminated.

A caller may fall back to the one-shot lane ONLY on `no-call`. On
`call-consumed` the deriver returns undefined and the record stays
pending/retryable. Without this split, a fail-open fallback would issue a
second model call for the same record, breaking §4's exactly-one-call rule
and making the `--go N` cost fence mean up to `2N` calls.

**Budget rule (binding, and the reason L2 is not a loophole).** The
client's daemon-leg budget MUST exceed the daemon's worst-case per-turn
wall clock, or an ordinary slow-but-legitimate turn would trip L2 and cost
the record. Registered values: daemon queue-wait 6 s + `/clear` confirm
4 s + `setModel` confirm 2 s + generation 16 s + hard grace 4 s = 32 s
worst case; client leg 36 s (the 4 s of slack is the client's connect +
`initialize` + `session/new` preamble, which the daemon's clock does not
cover); minimum fallback leg 10 s; total per-record budget 60 s (unchanged
from today's `CALL_TIMEOUT_MS`). Every daemon-side wait is capped —
including `setModel`, which the SDK exposes as an un-timed control
round-trip and which would otherwise let one wedged subprocess hang the
FIFO for the daemon's whole lifetime. The one uncapped item is the lazy
`import` of the SDK package (~84 ms measured); it sits outside the 32 s
sum, and an import slow enough to consume the client's slack degrades to
L2 (`call-consumed`, a lost retryable record), never to a second call.
Per-record latency therefore never exceeds today's. The arithmetic is
locked by a unit test, not by prose.

**Fail-open provenance rule (binding).** A caller selecting
`agent-sdk-daemon` that falls back derives via the direct lane instead and
the record stamps the transport THAT ACTUALLY RAN, and the model the lane
actually used. A stamp may therefore differ from the selection; the stamp
is the truth. Silent mislabeling here is the §6d cls-ab defect all over
again — the paired-validation partition reads stamps, so a lie in the
stamp corrupts the §6e bar itself.

**Which field proves the model — SCOPED TO THIS LANE (binding), and the
asymmetry that scoping registers.** For a turn served by the
`agent-sdk-daemon` lane, the AUTHORITATIVE evidence of which model ran is
the keys of `modelUsage` on the SDK's terminal result (sdk.d.ts:4312 on
success, sdk.d.ts:4279 on error). The `model` field of the turn's
assistant messages is DIAGNOSTIC ONLY and never becomes evidence —
treating it as a fallback proof would quietly reinstate the tautology this
rule exists to remove.

THE MATCHING RULE (binding, and NOT string equality). A `modelUsage` key
is not required to equal the requested model id, and in practice does not:
this repo's own captured CLI transcripts key `modelUsage` by the DATED
snapshot id (`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson`
records `"modelUsage":{"claude-haiku-4-5-20251001": …}` for a request that
named the undated alias), and sdk.d.ts:1274-1277 states outright that the
key may be a provider-specific id or an alias differing from the canonical
one. A key `k` therefore PROVES a requested model `m` iff:

    k === m  OR  k.startsWith(m + "-")  OR  usage[k].canonicalModel === m

Naive string equality here would discard EVERY honest derivation and turn
a sized go into a full spend with zero records — registered explicitly so
no later reader "simplifies" it back.

When `modelUsage` carries exactly one key, that key (with its
`canonicalModel`) is the turn's evidence. When it carries several (an
auxiliary title/summarizer model is possible), the turn is proven for `m`
only if some key proves `m` under the rule above AND every other key
recorded zero output tokens — the proof still comes from the result, not
from the request. A turn that produced text but whose result carries no
key proving the requested model is reported `call-consumed` (the call
happened; the record must not be stamped). The `transport` and `model`
STAMPS written onto the record remain the lane that ran and the resolved
requested id, exactly as §6c/§6d records already carry them; what this
rule adds is that a daemon-lane record is only written when the result
PROVES the lane ran that model.

REGISTERED ASYMMETRY, not an oversight: this rule binds the
`agent-sdk-daemon` lane only. The `"sdk"` lane returns an API response the
caller does not inspect for model provenance, and the `"agent-sdk"` lane's
`agentSdkCall` returns a bare string with no result surface at all
(`agent-transport.ts:146-149`), so neither can supply this evidence
without a change to code §6c/§6d already validated and froze. Those two
lanes keep their §6c/§6d requested-model stamp. Pretending otherwise
would make this amendment declare a rule two of the three live lanes
violate on their first record.

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
validation run binds its OWN socket path (`KKAMAK_ACP_SOCKET` set to a
run-specific file) and sets `KKAMAK_ACP_IDLE_MS` above the expected batch
duration, then re-proves daemon liveness inside the same script that
spends. The dedicated socket is not cosmetic: both `KKAMAK_ACP_IDLE_MS`
and `KKAMAK_ACP_SOCKET` are on the fingerprint denylist (neither can
change the instrument), so a daemon already listening at the default
fingerprinted path would be adopted by the liveness probe and would serve
the run under ITS idle budget, not the registered one — the registered
parameter would be silently inert. Both are operational parameters of the
run, not changes to the bar. The run records its daemon's pid (via
`KKAMAK_ACP_TEST_SPAWN_LOG`, itself denylisted), terminates THAT pid and
no other process, and asserts the socket file is gone.

**Pooling is not transitive, and the post-flip live stream is split three
ways.** §6d permits pooling `sdk` with `agent-sdk` at exactly 0.800; a
§6e pass would permit pooling `sdk` with `agent-sdk-daemon` at ≥ 0.80.
Neither licenses pooling `agent-sdk` with `agent-sdk-daemon`. After a
flip, the live derive path emits `"agent-sdk-daemon"` when the daemon
serves the turn and `"agent-sdk"` when it fell back on a `no-call` — the
lane is chosen by daemon availability, which is not independent of host
state or time of day. Every post-flip reading is therefore split THREE
ways (`sdk` pre-boundary, `agent-sdk-daemon`, `agent-sdk`), and the
fallback mixture is itself a registered source of variance. A post-flip
stream in which `agent-sdk-daemon` NEVER appears is not a valid reading of
this lane at all — it is an ensure-gate or fingerprint defect (see the
fingerprint residual above and the flip gate below).

**Live flip gate.** The live derive path (refiner-cli.ts) stays pinned to
`"sdk"` until: (1) this bar passes, (2) the flip ships with the fail-open
fallback and the wire-send boundary law above, (3) the flip ships with a
SessionStart ensure gate that fires on exactly the condition under which
the live path takes the daemon lane — one predicate read by both, not two
that can drift, because a forced live lane with an opt-in ensure gate
would produce a 100%-fallback stream that is slower than the pre-flip
instrument and stamped as a lane this bar never measured — and (4) the
boundary ts is logged in
`docs/2026-08-01-gauntlet-adoption-ledger.md` at the flip commit
— behaviour changes while `pluginVersion` does not. A bar FAIL is a
complete, successful outcome: the daemon stays available for any caller
that opts in with split readings, and live keeps `"sdk"`.

**Boundary ts for batch, too.** §6d's Deploy clause requires a boundary ts
when the first BATCH caller opts in. The §6e validation run (a shadow-store
derive) is instrument validation, not a production reading, and does NOT
trigger it. The first `agent-sdk-daemon` derive against a REAL store does,
whether or not the live flip ever happens.

**Known reporting gap, re-recorded.** `cls-ab.ts`'s `transportTally`
(lines 375-383, the `if/else` at 379-380 — this is the precise range;
§6d's own paragraph above says "lines ~375-380" and is corrected to this
range in the same commit that lands §6e) buckets records as `if
(transport === "sdk") sdk++ else cli++`. §6d recorded this for
`"agent-sdk"`; it applies identically to `"agent-sdk-daemon"`, which will
also be miscounted as CLI in the classifier A/B report. Display miscount
only, still out of scope, fix it when cls-ab is next opened.

**What would falsify this design.** If warm-lane derivations disagree with
fresh-spawn agent-lane derivations more than fresh-spawn disagrees with
the API lane (i.e. the warm context is NOT behaviourally neutral), the
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

- [ ] **Step 2: Correct §6d's `cls-ab` line range in the same edit.** The §6e text above states the precise range `375-383` with the `if/else` at `379-380` (verified against `cc-gate-plugin/src/gauge/cls-ab.ts` 2026-08-04). §6d's existing "Known reporting gap" paragraph (spec line ~734) says "lines ~375-380". Two ranges for the same code in the same spec file is exactly the kind of drift §6e's residue paragraph exists to prevent, so update §6d's sentence to `375-383` in this commit. No other §6d text changes.

- [ ] **Step 3: Verify no dead links**

Run: `bun scripts/doc-check.ts`
Expected: `doc-check: OK — <N> tracked file(s), 0 violations (<M>ms)`
(doc-check enforces relative-link integrity + fence balance only, `scripts/doc-check.ts:21-31`; the §6e text has no markdown links and no nested fences, and every backticked path it names exists. The trailing `(<M>ms)` is part of the real output — do not treat its presence as a mismatch.)

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "docs(spec): register 6e warm-daemon lane (pre-data, user-directed supersession)"
```

### Task 2: Pin the ACP wire subset + the budget arithmetic + the model-proof predicate — conformance fixtures, no new dependency

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
a general-purpose ACP agent.** Three deliberate deviations, all listed so
none is a silent divergence:
  1. `session/prompt` REQUIRES `_meta.model`, which no standard editor
     client sends.
  2. `session/new`'s `cwd` is accepted and ignored, because the instrument
     pins a neutral `cwd`.
  3. `session/cancel` is served as a REQUEST (it is answered with `{}`)
     as well as tolerated as a notification. In ACP proper it is a
     notification; our own client wants an acknowledgement so a test can
     order "cancel landed" against "turn resolved". The dispatcher answers
     only when the frame carried an `id`, so a real notification is never
     answered and JSON-RPC 2.0 is not violated.
The dispatcher is transport-agnostic and a `--stdio` binding is a flag
rather than a rewrite — but that binding serves the SAME private profile
(our own tooling over stdio), NOT off-the-shelf editors. Anyone wanting
real editor interoperability must relax `_meta.model`, honour
`session/new.cwd` and make `session/cancel` notification-only, which would
change the instrument and needs its own amendment.

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-wire.ts`
- Test: `cc-gate-plugin/test/acp-wire.test.ts`

**Interfaces:**
- Produces:
  - `interface JsonRpcRequest { jsonrpc: "2.0"; id?: number | string; method: string; params?: unknown }`
  - `interface JsonRpcResponse { jsonrpc: "2.0"; id: number | string; result?: unknown; error?: JsonRpcError }`
  - `interface JsonRpcError { code: number; message: string; data?: { callConsumed: boolean; model?: string } }`
  - `encodeFrame(msg: object): string` — `JSON.stringify(msg) + "\n"`. Safe by construction: `JSON.stringify` escapes any literal newline inside a payload string, so a frame can never contain an unescaped delimiter.
  - `class FrameDecoder { constructor(opts?: { maxLineChars?: number }); push(chunk: Buffer | string): object[]; malformed: number }` — buffers partial lines; a malformed JSON line increments `malformed` and is dropped (never a throw — a broken client must not kill the daemon); a line exceeding `maxLineChars` (default 4 194 304) also counts as malformed AND resets the buffer, so a client that never sends `\n` cannot grow the daemon's memory without bound. **Decoding is UTF-8-boundary-safe**: the decoder holds a `node:string_decoder` `StringDecoder("utf8")`, because a bare `chunk.toString()` turns a multi-byte character split across two socket chunks into two U+FFFD replacement characters — which still parses as JSON and would ship a SILENTLY CORRUPTED prompt to the model. Both `acp-daemon.ts` and `acp-client.ts` additionally call `socket.setEncoding("utf8")`, which is belt-and-braces for the same hazard.
  - Method-name constants: `ACP_INITIALIZE = "initialize"`, `ACP_SESSION_NEW = "session/new"`, `ACP_SESSION_PROMPT = "session/prompt"`, `ACP_SESSION_CANCEL = "session/cancel"`, `ACP_SESSION_UPDATE = "session/update"` (notification).
  - `ACP_BUDGET` — the ONE timing-constant object (Global Constraints table). It lives here, in the module BOTH sides already import, because the client's leg and the daemon's worst case are a single contract: split across two files they drift, and a drift silently converts §6e law L5 into law L2 (a `no-call` that should have been `call-consumed`, i.e. a double model call). `acp-wire.ts` imports nothing but `node:string_decoder`, so `transport.ts` may import it eagerly without putting anything expensive on the hook path.
  - `CLI_SPAWN_BUDGET_MS = 8_000` and `modelProvenBy(...)` — see below. Both live here for the same single-source reason as `ACP_BUDGET`.
  - Instrument error codes — these ARE the call-consumption channel on the wire:
    - `ACP_ERR_NO_CALL = -32000` — §6e law L1/L4: the prompt bytes were never pushed toward the model. `data.callConsumed === false`.
    - `ACP_ERR_CALL_CONSUMED = -32001` — §6e law L2/L5/L6: the prompt bytes were pushed and the turn did not succeed. `data.callConsumed === true`.
    Both sit in JSON-RPC 2.0's RESERVED implementation-defined SERVER-ERROR band (`-32099..-32000`), which is where a server's own error semantics belong; true application-defined codes must live OUTSIDE `-32768..-32000`. Recorded precisely because a later reader will otherwise "fix" them into the wrong band. `data.callConsumed` is AUTHORITATIVE over the code (§6e law L3 step (i)) so a code collision with a future ACP assignment degrades gracefully rather than into a double call; a RECOGNIZED code with `data` absent is honoured (L3 step (ii)).
  - Param/result shapes (types only, used by Tasks 5-6):
    `AcpInitializeResult { protocolVersion: number; agentCapabilities: { loadSession: false }; _meta: { envFingerprint: string } }` — the fingerprint echo §6e requires.
    `AcpNewSessionResult { sessionId: string }`,
    `AcpPromptParams { sessionId: string; prompt: Array<{ type: "text"; text: string }>; _meta: { model: string } }` — `_meta.model` is REQUIRED, not optional: the daemon must never silently substitute its own env's model for the caller's (see Task 5). This is the private-profile constraint noted above.
    `AcpPromptResult { stopReason: "end_turn"; _meta: { model: string; canonicalModel: string; callConsumed: true } }` — `_meta.model` is the `modelUsage` KEY the turn actually ran under (sdk.d.ts:4312) and `_meta.canonicalModel` is that entry's `canonicalModel` (sdk.d.ts:1274-1277) or `""`. Together they are the EVIDENCE the caller checks with `modelProvenBy`; neither is the model the caller asked for. Carrying both is what makes the dated-snapshot case (`claude-haiku-4-5-20251001` for a `claude-haiku-4-5` request) resolvable client-side without the client having to trust the daemon's own comparison.
    `AcpUpdateParams { sessionId: string; update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } } }`.
  - **Deliberate protocol note:** a daemon-side failure is a JSON-RPC ERROR, never `stopReason: "refusal"`. In ACP, `refusal` means the model refused; overloading it would make "daemon died" indistinguishable from "model refused" for any real client, and would give this instrument no place to carry `callConsumed`.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import {
  FrameDecoder, encodeFrame, ACP_BUDGET, CLI_SPAWN_BUDGET_MS, modelProvenBy,
  ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED,
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
  test("a multi-byte character split across two BUFFER chunks survives verbatim", () => {
    // THE corruption guard. A bare chunk.toString() yields two U+FFFD here,
    // the frame still parses as JSON, and a silently corrupted prompt goes
    // to the model — a wrong derivation with no error anywhere.
    const d = new FrameDecoder()
    const text = "\u00e9\u4f60\u597d\u{1F600} tail"        // 2-, 3- and 4-byte sequences
    const wire = Buffer.from(encodeFrame({ jsonrpc: "2.0", id: 7, method: "session/prompt", params: { text } }), "utf8")
    // Cut inside the 4-byte emoji: find its start and split one byte in.
    const cut = wire.indexOf(Buffer.from("\u{1F600}", "utf8")) + 1
    expect(d.push(wire.subarray(0, cut)).length).toBe(0)
    const frames = d.push(wire.subarray(cut))
    expect(frames.length).toBe(1)
    expect((frames[0] as { params: { text: string } }).params.text).toBe(text)
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
    const d = new FrameDecoder({ maxLineChars: 64 })
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
  test("the five daemon legs sum to the declared worst case", () => {
    const b = ACP_BUDGET
    expect(b.queueWaitMs + b.clearTimeoutMs + b.setModelMs + b.turnTimeoutMs + b.hardGraceMs)
      .toBe(b.daemonWorstCaseMs)
  })
  test("the client leg strictly exceeds the daemon worst case", () => {
    expect(ACP_BUDGET.daemonLegMs).toBeGreaterThan(ACP_BUDGET.daemonWorstCaseMs)
  })
  test("the client's slack covers a connect + initialize + session/new preamble", () => {
    // Not decoration: the daemon's clock starts when it accepts the prompt,
    // the client's when it opens the socket. Anything under a second of
    // slack would make an ordinary busy daemon look like law L2.
    expect(ACP_BUDGET.daemonLegMs - ACP_BUDGET.daemonWorstCaseMs).toBeGreaterThanOrEqual(3_000)
  })
  test("daemon leg + minimum fallback still fits the per-record budget", () => {
    expect(ACP_BUDGET.daemonLegMs + ACP_BUDGET.minFallbackMs).toBeLessThanOrEqual(ACP_BUDGET.recordBudgetMs)
  })
  test("the per-record budget is unchanged from the incumbent 60s", () => {
    expect(ACP_BUDGET.recordBudgetMs).toBe(60_000)
  })
  test("the generation budget exceeds the measured CLI spawn (round-4 C3)", () => {
    // A turn's timers start at the PUSH while the subprocess is still
    // booting; §6d measured that spawn at 1.25-1.46s. A turnTimeoutMs at or
    // below it cannot distinguish "generation failed" from "not started
    // yet". CLI_SPAWN_BUDGET_MS is the floor every WarmSession
    // construction, production or test, must clear.
    expect(CLI_SPAWN_BUDGET_MS).toBe(8_000)
    expect(ACP_BUDGET.turnTimeoutMs).toBeGreaterThanOrEqual(CLI_SPAWN_BUDGET_MS)
  })
})

// §6e "Which field proves the model" — the MATCHING rule, not equality.
// This is the round-4 C1 lock: the repo's own captured CLI transcripts key
// modelUsage by the DATED snapshot id
// (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22 =>
// "claude-haiku-4-5-20251001") while resolveModelId("haiku") produces the
// undated alias. Strict equality here discards EVERY honest derivation.
describe("modelProvenBy (§6e model-proof rule)", () => {
  test("exact match proves", () => {
    expect(modelProvenBy("claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DATED snapshot key proves its undated alias", () => {
    expect(modelProvenBy("claude-haiku-4-5-20251001", "claude-haiku-4-5")).toBe(true)
  })
  test("canonicalModel proves even when the key is provider-specific", () => {
    expect(modelProvenBy("bedrock/anthropic.claude-haiku", "claude-haiku-4-5", "claude-haiku-4-5")).toBe(true)
  })
  test("a DIFFERENT model never proves — prefix matching must not be a substring match", () => {
    expect(modelProvenBy("claude-opus-5", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-opus-5-20260101", "claude-haiku-4-5")).toBe(false)
    // and the boundary: a longer FAMILY name is not a snapshot of a shorter one
    expect(modelProvenBy("claude-haiku-4-52", "claude-haiku-4-5")).toBe(false)
  })
  test("empty inputs never prove anything", () => {
    expect(modelProvenBy("", "claude-haiku-4-5")).toBe(false)
    expect(modelProvenBy("claude-haiku-4-5", "")).toBe(false)
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
// general-purpose ACP agent — `_meta.model` is REQUIRED on session/prompt,
// `session/new.cwd` is accepted-and-ignored (the instrument pins a neutral
// cwd), and `session/cancel` is answerable as a request. Off-the-shelf
// editor clients are explicitly out of scope.
//
// Transport-agnostic: the daemon binds it to a Unix socket, and a --stdio
// flag binds the same dispatcher to stdin/stdout for our own tooling.
//
// Imports nothing but node:string_decoder, deliberately: transport.ts
// imports this module eagerly and transport.ts is on hook-cli.ts's eager
// import path (hook-cli.ts:24).
import { StringDecoder } from "node:string_decoder"

export interface JsonRpcRequest {
  jsonrpc: "2.0"
  id?: number | string
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  /** §6e law L3 step (i): AUTHORITATIVE call-consumption channel when
   * present AND boolean. A recognized numeric code with this field absent
   * is honoured by step (ii); anything else falls to L2. */
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

/** §6e law L1/L4 — the prompt bytes never crossed the boundary toward the
 * model. The caller MAY fall back to the one-shot lane without breaking
 * §4's exactly-one-call rule. This is the ONLY safe fallback signal. */
export const ACP_ERR_NO_CALL = -32000
/** §6e law L2/L5/L6 — the prompt bytes were pushed and the turn still
 * failed. The caller MUST NOT fall back; the record stays
 * pending/retryable. */
export const ACP_ERR_CALL_CONSUMED = -32001

/** §6e instrument invariant: a turn's timers start at the PUSH while the
 * CLI subprocess is still booting, and §6d measured that spawn at
 * 1.25-1.46 s. No WarmSession construction — production or test — may use
 * a `turnTimeoutMs` below this floor, or it cannot distinguish "generation
 * failed" from "the subprocess had not started yet". Round-4 finding C3:
 * a regression test built on a 1 s budget fails a CORRECT implementation
 * deterministically. */
export const CLI_SPAWN_BUDGET_MS = 8_000

/** §6e budget rule. ONE object, in the module both sides import, because
 * `daemonLegMs > daemonWorstCaseMs` is a CONTRACT: split these across two
 * files and a drift silently converts a `call-consumed` into a `no-call`,
 * i.e. two model calls for one record. Locked by acp-wire.test.ts. */
export const ACP_BUDGET = {
  /** daemon: a turn still queued at this point never reached execute() */
  queueWaitMs: 6_000,
  /** daemon: `/clear` must be confirmed by conversation_reset within this */
  clearTimeoutMs: 4_000,
  /** daemon: setModel() is an un-timed SDK control round-trip (sdk.d.ts:2327);
   * capped so one wedged subprocess cannot hang the FIFO for the daemon's
   * whole lifetime with no timer armed. */
  setModelMs: 2_000,
  /** daemon: generation budget, measured from the prompt push. MUST be
   * >= CLI_SPAWN_BUDGET_MS — the spawn happens inside this window. */
  turnTimeoutMs: 16_000,
  /** daemon: grace before destroying the Query when interrupt() hangs */
  hardGraceMs: 4_000,
  /** derived: 6 000 + 4 000 + 2 000 + 16 000 + 4 000. Does NOT include the
   * uncapped lazy `import("@anthropic-ai/claude-agent-sdk")` (~84 ms
   * measured); an import slow enough to eat the client's slack degrades to
   * law L2 (call-consumed, a lost retryable record), never to a second
   * model call. */
  daemonWorstCaseMs: 32_000,
  /** client: MUST exceed daemonWorstCaseMs. The 4 000 ms of slack is the
   * connect + initialize + session/new preamble, which the daemon's own
   * per-turn clock does not cover. */
  daemonLegMs: 36_000,
  /** client: below this remaining, do not start a fallback at all */
  minFallbackMs: 10_000,
  /** client: today's CALL_TIMEOUT_MS — per-record latency never exceeds it */
  recordBudgetMs: 60_000,
} as const

/** §6e "Which field proves the model", the MATCHING rule — the single
 * definition, used by WarmSession.route() (to pick which modelUsage entry
 * is the turn's own) and by callModelDerive (to decide whether the daemon
 * lane may stamp a record).
 *
 * NOT string equality, and that is load-bearing: this repo's own captured
 * CLI transcripts key `modelUsage` by the DATED snapshot id
 * (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22 =>
 * `"modelUsage":{"claude-haiku-4-5-20251001": …}`) for a request that named
 * the undated alias `claude-haiku-4-5`, and sdk.d.ts:1274-1277 states the
 * key "may differ from the raw model string this entry is keyed by
 * (provider-specific ids, aliases)". Strict equality would return
 * `undefined` for EVERY honest daemon derivation — a whole sized go spent
 * for zero records (round-4 finding C1).
 *
 * The `"-"` in the prefix test is deliberate: `startsWith(requested)` alone
 * would let `claude-haiku-4-52` prove `claude-haiku-4-5`. */
export function modelProvenBy(key: string, requested: string, canonicalModel?: string): boolean {
  if (!key || !requested) return false
  if (key === requested) return true
  if (key.startsWith(`${requested}-`)) return true
  return canonicalModel === requested
}

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
  /** `model` is the `modelUsage` KEY the turn ran under (sdk.d.ts:4312) and
   * `canonicalModel` is that entry's canonicalModel (sdk.d.ts:1274-1277) or
   * "". They are EVIDENCE, checked client-side with `modelProvenBy` — never
   * the requested model, which would make the caller's check a tautology,
   * and never a daemon-side verdict, which would hide the dated-snapshot
   * case from the caller. */
  _meta: { model: string; canonicalModel: string; callConsumed: true }
}
export interface AcpUpdateParams {
  sessionId: string
  update: { sessionUpdate: "agent_message_chunk"; content: { type: "text"; text: string } }
}

export function encodeFrame(msg: object): string {
  return JSON.stringify(msg) + "\n"
}

const DEFAULT_MAX_LINE_CHARS = 4 * 1024 * 1024

/** Newline-delimited JSON-RPC decoder. Malformed lines (and lines longer
 * than `maxLineChars`, which also reset the buffer) increment `malformed`
 * and are dropped — a broken or hostile client never kills the daemon and
 * never grows its memory without bound.
 *
 * UTF-8-BOUNDARY-SAFE by construction: a StringDecoder holds any partial
 * multi-byte sequence at a chunk edge until its remaining bytes arrive. A
 * bare `chunk.toString()` would emit U+FFFD on both sides of the split; the
 * frame would still parse as JSON and a CORRUPTED prompt would reach the
 * model with no error raised anywhere. `maxLineChars` counts UTF-16 code
 * units (JS string length), not bytes — named accordingly.
 *
 * In production both sides also call `socket.setEncoding("utf8")`, so the
 * string branch is the one that runs and Node's own decoder does this work;
 * the Buffer branch here is the second layer, and the split-multibyte test
 * is what keeps it honest. */
export class FrameDecoder {
  private buf = ""
  private readonly dec = new StringDecoder("utf8")
  private readonly maxLineChars: number
  malformed = 0

  constructor(opts: { maxLineChars?: number } = {}) {
    this.maxLineChars = opts.maxLineChars ?? DEFAULT_MAX_LINE_CHARS
  }

  push(chunk: Buffer | string): object[] {
    this.buf += typeof chunk === "string" ? chunk : this.dec.write(chunk)
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
    if (this.buf.length > this.maxLineChars) {
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
git commit -m "feat(gauge): ACP wire subset — framing, method constants, call-consumption codes, budget arithmetic, model-proof rule"
```

### Task 3: Widen the transport literal to `agent-sdk-daemon`

**Files:**
- Modify: `cc-gate-plugin/src/types.ts` (`GAUGE_TRANSPORTS`, line 167)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts:49` (DECLARED EXCEPTION #1 — replace in place) + append one test (DECLARED EXCEPTION #2)
- Modify: `cc-gate-plugin/test/paired-validation.test.ts` (append two tests — DECLARED EXCEPTION #3)

**Interfaces:**
- Consumes: `GAUGE_TRANSPORTS`, `GaugeTransport` (currently `["cli","sdk","agent-sdk"]`, `src/types.ts:167-168`).
- Produces: `GAUGE_TRANSPORTS = ["cli", "sdk", "agent-sdk", "agent-sdk-daemon"] as const` (incumbent-first order preserved) and the derived union. Everything downstream (`parsePairFlag` at `paired-validation.ts:349-362`, `PvPairing`, `arms` fields, `derivedOn`, `parsePvCountsFile`'s arms validation at `:638`, `replay-cli.ts:549`/`:691`'s usage strings) picks the new literal up structurally — the §6d plan parameterized them over `GAUGE_TRANSPORTS` for exactly this reason.

- [ ] **Step 1: Write the failing tests** (in the files that already import these symbols — `gauge-agent-transport.test.ts` owns `GAUGE_TRANSPORTS`/`selectTransport`, `paired-validation.test.ts` already imports `parsePairFlag` and `isCliDerived` at `:8`/`:21`; do NOT put them in `gauge-wiring.test.ts`, which is a hook-to-refiner E2E file that imports neither)

```typescript
// test/gauge-agent-transport.test.ts
//
// (1) DECLARED EXCEPTION #1 — REPLACE the body of the existing test at
// :47-51 IN PLACE. Do not add a second literal-list test: a fourth
// registered literal necessarily invalidates a toEqual on the old three,
// and two tests asserting the same array is duplication, not coverage.
describe("GaugeTransport", () => {
  test("four transports are recognized, incumbent order preserved (§6e)", () => {
    expect(GAUGE_TRANSPORTS).toEqual(["cli", "sdk", "agent-sdk", "agent-sdk-daemon"])
  })

  // (2) DECLARED EXCEPTION #2 — APPEND this test. It pins the two facts the
  // toEqual above does not: that the literal is a MEMBER OF THE UNION (a
  // compile-time fact `toEqual` cannot see, and the one Task 7's
  // `DeriveCallResult.transport` and Task 9's `--pair` both depend on), and
  // that it sorts LAST, which is the "existing readings that sort by this
  // array do not reshuffle" promise in types.ts's own comment.
  test("the §6e literal is a member of the GaugeTransport union and sorts last", () => {
    const t: GaugeTransport = "agent-sdk-daemon"      // compile-time union membership
    expect(GAUGE_TRANSPORTS.indexOf(t)).toBe(GAUGE_TRANSPORTS.length - 1)
    expect(GAUGE_TRANSPORTS.indexOf("sdk")).toBeLessThan(GAUGE_TRANSPORTS.indexOf(t))
  })
})
// ...and widen the import at :6 to `import { GAUGE_TRANSPORTS, type GaugeTransport } from "../src/types.ts"`.

// test/paired-validation.test.ts (declared exception #3 — append only).
// Uses this file's own `rec`/`gauge` builders rather than a hand-rolled
// literal, matching the sibling test at :1281.
test("parsePairFlag accepts the §6e literal structurally", () => {
  const p = parsePairFlag(["--pair", "sdk:agent-sdk-daemon"])!
  expect(p.shadowTransport).toBe("agent-sdk-daemon")
  expect(p.baselineLabel).toBe("sdk")
})
test("an agent-sdk-daemon record is NOT CLI-derived", () => {
  expect(isCliDerived(rec({ derivation: gauge({ transport: "agent-sdk-daemon" }) }))).toBe(false)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/gauge-agent-transport.test.ts test/paired-validation.test.ts`
Expected: FAIL — array does not contain `"agent-sdk-daemon"`, and the `GaugeTransport` annotation is a type error.

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
`grep -rn 'GAUGE_TRANSPORTS' cc-gate-plugin/test/` — expect exactly **FOUR** hits, all in `gauge-agent-transport.test.ts`: the import at `:6`, the replaced assertion at `:49`, and the **two** lines of the appended membership test (`indexOf(t)` and `indexOf("sdk") … indexOf(t)`). The pre-change tree has two hits; the appended test adds two LINES, not one (round-4 M1 — an expectation of "three" would make this verify step fail on a correct edit). Any hit in another file is an undeclared exception — stop and report.
`isCliDerived` (`paired-validation.ts:56-59`) already reads `"cli"`-or-absent, so the new literal cannot fall into the CLI baseline; the appended test pins that.
Also confirm nothing asserts `replay-cli.ts`'s usage strings (`:549`, `:691`) which interpolate `GAUGE_TRANSPORTS.join("|")`: `grep -rn 'cli|sdk|agent-sdk' cc-gate-plugin/test/` must show no usage-line assertion. (That pattern is a LITERAL search — basic `grep` does not treat `|` as alternation — which is exactly what is wanted here.)

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/types.ts cc-gate-plugin/test/gauge-agent-transport.test.ts cc-gate-plugin/test/paired-validation.test.ts
git commit -m "feat(gauge): widen transport literal to agent-sdk-daemon"
```

### Task 4: `WarmSession` — warm streaming Query, persistent pump, lossless feed, sequenced recycle

**Files:**
- Create: `cc-gate-plugin/test/agent-cli-stub.ts` (helper extraction, Step 0 — DECLARED EXCEPTION #4)
- Modify: `cc-gate-plugin/test/gauge-agent-transport.test.ts` (import the extracted helpers instead of defining them, and drop the four imports that go dead — a MOVE, no assertion changes)
- Create: `cc-gate-plugin/src/gauge/warm-session.ts`
- Test: `cc-gate-plugin/test/warm-session.test.ts`

**Interfaces:**
- Consumes: `query`, `Query`, `SDKMessage`, `SDKUserMessage` from `@anthropic-ai/claude-agent-sdk` (values lazy-imported inside `ensure()`, same rationale as `agent-transport.ts:102-108`'s ~84 ms finding; types via `import type`, which is erased); `ACP_BUDGET`, `CLI_SPAWN_BUDGET_MS`, `modelProvenBy` from `acp-wire.ts`; the isolation option set from `agent-transport.ts:119-132` (copy the object literal, cite it — do NOT import agent-transport's private internals).
- Produces:
  ```typescript
  export type TurnOutcome =
    | { kind: "ok"; text: string; model: string; canonicalModel: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  export type CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"

  export class WarmSession {
    constructor(
      env: Record<string, string | undefined>,
      opts?: {
        turnTimeoutMs?: number
        queueWaitMs?: number
        clearTimeoutMs?: number
        setModelMs?: number
        hardGraceMs?: number
        cwd?: string
      },
    )
    /** ONE serialized turn, resolving per §6e's wire-send boundary law.
     * `recycle` is the CALLER's decision (the daemon passes true when the
     * sessionId differs from the last one served), so a multi-prompt ACP
     * session keeps its context — see Task 5. `tag` is an opaque handle for
     * `cancel` and MUST be globally unique across callers (the daemon mints
     * a UUID; a per-connection request id would collide). Never two turns in
     * flight: calls queue FIFO. NEVER throws, ALWAYS resolves.
     *
     * `ok.model` is the `modelUsage` KEY the turn ran under and
     * `ok.canonicalModel` that entry's canonicalModel (or ""); the CALLER
     * decides whether they prove its requested model, via
     * `modelProvenBy` — see §6e's matching rule. */
    oneShot(messageText: string, model: string, opts: { recycle: boolean; tag?: string }): Promise<TurnOutcome>
    /** Cancel by tag. A QUEUED turn is dropped and resolves `no-call`
     * (`queued-dropped`). A turn that is CURRENT but has not yet pushed its
     * prompt is likewise dropped and resolves `no-call` (`unsent-dropped`)
     * — cancelling must never be what causes a turn to spend a call
     * (§6e L7). Only a turn that has ALREADY pushed is `interrupted`, and
     * only if it carries this tag — never another caller's turn. */
    cancel(tag: string): CancelResult
    isWarm(): boolean
    turnInFlight(): boolean
    /** ms since the last COMPLETED turn — the idle reaper reads this. */
    idleMs(): number
    /** Terminate the Query and subprocess, and settle every outstanding
     * caller (queued turns resolve `no-call`). Observed at EVERY suspension
     * point inside a turn, so a close during the SDK import cannot be
     * followed by a fresh spawn and a real model call. Idempotent. */
    close(): void
  }
  ```

**Design (locked by sdk.d.ts and by §6e's law, not by prose):**
- ONE `query({ prompt: pushable.stream(), options })`; the same `Query` serves many turns.
- **ONE persistent pump, BOUND TO ITS QUERY GENERATION.** `Query extends AsyncGenerator<SDKMessage, void>` (sdk.d.ts:2279). Returning or breaking out of a `for await` calls `iterator.return()` and TERMINATES the generator — so a per-turn `for await` kills the warm session at the end of turn #1. The pump is a single loop for the `Query`'s whole lifetime. It is ALSO guarded by `this.q !== q` in both the loop body and the `finally`: `close()` is synchronous (sdk.d.ts:2584) but the generator only unwinds on the subprocess exit event, an I/O tick later — by which time `drain()` may already have started the NEXT turn on a NEW `Query`. An unguarded teardown would settle that fresh turn and destroy its session. §6e law L7 names this explicitly.
- **`this.closed` is re-checked after EVERY await, not only at entry (round-4 I3).** `ensure()` awaits the SDK package import; `execute()` awaits `ensure`, `setModel` and `awaitClear`. A `close()` landing inside any of those windows must stop the turn. An entry-only check lets `ensure()` finish the import, construct a `Query`, spawn a CLI subprocess and let `execute()` push a prompt — a REAL MODEL CALL and a LEAKED SUBPROCESS on a session the caller already terminated, with `isWarm()` reporting true after `close()`. Every post-await check that finds `closed` tears down what it just built and settles `no-call` (nothing was pushed) or, if the push already happened, `call-consumed`.
- **Lossless feed.** The input side is a pushable queue with an optional waiting resolver, NOT a bare one-shot promise slot. A single re-armed resolver silently drops the second of two same-tick pushes. `close()` on the pushable CLEARS the queue as well as setting the flag, so messages queued at teardown are not fed into a dying `Query` (round-4 M12).
- **Exactly TWO resolver slots per turn, written exactly once each.** `turn.notifyCaller` is installed at ENQUEUE (it resolves the caller's `oneShot`) and `turn.settle` is installed by `execute` (it resolves the drain loop's internal wait). They are never the same field: a design that reuses one slot for both loses the queued caller's resolver when `execute` overwrites it, and that caller's promise never settles. Both are fired through the single `finish()` funnel, which is `done`-guarded, so double-settle is impossible.
- **Recycle is SEQUENCED, not fire-and-forget.** `/clear` is pushed only when the caller asks for it AND the `Query` is not brand-new, and `execute` then WAITS for `SDKConversationResetMessage` (`type: 'conversation_reset'`, sdk.d.ts:3838-3846: *"Emitted by /clear, plan-mode exit, and fresh-session flows"*), which is in the `SDKMessage` union (sdk.d.ts:4019). This is the SDK's own typed proof the recycle landed. An unconfirmed clear within `clearTimeoutMs` destroys the `Query` (the next turn respawns, which is a clean context by construction) and reports `no-call` — nothing was sent to the model.
- **Every daemon-side wait is capped, including `setModel`.** `setModel` (sdk.d.ts:2327) is an un-timed control round-trip; it is raced against `setModelMs` and a miss is `no-call` + `hardReset()` (nothing was pushed). Without the cap a wedged subprocess hangs `execute()` with NO timer armed — the turn never settles, `turnInFlight()` stays true forever, the idle reaper can never fire, and the host-global daemon is permanently dead.
- **A SENT turn settles ONLY from its own terminal `result`** (§6e law L7). `api_retry` and the turn timeout mark the turn `doomed` and call `interrupt()`, but do not settle; the terminal `result` does. The drain loop does not advance until then. A message that arrives while `turn.sent === false` belongs to the `/clear` or to a previous turn's tail and is dropped (counted in `strayMessages`) — this includes `api_retry`, which must never poison an unsent turn or interrupt an in-flight `/clear` (round-4 M11). If `interrupt()` hangs past `hardGraceMs`, the whole `Query` + subprocess is destroyed and the generation guard keeps the dying pump away from the next turn.
- **An UNSENT turn is never interrupted — it is dropped.** `cancel()` on a turn that is `current` but has not yet pushed resolves it `no-call` immediately and takes it out of `execute`'s path. Interrupting there would abort the in-flight `/clear` instead of a turn, leave `done` false, and let `execute` push the prompt anyway a moment later — so a cancel would CAUSE the model call it was asked to prevent (round-4 I11).
- **Classification is §6e's law, mechanically, and it is now trivial.** `sent` IS the classification: `consumed(t) === t.sent`. There is no post-send `no-call` witness. The `connectionOnly` carve-out (`api_retry` with `error_status === null`) was REMOVED in review round 3: sdk.d.ts:2839-2841 documents that status as covering "connection errors (e.g. timeouts) that had no HTTP response", and a read timeout is exactly the billed-but-unanswered case, so the carve-out could spend a second model call on one record. `sawModelActivity`/`sawApiResponse` survive as DIAGNOSTIC counters only — they no longer feed the outcome. `stream_event` is deliberately NOT consulted: `SDKPartialAssistantMessage` is only emitted with `includePartialMessages: true` (sdk.d.ts:1627-1631), which this option set does not set, so such a branch would be unreachable code pretending to be a guard.
- **Success requires `subtype === "success" && is_error !== true && !doomed`.** `SDKResultError` (sdk.d.ts:4269-4288) has NO `result` field, and an interrupted assistant message is flagged `aborted` (sdk.d.ts:2870-2873). No partial text is ever accumulated, let alone persisted.
- **The model is EVIDENCE, not a verdict, and corroboration is never promoted to proof.** `modelUsage` keys on the terminal result (sdk.d.ts:4312 success / :4279 error) are the only source of `observedModel`/`observedCanonical`. The last assistant `message.model` is kept in a separate `corroboratedModel` field that is DIAGNOSTIC ONLY and never reaches a stamp. A successful turn whose result carries no key proving the requested model under `modelProvenBy` reports `call-consumed`. Note the matching rule is NOT equality: this repo's own captured CLI transcripts key `modelUsage` by the dated snapshot id (`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22`), so an equality check would report `call-consumed` for every honest turn (round-4 C1).
- **Every test's `turnTimeoutMs` exceeds the measured CLI spawn.** See Global Constraints; `CLI_SPAWN_BUDGET_MS = 8_000` is the floor and every test below uses it or the 16 000 default.

- [ ] **Step 0: Extract the CLI-stub helpers (DECLARED EXCEPTION #4 — a MOVE plus one additive optional parameter)**

Move `hasClaudeCodeCredentials()` / `HAS_CLAUDE_CODE_CREDENTIALS` / `NO_CREDENTIALS_SKIP_REASON` (`test/gauge-agent-transport.test.ts:23-45`, including the `console.warn` block), `sseText()` (`:92-103`) and `withCaptureStub()` (`:116-145`) into `test/agent-cli-stub.ts` and re-import them in `gauge-agent-transport.test.ts`. **Then delete the now-dead imports at `:2-5` — `fs`, `os`, `path` and `execFileSync` have no other use in that file once `hasClaudeCodeCredentials` leaves.** No assertion in that file changes; `bun test` must be 0-fail before and after. (`test/agent-cli-stub.ts` is not matched by bun's test glob, same as the existing `test/sdk-stub.ts`.)

**Why this is mandatory, not tidiness:** `sseText` is load-bearing. The spawned CLI always sends `stream: true`, and a plain `Response.json(...)` makes it silently fall back to a SECOND, non-streaming request (`gauge-agent-transport.test.ts:67-91`). Every request-count assertion in Tasks 4-7 and 10 is meaningless without an SSE-shaped stub. And `withCaptureStub()` is per-test on purpose (`:107-115`): a killed test's subprocess can land mid-next-test, so a module-level shared `CAPTURED` corrupts unrelated counts. Tests below that need their own capture array build one with `stubServer` directly and follow the same per-test discipline.

**`sseText` gains ONE optional trailing parameter** — `model`, defaulting to the incumbent `"claude-haiku-4-5"` — so a test can make the stub declare a DATED snapshot id in `message_start` and drive the CLI to key `modelUsage` by it. Every existing call site is byte-unchanged. This is the only way to exercise round-4 C1 without a real model call:

```typescript
export function sseText(text: string, model = "claude-haiku-4-5"): Response {
  // ...identical to gauge-agent-transport.test.ts:92-103, except that
  // message_start's `model` field is the parameter rather than the literal.
}
```

**Also add to `agent-cli-stub.ts`** the never-answering stub helpers, built on raw `Bun.serve` (precedent: `gauge-agent-transport.test.ts:252`) because `stubServer`'s handler type is synchronous `(c: Captured) => Response` and must NOT be widened, plus one polling helper the timing-sensitive tests need:

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
 * answered normally — the shape the turn-timeout tests need. */
export function hangFirstServer(text: string, model = "claude-haiku-4-5"): { url: string; stop: () => void; count: () => number } {
  let n = 0
  const s = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = await req.text()
      if (!body) return new Response(null, { status: 200 })   // HEAD /api/hello probe
      n++
      if (n === 1) return new Promise<Response>(() => {})
      return sseText(text, model)
    },
  })
  return { url: `http://127.0.0.1:${s.port}`, stop: () => s.stop(true), count: () => n }
}

/** Poll `pred` until true or `ms` elapses; returns pred()'s final value.
 * REQUIRED by the cancel/close tests: "the turn has been SENT" is only
 * observable as "the stub received the request", and the CLI subprocess
 * takes 1.25-1.46 s to get there. A test that cancels or closes before
 * that point is testing a different branch than it claims to
 * (round-4 C3/I11). */
export async function until(pred: () => boolean, ms: number): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return pred()
}
```

- [ ] **Step 1a: THE GATE — prove `/clear` works through a streaming-input `Query`, AND capture what `modelUsage` actually looks like, before building anything on either. STOP-AND-REPORT if it does not.**

This is the plan's riskiest assumption and it has never been measured in this repo (§6e records it as an OPEN QUESTION at registration time). It is token-free: `ANTHROPIC_BASE_URL` points at an SSE stub, so no model is reached. Write it as a scratch script under `/mnt/d/tmp/`, not as a committed test. Round-4 I10 adds the `modelUsage` capture: the entire provenance chain turns on those keys, the check costs nothing here, and finding out at Task 9 costs a sized go.

```typescript
// /mnt/d/tmp/clear-probe.ts — token-free. Run: bun /mnt/d/tmp/clear-probe.ts
// Substitute the ABSOLUTE repo path for <repo> before running.
import os from "node:os"
import { stubServer } from "<repo>/cc-gate-plugin/test/sdk-stub.ts"
import { sseText } from "<repo>/cc-gate-plugin/test/agent-cli-stub.ts"

const CAPTURED: Array<Record<string, unknown>> = []
// The stub declares a DATED snapshot id, matching what the real API returns
// and what this repo's captured transcripts show
// (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22).
const STUB_MODEL = "claude-haiku-4-5-20251001"
const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", STUB_MODEL) })

const queue: unknown[] = []
let waiter: ((m: unknown) => void) | undefined
const push = (text: string) => {
  const m = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
  if (waiter) { const w = waiter; waiter = undefined; w(m) } else queue.push(m)
}
async function* feed(): AsyncGenerator<never> {
  for (;;) {
    const next = queue.shift()
    if (next !== undefined) { yield next as never; continue }
    yield (await new Promise((r) => { waiter = r })) as never
  }
}
const { query } = await import("@anthropic-ai/claude-agent-sdk")
const q = query({ prompt: feed(), options: {
  model: "claude-haiku-4-5", systemPrompt: "", settingSources: [],
  settings: { autoMemoryEnabled: false }, persistSession: false,
  strictMcpConfig: true, tools: [], title: "kkamak-gauge",
  thinking: { type: "disabled" }, cwd: os.tmpdir(),
  env: { ...process.env, ANTHROPIC_BASE_URL: cap.url } as Record<string, string>,
} })

const seen: string[] = []
const usages: unknown[] = []
const done = (async () => { for await (const m of q) {
  seen.push(m.type === "system" ? `system/${(m as { subtype?: string }).subtype}` : m.type)
  if (m.type === "result") usages.push((m as { modelUsage?: unknown }).modelUsage)
} })()

push("MARKER-ONE please answer")
await new Promise((r) => setTimeout(r, 8_000))
push("/clear")
await new Promise((r) => setTimeout(r, 6_000))
push("MARKER-TWO please answer")
await new Promise((r) => setTimeout(r, 8_000))

console.log("message types:", JSON.stringify(seen))
console.log("requests:", CAPTURED.length)
console.log("2nd request carries MARKER-ONE?:",
  JSON.stringify((CAPTURED[1] as { messages?: unknown })?.messages ?? []).includes("MARKER-ONE"))
console.log("2nd request messages:", JSON.stringify((CAPTURED[1] as { messages?: unknown })?.messages ?? []))
console.log("2nd request bytes:", JSON.stringify(CAPTURED[1] ?? {}).length)
console.log("modelUsage per result:", JSON.stringify(usages))
q.close(); cap.stop(); process.exit(0)
```

**PASS requires ALL FOUR:**
1. `seen` contains `"conversation_reset"` after the `/clear` push.
2. `CAPTURED.length === 2` — the `/clear` itself made NO model call.
3. The second request does NOT contain `MARKER-ONE`.
4. Every `result`'s `modelUsage` is a non-empty object, and at least one of its keys `k` satisfies `modelProvenBy(k, "claude-haiku-4-5", usage[k].canonicalModel)` — i.e. `k === "claude-haiku-4-5"`, or `k.startsWith("claude-haiku-4-5-")` (the expected dated case), or `canonicalModel === "claude-haiku-4-5"`.

**On PASS:** record the observed `seen` sequence, `CAPTURED.length`, the second request's `messages` array and byte size, AND the verbatim `modelUsage` objects (keys + `canonicalModel` + `outputTokens`) in the SDD progress note, then proceed to Step 1. The recorded keys are what the Task 4 dated-key test and Task 9's expectations are calibrated against.
**On ANY FAILURE: STOP. Do not proceed to Step 1, do not improvise.** Report which of the four failed and the observed `seen` sequence. Realistic outcomes and what they mean: no `conversation_reset` ⇒ slash commands are not processed on streaming input under this option set, and the whole lane is unbuildable as designed; three requests ⇒ `/clear` costs a model call, which breaks §4 outright; `MARKER-ONE` present ⇒ `/clear` does not reset the transcript in this mode; `modelUsage` empty or keyed by something `modelProvenBy` cannot reconcile ⇒ §6e's provenance rule has no evidence channel and the matching rule must be re-derived from the observed shape BEFORE any code depends on it — which is exactly the failure that would otherwise surface as ten consumed calls and zero records in Task 9. In every case the correct output is a report and an amendment to §6e recording what was actually observed — that is a complete outcome, and it costs zero tokens to reach.

- [ ] **Step 1: Write the failing tests** (every one obeys §6e's law; every one carries `CLI_TEST_TIMEOUT_MS` and the credentials skip-guard; **no `turnTimeoutMs` below `CLI_SPAWN_BUDGET_MS`**)

```typescript
import { describe, expect, test } from "bun:test"
import { WarmSession } from "../src/gauge/warm-session.ts"
import { modelProvenBy, CLI_SPAWN_BUDGET_MS } from "../src/gauge/acp-wire.ts"
import {
  HAS_CLAUDE_CODE_CREDENTIALS, sseText, silentServer, hangFirstServer, until,
} from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

// Raised from 60s: with turnTimeoutMs floored at CLI_SPAWN_BUDGET_MS (8s),
// a hard-reset test's worst case is ~8s + hardGrace + a full respawn + a
// second turn — comfortably over 60s only if something is wrong, but the
// margin has to exist or a slow host produces a false failure.
const CLI_TEST_TIMEOUT_MS = 90_000
const HAIKU = "claude-haiku-4-5"
// What the real API and this repo's captured transcripts actually key
// modelUsage by (opencode-plugin/test/fixtures/drivers/claude-code/
// success.ndjson:22). Step 1a recorded the observed value; use THAT if it
// differed.
const HAIKU_DATED = "claude-haiku-4-5-20251001"
// §6e/round-4 C3: the turn's timers start at the PUSH while the subprocess
// is still booting (§6d measured 1.25-1.46s). Every override below uses
// this floor; only hardGraceMs and queueWaitMs may be small, because
// neither measures generation.
const T = CLI_SPAWN_BUDGET_MS       // 8_000

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("WarmSession (spawns bundled CLI)", () => {
  test("two records reuse one subprocess; the second context is clean; exactly one call each", async () => {
    let n = 0
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText(`ANSWER-${++n}`, HAIKU_DATED) })
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
      // ~423 B `/clear` echo residue whose shape was never measured, and a
      // hard toBe(1) would fail a correct implementation. Step 1a already
      // recorded the observed count; pin it here in a follow-up commit.
      expect(JSON.stringify(m2.messages)).not.toContain("first record prompt")
      expect(JSON.stringify(m2.messages)).toContain("second record prompt")
      expect(m2.messages.length).toBeLessThanOrEqual(2)      // bulk-history regression guard
      expect(ws.isWarm()).toBe(true)                         // no respawn between records
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("ROUND-4 C1 LOCK: a DATED modelUsage key is evidence for the undated request", async () => {
    // The single most expensive defect this plan can ship. The real API keys
    // modelUsage by the dated snapshot id while the deriver requests the
    // undated alias; a strict-equality proof would report call-consumed for
    // EVERY honest turn, and Task 9 would spend a whole sized go for zero
    // records. WarmSession must report the KEY as evidence and let
    // modelProvenBy reconcile it — not compare, and not echo the request.
    const cap = stubServer(() => sseText("ANSWER", HAIKU_DATED))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("dated key record", HAIKU, { recycle: true })
      expect(r.kind).toBe("ok")
      if (r.kind !== "ok") return
      expect(r.model).toBe(HAIKU_DATED)                      // the KEY, verbatim
      expect(r.model).not.toBe(HAIKU)                        // NOT the request echoed back
      expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(true)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("a result whose modelUsage proves a DIFFERENT model is call-consumed, never ok", async () => {
    // The other side of the same rule: evidence that does not reconcile is
    // a consumed call with no stampable record, never a silent stamp.
    const cap = stubServer(() => sseText("ANSWER", "claude-opus-5-20260101"))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("wrong model record", HAIKU, { recycle: true })
      // WarmSession reports the evidence; it does NOT adjudicate. A turn
      // that produced text with usable evidence is `ok` and the CALLER
      // rejects it (Task 7). What must never happen is `ok` with the
      // requested model echoed as if proven.
      if (r.kind === "ok") {
        expect(modelProvenBy(r.model, HAIKU, r.canonicalModel)).toBe(false)
      } else {
        expect(r.kind).toBe("call-consumed")
      }
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("recycle:false keeps context (ACP multi-prompt session semantics)", async () => {
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU_DATED) })
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
    // Wall clock: r1 pushes at t0, the subprocess reaches the stub by
    // ~t0+1.5s and hangs; the turn timer fires at t0+8s (interrupt) and the
    // hard timer at t0+12s at the latest. r2 then runs on a warm-or-fresh
    // session with its OWN 8s budget, which covers a respawn. ~22s worst
    // case, well inside the 90s test timeout.
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r1 = await ws.oneShot("hanging record", HAIKU, { recycle: true })
      expect(r1.kind).toBe("call-consumed")                  // NOT ok, NOT no-call
      expect("text" in r1).toBe(false)                       // no truncated text escapes
      const r2 = await ws.oneShot("normal record", HAIKU, { recycle: true })
      expect(r2.kind).toBe("ok")
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L6: a 500 (api_retry) is call-consumed and the retry is never consumed as a result", async () => {
    let n = 0
    const cap = stubServer(() => (++n === 1 ? new Response("boom", { status: 500 }) : sseText("ANSWER", HAIKU_DATED)))
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    try {
      const r = await ws.oneShot("retry-provoking record", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
      expect(n).toBeLessThanOrEqual(2)   // the abort races an in-flight retry; a THIRD request means it never landed
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("law L5 has NO connection-only exception: an unreachable endpoint AFTER the push is call-consumed", async () => {
    // Round-3 finding C1. An earlier draft classified `api_retry` with
    // `error_status === null` as no-call, on the theory that a
    // connection-level failure proves nothing reached the model.
    // sdk.d.ts:2839-2841 documents that status as covering "connection
    // errors (e.g. TIMEOUTS) that had no HTTP response" — and a read
    // timeout is exactly the billed-but-unanswered case, so that carve-out
    // could spend a SECOND model call on one record. It also bought
    // nothing: the daemon and its clients are fingerprint-matched on the
    // same endpoint, so an endpoint the daemon cannot reach the fallback
    // cannot reach either. This test is the lock on its removal.
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: "http://127.0.0.1:9" },
      { turnTimeoutMs: T, hardGraceMs: 4_000 })
    try {
      const r = await ws.oneShot("x", HAIKU, { recycle: true })
      expect(r.kind).toBe("call-consumed")
    } finally { ws.close() }
  }, CLI_TEST_TIMEOUT_MS)

  test("FIFO: concurrent oneShots serialize; BOTH resolve; two calls total", async () => {
    // The queued caller's promise must resolve. A design that lets execute()
    // overwrite the queue-waiter's resolver deadlocks here.
    // queueWaitMs is raised explicitly so this test measures FIFO, not the
    // queue cap: turn A pays a ~1.5s spawn plus a response, and the DEFAULT
    // 6s cap would make the assertion depend on host speed. The cap itself
    // has its own dedicated test below.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU_DATED) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { queueWaitMs: 60_000 })
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
    // queueWaitMs is the ONLY short timer here — it measures queue
    // residency, not generation, so it is not bound by CLI_SPAWN_BUDGET_MS.
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 500 })
    try {
      const first = ws.oneShot("occupies the session", HAIKU, { recycle: true })
      const queued = await ws.oneShot("never gets its turn", HAIKU, { recycle: true })
      expect(queued.kind).toBe("no-call")        // never reached execute()
      await first                                 // drain, whatever it becomes (<= ~10s)
      expect(cap.count()).toBe(1)                 // the queued turn sent NOTHING
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancel(tag) drops only that caller's turn, never the other caller's in-flight turn", async () => {
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
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

  test("cancel scoping, WRONG-OWNER shape: a cancel naming the QUEUED turn's tag never reaches the IN-FLIGHT turn", async () => {
    // Round-3 finding C2's regression lock. The sibling test above puts the
    // named turn in `pending`, which `cancel()` searches FIRST — so it
    // passes even when tags collide across callers. This one names a tag
    // that ONLY the in-flight turn holds while a DIFFERENT-tagged turn is
    // queued, and then a tag that nobody holds, proving the search never
    // falls through to "whoever happens to be current". Task 5 additionally
    // mints globally-unique tags so a collision cannot arise on the wire.
    //
    // Round-4 I11: the `until(...)` gate is REQUIRED. `cancel` on a turn
    // that has not yet PUSHED is `unsent-dropped`, not `interrupted` — a
    // correct implementation, since cancelling must never be what causes a
    // model call. Waiting for the stub to see A's request is the only
    // observable proof A crossed the send boundary, and the CLI takes
    // 1.25-1.46s to get there.
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      const inflight = ws.oneShot("A in flight", HAIKU, { recycle: true, tag: "tag-A" })
      const queued = ws.oneShot("B queued", HAIKU, { recycle: true, tag: "tag-B" })
      expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)   // A has been SENT
      expect(ws.cancel("tag-C")).toBe("unknown")       // nobody: must be a no-op
      expect(ws.cancel("tag-A")).toBe("interrupted")   // the in-flight turn, by ITS OWN tag
      const a = await inflight
      expect(a.kind).toBe("call-consumed")             // it was SENT; never no-call
      const b = await queued
      expect(b.kind === "ok" || b.kind === "no-call").toBe(true)   // untouched by A's cancel
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("cancelling a turn BEFORE it pushes drops it — a cancel must never cause a model call", async () => {
    // Round-4 I11's direct lock. `this.current` is assigned BEFORE the
    // recycle leg, so for up to clearTimeoutMs a turn is current-but-unsent.
    // The old design interrupted there, left `done` false, and let execute()
    // push the prompt a moment later: the cancel CAUSED the spend it was
    // asked to prevent, and the interrupt() may have aborted the in-flight
    // /clear instead of a turn.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU_DATED) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 2_000, queueWaitMs: 60_000 })
    try {
      // Turn 1 warms the session so turn 2 takes the /clear path (the window
      // this test needs); wait for it to finish.
      expect((await ws.oneShot("warm the session", HAIKU, { recycle: true })).kind).toBe("ok")
      const before = CAPTURED.length                     // 1
      const second = ws.oneShot("must never be sent", HAIKU, { recycle: true, tag: "C" })
      // Cancel immediately: the turn is current, the /clear is in flight,
      // nothing has been pushed for THIS turn.
      const verdict = ws.cancel("C")
      expect(verdict === "unsent-dropped" || verdict === "queued-dropped").toBe(true)
      expect((await second).kind).toBe("no-call")        // provably unsent
      await new Promise((r) => setTimeout(r, 2_000))     // let any stray push land
      expect(CAPTURED.length).toBe(before)               // ZERO extra model calls
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("a hardReset with a turn QUEUED behind it does not kill the replacement session", async () => {
    // Round-3 finding C3's regression lock. hardTimer fires ~1ms after the
    // turn timer, so hardReset() lands while interrupt() is still in
    // flight; the OLD pump's `for await` only unwinds on the subprocess
    // exit event, by which time drain() has already started turn B on a
    // NEW Query. Without the `this.q !== q` generation guard the dying pump
    // settles B and destroys B's session.
    //
    // Round-4 C3: turnTimeoutMs is 8_000, NOT 1_000. At 1_000 turn A is
    // hard-reset before its request ever reaches the stub (the subprocess
    // takes 1.25-1.46s to boot), so B becomes the stub's FIRST request and
    // hangs, and a CORRECT implementation fails this test deterministically.
    // Wall clock now: A pushes at t0, reaches the stub ~t0+1.5s and hangs;
    // timer at t0+8s, hardTimer at t0+8.001s; B runs on a fresh Query,
    // pushes at ~t0+8s, reaches the stub ~t0+9.5s as request #2 and is
    // answered — inside B's own 8s budget. ~10s total.
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: T, hardGraceMs: 1, queueWaitMs: 60_000 })
    try {
      const a = ws.oneShot("A hangs and is hard-reset", HAIKU, { recycle: true })
      const b = ws.oneShot("B must survive the teardown", HAIKU, { recycle: true })
      expect((await a).kind).toBe("call-consumed")   // A was sent
      expect((await b).kind).toBe("ok")              // B ran on the REPLACEMENT Query
      expect(ws.isWarm()).toBe(true)                 // and that Query is still alive
      expect(cap.count()).toBe(2)
    } finally { ws.close(); cap.stop() }
  }, CLI_TEST_TIMEOUT_MS)

  test("close() settles every outstanding caller — no hanging promises", async () => {
    const cap = hangFirstServer("ANSWER", HAIKU_DATED)
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url },
      { turnTimeoutMs: 30_000, hardGraceMs: 5_000, queueWaitMs: 60_000 })
    const inflight = ws.oneShot("A", HAIKU, { recycle: true })
    const queued = ws.oneShot("B", HAIKU, { recycle: true })
    // Deterministic instead of a fixed sleep: close only once A has crossed
    // the send boundary, so `call-consumed` is an assertion rather than a
    // coin flip on spawn latency (round-4 C3/I10).
    expect(await until(() => cap.count() >= 1, 30_000)).toBe(true)
    ws.close()
    const [a, b] = await Promise.all([inflight, queued])
    expect(a.kind).toBe("call-consumed")            // sent, therefore consumed
    expect(b.kind).toBe("no-call")                  // queued: provably unsent
    expect(ws.isWarm()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)

  test("close() during the SDK import does not spawn a subprocess or send anything", async () => {
    // Round-4 I3. `ensure()` checked `this.closed` only at entry, so a
    // close landing inside `await import(...)` was followed by a Query
    // construction, a CLI spawn and a real push: a LEAKED subprocess and a
    // spent model call on a terminated session, with isWarm() true after
    // close(). The import is the widest such window (~84ms measured) and
    // this test drives it directly.
    const CAPTURED: Array<Record<string, unknown>> = []
    const cap = stubServer((c) => { CAPTURED.push(c.body); return sseText("ANSWER", HAIKU_DATED) })
    const ws = new WarmSession({ ...process.env, ANTHROPIC_BASE_URL: cap.url })
    const p = ws.oneShot("must never reach the model", HAIKU, { recycle: true })
    ws.close()                                       // same tick as the enqueue
    expect((await p).kind).toBe("no-call")
    await new Promise((r) => setTimeout(r, 3_000))   // generous: a leaked spawn would land here
    expect(CAPTURED.length).toBe(0)
    expect(ws.isWarm()).toBe(false)
    expect(ws.turnInFlight()).toBe(false)
    cap.stop()
  }, CLI_TEST_TIMEOUT_MS)
})
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts`
Expected: FAIL — `Export named 'WarmSession' not found`

- [ ] **Step 3: Implement `warm-session.ts`** — this skeleton is the design, not a sketch

```typescript
// §6e WarmSession: one streaming-input Query, ONE persistent message pump
// BOUND TO ITS QUERY GENERATION, a lossless pushable input queue, /clear
// recycling SEQUENCED on the SDK's own conversation_reset message, FIFO
// turns, every wait capped, close() observed at every suspension point,
// and three-way outcomes that implement §6e's wire-send boundary law
// mechanically.
//
// Isolation options are the §6d set (agent-transport.ts:119-132) with TWO
// registered deltas (§6e):
//  (a) REMOVED `maxTurns: 1` + `abortController` — query-scoped, cannot
//      transfer to a many-turn session (maxTurns, sdk.d.ts:1674-1678, would
//      stop the whole Query after record #1; aborting the shared controller
//      would kill every later turn). Replaced by per-turn call accounting +
//      interrupt().
//  (b) ADDED a neutral `cwd` — §6d measured it payload-neutral (spec line
//      690) and agent-transport.ts:41-44 omits it as redundant for a
//      one-shot; for a host-global daemon it is what stops the instrument
//      varying with whichever session spawned it.
//
// Lazy SDK VALUE import (hook processes must not pay the ~84 ms package
// load; same finding as agent-transport.ts:102-108). The `import type`
// below is erased and costs nothing.
import os from "node:os"
import type { Query, SDKMessage, SDKUserMessage } from "@anthropic-ai/claude-agent-sdk"
import { ACP_BUDGET, CLI_SPAWN_BUDGET_MS, modelProvenBy } from "./acp-wire.ts"

export type TurnOutcome =
  | { kind: "ok"; text: string; model: string; canonicalModel: string }
  | { kind: "no-call" }
  | { kind: "call-consumed" }

export type CancelResult = "queued-dropped" | "unsent-dropped" | "interrupted" | "unknown"

interface Turn {
  text: string
  model: string
  recycle: boolean
  /** MUST be globally unique across callers. Task 5 mints a UUID; a
   * per-connection JSON-RPC request id would collide across connections and
   * let one caller's cancel interrupt another caller's billed turn. */
  tag: string | undefined
  /** THE §6e send boundary, daemon-side, and the WHOLE classification:
   * `consumed(t) === t.sent`. True once this turn's prompt frame has been
   * pushed into the CLI's input stream. */
  sent: boolean
  /** DIAGNOSTIC ONLY (progress notes / strayMessages triage). These used to
   * feed the outcome via a `connectionOnly` carve-out; round 3 removed it
   * because sdk.d.ts:2839-2841's `error_status: null` covers billed
   * timeouts as well as refused connects. Do not reintroduce them into
   * `consumed()`. */
  sawModelActivity: boolean
  sawApiResponse: boolean
  /** interrupted / retry-cancelled: settle from the TERMINAL result, never
   * `ok`, and never at the moment of cancellation (law L7) */
  doomed: boolean
  done: boolean
  /** EVIDENCE, not a verdict: the modelUsage KEY this turn ran under, and
   * that entry's canonicalModel. The CALLER reconciles them against its
   * requested id with modelProvenBy — the key is routinely a DATED snapshot
   * of the requested alias (round-4 C1). */
  observedModel: string
  observedCanonical: string
  /** assistant `message.model`. DIAGNOSTIC ONLY — never promoted to a
   * stamp, or the provenance rule becomes an echo again. */
  corroboratedModel: string
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
    // Round-4 M12: DROP anything still queued. The stream() loop drains the
    // queue before it consults `closed`, so leaving items here would feed a
    // Query that is being torn down.
    this.queue.length = 0
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
  // sdk.d.ts:4583-4586 — `type`, `message` and `parent_tool_use_id` are the
  // only required fields; `uuid`/`session_id` are optional (:4617-4618).
  return { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null }
}

/** DIAGNOSTIC model id off an assistant message (`message.model`). The ONLY
 * evidence channel is the terminal result's `modelUsage` keys
 * (sdk.d.ts:4312 success / :4279 error) — see route(). */
function assistantModel(m: SDKMessage): string {
  const model = (m as { message?: { model?: unknown } }).message?.model
  return typeof model === "string" ? model : ""
}

/** Race `p` against `ms`; resolves false on timeout, false on rejection.
 * Used for setModel, which the SDK exposes as an UN-TIMED control
 * round-trip (sdk.d.ts:2327): without a cap a wedged subprocess hangs
 * execute() with no timer armed, the turn never settles, turnInFlight()
 * stays true forever, and the host-global daemon is permanently dead. */
async function within(p: Promise<unknown>, ms: number): Promise<boolean> {
  let t: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      p.then(() => true, () => false),
      new Promise<boolean>((res) => { t = setTimeout(() => res(false), ms) }),
    ])
  } finally {
    if (t) clearTimeout(t)
  }
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
  private readonly setModelMs: number
  private readonly hardGraceMs: number
  private readonly cwd: string

  constructor(
    private readonly env: Record<string, string | undefined>,
    opts: {
      turnTimeoutMs?: number
      queueWaitMs?: number
      clearTimeoutMs?: number
      setModelMs?: number
      hardGraceMs?: number
      cwd?: string
    } = {},
  ) {
    // §6e instrument invariant / round-4 C3: a turn's timers start at the
    // PUSH while the CLI subprocess is still booting (§6d measured
    // 1.25-1.46 s). Clamping here rather than trusting callers means no
    // configuration, test seam or future caller can create a session that
    // cannot tell "generation failed" from "not started yet".
    this.turnTimeoutMs = Math.max(CLI_SPAWN_BUDGET_MS, opts.turnTimeoutMs ?? ACP_BUDGET.turnTimeoutMs)
    this.queueWaitMs = opts.queueWaitMs ?? ACP_BUDGET.queueWaitMs
    this.clearTimeoutMs = opts.clearTimeoutMs ?? ACP_BUDGET.clearTimeoutMs
    this.setModelMs = opts.setModelMs ?? ACP_BUDGET.setModelMs
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
        doomed: false,
        done: false,
        observedModel: "",
        observedCanonical: "",
        corroboratedModel: "",
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
      if (!c.sent) {
        // §6e L4/L7, round-4 I11: the turn is CURRENT but has not crossed
        // the send boundary — it is inside ensure/setModel/awaitClear.
        // DROP it. Interrupting here would abort the in-flight /clear
        // rather than a turn, leave `done` false, and let execute() push
        // the prompt a moment later: the cancel would CAUSE the model call
        // it was asked to prevent. finish() sets `done`, and execute()'s
        // post-await `turn.done` check makes the push unreachable.
        this.finish(c, { kind: "no-call" })
        return "unsent-dropped"
      }
      c.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
      return "interrupted"
    }
    // A cancel that names nobody must NEVER interrupt whoever happens to be
    // in flight — with one global FIFO that would be another caller's turn,
    // and that caller's model call is already billed.
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
    // NOTE: a turn suspended inside ensure()/setModel()/awaitClear() is not
    // `current` yet or is current-but-unsettled; every one of those awaits
    // re-checks `this.closed` on resume and settles itself (round-4 I3), so
    // no caller is left hanging and no post-close spawn or push happens.
  }

  // ── internals ────────────────────────────────────────────────────────

  /** §6e law L4/L5, mechanically and completely: the send boundary IS the
   * classification. A turn that pushed its prompt consumed a call; a turn
   * that did not, did not. Round 3 removed the `connectionOnly` carve-out —
   * sdk.d.ts:2839-2841's `error_status: null` covers billed timeouts as
   * well as refused connects, so the carve-out could spend a second model
   * call on one record. Do not reintroduce it. */
  private consumed(t: Turn): boolean {
    return t.sent
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
        if (this.closed) {                     // round-4 I3
          this.finish(turn, { kind: "no-call" })
          continue
        }
        await this.execute(turn)               // ALWAYS resolves, via finish()
      }
    } finally {
      this.draining = false
    }
  }

  /** Ensure a live Query + pump. Returns false when the session cannot be
   * started at all (law L4 — nothing was pushed).
   *
   * The `this.closed` check appears TWICE, deliberately (round-4 I3): once
   * at entry, and once after the package import resolves. With only the
   * entry check, a close() landing inside that ~84 ms window is followed by
   * a Query construction, a CLI subprocess spawn and — via execute() — a
   * real prompt push: a leaked subprocess and a spent model call on a
   * session the caller already terminated, with isWarm() reporting true
   * after close(). §6e law L7's last paragraph names this. */
  private async ensure(model: string): Promise<boolean> {
    if (this.closed) return false
    if (this.q) return true
    try {
      const { query } = await import("@anthropic-ai/claude-agent-sdk")
      if (this.closed) return false            // closed during the import: build nothing
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
      if (this.closed) {                       // closed during construction
        try { q.close() } catch { /* nothing more to do */ }
        feed.close()
        return false
      }
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

  /** THE ONE PUMP, BOUND TO ITS GENERATION. `Query` is an AsyncGenerator
   * (sdk.d.ts:2279), so exiting a `for await` calls `.return()` and
   * terminates it — a per-turn loop would kill the warm session at the end
   * of record #1.
   *
   * The `this.q !== q` guards are §6e law L7's other half, and they are NOT
   * defensive padding: `close()` is synchronous (sdk.d.ts:2584) but this
   * generator only unwinds on the subprocess exit event, an I/O tick later.
   * By then finish() has resolved execute()'s wait, drain() has shifted the
   * NEXT turn, and ensure() has built a NEW Query. An unguarded teardown
   * would settle that fresh turn as call-consumed and destroy its session —
   * a lost record and a lost model call, mid-batch. */
  private async runPump(q: Query): Promise<void> {
    try {
      for await (const m of q) {
        if (this.q !== q) return           // superseded: never route into a newer generation
        this.route(m)
      }
    } catch {
      /* the query died; settled below */
    } finally {
      if (this.q === q) {
        const w = this.resetWaiter
        this.resetWaiter = undefined
        w?.(false)
        const t = this.current
        if (t && !t.done) this.finish(t, { kind: this.consumed(t) ? "call-consumed" : "no-call" })
        this.hardReset()
      }
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

    // §6e L6/L7 + round-4 M11: NOTHING below may act on a turn that has not
    // crossed the send boundary. Messages arriving in that window belong to
    // the /clear leg or to a previous turn's tail; letting them mark an
    // unsent turn `doomed` or fire interrupt() would poison a turn that has
    // spent nothing and could abort an in-flight /clear.
    if (!t.sent) { this.strayMessages++; return }

    if (m.type === "assistant") {
      t.sawModelActivity = true                  // diagnostic only
      const am = assistantModel(m)
      if (am) t.corroboratedModel = am           // DIAGNOSTIC — never a stamp
    }

    if (m.type === "system" && (m as { subtype?: string }).subtype === "api_retry") {
      // sdk.d.ts:2842-2852. `error_status !== null` => the API answered =>
      // law L6. `error_status === null` => a connection error with no HTTP
      // response, which sdk.d.ts:2839-2841 says includes TIMEOUTS — i.e.
      // possibly a billed call — so once the prompt was pushed it is law
      // L5, consumed, exactly like the non-null case. The status is
      // recorded for diagnostics and changes NOTHING about the outcome.
      const status = (m as { error_status?: number | null }).error_status
      if (status !== null && status !== undefined) t.sawApiResponse = true
      // The CLI auto-retries internally; that retry would be call #2 (§6d
      // finding, agent-transport.ts:135-145). Cancel now — but DO NOT
      // settle: law L7 settles from the turn's OWN terminal result, so no
      // trailing message can ever be attributed to the NEXT turn.
      t.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
      return
    }

    if (m.type === "result") {
      const r = m as {
        subtype?: string
        is_error?: boolean
        result?: unknown
        modelUsage?: Record<string, { outputTokens?: number; output_tokens?: number; canonicalModel?: string }>
      }
      // EVIDENCE (§6e provenance): the keys of `modelUsage` on the terminal
      // result (sdk.d.ts:4312 success, :4279 error) plus each entry's
      // `canonicalModel` (sdk.d.ts:1274-1277). `corroboratedModel` is NEVER
      // consulted here — promoting corroboration to proof when usage is
      // missing would quietly restore the tautology the rule exists to
      // remove.
      //
      // The match is modelProvenBy, NOT equality: the real API keys this by
      // the DATED snapshot id while the deriver requests the undated alias
      // (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22),
      // so an equality test would report call-consumed for every honest
      // turn and spend a whole sized go for zero records (round-4 C1).
      const usage = r.modelUsage ?? {}
      const keys = Object.keys(usage)
      const outOf = (k: string): number => {
        const u = usage[k]
        return Number(u?.outputTokens ?? u?.output_tokens ?? 0)
      }
      t.observedModel = ""
      t.observedCanonical = ""
      if (keys.length === 1 && keys[0]) {
        // Single key: it IS the turn's evidence, whatever it is spelled.
        // The caller reconciles it (Task 7). Reporting it verbatim is what
        // makes a genuine model divergence detectable at all.
        t.observedModel = keys[0]
        t.observedCanonical = usage[keys[0]]?.canonicalModel ?? ""
      } else if (keys.length > 1) {
        // An auxiliary model (title/summarizer) must not make an honest
        // turn unprovable. Pick the key that PROVES the requested model
        // under §6e's matching rule, and accept it only if every OTHER key
        // recorded zero output tokens — the evidence still comes from the
        // result, never from the request.
        const own = keys.find((k) => modelProvenBy(k, t.model, usage[k]?.canonicalModel))
        if (own && keys.filter((k) => k !== own).every((k) => outOf(k) === 0)) {
          t.observedModel = own
          t.observedCanonical = usage[own]?.canonicalModel ?? ""
        }
      }

      const success = r.subtype === "success" && r.is_error !== true && !t.doomed
      if (success && typeof r.result === "string" && r.result) {
        if (!t.observedModel) {
          // The call happened but the result carries no usable model
          // evidence; an unprovable stamp is worse than a retryable record.
          this.finish(t, { kind: "call-consumed" })
          return
        }
        this.finish(t, {
          kind: "ok",
          text: r.result,
          model: t.observedModel,
          canonicalModel: t.observedCanonical,
        })
        return
      }
      // SDKResultError carries no `result` (sdk.d.ts:4269-4288) and an
      // interrupted assistant message is `aborted` (sdk.d.ts:2870-2873) —
      // no partial text is ever accumulated here, let alone persisted.
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

  /** ONE turn, start to settle.
   *
   * ORDER IS LOAD-BEARING: ensure -> setModel cap -> `this.current`
   * assignment -> awaitClear -> push -> timers. `this.current` is assigned
   * BEFORE the recycle leg so a `session/cancel` naming this turn can find
   * it — which is exactly why `cancel()` must DROP an unsent current turn
   * rather than interrupt it (round-4 I11), and why `route()` ignores every
   * message while `sent === false` (round-4 M11).
   *
   * EVERY await is followed by a `this.closed || turn.done` re-check
   * (round-4 I3). Without them a close() landing inside the SDK import is
   * followed by a fresh subprocess and a real push, and a cancel landing
   * inside awaitClear() is followed by the push it was asked to prevent. */
  private async execute(turn: Turn): Promise<void> {
    // execute()'s OWN wait slot — never the caller's.
    const settled = new Promise<TurnOutcome>((res) => { turn.settle = res })

    if (!(await this.ensure(turn.model))) { this.finish(turn, { kind: "no-call" }); return }
    // Resumed after the package import / Query construction: a close() or a
    // cancel may have landed. finish() is done-guarded, so re-finishing an
    // already-settled turn is a no-op and the early return is safe.
    if (this.closed || turn.done) { this.finish(turn, { kind: "no-call" }); return }

    if (turn.model !== this.currentModel) {
      // setModel is streaming-only (sdk.d.ts:2327) and UN-TIMED. Cap it, or
      // one wedged subprocess hangs this await forever with no timer armed.
      const ok = await within(this.q!.setModel(turn.model), this.setModelMs)
      if (!ok || this.closed || turn.done) {
        this.hardReset()
        this.finish(turn, { kind: "no-call" })   // nothing pushed => law L4
        return
      }
      this.currentModel = turn.model
    }

    this.current = turn

    // Recycle FIRST and SEQUENCED. Recycle is the CALLER's decision so a
    // multi-prompt ACP session keeps its context.
    if (turn.recycle && !this.fresh) {
      const cleared = await this.awaitClear()
      if (turn.done) return                      // cancel/close settled it already
      if (this.closed) {
        this.hardReset()
        this.finish(turn, { kind: "no-call" })
        return
      }
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
    if (!feed || this.closed || turn.done) {
      if (!turn.done) this.finish(turn, { kind: "no-call" })
      return
    }
    feed.push(userMsg(turn.text))
    turn.sent = true                             // THE send boundary crosses here

    // Timers start AFTER the push, so the generation budget measures
    // generation and the /clear + setModel legs have their own caps
    // (§6e budget rule; all five legs sum to daemonWorstCaseMs). The CLI
    // subprocess spawn (1.25-1.46 s, §6d) also falls inside this window,
    // which is why `turnTimeoutMs` is clamped to CLI_SPAWN_BUDGET_MS in the
    // constructor (round-4 C3).
    turn.timer = setTimeout(() => {
      turn.doomed = true
      void this.q?.interrupt().catch(() => this.hardReset())
    }, this.turnTimeoutMs)
    turn.hardTimer = setTimeout(() => {
      // interrupt() itself hung. Destroy the Query + subprocess; the pump's
      // generation guard is what stops the dying pump from reaching the
      // NEXT turn (law L7).
      const consumed = this.consumed(turn)
      this.hardReset()
      this.finish(turn, { kind: consumed ? "call-consumed" : "no-call" })
    }, this.turnTimeoutMs + this.hardGraceMs)

    await settled
  }
}
```

- [ ] **Step 4: Run to verify they pass, and MEASURE the three things §6e left open**

Run: `cd cc-gate-plugin && bun test test/warm-session.test.ts` — 0 fail (on this credentialed host, none skipped).
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Record in the SDD progress notes:

(a) the measured first-record and steady-state per-record latency — §6e registered the 838 ms / ~20 ms figures as INDICATIVE and this is where they get their in-tree measurement. Record the observed CLI spawn component too: `CLI_SPAWN_BUDGET_MS = 8_000` is a floor derived from §6d's 1.25-1.46 s, and a materially larger observed spawn means the floor needs revisiting BEFORE Task 9, not after.

(b) **the §6e OPEN DISCREPANCY, resolved by measurement.** Capture the request body of a post-`/clear` warm turn AND of a fresh-spawn one-shot `agentSdkCall` turn under the same option set and the same prompt, and record `messages.length` and total byte size for BOTH. §6e attributes ~423 B of `/clear` echo to the warm lane; §6d's PER-CALLER paragraph (spec line 662) attributes the same ~423 B to the ONE-SHOT lane. **Whichever of the two statements the measurement contradicts is corrected in THIS task's commit** — amend §6e's residue paragraph, or spec line 662, or both, and say which in the commit message. Do not leave the spec self-contradictory past this task.

(c) **the `modelUsage` shape, as OBSERVED, against Step 1a's record.** Print the `modelUsage` object of one warm turn and confirm (i) which key form it uses, (ii) whether `canonicalModel` is populated, and (iii) that `modelProvenBy(key, "claude-haiku-4-5", canonicalModel)` is true. Step 1a recorded this before any code existed; this is the confirmation that `route()` reads the same thing the probe saw. **If the observed key form differs from `HAIKU_DATED` in the tests, update the test constant to the OBSERVED value — do not loosen `modelProvenBy`.** The predicate is the registered rule; the constant is a fixture.

Once (b) is measured, tighten the `toBeLessThanOrEqual(2)` guard to the exact observed value in a follow-up commit.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/warm-session.ts cc-gate-plugin/test/warm-session.test.ts \
        cc-gate-plugin/test/agent-cli-stub.ts cc-gate-plugin/test/gauge-agent-transport.test.ts \
        docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "feat(gauge): WarmSession — generation-bound pump, sequenced /clear, capped setModel, close-safe awaits, dated-key model evidence; resolve the 6d/6e /clear-residue discrepancy by measurement"
```

### Task 5: `acp-paths.ts` + `acp-daemon.ts` — socket server, ACP dispatcher, idle self-exit

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-paths.ts`
- Create: `cc-gate-plugin/src/gauge/acp-daemon.ts`
- Test: `cc-gate-plugin/test/acp-paths.test.ts`, `cc-gate-plugin/test/acp-daemon.test.ts`

**Why a separate `acp-paths.ts`.** `acp-client.ts` (Task 6) needs `socketPath`/`ensureSocketDir`/`envFingerprint`, and `hook-cli.ts` imports `acp-client.ts` on SessionStart. If those helpers lived in `acp-daemon.ts`, the hook would transitively import the daemon module — and any top-level side effect there (a `net.createServer`, the reaper's `setInterval`) would run INSIDE the hook process, on the one code path whose prime directive is to never affect a session. `acp-daemon.ts` additionally guards all of its runtime behaviour behind `if (import.meta.main)`.

**Interfaces (`acp-paths.ts`):**
- `ACP_ENV_DENYLIST` — the enumerated set of env keys EXCLUDED from the §6e fingerprint. Everything else in the environment is included. This is the inverse of the rejected five-key allow-list: an allow-list leaves `ANTHROPIC_MODEL`, `ANTHROPIC_SMALL_FAST_MODEL`, `HTTP_PROXY`/`HTTPS_PROXY`/`NO_PROXY` and every `CLAUDE_CODE_*` toggle free to change the instrument without changing the fingerprint, which is exactly what the fingerprint exists to prevent. The denylist has TWO classes and §6e states both: per-process VOLATILE (the shell/terminal/ssh/tmux group), and NOT-AN-INSTRUMENT-PARAMETER — `KKAMAK_ACP_IDLE_MS` and `KKAMAK_ACP_TEST_SPAWN_LOG` (daemon OPERATING parameters), `KKAMAK_ACP_SOCKET` (an ENDPOINT ADDRESS) and `KKAMAK_GAUGE_TRANSPORT` (a LANE SELECTION). **Round-4 I4: the last two are new and load-bearing.** With `KKAMAK_GAUGE_TRANSPORT` in the hash, the post-flip live path — which FORCES that value into a derived env (Task 10) — can never match a daemon started from an ambient env that does not carry it, and because `daemonCall` never spawns, that mismatch is not "an extra daemon" but a permanent silent `no-call` on every record. With `KKAMAK_ACP_SOCKET` in the hash, every test and every dedicated-socket run (Task 9) makes the client and its own daemon disagree. `KKAMAK_ACP_TURN_TIMEOUT_MS` is RULED IN (not denylisted) deliberately: it changes when a generation is cut off, hence which turns produce a derivation, hence the instrument — a daemon running a different turn budget must not be adopted by a client expecting the registered one. Task 9's procedure is written knowing all of this (a differing idle budget will NOT produce a second socket, which is why the validation run binds its own socket path explicitly).
- `ACP_SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i` — any env key whose NAME matches contributes `NAME=set` / `NAME=unset` instead of its value. Secrets never enter a filename, a log, or a wire frame; only their presence does. No `g` flag, deliberately: a global regex carries `lastIndex` across `.test()` calls and would return alternating results on the same key.
- `envFingerprint(env: Record<string, string | undefined>): string` — first 12 hex of `sha256` over `k=v\n` lines, keys sorted, denylist removed, secret-named keys reduced to presence.
- `socketPath(env): string` — `env.KKAMAK_ACP_SOCKET` when set; else on `win32` the named pipe `\\.\pipe\kkamak-acp-${os.userInfo().username}-${envFingerprint(env)}`; else `path.join(homedir(), ".config", "kkamak", "acp-${envFingerprint(env)}.sock")` — the repo's documented host-local store (CLAUDE.md). `~/.kkamak/` is NOT used: it does not exist and is not a repo convention. **The fingerprint in the filename is a convenience, not the guarantee**: `KKAMAK_ACP_SOCKET` bypasses it, so the binding check is the `initialize` echo (Task 6), which always runs.
- `spawnLockPath(env): string` / `bindLockPath(env): string` — `<socketPath>.spawn.lock` / `<socketPath>.bind.lock`. **Two distinct files, deliberately.** The client holds the SPAWN lock across "decide to spawn → daemon answers initialize"; the daemon holds the BIND lock across "probe → unlink → rebind". One shared file would deadlock: the client would still be holding it while the daemon it just started tried to take it to bind.
- `ensureSocketDir(p: string): void` — `mkdirSync(dirname(p), { recursive: true, mode: 0o700 })` before any `listen` or lock create. Without this the default path fails `ENOENT` on a fresh host. No-op for a named pipe. **May throw** (EACCES on an unwritable parent) — every caller wraps it, and `ensureDaemon`'s "NEVER throws" contract (Task 6) is what makes the fail-open SessionStart test pass with `KKAMAK_ACP_SOCKET=/nonexistent-dir/x.sock`.
- `ACP_LOCK_STALE_MS = 30_000`, plus `tryCreateLock(lockPath, content)` / `isLockStale(lockPath, now)` / `acquireAcpLock(lockPath, now)` / `releaseAcpLock(lockPath)` — signatures deliberately IDENTICAL in shape to `corpus-store.ts:134-143` (`tryCreateLock(lockPath, content)`), `:149-158` (`isLockStale(lockPath, now)`) and `:164-177` (`acquireLock`'s unlink-then-ONE-retry — note the range ends at 177, the closing `return tryCreateLock(...)`; round-4 M9 corrects an earlier `:164-176`). Content `{ pid, ts }`; stale / vanished / torn all collapse to the same takeover path; losing the retry race is a refusal, never "overwrite and assume ownership". Like its model, `tryCreateLock` RETHROWS anything that is not `EEXIST` — callers own the fail-open wrapping. Every caller passes `now` explicitly — do not drop the parameter, or the two modules stop being comparable and a later reader cannot check one against the other.

**Interfaces (`acp-daemon.ts`):**
- Runnable ONLY under `import.meta.main`: `bun src/gauge/acp-daemon.ts` (socket mode, default) and `bun src/gauge/acp-daemon.ts --stdio` (same dispatcher bound to stdin/stdout, serving the SAME private instrument profile — see Task 2's scope note; NOT for off-the-shelf editors). **The absolute path of this file is what `ensureDaemon` spawns** (Task 6), resolved as `path.join(import.meta.dir, "acp-daemon.ts")` from `acp-client.ts` — the same sibling-resolution idiom as `spawn.ts:12`'s `REFINER_CLI`. It must never be resolved relative to a caller's `cwd`.
- **The daemon fingerprints and binds from `process.env`, and that is a CONTRACT with the spawner.** `envFingerprint(process.env)` and `socketPath(process.env)` are both computed from the daemon's own inherited environment. A spawner that fingerprints one env object and then launches the daemon with a *different* one produces a daemon that binds a different path and echoes a different fingerprint — permanent mutual refusal. Round-4 I2 makes this explicit here because the repo's established spawn idiom (`hook-cli.ts:147-154`) passes NO `env` to `Bun.spawn` and therefore inherits `process.env`; Task 6's `ensureDaemon` must pass the env it fingerprints, explicitly.
- **Every socket gets `socket.setEncoding("utf8")` immediately after accept** (and the client does the same on connect). `FrameDecoder` is already UTF-8-boundary-safe via `StringDecoder`; this is the second layer on the same hazard, and it costs nothing.
- Filesystem hygiene is platform-gated behind `isPipe(p)`: `chmod 0600` and stale-file takeover apply only to the Unix path (named pipes carry no file mode and vanish with their last handle). The `listen`→`chmod` window is narrowed by creating the socket directory `0o700` FIRST (`ensureSocketDir`), so even during that window the path is unreachable to other users. Current hosts are WSL2 and macOS — the Unix path is what Tasks 5-10 execute and test; the win32 branch is a compile-checked seam with a unit test on the path string only. Bun named-pipe status (researched 2026-08-04): `node:net` named pipes are SUPPORTED (Bun v1.1.28; name normalization fixed v1.1.35; oven-sh/bun#11820 closed), but the neighbouring `node:http` pipe-listen bug is still open (oven-sh/bun#24682) — we use raw `node:net` only, never `node:http`, and a first native-Windows host still runs one live round-trip verify.
- **The daemon's `WarmSession` is constructed with EXPLICIT budget arguments**, never defaults-by-omission:
  ```typescript
  const warm = new WarmSession(process.env, {
    turnTimeoutMs: Number(process.env.KKAMAK_ACP_TURN_TIMEOUT_MS) || ACP_BUDGET.turnTimeoutMs,
    queueWaitMs: ACP_BUDGET.queueWaitMs,
    clearTimeoutMs: ACP_BUDGET.clearTimeoutMs,
    setModelMs: ACP_BUDGET.setModelMs,
    hardGraceMs: ACP_BUDGET.hardGraceMs,
  })
  ```
  These are the five numbers `ACP_BUDGET.daemonWorstCaseMs` sums, and the client's `daemonLegMs` is proven to exceed them by the Task 2 arithmetic test. `KKAMAK_ACP_TURN_TIMEOUT_MS` exists ONLY as a test seam; raising it in production without raising `daemonLegMs` re-opens the double-call hole §6e law L2 closes, and LOWERING it below `CLI_SPAWN_BUDGET_MS` is impossible — `WarmSession`'s constructor clamps it (round-4 C3), so a test seam cannot produce a session that mistakes an unbooted subprocess for a failed generation. It is also the one `KKAMAK_ACP_*` variable that is NOT denylisted from the fingerprint, because it changes which turns produce a derivation (§6e).
- **ACP behaviour:**
  - `initialize` → `{ protocolVersion: 1, agentCapabilities: { loadSession: false }, _meta: { envFingerprint: envFingerprint(process.env) } }`.
  - `session/new` → mints a UUID sessionId and records it (cheap: no model work, no recycle — an abandoned `session/new` costs nothing). `params.cwd` is ACCEPTED AND IGNORED: the instrument pins a neutral `cwd` (§6e delta (b)). Stated here so it is a decision, not a silent divergence.
  - `session/prompt` → requires `params._meta.model` (a non-empty string); a missing/non-string model is an `ACP_ERR_NO_CALL` error (law L4 — nothing is pushed), never a silent substitution of the daemon's own env.
    - **`recycle` and `lastServedSessionId` are computed and committed in the SAME synchronous step, at request-dispatch time, BEFORE `warm.oneShot` is called:**
      ```typescript
      const recycle = params.sessionId !== lastServedSessionId
      lastServedSessionId = params.sessionId          // commit NOW, not when the turn is served
      ```
      Committing at SERVE time instead is a context-leak bug: with `lastServed = A`, a request from B arriving first computes `recycle: true` while a request from A arriving second computes `recycle: false`; B then executes first and clears the transcript, and A runs `recycle: false` on a context that is no longer its own. Committing at dispatch time makes the second request see `A !== B` and clear correctly. Unreachable through the deriver (one fresh session per record ⇒ always `true`), but multi-prompt sessions are an advertised, tested capability of this profile and a cross-session context leak is precisely the class of defect §6d's isolation work exists to prevent.
    - **The cancel tag is DAEMON-MINTED and globally unique — never the client's JSON-RPC request id:**
      ```typescript
      const tag = crypto.randomUUID()
      outstanding.set(params.sessionId, tag)
      ```
      JSON-RPC ids are chosen by the client and every client's counter starts at 1, so two concurrent callers both label their `session/prompt` `3`. `WarmSession.cancel(tag)` matches by tag with no owner check, so a client-id tag would let B's correctly-scoped `session/cancel` resolve to tag `3` and INTERRUPT A's in-flight, already-billed turn — destroying A's record and consuming A's model call while telling A nothing. The `Map<sessionId, tag>` scopes WHICH tag is cancelled; only a globally-unique tag makes that scoping real. `crypto` is already imported for `session/new`'s UUID.
    - `ok` → emit ONE `session/update` notification with the full text as an `agent_message_chunk`, then answer `{ stopReason: "end_turn", _meta: { model: <TurnOutcome.model>, canonicalModel: <TurnOutcome.canonicalModel>, callConsumed: true } }`. **`_meta.model` is the `modelUsage` KEY the turn ran under, forwarded VERBATIM, and `_meta.canonicalModel` that entry's `canonicalModel` (or `""`).** The daemon does NOT compare them to `params._meta.model` and does NOT convert them to a verdict: the real API keys `modelUsage` by the DATED snapshot id while the caller requests the undated alias (round-4 C1), so the reconciliation is `modelProvenBy`'s job at the caller, which is also the only place that knows what it asked for. A daemon that adjudicated here would either reinstate the request-echo tautology or hide a genuine divergence behind its own opinion.
    - `no-call` → JSON-RPC error `{ code: ACP_ERR_NO_CALL, message, data: { callConsumed: false } }`, no update.
    - `call-consumed` → JSON-RPC error `{ code: ACP_ERR_CALL_CONSUMED, message, data: { callConsumed: true } }`, no update.
    - `data.callConsumed` is ALWAYS set (law L3 step (i) makes it authoritative over the code; step (ii) exists for a daemon that omits it, which this one never does). The outcome is delivered straight from `TurnOutcome.kind` — the daemon adds no classification of its own, so there is exactly one place in the process where §6e's law is decided.
    - Clear `outstanding.delete(sessionId)` in a `finally`.
  - `session/cancel` → `warm.cancel(outstanding.get(params.sessionId) ?? "")`; **answers `{}` ONLY when the frame carried an `id`.** ACP proper sends this as a notification; our own client wants an acknowledgement so a test can order "cancel landed" against "turn resolved", so the dispatcher serves both shapes and answers neither incorrectly (a notification is never answered, per JSON-RPC 2.0). A cancel naming an unknown/finished session is a no-op that still answers `{}` when an id was present. All four `CancelResult` values (`queued-dropped`, `unsent-dropped`, `interrupted`, `unknown`) are treated identically on the wire — the outcome the CALLER sees is the `session/prompt` reply, and §6e L4/L7 guarantee that a `queued-dropped` or `unsent-dropped` turn replies `ACP_ERR_NO_CALL` while an `interrupted` one replies `ACP_ERR_CALL_CONSUMED`.
  - Unknown method → JSON-RPC `-32601`, connection stays open.
- Idle reaper: ticks at `Math.max(250, Math.min(60_000, idleMs / 3))` — a fixed 60 s tick could never observe a short `KKAMAK_ACP_IDLE_MS` (the test uses 1 500 ms), and would make the reaper untestable. On a tick where `warm.idleMs() > KKAMAK_ACP_IDLE_MS` AND `!warm.turnInFlight()` → **stop accepting new connections first**, then close open connections, then `warm.close()`, release the bind lock, unlink the socket, `process.exit(0)`. Unlinking before draining races a client that has already written a `session/prompt`. A client torn down between `session/new` and `session/prompt` sees its socket close BEFORE the prompt frame was written — law L1, `no-call`, safe to fall back.
- Lifecycle hygiene: `chmod 0600` after listen; `SIGTERM`/`SIGINT` → same drain-then-unlink-then-exit path.
- **Stale-socket takeover, race-free:** the whole probe→unlink→rebind sequence runs while holding the BIND lock (`<socket>.bind.lock`, `wx`-created, `corpus-store.ts:145-177` staleness rule, released after a successful `listen` and on every exit path). Sequence: `listen` → on `EADDRINUSE`, `net.connect` the path → answered ⇒ another daemon is live, release the lock and exit 0 quietly; `ECONNREFUSED`/`ENOENT` ⇒ unlink and ONE rebind attempt. Without the lock two starters can both see `ECONNREFUSED`, both unlink, and the loser's unlink removes the winner's LIVE path — leaving a listening-but-unreachable daemon and every caller silently falling back forever.
- Test seam: when `env.KKAMAK_ACP_TEST_SPAWN_LOG` is set, append one line (`pid` + ISO ts) to that file **AFTER a successful `listen` + `chmod`** — never at boot. A starter that loses the bind race and exits 0 writes NOTHING, so "exactly one line" means "exactly one daemon is serving", which is the property Tasks 6 and 8 actually want to assert and which holds even when two processes were launched. The `pid` is also the ONLY sanctioned way to terminate a daemon — an `afterEach`, and Task 9's validation script, read it and signal THAT pid. `Bun.spawn`'s returned pid is the `bash -c nohup` shell's, not the daemon's, and pattern-killing the process table (`pkill -f acp-daemon`) is forbidden by §6e's "end half of ruling 3" paragraph because it is the host-wide teardown that paragraph rejects (round-4 I9).
- **One structural rule:** the dispatcher must never `throw` across a connection handler — every error path answers a JSON-RPC error frame. The daemon dying on a bad frame is a fail-open violation.

- [ ] **Step 1: Write the failing tests** (drive the real daemon as a child over a temp socket; SSE stub for the model side; the credentials skip-guard goes on the tests that reach a model AND ONLY on those)

```typescript
// test/acp-paths.test.ts — no daemon, no CLI, no credentials needed.
import { describe, expect, test } from "bun:test"
import {
  envFingerprint, socketPath, spawnLockPath, bindLockPath, ACP_ENV_DENYLIST,
} from "../src/gauge/acp-paths.ts"

describe("acp-paths", () => {
  test("the fingerprint covers the WHOLE env, not a five-key sample", () => {
    // The rejected allow-list would have made these three pairs identical.
    // Each of them changes the instrument.
    expect(envFingerprint({ ANTHROPIC_MODEL: "a" })).not.toBe(envFingerprint({ ANTHROPIC_MODEL: "b" }))
    expect(envFingerprint({ HTTPS_PROXY: "http://p1" })).not.toBe(envFingerprint({ HTTPS_PROXY: "http://p2" }))
    expect(envFingerprint({ CLAUDE_CODE_DISABLE_X: "1" })).not.toBe(envFingerprint({}))
  })
  test("a different base URL is a different instrument", () => {
    expect(envFingerprint({ ANTHROPIC_BASE_URL: "http://a" }))
      .not.toBe(envFingerprint({ ANTHROPIC_BASE_URL: "http://b" }))
  })
  test("secret-NAMED keys contribute PRESENCE only — the value never changes the fingerprint", () => {
    const a = envFingerprint({ ANTHROPIC_API_KEY: "sk-aaa" })
    const b = envFingerprint({ ANTHROPIC_API_KEY: "sk-bbb" })
    const none = envFingerprint({})
    expect(a).toBe(b)
    expect(a).not.toBe(none)
    // ...and the same rule reaches every secret-shaped name, not an enum.
    expect(envFingerprint({ SOME_AUTH_TOKEN: "t1" })).toBe(envFingerprint({ SOME_AUTH_TOKEN: "t2" }))
    expect(envFingerprint({ SOME_AUTH_TOKEN: "t1" })).not.toBe(none)
    // the regex must be stateless: a /g flag would carry lastIndex across
    // calls and make the SAME key match, then not match.
    expect(envFingerprint({ A_KEY: "1", B_KEY: "2" })).toBe(envFingerprint({ A_KEY: "9", B_KEY: "9" }))
  })
  test("denylisted keys do not change the fingerprint", () => {
    for (const k of ["PWD", "SHLVL", "TMUX_PANE", "KKAMAK_ACP_IDLE_MS", "KKAMAK_ACP_TEST_SPAWN_LOG"]) {
      expect(ACP_ENV_DENYLIST.includes(k)).toBe(true)
      expect(envFingerprint({ [k]: "x" })).toBe(envFingerprint({ [k]: "y" }))
    }
  })
  test("ROUND-4 I4: lane SELECTION and the ENDPOINT ADDRESS are denylisted", () => {
    // KKAMAK_GAUGE_TRANSPORT chooses a lane; it cannot change one byte the
    // daemon sends. Post-flip the live path FORCES it into a derived env
    // while the process that started the daemon carries whatever the shell
    // had, so leaving it in the hash makes a client and its OWN daemon
    // permanently unable to match — and because daemonCall never spawns,
    // that is not "one extra daemon", it is 100% silent fallback forever.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_GAUGE_TRANSPORT")).toBe(true)
    expect(envFingerprint({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe(envFingerprint({}))
    // KKAMAK_ACP_SOCKET is where to reach the instrument, not what it is.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_ACP_SOCKET")).toBe(true)
    expect(envFingerprint({ KKAMAK_ACP_SOCKET: "/tmp/a.sock" }))
      .toBe(envFingerprint({ KKAMAK_ACP_SOCKET: "/tmp/b.sock" }))
  })
  test("ROUND-4 I4: the TURN BUDGET is an instrument parameter and is NOT denylisted", () => {
    // It changes when a generation is cut off, hence which turns produce a
    // derivation. A daemon running a different turn budget is a different
    // instrument and must not be adopted by a client expecting the
    // registered one.
    expect(ACP_ENV_DENYLIST.includes("KKAMAK_ACP_TURN_TIMEOUT_MS")).toBe(false)
    expect(envFingerprint({ KKAMAK_ACP_TURN_TIMEOUT_MS: "9000" }))
      .not.toBe(envFingerprint({ KKAMAK_ACP_TURN_TIMEOUT_MS: "20000" }))
  })
  test("key ORDER in the object does not change the fingerprint (keys are sorted)", () => {
    expect(envFingerprint({ A: "1", B: "2" })).toBe(envFingerprint({ B: "2", A: "1" }))
  })
  test("no secret VALUE can appear in a socket path", () => {
    const p = socketPath({ ANTHROPIC_API_KEY: "sk-super-secret-value" })
    expect(p).not.toContain("sk-super-secret-value")
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
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { tmpdir } from "node:os"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText, silentServer, until } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"
import { ACP_ERR_NO_CALL, ACP_ERR_CALL_CONSUMED } from "../src/gauge/acp-wire.ts"

const DAEMON_TEST_TIMEOUT_MS = 60_000
const HAIKU_DATED = "claude-haiku-4-5-20251001"   // Step 1a's observed key form

/** Every test builds its OWN socket/spawn-log pair under tmpdir. NO TEST MAY
 * EVER TOUCH ~/.config/kkamak/acp-*.sock — the afterEach below asserts it. */
function tempEndpoint(tag: string) {
  const base = path.join(tmpdir(), `kkamak-acp-${tag}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`)
  return { sock: `${base}.sock`, spawnLog: `${base}.spawnlog` }
}

/** Spawn the REAL daemon as a detached child.
 *
 * `env` is passed EXPLICITLY and is the SAME object the caller fingerprints
 * (round-4 I2): the daemon computes envFingerprint(process.env) and
 * socketPath(process.env) from what it inherits, so a spawner that
 * fingerprints one env and launches with another gets a daemon on a
 * different path echoing a different fingerprint — mutual refusal forever.
 *
 * KKAMAK_ACP_IDLE_MS is ALWAYS set to a few seconds here (round-4 M8): the
 * production default is 900 000 ms, and a test daemon that survives an
 * afterEach failure would sit on the host for fifteen minutes. */
function spawnDaemon(sock: string, spawnLog: string, extra: Record<string, string> = {}, idleMs = "8000") {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    KKAMAK_ACP_SOCKET: sock,
    KKAMAK_ACP_TEST_SPAWN_LOG: spawnLog,
    KKAMAK_ACP_IDLE_MS: idleMs,
    ...extra,
  }
  const daemon = path.join(import.meta.dir, "..", "src", "gauge", "acp-daemon.ts")
  const quoted = ["bun", daemon].map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  return { env }
}

/** Read the POST-LISTEN pids out of the spawn log and SIGTERM each one, then
 * unlink the socket and both locks. Pid-scoped, never `pkill -f` — §6e
 * forbids host-wide teardown (round-4 I9), and the Bun.spawn handle is the
 * `bash -c nohup` shell, not the daemon. */
function killDaemon(sock: string, spawnLog: string): void {
  try {
    for (const line of fs.readFileSync(spawnLog, "utf-8").split("\n")) {
      const pid = Number(line.trim().split(/\s+/)[0])
      if (Number.isInteger(pid) && pid > 0) { try { process.kill(pid, "SIGTERM") } catch { /* gone */ } }
    }
  } catch { /* never listened */ }
  for (const p of [sock, `${sock}.spawn.lock`, `${sock}.bind.lock`, spawnLog]) {
    try { fs.rmSync(p, { force: true }) } catch { /* ignore */ }
  }
}

const LIVE: Array<{ sock: string; spawnLog: string }> = []
afterEach(() => {
  while (LIVE.length) { const e = LIVE.pop()!; killDaemon(e.sock, e.spawnLog) }
  // The hygiene invariant, asserted rather than hoped for.
  const home = process.env.HOME ?? ""
  const dir = path.join(home, ".config", "kkamak")
  const leaked = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("acp-")) : []
  expect(leaked).toEqual([])
})

// ── wire-level behaviour: no model is ever reached, so NO credentials
// guard. Round-4 M6: a blanket describe.skipIf over this block would throw
// away real coverage on a credential-less host, because the daemon's
// WarmSession does not start a Query until a prompt actually arrives.
describe("acp-daemon wire behaviour (no model reached)", () => {
  test("missing _meta.model -> ACP_ERR_NO_CALL with data.callConsumed false, and ZERO model calls", async () => {
    // law L4: nothing was pushed. assert error.code === ACP_ERR_NO_CALL,
    // error.data.callConsumed === false, and the stub captured 0 requests.
    // The stub is still wired so "0 captured" is a real observation.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("unknown method -> -32601 and the connection survives", async () => {
    // assert the error code, then a following `initialize` still answers.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a malformed frame does not kill the daemon", async () => {
    // write "garbage\n", then a valid initialize on the SAME socket: answers.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel sent as a NOTIFICATION (no id) is honoured and NOT answered", async () => {
    // JSON-RPC 2.0: a notification must never be answered. Assert the queued
    // prompt still resolves ACP_ERR_NO_CALL and no frame carrying a null/absent
    // id ever arrives back.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("idle reaper drains, exits, and removes the socket", async () => {
    // spawn with KKAMAK_ACP_IDLE_MS=1500, connect+initialize once, wait ~5s:
    // the pid from the spawn log is gone and fs.existsSync(sock) === false.
    // This is why the reaper ticks at min(60s, idleMs/3) rather than a fixed
    // 60s — a fixed tick could never observe a 1500ms budget.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("stale socket file is taken over under the BIND lock", async () => {
    // pre-create a dead socket file at the path, spawn daemon, initialize succeeds
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a LIVE socket is not taken over: the second starter exits 0, writes NO spawn-log line, and the first still answers", async () => {
    // this is the race the bind lock exists to prevent, and the reason the
    // spawn log is written post-listen rather than at boot. Assert the log
    // has exactly ONE line after both starters have settled.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("ROUND-4 I2: the daemon binds and echoes from the env it was GIVEN, not from an ambient one", async () => {
    // Spawn with an env carrying a distinctive instrument key (e.g.
    // ANTHROPIC_MODEL=probe-value) and assert BOTH that the socket it bound
    // is the one socketPath(thatEnv) names AND that initialize._meta
    // .envFingerprint === envFingerprint(thatEnv). A spawner that fingerprints
    // one env and launches with another produces a daemon on a different path
    // echoing a different fingerprint, which every client then refuses
    // forever — the failure that makes daemonCall's no-spawn design a
    // permanent 100% fallback rather than "one extra daemon".
  }, DAEMON_TEST_TIMEOUT_MS)
})

// ── model-reaching behaviour: these DO spawn the bundled CLI, so they carry
// the credentials guard.
describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-daemon over unix socket (reaches the stubbed model)", () => {
  test("initialize -> session/new -> session/prompt round-trip, fingerprint and PROVEN-model evidence echoed", async () => {
    const e = tempEndpoint("rt"); LIVE.push(e)
    const cap = stubServer(() => sseText("ANSWER", HAIKU_DATED))
    try {
      const { env } = spawnDaemon(e.sock, e.spawnLog, { ANTHROPIC_BASE_URL: cap.url })
      const c = await connectNdjson(e.sock)      // helper: net.connect + setEncoding + FrameDecoder
      const init = await c.request("initialize", { protocolVersion: 1 })
      expect(init.protocolVersion).toBe(1)
      expect(init._meta.envFingerprint).toBe(envFingerprint(env))   // §6e fingerprint echo
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
      // ROUND-4 C1: the daemon forwards the modelUsage KEY VERBATIM. The
      // real API keys it by the DATED snapshot id; the daemon must NOT
      // "helpfully" normalize it to the requested alias (that reinstates the
      // echo tautology) and must NOT adjudicate (that hides a real
      // divergence). Reconciliation is modelProvenBy's job at the caller.
      expect(r._meta.model).toBe(HAIKU_DATED)
      expect(r._meta.model).not.toBe("claude-haiku-4-5")
      expect(typeof r._meta.canonicalModel).toBe("string")
      expect(r._meta.callConsumed).toBe(true)
      expect(updates.join("")).toContain("ANSWER")
    } finally { cap.stop() }
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a second SESSION recycles (clean context); a second PROMPT in one session does not", async () => {
    // session/new + prompt, then session/new + prompt on the same daemon:
    // assert CAPTURED.length === 2 and the first prompt's marker ABSENT from
    // the second body (message COUNT is not asserted — §6e residue shape,
    // same reason as Task 4). Then a THIRD prompt reusing the SECOND
    // sessionId: assert the second prompt's marker IS present.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("INTERLEAVED sessions each get a clean context (lastServedSessionId is committed at dispatch)", async () => {
    // Two connections, sessions A and B, prompts issued A, B, A with a
    // distinct marker each. Assert NO captured body contains another
    // session's marker. Committing lastServedSessionId at SERVE time instead
    // of dispatch time makes the third prompt compute recycle:false against
    // a transcript B already cleared, and this test sees A's context
    // carrying B's turn.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("a 500 -> ACP_ERR_CALL_CONSUMED with data.callConsumed true, no update", async () => {
    // law L6. stub: 500 then success. assert error.code === ACP_ERR_CALL_CONSUMED
    // AND error.data.callConsumed === true (L3 step (i)'s authoritative channel).
  }, DAEMON_TEST_TIMEOUT_MS)

  test("an unreachable model endpoint AFTER the push -> ACP_ERR_CALL_CONSUMED, never NO_CALL", async () => {
    // law L5 with no exception (round-3 C1), asserted at the WIRE level so a
    // future reader cannot reintroduce the carve-out inside WarmSession
    // without this failing: spawn the daemon with
    // ANTHROPIC_BASE_URL=http://127.0.0.1:9 and
    // KKAMAK_ACP_TURN_TIMEOUT_MS=8000 (the CLI_SPAWN_BUDGET_MS floor — a
    // shorter value is clamped by WarmSession's constructor anyway, round-4
    // C3), send one prompt, assert error.code === ACP_ERR_CALL_CONSUMED and
    // error.data.callConsumed === true.
  }, DAEMON_TEST_TIMEOUT_MS)

  test("session/cancel is SCOPED even when BOTH clients use the SAME JSON-RPC id", async () => {
    // Round-3 C2 at the wire level. Two connections, each with its own id
    // counter, so BOTH label their session/prompt with the SAME id — the
    // real-world shape, since every client starts counting at 1. A's prompt
    // hangs (silentServer); B's prompt is queued; B sends session/cancel for
    // ITS OWN session. Assert B gets ACP_ERR_NO_CALL and A still ends on its
    // own turn timeout with ACP_ERR_CALL_CONSUMED — never cancelled by B. A
    // daemon that used the client's id as the WarmSession tag fails here.
    // Use `until(() => cap.count() >= 1, 30_000)` before B's cancel so A has
    // provably crossed the send boundary (round-4 C3/I11) — otherwise A is
    // still unsent and would legitimately end NO_CALL.
  }, DAEMON_TEST_TIMEOUT_MS)
})
```
(The sketched bodies are written out in full by the implementer following the first test's helper pattern — same `spawnDaemon`/`connectNdjson`/`killDaemon`/`tempEndpoint` helpers, different assertions; the assertions named in the comments are the required ones. Every test pushes its endpoint onto `LIVE` so the `afterEach` reaps it by POST-LISTEN pid and then asserts `~/.config/kkamak/` holds no `acp-*` file.)

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

/** §6e instrument fingerprint. The fingerprint covers the WHOLE env MINUS
 * these keys. An enumerated ALLOW-list was the first draft and is rejected:
 * it left ANTHROPIC_MODEL, ANTHROPIC_SMALL_FAST_MODEL, the proxy vars and
 * every CLAUDE_CODE_* toggle free to change the instrument silently.
 *
 * TWO classes, and they are not interchangeable:
 *  · PER-PROCESS VOLATILE — the shell/terminal/ssh/tmux group.
 *  · NOT AN INSTRUMENT PARAMETER —
 *      KKAMAK_ACP_IDLE_MS, KKAMAK_ACP_TEST_SPAWN_LOG : daemon OPERATING
 *        parameters. (Which is exactly why Task 9's validation run binds its
 *        own KKAMAK_ACP_SOCKET rather than relying on a differing idle
 *        budget to produce a separate daemon.)
 *      KKAMAK_ACP_SOCKET : an ENDPOINT ADDRESS — where to reach the
 *        instrument, not what it is.
 *      KKAMAK_GAUGE_TRANSPORT : a LANE SELECTION. Round-4 I4, and
 *        load-bearing: post-flip the live derive path FORCES this value into
 *        a derived env (refiner-cli.ts) while the process that started the
 *        daemon carries whatever the user's shell had. Leaving it in the
 *        hash makes a client and its OWN daemon permanently unable to match
 *        — and since daemonCall never spawns, that is not "one extra
 *        daemon", it is a silent 100% fallback on every record forever.
 *
 * NOT here, deliberately: KKAMAK_ACP_TURN_TIMEOUT_MS. It changes when a
 * generation is cut off, hence which turns produce a derivation, hence the
 * instrument. A daemon running a different turn budget must not be adopted
 * by a client expecting the registered one. */
export const ACP_ENV_DENYLIST: readonly string[] = [
  "_", "PWD", "OLDPWD", "SHLVL", "RANDOM", "LINES", "COLUMNS", "WINDOWID",
  "TERM_SESSION_ID", "ITERM_SESSION_ID", "TMUX", "TMUX_PANE", "STY",
  "SSH_AUTH_SOCK", "SSH_AGENT_PID", "SSH_CLIENT", "SSH_CONNECTION", "SSH_TTY",
  "XDG_SESSION_ID", "DBUS_SESSION_BUS_ADDRESS",
  "KKAMAK_ACP_IDLE_MS", "KKAMAK_ACP_TEST_SPAWN_LOG",
  "KKAMAK_ACP_SOCKET", "KKAMAK_GAUGE_TRANSPORT",
]

/** Keys whose NAME looks like a credential contribute presence, never value.
 * A name-shaped rule rather than an enum, so a new credential variable is
 * covered the day it appears. NO `g` FLAG: a global regex carries lastIndex
 * across .test() calls and would alternate true/false on the same key. */
export const ACP_SECRET_KEY_RE = /(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i

export function envFingerprint(env: Record<string, string | undefined>): string {
  const deny = new Set(ACP_ENV_DENYLIST)
  const lines: string[] = []
  for (const k of Object.keys(env).sort()) {
    if (deny.has(k)) continue
    const v = env[k]
    if (v === undefined) continue
    lines.push(ACP_SECRET_KEY_RE.test(k) ? `${k}=set` : `${k}=${v}`)
  }
  return crypto.createHash("sha256").update(lines.join("\n") + "\n").digest("hex").slice(0, 12)
}

export function isPipe(p: string): boolean { return p.startsWith("\\\\.\\pipe\\") }

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

/** MAY THROW (EACCES on an unwritable parent). Callers own the fail-open
 * wrapping — `ensureDaemon`'s NEVER-throws contract is what turns an
 * unwritable socket dir into an exit-0 SessionStart no-op. */
export function ensureSocketDir(p: string): void {
  if (isPipe(p)) return
  fs.mkdirSync(path.dirname(p), { recursive: true, mode: 0o700 })
}

/** Staleness discipline shaped EXACTLY on corpus-store.ts:145-177 —
 * `isLockStale` (:149-158) collapses stale/vanished/torn to one takeover
 * path, and `acquireLock` (:164-177) does unlink + ONE fresh `wx` retry,
 * treating a lost retry race as a refusal rather than an assumed ownership.
 * The bare `wx` create helper is corpus-store.ts:134-143, and like it,
 * `tryCreateLock` RETHROWS anything that is not EEXIST. SIGNATURES MATCH
 * THAT MODULE — `content` and `now` stay explicit parameters so the two
 * implementations remain directly comparable. */
export const ACP_LOCK_STALE_MS = 30_000
export interface AcpLockContent { pid: number; ts: number }
export function tryCreateLock(lockPath: string, content: AcpLockContent): boolean { /* wx create */ }
export function isLockStale(lockPath: string, now: number): boolean { /* per the rule above */ }
export function acquireAcpLock(lockPath: string, now: number): boolean { /* wx -> stale? -> unlink -> ONE retry */ }
export function releaseAcpLock(lockPath: string): void { /* unlink, ENOENT-tolerant, never throws */ }
```

```typescript
// acp-daemon.ts — §6e ACP daemon: one WarmSession behind the ACP wire
// subset, implementing the §6e wire-send boundary law.
//
// THE ENV CONTRACT (round-4 I2): this process fingerprints and binds from
// its OWN process.env — envFingerprint(process.env) is what `initialize`
// echoes and socketPath(process.env) is what it listens on. Whoever spawns
// it MUST pass, explicitly, the same env object it fingerprinted. The repo's
// established detached-spawn idiom (hook-cli.ts:147-154) passes no `env` and
// inherits, which is correct only when the spawner fingerprinted
// process.env itself. acp-client.ts's ensureDaemon passes it explicitly.
//
// session/new is cheap (UUID mint) and its `cwd` is accepted-and-IGNORED
// (the instrument pins a neutral cwd, §6e delta (b)); the /clear recycle
// happens at a prompt whose sessionId differs from the last one served — so
// a multi-prompt ACP session keeps its context while the deriver (fresh
// session per record) always gets a clean one. `lastServedSessionId` is
// committed at DISPATCH time, not serve time, or interleaved sessions leak
// context into each other.
// One turn in flight globally (WarmSession FIFO).
// Cancel tags are DAEMON-MINTED UUIDs, never the client's JSON-RPC id: two
// clients both start their id counters at 1, and a colliding tag would let
// one caller's cancel interrupt another caller's already-billed turn.
// Failure is a JSON-RPC ERROR carrying data.callConsumed (law L3 step (i)'s
// authoritative channel), never a fake stopReason, and the outcome is passed
// straight through from TurnOutcome.kind — the daemon adds no classification
// of its own.
// The MODEL fields are forwarded VERBATIM from TurnOutcome (the modelUsage
// KEY and its canonicalModel) and are NEVER compared here: the real API keys
// usage by the dated snapshot id while callers request the undated alias
// (round-4 C1), and reconciliation via modelProvenBy belongs at the caller,
// which is the only party that knows what it asked for.
//
// EVERY runtime side effect below is behind `import.meta.main`. acp-client
// imports NOTHING from this file (see acp-paths.ts).
import net from "node:net"
import fs from "node:fs"
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
// Map<string, { createdAt: number }>; `lastServedSessionId` committed at
// dispatch; an outstanding Map<sessionId, tag> of DAEMON-MINTED UUIDs so
// session/cancel is SCOPED to its own session and cannot collide with
// another connection's request ids;
// on session/prompt: validate params._meta.model is a non-empty string
// (else ACP_ERR_NO_CALL — law L4), compute+commit recycle, mint the tag,
// then map TurnOutcome -> result | ACP_ERR_NO_CALL | ACP_ERR_CALL_CONSUMED,
// forwarding TurnOutcome.model / .canonicalModel VERBATIM into _meta on the
// success path, always populating data.callConsumed on the error paths, and
// always clearing `outstanding` in a finally;
// on session/cancel: warm.cancel(outstanding.get(sessionId) ?? "") and answer
// {} ONLY when the frame carried an id. All four CancelResult values are
// treated identically on the wire — the caller learns the outcome from its
// session/prompt reply, and §6e L4/L7 guarantee queued-dropped and
// unsent-dropped reply NO_CALL while interrupted replies CALL_CONSUMED.
//
// if (import.meta.main) { ... and ONLY here:
//   ensureSocketDir(p); acquireAcpLock(bindLockPath(env), Date.now()); listen ->
//   on EADDRINUSE probe-then-(unlink + ONE rebind) or exit 0 quietly;
//   chmod 0600; releaseAcpLock; append the spawn-log line POST-LISTEN;
//   on every accepted socket: socket.setEncoding("utf8");
//   idle reaper setInterval(Math.max(250, Math.min(60_000, idleMs / 3)));
//   SIGTERM/SIGINT -> stop accepting, drain, warm.close(), unlink, exit 0. }
```

The implementer writes the full dispatcher (~200 lines) against the Task 2 types; every branch has a test from Step 1.

- [ ] **Step 4: Run to verify they pass**

Run: `cd cc-gate-plugin && bun test test/acp-paths.test.ts test/acp-daemon.test.ts` — 0 fail.
Run: `cd cc-gate-plugin && bun test` — 0 fail. `bunx tsc --noEmit` clean.
Hygiene check: `ls ~/.config/kkamak/` — no `acp-*.sock`, `.spawn.lock` or `.bind.lock` may exist (every test used a temp socket and the `afterEach` asserts this too, so a manual check that disagrees with a green suite means the assertion is wrong, not the directory).
Stray-daemon check: `ps -eo pid,etime,args | grep -F 'acp-daemon.ts' | grep -v grep` — expect nothing. If a daemon survived, SIGTERM it BY PID; do not `pkill -f` (§6e).
Import-purity check: `bun -e 'import("./cc-gate-plugin/src/gauge/acp-paths.ts").then(() => console.log("clean"))'` returns immediately and leaves no listening socket — proving the hook's import path cannot start a daemon.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-paths.ts cc-gate-plugin/src/gauge/acp-daemon.ts \
        cc-gate-plugin/test/acp-paths.test.ts cc-gate-plugin/test/acp-daemon.test.ts
git commit -m "feat(gauge): ACP daemon — socket server, UUID-tagged scoped cancel, whole-env fingerprint echo (selection/endpoint denylisted), verbatim model evidence, idle self-exit"
```

### Task 6: `acp-client.ts` — connect-or-spawn, three-way outcome, shared outgoing text

**Files:**
- Create: `cc-gate-plugin/src/gauge/acp-client.ts`
- Create: `cc-gate-plugin/test/acp-fake-daemon.ts` (shared scripted-daemon helper — Tasks 6 AND 7 both need it, and a `.test.ts` cannot be imported from another `.test.ts` without re-running its tests; not matched by bun's test glob, same as `sdk-stub.ts`)
- Modify: `cc-gate-plugin/src/gauge/agent-transport.ts` (EXPORT the existing `buildOutgoingText`, renamed `buildAgentOutgoingText` — no behaviour change, no new logic)
- Test: `cc-gate-plugin/test/acp-client.test.ts`

**Interfaces:**
- Consumes: `socketPath`, `ensureSocketDir`, `spawnLockPath`, `envFingerprint`, `acquireAcpLock`, `releaseAcpLock` (Task 5's `acp-paths.ts` — NOT `acp-daemon.ts`); wire pieces + error codes + `ACP_BUDGET` (Task 2); `buildAgentOutgoingText` (this task).
- Produces (`acp-fake-daemon.ts`):
  ```typescript
  /** A scripted ACP daemon on a unix socket: no WarmSession, no CLI, no
   * model. Shared by Tasks 6 and 7 so the two suites cannot drift on the
   * fingerprint echo — a fake that echoes the WRONG fingerprint makes every
   * client call a silent law-L1 `no-call`, which looks like a routing bug
   * and is not one. */
  export function fakeDaemon(
    sock: string,
    opts: {
      /** echoed in initialize._meta; pass envFingerprint(theEnvUnderTest) */
      fingerprint: string
      answer:
        | "ok"                    // session/update + AcpPromptResult
        | "no-call"               // ACP_ERR_NO_CALL + data.callConsumed false
        | "call-consumed"         // ACP_ERR_CALL_CONSUMED + data.callConsumed true
        | "no-call-code-no-data"  // ACP_ERR_NO_CALL, `data` OMITTED entirely
        | "consumed-code-no-data" // ACP_ERR_CALL_CONSUMED, `data` OMITTED entirely
        | "nonboolean-data"       // NO_CALL code, data.callConsumed = "false" (a STRING)
        | "mismatched-data"       // ACP_ERR_NO_CALL code, data.callConsumed TRUE
        | "unknown-code"          // -32603, no data
        | "hang"                  // accepts, answers init+new, never the prompt
        | "die-before-prompt"     // answers init+new then destroys the socket
      /** text the "ok" answer carries; default "ANSWER" */
      text?: string
      /** _meta.model the "ok" answer reports — the modelUsage KEY, which in
       * reality is usually a DATED snapshot of the requested alias
       * (round-4 C1). Default: the requested model with "-20251001"
       * appended, so the DEFAULT fake exercises the dated path rather than
       * the degenerate equal-strings path. */
      model?: string
      /** _meta.canonicalModel the "ok" answer reports; default "" */
      canonicalModel?: string
    },
  ): {
    stop: () => void
    /** true iff a session/prompt frame was ever decoded — the wire-level
     * proof for every "the fallback never sent anything" assertion */
    sawPrompt: () => boolean
    /** the params of the last session/prompt, for byte-identity assertions */
    promptParams: () => { sessionId: string; prompt: Array<{ type: "text"; text: string }>; _meta: { model: string } } | undefined
  }
  ```
  The three `*-no-data` / `nonboolean-data` variants exist for round-4 I1: §6e law L3 now specifies an exact three-step decision procedure, and the branch that decides between one and two model calls (a recognized code with `data` absent) had no fixture at all in the previous revision.
- Produces (`acp-client.ts`):
  ```typescript
  /** Mirrors WarmSession's TurnOutcome across the wire so §6e's law
   * survives the process boundary. `model`/`canonicalModel` are the
   * daemon's EVIDENCE (the modelUsage key and its canonicalModel),
   * forwarded verbatim — the caller reconciles them with modelProvenBy. */
  export type DaemonOutcome =
    | { kind: "ok"; text: string; model: string; canonicalModel: string }
    | { kind: "no-call" }
    | { kind: "call-consumed" }

  /** One record through the daemon. Connect (never spawn) -> initialize
   * (+ fingerprint check) -> session/new -> session/prompt -> collect the
   * update -> close socket.
   *
   * §6e law, client side: `no-call` for EVERY failure that happens BEFORE
   * the session/prompt frame's write callback reports success (L1: no
   * socket, connect refused, initialize/session-new failure, fingerprint
   * mismatch, write error). `call-consumed` for EVERY ambiguity after it
   * (L2). The post-send decision is L3's exact three steps: boolean
   * `error.data.callConsumed` wins; else a RECOGNIZED code is honoured
   * (including with `data` absent); else L2. NEVER throws. */
  export function daemonCall(
    outgoingText: string,
    model: string,
    env: Record<string, string | undefined>,
    opts?: { budgetMs?: number },   // default ACP_BUDGET.daemonLegMs = 36_000
  ): Promise<DaemonOutcome>

  /** Ensure a daemon is reachable. `waitMs` DEFAULTS TO 0 = kick and return
   * false immediately (the SessionStart hook's mode). Otherwise poll-connect
   * up to waitMs. Returns true when a daemon answered `initialize` with a
   * MATCHING fingerprint. NEVER throws — including when ensureSocketDir
   * raises EACCES on an unwritable parent. Destroys every socket it opens
   * and clears every timer before resolving — the SessionStart hook has no
   * forced `process.exit(0)` on its success path (hook-cli.ts:339-346 only
   * catches rejections), so one lingering handle would keep the hook alive
   * until CC's 30 s timeout on EVERY session start. */
  export function ensureDaemon(
    env: Record<string, string | undefined>,
    opts?: { waitMs?: number },     // default 0
  ): Promise<boolean>
  ```
  **`DAEMON_LEG_MS` is NOT re-exported here.** Callers read `ACP_BUDGET.daemonLegMs` from `acp-wire.ts` directly. `transport.ts` is on `hook-cli.ts`'s eager import path (`hook-cli.ts:24`), so a named re-export from `acp-client.ts` would force `transport.ts` to import this module at module scope and put `node:net` + the whole client on every hook event — the exact cost `agent-transport.ts:102-108` established the lazy-import discipline to avoid. `acp-wire.ts` imports only `node:string_decoder` and is safe to import eagerly.
- **Every socket gets `socket.setEncoding("utf8")` on connect**, matching the daemon (Task 5) — the second layer over `FrameDecoder`'s `StringDecoder` on the split-multibyte hazard.
- **`sentPrompt` is set in the WRITE CALLBACK, and that is the whole client-side send boundary.** One boolean, one assignment site:
  ```typescript
  await new Promise<void>((res, rej) =>
    socket.write(encodeFrame(promptFrame), (err) => (err ? rej(err) : (sentPrompt = true, res()))))
  ```
  A write that errors before the callback cannot have delivered a parseable frame — a partial line sits in the daemon's `FrameDecoder` buffer and is never dispatched — so it is law L1, `no-call`. Once the callback reports success the bytes are with the OS and every later ambiguity is L2, `call-consumed`. Nothing else in the file may write to this variable (round-4 M7: the previous revision left the placement unspecified; both plausible placements were safe, but "safe by luck" is not a contract).
- **Spawn idiom (repo-established, `hook-cli.ts:147-154`) — with the argv and the env made EXPLICIT (round-4 I2):**
  ```typescript
  import path from "node:path"
  // Sibling resolution, same idiom as spawn.ts:12's REFINER_CLI. NEVER
  // resolved against a caller's cwd: ensureDaemon runs from a hook process,
  // from `bun -e`, and from a test, and none of them share a cwd.
  const DAEMON_ENTRY = path.join(import.meta.dir, "acp-daemon.ts")

  const cmd = ["bun", DAEMON_ENTRY]
  const quoted = cmd.map((c) => `'${c.replace(/'/g, `'\\''`)}'`).join(" ")
  // `env` is the SAME object this function fingerprinted and derived
  // socketPath() from. The bare repo idiom passes no `env` and inherits
  // process.env — correct only when the spawner fingerprinted process.env
  // itself. A daemon launched with a DIFFERENT env computes a different
  // envFingerprint(process.env) AND binds a different socketPath(process.env),
  // so the client that just started it refuses it forever and, because
  // daemonCall never spawns, falls back on every single record.
  const childEnv: Record<string, string> = {}
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v
  const proc = Bun.spawn(["bash", "-c", `nohup ${quoted} </dev/null >/dev/null 2>&1 &`], {
    env: childEnv, stdout: "ignore", stderr: "ignore",
  })
  proc.unref()
  ```
  Bun's `spawn` has no `detached` option and no string `stdio`; and without `nohup` the daemon dies with the hook process that started it. Note the returned pid is the SHELL's, not the daemon's — tests and Task 9 read the daemon pid from the post-listen spawn log.
- **`ensureDaemon`'s exact sequence** (the "exactly one daemon SERVING" property, given the post-listen spawn log from Task 5). `held` is tracked explicitly and NOTHING is released that was not acquired. The whole body is inside a `try { … } catch { return false }` so `ensureSocketDir`'s EACCES and `tryCreateLock`'s non-EEXIST rethrow can never escape:
  1. probe: connect + `initialize`; fingerprint matches ⇒ return true.
  2. `ensureSocketDir(socketPath(env))`, then `const held = acquireAcpLock(spawnLockPath(env), Date.now())`.
  3. if `held`: RE-probe (a winner may have finished between 1 and 2) ⇒ release + return true; otherwise spawn per the idiom above, **passing `env`**.
  4. if `!held`: another caller is mid-spawn — do NOT spawn and do NOT touch the lock file. **`releaseAcpLock` is an unlink; releasing a lock you never acquired deletes the winner's lock and lets the next caller spawn a duplicate.**
  5. if `waitMs === 0`: `if (held) releaseAcpLock(...)`; return false (kick-and-go). Else poll-connect until `waitMs`, then `if (held) releaseAcpLock(...)` in a `finally` and return the probe result.
  Holding the client lock across step 5's wait is safe precisely because the daemon takes the *bind* lock, not this one. With `waitMs: 0` two racing callers can both spawn — but only one can BIND, the loser exits 0 quietly and writes no spawn-log line, so "exactly one daemon serving" and "exactly one spawn-log line" both hold.
- **Deliberate split:** `daemonCall` never spawns. Spawning is `ensureDaemon`'s job (SessionStart hook, Task 8; batch runs call it once up front with a real `waitMs`). A Stop-hook deriver whose daemon is missing gets `no-call`, falls back this record, and the next session's hook re-ensures — no derivation ever waits out a daemon boot. This split is also why a fingerprint mismatch is a permanent 100% fallback rather than a self-healing extra spawn (§6e residual), and why Task 5's env contract is stated as a contract.
- **Shared outgoing text (§6e "the two lanes must differ in transport only"):** `agent-transport.ts`'s private `buildOutgoingText` (`:85-88`) appends the trailing schema instruction that IS the agent lane's entire schema-enforcement mechanism (spec §6d, "Schema enforcement differs between the arms"). It is exported as `buildAgentOutgoingText(messageText, schema)` so `callModelDerive` builds ONE string used byte-identically by `daemonCall` and `agentSdkCall`. `agentSdkCall` keeps calling it internally at `:118` and is byte-unchanged for its existing callers.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { daemonCall, ensureDaemon } from "../src/gauge/acp-client.ts"
import { buildAgentOutgoingText } from "../src/gauge/agent-transport.ts"
import { ACP_BUDGET, modelProvenBy } from "../src/gauge/acp-wire.ts"
import { envFingerprint } from "../src/gauge/acp-paths.ts"
import { fakeDaemon } from "./acp-fake-daemon.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS } from "./agent-cli-stub.ts"

// These tests talk to SCRIPTED FAKE daemons — no WarmSession, no CLI, no
// credentials, no model. They pin the CLIENT half of the wire contract
// independently of Task 5, so a Task 5 regression cannot mask a Task 6 one.
// EVERY fake echoes envFingerprint(THE SAME env object the test passes to
// daemonCall); a mismatched echo turns every case into a silent law-L1
// no-call that looks like a routing bug and is not one.
describe("acp-client (fake daemons only — no CLI, no model)", () => {
  test("law L1: no daemon at all -> no-call, fast", async () => {
    const t0 = Date.now()
    const r = await daemonCall("x", "claude-haiku-4-5", {
      ...process.env, KKAMAK_ACP_SOCKET: `${tmpdir()}/nope-${Date.now()}.sock`,
    })
    expect(r.kind).toBe("no-call")
    expect(Date.now() - t0).toBeLessThan(2_000)
  })
  test("round-trips against a scripted fake daemon -> ok, text, DATED model evidence", async () => {
    // fakeDaemon(sock, { fingerprint: envFingerprint(env), answer: "ok" })
    // The default fake reports a DATED key, so this pins that the client
    // forwards evidence verbatim rather than normalizing it (round-4 C1):
    //   r.kind === "ok", r.text === "ANSWER",
    //   r.model === "claude-haiku-4-5-20251001",
    //   modelProvenBy(r.model, "claude-haiku-4-5", r.canonicalModel) === true
  })
  test("law L3(i): ACP_ERR_CALL_CONSUMED maps to call-consumed, NOT no-call", async () => {
    // answer: "call-consumed" -> expect(r.kind).toBe("call-consumed")
    // this is what stops a double call
  })
  test("law L3(i): ACP_ERR_NO_CALL maps to no-call", async () => {
    // answer: "no-call" -> expect(r.kind).toBe("no-call")
  })
  test("law L3(i): data.callConsumed OVERRIDES a mismatched code", async () => {
    // answer: "mismatched-data" (NO_CALL code, data.callConsumed true)
    // -> expect(r.kind).toBe("call-consumed")   // the data field is authoritative
  })
  test("law L3(ii): a RECOGNIZED code with `data` ABSENT is HONOURED, both ways", async () => {
    // ROUND-4 I1's lock. The previous revision's L2 said "missing
    // data.callConsumed => call-consumed" while L3 said "the code is the
    // fallback for a daemon that omitted it" — a direct contradiction on
    // the one branch that decides between one and two model calls, with no
    // fixture either way. L3 step (ii) is now the single authority.
    // answer: "no-call-code-no-data"      -> expect(r.kind).toBe("no-call")
    // answer: "consumed-code-no-data"     -> expect(r.kind).toBe("call-consumed")
  })
  test("law L2: a NON-BOOLEAN data.callConsumed is an ambiguity, not a value", async () => {
    // answer: "nonboolean-data" (NO_CALL code, data.callConsumed === "false")
    // Step (i) requires typeof === "boolean", so this is NOT authoritative;
    // step (ii) would honour the NO_CALL code, but a malformed data field
    // means the daemon is not the conforming one step (ii) assumes, so it
    // falls to L2. -> expect(r.kind).toBe("call-consumed")
  })
  test("law L2: an UNRECOGNIZED error code after the prompt was sent is call-consumed", async () => {
    // answer: "unknown-code" -> expect(r.kind).toBe("call-consumed")
    // never no-call — that would double-spend
  })
  test("law L2: budget expiry after the prompt was sent is call-consumed", async () => {
    // answer: "hang", budgetMs 500 -> call-consumed, elapsed < 1.5s,
    // and fake.sawPrompt() === true (it really did cross the boundary)
  })
  test("law L1: a daemon that dies before session/prompt is written is no-call", async () => {
    // answer: "die-before-prompt" -> expect(r.kind).toBe("no-call")
    // and fake.sawPrompt() === false
  })
  test("law L1: a fingerprint mismatch refuses BEFORE sending anything", async () => {
    // fingerprint: envFingerprint({ ...env, ANTHROPIC_BASE_URL: "http://other" })
    // -> expect(r.kind).toBe("no-call") AND expect(fake.sawPrompt()).toBe(false)
  })
  test("ROUND-4 I4: lane selection and socket path do NOT change the client's fingerprint", async () => {
    // Build TWO envs differing only in KKAMAK_GAUGE_TRANSPORT (and pointing
    // at the same fake socket): both must reach the SAME fake without a
    // fingerprint refusal. This is the client-side half of the denylist
    // rule — the post-flip live path forces that variable into a derived
    // env while the daemon carries the ambient one.
    // -> both calls return kind "ok"; fake.sawPrompt() true for both.
  })
  test("daemonCall sends the model in _meta and the text verbatim", async () => {
    // fake.promptParams(): _meta.model === "claude-haiku-4-5",
    // prompt[0].text === the exact outgoing string passed in
  })
  test("the default budget is the contract constant, not a local literal", () => {
    // assert the exported default equals ACP_BUDGET.daemonLegMs; acp-client
    // must not define a second timing literal anywhere.
    expect(ACP_BUDGET.daemonLegMs).toBe(36_000)
  })
  test("buildAgentOutgoingText is the SAME builder the one-shot lane uses", () => {
    const s = { type: "object" } as Record<string, unknown>
    expect(buildAgentOutgoingText("P", s)).toContain("Respond with ONLY a JSON object matching this schema")
    expect(buildAgentOutgoingText("P", undefined)).toBe("P")
  })
  test("ensureDaemon spawns exactly ONE serving daemon under concurrent callers", async () => {
    // two ensureDaemon(env, { waitMs: 10_000 }) racing on one socket path:
    // both resolve true, and KKAMAK_ACP_TEST_SPAWN_LOG has exactly ONE line
    // (the log is written POST-LISTEN, so a losing starter contributes none).
    // `env` MUST carry KKAMAK_ACP_SOCKET + KKAMAK_ACP_TEST_SPAWN_LOG +
    // a short KKAMAK_ACP_IDLE_MS, and ensureDaemon must pass that same env
    // to Bun.spawn — with the bare inherit-process.env idiom the daemon
    // binds ~/.config/kkamak/acp-<fp>.sock instead and this test hangs to
    // its timeout (round-4 I2). afterEach reaps by post-listen pid.
  }, 30_000)
  test("ROUND-4 I2: the spawned daemon binds the socket the CALLER named", async () => {
    // ensureDaemon(env with a temp KKAMAK_ACP_SOCKET, { waitMs: 10_000 }).
    // Assert fs.existsSync(thatSocket) === true AND that
    // ~/.config/kkamak/ gained no acp-* file. A daemon spawned without an
    // explicit env would bind the DEFAULT fingerprinted path — the failure
    // is invisible to a naive "did ensureDaemon return true" assertion
    // because it returns false and the caller "just falls back".
  }, 30_000)
  test("ensureDaemon() defaults to waitMs 0: returns false immediately and still kicks a spawn", async () => {
    // < 500ms, returns false, spawn log eventually gains a line
  }, 30_000)
  test("ensureDaemon NEVER throws on an unwritable socket dir", async () => {
    // KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" -> resolves false, no
    // rejection. ensureSocketDir raises EACCES/EPERM there and
    // tryCreateLock rethrows anything but EEXIST; the SessionStart hook's
    // fail-open contract depends on this being caught HERE.
    await expect(ensureDaemon({ ...process.env, KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }, { waitMs: 0 }))
      .resolves.toBe(false)
  })
  test("a caller that LOSES the spawn lock never unlinks it", async () => {
    // Pre-create <socket>.spawn.lock with a FRESH {pid, ts}, then call
    // ensureDaemon(env, { waitMs: 0 }). Assert it returns false AND the lock
    // file still exists afterwards: releasing a lock you never acquired
    // deletes the winner's and lets the next caller spawn a duplicate.
  })
})

describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)("acp-client e2e (real daemon + SSE stub)", () => {
  test("ensureDaemon + daemonCall against the real daemon", async () => {
    // full path: ensureDaemon spawns real acp-daemon.ts (stub
    // ANTHROPIC_BASE_URL, temp KKAMAK_ACP_SOCKET, temp
    // KKAMAK_ACP_TEST_SPAWN_LOG, KKAMAK_ACP_IDLE_MS=8000 — round-4 M8),
    // daemonCall returns { kind:"ok" } and its model evidence satisfies
    // modelProvenBy against the requested id. SIGTERM the daemon BY PID from
    // the spawn log at the end (never pkill -f, §6e / round-4 I9) and assert
    // the socket file is gone.
  }, 60_000)
})
```

- [ ] **Step 2: Run to verify they fail** — `bun test test/acp-client.test.ts`, FAIL on missing exports.

- [ ] **Step 3: Implement** (~190 lines: `net.connect` + `setEncoding("utf8")` with its own `FrameDecoder`, request-id counter, pending-response map, notification handler collecting `session/update` text, ONE overall deadline; a single `sentPrompt` boolean assigned ONLY in the prompt frame's write callback, which IS §6e's client-side send boundary — every failure path consults it and nothing else to choose between `no-call` and `call-consumed`; the post-send branch implements L3's three steps in order, boolean `data.callConsumed` first, then a recognized code, then L2; `ensureDaemon` per the exact `held`-tracked sequence above, spawning `path.join(import.meta.dir, "acp-daemon.ts")` with the SAME env it fingerprinted, wrapped so nothing throws, and destroying every socket and clearing every timer before it resolves). Plus `test/acp-fake-daemon.ts` per the signature above. In `agent-transport.ts`, add `export` to `buildOutgoingText` and rename it `buildAgentOutgoingText` at its definition (`:85`) and its one internal call site (`:118`) — nothing else changes in that file.

- [ ] **Step 4: Run to verify green** — file suite, then full `bun test` 0 fail, `bunx tsc --noEmit` clean. Re-run `bun test test/gauge-agent-transport.test.ts` explicitly: the rename must leave every §6d assertion passing unmodified. Re-run the stray-daemon check from Task 5 Step 4.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/acp-client.ts cc-gate-plugin/src/gauge/agent-transport.ts \
        cc-gate-plugin/test/acp-client.test.ts cc-gate-plugin/test/acp-fake-daemon.ts
git commit -m "feat(gauge): ACP client — write-callback send boundary, L3 three-step mapping, fingerprint refusal, explicit-argv+env spawn, shared outgoing text"
```
git commit -m "feat(gauge): ACP client — write-callback send boundary, L3 three-step mapping, fingerprint refusal, explicit-argv+env spawn, shared outgoing text"
```

### Task 7: Route the transport — selection, safe fallback, honest stamping

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (`selectTransport` allow-list + `callModelDerive`)
- Modify: `cc-gate-plugin/src/gauge/corpus-replay.ts` (`deriveRecord` stamps the actual lane AND the actual model)
- Test: `cc-gate-plugin/test/gauge-transport-daemon.test.ts` (new file)

**Interfaces:**
- Consumes: `daemonCall` + `DaemonOutcome` (Task 6, **lazy-imported**); `buildAgentOutgoingText` (Task 6); `ACP_BUDGET` + `modelProvenBy` (Task 2, imported normally — `acp-wire.ts`'s only import is `node:string_decoder`); `agentSdkCall`, `sdkCall`, `resolveModelId`, `DERIVATION_SCHEMA`, `buildRefinerPrompt` (existing); `fakeDaemon` (Task 6's test helper) in the test file.
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
  The three existing `selectTransport` tests (`gauge-agent-transport.test.ts:53-65`) must pass UNMODIFIED — including `selectTransport({ KKAMAK_GAUGE_TRANSPORT: "" })` at `:56`, which the allow-list still resolves to `"sdk"`.
- **The daemon client is LAZY-IMPORTED, deliberately.** `hook-cli.ts:24` imports `transport.ts` eagerly on every hook event, so a top-level `import { daemonCall } from "./acp-client.ts"` would put `node:net` and the whole ACP client on PostToolUse, UserPromptSubmit and Stop — and would make Task 8's "imported lazily so the other three hook events pay nothing" claim false. Same discipline, same reason, as `agent-transport.ts:102-108`'s measured ~84 ms. `ACP_BUDGET` and `modelProvenBy` come from `acp-wire.ts` and may be imported normally.
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
    /** The model stamp: the RESOLVED requested id, identical in shape to
     * what §6c/§6d records already carry (`resolveModelId(...)`). For the
     * daemon lane this is written only after the turn's `modelUsage`
     * evidence PROVED that model under §6e's matching rule; for the `sdk`
     * and `agent-sdk` lanes it is the §6d requested-model stamp, per §6e's
     * registered asymmetry. */
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
  1. `model = resolveModelId(opts?.model ?? env.KKAMAK_GAUGE_MODEL ?? "haiku")` — byte-identical to `callModelSdk`'s own line `:234`.
  2. `selectTransport(env) !== "agent-sdk-daemon"` → today's behaviour byte-for-byte: `await callModelSdk(prompt, floorCheck, env, authDeps, opts)`, stamped with `selectTransport(env)` and `model`. No outgoing text is pre-built on this path — `callModelSdk` owns it, exactly as today. (§6e's model-proof rule does NOT bind here; `sdkCall` returns an API response the caller never inspects for provenance and `agentSdkCall` returns a bare string with no result surface at all — the asymmetry §6e registers rather than pretends away.)
  3. Daemon selected → build the shared text ONCE, then run the two legs inside one record budget:
     ```typescript
     const messageText = buildRefinerPrompt(prompt, floorCheck, opts?.promptVariant ?? "base")
     const outgoing = buildAgentOutgoingText(
       messageText,
       DERIVATION_SCHEMA as unknown as Record<string, unknown>,   // same double cast as transport.ts:238/242
     )
     const { daemonCall } = await import("./acp-client.ts")   // LAZY: hook-cli.ts:24 imports this module eagerly
     const started = Date.now()
     const d = await daemonCall(outgoing, model, env, { budgetMs: ACP_BUDGET.daemonLegMs })
     if (d.kind === "ok") {
       // §6e provenance, daemon lane. `d.model` is the turn's `modelUsage`
       // KEY and `d.canonicalModel` that entry's canonicalModel — EVIDENCE
       // forwarded verbatim from the result, so this check is real and not
       // a tautology against our own request.
       //
       // modelProvenBy, NOT `d.model !== model`. The real API keys
       // modelUsage by the DATED snapshot id
       // (opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22
       // => "claude-haiku-4-5-20251001") while resolveModelId("haiku")
       // yields the undated alias; a strict-equality reject would discard
       // EVERY honest derivation and turn Task 9's sized go into a full
       // spend for zero records (round-4 C1).
       if (!modelProvenBy(d.model, model, d.canonicalModel)) return undefined
       return { raw: d.text, transport: "agent-sdk-daemon", model }
     }
     // §6e law: fallback ONLY on no-call, and after round-3's C1 a `no-call`
     // can only mean the prompt bytes never crossed the boundary — on either
     // side of the wire. A `call-consumed` fallback would be model call #2
     // for one record and would make `--go N` mean 2N.
     if (d.kind === "call-consumed") return undefined
     const remaining = ACP_BUDGET.recordBudgetMs - (Date.now() - started)
     if (remaining < ACP_BUDGET.minFallbackMs) return undefined
     const raw = await agentSdkCall(outgoing, model, env, { timeoutMs: remaining })
     return raw === undefined ? undefined : { raw, transport: "agent-sdk", model }
     ```
     `agentSdkCall` is called WITHOUT a schema because `outgoing` already carries the trailing schema instruction — `buildAgentOutgoingText(messageText, undefined)` returns its input verbatim (`agent-transport.ts:86`), so the fallback leg's bytes are identical to the daemon leg's. Budget: the daemon leg is capped at 36 000 ms and the fallback starts only with ≥ 10 000 ms left of 60 000, so the record can never exceed `recordBudgetMs` plus the CLI's own spawn/abort overhead.
- `deriveRecord` (`corpus-replay.ts:41-79`) switches from `callModelSdk` + two independent stamps to `callModelDerive`'s returned `transport` AND `model` — selection, stamp and model can no longer diverge (the §6d cls-ab lesson, now structural). `corpus-replay.ts:73`'s `model: resolveModelId(process.env.KKAMAK_GAUGE_MODEL ?? "haiku")` and `:75`'s `transport: selectTransport(process.env)` both become reads off the result. **`resolveModelId` and `selectTransport` then become unused in that file — remove them from the import at `corpus-replay.ts:26`** (leaving `callModelDerive`), and update the file-header comment at `:5-9` which currently names `callModelSdk` as the one shared transport.
  Regression note: `corpus-replay.test.ts:82` asserts `d.model === "claude-haiku-4-5"` and `:86`/`:170` assert `transport === "sdk"` on the DEFAULT env via `withSdkStub`. Path 2 stamps exactly those values, so all three stay green untouched — verify, do not edit.

- [ ] **Step 1: Write the failing tests**

```typescript
import { describe, expect, test } from "bun:test"
import { tmpdir } from "node:os"
import { selectTransport, callModelDerive } from "../src/gauge/transport.ts"
import { deriveRecord } from "../src/gauge/corpus-replay.ts"
import { ACP_BUDGET } from "../src/gauge/acp-wire.ts"
import { envFingerprint } from "../src/gauge/acp-paths.ts"
import { fakeDaemon } from "./acp-fake-daemon.ts"
import { HAS_CLAUDE_CODE_CREDENTIALS, sseText, silentServer } from "./agent-cli-stub.ts"
import { stubServer } from "./sdk-stub.ts"

const CLI_TEST_TIMEOUT_MS = 90_000   // fallback tests spawn the bundled CLI

// selectTransport is pure — no CLI, no credentials, no timeout needed.
describe("selectTransport allow-list (§6e)", () => {
  test("accepts the new literal; defaults and the retired literal are unchanged", () => {
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe("agent-sdk-daemon")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk" })).toBe("agent-sdk")
    expect(selectTransport({})).toBe("sdk")
    expect(selectTransport({ KKAMAK_GAUGE_TRANSPORT: "" })).toBe("sdk")
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
  /** EVERY fake in this file MUST be built with this fingerprint, computed
   * from the SAME env object the test passes to callModelDerive. A fake that
   * echoes anything else makes the client refuse pre-send (law L1), every
   * case silently becomes the fallback, and three of the tests below would
   * pass for entirely the wrong reason.
   *
   * Note that `KKAMAK_GAUGE_TRANSPORT` and `KKAMAK_ACP_SOCKET` are both
   * DENYLISTED (round-4 I4), so `stubEnv`'s per-test socket path does not
   * perturb the fingerprint — which is the property that makes a shared
   * helper like this usable at all. */
  const fpOf = (env: Record<string, string | undefined>) => envFingerprint(env)

  test("no-call fallback stamps agent-sdk, not agent-sdk-daemon", async () => {
    // deadSock (never created) -> law L1 no-call -> fallback runs
    const r = await callModelDerive("p", "check", stubEnv(agentStub.url, sdkStub.url, deadSock))
    expect(r?.transport).toBe("agent-sdk")
    expect(r?.model).toBe("claude-haiku-4-5")
  }, CLI_TEST_TIMEOUT_MS)

  test("call-consumed does NOT fall back — undefined, and the one-shot endpoint is never hit", async () => {
    // fakeDaemon(sock, { fingerprint: fpOf(env), answer: "call-consumed" })
    const r = await callModelDerive("p", "check", env)
    expect(r).toBeUndefined()
    expect(agentStub.captured.length).toBe(0)   // THE binding assertion: never a second call
  }, CLI_TEST_TIMEOUT_MS)

  test("ROUND-4 C1: a DATED modelUsage key PROVES the undated request — the record is written", async () => {
    // The fake's DEFAULT model is the requested id with "-20251001"
    // appended, i.e. exactly what the real API returns. A strict-equality
    // check here returns undefined and Task 9 spends ten calls for zero
    // records; modelProvenBy returns a stamped record.
    // fakeDaemon(sock, { fingerprint: fpOf(env), answer: "ok" })
    const r = await callModelDerive("p", "check", env)
    expect(r?.transport).toBe("agent-sdk-daemon")
    expect(r?.model).toBe("claude-haiku-4-5")   // the RESOLVED REQUESTED id is the stamp...
    expect(fake.promptParams()!._meta.model).toBe("claude-haiku-4-5")
    expect(agentStub.captured.length).toBe(0)   // ...and the daemon served it; no spawn
  }, CLI_TEST_TIMEOUT_MS)

  test("canonicalModel alone can prove a provider-specific key", async () => {
    // fakeDaemon(..., { answer: "ok", model: "bedrock/anthropic.claude-haiku",
    //                   canonicalModel: "claude-haiku-4-5" })
    const r = await callModelDerive("p", "check", env)
    expect(r?.transport).toBe("agent-sdk-daemon")
  }, CLI_TEST_TIMEOUT_MS)

  test("a daemon that reports a DIFFERENT model produces no record — and no fallback", async () => {
    // fakeDaemon(..., { answer: "ok", model: "claude-opus-5-20260101" }) for a
    // haiku request. This is the branch a request-echo design could never
    // test: daemon-side the model is EVIDENCE from modelUsage, so it CAN
    // diverge. The call was consumed, so there is NO fallback either.
    const r = await callModelDerive("p", "check", env)
    expect(r).toBeUndefined()
    expect(agentStub.captured.length).toBe(0)
  }, CLI_TEST_TIMEOUT_MS)

  test("both agent legs receive byte-identical outgoing text", async () => {
    // run once against an "ok" fake (capturing fake.promptParams()!.prompt[0].text)
    // and once against deadSock (capturing the agent stub's messages[0].content);
    // assert equal, and that both contain the schema instruction.
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
test("default env -> derivation.transport sdk, model claude-haiku-4-5 (unchanged)", async () => { /* ... */ })
```

- [ ] **Step 2: Run to verify they fail** — missing export.

- [ ] **Step 3: Implement.** ~70 lines in `transport.ts` (with the lazy `await import("./acp-client.ts")` inside the daemon branch ONLY), ~8 changed lines in `corpus-replay.ts` (including the import trim and the header comment). **The live-path pin tests (`gauge-refiner-cli.test.ts:56-86`, `:105`, `gauge-wiring.test.ts:102`) must stay green untouched** — `refiner-cli.ts:54` still strips the env var, so live derives keep running `"sdk"` regardless of this task.
Grep-verify: `grep -rn 'transport: selectTransport' cc-gate-plugin/src/` — currently TWO hits (`refiner-cli.ts:85`, `corpus-replay.ts:75`); expect exactly ONE afterwards (`refiner-cli.ts:85`, the live pin). `corpus-replay.ts:75` must no longer appear.
Import-purity re-check (round-3 I7's lock): `grep -n 'acp-client' cc-gate-plugin/src/gauge/transport.ts` must show the string ONLY inside an `await import(...)` — never on a top-level `import` line.
Proof-rule single-source check (round-4 C1's lock): `grep -rn 'modelProvenBy\|startsWith(.*model' cc-gate-plugin/src/gauge/` must show `modelProvenBy` DEFINED once (`acp-wire.ts`) and CALLED from exactly two places (`warm-session.ts`'s multi-key branch, `transport.ts`'s daemon branch). A second hand-rolled comparison anywhere is the defect this rule exists to prevent.

- [ ] **Step 4: Full suite green** — `bun test` 0 fail, `bunx tsc --noEmit` clean.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/corpus-replay.ts \
        cc-gate-plugin/test/gauge-transport-daemon.test.ts
git commit -m "feat(gauge): route agent-sdk-daemon, fallback only on no-call, dated-key model proof, honest lane+model stamp"
```

### Task 8: SessionStart ensure-hook (through the existing dispatcher), gated by the SHARED live-lane predicate

**Files:**
- Modify: `cc-gate-plugin/src/gauge/transport.ts` (export `liveDerivesOnDaemon` — the ONE predicate)
- Modify: `cc-gate-plugin/src/hook-cli.ts` (add `"SessionStart"` to `KNOWN_EVENTS` at line 36 + one early branch)
- Modify: `cc-gate-plugin/hooks/hooks.json` (add a SessionStart entry, `timeout: 30`)
- Test: `cc-gate-plugin/test/acp-ensure.test.ts`

**Why NOT a standalone CLI.** `test/packaging.test.ts:64-75` asserts that **every** hook command references `src/hook-cli.ts` and that the file exists; `:86-95` asserts every non-`Stop` entry has `timeout === 30`. A `hooks.json` entry pointing at `src/gauge/acp-ensure-cli.ts` turns that test red, which the Global Constraints forbid. Routing through the existing dispatcher keeps both assertions green, matches the shape of all three existing entries, and is F1-clean (`hook-cli.ts` is not a MECHANISM_PATH; the Phase-2 fixture harvest set the "hook-cli.ts wiring" precedent). Verified 2026-08-04: `packaging.test.ts` is the ONLY file that reads `hooks.json` at all, and it asserts nothing about the event SET.

**THE PREDICATE (round-4 C2) — this is the load-bearing part of the task, not the plumbing.**
`transport.ts` exports ONE function that both this hook and (post-flip) `refiner-cli.ts` read:

```typescript
/** §6e SINGLE SOURCE for "the live derive path uses the warm-daemon lane".
 *
 * Read by TWO callers and they must never disagree:
 *   · hook-cli.ts's SessionStart branch — whether to ensure a daemon exists.
 *   · refiner-cli.ts (Task 10 only) — which lane to force into its liveEnv.
 *
 * The Task 10 flip changes THIS BODY and nothing else about lane selection.
 * That is the whole point: with two independent conditions, the flip ships a
 * live path that always takes the daemon lane and an ensure-hook that only
 * fires when an env var nobody sets is present — so every live derive finds
 * no daemon, takes the law-L1 fallback, and pays the full 1.25-1.46 s CLI
 * spawn per Stop hook. That is strictly WORSE than the pre-flip instrument
 * (a ~5 ms direct API call) and it stamps `"agent-sdk"`, a lane the §6e bar
 * never measured. §6e's Live flip gate clause (3) forbids exactly that.
 *
 * Lives in transport.ts, not acp-client.ts: hook-cli.ts:24 already imports
 * transport.ts eagerly, so reading the predicate costs the hook nothing,
 * while `ensureDaemon` itself stays behind a lazy import inside the branch. */
export function liveDerivesOnDaemon(env: Record<string, string | undefined>): boolean {
  // TASK 10 FLIPS THIS LINE TO `return true` (and refiner-cli.ts starts
  // reading it). Until then the daemon lane is opt-in and the live path is
  // pinned to "sdk" by refiner-cli.ts:54's strip.
  return env.KKAMAK_GAUGE_TRANSPORT === "agent-sdk-daemon"
}
```

**Interfaces:**
- Consumes: `ensureDaemon` (Task 6, lazy-imported); `liveDerivesOnDaemon` (this task, eager — it is a pure predicate in an already-eager module).
- Produces: `bun "${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts" SessionStart` — fire-and-forget. The branch sits **after** the `session_id`/`cwd` string checks (`:116-117`, which a SessionStart payload satisfies — CC sends both) and **before** `readGateConfigRaw`/`FileStateStore` (`:119-121`; a daemon kick must not depend on gate config).
- **THE BRANCH RETURNS UNCONDITIONALLY (round-4 I7).** Write it exactly this shape:
  ```typescript
  if (event === "SessionStart") {
    if (liveDerivesOnDaemon(process.env)) {
      try {
        const { ensureDaemon } = await import("./gauge/acp-client.ts")
        await ensureDaemon(process.env, { waitMs: 0 })
      } catch { /* fail-open: a daemon kick must never affect a session */ }
    }
    return                      // <-- OUTSIDE the if. NOT optional.
  }
  ```
  The `return` is outside the transport check because **`Stop` is the UNGUARDED FALL-THROUGH**: `hook-cli.ts` has `if (event === "PostToolUse") {…}` at `:123`, `if (event === "UserPromptSubmit") {…}` at `:131`, and then the bare comment `// event === "Stop"` at `:221` followed by `handleStop`. Once `"SessionStart"` joins `KNOWN_EVENTS` (`:36`) the `:94` unknown-event guard no longer protects it, so a `return` nested inside the `if` means every SessionStart with the daemon lane OFF — i.e. the default, i.e. essentially all of them — runs `handleStop` on a SessionStart payload. In THIS repo that means executing `gate.json`'s check, which is `cd cc-gate-plugin && bun test && cd ../gate-plugin && bun test && cd ../km-crank && bun test && cd .. && bun scripts/doc-check.ts` — the entire test suite — on every session start, plus a fabricated sensor line and a possible exit-2 block. The tests below cannot detect it by accident (they run with `cwd` = `cc-gate-plugin`, which has no `gate.json`), so one of them creates a repo WITH a `gate.json` and asserts no sensor line appears.
- **Self-budget < 500 ms, and that is an assertion, not an aspiration.** `hook-cli.ts` has NO forced `process.exit(0)` on its success path — `main().catch(...)` at `:339-346` only fires on rejection, and `PostToolUse` at `:128` simply returns. A SessionStart hook that leaves one un-destroyed probe socket or one uncleared timer therefore keeps the process alive until CC's `timeout: 30`, delaying EVERY session start by up to 30 s. `ensureDaemon` destroys every socket it opens and clears every timer before resolving (Task 6), and every test below asserts a wall-clock bound so a regression is loud.
- **No SessionEnd hook** — registered in §6e, not decided here: the daemon is HOST-GLOBAL, so tearing it down when one CC window closes would kill the warm session other windows and any running batch still need. The 15-minute idle self-exit owns shutdown and fires only when nothing is in flight.
- `ensureDaemon` is imported LAZILY inside the branch (`await import("./gauge/acp-client.ts")`) so the other three hook events pay nothing for it. **That saving is only real because Task 7 also keeps `transport.ts` free of a top-level `acp-client` import** — `hook-cli.ts:24` imports `transport.ts` eagerly, so an eager import there would put the client on every event regardless of what this branch does. `acp-client.ts` imports its path helpers from `acp-paths.ts`, never from `acp-daemon.ts`, so this import can never start a server inside the hook process (Task 5's import-purity check).

- [ ] **Step 1: Write the failing tests**

```typescript
import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const HOOK_CLI = path.join(import.meta.dir, "..", "src", "hook-cli.ts")
const SESSION_START_STDIN = JSON.stringify({ session_id: "s1", cwd: process.cwd(), source: "startup" })

/** Build a child env by explicit deletion — spreading `{...process.env,
 * K: undefined}` into Bun.spawn does NOT reliably drop the key, and an
 * inherited KKAMAK_GAUGE_TRANSPORT would make this test fork a REAL daemon
 * at the host's default socket. */
function envWithout(keys: string[], extra: Record<string, string> = {}): Record<string, string> {
  const e = { ...process.env } as Record<string, string>
  for (const k of keys) delete e[k]
  // Round-4 M8: never let a test daemon inherit the 900 000 ms production
  // idle budget. Anything a test starts must self-exit in seconds even if
  // the afterEach kill misses it.
  return { ...e, KKAMAK_ACP_IDLE_MS: "8000", ...extra }
}

/** Poll a file for exactly `n` non-empty lines, up to `ms`. The spawn is
 * detached and asynchronous, so a bare read races it; the daemon writes its
 * line POST-LISTEN (Task 5), so "one line" means "one daemon serving". */
async function waitForLines(file: string, n: number, ms: number): Promise<string[]> { /* ... */ }

/** Pid-scoped reaper — never `pkill -f` (§6e forbids host-wide teardown,
 * round-4 I9). Reads the POST-LISTEN pids from the spawn log. */
function reap(sock: string, spawnLog: string): void { /* SIGTERM each pid; rm sock + both locks + log */ }

const LIVE: Array<{ sock: string; spawnLog: string }> = []
afterEach(() => {
  while (LIVE.length) { const e = LIVE.pop()!; reap(e.sock, e.spawnLog) }
  const dir = path.join(process.env.HOME ?? "", ".config", "kkamak")
  const leaked = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.startsWith("acp-")) : []
  expect(leaked).toEqual([])          // no test may ever touch the real store
})

describe("SessionStart ensure-daemon hook", () => {
  test("no-op exit 0 when the live path is not on the daemon lane", () => {
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout(["KKAMAK_GAUGE_TRANSPORT"], { KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)   // no lingering handles
    expect(fs.existsSync(SPAWN_LOG)).toBe(false)       // nothing was spawned
  })

  test("ROUND-4 I7: SessionStart NEVER falls through to the Stop path", () => {
    // The branch's `return` must be OUTSIDE the transport check. hook-cli.ts
    // has no `if (event === "Stop")` — Stop is what you reach by falling off
    // the end (`:221`). A nested return means every default-configuration
    // SessionStart runs handleStop, which in THIS repo executes gate.json's
    // check: the entire test suite, on every session start. The other tests
    // in this file cannot see it (their cwd has no gate.json), so this one
    // builds a repo that DOES.
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "km-ss-fallthrough-"))
    // A check that is instantaneous but UNMISTAKABLE if it ever runs.
    const marker = path.join(repo, "STOP-PATH-RAN")
    fs.writeFileSync(path.join(repo, "gate.json"),
      JSON.stringify({ check: `touch '${marker}'`, rounds: 2, gauge: true }))
    fs.mkdirSync(path.join(repo, ".km", "cc-gate"), { recursive: true })
    fs.writeFileSync(path.join(repo, ".km", "cc-gate", "ss-sid.json"), JSON.stringify({
      v: 1, edited: true, gating: false, round: 0, outcomes: [],
      cycleStartedAt: 0, failStreak: 0, updatedAt: Date.now(),
    }))
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(JSON.stringify({ session_id: "ss-sid", cwd: repo, source: "startup" })),
      env: envWithout(["KKAMAK_GAUGE_TRANSPORT"]),
    })
    expect(p.exitCode).toBe(0)
    expect(p.stdout.toString()).toBe("")                                   // no block payload
    expect(fs.existsSync(marker)).toBe(false)                              // the check NEVER ran
    expect(fs.existsSync(path.join(repo, ".km", "gate-outcomes.ndjson"))).toBe(false)  // no sensor line
    expect(Date.now() - started).toBeLessThan(3_000)
    fs.rmSync(repo, { recursive: true, force: true })
  })

  test("exit 0 even when the socket dir is unwritable (fail-open)", () => {
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: "/nonexistent-dir/x.sock" }),
    })
    expect(p.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)
  })

  test("armed: exits 0 fast AND kicks exactly one serving daemon", async () => {
    LIVE.push({ sock: TMP_SOCK, spawnLog: SPAWN_LOG })
    const started = Date.now()
    const p = Bun.spawnSync(["bun", HOOK_CLI, "SessionStart"], {
      stdin: Buffer.from(SESSION_START_STDIN),
      env: envWithout([], { KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon", KKAMAK_ACP_SOCKET: TMP_SOCK, KKAMAK_ACP_TEST_SPAWN_LOG: SPAWN_LOG }),
    })
    expect(p.exitCode).toBe(0)
    expect(Date.now() - started).toBeLessThan(3_000)   // waitMs 0: kick and go,
    // and — because hook-cli has no forced exit on success — proof that no
    // socket or timer is keeping the hook process alive.
    // The name of this test is also its assertion: poll for the post-listen
    // line rather than asserting nothing, and prove no SECOND daemon bound.
    const lines = await waitForLines(SPAWN_LOG, 1, 15_000)
    expect(lines.length).toBe(1)
    // Round-4 I2: the daemon must have bound the socket the HOOK named, not
    // the default fingerprinted path. ensureDaemon passes its env to
    // Bun.spawn explicitly; the bare inherit idiom fails here.
    expect(fs.existsSync(TMP_SOCK)).toBe(true)
  }, 30_000)

  test("the ensure gate is the SAME predicate the live derive path reads", async () => {
    // Round-4 C2's structural lock, asserted at the source of truth rather
    // than through two independent env checks. Pre-flip this is
    // env-dependent; Task 10 flips the body to `return true` and updates the
    // first test in this file in the SAME commit. If a future edit changes
    // one caller and not the other, this fails.
    const { liveDerivesOnDaemon } = await import("../src/gauge/transport.ts")
    expect(liveDerivesOnDaemon({ KKAMAK_GAUGE_TRANSPORT: "agent-sdk-daemon" })).toBe(true)
    expect(liveDerivesOnDaemon({})).toBe(false)          // Task 10 flips this line to `true`
    const src = fs.readFileSync(path.join(import.meta.dir, "..", "src", "hook-cli.ts"), "utf-8")
    expect(src).toContain("liveDerivesOnDaemon")          // the hook reads the predicate, not the raw env var
  })
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
Every test sets `KKAMAK_ACP_SOCKET` to a per-test temp path and `KKAMAK_ACP_IDLE_MS` to a few seconds, and the `afterEach` SIGTERMs the pids recorded in the spawn log (the `Bun.spawn` handle is the `bash -c nohup` shell, not the daemon), removes the socket, the spawn log and both lock files, and then asserts `~/.config/kkamak/` holds no `acp-*` file.

- [ ] **Step 2: Run to verify they fail** — `SessionStart` is not in `KNOWN_EVENTS` (`hook-cli.ts:36`), so the hook exits 0 silently at `:94`, the spawn-log poll times out, `liveDerivesOnDaemon` does not exist, and the packaging assertion fails on a missing key.

- [ ] **Step 3: Implement** `liveDerivesOnDaemon` in `transport.ts`, the `KNOWN_EVENTS` addition, the early branch (with the UNCONDITIONAL `return`), and the `hooks.json` entry:

```json
"SessionStart": [{ "hooks": [{ "type": "command", "command": "bun \"${CLAUDE_PLUGIN_ROOT}/src/hook-cli.ts\" SessionStart", "timeout": 30 }] }]
```

- [ ] **Step 4: Full suite green** — `bun test` 0 fail (including `packaging.test.ts` UNMODIFIED), `bunx tsc --noEmit` clean. Re-run Task 5 Step 4's stray-daemon check.

- [ ] **Step 5: Commit**

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/hook-cli.ts \
        cc-gate-plugin/hooks/hooks.json cc-gate-plugin/test/acp-ensure.test.ts
git commit -m "feat(gauge): SessionStart ensure-daemon via hook-cli dispatcher, gated by the shared live-lane predicate (opt-in, fail-open, unconditional return)"
```

### Task 9: Paired validation of the daemon lane (REAL SPEND — own sized go)

- [ ] **Step 1: Preserve the §6d arm BEFORE anything else.** `pv-sample --reset` `rmSync`s the shadow root (`paired-validation.ts:218`), and `.km/gauge-corpus-shadow/` currently holds the ONLY record-level `agent-sdk` derivations on this host (verified 2026-08-04: 10 records, all `transport:"agent-sdk"`, in the nested `.km/gauge-corpus/records.ndjson`; zero `agent-sdk` records anywhere else). Copy it aside host-locally first:

```bash
cp -a .km/gauge-corpus-shadow /mnt/d/tmp/gauge-corpus-shadow-6d-$(date +%s)
```

This is the data §6e's falsification criterion reads (C-stratum only; the not-C stratum is an independent draw in each run and is not comparable). The committed `docs/gauge-pv/yoo-dev-sdk-vs-agent-sdk-pv-counts.json` carries the per-key classes that travel. `cp -a` preserves the nested store AND the §6d `pv-counts.json` at the shadow root.

- [ ] **Step 2: STOP and report before spending.** Run `bun cc-gate-plugin/src/gauge/replay-cli.ts pv-sample --pair sdk:agent-sdk-daemon --reset` (token-free) and report: **the printed sample size, verbatim** (expected 5 C + 5 not-C = 10, since the whole sdk-derived C stratum is 5 — measured 2026-08-04: 109 `transport:"sdk"` records, 5 of class C — but `drawNotC` prints a smaller total when the not-C pool is short, `paired-validation.ts:222-226`), the model (haiku unless overridden), that the shadow derive is real spend, and that §6e registers this bar as having no power to separate a small effect (5-record C stratum, cap `ceil(0.1 × 5) = 1`, and §6d landed at exactly 0.800 agreement with missedC 1 — both edges, zero slack). **Do not proceed without an explicit sized go, and size it to the number `pv-sample` actually printed, not to 10** (round-4 M2: `runDerive` refuses unless `--go` equals the pending count exactly, `corpus-replay.ts:151-157`, so a hardcoded 10 against a 9-record sample is a zero-effect refusal — recoverable, but it burns a go round-trip).

  **Note the liveness gate is NOT here.** A daemon proved alive before a human stop-gate is stale by the time the go arrives: the idle reaper would have fired, record #1 would fall back to `"agent-sdk"`, `wrongTransport` would be non-zero, `evaluatePvBar` would return NOT-EVALUATED (`paired-validation.ts:472-481`), and recovery is expensive. The proof therefore lives INSIDE the spend script (Step 3), moments before the first record.

- [ ] **Step 3: On a granted go, run ONE script — liveness proof and spend in the same process, on a DEDICATED socket, terminating only ITS OWN daemon.**

```bash
set -euo pipefail

# Size this to what Step 2 printed. `runDerive` refuses unless --go equals
# the pending count exactly (corpus-replay.ts:151-157).
GO="${1:?usage: run-6e-validation.sh <go, the number pv-sample printed>}"

export KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon

# §6e validation-run instrument parameters, registered pre-data. The
# DEDICATED SOCKET is load-bearing, not tidiness: KKAMAK_ACP_IDLE_MS and
# KKAMAK_ACP_SOCKET are BOTH on the fingerprint denylist (acp-paths.ts
# ACP_ENV_DENYLIST), so neither produces a distinct default socket path.
# Without an explicit socket, a daemon already listening at the fingerprinted
# path — very likely on a dev host once Task 8's SessionStart hook is armed —
# would be ADOPTED by the liveness probe and would serve this run under ITS
# 15-minute idle budget, leaving the registered parameter silently inert.
export KKAMAK_ACP_SOCKET="/tmp/kkamak-acp-6e-validation-$$.sock"
export KKAMAK_ACP_IDLE_MS=3600000
# The daemon writes its pid here AFTER a successful listen (Task 5). This is
# the ONLY sanctioned way to terminate it: §6e forbids host-wide pattern
# teardown, and the socket path is in the env, not the cmdline, so `pkill -f`
# could not scope to this run even if it were allowed (round-4 I9).
export KKAMAK_ACP_TEST_SPAWN_LOG="/tmp/kkamak-acp-6e-validation-$$.spawnlog"

cleanup() {
  if [ -f "$KKAMAK_ACP_TEST_SPAWN_LOG" ]; then
    while read -r pid _rest; do
      case "$pid" in ''|*[!0-9]*) continue ;; esac
      kill -TERM "$pid" 2>/dev/null || true
    done < "$KKAMAK_ACP_TEST_SPAWN_LOG"
  fi
  sleep 1
  if [ -e "$KKAMAK_ACP_SOCKET" ]; then
    echo "ERROR: validation socket survived teardown: $KKAMAK_ACP_SOCKET" >&2
    exit 1
  fi
  echo "validation socket removed"
}
trap cleanup EXIT

# Token-free liveness gate, immediately before the spend. A `false` here
# exits non-zero and `set -e` stops the script BEFORE any model call.
bun -e 'import("./cc-gate-plugin/src/gauge/acp-client.ts").then(async (m) => {
  const up = await m.ensureDaemon(process.env, { waitMs: 10_000 })
  console.log("daemon ready:", up); process.exit(up ? 0 : 1)
})'

bun cc-gate-plugin/src/gauge/replay-cli.ts derive \
  /home/th-yoo/z2/meta-harness/.km/gauge-corpus-shadow --go "$GO"
bun cc-gate-plugin/src/gauge/replay-cli.ts pv-compare --pair sdk:agent-sdk-daemon
```

Round-4 M3: the teardown is an `if`/`exit 1`, not `test ! -e … && echo`. Under `set -e` the latter is exempt from the errexit rule (a failing command before the final `&&` never triggers an exit), so a surviving socket produced silence and a green script — the exact opposite of an assertion. It also runs from a `trap … EXIT`, so a failed derive still reaps the run's daemon.

- [ ] **Step 4: Sanity BEFORE reading the verdict, and the THREE different recovery paths.** Read the `pv-compare` counts. `undecided` and `wrongTransport` mean different things and cost very different amounts — do not conflate them:

  - **`wrongTransport > 0`** — records were derived on the WRONG lane, i.e. they fell back to `"agent-sdk"` (the daemon died mid-batch, or the client refused it) or the stamp plumbing broke. `evaluatePvBar` returns NOT-EVALUATED. These records are already stage `"derived"`, so `runDerive` will not re-derive them (`corpus-replay.ts:151-157` refuses unless `go === pending.length`, and they are not pending). **Recovery IS expensive: a full `pv-sample --reset` and a fresh spend, which needs its own new go.** Diagnose first — is the daemon process still alive (check the pid in `$KKAMAK_ACP_TEST_SPAWN_LOG`)? did the idle reaper fire despite `KKAMAK_ACP_IDLE_MS` (did the run actually use its dedicated socket, or adopt someone else's daemon)? does the spawn log show a second daemon binding mid-batch? — before requesting it.
  - **`wrongTransport === total` (EVERY record fell back)** — this is a FINGERPRINT or ENSURE defect, not a flaky daemon, and it has its own cheap diagnosis. Because `daemonCall` never spawns, a client/daemon fingerprint mismatch produces a silent 100% fallback that looks exactly like "the daemon was never up" (§6e residual). Run, token-free:
    ```bash
    bun -e 'Promise.all([import("./cc-gate-plugin/src/gauge/acp-paths.ts")]).then(([p]) =>
      console.log("client fp:", p.envFingerprint(process.env), "socket:", p.socketPath(process.env)))'
    ```
    and compare against the daemon's `initialize._meta.envFingerprint`. If they differ, an env key that should be denylisted is not (round-4 I4 denylisted `KKAMAK_GAUGE_TRANSPORT` and `KKAMAK_ACP_SOCKET` for exactly this reason) — fix the denylist and re-run; do NOT re-spend until the two fingerprints match.
  - **`undecided > 0` with `wrongTransport === 0`** — records came back `undefined` (a `call-consumed` turn, a parse failure, or a model the result could not prove) and are still stage `"mined"`. This is the ORDINARY outcome of §6e law L5 and it is CHEAP to finish: `bun cc-gate-plugin/src/gauge/replay-cli.ts derive <shadowRoot> --go <the current pending count>` re-derives exactly those records and nothing else. Report the residual pending count and request a sized go for that number — NOT for the original total. **One check first, because it is the difference between a cheap top-up and an infinite loop of spend:** if `undecided` equals the whole sample, suspect the model-proof rule before re-spending. `modelProvenBy` reconciles a DATED `modelUsage` key against the undated request (round-4 C1); a regression there rejects every honest turn identically, and a second `--go` would spend the same number of calls for the same zero records. Confirm against the `modelUsage` keys Task 4 Step 4 recorded before asking for the top-up.

  This is why Task 7's stamp honesty is load-bearing: the partition SEES a fallback instead of silently absorbing it, which is what makes these cases distinguishable at all.

- [ ] **Step 5: Commit the counts** (F2: counts travel, prompts do not). `pv-compare`'s only write is `pv-counts.json` at the shadow root (`paired-validation.ts:895-901`); the operator copies it into the repo:

```bash
cp .km/gauge-corpus-shadow/pv-counts.json \
   "docs/gauge-pv/$(hostname)-sdk-vs-agent-sdk-daemon-pv-counts.json"
bun scripts/doc-check.ts
git add docs/gauge-pv/
git commit -m "docs(gauge-pv): 6e sdk-vs-agent-sdk-daemon paired-validation counts"
```
git commit -m "docs(gauge-pv): 6e sdk-vs-agent-sdk-daemon paired-validation counts"
```

### Task 10: Verdict, and the live flip ONLY on a pass

> **OPEN QUESTION FOR THE USER, answer before Step 3 runs.** §6e registers
> that this bar has no statistical power: the whole `"sdk"`-derived class-C
> stratum on `yoo-dev` is 5 records, the missed-C cap is 1, and agreement
> ≥ 0.80 over a union of 5 means 4/5 — §6d already landed on both edges
> with zero slack (agreement exactly 0.800, missedC exactly 1 of a cap of
> 1). The flip is user-directed and reversible with one commit revert, so a
> PASS is sufficient under the rulings as given. **Do you want the live flip
> to additionally wait until the sdk-derived C stratum is materially larger
> (more live derivations accumulated), or to proceed on the 10-record
> result?** This is a question, not a bar change: the §6e bar constants are
> registered pre-data and are not being touched either way.

- [ ] **Step 1: Script-tally the verdict** (counts only, never quote notes): re-run `pv-compare --pair sdk:agent-sdk-daemon`, record agreement and missed-C against the §6e bar.

- [ ] **Step 2: If the bar FAILS** — append the measured counts to §6e, state that the daemon stays available with split readings and that live keeps `"sdk"`, STOP. Complete outcome.

- [ ] **Step 3: If the bar PASSES (and the OPEN QUESTION is answered "proceed") — flip the live pin, WITH the safe fallback AND the ensure gate, in ONE commit.**

**The flip is TWO source edits that must land together (round-4 C2).**

  **(i) `transport.ts` — flip the shared predicate's body, and nothing else about lane selection:**
  ```typescript
  export function liveDerivesOnDaemon(_env: Record<string, string | undefined>): boolean {
    // §6e FLIP (bar PASS, boundary ts logged). The live derive path now
    // always takes the warm-daemon lane, so the SessionStart hook must
    // always ensure a daemon. ONE predicate, TWO readers — refiner-cli.ts
    // and hook-cli.ts — precisely so this commit cannot leave the ensure
    // gate stale. `_env` stays in the signature: the argument is what makes
    // the predicate testable and what a future re-gating would read.
    return true
  }
  ```

  **(ii) `refiner-cli.ts` — replace the `liveEnv` strip (`:54`) with a `liveEnv` derived from that SAME predicate** (still never mutating `process.env`), call `callModelDerive`, and stamp `transport` AND `model` from its result (`:80`, `:85`). Trim the import at `:15` from `{ callModelSdk, resolveModelId, selectTransport }` to `{ callModelDerive, liveDerivesOnDaemon }`:
  ```typescript
  const liveEnv: Record<string, string | undefined> = {
    ...process.env,
    KKAMAK_GAUGE_TRANSPORT: liveDerivesOnDaemon(process.env) ? "agent-sdk-daemon" : undefined,
  }
  const r = await callModelDerive(prompt, floorCheck, liveEnv)
  if (r === undefined) return
  // ...stamp derivation.transport = r.transport and derivation.model = r.model
  ```
  The Task 7 chain — daemon → (only on `no-call`) one-shot agent → undefined — IS the live behaviour, and `call-consumed` still means "no gauge file this turn", which is already an ordinary M0 miss on this path.

  **Why (i) is not optional.** With (ii) alone, `refiner-cli.ts` forces the daemon lane while `hook-cli.ts`'s SessionStart branch still fires only when the user exported `KKAMAK_GAUGE_TRANSPORT=agent-sdk-daemon` — which nobody does after the flip, because the flip is what made it unnecessary. Every live derive would then find no socket, return law-L1 `no-call`, and fall back to the bundled-CLI lane: **~1.25-1.46 s of subprocess spawn on every Stop hook against today's ~5 ms direct API call**, with 100% of records stamped `"agent-sdk"` — a lane §6e's bar never measured, whose own §6d bar passed at exactly 0.800/1 with zero slack. §6e's Live flip gate clause (3) forbids shipping that shape, and §6e's "post-flip stream is split three ways" paragraph names a stream with zero `agent-sdk-daemon` records as an ensure-gate or fingerprint defect rather than a reading.

  **Round-4 I4 interaction, worth stating once here:** the flip is also why `KKAMAK_GAUGE_TRANSPORT` had to leave the fingerprint. `liveEnv` FORCES that key while the SessionStart hook that started the daemon carries whatever the shell had; if it were still hashed, the deriver and its own daemon could never match, and `daemonCall` — which by design never spawns — would fall back on every single record with no visible error. The Task 5 fingerprint tests are what keep that from silently regressing.

**THE THING THAT MAKES THIS STEP DANGEROUS, stated first.** The flip changes what `refiner-cli.ts` DOES, so it changes every test that RUNS `refiner-cli.ts` — not just the ones that assert on `transport`. Post-flip the live path never touches the direct API-SDK lane, so `KKAMAK_GAUGE_SDK_BASE_URL` (the only stub those tests set) intercepts nothing; the daemon leg finds no socket, returns `no-call`, and the fallback spawns the BUNDLED CLI, which reads `ANTHROPIC_BASE_URL` — unset in those tests — and therefore issues a **REAL model call against the real API with this host's real credentials**. The zero-real-model-calls invariant is a whole-plan invariant precisely so this step cannot quietly break it. Five consequences, all mandatory:

  **(a) Change the shared helper, not just the assertions.** `runRefinerCli` (`gauge-refiner-cli.test.ts:31-49`) must inject TWO env vars into every child it spawns:
  ```typescript
  // Post-§6e-flip, refiner-cli.ts FORCES the daemon lane. Two seams are now
  // mandatory on EVERY child, not just the transport-asserting ones:
  //  · KKAMAK_ACP_SOCKET -> a guaranteed-dead temp path, so the record takes
  //    the law-L1 no-call fallback DETERMINISTICALLY. Left unset it resolves
  //    to ~/.config/kkamak/acp-<fingerprint>.sock, which the Task 8 hook
  //    makes likely to be LIVE on a dev host — assertions would flap between
  //    agent-sdk and agent-sdk-daemon depending on whether a daemon is up.
  //  · ANTHROPIC_BASE_URL -> the SSE stub, because the fallback lane spawns
  //    the bundled CLI. Without it these tests hit the real API.
  KKAMAK_ACP_SOCKET: path.join(os.tmpdir(), `kkamak-acp-dead-${process.pid}-${Math.random()}.sock`),
  ANTHROPIC_BASE_URL: agentSrv.url,
  ```
  `runRefinerCli` therefore takes the agent stub as a parameter alongside the existing `srv`.

  **(b) Every stub those tests rely on becomes SSE-shaped, and every read of the now-empty API stub goes with it.** The spawned CLI always sends `stream: true`; a `Response.json(...)` body makes it silently fall back to a SECOND, non-streaming request (`gauge-agent-transport.test.ts:67-91`), which would double every request count. Use `sseText(JSON.stringify(DERIVATION))` from `test/agent-cli-stub.ts`. Concretely, per test:
   - `:56-86` — assert `gauge.transport === "agent-sdk"` (was `"sdk"` at `:78`); the derivation-content assertions (`goalSummary`, `check`, `class`, `v`, `sessionID`, `n`, `derivationMs`, req-removed) are PRESERVED and now read off the SSE stub. Replace `expect(srv.captured.length).toBe(1)` (`:82`) with the same assertion on the AGENT stub's capture count.
     **`:83-84` MOVE, they do not stay (round-4 I5).** They currently read `const body = srv.captured[0]!.body; expect(body.model).toBe("claude-haiku-4-5")`. Post-flip `srv.captured` is EMPTY, so `srv.captured[0]!.body` is a TypeError on `undefined`, not a failed assertion — the test dies before it can tell you anything. Re-point both lines at `agentSrv.captured[0]!.body`; the CLI's `/v1/messages` body carries `model` just as the API-SDK body did, so the assertion survives verbatim on the new source.
     **DELETE the `output_config` assertion at `:85` outright — do NOT "move it onto a `KKAMAK_GAUGE_TRANSPORT=sdk`-pinned sibling".** Such a sibling is impossible by construction: item `:105` below pins that the flipped `refiner-cli.ts` FORCES its own transport and is env-independent, so an env-pinned sibling would take the daemon lane too and never produce an `output_config` request. It is also unnecessary: the direct API-SDK lane's `output_config` shape already has dedicated, unaffected coverage at `test/gauge-transport.test.ts:163`, `:352`, `:369` and `:485`. Cite those lines in the deletion comment so a later reader sees coverage moved, not lost.
   - `:105` — the §6d PIN test. Its new invariant: live selection is `agent-sdk-daemon`, env-independent (an adversarial `KKAMAK_GAUGE_TRANSPORT=sdk` must NOT reroute it), and with a dead daemon socket the record is stamped `"agent-sdk"` (fallback proof, stub-only, no spend). `agentSrv` currently answers a bare 500 labelled "must not be hit by the live derive path" (`:109`) — post-flip it IS hit, so it becomes `sseText(JSON.stringify(DERIVATION))`, the "never touched" assertion at `:135` inverts to "hit exactly once", and `sdkSrv.captured.length` becomes the zero.
     **`:133` moves with it (round-4 I5).** `expect(sdkSrv.captured[0]!.body.model).toBe("claude-haiku-4-5")` indexes the array this same edit empties — a TypeError, not a failure. Re-point it at `agentSrv.captured[0]!.body.model`.
   - `:138` (downgrade-to-D), `:159` (stale v1 req), `:178` (garbage output), `:203` (API error) — **assertions unchanged**, but each now needs its stub behaviour expressed on the AGENT endpoint instead of the API-SDK one: `:138`/`:159` answer `sseText(JSON.stringify(...))`, `:178` answers `sseText("I refuse to emit JSON")`, `:203` answers `new Response("boom", { status: 500 })`. Without this they pass or fail on real model output.
   - `:217` (missing req file) — genuinely unaffected: it never reaches a transport. Verify, do not edit.

  **(c) Both flipped files newly spawn the bundled CLI, so both need the guard and the timeout.** Import `HAS_CLAUDE_CODE_CREDENTIALS` from `test/agent-cli-stub.ts` and wrap the CLI-spawning tests in `describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)`, with `CLI_TEST_TIMEOUT_MS` (90 s — a fallback path pays a CLI spawn) as each test's third argument. A credential-less host must SKIP, not FAIL (`gauge-agent-transport.test.ts:13-22`); bun:test's 5 s default is shorter than observed spawn latency.

  **(d) `gauge-wiring.test.ts:84-109` gets the same treatment as (a)-(c), PLUS a deadline raise (round-4 I5):** one assertion change (`:102`, `"sdk"` → `"agent-sdk"`), an SSE-shaped `ANTHROPIC_BASE_URL` stub and a dead `KKAMAK_ACP_SOCKET` passed through `runHook`'s `env`, plus the skip-guard and timeout — **and `waitFor`'s default deadline (`:75-82`, `ms = 5000`) must rise to at least 20 000.** That helper polls for the detached refiner's output; pre-flip the refiner made a ~5 ms direct API call, post-flip it pays a dead-socket probe plus a full 1.25-1.46 s bundled-CLI spawn plus SSE parsing, inside a detached double-forked child. 5 s is no longer a safe margin, and the failure mode is an intermittently red suite that looks like a daemon bug. Its other ten tests write gauge files directly and never run the refiner — verify, do not edit.

  **(e) `test/acp-ensure.test.ts` (created in Task 8, not a pre-existing file) is updated in THIS commit.** Two of its tests encode the pre-flip gate:
   - `"no-op exit 0 when the live path is not on the daemon lane"` — post-flip there is no such state. Retarget it to the still-true fail-open property (`KKAMAK_ACP_SOCKET` pointing at an unwritable dir ⇒ exit 0, < 3 s, no spawn-log line) or delete it and rely on the existing unwritable-dir test; do not leave it asserting a branch that can no longer be reached.
   - `"the ensure gate is the SAME predicate the live derive path reads"` — flip its second expectation to `expect(liveDerivesOnDaemon({})).toBe(true)`. This assertion is the mechanical proof that (i) and (ii) landed together; if it is not updated in this commit, the commit does not compile as a coherent change.
   The `"ROUND-4 I7: SessionStart NEVER falls through to the Stop path"` test is unaffected and MUST stay green — post-flip the branch takes the ensure path rather than the no-op path, and its `return` is still outside the `if`.

**Finding the assertions (round-4 I6 — the counts below are the tree's, verified 2026-08-04; the previous revision's "FIVE" and "a single hit" were both wrong and would have stalled this step at its own verify gate).**
`grep -rn 'transport).toBe("sdk")' cc-gate-plugin/test/` returns **SEVEN** hits:
  - THREE to change: `gauge-refiner-cli.test.ts:78`, `gauge-refiner-cli.test.ts:130`, `gauge-wiring.test.ts:102`.
  - FOUR that must NOT change, each for its own reason:
    - `corpus-replay.test.ts:86` — a single-record `deriveRecord` assertion on the DEFAULT env via `withSdkStub`; `selectTransport({})` still returns `"sdk"` and `deriveRecord` is not the live path.
    - `gauge-agent-transport.test.ts:379` — `routeCase(undefined)`, likewise default-env.
    - `cls-ab-run.test.ts:344` — `cls-run` is pinned by its own `liveEnv` strip (`cls-ab.ts:746`) and stamps `ClsArmRow.transport: "sdk"` unconditionally; explicitly out of scope (Post-plan item 4).
    - `gauge-evaluate.test.ts:171` — a pure `evaluateGauge` unit test over a hand-built object; it never runs a transport at all.
`grep -rn 'transport === "sdk"' cc-gate-plugin/test/` returns **THREE** hits, all to be CONFIRMED unaffected, none edited: `corpus-replay.test.ts:170` (an `.every(...)`-shaped assertion over `runDerive`'s output on the default env), `paired-validation.test.ts:414` (same shape, pv shadow-derive path, default env), `cls-ab-run.test.ts:416` (cls-run, pinned).
Verify all seven, edit three.

Log the boundary ts in `docs/2026-08-01-gauntlet-adoption-ledger.md` in the flip commit, and note that `KKAMAK_GAUGE_TRANSPORT=sdk` does NOT roll this back (the live path forces its own value through `liveDerivesOnDaemon`): the rollback is reverting the flip commit, and that must be written into the ledger row.

- [ ] **Step 4: Full suite green, and prove the invariant held.**

```bash
cd cc-gate-plugin && bun test && bunx tsc --noEmit
cd .. && bun scripts/doc-check.ts
```
Before committing, re-read the diff of all three test files and confirm that EVERY `Bun.spawn` of `refiner-cli.ts` or `hook-cli.ts` in them passes both `ANTHROPIC_BASE_URL` (SSE stub) and `KKAMAK_ACP_SOCKET` (dead path). A single child without them is a real model call.
Also confirm no `captured[0]!` survives against a stub this commit emptied: `grep -rn 'sdkSrv.captured\[0\]\|srv.captured\[0\]' cc-gate-plugin/test/gauge-refiner-cli.test.ts` must return nothing (round-4 I5).
Run the stray-daemon check once more (`ps -eo pid,args | grep -F 'acp-daemon.ts' | grep -v grep` — expect nothing; SIGTERM by pid if not, never `pkill -f`).

```bash
git add cc-gate-plugin/src/gauge/transport.ts cc-gate-plugin/src/gauge/refiner-cli.ts \
        cc-gate-plugin/test/gauge-refiner-cli.test.ts cc-gate-plugin/test/gauge-wiring.test.ts \
        cc-gate-plugin/test/acp-ensure.test.ts \
        docs/2026-08-01-gauntlet-adoption-ledger.md \
        docs/superpowers/specs/2026-07-29-km-gauge-v2-extractor-preregistration.md
git commit -m "feat(gauge): live derive flips to agent-sdk-daemon — shared ensure predicate flipped in the same commit (6e bar pass, boundary ts logged)"
```

- [ ] **Step 5: Post-flip smoke, once, on this host.** The one thing no test can check is whether CC's real `SessionStart` payload and firing behaviour match what Task 8 assumed. Within the first real session after the flip: confirm a daemon is listening at `socketPath(process.env)`, confirm exactly one spawn-log-equivalent process exists (`ps` by pid, not by pattern), and confirm the next live derive stamps `agent-sdk-daemon` rather than `agent-sdk`:

```bash
ls -l "$(bun -e 'import("./cc-gate-plugin/src/gauge/acp-paths.ts").then(p=>console.log(p.socketPath(process.env)))')"
# after one task-shaped prompt has produced a gauge file:
jq -r '.transport' .km/gauge/<sid>-<n>.json     # expect: agent-sdk-daemon
```
A stamp of `agent-sdk` here means the ensure gate or the fingerprint is wrong, NOT that the daemon is slow — run Task 9 Step 4's fingerprint comparison. §6e records a post-flip stream with zero `agent-sdk-daemon` records as a defect, not a reading.

---

## Post-plan (recorded so the executor does not invent it)

1. **Branch + merge**: one branch `acp-warm-daemon`; per-task reviews; final fresh-context whole-branch review; merge via `scripts/merge-with-gate.sh` with a committed `docs/reviews/<short-sha>-acp-warm-daemon.md` carrying the 5 required fields (reviewed-range/reviewed-commit, reviewer, fresh-context, verdict ∈ approved|fix-first|blocked, findings-count). The 7b gate is ARMED — plain `git merge` bypasses the floor and this merge is a §6 ledger row.
2. **Ordering**: Task 1 must land before any code. **Task 4 Step 1a (the `/clear`-through-streaming-input probe, now also the `modelUsage`-shape probe) must run and PASS on all FOUR conditions before any of Task 4 Step 3 is written** — it is token-free and it is the plan's single largest unproven assumption plus the cheapest possible check on the one rule (round-4 C1) whose failure costs a whole sized go. Task 8 must land before Task 10 (the flip edits the predicate Task 8 introduces). Task 9's shadow-store preservation (Step 1) must land before any `pv-sample --reset`.
3. **Boundary ts obligations**: one when the first `agent-sdk-daemon` derive runs against a REAL store (§6d Deploy clause, batch opt-in), one at the live flip (§6e). They are separate rows.
4. **Not in scope**: `cls-ab.ts` and `channel-run.ts`. `cls-run` is pinned to `"sdk"` by its own `liveEnv` strip (`cls-ab.ts:746`) and stamps `ClsArmRow.transport: "sdk"` unconditionally; `channel-run.ts` calls `sdkCall` directly and is never env-routed. `callModelSdkLabel` (`transport.ts:256`) is deliberately not env-routed either. Neither is touched. `cls-ab.ts`'s `transportTally` miscount (`:375-383`) is re-recorded in §6e — and §6d's own "~375-380" sentence is corrected to that range in Task 1 Step 2 — but the tally itself is not fixed here.
5. **Host-local artifacts that do NOT travel**: `~/.config/kkamak/acp-<fp>.sock`, its `.spawn.lock` / `.bind.lock`, `.km/gauge-corpus-shadow/`, the §6d shadow copy under `/mnt/d/tmp/`, the Task 4 Step 1a scratch probe, the Task 9 spawn log. Only `docs/gauge-pv/*.json` counts travel.
6. **Daemon termination discipline, everywhere**: by PID from the post-listen spawn log, never by `pkill -f`. §6e's "end half of ruling 3" paragraph forbids host-wide teardown, and the socket path lives in the env rather than the cmdline, so a pattern kill could not be scoped to one run even if it were permitted. This binds test `afterEach` hooks, Task 9's script, and any manual cleanup.

## Self-Review Notes (kept in-plan deliberately)

- **Type-consistency check, re-run after revision 4 (round-4 findings applied).**
  - T2 `acp-wire.ts` produces `ACP_BUDGET` (EIGHT constants), `CLI_SPAWN_BUDGET_MS` (NEW, round-4 C3), `modelProvenBy` (NEW, round-4 C1), `ACP_ERR_NO_CALL`, `ACP_ERR_CALL_CONSUMED`, `FrameDecoder` (`maxLineChars`, `StringDecoder`-backed), `encodeFrame`, the method constants, and the `Acp*` shapes → consumed by T4 (`ACP_BUDGET`, `CLI_SPAWN_BUDGET_MS`, `modelProvenBy`), T5 (all), T6 (all), T7 (`ACP_BUDGET` + `modelProvenBy`, imported EAGERLY — it is a constants-plus-one-pure-function module whose sole import is `node:string_decoder`, safe on the hook path).
  - T3 `GAUGE_TRANSPORTS`/`GaugeTransport` → consumed by T7 (`selectTransport`'s return type, `DeriveCallResult.transport`) and T9 (`--pair` validation).
  - T4 `warm-session.ts` produces `TurnOutcome` — `ok` now carries FOUR fields (`text`, `model`, `canonicalModel`, plus `kind`), `CancelResult` — now FOUR values (`queued-dropped`, **`unsent-dropped`** (NEW, round-4 I11), `interrupted`, `unknown`), and `WarmSession` with `oneShot(text, model, {recycle, tag?})` / `cancel(tag)` / `isWarm()` / `turnInFlight()` / `idleMs()` / `close()` → consumed by T5 only. T5's `session/cancel` uses `cancel(tag)` with a DAEMON-MINTED UUID and treats all four `CancelResult` values identically on the wire (the caller learns the outcome from its `session/prompt` reply, and §6e L4/L7 guarantee `queued-dropped`/`unsent-dropped` ⇒ NO_CALL, `interrupted` ⇒ CALL_CONSUMED); T5's reaper uses `idleMs()` + `turnInFlight()`; T5's shutdown uses `close()`; T5 passes all FIVE budget legs explicitly. The constructor CLAMPS `turnTimeoutMs` to `CLI_SPAWN_BUDGET_MS`, so no caller — including the `KKAMAK_ACP_TURN_TIMEOUT_MS` seam — can construct a session that mistakes an unbooted subprocess for a failed generation.
  - T5 `acp-paths.ts` produces `ACP_ENV_DENYLIST` (now 24 keys — `KKAMAK_ACP_SOCKET` and `KKAMAK_GAUGE_TRANSPORT` added, round-4 I4; `KKAMAK_ACP_TURN_TIMEOUT_MS` deliberately NOT added and asserted absent), `ACP_SECRET_KEY_RE` (no `g` flag, asserted stateless), `envFingerprint`, `socketPath`, `spawnLockPath`, `bindLockPath`, `isPipe`, `ensureSocketDir` (MAY THROW — declared), `ACP_LOCK_STALE_MS`, `AcpLockContent`, `tryCreateLock(path, content)` (rethrows non-EEXIST — declared), `isLockStale(path, now)`, `acquireAcpLock(path, now)`, `releaseAcpLock(path)` → consumed by `acp-daemon.ts` (bind lock) and T6 `acp-client.ts` (spawn lock, socket path, fingerprint) and by T5/T6/T7 tests (`envFingerprint`). Every call site passes `now`. **`acp-client.ts` imports NOTHING from `acp-daemon.ts`** — that is the whole reason `acp-paths.ts` exists — but it DOES resolve `acp-daemon.ts`'s absolute path via `path.join(import.meta.dir, "acp-daemon.ts")` for the spawn argv (round-4 I2); a path string is not an import and starts no server.
  - T6 produces `DaemonOutcome` (same three spellings as `TurnOutcome`, and `ok` carries the same `text`/`model`/`canonicalModel` triple so §6e's evidence survives the process boundary), `daemonCall`, `ensureDaemon`, and the test helper `fakeDaemon` in `test/acp-fake-daemon.ts` (TEN `answer` variants: `ok`, `no-call`, `call-consumed`, **`no-call-code-no-data`**, **`consumed-code-no-data`**, **`nonboolean-data`** (all three NEW, round-4 I1), `mismatched-data`, `unknown-code`, `hang`, `die-before-prompt`; plus `model` — defaulting to the requested id with `-20251001` appended so the DEFAULT fixture exercises the dated path — and `canonicalModel`); plus `buildAgentOutgoingText` (from `agent-transport.ts`) → consumed by T7 (`daemonCall` LAZILY, `buildAgentOutgoingText`, `fakeDaemon` in tests), T8 (`ensureDaemon`, lazily) and T9 Step 3 (`ensureDaemon`). **No `DAEMON_LEG_MS` re-export exists** — removed in round 3 so `transport.ts` never needs a top-level `acp-client` import; every caller reads `ACP_BUDGET.daemonLegMs`.
  - T7 produces `DeriveCallResult`/`callModelDerive` → consumed by `corpus-replay.ts` (T7 itself) and by `refiner-cli.ts` in T10. T8 produces `liveDerivesOnDaemon` (NEW, round-4 C2) in `transport.ts` → consumed by `hook-cli.ts`'s SessionStart branch (T8) and by `refiner-cli.ts` (T10 only). Placing it in `transport.ts` rather than `acp-client.ts` is deliberate: `hook-cli.ts:24` already imports `transport.ts` eagerly, so the predicate is free on the hook path while `ensureDaemon` stays behind a lazy import.
  - The three outcome kinds use identical spellings in T4's `TurnOutcome`, T2's two error codes, T6's `DaemonOutcome` and T7's branching. **`model` means one of exactly two things and each site says which**: in `TurnOutcome.ok`, `AcpPromptResult._meta.model`, `DaemonOutcome.ok` and `Turn.observedModel` it is the `modelUsage` KEY — EVIDENCE, forwarded verbatim, never normalized and never adjudicated en route; in `DeriveCallResult.model` and the record stamp it is the RESOLVED REQUESTED id, written only after `modelProvenBy` reconciled the evidence. `canonicalModel` is the companion evidence field and rides the same three hops. Nowhere is the requested model echoed back as if proven. `tag` means "a globally-unique daemon-minted handle" in T4's `Turn`, T4's `cancel`, and T5's `outstanding` map — never a client-supplied id.
  - Budget names are single-sourced: no task defines a local `daemonLegMs`, `turnTimeoutMs`, `setModelMs`, `recordBudgetMs` or spawn-floor literal; every one reads `ACP_BUDGET` or `CLI_SPAWN_BUDGET_MS`. The model-proof rule is likewise single-sourced: `modelProvenBy` is DEFINED once (`acp-wire.ts`) and CALLED from exactly two production sites (`warm-session.ts`'s multi-key branch, `transport.ts`'s daemon branch), with a T7 Step 3 grep that fails if a third hand-rolled comparison appears.
- **Budget arithmetic, re-derived after round 4:** `6 000 + 4 000 + 2 000 + 16 000 + 4 000 = 32 000 = daemonWorstCaseMs` ✓; `daemonLegMs 36 000 > 32 000` ✓ with 4 000 ms of slack for the client's connect + `initialize` + `session/new` preamble (asserted at ≥ 3 000) ✓; `36 000 + 10 000 = 46 000 ≤ 60 000 = recordBudgetMs` ✓; `recordBudgetMs` unchanged from the incumbent `CALL_TIMEOUT_MS` ✓; `turnTimeoutMs 16 000 ≥ CLI_SPAWN_BUDGET_MS 8 000 ≥ the measured 1.25-1.46 s spawn` ✓ (NEW assertion, round-4 C3). Every daemon-side wait is inside the sum: queue, `/clear`, `setModel`, generation, hard grace. **The one item OUTSIDE the sum is `await import("@anthropic-ai/claude-agent-sdk")` (~84 ms measured), and that is now stated rather than glossed (round-4 M4):** the daemon's true worst case is `32 000 + import`, so the literal claim "the client leg exceeds the daemon's worst case" is about the registered legs, not about a pathological module load. The safety property is unaffected — an import slow enough to eat the client's 4 000 ms of slack trips law L2, which is `call-consumed`, a lost retryable record, never a second model call. The CLI spawn is inside `turnTimeoutMs` because the turn's timers start at the push while the subprocess is still coming up, which is exactly why that constant has a floor.
- **§6e's wire-send boundary law is the plan's structural core**, it is stated exactly ONCE (Task 1), it has NO post-send exception on either side of the wire, and after round 4 its post-send branch is a THREE-STEP decision procedure with no contradiction: boolean `data.callConsumed` first, then a RECOGNIZED numeric code (honoured even with `data` absent), then L2. The previous revision's L2 clause "missing or non-boolean `data.callConsumed` ⇒ call-consumed" directly contradicted L3's "the code is the fallback for a daemon that omitted it", on the one branch that decides between one and two model calls, with no fixture on either side (round-4 I1). L2's clause is now scoped to "neither a recognized code nor a boolean field", and three `fakeDaemon` variants plus three client tests pin all three steps. The law is encoded in the wire (two codes + the authoritative `data.callConsumed`), implemented daemon-side by `consumed(t) === t.sent`, mirrored client-side by a single `sentPrompt` boolean assigned ONLY in the prompt frame's write callback, and enforced by `callModelDerive` — with a test at each layer, including the one that asserts the one-shot endpoint receives ZERO requests after a `call-consumed`, and a wire-level test that an unreachable endpoint after the push answers `ACP_ERR_CALL_CONSUMED`.
- **The Task 4 skeleton is the design, not a sketch.** The persistent pump exists because `Query` is an AsyncGenerator whose `.return()` fires on any early loop exit. Its `this.q !== q` generation guard exists because `close()` is synchronous while the generator unwinds an I/O tick later, by which time the next turn may already own a new `Query`. The pushable queue exists because a single re-armed resolver drops the second of two same-tick pushes, and its `close()` now CLEARS the queue because `stream()` drains before it consults the flag (round-4 M12). The TWO separate resolver slots (`notifyCaller` at enqueue, `settle` in `execute`) exist because one shared slot loses the queued caller's resolver and hangs that caller forever. `conversation_reset` sequencing exists because "/clear emits no result" was an indicative scratch observation and the SDK ships a typed signal instead. The `setModel` cap exists because the SDK exposes it as an un-timed control round-trip and an uncapped await is the one way to wedge the FIFO with no timer armed. Settling only from a SENT turn's own terminal `result` exists because settling at cancellation time hands the next turn a stale result — while an UNSENT turn is DROPPED rather than interrupted, because interrupting there aborts the in-flight `/clear`, leaves `done` false, and lets `execute` push the prompt anyway, making the cancel the cause of the very model call it was asked to prevent (round-4 I11). `route()`'s `!t.sent` guard now precedes every branch, not just the `result` branch, for the same reason (round-4 M11). `this.closed` is re-checked after EVERY await because an entry-only check let a `close()` during the SDK import be followed by a fresh subprocess spawn and a real push (round-4 I3). Every one of these is covered by a test a wrong implementation cannot pass.
- **`/clear`-makes-no-model-call is re-locked by request-count assertions rather than trusted, and Step 1a gates the whole mechanism before a line of it is built — now on FOUR conditions, not three.** The fourth is the `modelUsage` shape, because the entire provenance chain turns on those keys and this repo's own captured CLI transcripts key them by the DATED snapshot id while `resolveModelId("haiku")` yields the undated alias (round-4 C1); a strict-equality proof would have returned `undefined` for every honest derivation and turned Task 9's sized go into a full spend for zero records, with the documented `undecided` recovery path prescribing an identical second spend. The `/clear` residue SHAPE is measured and recorded rather than asserted, and Task 4 Step 4 additionally measures the ONE-SHOT lane's bytes so §6e's residue paragraph and §6d's line 662 stop contradicting each other. Every stub in this plan is SSE-shaped; a JSON-bodied stub silently doubles the observed call count. Never-answering stubs use raw `Bun.serve`, not a widened shared helper. `sseText` gained one optional `model` parameter with the incumbent default so a stub can declare a dated id without touching a single existing call site.
- **Architect review 1 (31 findings: 7 critical, 16 important, 8 minor) applied in full.** The load-bearing ones: the fail-open fallback could spend a second model call per record (now split zero-call vs consumed-call at every layer); §6e contradicted a registered user BINDING (now carries the verbatim 2026-08-04 supersession rulings); the SessionStart hook would have failed `packaging.test.ts:64` (now routed through `hook-cli.ts`); the `WarmSession` skeleton killed its own Query after one turn and dropped every second same-tick push; the daemon would have silently substituted its own model and env; the daemon lane would have sent a different prompt than the §6d-validated lane (shared builder now exported); and an interrupted turn returned truncated text as a derivation.
- **Architect review 2 (29 findings: 4 critical, 13 important, 12 minor) applied in full.** The load-bearing ones: (C1) `drain()` and `execute()` both wrote `turn.settle`, so every QUEUED caller's `oneShot()` promise was orphaned and the FIFO test would hang — now two write-once slots funnelled through `finish()`; (C2) the 20 s client leg was SHORTER than the 45 s daemon turn timeout, so an ordinary in-flight turn read as `no-call` and the fallback spent a second call — now one `ACP_BUDGET` object with `daemonLegMs > daemonWorstCaseMs` locked by arithmetic tests; (C3) `api_retry` was treated as model activity unconditionally, which contradicted §6e's own rule and its own test — now handled per sdk.d.ts:2839-2852 (and, after round 3, uniformly as consumed once sent); (C4) turns were settled at cancellation time while their terminal `result` was still in flight, poisoning the next turn — now settled only from their own `result`, with `/clear` sequenced on `SDKConversationResetMessage` (sdk.d.ts:3838-3846); (I5) the "model that ran" was the caller's own request echoed back, making the provenance check a tautology — now proven from `modelUsage` keys (sdk.d.ts:4312); (I6) one lock file guarded two different critical sections in two different processes — now `.spawn.lock` and `.bind.lock`; (I7) a fixed 60 s reaper tick could never satisfy its own 1.5 s idle test; (I8) Task 10's `output_config` remedy contradicted Task 10's own env-independence invariant and duplicated coverage that already exists at `gauge-transport.test.ts:163/352/369/485`; (I9) the sketched hanging stub did not type-check against `stubServer`'s synchronous handler; (I10) Task 7's CLI-spawning tests had neither skip-guard nor timeout and asserted a budget bound the design guarantees to exceed; (I11) a REQUIRED `_meta.model` is incompatible with the "standard editor clients" claim, now dropped in favour of an explicit private-profile scope; (I14) the daemon's `env` — a pinned isolation key — was whatever its spawner happened to have, now fingerprinted and checked on `initialize`; (I15) the "exactly two declared exceptions" constraint omitted three real test-file edits; (I16) `session/cancel` interrupted whoever was in flight, including another caller's turn.
- **Architect review 3 (30 findings: 4 critical, 11 important, 15 minor) applied in full.** The load-bearing ones: (C1) §6e law L5's `error_status === null` carve-out classified a BILLED read timeout as `no-call` — sdk.d.ts:2839-2841 explicitly covers timeouts under that status, and `SDKAssistantMessageError` (sdk.d.ts:2901) cannot distinguish a refused connect from one; the exception is deleted, `consumed(t)` is now exactly `t.sent`, and daemon-side L5 and client-side L2 classify the same physics identically; (C2) the daemon used the client's JSON-RPC request id as the `WarmSession` cancel tag, and every client's counter starts at 1, so one caller's correctly-scoped `session/cancel` could interrupt ANOTHER caller's already-billed in-flight turn — tags are now daemon-minted UUIDs, with a wrong-owner test at both the `WarmSession` and the wire level; (C3) `runPump`'s `finally` was unguarded, so after any `hardReset()` the dying pump settled and destroyed the turn and the `Query` that had replaced it — a `this.q !== q` generation guard now binds every pump to its own `Query`, with a hardReset-with-queued-turn regression test; (C4) Task 10's declared exception #5 named three assertions but the flip breaks SIX tests plus a shared helper, and its stated remedy would have issued REAL model calls (the API-SDK stub those tests set is not on the post-flip path) — Step 3 now rewrites the helper, converts every stub to SSE shape on `ANTHROPIC_BASE_URL`, adds credentials skip-guards and timeouts, and zero-real-model-calls is a whole-plan invariant that explicitly covers the flip; (I5) `setModel` was an uncapped await outside the budget and could wedge the FIFO forever — now `setModelMs`, inside `daemonWorstCaseMs`; (I6) `FrameDecoder` used `chunk.toString()`, corrupting any multi-byte character split across a socket chunk into U+FFFD in a frame that still parses — now `StringDecoder`-backed with a split-multibyte test; (I7) `transport.ts` would have put the whole ACP client on every hook event via `hook-cli.ts:24`'s eager import, voiding Task 8's own lazy-import claim — `daemonCall` is now lazy-imported and `DAEMON_LEG_MS` is not re-exported; (I8) `ensureDaemon` released a spawn lock it might never have acquired, unlinking the winner's; (I9) Task 9's registered `KKAMAK_ACP_IDLE_MS` was inert because it is denylisted from the fingerprint and a pre-existing daemon would be adopted — the run now binds its own socket; (I10) the plan had no procedure for `undecided > 0` and implied a 10-record re-spend where a `--go <pending>` top-up finishes the job; (I11) the five-key fingerprint left `ANTHROPIC_MODEL`, the proxy vars and every `CLAUDE_CODE_*` toggle free to change the instrument silently — now whole-env-minus-denylist with the residual stated; (I12) §6e's residue claim contradicted §6d's line 662 about the same 423 bytes — now an OPEN DISCREPANCY resolved by measurement in Task 4 Step 4, corrected in that commit; (I13) Tasks 6 and 7 both needed scripted fake daemons with no shared helper and no way to import one from a `.test.ts` — `test/acp-fake-daemon.ts` added; (I14) the `/clear`-through-streaming-input assumption was unverified with no stop gate — Task 4 Step 1a; (I15) `lastServedSessionId` committed at serve time leaks one session's context into another under interleaving — now committed at dispatch.
- **Architect review 4 (26 findings: 3 critical, 11 important, 12 minor) applied in full — and this is the last revision round.** The load-bearing ones: (C1) `modelUsage` keys are DATED snapshot ids, proven by this repo's own captured CLI transcripts (`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22` = `"claude-haiku-4-5-20251001"`) and by sdk.d.ts:1274-1277's own warning that the key may be a provider id or alias — the plan's strict-equality model check would have returned `undefined` for EVERY honest daemon derivation, spending Task 9's whole sized go for zero records while the documented `undecided` recovery prescribed an identical second spend; a shared `modelProvenBy` predicate, a dated-key fixture at three layers, and a fourth Step 1a PASS condition replace it. (C2) Task 10 flipped the live lane but left Task 8's ensure gate on an opt-in env var, so post-flip every live derive would find no daemon, fall back, and pay a 1.25-1.46 s CLI spawn per Stop hook — strictly worse than the pre-flip instrument and stamped as a lane the bar never measured; ONE `liveDerivesOnDaemon` predicate now feeds both readers and the flip changes its body. (C3) the finding-C3 regression test set `turnTimeoutMs: 1_000` while the plan's own §6d figure puts the CLI spawn at 1.25-1.46 s, so a CORRECT implementation failed it deterministically; `CLI_SPAWN_BUDGET_MS` is now a floor enforced in the constructor and every affected test's wall clock is re-derived. (I1) L2 and L3 contradicted each other on a recognized code with `data` absent — the exact branch that decides one call versus two — with no fixture on either side; L3 is now a three-step procedure and `fakeDaemon` gained three variants. (I2) `ensureDaemon`'s spawn had neither an argv nor an `env`, and the repo idiom it cited passes none, so the daemon would inherit `process.env`, bind a different fingerprinted socket and echo a different fingerprint than the client that started it — permanent mutual refusal, and three Task 6 tests plus the e2e unpassable. (I3) `close()` was observed only at `ensure()`'s entry, so a close during the ~84 ms package import was followed by a subprocess spawn and a real push. (I4) `KKAMAK_GAUGE_TRANSPORT` and `KKAMAK_ACP_SOCKET` were inside the instrument fingerprint though neither can change a byte sent to the model, guaranteeing a post-flip client/daemon mismatch. (I5/I6) Task 10's per-test list left two `captured[0]!` reads pointed at stubs the same edit empties (TypeErrors, not failures), left `waitFor`'s 5 s deadline covering a newly-added CLI spawn, and stated grep counts of 5 and 1 where the tree returns 7 and 3. (I7) the SessionStart branch's `return` was ambiguously scoped and `Stop` is hook-cli's unguarded fall-through, so a nested return would have run the repo's entire test suite as a gate check on every session start. (I9) `pkill -f acp-daemon.ts` contradicted §6e's own host-global reasoning. (I11) a cancel arriving between `this.current = turn` and the push interrupted an unsent turn, left `done` false, and let `execute` push anyway — the cancel causing the spend it was asked to prevent.

## Disposition of review-2 findings (traceability)

| # | Sev | Applied where |
|---|-----|---------------|
| C1 | Critical | T4 Turn `notifyCaller`+`settle`, `finish()` funnel, `drain()` resolves nobody; FIFO + queue-cap + close tests |
| C2 | Critical | `ACP_BUDGET` in T2 + arithmetic tests; T5 explicit daemon budgets; T7 remaining-budget math; §6e budget rule |
| C3 | Critical | §6e law L5/L6; T4 `api_retry` handling off `error_status` (superseded in round 3 by uniform post-send consumption) |
| C4 | Critical | §6e law L7; T4 `doomed`, `sent` guard, `awaitClear()` on `conversation_reset`, hardTimer destroys the Query |
| I5 | Important | §6e "Which field proves the model"; T4 `observedModel` from `modelUsage`; T7 divergence branch + fake-daemon test |
| I6 | Important | `acp-paths.ts` `spawnLockPath`/`bindLockPath`; T5 bind sequence; T6 `ensureDaemon` 5-step sequence |
| I7 | Important | T5 reaper tick `max(250, min(60_000, idleMs/3))` |
| I8 | Important | T10 Step 3 item `:56-86`: delete the assertion, cite `gauge-transport.test.ts:163/352/369/485` |
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
| M20 | Minor | Cites now `corpus-store.ts:145-177` (with `:134-143` for the bare `wx` helper) |
| M21 | Minor | T10: `:86` described as a single-record assertion, `:170` as `.every(...)`-shaped |
| M22 | Minor | "TWO declared deltas" in Global Constraints, §6e and the T4 header |
| M23 | Minor | `results` Map gone; single stub in T4 test 1; `withCaptureStub` not imported unused; `stream_event` branch removed with a reason |
| M24 | Minor | `acp-paths.ts` split out; `import.meta.main` guard stated; T5 Step 4 import-purity check |
| M25 | Minor | T7 `DERIVATION_SCHEMA as unknown as Record<string, unknown>`; `corpus-replay.ts:26` import trim + header comment |
| M26 | Minor | T8 armed test polls the post-listen spawn log and asserts exactly one line |
| M27 | Minor | T6 `ensureDaemon` `waitMs` default 0, stated in the signature comment and pinned by a test |
| M28 | Minor | §6e "The 'end' half of ruling 3, deliberately NOT implemented" |
| M29 | Minor | T4 `close()` settles current + every queued turn; dedicated test |

## Disposition of review-3 findings (traceability)

| # | Sev | Finding | Applied where |
|---|-----|---------|---------------|
| C1 | Critical | §6e L5's connection-only exception classified a billed read timeout as `no-call` ⇒ double model call | §6e L4/L5/L6 rewritten (no post-send exception, with the sdk.d.ts:2839-2841 / :2901 reasoning); T4 `consumed(t) === t.sent`, `connectionOnly` removed from `Turn` and `route()`, witnesses demoted to diagnostics; T4 test retargeted to `call-consumed`; T5 wire-level "unreachable endpoint ⇒ ACP_ERR_CALL_CONSUMED" test; T2 `ACP_ERR_NO_CALL` doc = L1/L4 only (M22 folded in) |
| C2 | Critical | Daemon used the client's JSON-RPC id as the cancel tag ⇒ cross-caller interrupt of a billed turn | T5 `crypto.randomUUID()` tag minted per accepted `session/prompt`, stored in `outstanding`; T4 `Turn.tag` doc'd as globally-unique; T4 wrong-owner queued-turn test; T5 "same JSON-RPC id on both connections" wire test |
| C3 | Critical | `runPump`'s `finally` unguarded ⇒ dying pump settles and destroys the replacement turn/Query | T4 `runPump(q)` guards `this.q !== q` in BOTH the loop body and the `finally`; §6e L7 extended to name the generation binding; T4 hardReset-with-queued-turn regression test |
| C4 | Critical | Task 10 exception #5 incomplete; its remedy would issue real model calls | Global Constraints exception #5 re-enumerated (helper + 6 tests + gauge-wiring); zero-real-model-calls promoted to a whole-plan invariant naming the flip; T10 Step 3 rewritten as (a) helper injection, (b) per-test SSE stub conversion, (c) skip-guards + timeouts, (d) gauge-wiring; Step 4 diff re-read gate |
| I5 | Important | `setModel` uncapped and outside the budget; client slack unquantified | `ACP_BUDGET.setModelMs = 2_000`, `daemonWorstCaseMs 32_000`, `daemonLegMs 36_000`; T4 `within()` helper + `setModelMs` ctor opt; T5 passes it explicitly; T2 five-leg sum test + a ≥3 000 ms preamble-slack test; §6e budget rule updated |
| I6 | Important | `chunk.toString()` corrupts split multi-byte UTF-8 ⇒ silently wrong prompt | T2 `FrameDecoder` holds a `StringDecoder("utf8")`; split-multibyte test; T5/T6 `socket.setEncoding("utf8")` on every socket |
| I7 | Important | Eager `acp-client` import in `transport.ts` lands on every hook event | Global Constraint "the hook's import path stays cheap"; T6 drops the `DAEMON_LEG_MS` re-export; T7 lazy `await import("./acp-client.ts")` + a grep check; T8's lazy-import claim reworded to depend on it |
| I8 | Important | `ensureDaemon` released a spawn lock it may not hold | T6 `held`-tracked 5-step sequence; "a caller that LOSES the spawn lock never unlinks it" test |
| I9 | Important | Registered `KKAMAK_ACP_IDLE_MS` inert if a daemon already listens | §6e "Validation-run instrument parameters" now mandates a run-specific socket and says why; T9 Step 3 exports `KKAMAK_ACP_SOCKET` and terminates its own daemon; `KKAMAK_ACP_IDLE_MS` documented on the denylist |
| I10 | Important | No procedure for `undecided > 0`; implied a full re-spend | T9 Step 4 split into the `wrongTransport` branch (full reset, new go) and the `undecided` branch (`derive --go <pending>` top-up, sized go for that number) |
| I11 | Important | Five-key fingerprint misses instrument-changing env vars | §6e "Instrument fingerprint" = whole env minus `ACP_ENV_DENYLIST`, secret-NAMED keys reduced to presence, allow-list explicitly rejected, residual stated; `acp-paths.ts` `ACP_ENV_DENYLIST` + `ACP_SECRET_KEY_RE`; T5 tests for `ANTHROPIC_MODEL`/proxy/`CLAUDE_CODE_*`, denylist, sort-order, secret-name rule |
| I12 | Important | §6e residue claim contradicts §6d spec line 662 on the same 423 B | §6e "Declared residue, and an open disagreement inside this spec"; T4 Step 4 measures BOTH lanes and corrects whichever statement is wrong in that commit; the spec file is in T4's `git add` |
| I13 | Important | No shared fake-ACP-daemon helper though T6 and T7 both need one | `cc-gate-plugin/test/acp-fake-daemon.ts` added to T6's Files with the full `fakeDaemon(sock, opts)` signature (`sawPrompt()`, `promptParams()`); T6 and T7 both import it (M29 folded in) |
| I14 | Important | `/clear` through streaming input is unverified with no stop gate | Plan-header RISK NOTE; §6e "Why, and what is still UNMEASURED"; **T4 Step 1a** token-free probe with explicit PASS conditions and an unmissable STOP-AND-REPORT; Post-plan ordering rule 2 |
| I15 | Important | `lastServedSessionId` committed at serve time leaks context under interleaving | T5 `session/prompt` computes and COMMITS `recycle`/`lastServedSessionId` in one synchronous step, with the failure mode spelled out; T5 interleaved-sessions test |
| M16 | Minor | Single-key `modelUsage` requirement is brittle | T4 `route()` accepts the requested model when it is a key AND every other key has zero output tokens; §6e "Which field proves the model" states the rule (round 4 replaces the equality test with `modelProvenBy`) |
| M17 | Minor | Corroboration silently promoted to proof when `modelUsage` absent | T4 `Turn.corroboratedModel` is diagnostic-only; `observedModel` is cleared and set ONLY from `modelUsage`; §6e says corroboration is never a stamp |
| M18 | Minor | Exception #2 had no corresponding test; the shown test duplicated #1 | Global Constraints #1 says "REPLACED in place, not duplicated"; #2 now names the union-membership + sorts-last test, written out in T3 Step 1 |
| M19 | Minor | Dead `fs`/`os`/`path`/`execFileSync` imports left in `gauge-agent-transport.test.ts` | Exception #4 extended to `:2-5`; T4 Step 0 requires the deletion |
| M20 | Minor | F1/F2 enumeration omitted `src/types.ts` | Global Constraints F1/F2 now lists it (still outside every MECHANISM_PATH) |
| M21 | Minor | `maxLineBytes` counts UTF-16 code units | Renamed `maxLineChars` in the interface, the implementation and the test |
| M22 | Minor | `ACP_ERR_NO_CALL` documented as L4 only | Folded into C1: now documented as L1/L4, and `ACP_ERR_CALL_CONSUMED` as L2/L5/L6 |
| M23 | Minor | `session/cancel` answered as a request though ACP makes it a notification | T2 scope note lists it as deviation 3; T5 answers only when an `id` is present; T5 notification-shape test |
| M24 | Minor | T10's two-grep rationale was inverted | T10 "Finding the assertions" states the hit counts for both greps and which hits must NOT change (round 4 corrects the counts themselves) |
| M25 | Minor | Lock helper signatures drifted from `corpus-store.ts` and between T5/T6 | `acp-paths.ts` declares `tryCreateLock(path, content)` / `isLockStale(path, now)` / `acquireAcpLock(path, now)`; T5 and T6 both pass `Date.now()` |
| M26 | Minor | SessionStart hook could linger to CC's 30 s timeout | T6 `ensureDaemon` destroys sockets and clears timers before resolving; T8 states hook-cli has no forced success-path exit and adds `< 3_000 ms` bounds to all its tests |
| M27 | Minor | T9 Step 5 lacked the copy command | T9 Step 5 gives the literal `cp` from `<shadowRoot>/pv-counts.json`, with `doc-check` and the commit |
| M28 | Minor | Expected `doc-check` output omitted the `(NNNms)` suffix | T1's doc-check step shows the real format and says not to treat it as a mismatch |
| M29 | Minor | T7's fakes must echo the env-under-test's fingerprint | Folded into I13: T7's `fpOf()` helper with the failure mode spelled out, plus the fingerprint-mismatch note in T6's test header |
| M30 | Minor | Minor cite drift | Corrected throughout: `agent-transport.ts:102-108`, `hook-cli.ts:147-154`, `sdk.d.ts:1674-1678`, `:1627-1631`, `:2870-2873`, `:4583-4586`, `paired-validation.ts:472-481`, `cls-ab.ts:375-383` |

## Disposition of review-4 findings (traceability) — FINAL ROUND

| # | Sev | Finding | Applied where |
|---|-----|---------|---------------|
| C1 | Critical | `modelUsage` is keyed by the DATED snapshot id (`opencode-plugin/test/fixtures/drivers/claude-code/success.ndjson:22` = `claude-haiku-4-5-20251001`; sdk.d.ts:1274-1277 warns the key may be a provider id or alias) while `resolveModelId("haiku")` yields the undated alias — strict equality discards EVERY honest daemon derivation, spending Task 9's whole sized go for zero records, and Task 9 Step 4's `undecided` recovery prescribes an identical second spend | T2 `modelProvenBy(key, requested, canonicalModel)` — `k === m` ∨ `k.startsWith(m + "-")` ∨ `canonicalModel === m` — defined ONCE with five fixture tests including the `claude-haiku-4-52` boundary; §6e "Which field proves the model" carries THE MATCHING RULE with the fixture cite; T4 `Turn.observedCanonical`, `TurnOutcome.ok.canonicalModel`, `route()` single-key branch reports the key verbatim and multi-key branch selects via `modelProvenBy`; T4 dated-key test + wrong-model test; T5 `AcpPromptResult._meta.{model,canonicalModel}` forwarded VERBATIM with an explicit "the daemon does not adjudicate" rule + wire test asserting the dated key is not normalized; T6 `DaemonOutcome.ok.canonicalModel`, fakeDaemon's `model` default is the dated form, `canonicalModel` option; T7 `if (!modelProvenBy(d.model, model, d.canonicalModel)) return undefined` + three routing tests (dated proves, canonical proves, different model rejects with no fallback); T4 Step 1a PASS condition **4**; T4 Step 4 measurement (c); T7 Step 3 single-source grep; T9 Step 4's "if `undecided` equals the whole sample, suspect the proof rule before re-spending" |
| C2 | Critical | Task 10 flips the live lane but Task 8's ensure gate stays on an opt-in env var ⇒ post-flip every live derive finds no daemon, falls back, pays a 1.25-1.46 s CLI spawn per Stop hook (worse than the ~5 ms pre-flip instrument) and stamps `agent-sdk`, a lane the §6e bar never measured | Global Constraint "The live derive lane and the SessionStart ensure gate are ONE predicate"; §6e Live flip gate clause **(3)** + "a post-flip stream with zero `agent-sdk-daemon` records is a defect, not a reading"; T8 exports `liveDerivesOnDaemon(env)` from `transport.ts` with the failure mode in its doc comment, the hook reads it, and a T8 test asserts both the predicate's values and that `hook-cli.ts` contains the identifier; T10 Step 3 is TWO edits `(i)`+`(ii)` that must land together, with "Why (i) is not optional"; T10 Step 3(e) updates `acp-ensure.test.ts` in the same commit; T10 Step 5 post-flip smoke asserts a live derive stamps `agent-sdk-daemon` |
| C3 | Critical | The finding-C3 regression test used `turnTimeoutMs: 1_000` while §6d measures the CLI spawn at 1.25-1.46 s and the plan itself says the spawn is inside that window ⇒ a CORRECT implementation fails deterministically (turn A is torn down before its request reaches the stub; turn B then hangs as the stub's first request) | T2 `CLI_SPAWN_BUDGET_MS = 8_000` + an arithmetic test asserting `ACP_BUDGET.turnTimeoutMs >= it`; Global Constraint "A turn's timeout MUST exceed the CLI spawn — one constraint, stated once"; §6e instrument-invariants paragraph ("no configuration, including a test seam, may set it below 8 s"); T4 constructor CLAMPS via `Math.max`; every T4 test override uses `T = CLI_SPAWN_BUDGET_MS` with its wall clock re-derived in a comment; T4 `CLI_TEST_TIMEOUT_MS` raised 60 s → 90 s; `until()` helper added so "the turn has been SENT" is observed rather than assumed; T5's unreachable-endpoint test uses 8 000; T4 Step 4(a) records the observed spawn against the floor |
| I1 | Important | §6e L2 ("missing `data.callConsumed` ⇒ call-consumed") contradicted L3 ("the code is the fallback for a daemon that omitted it") on a recognized `ACP_ERR_NO_CALL` with `data` absent — the one branch deciding one call versus two — with no fixture either way | §6e L3 rewritten as an explicit ordered three-step procedure ((i) boolean data wins, (ii) recognized code honoured even with data absent, (iii) else L2), L2's clause narrowed to "neither a recognized code nor a boolean field"; T2's `JsonRpcError.data` doc restated to match; T6 `fakeDaemon` gains `no-call-code-no-data`, `consumed-code-no-data`, `nonboolean-data`; T6 tests "law L3(ii) … honoured, both ways" and "law L2: a NON-BOOLEAN `data.callConsumed` is an ambiguity"; T6 Step 3 implements the three steps in order |
| I2 | Important | `ensureDaemon`'s spawn had neither an argv nor an `env`, and the cited repo idiom (`hook-cli.ts:147-154`) passes neither ⇒ the daemon inherits `process.env`, binds `socketPath(process.env)` and echoes `envFingerprint(process.env)`, so a caller passing any other `env` object is refused forever; three T6 tests and the e2e become unpassable | T5 "The daemon fingerprints and binds from `process.env`, and that is a CONTRACT with the spawner"; T5 wire test "the daemon binds and echoes from the env it was GIVEN"; T5's `spawnDaemon` test helper passes `env` explicitly; T6 spawn idiom now shows `DAEMON_ENTRY = path.join(import.meta.dir, "acp-daemon.ts")` (the `spawn.ts:12` idiom) and `Bun.spawn(..., { env: childEnv, ... })` with the failure mode in the comment; T6 `ensureDaemon` step 3 says "spawn per the idiom above, **passing `env`**"; T6 test "the spawned daemon binds the socket the CALLER named"; T8's armed test asserts `fs.existsSync(TMP_SOCK)` |
| I3 | Important | `ensure()` checked `this.closed` only at entry ⇒ a `close()` during the ~84 ms SDK import was followed by a `Query` construction, a CLI subprocess spawn and a real prompt push: a leaked subprocess and a spent model call on a terminated session, with `isWarm()` true after `close()` | §6e L7's closing paragraph ("a session `close()` must be observed after EVERY suspension point"); T4 design bullet "`this.closed` is re-checked after EVERY await"; T4 `ensure()` has the check at entry, after the import, and after `query()` (closing what it built); `execute()` re-checks after `ensure`, after `setModel` and after `awaitClear`; `drain()` checks before `execute`; T4 test "close() during the SDK import does not spawn a subprocess or send anything"; `close()`'s doc records why it does not itself settle a mid-await turn |
| I4 | Important | `KKAMAK_GAUGE_TRANSPORT` (lane selection) and `KKAMAK_ACP_SOCKET` (endpoint address) were inside the instrument fingerprint though neither changes a byte sent to the model; post-flip the live path FORCES the former into a derived env, guaranteeing a client/daemon mismatch and — since `daemonCall` never spawns — a silent 100% fallback | §6e denylist gains both keys, with the TWO-CLASS rationale (volatile vs not-an-instrument-parameter) and an explicit RULING that `KKAMAK_ACP_TURN_TIMEOUT_MS` stays IN because it changes which turns produce a derivation; §6e residual paragraph rewritten to state the CORRECT failure mode for a non-spawning caller; Global Constraints env bullet updated; T5 `ACP_ENV_DENYLIST` + doc comment; T5 tests "lane SELECTION and the ENDPOINT ADDRESS are denylisted" and "the TURN BUDGET is an instrument parameter and is NOT denylisted"; T6 test "lane selection and socket path do NOT change the client's fingerprint"; T7's `fpOf` comment notes why the per-test socket does not perturb it; T9 Step 3 and Step 4's fingerprint-diagnosis branch; T10 Step 3's "Round-4 I4 interaction" |
| I5 | Important | T10's per-test list left `gauge-refiner-cli.test.ts:83-84` and `:133` reading `captured[0]!` on stubs the same edit empties (a TypeError, not a failed assertion) and left `gauge-wiring.test.ts`'s `waitFor(…, ms = 5000)` covering a newly-added CLI spawn | Global Constraints exception #5 re-enumerated to name `:83-84`, `:133` and `waitFor` `:75-82`; T10 Step 3(b) re-points both reads at `agentSrv.captured[0]!.body`; T10 Step 3(d) raises the deadline to ≥ 20 000 with the reason; T10 Step 4 adds a grep gate (`sdkSrv.captured[0]\|srv.captured[0]` must return nothing) |
| I6 | Important | T10's "Finding the assertions" claimed 5 hits and 1 hit; the tree returns 7 and 3 — and that paragraph's whole purpose is a verify-don't-edit gate the implementer would fail | T10 "Finding the assertions" restated with the real counts, the three to change, and the FOUR + THREE that must not, each with its reason (`corpus-replay.test.ts:86`/`:170`, `gauge-agent-transport.test.ts:379`, `cls-ab-run.test.ts:344`/`:416`, `gauge-evaluate.test.ts:171`, `paired-validation.test.ts:414`) |
| I7 | Important | The SessionStart branch's `return` was ambiguously scoped; `hook-cli.ts` has no `if (event === "Stop")` — Stop is the fall-through at `:221` — so a nested return runs `handleStop` on every default-configuration SessionStart, executing this repo's `gate.json` check (the entire test suite) per session start | T8 "THE BRANCH RETURNS UNCONDITIONALLY" with the exact code shape and the blast radius spelled out; T8 test "ROUND-4 I7: SessionStart NEVER falls through to the Stop path" builds a repo WITH a `gate.json` whose check touches a marker file and asserts the marker, the sensor file and stdout are all absent; T10 Step 3(e) confirms that test stays green post-flip |
| I8 | Important | §6e's model-provenance rule was stated as binding for every turn while two of `callModelDerive`'s three paths stamp the requested model — the amendment would declare a rule two live lanes violate on their first record | §6e's provenance section retitled "SCOPED TO THIS LANE" with a REGISTERED ASYMMETRY paragraph naming `sdkCall`'s uninspected response and `agentSdkCall`'s bare-string return (`agent-transport.ts:146-149`) as the reason; T7 behaviour item 2 restates the scoping; `DeriveCallResult.model`'s doc says which lane proves and which stamps |
| I9 | Important | Task 9 Step 3's `pkill -f "acp-daemon.ts"` is host-wide, contradicting §6e's own rejection of per-session teardown, and cannot be scoped by socket path (it lives in the env, not the cmdline) | §6e "end half of ruling 3" paragraph gains the OPERATIONS binding ("no procedure … may terminate daemons by pattern-matching the process table"); T5's spawn-log bullet names the pid as the only sanctioned handle; T5/T8 test helpers `killDaemon`/`reap` are pid-scoped; T9 Step 3 exports `KKAMAK_ACP_TEST_SPAWN_LOG` and reaps by pid in a `trap … EXIT`; T5 Step 4 and T10 Step 4 stray-daemon checks say "SIGTERM by pid, never `pkill -f`"; Post-plan item 6 |
| I10 | Important | Several T4 tests left under a second of margin over the measured spawn; Step 1a — the token-free gate — did not probe `modelUsage`, the field C1 turns on | Folded into C3 (timer re-derivation, `until()` gating of the close/cancel tests) and C1 (Step 1a PASS condition 4 records `modelUsage` keys, `canonicalModel` and `outputTokens`; Step 1a's failure taxonomy names the empty/unreconcilable case and what it costs if found at Task 9 instead) |
| I11 | Important | A `session/cancel` arriving between `this.current = turn` and the push interrupted an UNSENT turn, left `done` false, and let `execute` push anyway — the cancel causing the model call it was asked to prevent, and possibly aborting the in-flight `/clear` | §6e L4 gains "cancelled after leaving the queue but BEFORE its prompt was pushed" and L7 gains "a cancel that arrives while the turn is UNSENT settles immediately as `no-call` … cancelling a turn must never be the thing that causes it to spend a model call"; T4 `CancelResult` gains `unsent-dropped`; `cancel()` branches on `c.sent`; `execute()`'s post-`awaitClear` `turn.done` check makes the push unreachable; T4 test "cancelling a turn BEFORE it pushes drops it" asserts ZERO extra captured requests; the wrong-owner test now gates on `until(() => cap.count() >= 1)` so it exercises the SENT branch it claims to; T5 records that all four `CancelResult` values map identically on the wire |
| M1 | Minor | T3 Step 4's grep expected THREE `GAUGE_TRANSPORTS` hits; the appended membership test adds TWO lines, not one ⇒ FOUR | T3 Step 4 states FOUR with the line-by-line breakdown and notes an expectation of three would fail a correct edit |
| M2 | Minor | T9 Step 3 hardcoded `--go 10` while Step 2 says to report the printed size; `runDerive` refuses unless `--go` equals the pending count exactly | T9 Step 2 says "size it to the number `pv-sample` actually printed, not to 10" with the `corpus-replay.ts:151-157` cite and the `drawNotC` short-pool cite; T9 Step 3 takes `GO` as a required positional argument |
| M3 | Minor | `test ! -e "$SOCK" && echo …` is exempt from `set -e` (a non-final command in an `&&` list), so a surviving socket produced silence and a green script | T9 Step 3's teardown is an `if`/`exit 1` inside a `trap … EXIT` under `set -euo pipefail`, with the errexit-exemption reason stated |
| M4 | Minor | `daemonWorstCaseMs` excludes the uncapped SDK import, so "the client leg exceeds the daemon's worst case" is not literally true | `ACP_BUDGET.daemonWorstCaseMs`'s doc comment, the Global Constraints "Honesty note", §6e's budget rule and the Self-Review budget pass all state the exclusion and why the safety property (no double spend) survives it |
| M5 | Minor | The Step 1a probe used `require("node:os")` in an ESM script and a `<repo>` placeholder in its imports | T4 Step 1a uses `import os from "node:os"` and says to substitute the ABSOLUTE repo path before running |
| M6 | Minor | `acp-daemon.test.ts`'s blanket `describe.skipIf(!HAS_CLAUDE_CODE_CREDENTIALS)` over-skipped tests that never reach a model (the daemon starts no `Query` until a prompt arrives) | T5 Step 1 splits the file into "acp-daemon wire behaviour (no model reached)" — NO guard — and "acp-daemon over unix socket (reaches the stubbed model)" — guarded; Global Constraints TDD bullet states the rule ("a test that only exercises the WIRE must NOT carry the credentials guard") |
| M7 | Minor | `daemonCall`'s `sentPrompt` placement was unspecified; both plausible placements were safe, but "safe by luck" is not a contract | T6 "`sentPrompt` is set in the WRITE CALLBACK, and that is the whole client-side send boundary" with the one-assignment-site code and the partial-frame reasoning; §6e L1 defines "fully written" as "the socket's write callback reported success"; T6 Step 3 restates it |
| M8 | Minor | T8's armed test spawned a real daemon on the 900 000 ms production idle default; a missed `afterEach` leaves it for 15 minutes | T5's `spawnDaemon` helper always sets `KKAMAK_ACP_IDLE_MS` (default `8000`); T8's `envWithout` injects `KKAMAK_ACP_IDLE_MS: "8000"` into every child; T6's e2e test sets it too |
| M9 | Minor | Cite drift: `corpus-store.ts`'s `acquireLock` runs `:164-177`, not `:164-176`; `agent-transport.ts:135-145` points at the comment plus half the guard | T5's lock-helper doc cites `corpus-store.ts:145-177` / `:164-177` / `:134-143` and notes the rethrow behaviour; the `agent-transport.ts:135-145` cite is retained where it refers to the finding-plus-guard block and the guard itself is described as `:142-145` where precision matters |
| M10 | Minor | §6e's `cls-ab` range (`375-383`) disagreed with §6d's existing "~375-380" in the same spec file | §6e states the precise range and says §6d's sentence is corrected in the same commit; **T1 Step 2** is a new step that makes that edit; Post-plan item 4 records it |
| M11 | Minor | `route()`'s `api_retry` branch fired on a turn with `sent === false`, poisoning an unsent turn and interrupting an in-flight `/clear` | §6e L6 gains "an `api_retry` arriving while the CURRENT turn has NOT yet pushed … is counted as a stray and MUST NOT poison an unsent turn or interrupt an in-flight `/clear`"; T4's `route()` hoists `if (!t.sent) { this.strayMessages++; return }` above every branch; the T4 design bullet on stray messages says so |
| M12 | Minor | `Pushable.close()` set the flag but `stream()` drains the queue before consulting it, so messages queued at teardown were still fed to a dying `Query` | T4 `Pushable.close()` sets `this.queue.length = 0` with the drain-order reason in the comment; the T4 design bullet on the lossless feed records it |
