# docs/ index — the durable map

- **[resume.md](resume.md) — START HERE on a new host/session** (how to continue the loop; personal memory doesn't transfer).

One entry per canonical doc so a fresh/cleared-context session can re-find the
design state. Git is the backstop; `~/.claude/.../memory/MEMORY.md` points here.

## Architecture & loops
- [evolution-loop.md](evolution-loop.md) — the components (store, layers, proposer, judge, gate).
- [improvement-loops.md](improvement-loops.md) — the PROCEDURAL view: how static (TB2 bench) & dynamic (runtime) improvement actually run, and how they compose.
- [loop-1-state.md](loop-1-state.md) — FIRST propose→ab run (#5) live state: baseline 0.381, 14-band split, account-global **v1** created (playbook preserved), next=`ab`. Cross-host continuation notes (account store is host-local — scp or re-run).
- [enhancement-roadmap.md](enhancement-roadmap.md) — what was built (dated status blocks).
- [explicitly-not-now.md](explicitly-not-now.md) — deferral register: every deliberate non-decision + its reopen trigger. Read before proposing "new" work.
- [python-elimination.md](python-elimination.md) — the runner.py→Bun cutover (complete).

## Memory / retrieval
- [memory-landscape.md](memory-landscape.md) — where meta-harness sits in the agent-memory literature (category, prior art, gap→paper), + how we keep memory under a bounded context window.

## Capabilities / strategy
- [capability-envelope.md](capability-envelope.md) — `discoverable = mutable ∩ benchmarked`: what the loop can/can't improve, the inner-loop gap map, and the reordered roadmap (search-with-verifier #1). Read before adding a deferral with an off-benchmark trigger.
- [external-practices-openclaw.md](external-practices-openclaw.md) — mined OpenClaw "vibe coding" best practices → mapped to our system (mostly validates it) + a seed-bullet corpus for the proposer (test what propose discovers before hand-seeding). We add the selection gate they lack.

## Fleet / squad (the multi-agent builder)
- [superpowers/specs/2026-07-13-fleet-squad-integration-design.md](superpowers/specs/2026-07-13-fleet-squad-integration-design.md) — **the design spec** (D1–D7 all decided): node grammar, SquadDef, flow state machine, escalation taxonomy, score routing, master boundary layer, repo boundary.
- [fleet-context.md](fleet-context.md) — the OpenClaw dev-fleet briefing (has a stale-pointer correction header).
- [fleet-integration-plan.md](fleet-integration-plan.md) — the original T0–T6 primitives plan.
- [fleet-integration.md](fleet-integration.md) — the recipe/how-to for driving the fleet.

## Implementation plans (docs/superpowers/plans/)
- [2026-07-13-fleet-squad-depth1-e2e.md](superpowers/plans/2026-07-13-fleet-squad-depth1-e2e.md) — the depth-1 squad E2E build (9 tasks, shipped).
- [2026-07-14-failure-retrieval.md](superpowers/plans/2026-07-14-failure-retrieval.md) — relevance-ranked proposer failure retrieval (shipped) + MCP increment-2 (deferred).

## Testing manuals
- [tier3-testing-manual.md](tier3-testing-manual.md) — the interactive full-loop manual test.
