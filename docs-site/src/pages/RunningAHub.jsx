import DocsLayout from "../components/DocsLayout.jsx";
import CodeBlock from "../components/CodeBlock.jsx";

export default function RunningAHub() {
  return (
    <DocsLayout>
      <h1>Running a Hub</h1>

      <p>A hub operator:</p>
      <ol style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Runs a Fiber node (FNN) and a Lightning node (LND) with real, funded channels on both sides</li>
        <li>Runs bifrostd, the daemon that quotes, matches, and settles swaps</li>
        <li>Advertises supported pairs and pricing to the registry</li>
        <li>Answers quote requests, priced against live liquidity</li>
        <li>Monitors inventory and tops up channels when needed</li>
        <li>Earns the spread between what it charges and its own network fees</li>
      </ol>

      <h2 id="requirements">
        Requirements{" "}
        <a
          href="#requirements"
          className="section-anchor"
          aria-label="Link to Requirements section"
        >
          §
        </a>
      </h2>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li>Docker and Docker Compose</li>
        <li>Node.js 20+</li>
        <li>4GB RAM minimum, 8GB recommended</li>
        <li>50GB storage for chain data</li>
        <li>A funded Fiber node and a funded Lightning node, with channels open to real counterparties</li>
      </ul>

      <h2 id="economics">
        Economics{" "}
        <a
          href="#economics"
          className="section-anchor"
          aria-label="Link to Economics section"
        >
          §
        </a>
      </h2>
      <p>Worked example, pricing a 5,000-sat swap:</p>
      <CodeBlock>{`Customer sends:     650,000 shannon (Fiber)
Merchant receives:  5,000 sat (Lightning)
Hub spread:         2000 ppm (0.2%)
Hub margin:          ~10 sat per swap
At 100 swaps/day:    ~1,000 sat/day in spread`}</CodeBlock>
      <p>
        The hub still pays its own outgoing network fee out of that spread,
        so the real margin is spread minus routing cost, not the full 2000
        ppm.
      </p>

      <h2 id="docker-setup">
        Quick start{" "}
        <a
          href="#docker-setup"
          className="section-anchor"
          aria-label="Link to Quick start section"
        >
          §
        </a>
      </h2>
      <CodeBlock>{`git clone https://github.com/FadhilMulinya/bitfrost
cd bitfrost/deploy
cp .env.example .env   # fill in real values, see Configuration below
docker compose -f docker-compose.dev.yml up -d
./scripts/fund-regtest.sh
./scripts/smoke-bifrost.sh`}</CodeBlock>

      <h2 id="configuration">
        Configuration{" "}
        <a
          href="#configuration"
          className="section-anchor"
          aria-label="Link to Configuration section"
        >
          §
        </a>
      </h2>
      <p>Environment variables read from <code>deploy/.env</code>:</p>
      <table>
        <thead><tr><th>Variable</th><th>Description</th></tr></thead>
        <tbody>
          <tr>
            <td><code>BITCOIN_RPC_USER</code></td>
            <td>bitcoind regtest RPC username, also injected into LND</td>
          </tr>
          <tr>
            <td><code>BITCOIN_RPC_PASS</code></td>
            <td>bitcoind regtest RPC password, also injected into LND</td>
          </tr>
          <tr>
            <td><code>FNN_CLIENT_KEY_PASSWORD</code></td>
            <td>Password encrypting the client-side Fiber node's dev key</td>
          </tr>
          <tr>
            <td><code>FNN_HUB_KEY_PASSWORD</code></td>
            <td>Password encrypting the hub-side Fiber node's dev key</td>
          </tr>
          <tr>
            <td><code>FNN_RUST_LOG</code></td>
            <td>Fiber node log filter (e.g. <code>info,fnn=debug</code>)</td>
          </tr>
          <tr>
            <td><code>UDT_CODE_HASH</code></td>
            <td>
              wBTC UDT type-script code_hash. Required by{" "}
              <code>bifrostd</code>'s startup config validation. The
              repository default is a local dev-chain fixture value, not a
              real testnet or mainnet UDT -- replace with the actual UDT's
              code_hash to run against a real network.
            </td>
          </tr>
          <tr>
            <td><code>WBTC_ARGS</code></td>
            <td>
              wBTC UDT type-script args, identifying the specific UDT
              instance. Same dev-chain-fixture caveat as{" "}
              <code>UDT_CODE_HASH</code>.
            </td>
          </tr>
        </tbody>
      </table>

      <h2 id="liquidity-management">
        Liquidity management{" "}
        <a
          href="#liquidity-management"
          className="section-anchor"
          aria-label="Link to Liquidity management section"
        >
          §
        </a>
      </h2>
      <p>
        bifrostd prices quotes against each node's live channel balances
        (<code>fiberLiquidity</code>/<code>lightningLiquidity</code>).
        Quotes are non-binding until redeemed by an order, so pricing alone
        never reserves inventory. Operators are responsible for rebalancing
        or topping up channels on both sides as swap volume depletes one
        leg faster than the other -- bifrostd does not automate
        rebalancing itself.
      </p>

      <h2>Pricing strategies</h2>
      <ul style={{ margin: "1rem 0 1rem 1.5rem" }}>
        <li><strong>Static peg</strong> -- fixed exchange rate plus a flat spread, simplest to run, exposed to market moves</li>
        <li><strong>Feed spread</strong> -- rate sourced from an external price feed, spread applied on top, tracks the market but depends on feed uptime</li>
        <li><strong>Inventory skew</strong> -- spread widens as one side's liquidity depletes, discouraging swaps that would drain it further</li>
      </ul>
    </DocsLayout>
  );
}
