# Daemon carrier migration — eliminate `claude -p` from production LLM seats

**Date:** 2026-08-14 · **Status:** DESIGN (user-refined in brainstorm, pending spec review)
**Trigger:** proven proposer contamination — both crank proposer transcripts
(`f5ba3cad-*.jsonl`, `d1c0ffd7-*.jsonl`) contain "CAVEMAN MODE ACTIVE" +
superpowers references. `claude -p` children inherit CC's system prompt, repo
`CLAUDE.md`, SessionStart/UserPromptSubmit hooks, and the full plugin surface.
Every proposal that session was authored under a contaminated harness. Blast
radius: zero adopted rules (all 5 cranks rejected; store untouched).

**Ruling (user, this session):** production LLM seats (proposer, judge,
promoter, curator — "other LLM usages such as invoking proposer with its
prompt, judge etc.") are invoked via **cc-api-daemon**: pure LLM call with OUR
system prompt, not CC's. The TB2 bench entry point stays `claude -p` — CC is
the measured specimen. cc-api-daemon stays **toolless**; its warm-lane
isolation guard is not relaxed.

## 1. Per-site disposition table

| # | Site | Disposition | Why |
|---|------|-------------|-----|
| 1 | `cc-host.ts` `runClaudeCodeTextAgent` (judge) | **Migrate** to daemon | One-shot text turn; already passes our `--system-prompt`. Migration drops the CC runtime entirely. |
| 2 | `cc-host.ts` `runClaudeCodeTaskAgent` (proposer/promoter/curator) | **Migrate + restructure** | The contaminated seat: no system-prompt override, repo cwd, hooks + CLAUDE.md + plugins live. Becomes a pure text call; all I/O moves into our deterministic code. |
| 3 | `drivers/claude-code.ts` `buildArgv` (TB2 bench subject) | **Keep `claude -p`** | User-ruled: "We need to run CC anyway as the entry point." The CC agent IS the measured specimen; swapping the carrier changes what TB2 measures and breaks v0 baseline comparability. |
| 4 | `p2/cmd-p2.ts` probe arms | **Keep** | Probes measure CC hook mechanics (Stop hooks under one-shot `claude -p`) that the bench's a3 stop-gate still relies on. Target still exists because site 3 keeps CC. |
| — | kkamak gauge seats | Already migrated (N5, `2026-08-04-send-prompt-interface.md`) | Precedent; not in scope. |
| — | a4-review | Already on daemon (`p2/a4-review.ts`) | Reference implementation for the client call pattern. |

Consequence of 3+4 staying: no TB2 re-baseline, no bench boundary break.
Contamination is closed at its source (site 2); site 1 is carrier hygiene.

## 2. Carrier contract (both migrating seats)

- Client trio `ensureDaemon` / `daemonCall` / `closeSession` from
  `@th-yoo/cc-api-daemon` (already pinned at `33f74db` = 0.8.0 in
  opencode-plugin and cc-gate-plugin — **no new dependency surface, no daemon
  contract change, no version bump**).
- Isolation shape: `systemPrompt: <ours>`, `settingSources: []`, `tools: []`,
  `settings: { autoMemoryEnabled: false }`, `persistSession: false`,
  `strictMcpConfig: true`, `thinking: { type: "disabled" }` — the same
  `WarmIsolation` a4-review uses. The daemon's strict toolless validator stays
  byte-identical.
- Backend routing is the daemon's (`routeBackend`): OAuth models ride the warm
  agent-sdk lane; only api-key/haiku-class models take the direct API lane.
  Callers do not choose lanes.
- Designed-around daemon caveats (all previously bitten):
  - **api-lane `DEFAULT_MAX_TOKENS` 2048 truncation** — pass explicit
    `maxTokens` sized per seat; check the truncation signal a4-review checks.
  - **cold-daemon silent-skip** — production seats call `ensureDaemon` with a
    nonzero `waitMs` (a4-review's zero-wait budget-guard behavior is NOT
    copied for proposer/judge; a missing daemon must spawn, not skip).
  - **429-per-transport** — retry/backoff stays at the seat, per existing
    retry conventions; a 429 on the daemon lane says nothing about `claude -p`
    health and vice versa.
  - **auth path** — api lane needs `ANTHROPIC_API_KEY`; warm lane rides host
    OAuth. Non-anthropic model guard (existing log + `null` return) stays.

## 3. Seat 1 — judge (`runClaudeCodeTextAgent`)

Body swap only. Same exported signature, same NEVER-throws / null-on-failure
contract, same caller (`host.runTextAgent`), same log-line shapes (`[cc-host]
runTextAgent: ...`). Replace the spawn + JSON-stdout parse with:
`ensureDaemon` → `daemonCall(prompt, model, { systemPrompt: opts.system, ... })`
→ outcome check (`modelProvenBy`, truncation) → return text or `null`.

- The scratch-cwd machinery dies (no subprocess, no cwd).
- `DISALLOWED_TOOLS` argv machinery dies (daemon is toolless by contract).
- Timeout: `opts.timeoutMs` maps to the daemon call timeout.
- The injectable `spawnFn` test seam becomes an injectable
  `{ ensure, call, close }` deps object (a4-review's exact test pattern).

## 4. Seat 2 — proposer/promoter/curator (`runClaudeCodeTaskAgent`)

The restructure. Today: detached `claude -p` agent child wanders the repo with
tools and writes staged artifacts itself. New shape — **harness owns all I/O,
LLM sees text only**:

1. **Context assembler** (deterministic TS, runs in the worker): reads what
   the old prompt told the agent to go read — active playbook, scores ledger,
   staging-system instructions, rejected ledger (verdict-summary-only, per the
   F2 ruling) — and builds ONE prompt under an explicit size budget. The
   assembled prompt is persisted next to the staged artifact as a provenance
   record: we know exactly what evidence the proposer saw.
2. **One `daemonCall`** with our proposer system prompt. Reply contract:
   structured JSON (the ops.json/system.md payload + rationale), parsed and
   schema-validated by the harness. Invalid JSON → retry once with a repair
   nudge, then fail the cycle (lock expiry reclaims it; existing behavior for
   a child that never produced an artifact).
3. **Stager**: the harness writes the staged artifact files
   (`ops.json`/`system.md`) into the staging dir itself.

**Process shape preserved:** CC hook processes are short-lived, so the seat
still spawns a **detached bun worker** (our script under the repo, run with
`bun`) instead of a detached `claude -p`. The worker does assemble → call →
validate → stage, then exits. Everything downstream is untouched:
`writeProposerLock` lock files, `applyPendingArtifacts` apply-on-next-event,
`applyStagedArtifact`, staging paths, descriptor shape, stale-lock expiry.
`runClaudeCodeTaskAgent` keeps its signature and null-contract; only the argv
it spawns changes (bun worker + a JSON args file, not `claude -p`).

What dies with the old child: repo cwd exposure, hook inheritance, CLAUDE.md
injection, plugin surface, `PROPOSER_ALLOWED_TOOLS`, `MH_CHILD_ENV` sentinel
(no CC child to guard against recursion), `--session-id` plumbing (worker
generates its own artifact/log id).

## 5. Instrumentation & process discipline

- **Boundary timestamps:** proposer-environment change AND judge-transport
  change each stamp a boundary ts in the adoption ledger. The first crank
  after migration stamps a fresh boundary. Pre/post proposal distributions
  are not comparable across it.
- **Provenance:** each proposer cycle persists {assembled prompt, model,
  daemon outcome metadata} alongside the staged artifact.
- **7b gate + committed review artifact** before merge; explicit go before
  merge and before any spend (first post-migration crank is spend).

## 6. Testing

- Judge: existing `runTextAgent` tests re-targeted at the `{ ensure, call,
  close }` seam (fake daemon deps, no real WebSocket) — a4-review's test
  pattern. Contract cases: happy path, non-anthropic model skip, timeout,
  daemon-unreachable → null, truncation.
- Proposer: (a) assembler unit tests — given store fixtures, assert exact
  assembled prompt (golden); (b) worker integration with fake daemon deps —
  reply JSON → staged files byte-asserted; invalid reply → retry → cycle
  failure; (c) lock/apply machinery untouched, existing tests must stay green
  unmodified — that is the no-regression proof for the downstream half.
- Suites serial (standing rule).

## 7. Non-goals

- No daemon (cc-api-daemon) code or contract changes; validator untouched.
- No TB2 bench driver or p2 probe changes; no re-baseline.
- No gauge-seat changes (already migrated in N5).
- No npm publish of cc-api-daemon (git-pin stays; dependency surface
  unchanged at `33f74db`).
- No opencode-host proposer changes beyond what the shared `triggerPropose`
  refactor forces (the opencode inline-wait path keeps its behavior).
