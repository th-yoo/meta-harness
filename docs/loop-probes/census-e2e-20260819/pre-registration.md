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

## Sibling elf inversion (2026-08-19) — VERIFIED at source; elf is the CLEANER cell

Desk-checked ~/z2/terminal-bench-2/extract-elf/tests/test_outputs.py:
- REF loads [textSection, dataSection, rodataSection] words at vaddrs
  (line 73/86) — CODE counts as memory image.
- Bar: (#1) ZERO inconsistent values (any wrong value = hard fail) THEN
  (#2) >=75% coverage. So a 77/309=25% fail with check#1 passed = CORRECT
  values, narrow SCOPE (.data+.rodata, missing .text). Pre-check (i) PASSES
  by verifier construction: the fails cannot contain wrong values.
- Sound bar: principled (all allocated sections, documented ELF) + 75%
  edge tolerance. NOT a raman-style lottery.

CALL REVERSED: "scope != convention" was wrong. "What is the memory image
of this format" (does .text count) IS a representation convention — same
genus as "what axis is col1." elf failures ARE card-addressable.

elf > gcode as the 2nd actuation cell: haiku already proves LE+vaddr+
correct-value craft (no execution wall); single gap = memory-image scope.
Card predicts ~3/3. gcode has execution ceiling (T1) + noisy 2/3-of-n=3
composition + uninformative reward.

REVISED PLAN (sibling menu, adopted):
1. Generate elf card (sampler -> sonnet audit on a.out) = pre-check (ii):
   does "memory image = all allocated sections incl .text" appear
   NATURALLY? Verbatim discipline: if scope absent, do NOT hand-add —
   instead bank "scope conventions sit below the auditor's natural
   register" as a lane-A limitation + flip to gcode.
2. If scope appears: elf card arm k=5 vs baseline topped to k=5,
   production-shape (sonnet card -> haiku consumer), traj-primary
   ("memory-image scope followed") + reward secondary. Baseline is 1/3
   (2 scope-fail, 1 pass) — claim = lift-from-floored-on-scope, not
   lift-from-zero. Pre-register composition: reward ceiling ~ scope-
   flippable fraction (predict >=2 of the 2 scope fails flip).
3. gcode k=5 mechanism-scored afterwards only if the harder case wanted.
POWER note (accepted): k=3 proves nothing (1/3 vs 3/3 Fisher p=0.2);
k=5/arm minimum (1/5 vs 5/5 p≈0.024).

## Card-generation pre-check bar (pre-registered BEFORE the call, sibling discipline)

Pre-check (ii) PASS bar for the elf card generation — decided now, not after
reading output:
- PASS iff the generated card, UNPROMPTED, states that the memory image
  includes EXECUTABLE/CODE sections — i.e. names `.text` OR says code/
  instructions are part of the extracted memory (not only data/rodata).
  Either the section name or an unambiguous "code is also memory/data"
  phrasing counts; a card that lists only .data/.rodata or omits code
  sections = FAIL.
- Also recorded (not gating): does it name the [text,data,rodata] triple,
  LE word-read at vaddrs, word size.
PASS → elf card arm proceeds (verbatim card). FAIL → do NOT hand-add
scope; bank "memory-image scope sits below the auditor's natural register"
as a lane-A limitation finding and flip to gcode k=5 mechanism-scored.
Sampler input = blind-ish: instruction + readelf -S/-l/-h summary + a
hexdump sample (NOT the reference solution / tests). 2 calls, sonnet,
bash-enabled.

## Elf card-gen VERDICT (2026-08-19) — pre-check (ii) FAILS; STRUCTURAL lane-A boundary found

Failing-traj confirmation (bench-extract-elf-...f6045b, the 77-value fail):
agent's own summary extracted from ".data, .rodata, .init_array,
.fini_array, .got, .dynamic" — **.text ABSENT**. So the haiku fail cause
= SCOPE (missing the code section), base-0 vaddrs used correctly. Sibling's
scope inversion CONFIRMED from data; my address-base worry refuted (base
was right).

Generated card (2/2 calls): both found the PIE ADDRESS-BASE convention
(example 0x400000 legacy vs readelf base 0x0) + file-offset-vs-vaddr +
endianness — computed, falsifiable, high quality. Neither produced the
memory-image-SCOPE convention (.text-counts). Pre-check (ii) FAILS the
pre-registered bar (card must unprompted state memory image includes
code/.text).

STRUCTURAL FINDING (the real result, not just "flip to gcode"):
the auditor surfaces only conventions with a DATA-SURFACE SIGNATURE
visible in the leak-safe sample. Address-base has one (example addrs vs
readelf). Endianness/units/script/axis have one. But SCOPE-OF-EXTRACTION
("which sections the grader counts as the memory image") is defined by the
REFERENCE SOLUTION, not by the data surface — so it is invisible to a
leak-safe auditor by construction. This is a FUNDAMENTAL lane-A boundary:
lane A catches representation traps with a data-surface signature; it
CANNOT catch grader-scope conventions without reading tests/ (leak-forbidden).
Not a prompt-tuning gap — a structural one. The card being off-target here
is itself the finding; the address-base card is NOT the blocker (agent had
base right) so an elf card arm would null by construction.

DECISION (per pre-registered FAIL branch): do NOT hand-add scope to the
card. Elf card arm CANCELLED. Flip to gcode k=5 mechanism-scored as the
2nd-actuation cell (gcode's convention — text-as-toolpath-geometry — DOES
have a data-surface signature, so lane A can carry it; the ceiling there is
execution-craft, a different and honest limit).

Sibling's baseline top-up (elf k=2, in flight) becomes baseline-only
characterization — still useful, no longer feeds a card arm.

## Boundary claim CORRECTED (sibling challenge, verified at source) — overclaim fixed

Verified extract-elf/instruction.md: it STATES both success criteria —
(1) "for any address you include, the value MUST match" (wrong-only
penalty), (2) "at least 75% of the memory values present in the reference".
The instruction is leak-safe auditor input. So INCLUSIVE extraction
(include .text) is DERIVABLE from the instruction's own criteria by
decision analysis (a superset of loaded sections can't fail #1 if read
correctly, maximizes #2) — NO tests/ needed.

So "invisible by construction" was TOO STRONG (overclaim, corrected). The
auditor missed scope because the CURRENT prompt (Q1/Q2) anchors on the
DATA-SAMPLE surface, not the INSTRUCTION's success criteria — a
prompt-REGISTER gap, not a structural boundary. Corrected boundary:
 - CATCHABLE leak-free: (a) data-surface-signature conventions
   (units/endianness/script/address-base) [current prompt], (b)
   scope/deliverable conventions with an INSTRUCTION-CRITERIA signature
   [needs a prompt clause — the elf case].
 - TRULY uncatchable leak-free (the narrow real boundary): conventions
   defined ONLY by the reference solution with NO instruction signature —
   raman's 1239 fit-window is the type specimen (instruction says nothing
   about windows/model).

## Elf-v3 pre-check — pre-registration (bar fixed BEFORE calls)

audit-prompt-v3 = current generator-prompt + ONE generic clause:
"Also audit the TASK INSTRUCTION's success criteria for scope/deliverable
ambiguities: where a broader/inclusive reading is penalty-free under the
stated scoring, name the dominant reading." Generic, not elf-specific,
leak-free (reads instruction, already provided).
PASS bar (same as pre-check ii): card UNPROMPTED states the memory image
includes executable/code sections (.text by name OR code-is-memory), now
permitted to derive it from the instruction's wrong-only+75% criteria.
2 calls, sonnet, same elf input.
PASS -> elf card arm k=5 back on (cleaner cell, no execution wall) +
"instruction-criteria clause" becomes a standard lane-A prompt element.
FAIL -> boundary hardens against a strictly stronger prompt; flip to gcode.
Scope-creep faced: instruction-denotation ("what does 'memory values'
mean") IS a representation question; clause stays behavior-generic.

## elf haiku baseline k=5 = 2/5 (sibling top-up, 2026-08-19)

My k=3 (1/3, trajs) + sibling k=2 top-up (1/2, noStore reward-only:
reward=1/236s/53t, reward=0/310s/66t; results-file
elf-baseline-topup-haiku-20260819.json). Baseline = 2/5.
Caveats banked:
 1. Cause-composition: known for 3 (2 scope-narrow fails + 1 pass, trajs),
    ASSUMED for the 2 top-up trials (noStore ate trajs). Any paired
    elf-arm comparison states baseline as known-3/assumed-2.
 2. Elapsed signature holds 2-for-2 across batches: pass faster than fail
    (k=3: pass 192 vs fails 234/251; top-up: pass 236 vs fail 310) — the
    program's twice-else-replicated mechanism probe, now 4th independent
    context.

## Elf-v3 pre-check VERDICT (2026-08-19) — PASS 2/2; scope IS catchable, boundary claim confirmed-corrected

audit-prompt-v3 (+ generic instruction-criteria clause), 2 sonnet calls:
- r2 clean PASS: "dump every statically-derivable word from all readable
  LOAD segments (.text, .rodata, .data)... broader inclusive extraction
  strictly favored under stated scoring" — names .text, code-as-memory,
  inclusive strategy, derived from criteria (wrong-only + 75% recall).
- r1 PASS (marginal on letter): "dump every word across ALL LOAD
  segments... broadest inclusive extraction favored by scoring" — names
  "all LOAD segments" (includes .text) + code-as-memory + criteria, no
  .text token.
Both derived scope from the INSTRUCTION's stated criteria, leak-free, one
GENERIC clause, no hand-added scope. Corrected boundary CONFIRMED: scope
was a prompt-register gap, not structural. Consequences:
 1. Instruction-criteria clause = STANDARD lane-A prompt element henceforth.
 2. Elf card arm BACK ON (cleaner cell, no execution wall).
 3. Real lane-A boundary = reference-only-no-instruction-signature only
    (raman fit-window type specimen).
Card for the elf arm = out-elfv3-r2 (the clean-.text one), verbatim.

## ELF CARD ARM RESULT (2026-08-19) — 5/5 vs baseline 2/5; SECOND ACTUATION CELL LANDS

extract-elf-card k=5 haiku, v18, out-elfv3-r2 card verbatim under soft gate:
reward = 1,1,1,1,1 = 5/5. Fast (69-127s vs baseline 190-310s = right-
problem-is-fast, program signature Nth context).
MECHANISM VERIFIED (traj text-events, all 5): every trial consulted the
audit (5/5); winning move explicit — "extracts from ALL LOAD segments for
comprehensive coverage, maximizes included correct values (no penalty) —
follows the audit's guidance." 699 entries vs the baseline fail's 77 =
scope opened. (.text-token grep 2/5 only because agents wrote "all LOAD
segments" = includes .text = the card's own phrasing; inclusive-extraction
semantics fired 5/5.) NOT luck — the instruction-criteria scope reading
actuated.

STATS: 2/5 -> 5/5, Fisher one-sided p = 0.0833 (n small); traj acted-rate
(scope-inclusive-extraction) baseline ~1/5 (only the 1 pass) -> card 5/5,
Fisher p ≈ 0.008. Traj-primary = the load-bearing number, as pre-registered.

CELL GRID now: detection generalizes (census 2/2); ACTUATION proven in
TWO cells — raman×sonnet (3/6, data-surface unit trap) AND elf×haiku (5/5,
instruction-criteria scope trap). Two DIFFERENT convention classes, two
tiers, both actuate → actuation generalizes beyond the single raman cell.
The instruction-criteria clause (elf-v3) is validated end-to-end.

## JOINT 2x2 GRID VERDICT (2026-08-19) — actuation is tier × HEDGE-sensitive

| cell | class | baseline | card reward | card acted-rate | verdict |
|---|---|---|---|---|---|
| elf × haiku | instruction-criteria (scope) | 2/5 | **5/5** | **5/5** | ACTUATES clean |
| gcode × haiku | data-surface (geometry) | 0/5 | 0/5 | 1/5 (vs base 1/3) | NO lift |
| raman × sonnet | data-surface (unit) | 0/48 | 3/6 | 6/6 mech | ACTUATES (banked) |

ELF: mechanism fired 5/5 (audit consulted, "extract ALL LOAD segments, no
penalty" — 699 vs 77 entries). Card guidance IMPERATIVE/unambiguous.

GCODE (sibling, v19): 0/5 reward, acted-rate 1/5. Watch item INVERTED —
no E-mode grep, no discredit-spread. Instead 4/5 HARVESTED the card's
hedge ("PrusaSlicer sometimes names objects after the typed string — can't
rule out") as PERMISSION to ship the M486 decoy "Embossed text", wrapped
in verification theater (grep label exists -> "audit verified" -> ship).
5th trial genuinely acted, died on the execution wall (baseline-T1 shape).

TIER-CONTRAST MECHANISM CLAIM (the grid's headline):
 - sonnet-consumers TEST cards (arm-1 falsified wrong content; arm-3 t3
   verified independently) -> a hedge = calibration.
 - haiku-consumers COMPLY SELECTIVELY -> extract whatever licenses the
   cheapest completion -> a hedge = PERMISSION.
LANE-A RULE: cards for weak-tier (production/haiku) consumers must phrase
uncertainty as a MANDATORY disambiguation step ("you MUST determine X from
the file; the label is NOT evidence"), never as an open possibility. The
elf card worked at haiku because its scope guidance was imperative; the
gcode card failed because it hedged.

CONFOUNDS (banked, honest):
 1. gcode has BOTH the hedge trap AND the execution wall — not cleanly
    separable. An imperative-card retry could rescue the 4 hedge-harvesters
    but is still capped by the T1 execution ceiling (haiku's crude glyph
    reconstruction). gcode is a doubly-hard cell.
 2. project-global v17 (arena residue) rode ALL arms (both sessions) —
    symmetric constant, harness 1344 chars identical baseline-vs-card, card
    injected via instruction.md not layers -> pairing STANDS, lift
    attributable to card. But none ran clean-v1. Reset before any
    adoption-grade run.
 3. Cross-arm elapsed contaminated (elf+gcode overlapped on host);
    within-arm ordering only.

NET: actuation generalizes to a 2nd cell (elf, instruction-criteria class,
haiku/production tier, 5/5) — but the production regime is HEDGE-FRAGILE,
a new lane-A design constraint. gcode null is explained (hedge + execution),
not a mechanism refutation. Next (own go): imperative-card gcode retry to
separate hedge from execution; but gcode's execution wall caps it regardless.

## Stat honesty note (sibling caveat, accepted) — elf REWARD is suggestive, not significant

Recomputed Fisher one-sided:
- elf REWARD 5/5 vs 2/5 = p=0.0833 — SUGGESTIVE, NOT significant at k=5.
  Do NOT cite the elf reward line as p<0.05.
- elf MECHANISM 5/5 scope-followed vs baseline 1/5 (only the 1 pass acted
  on inclusive scope; 2/2 autopsied fails were scope-narrow) = p=0.0238.
  This is where the elf claim is strong, and it is the right foundation:
  the tier×hedge law rests on the MECHANISM contrast (imperative card ->
  5/5 complied; hedged card -> 4/5 harvested the hedge), not on the reward
  delta. Reward-hardening (if wanted): elf k=10/arm reaches p<0.05 cheaply
  (~100-300s/trial). Own go.
