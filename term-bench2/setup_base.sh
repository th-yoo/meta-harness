#!/usr/bin/env bash
# setup_base.sh — common tooling for all Terminal-Bench 2 tasks
# Run once per machine. Most packages are already installed on this system.
set -euo pipefail

BASE_PACKAGES=(
  build-essential
  git
  curl
  wget
  python3
  python3-pip
  sqlite3
  openssl
  ca-certificates
  unzip
  zip
  tmux
  asciinema
)

echo "[setup_base] Checking / installing common tooling..."
if [[ -z "${SKIP_APT:-}" ]]; then
  sudo apt-get update -qq
  sudo apt-get install -y --no-install-recommends "${BASE_PACKAGES[@]}"
  sudo rm -rf /var/lib/apt/lists/*
else
  echo "[setup_base] SKIP_APT=1 — skipping apt (packages assumed pre-installed)"
fi

# Ensure uv is available
if ! command -v uv >/dev/null 2>&1; then
  curl -LsSf https://astral.sh/uv/install.sh | sh
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
  export PATH="$HOME/.local/bin:$PATH"
fi

echo "[setup_base] Done."
