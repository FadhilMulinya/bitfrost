import { useState } from "react";
import DocsLayout from "../components/DocsLayout.jsx";

const ORIGIN = "https://superb-grouse-genuinely.ngrok-free.app";
const HUB = `${ORIGIN}/v1`;

const NGROK_HEADER = { "ngrok-skip-browser-warning": "true" };

async function timedFetch(url, opts = {}) {
  const start = performance.now();
  try {
    const res = await fetch(url, {
      ...opts,
      headers: { ...NGROK_HEADER, ...(opts.headers || {}) },
    });
    const ms = Math.round(performance.now() - start);
    const body = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, body, ms };
  } catch (err) {
    const ms = Math.round(performance.now() - start);
    return { ok: false, status: 0, body: { error: { message: String(err) } }, ms };
  }
}

function CurlLine({ method = "GET", url, body }) {
  const parts = [`curl -X ${method} ${url}`, `-H "ngrok-skip-browser-warning: true"`];
  if (body) {
    parts.push(`-H "Content-Type: application/json"`);
    parts.push(`-d '${JSON.stringify(body)}'`);
  }
  return <pre style={{ fontSize: "0.75rem", marginBottom: "0.75rem" }}>{parts.join(" \\\n  ")}</pre>;
}

function Output({ result }) {
  const [copied, setCopied] = useState(false);
  if (!result) return null;
  const text = JSON.stringify(result.body, null, 2);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  };

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: "0.4rem" }}>
        <span style={{ fontSize: "0.75rem", color: "var(--fg-subtle)" }}>
          {result.ok ? `status ${result.status}` : `error (status ${result.status})`} -- response in {result.ms}ms
        </span>
        <button className="copy-btn" style={{ position: "static" }} onClick={onCopy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className={`playground-output ${result.ok ? "success" : "error"}`}>{text}</pre>
    </div>
  );
}

function Panel({ title, description, note, curl, children }) {
  return (
    <div className="playground">
      <div className="playground-header">
        <span>{title}</span>
      </div>
      <div className="playground-body">
        <p style={{ color: "var(--fg-subtle)", fontSize: "0.9rem" }}>{description}</p>
        {note && <div className="callout warning" style={{ fontSize: "0.8rem" }}>{note}</div>}
        {curl}
        {children}
      </div>
    </div>
  );
}

/* ---------- Panel 1: Health Check ---------- */
function HealthPanel() {
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const run = async () => {
    setLoading(true);
    setResult(await timedFetch(`${HUB}/health`));
    setLoading(false);
  };

  return (
    <Panel
      title="GET /v1/health"
      description="Check if the hub is online and both nodes connected"
      curl={<CurlLine method="GET" url={`${HUB}/health`} />}
    >
      <div className="playground-actions">
        <button onClick={run} disabled={loading}>{loading ? "Running..." : "Run"}</button>
      </div>
      <Output result={result} />
    </Panel>
  );
}

/* ---------- Panel 2: Get Quote ---------- */
function QuotePanel() {
  const [amount, setAmount] = useState("5000");
  const [direction, setDirection] = useState("fiber-to-ln");
  const [invoice, setInvoice] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const pair =
    direction === "fiber-to-ln"
      ? { give: { network: "fiber", unit: "shannon" }, get: { network: "lightning", unit: "sat" } }
      : { give: { network: "lightning", unit: "sat" }, get: { network: "fiber", unit: "shannon" } };

  const body = {
    protocol: "bifrost/0.1",
    pair,
    amount: { side: "get", value: String(amount || "0") },
    mode: invoice ? "PAY_INVOICE" : "RECEIVE",
    ...(invoice ? { targetInvoice: invoice } : {}),
  };

  const run = async () => {
    setLoading(true);
    setResult(
      await timedFetch(`${HUB}/quotes`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
    );
    setLoading(false);
  };

  return (
    <Panel
      title="POST /v1/quotes"
      description="Request a signed price quote for a swap"
      curl={<CurlLine method="POST" url={`${HUB}/quotes`} body={body} />}
    >
      <label style={{ fontSize: "0.8rem" }}>Amount</label>
      <input
        className="playground-input"
        type="number"
        value={amount}
        onChange={(e) => setAmount(e.target.value)}
      />
      <label style={{ fontSize: "0.8rem" }}>Direction</label>
      <select
        className="playground-input"
        value={direction}
        onChange={(e) => setDirection(e.target.value)}
      >
        <option value="fiber-to-ln">Fiber -&gt; Lightning</option>
        <option value="ln-to-fiber">Lightning -&gt; Fiber</option>
      </select>
      <label style={{ fontSize: "0.8rem" }}>Invoice (optional BOLT11, leave blank for RECEIVE mode)</label>
      <input
        className="playground-input"
        type="text"
        placeholder="lnbcrt..."
        value={invoice}
        onChange={(e) => setInvoice(e.target.value)}
      />
      <div className="playground-actions">
        <button onClick={run} disabled={loading}>{loading ? "Running..." : "Get Quote"}</button>
      </div>
      <Output result={result} />
      {result?.ok && result.body && !result.body.error && (
        <ul style={{ fontSize: "0.8rem", margin: "0.75rem 0 0 1.25rem" }}>
          <li><code>giveAmount</code>: shannon/sat you pay</li>
          <li><code>getAmount</code>: shannon/sat the counterparty receives</li>
          <li><code>rate</code>: exchange rate</li>
          <li><code>expiresAt</code>: quote valid until</li>
          <li><code>signature</code>: BIP-340 Schnorr signature (present -- verify client-side with the SDK's <code>verifyQuote()</code>)</li>
        </ul>
      )}
    </Panel>
  );
}

/* ---------- Panel 3: Generate Test Invoice ---------- */
function DemoInvoicePanel() {
  const [amt, setAmt] = useState("1000");
  const [memo, setMemo] = useState("test payment");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const url = `${HUB}/demo/invoice?amt=${encodeURIComponent(amt)}&memo=${encodeURIComponent(memo)}`;

  const run = async () => {
    setLoading(true);
    setResult(await timedFetch(url));
    setLoading(false);
  };

  return (
    <Panel
      title="GET /v1/demo/invoice"
      description="Generate a regtest Lightning invoice for testing"
      note="Only available when DEMO_ENDPOINTS_ENABLED=true on the hub -- otherwise this returns 404."
      curl={<CurlLine method="GET" url={url} />}
    >
      <label style={{ fontSize: "0.8rem" }}>Amount (sat)</label>
      <input className="playground-input" type="number" value={amt} onChange={(e) => setAmt(e.target.value)} />
      <label style={{ fontSize: "0.8rem" }}>Memo</label>
      <input className="playground-input" type="text" value={memo} onChange={(e) => setMemo(e.target.value)} />
      <div className="playground-actions">
        <button onClick={run} disabled={loading}>{loading ? "Running..." : "Generate Invoice"}</button>
      </div>
      <Output result={result} />
    </Panel>
  );
}

/* ---------- Panel 4: Full Swap Flow ---------- */
const SWAP_STEPS = ["Invoice", "Quote", "Order", "Pay", "Done"];

function SwapFlowPanel() {
  const [step, setStep] = useState(0);
  const [log, setLog] = useState([]);
  const [running, setRunning] = useState(false);
  const [orderState, setOrderState] = useState(null);
  const [finishedMs, setFinishedMs] = useState(null);

  const append = (label, result) => setLog((l) => [...l, { label, result }]);

  const pollOrder = async (hubApi, orderId, since) => {
    for (let i = 0; i < 30; i++) {
      const r = await timedFetch(`${hubApi}/orders/${orderId}`);
      if (r.ok && r.body) {
        setOrderState(r.body.state);
        if (r.body.state === "SUCCEEDED" || r.body.state === "FAILED") {
          append(`poll (${r.body.state})`, r);
          if (r.body.state === "SUCCEEDED") setFinishedMs(Math.round(performance.now() - since));
          return r.body.state;
        }
      }
      append(`poll (${r.body?.state ?? "?"})`, r);
      await new Promise((res) => setTimeout(res, 2000));
    }
    return "TIMEOUT";
  };

  const run = async () => {
    setRunning(true);
    setLog([]);
    setOrderState(null);
    setFinishedMs(null);
    const t0 = performance.now();
    setStep(1);

    const invR = await timedFetch(`${HUB}/demo/invoice?amt=5000&memo=playground-swap`);
    append("Generate Invoice", invR);
    if (!invR.ok || !invR.body?.payment_request) {
      setRunning(false);
      return;
    }
    setStep(2);

    const quoteR = await timedFetch(`${HUB}/quotes`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        protocol: "bifrost/0.1",
        pair: {
          give: { network: "fiber", unit: "shannon" },
          get: { network: "lightning", unit: "sat" },
        },
        amount: { side: "get", value: "5000" },
        mode: "PAY_INVOICE",
        targetInvoice: invR.body.payment_request,
      }),
    });
    append("Get Quote", quoteR);
    if (!quoteR.ok || !quoteR.body?.quoteId) {
      setRunning(false);
      return;
    }
    setStep(3);

    const orderR = await timedFetch(`${HUB}/orders`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ protocol: "bifrost/0.1", quoteId: quoteR.body.quoteId }),
    });
    append("Create Order", orderR);
    if (!orderR.ok || !orderR.body?.orderId) {
      setRunning(false);
      return;
    }
    setOrderState(orderR.body.state);
    setStep(4);

    const payR = await timedFetch(`${HUB}/demo/pay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ orderId: orderR.body.orderId }),
    });
    append("Simulate Payment", payR);
    setStep(5);

    const finalState = await pollOrder(HUB, orderR.body.orderId, t0);
    setOrderState(finalState);
    setRunning(false);
  };

  return (
    <Panel
      title="Complete Swap (3 steps)"
      description="Run a complete FIBER_TO_LN swap end to end against the live hub"
      note="Requires DEMO_ENDPOINTS_ENABLED=true on the hub for the invoice/pay steps."
    >
      <div style={{ display: "flex", gap: "0.5rem", marginBottom: "1rem", flexWrap: "wrap", fontSize: "0.8rem" }}>
        {SWAP_STEPS.map((label, i) => (
          <span
            key={label}
            className="badge"
            style={{
              borderColor: i < step ? "var(--success)" : "var(--border)",
              color: i < step ? "var(--success)" : "var(--fg-subtle)",
            }}
          >
            {i + 1} {label}
          </span>
        ))}
      </div>
      <div className="playground-actions">
        <button onClick={run} disabled={running}>{running ? "Running..." : "Run Full Swap"}</button>
      </div>
      {orderState && (
        <p style={{ fontSize: "0.85rem" }}>
          Order state: <code>{orderState}</code>
          {finishedMs !== null && ` -- Swap complete in ${finishedMs}ms`}
        </p>
      )}
      {log.map((entry, i) => (
        <div key={i} style={{ marginBottom: "0.75rem" }}>
          <span style={{ fontSize: "0.75rem", fontWeight: "bold" }}>{entry.label}</span>
          <Output result={entry.result} />
        </div>
      ))}
    </Panel>
  );
}

/* ---------- Panel 5: Raw API Request ---------- */
function RawRequestPanel() {
  const [method, setMethod] = useState("GET");
  const [path, setPath] = useState("/v1/health");
  const [body, setBody] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);

  const url = `${ORIGIN}${path}`;

  const run = async () => {
    setLoading(true);
    let parsedBody;
    if (method === "POST" && body.trim()) {
      try {
        parsedBody = JSON.parse(body);
      } catch {
        setResult({ ok: false, status: 0, body: { error: { message: "invalid JSON body" } }, ms: 0 });
        setLoading(false);
        return;
      }
    }
    setResult(
      await timedFetch(url, {
        method,
        ...(parsedBody ? { headers: { "content-type": "application/json" }, body: JSON.stringify(parsedBody) } : {}),
      }),
    );
    setLoading(false);
  };

  return (
    <Panel
      title="Raw Request"
      description="Send any request to the hub"
      curl={<CurlLine method={method} url={url} body={method === "POST" && body.trim() ? body.trim() : undefined} />}
    >
      <label style={{ fontSize: "0.8rem" }}>Method</label>
      <select className="playground-input" value={method} onChange={(e) => setMethod(e.target.value)}>
        <option value="GET">GET</option>
        <option value="POST">POST</option>
      </select>
      <label style={{ fontSize: "0.8rem" }}>Path</label>
      <input className="playground-input" type="text" value={path} onChange={(e) => setPath(e.target.value)} />
      {method === "POST" && (
        <>
          <label style={{ fontSize: "0.8rem" }}>Body (JSON, optional)</label>
          <textarea
            className="playground-input"
            rows={5}
            value={body}
            onChange={(e) => setBody(e.target.value)}
          />
        </>
      )}
      <div className="playground-actions">
        <button onClick={run} disabled={loading}>{loading ? "Sending..." : "Send"}</button>
      </div>
      <Output result={result} />
    </Panel>
  );
}

export default function Playground() {
  return (
    <DocsLayout>
      <h1>API Playground</h1>
      <p>
        Every panel below calls the live demo hub at{" "}
        <code>{HUB}</code> directly from your browser. No server-side proxy,
        no mocked responses. Requests carry no auth header -- see{" "}
        <a href="/docs/security#known-gaps">Known Gaps</a> for what that means.
      </p>

      <HealthPanel />
      <QuotePanel />
      <DemoInvoicePanel />
      <SwapFlowPanel />
      <RawRequestPanel />
    </DocsLayout>
  );
}
