# Review artifact — cas-reset-port (CAS state persistence + reset-retry into cc-gate-plugin, 0.4.5)

reviewed-range: 342b9eb45c37c3375c29605aa1f75eafd50da1e9..579fd0fe214fb6a7a88b15b46e0018189ee966e8
reviewer: fresh-context-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

Ports kkamak 0.6.0's compare-and-swap state persistence + reset-retry
(`~/z2/kkamak/src/runtime/file-state-store.ts`, `src/kernel/gate.ts:176`
`resetWithRetry`) into cc-gate-plugin, whose `state.ts` `save()` was a blind
atomic write under documented last-writer-wins doctrine. Same Claude Code hook
concurrency runs on both products; a lost race in cc-gate was a stale
whole-state overwrite — strictly worse than kkamak's pre-fix symptom
(known-issue #8: "first failing check exhausts with zero blocks issued").

**What ships.** `state.ts save(id, s, expectedUpdatedAt)` re-reads the on-disk
`updatedAt` and refuses a stale write (`StaleWriteError`); stamps a monotonic
`max(now, current+1)`; delete-on-initial runs under the same lock + CAS with
EPERM now propagated (the empty-catch swallow that contradicted its own comment
is removed); ported `withLock`/`reclaimIfStale`/pid-liveness verbatim; a NEW
non-blocking `tryLock` serves `sweep()` only (`withLock`'s
spin-then-run-unlocked fall-through is safe for `commit()` — CAS is a second
guard — but fatal for `sweep`'s `rmSync`, which has none); `saveResetWithRetry`
(one retry against fresh state, never throws); `mkdirSync` hoisted before lock
acquisition. `hook-cli.ts` routes all three hook sites through one three-way
`dispatchSave` (`next===prev` skip / `isInitialState` reset-retry /
CAS-save-with-fail-open); `sweep()` moves to an unconditional call after
dispatch and before the terminal `emit()` (which is `Promise<never>`).
`StateStore.save` gains `expectedUpdatedAt` (types.ts). Version 0.4.4 → 0.4.5
in BOTH manifests (packaging parity test).

**Doctrine change (README, last-writer-wins bullet replaced).** A prompt
preempting mid-check now WINS: a Stop block that loses its CAS fails open
(exactly as on ENOSPC) instead of clobbering the reset. Pass-through events
(unarmed Stop, no-op Prompt) no longer re-stamp `updatedAt`, so a session idle
7+ days without a clean Stop is swept — one unmeasured cycle, self-heals on the
next edit (kkamak parity).

**Binding constraints, all verified by the reviewer against file contents.**
`store.save()` is called nowhere in hook-cli outside `dispatchSave`
(grep-confirmed); the reset-vs-progress classification was traced against every
core handler return site and against kkamak's own `persist()`-vs-`resetWithRetry()`
per-call-site choice, including the config-vanished branch
(`{...INITIAL_STATE, edited: state.edited}`) which is `isInitialState===false`
only when `edited` is true and so correctly lands in the non-reset CAS arm,
matching kkamak's `gate.ts:296` plain persist; `tryLock` is sweep-only with a
`finally` release on every locked path and no leak on the skip path; sweep
re-checks staleness INSIDE the held lock and never matches `.lock`/`.last-swept`
(only `*.json`); the sweep relocation is unconditional (fires on the no-save
pass-through arm — pinned by the "unarmed Stop still sweeps a stale FOREIGN
file" CLI test) and strictly before `emit()`; the sentinel/monotonic
interaction (absent and post-delete both read `updatedAt:0`; first-save and
post-reset-save both present `0`) has no coherence hole.

**Review lineage.** Design reviewed to FLAWLESS over 7 code-architect rounds
(ledger in `~/.claude/plans/plan-for-a-misty-flurry.md`; headline catches: Stop
pass-through retry-misroute, `withLock` fall-through fatal to sweep → the
`tryLock` primitive, sweep-after-emit dead code, mkdir-before-lock ENOENT
degrade). Implementation then fresh-context reviewed: **0 findings ≥80
confidence**. One sub-threshold, explicitly-not-a-finding note: the two T6 CLI
lost-race tests both end on a reset delete, so their final `existsSync===false`
assertion is not CAS-discriminating alone — but this mirrors the accepted
upstream pattern the tests port (`~/z2/kkamak/test/gate.test.ts:563,588`), and
hard CAS-discriminating coverage exists at the store level
(`test/state.test.ts` concurrent-write + stale-delete both assert
`toThrow(StaleWriteError)` and that the loser's data does not survive).

**Test evidence.** Full suite 1051 pass / 0 fail across 58 files (ACP_GATE_FAST,
serial). Changed-file subset (state + cli) 62 pass / 0 fail. `tsc --noEmit`
clean; `grep last-writer README test/ src/` empty; every `store.save` site
carries an expected arg; both manifests 0.4.5.

**Not deployed.** Merge to main and km-refresh to 0.4.5 remain separately gated
(0.4.4 currently deployed). Merging ≠ deploying.
