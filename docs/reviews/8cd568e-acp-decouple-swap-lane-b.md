# Review artifact — acp-decouple-swap (Lane B: gate blind spot, runOnce net, cc-api-daemon pin)

reviewed-range: d35cc1579a0fbc76f5c6268c808b90cdd44a83d0..8cd568e1513d02d4395b9c635b8f6f6c32e21256
reviewer: fresh-context-sonnet-code-reviewer
fresh-context: true
verdict: approved
findings-count: 1

Lane B of `~/.claude/plans/steady-coalescing-aho.md` (decouple `@th-yoo/cc-api-daemon`
from kkamak, then move meta-harness consumers onto it). Lane A — the upstream
decoupling itself — ran in a separate session against `~/z2/cc-api-daemon` and
shipped as that repo's v0.2.0 @ `469456b`; it is not part of this range.

Three tasks, each with a fresh-context per-task review by a subagent that did not
write the code.

**B7 — `5d0e9be` — gate blind spot. Approved, 0 Critical/Important.**
The tier-1 `full` command never ran `opencode-plugin`, and `opencode` is absent from
`FALLBACK_SUITES`, so a cc-gate-plugin-only commit that broke opencode's suite was
invisible to BOTH tiers indefinitely. That matters now because the pin below makes the
two packages share a dependency. Fix adds `opencode-plugin` to the tier-1 chain;
`FALLBACK_SUITES` deliberately unchanged (~45s measured tax per no-baseline tier-0
Stop, exposure bounded by tier-1's background full-sync, reasoning recorded inline).
`realCommands()` is now exported and `main()` guarded by `import.meta.main` so the new
regression test asserts the REAL command table rather than a copied string. The
reviewer traced both the direct and `--bg` self-re-exec invocation paths to confirm
the guard cannot wedge the Stop hook. Verified: km-crank 372 pass / 0 fail;
doc-check 0 violations.

**B3 — `c465b9d`, fix `ff74112` — runOnce regression net. Approved after 1 fix round.**
`runner.ts` exported `runOnce` plus a `RunnerDeps` DI seam that existed precisely to
be injectable, yet NO test in the repo ever called it — the outcome-to-sensor-line
mapping was entirely unverified, immediately before that file is repointed at a
different ACP client. New `test/review-sensor-runner.test.ts` pins: `ok` -> PASS line
with fields, `no-call` -> SKIP `warm-lane-busy`, `call-consumed` -> the SAME reason
(indistinguishable in the emitted line) with `deps.close` never called. Reviewer
confirmed all three are real regression nets, not loose existence checks.
THE ONE FINDING (Important, fix round 1, ADDRESSED): a comment claimed the unclosed
`call-consumed` session was "Documented behavior" citing runner.ts:287-296. It is not
— that passage only discusses the `kind === "ok"` path, and its 900s-reap mention is
about a close() transport failure. The leak is a structural consequence (the
close-not-release `finally` is nested inside the `kind === "ok"` try), not a stated
decision. Left as "documented", a future reader during the swap would take it at face
value and never revisit it. Comment corrected; the assertion was verified byte-identical.
Verified: 1118 pass / 0 fail, plus a credential-scrubbed run of the new file.

**B1+B2 — `8cd568e` — pin the package into both consumers. Approved, 0 Critical/Important.**
`@th-yoo/cc-api-daemon` added to `dependencies` in BOTH `cc-gate-plugin` and
`opencode-plugin`, pinned to the exact 40-char SHA `469456b` (git pin, not `file:` —
this repo's CLAUDE.md makes cross-host transfer git-only, so a relative path silently
breaks on the other host). New `test/acp-package-surface.test.ts` locks the runtime
surface via the public entry only. `send-prompt.ts`'s type-only `WarmIsolation` import
repointed, comment strengthened: the barrel value-exports `ApiSession`/`listModels`,
whose chain top-level-imports `@anthropic-ai/sdk`, so a value import there would widen
the runtime graph eagerly.

Two corrections the controller made before/after dispatch, recorded because both would
have shipped defects:
- The plan's own B1 draft told the surface test to assert `envFingerprint`,
  `routeBackend` and `ACP_BUDGET`. None are exported at this pin — they belong to A6,
  which is deliberately deferred. Caught by reading the pinned `src/index.ts` before
  briefing; the test locks only what exists.
- The reviewer flagged the `send-prompt.ts` comment's upstream import-chain claim as
  unverifiable from the diff. Controller verified it directly against the installed
  package: `index.ts:32` -> `api-session.ts:9` -> `call.ts:20` -> `client.ts:17`
  `import Anthropic from "@anthropic-ai/sdk"`. Accurate.

Verified: cc-gate-plugin tsc clean + 1121 pass / 0 fail; opencode-plugin tsc clean +
1863 pass / 0 fail (1 pre-existing skip); doc-check 0 violations;
`git diff cc-gate-plugin/src/acp/` EMPTY.

**Load-bearing negative result.** B1's typecheck was the plan's designated go/no-go:
the pinned package ships raw `.ts` and compiles under `"types": ["bun"]` only, while
both consumers add `@types/node`, and `skipLibCheck` does not suppress `.ts` errors.
Predicted collision (`MessageEvent`/`WebSocket` declared by both type packages) did NOT
materialize — clean in both real consumers, not merely in a scratch probe.

**Scope deliberately NOT in this range**, held pending further review: A6 (`./testing`
subpath export + helper extraction), B4 (daemonWorstCaseMs floor guard), B5 (gauge
`anthropic-cli-warm` + P2 `a4-review` + their two test ports), B6 (lane lock + sensor
`lane` field), B8 (live verification — real spend, needs a sized go), B9. The three
deferred consumers remain on the local `../acp/index.ts`, which stays byte-identical
and fully tested.

Minors recorded, none blocking: `realCommands()` in tests triggers incidental readdir
scans; `bun.lock` renders an abbreviated SHA in its resolution key while the pin field
carries the full 40 chars; `"configVersion": 0` is bun 1.3.11 lockfile behavior. A
pre-existing flake (`gate-check CLI`, hardcoded 5s subprocess window) fails only under
CPU contention and was confirmed unrelated on unmodified HEAD.
