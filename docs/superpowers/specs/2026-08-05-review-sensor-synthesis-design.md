# Review-loop-as-sensor synthesis — design (2026-08-05)

**Status:** DRAFT — design go granted 2026-08-05 ("go both"); build gated
on plan; ACTIVATION (live model spend) gated on its own sized go. Nothing
here authorizes spend.

**Motivation (numerically forced):** the loop-fix probe program (spec
2026-08-05, merge 1649fe8) found exactly one viable outcome signal — b2
review findings-count (n=10, mean 4.2, sd 5.92) — riding the starved
source s3 at 1.43 review-passes/day: 245 days to a d=0.30 verdict vs the
14-day bar. The same signal at s1/s2 cadence passes in 6–7 days. This
design moves the signal onto a dense source: review passes auto-fired at
gated-Stop cadence, findings-counts emitted as a sensor stream.

## 1. Rulings (closed 2026-08-05, brainstorm Q&A)

1. **Trigger:** debounced Stop-hook with daily cap. Fires on gated Stop
   (after the two-tier gate verdict, win or lose), iff BOTH: ≥15 min
   since the last completed pass AND <30 passes since local midnight.
   Constants (15 min, 30/day) are pre-registered, user-amendable
   pre-data. (Round-1 review finding 1/2: the original 30 min/20-day
   constants made the 14-day bar structurally unreachable — see §5
   math; these values leave margin above the 25/day floor.)
2. **Tier/transport:** claude-haiku-4-5 via the ACP warm lane (active
   both hosts, seat cap 4). One tier per instrument regime; a tier change
   is a new boundary ts, streams never pool across.
3. Shadow use by P2 (its own spec): passive read only.

## 2. Mechanism

- **Hook point:** the existing gated-Stop path in cc-gate-plugin (where
  gate-check + gauge already run). Sensor runs AFTER the gate verdict,
  never before, never blocking it.
- **Reviewed material:** the accumulated diff since the last completed
  pass: committed range (last-pass HEAD → current HEAD) plus staged +
  unstaged working-tree changes of this repo. Empty diff → no dispatch,
  no line (an empty-diff Stop is not an observation).
- **Reviewer call:** one haiku dispatch on the warm lane, fixed
  review prompt (frozen at implementation, sha256 recorded in the
  ledger entry), structured JSON output: findings array with
  {severity, file, line} per finding — content text retained only
  host-locally (see F2).
- **Debounce/cap state:** cwd-relative under `.km/` (matching every
  existing `.km/` consumer — gate-check.ts, hook-cli.ts) — which makes
  the scope strictly PER-CWD, not per-repo: worktrees of this repo have
  distinct `.km/` dirs and would each accumulate their own 30/day
  (round-2 note). Therefore the sensor ARMS ONLY IN THE MAIN CHECKOUT:
  arming is gated on cwd == the home-anchored main-checkout path (the
  probe scripts' MAIN_CHECKOUT precedent); a worktree Stop never
  dispatches. Cap is thus a true per-repo bound. Host-wide spend = sum
  over armed repos; only THIS repo arms initially (a second repo is its
  own sized go). Never committed.
- **Single-dispatch guarantee:** the claim is an EXCLUSIVE CREATE —
  `fs.openSync(claimPath, "wx")`: exactly one concurrent Stop wins
  (loser gets EEXIST → skip, reason "claim-lost"). Bare atomic-rename
  is NOT the mechanism (round-2 review: rename always succeeds on
  POSIX, silently overwrites, produces no loser signal); if readback
  is ever preferred, it must be gate-check.ts's actual
  ownership-readback pattern (write, re-read, compare owner pid), not
  rename alone. A claim file older than the debounce window is stale
  and removed before the create attempt (crash recovery; the
  stat→unlink→open-wx pair has a declared narrow TOCTOU — reachable
  only when a prior dispatch crashed AND two Stops race the cleanup;
  accepted, worst case one extra dispatch).
- **Spawn discipline:** dispatch is a DETACHED fire-and-forget spawn
  issued BEFORE hook-cli.ts's `emit()` (which exits the process
  synchronously) — the maybeSpawnGauge/maybeSpawnPromptCheck precedent,
  named here because nothing can run "after" emit().
- **Warm-lane contention:** the sensor acquires a seat with ZERO WAIT
  and lowest priority: no free seat among the 4 → immediate skip line,
  reason "warm-lane-busy", never queues, never evicts a design-time
  seat. The sensor holds NO standing warm session: at pass completion it
  CLOSES its session outright (`.close()`, not `pool.release()` —
  release only marks idle and stays counted against the global cap
  until the 900 s reap), so it never pins one of the 4
  global pool slots between passes (round-2 note: SessionPool's cap is
  global across isolations, and its 900 s idle reap ≈ the 15-min
  debounce would otherwise keep a sensor seat permanently warm). Skip
  rates appear in the stream, so realized cadence stays auditable under
  contention.
- **Diff edge cases:** last-pass HEAD not an ancestor of current HEAD
  (rebase/reset) → fall back to merge-base; no merge-base → review
  working-tree-vs-HEAD only and emit the line with `"diffBase":
  "fallback"`. Diff truncated at a 128 KiB byte ceiling
  (pre-registered constant; truncation flagged in the line).

## 3. Output stream (the new b2 carrier)

`.km/review-findings.ndjson`, one line per completed pass:

```json
{"ts":..., "findingsCount":N, "severityCounts":{"high":..,"med":..,"low":..},
 "diffStat":{"files":..,"insertions":..,"deletions":..},
 "baseSha":"..","headSha":"..","model":"claude-haiku-4-5",
 "durationMs":.., "pluginVersion":"..", "host":".."}
```

- Counts, shas, stats only — NEVER finding text in the stream (F2).
- Full finding text → host-local side file
  `.km/review-findings-text/<ts>.json`, gitignored, referenced by ts —
  for human reading and for a future A4-style actuator, not for pooling.
- Skipped dispatches (debounce, cap, warm-lane unavailable, dispatch
  error) emit `{"ts":..,"skipped":true,"reason":".."}` lines so cadence
  remains auditable. Skips are not observations.

## 4. Instrument discipline

- **New instrument, new regime.** Boundary ts stamped at activation;
  entry in `docs/2026-08-01-gauntlet-adoption-ledger.md`. This stream is
  NEVER pooled with the 10 human-flow `docs/reviews/` artifacts P0
  measured (different reviewer tier, different unit of observation:
  accumulated-diff pass vs merge-review). Its viability (count family:
  n ≥ 10, sd/mean ≥ 0.1 spread floor per probe-program §1) is
  re-established from its own first 10 lines via a P0 re-run before any
  E-table row cites it.
- **Fail-open family rule:** sensor failure never blocks or delays the
  Stop beyond its own dispatch (dispatch is async post-verdict; the Stop
  returns without waiting).
- prompt change / constant change / tier change ⇒ new boundary ts +
  ledger entry (KKAMAK_DEV_CHECKS untouched — sensor, not gate).

## 5. Activation + cost

- Ships OFF. Armed PER-REPO by env (`KKAMAK_REVIEW_SENSOR=1` precedent:
  gauge arming), flipped only under a sized go stating the cap math:
  ≤30 haiku passes/day for this repo, prompt bounded by the 128 KiB
  diff ceiling.
- **Verdict math (count family — corrected per round-1 review finding
  1; the draft wrongly transplanted B3's binomial n/arm=41):**
  nPerArmCount(0.30) = ceil(15.68/0.09) = 175 per arm → 2×175 = **350
  events** for a d=0.30 two-arm comparison. Days = 350/rate: 25/day →
  14 days (bar edge), 30/day → 12 days (PASS), 20/day → 18 days
  (FAIL). **The bar is reachable iff realized cadence ≥ 25/day** —
  hence the 15-min/30-cap constants.
- **Realized-cadence checkpoint (pre-registered):** the claimed cadence
  is a hypothesis, not a derivation — no inter-Stop gap distribution
  exists to compute the debounce collapse from. After 7 calendar days
  armed, realized events/day is read from the stream itself; if
  < 25/day, the constants come back to the user for amendment (raise
  cap / shrink debounce / accept a longer verdict horizon) — an
  instrument-constant change, so it stamps a new boundary ts (this is
  deliberately NOT called a "pre-data" amendment: cadence data exists
  by then; only the user gate makes it legal). Nothing self-adjusts.

## 6. What this is NOT

- Not a gate: emits no verdicts, blocks nothing, `accepted` unaffected.
- Not an actuator: findings are recorded, never auto-applied (A4-style
  application is P2's subject, separately ruled).
- Not a replacement for merge reviews: the 7b merge-gate flow and
  `docs/reviews/` artifacts continue unchanged.
- Adopts nothing: turning the stream into loop decisions still goes
  through P0 viability + E-table + user ruling.

## 7. Boundaries (inherited)

F1: no mechanism edits outside the sensor itself. F2: committed/streamed
artifacts carry counts, stats, shas, ts — never prompt/finding text.
Boundary-liveness rule of probe-program §6 applies to every future read
of this stream.
