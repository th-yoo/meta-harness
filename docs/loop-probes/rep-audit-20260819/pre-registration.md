# Representation-audit probe — pre-registration (2026-08-19, before any call)

**Hypothesis:** convention-identification framed as the ENTIRE task of a
dedicated model call fires where in-task recognition doesn't (rung-0 0/5) —
i.e. task-framing, not load, gates retrieval. If true, the general detector
for the representation-trap class exists and lane A upgrades from "domain
cue card" to "convention audit" (input = instruction + input-data sample,
never tests/).

**Design:** one audit prompt (audit-prompt.txt), 4 inputs × 2 models
(haiku = staging-economics tier, sonnet = executing tier), 1 call each,
8 calls total, `claude -p` from a context-free cwd (no project CLAUDE.md).

**Success criteria (per input, judged by transcript read, grep as index only):**

- **A raman** (real instruction.md + head/peak/tail sample of graphene.dat,
  decimal commas intact): PASS = names the wavelength-nm → Raman-shift-cm⁻¹
  unit mismatch (mentions cm⁻¹ expectation, ~1580/~2670, or 1e7/x / 1/λ
  conversion). Decimal-comma mention alone = PARTIAL (already proven easy —
  strain-marked). Silence on units = FAIL.
- **B hangul** (instruction claims "Korean text", lines are Japanese +
  Mandarin phonetically in Hangul): PASS = identifies BOTH as non-Korean
  content (Japanese; Mandarin) in Korean script. One of two = PARTIAL.
  "It's Korean" = FAIL.
- **C dates** (CSV, all day-fields ≤ 12, instruction asks for an April
  total): PASS = flags DD/MM vs MM/DD ambiguity AND notes the file itself
  cannot disambiguate (no day > 12). Ambiguity named without the
  evidence-scan point = PARTIAL. Confident single reading = FAIL.
- **D control** (clean ISO dates, dot decimals): PASS = no representation
  risks claimed. Any invented trap = FAIL (false positive; pollution cost
  for the injection lane).

**Decision rule (pre-registered):** detector "exists at tier" iff a single
model gets A=PASS, B≥PARTIAL, C≥PARTIAL, D=PASS. Haiku meeting it →
staging lane economics work as designed. Only sonnet meeting it → audit
must run at executing tier (costlier, still viable). Neither → framing
hypothesis dead at these tiers; lane A falls back to domain cue card
(world-knowledge injection without per-file reading).

**Spend:** 8 headless calls, authorized "go probe" 2026-08-19. No bench
containers, no store writes.
