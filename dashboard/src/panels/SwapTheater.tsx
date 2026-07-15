/**
 * Swap Theater — demo-video view (§4.10). Animates one order walking the
 * cross-chain state machine: two chain lanes, an HTLC "lock" on each leg, and
 * the preimage physically traveling from the outgoing settlement back to the
 * incoming settle. The narration line spells out the safety invariant being
 * honored at each step (I1: never settle incoming before the preimage is known).
 */
import type { Order, OrderState } from "bifrost-sdk";
import { fmtAmount } from "../api.ts";

const STEPS: Array<{ state: OrderState; title: string; narration: string }> = [
  { state: "PENDING", title: "Quote accepted", narration: "Order created under a signed quote. Incoming hold invoice issued — same payment hash on both chains." },
  { state: "INCOMING_HELD", title: "Incoming HTLC held", narration: "Client's HTLC accepted and HELD — not settled. Funds are locked, not spendable (invariant I1)." },
  { state: "OUTGOING_IN_FLIGHT", title: "Outgoing dispatched", narration: "Hub pays the target invoice. Outgoing expiry is strictly shorter: incoming ≥ outgoing + Δsafety (I2)." },
  { state: "OUTGOING_SETTLED", title: "Preimage learned", narration: "Payee revealed the preimage to claim. The hub now — and only now — holds the key to its incoming funds." },
  { state: "SUCCEEDED", title: "Atomic swap complete", narration: "Incoming settled with the SAME preimage. Both legs settled or neither — that's the atomicity anchor." },
];
const FAIL_STEPS: Partial<Record<OrderState, { title: string; narration: string }>> = {
  REFUNDING: { title: "Outgoing failed — refunding", narration: "No route. The held incoming HTLC is cancelled; the client's funds flow back. Nobody loses money." },
  FAILED: { title: "Refunded", narration: "Terminal: incoming cancelled, client refunded. The hub never settled what it couldn't forward." },
};

export function SwapTheater({ order }: { order?: Order | undefined }) {
  if (!order) {
    return (
      <div className="panel span2 theater">
        <h2>Swap Theater</h2>
        <p className="muted">select an order to watch it cross the bridge</p>
      </div>
    );
  }
  const failing = order.state === "REFUNDING" || order.state === "FAILED";
  const stepIdx = failing ? 2 : Math.max(0, STEPS.findIndex((s) => s.state === order.state));
  const active = failing ? FAIL_STEPS[order.state]! : STEPS[stepIdx]!;
  const preimageKnown = order.outgoing.preimage !== undefined;
  const done = order.state === "SUCCEEDED";

  const [inChain, outChain] = order.direction === "FIBER_TO_LN" ? (["Fiber (CKB)", "Lightning"] as const) : (["Lightning", "Fiber (CKB)"] as const);

  return (
    <div className={`panel span2 theater ${failing ? "theater-fail" : ""}`}>
      <h2>Swap Theater <span className="mono muted">{order.orderId.slice(0, 12)}…</span></h2>

      <div className="lanes">
        <div className={`lane ${order.incoming.status === "HELD" ? "lane-held" : ""} ${order.incoming.status === "SETTLED" ? "lane-settled" : ""} ${order.incoming.status === "CANCELLED" ? "lane-cancelled" : ""}`}>
          <div className="lane-title">{inChain} <span className="muted">incoming</span></div>
          <div className="lane-amount mono">{fmtAmount(order.incoming.amount)}</div>
          <div className="lock">
            {order.incoming.status === "SETTLED" ? "🔓 settled" : order.incoming.status === "CANCELLED" ? "↩ refunded" : order.incoming.status === "HELD" ? "🔒 HELD" : "⏳ waiting"}
          </div>
        </div>

        <div className="bridge">
          <div className="hash mono" title="shared payment hash — the atomicity anchor">
            H = {order.paymentHash.slice(0, 10)}…
          </div>
          <div className={`preimage ${preimageKnown ? "preimage-travel" : ""} ${done ? "preimage-home" : ""}`}>
            {preimageKnown ? "🔑 preimage" : "🔑?"}
          </div>
          <div className="arrow">→ outgoing · preimage returns ←</div>
        </div>

        <div className={`lane ${order.outgoing.status === "IN_FLIGHT" ? "lane-flight" : ""} ${order.outgoing.status === "SETTLED" ? "lane-settled" : ""} ${order.outgoing.status === "FAILED" ? "lane-cancelled" : ""}`}>
          <div className="lane-title">{outChain} <span className="muted">outgoing</span></div>
          <div className="lane-amount mono">{fmtAmount(order.outgoing.amount)}</div>
          <div className="lock">
            {order.outgoing.status === "SETTLED" ? "🔓 settled" : order.outgoing.status === "FAILED" ? "✗ failed" : order.outgoing.status === "IN_FLIGHT" ? "⚡ in flight" : "⏳ waiting"}
          </div>
        </div>
      </div>

      <div className="steps">
        {STEPS.map((s, i) => (
          <div key={s.state} className={`step ${i < stepIdx ? "step-done" : ""} ${!failing && i === stepIdx ? "step-active" : ""}`}>
            <div className="step-dot" />
            <div className="step-label">{s.state}</div>
          </div>
        ))}
      </div>

      <div className="narration">
        <b>{active.title}.</b> {active.narration}
      </div>
    </div>
  );
}
