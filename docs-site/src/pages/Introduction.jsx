import DocsLayout from "../components/DocsLayout.jsx";
import StatusTable from "../components/StatusTable.jsx";

export default function Introduction() {
  return (
    <DocsLayout>
      <h1>Introduction</h1>

      <p>
        Bifrost is infrastructure for atomic swaps between Fiber Network
        (CKB) and Bitcoin Lightning Network.
      </p>

      <p style={{ marginTop: "1rem" }}>
        It generalizes Fiber's built-in CCH (Cross-Chain Hub) from a
        hard-coded 1:1 BTC to wBTC bridge into an open RFQ (Request for
        Quote) protocol with:
      </p>

      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Negotiated, signed quotes</li>
        <li>Multi-asset support</li>
        <li>Hub discovery registry</li>
        <li>A TypeScript SDK (bifrost-sdk)</li>
      </ul>

      <h2>What it is not</h2>
      <p>
        Bifrost is not a wallet. It is not a custodian. It does not hold
        user funds. It is infrastructure that hub operators run to provide
        liquidity between the two networks.
      </p>

      <h2>Status</h2>
      <p>Version: bifrost/0.1 (draft)</p>
      <p>Network: local CKB dev chain + Bitcoin regtest</p>
      <p>
        SDK: <code>npm install bifrost-sdk</code>
      </p>

      <h3>Component status</h3>
      <StatusTable />
    </DocsLayout>
  );
}
