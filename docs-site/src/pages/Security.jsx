import DocsLayout from "../components/DocsLayout.jsx";
import CodeBlock from "../components/CodeBlock.jsx";

export default function Security() {
  return (
    <DocsLayout>
      <h1>Security</h1>

      <h2 id="trust-model">
        Trust model{" "}
        <a
          href="#trust-model"
          className="section-anchor"
          aria-label="Link to Trust model section"
        >
          §
        </a>
      </h2>
      <p>A hub operator can:</p>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Set prices and refuse quotes</li>
        <li>Fail an order (outgoing leg times out or has no route)</li>
        <li>See order metadata: invoice strings, amounts, payment hashes</li>
      </ul>
      <p>A hub operator cannot:</p>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Settle the incoming leg without the outgoing leg's preimage</li>
        <li>Take the customer's funds without paying the outgoing leg</li>
        <li>Forge a quote or advertisement -- both are signed and verified client-side</li>
      </ul>

      <h2 id="htlc-atomicity">
        HTLC Atomicity (Invariant I1){" "}
        <a
          href="#htlc-atomicity"
          className="section-anchor"
          aria-label="Link to HTLC Atomicity (Invariant I1) section"
        >
          §
        </a>
      </h2>
      <p>
        The incoming hold invoice is NEVER settled before the outgoing
        preimage is verified.
      </p>
      <CodeBlock>{`Code:      bifrostd/src/orders/engine.ts -> settleIncoming()
           Only call site of hold.settle()
Gated by:  state === "OUTGOING_SETTLED" && hexPreimageMatches()
Audited:   2026-07-16 (see docs/SECURITY.md)`}</CodeBlock>

      <h2 id="expiry-invariant">
        Expiry Invariant (I2){" "}
        <a
          href="#expiry-invariant"
          className="section-anchor"
          aria-label="Link to Expiry Invariant (I2) section"
        >
          §
        </a>
      </h2>
      <CodeBlock>{"incoming.tlcExpiryAt >= outgoing.tlcExpiryAt + minSafetyDeltaMs"}</CodeBlock>
      <p>Default <code>minSafetyDeltaMs</code>: 7,200,000 ms (2 hours).</p>
      <p>Enforced at three points:</p>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Order creation -- rejected up front if the gap doesn't hold</li>
        <li>Immediately before outgoing dispatch -- re-checked, refunds if the gap has closed since creation</li>
        <li>Periodic sweep -- catches orders that go stale waiting in <code>INCOMING_HELD</code></li>
      </ul>
      <p>
        CLTV-to-milliseconds conversion is deliberately asymmetric and
        pessimistic in both directions: the outgoing side uses 600,000
        ms/block (slow-block assumption, overestimates how long the
        outgoing leg can hang), the incoming side uses 300,000 ms/block
        (fast-block assumption, underestimates the incoming hold window).
        Both directions shrink the apparent safety gap, never widen it.
      </p>

      <h2 id="known-gaps">
        Known gaps{" "}
        <a
          href="#known-gaps"
          className="section-anchor"
          aria-label="Link to Known gaps section"
        >
          §
        </a>
      </h2>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>
          No API authentication. Bearer-token auth was added, then
          deliberately removed: a quote expires in 30 seconds, and creating
          an order requires actually paying the Fiber hold invoice -- no
          payment, no swap, the hub loses nothing. Residual gap: <code>GET
          /v1/orders</code> and <code>GET /v1/inventory</code> are
          unauthenticated reads (order metadata, live liquidity) -- accepted
          for a demo hub with no real funds, but real if this hub is
          tunneled publicly.
        </li>
        <li>
          CORS is <code>Access-Control-Allow-Origin: *</code> on every
          response, no environment-based restriction.
        </li>
        <li>
          Demo endpoints (<code>/v1/demo/*</code>) are gated behind{" "}
          <code>DEMO_ENDPOINTS_ENABLED</code>, fail-closed by default (404
          unless explicitly enabled).
        </li>
        <li>No external price feed -- pricing is static-peg or feed-spread depending on operator configuration, not sourced from a canonical market feed by default.</li>
        <li>No rate limiting -- <code>RATE_LIMITED</code> is a defined error code that nothing currently throws.</li>
        <li>Event log is a single file, not Postgres -- fine for a demo hub, not for production durability.</li>
      </ul>
      <p>
        See <code>docs/STATUS.md</code> and <code>docs/SECURITY.md</code> in
        the repository for the full, currently-maintained honesty table.
      </p>
    </DocsLayout>
  );
}
