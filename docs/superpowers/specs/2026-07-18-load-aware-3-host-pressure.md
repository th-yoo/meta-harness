# Load-aware scheduler increment #3 — host-pressure + wall-clock back-pressure

Status: SPEC (not started). Prereqs shipped: #1 capture+memorize (`e113f43`), #2 measured
packing + cap raise + OOM retry (`dca27be`), `--min-agent-timeout` floor (`248fe8f`+`d22ecb0`).

## Problem — demand is measured, supply is assumed

The packer now sizes tasks by measured demand (`avgCpu`/`peakRssMb`) and the time envelope is
host-generous (1h floor). But the budgets it packs INTO (`--cpu-budget`/`--mem-budget`) are
static operator inputs describing the podman VM — nothing senses the actual machine.

Live evidence (2026-07-18, MacBook 6c/12t 16GB, VM 4c/8GiB):
- Measured packing reached width-3 (0.86+0.88+2.0 = 3.74 of cpu-budget 4) — correct vs the VM
  budget — and drove the HOST to loadavg 149 with 19/21.5 GB swap used (two browsers + VM
  reservation). The user had to kill the run to get the laptop back.
- Same host, earlier: tune-mjcf 0-for-4 timeouts at TB2 budgets (fixed by the floor), i.e. this
  host runs ~3× slower than the 8-core WSL box — a fact no config knew.

Two missing feedback loops: (A) the host's live pressure, (B) whether in-flight tasks are
running slower than their own history predicts (contention seen from inside).

## Design

### Actuator: the existing `canLaunch` seam — width by attrition, never preemption
`schedule()` already accepts a `canLaunch: () => boolean` guard (built for the oauth freshness
gate): while false, no NEW task launches; in-flight tasks finish naturally; canonical order is
preserved on resume. Compose pressure into that seam:

```
canLaunch = freshnessGate() && !underPressure()
```

No scheduler surgery, no task killing, no mid-flight cap changes. Width shrinks by attrition
and recovers when pressure clears. D5 verdict-equivalence holds: concurrency changes only —
per-task envelopes (timeouts, caps) untouched → **NOT a budget-identity change; no re-baseline.**

### Signal A — host pressure (supply side)
Sample the HOST (not the VM) every POLL_SEC (default 20s) in the scheduler loop:

- **CPU**: 1-min loadavg ÷ host logical cores. darwin: `sysctl -n vm.loadavg` + `hw.ncpu`;
  linux/WSL: `/proc/loadavg` + nproc. (On WSL the "host" IS the Linux env; on macOS podman the
  host is the Mac — the VM squeezes it from outside the containers' view.)
- **Memory**: darwin: `memory_pressure -Q` free-percentage (or `vm.swapusage` delta as a
  fallback — swap GROWTH during the run, not absolute use, since a long-lived host may sit on
  old swap); linux: PSI `/proc/pressure/memory` some avg10, fallback MemAvailable %.
- Pressure score = worst of the two, with hysteresis: enter at HI, exit at LO
  (defaults: cpu load/core HI 2.0 / LO 1.2; mem free% HI <10 / LO >20; PSI some avg10 HI 25 /
  LO 10). Flap guard: min 2×POLL_SEC in each state.
- All reads best-effort — any sensing failure = "no pressure" (never blocks the bench on a
  broken sensor; log once).

### Signal B — wall-clock lag (contention seen from inside)
The profile store already records `wall` per sample; add `avgWall = median(wall)` alongside
`avgCpu` (window 5, same file — backfillable from existing samples on next write).
- The scheduler knows each in-flight task's launch time. Every POLL_SEC compute per in-flight
  task with a trustworthy profile (n ≥ PACK_MIN_SAMPLES): `lag = elapsed / avgWall`.
- Contention signal: median lag across ≥2 profiled in-flight tasks > LAG_HI (default 1.6) →
  underPressure() true until median < LAG_LO (1.2) or the population drops below 2.
- This catches what host sensing can't see from a different failure direction: the VM itself
  contended (vCPU steal), disk-bound verifiers, thermal throttling.

### Flags / rollout (house style: dark ship, then flip)
- `--host-pressure` opt-in flag on `run`/`ab` parallel paths (later default-on once soaked).
  `--no-host-pressure` reserved for the flip. Constants overridable only in code for now — no
  threshold flags until real runs show which knobs matter.
- Log one line on each state change: `  [pressure] paused launches (load/core 2.4, mem 8% free)`
  / `  [pressure] resumed (load/core 1.1)`. The resource sampler (ops-side) already exists.

### Explicitly out of scope (unchanged decisions)
- Killing/preempting in-flight tasks; mid-flight cgroup cap changes.
- CPU-timeout escalation (deferred at #2; the 1h floor covers it).
- Auto-derived timeout floors from host speed (user decided flat 1h).
- Host-class stamping of SCORE sessions (separate follow-up — noted 2026-07-18, cross-host
  score mixing).
- User-interactivity detection ("pause while I'm typing") — tempting on the MacBook, but
  pressure sensing approximates it (interactive use raises load); revisit only if real runs
  show it's insufficient.

## Open questions (settle at build time)
1. Sampling exec on darwin: `memory_pressure` can be slow (~100ms) — cache per POLL_SEC tick;
   acceptable?
2. Should Signal B's `avgWall` update feed back into ETA-style scheduling later (pack by
   predicted wall)? Out of scope here; the field is additive either way.
3. Threshold defaults above are educated guesses from the 2026-07-18 episode — first soak run
   should log pressure scores WITHOUT gating (observe-only mode?) to calibrate. Lean: yes,
   `--host-pressure=observe|on`.

## Tests (sketch)
Pure: pressure-score computation from fake sensor readings (hysteresis transitions, flap
guard, sensor-failure = no pressure); lag computation from fake profiles + launch times.
Integration: scheduler with injected `underPressure` flips — launches pause/resume, canonical
order preserved, in-flight unaffected (reuse the canLaunch test patterns from the freshness
gate). Sensor parsers per-platform against captured fixture strings (darwin sysctl/
memory_pressure output, linux /proc/loadavg + PSI lines).
