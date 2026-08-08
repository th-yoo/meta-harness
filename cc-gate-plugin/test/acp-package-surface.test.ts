// test/acp-package-surface.test.ts — locks the runtime surface this repo is
// about to depend on from `@th-yoo/cc-api-daemon` (pinned by git SHA in
// package.json, per CLAUDE.md's cross-host-git-only rule). The premise this
// guards: the pinned SHA's `src/index.ts` exports exactly these value
// bindings. An upstream rename/removal at a later SHA bump would otherwise
// surface as an obscure failure deep inside a review-sensor cycle; this test
// fails loudly, here, first.
//
// `envFingerprint`, `routeBackend`, `ACP_BUDGET` ARE asserted below: the
// pin bumped to v0.3.0 (f99bcd6, review-sensor-swap), which exports all
// three from the main entry (A6.4) — an earlier plan draft named them
// based on work that was, at the time, deliberately deferred; that is no
// longer the state of the pinned SHA. They earn their place here beyond
// "keep the lock exhaustive": runner.ts already depends on this package at
// runtime, and upcoming work depends on these specific three — a floor
// guard needs `ACP_BUDGET.daemonWorstCaseMs`, a lane assertion needs
// `routeBackend`.
//
// Also NOT assertable here: `DaemonOutcome` and `WarmIsolation` are TYPES,
// erased at compile time — they have no runtime representation to check.
// `bunx tsc --noEmit` is their only guard (see send-prompt.ts's type-only
// import of `WarmIsolation` for the consumer this protects).
import { describe, expect, test } from "bun:test"
import * as pkg from "@th-yoo/cc-api-daemon"

describe("@th-yoo/cc-api-daemon surface lock", () => {
  test("functions", () => {
    expect(typeof pkg.ensureDaemon).toBe("function")
    expect(typeof pkg.daemonCall).toBe("function")
    expect(typeof pkg.closeSession).toBe("function")
    expect(typeof pkg.modelProvenBy).toBe("function")
    expect(typeof pkg.listModels).toBe("function")
    expect(typeof pkg.retrieveModel).toBe("function")
    expect(typeof pkg.envFingerprint).toBe("function")
    expect(typeof pkg.routeBackend).toBe("function")
  })

  test("ACP_BUDGET object", () => {
    expect(typeof pkg.ACP_BUDGET).toBe("object")
    expect(pkg.ACP_BUDGET).not.toBeNull()
  })

  test("classes", () => {
    expect(typeof pkg.ApiSession).toBe("function")
    expect(typeof pkg.WarmSession).toBe("function")
  })

  test("DEFAULT_ISOLATION object", () => {
    expect(typeof pkg.DEFAULT_ISOLATION).toBe("object")
    expect(pkg.DEFAULT_ISOLATION).not.toBeNull()
  })
})
