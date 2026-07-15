import { fetchQuoteStats, usePolled } from "../api.ts";

export function QuoteStatsPanel() {
  const q = usePolled(fetchQuoteStats, 2000);
  const hitPct = q ? (q.hitRateBps / 100).toFixed(2) : "—";
  return (
    <div className="panel">
      <h2>Quotes <span className="muted">hit rate, last hour</span></h2>
      {q && (
        <>
          <div className="big-number">{hitPct}<span className="unit">%</span></div>
          <div className="stat-grid">
            <div><span className="stat">{q.issued}</span><span className="muted">issued</span></div>
            <div><span className="stat ok">{q.accepted}</span><span className="muted">accepted</span></div>
            <div><span className="stat warn">{q.expired}</span><span className="muted">expired</span></div>
            <div><span className="stat bad">{q.rejected}</span><span className="muted">rejected</span></div>
          </div>
        </>
      )}
    </div>
  );
}
