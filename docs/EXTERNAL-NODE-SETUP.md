# Running Bifrost with your own nodes

If you already have a funded LND node and FNN node, set `HUB_MODE=external`
in `deploy/.env` and configure the vars below. This mode is validated by
`bifrostd/src/config.ts`'s `resolveHubConfig()` — bifrostd refuses to start
and prints exactly what's missing if any required var is absent.

## Step 1: Generate a hub signing key

```
node scripts/generate-hub-key.mjs
```

Add the printed `HUB_SIGNING_KEY=<hex>` line to `deploy/.env`. This key
signs RFQ quotes only — it is never a wallet key and never touches funds.
Back it up: if you lose it, clients with your pubkey pinned can't verify
your quotes until they learn the new one.

## Step 2: Point at your LND node

```
LND_HOST=your-lnd-host
LND_REST_PORT=8080
LND_TLS_CERT_PATH=/path/to/tls.cert
LND_MACAROON_PATH=/path/to/admin.macaroon
```

bifrostd talks to LND over its REST API only (`bifrostd/src/adapters/transport.ts`'s
`LndRestHttp`) — the same interface used by any Lightning app. It reads the
macaroon file once at startup and sends it as a header on every request; it
never reads your wallet seed.

`LND_WALLET_PASSWORD` is accepted in `deploy/.env.example` for
documentation but **not yet wired** — bifrostd does not call LND's
wallet-unlock RPC. If your node needs unlocking, do that yourself before
starting bifrostd (tracked as a production gap in `docs/STATUS.md`).

## Step 3: Point at your FNN node

```
FNN_HOST=your-fnn-host
FNN_RPC_PORT=21716
```

Same principle as LND: bifrostd only calls FNN's JSON-RPC/WS API
(`bifrostd/src/adapters/fiber.ts`) against an **already-running** node. It
never starts FNN, never reads FNN's config directory, and never touches its
private key or CKB wallet.

## Step 4: Set the wBTC asset

```
UDT_CODE_HASH=0xe1e354...
WBTC_ARGS=0x32e555...
```

Get these from the CKB explorer for the wBTC xUDT you want to bridge, or
from your UDT issuer's published script config. These are the type-script
identity of the real asset — get them wrong and bifrostd will price/settle
the wrong token.

## Step 5: Confirm demo endpoints are off

```
DEMO_ENDPOINTS_ENABLED=false
```

This must be `false` (the default) for external mode — `resolveHubConfig()`
refuses to start otherwise. Demo endpoints let an unauthenticated caller
generate invoices and simulate payments against your node; they exist only
for the local dev/demo stack.

## Step 6: Start bifrostd only (no docker-compose stack)

```
cd bifrostd
npm run build
npm run start
```

No `docker compose` involved — bifrostd is a plain Node process that
connects out to your existing infrastructure.

## What bifrostd does NOT touch

- Your LND wallet seed or private keys
- Your FNN/CKB private key
- Your channel states
- Your on-chain funds

bifrostd only calls LND/FNN via their standard RPC APIs, the same way any
Lightning or Fiber application would. The only key it generates or holds
itself is the hub signing key from Step 1, which signs price quotes and has
no spending authority over anything.
