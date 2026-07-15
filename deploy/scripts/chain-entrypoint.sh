#!/usr/bin/env bash
# Boots the CKB dev chain, deploys fiber contracts, funds fnn node wallets,
# and runs udt-init to deploy the wrapped-BTC UDT and generate per-node
# config.yml files. Mirrors fiber's tests/nodes/start.sh preamble 1:1.
set -euo pipefail

WORK=/work            # bind mount of deploy/vendor/fiber-0.9.0-rc7
DEPLOY_DIR="$WORK/tests/deploy"
NODES_DIR="$WORK/tests/nodes"

echo "[chain] init-dev-chain (no-op if node-data exists)"
"$DEPLOY_DIR/init-dev-chain.sh"

echo "[chain] starting ckb with indexer"
ckb run -C "$DEPLOY_DIR/node-data" --indexer &
CKB_PID=$!

for i in $(seq 1 60); do
  nc -z 127.0.0.1 8114 && break
  sleep 1
done
nc -z 127.0.0.1 8114 || { echo "[chain] CKB RPC never came up"; exit 1; }

if [ ! -f "$NODES_DIR/3/config.yml" ]; then
  echo "[chain] running udt-init (deploys wrapped BTC UDT, writes node configs)"
  (cd "$WORK" && NODES_DIR="$NODES_DIR" udt-init)
else
  echo "[chain] node configs already generated, skipping udt-init"
fi

touch "$WORK/.chain-ready"
echo "[chain] ready — dev chain running, node configs generated"
wait "$CKB_PID"
