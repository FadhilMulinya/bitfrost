import { fmtAmount, pctOf, usePolled, fetchInventory } from "../api.ts";

export function InventoryPanel() {
  const inv = usePolled(fetchInventory, 2000);
  return (
    <div className="panel">
      <h2>Inventory <span className="muted">available vs in-flight</span></h2>
      {!inv && <p className="muted">loading…</p>}
      {inv?.assets.map((a) => {
        const total = BigInt(a.available) + BigInt(a.inFlight);
        const inFlightPct = pctOf(a.inFlight, total);
        return (
          <div key={`${a.asset.network}-${a.asset.unit}`} className="inv-row">
            <div className="inv-label">
              <span className={`net net-${a.asset.network}`}>{a.asset.network}</span>
              <span className="mono">{fmtAmount(a.available)} {a.asset.unit}</span>
              <span className="muted">({fmtAmount(a.inFlight)} in-flight)</span>
            </div>
            <div className="bar">
              <div className="bar-avail" style={{ width: `${100 - inFlightPct}%` }} />
              <div className="bar-flight" style={{ width: `${inFlightPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}
