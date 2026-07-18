import { Link } from "react-router-dom";
import DocsLayout from "../components/DocsLayout.jsx";

const ERROR_CODES = [
  ["PAIR_UNSUPPORTED", "The requested asset pair is not offered by this hub"],
  ["AMOUNT_OUT_OF_BOUNDS", "Amount is outside the hub's advertised min/max for this pair"],
  ["INVENTORY_INSUFFICIENT", "Hub does not have enough liquidity to cover this quote"],
  ["PRICING_UNAVAILABLE", "Hub cannot currently price this pair"],
  ["INVOICE_INVALID", "Target invoice could not be decoded"],
  ["INVOICE_MISMATCH", "Quote amount does not match the target invoice amount"],
  ["HASH_ALGO_UNSUPPORTED", "Payment hash algorithm is not sha256"],
  ["QUOTE_EXPIRED", "Quote's expiresAt has passed"],
  ["QUOTE_UNKNOWN", "quoteId does not exist or was already redeemed"],
  ["EXPIRY_INVARIANT_VIOLATION", "incoming.tlcExpiryAt >= outgoing.tlcExpiryAt + minSafetyDeltaMs does not hold"],
  ["NO_ROUTE", "Outgoing leg has no viable payment route"],
  ["OUTGOING_TIMEOUT", "Outgoing leg did not settle before its deadline"],
  ["OUTGOING_FAILED", "Outgoing leg failed outright"],
  ["HUB_OVEREXPOSED", "Hub's risk limits would be exceeded by this order"],
  ["RATE_LIMITED", "Too many requests; see Retry-After"],
  ["UNAUTHORIZED", "Missing or invalid credentials"],
  ["INTERNAL", "Unexpected server-side error"],
];

export default function Sdk() {
  return (
    <DocsLayout>
      <h1>SDK Reference</h1>

      <h2 id="installation">
        Installation{" "}
        <a
          href="#installation"
          className="section-anchor"
          aria-label="Link to Installation section"
        >
          §
        </a>
      </h2>
      <pre>npm install bifrost-sdk</pre>

      <h2 id="bifrost-client">
        Bifrost Client{" "}
        <a
          href="#bifrost-client"
          className="section-anchor"
          aria-label="Link to Bifrost Client section"
        >
          §
        </a>
      </h2>
      <pre>{`import { Bifrost } from "bifrost-sdk";

const bf = new Bifrost({
  registryUrl: "optional -- for hub discovery",
  apiKey: "optional -- if hub requires auth"
});`}</pre>
      <p>
        Constructor options mirror <code>BifrostOptions</code>:{" "}
        <code>registryUrl</code> (hub discovery registry base URL),{" "}
        <code>apiKey</code> (sent as <code>Authorization: Bearer</code>),{" "}
        <code>fetchImpl</code> (custom fetch, defaults to global fetch),{" "}
        <code>now</code> (clock override for tests, defaults to{" "}
        <code>Date.now</code>).
      </p>

      <h2>Methods</h2>

      <h3 id="discover">
        bf.discover(pair, amount){" "}
        <a
          href="#discover"
          className="section-anchor"
          aria-label="Link to bf.discover(pair, amount) section"
        >
          §
        </a>
      </h3>
      <p>
        Queries the registry for hubs advertising <code>pair</code>, verifies
        each advertisement's signature and expiry, and returns only the ones
        that pass. Throws if no <code>registryUrl</code> was configured.
      </p>

      <h3 id="getquote">
        bf.getQuote(hubApi, request){" "}
        <a
          href="#getquote"
          className="section-anchor"
          aria-label="Link to bf.getQuote(hubApi, request) section"
        >
          §
        </a>
      </h3>
      <p>
        Requests a quote directly from a hub's API URL and verifies it
        against the full PROTOCOL §9 checklist (signature, expiry, pair
        match, and -- if <code>invoiceAmount</code> is passed -- amount
        match) before returning it. There is no way to get an unverified
        quote out of this method.
      </p>

      <h3 id="getquotes">
        bf.getQuotes(hubs, request){" "}
        <a
          href="#getquotes"
          className="section-anchor"
          aria-label="Link to bf.getQuotes(hubs, request) section"
        >
          §
        </a>
      </h3>
      <p>
        Fans <code>getQuote</code> out across multiple hubs in parallel via{" "}
        <code>Promise.allSettled</code> and returns only the ones that
        resolved. Pair with <code>Bifrost.bestQuote()</code> to pick the best
        rate.
      </p>

      <h3 id="payanyinvoice">
        bf.payAnyInvoice(hubApi, invoice, giveAsset){" "}
        <a
          href="#payanyinvoice"
          className="section-anchor"
          aria-label="Link to bf.payAnyInvoice(hubApi, invoice, giveAsset) section"
        >
          §
        </a>
      </h3>
      <p>
        Detects whether <code>invoice</code> is a Lightning (BOLT11) or Fiber
        invoice, builds a <code>PAY_INVOICE</code> quote request, verifies the
        quote's amount matches the invoice exactly, and creates an order.
        Returns <code>{"{ order, quote }"}</code>. Rejects invoices with a
        sub-sat (msat-precision) amount, since PAY_INVOICE requires a
        whole-sat amount match.
      </p>

      <h3 id="watchorder">
        bf.watchOrder(hubApi, orderId){" "}
        <a
          href="#watchorder"
          className="section-anchor"
          aria-label="Link to bf.watchOrder(hubApi, orderId) section"
        >
          §
        </a>
      </h3>
      <p>
        An async generator that opens a WebSocket to the hub's stream
        endpoint and yields <code>Order</code> updates for{" "}
        <code>orderId</code>, deduped on <code>orderId:updatedAt:state</code>{" "}
        (at-least-once delivery). Stops after yielding a terminal state (
        <code>SUCCEEDED</code> or <code>FAILED</code>) or when the socket
        closes.
      </p>

      <Link to="/docs/playground" className="callout" style={{ display: "block" }}>
        → Try these methods live in the API Playground
      </Link>

      <h2 id="types">
        Types{" "}
        <a
          href="#types"
          className="section-anchor"
          aria-label="Link to Types section"
        >
          §
        </a>
      </h2>

      <p><code>PROTOCOL_VERSION</code> — the literal string <code>"bifrost/0.1"</code>, stamped on every signed message.</p>

      <p><code>CkbScript</code> — <code>{"{ codeHash, hashType, args }"}</code>, a CKB lock/type script reference.</p>

      <p>
        <code>AssetRef</code> — a tagged union: lightning/sat,
        fiber/shannon, or fiber/udt (with a <code>CkbScript</code>).
      </p>

      <p><code>Pair</code> — <code>{"{ give: AssetRef, get: AssetRef }"}</code>.</p>

      <p><code>Amount</code> — a base-10 integer string. All wire amounts are strings; never floats.</p>

      <p><code>QuoteMode</code> — <code>"PAY_INVOICE"</code> or <code>"RECEIVE"</code>.</p>

      <p>
        <code>QuoteRequest</code> — <code>{"{ protocol, pair, amount: { side, value }, mode, targetInvoice? }"}</code>.
      </p>

      <p><code>FeeBreakdown</code> — <code>{"{ hubFeePpm, flatFee, estNetworkFee }"}</code>.</p>

      <p>
        <code>Quote</code> — signed quote object: <code>quoteId</code>,{" "}
        <code>pair</code>, <code>rate</code>, <code>giveAmount</code>,{" "}
        <code>getAmount</code>, <code>feeBreakdown</code>,{" "}
        <code>issuedAt</code>/<code>expiresAt</code>,{" "}
        <code>maxIncomingHoldMs</code>, <code>minSafetyDeltaMs</code>,{" "}
        <code>hubPubkey</code>, <code>signature</code>.
      </p>

      <p>
        <code>OrderState</code> — one of <code>PENDING</code>,{" "}
        <code>INCOMING_HELD</code>, <code>OUTGOING_IN_FLIGHT</code>,{" "}
        <code>OUTGOING_SETTLED</code>, <code>SUCCEEDED</code>,{" "}
        <code>REFUNDING</code>, <code>FAILED</code>.
      </p>

      <p>
        <code>LegStatus</code> — <code>WAITING</code>, <code>HELD</code>,{" "}
        <code>IN_FLIGHT</code>, <code>SETTLED</code>, <code>CANCELLED</code>,{" "}
        <code>FAILED</code>.
      </p>

      <p>
        <code>Leg</code> — <code>{"{ network, invoice, amount, tlcExpiryAt, status, preimage? }"}</code>, one side (incoming or outgoing) of an order.
      </p>

      <p><code>OrderCreate</code> — <code>{"{ protocol, quoteId, targetInvoice? }"}</code>, the request body to redeem a quote.</p>

      <p>
        <code>Order</code> — <code>orderId</code>, <code>quoteId</code>,{" "}
        <code>direction</code> (<code>FIBER_TO_LN</code> or{" "}
        <code>LN_TO_FIBER</code>), <code>paymentHash</code>,{" "}
        <code>state</code>, <code>incoming</code>/<code>outgoing</code> legs,{" "}
        <code>failure</code>, <code>createdAt</code>/<code>updatedAt</code>.
      </p>

      <p><code>AdvertisedPair</code> — a <code>Pair</code> plus <code>minAmount</code>/<code>maxAmount</code>.</p>

      <p>
        <code>Advertisement</code> — signed hub listing: <code>hubPubkey</code>,{" "}
        <code>endpoints</code>, <code>pairs</code>,{" "}
        <code>fiberNodeId</code>/<code>lightningNodeId</code>,{" "}
        <code>issuedAt</code>/<code>ttlMs</code>, <code>signature</code>.
      </p>

      <p><code>ErrorCode</code> — one of the 17 closed registry codes below.</p>

      <p>
        <code>ProtocolError</code> — <code>{"{ code, message, hint?, retryable, orderId? }"}</code>.
      </p>

      <p>
        <code>StreamEvent</code> — <code>{'{ type: "order", data: Order }'}</code> or{" "}
        <code>{'{ type: "quote_expired", quoteId }'}</code>.
      </p>

      <h2>Error Codes</h2>
      <table>
        <thead><tr><th>Code</th><th>Meaning</th></tr></thead>
        <tbody>
          {ERROR_CODES.map(([code, meaning]) => (
            <tr key={code}><td><code>{code}</code></td><td>{meaning}</td></tr>
          ))}
        </tbody>
      </table>
    </DocsLayout>
  );
}
