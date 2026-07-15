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

# ---------------------------------------------------------------------------
# Liquidity preflight (shared by smoke-cch.sh and smoke-bifrost.sh)
#
# Smoke runs are not idempotent: each successful swap drains one side's
# channel balance, and aborted runs can leave HELD invoices/TLCs locking
# liquidity. These helpers make "does this channel actually have enough
# *spendable* balance" an explicit, printed check instead of the old
# CHANNEL_READY-only reuse logic (which says nothing about capacity).
#
# FNN's list_channels already nets outstanding outbound TLC exposure via
# offered_tlc_balance — see docs/RPC-NOTES.md for the field-by-field notes
# and why there's no separate "reserve" concept on the Fiber side.
# ---------------------------------------------------------------------------

SMOKE_STATE_DIR="$DEPLOY_DIR/.smoke-state"
FIBER_STALE_HASHES_FILE="$SMOKE_STATE_DIR/fiber-stale-hashes.txt"

# fiber_chan_ready <port> — true if any channel on that node is ChannelReady.
fiber_chan_ready() {
  local port=$1 ch
  rpc "$CKB_PORT" generate_epochs '["0x1"]' >/dev/null
  ch=$(rpc "$port" list_channels '[{"peer_id":null}]')
  printf '%s' "$ch" | compose exec -T ckb jq -e \
    '.result.channels[]? | select(.state.state_name == "ChannelReady")' >/dev/null 2>&1
}

# fiber_spendable_outbound <port> — sum of (local_balance - offered_tlc_balance)
# across all ChannelReady channels on that node, in wBTC units (decimal).
fiber_spendable_outbound() {
  local port=$1 ch lines lb otlc total=0
  ch=$(rpc "$port" list_channels '[{"peer_id":null}]')
  lines=$(printf '%s' "$ch" | compose exec -T ckb jq -r \
    '.result.channels[]? | select(.state.state_name=="ChannelReady") | "\(.local_balance) \(.offered_tlc_balance)"')
  while read -r lb_hex otlc_hex; do
    [ -z "$lb_hex" ] && continue
    lb=$(codec decode-u128 "$lb_hex")
    otlc=$(codec decode-u128 "$otlc_hex")
    total=$((total + lb - otlc))
  done <<EOF
$lines
EOF
  echo "$total"
}

# record_fiber_hash <hash> — remember a hold-invoice payment_hash this run
# created, so a NEXT run's preflight can cancel it if this run aborts before
# settling/cancelling it itself.
record_fiber_hash() {
  mkdir -p "$SMOKE_STATE_DIR"
  printf '%s\n' "$1" >> "$FIBER_STALE_HASHES_FILE"
}

# clear_fiber_hash <hash> — this run settled/cancelled the hash itself; no
# need for the next run to clean it up.
clear_fiber_hash() {
  [ -f "$FIBER_STALE_HASHES_FILE" ] || return 0
  grep -v -F "$1" "$FIBER_STALE_HASHES_FILE" > "$FIBER_STALE_HASHES_FILE.tmp" 2>/dev/null || true
  mv "$FIBER_STALE_HASHES_FILE.tmp" "$FIBER_STALE_HASHES_FILE" 2>/dev/null || true
}

# cancel_stale_fiber_invoices <port> — best-effort cancel_invoice for every
# hash recorded by a prior aborted run. FNN exposes no list_invoices RPC
# (verified live, see docs/RPC-NOTES.md), so this is the only cleanup path
# available without node-side enumeration.
cancel_stale_fiber_invoices() {
  local port=$1
  [ -f "$FIBER_STALE_HASHES_FILE" ] || return 0
  while read -r h; do
    [ -z "$h" ] && continue
    echo "        cancelling stale fiber hold invoice $h"
    rpc "$port" cancel_invoice "[{\"payment_hash\":\"$h\"}]" >/dev/null 2>&1 || true
  done < "$FIBER_STALE_HASHES_FILE"
  rm -f "$FIBER_STALE_HASHES_FILE"
}

# cancel_stale_ln_holds <lncli_fn> — cancel any hold invoice stuck in
# ACCEPTED (TLC held, awaiting settle) on that node from a prior aborted run.
cancel_stale_ln_holds() {
  local fn=$1 hashes
  hashes=$("$fn" listinvoices --pending_only=true | compose exec -T ckb jq -r \
    '.invoices[]? | select(.state=="ACCEPTED") | .r_hash')
  [ -z "$hashes" ] && return 0
  while read -r rh; do
    [ -z "$rh" ] && continue
    echo "        cancelling stale LN hold invoice $rh"
    "$fn" cancelinvoice "$rh" >/dev/null 2>&1 || true
  done <<EOF
$hashes
EOF
}

# ln_spendable_outbound <lncli_fn> — sum of (local_balance - chan_reserve -
# unsettled_balance) across active channels, in sats (decimal).
ln_spendable_outbound() {
  local fn=$1 lines lb reserve unsettled total=0
  lines=$("$fn" listchannels | compose exec -T ckb jq -r \
    '.channels[]? | select(.active==true) | "\(.local_balance) \(.local_chan_reserve_sat) \(.unsettled_balance)"')
  while read -r lb reserve unsettled; do
    [ -z "$lb" ] && continue
    total=$((total + lb - reserve - unsettled))
  done <<EOF
$lines
EOF
  echo "$total"
}

# ensure_fiber_capacity <port> <pubkey> <required> [open_multiplier=4]
#
# Order: reuse the existing ChannelReady channel if it already has enough
# spendable outbound (>= required, which the caller must have already added
# fee headroom to) -> clean up stale hold invoices and recheck -> open a
# fresh channel sized open_multiplier * required so several consecutive
# runs work without hitting this again.
ensure_fiber_capacity() {
  local port=$1 pubkey=$2 required=$3 mult=${4:-4}
  local spendable
  spendable=$(fiber_spendable_outbound "$port")
  echo "        fiber spendable outbound: $spendable (need >= $required)"
  if fiber_chan_ready "$port"; then
    if [ "$spendable" -ge "$required" ]; then
      echo "        reusing existing ready channel — sufficient liquidity"
      return 0
    fi
    echo "        insufficient liquidity — cleaning up stale hold invoices"
    cancel_stale_fiber_invoices "$port"
    spendable=$(fiber_spendable_outbound "$port")
    echo "        fiber spendable outbound after cleanup: $spendable"
    if [ "$spendable" -ge "$required" ]; then
      echo "        reusing existing ready channel — sufficient liquidity after cleanup"
      return 0
    fi
  fi
  local seed=$((required * mult))
  echo "        opening fresh channel sized ${seed} wBTC units (${mult}x required)"
  local FUNDING_HEX OPEN
  FUNDING_HEX=$(codec encode-u128 "$seed")
  OPEN=$(rpc "$port" open_channel "[{\"pubkey\":\"$pubkey\",\"funding_amount\":\"$FUNDING_HEX\",\"funding_udt_type_script\":{\"code_hash\":\"$UDT_CODE_HASH\",\"hash_type\":\"data2\",\"args\":\"$WBTC_ARGS\"}}]")
  if [ "$(printf '%s' "$OPEN" | compose exec -T ckb jq -r '.error')" != "null" ]; then
    echo "open_channel failed: $OPEN" >&2
    return 1
  fi
  retry 40 3 "fiber channel CHANNEL_READY" fiber_chan_ready "$port"
}

# ensure_ln_capacity <lncli_fn> <remote_pubkey> <remote_addr> <required> [open_multiplier=4]
#
# Same order as ensure_fiber_capacity. Opening a fresh channel only succeeds
# if <lncli_fn>'s node has enough on-chain wallet balance to fund it (true
# for lnd-hub; NOT true for lnd-payee, which fund-regtest.sh never gives an
# on-chain balance — by design, direction 1 of smoke-bifrost.sh is what
# gives lnd-payee outbound capacity). When the open fails for that reason,
# fail loudly with a pointer to --rebalance / --fresh instead of pretending.
ensure_ln_capacity() {
  local fn=$1 pubkey=$2 addr=$3 required=$4 mult=${5:-4}
  local spendable
  spendable=$(ln_spendable_outbound "$fn")
  echo "        LN ($fn) spendable outbound: $spendable (need >= $required)"
  if [ "$spendable" -ge "$required" ]; then
    echo "        reusing existing channel — sufficient liquidity"
    return 0
  fi
  echo "        insufficient liquidity — cleaning up stale hold invoices"
  cancel_stale_ln_holds "$fn"
  spendable=$(ln_spendable_outbound "$fn")
  echo "        LN ($fn) spendable outbound after cleanup: $spendable"
  if [ "$spendable" -ge "$required" ]; then
    echo "        reusing existing channel — sufficient liquidity after cleanup"
    return 0
  fi
  local seed=$((required * mult))
  echo "        opening fresh channel sized ${seed} sat (${mult}x required)"
  "$fn" connect "$addr" >/dev/null 2>&1 || true
  if ! "$fn" openchannel --node_key "$pubkey" --local_amt "$seed" --sat_per_vbyte 1 --min_confs 0 >/dev/null 2>&1; then
    echo "FATAL: $fn cannot open a fresh channel to $pubkey (likely no on-chain balance)." >&2
    echo "       Run with --fresh for a clean baseline, or --rebalance after a run to keep this side funded." >&2
    return 1
  fi
  btc generatetoaddress 3 "$(btc getnewaddress)" >/dev/null
  _ln_chan_active() { "$fn" listchannels | grep -q '"active": true'; }
  retry 30 2 "LN channel active ($fn)" _ln_chan_active
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
