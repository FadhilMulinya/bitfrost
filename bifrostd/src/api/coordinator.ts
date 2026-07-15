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

  constructor(private readonly opts: SwapCoordinatorOptions) {}

  /** Call once at startup: the single process-wide Fiber WS pump. */
  startGlobalPumps(signal: AbortSignal): void {
    this.pump(this.opts.fnnHubWs.legEvents(), "fiber-ws-global", signal);
  }

  /** Call right after engine.createOrder() succeeds. */
  watchOrder(order: Order): void {
    if (this.controllers.has(order.orderId)) return; // already watched (e.g. reconciled on restart)
    const ac = new AbortController();
    this.controllers.set(order.orderId, ac);
    const hash = order.paymentHash as Hash256;

    if (order.incoming.network === "lightning") {
      this.pump(this.opts.lndHub.legEvents(hash, "incoming"), `ln-incoming:${order.orderId}`, ac.signal);
    } else {
      this.pump(this.opts.fnnHubHttp.pollLegEvents(hash, "incoming", { signal: ac.signal }), `fiber-poll-incoming:${order.orderId}`, ac.signal);
    }
    if (order.outgoing.network === "lightning") {
      this.pump(this.opts.lndHub.legEvents(hash, "outgoing"), `ln-outgoing:${order.orderId}`, ac.signal);
    } else {
      this.pump(this.opts.fnnHubHttp.pollLegEvents(hash, "outgoing", { signal: ac.signal }), `fiber-poll-outgoing:${order.orderId}`, ac.signal);
    }
  }

  private stopOrder(orderId: string): void {
    this.controllers.get(orderId)?.abort();
    this.controllers.delete(orderId);
  }

  private pump(events: AsyncIterable<SwapLegEvent>, label: string, signal: AbortSignal): void {
    void (async () => {
      try {
        for await (const ev of events) {
          if (signal.aborted) return;
          await this.opts.engine.onLegEvent(ev).catch((e) => this.opts.log(`pump[${label}] handler error: ${String(e)}`));
          const order = this.opts.store.getByHash(ev.paymentHash);
          if (order) {
            this.opts.onOrderChanged(order);
            if (TERMINAL.has(order.state)) this.stopOrder(order.orderId);
          }
        }
      } catch (e) {
        if (!signal.aborted) this.opts.log(`pump[${label}] ended: ${String(e)}`);
      }
    })();
  }
}
