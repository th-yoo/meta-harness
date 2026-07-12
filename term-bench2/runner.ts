#!/usr/bin/env bun
import { main } from "../opencode-plugin/src/bench/cli.ts"
import { migrateAccountRoot } from "../opencode-plugin/src/harness-store.ts"

// One-time migration of the account-layer root off its old opencode-owned
// location (Task L5) — the bench CLI's process bootstrap, mirroring the
// plugin's own call in index.ts. Deliberately NOT inside cli.ts's main() or
// paths.ts's makeBenchPaths(): both are exercised directly by unit tests
// (bench-cli-*.test.ts, bench-sandbox.test.ts, etc.) without env stubbing,
// and migration must never run against a developer's real $HOME during a
// test run. This file is the actual, untested process entrypoint, so it's
// the only safe place for a real (non-hermetic-by-default) migration call.
migrateAccountRoot()

process.exit(await main(process.argv.slice(2)))
