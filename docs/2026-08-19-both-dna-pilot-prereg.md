# Both-DNA baseline autopsy — pre-registration (2026-08-19, `yoo-dev`)

Census-e2e **confirm gate** before any convention-card arm on a NEW domain
(molecular biology). Raman-class generality test beyond
spectroscopy/gcode/elf. Approved go; bench spend authorized.

## Tasks
- `dna-assembly` (leaderboard band ~0.38, split fold-2 / opus-candidates-B) —
  Golden Gate one-pot assembly, design 8 primers (input+egfp+flag+snap ×
  fwd/rev), BsaI-HF v2 cut-sites.
- `dna-insert` (band ~0.31, same fold) — Q5 site-directed mutagenesis,
  insert a 39 bp contiguous fragment into a circular plasmid.

Source of truth: `~/z2/terminal-bench-2/dna-{assembly,insert}/`
(instruction.md, tests/test_outputs.py, solution/solve.sh).

## Hypothesis under test
Failures on these tasks are **CONVENTION-caused** (molecular-biology
conventions the model gets wrong) **not EXECUTION-caused** (can't run the
compute pipeline). If convention-caused, a convention card is the right
lever and raman-class generality extends to a 4th domain.

Convention traps identified by reading instruction + verifier:
- reverse-complement (rc) correctness
- strand / 5'→3' direction
- reading frame — exclude start/stop codons (solve.sh `cut -c 4-21` skips
  the ATG; egfp/flag/snap inserts trimmed at both ends)
- circular plasmid topology — input primers wrap the origin (assembly:
  fwd@688, rev@184 across the seam; insert: fwd@214 / rev@213 back-to-back)
- **Tm computed on the ANNEALED region only**, not the full primer incl.
  BsaI tail/overhang (elf-class scope trap; explicit in both instructions)
- Golden-Gate overhang closure + uniqueness (assembly: 4 unique junction
  overhangs, left == rc(prev.right), closure vector.left == rc(snap.right))
- BsaI site placement: `ggtctc` + ≥1 nt clamp before + 1 nt pad + 4 nt
  overhang after (verifier `parse_bsai_primer`)

Execution demands (must be met for a fair convention read):
- install `emboss` (needle) + `primer3` (oligotm) via apt
- run `oligotm -tp 1 -sc 1 -mv 50 -dv 2 -n 0.8 -d 500 <seq>` for Tm
- optionally `needle` alignment to locate insert/cut positions
- string-slice arithmetic on the fasta

## Method
- Model: **claude-sonnet-5** (matches prior lane: ladder v1 arm, raman-class,
  lane-A validation). Strong enough to execute → residual failures isolate
  to convention. (Haiku would fail at execution = uninformative.)
- k = **3** attempts per task (6 trajectories total).
- **NO card** (pure baseline). Card-free autopsy; `--convention-audit` OFF.
- Baseline card = **v0** default orientation (global active is v17 arena
  residue — must NOT inherit). Minted disposable clone **v999** so
  trials+trajectories store-write without polluting v0.
- `--save-all-traj` (needs store-write ⇒ NO `--results-file`, NO
  `--no-store`, else `noStore` early-return in record.ts drops trajs).
- `--layers project` (project-global only = `repo/.kkamak/global`;
  `--layers global` would also touch account layer).
- Env EXPLICIT in the launch command (never inherit from tmux server):
  `KKAMAK_HOME=META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak`.
- tmux (detached-without-tmux gets silently killed).
- Autopsy reads **text-events only**.

## Pre-registered decision rule
Classify each FAILING trajectory's terminal cause from its text-events:
- **CONVENTION** — pipeline ran (tools installed, oligotm/needle executed OR
  a syntactically valid `primers.fasta` produced) but the verifier fails on
  one of the convention traps above.
- **EXECUTION** — plumbing-dominated: couldn't install emboss/primer3,
  couldn't run oligotm, crashed, produced no `primers.fasta`, timed out on
  mechanics, or computed Tm by hand-arithmetic instead of oligotm.
- **OTHER** — misread instruction, gave up, format-only slip.

### Gate verdict
- **CONFIRM** (convention-caused; keep for card, raman-class generality
  holds) iff ≥ majority of failing trajectories across BOTH tasks are
  CONVENTION-class **and** ≥1 trajectory reaches a
  valid-pipeline-but-wrong-convention state (proves execution is not the
  wall).
- **REJECT** (execution-caused; drop from lane like make-mips-interpreter /
  extract-moves-from-video) iff failures are EXECUTION-dominant.
- **SPLIT** verdict permitted: one task CONVENTION (keep), one EXECUTION
  (drop), decided per-task by the same rule.

n is small (6 traj) → verdict is mechanistic/qualitative (an autopsy), not
statistical. No pass-rate threshold is claimed; if any task unexpectedly
PASSES ≥1/3, note it but the gate is about the *failure mechanism*.

## Launch (reconstruct on any host)
```
# 1. mint disposable v0-clone (no-card baseline)
V=/home/th-yoo/z2/meta-harness/.kkamak/global/candidates
cp -r $V/v0 $V/v999   # then strip v0's score.json/traces from v999

# 2. oracle pre-flight (no model spend) — confirm env + verifier
KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak \
META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak \
bun term-bench2/runner.ts oracle --tasks dna-assembly dna-insert

# 3. autopsy (tmux, sonnet-5, k=3, no card, traj capture)
KKAMAK_HOME=/home/th-yoo/z2/meta-harness/.kkamak \
META_HARNESS_HOME=/home/th-yoo/z2/meta-harness/.kkamak \
bun term-bench2/runner.ts run --tasks dna-assembly dna-insert \
  --model claude-sonnet-5 --driver claude-code --k 3 \
  --layers project --pin project-global=v999 --save-all-traj
```
Trajectories land under `.kkamak/global/candidates/v999/traj/`.
