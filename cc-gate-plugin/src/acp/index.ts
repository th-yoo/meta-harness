// index.ts — the ACP subsystem's PUBLIC surface.
//
// Promoted out of src/gauge/ on 2026-08-05: these six modules (acp-wire,
// acp-paths, acp-pool, acp-daemon, acp-client, warm-session) import nothing
// from the rest of this repo — only node builtins, each other, and
// @anthropic-ai/claude-agent-sdk — so they are a self-contained library that
// happened to live in the gauge's directory. This file is the seam that makes
// that explicit, and makes a later extraction to its own repo/npm package a
// directory move plus a package.json rather than an archaeology exercise.
//
// THE RULE: production code outside src/acp/ imports from THIS FILE, never
// from a module inside src/acp/ directly. Tests are inside the boundary and
// may import internals — they test them.
//
// Everything below is what the rest of the repo actually consumes today
// (src/gauge/send-prompt.ts and src/gauge/providers/anthropic-cli-warm.ts).
// Adding an export here is a deliberate widening of the public surface; do it
// on purpose, not because something happened to need it.
//
// EXTRACTION WART, deliberately left: `GAUGE_ISOLATION` (acp-wire.ts) is a
// gauge-specific constant living inside this layer. It is NOT exported here —
// nothing outside src/acp/ needs it in production — but a standalone ACP
// package has no business knowing what a "gauge" is, so that constant should
// move to the caller's side before this ships as its own package. Its sibling
// REASONING_ISOLATION already sits correctly on the gauge side
// (src/gauge/send-prompt.ts).

/** The daemon lifecycle: ensure one is listening, then send it a turn. */
export { ensureDaemon, daemonCall, type DaemonOutcome } from "./acp-client.ts"

/** Close the pool entry that served a session (review-sensor spec §2:
 * close-not-release). First consumer outside src/gauge/: the review
 * sensor. Deliberate widening of the public surface. */
export { closeSession } from "./acp-client.ts"

/** Isolation is a VALUE that crosses the wire on session/new, not an id. */
export type { WarmIsolation } from "./acp-wire.ts"

/** Model-identity check over what the wire actually reported. */
export { modelProvenBy } from "./acp-wire.ts"
