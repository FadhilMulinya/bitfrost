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
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
UNIT_SRC="$DEPLOY_DIR/bifrostd.service"
UNIT_DST="/etc/systemd/system/bifrostd.service"

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
