# Review artifact — p2-container-auth-fix (a1 burned as agent_no_output)

reviewed-range: 1bc9ac3889d6f1a2c1511afcca28a6a167183849..05e3d1deba122191c35bbaedf1f7e43e346427ba
reviewer: fresh-context-opus
fresh-context: true
verdict: approved
findings-count: 2 Important (1 fixed in 05e3d1d, 1 recorded host-conditional) + 3 Minor (1 fixed, 2 recorded)

## The incident (2026-08-09, first live P2 launch)

The first-ever live P2 bench launch burned the whole a1 arm — 28 container
executions, all `agent_no_output`, turns=0, 0/14 pass — and was killed early
in a3. Diagnosed live with a manual container recreation of the exact bench
lifecycle (`create mounts:[] env:{}` → `start` → `exec timeout … claude -p …
--dangerously-skip-permissions`):

    --dangerously-skip-permissions cannot be used with root/sudo privileges
    for security reasons

rc=1, message on STDERR only, stdout EMPTY. `classifyAttempt`
(drivers/claude-code.ts) reads stdout only: empty → not auth, not transient →
"done" → turns=0 → `agent_no_output`, single attempt, no retry, no loud
failure. Token spend was zero (the CLI never reached the API); the cost was
~35 container executions and the run.

Root cause: `runOneP2Attempt` created containers with `mounts: []` +
`env: apiKeyEnv()`, dropping all three things the driver's `prepareAuth()`
(prepareClaudeCodeAuth) provides — the oauth credential mount, the onboarding
`/root/.claude.json`, and `IS_SANDBOX=1` (which is what legalizes
`--dangerously-skip-permissions` as root). `runAgent`'s own header says it
assumes creds are already in the container "see cmd-run.ts for the mounts";
cmd-p2 mirrored cmd-run's create shape but not its auth lifecycle. Nothing
test-level could catch it: every suite fakes execFn, and the READINESS
checklist never ran a live container attempt.

## The fix (`8f7ed87` + follow-ups `05e3d1d`)

Mirrors `cmd-run.ts` `runTaskOnce` exactly: new `prepareAuthFn` param
(default `() => driver.prepareAuth()`), called inside the bring-up try — a
missing-credential BenchError = `setup_failed` before any container work;
`mounts: [...auth.mounts]`; `env: {...apiKeyEnv(), ...(auth.env ?? {})}`
(auth wins on collision, pinned by test); `auth?.cleanup()` in the outer
finally with `podman rm` guarded in its OWN try/finally (reviewer finding:
a Bun.spawn throw in rm must never skip the credential shred —
cmd-run.ts:380-389's own documented hazard).

Reviewer verified cleanup runs exactly once on every exit route, no test or
prod path reaches the real keychain unintentionally (all test callers inject
fake drivers; `cmdP2` resolves against the passed driver), and all new tests
fail on revert.

**Validated live post-fix:** one real a1 attempt (extract-elf, k=1, --go 1):
`turns=27, compliant=true` — the agent actually worked. Validation results
file deleted; the garbage a1/a3 results files were deleted (they sat at the
exact paths a future `p2-tally.ts` reads — tally does not die on missing or
zero-datum files, it writes an all-zero verdict).

## Recorded, not fixed here

- **Linux-host env-fidelity hole (Important, host-conditional):**
  `prepareClaudeCodeAuth`'s linux branch mounts the operator's REAL
  `~/.claude` rw into the container — global CLAUDE.md, settings/hooks, and
  memory (which names P2) become visible to every arm. Identical across
  arms (no A/B bias) and darwin (this host) is unaffected (temp dir with
  credentials only) — but a WSL/linux-host P2 run needs a recorded decision
  first. Inherited from cmd-run.ts, newly reachable in p2.
- **classifyAttempt ignores stderr:** rc≠0 + empty stdout still classifies
  "done" — the exact shape that made this burn silent. Cheap hardening
  candidate: `rc !== 0 && stdout.trim() === ""` → transient (retry + loud
  log) or a distinct `agent_hard_fail` label.
- **a4 re-pass same shape:** `rePassResult.rc` ignored, classifyAttempt
  never called on the re-pass — an rc≠0/empty re-pass is indistinguishable
  from "ran and did nothing".
- mkdir exec rc ignored (masked by staging failing right after).

Verified: p2-cmd.test.ts 46 pass / 0 fail; full opencode-plugin suite
1890 pass / 1 skip / 0 fail; tsc clean; live single-attempt validation above.
