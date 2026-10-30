#!/usr/bin/env bash
# feishu-bridge one-click installer (macOS / Linux)
#
# Usage (from the project folder):
#   bash install.sh            # deps + setup wizard
#   bash install.sh --no-setup # deps only
#
# What it does:
#   1. Node >= 22.5 already on the system -> use it
#   2. otherwise -> download the official PORTABLE Node into .tools/node
#      (no install, no root, system untouched)
#   3. npm install
#   4. npm run setup (Feishu authorization + LLM key + business interview)
set -euo pipefail
cd "$(dirname "$0")"

NODE_DIR=".tools/node"
USED_PORTABLE=0

node_ok() {
  local exe="${1:-}"
  [ -n "$exe" ] && [ -x "$exe" ] || return 1
  local v maj min
  v="$("$exe" --version 2>/dev/null)" || return 1
  maj="${v#v}"; maj="${maj%%.*}"
  min="${v#*.}"; min="${min%%.*}"
  case "$maj$min" in *[^0-9]*) return 1 ;; esac
  if [ "$maj" -gt 22 ]; then return 0; fi
  if [ "$maj" -eq 22 ] && [ "$min" -ge 5 ]; then return 0; fi
  return 1
}

echo
echo " feishu-bridge one-click installer"
echo

if node_ok "$(command -v node || true)"; then
  echo "  System Node found: $(node --version)"
elif node_ok "$NODE_DIR/bin/node"; then
  export PATH="$PWD/$NODE_DIR/bin:$PATH"
  USED_PORTABLE=1
  echo "  Using project-local portable Node: $("$NODE_DIR/bin/node" --version)"
else
  echo "  Node >= 22.5 not found (required for built-in SQLite)."
  echo "  Downloading official PORTABLE Node (~45 MB, no install, no root)..."

  OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
  ARCH="$(uname -m)"
  case "$ARCH" in
    x86_64|amd64) NARCH="x64" ;;
    arm64|aarch64) NARCH="arm64" ;;
    *) echo "  Unsupported architecture: $ARCH. Install Node LTS manually instead."; exit 1 ;;
  esac
  case "$OS" in
    darwin) PLATFORM="darwin-$NARCH" ;;
    linux)  PLATFORM="linux-$NARCH" ;;
    *) echo "  Unsupported OS: $OS"; exit 1 ;;
  esac

  # Pick the newest even-major release >= 22.5 from the official index
  # (newest-first). Handles the pretty-printed JSON (space after colon) and
  # skips prerelease strings like "v27.0.0-alpha.1".
  VER="$(curl -fsSL --retry 3 https://nodejs.org/dist/index.json \
        | grep -Eo '"version": *"v[0-9]+\.[0-9]+\.[0-9]+"' \
        | sed 's/.*"\(v[0-9][0-9.]*\)".*/\1/' \
        | awk -F'[v.]' '{ m = $2 + 0; n = $3 + 0; if (m >= 22 && m % 2 == 0 && (m > 22 || n >= 5)) { print; exit } }')" || true

  if [ -z "${VER:-}" ]; then
    echo "  Could not resolve a usable Node version from nodejs.org."
    echo "  Install Node LTS manually (https://nodejs.org/) and re-run."
    exit 1
  fi

  PKG="node-${VER}-${PLATFORM}.tar.gz"
  TMP="$(mktemp)"
  trap 'rm -f "$TMP"' EXIT
  echo "  Fetching $PKG ..."
  curl -fL --retry 3 -o "$TMP" "https://nodejs.org/dist/${VER}/${PKG}"

  mkdir -p "$NODE_DIR"
  tar -xzf "$TMP" -C "$NODE_DIR" --strip-components=1
  rm -f "$TMP"

  if ! node_ok "$NODE_DIR/bin/node"; then
    echo "  Node unpacked but not runnable. Install Node LTS manually and re-run."
    exit 1
  fi
  export PATH="$PWD/$NODE_DIR/bin:$PATH"
  USED_PORTABLE=1
  echo "  Portable Node ready: $("$NODE_DIR/bin/node" --version)"
fi

echo
echo "  Installing dependencies: npm install"
npm install --no-fund --no-audit

if [ "${1:-}" = "--no-setup" ]; then
  echo
  echo "  Skipped the wizard. Run it later:  npm run setup"
else
  echo
  echo "  Starting the setup wizard: npm run setup"
  npm run setup
fi

if [ "$USED_PORTABLE" = "1" ]; then
  echo
  echo "  NOTE: Node lives inside this project ($PWD/$NODE_DIR)."
  echo "  In a NEW terminal before a manual \"npm start\", run:"
  echo "      export PATH=\"$PWD/$NODE_DIR/bin:\$PATH\""
fi
