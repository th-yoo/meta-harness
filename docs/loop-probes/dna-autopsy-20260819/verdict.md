# Both-DNA baseline autopsy — VERDICT (2026-08-19, `yoo-dev`)

**Gate:** census-e2e confirm gate — is molecular biology (dna-assembly,
dna-insert) a raman-class **representation-convention** trap (card lane) or
not, before any convention-card arm.

**VERDICT: REJECT for the convention-card lane. Provable null.**
DNA-task failures are the **Tm-precision/craft rung**, NOT a representation-
convention misread. Every molecular-biology convention (reverse-complement,
strand 5'→3', reading frame, circular-plasmid topology, Golden-Gate overhang
closure/uniqueness, BsaI site placement) is read **correctly** in every
failing run. This is the same wall as raman's residual precision rung — which
lane A explicitly does NOT target (arm-3b rejected, "curve-fitting craft
outside the research question"). Molecular biology does **not** extend the
representation-trap generality case beyond spectroscopy/gcode/elf.

**Tier scope (explicit caveat).** Baseline measured at **sonnet-5**, chosen so
the pipeline executes and failures isolate to convention vs craft (it did). It
is NOT the historical card-lane baseline tier (haiku). **Haiku-tier DNA is
unprobed.** gcode's representation wall exists *only at haiku* (sonnet solves
gcode unaided), so a haiku DNA probe could in principle expose an rc/frame
representation wall a card moves. This verdict is therefore scoped:
**reject-for-lane-A on the measured (sonnet) evidence**, not "DNA uninteresting
forever." Countervailing (sibling `meta-harness-1e`): a domain that already
fails at sonnet on *Tm arithmetic craft* has nothing a convention card
addresses at any tier — the craft rung is tier-invariant — so a haiku probe is
low-value, not a blocker to the reject. Haiku-DNA probe = its own go if ever
wanted.

## Method (pre-registered: `docs/2026-08-19-both-dna-pilot-prereg.md`)
- sonnet-5, k=3, NO card (v0 baseline via disposable clone v999), tmux,
  `--save-all-traj`. Oracle pre-flight 2/2 PASS (env + verifier green).
- Autopsy upgraded mid-flight: the traj carries no verifier output, so agent
  text-event inference was **replaced by replaying the real verifier** on the
  agent's reconstructed `primers.fasta` — exact failing assertion, ground
  truth. (3 subagent text-only classifications were all REFUTED by the replay:
  they guessed case-slip / BsaI cut-position / mid-codon breakpoint; all wrong.)

## Baseline result (no card)
| Task | r1 | r2 | r3 | pass |
|---|---|---|---|---|
| dna-assembly | FAIL | PASS | FAIL | 1/3 |
| dna-insert | PASS | FAIL | PASS | 2/3 |

3/6 attempts (50%), pass@3 = 2/2 tasks. **Both tasks solved at baseline** —
mid-band stochastic, not a hard 0/5 representation wall (contrast raman 0/5).

## Ground truth — real verifier replayed on reconstructed primers
| Fail | Exact assertion | Root-cause numbers |
|---|---|---|
| asm-r1 | Tm of fwd/rev within 5°C | egfp: fwd 20nt/67.7 vs rev 20nt/62.3, |Δ|=**5.4** (kf=4/kr=0 asymmetric overhang-extension) |
| asm-r3 | Tm of fwd/rev within 5°C | input: fwd 23nt/66.9 vs rev 32nt/59.7, |Δ|=**7.2** (unbalanced anneal lengths across circular origin) |
| ins-r2 | Reverse primer Tm 58–72°C | rev anneal 26nt/**55.9** (< 58; too-weak split) |

Replay artifacts (committed, auditable): `replay/{asm-r1,asm-r3,ins-r2}.fasta`
(reconstructed from the traj Write/cat events) + `replay/verifier-output.txt`
(the three real-verifier FAIL assertions). All conventions verified correct: fragments
located on template (incl. circular wrap), assembly reconstructs the output
plasmid in the agents' own sims; only the Tm rung binds.

## Why not card-addressable
- The agent already reads every representation convention correctly. A
  convention card (units / endianness / script / address-base / extraction-
  scope / dialect) has no misread to correct.
- The binding failure is a **numeric optimization**: choose annealing
  boundaries so fwd/rev Tm balance within 5°C and land in 58–72°C. That is
  craft/search, the raman-2D-offset analogue, not representation content.
- One marginal sliver IS convention-shaped: the verifier scores Tm on the
  annealing tract **extended by overhang bases that match the template**
  (`kf`/`kr` up to 4 nt), not the bare designed anneal. asm-r1's egfp (|Δ|=5.4)
  would balance if the agent knew the fwd tract gets +4. But (a) asm-r3 (+4 both
  sides) and ins-r2 are pure balancing, unexplained by it — the sliver fixes at
  most 1/3; (b) it is a verifier-scoring fact (leak-adjacent), only weakly
  instruction-derivable ("the part that anneals to template"). Not a robust
  lever. Noted, not adopted.

## Cross-domain law (this null is the 3rd confirmation)
**Cards move convention walls, never craft walls.** Same craft rung in three
domains: raman 2D-offset/gamma residual, gcode glyph-perception residual, DNA
Tm-precision. The two domains split exactly on this axis:
- **gcode = the stronger leg** (sibling `meta-harness-1e`, its lane): a TRUE
  representation wall at haiku — 0/5 floored, failures = decoy-shipping +
  axis-blindness, card measurably moved it (acted 1/5→5/5, decoy 4/5→0/5,
  scoped extraction 0/5→5/5). Its glyph residual is craft, but sits BEHIND a
  wall cards moved first.
- **DNA = craft all the way down**: the representation layer
  (rc/strand/frame/topology/overhangs) was already solved in every failing
  baseline run; mid-band 3/6 confirms no floor. No wall for a card to move.

Membership rule the null sharpens: **lane-A entry requires a MEASURED
convention-caused floor** (the census-e2e step-1 discipline) — not merely a
domain that looks convention-flavoured. DNA has the flavour, not the floor.

## Consequences
- **Do not expand lane A (convention cards) to DNA.** Not a representation
  domain (at the measured tier; see tier caveat).
- The representation-trap generality set stays spectroscopy(raman) / gcode /
  elf. DNA is a precision-craft domain — out of the research question, same as
  raman-arm-3b.
- Increment-2 revalidator (raman/numeric class) is **unaffected** — DNA adds no
  case for or against it; it stands on the raman evidence alone.
- v999 disposable clone can be deleted; trajs under
  `.kkamak/global/candidates/v999/traj/` are host-local (this doc is the record).
