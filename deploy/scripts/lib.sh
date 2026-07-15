#!/usr/bin/env bash
# Shared helpers for deploy scripts. Everything runs via `docker compose exec`
# inside the stack's shared network namespace — no RPC is exposed to the host.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
DEPLOY_DIR="$(dirname "$SCRIPT_DIR")"
REPO_DIR="$(dirname "$DEPLOY_DIR")"

if [ ! -f "$DEPLOY_DIR/.env" ]; then
  echo "deploy/.env missing — copy deploy/.env.example and adjust." >&2
  exit 1
fi
# shellcheck disable=SC1091
source "$DEPLOY_DIR/.env"

compose() {
  docker compose -f "$DEPLOY_DIR/docker-compose.dev.yml" --env-file "$DEPLOY_DIR/.env" "$@"
}

btc() {
  compose exec -T bitcoind bitcoin-cli -regtest \
    -rpcuser="$BITCOIN_RPC_USER" -rpcpassword="$BITCOIN_RPC_PASS" "$@"
}

lncli_hub() {
  compose exec -T lnd-hub lncli --network=regtest --no-macaroons \
    --lnddir=/work/tests/deploy/lnd-init/lnd-ingrid --rpcserver=localhost:10009 "$@"
}

lncli_payee() {
  compose exec -T lnd-payee lncli --network=regtest --no-macaroons \
    --lnddir=/work/tests/deploy/lnd-init/lnd-bob --rpcserver=localhost:11009 "$@"
}

# JSON-RPC against any 127.0.0.1 port inside the namespace (curl+jq live in
# the ckb/chain-init image). $1=port $2=method $3=params-json
rpc() {
  local port=$1 method=$2 params=$3
  compose exec -T ckb curl -sS -X POST "http://127.0.0.1:${port}" \
    -H 'Content-Type: application/json' \
    -d "{\"id\":42,\"jsonrpc\":\"2.0\",\"method\":\"${method}\",\"params\":${params}}"
}

# THE codec module (bifrostd/src/fnn/codec.ts) — single source of hex truth.
codec() {
  if [ ! -f "$REPO_DIR/bifrostd/dist/fnn/codec.js" ]; then
    (cd "$REPO_DIR/bifrostd" && npm run --silent build)
  fi
  node "$REPO_DIR/bifrostd/src/fnn/codec-cli.mjs" "$@"
}

retry() { # retry <n> <sleep_s> <desc> <cmd...>
  local n=$1 s=$2 desc=$3; shift 3
  for i in $(seq 1 "$n"); do
    if "$@"; then return 0; fi
    echo "  waiting: $desc ($i/$n)"
    sleep "$s"
  done
  echo "FAILED waiting for: $desc" >&2
  return 1
}

# Constants from the vendored fiber test fixtures (tests/bruno/environments).
CKB_PORT=8114
FNN_CLIENT_PORT=21714
FNN_HUB_PORT=21716
NODE3_ADDR="/ip4/127.0.0.1/tcp/8346/p2p/QmaFDJb9CkMrXy7nhTWBY5y9mvuykre3EzzRsCJUAVXprZ"
NODE3_PUBKEY="03032b99943822e721a651c5a5b9621043017daa9dc3ec81d83215fd2e25121187"
NODE1_PUBKEY="02a64b8993f33b2ebd37a4de1c9441f491291a4e779da8e519bcfb7c1f3f56c9c0"
UDT_CODE_HASH="0xe1e354d6d643ad42724d40967e334984534e0367405c5ae42a9d7d63d77df419"
WBTC_ARGS="0x32e555f3ff8e135cece1351a6a2971518392c1e30375c1e006ad0ce8eac07947"
export CKB_PORT FNN_CLIENT_PORT FNN_HUB_PORT NODE3_ADDR NODE3_PUBKEY NODE1_PUBKEY UDT_CODE_HASH WBTC_ARGS
