// test/acp-package-surface.test.ts — locks the runtime surface this repo is
// about to depend on from `@th-yoo/cc-api-daemon` (pinned by git SHA in
// package.json, per CLAUDE.md's cross-host-git-only rule). The premise this
// guards: the pinned SHA's `src/index.ts` exports exactly these value
// bindings. An upstream rename/removal at a later SHA bump would otherwise
// surface as an obscure failure deep inside a review-sensor cycle; this test
// fails loudly, here, first.
//
// Deliberately NOT asserted: `envFingerprint`, `routeBackend`, `ACP_BUDGET`.
// They are not exported by this package's barrel at the pinned SHA — an
// earlier plan draft named them, based on work that was deliberately
// deferred. Asserting them here would fail against the real package.
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
