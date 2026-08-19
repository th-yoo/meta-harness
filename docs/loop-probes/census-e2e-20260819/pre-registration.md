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
