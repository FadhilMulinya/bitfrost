#!/usr/bin/env bash
# QA attack (SYSTEM-DESIGN §5.3 refund path / threat row "outgoing fails"):
# kill lnd-hub while an order is mid-swap and assert the OrderEngine drives
# REFUNDING → FAILED and the client's held Fiber TLC is released.
# Restarts lnd-hub afterwards regardless of outcome.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

SIGNAL_DIR="$DEPLOY_DIR/.qa-attack"
rm -rf "$SIGNAL_DIR"; mkdir -p "$SIGNAL_DIR"
cleanup() {
  echo "[qa-attack] restarting lnd-hub"
  compose start lnd-hub >/dev/null 2>&1 || compose up -d lnd-hub >/dev/null 2>&1 || true
  rm -rf "$SIGNAL_DIR"
}
trap cleanup EXIT

echo "[qa-attack] 0/3 building bifrostd"
(cd "$REPO_DIR/sdk" && npm run --silent build)
(cd "$REPO_DIR/bifrostd" && npm run --silent build)

echo "[qa-attack] 1/3 launching attack runner (creates order, then waits for the kill)"
compose exec -T \
  -e UDT_CODE_HASH="$UDT_CODE_HASH" \
  -e WBTC_ARGS="$WBTC_ARGS" \
  -e QA_SIGNAL_DIR=/repo/deploy/.qa-attack \
  bifrostd node /repo/bifrostd/dist/smoke/attack-refund.js &
RUNNER_PID=$!

retry 60 1 "runner READY signal" test -f "$SIGNAL_DIR/ready"

echo "[qa-attack] 2/3 killing lnd-hub mid-swap"
compose stop lnd-hub
touch "$SIGNAL_DIR/killed"

echo "[qa-attack] 3/3 waiting for the runner's verdict"
if wait "$RUNNER_PID"; then
  echo
  echo "=== QA ATTACK DEFEATED: refund path held (REFUNDING → FAILED, TLC released) ==="
else
  echo "=== QA ATTACK SUCCEEDED AGAINST THE ENGINE — refund path is broken ===" >&2
  exit 1
fi
