#!/bin/bash
# Generates a regtest Lightning invoice from lnd-payee
# Usage: ./scripts/invoice.sh <amount_sat> <memo>
# Returns: raw payment_request string (lnbcrt...)

set -e
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

if [ ! -f deploy/scripts/lib.sh ]; then
  echo "ERROR: run from repo root" >&2
  exit 1
fi

source deploy/scripts/lib.sh
lncli_payee addinvoice \
  --amt "${1:-1000}" \
  --memo "${2:-bifrost payment}" | jq -r '.payment_request'
