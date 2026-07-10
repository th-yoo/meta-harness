#!/usr/bin/env bash
# oc-env.sh — build a fully ISOLATED opencode environment in a temp dir so the
# smoke harness can seed fixtures and launch real opencode TUI sessions WITHOUT
# ever touching the user's real store (~/.config/opencode/.meta-harness or
# <repo>/.meta-harness).
#
# Isolation = temp XDG_CONFIG_HOME + temp XDG_DATA_HOME + temp project dir.
#   - account mh store  -> $OC_CONFIG/opencode/.meta-harness   (temp)
#   - project mh store  -> $OC_PROJ/.meta-harness              (temp)
#   - auth              -> $OC_DATA/opencode/auth.json         (copied real creds)
#   - mh plugin         -> loaded via $OC_PROJ/opencode.json (ABSOLUTE path)
#
# Token-free-ness of tier-A comes from NOT prompting the model (slash commands
# don't call the LLM), NOT from missing auth — auth is copied so opencode starts
# clean.
#
# Exports: OC_ENV OC_CONFIG OC_DATA OC_PROJ OC_ROLE_ROOT REPO_ROOT
# Functions: mk_oc_env  seed_file  rm_oc_env  oc_env_prefix

set -u

# Resolve the meta-harness repo root from this script's location (works no matter
# the caller's cwd).
REPO_ROOT="$(git -C "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)" rev-parse --show-toplevel)"
export REPO_ROOT

# The real auth file (XDG_DATA_HOME, survives XDG_CONFIG_HOME isolation).
REAL_AUTH="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"

# Build the isolated env. Sets OC_ENV/OC_CONFIG/OC_DATA/OC_PROJ + seeds a
# baseline project-role store so /mh-status renders a project-role line.
mk_oc_env() {
  OC_ENV="$(mktemp -d "${TMPDIR:-/tmp}/mh-smoke.XXXXXX")"
  OC_CONFIG="$OC_ENV/config"
  OC_DATA="$OC_ENV/data"
  OC_PROJ="$OC_ENV/proj"
  export OC_ENV OC_CONFIG OC_DATA OC_PROJ

  mkdir -p "$OC_CONFIG/opencode" "$OC_DATA/opencode" "$OC_PROJ"

  # opencode derives the project `worktree` by walking up for a .git dir. Without
  # one, it resolves to filesystem root "/" and the plugin tries to mkdir
  # "/.meta-harness" (EACCES) and fails to load. A bare `git init` makes the temp
  # project the worktree boundary.
  git -C "$OC_PROJ" init -q

  # Account config: auth plugin only (path-independent npm plugin). Drop the
  # real account's mcp block for fast, side-effect-free startup.
  printf '%s\n' '{"$schema":"https://opencode.ai/config.json","plugin":["opencode-claude-auth@latest"]}' \
    > "$OC_CONFIG/opencode/opencode.json"

  # Copy real auth so opencode starts without an auth prompt. Missing auth would
  # not block tier-A (no model call) but can slow/complicate TUI startup.
  if [ -f "$REAL_AUTH" ]; then
    cp "$REAL_AUTH" "$OC_DATA/opencode/auth.json"
  fi

  # Project config: the mh plugin by ABSOLUTE path (relative paths resolve
  # against the config file, so absolute is required from a temp dir).
  printf '{"$schema":"https://opencode.ai/config.json","plugin":["%s/opencode-plugin/src/index.ts"]}\n' \
    "$REPO_ROOT" > "$OC_PROJ/opencode.json"

  # The mh-* agent + slash-command definitions live in the repo's .opencode/
  # (agents/mh-build.md, commands/mh-*.md) plus the plugin's installed deps
  # (.opencode/node_modules). These are STATIC config — the plugin only mutates
  # .meta-harness (temp) and the account store (temp XDG) — so symlinking the
  # real .opencode read-only is safe and makes `--agent mh-build` + the slash
  # commands resolve without a per-run npm install.
  ln -s "$REPO_ROOT/.opencode" "$OC_PROJ/.opencode"

  # Seed a baseline project-role (mh-build) store: active v0 + empty candidate.
  OC_ROLE_ROOT="$OC_PROJ/.meta-harness/roles/mh-build"
  export OC_ROLE_ROOT
  mkdir -p "$OC_ROLE_ROOT/active" "$OC_ROLE_ROOT/candidates/v0"
  printf 'v0' > "$OC_ROLE_ROOT/active/.version"
  printf '# baseline system prompt\n' > "$OC_ROLE_ROOT/active/system.md"
  printf '{"version":"v0","nPass":0,"nFail":0,"sessions":[]}\n' \
    > "$OC_ROLE_ROOT/candidates/v0/score.json"
}

# seed_file <relpath-under-OC_PROJ> <content>
# Writes a fixture (JSON / flag file) under the temp project, creating parents.
seed_file() {
  local rel="$1" content="$2" abs
  abs="$OC_PROJ/$rel"
  mkdir -p "$(dirname "$abs")"
  printf '%s' "$content" > "$abs"
}

# Env prefix that points opencode at the isolated config/data dirs.
oc_env_prefix() {
  printf 'XDG_CONFIG_HOME=%s XDG_DATA_HOME=%s TERM=xterm-256color' "$OC_CONFIG" "$OC_DATA"
}

# Tear the env down. Safe to call multiple times.
rm_oc_env() {
  [ -n "${OC_ENV:-}" ] && [ -d "$OC_ENV" ] && rm -rf "$OC_ENV"
  unset OC_ENV OC_CONFIG OC_DATA OC_PROJ OC_ROLE_ROOT
}
