# Bifrost

A production-grade **Fiber ⇄ Lightning edge-node daemon**: pay any BOLT11 invoice from Fiber (CKB) assets and vice versa, via trust-minimized HTLC atomic swaps with signed RFQ quotes.

Built for the "Gone in 60ms" Fiber Network Infrastructure Hackathon.

## Repo map
- `spec/PROTOCOL.md` — the bifrost/0.1 wire protocol (the contract; read first)
- `spec/SYSTEM-DESIGN.md` — full architecture: modules, flows, security, deployment
- `CLAUDE.md` — project context for Claude Code / gstack agents
- `docs/STATUS.md` — honesty table: what's working, what's mocked, what's a known gap
- `sdk/` — `bifrost-sdk` TypeScript client (types, canonical JSON, BIP-340 verification, invoice decode, client facade)
- `bifrostd/` — the hub daemon: Fiber/Lightning adapters, `OrderEngine` (the HTLC state machine), RFQ pricing, and the `api/` HTTP+WS gateway (SYSTEM-DESIGN §4.5)
- `dashboard/` — operator UI (order table, inventory, quote hit-rate, ExpiryGuard health, swap-theater animation) against the real `bifrostd` api/
- `registry/` — hub discovery service (signed advertisements)
- `deploy/` — the local dev stack (CKB dev chain, bitcoind regtest, 2x LND, 2x Fiber node) + smoke test scripts

---

## Prerequisites

- Docker + Docker Compose
- Node 20+, npm (this repo uses **npm**, not pnpm or yarn — every `package.json` here only defines npm scripts)

---

## Start the full stack

```bash
git clone git@github.com:FadhilMulinya/bitfrost.git bifrost
cd bifrost

# 1. Dev-only credentials (throwaway keys, never real funds — see deploy/.env.example)
cp deploy/.env.example deploy/.env

# 2. Bring up the chain + node stack: CKB dev chain, bitcoind regtest, 2x LND,
#    2x Fiber node, and bifrostd's container (it waits for the host build below).
#    First run is the slow part — it deploys contracts and funds wallets from
#    genesis, a few minutes. Later runs are fast (chain state persists in
#    deploy/vendor, a bind mount).
docker compose -f deploy/docker-compose.dev.yml --env-file deploy/.env up -d --build

# 3. Open the LN channel hub->payee and fund the regtest wallets.
deploy/scripts/fund-regtest.sh

# 4. Build the SDK (bifrostd and dashboard both depend on it via
#    "bifrost-sdk": "file:../sdk" — build it first or their installs/builds
#    will fail to resolve it).
cd sdk && npm install && npm run build && cd ..

# 5. Build bifrostd. The compose container has no toolchain of its own (see
#    deploy/docker-compose.dev.yml's bifrostd comment) — it polls for this
#    build to appear and starts the api/ gateway itself, no restart needed.
cd bifrostd && npm install && npm run build && cd ..

# 6. Confirm the gateway came up (published 127.0.0.1:8391-only by
#    deploy/docker-compose.dev.yml's netbase service):
curl http://127.0.0.1:8391/v1/health
```

You should see `docker logs bifrost-dev-bifrostd-1` print `bifrostd: starting api/ gateway` followed by `api listening on http://0.0.0.0:8391`.

---

## Run your first swap

```bash
deploy/scripts/smoke-bifrost.sh
```

This drives two full swaps through the **real** `OrderEngine` + adapters inside the compose stack — not a simulation. What the output means:

1. **`[smoke-bifrost] 2/6` and `4/6`** — before each swap, a liquidity preflight checks the Fiber and Lightning channels actually have spendable capacity for the amount about to move, opening a fresh channel automatically if not (see `deploy/scripts/lib.sh`'s `ensure_fiber_capacity`/`ensure_ln_capacity`).
2. **`[smoke-runner] order state → ...`** lines are the `OrderEngine`'s real state machine walking `PENDING → INCOMING_HELD → OUTGOING_IN_FLIGHT → OUTGOING_SETTLED → SUCCEEDED` for each direction (`FIBER_TO_LN` then `LN_TO_FIBER`) — this is PROTOCOL §4.4's state machine, not mocked.
3. **`=== BIFROSTD SWAPS SUCCEEDED (FIBER_TO_LN + LN_TO_FIBER) ===`** at the end means both directions completed with the preimage from the outgoing leg matching the preimage that settled the incoming leg (invariant I1 — the hub can never settle a claim before it has verified the matching payment).

Run it more than once and it keeps working — the preflight above is what makes repeated runs idempotent (each swap drains one side's channel balance; add `--rebalance` to have the hub top the client back up after a run, or `--fresh` for a guaranteed-clean baseline).

---

## Open the dashboard

```bash
cd dashboard
npm install
cp .env.example .env      # BIFROSTD_URL=http://127.0.0.1:8391 — the gateway from Step 6 above
npm run dev
```

Open **http://localhost:5180**. You'll see:
- **Order table** — every order `bifrostd` has ever processed, live-updating over the `/v1/stream` WebSocket as states change.
- **Inventory panel** — real spendable Fiber/Lightning liquidity (same "available vs. in-flight TLC" math the smoke-test preflight uses), not simulated numbers.
- **Quote hit-rate** — issued vs. accepted vs. expired quotes (`GET /v1/quotes/stats`).
- **ExpiryGuard health** — `minSafetyDeltaMs`/`maxIncomingHoldMs` and any rejected-order log.
- **Node connectivity** — live FNN/LND connected state and versions (`GET /v1/health`).

**To trigger a live swap you can watch animate in the dashboard:** run `deploy/scripts/smoke-bifrost.sh` (above) in another terminal while the dashboard is open — the order table and swap-theater view update in real time as that swap's `OrderEngine` state changes stream over the same WebSocket.

If you'd rather not run the Docker stack at all, `npm run mock` (in `dashboard/`) starts a simulated `bifrostd` on the same port — useful for pure UI work, but it does not exercise any real protocol logic.

---

## SDK quickstart

Published as `bifrost-sdk` on npm — `npm install bifrost-sdk` in your own
project and import it by name:

```ts
import { Bifrost } from "bifrost-sdk";

const bf = new Bifrost({});
const { order, quote } = await bf.payAnyInvoice(
  "http://127.0.0.1:8391/v1",
  "lnbcrt...",
  { network: "fiber", unit: "shannon" },
);
console.log(order.orderId, order.state);
```

Working **inside this repo** instead (no publish/install round-trip)? Build
the local package and import the built output directly — same pattern
bifrostd/dashboard use via `"bifrost-sdk": "file:../sdk"` in their
package.json:

```bash
cd sdk && npm install && npm run build
```

Save as `bifrost/quickstart.mjs` (repo root, a sibling of `sdk/` — adjust the
import path if you put it elsewhere), then `node quickstart.mjs`:

```ts
import { Bifrost } from "./sdk/dist/index.js";

const bf = new Bifrost({});
const { order, quote } = await bf.payAnyInvoice(
  "http://127.0.0.1:8391/v1",       // bifrostd's api/ gateway (see above)
  "lnbcrt...",                       // any BOLT11 (or a Fiber invoice, either direction)
  { network: "fiber", unit: "shannon" }, // the asset you're paying the hub with
);
console.log(order.orderId, order.state); // watch it settle: bf.watchOrder(hubApi, order.orderId)
```

`payAnyInvoice` detects the invoice network, requests a signed quote (verified client-side against the hub's pubkey before use), creates the order, and returns the hold invoice you pay to start the swap — the pattern this repo's own `bifrostd/src/smoke/runner.ts` and the dashboard both exercise end-to-end against a live stack.

---

## Deploy the SDK (npm publish)

**Already published:** `bifrost-sdk@0.1.0` on npm.

```bash
cd sdk && npm publish
```

`prepublishOnly` (typecheck → test → build) runs automatically and blocks the
publish if any step fails — no separate build command needed first. Unlike
the original `@bifrost/sdk` scoped name, `bifrost-sdk` is unscoped, so no
`--access public` flag or org access is needed — just `npm login` with
publish rights to the `bifrost-sdk` package name itself (whoever published
0.1.0 owns it; get added as a maintainer for subsequent releases, or bump to
your own unique name if you don't have access).

Verify what would get published (never publishes anything) with:

```bash
cd sdk && npm publish --dry-run
```

`sdk/package.json`'s `files: ["dist"]` + `sdk/.npmignore` keep the tarball to
`dist/` + `package.json` only.

---

## Working with gstack
Install gstack into Claude Code, open this repo, and start with `/office-hours` referencing `CLAUDE.md`. See `docs/STATUS.md` for what's real vs. simplified in the current build.
