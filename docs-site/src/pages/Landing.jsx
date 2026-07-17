import { Link } from "react-router-dom";

const HUB_HEALTH_URL = "https://superb-grouse-genuinely.ngrok-free.app/v1/health";
const GITHUB_URL = "https://github.com/FadhilMulinya/bitfrost";

export default function Landing() {
  return (
    <div className="container" style={{ maxWidth: 600, textAlign: "left" }}>
      <h1>Bifrost</h1>

      <p>Send sats. Receive shannon.</p>
      <p>Send shannon. Receive sats.</p>
      <p style={{ marginTop: "1rem" }}>A bridge between Fiber and Lightning.</p>
      <p>No custodian. No trust. Under 1s.</p>

      <p style={{ marginTop: "1.5rem" }}>
        <Link to="/docs/introduction" className="tag">
          Read the docs
        </Link>{" "}
        <a href={GITHUB_URL} className="tag" target="_blank" rel="noreferrer">
          View on GitHub
        </a>
      </p>

      <hr />

      <p>Live hub:</p>
      <p>
        <a href={HUB_HEALTH_URL} target="_blank" rel="noreferrer">
          {HUB_HEALTH_URL}
        </a>
      </p>

      <p style={{ marginTop: "1rem" }}>
        <code>npm install bifrost-sdk</code>
      </p>

      <hr />

      <h3>How it works:</h3>
      <p>1. Merchant has a Lightning invoice</p>
      <p>2. Customer pays with Fiber (CKB)</p>
      <p>3. Bifrost atomically bridges them</p>
      <p>4. Merchant receives sats instantly</p>

      <p style={{ marginTop: "1rem" }}>The hub cannot steal funds.</p>
      <p>The HTLC hash locks both legs.</p>
      <p>Payment fails = full refund.</p>

      <hr />

      <p>Built for the Gone in 60ms</p>
      <p>Fiber Network Infrastructure Hackathon</p>
    </div>
  );
}
