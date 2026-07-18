import { Link } from "react-router-dom";
import DocsLayout from "../components/DocsLayout.jsx";
import CodeBlock from "../components/CodeBlock.jsx";

export default function HowItWorks() {
  return (
    <DocsLayout>
      <h1>How It Works</h1>

      <h2>The problem</h2>
      <p>Fiber Network uses CKB-based payment channels (TLC).</p>
      <p>Lightning Network uses Bitcoin payment channels (HTLC).</p>
      <p>They cannot talk to each other natively.</p>

      <h2>The solution</h2>
      <p>
        A Bifrost hub operator runs both a Fiber node and a Lightning node.
        When a user wants to pay a Lightning invoice using Fiber assets:
      </p>

      <ol style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>User requests a quote from the hub</li>
        <li>Hub issues a Fiber hold invoice with the SAME payment hash as the Lightning invoice</li>
        <li>User pays the Fiber hold invoice</li>
        <li>Hub pays the Lightning invoice</li>
        <li>When the Lightning payee claims the payment, they reveal the preimage</li>
        <li>Hub uses that preimage to claim the Fiber payment</li>
        <li>Both legs settle atomically</li>
      </ol>

      <h2>Why the hub cannot steal</h2>
      <p>
        The Fiber hold invoice is locked to the same payment hash H =
        sha256(P) as the Lightning invoice.
      </p>
      <p>
        The hub only learns P (the preimage) when the Lightning payee
        claims their payment.
      </p>
      <p>The hub can only settle the Fiber side using P.</p>

      <p style={{ marginTop: "1rem" }}>Therefore:</p>
      <ul style={{ margin: "0.5rem 0 1rem 1.5rem" }}>
        <li>If Lightning payment succeeds, hub learns P, both legs settle, swap complete</li>
        <li>If Lightning payment fails, hub never learns P, Fiber hold expires, user refunded automatically</li>
      </ul>

      <p>The hub can fail. It cannot steal.</p>

      <h2>State machine</h2>
      <CodeBlock>{`PENDING -> INCOMING_HELD -> OUTGOING_IN_FLIGHT
        -> OUTGOING_SETTLED -> SUCCEEDED

INCOMING_HELD -> REFUNDING -> FAILED (if outgoing fails)`}</CodeBlock>

      <Link to="/docs/playground" className="callout" style={{ display: "block" }}>
        → Try this in the API Playground
      </Link>
    </DocsLayout>
  );
}
