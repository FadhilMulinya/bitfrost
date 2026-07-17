import { Link } from "react-router-dom";
import DocsLayout from "../components/DocsLayout.jsx";

export default function QuickStart() {
  return (
    <DocsLayout>
      <h1>Quick Start</h1>

      <h2>Option 1: Use the live hub (no setup)</h2>
      <p>The simplest way to try Bifrost:</p>

      <pre>npm install bifrost-sdk</pre>

      <pre>{`import { Bifrost } from "bifrost-sdk";

const HUB = "https://superb-grouse-genuinely.ngrok-free.app/v1";

// 1. Check hub health
const res = await fetch(\`\${HUB}/health\`);
const health = await res.json();
console.log(health.fnn.connected); // true

// 2. Get a quote
const bf = new Bifrost({});
const quote = await bf.getQuote(HUB, {
  protocol: "bifrost/0.1",
  pair: {
    give: { network: "fiber", unit: "shannon" },
    get:  { network: "lightning", unit: "sat" }
  },
  amount: { side: "get", value: "5000" },
  mode: "PAY_INVOICE",
  targetInvoice: "lnbcrt..."
});

console.log(quote.giveAmount); // shannon to pay
console.log(quote.getAmount);  // sats merchant receives`}</pre>

      <p>
        This hub currently has no API-key auth (see{" "}
        <Link to="/docs/security#known-gaps">Known Gaps</Link>) and is a
        demo instance, not a production deployment.
      </p>

      <h2>Option 2: Run your own hub</h2>
      <p>
        See: <Link to="/docs/running-a-hub">Running a Hub</Link>
      </p>
    </DocsLayout>
  );
}
