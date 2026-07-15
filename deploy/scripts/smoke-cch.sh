#!/usr/bin/env bash
# Stock CCH regression smoke test (UNMODIFIED upstream behavior):
# payee LN invoice -> hub send_btc order -> fiber wBTC channel client->hub ->
# client pays the hub's fiber invoice -> hub pays the LN invoice ->
# order reaches Success. Mirrors tests/bruno/e2e/cross-chain-hub 01-09.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

need_jq() { compose exec -T ckb jq "$@"; }
jqr() { local json=$1 f=$2; printf '%s' "$json" | compose exec -T ckb jq -r "$f"; }

for a in "$@"; do
  if [ "$a" = "--fresh" ]; then
    echo "[smoke] --fresh: tearing down and reprovisioning the stack for a clean baseline"
    fresh_reprovision
  fi
done

echo "[smoke] 0/7 verifying hold-invoice support (invoicesrpc) on lnd-hub"
if ! lncli_hub addholdinvoice --help >/dev/null 2>&1; then
  echo "FATAL: lnd-hub lacks invoicesrpc (hold invoices) — CCH cannot operate" >&2
  exit 1
fi

echo "[smoke] 1/7 payee creates a 100,000 sat BOLT11 invoice"
INV_JSON=$(lncli_payee addinvoice --amt 100000)
BTC_PAY_REQ=$(jqr "$INV_JSON" '.payment_request')
PAYMENT_HASH="0x$(jqr "$INV_JSON" '.r_hash')"
echo "        payment_hash: $PAYMENT_HASH"

echo "[smoke] 2/7 hub cch: send_btc order"
ORDER=$(rpc "$FNN_HUB_PORT" send_btc "[{\"btc_pay_req\":\"$BTC_PAY_REQ\",\"currency\":\"Fibd\"}]")
if [ "$(jqr "$ORDER" '.error')" != "null" ]; then
  echo "send_btc failed: $ORDER" >&2; exit 1
fi
FIBER_PAY_REQ=$(jqr "$ORDER" '.result.incoming_invoice.Fiber')
AMT_HEX=$(jqr "$ORDER" '.result.amount_sats')
AMT=$(codec decode-u128 "$AMT_HEX")
echo "        order amount_sats: $AMT sat ($AMT_HEX)"
# send_btc already created the hub's fiber hold invoice keyed to PAYMENT_HASH.
# Record it now so an aborted run doesn't leave it HELD forever, locking
# capacity for the next run's preflight.
record_fiber_hash "$PAYMENT_HASH"

echo "[smoke] 3/7 fiber: client connects to hub"
rpc "$FNN_CLIENT_PORT" connect_peer "[{\"address\":\"$NODE3_ADDR\"}]" >/dev/null
sleep 2

echo "[smoke] 4/7 fiber: ensuring client->hub wBTC channel has spendable capacity"
REQUIRED=$((AMT + (AMT + 9) / 10))   # +10% fee headroom, integer ceiling
ensure_fiber_capacity "$FNN_CLIENT_PORT" "$NODE3_PUBKEY" "$REQUIRED"

echo "[smoke] 5/7 fiber: client pays the hub's wrapped-BTC invoice"
PAY=$(rpc "$FNN_CLIENT_PORT" send_payment "[{\"invoice\":\"$FIBER_PAY_REQ\"}]")
if [ "$(jqr "$PAY" '.error')" != "null" ]; then
  echo "send_payment failed: $PAY" >&2; exit 1
fi

echo "[smoke] 6/7 polling get_cch_order until Success"
final=""
for i in $(seq 1 60); do
  ST=$(rpc "$FNN_HUB_PORT" get_cch_order "[{\"payment_hash\":\"$PAYMENT_HASH\"}]")
  STATUS=$(jqr "$ST" '.result.status')
  echo "        [$i] status: $STATUS"
  case "$STATUS" in
    Success) final="$ST"; break ;;
    Failed) echo "ORDER FAILED: $ST" >&2; exit 1 ;;
  esac
  sleep 3
done
[ -n "$final" ] || { echo "order never reached Success" >&2; exit 1; }
clear_fiber_hash "$PAYMENT_HASH"   # settled by CCH itself — nothing left to clean up

echo "[smoke] 7/7 verifying payee actually received the BTC"
lncli_payee lookupinvoice "$(printf '%s' "$PAYMENT_HASH" | sed 's/^0x//')" | grep -q '"state": "SETTLED"' \
  || { echo "payee invoice not settled" >&2; exit 1; }

echo
echo "=== STOCK CCH SWAP SUCCEEDED (order status: Success) ==="
printf '%s' "$final" | compose exec -T ckb jq '.result'
