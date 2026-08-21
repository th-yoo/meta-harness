# Core divergence map: lab `gauge/` → kkamak ports (task M2)

Produces the import-rewrite table tasks K2–K4 apply mechanically when porting
`cc-gate-plugin/src/gauge/` into `kkamak/src/`. One row per SYMBOL gauge
imports from outside `gauge/` (not per file) — completeness verified by
recursive extraction (see Step 1 note below) and every kkamak-side cell
verified with a grep hit before being written into this table (no assertion
without a citation).

## Step 1: exact external-import surface (verified)

The brief's literal command is **non-recursive** and misses `gauge/providers/`:

```
grep -h 'from "\.\./' ~/z2/meta-harness/cc-gate-plugin/src/gauge/*.ts | sort -u
```

Running it reproduces exactly the 9 top-level lines the brief's survey
anticipated (`../types.ts` ×9 grouped import statements, `../config.ts`,
`../check-runner.ts`, `../sensor-append.ts`, `../fixture-ref.ts`). It does
**not** surface `../../acp-client-singleton.ts` — which the brief's own
survey lists by name — because that import lives in
`gauge/providers/anthropic-cli-warm.ts`, one directory the glob doesn't
reach. Corrected extraction, run recursively over the whole `gauge/` tree:

```
grep -rn 'from "\.\./' ~/z2/meta-harness/cc-gate-plugin/src/gauge/
```

This adds three lines from `gauge/providers/*.ts`:

```
gauge/providers/anthropic-api.ts:7:   import type { SendPromptProvider, SendPromptOptions, SendOutcome } from "../send-prompt.ts"
gauge/providers/anthropic-api.ts:8:   import { sdkCallOutcome, resolveModelId, type AuthTokenDeps } from "../transport.ts"
gauge/providers/anthropic-cli-warm.ts:41: import type { SendPromptProvider, SendPromptOptions, SendOutcome } from "../send-prompt.ts"
gauge/providers/anthropic-cli-warm.ts:42: import { ensureDaemon, daemonCall } from "../../acp-client-singleton.ts"
gauge/providers/anthropic-cli-warm.ts:44: import { buildAgentOutgoingText } from "../agent-transport.ts"
```

**Correction to the brief's survey:** `../send-prompt.ts`, `../transport.ts`
and `../agent-transport.ts` are **not** external imports. `send-prompt.ts`,
`transport.ts` and `agent-transport.ts` all live *inside* `gauge/`
(`gauge/send-prompt.ts`, `gauge/transport.ts`, `gauge/agent-transport.ts` —
confirmed by `ls gauge/`). The `../` in `providers/anthropic-api.ts` and
`providers/anthropic-cli-warm.ts` resolves one level up *from
`gauge/providers/`*, i.e. back into `gauge/` itself — internal, not part of
this table. Only `../../acp-client-singleton.ts` (two levels up from
`gauge/providers/`) escapes `gauge/` entirely. This is also why the brief's
survey pre-listed `acp-client-singleton` as lab-only despite it never
appearing in the literal (non-recursive) Step-1 command's output.

`gauge/send-prompt.ts` itself also imports a bare npm package from outside
the lab source tree entirely:

```
gauge/send-prompt.ts:36: import type { WarmIsolation } from "@th-yoo/cc-api-daemon"
```

and `gauge/providers/anthropic-cli-warm.ts:43` imports
`{ modelProvenBy, ACP_BUDGET }` from the same package. `@th-yoo/cc-api-daemon`
is a genuine external git dependency (`cc-gate-plugin/package.json`:
`"@th-yoo/cc-api-daemon": "git+https://github.com/th-yoo/cc-api-daemon.git#..."`)
— `kkamak/package.json` currently declares **zero** runtime dependencies, so
this whole package is out of scope for a same-shape port.

No file in `gauge/` (recursively) imports `../state.ts`. `cc-gate-plugin/src/state.ts`
(`FileStateStore`, `saveResetWithRetry`) exists but is imported only by
`hook-cli.ts` — confirmed via `grep -rn '"\./state\.ts"' cc-gate-plugin/src/`,
one hit, not in `gauge/`. The brief's Interfaces line lists `src/state.ts` as
"consumed" for cross-reference context, but gauge itself does not import it —
no row is fabricated for it below. (kkamak's structural analog,
`src/runtime/file-state-store.ts`, is noted anyway in the self-review section
since a later K-task may want the parallel.)

**Row count: 19 symbols**, from 7 origin files/packages:
`../types.ts` (7), `../config.ts` (1), `../check-runner.ts` (1),
`../sensor-append.ts` (1), `../fixture-ref.ts` (4),
`../../acp-client-singleton.ts` (2), `@th-yoo/cc-api-daemon` (3).

## Step 2: symbol-level mapping table

Legend for the **adaptation needed** column: `MAP` = existing kkamak symbol,
rewrite the import + adapt shape; `NEW` = gauge's own vocabulary, no kkamak
host exists, author fresh in the ported gauge's own file (not a rewrite
target, K3/K4 create it); `lab-only` = per brief, exact required row value.

| lab symbol (file) | kkamak equivalent (file) | adaptation needed |
|---|---|---|
| `GateConfig` (`cc-gate-plugin/src/types.ts:95`) | `GateConfig` (`kkamak/src/kernel/ports.ts:46`) | MAP — lab adds two fields kkamak's core type deliberately lacks: `gauge: boolean` and `channelNudge?: boolean` (verified absent from `ports.ts:46-76`; kkamak's own comment at `ports.ts:56-64` documents the `marker` field as the frozen-contract analog but never mentions `gauge`/`channelNudge`). Per K1: the extension's own config layer supplies these, not kkamak core `GateConfig`. |
| `SensorLine` (`cc-gate-plugin/src/types.ts:201`) | `SensorLine` (`kkamak/src/kernel/ports.ts:79`) | MAP — **additional divergence beyond the brief's known list**: lab's `SensorLine.gauge?: GaugeSensorField` (`types.ts:213`) has no counterpart field in kkamak's `SensorLine` (verified: `ports.ts:79-237` field list is `ts, sessionID, check, accepted, gateExhausted, interrupted, rounds, durationMs, host, app, roundsMax?, checkMs?, skippedStop?, marker, pluginVersion?, product?, forced?, implOnly?, sameTurnCoEdit?, ruleChecks?, hookRules?` — no `gauge`). Same treatment as the `GateConfig` field diff: the gauge extension must carry this field itself rather than expecting kkamak core to grow it. |
| `parseGateConfig` (`cc-gate-plugin/src/config.ts:11`) | `parseGateConfig` (`kkamak/src/kernel/config.ts:37`) | MAP — name and purpose match (parse `gate.json` text → `GateConfig`), but kkamak's version only knows the leaner core fields; it will silently drop `gauge`/`channelNudge` on parse (never-throw discipline, same convention both sides) so the ported gauge needs its own parse step for those two fields, layered on top of (not replacing) kkamak's `parseGateConfig`. |
| `runCheck` (as `realRunCheck`) (`cc-gate-plugin/src/check-runner.ts:12`) | `SpawnCheckRunner` (`kkamak/src/runtime/check-runner.ts:17`, implements `CheckRunner` port at `kkamak/src/kernel/ports.ts:281`) | MAP — shape change, not just a rename: lab is a bare function `runCheck(cmd, cwd, timeoutMs): Promise<{code, out, ms}>`; kkamak is a class, `new SpawnCheckRunner(cwd).run(command, timeoutMs): Promise<{code, output}>` (`CheckResult` at `ports.ts:276`). Field rename `out`→`output`, `cwd` moves from a per-call arg to constructor state, and kkamak's `CheckResult` carries no `ms` (elapsed-time) field at all — call sites using `.ms` need another source (wrap the call in `Date.now()` deltas) or must accept the loss. |
| `DEFAULT_SENSOR_REL_PATH` (`cc-gate-plugin/src/sensor-append.ts:12`) | `DEFAULT_SENSOR_PATH` (`kkamak/src/kernel/config.ts:5`) | MAP — same string value verified both sides (`".km/gate-outcomes.ndjson"`), pure rename on import. Note this is a read-only path constant on the gauge side (`state-resolve.ts` only reads sensor lines from it, never appends); kkamak's write-side equivalent for the append operation itself is `NdjsonSensorSink` (`kkamak/src/runtime/ndjson-sink.ts:12`), which gauge does not currently import at all (no `appendSensor` import found) — flagged for K3/K4 awareness, not a row of its own since it isn't in gauge's actual import surface. |
| `GaugePromptClass` (`cc-gate-plugin/src/types.ts:145`) | *(none)* | NEW — zero hits for `GaugePromptClass` anywhere under `kkamak/src/` (verified by recursive grep). Not `lab-only`/do-not-port: this is gauge's own domain vocabulary and must travel with the port, just with no existing kkamak host — author fresh in the ported gauge's own types file. |
| `GaugeHorizon` (`cc-gate-plugin/src/types.ts:148`) | *(none)* | NEW — same as `GaugePromptClass`, zero hits under `kkamak/src/`. |
| `GaugeSensorField` (`cc-gate-plugin/src/types.ts:158`) | *(none)* | NEW — zero hits under `kkamak/src/`. This is also the type of `SensorLine.gauge` (see the `SensorLine` row above) — the two rows are linked: porting this type is what lets the gauge extension supply the missing `SensorLine.gauge` field. |
| `GAUGE_TRANSPORTS` (`cc-gate-plugin/src/types.ts:197`) | *(none)* | NEW — zero hits under `kkamak/src/`. |
| `GaugeTransport` (`cc-gate-plugin/src/types.ts:198`) | *(none)* | NEW — zero hits under `kkamak/src/`. |
| `bunGitRunner` (`cc-gate-plugin/src/fixture-ref.ts:32`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `FIXTURE_REF_REL_PATH` (`cc-gate-plugin/src/fixture-ref.ts:11`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `FixtureRefRecord` (`cc-gate-plugin/src/fixture-ref.ts:13`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `GitRunner` (`cc-gate-plugin/src/fixture-ref.ts:30`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `ensureDaemon` (`cc-gate-plugin/src/acp-client-singleton.ts:177`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `daemonCall` (`cc-gate-plugin/src/acp-client-singleton.ts:196`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `modelProvenBy` (`@th-yoo/cc-api-daemon`, imported at `gauge/providers/anthropic-cli-warm.ts:43`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `ACP_BUDGET` (`@th-yoo/cc-api-daemon`, imported at `gauge/providers/anthropic-cli-warm.ts:43`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |
| `WarmIsolation` (`@th-yoo/cc-api-daemon`, imported at `gauge/send-prompt.ts:36`) | *(none)* | lab-only — do not port; covered by K3 transport port or excluded file list |

**Verification method for every "(none)" cell:** `grep -rn '<symbol>' ~/z2/kkamak/src/` returned zero hits before that row was written — including a combined check (`grep -rn 'GaugePromptClass\|GaugeSensorField\|GaugeTransport\|GaugeHorizon\|GAUGE_TRANSPORTS\|fixture-ref\|FixtureRef\|acp-client\|ensureDaemon\|daemonCall\|cc-api-daemon' ~/z2/kkamak/src/ ~/z2/kkamak/package.json`, exit code 1 / no output). `kkamak/package.json` also declares zero runtime `dependencies` (only three `devDependencies`), independently corroborating that the daemon-transport packages have no home there yet.

## Field-level divergences (summary, cross-referenced from the table)

- `GateConfig`: kkamak (`kernel/ports.ts:46`) omits lab's `gauge: boolean` and
  `channelNudge?: boolean` (`types.ts:95-108`) — deliberate per K1, extension
  config supplies these later.
- `SensorLine`: kkamak (`kernel/ports.ts:79`) omits lab's
  `gauge?: GaugeSensorField` (`types.ts:213`) — same treatment, not previously
  called out in the brief's known-divergence list; found by this task's
  symbol-by-symbol field diff.

## Self-review notes

- Recursive extraction was required to reach completeness: the brief's Step-1
  command as literally written (`gauge/*.ts`, non-recursive) misses
  `gauge/providers/*.ts` and would have silently dropped the two
  `acp-client-singleton` symbols and all three `@th-yoo/cc-api-daemon`
  symbols from the table — exactly the daemon-transport class the brief
  itself flags as expected lab-only content. Re-ran with `grep -rn` over the
  whole `gauge/` tree to close this gap.
- One false-positive risk avoided: `../send-prompt.ts`, `../transport.ts`,
  `../agent-transport.ts` as seen from `gauge/providers/*.ts` resolve to
  files still inside `gauge/` (`gauge/send-prompt.ts`, `gauge/transport.ts`,
  `gauge/agent-transport.ts`), not external files despite matching the
  `from "../` grep pattern. Excluded from the table on that basis, confirmed
  by `ls gauge/`.
- `cc-gate-plugin/src/state.ts` (listed in the brief's Interfaces line) is
  confirmed NOT imported anywhere in `gauge/` (only by `hook-cli.ts`) — no
  row fabricated for it. Flagging rather than silently matching the brief's
  framing, per the repo's admissibility rule (a claim needs a grep hit before
  it's written down).
- Every kkamak-side cell in the table above was verified with a live grep
  against `kkamak/src/` (or `ports.ts`/`config.ts`/`check-runner.ts` line
  reads) before being written; no cell is asserted from the brief's "known
  from survey" hints without independent confirmation. Two hints from the
  brief needed correction after verification: (a) `DEFAULT_SENSOR_REL_PATH`'s
  actual kkamak counterpart is `kernel/config.ts:5`'s `DEFAULT_SENSOR_PATH`,
  not `runtime/ndjson-sink.ts` as the brief's phrasing suggested (that file
  hosts the *append* operation, which gauge doesn't import at all — noted in
  the table row); (b) the five `Gauge*` vocabulary symbols are not
  "lab-only — do not port" in the brief's do-not-port sense (that phrase is
  reserved, per the brief, for daemon transports / `acp-client-singleton` /
  `fixture-ref`) — they are gauge's own types with no existing kkamak host,
  so they get a distinct `NEW` treatment instead, to avoid K2–K4 misreading
  them as symbols to drop from the port.
- Not investigated further (out of scope for this task): whether K3's
  "transport port" is expected to reintroduce `@th-yoo/cc-api-daemon` as a
  new kkamak dependency, or whether the CLI-warm provider is excluded from
  the port entirely. Both readings are consistent with the brief's exact row
  value; the decision belongs to K3, not this map.
