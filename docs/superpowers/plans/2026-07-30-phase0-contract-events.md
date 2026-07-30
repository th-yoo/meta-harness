# Phase 0: sensor-contract conformance + event groundwork (roadmap 2026-07-30)

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Parent spec: `docs/2026-07-30-enhancement-roadmap.md` Phase 0 (constraints F1/F2 bind — though Phase 0 touches neither mechanism paths nor the sensor stream).

**Goal:** make `~/z2/kkamak`'s sensor stream consumable by km-crank (today every kernel-emitted line is silently dropped), guard the contract against future drift on both sides, harden the duplicated REPOS list, and roll the gate into `~/z2/squad`.

## Ratified decisions (recorded here so tasks don't re-litigate)

- **D1 — kernel conformance scope: MINIMAL.** The kernel gains `sessionID` (rename from `sessionId`) and `marker: boolean` — the two fields km-crank's `scan.ts` requires. `pluginVersion`/`forced` porting is DEFERRED to the kkamak packaging milestone (both are optional fields; consumers tolerate absence by registered rule).
- **D2 — golden vectors are duplicated, test-enforced.** Canonical vector file `test/fixtures/sensor-contract.ndjson` lives in the kkamak repo (it is the standalone/publishable side); meta-harness embeds the identical lines in a km-crank contract test. Each file carries a header comment naming its counterpart path. Cross-repo byte-parity is enforced by an advisory check in the meta-harness test that reads `../kkamak/test/fixtures/sensor-contract.ndjson` **when present** and skips (with a printed notice, not a failure) when absent — repos must stay independently testable.
- **D3 — REPOS single-sourcing is test-enforced, not runtime.** `km-sensors-sync.sh` stays pure bash with its own list; a km-crank test greps the script and asserts list equality with `crank.ts`'s `REPOS`. (Runtime sourcing would make the sync script depend on bun for no operational gain.)

## Global constraints

- Roadmap F1: nothing under `cc-gate-plugin/src/core/` or `cc-gate-plugin/vendor/` may be touched (Phase 0 has no reason to).
- Commit convention: `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`; direct to main in each repo.
- Suites at start: kkamak 260 · km-crank 183 · cc-gate-plugin 385 · opencode-plugin 1748/1 · gate-plugin 26. Every task holds or exceeds.

### Task 1 (repo `~/z2/kkamak`): kernel contract fix + golden vectors

**Files:** `src/kernel/sensor.ts` (+ any emit-site/type touchpoints), `test/fixtures/sensor-contract.ndjson` (new), extend kernel sensor test file.
**Contracts:**
1. Emitted sensor lines carry `sessionID` (exact casing) and `marker` (boolean, the same semantics the installed plugin uses — find how the kernel tracks/should default it; if the kernel has no marker mechanism, emit `marker:false` with a doc comment naming the deferral).
2. `test/fixtures/sensor-contract.ndjson`: ≥4 canonical lines — one clean accept, one catch (block→fix), one exhausted, one skippedStop-shaped diagnostic — each a REAL shape the kernel emits, with header comment naming the meta-harness counterpart test.
3. Conformance test: kernel-emitted lines (from a driven fixture run, not hand-built objects) parse against the vector schema: required `ts,sessionID,check,accepted,gateExhausted,interrupted,rounds,durationMs,host,app,marker`; optional fields tolerated.
4. Dogfood-log entry appended: contract fix, D1 deferral note.
**Steps:** TDD → suite 260+ green → commit `fix(kernel): sensor contract conformance — sessionID + marker per frozen SensorLine; golden vectors (phase 0)`.

### Task 2 (repo `~/z2/meta-harness`): km-crank contract test

**Files:** `km-crank/test/sensor-contract.test.ts` (new).
**Contracts:**
1. Embedded copies of the same vector lines (byte-identical strings, header comment naming the kkamak counterpart file).
2. Test: `parseSensorLines`/scan-layer parser accepts every vector line (none dropped); the required-field rejection path is exercised with a deliberately broken line (`sessionId` casing — the drift class this guards).
3. Advisory parity check per D2: when `../kkamak/test/fixtures/sensor-contract.ndjson` exists, byte-compare; on mismatch FAIL with a message naming both files; when absent, skip with printed notice.
**Steps:** TDD → km-crank suite green → commit `test(km-crank): sensor-contract golden vectors + cross-repo parity guard (phase 0)`.

### Task 3 (repo `~/z2/meta-harness`): REPOS drift guard

**Files:** `km-crank/test/repos-parity.test.ts` (new) or extend an existing config test.
**Contracts:** test extracts the repo list from `scripts/km-sensors-sync.sh` (grep/parse the assignment) and asserts set-equality with `crank.ts` `REPOS`. Comment in BOTH files pointing at the guard test replaces the current informal mirror comments.
**Steps:** TDD → suite green → commit `test(km-crank): REPOS list drift guard — crank.ts vs km-sensors-sync.sh (phase 0)`.

### Task 4 (repo `~/z2/squad`): gate rollout

Coordinator-run (token-free, no subagent): `bun <installed-kkamak-cache>/src/init-cli.ts` (or the repo copy) in `~/z2/squad`; verify `gate.json` (check = squad's real test command — inspect its package.json; if no runnable check exists, init's no-test-command branch decides), `.km/` gitignored; commit in squad repo. Note in commit: sensor collection only — §4.3 trial enrollment is a separate seam, not enabled by this.

### Acceptance (whole phase)

- A kernel-emitted line from `~/z2/kkamak` parses in km-crank's scanner (prove in Task 2 via a vector line that matches Task 1's real emission).
- Both drift guards (contract parity, REPOS parity) fail loudly when either side moves alone.
- Squad has an armed gate.json committed.
- All suites hold: kkamak 260+ · km-crank 183+ · others untouched.
