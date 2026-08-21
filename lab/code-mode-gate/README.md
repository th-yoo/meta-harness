# lab/code-mode-gate — composed runtime (worker-isolated, verifier-agnostic)

Hardened form of `poc/code-mode-gate/` (frozen reference; read its README
first). Same composition — code-mode batching + zero-spend gate as the only
effect path — now with a real thread boundary and a pluggable verifier.

## What changed vs the PoC

| | PoC | this library |
|---|---|---|
| Guest execution | in-process `new Function` | Bun Worker, structured-clone RPC, zero host references |
| Failure handling | none | watchdog timeout, output cap, pending-call cap — enumerated codes |
| Verifier | hardwired merge gate | `Verifier<C, S>` plug-in; two bundled: real merge-fit + source-recount |
| Guest API | sync | async (`await api.tools.x()`, `await api.checkAndCommit(c)`) |
| Agnosticism | n/a | enforced by executable grep guard (`agnostic.test.ts`) |

## What is preserved (pinned by `parity.test.ts` and `runtime.test.ts`)

Correctness parity, 5-trips-vs-1, >3x token ratio at 4k context, rejection
absorbed in-turn, no guest commit capability, fail-closed commit.

## Still deliberately unclaimed

- **Actuation** — guests here are scripted; whether a real model consumes
  steering in-program is the un-bought number (prose prior 1/8). Relatedly,
  `localRetries` measures TEMPORAL co-occurrence (a rejection followed by an
  acceptance in the same turn), not proven causal steering use.
- **Security** — thread boundary + watchdog, NOT a sandbox. No memory limit.
  Guests run in the worker's GLOBAL scope: a guest can reach `postMessage`
  and forge raw protocol messages, bypassing the `api.tools` surface (the
  runtime's unknown-tool guard exists for exactly that). Trusted-guest only.
  Hostile-guest reference: OpenClaw QuickJS-WASI (`src/agents/code-mode-*`).
- **Snapshots/resume, TS guests, tool catalogs** — YAGNI until an experiment
  needs them.

Guest authors: `steering` is optional on `Verdict` — only steering-bearing
rejections carry it; use `v.steering?.summary`.

## Run

    bun test lab/code-mode-gate/
