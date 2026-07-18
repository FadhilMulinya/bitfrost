// Transcribed verbatim from docs/STATUS.md — keep in sync with that file.
export const STATUS_ROWS = [
  {
    component: "spec/PROTOCOL.md",
    status: "working",
    notes:
      "§10 test vectors published under spec/vectors/ (canonical-json, signatures, expiry, state-machine)",
  },
  {
    component: "spec/vectors + sdk vectors test",
    status: "working",
    notes:
      "19 assertions in test/vectors.test.ts; regenerate with npm run build && node scripts/gen-vectors.mjs",
  },
  { component: "sdk types/errors", status: "working", notes: "mirrors PROTOCOL exactly" },
  {
    component: "sdk canonical JSON + signing digest",
    status: "working",
    notes: "RFC 8785 subset; floats rejected by design; unchanged since signature vectors were cut",
  },
  {
    component: "sdk BIP-340 verification + §9 checklist",
    status: "working",
    notes:
      "tamper/expiry/mismatch paths tested; payAnyInvoice now enforces §9 item 3 (quote getAmount == invoice amount)",
  },
  {
    component: "sdk expiry conversions (§6)",
    status: "working",
    notes: "single module (src/expiry.ts); asymmetric block-to-ms constants exercised by expiry vectors",
  },
  {
    component: "sdk invoice module -- BOLT11",
    status: "working",
    notes:
      "payment_hash/amount/expiry via light-bolt11-decoder; tested against SDK-generated invoices (decoder does not verify LN signatures -- the hub's nodes are authoritative)",
  },
  {
    component: "sdk invoice module -- Fiber",
    status: "working, format assumption",
    notes:
      "bech32m HRP amount + fixed payload layout (version, timestamp, payment_hash); round-trip tested against the SDK's own encoder, NOT yet validated against live FNN invoices -- production gap",
  },
  {
    component: "sdk client (discover/quotes/orders/watch)",
    status: "working, verified against real bifrostd",
    notes:
      "mock-hub harness covers payAnyInvoice happy path, tampered quote, expired quote, error-envelope passthrough. Also run live 2026-07-15: Bifrost.payAnyInvoice() against the real api/ gateway -- quote issued, signature-verified client-side, order created, Fiber payment dispatched, order reached SUCCEEDED with matching incoming/outgoing preimages",
  },
  {
    component: "deploy/ dev environment (compose)",
    status: "working",
    notes:
      "verified 2026-07-14: docker compose up -> fund-regtest.sh -> smoke-cch.sh reaches CCH Success. Dev-chain topology mirrors upstream fiber e2e CI (decision: local dev chain, not CKB testnet -- testnet can't be self-funded reproducibly). Pinned: fiber 0.9.0-rc7, ckb v0.202.0, lnd v0.19.2-beta, bitcoind 29",
  },
  {
    component: "deploy/scripts/smoke-cch.sh (stock CCH baseline)",
    status: "working",
    notes:
      "full swap: payee BOLT11 -> send_btc -> wBTC fiber channel -> fiber payment -> hub pays LN -> order Success + payee invoice SETTLED (upstream has no Succeeded state)",
  },
  {
    component: "bifrostd fnn hex codec (0x... u64/u128)",
    status: "working",
    notes:
      "single codec module bifrostd/src/fnn/codec.ts, bigint-only, 6 passing tests incl. 0x5f5e100 vector; shell scripts reuse it via codec-cli",
  },
  {
    component: "bifrostd adapters (FiberAdapter + LightningAdapter)",
    status: "working, fixture-tested",
    notes:
      "SYSTEM-DESIGN §4.1 bound to real RPC surfaces (FNN new_invoice hold / settle / cancel / send_payment / pubsub; LND invoicesrpc+routerrpc via REST). 31 unit tests on recorded fixtures; contract tests (BIFROST_IT=1) not yet run against live compose env. Divergences logged in docs/RPC-NOTES.md",
  },
  {
    component: "bifrostd rfq (QuoteService + 3 pricing strategies)",
    status: "working (unit-tested + live)",
    notes:
      "Signed quotes via sdk signingDigest + BIP-340; static-peg / feed-spread (stale-feed reject) / inventory-skew composing chain; exact rationals, no floats; §4.2 hub-favorable <=1-unit rounding proven against the SDK verifier in 16 tests. Now wired to the api/ gateway (staticPeg only -- feed-spread/inventory-skew are unit-tested but not selected by index.ts yet)",
  },
  {
    component: "registry/ (Fastify + SQLite discovery service)",
    status: "working (e2e-tested)",
    notes:
      "POST /ads verifies BIP-340 via sdk verifyAdSignature, 5-min/60-s anti-replay window, expiry at issuedAt+ttlMs, verbatim storage (never modifies, never stores/serves rates -- rate-bearing payloads rejected); GET /ads pair+amount filters. 7 e2e tests incl tamper/replay/expiry. Single-instance, localhost-bind; no TLS/prod deploy yet",
  },
  {
    component: "dashboard/ (operator UI + swap theater)",
    status: "working against real bifrostd",
    notes:
      "React UI: order table w/ live WS stream, inventory, quote hit-rate, ExpiryGuard health, node connectivity, swap-theater animation. mock/server.ts still exists for offline dev (npm run mock); dashboard/test/contract.test.ts (9 tests) verified 2026-07-15 against the real gateway via BIFROSTD_URL=http://127.0.0.1:8391, all passing. GET /v1/quotes/stats is a PROPOSED §4.5 addition (flagged, not silent)",
  },
  {
    component: "bifrostd orders/ (OrderEngine, R1-R5, I1-I4)",
    status: "working (property-tested + live smoke)",
    notes:
      "State machine per SYSTEM-DESIGN §4.2/PROTOCOL §4.4; each invariant encoded as a seeded property test (15 tests: adversarial event orderings, wrong/missing preimages, concurrent dupes, random crash points + recovery). Persistence is an fsync'd append-only JSONL event log (R5/I4) -- SQLite store deferred (production gap: single-file log, no Postgres path yet). ExpiryGuard exists as the engine's I2 checks + sweep, not yet a standalone guard/ module",
  },
  {
    component: "deploy/scripts/smoke-bifrost.sh (engine e2e, both directions)",
    status: "working",
    notes:
      "full swaps through the OrderEngine + real adapters inside the compose stack (runner in the bifrostd container): FIBER_TO_LN then LN_TO_FIBER; verifies preimage equality across legs, payee invoice SETTLED, client fiber invoice Paid",
  },
  {
    component: "bifrostd api/ gateway (bifrostd/src/api/)",
    status: "working, v0.1 scope",
    notes:
      "HTTP+WS server backed by the REAL OrderEngine + adapters (not a simulation): POST /v1/quotes, POST /v1/orders (what sdk's payAnyInvoice actually calls), GET /v1/orders(?state=&cursor=&limit=)/:id, POST /v1/orders/:id/cancel, GET /v1/inventory, GET /v1/health, GET /v1/quotes/stats, WS /v1/stream, plus dev-only GET /v1/demo/invoice and POST /v1/demo/pay (gated off by default via DEMO_ENDPOINTS_ENABLED). Verified live 2026-07-16: full end-to-end flow (health -> demo invoice -> quote -> SDK signature verify -> order -> simulated payment -> SUCCEEDED with matching preimages within 2s). I4 crash recovery also verified live. No API-key auth as of 2026-07-17 (see docs/SECURITY.md Finding 4 -- HTLC cryptography is the real security boundary). Gaps, not silently faked: no rate limits, CORS Access-Control-Allow-Origin: *, no webhooks (events/ §4.6 not started), quote issuance is in-memory (lost on restart, short window), only QuoteMode PAY_INVOICE implemented, no external price feed wired (staticPeg only)",
  },
  {
    component: "events/ webhooks",
    status: "not started",
    notes:
      "§4.6 EventBus/WebhookDispatcher; the WS /v1/stream in api/ is a direct StreamHub broadcast, not built on a general event bus yet",
  },
  {
    component: "demo/ (merchant checkout, Vite + React)",
    status: "working against real bifrostd",
    notes:
      "Merchant dashboard (/) generates checkout links + test invoices; customer checkout (/checkout) gets a signed quote (client-verified via verifyQuote), creates an order, shows the Fiber hold invoice as a QR, has a demo-only Simulate Payment button, polls to SUCCEEDED, shows preimage/payment-hash/order-id as proof of payment. npm run build clean. Sends no auth header (bifrostd has none as of 2026-07-17). No CKB/Lightning block-explorer links -- Fiber and Lightning both settle off-chain per-swap; verified by preimage instead",
  },
];
