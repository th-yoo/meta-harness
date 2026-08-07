# cc-api-daemon: unix socket → localhost WebSocket — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `cc-api-daemon`'s unix-socket transport with a localhost WebSocket server, keeping ACP's JSON-RPC 2.0 message layer and lifecycle unchanged.

**Architecture:** ACP is explicitly transport-agnostic — "implementers who choose to support custom transports **MUST** ensure they preserve the JSON-RPC message format and lifecycle requirements." The message layer (`initialize` → `session/new` → `session/prompt`, error codes `-32000`/`-32001`, the `_meta.kkamak` envelope) is unchanged. What changes is the channel underneath it: a `ws` `WebSocketServer` on `127.0.0.1`, reached through an HTTP upgrade, replacing `net` + a unix socket path.

**Reference implementation:** `~/z2/chronos-api-0.4.5` — a JSON-RPC 2.0 over WebSocket server on Bun. Port its per-connection JSON-RPC handling (`src/websocket/websocket-client.ts`) and its server wiring (`src/index.ts:59-161`). Do not port its upgrade handler's *policy* — see the ruling below.

**Tech Stack:** Bun ≥1.0, `ws` (`WebSocketServer({noServer:true})`), `node:http` `createServer`, `@anthropic-ai/sdk`. Koa is **not** needed — chronos uses it for a web app and REST routes this package has no equivalent of.

## Global Constraints

- **Bun-only**, raw `.ts` ships, `exports["."]` → `src/index.ts`. No build step.
- **`index.ts` is the only public surface.** The client trio (`ensureDaemon`, `daemonCall`, `closeSession`) keeps its signatures — this is a transport swap, not an API change.
- **The outcome law is unchanged.** `no-call` = provably nothing went toward the model; `call-consumed` = any ambiguity at or after the send boundary. `maxRetries: 0`.
- **The credential-safety rule in `CLAUDE.md` still binds.** `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test` must pass, and CI runs it as its own step.
- **Zero real spend in tests.** Local `Bun.serve` stub, `ANTHROPIC_BASE_URL` redirected.
- **Gate:** `bun test` and `bunx tsc --noEmit` clean at every commit.

---

## RULING: no handshake authentication (2026-08-07)

**Decided by the user after the exposure was stated twice. Implement as specified; do not add auth back on your own initiative.**

The daemon binds `127.0.0.1` and accepts every upgrade, exactly as the reference does (`chronos-api-0.4.5/src/index.ts:154` — `handleUpgrade` with no Origin check, no token; a `grep` for `origin|authorization|token` across its `src/` returns nothing).

What this accepts, recorded so a future reader doesn't mistake it for an oversight:

- **Any local process** can drive the daemon and spend the host's Anthropic credentials. This is *not* a regression — the unix socket's `0700` directory already admitted any process running as the same user.
- **Any web page the user visits** can connect. This *is* new. A WebSocket handshake is not subject to the same-origin policy, so `new WebSocket('ws://127.0.0.1:PORT')` from any page succeeds; loopback binding does not prevent it.

The unix socket got authorization from the filesystem for free (`ensureSocketDir`, `mode: 0o700`). TCP has no equivalent, and this ruling declines to re-create one.

**If the ruling is ever revisited, the fix is small and belongs at the upgrade handler:** require a token in a *custom header* (the browser `WebSocket` constructor cannot set headers, so that alone excludes browser pages by construction), reject any request carrying an `Origin` header at all, and keep the token in a `0600` file. Roughly 30 lines. Noted here so the option is costed, not to relitigate it.

---

## File structure

| File | Fate |
|---|---|
| `src/acp-wire.ts` | **Edit** — delete `encodeFrame`/`FrameDecoder` (WebSocket messages are already discrete); keep method constants, error codes, `WarmIsolation`, `modelProvenBy`, `ACP_BUDGET` |
| `src/acp-paths.ts` | **Rewrite** — socket path → discovery file; keep `envFingerprint` unchanged |
| `src/acp-daemon.ts` | **Edit** — `net.createServer` → `http.createServer` + `WebSocketServer({noServer:true})`; dispatch logic unchanged |
| `src/acp-client.ts` | **Edit** — `net.connect` → `new WebSocket(url)`; connect-or-spawn, locks, budget check unchanged |
| `src/acp-pool.ts`, `src/api-session.ts`, `src/call.ts`, `src/auth.ts`, `src/models.ts`, `src/session-contract.ts` | **Untouched** — none of them know about the transport |
| `src/jsonrpc.ts` | **New** — validation + error responses, ported from chronos |

Nothing below the wire changes. `ApiSession`, the send boundary, the outcome law, the pool, and the models surface are all transport-agnostic already.

---

### Task 1: JSON-RPC validation module

Port the message-layer discipline from `chronos-api-0.4.5/src/websocket/websocket-client.ts:100-155`. It handles three things this package currently does implicitly, and gets one of them right that we do not.

**Files:** Create `src/jsonrpc.ts`, `test/jsonrpc.test.ts`

**Interfaces:**
- Produces: `validateJsonRpc(raw: unknown): {ok: true; value: JsonRpcRequest} | {ok: false; code: number; message: string; id: string|number|null; isNotification: boolean}`, `createErrorResponse(id, code, message): JsonRpcResponse`

- [ ] **Step 1: Write the failing test**

```ts
import { test, expect } from "bun:test"
import { validateJsonRpc, createErrorResponse } from "../src/jsonrpc.ts"

test("a valid request parses", () => {
  const r = validateJsonRpc({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })
  expect(r.ok).toBe(true)
})

test("a notification is flagged and carries a null id", () => {
  const r = validateJsonRpc({ jsonrpc: "2.0", method: "session/cancel", params: {} })
  if (r.ok) throw new Error("expected the validator to flag the missing id")
  expect(r.isNotification).toBe(true)
})

test("a malformed request reports Invalid Request with its id preserved", () => {
  const r = validateJsonRpc({ jsonrpc: "1.0", id: 7, method: "initialize" })
  if (r.ok) throw new Error("unreachable")
  expect(r.code).toBe(-32600)
  expect(r.id).toBe(7)
})

test("createErrorResponse is well-formed", () => {
  expect(createErrorResponse(3, -32700, "Parse error")).toEqual({
    jsonrpc: "2.0", id: 3, error: { code: -32700, message: "Parse error" },
  })
})
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test test/jsonrpc.test.ts`
Expected: FAIL — `Cannot find module '../src/jsonrpc.ts'`

- [ ] **Step 3: Implement it**

Mirror chronos's structure. **The rule worth copying verbatim, because it is easy to get wrong and the reference gets it right:** a notification (no `id`) receives **no reply at all — not even an error response**. JSON-RPC 2.0 requires this, and chronos honours it explicitly at `websocket-client.ts:122-127`. `session/cancel` is a notification in ACP, so this is a live path here, not a spec footnote.

Standard codes: `-32700` parse error, `-32600` invalid request, `-32601` method not found, `-32602` invalid params. ACP's own `-32000` (no-call) and `-32001` (call-consumed) stay in `acp-wire.ts`.

- [ ] **Step 4: Run it**

Run: `bun test test/jsonrpc.test.ts && bunx tsc --noEmit`
Expected: both clean.

- [ ] **Step 5: Commit**

```bash
git add src/jsonrpc.ts test/jsonrpc.test.ts
git commit -m "JSON-RPC validation module, ported from chronos-api

Notifications get no reply even on a validation error, per JSON-RPC 2.0 —
the reference implementation honours this explicitly and session/cancel is
a notification in ACP, so it is a live path here rather than a footnote."
```

---

### Task 2: Discovery file replaces the socket path

The socket path carried the env fingerprint (`~/.config/kkamak/acp-<fp>.sock`), which is what made the daemon a self-organizing singleton-per-fingerprint with no registry. A TCP port carries no fingerprint, so the mapping has to become an artifact.

**Files:** Modify `src/acp-paths.ts`, `test/acp-paths.test.ts`

**Interfaces:**
- Consumes: `envFingerprint(env)` (unchanged)
- Produces: `discoveryPath(env): string` → `~/.config/kkamak/acp-<fp>.json`; `readDiscovery(env): {port: number; pid: number} | undefined`; `writeDiscovery(env, {port, pid}): void`; `wsUrl(port): string`

- [ ] **Step 1: Write the failing test**

```ts
test("the discovery path is keyed by fingerprint, like the socket path was", () => {
  const a = discoveryPath({ FOO: "1" })
  const b = discoveryPath({ FOO: "2" })
  expect(a).not.toBe(b)
  expect(a.endsWith(".json")).toBe(true)
})

test("a secret's VALUE never reaches the filename", () => {
  const p = discoveryPath({ ANTHROPIC_API_KEY: "sk-super-secret-value" })
  expect(p).not.toContain("sk-super-secret-value")
})

test("write then read round-trips", () => {
  const env = { HOME: tmpHome(), KKAMAK_TEST: "rt" }
  writeDiscovery(env, { port: 45123, pid: 999 })
  expect(readDiscovery(env)).toMatchObject({ port: 45123, pid: 999 })
})

test("a missing discovery file reads as undefined, not a throw", () => {
  expect(readDiscovery({ HOME: tmpHome(), KKAMAK_TEST: "absent" })).toBeUndefined()
})
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test test/acp-paths.test.ts`
Expected: FAIL — the discovery functions don't exist.

- [ ] **Step 3: Implement**

Keep `envFingerprint` **exactly as-is** — including `ACP_SECRET_KEY_RE` redacting `KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL` as `KEY=set` before hashing. That behaviour is load-bearing and already tested.

Write the file with `mode: 0o600` and its directory `0o700`. The ruling above declines to *authenticate* on the wire, but there is no reason to make the port world-readable when the old socket dir was not — this costs nothing and keeps the file honest about who owns it.

Delete `socketPath`, `isPipe`, and `ensureSocketDir` once nothing references them. **`spawnLockPath` and `bindLockPath` stay** — the two-lock spawn protocol is transport-independent and still needed; just re-derive them from `discoveryPath` instead of `socketPath`.

- [ ] **Step 4: Run, then verify nothing dangles**

Run: `bun test test/acp-paths.test.ts`
Run: `grep -rn "socketPath\|ensureSocketDir\|isPipe" src/`
Expected: tests pass; grep returns only comments, if anything.

- [ ] **Step 5: Commit**

```bash
git add src/acp-paths.ts test/acp-paths.test.ts
git commit -m "discovery file replaces the socket path

The socket path encoded the env fingerprint, which is what made the daemon a
singleton per fingerprint with no registry. Ports carry no fingerprint, so the
mapping becomes ~/.config/kkamak/acp-<fp>.json (0600, dir 0700). envFingerprint
and the two spawn locks are unchanged — both are transport-independent."
```

---

### Task 3: Daemon serves WebSocket

**Files:** Modify `src/acp-daemon.ts`, `test/acp-daemon.test.ts`

**Interfaces:**
- Consumes: `validateJsonRpc` (Task 1), `writeDiscovery` (Task 2), `createDispatcher` (existing, unchanged)
- Produces: same `import.meta.main` entry point; no new exports

- [ ] **Step 1: Replace the server**

Follow `chronos-api-0.4.5/src/index.ts:59-161`, minus Koa:

```ts
import { WebSocketServer } from "ws"
import { createServer } from "node:http"

const wss = new WebSocketServer({ noServer: true })
const server = createServer()          // no Koa — this package serves no HTTP routes

server.on("upgrade", (req, socket, head) => {
  // RULING 2026-08-07: no Origin check, no token — every upgrade is accepted.
  // See the plan's RULING section for exactly what this admits and why.
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req))
})

wss.on("connection", (ws) => {
  // ONE write closure per connection — the same per-connection response routing
  // the unix socket had. This is what makes (connection, id) sufficient to
  // correlate responses; it is not new behaviour.
  const write: Write = (msg) => { try { ws.send(JSON.stringify(msg)) } catch { /* peer gone */ } }
  ws.on("message", (data) => {
    lastActivityAt = Date.now()
    void dispatch(JSON.parse(String(data)), write)   // route via validateJsonRpc
  })
})
```

- [ ] **Step 2: Delete the framing**

`encodeFrame` and `FrameDecoder` go. A WebSocket message **is** a frame — there is no `decoder.push(chunk)` loop, and no newline-delimitation rule to enforce. Remove them from `acp-wire.ts` and delete their tests.

**This also retires Task 9 from the previous plan.** That finding required a `session/prompt` and a `session/cancel` arriving in **one TCP chunk**, decoded in **one synchronous pass**, so the cancel landed after `drain()` had already crossed the send boundary. Over WebSocket those are two frames → two `'message'` events → two event-loop turns. The scenario cannot be constructed. Delete both `test.todo`s at `test/acp-daemon.test.ts:378` and `:1174` — with a commit-message note that they are being removed as unconstructible, not as unfixed.

- [ ] **Step 3: Bind and publish**

Listen on `127.0.0.1` with port `0` (kernel-assigned), read the actual port off `server.address()`, then `writeDiscovery(env, {port, pid: process.pid})`. Publishing *after* a successful bind is what makes the discovery file mean "a daemon is listening here", so a client never dials a port nothing owns.

Keep `bindWithTakeover`'s staleness semantics, re-expressed for ports: if a discovery file exists, try connecting; if the connect fails, treat the file as stale and take over.

- [ ] **Step 4: Green**

Run: `bun test && bunx tsc --noEmit`
Expected: both clean, `0 skip`, `0 todo`.

- [ ] **Step 5: Commit**

```bash
git add src/acp-daemon.ts src/acp-wire.ts test/
git commit -m "daemon serves WebSocket on 127.0.0.1

WebSocketServer({noServer:true}) + http.createServer with a manual upgrade
handler, following chronos-api's wiring (minus Koa — this package serves no
HTTP routes). Port is kernel-assigned and published to the discovery file only
after a successful bind, so the file always means 'someone is listening here'.

encodeFrame/FrameDecoder deleted: a WebSocket message is already a frame.

Removes both cancel-race test.todos as UNCONSTRUCTIBLE rather than unfixed —
they required a prompt and a cancel in one TCP chunk decoded in one synchronous
pass, which cannot happen when each is its own WebSocket frame and therefore
its own event-loop turn.

RULING 2026-08-07 (user): the upgrade handler performs no Origin check and
requires no token. See docs/superpowers/plans/2026-08-07-cc-api-daemon-websocket-transport.md."
```

---

### Task 4: Client connects over WebSocket

**Files:** Modify `src/acp-client.ts`, `test/acp-client.test.ts`

- [ ] **Step 1: Swap the connect**

`net.connect(socketPath)` → `readDiscovery(env)` then `new WebSocket(wsUrl(port))`. Everything else in `acp-client.ts` stays: connect-or-spawn, the two-lock protocol, `spawnDaemonProcess` (still `bun <DAEMON_ENTRY>` via the package-internal sibling path), the `initialize` fingerprint check, and Task 8's `daemonWorstCaseMs` budget check.

`ensureDaemon`'s `waitMs` poll now polls a TCP connect instead of a socket connect — same shape.

- [ ] **Step 2: Delete the decoder on the client side too**

Client-side `FrameDecoder` use goes; `ws.on("message", …)` yields whole JSON-RPC objects.

- [ ] **Step 3: Green**

Run: `bun test && bunx tsc --noEmit`

- [ ] **Step 4: Commit**

```bash
git add src/acp-client.ts test/acp-client.test.ts
git commit -m "client connects over WebSocket

Discovery file -> port -> ws://127.0.0.1:<port>. Connect-or-spawn, the two-lock
spawn protocol, the initialize fingerprint check, and the daemonWorstCaseMs
budget check are all unchanged — only the channel differs."
```

---

### Task 5: e2e, docs, and the security note

- [ ] **Step 1: Re-point the e2e**

`test/e2e.test.ts` keeps driving the real launch path (`ensureDaemon` → spawn → connect → `ApiSession` → stub). Only the transport differs. Give each test its own `HOME` so discovery files don't collide, and keep killing spawned daemons in `afterEach` — a survivor now holds a *port*, and a stale discovery file pointing at a dead port is the new wedge shape.

- [ ] **Step 2: Verify the credential invariant still holds**

Run: `env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN HOME=/tmp/no-creds bun test`
Expected: PASS. This is the `CLAUDE.md` rule and a CI step; a transport change must not weaken it.

- [ ] **Step 3: Update README.md and CLAUDE.md**

Both currently describe a unix socket. Rewrite the transport paragraphs, and **add a Security section stating the ruling plainly** — that the daemon accepts any local connection including from web pages, that this is deliberate, and what the mitigation would be if it is ever revisited. A reader who finds an unauthenticated localhost daemon holding API credentials should find the decision documented, not have to infer it.

- [ ] **Step 4: Green + commit**

```bash
git add -A
git commit -m "e2e over WebSocket; document the transport and the no-auth ruling

README and CLAUDE.md described a unix socket. Adds a Security section recording
that the daemon accepts every upgrade — including from browser pages, which
loopback binding does not prevent — that this is a deliberate ruling, and what
closing it would take."
```

---

## Self-review

**What carries over untouched, and why that's the point.** `ApiSession`, `call.ts`, `auth.ts`, `acp-pool.ts`, `session-contract.ts`, and `models.ts` are not edited by any task here. The send boundary, the outcome law, the FIFO, history-advances-only-on-ok, and the leak test are all above the transport. That the swap doesn't reach them is evidence the earlier layering was right.

**What genuinely gets simpler:** `encodeFrame` + `FrameDecoder` (~278 lines of `acp-wire.ts`) delete outright, and the cancel-race finding retires as unconstructible rather than unfixed.

**What gets harder, honestly:** the socket path was a self-organizing registry — fingerprint in the filename, collision-free, self-cleaning on unlink. The discovery file has to be written, read, and detected-stale by hand, and a stale file pointing at a dead or reused port is a failure mode the socket did not have. Task 3 Step 3 handles it; it is still new surface.

**Not addressed here, unchanged from the previous plan:** nothing consumes this package yet; nothing launches the daemon on a host as a matter of policy; and the pool cap of 4 and `turnTimeoutMs` of 16s are still sized for CLI subprocesses rather than HTTP calls.
