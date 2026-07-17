#!/usr/bin/env bash
# Bootstraps bitcoind regtest and opens the LN channel lnd-hub -> lnd-payee.
# Mirrors upstream fiber tests/deploy/lnd-init/setup-lnd.sh, adapted to compose.
set -euo pipefail
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"

echo "[fund] creating bitcoind wallet + maturing coinbase"
btc createwallet dev >/dev/null 2>&1 || btc loadwallet dev >/dev/null 2>&1 || true
MINE_ADDR=$(btc getnewaddress)
btc generatetoaddress 101 "$MINE_ADDR" >/dev/null

lnd_synced() {
  lncli_hub getinfo 2>/dev/null | grep -q '"synced_to_chain": true' &&
  lncli_payee getinfo 2>/dev/null | grep -q '"synced_to_chain": true'
}
retry 60 2 "both LNDs synced to chain" lnd_synced

echo "[fund] funding lnd-hub with 5 BTC"
hub_confirmed_balance() {
  # walletbalance's JSON has TWO "confirmed_balance" keys (top-level +
  # nested under account_balance.default) — take only the first (top-level).
  lncli_hub walletbalance | grep -o '"confirmed_balance": *"[0-9]\+"' | head -1 | grep -o '[0-9]\+'
}
BALANCE_BEFORE=$(hub_confirmed_balance)
HUB_ADDR=$(lncli_hub newaddress p2tr | grep -o '"address": *"[^"]*"' | sed 's/.*"\(bcrt[^"]*\)".*/\1/')
btc sendtoaddress "$HUB_ADDR" 5 >/dev/null
btc generatetoaddress 1 "$MINE_ADDR" >/dev/null
# Exact-equality against a fresh-wallet baseline (500000000) breaks on a
# warm/already-funded lnd-hub wallet (e.g. re-running against a long-lived
# stack) — check for the expected increase over whatever it started at.
TARGET_BALANCE=$((BALANCE_BEFORE + 500000000))
hub_funded() {
  local bal
  bal=$(hub_confirmed_balance)
  [ -n "$bal" ] && [ "$bal" -ge "$TARGET_BALANCE" ]
}
retry 30 2 "lnd-hub wallet balance confirmed" hub_funded

PAYEE_KEY=$(lncli_payee getinfo | grep -o '"identity_pubkey": *"[^"]*"' | sed 's/.*"\([0-9a-f]\{66\}\)".*/\1/')
echo "[fund] connecting to payee $PAYEE_KEY and opening 1,000,000 sat channel"
lncli_hub connect "${PAYEE_KEY}@127.0.0.1:9835" >/dev/null 2>&1 || true
lncli_hub openchannel --node_key "$PAYEE_KEY" --local_amt 1000000 --sat_per_vbyte 1 --min_confs 0 >/dev/null
btc generatetoaddress 3 "$MINE_ADDR" >/dev/null

chan_active() { lncli_hub listchannels | grep -q '"active": true'; }
retry 30 2 "LN channel active" chan_active

echo "[fund] done — LN channel hub->payee is active"
