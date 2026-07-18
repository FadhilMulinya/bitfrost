import { Link } from "react-router-dom";
import CodeBlock from "../components/CodeBlock.jsx";

const HUB_HEALTH_URL = "https://superb-grouse-genuinely.ngrok-free.app/v1/health";
const GITHUB_URL = "https://github.com/FadhilMulinya/bitfrost";

export default function Landing() {
  return (
    <div className="landing">
      <div className="landing-hero">
        <h1 className="landing-title">Bifrost</h1>
        <p className="landing-tagline">
          Send sats. Receive shannon.
          <br />
          Send shannon. Receive sats.
          <br />
          A bridge between Fiber and Lightning. No custodian. No trust. Under 1s.
        </p>

        <div className="landing-actions">
          <Link to="/docs/introduction" className="btn-primary">
            Read the docs
          </Link>
          <a href={GITHUB_URL} className="btn-secondary" target="_blank" rel="noreferrer">
            View on GitHub
          </a>
        </div>

        <p>Live hub:</p>
        <p>
          <a href={HUB_HEALTH_URL} target="_blank" rel="noreferrer">
            {HUB_HEALTH_URL}
          </a>
        </p>
      </div>

      <CodeBlock>npm install bifrost-sdk</CodeBlock>

      <hr className="divider" />

      <h3>How it works:</h3>
      <p>1. Merchant has a Lightning invoice</p>
      <p>2. Customer pays with Fiber (CKB)</p>
      <p>3. Bifrost atomically bridges them</p>
      <p>4. Merchant receives sats instantly</p>

      <p style={{ marginTop: "1rem" }}>The hub cannot steal funds.</p>
      <p>The HTLC hash locks both legs.</p>
      <p>Payment fails = full refund.</p>

      <hr className="divider" />

      <p>Built for the Gone in 60ms</p>
      <p>Fiber Network Infrastructure Hackathon</p>
    </div>
  );
}
