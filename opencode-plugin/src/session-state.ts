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
