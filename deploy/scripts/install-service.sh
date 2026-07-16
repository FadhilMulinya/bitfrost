#!/usr/bin/env bash
# Installs bifrostd as a systemd service on a bare-metal/VM host (e.g. the
# ubuntu user on an EC2 box) — NOT for the deploy/docker-compose.dev.yml dev
# stack, which runs bifrostd inside its own container. Run this ON the
# target host after cloning the repo there and building bifrostd
# (`cd bifrostd && npm install && npm run build`).
#
# Requires: sudo, systemd. Must be run as a user with sudo rights (root not
# required to invoke this script — only the copy/systemctl calls below use
# sudo explicitly, so nothing here needs YOU to already be root).
#
# Usage: install-service.sh [--dry-run]
#   --dry-run   print what would happen without copying the unit file or
#               calling systemctl.
set -euo pipefail

DRY_RUN=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    *)
      echo "FATAL: unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$DEPLOY_DIR/bifrostd.service"
UNIT_DST="/etc/systemd/system/bifrostd.service"
NODE_BIN="/usr/bin/node"

if [ ! -f "$UNIT_SRC" ]; then
  echo "FATAL: $UNIT_SRC not found" >&2
  exit 1
fi

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "WARNING: $DEPLOY_DIR/.env does not exist yet — bifrostd.service's" >&2
  echo "         EnvironmentFile= points at it and the service will fail to" >&2
  echo "         start until it exists. Copy deploy/.env.example and fill in" >&2
  echo "         UDT_CODE_HASH / WBTC_ARGS (required, no default) first." >&2
fi

# bifrostd.service's ExecStart= hardcodes /usr/bin/node (see the unit file's
# comment on why: systemd services don't see nvm shims on PATH). Fail loudly
# here, at install time, rather than silently at service-start time.
if [ ! -x "$NODE_BIN" ]; then
  echo "node not found at /usr/bin/node — if you use nvm, run: sudo ln -s $(which node) /usr/bin/node" >&2
  exit 1
fi

if $DRY_RUN; then
  echo "[install-service] --dry-run: would run the following:"
  echo "  cp \"$UNIT_SRC\" \"$UNIT_DST\""
  echo "  systemctl daemon-reload"
  echo "  systemctl enable bifrostd"
  echo "  systemctl start bifrostd"
  echo "  systemctl status bifrostd --no-pager"
  exit 0
fi

echo "[install-service] copying $UNIT_SRC -> $UNIT_DST"
sudo cp "$UNIT_SRC" "$UNIT_DST"

echo "[install-service] daemon-reload"
sudo systemctl daemon-reload

echo "[install-service] enabling + starting bifrostd"
sudo systemctl enable bifrostd
sudo systemctl start bifrostd

echo
echo "[install-service] status:"
sudo systemctl status bifrostd --no-pager || true
