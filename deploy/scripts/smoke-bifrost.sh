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
#
# Flags:
#   --fresh       docker compose down -v + reprovision for a guaranteed-clean
#                 baseline (use in CI).
#   --rebalance   after both swaps succeed, hub pays the client back AMT1
#                 wBTC units (plain fiber payment) so repeated runs stay
#                 above the liquidity floor.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

jqr() { local json=$1 f=$2; printf '%s' "$json" | compose exec -T ckb jq -r "$f"; }
headroom() { local amt=$1; echo $((amt + (amt + 9) / 10)); } # +10%, integer ceiling

FRESH=0
REBALANCE=0
for a in "$@"; do
  case "$a" in
    --fresh) FRESH=1 ;;
    --rebalance) REBALANCE=1 ;;
  esac
done

if [ "$FRESH" = 1 ]; then
  echo "[smoke-bifrost] --fresh: tearing down and reprovisioning the stack for a clean baseline"
  compose down -v
  git -C "$REPO_DIR" clean -fdx deploy/vendor
  compose up -d --build --wait
  "$SCRIPT_DIR/fund-regtest.sh"
fi

AMT1="${BIFROST_SMOKE_AMT1:-50000}"   # sats, FIBER_TO_LN
AMT2="${BIFROST_SMOKE_AMT2:-20000}"   # sats, LN_TO_FIBER

echo "[smoke-bifrost] 0/6 building sdk + bifrostd (host toolchain, pure-JS output)"
(cd "$REPO_DIR/sdk" && npm run --silent build)
(cd "$REPO_DIR/bifrostd" && npm run --silent build)

echo "[smoke-bifrost] 1/6 verifying LN topology (hub->payee channel, hold-invoice support)"
if ! lncli_hub addholdinvoice --help >/dev/null 2>&1; then
  echo "FATAL: lnd-hub lacks invoicesrpc (hold invoices)" >&2; exit 1
fi
lncli_hub listchannels | compose exec -T ckb jq -e '.channels | length > 0' >/dev/null \
  || { echo "FATAL: lnd-hub has no channels — run fund-regtest.sh first" >&2; exit 1; }

HUB_KEY=$(lncli_hub getinfo | compose exec -T ckb jq -r .identity_pubkey)
PAYEE_KEY=$(lncli_payee getinfo | compose exec -T ckb jq -r .identity_pubkey)

echo "[smoke-bifrost] 2/6 ensuring Fiber wBTC channel client<->hub has spendable capacity"
rpc "$FNN_CLIENT_PORT" connect_peer "[{\"address\":\"$NODE3_ADDR\"}]" >/dev/null || true
sleep 2
echo "        client->hub leg (funds swap #1, FIBER_TO_LN pay of $AMT1)"
ensure_fiber_capacity "$FNN_CLIENT_PORT" "$NODE3_PUBKEY" "$(headroom "$AMT1")"
echo "        hub->client leg (funds swap #2, LN_TO_FIBER pay of $AMT2)"
ensure_fiber_capacity "$FNN_HUB_PORT" "$NODE1_PUBKEY" "$(headroom "$AMT2")"

echo "[smoke-bifrost] 3/6 ensuring LN channel hub<->payee has spendable capacity"
echo "        hub->payee leg (funds swap #1, FIBER_TO_LN pay of $AMT1)"
ensure_ln_capacity lncli_hub "$PAYEE_KEY" "${PAYEE_KEY}@127.0.0.1:9835" "$(headroom "$AMT1")"
echo "        payee->hub leg (funds swap #2, LN_TO_FIBER pay of $AMT2)"
ensure_ln_capacity lncli_payee "$HUB_KEY" "${HUB_KEY}@127.0.0.1:9735" "$(headroom "$AMT2")"

run_swap() { # run_swap <direction> <amt>
  compose exec -T \
    -e UDT_CODE_HASH="$UDT_CODE_HASH" \
    -e WBTC_ARGS="$WBTC_ARGS" \
    bifrostd node /repo/bifrostd/dist/smoke/runner.js "$1" --amt "$2"
}

echo "[smoke-bifrost] 4/6 swap #1: FIBER_TO_LN ($AMT1 sat) through the OrderEngine"
run_swap fiber_to_ln "$AMT1"

echo "[smoke-bifrost] 5/6 swap #2: LN_TO_FIBER ($AMT2 sat) through the OrderEngine"
run_swap ln_to_fiber "$AMT2"

echo "[smoke-bifrost] 6/6 both directions complete"
echo
echo "=== BIFROSTD SWAPS SUCCEEDED (FIBER_TO_LN + LN_TO_FIBER) ==="

if [ "$REBALANCE" = 1 ]; then
  echo
  echo "[smoke-bifrost] --rebalance: hub pays the client back $AMT1 wBTC units (fiber)"
  echo "                so repeated runs stay above the liquidity floor"
  # Plain (non-hold) fiber payment — no HTLC swap, no OrderEngine involvement.
  # Just tops the client's channel balance back up from what FIBER_TO_LN spent.
  REBAL_INV=$(rpc "$FNN_CLIENT_PORT" new_invoice "[{\"amount\":\"$(codec encode-u128 "$AMT1")\",\"currency\":\"Fibd\"}]")
  if [ "$(jqr "$REBAL_INV" '.error')" != "null" ]; then
    echo "rebalance: client new_invoice failed: $REBAL_INV" >&2; exit 1
  fi
  REBAL_ADDR=$(jqr "$REBAL_INV" '.result.invoice_address')
  REBAL_PAY=$(rpc "$FNN_HUB_PORT" send_payment "[{\"invoice\":\"$REBAL_ADDR\"}]")
  if [ "$(jqr "$REBAL_PAY" '.error')" != "null" ]; then
    echo "rebalance: hub send_payment failed: $REBAL_PAY" >&2; exit 1
  fi
  echo "                rebalance payment sent"
fi
