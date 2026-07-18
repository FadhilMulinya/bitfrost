import DocsLayout from "../components/DocsLayout.jsx";
import CodeBlock from "../components/CodeBlock.jsx";

const ERROR_CODES = [
  ["PAIR_UNSUPPORTED", "Requested asset pair not offered by this hub"],
  ["AMOUNT_OUT_OF_BOUNDS", "Amount outside the hub's configured min/max"],
  ["INVENTORY_INSUFFICIENT", "Hub cannot cover the outgoing leg right now"],
  ["PRICING_UNAVAILABLE", "Pricing strategy could not produce a rate"],
  ["INVOICE_INVALID", "Invoice could not be decoded"],
  ["INVOICE_MISMATCH", "Amount does not match the target invoice"],
  ["HASH_ALGO_UNSUPPORTED", "Invoice hash algorithm is not sha256"],
  ["QUOTE_EXPIRED", "Quote's expiresAt has passed"],
  ["QUOTE_UNKNOWN", "quoteId not found or already redeemed"],
  ["EXPIRY_INVARIANT_VIOLATION", "incoming expiry does not clear outgoing + minSafetyDeltaMs"],
  ["NO_ROUTE", "No route to destination on the outgoing network"],
  ["OUTGOING_TIMEOUT", "Outgoing payment did not resolve in time"],
  ["OUTGOING_FAILED", "Outgoing payment definitively failed"],
  ["HUB_OVEREXPOSED", "Hub's risk limits would be exceeded"],
  ["RATE_LIMITED", "Too many requests; see Retry-After"],
  ["UNAUTHORIZED", "Missing or invalid credentials"],
  ["INTERNAL", "Unclassified hub-side error"],
];

export default function Protocol() {
  return (
    <DocsLayout>
      <h1>Protocol Reference (bifrost/0.1)</h1>

      <p>
        This is the wire protocol between clients (wallets, merchants,
        agents, SDKs) and hubs (Bifrost edge-node daemons), plus the
        advertisement format hubs publish to registries. Any
        implementation that speaks this protocol interoperates --
        bifrostd is the reference implementation, not the protocol.
        Keywords MUST, SHOULD, MAY follow RFC 2119.
      </p>

      <h2 id="overview">Overview</h2>

      <h3>Concepts and roles</h3>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li><strong>Hub</strong> -- operates one Fiber node and one Lightning node, quotes and executes atomic cross-network swaps.</li>
        <li><strong>Client</strong> -- requests quotes and creates orders. Never trusts the hub with settled funds: atomicity is enforced by a shared HTLC payment hash, not reputation.</li>
        <li><strong>Registry</strong> -- indexes signed hub advertisements. Metadata only; never in the money path.</li>
        <li><strong>Quote</strong> -- a signed, expiring price commitment for one swap.</li>
        <li><strong>Order</strong> -- one swap attempt executing under one quote.</li>
      </ul>

      <p>
        All amounts are integers in the asset's smallest unit (sat for
        Lightning BTC, shannon for CKB, UDT base units for UDTs). No floats
        anywhere in the protocol. All timestamps are Unix milliseconds
        (UTC). All binary values are lowercase hex without a 0x prefix.
      </p>

      <h3>Canonical JSON and signing</h3>
      <p>Every signed object (Quote, Advertisement) is signed over its canonical form:</p>
      <ol style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>Remove the signature field.</li>
        <li>
          Serialize per RFC 8785 (JCS): UTF-8, lexicographically sorted keys
          at every level, no insignificant whitespace, numbers in shortest
          form. Because all protocol amounts are strings, no
          numeric-precision ambiguity exists.
        </li>
        <li>
          Compute <code>digest = sha256("bifrost/0.1|" + type_tag + "|" + canonical_bytes)</code>{" "}
          where type_tag is quote or ad. The domain-separation prefix
          prevents cross-type signature reuse.
        </li>
        <li>
          signature = secp256k1 Schnorr (BIP-340) over digest, hex-encoded
          (64 bytes). hubPubkey is the 32-byte x-only public key, hex.
        </li>
      </ol>
      <p>
        Verifiers MUST reject: bad signature, unknown hubPubkey (when
        pinned), expired object, or version prefix mismatch. Every amount
        field is a JSON string of a base-10 integer (e.g. "50000").
        Implementations MUST NOT emit JSON numbers for amounts.
      </p>

      <h2 id="asset-references">Asset References</h2>
      <CodeBlock>{`{ "network": "lightning", "unit": "sat" }
{ "network": "fiber", "unit": "shannon" }
{ "network": "fiber", "unit": "udt", "udtScript": { "codeHash": "...", "hashType": "type", "args": "..." } }`}</CodeBlock>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li><code>network</code> MUST be "lightning" or "fiber".</li>
        <li>
          For <code>unit:"udt"</code>, <code>udtScript</code> MUST be
          present and is the CKB type script identifying the asset.
          Implementations MUST compare UDT assets by the script's canonical
          hash, not by display name.
        </li>
        <li>
          A pair is <code>{"{ give: AssetRef, get: AssetRef }"}</code> from
          the client's perspective: the client gives give and receives get
          (directly or as payment of a target invoice).
        </li>
      </ul>

      <h2 id="quotes">Quotes</h2>

      <h3>QuoteRequest (client to hub)</h3>
      <p><code>POST /v1/quotes</code></p>
      <CodeBlock>{`{
  "protocol": "bifrost/0.1",
  "pair": { "give": {"network":"fiber","unit":"shannon"},
            "get":  {"network":"lightning","unit":"sat"} },
  "amount": { "side": "get", "value": "50000" },
  "mode": "PAY_INVOICE",
  "targetInvoice": "lnbc500u1p..."
}`}</CodeBlock>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>
          <code>mode</code> is PAY_INVOICE or RECEIVE. PAY_INVOICE: client
          wants the hub to pay targetInvoice on the get network.
          targetInvoice MUST be present; amount MUST match the invoice
          amount if the invoice specifies one (hub MUST verify and reject
          mismatches with INVOICE_MISMATCH). RECEIVE: client wants inbound
          funds on get network; hub will later produce the outgoing payment
          to a client-supplied invoice at order creation.
        </li>
        <li><code>amount.side</code> declares which side is fixed; the hub computes the other from its rate.</li>
      </ul>

      <h3>Quote (hub to client)</h3>
      <CodeBlock>{`{
  "protocol": "bifrost/0.1",
  "quoteId": "01J9...ULID",
  "pair": { "give": {...}, "get": {...} },
  "rate": { "num": "50000", "den": "13000000000" },
  "giveAmount": "13026000000",
  "getAmount": "50000",
  "feeBreakdown": { "hubFeePpm": "2000", "flatFee": "0", "estNetworkFee": "12" },
  "issuedAt": 1752505200000,
  "expiresAt": 1752505230000,
  "maxIncomingHoldMs": 21600000,
  "minSafetyDeltaMs": 7200000,
  "hubPubkey": "ab34...",
  "signature": "9f1c..."
}`}</CodeBlock>
      <p>Semantics:</p>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>
          <code>rate</code> is the exact rational get/give before fees.
          giveAmount/getAmount are fully fee-inclusive and final -- the
          client pays exactly giveAmount, the payee receives exactly
          getAmount. Clients SHOULD recompute and verify:
          getAmount ~ giveAmount x rate - fees within 1 unit rounding
          (round direction: always in the hub's favor by at most 1 unit;
          hubs MUST NOT round further).
        </li>
        <li>
          expiresAt - issuedAt SHOULD be 15-60s. A hub MUST honor an
          unexpired quote presented at order creation or reject with
          QUOTE_EXPIRED/INVENTORY_INSUFFICIENT -- it MUST NOT execute at a
          different rate.
        </li>
        <li><code>maxIncomingHoldMs</code> -- longest the hub will hold the client's incoming HTLC awaiting the outgoing leg.</li>
        <li>
          <code>minSafetyDeltaMs</code> -- the hub's required gap:
          incomingExpiry {">="} outgoingExpiry + minSafetyDeltaMs. Published
          so clients can predict feasibility for invoices with tight CLTV.
        </li>
      </ul>

      <h2 id="orders">Orders</h2>

      <h3>OrderCreate (client to hub)</h3>
      <p><code>POST /v1/orders</code></p>
      <CodeBlock>{`{ "protocol": "bifrost/0.1",
  "quoteId": "01J9...",
  "targetInvoice": "lnbc500u1p..." }`}</CodeBlock>
      <p>
        For mode:RECEIVE quotes, targetInvoice is the client's own invoice
        on the get network (client-generated, so the client controls the
        preimage). Hub validation order: quote exists and unexpired to
        signature self-check to invoice decode to hash-consistency rule to
        ExpiryGuard to inventory admission. First failure returns its error
        code; no partial state is created.
      </p>

      <h3>Order (hub to client)</h3>
      <p>Returned on create and on every read/stream event.</p>
      <CodeBlock>{`{
  "protocol": "bifrost/0.1",
  "orderId": "01J9...",
  "quoteId": "01J9...",
  "direction": "FIBER_TO_LN",
  "paymentHash": "c0ffee...",
  "state": "PENDING",
  "incoming": { "network": "fiber", "invoice": "fibt...", "amount": "13026000000",
                "tlcExpiryAt": 1752526800000, "status": "WAITING" },
  "outgoing": { "network": "lightning", "invoice": "lnbc500u1p...", "amount": "50000",
                "tlcExpiryAt": 1752512400000, "status": "WAITING" },
  "failure": null,
  "createdAt": 1752505206000, "updatedAt": 1752505206000
}`}</CodeBlock>

      <p>State machine (normative):</p>
      <CodeBlock>{`PENDING -> INCOMING_HELD -> OUTGOING_IN_FLIGHT -> OUTGOING_SETTLED -> SUCCEEDED
PENDING -> FAILED                      (expiry, cancel)
INCOMING_HELD | OUTGOING_IN_FLIGHT -> REFUNDING -> FAILED`}</CodeBlock>

      <p>Normative transition rules:</p>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li><strong>R1:</strong> A hub MUST NOT settle the incoming HTLC in any state except OUTGOING_SETTLED.</li>
        <li><strong>R2:</strong> A hub MUST NOT dispatch the outgoing payment before INCOMING_HELD.</li>
        <li><strong>R3:</strong> On outgoing failure or when now + minSafetyDeltaMs {">="} incoming.tlcExpiryAt, the hub MUST enter REFUNDING and cancel the incoming hold.</li>
        <li><strong>R4:</strong> At most one outgoing dispatch per paymentHash may be in flight.</li>
        <li><strong>R5:</strong> All transitions MUST be durably persisted before their side effect is acknowledged externally.</li>
      </ul>

      <h3>Hash-consistency rule (atomicity anchor)</h3>
      <p>
        For every order, both legs MUST lock to the same paymentHash H,
        with H = sha256(P) for a preimage P known initially only to the
        final payee.
      </p>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>
          PAY_INVOICE (client pays hub's incoming, hub pays external
          invoice): H comes from the targetInvoice. The hub's incoming hold
          invoice MUST be created with that same H. The hub MUST verify the
          decoded invoice's hash algorithm is sha256 and reject otherwise
          (HASH_ALGO_UNSUPPORTED).
        </li>
        <li>
          RECEIVE (external payer pays hub, hub pays client's invoice): H
          comes from the client's targetInvoice; the hub's incoming
          (Lightning or Fiber) hold invoice reuses it.
        </li>
        <li>
          The hub never knows P before the outgoing leg settles. Settling
          the incoming leg therefore proves the outgoing leg was paid. This
          rule is what makes the hub trust-minimized; implementations MUST
          treat any code path that could settle incoming without a
          verified sha256(P) == H as a critical bug.
        </li>
      </ul>

      <h3>Expiry semantics (normative)</h3>
      <p>Two different clocks exist and MUST be normalized to wall-clock ms:</p>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>Fiber TLC expiry -- already wall-clock (ms deltas). Use directly.</li>
        <li>
          Lightning CLTV -- block heights. Convert conservatively:
          wallclock(blocks) = blocks x 600,000ms for safety margins on the
          outgoing side, and blocks x 300,000ms (fast-block pessimism) when
          bounding the incoming side -- i.e., always convert in the
          direction that shrinks the apparent safety gap.
        </li>
      </ul>
      <p>
        Invariant (MUST): incoming.tlcExpiryAt {">="} outgoing.tlcExpiryAt +
        minSafetyDeltaMs, evaluated with the conservative conversions
        above, at order-creation time AND re-evaluated before dispatching
        the outgoing leg. Violation at creation returns
        EXPIRY_INVARIANT_VIOLATION; violation detected later triggers
        REFUNDING (rule R3).
      </p>

      <h2 id="advertisements">Advertisements</h2>
      <p>Hub to registry, <code>POST /ads</code> on a registry.</p>
      <CodeBlock>{`{
  "protocol": "bifrost/0.1",
  "hubPubkey": "ab34...",
  "endpoints": { "api": "https://hub.example.com/v1" },
  "pairs": [ { "give": {...}, "get": {...}, "minAmount": "1000", "maxAmount": "10000000" } ],
  "fiberNodeId": "...", "lightningNodeId": "...",
  "issuedAt": 1752505200000,
  "ttlMs": 3600000,
  "signature": "..."
}`}</CodeBlock>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>Registries MUST verify the signature and MUST reject issuedAt older than 5 minutes (anti-replay) or in the future by more than 60s.</li>
        <li>Ads expire at issuedAt + ttlMs; hubs SHOULD republish at or before ttl/2.</li>
        <li>
          Registry query: <code>GET /ads?giveNetwork=&giveUnit=&getNetwork=&getUnit=&amount=</code>{" "}
          returns an array of unexpired, matching ads. Registries MUST NOT
          modify ads; clients re-verify signatures locally.
        </li>
        <li>
          Trust model: the registry is untrusted for everything except
          availability. Rates never appear in ads -- clients always fetch
          live signed quotes from the hub directly.
        </li>
      </ul>

      <h2 id="error-codes">Error Codes</h2>
      <p>Every non-2xx response and every terminal failure embeds:</p>
      <CodeBlock>{`{ "error": { "code": "NO_ROUTE", "message": "no route to destination on lightning",
             "hint": "the destination may lack inbound capacity; try a smaller amount",
             "retryable": true, "orderId": "01J9..." } }`}</CodeBlock>
      <p>
        hint is human-readable and non-normative. retryable tells clients
        whether the identical request may succeed later. This is a closed
        set for 0.1 -- implementations MUST NOT invent codes outside it;
        extension codes go to an x- prefix.
      </p>
      <table>
        <thead>
          <tr>
            <th>Code</th>
            <th>Meaning</th>
          </tr>
        </thead>
        <tbody>
          {ERROR_CODES.map(([code, meaning]) => (
            <tr key={code}>
              <td><code>{code}</code></td>
              <td>{meaning}</td>
            </tr>
          ))}
        </tbody>
      </table>

      <h3>Transport bindings</h3>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>REST: JSON over HTTPS. Endpoints as in the system spec (/v1/quotes, /v1/orders, /v1/pay, /v1/orders/{"{id}"}, /v1/orders/{"{id}"}/cancel).</li>
        <li>
          Stream: WebSocket GET /v1/stream; server pushes{" "}
          <code>{'{ "type": "order", "data": Order }'}</code> on every
          transition and <code>{'{ "type": "quote_expired", "quoteId": ... }'}</code>.
          Clients MUST treat pushes as at-least-once and idempotent (dedupe
          on orderId + updatedAt).
        </li>
        <li>
          Auth: Authorization: Bearer {"<api-key>"}. Order reads are scoped
          to the creating key. Rate-limit responses use RATE_LIMITED +
          Retry-After. (Spec-normative; see{" "}
          <a href="/docs/security#known-gaps">Known Gaps</a> for the live
          hub's current auth status.)
        </li>
        <li>Versioning: every message carries protocol. A hub receiving an unknown minor version SHOULD respond with its own version in the error message; majors are incompatible.</li>
      </ul>

      <h3>Client verification checklist (normative for SDKs)</h3>
      <p>Before displaying or acting on a quote, an SDK MUST:</p>
      <ol style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>Verify protocol, quote signature against hubPubkey, and expiresAt {">"} now.</li>
        <li>Recompute amounts from rate and feeBreakdown (within 1 unit).</li>
        <li>Check pair matches the request and, for PAY_INVOICE, that getAmount equals the invoice amount.</li>
        <li>Check the invoice's timelock is satisfiable given minSafetyDeltaMs and maxIncomingHoldMs.</li>
      </ol>
      <p>Before paying the incoming invoice, verify its paymentHash equals the target invoice's hash and its amount equals giveAmount.</p>
    </DocsLayout>
  );
}
