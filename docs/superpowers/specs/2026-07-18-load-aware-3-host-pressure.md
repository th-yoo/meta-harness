# Load-aware scheduler increment #3 — host-pressure launch gate (Signal-A-only)

Status: SHIPPED 2026-07-18 (feat/loadaware-3 — sensor + transient pauseGate + --host-pressure observe|on, dark by default; live-smoked: real-spike pause/resume cycle PASS). Scope TRIMMED 2026-07-18 (user decision: solo-dev lightweight — see
"Explicitly deferred" for what was cut and why). Prereqs shipped: #1 capture+memorize
(`e113f43`), #2 measured packing + cap raise + OOM retry (`dca27be`), `--min-agent-timeout`
floor (`248fe8f`+`d22ecb0`).

## Problem — demand is measured, supply is assumed

The packer sizes tasks by measured demand (`avgCpu`/`peakRssMb`) and the time envelope is
host-generous (1h floor). But the budgets it packs INTO (`--cpu-budget`/`--mem-budget`) are
static operator inputs describing the podman VM — nothing senses the actual machine.

Live evidence (2026-07-18, MacBook 6c/12t 16GB, VM 4c/8GiB): measured packing reached width-3
(0.86+0.88+2.0 = 3.74 of cpu-budget 4) — correct vs the VM budget — and drove the HOST to
loadavg 149 with 19/21.5 GB swap used (two browsers + VM reservation). The user killed the run
to get the laptop back. The one real, recurring failure mode this increment must fix: **the
bench must not melt the machine the developer is using.**

## Design — one sensor, one gate, the existing seam

### Actuator: `canLaunch` — width by attrition, never preemption
`schedule()` already accepts a `canLaunch: () => boolean` guard (built for the oauth freshness
gate): while false, no NEW task launches; in-flight tasks finish naturally; canonical order
preserved. Compose:

```
canLaunch = freshnessGate() && !hostPressure()
```

No scheduler surgery, no task killing, no mid-flight cap changes. Concurrency-only change →
D5 verdict-equivalence holds → **NOT a budget-identity change; no re-baseline.**

### Sensor — host pressure, sampled every POLL_SEC (default 20s), cached per tick
Sample the HOST (not the VM; on WSL the "host" IS the Linux env; on macOS it's the Mac the
applehv VM squeezes):

- **CPU**: 1-min loadavg ÷ host logical cores. darwin `sysctl -n vm.loadavg` + `hw.ncpu`;
  linux `/proc/loadavg` + nproc.
- **Memory**: darwin `memory_pressure -Q` free-percentage (can be ~100ms — cache per tick);
  linux PSI `/proc/pressure/memory` some avg10, fallback MemAvailable%. Prior art: PSI/oomd
  act on SUSTAINED pressure (avg10), never instants.
- Pressure = worst-of, with hysteresis: enter at HI, exit at LO (defaults: load/core HI 2.0 /
  LO 1.2; mem free% HI <10 / LO >20; PSI some avg10 HI 25 / LO 10). Flap guard: min
  2×POLL_SEC in each state.
- **Fail-safe**: any sensing failure = "no pressure" (a broken sensor never blocks the bench;
  log once).

### Flags / rollout (house style: dark ship, then flip)
- `--host-pressure observe|on` on the `run`/`ab` parallel paths, default OFF (absent =
  byte-identical). `observe` logs pressure state changes without gating — run the first real
  sweep in observe mode to calibrate thresholds, then flip to `on`.
- Log one line per state change:
  `  [pressure] paused launches (load/core 2.4, mem 8% free)` / `  [pressure] resumed (...)`.
- Constants in code, no threshold flags — knobs only if observe-mode data demands them.

## Explicitly deferred (trimmed 2026-07-18 — solo-dev scale, revisit only on evidence)
- **Signal B (wall-clock lag** — in-flight elapsed vs profile `avgWall`): on a single box,
  contention IS host load; Signal A subsumes it. Revisit only if pressure-gating proves
  insufficient (e.g. VM-internal steal invisible to host sensors).
- **Live admission / reservation-table accounting** (run-one → monitor → admit-while-headroom;
  Borg/Trimaran-style): correct design, real scheduler surgery; its payoff over warmed
  profiles ≈ one cold sweep per host, paid once. Profiles already self-warm and persist.
- Metrics services / percentile recommenders / vertical autoscaling (Trimaran load-watcher,
  Autopilot): fleet-scale machinery; the 30s ops sampler + profile store cover this scale.
- Killing/preempting in-flight tasks; mid-flight cgroup changes; CPU-timeout escalation
  (1h floor covers it); auto-derived floors (user decided flat 1h); host-class stamping of
  SCORE sessions (separate follow-up — cross-host score mixing, noted 2026-07-18);
  user-interactivity detection (pressure approximates it).

Prior art validating the shape (researched 2026-07-18): Borg reservations-from-measured-usage
(EuroSys'15), Autopilot moving-window limits (EuroSys'20), Trimaran TargetLoadPacking
(pack-to-target-utilization on live metrics), PSI/oomd sustained-pressure backoff. Their
converged refinements — peak/percentile reservations, target-utilization headroom, sustained
triggers, OOM events as canary — are already reflected in #2's constants and this gate.

## Tests (sketch)
Pure: pressure-score from fake sensor readings (hysteresis transitions both directions, flap
guard, sensor-failure = no pressure); parser units per platform against captured fixture
strings (darwin sysctl/memory_pressure output; linux /proc/loadavg + PSI lines). Integration:
scheduler with injected pressure flips — launches pause/resume, canonical order preserved,
in-flight unaffected (reuse the freshness-gate canLaunch test patterns); observe mode logs but
never gates.
