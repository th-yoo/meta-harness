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

  // Silent-failure invariant, pinned live (never hardcoded 36_000/32_000 —
  // a hardcoded copy would keep passing while the REAL exported values
  // drifted, which defeats the point of this test). The package's client
  // (node_modules/@th-yoo/cc-api-daemon/src/acp-client.ts, `run()`, the
  // "Task 8" comment block) refuses to send on:
  //   if (typeof dw === "number" && dw >= budgetMs) { finish({ kind: "no-call" }); return }
  // — i.e. it returns `no-call` whenever the daemon's advertised
  // `daemonWorstCaseMs` is >= the call's `budgetMs`. Since `>=` is the
  // client's own refusal condition, equality is ALREADY a failure, so the
  // safe margin must be a strict `>`, not `>=`.
  //
  // Two meta-harness consumers take the default `budgetMs` (neither passes
  // one explicitly): cc-gate-plugin/src/review-sensor/runner.ts and
  // opencode-plugin/src/bench/p2/a4-review.ts. Their default resolves to
  // `ACP_BUDGET.clientBudgetMs` (acp-client.ts: `opts.budgetMs ??
  // ACP_BUDGET.clientBudgetMs`), compared against the daemon's own
  // `ACP_BUDGET.daemonWorstCaseMs`. Today clientBudgetMs (36_000) exceeds
  // daemonWorstCaseMs (32_000), so the check passes — but that margin is
  // just two numbers in an upstream package, not something this repo
  // controls. If a future package version narrowed or flipped that margin,
  // BOTH consumers would start hitting `dw >= budgetMs` on every single
  // turn: `daemonCall` still resolves cleanly (no throw, no rejected
  // promise) with `{ kind: "no-call" }`, so there is no exception, no
  // non-zero exit, no crash — just a permanent, silent stream of skipped
  // review turns. Nothing else in this repo would catch that: `bunx tsc
  // --noEmit` doesn't see runtime constant values, and neither consumer's
  // own tests assert on the numeric margin between two constants defined
  // entirely inside the dependency. This test is the one place that margin
  // is checked, against the package's real exported values.
  test("ACP_BUDGET floor guard: clientBudgetMs strictly exceeds daemonWorstCaseMs", () => {
    expect(pkg.ACP_BUDGET.clientBudgetMs).toBeGreaterThan(pkg.ACP_BUDGET.daemonWorstCaseMs)
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
