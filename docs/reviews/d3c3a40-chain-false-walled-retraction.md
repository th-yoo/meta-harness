# Review artifact — chain-probe-transport-fix (retraction of the "chain false-walled" claim)

reviewed-range: 2b4efdbdcde3160769e6e24d67173f4b79e0eab5..d3c3a40e47fbb5002eaf3a6e720b9fef2a62c198
reviewer: fresh-context-code-reviewer
fresh-context: true
verdict: approved
findings-count: 0

One commit, docs-only (`docs/resume.md`). It does not fix the chain — it **withdraws**
a queued action item whose premise was false.

**What was queued.** Decision B (08-08 block) / decision 3 (08-07 block): a "chain
probe-transport fix". It held that the verification-channel chain was FALSE-WALLED —
that the opus 429 seen by `probe_models` (bare SDK) did not apply to the chain's own
batch calls because those ride the agent-SDK lane — and prescribed swapping the
chain's probe to the agent lane and re-arming, which fires smoke 14 + channel 301
opus calls.

**Why it was withdrawn.** The transport claim is false. Both the retraction author
and the reviewer traced it independently from source; the reviewer opened every file
itself rather than reading the commit message, and additionally recovered the
intermediate hop the original trace had skipped.

| chain step | traced path | transport |
|---|---|---|
| `scripts/channel-smoke.ts:28` → `:94` | `callChannelModel` (`channel-run.ts:90-99`) → `sdkCall` | bare SDK |
| `replay-cli.ts:583` (`channel`) | `runChannel` (`channel-run.ts:143`) → `refineRecord` (`:113`) → `callChannelModel` → `sdkCall` | bare SDK |
| `scripts/probe-models.sh:34-47` | bare `@anthropic-ai/sdk`, `apiKey:null` + authToken, `maxRetries:0` | bare SDK |

- `transport.ts:289-298` `sdkCall` has **no transport dispatch**; it calls
  `sdkCallOutcome` (`:216`), which unconditionally constructs
  `new Anthropic({… maxRetries: 0})` (`:237`) and `client.messages.create` (`:257`).
- The `selectTransport(env) === "agent-sdk"` redirect exists at exactly one place —
  `transport.ts:314`, inside `callModelSdk` (the refiner/derive path). Repo-wide,
  `selectTransport` is called from `transport.ts:314`, `refiner-cli.ts:85`, and
  `corpus-replay.ts:75`; the latter two only *stamp* a record's `transport` field.
  `channel-run.ts:35` imports `{ resolveModelId, sdkCall }` only — not
  `selectTransport`, not `agentSdkCall` — directly or transitively.
- `transport.ts:332` says it in-source: *"only the deriver (`callModelSdk`) is subject"*.

**Escape-hatch hunt (explicitly commissioned, since a wrong retraction strands a
live chain).** None found. The channel path reads no `KKAMAK_GAUGE_TRANSPORT`. Its
one env seam is `KKAMAK_GAUGE_SDK_BASE_URL` (`transport.ts:244`), which redirects the
bare-SDK client's base URL as a test stub — it cannot change lane. `channel.ts` is a
pure prompt/parse module with zero transport code.

**Verdict on the substance: CONFIRMED.** Probe and batch share one lane. The probe was
already transport-faithful; the 429 genuinely blocks the chain. Walled, not
false-walled. Executing the swap would have been the exact failure
`scripts/probe-models.sh:11` warns about — *"a retrying or CLI-shaped probe reports
'clear' falsely because it rides a different quota than a bare-SDK batch"*, a
violation that "cost a stalled chain" once already — and would have fired 315 opus
calls into a live 429.

**Doc-edit checks, all clean.**
- Every file:line citation in the new RETRACTION block verifies against source. The
  quoted `probe-models.sh` header text is an exact match. No overclaim.
- Retraction guarding: the 08-08 decision B (`:91-96`), the 08-07 decision 3
  (`:128-138`), and the 08-07 section header (`:109`, struck through + pointer) each
  place a retraction marker **before** the false instruction. A reader scanning
  top-down, or landing in either historical block cold, cannot reach the false
  instruction without hitting a marker first. Old text kept verbatim per this file's
  "wrong turns stay visible" convention (`:1308`).
- Grep: all remaining `false-walled` occurrences sit inside marked-retracted text;
  none stands as live fact.
- Mermaid diagram accurate. It collapses `runChannel → refineRecord →
  callChannelModel` to one edge — a simplification the full table directly above it
  (`:21`) states in full. Not finding-worthy.
- The `14` / `301` call counts match the pre-existing planned figures elsewhere in the
  doc (`:138`, `:456`, `:577`) — not newly invented.
- Internal consistency: "C4 stays chain-blocked" (`:58`) agrees with the standing-opens
  line (`:99`) and with the traced source. Nothing contradicts it.

**Scope note.** No code changed, so no suite was re-run; the range touches
`docs/resume.md` alone. What survives from the retracted item: the 2026-08-06
per-transport 429 measurement is correct and stands — only the inference that the
*chain* rides the agent lane was wrong. C4 remains chain-blocked; the earlier claim
that this fix would unblock C4 is void.
