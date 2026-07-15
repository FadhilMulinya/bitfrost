import { fetchHealth, usePolled } from "../api.ts";

export function HealthPanel() {
  const h = usePolled(fetchHealth, 2000);
  return (
    <div className="panel">
      <h2>Nodes & Guard</h2>
      {h && (
        <>
          <div className="node-row">
            <Dot ok={h.fnn.connected} /> <b>FNN</b> <span className="mono muted">{h.fnn.version}</span>
            <Dot ok={h.lnd.connected} /> <b>LND</b> <span className="mono muted">{h.lnd.version}</span>
            <Dot ok={h.feed.fresh} /> <b>feed</b> <span className="muted">{h.feed.fresh ? `${h.feed.ageMs}ms` : "STALE"}</span>
          </div>
          <div className="guard">
            <span className="muted">ExpiryGuard:</span>{" "}
            <span className="mono">Δsafety {h.expiryGuard.minSafetyDeltaMs / 60000}m · hold ≤ {h.expiryGuard.maxIncomingHoldMs / 60000}m</span>
          </div>
          <h3>Guard rejections</h3>
          <ul className="rejections">
            {h.expiryGuard.rejections.length === 0 && <li className="muted">none — all admitted orders satisfied I2</li>}
            {h.expiryGuard.rejections.slice(0, 4).map((r) => (
              <li key={`${r.orderId}-${r.at}`}>
                <span className="badge s-failed">{r.code}</span>
                <span className="hint"> {r.hint}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

function Dot({ ok }: { ok: boolean }) {
  return <span className={`dot ${ok ? "dot-ok" : "dot-bad"}`} />;
}
