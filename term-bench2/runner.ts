#!/usr/bin/env bun
import { main } from "../opencode-plugin/src/bench/cli.ts"
process.exit(await main(process.argv.slice(2)))
