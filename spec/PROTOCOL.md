# Bifrost RFQ Protocol Specification

**Protocol version:** `bifrost/0.1` · **Status:** Draft for implementation · **License intent:** open (MIT/Apache-2.0)

This document defines the wire protocol between **clients** (wallets, merchants, agents, SDKs) and **hubs** (Bifrost edge-node daemons providing Fiber⇄Lightning liquidity), plus the **advertisement** format hubs publish to registries. Any implementation that speaks this protocol interoperates — bifrostd is the reference implementation, not the protocol.

Keywords MUST, SHOULD, MAY follow RFC 2119.

---

## 1. Concepts & Roles

- **Hub** — operates one Fiber node and one Lightning node, quotes and executes atomic cross-network swaps.
- **Client** — requests quotes and creates orders. Never trusts the hub with settled funds: atomicity is enforced by a shared HTLC payment hash, not reputation.
- **Registry** — indexes signed hub advertisements. Metadata only; never in the money path.
- **Quote** — a signed, expiring price commitment for one swap.
- **Order** — one swap attempt executing under one quote.

All amounts are integers in the asset's smallest unit (`sat` for Lightning BTC; `shannon` for CKB; UDT base units for UDTs). No floats anywhere in the protocol. All timestamps are Unix milliseconds (UTC). All binary values are lowercase hex without `0x` prefix.

## 2. Asset References

```json
{ "network": "lightning", "unit": "sat" }
{ "network": "fiber", "unit": "shannon" }
{ "network": "fiber", "unit": "udt", "udtScript": { "codeHash": "…", "hashType": "type", "args": "…" } }
```

- `network` MUST be `"lightning"` or `"fiber"`.
- For `unit:"udt"`, `udtScript` MUST be present and is the CKB type script identifying the asset. Implementations MUST compare UDT assets by the script's canonical hash, not by display name.
- A **pair** is `{ "give": AssetRef, "get": AssetRef }` from the *client's* perspective: the client gives `give` and receives `get` (directly or as payment of a target invoice).

## 3. Canonical JSON & Signing

Every signed object (`Quote`, `Advertisement`) is signed over its **canonical form**:

1. Remove the `signature` field.
2. Serialize per **RFC 8785 (JCS)**: UTF-8, lexicographically sorted keys at every level, no insignificant whitespace, numbers in shortest form. Because all protocol amounts are strings (see §4), no numeric-precision ambiguity exists.
3. Compute `digest = sha256( "bifrost/0.1|" + type_tag + "|" + canonical_bytes )` where `type_tag` ∈ {`quote`, `ad`}. The domain-separation prefix prevents cross-type signature reuse.
4. `signature` = secp256k1 Schnorr (BIP-340) over `digest`, hex-encoded (64 bytes). `hubPubkey` is the 32-byte x-only public key, hex.

Verifiers MUST reject: bad signature, unknown `hubPubkey` (when pinned), expired object, or version prefix mismatch.

**Big integers:** every amount field is a JSON **string** of a base-10 integer (e.g. `"50000"`). Implementations MUST NOT emit JSON numbers for amounts.

## 4. Messages

### 4.1 QuoteRequest (client → hub)

`POST /v1/quotes`

```json
{
  "protocol": "bifrost/0.1",
  "pair": { "give": {"network":"fiber","unit":"shannon"},
            "get":  {"network":"lightning","unit":"sat"} },
  "amount": { "side": "get", "value": "50000" },
  "mode": "PAY_INVOICE",
  "targetInvoice": "lnbc500u1p…"
}
```

- `mode` ∈ `PAY_INVOICE` | `RECEIVE`.
  - `PAY_INVOICE`: client wants the hub to pay `targetInvoice` on the `get` network. `targetInvoice` MUST be present; `amount` MUST match the invoice amount if the invoice specifies one (hub MUST verify and reject mismatches with `INVOICE_MISMATCH`).
  - `RECEIVE`: client wants inbound funds on `get` network; hub will later produce the outgoing payment to a client-supplied invoice at order creation.
- `amount.side` declares which side is fixed; the hub computes the other from its rate.

### 4.2 Quote (hub → client)

```json
{
  "protocol": "bifrost/0.1",
  "quoteId": "01J9…ULID",
  "pair": { "give": {…}, "get": {…} },
  "rate": { "num": "50000", "den": "13000000000" },
  "giveAmount": "13026000000",
  "getAmount": "50000",
  "feeBreakdown": { "hubFeePpm": "2000", "flatFee": "0", "estNetworkFee": "12" },
  "issuedAt": 1752505200000,
  "expiresAt": 1752505230000,
  "maxIncomingHoldMs": 21600000,
  "minSafetyDeltaMs": 7200000,
  "hubPubkey": "ab34…",
  "signature": "9f1c…"
}
```

Semantics:

- `rate` is the exact rational `get/give` before fees. `giveAmount`/`getAmount` are **fully fee-inclusive and final** — the client pays exactly `giveAmount`, the payee receives exactly `getAmount`. Clients SHOULD recompute and verify: `getAmount ≈ giveAmount × rate − fees` within 1 unit rounding (round direction: always in the hub's favor by ≤1 unit; hubs MUST NOT round further).
- `expiresAt − issuedAt` SHOULD be 15–60 s. A hub MUST honor an unexpired quote presented at order creation or reject with `QUOTE_EXPIRED`/`INVENTORY_INSUFFICIENT` — it MUST NOT execute at a different rate.
- `maxIncomingHoldMs` — longest the hub will hold the client's incoming HTLC awaiting the outgoing leg.
- `minSafetyDeltaMs` — the hub's required gap: `incomingExpiry ≥ outgoingExpiry + minSafetyDeltaMs`. Published so clients can predict feasibility for invoices with tight CLTV.
- Rejections use the error envelope (§7) with codes `PAIR_UNSUPPORTED`, `AMOUNT_OUT_OF_BOUNDS`, `INVENTORY_INSUFFICIENT`, `PRICING_UNAVAILABLE`, `INVOICE_MISMATCH`, `INVOICE_INVALID`.

### 4.3 OrderCreate (client → hub)

`POST /v1/orders`

```json
{ "protocol": "bifrost/0.1",
  "quoteId": "01J9…",
  "targetInvoice": "lnbc500u1p…" }
```

- For `mode:RECEIVE` quotes, `targetInvoice` is the client's own invoice on the `get` network (client-generated, so the client controls the preimage… see §5 hash rule).
- Hub validation order: quote exists & unexpired → signature self-check → invoice decode → **hash-consistency rule (§5)** → ExpiryGuard (§6) → inventory admission. First failure returns its error code; no partial state is created.

### 4.4 Order (hub → client; returned on create and on every read/stream event)

```json
{
  "protocol": "bifrost/0.1",
  "orderId": "01J9…",
  "quoteId": "01J9…",
  "direction": "FIBER_TO_LN",
  "paymentHash": "c0ffee…",
  "state": "PENDING",
  "incoming": { "network": "fiber", "invoice": "fibt…", "amount": "13026000000",
                "tlcExpiryAt": 1752526800000, "status": "WAITING" },
  "outgoing": { "network": "lightning", "invoice": "lnbc500u1p…", "amount": "50000",
                "tlcExpiryAt": 1752512400000, "status": "WAITING" },
  "failure": null,
  "createdAt": 1752505206000, "updatedAt": 1752505206000
}
```

`state` machine (normative):

```
PENDING → INCOMING_HELD → OUTGOING_IN_FLIGHT → OUTGOING_SETTLED → SUCCEEDED
PENDING → FAILED                      (expiry, cancel)
INCOMING_HELD | OUTGOING_IN_FLIGHT → REFUNDING → FAILED
```

Normative transition rules:
- **R1:** A hub MUST NOT settle the incoming HTLC in any state except `OUTGOING_SETTLED`.
- **R2:** A hub MUST NOT dispatch the outgoing payment before `INCOMING_HELD`.
- **R3:** On outgoing failure or when `now + minSafetyDeltaMs ≥ incoming.tlcExpiryAt`, the hub MUST enter `REFUNDING` and cancel the incoming hold.
- **R4:** At most one outgoing dispatch per `paymentHash` may be in flight.
- **R5:** All transitions MUST be durably persisted before their side effect is acknowledged externally.

### 4.5 Advertisement (hub → registry)

`POST /ads` on a registry.

```json
{
  "protocol": "bifrost/0.1",
  "hubPubkey": "ab34…",
  "endpoints": { "api": "https://hub.example.com/v1" },
  "pairs": [ { "give": {…}, "get": {…}, "minAmount": "1000", "maxAmount": "10000000" } ],
  "fiberNodeId": "…", "lightningNodeId": "…",
  "issuedAt": 1752505200000,
  "ttlMs": 3600000,
  "signature": "…"
}
```

- Registries MUST verify the signature and MUST reject `issuedAt` older than 5 minutes (anti-replay) or in the future by >60 s.
- Ads expire at `issuedAt + ttlMs`; hubs SHOULD republish at ≤ ttl/2.
- Registry query: `GET /ads?giveNetwork=&giveUnit=&getNetwork=&getUnit=&amount=` → array of unexpired, matching ads. Registries MUST NOT modify ads; clients re-verify signatures locally.
- **Trust model:** the registry is untrusted for everything except availability. Rates never appear in ads — clients always fetch live signed quotes from the hub directly.

## 5. Hash-Consistency Rule (atomicity anchor)

For every order, both legs MUST lock to the **same** `paymentHash` `H`, with `H = sha256(P)` for a preimage `P` known initially only to the final payee:

- `PAY_INVOICE` (client pays hub's incoming, hub pays external invoice): `H` comes from the `targetInvoice`. The hub's incoming hold invoice MUST be created with that same `H`. The hub MUST verify the decoded invoice's hash algorithm is sha256 and reject otherwise (`HASH_ALGO_UNSUPPORTED`).
- `RECEIVE` (external payer pays hub, hub pays client's invoice): `H` comes from the client's `targetInvoice`; the hub's incoming (Lightning or Fiber) hold invoice reuses it.
- The hub never knows `P` before the outgoing leg settles. Settling the incoming leg therefore proves the outgoing leg was paid. This rule is what makes the hub trust-minimized; implementations MUST treat any code path that could settle incoming without a verified `sha256(P) == H` as a critical bug.

**PTLC forward-compatibility:** the `paymentHash` field is defined as `{algo, value}` in `bifrost/0.2`; `0.1` fixes `algo=sha256` implicitly. Implementations SHOULD isolate hash handling behind one interface.

## 6. Expiry Semantics (normative)

Two different clocks exist and MUST be normalized to wall-clock ms:

- **Fiber TLC expiry** — already wall-clock (ms deltas). Use directly.
- **Lightning CLTV** — block heights. Convert conservatively: `wallclock(blocks) = blocks × 600_000 ms` for safety margins on the *outgoing* side, and `blocks × 300_000 ms` (fast-block pessimism) when bounding the *incoming* side — i.e., always convert in the direction that shrinks the apparent safety gap. Implementations MUST document their conversion constants and test them.

**Invariant (MUST):** `incoming.tlcExpiryAt ≥ outgoing.tlcExpiryAt + minSafetyDeltaMs`, evaluated with the conservative conversions above, at order-creation time AND re-evaluated before dispatching the outgoing leg. Violation at creation → reject `EXPIRY_INVARIANT_VIOLATION`; violation detected later → `REFUNDING` (rule R3).

## 7. Error Envelope

Every non-2xx response and every terminal failure embeds:

```json
{ "error": { "code": "NO_ROUTE", "message": "no route to destination on lightning",
             "hint": "the destination may lack inbound capacity; try a smaller amount",
             "retryable": true, "orderId": "01J9…" } }
```

`code` registry (closed set for 0.1): `PAIR_UNSUPPORTED`, `AMOUNT_OUT_OF_BOUNDS`, `INVENTORY_INSUFFICIENT`, `PRICING_UNAVAILABLE`, `INVOICE_INVALID`, `INVOICE_MISMATCH`, `HASH_ALGO_UNSUPPORTED`, `QUOTE_EXPIRED`, `QUOTE_UNKNOWN`, `EXPIRY_INVARIANT_VIOLATION`, `NO_ROUTE`, `OUTGOING_TIMEOUT`, `OUTGOING_FAILED`, `HUB_OVEREXPOSED`, `RATE_LIMITED`, `UNAUTHORIZED`, `INTERNAL`. Implementations MUST NOT invent codes outside this set for 0.1; extension codes go to `x-` prefix.

`hint` is human-readable and non-normative. `retryable` tells clients whether the identical request may succeed later.

## 8. Transport Bindings

- **REST:** JSON over HTTPS. Endpoints as in the system spec (`/v1/quotes`, `/v1/orders`, `/v1/pay`, `/v1/orders/{id}`, `/v1/orders/{id}/cancel`).
- **Stream:** WebSocket `GET /v1/stream`; server pushes `{ "type": "order", "data": Order }` on every transition and `{ "type": "quote_expired", "quoteId": … }`. Clients MUST treat pushes as at-least-once and idempotent (dedupe on `orderId` + `updatedAt`).
- **Auth:** `Authorization: Bearer <api-key>`. Order reads are scoped to the creating key. Rate-limit responses use `RATE_LIMITED` + `Retry-After`.
- **Versioning:** every message carries `protocol`. A hub receiving an unknown minor version SHOULD respond with its own version in the error message; majors are incompatible.

## 9. Client Verification Checklist (normative for SDKs)

Before displaying or acting on a quote, an SDK MUST:
1. Verify `protocol`, quote signature against `hubPubkey`, and `expiresAt > now`.
2. Recompute amounts from `rate` and `feeBreakdown` (±1 unit).
3. Check `pair` matches the request and, for `PAY_INVOICE`, that `getAmount` equals the invoice amount.
4. Check the invoice's timelock is satisfiable given `minSafetyDeltaMs` and `maxIncomingHoldMs`.
Before paying the incoming invoice, verify its `paymentHash` equals the target invoice's hash (§5) and its amount equals `giveAmount`.

## 10. Test Vectors (to be generated by the reference implementation)

The reference repo MUST publish, under `spec/vectors/`:
- `canonical-json/*.json` — object + expected canonical bytes + digest.
- `signatures/*.json` — key, object, expected signature.
- `expiry/*.json` — leg expiries + conversion inputs + expected accept/reject.
- `state-machine/*.json` — event sequences + expected state trajectories, including every REFUNDING path.

An implementation passing all vectors and the checklist in §9 MAY claim `bifrost/0.1` conformance.

---

*Changelog: 0.1 — initial draft (hackathon submission).*
