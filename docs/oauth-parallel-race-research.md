# OAuth `--parallel` race — research (2026-07-16)

The evidence trail behind the harness's decision to forbid OAuth under `--parallel`.
This doc is the **investigation/evidence** record; the **decision** (surface, don't
handle) lives in [auth-delegation-design.md](auth-delegation-design.md).

## Question

Does concurrent bench execution (`--parallel`: N podman-sandboxed agents sharing one
credential store) actually race/corrupt the Anthropic OAuth credential — or is the
`--parallel` key-mandate (D4: no oauth under `--parallel`, `ANTHROPIC_API_KEY`
required) over-strict? The mandate rested on a single unverified `agent-auth.ts`
code comment; the user flagged that as a big open assumption.

## Answer

The race is **REAL** and the mandate is **justified** for its intended use — but the
original framing ("the refresh token is rotated **on use** / per task") is imprecise:
rotation fires **per refresh (~8h access-token expiry), NOT per task.**

## Mechanism

Anthropic OAuth uses **single-use (rotating) refresh tokens**: a refresh exchange
invalidates the old refresh token server-side and returns a new access+refresh pair.
The access token TTL is **hours** (~8h subscription, up to 24h reported). N processes
sharing one `~/.claude/.credentials.json` / `auth.json` with **no file-locking** →
the first to refresh wins and rewrites the file; the others still hold the now-invalid
old refresh token → their next refresh is rejected (401 / forced re-login).

## Evidence

**1. Anthropic's own `claude-code` tracker (authoritative):**
- [#22600](https://github.com/anthropics/claude-code/issues/22600) (2026-02-02, closed) — "OAuth refresh token race condition in multi-instance scenarios": *A refreshes → server invalidates old refresh token, issues new; B (old token) → rejected → restart to pick up new token.* The exact mechanism.
- [#48786](https://github.com/anthropics/claude-code/issues/48786) (2026-04-15) — 4–7 concurrent CLI sessions share one `.credentials.json`, **no file-locking**, access-token TTL **~8h**; on expiry all-but-one are logged out.
- [#24317](https://github.com/anthropics/claude-code/issues/24317) — "refresh tokens are typically single-use... the old is invalidated server-side."
- [#28256](https://github.com/anthropics/claude-code/issues/28256) — "refresh token rotation causes one session to invalidate the other's stored token."

**2. Local confirmation (this host, non-destructive):**
- `~/.claude/.credentials.json` → `{accessToken, refreshToken, expiresAt, refreshTokenExpiresAt, scopes, subscriptionType, rateLimitTier}`. **`expiresAt` ≈ 8h out** → access TTL ~8h, *not* per-task. A `refreshTokenExpiresAt` field exists too (the refresh token also expires).
- **No `flock`/mutex/grace/retry** anywhere in `agent-auth.ts` / `paths.ts` — the harness adds no coordination, and (per the issues above) neither does CC.

**3. Reverse-engineered token endpoint** (third-party `claude-swap`, strong reference, not an Anthropic spec): `POST https://platform.claude.com/v1/oauth/token`, 5-minute expiry buffer. Confirms the refresh-exchange shape.

## Precise characterization

- The race fires **per refresh (~8h expiry), NOT per task** → 0–1 refreshes per run.
- **Short** parallel runs that finish within the token TTL never refresh → **safe**.
- **Long / overnight** sweeps cross the ~8h boundary → the race fires, N−1 containers
  are knocked out at that single moment.

## Implication for the scheduler (D4)

- The `--parallel` key-mandate is **justified** for the intended use (long sweeps —
  they *will* cross the boundary). A static API key has no refresh → no rotation → no
  race; the `keyOnly` path removes the shared rw `auth.json` mount
  (`/root/.local/share/opencode`), the exact race surface.
- Strictly **slightly over-strict** for short runs under the TTL (those would be safe
  with shared oauth), but run duration can't be reliably predicted up front, so the
  fail-safe blanket guard is defensible.

## Decision & implementation (see the design note)

- **Surface, don't handle** ([auth-delegation-design.md](auth-delegation-design.md)):
  `validateParallel` (`cli.ts`, shared by `run`+`ab`) rejects oauth+parallel up front;
  the user chooses **serial** (oauth-safe) or a **static key** (`keyOnly`).
- **Rejected:** single-flight refresh coordinator (CC #22600's own proposed fix) —
  re-implements agent-side coordination; and duration-gated allowance — fragile.
- **Tested:** `bench-cli-ab.test.ts` (the `ab --parallel` guard fires) +
  `bench-agent-auth.test.ts` (keyOnly removes the race surface) — commit `46131ec`.

## Why no destructive live experiment

The `resume.md` sandbox experiment (race two containers on a *copied* auth dir) is
**not needed**: existence is proven by Anthropic's own tracker, and any real refresh
with the live refresh token rotates + invalidates it — which would log the user out
of Claude Code (the asymmetric risk originally flagged). Verification here is
literature + local structural confirmation, deliberately non-destructive.
