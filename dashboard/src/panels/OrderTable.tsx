import type { Order, OrderState } from "bifrost-sdk";
import { fmtAmount } from "../api.ts";

const STATE_CLASS: Record<OrderState, string> = {
  PENDING: "s-pending",
  INCOMING_HELD: "s-held",
  OUTGOING_IN_FLIGHT: "s-flight",
  OUTGOING_SETTLED: "s-settled",
  SUCCEEDED: "s-success",
  REFUNDING: "s-refunding",
  FAILED: "s-failed",
};

export function OrderTable({ orders, onSelect, selected }: {
  orders: Order[];
  onSelect: (id: string) => void;
  selected?: string | undefined;
}) {
  return (
    <div className="panel span2">
      <h2>Orders <span className="muted">live via /v1/stream</span></h2>
      <table>
        <thead>
          <tr><th>order</th><th>direction</th><th>in → out</th><th>state</th><th>failure</th><th>updated</th></tr>
        </thead>
        <tbody>
          {orders.map((o) => (
            <tr key={o.orderId} className={o.orderId === selected ? "selected" : ""} onClick={() => onSelect(o.orderId)}>
              <td className="mono">{o.orderId.slice(0, 12)}…</td>
              <td>{o.direction === "FIBER_TO_LN" ? "Fiber → LN" : "LN → Fiber"}</td>
              <td className="mono">
                {fmtAmount(o.incoming.amount)} → {fmtAmount(o.outgoing.amount)}
              </td>
              <td><span className={`badge ${STATE_CLASS[o.state]}`}>{o.state}</span></td>
              <td className="hint">{o.failure ? `${o.failure.code}: ${o.failure.hint ?? o.failure.message}` : "—"}</td>
              <td className="muted">{new Date(o.updatedAt).toLocaleTimeString()}</td>
            </tr>
          ))}
          {orders.length === 0 && <tr><td colSpan={6} className="muted">no orders yet</td></tr>}
        </tbody>
      </table>
    </div>
  );
}
