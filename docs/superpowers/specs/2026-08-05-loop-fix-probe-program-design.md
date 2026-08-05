# Loop-fix probe program — design + P0/P1 pre-registration (2026-08-05)

**Status:** REGISTERED, pre-data for P0/P1. P2 is a named placeholder with a
contract, NOT pre-registered here (it spends; it gets its own spec after P0).
Constants for each probe freeze at that probe's first datum.

## 0. Context — what is being fixed, and how fixes get chosen

The 2026-08-05 diagnosis (kkamak-repo session, cross-checked against this
repo's own verdicts: loop-1 provable null with lesson ignored 7/8; loop-2
no-lift called early; the event-starvation roadmap note) named five causes
for the self-improving loop not turning:

- **A** — actuator doesn't bind (prose advice loses to model priors)
- **B** — outcome variable nearly constant (`accepted` always true;
  catches resolve round 1)
- **C** — event starvation, worse with work depth (one Stop = one event)
- **D** — instrument blind to non-breaking defects (green ≠ good)
- **E** — rigor priced above the evidence rate (bars unreachable at
  ~10 events/day)

Each cause has SEVERAL candidate fixes and no principled way to pick by
argument. This program picks by measurement: free probes first, spend
probes later, the architecture decision made from numbers. The user rules
on every adoption; nothing here self-adopts.

**Probe registry:**

| id | cause | cost | status |
|----|-------|------|--------|
| P0 signal-variance audit | B | zero model calls | pre-registered §1 |
| P1 event-density counters | C | zero model calls | pre-registered §2 |
| E computation | E | arithmetic only | defined §3, runs after P0+P1 |
| P2 actuator-binding probe | A | model spend | contract §4, own spec later |
| P3 channel program | D | in flight | foreign to this spec (ladder + C4 pre-regs) |

## 1. P0 — signal-variance audit (pre-registered)

**Question:** which candidate outcome signals actually vary? A signal with
no variance cannot rank candidates regardless of volume; dead signals are
eliminated before any probe spends.

**Candidate signals and their mechanical computation (all from EXISTING
data — zero model calls):**

- **B1 gate-outcomes** — `accepted`, `rounds` length, `gateExhausted`,
  `durationMs` from `.km/gate-outcomes.ndjson` on this repo, and
  read-only from `~/z2/kkamak/.km/` as a FOREIGN stream (attribution:
  lines stamp `pluginVersion`; 0.2.1 lines describe the frozen snapshot —
  reported separately, never pooled with anything).
- **B2 review findings** — findings-count and severity mix per review,
  from committed `docs/reviews/*.md` (`findings-count` field) plus this
  repo's SDD ledgers (`.superpowers/sdd/*/progress.md` severity lines)
  and the 2026-08-05 session records (architect reviews: 7, 9, 8-finding
  rounds). Per-review counts; severity split where recorded.
- **B3 gauge class/channel distribution** — descriptive import of the
  corpus report (A1/A2/B/C/D counts by provenance) and, when the armed
  chain lands them, channel labels. No new classification here.
- **B4 TB2 band pass@k** — historical pass@k spread over the term-bench2
  band tasks from the committed store snapshot (loop-1/2/3 artifacts).
  No new runs.

**Viability rule (pre-registered):** a signal is VIABLE iff (i) it shows
nonzero variance over n ≥ 10 existing observations, and (ii) its
per-event acquisition cost is stated and bounded (B1: free rider on
gated Stops; B2: one review dispatch; B3: classifier call; B4: one bench
run). Signals failing either clause are EXCLUDED from P2's outcome
design. Fewer than 10 observations → signal reported UNKNOWN, not
viable, not excluded — it may re-enter when data exists.

**Output:** `docs/loop-probes/<hostname>-p0-signal-variance.json` —
per-signal n, distribution summary (counts per value or
mean/sd/min/max), viability verdict. Counts and stats only (F2: no
prompt/note text). Committed.

## 2. P1 — event-density counters (pre-registered)

**Question:** how many evidence events per day does each candidate source
actually generate on live work?

**Window:** the 7 calendar days ending at run time, both hosts where the
data travels (git history travels; `.km` streams are host-local — the
office host's stream is read here, the MacBook's only if its snapshot was
committed).

**Sources and their mechanical counts:**

- **C1 gated Stops/day** — gate-outcomes lines per day (existing stream).
- **C2 commits/day** — `git log --since` count on this repo + `~/z2/kkamak`.
  This PROXIES a per-commit hook source without building it: if C2 wins,
  the hook gets built; the probe itself is `git log` arithmetic.
- **C3 review passes/day** — count of review artifacts + SDD review
  dispatches per day from committed `docs/reviews/` dates and ledger
  lines. DECLARED CRUDE: manual dispatches only; a scheduled-sweep source
  would multiply this at will, so C3's number is a floor, not a ceiling.
- **C4 post-two-tier turn shift** — gated Stops/day and `durationMs`
  distribution split at instrument boundary ts 1785888548054 (this repo,
  never pooled across; descriptive read of whether cheap Stops actually
  shortened turns yet — n will be small, reported as-is).

**Output:** `docs/loop-probes/<hostname>-p1-event-density.json` —
events/day per source per repo, window bounds, boundary splits. Committed.

**No verdict rule of its own** — P1 feeds §3.

## 3. E computation (arithmetic, no probe)

For each (signal from P0-viable) × (source from P1): compute days-to-verdict
for a two-arm comparison at MIN_N = 20/arm across effect sizes
{0.10, 0.20, 0.30, 0.40} using the source's measured events/day, and the
signal's measured base rate where binomial. **Config-viability bar
(pre-registered, user may amend pre-data): days-to-verdict ≤ 14 at effect
size ≤ 0.30.** Output table appended to this spec + the P0 json. Rigor is
never lowered: MIN_N and §4.3 discipline stand; only the evidence CHANNEL
changes.

## 4. P2 — actuator-binding probe (contract only; own spec later)

Blocked until P0's verdict exists (it needs a viable outcome signal).
Its spec MUST state: arms — A1 prose bullet (measured baseline: 7/8
ignored), A3 binding middleware (mechanically enforced check/transform),
A4 review-actuator (findings applied as edits, binding by construction);
mechanical behavior-change detection per arm; task band; model tiers; and
its own sized go. Nothing in this document authorizes P2 spend.

## 5. Program decision rule

After P0 + P1 + E: the architecture choice (review-loop-as-sensor
synthesis vs piecemeal cause fixes) is presented to the user as the set of
configs passing the §3 bar, with their numbers. The user rules. If NO
config passes, that is itself the finding: the loop is unaffordable on
current evidence channels, and the program stops proposing until a new
channel exists (e.g. P3's landing).

## 6. Boundaries

- F1: no mechanism edits anywhere in P0/P1 (read-only probes).
- F2: committed artifacts carry counts, stats, dates, keys — never prompt
  or note text.
- Pooling prohibitions inherited and restated: never across
  `pluginVersion` stamps; never across instrument boundary ts
  (1785847012141, 1785856371528, 1785888548054, 1785892022908); never
  across hosts; the `~/z2/kkamak` stream is a foreign instrument read for
  descriptive contrast only.
- No §4.3 claims from any probe. Probes describe; adoption has its own
  gates.

## 7. What this program cannot do

Cannot fix anything by itself — it selects which fixes earn a build.
Cannot lower rigor bars (E changes the channel, not the bar). Cannot
adopt: every next step (P2 spec, hook build, sweep scheduler, synthesis
design) is a separate user-ruled go.
