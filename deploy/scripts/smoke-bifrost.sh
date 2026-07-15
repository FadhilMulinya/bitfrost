#!/usr/bin/env bash
# Bifrost end-to-end smoke test: full HTLC swaps through bifrostd's
# OrderEngine + real adapters (NOT stock CCH), BOTH directions:
#   1) FIBER_TO_LN  — fnn-client pays the hub's Fiber wBTC hold invoice,
#                     hub pays the payee's BOLT11, preimage settles the hold.
#   2) LN_TO_FIBER  — lnd-payee pays the hub's LN hold invoice, hub pays the
#                     client's Fiber invoice, PutPreimage settles the hold.
# Direction 1 runs first ON PURPOSE: it gives lnd-payee outbound sats and the
# hub Fiber-channel balance, which direction 2 spends back.
#
# Prereqs: docker compose up + fund-regtest.sh (same as smoke-cch.sh).
# The runner executes INSIDE the bifrostd container (node:22, repo at /repo)
# because no RPC is published to the host.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

jqr() { local json=$1 f=$2; printf '%s' "$json" | compose exec -T ckb jq -r "$f"; }

AMT1="${BIFROST_SMOKE_AMT1:-50000}"   # sats, FIBER_TO_LN
AMT2="${BIFROST_SMOKE_AMT2:-20000}"   # sats, LN_TO_FIBER

echo "[smoke-bifrost] 0/5 building sdk + bifrostd (host toolchain, pure-JS output)"
(cd "$REPO_DIR/sdk" && npm run --silent build)
(cd "$REPO_DIR/bifrostd" && npm run --silent build)

echo "[smoke-bifrost] 1/5 verifying LN topology (hub->payee channel, hold-invoice support)"
if ! lncli_hub addholdinvoice --help >/dev/null 2>&1; then
  echo "FATAL: lnd-hub lacks invoicesrpc (hold invoices)" >&2; exit 1
fi
lncli_hub listchannels | compose exec -T ckb jq -e '.channels | length > 0' >/dev/null \
  || { echo "FATAL: lnd-hub has no channels — run fund-regtest.sh first" >&2; exit 1; }

echo "[smoke-bifrost] 2/5 ensuring Fiber wBTC channel client->hub is CHANNEL_READY"
rpc "$FNN_CLIENT_PORT" connect_peer "[{\"address\":\"$NODE3_ADDR\"}]" >/dev/null || true
sleep 2
chan_ready() {
  rpc "$CKB_PORT" generate_epochs '["0x1"]' >/dev/null
  local ch
  ch=$(rpc "$FNN_CLIENT_PORT" list_channels "[{\"peer_id\":null}]")
  printf '%s' "$ch" | compose exec -T ckb jq -e \
    '.result.channels[]? | select(.state.state_name == "ChannelReady")' >/dev/null 2>&1
}
if chan_ready; then
  echo "                reusing existing ready channel"
else
  FUNDING_HEX=$(codec encode-u128 200000)
  OPEN=$(rpc "$FNN_CLIENT_PORT" open_channel "[{\"pubkey\":\"$NODE3_PUBKEY\",\"funding_amount\":\"$FUNDING_HEX\",\"funding_udt_type_script\":{\"code_hash\":\"$UDT_CODE_HASH\",\"hash_type\":\"data2\",\"args\":\"$WBTC_ARGS\"}}]")
  if [ "$(jqr "$OPEN" '.error')" != "null" ]; then
    echo "open_channel failed: $OPEN" >&2; exit 1
  fi
fi
retry 40 3 "fiber channel CHANNEL_READY" chan_ready

run_swap() { # run_swap <direction> <amt>
  compose exec -T \
    -e UDT_CODE_HASH="$UDT_CODE_HASH" \
    -e WBTC_ARGS="$WBTC_ARGS" \
    bifrostd node /repo/bifrostd/dist/smoke/runner.js "$1" --amt "$2"
}

echo "[smoke-bifrost] 3/5 swap #1: FIBER_TO_LN ($AMT1 sat) through the OrderEngine"
run_swap fiber_to_ln "$AMT1"

echo "[smoke-bifrost] 4/5 swap #2: LN_TO_FIBER ($AMT2 sat) through the OrderEngine"
run_swap ln_to_fiber "$AMT2"

echo "[smoke-bifrost] 5/5 both directions complete"
echo
echo "=== BIFROSTD SWAPS SUCCEEDED (FIBER_TO_LN + LN_TO_FIBER) ==="
