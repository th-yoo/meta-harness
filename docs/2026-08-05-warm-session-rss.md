# WarmSession RSS measurement — sizing `KKAMAK_ACP_MAX_SESSIONS`

**Provenance:** transcribed from the acp-session-pool branch's host-local
`.superpowers/sdd/2026-08-04-acp-warm-daemon/rss-measurement-report.md`
(gitignored, does not travel — CLAUDE.md: "cross-host transfer is git-only").
This file is the durable copy; the `DEFAULT_MAX_SESSIONS` comment that cites
this path now lives in `@th-yoo/cc-api-daemon`'s `src/acp-pool.ts` (the
package is the sole implementation post-2026-08-09 src/acp retirement). The
path this section used to cite, `cc-gate-plugin/src/gauge/acp-pool.ts`, was
already wrong even pre-branch — the file actually lived at
`cc-gate-plugin/src/acp/acp-pool.ts`, retrievable at
`git show 2a5e873:cc-gate-plugin/src/acp/acp-pool.ts`; that whole directory
is gone now regardless, superseded by the package.

**Status:** measured, token-free, zero real model calls.
`KKAMAK_ACP_MAX_SESSIONS` had been an *asserted* 4 since it was first written
(no prior measurement of `WarmSession`'s RSS existed anywhere in the repo);
this was the first.

## Method

Host: WSL2 Linux box, `cc-gate-plugin/`.

`@anthropic-ai/claude-agent-sdk`'s `Query` does not expose the spawned CLI's
pid, so RSS was measured by **process-tree sweep**: snapshot the bun host
process's descendant pids (recursively, via `/proc/<pid>/task/*/children`,
unioned across every thread's own children file) before and after each
`WarmSession` is created, and sum `VmRSS` from `/proc/<pid>/status` across
whatever pids are new.

Verified independently with `pstree -p` on a held-open session: the bundled
CLI (`node_modules/@anthropic-ai/claude-agent-sdk-linux-x64/claude`) is a
**single multi-threaded process** — it does not fork a second node/bun
process (an initial hypothesis that turned out false on this host/build).
The tree-sweep method still works correctly regardless, since it makes no
assumption about tree depth.

Every request the spawned CLI makes is intercepted by `ANTHROPIC_BASE_URL`
pointing at a local `Bun.serve` stub — zero real model calls per run.
Script (retired with src/acp/ retirement; retrievable at pre-deletion SHA 2a5e873
via `git show 2a5e873:cc-gate-plugin/test/warm-session-rss-measure.ts`): was
`cc-gate-plugin/test/warm-session-rss-measure.ts`, run via `cd cc-gate-plugin && bun test/warm-session-rss-measure.ts`.
It measures, in order: (1) baseline (one session, warm + settled 2s), (2)
marginal (4 sessions opened sequentially, kept resident together), (3)
recycle effect (`/clear` ×2 on one held-open session), then closes
everything and verifies pid-scoped cleanup (SIGTERM then SIGKILL fallback,
never `pkill -f`). Ran twice for a variance check; no orphan processes left
either time.

## Headline numbers (two runs, same host)

**Baseline** — one warm session, settled: **~374–380 MB total**
(bun host process delta 43.5–46.1 MB for the SDK import + Query bookkeeping,
plus the CLI subprocess itself at 330.2–334.2 MB, the whole process as one
pid).

**Marginal** — 4 sessions opened sequentially, kept resident: session 1 pays
a one-time host-side ~44–90 MB overhead (lazy SDK import); every session
after that adds ≤1 MB to the host process. The whole marginal cost per
*additional* session is the CLI subprocess itself: **consistently
~300–365 MB, centering ~325–330 MB**, both runs. This is the number that
sizes a pool, not session 1's cost (which includes the one-time host
overhead).

**Recycle (`/clear`) effect** on one session's RSS across 2 recycles: reads
as flat (+0.9 MB then +0.9–1.3 MB), same pid across all three turns (no
respawn) — inside plausible allocator noise, not an obvious leak. n=1 per
run / 2 recycles per run: real, but a short trend; a longer soak (10–20
recycles) would firm this up further. Not done in this pass.

**Host memory** (from `/proc/meminfo`, WSL2 box, not idle — an active tmux
with a `podman system service`, editor, etc. running throughout):
`MemAvailable` ~14,497–14,559 MB before any session, ~14,359–14,469 MB
after all closed; `MemTotal` 24,610 MB.

## Cap sizing table

Floor for N resident sessions ≈ **90 MB (one-time host overhead) + N × 330 MB**
(conservative, higher end of the measured marginal-RSS range):

| N | floor (session RSS only) | headroom left (of ~14,500 MB `MemAvailable`) | floor as % of `MemAvailable` |
|---|---|---|---|
| 4 (shipped default) | ~1,410 MB | ~13,090 MB | ~9.7% |
| 8 | ~2,730 MB | ~11,770 MB | ~18.8% |
| 16 | ~5,370 MB | ~9,130 MB | ~37.0% |

## Recommendation and the ruling actually shipped

The measurement report's own recommendation was **cap = 8** (floors at
~2.7 GB, ~19% of this host's `MemAvailable`, still leaving headroom for
concurrent `term-bench2` podman task load on the same box). The controller's
actual ruling (2026-08-05, data-based, recorded in this branch's SDD
progress log) was: **`KKAMAK_ACP_MAX_SESSIONS` default STAYS 4** —
retrospectively justified by this measurement (1.4 GB ≈ 10% headroom,
matching the existing seat count) rather than raised to the recommended 8;
8 remains memory-permissible on this host class and is reachable via the
`KKAMAK_ACP_MAX_SESSIONS` env override without a code change. This is what
`@th-yoo/cc-api-daemon`'s `src/acp-pool.ts`'s `DEFAULT_MAX_SESSIONS = 4` and
its comment now reflect (formerly the in-repo `cc-gate-plugin/src/acp/acp-pool.ts`,
retired 2026-08-09 — see the provenance note at the top of this file).

## MacBook (`yoo-mac`) measurement — 2026-08-05, darwin

Ran per the shared-host caveat below: the WSL2 number does not travel, so
the cap for this host needed its own read. Host: Intel MacBook, macOS 15,
16 GB RAM (`hw.memsize`), not idle (Claude Code session + browser running).

**Script portability first:** the committed script was `/proc`-only and on
darwin every reader silently returned `0`/`[]` — a run would have reported
0 MB and looked like a measurement. Platform-branched in the same file
(this branch): `vmRssKb` → `ps -o rss=`, `directChildren` → `ps -axo
pid=,ppid=` scan (process-level parentage is all darwin exposes and all the
probe needs), `memAvailableKb` → `vm_stat` free+inactive pages
(approximation, informational lines only). Linux branch byte-unchanged.

**Headline numbers (one run):**

- **Baseline** — one warm session, settled: **~365 MB total** (host delta
  37.4 MB + CLI subprocess tree 327.5 MB). Unlike the linux build's single
  multi-threaded process, the darwin CLI shows a **3-pid subprocess tree**
  for the first session; later sessions added ~1 new pid each while still
  costing a full ~330 MB marginal — the tree-sweep method makes no
  shape assumptions, so the totals stay valid.
- **Marginal** — sessions 2–4 kept resident: **332.5 / 331.4 / 325.5 MB**
  per additional session — same ~325–335 MB band as WSL2. Host-process
  marginal ≤1.2 MB after session 1, same shape.
- **Recycle (`/clear`)** ×2 on one held session, same pids, no respawn:
  +1.9 MB then +1.9 MB — flat within the ~2 MB noise band, slightly above
  the WSL2 readings (+0.9–1.3 MB); same "short soak" caveat applies.
- **Host memory:** `vm_stat` free+inactive ≈ 6,067 MB before, ≈ 5,483 MB
  after all sessions closed; total RAM 16,384 MB. No orphan processes
  (the one "children remaining" pid at exit was gone on immediate re-check
  — transient teardown, pid-scoped cleanup held).

**Cap ruling for this host (2026-08-05): `KKAMAK_ACP_MAX_SESSIONS` stays
4.** 4 × 330 MB ≈ 1.3 GB ≈ 22% of this host's ~6 GB reclaimable — workable.
8 would floor at ~2.7 GB ≈ 45% of reclaimable on a 16 GB machine that also
runs the dev session itself — not taken. The WSL2 box's "8 is permissible"
line does NOT transfer here.

## Concerns / caveats

- **Shared-host caveat.** `MemAvailable` reflects this WSL2 box's state at
  measurement time, on a dev machine that also runs podman/VSCode/tmux
  sessions, not a dedicated daemon host. The recommendation is sized against
  *this host's* headroom; a different host (the MacBook mentioned in
  `CLAUDE.md`) needs its own `/proc/meminfo` (or macOS equivalent) read
  before trusting the same cap — the number here does not travel, only the
  method and the shipped default do.
- **Recycle soak is short.** 2 recycles per run is enough to say "does not
  obviously ratchet," not enough to rule out a slow leak over dozens of
  recycles in a long-lived daemon.
- **Marginal RSS has real run-to-run variance** (300–365 MB band; one
  transient 5-pid reading in run 2 that resolved to a normal ~330 MB delta,
  read as a momentary spawn/teardown race in the tree walk, not a second
  persistent process — confirmed by the `pstree` check showing exactly one
  CLI process per session). The 330 MB figure used for sizing is the
  conservative (higher) end of the observed range, not an average.
- **CPU/FD cost of N resident sessions is out of scope here** — this
  measures RSS only. A pool cap driven purely by memory headroom could
  still be too high on CPU or file-descriptor grounds; that needs its own
  measurement if it becomes the binding constraint.
