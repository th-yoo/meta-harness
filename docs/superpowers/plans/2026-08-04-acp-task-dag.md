# ACP work — task DAG, file-conflict map, and execution schedule

**What this is.** The two ACP plans describe *what* to build; this describes
*in what order and what can run at once*. It spans BOTH documents, because the
executable graph does:

- `2026-08-04-acp-warm-daemon.md` — Tasks **T1-T10**
- `2026-08-04-acp-session-pool.md` — Tasks **S0-S4, P0-P2**

**The one rule that overrides the DAG.** `T4·1a` is a STOP gate. If the
`/clear`-through-streaming-input probe fails, everything downstream of it is
cancelled, not retried. It is token-free and it is the cheapest node in the
graph — schedule it as early as its dependencies allow.

---

## 1. Node table

`spend` = needs real model tokens. `parallel-safe` = holds no file another
ready node holds (see §3).

| id | task | writes | depends on | spend |
|---|---|---|---|---|
| **T1** | §6e spec registration | spec md | — | no |
| **T2** | `acp-wire.ts` (framing, `ACP_BUDGET`, error codes, `modelProvenBy`) | `src/gauge/acp-wire.ts` + its test | T1 | no |
| **T3** | widen `GAUGE_TRANSPORTS` | `src/types.ts`, `test/gauge-agent-transport.test.ts`, `test/paired-validation.test.ts` | T1, **T4·0 (file-conflict edge, §3 — not a type dependency)** | no |
| **T4·0** | extract CLI-stub helpers | `test/agent-cli-stub.ts`, `test/gauge-agent-transport.test.ts` | T1 | no |
| **T4·1a** | **GATE** — `/clear` + `modelUsage` probe | scratch only (`/mnt/d/tmp`) | T4·0 | no |
| **T4** | `WarmSession` | `src/gauge/warm-session.ts` + its test | T2, T4·1a | no |
| **T5a** | `acp-paths.ts` (fingerprint, socket, locks) | `src/gauge/acp-paths.ts` + its test | T2 | no |
| **T5b** | singleton dispatcher — **SKIP on the pool path** (§4) | `src/gauge/acp-daemon.ts` + its test | T4, T5a | no |
| **S0** | `WarmSession` takes `isolation` | `src/gauge/warm-session.ts`, `test/warm-session.test.ts` | T4 | no |
| **S1** | profile registry + `isGaugeEligible` | `src/gauge/acp-profiles.ts` + its test | S0 | no |
| **S2** | `SessionPool` | `src/gauge/acp-pool.ts` + its test | S0, S1 | no |
| **T2n** | **`_meta.kkamak` namespacing** — every custom `_meta` key nested under a `kkamak` vendor key, per the extensibility page (pool plan §B calls this required; until this node, NO task owned it — review finding D5) | `src/gauge/acp-wire.ts` (the `Acp*` shapes) + its test | T2 | no |
| **S3** | pooled ACP dispatcher — **CREATES** `acp-daemon.ts` when T5b is skipped (§4), and then also owns T5b's lifecycle scaffolding | `src/gauge/acp-daemon.ts` + its test | S2, T5a, T2n | no |
| **T6** | `acp-client.ts` + `acp-fake-daemon.ts` + export `buildAgentOutgoingText` | `src/gauge/acp-client.ts`, `test/acp-fake-daemon.ts`, `src/gauge/agent-transport.ts` | T2n, T5a | no |
| **S4** | session-scoped client API + `DaemonOutcome.profile` | `src/gauge/acp-client.ts`, `test/acp-fake-daemon.ts` | T6, S3 | no |
| **T7** | route `agent-sdk-daemon`, gauge-eligibility refusal | `src/gauge/transport.ts`, `src/gauge/corpus-replay.ts` | T3, S4, S1 | no |
| **T8** | SessionStart hook + `liveDerivesOnDaemon` | `src/gauge/transport.ts`, `src/hook-cli.ts`, `hooks/hooks.json` | T7, S4 | no |
| **P0** | proposer instrument registration | loop spec md, gauntlet ledger | — | no |
| **P1** | `minimal/llm.ts` → pool | `minimal/llm-acp.ts`, `minimal/llm.ts` | S4, P0 | no |
| **T9** | paired validation | shadow store, `docs/gauge-pv/*.json` | T7, T8 | **YES — own go** |
| **T10** | verdict + live flip | `refiner-cli.ts`, tests, ledger, spec | T9 | no |
| **P2** | judge → pool (optional) | judge-audit | S4 | no |

---

## 2. Schedule — layers, each layer's nodes runnable concurrently

```
L0   T1 · P0                    T1 gates ALL code (Post-plan rule 2); P0 is docs
      │
L1   T4·0 ◄─ T1                 T2 ◄─ T1                      (2-way)
      │                          │
L2   T4·1a ◄─ T4·0              T2n ◄─ T2  ·  T3 ◄─ T1,T4·0   ★ GATE + 2 more
      │                          │
L3   T4 ◄─ T2, T4·1a            T5a ◄─ T2                     (2-way)
      │                          │
L4   S0 ◄─ T4                   T6 ◄─ T2n, T5a                (2-way)
      │
L5   S1 ◄─ S0
      │
L6   S2 ◄─ S0, S1
      │
L7   S3 ◄─ S2, T5a, T2n
      │
L8   S4 ◄─ T6, S3
      │
L9   T7 ◄─ T3, S4, S1           P1 ◄─ S4, P0                  (2-way)
      │
L10  T8 ◄─ T7, S4
      │
L11  T9 ◄─ T7, T8               ← REAL SPEND, own sized go
      │
L12  T10 ◄─ T9                  ← gated on the §6e bar AND the open scope question
```

Note `T3` sits at L2 rather than L1: its edge to `T4·0` is a FILE conflict, not
a type dependency (§3), so it cannot start until `T4·0` has landed even though
nothing it imports comes from there.

**Critical path (13 hops), unchanged by these fixes:**
`T1 → T4·0 → T4·1a → T4 → S0 → S1 → S2 → S3 → S4 → T7 → T8 → T9 → T10`

Off it: `T2`, `T2n`, `T3`, `T5a`, `T6`, plus `P0`/`P1`/`P2`.

**Peak concurrency is 2, not 3 (review finding D4).** Every parallel layer
holds exactly two runnable nodes — L1 {T4·0, T2}, L3 {T4, T5a}, L4 {S0, T6},
L9 {T7, P1} — and L2's three ({T4·1a, T2n, T3}) is the sole exception, worth
little because T4·1a is a STOP gate whose failure cancels the other two anyway.
L5 through L8 are strictly serial: the S-chain's every link consumes the
previous link's type. **Do not staff this graph expecting fan-out.**

---

## 3. File-conflict map — why some "independent" nodes cannot run together

Two nodes writing one file cannot be dispatched concurrently, however
unrelated their intent. Verified against both plans' Files blocks:

| file | claimed by | resolution |
|---|---|---|
| `test/gauge-agent-transport.test.ts` | **T3** (exceptions #1, #2) and **T4·0** (exception #4) | **SERIALIZE T4·0 → T3.** T4·0 moves helpers OUT and deletes now-dead imports; T3 replaces the literal-list assertion and appends. Same file, different regions — a concurrent merge would conflict. |
| `src/gauge/warm-session.ts` | **T4** creates, **S0** modifies | Sequential by dependency already (S0 needs T4). |
| `src/gauge/acp-daemon.ts` | **T5b** creates, **S3** rewrites | Resolved by SKIPPING T5b (§4). |
| `src/gauge/acp-client.ts` | **T6** creates, **S4** modifies | Sequential by dependency already. |
| `test/acp-fake-daemon.ts` | **T6** creates, **S4** adds variants | Sequential by dependency already. |
| `src/gauge/transport.ts` | **T7** (`callModelDerive`) and **T8** (`liveDerivesOnDaemon`) | **SERIALIZE T7 → T8.** The pool plan puts the shared predicate in `transport.ts` deliberately (it is already on `hook-cli.ts`'s eager import path); that makes these two nodes co-located. |

Everything else touches disjoint files.

---

## 4. Efficiency finding: skip T5b entirely

**T5b (the singleton dispatcher) is throwaway work on the pool path.** S3's own
Files block says it *replaces* `acp-daemon.ts`'s singleton design while keeping
`acp-paths.ts`, the bind lock, stale-socket takeover, the spawn log, the
`setEncoding` calls and the `import.meta.main` guard. Those all live in **T5a**.
So splitting daemon-plan Task 5 into **T5a (paths — keep) + T5b (dispatcher —
skip)** removes an entire build-then-rewrite cycle, including its test file.

**The skip is NOT free, and S3 must absorb the difference (review finding
D1).** S3's Files block says "**modify** `acp-daemon.ts`; **modify**
`test/acp-daemon.test.ts`" — both written by T5b. Skip T5b and neither file
exists, so taking this optimisation REQUIRES three amendments to S3, which the
implementer must make before starting it:
1. `modify` → **`create`** for both files.
2. S3 inherits every piece of T5b's lifecycle scaffolding its own text
   currently lists under "Keeps unchanged": the `import.meta.main` guard, the
   bind-lock acquire/release around probe→unlink→rebind, stale-socket
   takeover, the post-listen spawn-log line, `socket.setEncoding("utf8")` on
   every accepted socket, the idle reaper's tick formula, and the
   SIGTERM/SIGINT drain path. "Keeps unchanged" is only true relative to a
   T5b that was built; with T5b skipped these are S3's to write.
3. S3 inherits T5b's wire-behaviour tests too — the ones the pool plan's S3
   already says to "carry over", plus the credential-free split (unknown
   method, malformed frame, idle reaper, stale-socket takeover, live-socket
   refusal).
If that absorption looks like too much for one node, do NOT skip T5b — build
it and accept the rewrite. The optimisation is a schedule choice, not a
correctness one.

**Consequence for T6.** T6's e2e test ("`ensureDaemon` + `daemonCall` against
the real daemon") needs *a* daemon. Without T5b that is S3, which sits later.
**Chosen: (a)** — build T6 at L4 against fake daemons only, and move its single
e2e test into S4's suite, which runs after S3 exists. (The alternative, moving
all of T6 after S3, costs the L4 parallelism for no gain.)

**If the scope question (§6) resolves toward "gauge only, no pool", this
inverts**: build T5b, skip S1-S4 entirely, and the graph collapses to
`T1 → T4·0 → T4·1a → T4 → {T5a,T5b,T6} → T7 → T8 → T9 → T10`.

---

## 5. Dispatch notes

- **Nodes are SDD tasks**, not free-form work: each ends with its own tests
  green, `tsc` clean, and a commit. Per-task fresh-context review after each,
  as with the §6d branch.
- **Concurrent nodes must be separate agents on separate files** — see §3. Do
  not hand one agent two nodes from the same layer if they share a file.
- **Run full suites SERIALLY at layer boundaries — concurrent suite runs are
  a known risk, not a proven-safe operation (review finding D6).** Every node
  ends with `bun test` over the whole `cc-gate-plugin` suite (857 tests,
  ~26 s). Per-test temp sockets (`KKAMAK_ACP_SOCKET`) keep two runs from
  binding the same endpoint — but the daemon tests' `afterEach` asserts that
  `~/.config/kkamak/` holds no `acp-*` file, and that directory is SHARED
  across concurrent runs. Two suites are safe only if neither ever leaks
  there, which is exactly what that assertion exists to catch; a leak in one
  would fail the other and look like a defect in the wrong node. Let
  concurrent nodes develop in parallel, then run the suite once per layer.
- **One branch**, `acp-session-pool`. 7b is ARMED: merge via
  `scripts/merge-with-gate.sh` with a committed
  `docs/reviews/<sha>-acp-session-pool.md`.
- **T9 is the only spend node.** It stops for an explicit sized go and reports
  the sample size `pv-sample` actually printed, not an assumed 10.

---

## 5b. Self-review pass (2026-08-04, by the author)

2 critical, 3 important, 1 minor found; **D1-D5 applied, D6 folded into §5.**
Both criticals were introduced by this document's own first draft.
- **D1** — §4's "skip T5b" optimisation silently reassigned work: S3's Files
  block says *modify* two files T5b creates, so with T5b skipped S3 hits "no
  such file" and also inherits all of T5b's lifecycle scaffolding and
  wire-behaviour tests. §4 now states the three amendments the skip requires,
  and says plainly that if they look too big, build T5b instead.
- **D2** — L0 ran `T4·0` (a test-file refactor, i.e. code) concurrently with
  `T1`, violating Post-plan rule 2: *"Task 1 must land before any code."*
  Every layer below shifted by one.
- **D3** — the node table gave `T3` only a `T1` dependency while the schedule
  annotated a `T4·0` file conflict. The edge is now in the table, marked as a
  file-conflict edge rather than a type dependency.
- **D4** — "2-3 concurrent nodes" overstated it. Real peak is 2; the single
  3-wide layer is L2, whose value is illusory because `T4·1a` is a STOP gate.
- **D5** — the `_meta.kkamak` namespacing that pool-plan §B calls *required*
  had been flagged unapplied twice and owned by nobody. It is now node `T2n`,
  off the critical path, feeding `T6` and `S3`.

**Pattern, recorded because it is now three passes running:** each review's
criticals were created by the previous pass's fixes. The DAG's conclusions
(13-hop critical path, peak concurrency 2, the two file conflicts, T5b's
redundancy) have survived every pass; the defects have all been in freshly
written prose. Prose review has stopped converging here — execute `T1 → T4·0 →
T4·1a` instead, since that gate is token-free and settles more than a fourth
pass would.

## 6. What the DAG cannot decide

Two open questions gate large parts of this graph, and neither is a scheduling
problem:

1. **The send-prompt question.** If the design-time seats need only stateless
   prompt-in/text-out, then S2-S4 serve exactly one caller (the gauge) — which
   is the singleton T5b already provides. That would delete L5-L8 from the
   critical path and make §4's inversion the right build.
2. **The live flip (T10).** My review of it stands: it optimises ~0.03% of a
   median 17.2 s live derivation and makes the live path slower than today's
   direct API call. T10 is scheduled here for completeness, not endorsed.

`S0` and `S1` are worth building under either answer. Everything from `S2`
onward is contingent on question 1.
