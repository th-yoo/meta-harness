/**
 * session-state.ts
 *
 * Shared mutable state accessed by both index.ts and propose.ts.
 * Kept in one module to avoid circular imports.
 */

/**
 * Session IDs created by the proposer loop.
 * These are excluded from scoring and from system-prompt/snapshot injection
 * so they don't trigger a scoring toast and don't receive the harness under test.
 */
export const proposerSessions = new Set<string>()

/**
 * Session IDs created by the shadow judge — a subset of machine sessions whose
 * ENTIRE system array is replaced by the judge persona in the plugin's
 * system.transform hook. (opencode always prepends its base coding-agent
 * prompt + env block; per source, request.ts assembles them before the
 * transform runs, so the hook is the only mechanism that can remove them.)
 * Judge sessions are ALSO added to proposerSessions so every scoring/
 * trajectory hook skips them.
 */
export const judgeSessions = new Set<string>()
