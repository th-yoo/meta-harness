# Census generality verdict (2026-08-19) — mechanism GENERALIZES; feal is a poor negative control

Scored per pre-registration.md (card-level, round-6 §3). 6 headless sonnet
calls, each with task instruction + real input files + bash, leak-safe.

| task | type | convention identified | decisive evidence computed | revalidatable |
|---|---|---|---|---|
| gcode-to-text | trap | 2/2 | 2/2 | partial (path reconstruction) |
| extract-elf | trap | 2/2 | 2/2 | 2/2 (readelf recompute) |
| feal-diff | control | n/a (found a REAL issue) | 2/2 | 2/2 |

Findings:
- gcode: both calls found text is encoded as TOOLPATH GEOMETRY (G1
  letterform traces), not text strings; falsified "search quoted strings"
  via computed M862/M486 command analysis + xxd locale ruling-out.
- extract-elf: identified little-endian (ELF magic byte5=0x01), the
  file_offset≠vaddr PIE skew (RW LOAD +0x1000, via readelf -l), plus
  signedness + 4B/8B word-size ambiguities. Sharper + more mechanically
  revalidatable than the raman card.
- feal: found a GENUINE convention issue (f_function docstring endianness
  vs code's actual little-endian; "trust computed behavior not comment")
  and correctly scoped it "not an external data-format issue"; falsified
  the commented-out dead-code key trap. NO hallucinated trap.

DECISION RULE MET: 2/3 trap tasks convention-identified on both calls;
control did not hallucinate → the convention-audit mechanism GENERALIZES
beyond raman (script≠language, unit trap, toolpath-geometry, ELF
format/endianness all cracked by the same prompt).

CAVEATS (banked):
1. feal was a POOR negative control — it has a real code-level convention
   subtlety, so quiet-on-GENUINELY-clean is still UNTESTED at census
   scale (only the rep-audit D-control clean batch tested it, 8/8). A
   future census needs a truly clean task (pure-algorithm, no
   comment/impl mismatch).
2. BAR-SOUNDNESS (free result): all three graders EXACT-MATCH
   (gcode string eq / elf address-value eq / feal exact key) —
   data-determined, no raman-style procedure lottery. The raman verifier
   defect does NOT recur on these tasks.
3. This probe scored the AUDITOR only (does it identify the convention).
   It did NOT run end-to-end (card→agent→verifier) on these tasks —
   generality of ACTUATION (arm-2/3 analog) is a separate, larger spend.

NEXT (own gos): (a) end-to-end on one census trap (gcode or elf: sampler
→ audit → card → bench k=3, card-graded + task-reward secondary) to test
actuation generality; (b) lane A harness build (staging integration +
propose-verify revalidator), now justified — the detector generalizes.
