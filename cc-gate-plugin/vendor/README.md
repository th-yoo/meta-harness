# vendor/ — verbatim copies of `minimal/` kernel modules

The plugin is installed by COPYING its directory out of the monorepo
(`claude plugin install` → `~/.claude/plugins/cache/…`). Any import that
escapes the plugin root resolves in the repo and dies in the install — and
the hook's fail-open contract turns that death into silence (exit 0, gate
inert, no sensor data, no visible error).

These files are therefore byte-identical copies of `../../minimal/*.ts`,
not a fork. `test/self-contained.test.ts` enforces both properties:

1. no file under `src/` imports outside the plugin root, and
2. every file here is byte-identical to its `minimal/` original whenever
   `minimal/` is present (i.e. in the monorepo).

Changing a kernel module means copying it here again in the same commit —
the drift guard fails the suite otherwise.
