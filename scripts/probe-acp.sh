#!/bin/bash
# ACP/CLI-lane model probe — the CLI-shaped counterpart to probe-models.sh.
#
# WHY THIS EXISTS (2026-08-06 finding, yoo-dev): quotas are per TIER *and* per
# TRANSPORT. Measured same-minute, one account, one token:
#   BARE-SDK (probe-models.sh)  haiku-4-5=OK  sonnet-5=ERR429  opus-5=ERR429
#   ACP/CLI  (this file)        haiku-4-5=OK  sonnet-5=OK      opus-5=OK
# Both confounds were ruled out: bare-SDK re-probed 429 concurrently (not
# time-scoped), and model identity was proven from `modelUsage`/`canonicalModel`
# rather than assumed from a success (not a silent fallback).
#
# So a 429 verdict is NEVER an account fact — always name the transport.
# probe-models.sh:11-14 documents the false-CLEAR direction (a CLI probe gating
# a bare-SDK batch). This file exists for the undocumented inverse: a bare-SDK
# probe reporting false-WALLED for a CLI-shaped batch, which is what fired.
#
# WHICH PROBE GATES WHICH WORK — probe the lane you will actually spend on:
#   bare SDK    -> probe-models.sh. The gauge refiner's default `sdk` transport
#                  and the channel chain (channel-run.ts callChannelModel ->
#                  plain sdkCall) are bare-SDK end-to-end; their 429s are REAL.
#   ACP/CLI     -> probe_acp_models here (transport only, no daemon).
#   ACP daemon  -> probe_acp_daemon here, when the socket, discovery, pool seat
#                  and setModel path must be covered too.
#   TB2 batch   -> CLI-shaped (`--driver claude-code`). Closest gate is
#                  probe_acp_models; a TB2-exact probe is one task, one model.
#
# NOT A SUBSTITUTE: the package's `listModels`/`retrieveModel` are unbilled GETs
# on /v1/models, but they ride the BARE-SDK client and report model VISIBILITY,
# not inference quota — a model can list fine and still 429 on messages.create.
#
# NOTE `daemonCall` CANNOT REPORT A 429: warm-session.ts reads
# `api_retry.error_status` as a diagnostic and then collapses every failure to
# `call-consumed`/`no-call`, so a 429, a turn-budget expiry and a setModel
# failure are indistinguishable there. probe_acp_models reads the frame itself.
#
# SOURCE OF TRUTH for the ACP internals cited here: the extracted package,
# checked out at ~/z2/cc-api-daemon and git-pinned in
# cc-gate-plugin/package.json. Read line numbers out of that checkout at the
# pinned rev — they moved once already when the subsystem left this repo.
#
# Usage:
#   source scripts/probe-acp.sh
#   probe_acp_models claude-opus-5 claude-haiku-4-5   # transport only, no daemon
#   probe_acp_daemon claude-haiku-4-5 claude-opus-5   # end-to-end through ACP
#
# Cost: a 429 is rejected pre-inference and costs nothing. A success spends one
# turn under DEFAULT_ISOLATION (empty systemPrompt, no settingSources, no tools,
# thinking disabled) — not the full CC harness.
#
# Both functions run from cc-gate-plugin/ so they resolve the PINNED installed
# copy of the package, i.e. the code production actually runs, not the working
# tree at ~/z2/cc-api-daemon.
KKAMAK_PROBE_REPO=${KKAMAK_PROBE_REPO:-$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)}

# Transport-only probe. Replicates the warm lane's query() construction — same
# @anthropic-ai/claude-agent-sdk, same isolation shape, same CLI subprocess
# spawn — but reads the `system`/`api_retry` frame itself.
#
# Deliberately spawns NO daemon, writes NO discovery file and takes NO pool
# seat, so it is safe to run while the live lane is serving.
#
# Prints "<model>=OK|ERR<code>  modelUsage=[key|canonicalModel]  elapsed=<ms>".
# `elapsed` is reported against ACP_BUDGET.turnTimeoutMs minus the worst-case
# CLI spawn, because a model that answers but overruns that window fails
# through ACP as `call-consumed` — a DIFFERENT failure from a 429, and one the
# public surface cannot distinguish.
probe_acp_models() {
  ( cd "$KKAMAK_PROBE_REPO/cc-gate-plugin" && bun -e '
// DEFAULT_ISOLATION, not the plugin-side GAUGE_ISOLATION: byte-identical bar
// the `title` label, and it is a stable package export rather than a plugin
// internal. An earlier revision of this script imported the gauge constant by
// path and broke outright when the subsystem was extracted.
const { DEFAULT_ISOLATION, ACP_BUDGET } = require("@th-yoo/cc-api-daemon")
const { query } = require("@anthropic-ai/claude-agent-sdk")
const BUDGET_MS = Number(process.env.KKAMAK_ACP_PROBE_BUDGET_MS) || 90000
const subprocessEnv = {}
for (const [k, v] of Object.entries(process.env)) if (v !== undefined) subprocessEnv[k] = v

for (const model of process.argv.slice(1)) {
  let status, sawRetry = false, verdict = "ERR-nostream", usage = ""
  // t0 BEFORE query() so the CLI spawn sits inside the window, exactly as the
  // daemon measures its own turn budget.
  const t0 = Date.now()
  const q = query({ prompt: "say ok",
    options: { ...DEFAULT_ISOLATION, model, cwd: process.cwd(), env: subprocessEnv } })
  const timer = setTimeout(() => { try { q.close() } catch {} }, BUDGET_MS)
  try {
    for await (const m of q) {
      if (m.type === "system" && m.subtype === "api_retry") {
        sawRetry = true; status = m.error_status
        verdict = (status === null || status === undefined) ? "ERR-conn" : "ERR" + status
        break                    // deny the CLI its auto-retry, as warm-session does
      }
      if (m.type === "result") {
        // A success does NOT prove which model ran — the package uses
        // selectEvidence/modelProvenBy for exactly this. Report the evidence.
        const u = m.modelUsage || {}
        usage = Object.keys(u).map(k =>
          k + (u[k] && u[k].canonicalModel ? "|" + u[k].canonicalModel : "")).join(",")
        verdict = (m.subtype === "success" && m.is_error !== true) ? "OK" : "ERR-result:" + m.subtype
        break
      }
    }
  } catch (e) { verdict = "ERR-throw:" + String(e && e.message).slice(0, 60) }
  finally { clearTimeout(timer); try { q.close() } catch {} }
  const el = Date.now() - t0
  const fits = (ACP_BUDGET && ACP_BUDGET.turnTimeoutMs ? ACP_BUDGET.turnTimeoutMs : 16000) - 1460
  console.log(model + "=" + verdict
    + (sawRetry ? " (api_retry error_status=" + String(status) + ")" : "")
    + "  modelUsage=[" + (usage || "NONE") + "]"
    + "  elapsed=" + el + "ms  vs_acp_budget=" + (el <= fits ? "FITS" : "OVER by " + (el - fits) + "ms"))
}
' "$@" )
}

# End-to-end probe THROUGH the daemon: ensureDaemon + daemonCall, covering the
# discovery file, the fingerprint handshake, session/new, the pool seat and the
# setModel path that probe_acp_models bypasses.
#
# Passing two or more models is the point: the second call has
# model !== currentModel, so it drives setModel() under ACP_BUDGET.setModelMs.
#
# ISOLATION — READ BEFORE EDITING. The daemon is discovered via
# `discoveryPath(env)` = `$HOME/.config/acpd/acp-<envFingerprint>.json`.
# `KKAMAK_ACP_SOCKET` is an ENDPOINT ADDRESS and is IN `ACP_ENV_DENYLIST`
# (acp-paths.ts), so binding a private socket does NOT fork the fingerprint —
# a probe that isolated only that way would share the HOST's discovery file and
# DELETE it on stop. The sanctioned fork is `KKAMAK_ACP_TEST_MARKER`, kept out
# of the denylist precisely so a run can claim its own fingerprint
# (acp-paths.ts's denylist commentary; pinned by test/acp-paths.test.ts).
#
# The package's own `tempEnv()` also overrides HOME, which is right for tests
# but wrong here: a throwaway HOME hides the real credentials and the probe
# could not reach a model at all. Marker-only forks the fingerprint while
# keeping the real HOME, which is what a LIVE probe needs.
#
# KKAMAK_ACP_IDLE_MS is denylisted too (an operating parameter, not an
# identity), so shortening it changes nothing about which daemon is reached —
# it only makes this probe's own daemon self-exit promptly instead of lingering
# for the production default.
probe_acp_daemon() {
  local marker idle
  marker=${KKAMAK_ACP_PROBE_MARKER:-"probe-acp-$$"}
  idle=${KKAMAK_ACP_PROBE_IDLE_MS:-15000}
  ( cd "$KKAMAK_PROBE_REPO/cc-gate-plugin" \
    && KKAMAK_ACP_TEST_MARKER="$marker" KKAMAK_ACP_IDLE_MS="$idle" bun -e '
// Imported from the package directly, NOT via the plugin'"'"'s
// src/acp-client-singleton.ts. That singleton exists to pin ONE env for a
// plugin process so every consumer reaches the same daemon; this probe is a
// standalone process whose whole purpose is to reach a DIFFERENT, forked
// daemon, so routing through it would defeat the isolation. The hazard the
// singleton closes (several in-process consumers, divergent envs, N daemons)
// does not arise here.
const { ensureDaemon, daemonCall, DEFAULT_ISOLATION, envFingerprint } = require("@th-yoo/cc-api-daemon")
const env = process.env

console.log("fingerprint=" + envFingerprint(env) + "  (forked via KKAMAK_ACP_TEST_MARKER)")
const up = await ensureDaemon(env, { waitMs: 30000 })
console.log("ensureDaemon=" + up)
if (!up) { console.log("ABORT: no daemon"); process.exit(1) }

for (const model of process.argv.slice(1)) {
  const t0 = Date.now()
  const r = await daemonCall("say ok", model, env, { isolation: DEFAULT_ISOLATION })
  const el = Date.now() - t0
  // kind=ok carries model/canonicalModel proven over the wire. Any other kind
  // is AMBIGUOUS BY DESIGN — it does NOT mean "429".
  console.log(model + " -> kind=" + r.kind
    + (r.kind === "ok" ? "  model=" + r.model + "  canonical=" + r.canonicalModel : "")
    + "  elapsed=" + el + "ms")
}
' "$@" )
  local rc=$?
  # MEASURED 2026-08-11: the probe daemon self-exits on the idle clock, but
  # acp-daemon.ts has no unlink of its discovery file, so the entry SURVIVES
  # the process. That is tolerated by design, not a defect — readDiscovery is
  # documented structural-only ("does NOT probe whether `port` is still live —
  # that is a connect attempt, the caller's job"), so ensureDaemon dials a
  # stale entry, fails, and takes over. Do NOT wait for the file to vanish; it
  # will not. Some of the host's own acpd entries are stale for the same
  # reason.
  echo "probe daemon self-exits after ${idle}ms idle; it leaves a STALE entry at"
  echo "  \$HOME/.config/acpd/acp-<fp>.json for the forked fp printed above."
  echo "  Safe to delete once that pid is dead; harmless if left. Confirm the"
  echo "  HOST's own acpd entries are unchanged (assert a delta, not emptiness)."
  return $rc
}
