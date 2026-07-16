# BIFROST — System Design Specification

**Version:** 0.1-draft · **Status:** Hackathon build target · **Audience:** Implementers (human + AI-assisted), hackathon judges, future contributors

---

## 1. Purpose & Scope

Bifrost is a production-grade **Fiber ⇄ Lightning edge-node daemon**. It upgrades Fiber's built-in Cross-Chain Hub (CCH) prototype — which today swaps only BTC↔wrapped-BTC at a hard-coded 1:1 ratio with a single configured asset — into open, reusable infrastructure with:

1. **Negotiated, multi-asset swaps** via an RFQ (Request-for-Quote) protocol
2. **A unified "pay anything" API** (accepts BOLT11 or Fiber invoices, routes across networks)
3. **A swap-acceptor + pluggable pricing engine** (the interface the Fiber core team sketched but has not built)
4. **A discovery registry** so multiple hub operators can advertise and compete on quotes
5. **Operator tooling**: risk dashboard, diagnostics, webhooks

**Non-goals (v0.1):** custody of end-user funds beyond in-flight HTLCs; mainnet deployment; PTLC swaps (designed-for, not implemented); gossip-based ad propagation (registry is centralized in v0.1, spec'd for decentralization).

---

## 2. System Context

```
                        ┌──────────────────────────────────────────────┐
                        │                 CLIENTS                      │
                        │  Wallets · Merchant backends · AI agents     │
                        │  (via bifrost-sdk or raw REST/WS)            │
                        └───────┬──────────────────────────┬───────────┘
                                │ get quotes / pay invoice │ discover hubs
                                ▼                          ▼
                    ┌───────────────────┐        ┌──────────────────────┐
                    │   BIFROSTD (hub)  │◄──ads──┤  BIFROST-REGISTRY    │
                    │   this operator   │        │  (discovery service) │
                    └───┬───────────┬───┘        └──────────▲───────────┘
              JSON-RPC/WS│           │gRPC/REST              │ signed ads
              (Biscuit)  ▼           ▼                       │ from other hubs
                 ┌──────────┐  ┌──────────┐         ┌────────┴─────────┐
                 │   FNN    │  │   LND    │         │  Other bifrostd  │
                 │ (Fiber)  │  │(Lightning)│        │    operators     │
                 └────┬─────┘  └────┬─────┘         └──────────────────┘
                      ▼             ▼
                 CKB testnet   Bitcoin testnet
                 (channels,    (channels,
                  contracts)    HTLCs)
```

The hub operator runs **one bifrostd**, which supervises **one FNN** and **one LND**. Funds live in the operator's own Fiber and Lightning channels. Atomicity between the two networks is enforced by sharing a single HTLC payment hash across both — never by trust.

---

## 3. Repository / Deliverable Layout

```
bifrost/
├── bifrostd/            # The daemon (TypeScript, Node 20+; core logic testable in isolation)
│   └── src/
│       ├── adapters/    # FiberAdapter, LightningAdapter (node abstraction)
│       ├── orders/      # OrderEngine + state machine
│       ├── rfq/         # QuoteService, SwapAcceptor, pricing/ strategies
│       ├── guard/       # ExpiryGuard, InventoryManager (risk invariants)
│       ├── api/         # REST + WS gateway, auth middleware
│       ├── events/      # EventBus, WebhookDispatcher
│       ├── store/       # Persistence (SQLite via better-sqlite3 or Postgres)
│       └── telemetry/   # metrics, structured logs
├── registry/            # bifrost-registry service (small; Fastify + SQLite)
├── sdk/                 # @bifrost/sdk — TypeScript client
├── dashboard/           # operator web UI (React, reads bifrostd API)
├── spec/                # PROTOCOL.md (RFQ + Advertisement wire formats), this doc
├── deploy/              # docker-compose.testnet.yml, config templates
└── e2e/                 # end-to-end swap tests (adapted from fiber repo's bruno suites)
```

---

## 4. Module Specifications

### 4.1 `adapters/` — Node Abstraction Layer

Purpose: isolate all node-specific I/O behind two narrow interfaces so the rest of the system is network-agnostic and mockable in tests. **Design rule: bifrostd performs no cryptography for HTLCs itself — the nodes do. Bifrost orchestrates.**

```ts
interface FiberAdapter {
  // connection: FNN JSON-RPC 2.0 over HTTP + WS (jsonrpsee), Biscuit bearer token
  newHoldInvoice(p: { amount: bigint; assetScript?: Script; paymentHash: Hash256;
                      finalTlcExpiryDelta: number; description?: string }): Promise<FiberInvoice>;
  settleHoldInvoice(paymentHash: Hash256, preimage: Hash256): Promise<void>;
  cancelHoldInvoice(paymentHash: Hash256): Promise<void>;
  sendPayment(invoice: string, maxFee: bigint, tlcExpiryLimit: number): Promise<PaymentHandle>;
  parseInvoice(invoice: string): FiberInvoiceDetails;
  subscribeStoreChanges(): AsyncIterable<StoreChangeEvent>;   // real-time order/TLC updates, no polling
  getChannels(): Promise<FiberChannel[]>;                     // for inventory
  nodeInfo(): Promise<FiberNodeInfo>;
}

interface LightningAdapter {
  // connection: LND gRPC (invoicesrpc + routerrpc), macaroon auth. CLN via plugin later.
  addHoldInvoice(p: { amountSat: bigint; paymentHash: Hash256; cltvExpiry: number }): Promise<Bolt11>;
  settleHoldInvoice(preimage: Hash256): Promise<void>;
  cancelHoldInvoice(paymentHash: Hash256): Promise<void>;
  sendPayment(bolt11: string, maxFeeSat: bigint, cltvLimit: number): Promise<PaymentHandle>;
  trackPayment(paymentHash: Hash256): AsyncIterable<PaymentUpdate>;   // yields preimage on success
  decodeInvoice(bolt11: string): Bolt11Details;
  getChannels(): Promise<LnChannel[]>;
}
```

Notes:
- FNN RPC modules required: `cch`, `invoice`, `payment`, `channel`, `graph`, `info`. Generate a Biscuit token scoped to exactly these (read/write as needed) — never an all-access token.
- The adapters normalize both networks' invoice/TLC events into a common `SwapLegEvent` type consumed by the OrderEngine.
- Hash algorithm is a parameter (`sha256` today), carried through every call — this is the PTLC-readiness seam.

### 4.2 `orders/` — Order Engine

Purpose: own the canonical **Order** record and drive it through the cross-chain state machine. One order = one atomic swap attempt (one incoming leg, one outgoing leg, one shared payment hash).

**Order data model:**

```ts
type Direction = "FIBER_TO_LN" | "LN_TO_FIBER";

interface Order {
  id: string;                       // ulid
  direction: Direction;
  paymentHash: Hash256;             // shared across both legs — THE atomicity anchor
  quoteId: string;                  // quote this order was created under
  incoming: Leg;                    // what the client pays the hub
  outgoing: Leg;                    // what the hub pays onward
  state: OrderState;
  failureReason?: FailureCode;
  createdAt: number; updatedAt: number;
  expiryDeadline: number;           // absolute; after this, auto-cancel path triggers
}

interface Leg {
  network: "fiber" | "lightning";
  invoice: string;                  // Fiber invoice or BOLT11
  asset: AssetRef;                  // { network:"lightning", unit:"sat" } | { network:"fiber", udtScript?, unit }
  amount: bigint;                   // in smallest unit of asset
  tlcExpiry: number;                // absolute expiry of this leg's HTLC
  status: "WAITING" | "HELD" | "IN_FLIGHT" | "SETTLED" | "CANCELLED" | "FAILED";
  preimage?: Hash256;               // populated once known
}

type OrderState =
  | "PENDING"             // order created, incoming invoice issued, nothing received
  | "INCOMING_HELD"       // incoming HTLC accepted & held (NOT settled)
  | "OUTGOING_IN_FLIGHT"  // outgoing payment dispatched
  | "OUTGOING_SETTLED"    // outgoing settled, preimage learned
  | "SUCCEEDED"           // incoming settled with preimage; swap complete
  | "REFUNDING"           // outgoing failed/expired; cancelling incoming hold
  | "FAILED";             // terminal failure (incoming refunded or never arrived)
```

**State machine (both directions use the same skeleton):**

```
 PENDING ──incoming HTLC held──► INCOMING_HELD ──dispatch──► OUTGOING_IN_FLIGHT
    │                                 │                            │
    │ order expiry                    │ ExpiryGuard veto           ├─ success: preimage learned
    ▼                                 ▼                            ▼
  FAILED ◄──────────────────────── REFUNDING ◄──failure/timeout  OUTGOING_SETTLED
    ▲                                 │                            │ settle incoming
    └──────── incoming cancelled ─────┘                            ▼
                                                               SUCCEEDED
```

Invariants enforced by the engine:
- **I1 (atomicity):** incoming leg is *never* settled before outgoing preimage is known.
- **I2 (timelock ordering):** `incoming.tlcExpiry ≥ outgoing.tlcExpiry + SAFETY_DELTA` (see ExpiryGuard). Orders violating I2 are rejected at creation.
- **I3 (single-flight):** at most one outgoing dispatch per paymentHash; retries only after a definitive failure signal.
- **I4 (crash recovery):** every transition is persisted before the side-effect is acknowledged; on restart, the engine reconciles all non-terminal orders against both adapters (query hold-invoice + payment status) before accepting new work.

### 4.3 `rfq/` — RFQ Engine (QuoteService · SwapAcceptor · Pricing)

Purpose: replace the hard-coded 1:1 swap with negotiated, signed, expiring quotes. This module is also published as a standalone **protocol spec** (`spec/PROTOCOL.md`) so other implementations can interoperate.

**Wire messages (JSON over REST/WS):**

```ts
// Client → Hub
interface QuoteRequest {
  pair: { give: AssetRef; get: AssetRef };  // e.g. give CKB-UDT-X, get LN sats
  amount: { side: "give" | "get"; value: bigint };
  mode: "PAY_INVOICE" | "RECEIVE";          // paying an existing invoice vs. requesting inbound
  targetInvoice?: string;                   // when mode=PAY_INVOICE (amount derived from it)
}

// Hub → Client
interface Quote {
  quoteId: string;
  pair: { give: AssetRef; get: AssetRef };
  rate: { num: bigint; den: bigint };       // exact rational, no floats
  giveAmount: bigint; getAmount: bigint;    // fully computed, fee-inclusive
  feeBreakdown: { hubFee: bigint; estNetworkFee: bigint };
  expiresAt: number;                        // quote validity (e.g. now + 30s)
  maxTlcExpiryDelta: number;                // hub's offered incoming hold window
  hubPubkey: string;
  signature: string;                        // secp256k1 over canonical JSON of all above fields
}

type QuoteReject = { code: "PAIR_UNSUPPORTED" | "AMOUNT_OUT_OF_BOUNDS" |
                           "INVENTORY_INSUFFICIENT" | "PRICING_UNAVAILABLE"; message: string };
```

**SwapAcceptor** — implements the pattern the Fiber team sketched (modeled on LND's ChannelAcceptor): a persistent WS subscription where every inbound `QuoteRequest` / swap proposal is pushed to the operator's acceptor pipeline, and an accept/reject decision flows back on the same connection. In bifrostd the "acceptor client" is in-process by default (the pricing chain below), but the WS surface is exposed so an operator can plug an *external* acceptor.

**PricingStrategy plugin interface:**

```ts
interface PricingStrategy {
  name: string;
  price(req: QuoteRequest, ctx: PricingContext): Promise<PriceDecision>;
}
interface PricingContext {
  inventory: InventorySnapshot;      // per-asset channel balances, both networks
  inFlightExposure: bigint;          // sum of outgoing legs not yet settled
  feedRate?: Rational;               // from configured price feed, if any
}
type PriceDecision = { accept: true; rate: Rational; hubFee: bigint }
                   | { accept: false; reason: QuoteReject["code"] };
```

Shipped strategies (v0.1):
1. `static-peg` — fixed rate (e.g. 1:1 wBTC↔BTC), configurable spread. Parity with today's CCH.
2. `feed-spread` — external price feed ± configurable bps spread; rejects if feed is stale (> N seconds).
3. `inventory-skew` — wraps another strategy; widens spread on the side draining inventory and tightens on the side that rebalances the hub. **This makes quoting itself a passive rebalancing mechanism** — a genuinely novel operational feature.

Strategies compose as a chain: `inventory-skew(feed-spread)`. Rejections short-circuit.

### 4.4 `guard/` — ExpiryGuard & InventoryManager (Risk Core)

**ExpiryGuard** — the single most safety-critical component. Before any order is created it computes and enforces:

```
incoming.tlcExpiry ≥ outgoing.tlcExpiry + SAFETY_DELTA

where SAFETY_DELTA = max_settlement_lag(outgoing.network)
                   + reorg_margin(incoming.network)
                   + operator_margin (config, default 2h)
```

- For LN outgoing: derive `outgoing.tlcExpiry` from the BOLT11's `min_final_cltv_expiry` + route CLTV budget, converted to wall-clock via conservative block-time assumptions.
- For Fiber outgoing: use the invoice's `final_tlc_expiry_delta` (Fiber TLC expiries are millisecond-based wall-clock deltas — do NOT confuse block-based CLTV with time-based TLC expiry; ExpiryGuard owns this conversion in one place, with unit tests).
- Guard also enforces a **max hold window** so a client can't lock hub liquidity indefinitely via unpaid quotes.

**InventoryManager** — maintains `InventorySnapshot`:

```ts
interface InventorySnapshot {
  assets: Array<{
    asset: AssetRef;
    localBalance: bigint;      // spendable now (sum of local channel balances)
    remoteBalance: bigint;     // receivable now
    inFlightOut: bigint;       // committed to outgoing legs
    available: bigint;         // localBalance - inFlightOut - reserve
  }>;
  updatedAt: number;
}
```

Order admission requires `outgoing.amount ≤ available(outgoing.asset)`. Exposure caps per-order and global are config-enforced. All rejections surface as structured errors (never silent).

### 4.5 `api/` — Payment API Gateway

REST + WebSocket surface consumed by the SDK, dashboard, and third parties.

```
POST   /v1/quotes                 body: QuoteRequest            → Quote | QuoteReject
POST   /v1/orders                 body: { quoteId, targetInvoice? } → { order, incomingInvoice }
POST   /v1/pay                    body: { invoice, maxFee? }    → convenience: detect BOLT11 vs Fiber,
                                                                   auto-quote, create order, return
                                                                   { order, incomingInvoice }  ("pay anything")
GET    /v1/orders/:id                                           → Order
GET    /v1/orders?state=&cursor=                                → paginated list
POST   /v1/orders/:id/cancel      (only PENDING/INCOMING_HELD)  → Order
GET    /v1/inventory              (operator-auth)               → InventorySnapshot
GET    /v1/health                                               → node connectivity, feed freshness
WS     /v1/stream                 subscribe: order updates, quote events (server push)
POST   /v1/webhooks               (operator-auth) register URL for OrderState transitions
```

Auth model: public endpoints (`quotes`, `pay`, `orders` create/read-own) use API keys with per-key rate limits; operator endpoints require an operator key. bifrostd→FNN uses Biscuit; bifrostd→LND uses macaroons. **bifrostd's own RPC listeners bind to localhost/private interfaces by default**; the compose file fronts them with a reverse proxy for TLS.

Error taxonomy (`FailureCode`): `NO_ROUTE`, `INSUFFICIENT_INBOUND`, `QUOTE_EXPIRED`, `EXPIRY_INVARIANT_VIOLATION`, `OUTGOING_TIMEOUT`, `OUTGOING_FAILED`, `INVENTORY_INSUFFICIENT`, `INVOICE_INVALID`, `HUB_OVEREXPOSED`, `INTERNAL`. Every failure carries a human-readable `hint` — this is the "payment failure diagnostics" the hackathon brief asks for, built into the core.

### 4.6 `events/` — EventBus & WebhookDispatcher

- In-process typed event bus: `order.created`, `order.state_changed`, `quote.issued`, `quote.expired`, `inventory.updated`, `guard.rejected`.
- WebhookDispatcher: at-least-once delivery, HMAC-signed payloads (`X-Bifrost-Signature`), exponential backoff, dead-letter table.
- The WS `/v1/stream` endpoint is a thin subscriber on the same bus.

### 4.7 `store/` — Persistence

SQLite (WAL mode) in v0.1; schema kept Postgres-compatible.

Tables: `orders`, `legs`, `quotes`, `webhooks`, `webhook_deliveries`, `events` (append-only audit log), `inventory_snapshots`. Every OrderEngine transition = one transaction writing `orders` + `events`. The append-only `events` table is the recovery source of truth and doubles as the dashboard's activity feed.

### 4.8 `registry/` — bifrost-registry (separate service)

Purpose: discovery. Hubs publish signed advertisements; clients query for candidate hubs, then fetch live quotes directly from each hub (registry never intermediates funds or quotes — it is metadata only, so it is not a custodial or MITM risk).

```ts
interface Advertisement {
  hubPubkey: string;
  endpoints: { api: string };                  // https URL of the hub's /v1
  pairs: Array<{ give: AssetRef; get: AssetRef;
                 minAmount: bigint; maxAmount: bigint }>;
  fiberNodeId: string; lightningNodeId: string;
  version: string;                             // bifrost protocol version
  timestamp: number;                           // ads expire after TTL (e.g. 1h); hubs re-publish
  signature: string;                           // hub key over canonical JSON
}
```

API: `POST /ads` (validated: signature, timestamp freshness), `GET /ads?give=&get=&amount=` (returns fresh ads matching a pair). v0.1 is a single hosted instance; the *signed-ad format* is the durable contribution — the roadmap moves distribution to Fiber gossip or Nostr relays without changing the ad schema.

### 4.9 `sdk/` — @bifrost/sdk (TypeScript)

```ts
const bf = new Bifrost({ registry: "https://registry...", apiKey });
const hubs   = await bf.discover({ give: CKB, get: LN_SAT, amount: 50_000n });
const quotes = await bf.getQuotes(hubs, request);            // parallel, verifies signatures
const best   = Bifrost.bestQuote(quotes);                    // rate- and fee-aware comparator
const { order, incomingInvoice } = await bf.payAnyInvoice(bolt11OrFiberInvoice, { hub: best.hub });
for await (const update of bf.watchOrder(order.id)) { ... }  // WS-backed
```

Also exports: invoice detection/parsing helpers, quote signature verification, and typed errors mirroring `FailureCode` — so wallet developers integrate cross-network payments in ~10 lines.

### 4.10 `dashboard/` — Operator UI

Read-mostly React app against the operator API: order table with live state stream; inventory panel per asset/side with available-vs-in-flight bars; quote analytics (issued vs. accepted vs. expired = hit rate); ExpiryGuard health (current SAFETY_DELTA inputs, rejected-order log); webhook delivery status; node connectivity (FNN/LND up, feed freshness). Demo mode: a "swap theater" view that animates an order walking through its states — built for the judging video.

---

## 5. End-to-End Sequence Flows

### 5.1 Fiber → Lightning ("pay a BOLT11 with Fiber assets")

```
Client            bifrostd                FNN                 LND              LN Payee
  │ POST /v1/pay     │                     │                    │                  │
  │  {bolt11}        │ decode bolt11 (hash H, amt)              │                  │
  │                  │ price via RFQ chain; ExpiryGuard check   │                  │
  │◄─ quote + Fiber ─┤ newHoldInvoice(H, amt', expiry_in)       │                  │
  │   hold invoice   │────────────────────►│                    │                  │
  │ pays Fiber inv.  │                     │                    │                  │
  │─────────────────►│◄── HTLC HELD event ─┤   (NOT settled)    │                  │
  │                  │ state: INCOMING_HELD│                    │                  │
  │                  │ sendPayment(bolt11, cltvLimit)───────────►│── HTLC(H) ─────►│
  │                  │ state: OUTGOING_IN_FLIGHT                │                  │
  │                  │◄─────────── preimage P (settled) ────────┤◄── settles, P ──┤
  │                  │ state: OUTGOING_SETTLED                  │                  │
  │                  │ settleHoldInvoice(H, P)                  │                  │
  │                  │────────────────────►│  incoming settles  │                  │
  │◄── order: SUCCEEDED (WS/webhook) ──────┤                    │                  │
```

### 5.2 Lightning → Fiber ("receive on Fiber, paid from any LN wallet")

Mirror image: client submits a Fiber invoice (hash H); bifrostd issues an LND **hold invoice** with the same H; LN payer pays it; hub holds; hub dispatches the Fiber payment; on Fiber settlement the preimage returns; hub settles the LN hold invoice. Same state machine, legs swapped.

### 5.3 Refund path (the atomicity proof — demo this on camera)

Outgoing leg fails or times out (`NO_ROUTE`, payee offline, expiry approaching):
1. OrderEngine → `REFUNDING`; cancels the held incoming HTLC (`cancelHoldInvoice`).
2. Client's funds are released by their own node automatically — the hub never possessed them (held ≠ settled).
3. Order → `FAILED` with structured `failureReason` + hint; webhook fires.
Because of invariant **I2**, there is no window where the outgoing leg can settle after the incoming leg has refunded.

---

## 6. Security Model & Threat Table

| Threat | Mitigation |
|---|---|
| Hub settles incoming, never pays outgoing | Impossible by construction: incoming settle requires preimage P, which only exists after outgoing settles (I1). |
| Timelock race (outgoing settles after incoming refund) | ExpiryGuard invariant I2 with conservative SAFETY_DELTA; orders violating it never exist. |
| Stale/manipulated price feed | `feed-spread` rejects stale feeds; rates are quoted as exact rationals and signed; quotes expire in seconds. |
| Client griefing (lock hub liquidity with unpaid quotes/orders) | Quote expiry (~30s), max hold window, per-key rate limits, per-order + global exposure caps. |
| Quote forgery / registry MITM | Quotes and advertisements are secp256k1-signed by the hub key; SDK verifies before display; registry is metadata-only. |
| RPC exposure | FNN Biscuit tokens minimally scoped; bifrostd binds private interfaces; TLS via reverse proxy; operator endpoints separately keyed. |
| Crash mid-swap | I4 recovery: persisted transitions + startup reconciliation against both nodes; append-only event log as source of truth. |
| Channel-state cheating on either network | Delegated to the networks' own security: Fiber watchtower (enable the module) + LND watchtower. Bifrost surfaces watchtower health in /v1/health. |

Key management: hub signing key (quotes/ads) is separate from node keys; stored encrypted at rest; FNN key encrypted via `FIBER_SECRET_KEY_PASSWORD` per upstream practice.

---

## 7. Deployment Topology (v0.1 testnet)

`deploy/docker-compose.testnet.yml` services:

| Service | Image/Source | Notes |
|---|---|---|
| `fnn` | official Fiber Docker image | CKB testnet; RPC on private network; Biscuit auth on |
| `bitcoind` | bitcoin/bitcoin | testnet (or regtest for CI/e2e) |
| `lnd` | lightninglabs/lnd | invoicesrpc + routerrpc build tags enabled (hold invoices) |
| `bifrostd` | ./bifrostd | depends_on fnn+lnd; config via env + yaml |
| `registry` | ./registry | optional locally; hosted instance for demo |
| `dashboard` | ./dashboard | static build behind proxy |
| `proxy` | caddy | TLS termination, routes /v1 and dashboard |

Config reference (excerpt, `bifrost.yaml`):

```yaml
fiber:   { rpc_url, biscuit_token, watchtower: true }
lightning: { impl: lnd, grpc_host, macaroon_path, tls_cert_path }
rfq:
  pairs:
    - give: { network: fiber, udt: wBTC }   # parity mode
      get:  { network: lightning, unit: sat }
      strategy: static-peg   # spread_bps: 20
    - give: { network: fiber, unit: ckb }
      get:  { network: lightning, unit: sat }
      strategy: inventory-skew(feed-spread) # feed: <configurable>, max_staleness_s: 30
  quote_ttl_s: 30
guard:  { operator_margin_h: 2, max_hold_window_h: 6, global_exposure_cap, per_order_cap }
registry: { publish: true, url, republish_interval_m: 30 }
```

---

## 8. Testing Strategy

1. **Unit:** OrderEngine transitions (property-based: no path settles incoming before outgoing preimage); ExpiryGuard math incl. block-time↔wall-clock conversion edge cases; pricing chain composition; quote signature round-trip.
2. **Integration (regtest):** full swap both directions against real FNN + LND in compose; forced-failure suite (kill LND mid-flight → assert REFUNDING→FAILED and client refund; expire quotes; drain inventory → assert structured rejects).
3. **Crash-recovery:** SIGKILL bifrostd in every non-terminal state; assert reconciliation resumes or safely refunds.
4. **e2e:** adapt the upstream fiber repo's cross-chain-hub bruno suites to run against bifrostd's API.
5. **Honesty table (required by submission rules):** maintained in README — working / mocked / production-gap per feature.

---

## 9. Roadmap (post-hackathon / DAO-grant scope)

1. **PTLC swaps** — hash-algorithm-agnostic seam already in adapters; adopt once Fiber PTLC flows stabilize (privacy: unlinkable legs; security: wormhole resistance).
2. **Decentralized ad distribution** — same Advertisement schema over Fiber gossip extension or Nostr relays; registry becomes just one indexer.
3. **Multi-hub payment splitting** — SDK-side MPP across several hubs' quotes.
4. **CLN adapter**; **acceptor federation** (external acceptor clients over the WS surface, enabling professional market-makers).
5. **Virtual-channel research track** — CKB's programmability permits full Perun-style virtual channels that Bitcoin cannot express; Bifrost's hub topology is the natural substrate.

---

## 10. Glossary

- **CCH** — Cross-Chain Hub, Fiber's built-in BTC⇄wBTC swap module that Bifrost generalizes.
- **Hold invoice** — an invoice whose HTLC the recipient accepts but deliberately does not settle until an external condition (here: the outgoing leg's preimage) is met.
- **HTLC / TLC** — (Hashed) Time-Locked Contract; Fiber uses time-based TLC expiries (ms), Lightning uses block-height CLTV.
- **Preimage (P) / payment hash (H)** — H = sha256(P); revealing P settles every HTLC locked to H on both networks — the atomicity anchor.
- **RFQ** — Request for Quote: signed, expiring price offers replacing hard-coded rates.
- **Edge node** — a node providing priced liquidity at the boundary between two networks/assets.
- **SAFETY_DELTA** — the minimum time gap between incoming and outgoing HTLC expiries that makes the refund path race-free.
