# Pre-registration — rung-5 delivery-channel check (2026-08-20, `yoo-dev`)

Fixed BEFORE building the task and before any model call. The rung-5 dry-run
verdict named this as the gate that must precede the ~2-3h build:

> **What does the agent physically receive — an image, or text?** … If the
> delivery channel is not an image the agent can actually see, this entire
> dry-run measures something the arm never touches.

## The question, and the one thing it must not be confused with

**Q: can a haiku-tier agent, running under the bench's `claude-code` driver in
the task container, actually SEE a PNG placed in its workspace?**

This is a question about the *channel*, not about glyph perception. The rung-5
arm needs both; this check isolates the first. Accordingly the image is made
**trivially legible** — large, high-contrast, well-separated characters, no
G-code glyphs, no ambiguity of the `0`/`O` kind that the dry-run measured. If
the agent fails on *this* image, the channel is the explanation, not
perception. That is the same rung-0 ablation logic the raman ladder used:
strip the load until only the mechanism under test remains.

## Design

A probe task `term-bench2/probe-tasks/image-channel-probe/`:

- `environment/token.png` carries a **6-character token** rendered at large
  size, and the token appears **nowhere else** — not in the instruction, not
  in any text file in the image, not in a filename, not in the task
  description. The agent cannot produce it by inference, memory, or guessing;
  the only path to it is seeing the image.
- The instruction states the file path, says it is an image, and asks for the
  token written verbatim to `/app/out.txt`. It does **not** describe the
  token's content, format beyond length, or appearance.
- The verifier compares `out.txt` to the token exactly (case-sensitive, after
  strip).

The token is generated at build time from a fixed seed committed in the repo,
so the task is reproducible and the expected value is checkable, but it is not
a string any model would emit by chance.

## Pre-registered readings

| outcome | reading |
|---|---|
| token exact, and traj shows a `Read` on `token.png` | **CHANNEL WORKS.** Image reaches a haiku-tier agent. Rung-5's delivery assumption holds; the build's remaining risk is perception only. |
| token exact, but traj shows NO `Read` of the PNG | **INVALID — investigate.** Leakage: the token reached the agent by some path other than the image. Do not score. |
| token wrong/absent, traj shows a `Read` on `token.png` that returned image content | **CHANNEL WORKS, PERCEPTION FAILS at this tier.** Strong negative for rung-5: if a 6-char high-contrast token is unreadable, 26 G-code glyphs will not be read. |
| token wrong/absent, traj shows `Read` returning text/error/refusal for the PNG | **CHANNEL BROKEN.** The tool does not deliver image content in this configuration. Rung-5 as designed measures something the arm never touches; the sampler must hand over text, not an image. |
| any `is_error` / auth / `api_error` / transient result | **TRANSPORT FAILURE — NOT EVIDENCE.** Fix and re-run. Never scored as a perception or channel result. |

## The confound this check is pre-registered against

The dry-run verdict required the model id be pinned so a transport error
cannot present as a perception result. Checked in the source before writing
this: the `claude-code` driver's `modelArg` (`opencode-plugin/src/bench/
drivers/claude-code.ts:258`) *strips* the `anthropic/` prefix and passes a
bare id to `claude --model`, so this path already sends what the CLI accepts.
The sibling lane's `terminal_reason=api_error` on `anthropic/claude-sonnet-5`
was the **ACP daemon** transport, a different path from this driver. The
confound is therefore not live here — but the rule stands: any `is_error`
result is a transport failure to fix and re-run, never tier evidence.

## Spend

Model tier **haiku** (the arm's tier — checking the channel at sonnet would
answer a question nobody asked). Pinned explicitly rather than taking
`DEFAULT_BENCH_MODEL`, which is `anthropic/claude-sonnet-5`.

**k=3, one task.** Three trials because a single failure cannot distinguish a
broken channel from a flaky one, and three identical passes are enough for a
yes/no channel question. Any trial ending in a transport error is re-run and
not counted.

If the channel result is unambiguous at k=3 the check is closed; it does not
escalate on its own, and the rung-5 build remains a separate go regardless of
outcome.
