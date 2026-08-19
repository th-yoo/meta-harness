# Census end-to-end probe — pre-registration (2026-08-19, before any bench trial)

**Question:** does the convention card, injected via the actuating channel
(soft ordering gate + falsifiable framing), change agent behavior on a
census trap — i.e. does ACTUATION generalize beyond raman, not just
detection (census probe already showed detection generalizes)?

**Discipline gate (why a pilot first):** raman was a universal 0-floor, so
any lift was unambiguous. gcode (leaderboard mean 0.38) and extract-elf
(0.61) are PARTLY solved — agents may fail for execution reasons, not
convention-blindness. A card only helps if the CONVENTION is the blocker.
So: baseline pilot BEFORE any card arm.

**Step 1 — baseline pilots (this go):** gcode-to-text + extract-elf, k=1
each, NO card, v1 content (pin v18 = v1-clone), --save-all-traj. Autopsy
each failing/passing traj: did the agent (a) misread the convention
[card-addressable], or (b) read it right and fail/succeed on execution
[card cannot help]? 
DECISION: pick the task whose failure is convention-caused for the card
arm. If BOTH pass at k=1, escalate k or pick the lower-baseline task
(gcode) and read the leaderboard-fail pattern.

**Step 2 — card arm (SEPARATE go, needs /login):** chosen task, sampler →
census audit card reframed as soft-gate falsifiable prediction (raman
arm-3 format) → bench k=3 under v18, --save-all-traj. Baseline arm k=3
same session for paired comparison.

**Scoring:** card-level (convention acted-on in traj) PRIMARY; task reward
SECONDARY (bars are exact-match/sound here, but n small). Mechanism
actuates iff trajs show the card's convention consulted AND acted upon vs
baseline trajs that miss it.

**Spend:** step 1 = 2 bench trials, authorized "go (1)" 2026-08-19. Step 2
gated on step-1 result + a fresh /login.

## Step-1 baseline pilot RESULT (2026-08-19) — BOTH PASS unaided; no headroom at sonnet tier

gcode-to-text reward=1 (381s, 31 turns): agent solved the convention
UNAIDED — "toolpath geometry doesn't sit flat... fitting a plane via
PCA/SVD and projecting the toolpath onto that plane unwarped it into
legible letters, rendered and read visually." (7 geometry/toolpath text
hits.) The representation trap was read AND executed with no card.

extract-elf reward=1 (108s, 11 turns): solved unaided — little-endian,
link-time vaddr, values at addresses; "address 0 → ELF magic, 8196-8204
decoding Hello world". (4 endian/vaddr hits.)

VERDICT: at sonnet-5 (executing tier) neither census trap is
convention-FLOORED — the agent identifies and acts on the convention on
its own. Contrast raman (sonnet 0-floored). So an end-to-end CARD lift is
UNPROVABLE on these two tasks at this model: ceiling effect, no headroom.
The card can only demonstrate actuation where the baseline FAILS on the
convention.

CONSEQUENCE: the card arm (step 2) is CANCELLED for gcode/elf at sonnet.
To test actuation generality end-to-end, need a convention-FLOORED
setup: (a) run these traps at HAIKU tier (where the convention may floor,
matching the TB2 baseline-model regime), or (b) find a census trap that
floors sonnet like raman did. Raman remains the only known
sonnet-floored representation trap in hand. This is itself a finding:
the census "traps" are tier-dependent — floored for the leaderboard's
weaker stacks (gcode mean 0.38, elf 0.61 across 10 agents), self-solved
at sonnet. Detection generality (census probe) holds; ACTUATION lift
needs a floored baseline, which sonnet does not provide here.


## CORRECTION (sibling review, post-result) — "no headroom/ceiling" was a k=1 OVERCLAIM

A k=1 pass establishes NOT-ZERO-FLOORED, not ceiling. gcode leaderboard
mean 0.38 → sonnet could be p≈0.5 with ample headroom, just not raman's
unambiguous-0-floor kind. Correct statement: the raman-style
unambiguous-lift design (0-floor baseline) is UNAVAILABLE at sonnet; a
mid-p lift test needs ~k=15/arm on reward. The card arm was cancelled on
POWER grounds, not ceiling grounds.

CLAIM STRUCTURE (accepted): actuation is (task × tier) CELL-relative —
defined only where the baseline fails for convention reasons. Detection
generalizes across tasks (census, banked). Channel + actuation proven in
ONE cell: raman × sonnet (3/6 vs 0/48, p≈0.0008, mechanism 6/6). That is
an EXISTENCE proof, not generality. Any SECOND convention-floored cell
closes it. Two ways to get one:
 - HAIKU pipeline (production claim): sonnet-audit card → haiku consumer
   = lane A's actual shipping shape (baseline law = haiku; audit runs
   sonnet regardless per the tier ruling). NOT a task-generality test
   (task AND tier both move vs the raman cell).
 - SONNET-gcode paired k≈5 (science claim): tier FIXED, task moved = the
   clean task-generality cell. Score traj-primary (convention consulted +
   acted) + ELAPSED signature (381s/31-turn grind shortening under a card
   — the twice-replicated mechanism probe), reward secondary.
MANDATORY either way: step-1 discipline transfers — baseline pilots k≥3
at the target tier with traj autopsy classifying each failure
convention-caused vs execution-caused, BEFORE any card arm. Risk: haiku
may fail gcode on EXECUTION (PCA/SVD unwarping craft the card cannot
supply) → a card arm on an execution-floored baseline yields a null that
misreads as "actuation doesn't generalize." Card arm only where failures
are convention-caused.
RAMAN: not needed again. Banked sonnet-cell existence proof is as good as
that cell gets (verifier bar is a procedure lottery — re-running adds
reward-noise, nothing at mechanism level). Roles: cite-don't-rerun
existence proof + headless probe-instrument for future auditor/card-format
regression. Do NOT take raman to haiku (execution-floored on scipy craft +
verifier defect = reward unusable).

## Haiku baseline autopsy (2026-08-19) — gcode 0/3, FAILURES SPLIT 2 convention : 1 execution

gcode-to-text haiku k=3 = 0/3 (188s/25s/62s), FLOORED (contrast sonnet 1/1).
Per-trial cause (traj text-events):
- T1 (188s, 16 convention-hits): convention READ RIGHT, executed the
  geometry visualization, reconstructed a letterform but MISREAD the glyph
  ("A"). EXECUTION floor — the PCA/SVD-unwarp reconstruction craft haiku
  lacks; a card cannot supply this (agent already had the convention).
- T2 (25s): grabbed the M486 object LABEL literally, shipped "Embossed
  text" (slicer object name), never reached the toolpath. CONVENTION miss
  — card-addressable.
- T3 (62s): stated the convention correctly ("encoded as movement
  commands, not a string") then GAVE UP ("depends what was entered").
  Detection-without-actuation — the exact rung the card targets.

VERDICT: haiku IS convention-floored on gcode (unlike sonnet), and 2/3
failures are convention-caused → genuine card headroom. BUT T1 exposes an
EXECUTION ceiling: even given the convention, haiku's reconstruction may
misread the glyph. Predicted card effect = flips T2/T3-type (convention)
failures, capped by haiku's reconstruction ability on the T1-type. This
is a HONEST card arm (headroom exists) with a KNOWN ceiling (< 3/3).
Card-level scoring (convention consulted+acted in traj) will be cleaner
than reward here, exactly as pre-registered.

## Haiku baseline FINAL (2026-08-19) — gcode 0/3, extract-elf 1/3

extract-elf haiku k=3 = 1/3 (pass 192s / fail 234s / fail 251s). All three
READ the convention (little-endian, vaddr, readelf — conv-hits 2-10 each);
the two fails extracted a DIFFERENT SUBSET of addresses than the reference
(77 vs 309 vs 309 values) — the verifier requires the reference address
SET, and which addresses to include is an under-specified execution/scope
choice, NOT a convention miss. So elf failures = EXECUTION/scope, NOT
card-addressable. (Also: elf partly passes at haiku = less floored than
gcode.)

TASK PICK (card arm, if run): gcode — it is the only cell that is BOTH
convention-floored at haiku AND fails for convention reasons (2/3). elf
fails on scope-of-extraction, which a convention card does not fix.
Predicted gcode card ceiling < 3/3 (T1 execution wall stands).

CELL GRID after today:
- detection generality: across tasks (census 2/2) — BANKED.
- actuation: raman×sonnet 3/6 (existence proof) — BANKED.
- gcode×haiku: floored 0/3, 2/3 convention-caused — CARD-ARM CANDIDATE
  (production claim), honest headroom, known execution ceiling.
- elf×haiku: 1/3, fails on scope not convention — NOT a card cell.
- gcode×sonnet: not-floored (mid-p) — science-claim cell needs k≈15
  or elapsed/traj scoring.

RECOMMENDATION (for user): gcode×haiku card arm = the cleanest available
2nd actuation cell (production-shaped: sonnet-audit card → haiku consumer).
Score traj-primary (convention consulted+acted) + reward secondary; expect
partial reward lift capped by the execution wall. Own go + it needs the
generated gcode card (sampler→sonnet audit) built first.
