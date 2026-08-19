# Census generality probe — pre-registration (2026-08-19, before any call)

**Question:** does the convention-audit mechanism (the lane-A auditor) generalize
beyond raman — identify the representation convention on OTHER trap tasks, and
stay quiet where there is none?

**Tasks (3), selected from grader-classes census convention-trap candidates:**
- gcode-to-text — dialect/rendering convention (Prusa gcode → rendered text). TRAP.
- extract-elf — binary format/endianness/address convention (ELF, little-endian,
  symbol table). TRAP.
- feal-differential-cryptanalysis — crypto algorithm task, NO representation
  convention. NEGATIVE CONTROL (should audit to "no representation risk"-class).

**Bar-soundness (measured pre-call):** all three graders EXACT-MATCH
(gcode string equality; elf address-value equality; feal exact key[5]) —
data-determined, sound. The raman tolerance-on-procedure-artifact defect
does NOT recur. Flag = SOUND for all three.

**Method:** per task, an auditor gets a working dir containing the task
instruction + the actual input file(s) (never tests/), bash compute, and
audit-prompt-v2 + the compute clause. 2 calls/task = 6 headless sonnet calls.
Mirrors lane A (instruction + input sample, leak-safe).

**Card-level scoring (round-6 §3 — grade the CARD, not end-task reward):**
per call, three binary marks —
1. CONVENTION IDENTIFIED: names the actual representation issue
   (gcode: which flavor/how text is encoded in moves; elf: endianness +
   where values live + address basis; feal: correctly reports NO
   representation trap, it's an algorithm).
2. DECISIVE EVIDENCE COMPUTED: ran a calculation/inspection that
   discriminates the reading (not asserted).
3. MECHANICALLY REVALIDATABLE: the card's claim could be checked by
   deterministic recompute (the propose-verify gate).

**Decision rule:** mechanism GENERALIZES iff ≥2/3 trap tasks score
CONVENTION IDENTIFIED on ≥1 of 2 calls AND the feal control does NOT
hallucinate a representation trap on ≥1 call (quiet-on-clean, census form).
Partial/failure → per-task diagnosis, no harness build until addressed.

**Spend:** 6 headless calls, authorized "go" 2026-08-19. No bench, no store.
