# Master — Boundary/Orchestration Layer Build Plan (D4 / D8 / D9 + R1–R4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the **master** — the *deterministic* boundary/orchestration layer between the human and the self-orchestrating fleet. The master is a persistent SINGLETON **authority** + skill-less **composite scheduler**: it relays gates to/from a human over a durable transport, exposes what is pending, runs the quality gate out-of-process, schedules per-project ephemeral sub-schedulers under one global resource cap, and reconciles crash state against git truth. It contains **no LLM in its own decision path** — every skill/formulation job is delegated to a leaf node via the already-shipped `role-run`/`squad-run` seam.

**Architecture:** All new code lands under `opencode-plugin/src/fleet/master/`; the *only* edit to shipped code is a new `master` subcommand case in `bench/cli.ts`. The master is assembled from six deterministic modules, each with its side-effecting boundary behind an injected seam so the whole layer is hermetically testable:

| Module | Job | Decided by |
|---|---|---|
| `master/gate-state.ts` | Durable, queryable log of pending gates + processed instructions (the R1 *exposure* surface + D8.1 durable log). Atomic writes (D9). | §9.1, R1, D8.1, D9 |
| `master/transport.ts` | Human↔master channel seam (Telegram getUpdates / Slack-HTTP + offset-ack) — **NOT Slack Socket Mode**. Fake in-memory transport for tests. | §9.2 **as corrected by R1** |
| `master/relay.ts` | The deterministic relay tick: poll → parse inbound → resume the paused `squad-run` on a gate answer → surface pending state on a status query → send. The single chokepoint for human-owned outward actions. | §9.1, R1, §9.3 (halt-on-approval) |
| `master/frozen-gate.ts` | Run the deterministic gate (`bun test` + smoke) out-of-process from a path the fleet worktrees cannot write to, + a gaming-monitor. | R3 |
| `master/namespace.ts` | Project-namespace registry: per-project isolation of runtimeRoot / worktreeBase / integration-branch / credential-scope / gate-policy / lifetime. | D8.3, D8.4 |
| `master/scheduler.ts` | Deterministic composite scheduler: admit ready per-project requests under a global cap (fair-share), spawn **ephemeral** sub-schedulers (never a persistent sub-master). | D8.1, D8.2, D8.4 |
| `master/reconcile.ts` | On restart, reconcile persisted namespace intent vs git truth (abort partial merges, done-by-commit, re-drive live-at-crash, discard partial worktrees). | D9 |
| `master/master.ts` | The singleton daemon loop (advisory lockfile = one logical authority) + the `master` CLI subcommand; ties the tick together. | §9.1, D8.1 |

The master **reuses, never reimplements**, the shipped gate mechanism: a human gate answer rides the existing `cmdSquadRun({ resume:true, gateAnswer })` checkpoint/resume idiom (`squad-cli.ts:191-211`); the per-project DAG execution is the self-hosting `fleet-dev` scheduler (self-hosting spec T4 / N5a), consumed here as an **injected `SubScheduler` seam** so this plan neither depends on T4 being built nor duplicates it.

**Tech Stack:** TypeScript, Bun (`bun test`), `bun:test`, `node:fs`/`node:child_process` (`execFileSync`), the shipped `writeJsonAtomic` (`bench/util.ts:68-74`) and `die` (`bench/util.ts:58`). No new runtime dependencies. Real network (Telegram/Slack HTTP), the OpenClaw platform binding, and any LLM call are **out of scope** (deferred — see Notes).

---

## Spec corrections the implementer MUST honor (R1–R4 override the stale §9.2 text)

The spec §9.2 names **OpenClaw / Slack Socket Mode** as the master platform. The 2026-07-16 research (`docs/master-open-questions-research.md`, adversarially verified) **corrects that**, and this plan follows the research, not the stale §9.2 prose:

1. **R1 — transport.** Slack **Socket Mode has NO offline durability** (events during a socket gap are silently dropped). Do **not** build on Socket Mode. Use a transport with server-side backlog + offset-ack: **Telegram getUpdates** (24h backlog, strongest) or **Slack-HTTP + Delayed Events**. The `Transport` seam (Task 2) models exactly `poll → ack(offset)` so either backing implementation drops in later.
2. **R1 — the REQUIRED small thing is state exposure, not a queue.** The master must **expose its processed-instruction / pending-gate state** so the human (the durability layer) can verify and re-send drops. That is the `gate-state.ts` query surface (Task 1) + the relay's `status` verb (Task 3). A durable inbox + persist-before-ack is **deferred hardening** (only needed once the master is unattended / higher-volume).
3. **R3 — the gate is out-of-process + monitored.** Run the frozen gate where the patcher/fleet cannot write to it, plus a **gaming monitor** (score jumps that don't reflect real capability — e.g. DGM node-114 deleting the logging its detector relied on). Hiding alone is insufficient; mechanical isolation is what holds. That is `frozen-gate.ts` (Task 4).
4. **R4 / D8 — the master is deterministic; it needs NO LLM-fitness.** The master's correctness is *operationally verifiable* (did it schedule ready nodes, relay gates, enforce sole-remote-writer, reconcile against git?), not a graded artifact. Therefore **no LLM lives in the master's decision path**, and the evolvable master *persona* (§9.3) — plus its human-score/proxy fitness — is **held LAST and is out of scope for this build** (§9.3 automation order). Any LLM-ish job (backlog→slice text, gate-question phrasing) is **delegated to a leaf node** via the shipped `role-run`/`squad-run` seam, never executed in-master.

The spec §9.2 already carries a TRANSPORT NOTE reflecting (1)/(2); this plan is the build-time realization of that note and of (3)/(4).

## Global Constraints

- **Determinism — no LLM in the master decision path (binding).** Every scheduling, gate-relay, reconciliation, and outward-action decision is a *pure function of durable state + injected deterministic seams*. No module under `fleet/master/` imports an LLM driver, calls `cmdRoleRun`/`cmdRoleScore` for a *judgment*, or branches on model output. LLM-ish formulation is delegated to a leaf and is out of scope here. **Every task below re-affirms this**; a task that needs an LLM to decide is mis-scoped.
- **Singleton authority, composite scheduling (D8.1/D8.2).** One logical master = one process, enforced by an advisory lockfile under `masterRoot` (Task 8). Sub-fleets are **ephemeral sub-schedulers** spawned per wave (injected `SubScheduler`), never persistent sub-masters. Authority does not recurse; structure + scheduling do.
- **Atomic-commit crash-consistency (D9).** Every durable master write goes through `writeJsonAtomic` (temp+rename; `bench/util.ts:68-74`) — the master advances only past an atomic boundary. On restart the master reconciles persisted *intent* against *git truth* and discards anything before its boundary. (`fsync`-hardening of the shared writer is a self-hosting D9 item — see Notes; this plan writes through the shared atomic writer so it inherits that fix for free.)
- **Ledger anchoring (N1b idiom).** All master durable state lives under `<masterRoot>/.meta-harness/runtime/master/`, **never** a throwaway worktree — so it survives worktree cleanup, exactly as the squad ledger stays in `runtimeRoot`.
- **Back-compat is total.** The master is all-new code under `fleet/master/`. The single edit to shipped code is a new `case "master":` + one usage line in `bench/cli.ts`. No existing fleet path (`run.ts`, `squad-cli.ts`, `score.ts`, `pending.ts`, `squad.ts`, `worktree.ts`) changes. Verified by full-suite green after Task 8.
- **Reuse the shipped gate mechanism.** The gate relay rides the existing `cmdSquadRun({ resume:true, gateAnswer })` (`squad-cli.ts:191-211`); the master never reimplements checkpoint/resume, and never opens its own PR flow (that is self-hosting N2, invoked as an outward-action seam).
- **Hermetic tests.** Temp dirs (`mkdtempSync(join(tmpdir(), …))`), injected seams (`fakeTransport`, fake `SubScheduler`, `GitProbe`, `GateExec`), `META_HARNESS_HOME` per-test only where a store is touched — **no real network, process spawn, git remote, or LLM**. Match the shipped fleet idiom (`bun:test`, `beforeEach`/`afterEach` temp-dir dance, `fleet-helpers.ts`).
- **Tests run with:** `bun test test/<file>.test.ts` from `opencode-plugin/`.

---

### Task 1: `master/gate-state.ts` — the durable pending-gate + processed-instruction log (R1 exposure, D8.1, D9)

The master's durable authority log: what is *awaiting a human gate* and what instructions have been *processed*. This is the R1-REQUIRED exposure surface (so the human can verify + re-send) and the D8.1 durable log. Anchored under `masterRoot` (survives worktree cleanup), atomic writes (D9).

**Files:**
- Create: `opencode-plugin/src/fleet/master/gate-state.ts`
- Test: `opencode-plugin/test/master-gate-state.test.ts`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `die` (`../../bench/util.ts`).
- Produces:
  - `type GateKind = "gate1" | "gate2" | "verdict" | "merge" | "escalation"`
  - `interface PendingGate { project: string; sliceId: string; kind: GateKind; payload: string; raisedAt: string; relayRef?: string }`
  - `interface ProcessedRecord { inboundId: string; project: string; sliceId: string; answer: string; processedAt: string }`
  - `interface MasterLog { pending: PendingGate[]; processed: ProcessedRecord[] }`
  - `masterLogPath(masterRoot: string): string` → `<masterRoot>/.meta-harness/runtime/master/gate-log.json`
  - `loadMasterLog(masterRoot): MasterLog` (missing file → `{ pending: [], processed: [] }`)
  - `raiseGate(masterRoot, g: PendingGate): void` (atomic append; a duplicate `project+sliceId+kind` is idempotent — replaces, never doubles)
  - `markRelayed(masterRoot, project, sliceId, relayRef): void`
  - `resolveGate(masterRoot, project, sliceId, rec: ProcessedRecord): void` (move the matching pending → `processed`, atomic)
  - `pendingGates(masterRoot, project?): PendingGate[]` (the R1 query surface; optional namespace filter)

- [ ] **Step 1: Write the failing test** — `master-gate-state.test.ts`. Intent + key assertions:
  - `raiseGate` then `pendingGates()` returns it; `masterLogPath` is under `.meta-harness/runtime/master/` of a temp `masterRoot`.
  - **Idempotent raise:** raising the same `project+sliceId+kind` twice leaves exactly one pending entry (a re-sent escalation must not double).
  - **resolve moves, not duplicates:** `resolveGate` removes it from `pending` and appends to `processed`; `pendingGates()` is then empty and `loadMasterLog().processed` has the record.
  - **exposure filter:** two projects each raise a gate; `pendingGates(root, "projA")` returns only projA's.
  - **atomic/torn-write survival:** write a valid log, then simulate an interrupted writer by leaving a stray `*.tmp` sibling and asserting `loadMasterLog` still reads the committed file (temp+rename discipline — mirrors T1's atomicity intent).
  ```ts
  test("raiseGate → pendingGates exposes it; resolveGate moves it to processed", () => {
    const root = mkdtempSync(join(tmpdir(), "mh-master-log-"))
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" })
    raiseGate(root, { project: "p", sliceId: "s1", kind: "gate1", payload: "spec…", raisedAt: "t0" }) // dup
    expect(pendingGates(root)).toHaveLength(1)                               // idempotent
    resolveGate(root, "p", "s1", { inboundId: "u7", project: "p", sliceId: "s1", answer: "approve", processedAt: "t1" })
    expect(pendingGates(root)).toEqual([])
    expect(loadMasterLog(root).processed.map((r) => r.inboundId)).toEqual(["u7"])
    rmSync(root, { recursive: true, force: true })
  })
  ```
- [ ] **Step 2: Run test to verify it fails** — `bun test test/master-gate-state.test.ts` → FAIL (`Cannot find module '../src/fleet/master/gate-state.ts'`).
- [ ] **Step 3: Write minimal implementation.** `loadMasterLog` reads-or-defaults; each mutator is read→modify→`writeJsonAtomic(masterLogPath(root), log)`. `raiseGate` upserts on `(project,sliceId,kind)`. `resolveGate` filters `pending` and pushes to `processed`. Single-writer (the singleton master) means no flock is required here — note it in the header comment.
- [ ] **Step 4: Run test to verify it passes** — `bun test test/master-gate-state.test.ts` → PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): gate-state durable pending/processed log — R1 exposure + D8.1/D9"`

---

### Task 2: `master/transport.ts` — the human↔master transport seam (R1 correction of §9.2)

The channel abstraction. Backing impls (Telegram getUpdates / Slack-HTTP) come later; this task builds the **seam** + a fake, and encodes the R1 durability model: `poll` returns backlog since the last ack, `ack(id)` advances the offset. **No Socket Mode.**

**Files:**
- Create: `opencode-plugin/src/fleet/master/transport.ts`
- Test: `opencode-plugin/test/master-transport.test.ts`

**Interfaces:**
- Produces:
  - `interface InboundMsg { id: string; text: string; from?: string }` (`id` = the offset/update_id ack key)
  - `interface OutboundMsg { text: string; replyTo?: string }`
  - `interface Transport { poll(): Promise<InboundMsg[]>; ack(id: string): Promise<void>; send(m: OutboundMsg): Promise<{ id: string }> }`
  - `fakeTransport(script?: InboundMsg[]): Transport & { sent: OutboundMsg[]; acked: string[]; inject(msgs: InboundMsg[]): void }`

- [ ] **Step 1: Write the failing test** — `master-transport.test.ts`:
  - `fakeTransport` seeded with a script returns it on `poll`; after `ack(id)`, a second `poll` **does not** re-return acked messages (offset-ack durability — the Telegram getUpdates contract, R1).
  - Un-acked messages **re-appear** on the next `poll` (the "master was down / didn't ack → human sees no answer, backlog persists" self-healing property, R1).
  - `send` records into `sent` and returns a monotonic id; `inject` adds new backlog mid-test.
  ```ts
  test("poll returns backlog; ack advances the offset; un-acked re-appears (R1 durability)", async () => {
    const t = fakeTransport([{ id: "u1", text: "approve p/s1" }, { id: "u2", text: "status" }])
    expect((await t.poll()).map((m) => m.id)).toEqual(["u1", "u2"])
    await t.ack("u1")
    expect((await t.poll()).map((m) => m.id)).toEqual(["u2"])   // u1 gone, u2 (un-acked) stays
  })
  ```
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation.** `fakeTransport` holds an array + an ack-cursor set; `poll` returns entries whose id is not in `acked`; `ack` adds to the set; `send` pushes to `sent`, returns `{ id: "out-" + n++ }`. Header comment states the R1 rule: **any real impl MUST be offset-acknowledged (Telegram getUpdates / Slack-HTTP+Delayed Events) — Socket Mode is forbidden (no offline durability).**
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): transport seam + fakeTransport (offset-ack, R1 — no Socket Mode)"`

---

### Task 3: `master/relay.ts` — the deterministic relay tick (§9.1 gate mechanism, R1, human-owned outward actions)

Ties gate-state + transport + the **shipped** `squad-run --resume --gate-answer`. One tick: poll → parse each inbound → route. **No callbacks, no LLM** — a gate answer deterministically resumes the paused squad; a `status` query renders the R1 exposure surface; outward actions fire only on an explicit human approve (the halt-on-approval invariant, §9.3).

**Files:**
- Create: `opencode-plugin/src/fleet/master/relay.ts`
- Test: `opencode-plugin/test/master-relay.test.ts`

**Interfaces:**
- Consumes: `Transport` (Task 2); `pendingGates`/`raiseGate`/`resolveGate`/`markRelayed` (Task 1); `SquadOutcome` (`../squad.ts`).
- Produces:
  - `parseInbound(text): { verb: "answer" | "status" | "unknown"; project?: string; sliceId?: string; answer?: "approve" | "revise" }` (a fixed, deterministic grammar, e.g. `approve <project>/<sliceId>`, `revise <project>/<sliceId>`, `status`)
  - `type ResumeSquadFn = (a: { project: string; sliceId: string; resume: true; gateAnswer: "approve" | "revise" }) => Promise<SquadOutcome>` (bound `cmdSquadRun`)
  - `interface RelayDeps { masterRoot: string; transport: Transport; resumeSquad: ResumeSquadFn; onApprovedTerminal?: (o: SquadOutcome, ctx: { project: string; sliceId: string }) => Promise<void>; now?: () => string }`
  - `relayTick(deps: RelayDeps): Promise<{ handled: number }>`

  `relayTick` logic (pure control flow):
  1. `poll()` inbound. For each message, `parseInbound`.
  2. `answer` matching a `pendingGates()` entry → call `resumeSquad(...)`. Map the returned `SquadOutcome`: `status:"gate"` → `raiseGate` the new pause + `send`; `status:"escalation"` → `raiseGate(kind:"escalation")` + `send`; `status:"done"` → `send` "done", and (only here, on a human approve that terminated) invoke `onApprovedTerminal` (the **outward-action seam** — self-hosting N2 push/PR; never called on `revise` or a non-approve path). Then `resolveGate` the answered gate and `ack(msg.id)`.
  3. `status` → `send` a deterministic rendering of `pendingGates(masterRoot)` (the R1 surface) + `ack`.
  4. `unknown` / an `answer` with no matching pending gate → `send` a help/`"no such pending gate"` line + `ack` (self-healing: the human re-sends).

- [ ] **Step 1: Write the failing test** — `master-relay.test.ts` (fake transport + fake `resumeSquad`; NO real squad):
  - **gate round-trip:** seed a pending `gate1` for `p/s1`; inject `"approve p/s1"`; a fake `resumeSquad` returns `{status:"gate", gate:"gate2", …}`. After `relayTick`: the old gate is resolved, a new `gate2` pending exists, an outbound message was sent, and the inbound was acked.
  - **status exposure (R1):** seed two pending gates; inject `"status"`; assert the single outbound `text` contains both `sliceId`s (the exposure surface).
  - **outward-action halt (§9.3):** `resumeSquad` returns `{status:"done"}` for an `approve`; assert `onApprovedTerminal` fired **once**; then a `revise` that returns `{status:"gate"}` — assert `onApprovedTerminal` did **not** fire. Proves outward actions are gated on human approve only.
  - **self-heal on unmatched answer:** inject `"approve p/nope"` with no matching pending → `resumeSquad` NOT called, a "no such pending gate" reply sent, message acked.
  - **determinism:** `relayTick` calls no LLM (there is no LLM seam in `RelayDeps` to call — structurally enforced).
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation** per the logic above. `parseInbound` is a small regex/switch. Note in the header: `resumeSquad` is the shipped `cmdSquadRun` bound with `runtimeRoot = namespace.runtimeRoot` — the relay reuses checkpoint/resume, never reimplements it.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): deterministic relay tick — gate resume + R1 status + human-gated outward actions"`

---

### Task 4: `master/frozen-gate.ts` — out-of-process gate + gaming monitor (R3)

The master runs the deterministic quality gate (`bun test` + smoke — the self-hosting N5b gate content) from a location the fleet's worktrees **cannot write to**, and flags gaming (score jumps inconsistent with real capability). This is the R3 hardening the *master authority* applies; it does **not** rebuild the gate content (that is self-hosting T5) — it owns *where/how* the gate runs + the monitor.

**Files:**
- Create: `opencode-plugin/src/fleet/master/frozen-gate.ts`
- Test: `opencode-plugin/test/master-frozen-gate.test.ts`

**Interfaces:**
- Produces:
  - `type GateExec = (argv: string[], opts: { cwd: string }) => Promise<{ rc: number; stdout: string }>` (injected — hermetic; real default wraps `bench/exec.ts`'s `runHost`, never exercised in tests)
  - `interface FrozenGateResult { pass: boolean; testsRun: number; raw: string }`
  - `runFrozenGate(deps: { gateRoot: string; ref: string; exec: GateExec }): Promise<FrozenGateResult>` — executes the gate in `gateRoot` (an out-of-repo checkout of `ref` the fleet cannot write to), parses pass/fail + a test-count from stdout.
  - `interface GamingSignal { suspicious: boolean; reason?: string }`
  - `detectGaming(prev: { pass: boolean; testsRun: number }, next: { pass: boolean; testsRun: number }, opts?: { minTests?: number }): GamingSignal` — flags the DGM-node-114 signature: a run that **flips FAIL→PASS while the test count DROPS** (the gate was gamed by deleting/shrinking the check surface), or a PASS whose `testsRun < minTests` (baseline floor). Deterministic; no LLM.

- [ ] **Step 1: Write the failing test** — `master-frozen-gate.test.ts` (injected `GateExec` returning scripted stdout; NO real `bun test`):
  - `runFrozenGate` runs the exec **with `cwd: gateRoot`** (assert the injected exec saw `gateRoot`, proving out-of-process/out-of-repo isolation — the fleet worktree path is never the cwd).
  - a passing stdout → `{ pass:true, testsRun:N }`; a failing stdout → `{ pass:false }`.
  - **gaming detected:** `detectGaming({pass:false, testsRun:120}, {pass:true, testsRun:3})` → `suspicious:true` with a reason mentioning the test-count drop (DGM-114).
  - **not gaming:** `detectGaming({pass:false, testsRun:120}, {pass:true, testsRun:121})` → `suspicious:false` (real fix: passed without shrinking the surface).
  - **floor:** a PASS with `testsRun` below `minTests` → suspicious.
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation.** `runFrozenGate` calls `exec(["bun","test", …], { cwd: gateRoot })`, parses rc + a `\d+ (pass|tests)` count from stdout. `detectGaming` is the pure heuristic above. Header states: **gaming is *monitored*, not auto-resolved — a suspicious signal is surfaced to the human via the relay (it is never a silent auto-accept);** and the gate content (bun test + smoke) is self-hosting N5b — this module only isolates + monitors it.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): out-of-process frozen gate + gaming monitor (R3)"`

---

### Task 5: `master/namespace.ts` — project-namespace registry (D8.3, D8.4)

Multi-project under one master = a **namespace**, not a redesign. Each project gets isolated runtimeRoot / worktreeBase / integration-branch / credential-scope / gate-policy / process-lifetime. Pure data + isolation validation; the scheduler (Task 6) consumes it.

**Files:**
- Create: `opencode-plugin/src/fleet/master/namespace.ts`
- Test: `opencode-plugin/test/master-namespace.test.ts`

**Interfaces:**
- Consumes: `writeJsonAtomic`, `die`.
- Produces:
  - `interface ProjectNamespace { project: string; runtimeRoot: string; worktreeBase: string; integrationBranch: string; credentialScope: string; gatePolicy: "root-human" | "auto"; lifetime: "ephemeral" | "daemon" }` (`lifetime` defaults `"ephemeral"` — D8.4; `credentialScope` is the `fleet/*`-scoped non-admin credential id from self-hosting N2, never the owner's admin identity)
  - `interface NamespaceRegistry { projects: Record<string, ProjectNamespace>; globalCap: number }`
  - `registryPath(masterRoot): string`, `loadRegistry(masterRoot): NamespaceRegistry` (missing → `{ projects:{}, globalCap:<default> }`)
  - `registerProject(masterRoot, ns: ProjectNamespace): void` (atomic; **rejects** a namespace that collides with an existing project on any of runtimeRoot / worktreeBase / integrationBranch / credentialScope — isolation, D8.3)
  - `isolationOk(a, b): boolean` (the pairwise disjointness predicate)

- [ ] **Step 1: Write the failing test** — `master-namespace.test.ts`:
  - register two projects with disjoint roots/branches/creds → both present in `loadRegistry`; `lifetime` defaults `"ephemeral"` when omitted.
  - **isolation enforced:** registering a second project that **reuses another's `integrationBranch`** (or `runtimeRoot`, or `credentialScope`) `die`s (asserted via `expect(() => …).toThrow`). D8.3 per-project isolation is mechanical, not advisory.
  - `globalCap` persists and defaults sanely (e.g. `3`).
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation.** `registerProject` loads, runs `isolationOk` against every existing entry, `die`s on collision, else upserts + `writeJsonAtomic`. Note: D8.3's "per-project store-slice" is the **existing** account/project store layer — this registry introduces **no new store-splitting axis** (D6 untouched); it only records the outer namespace.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): project-namespace registry with mechanical isolation (D8.3/D8.4)"`

---

### Task 6: `master/scheduler.ts` — deterministic composite scheduler (D8.1, D8.2, D8.4)

Singleton authority, **composite scheduling**: admit ready per-project run-requests under one global resource cap (fair-share so one project can't starve others), and spawn each as an **ephemeral** sub-scheduler (the self-hosting `fleet-dev` DAG scheduler, injected as `SubScheduler`) — never a persistent sub-master. Deterministic ready-set + ordering; no LLM.

**Files:**
- Create: `opencode-plugin/src/fleet/master/scheduler.ts`
- Test: `opencode-plugin/test/master-scheduler.test.ts`

**Interfaces:**
- Consumes: `NamespaceRegistry`, `ProjectNamespace` (Task 5); `SquadOutcome`.
- Produces:
  - `interface RunRequest { project: string; feature: string; sliceId: string }`
  - `type SubScheduler = (req: RunRequest & { ns: ProjectNamespace }) => Promise<SquadOutcome>` (the **injected** ephemeral per-project executor = self-hosting T4/N5a `fleet-dev`; spawned per wave, holds no persistent authority — D8.2)
  - `interface AdmitResult { admitted: RunRequest[]; deferred: RunRequest[]; outcomes: Array<{ req: RunRequest; outcome: SquadOutcome }> }`
  - `admit(deps: { registry: NamespaceRegistry; sub: SubScheduler }, requests: RunRequest[]): Promise<AdmitResult>`

  `admit` logic: filter requests to registered projects; select up to `registry.globalCap` by **fair-share round-robin across distinct project keys** (deterministic tie-break by project then sliceId), so N requests from one project don't monopolize the cap; run the admitted set through `sub` (each with its resolved `ns`); return admitted/deferred + outcomes. Every admitted run is a fresh ephemeral `sub` call — the composite recurses, authority does not.

- [ ] **Step 1: Write the failing test** — `master-scheduler.test.ts` (fake `SubScheduler` recording calls; NO real fleet-dev):
  - **cap respected:** `globalCap:2`, 4 requests across 3 projects → exactly 2 admitted, 2 deferred; `sub` called exactly twice.
  - **fair-share:** 3 requests all from `projA` + 1 from `projB` with `cap:2` → the admitted 2 are **one projA + projB** (round-robin), not two projA — asserts no single-project starvation of the shared cap (D8.3).
  - **ephemeral spawn:** each `sub` call receives the correct resolved `ns` for its project (proves per-project isolation is threaded, and that `sub` is a fresh call, not a retained daemon).
  - **unregistered rejected:** a request for an unregistered project is deferred/refused, never run.
  - **determinism:** admit ordering is stable across two identical calls (no LLM, no randomness).
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation** — the deterministic round-robin selection + `Promise.all` over the admitted `sub` calls. Header: **composite SCHEDULING not composite AUTHORITY (D8.2)** — `sub` is ephemeral and injected; the master never forks a second persistent authority.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): deterministic composite scheduler — global cap + fair-share, ephemeral sub-schedulers (D8.1/D8.2)"`

---

### Task 7: `master/reconcile.ts` — restart reconciliation, intent vs git truth (D9)

On master restart, reconcile persisted namespace intent against **git truth** across every project: abort a partial merge (`MERGE_HEAD` present), treat a node whose commit-SHA is on the integration branch as done, re-queue nodes live at crash, discard their partial worktrees. Idempotent (re-merging an applied commit = no-op). This is the **master/namespace-level** wrapper; per-project DAG-node reconciliation is self-hosting N5a — invoked per namespace (injected).

**Files:**
- Create: `opencode-plugin/src/fleet/master/reconcile.ts`
- Test: `opencode-plugin/test/master-reconcile.test.ts`

**Interfaces:**
- Consumes: `NamespaceRegistry`/`ProjectNamespace` (Task 5); `loadMasterLog`/`pendingGates` (Task 1).
- Produces:
  - `interface GitProbe { hasMergeHead(root: string): boolean; branchContains(root: string, branch: string, sha: string): boolean; abortMerge(root: string): void }` (injected — a real default shells `git`, but tests inject a fake; a light real-git integration variant may use a temp repo as in `fleet-worktree.test.ts`)
  - `interface CrashIntent { project: string; sliceId: string; commitSha?: string; worktreeDir?: string; phase: "merging" | "running" }` (read from the persisted namespace/DAG state)
  - `interface ReconcileResult { abortedMerges: string[]; doneByCommit: string[]; redriven: string[]; discardedWorktrees: string[] }`
  - `reconcile(deps: { masterRoot: string; registry: NamespaceRegistry; intents: CrashIntent[]; git: GitProbe; removeWorktree: (dir: string) => void }): ReconcileResult`

  `reconcile` logic per intent: if `phase:"merging"` and `git.hasMergeHead(ns.runtimeRoot)` → `git.abortMerge` (→ `abortedMerges`); if `commitSha && git.branchContains(ns.runtimeRoot, ns.integrationBranch, commitSha)` → done (→ `doneByCommit`, no re-drive); else → re-queue (`redriven`) and `removeWorktree(worktreeDir)` if a partial worktree exists (→ `discardedWorktrees`). Idempotent + deterministic.

- [ ] **Step 1: Write the failing test** — `master-reconcile.test.ts` (fake `GitProbe` + spy `removeWorktree`):
  - **abort partial merge:** an intent `phase:"merging"` with `hasMergeHead:true` → `abortMerge` called, listed in `abortedMerges`.
  - **done-by-commit (idempotent):** an intent whose `commitSha` is `branchContains` → in `doneByCommit`, NOT re-driven, worktree not discarded (re-merging would be a no-op).
  - **re-drive + discard live-at-crash:** an intent `phase:"running"` with a `worktreeDir` and SHA not on the branch → in `redriven`, `removeWorktree(worktreeDir)` called, listed in `discardedWorktrees`.
  - **idempotent second run:** running `reconcile` twice on the same inputs yields the same result and calls `abortMerge` only when `MERGE_HEAD` is (still) present (no double-abort side effects).
  - **crash blast radius bounded:** completed (done-by-commit) intents are never re-driven — asserts only live-at-crash nodes are re-run (D9 blast-radius bound).
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL.
- [ ] **Step 3: Write minimal implementation** per the logic above. Header ties it to D9: **git is the crash-consistent artifact store — the integration branch's commits ARE the durable truth of completed nodes; anything before its atomic boundary is discarded, never consumed.** Note the coordination: this master-level reconcile calls the self-hosting N5a per-project reconcile (which owns intra-DAG node state) — here modeled by the `intents` input + `GitProbe`.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `git commit -m "feat(master): restart reconciliation vs git truth — abort/done-by-commit/re-drive (D9)"`

---

### Task 8: `master/master.ts` — the singleton daemon loop + `master` CLI subcommand (§9.1, D8.1); end-to-end integration

Assemble the tick: one iteration runs `relayTick` (gate/status IO) and advances the scheduler; the daemon loops with an injected `until` seam (so tests never spin forever). Enforce **singleton authority** with an advisory lockfile under `masterRoot` (second launch dies). Wire a `master` CLI case in `bench/cli.ts` against the frozen 4-subcommand contract. This task's test is the hermetic **end-to-end** proof.

**Files:**
- Create: `opencode-plugin/src/fleet/master/master.ts`
- Modify: `opencode-plugin/src/bench/cli.ts` (add a `master` usage line near the fleet block ~line 64 and a `case "master":` in the dispatch switch alongside `squad-run` ~line 1287; a small `parseMasterArgs` mirroring `parseSquadRunArgs`)
- Test: `opencode-plugin/test/master-loop.test.ts`

**Interfaces:**
- Consumes: every prior module (`gate-state`, `transport`, `relay`, `namespace`, `scheduler`, `reconcile`); `cmdSquadRun` (`../squad-cli.ts`) — the real resume binding; `die`.
- Produces:
  - `interface MasterDeps { masterRoot: string; transport: Transport; resumeSquad: ResumeSquadFn; registry: NamespaceRegistry; sub: SubScheduler; git: GitProbe; removeWorktree: (dir: string) => void }`
  - `acquireSingletonLock(masterRoot): () => void` (writes `<masterRoot>/.meta-harness/runtime/master/master.lock`; a live lock → `die("master already running")`; returns a release fn)
  - `masterTick(deps: MasterDeps): Promise<void>` (one iteration: `relayTick` + a scheduler advance)
  - `runMaster(deps: MasterDeps, opts: { until: () => boolean; intervalMs?: number }): Promise<void>` (loop until `until()` — the `until` seam replaces an infinite `while(true)` for tests and clean shutdown)

- [ ] **Step 1: Write the failing test** — `master-loop.test.ts`, the hermetic E2E (fake transport + fake `resumeSquad`/`sub` + fake `GitProbe`; NO real network/LLM/process):
  - **singleton lock (D8.1):** `acquireSingletonLock(root)` succeeds; a second call while held `die`s "master already running"; after `release()` a fresh acquire succeeds.
  - **gate E2E round-trip:** pre-seed a pending `gate1` for `p/s1`; the fake transport scripts `"status"` then `"approve p/s1"`; `resumeSquad` returns `{status:"done"}`. Run `runMaster` with `until` stopping after 2 ticks. Assert: the `status` tick sent a message listing `s1` (R1 exposure); the `approve` tick resolved the gate (`pendingGates(root)` empty), acked the inbound, and the terminal-approve outward-action seam fired exactly once.
  - **reconcile on startup:** `runMaster` first calls `reconcile` before its first poll (assert the injected `GitProbe`/`removeWorktree` were consulted before any transport poll) — restart-safety before serving.
  - **no LLM anywhere:** `MasterDeps` exposes no LLM seam; the whole loop is driven by the injected deterministic fakes (structural proof of the determinism invariant).
- [ ] **Step 2: Run test to verify it fails** — module-not-found FAIL (and the `master` CLI case absent).
- [ ] **Step 3: Write minimal implementation.** `acquireSingletonLock` via `existsSync`+atomic create (O_EXCL semantics; a stale lock older than a TTL may be reclaimed — note it, TTL-reclaim optional). `masterTick` = `await relayTick(...)` then a scheduler advance over any queued requests. `runMaster` = `reconcile(...)` once, then `while (!opts.until()) { await masterTick(...); }`. Wire `cmdSquadRun` as `resumeSquad` (binding `project = ns.runtimeRoot`). In `cli.ts`, add the usage line + `case "master":` that constructs real deps (real Telegram/Slack transport is a later drop-in — for now a `die("no transport configured")` guard or a `--dry-run` fake) and calls `runMaster`. **Prod behavior of every other subcommand is byte-identical.**
- [ ] **Step 4: Run test to verify it passes** — `bun test test/master-loop.test.ts` → PASS.
- [ ] **Step 5: Run the full suite (no regression)** — `bun test` → all green (existing fleet tests unchanged; only a new `master` CLI case added).
- [ ] **Step 6: Commit** — `git commit -m "feat(master): singleton daemon loop + master CLI subcommand; hermetic E2E (§9.1/D8.1)"`

---

## Notes / scope boundaries (YAGNI — deferred, with reopen triggers)

- **Real transport wiring (Telegram getUpdates / Slack-HTTP + Delayed Events) is DEFERRED.** This plan builds the `Transport` seam + fake only. A real backing impl drops in behind the seam; it MUST be offset-acknowledged (never Socket Mode, R1). Reopen: when the master runs against a live human channel.
- **Durable inbox + persist-before-ack is DEFERRED (R1).** The human is the durability layer (a down master fails to ack → re-send; a status query catches acked-then-crashed). Only worth building when the master becomes *unattended* / higher-volume. The gate-state log (Task 1) is the required exposure; the durable inbox is the optional hardening.
- **The evolvable master PERSONA + its LLM-fitness (§9.3) is HELD LAST — out of scope (R4/D8).** The master built here is the pure deterministic shell. Any LLM-ish job (backlog→slice text, gate-question phrasing, escalation summarization, PR descriptions) is **delegated to a leaf node** via the shipped `role-run`/`squad-run` seam — never executed in-master. Reopen: only after the loop proves itself on verifier-grounded roles (§9.3 automation order), and after a dedicated R4 credit-assignment pass.
- **The OpenClaw platform binding is fleet-side (oc-test), against this frozen contract (§9.1).** This plan builds the master *logic* in-repo, transport-agnostic; the OpenClaw HarnessHost adapter (§9.3 fitness source 1) is a separate, later, fleet-side task.
- **The per-project DAG scheduler (`fleet-dev` / self-hosting T4 / N5a) is a DEPENDENCY consumed as the injected `SubScheduler` seam, not built here.** Likewise the gate *content* (`bun test` + smoke, N5b/T5) and the push/PR credential boundary (N2/T2) are self-hosting tasks; the master consumes them as the `SubScheduler`, `GateExec`, and outward-action seams. This keeps the master plan hermetic and non-duplicative.
- **`fsync`-hardening of `writeJsonAtomic`** (temp+rename survives a process crash but not power-loss before the rename flushes) is a shared self-hosting D9 item (`bench/util.ts:68-74`). This plan writes exclusively through that shared writer, so it inherits the fix when it lands — the master introduces no new non-atomic write path.
- **Multi-tenant sub-masters are DEFERRED to a trust-boundary trigger (D8.5).** Same-owner many-projects → the singleton + namespace registry (Tasks 5/6) is correct and simpler. Reopen only on a different owner/org/host/credential domain or an SLA a restartable singleton can't meet. Register in `explicitly-not-now.md` if not already.
- **`master-*` test filenames** are deliberately chosen so `bun test` picks them up alongside `fleet-*`; keep the `master/` source subdir so the boundary is legible in the tree.
- **Every task traces to a decided point** (self-review): T1→§9.1+R1+D8.1+D9; T2→§9.2-as-corrected-by-R1; T3→§9.1+R1+§9.3-halt; T4→R3; T5→D8.3/D8.4; T6→D8.1/D8.2/D8.4; T7→D9; T8→§9.1+D8.1 + shipped-fleet integration (worktree/checkpoint/resume). The determinism invariant (no LLM in the master path) is structurally enforced in every task — no `MasterDeps`/`RelayDeps`/`SchedulerDeps` exposes an LLM seam.
