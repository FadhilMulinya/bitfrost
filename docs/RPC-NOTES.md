# FNN RPC Notes — Hold-Invoice Semantics

Source examined: `nervosnetwork/fiber` at commit `04e091b08953368aa5ee977f562ad628c3000ff4`
(main, 2026-07-07), plus PR [#942](https://github.com/nervosnetwork/fiber/pull/942)
("feat: multi-hop fiber payments for cch", merged 2025-11-11), which introduced this behavior.

## Answer

**Yes — FNN's `new_invoice` RPC accepts an externally supplied `payment_hash`, and
supplying a hash (with no preimage) is explicitly documented as a hold invoice.**
The incoming TLC set is accepted and *held* until the preimage is supplied later via
`settle_invoice` (or released via `cancel_invoice`). This is true hold-invoice
semantics, equivalent to LND's `invoicesrpc.AddHoldInvoice`.

## `new_invoice`

Method name: `new_invoice` (invoice module). Params struct `NewInvoiceParams`
(`crates/fiber-json-types/src/invoice.rs:119`):

| Field | Type (wire) | Notes |
|---|---|---|
| `amount` | u128, **hex string** (`U128Hex`) | required |
| `currency` | `Currency` enum | must match node network |
| `payment_preimage` | `Hash256`, optional | if set, `payment_hash` must be absent |
| `payment_hash` | `Hash256`, optional | if set, `payment_preimage` must be absent → **hold invoice** |
| `description` | string, optional | |
| `expiry` | u64 seconds, hex string, optional | invoice expiry |
| `final_expiry_delta` | u64 **milliseconds**, hex string, optional | clamped to [`MIN_TLC_EXPIRY_DELTA`, `MAX_PAYMENT_TLC_EXPIRY_LIMIT`] (doc comment says min 16 h, max 14 d) |
| `fallback_address` | string, optional | |
| `udt_type_script` | CKB `Script`, optional | |
| `hash_algorithm` | `HashAlgorithm`, optional | pass `Sha256` explicitly for cross-chain (CkbHash is the alternative) |
| `allow_mpp` / `allow_trampoline_routing` | bool, optional | require node feature support |

Doc comment on `payment_hash` (verbatim): *"If hash is set, preimage must be absent.
This condition indicates a 'hold invoice' for which the tlc must be accepted and held
until the preimage becomes known."*

Handler logic (`crates/fiber-lib/src/rpc/invoice.rs:187-203`): if preimage given → stored;
if both absent → random preimage generated (normal invoice); if **only hash given → no
preimage stored**, invoice built with the external hash. Duplicate payment hashes are
rejected ("invoice already exists").

## `settle_invoice` / `cancel_invoice`

- `settle_invoice` — `SettleInvoiceParams { payment_hash: Hash256, payment_preimage: Hash256 }`.
  Sends `NetworkActorCommand::SettleInvoice(hash, preimage)`; this is how a held TLC set
  is released once the preimage is learned from the outgoing leg. Returns empty
  `SettleInvoiceResult {}`.
- `cancel_invoice` — `InvoiceParams { payment_hash: Hash256 }`. Triggers
  `NetworkActorCommand::SettleHoldTlcSet(payment_hash)`, which fails held
  TLCs back with error code `HoldTlcTimeout` (`PERM | 23`).
  CORRECTION (verified live on rc7, 2026-07-15): earlier reading said "Open
  only", but cancelling a `Received` (TLC-held) invoice works — status flips
  to `Cancelled` and the held TLC is released to the payer. The OrderEngine's
  R3 refund path (cancel a HELD incoming) depends on exactly this.
- `get_invoice` — `InvoiceParams { payment_hash }` → invoice + status
  (`Open | Cancelled | Expired | Received | Paid`; `Received` = TLCs held, awaiting preimage).

## Hold-TLC internals (for context, not for the adapter)

`HoldTlc { channel_id: Hash256, tlc_id: u64, hold_expire_at: u64 }`
(`crates/fiber-lib/src/fiber/types.rs:2064`). Held TLCs are tracked per payment hash;
`settle_tlc_set_command.rs` settles/rejects the whole set atomically, including MPP sets,
and times out holds with `HoldTlcTimeout`. So hold expiry is enforced node-side.

## CCH module confirmation

The built-in CCH does exactly what Bifrost needs to do: in `send_btc`
(`crates/fiber-lib/src/cch/actor.rs`), it extracts the payment hash from the outgoing
BOLT11 invoice and builds the incoming Fiber invoice with
`.payment_hash(payment_hash).hash_algorithm(HashAlgorithm::Sha256)` — i.e. a hold invoice
keyed to the external LN hash — then registers it via an `AddInvoice` command (PR #942
added `AddInvoice`/`SettleInvoice` network-actor commands). It also enforces an expiry
safety rule: outgoing BTC final CLTV (blocks × 600 s) must be < half the incoming CKB
final TLC expiry.

CCH RPC methods: `send_btc` (`SendBTCParams { btc_pay_req, currency }`),
`receive_btc` (`ReceiveBTCParams { fiber_pay_req }`), `get_cch_order`
(`GetCchOrderParams { payment_hash }`) → `CchOrderResponse` with
`status: Pending | IncomingAccepted | OutgoingInFlight | OutgoingSuccess | Success | Failed`.

## Caveats / open items

- Numeric params are hex-encoded strings (`0x…`) on the wire (`U64Hex`/`U128Hex`), not
  decimal — the adapter must encode accordingly.
- `final_expiry_delta` is milliseconds while `expiry` is seconds; easy to confuse.
- The maximum hold duration for a held TLC (`hold_expire_at` derivation) was not traced
  to a config knob in this pass — verify before relying on long holds.
- Findings are from main as of 2026-07-07; the deployed testnet Docker image may lag.
  Verify `new_invoice` accepts `payment_hash` against the actual node version we run.

## Adapter divergence log (bifrostd/src/adapters/, 2026-07-15)

Where SYSTEM-DESIGN §4.1's interfaces diverge from what the nodes actually
expose, the adapters follow reality. No capability is faked.

1. **`FiberAdapter.parseInvoice` is async, not sync.** The spec declares a
   synchronous `parseInvoice(invoice): FiberInvoiceDetails`; FNN only parses
   via the `parse_invoice` RPC, so the adapter method returns a Promise.
2. **`newHoldInvoice` signature adapted to FNN units/requirements.**
   `finalTlcExpiryDeltaMs` is explicitly milliseconds (FNN `final_expiry_delta`
   unit; node clamps to [16 h, 14 d]), and the adapter carries a required
   `currency` (`Fibb|Fibt|Fibd`) the spec interface omits — FNN rejects
   mismatches with the node network. `hash_algorithm: "sha256"` is always sent
   explicitly (PTLC seam).
3. **`subscribeStoreChanges` requires the WS endpoint.** Bound to jsonrpsee
   subscription `subscribe_store_changes` / `unsubscribe_store_changes`
   (verified in fiber source `rpc/pubsub.rs`; the `pubsub` module is enabled in
   the deployed rc7 node configs). On an HTTP-only transport the adapter throws
   a typed error instead of pretending; `pollLegEvents(paymentHash, role)` is
   the documented polling alternative (get_invoice/get_payment). Note:
   `get_payment` does NOT return the preimage — on the polling path the
   preimage only arrives via the `PutPreimage` store change (WS) or the settled
   TLC, which the OrderEngine must handle.
4. **LightningAdapter uses LND's REST proxy, not native gRPC.** The spec names
   gRPC; the adapter binds the same invoicesrpc/routerrpc methods through their
   1:1 REST mappings (`AddHoldInvoice`→`POST /v2/invoices/hodl`,
   `SettleInvoice`→`/v2/invoices/settle`, `CancelInvoice`→`/v2/invoices/cancel`,
   `SendPaymentV2`→`POST /v2/router/send` stream,
   `TrackPaymentV2`→`GET /v2/router/track/{hash}` stream,
   `SubscribeSingleInvoice`→`/v2/invoices/subscribe/{hash}` stream) to avoid a
   proto/grpc-js dependency. REST quirks: byte fields are base64 (base64url in
   URL paths), int64s are JSON strings, stream frames wrap as `{"result": …}`.
5. **`send_payment` params verified against source:** `{ invoice,
   max_fee_amount?: U128Hex, tlc_expiry_limit?: u64 }`;
   `get_payment { payment_hash }` → `status: Created|Inflight|Success|Failed`,
   `failed_error?`. StoreChange variants consumed: `PutCkbInvoiceStatus`
   (`Received`→held, `Paid`→settled, `Cancelled|Expired`→cancelled) and
   `PutPreimage` (preimage learned).

Contract tests (`bifrostd/test/contract.it.test.ts`, run with `BIFROST_IT=1`
against the compose env) verify the rc7 caveats above: external-hash hold
invoice accepted, duplicate hash rejected, wrong-preimage settle refused,
parse round-trip, and LND hold states OPEN→CANCELED.

6. **`lnrpc.LookupInvoice` added to LightningAdapter** (`GET /v1/invoice/{r_hash_str}`,
   hex path param — the one LND REST byte-field that is hex, not base64url).
   Needed by the OrderEngine's I4 crash-recovery reconciliation to query
   incoming hold-invoice state without opening a subscription stream.
7. **FNN outgoing preimage is WS-only.** `get_payment` never returns the
   preimage, so an OUTGOING_SETTLED signal from polling carries no preimage;
   the OrderEngine deliberately PARKS the order in OUTGOING_IN_FLIGHT until
   the `PutPreimage` store change arrives over `subscribe_store_changes`
   (I1: nothing verifiable → nothing settleable). LN→Fiber swaps therefore
   REQUIRE the WS transport on the hub FNN; the smoke runner wires
   `WsJsonRpc` (pubsub module confirmed enabled in the dev node 3 config).

## In-flight TLC amounts per channel (2026-07-15, live-verified on rc7)

Needed for the smoke-liquidity-preflight fix (deploy/scripts/lib.sh) and,
later, the real InventoryManager: which RPC exposes outstanding TLC exposure
per channel, so "spendable outbound" can be computed as something better than
raw `local_balance`.

**Fiber (FNN): `list_channels`.** Queried live against a real channel
(`rpc list_channels [{"peer_id":null}]`) — the response already carries this,
no separate RPC needed:

```json
{
  "local_balance": "0x9c40",
  "offered_tlc_balance": "0x0",
  "remote_balance": "0x27100",
  "received_tlc_balance": "0x0",
  "pending_tlcs": [
    { "id": "0x4", "amount": "0x1388", "payment_hash": "0x...",
      "status": { "Outbound": "RemoveAckConfirmed" } }
  ]
}
```

- `offered_tlc_balance` — sum of currently-locked OUTBOUND TLCs (what this
  node has offered and not yet had removed/settled). This is exactly the
  "in-flight" amount to subtract from `local_balance` for spendable outbound.
  A TLC that has reached `RemoveAckConfirmed` (settling/removing, no longer
  capital-locking) is correctly excluded — confirmed live: a channel with a
  `pending_tlcs` entry in that status still reported `offered_tlc_balance:
  "0x0"`.
  So: **spendable outbound (fiber) = local_balance − offered_tlc_balance.**
- `received_tlc_balance` — the inbound mirror, for spendable *inbound*.
- `pending_tlcs[]` — full per-TLC detail (id, amount, payment_hash, expiry,
  status) if a caller needs more than the aggregate. `status.Outbound` /
  `status.Inbound` distinguishes direction; sub-states beyond
  `RemoveAckConfirmed` were not enumerated in this pass.
- **No separate "channel reserve" field is exposed on the Fiber side** (unlike
  LND's `chan_reserve_sat`) — none of the fields above, nor anything in the
  vendored upstream bruno fixtures (`tests/bruno/e2e/**/*.bru`), reference a
  reserve concept. Treated as "not applicable to Fiber" rather than
  "undiscovered" — if this turns out wrong, the InventoryManager will need a
  correction pass.
- **No `list_invoices` (or any invoice-enumeration) RPC exists** — confirmed
  live (`-32601 Method not found`). A hub can only query a hold invoice's
  state by `payment_hash` (`get_invoice`) or cancel it by hash
  (`cancel_invoice`). This means stale-HELD-invoice cleanup after an aborted
  run can only act on hashes the caller already recorded itself; there is no
  way to ask FNN "list everything you're currently holding." The smoke
  preflight works around this by writing payment hashes to
  `deploy/.smoke-state/fiber-stale-hashes.txt` as soon as a hold invoice is
  created, and sweeping that file on the next run's preflight
  (`cancel_stale_fiber_invoices` in `deploy/scripts/lib.sh`). The real
  InventoryManager will need the same workaround, or its own persistent
  ledger of outstanding hub-issued hold invoices, since the node itself
  cannot be asked.

**Lightning (LND): `listchannels`.** Standard fields, queried live:

```json
{
  "local_balance": "766530",
  "local_chan_reserve_sat": "10000",
  "unsettled_balance": "0",
  "pending_htlcs": []
}
```

Spendable outbound (LN) = `local_balance − local_chan_reserve_sat −
unsettled_balance`. `pending_htlcs[]` gives per-HTLC detail if needed.
Stale HELD invoices ARE enumerable here — `listinvoices --pending_only=true`
returns invoices in state `ACCEPTED` (a hold invoice with the TLC held,
awaiting settle/cancel), which the preflight cancels via `cancelinvoice`
before deciding whether more capacity is needed.
