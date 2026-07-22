# Evolution-loop roadmap (as of 2026-07-22, post loop-2)

Canonical forward plan after loop-2 closed. State details: [`resume.md`](resume.md) (top
block) · verdict history: [`reboot.md`](reboot.md) (bottom sections) · proposer design:
[`proposer-lesson-prompt.md`](proposer-lesson-prompt.md).

## Where we are

- **Loop-1 (07-21):** v8 (ORDER-BY lesson) — provable null, rolled back. Post-mortem
  desk-check reversed the diagnosis (grader ignores order, grades on a held-out graph).
- **Loop-2 (07-22):** v9 (interpretation-enumeration lesson b7) — **sparql lift certified**
  (7/10 vs 1/10 same-host, Fisher p = 0.020) but **guard-rejected**
  (configure-git-webserver 0/3: b7's "literal wording" made agents trust the task's false
  "I'll setup login" promise and skip sshd). v7 active. v9 kept as
  certified-on-sparql / guard-rejected candidate.
- **Core finding:** no universal interpretation policy across graders — sparql's grader
  rewards literalism, configure-git-webserver's punishes it. Lessons need scoped triggers.
- Both halves of the machine are now proven: the gate certified a real lift AND the guard
  caught a real regression, each with a trajectory-level mechanism.

## Forward plan

**Loop-3 is DECOMPOSED into two parallel single-variable tracks (2026-07-22 revision:
the bundled author→sparql→guard design multiplied three failure odds and made a null
three-way ambiguous — violated standing rule 1):**

```mermaid
flowchart TD
    A[NOW: loop-2 closed<br/>active=v7, v9 guard-rejected, all pushed] --> T1
    A --> T2

    subgraph T1 [TRACK 1 — CONTENT. trials, no factory involved]
        T1a[Hand-write v10 = scoped b7:<br/>ambiguous terms → enumerate;<br/>explicit env promises → verify anyway] --> T1b[ONE run, one task-file:<br/>sparql k=10 + both guards k=3<br/>parallel width]
        T1b --> T1c{lift kept AND guard recovered?}
    end

    subgraph T2 [TRACK 2 — FACTORY. zero trials, code + desk work]
        T2a[Wire enhanced prompt into propose.ts<br/>TDD] --> T2b[Desk-compare: wired vs manual<br/>same evidence in → same output?<br/>divergence = transport bug]
        T2b --> T2c[Factory authors its own bullet from<br/>loop-2 evidence: taxonomy + v9<br/>guard-rejection + verifier contracts]
        T2c --> T2d{factory bullet ≈ hand v10<br/>same fix-class + scoping?}
    end

    T1c -->|yes| I1
    T2d -->|yes| I1
    I1[INTEGRATE: adopt v10.<br/>Factory certified by EQUIVALENCE —<br/>no extra trials needed] --> L4

    T1c -->|sparql lift lost| G[Scoping cut the working mechanism<br/>→ mechanism re-read, rewrite, stay v7]
    T1c -->|guard fails again| H[Wording cannot fix it →<br/>escalate: routing / per-task-class memory]
    T2d -->|no| I2[Content verdict stands from track 1;<br/>iterate PROMPT until output matches<br/>proven-good class — trials reused, not respent]

    L4[LOOP-4 — held-out generalization:<br/>build-pmars, cancel-async-tasks, polyglot-rust-c] -->|travels| J[Real self-improvement claim]
    L4 -->|null| K[Lessons task-local →<br/>routing / per-task-class memory]

    S[Side quests — slot anywhere]:::side
    S --> S1[Office box: grep v8 log harness size]:::side
    S --> S2[Pass-side traj + taxonomy-v2 divergence]:::side
    S --> S3[Rule-12: proposer predicts guard outcomes<br/>would have flagged v9 pre-trial]:::side

    classDef side fill:#eeeeee,stroke:#999999,color:#333333
```

## Track outcomes

| Track | Outcome | Reading | Next move |
|---|---|---|---|
| 1 (content) | Lift kept + guard recovered | Scoped trigger "just right" | Ready to adopt (pending track-2 or as hand-authored v10) |
| 1 | Sparql lift lost | Scoping cut the working mechanism — trigger and mechanism were entangled | Trajectory re-read, rewrite, baseline stays v7 |
| 1 | Guard fails again | Wording cannot serve opposed graders | Stop rewording; escalate to routing / per-task-class memory |
| 2 (factory) | Wired ≈ manual, factory bullet ≈ hand v10 | Factory validated by equivalence — zero factory trials spent | Adoption doubles as first automated-pipeline certification |
| 2 | Factory bullet diverges | Authoring gap, not content gap (content verdict independent from track 1) | Iterate the prompt against the proven-good target; trials reused |

**Integration rule: adoption decision comes ONLY from track 1; factory certification comes
ONLY from track-2 equivalence. Neither blocks the other; a null in either stays
single-variable attributable.**

## Standing rules (accumulated, all evidence-backed)

1. **One manipulated variable per loop.** Everything else is a zero-trial pre-check or
   free post-verdict bookkeeping. (Loop-2's attribution clarity came from this.)
2. **Desk-check the verifier before distilling or trusting any lesson.** Free, and it has
   beaten every LLM input mode so far (loop-1 reversal, guard mechanism).
3. **Forensics audit before any verdict math.** Auth-error grep, turns=0 classification,
   near-wall elapsed. (Both loop-2 arms + guards ran clean.)
4. **Adoption = target lift AND guard non-regression.** Either alone is insufficient
   (v9: certified lift, still rejected).
5. **Candidate system.md must contain the lesson line** — composeHarness silently falls
   back to flat system.md when playbook and system.md disagree. Check
   "Harness assembled (N chars)" at launch (v7 = 394, v9 = 717).
6. **Cross-host confounds act only through timeout margin and podman env** — both
   auditable; when inert, arms pool across hosts (v7 4/20 used this).
7. **tmux-only detach; `META_HARNESS_HOME=$PWD/.meta-harness` on every store command;
   script FILES not inline `bun -e` for store mutations** (apostrophe trap).
