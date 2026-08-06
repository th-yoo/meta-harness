# P2 Actuator-Binding Probe Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Measure, per delivery mechanism (A1 prose / A3 binding chokepoint / A4 review-actuator), what fraction of TB2 bench runs an injected rule actually changes behavior — with mechanical detection and a pre-registered decision rule.

**Architecture:** A new `p2-run` bench subcommand reuses the existing sandbox/agent-run/verifier primitives (never the stock `run` path — F1-clean) to execute one arm × task × attempt with arm-specific injection: A1 appends the frozen rule to the stock harness markdown; A3 copies a `.claude/settings.json` Stop-hook gate into the container (pending Task 1's capability probe); A4 runs the stock harness, then a host-side haiku review via the ACP warm lane, then one bounded re-pass in the same container. A tally script computes compliance/pass@k/cost + the b2 shadow read into a committed F2-clean verdict json.

**Tech Stack:** Bun + TypeScript, `opencode-plugin/src/bench/` primitives (sandbox.ts, agent-run.ts, verifier.ts, results.ts), podman, ACP warm lane via `cc-gate-plugin/src/acp/index.ts`.

**Spec:** `docs/superpowers/specs/2026-08-05-p2-actuator-binding-design.md` (FLAWLESS; spec-is-law — deviations recorded, never silent).

## Global Constraints (verbatim from spec)

- Band: the 14 tasks of `term-bench2/splits/loop1-band.txt`, model claude-haiku-4-5, k = 2 per task per arm.
- Arms: same rule content, three carriers. A1 = TB2 workspace-file harness bullet (`assembleAgentsMd`-assembled markdown + rule, landing at `/app/CLAUDE.md`). A3 = container-level chokepoint, NOT CC hooks-on-host — one-shot `claude -p` injection verified by probe; hook substitution is a recorded plan decision (Task 1). A4 = post-attempt scoped haiku review, findings reinjected, ONE re-pass, **turn cap 10**.
- Rule frozen AT PLAN COMPLETION (this document, §Frozen Rule below) with grep pattern + anti-gaming criterion + A3 check; pre-data boundary = first run datum.
- Store isolation: every probe invocation writes `--results-file` under `docs/loop-probes/p2/` — NOTHING touches `term-bench2/store/**`; the run script hard-refuses without a results-file (protocol check).
- Cost fence: `--go N` must equal the invocation's exact planned container-execution count; mismatch = refusal, zero effect (channel-run discipline).
- Sized go BEFORE any model spend: 3×14×2 = 84 executions + ≤28 A4 re-passes (total ≤112) + ≤28 A4 review calls + Task 1's probe (≤4 haiku calls). The go is granted against the plan-completion table in Task 6, not estimates.
- F2: committed artifacts carry counts/stats/task-ids — never transcript or finding text.
- Live shadow: PASSIVE read of `.km/review-findings.ndjson` over the P2 window — realized n + events/day always reported; near-empty = "not evidential". No live arm assignment.
- Decision rule (spec §5, pre-registered): mechanism earns routing iff compliance ≥ 0.75 (≥21/28) AND pass@k not degraded > 0.15 absolute vs A1. A1 = control, no bar. A4's pass@k/cost reported WITH re-pass trigger rate + compute-bonus caveat; A4 oracle scores FINAL container state post re-pass.
- No pooling with loop-1's opus 7/8 (cross-tier, narrative only).

## Frozen Rule (freezes at this plan's commit; amendments only pre-first-datum, recorded)

**Rule text (verbatim, all arms):**

```
Before you finish, independently verify your work: run at least one
concrete check command against the actual artifacts (tests, a build, or
direct inspection of produced output) and write the command(s) you ran
and their observed result to /app/DONE-CHECK.txt. Your own reasoning
does not count as verification.
```

- **Family / baseline continuity:** `looks_done` — loop-1's dominant failure mode (v7-taxonomy.json: 5/7, "agent validated against its own logic rather than independent ground truth"). The v8 bullet's verbatim text is no longer in the store (v8 removed), so the continuity claim is scoped to the MODE, not the text — recorded here per spec §3's fallback clause.
- **Compliance detection (A1/A4, mechanical):** `/app/DONE-CHECK.txt` exists in the container after the attempt AND is non-empty AND (anti-gaming) at least one line of it contains a substring of ≥ 8 chars that also appears in a Bash-tool command of the attempt's parsed TrajEvents — echoing the rule text or writing prose is not compliance; the file must name a command that actually ran.
- **PRE-DATA AMENDMENT (2026-08-06, user-ruled "amend", before any run datum):** the anti-gaming match set EXCLUDES every Bash command whose text contains the DONE-CHECK path (`/app/DONE-CHECK.txt`). Reason, reproduced in Task 2's fresh-context review: the command that writes the file necessarily contains the file's content, so `echo "<prose>" > /app/DONE-CHECK.txt` self-satisfied the predicate with zero verification run — the unamended predicate measured "wrote a file via Bash", not "ran a check". Conservative side-effect accepted: a genuine command that merely references the path (e.g. `cat /app/DONE-CHECK.txt`) is also excluded; compliance requires naming a command that is not about the marker file itself.
- **A3 check (mechanical, binding):** a Stop-gate inside the container blocks completion until the compliance predicate above (file exists + non-empty) holds — the agent cannot finish without it, by construction. Delivery per Task 1's probe result.
- **Production note (2026-08-06 user ruling, NOT part of P2's arms):** the eventual production deployment of a binding Stop-gate should be queue-buffered (enqueue at Stop, enforce as debt at a later chokepoint — the two-tier-gate pattern) to avoid synchronous Stop-hook cost. P2 measures the arms as frozen above; this note only records the deployment shape decision for the post-verdict phase.

---

## File Structure

```
opencode-plugin/src/bench/p2/rule.ts        (create: frozen rule text + compliance predicate)
opencode-plugin/src/bench/p2/cmd-p2.ts      (create: p2-run subcommand — arm dispatch, cost fence, results-file fence)
opencode-plugin/src/bench/p2/a4-review.ts   (create: host-side haiku review + reinject prompt builder)
opencode-plugin/src/bench/cli.ts            (modify: register p2-run)
opencode-plugin/src/bench/p2/assets/stop-gate-settings.json (create: A3 in-container hook settings, if Task 1 confirms)
scripts/p2-tally.ts                         (create: verdict table + shadow read)
opencode-plugin/test/p2-rule.test.ts        (create)
opencode-plugin/test/p2-cmd.test.ts         (create)
opencode-plugin/test/p2-a4-review.test.ts   (create)
docs/loop-probes/p2/                        (results land here; gitkeep not needed — created at run time)
```

---

### Task 1: In-container CC capability probe (gate decision for A3)

**Files:**
- Create: `docs/loop-probes/p2/PROBE.md` (probe protocol + result — committed, counts only)

**Spend: ≤4 haiku calls — runs only under the granted sized go** (the go covers this probe + the bench runs; nothing in Tasks 2-5 spends).

Two questions, each answered inside a real TB2 container (reuse any band task's container, e.g. `extract-elf`):

- [ ] **Step 1: Probe A — does one-shot `claude -p` fire Stop hooks from `/app/.claude/settings.json`?** Create the container the way cmd-run does (or run `bun term-bench2/runner.ts task-load --tasks extract-elf` to find staging, then manually `podman` create+start per sandbox.ts's argv). Copy in a settings file with a Stop hook that writes a marker:

```json
{
  "hooks": {
    "Stop": [
      { "hooks": [ { "type": "command", "command": "touch /app/HOOK-FIRED && exit 0" } ] }
    ]
  }
}
```

to `/app/.claude/settings.json`, then `podman exec` the driver's exact argv shape (see `drivers/claude-code.ts:252 buildArgv`) with a trivial instruction ("reply with the word ok"). Afterward: `podman exec <c> ls /app/HOOK-FIRED`.

- [ ] **Step 2: Probe B: does the CC CLI in the container support `--max-turns` in -p mode?** `podman exec <c> claude --help | grep -i max-turns` (no model call), plus one live `-p` call with `--max-turns 1` to confirm it is accepted.
- [ ] **Step 3: Record both answers in PROBE.md** (commands run, exit codes, marker present y/n — no transcript text) and commit.
- [ ] **Step 4: DECISION GATE (recorded, not silent):** hooks fire → A3 = Stop-hook settings copy-in (Task 4's default path). Hooks do NOT fire → STOP and report to the user: the spec's PATH-shim fallback cannot see file-edit tool calls (they are not shell commands), so A3's mechanism needs a user ruling before Task 4 proceeds. `--max-turns` absent → A4's turn cap falls back to instruction text ("you have at most 10 turns") + recorded deviation.
- [ ] **Step 5: Commit** — `git add docs/loop-probes/p2/PROBE.md && git commit -m "docs(p2): in-container CC capability probe — hooks/-p + --max-turns verdicts"`

### Task 2: rule.ts — frozen rule + compliance predicate

**Files:**
- Create: `opencode-plugin/src/bench/p2/rule.ts`
- Test: `opencode-plugin/test/p2-rule.test.ts`

**Interfaces:**
- Produces:

```ts
export const P2_RULE_TEXT: string  // the Frozen Rule verbatim
export const DONE_CHECK_PATH = "/app/DONE-CHECK.txt"
/** sha256 of P2_RULE_TEXT — the arm-content identity, stamped in results. */
export function ruleSha(): string
/** Mechanical compliance: file content non-empty AND >=1 line shares a
 * >=8-char substring with some Bash-tool command from the traj events.
 * Pure — caller reads the file and extracts commands. */
export function isCompliant(doneCheckContent: string | undefined, bashCommands: string[]): boolean
/** Extract Bash-tool command strings from parsed TrajEvents (driver-neutral:
 * events with tool names matching /bash/i carry their command text). */
export function bashCommandsFromEvents(events: Array<{ tool?: string; command?: string }>): string[]
```

- [ ] **Step 1: Failing tests** — table-driven: undefined/empty content → false; content whose only overlap is rule-text echo → false; content containing `bun test x.test.ts` when that string is among bashCommands → true; 8-char boundary case (7-char shared substring → false); bashCommandsFromEvents filters non-bash tools.
- [ ] **Step 2: Run to verify fail** — `cd opencode-plugin && bun test test/p2-rule.test.ts`.
- [ ] **Step 3: Implement** — substring check: for each non-empty doneCheck line, for each command, test `command.includes(sub)` over the line's length-8 windows is O(n·m·L) worst case but inputs are tiny; simpler and sufficient: `commands.some(c => c.length >= 8 && content.includes(c.slice(0, Math.min(c.length, 64))))` is NOT the spec'd predicate — implement the declared one: some line L, some command C, some 8-char window of L appears in C. Keep under 30 lines.
- [ ] **Step 4: Run to verify pass** + `bunx tsc --noEmit`.
- [ ] **Step 5: Commit** — `"feat(p2): frozen rule + mechanical compliance predicate"`

### Task 3: a4-review.ts — host-side review + reinject builder

**Files:**
- Create: `opencode-plugin/src/bench/p2/a4-review.ts`
- Test: `opencode-plugin/test/p2-a4-review.test.ts`

**Interfaces:**
- Consumes: `daemonCall`, `ensureDaemon`, `closeSession`, `modelProvenBy` from `cc-gate-plugin/src/acp/index.ts` (the ONLY acp import path); `P2_RULE_TEXT` from Task 2.
- Produces:

```ts
export const A4_MODEL = "claude-haiku-4-5"
export const A4_TURN_CAP = 10
/** Review prompt: rule + evidence (DONE-CHECK content or "absent" + bash command list + workspace file list). Frozen at build; sha recorded in results. */
export function buildA4ReviewPrompt(evidence: { doneCheck: string | undefined; bashCommands: string[]; workspaceFiles: string[] }): string
/** Parse reviewer JSON {complied: boolean, requiredEdits: string[]} — tolerant (fenced/bare), undefined on junk. */
export function parseA4Review(text: string): { complied: boolean; requiredEdits: string[] } | undefined
/** Reinject instruction for the re-pass: rule + requiredEdits as a numbered demand list. */
export function buildReinjectInstruction(requiredEdits: string[]): string
/** The live call: ensure (zero-wait) -> daemonCall -> modelProvenBy check -> parse -> closeSession (best effort). undefined on any failure (caller records reviewFailed). Injected deps for tests. */
export function runA4Review(evidence: {...}, env: Record<string, string | undefined>, deps?: { call?: typeof daemonCall; ensure?: typeof ensureDaemon; close?: typeof closeSession }): Promise<{ complied: boolean; requiredEdits: string[] } | undefined>
```

The review prompt demands STRICT JSON: `{"complied": true|false, "requiredEdits": ["<edit demand>", ...]}` — empty requiredEdits when complied. Reviewer sees evidence, never the whole transcript (bounded prompt).

- [ ] **Step 1: Failing tests** — prompt contains rule + evidence fields; parse: bare/fenced/junk/wrong-shape; reinject numbers the edits; runA4Review with fake deps: ok-outcome path (incl. modelProvenBy fail → undefined), pool-exhausted → undefined, close called with sessionId on ok. No live calls in tests.
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run to verify pass** + tsc.
- [ ] **Step 5: Commit** — `"feat(p2): A4 host-side review + reinject builders (warm-lane, close-not-release)"`

### Task 4: cmd-p2.ts — the p2-run subcommand

**Files:**
- Create: `opencode-plugin/src/bench/p2/cmd-p2.ts`, `opencode-plugin/src/bench/p2/assets/stop-gate-settings.json` (per Task 1's verdict)
- Modify: `opencode-plugin/src/bench/cli.ts` (register `p2-run` case + USAGE line)
- Test: `opencode-plugin/test/p2-cmd.test.ts`

**Interfaces:**
- Consumes: Tasks 2-3; existing primitives — read these files first and reuse their exact signatures: `sandbox.ts` (container create/destroy per attempt), `agent-run.ts runAgent(driver, paths, containerName, task, model, variant, agentTimeout, harnessMd, execFn, sleepFn)`, `verifier.ts` (oracle scoring), `record.ts assembleAgentsMd` (stock harness assembly for the ACTIVE store candidate), `results.ts writeRunResults`, `drivers/claude-code.ts` driver object.
- Produces: `bun term-bench2/runner.ts p2-run --arm a1|a3|a4 --tasks <...>|--task-file F --k N --results-file PATH --go N [--model claude-haiku-4-5]`.

Behavior (all arms):
1. **Fences first:** `--results-file` REQUIRED (die without it — store isolation); resolved path must be under `docs/loop-probes/p2/` (die otherwise); `--go` must equal `tasks × k × (arm === "a4" ? 2 : 1)` planned MAX executions (A4 counts its potential re-pass; unfired re-passes are unspent budget, never re-allocated) — mismatch dies with the computed expected number.
2. Stock harness markdown assembled exactly as cmd-run does for the active candidate (same `assembleAgentsMd` inputs). Arm deltas:
   - **a1:** `harnessMd + "\n\n- " + P2_RULE_TEXT` (one appended bullet).
   - **a3:** stock harnessMd unchanged; AFTER container create and BEFORE `runAgent`, `podman cp` `stop-gate-settings.json` → `/app/.claude/settings.json` (A3 containers ONLY — never the shared image, never other arms). The settings file's Stop hook: `test -s /app/DONE-CHECK.txt` — exit 0 lets the stop pass, nonzero blocks with stderr explaining the rule (CC re-prompts the agent; its own consecutive-block bound backstops runaway).
   - **a4:** stock harnessMd unchanged; after `runAgent` returns, gather evidence (`podman exec cat /app/DONE-CHECK.txt` tolerant, `bashCommandsFromEvents(output.events)`, `podman exec ls /app`), `runA4Review(...)`; if review returns `complied: false` with requiredEdits → ONE re-pass: `podman exec` the driver argv with `buildReinjectInstruction(...)` as instruction + `--max-turns 10` (per Task 1 probe; fallback per its deviation note) in the SAME container; reviewFailed (undefined) → no re-pass, recorded.
3. Per attempt record (extends the results-file row via the label field, no schema change): compliance bit (Task 2 predicate, evaluated post-attempt — post-re-pass for a4), reprompted/re-pass-fired bit, reviewFailed bit, ruleSha, arm. Oracle verdict = existing verifier on FINAL container state.
4. Results via `writeRunResults` with `label: "p2-<arm>"` — counts/ids only (F2 holds by that writer's shape).

- [ ] **Step 1: Failing tests** (hermetic — fake execFn/driver per `agent-run.ts`'s injectable seams; NO podman, NO model): fence tests (missing results-file dies; path outside docs/loop-probes/p2/ dies; wrong --go dies naming expected count); a1 harness gets exactly one appended bullet (string assert); a3 issues the settings cp for its containers only (fake execFn records argv); a4 with fake review complied:false fires exactly one re-pass with the reinject instruction and --max-turns 10; a4 with complied:true fires none; compliance bit computed from fake DONE-CHECK + events.
- [ ] **Step 2: Run to verify fail** — `bun test test/p2-cmd.test.ts`.
- [ ] **Step 3: Implement** cmd-p2.ts + cli.ts registration (+ USAGE line under `p2-run`).
- [ ] **Step 4: Run to verify pass**, then FULL `cd opencode-plugin && bun test` + `bunx tsc --noEmit` (cli.ts is shared surface).
- [ ] **Step 5: Commit** — `"feat(p2): p2-run subcommand — three arms, cost+store fences, mechanical compliance capture"`

### Task 5: p2-tally.ts — verdict table + shadow read

**Files:**
- Create: `scripts/p2-tally.ts`
- Test: extend `opencode-plugin/test/p2-cmd.test.ts` only if pure helpers are shared; otherwise a small inline-tested pure core in the script per `b3-binarization-measure.ts` precedent (env-seam paths, home-anchored `.km` read via `scripts/p0-signal-variance.ts`'s `gateNdjsonPath` pattern — the sensor stream lives at `~/z2/meta-harness/.km/review-findings.ndjson`, read tolerantly).

Reads the three results files (a1/a3/a4) from `docs/loop-probes/p2/`, emits `docs/loop-probes/p2/<hostname>-p2-verdict.json`:

```json
{
  "spec": "docs/superpowers/specs/2026-08-05-p2-actuator-binding-design.md",
  "ruleSha": "...", "band": "loop1-band", "k": 2, "model": "claude-haiku-4-5",
  "arms": {
    "a1": { "n": 28, "compliance": 0.0, "passAtK": 0.0, "meanTurns": 0, "meanElapsedSec": 0 },
    "a3": { "n": 28, "compliance": 0.0, "passAtK": 0.0, "meanTurns": 0, "meanElapsedSec": 0, "stopBlocks": 0 },
    "a4": { "n": 28, "compliance": 0.0, "passAtK": 0.0, "meanTurns": 0, "meanElapsedSec": 0, "rePassRate": 0.0, "reviewFailedCount": 0 }
  },
  "bars": { "a3earnsRouting": false, "a4earnsRouting": false, "complianceBar": 0.75, "passDropBar": 0.15 },
  "computeBonusCaveat": "a4 pass@k gains with high rePassRate are not attributable to binding vs +10 turns",
  "b2Shadow": { "host": "yoo-dev", "realizedN": 0, "eventsPerDay": 0.0, "evidential": false, "windowStart": 0, "windowEnd": 0 }
}
```

- [ ] **Step 1: Failing tests for the pure tally core** (feed synthetic results rows → compliance/passAtK/bars math; bars: a3earnsRouting = compliance ≥ 0.75 AND (a1.passAtK − a3.passAtK) ≤ 0.15; same for a4; shadow evidential = realizedN ≥ 10).
- [ ] **Step 2: Run to verify fail.**
- [ ] **Step 3: Implement** (counts only — never transcript text into the json).
- [ ] **Step 4: Run to verify pass** + tsc.
- [ ] **Step 5: Commit** — `"feat(p2): tally — arm table, pre-registered bars, b2 shadow read"`

### Task 6: sized-go table + readiness report (no spend)

**Files:** none — verification/report task.

- [ ] **Step 1:** Full-suite gate: repo-root `bun test`, `bunx tsc --noEmit` in opencode-plugin (+ cc-gate-plugin untouched-check: `git diff --stat main -- cc-gate-plugin` empty).
- [ ] **Step 2:** Compute and report the EXACT spend table for the user's sized go:

| item | calls/executions |
|---|---|
| Task 1 probe | ≤4 haiku calls (2 probes × ≤2) |
| a1 | 14 tasks × k=2 = 28 container executions |
| a3 | 28 container executions |
| a4 first passes | 28 container executions |
| a4 re-passes | ≤28 additional executions (fired only on complied:false) |
| a4 review calls | ≤28 haiku warm-lane calls |
| **total** | **≤112 bench container executions + ≤28 review haiku calls + ≤4 probe haiku calls** |

Wall estimate 4-6 hrs tmux (loop-1 precedent), run detached IN TMUX (standing rule). Invocation order after go: Task 1 probe → 3× p2-run (one per arm, `--go 28` / `--go 28` / `--go 56`) → p2-tally → commit verdict json + report to user (§5 decision rule applied, adoption stays a separate ruling).
- [ ] **Step 3:** Report READY-FOR-SIZED-GO. **Do NOT run any arm. Nothing self-adopts.**

---

## Self-Review (done at write time)

- Spec coverage: §1 rulings → band/k/shadow in Global Constraints + Task 5 shadow; §2 arms → Tasks 2/3/4 (A3 hook route gated on Task 1's recorded decision, PATH-shim impossibility for tool-call edits recorded); §3 freeze → Frozen Rule section (text + grep + anti-gaming + A3 check, mode-scoped continuity recorded); §4 detection/outcomes → compliance predicate (T2), per-attempt bits (T4), tally fields incl. rePassRate + computeBonusCaveat + final-state oracle (T5); §5 bars → T5 bars object verbatim (0.75 / 0.15); §6 sized go → T6 exact table (84 base + ≤28 re-pass = ≤112 bench executions, +4 probe = ≤116 total with probe listed separately); §7 store isolation/fences → T4 fences; build order (sensor first) → satisfied, sensor is live.
- Placeholders: none — every step carries code, exact commands, or a recorded decision gate.
- Type consistency: `isCompliant`/`bashCommandsFromEvents` (T2) consumed by T4; `runA4Review`/`buildReinjectInstruction` (T3) consumed by T4 with matching shapes; tally reads `writeRunResults` rows (existing shape) + the per-attempt bits T4 records.
- Deviation latitude: implementers adapt to `sandbox.ts`/`verifier.ts` exact signatures (read-first instructed in T4); behaviors and fences are fixed.
