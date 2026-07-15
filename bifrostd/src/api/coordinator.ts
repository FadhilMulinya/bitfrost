/**
 * SwapCoordinator — wires adapter event streams into the OrderEngine for a
 * long-running, many-concurrent-orders server. Adapted from
 * bifrostd/src/smoke/runner.ts's `pump()`, generalized from "one hardcoded
 * direction" to "however many orders are live right now":
 *
 *  - ONE global Fiber WS pump for the whole process (fnnHubWs.legEvents()
 *    carries incoming-hold status AND PutPreimage for every order — it is
 *    not scoped to a single payment_hash).
 *  - PER-ORDER pumps for whichever legs are per-hash by nature: LND's
 *    invoice/payment subscriptions (LightningAdapter.legEvents) and the
 *    Fiber HTTP poll fallback (FiberAdapter.pollLegEvents) both require one
 *    subscription per payment_hash.
 *
 * Each order's per-hash pumps are torn down (AbortController) once the
 * order reaches a terminal state, notified via onOrderChanged.
 */
import type { FiberAdapter } from "../adapters/fiber.js";
import type { LightningAdapter } from "../adapters/lightning.js";
import type { Hash256, SwapLegEvent } from "../adapters/types.js";
import type { OrderEngine } from "../orders/engine.js";
import type { OrderStore } from "../orders/store.js";
import type { Order, OrderState } from "@bifrost/sdk";

const TERMINAL: ReadonlySet<OrderState> = new Set(["SUCCEEDED", "FAILED"]);
const DISPATCHED: ReadonlySet<OrderState> = new Set(["OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED"]);

export interface SwapCoordinatorOptions {
  engine: OrderEngine;
  store: OrderStore;
  fnnHubWs: FiberAdapter;
  fnnHubHttp: FiberAdapter;
  lndHub: LightningAdapter;
  onOrderChanged: (order: Order) => void;
  log: (msg: string) => void;
}

export class SwapCoordinator {
  private readonly controllers = new Map<string, AbortController>();
  /** Orders whose outgoing pump is deliberately not started yet — see watchOrder. */
  private readonly outgoingPending = new Map<string, { network: "fiber" | "lightning"; hash: Hash256; signal: AbortSignal }>();

  constructor(private readonly opts: SwapCoordinatorOptions) {}

  /**
   * Call once at startup: the single process-wide Fiber WS pump. Unlike
   * per-order pumps (which end naturally at a terminal state), this one MUST
   * survive for the life of the process — I1 depends on PutPreimage arriving
   * over it for every LN→Fiber order. Found live: compose's `depends_on:
   * fnn-hub: {condition: service_started}` only waits for the container to
   * start, not for FNN's WS listener to actually be accepting connections,
   * so the very first connect attempt can lose that race. Retry with a
   * capped backoff instead of dying silently on the first failure.
   */
  startGlobalPumps(signal: AbortSignal): void {
    void (async () => {
      let delayMs = 1000;
      while (!signal.aborted) {
        try {
          for await (const ev of this.opts.fnnHubWs.legEvents()) {
            if (signal.aborted) return;
            delayMs = 1000; // reset backoff after a successful stream of events
            await this.opts.engine.onLegEvent(ev).catch((e) => this.opts.log(`pump[fiber-ws-global] handler error: ${String(e)}`));
            this.afterEvent(ev.paymentHash, "fiber-ws-global"); // this pump itself never stops — it's global, not per-order
          }
          if (signal.aborted) return;
          this.opts.log("pump[fiber-ws-global] stream ended — reconnecting");
        } catch (e) {
          if (signal.aborted) return;
          this.opts.log(`pump[fiber-ws-global] connect failed: ${String(e)} — retrying in ${delayMs}ms`);
        }
        await new Promise((r) => setTimeout(r, delayMs));
        delayMs = Math.min(delayMs * 2, 30_000);
      }
    })();
  }

  /**
   * Call right after engine.createOrder() succeeds. Mirrors the smoke
   * runner's exact ordering, not just "subscribe to everything now":
   *
   * - incoming leg: safe to subscribe immediately (that's the hold invoice
   *   the counterparty is about to pay — nothing to wait for).
   * - outgoing leg: found live — subscribing before dispatch is a bug, not
   *   just wasted work. Both LightningAdapter.legEvents("outgoing")
   *   (trackPayment on a payment_hash LND has never seen) and
   *   FiberAdapter.pollLegEvents("outgoing") (get_payment on a hash FNN has
   *   never seen) end/throw immediately on a not-yet-dispatched payment —
   *   the smoke runner avoids this by only starting that pump after
   *   `waitState([...OUTGOING_IN_FLIGHT...])`. Deferred here the same way:
   *   parked in outgoingPending, started by pump() the moment any event
   *   moves the order into a DISPATCHED state.
   */
  watchOrder(order: Order): void {
    if (this.controllers.has(order.orderId)) return; // already watched (e.g. reconciled on restart)
    const ac = new AbortController();
    this.controllers.set(order.orderId, ac);
    const hash = order.paymentHash as Hash256;

    if (order.incoming.network === "lightning") {
      this.pump(this.opts.lndHub.legEvents(hash, "incoming"), `ln-incoming:${order.orderId}`, ac.signal, order.orderId);
    } else {
      this.pump(this.opts.fnnHubHttp.pollLegEvents(hash, "incoming", { signal: ac.signal }), `fiber-poll-incoming:${order.orderId}`, ac.signal, order.orderId);
    }

    if (DISPATCHED.has(order.state)) {
      this.startOutgoingPump(order.orderId, order.outgoing.network, hash, ac.signal);
    } else {
      this.outgoingPending.set(order.orderId, { network: order.outgoing.network, hash, signal: ac.signal });
    }
  }

  private startOutgoingPump(orderId: string, network: "fiber" | "lightning", hash: Hash256, signal: AbortSignal): void {
    if (network === "lightning") {
      this.pump(this.opts.lndHub.legEvents(hash, "outgoing"), `ln-outgoing:${orderId}`, signal, orderId);
    } else {
      this.pump(this.opts.fnnHubHttp.pollLegEvents(hash, "outgoing", { signal }), `fiber-poll-outgoing:${orderId}`, signal, orderId);
    }
  }

  private stopOrder(orderId: string): void {
    this.controllers.get(orderId)?.abort();
    this.controllers.delete(orderId);
    this.outgoingPending.delete(orderId);
  }

  private pump(events: AsyncIterable<SwapLegEvent>, label: string, signal: AbortSignal, orderId?: string): void {
    void (async () => {
      try {
        for await (const ev of events) {
          if (signal.aborted) return;
          await this.opts.engine.onLegEvent(ev).catch((e) => this.opts.log(`pump[${label}] handler error: ${String(e)}`));
          this.afterEvent(ev.paymentHash, label);
        }
      } catch (e) {
        if (!signal.aborted) this.opts.log(`pump[${label}]${orderId ? ` (${orderId})` : ""} ended: ${String(e)}`);
      }
    })();
  }

  /** Shared post-event bookkeeping: broadcast, terminal cleanup, lazy outgoing-pump start. */
  private afterEvent(paymentHash: Hash256, label: string): void {
    const order = this.opts.store.getByHash(paymentHash);
    if (!order) return;
    this.opts.onOrderChanged(order);
    if (TERMINAL.has(order.state)) {
      this.stopOrder(order.orderId);
      return;
    }
    if (!DISPATCHED.has(order.state)) return;
    const pending = this.outgoingPending.get(order.orderId);
    if (!pending) return;
    this.outgoingPending.delete(order.orderId);
    this.opts.log(`pump[${label}] observed dispatch — starting outgoing pump for ${order.orderId}`);
    this.startOutgoingPump(order.orderId, pending.network, pending.hash, pending.signal);
  }
}
