# PoC: code-mode batching + zero-spend effect gate

Zero-model-spend proof of the composition claim (2026-08-21): OpenClaw-style
code-mode batching kills the round-trip cost; kkamak-style deterministic
verification kills the wrongness cost; composing them also absorbs gate
rejections **inside the turn**, which is the mechanism the raman thrash class
lacks. Each side's cost problem is the other side's solved problem.

## What it demonstrates (measured by `bun test poc/code-mode-gate/`)

1. **Real verifier, not a mock** — the gate imports kkamak's shipped
   `mergeCheck`/`fitAffine` (`opencode-plugin/src/bench/reval-fit.ts`, ships
   OFF). Honest claim accepted; index-shifted claim rejected; partial coverage
   and short claims fail closed.
2. **Steering on rejection** — the gate returns per-anchor residuals
   (worst-first), computed from the fit the verifier already ran. No new
   authority, no answer key: residuals are derivable by any party.
3. **Correctness parity** — both arms commit the *identical*,
   verifier-accepted claim. The composition changes cost, never the answer.
4. **Cost arithmetic** — identical work (3 tool calls, 2 gate checks, 1
   rejection): classic loop = 5 round trips, ~20k input tokens; composed = 1
   round trip, ~4.1k tokens (**4.9× at a deliberately conservative 4k-token
   context**; the ratio grows linearly with context size and per-task tool
   calls).
5. **Anti-thrash** — the rejection is consumed in-turn in the composed arm
   (`localRetries=1`); in the classic arm the same rejection costs a whole
   round trip.
6. **Capability discipline** — the guest API carries **no commit capability**;
   the runtime commits internally iff the gate passed (authorization by object
   capability, not by name — the OpenClaw WeakSet lesson). A guest probing
   `api.commit` finds nothing; a never-passing program commits nothing.

## What it deliberately does NOT claim

- **Actuation.** The mock model's correction is SCRIPTED. Whether a *real*
  model consumes steering in-program is the un-bought number (prose-actuation
  prior: 1/8, v13 0/4). This PoC prices the architecture, not the model.
- **Sandboxing.** Guests run via `new Function` and are trusted. Reference
  implementation for hostile guests: OpenClaw's QuickJS-WASI worker
  (`openclaw/openclaw` `src/agents/code-mode-*`, 60 files).
- **Task generality.** One fixture, one claim shape (the affine
  unit-convention family the real verifier covers). The 1/99 addressable-class
  finding applies to the VERIFIER unchanged; the batching+gating shape is
  verifier-agnostic.
- **Token realism.** `approxTokens = context × trips + program/4` is a floor
  model; real contexts are larger, which favors the composed arm further.

## Files

- `verifier.ts` — real-verifier adapter + steering
- `runtime.ts` — mini code-mode runtime: metered turns, staged commit, capability discipline
- `scenario.ts` — fixture, hypotheses, cost constants
- `arms.ts` — classic-loop arm vs composed arm (identical scripted knowledge)
- `poc.test.ts` — 9 tests: verifier reality, parity, cost, anti-thrash, capability
- `run.ts` — prints the cost table (`bun poc/code-mode-gate/run.ts`)

## Standing relation to the repo

Lab artifact (meta-harness), zero model spend, additive-only. Not wired into
the bench, the plugin, or kkamak production; promoting any of it is its own go
and would meet the usual oracle/bad-set bar. The composed shape corresponds to
loop-1's "BINDING actuator" conclusion and the Anthropic orchestrator-workers
rung with harness-owned verification.
