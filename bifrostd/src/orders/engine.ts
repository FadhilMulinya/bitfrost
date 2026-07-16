/**
 * OrderEngine — SYSTEM-DESIGN §4.2 / PROTOCOL §4.4. Owns the canonical Order
 * record and drives it through the cross-chain state machine:
 *
 *   PENDING → INCOMING_HELD → OUTGOING_IN_FLIGHT → OUTGOING_SETTLED → SUCCEEDED
 *   PENDING → FAILED · INCOMING_HELD|OUTGOING_IN_FLIGHT → REFUNDING → FAILED
 *
 * Normative rules, and where each is enforced:
 *   R1/I1 — `settleIncoming` is the ONLY call site of hold.settle, reachable
 *           only after sha256(P) == paymentHash verified and OUTGOING_SETTLED
 *           persisted. Events with wrong/missing preimages never settle.
 *   R2    — dispatch happens only inside the INCOMING_HELD handler.
 *   R3    — outgoing failure or expiry-proximity (also re-checked immediately
 *           before dispatch) drives REFUNDING + incoming cancel.
 *   R4/I3 — dispatch is guarded by the persisted outgoing.status ("WAITING"
 *           exactly once) under a per-order mutex; store enforces one order
 *           per paymentHash.
 *   R5/I4 — every transition is persisted (fsync) BEFORE its side effect;
 *           `start()` reconciles non-terminal orders against both nodes
 *           before `createOrder` accepts work.
 *
 * The engine consumes normalized SwapLegEvents; subscription plumbing (WS,
 * polling) belongs to the caller (smoke runner / future api module).
 */
import { sha256 } from "@noble/hashes/sha256";
import { BifrostError, expiryInvariantHolds, type ErrorCode, type Order, type ProtocolError } from "bifrost-sdk";
import { assertHash256, type Hash256, type SwapLegEvent } from "../adapters/types.js";
import type { NetworkPorts } from "./ports.js";
import type { OrderStore } from "./store.js";

export interface CreateOrderParams {
  orderId?: string;
  quoteId: string;
  direction: "FIBER_TO_LN" | "LN_TO_FIBER";
  paymentHash: Hash256;
  incoming: { network: "fiber" | "lightning"; amount: bigint; tlcExpiryAt: number };
  outgoing: { network: "fiber" | "lightning"; invoice: string; amount: bigint; tlcExpiryAt: number };
}

export interface OrderEngineOptions {
  store: OrderStore;
  ports: Record<"fiber" | "lightning", NetworkPorts>;
  /** I2 safety delta, wall-clock ms (ExpiryGuard §4.4; default 2h operator margin) */
  minSafetyDeltaMs: number;
  /** fee ceiling for outgoing dispatch; default 1% + 10 units */
  maxFeeFor?: (amount: bigint) => bigint;
  now?: () => number;
  log?: (level: "info" | "warn" | "critical", msg: string, orderId?: string) => void;
}

const hexPreimageMatches = (preimage: Hash256, hash: Hash256): boolean => {
  const digest = sha256(Buffer.from(preimage.slice(2), "hex"));
  return `0x${Buffer.from(digest).toString("hex")}` === hash;
};

const failure = (code: ErrorCode, message: string, retryable: boolean, hint?: string): ProtocolError => ({
  code,
  message,
  retryable,
  ...(hint !== undefined ? { hint } : {}),
});

let ulidCounter = 0;
const newOrderId = (now: number): string =>
  `${now.toString(36).toUpperCase().padStart(10, "0")}${(ulidCounter++ % 1296).toString(36).toUpperCase().padStart(2, "0")}${Math.random().toString(36).slice(2, 14).toUpperCase().padEnd(12, "0")}`;

export class OrderEngine {
  private readonly store: OrderStore;
  private readonly ports: OrderEngineOptions["ports"];
  private readonly minSafetyDeltaMs: number;
  private readonly maxFeeFor: (amount: bigint) => bigint;
  private readonly now: () => number;
  private readonly log: NonNullable<OrderEngineOptions["log"]>;
  private readonly queues = new Map<string, Promise<void>>();
  private ready = false;

  constructor(opts: OrderEngineOptions) {
    this.store = opts.store;
    this.ports = opts.ports;
    this.minSafetyDeltaMs = opts.minSafetyDeltaMs;
    this.maxFeeFor = opts.maxFeeFor ?? ((amount) => amount / 100n + 10n);
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? (() => undefined);
  }

  /** I4: reconcile all non-terminal orders against node truth, then accept work. */
  async start(): Promise<void> {
    for (const order of this.store.listNonTerminal()) {
      await this.enqueue(order.orderId, () => this.reconcile(order.orderId));
    }
    this.ready = true;
  }

  async createOrder(p: CreateOrderParams): Promise<Order> {
    if (!this.ready) {
      throw new BifrostError("INTERNAL", "engine not started: crash recovery has not run (I4)", true);
    }
    assertHash256(p.paymentHash, "paymentHash");
    const now = this.now();

    // I2 at creation time (legs arrive normalized to wall-clock ms; the
    // conservative CLTV conversions are applied at the edges — sdk expiry).
    if (
      !expiryInvariantHolds(
        { tlcExpiryAt: p.incoming.tlcExpiryAt },
        { tlcExpiryAt: p.outgoing.tlcExpiryAt },
        this.minSafetyDeltaMs,
        now,
      )
    ) {
      throw new BifrostError(
        "EXPIRY_INVARIANT_VIOLATION",
        `incoming expiry ${p.incoming.tlcExpiryAt} < outgoing ${p.outgoing.tlcExpiryAt} + ${this.minSafetyDeltaMs}`,
        false,
        "the incoming hold must outlive the outgoing HTLC by the safety delta",
      );
    }

    const orderId = p.orderId ?? newOrderId(now);
    const order: Order = {
      protocol: "bifrost/0.1",
      orderId,
      quoteId: p.quoteId,
      direction: p.direction,
      paymentHash: p.paymentHash,
      state: "PENDING",
      incoming: {
        network: p.incoming.network,
        invoice: "", // filled after node-side creation; empty on crash → recovery cancels
        amount: p.incoming.amount.toString(),
        tlcExpiryAt: p.incoming.tlcExpiryAt,
        status: "WAITING",
      },
      outgoing: {
        network: p.outgoing.network,
        invoice: p.outgoing.invoice,
        amount: p.outgoing.amount.toString(),
        tlcExpiryAt: p.outgoing.tlcExpiryAt,
        status: "WAITING",
      },
      failure: null,
      createdAt: now,
      updatedAt: now,
    };
    this.store.create(order); // persisted before the node-side side effect (R5)

    const invoice = await this.ports[p.incoming.network].hold.createHoldInvoice({
      paymentHash: p.paymentHash,
      amount: p.incoming.amount,
      tlcExpiryDeltaMs: p.incoming.tlcExpiryAt - now,
      description: `bifrost order ${orderId}`,
    });
    return this.store.transition(orderId, (o) => {
      o.incoming.invoice = invoice;
      o.updatedAt = this.now();
    }, "incoming hold invoice issued");
  }

  /**
   * Operator/client-initiated cancel (§4.5 POST /v1/orders/:id/cancel).
   * Only PENDING/INCOMING_HELD may be cancelled — once the outgoing leg is
   * dispatched the hub is exposed and must run the swap to a definitive
   * outcome (R1..R5), never abandon it. Anything else throws INTERNAL,
   * mapped by the api layer to HTTP 409.
   */
  async cancelOrder(orderId: string): Promise<Order> {
    const order = this.store.get(orderId);
    if (!order) throw new BifrostError("INTERNAL", `unknown order ${orderId}`, false);
    if (order.state !== "PENDING" && order.state !== "INCOMING_HELD") {
      throw new BifrostError("INTERNAL", `cannot cancel order in state ${order.state}`, false);
    }
    // PROTOCOL §7's closed registry has no dedicated "cancelled by request"
    // code (spec gap — see docs/STATUS.md); INTERNAL is the documented
    // fallback for uncategorized outcomes, so it carries this one with an
    // explicit hint rather than silently inventing a new wire code.
    return this.enqueue(orderId, async () => {
      await this.fail(orderId, failure("INTERNAL", "cancelled by operator/client request", false, "not a hub error — the client or operator requested cancellation"), true);
    }).then(() => this.store.get(orderId)!);
  }

  /** Feed one normalized adapter event; per-order serialized. */
  async onLegEvent(event: SwapLegEvent): Promise<void> {
    const order = this.store.getByHash(event.paymentHash);
    if (!order) return; // not ours (e.g. shared node with stock CCH traffic)
    await this.enqueue(order.orderId, () => this.handle(order.orderId, event));
  }

  /** R3 timer hook: refund anything whose incoming expiry is within the safety delta. */
  async sweepExpiries(): Promise<void> {
    const now = this.now();
    for (const order of this.store.listNonTerminal()) {
      if (now + this.minSafetyDeltaMs < order.incoming.tlcExpiryAt) continue;
      await this.enqueue(order.orderId, async () => {
        const o = this.store.get(order.orderId)!;
        if (o.state === "PENDING") {
          await this.fail(o.orderId, failure("QUOTE_EXPIRED", "incoming leg never arrived before expiry", false), true);
        } else if (o.state === "INCOMING_HELD" || o.state === "OUTGOING_IN_FLIGHT") {
          await this.refund(o.orderId, failure(
            "EXPIRY_INVARIANT_VIOLATION",
            "incoming expiry entered the safety window (R3)",
            false,
            "ask the payer to retry with a longer-lived invoice",
          ));
        }
      });
    }
  }

  /* ---------------- internals ---------------- */

  private enqueue(orderId: string, fn: () => Promise<void>): Promise<void> {
    const next = (this.queues.get(orderId) ?? Promise.resolve()).then(fn, fn);
    this.queues.set(orderId, next.catch(() => undefined));
    return next;
  }

  private async handle(orderId: string, event: SwapLegEvent): Promise<void> {
    const order = this.store.get(orderId)!;
    switch (event.kind) {
      case "INCOMING_HELD": {
        if (order.state !== "PENDING") return; // duplicate / stale
        this.store.transition(orderId, (o) => {
          o.state = "INCOMING_HELD";
          o.incoming.status = "HELD";
          o.updatedAt = this.now();
        }, "incoming HTLC held");
        await this.dispatchOutgoing(orderId); // R2: only reachable from here
        return;
      }
      case "OUTGOING_SETTLED": {
        if (order.state === "SUCCEEDED" || order.state === "OUTGOING_SETTLED") {
          if (order.state === "OUTGOING_SETTLED") await this.settleIncoming(orderId); // retry after crash
          return;
        }
        if (order.state !== "OUTGOING_IN_FLIGHT") {
          this.log("warn", `OUTGOING_SETTLED ignored in state ${order.state}`, orderId);
          return;
        }
        if (!event.preimage) {
          // Fiber poll path: settled but preimage not yet known (PutPreimage
          // arrives via WS). I1: nothing to verify → do NOT advance.
          this.log("info", "outgoing settled, awaiting preimage before advancing (I1)", orderId);
          return;
        }
        if (!hexPreimageMatches(event.preimage, order.paymentHash)) {
          this.log("critical", `preimage in OUTGOING_SETTLED does not hash to paymentHash — refusing to settle (I1)`, orderId);
          return;
        }
        const preimage = event.preimage;
        this.store.transition(orderId, (o) => {
          o.state = "OUTGOING_SETTLED";
          o.outgoing.status = "SETTLED";
          o.outgoing.preimage = preimage;
          o.updatedAt = this.now();
        }, "outgoing settled, preimage verified");
        await this.settleIncoming(orderId);
        return;
      }
      case "OUTGOING_FAILED": {
        if (order.state !== "OUTGOING_IN_FLIGHT" && order.state !== "INCOMING_HELD") return;
        const reason = event.failureReason ?? "outgoing payment failed";
        await this.refund(orderId, failure(
          /no.?route/i.test(reason) ? "NO_ROUTE" : "OUTGOING_FAILED",
          reason,
          true,
          "the destination may be unreachable or lack inbound capacity",
        ));
        return;
      }
      case "INCOMING_CANCELLED": {
        if (order.state === "SUCCEEDED" || order.state === "FAILED") return;
        if (order.state === "OUTGOING_SETTLED") {
          // hub is owed money and the hold vanished — never mask this
          this.log("critical", "incoming cancelled AFTER outgoing settled — funds at risk, manual intervention", orderId);
        }
        await this.fail(
          orderId,
          order.failure ?? failure("OUTGOING_FAILED", "incoming hold cancelled/expired", false),
          false,
        );
        return;
      }
      case "INCOMING_SETTLED": {
        if (order.state === "OUTGOING_SETTLED") {
          this.store.transition(orderId, (o) => {
            o.state = "SUCCEEDED";
            o.incoming.status = "SETTLED";
            if (o.outgoing.preimage) o.incoming.preimage = o.outgoing.preimage;
            o.updatedAt = this.now();
          }, "incoming settled (node event)");
        } else if (order.state !== "SUCCEEDED") {
          // only we can settle; anything else is an I1 alarm, never celebrated
          this.log("critical", `incoming settled in state ${order.state} without engine action — I1 breach signal`, orderId);
        }
        return;
      }
      case "OUTGOING_IN_FLIGHT":
        return; // informational; the dispatch transition is engine-driven (R5)
    }
  }

  /** R2/R4/I3: dispatch exactly once, persisted before the node call. */
  private async dispatchOutgoing(orderId: string): Promise<void> {
    const order = this.store.get(orderId)!;
    if (order.state !== "INCOMING_HELD" || order.outgoing.status !== "WAITING") return; // R4

    // R3 re-evaluation immediately before dispatch (PROTOCOL §6).
    const now = this.now();
    if (now + this.minSafetyDeltaMs >= order.incoming.tlcExpiryAt) {
      await this.refund(orderId, failure(
        "EXPIRY_INVARIANT_VIOLATION",
        "incoming expiry too close at dispatch time (R3)",
        false,
      ));
      return;
    }

    this.store.transition(orderId, (o) => {
      o.state = "OUTGOING_IN_FLIGHT";
      o.outgoing.status = "IN_FLIGHT";
      o.updatedAt = this.now();
    }, "dispatching outgoing"); // R5: persisted BEFORE pay()

    try {
      await this.ports[order.outgoing.network].pay.pay(order.outgoing.invoice, {
        maxFee: this.maxFeeFor(BigInt(order.outgoing.amount)),
        tlcExpiryLimitMs: order.outgoing.tlcExpiryAt - now,
      });
    } catch (e) {
      // Immediate refusal is NOT proof of absence (the node may have accepted
      // it); reconcile against node truth before deciding (I3: retries only
      // after a definitive signal).
      this.log("warn", `dispatch call failed: ${String(e)} — reconciling`, orderId);
      await this.reconcileOutgoing(orderId);
    }
  }

  /** THE only call site of incoming settle (R1/I1). */
  private async settleIncoming(orderId: string): Promise<void> {
    const order = this.store.get(orderId)!;
    if (order.state !== "OUTGOING_SETTLED") {
      this.log("critical", `settleIncoming reached in state ${order.state} — refusing (R1)`, orderId);
      return;
    }
    const preimage = order.outgoing.preimage;
    if (!preimage || !hexPreimageMatches(preimage, order.paymentHash)) {
      this.log("critical", "persisted preimage missing or unverified — refusing to settle (I1)", orderId);
      return;
    }
    await this.ports[order.incoming.network].hold.settle(order.paymentHash, preimage);
    this.store.transition(orderId, (o) => {
      o.state = "SUCCEEDED";
      o.incoming.status = "SETTLED";
      o.incoming.preimage = preimage;
      o.updatedAt = this.now();
    }, "incoming settled — swap complete");
    this.log("info", "swap SUCCEEDED", orderId);
  }

  private async refund(orderId: string, why: ProtocolError): Promise<void> {
    const order = this.store.get(orderId)!;
    if (order.state === "REFUNDING" || order.state === "FAILED" || order.state === "SUCCEEDED") return;
    this.store.transition(orderId, (o) => {
      o.state = "REFUNDING";
      o.outgoing.status = o.outgoing.status === "IN_FLIGHT" ? "FAILED" : o.outgoing.status;
      o.failure = why;
      o.updatedAt = this.now();
    }, `refunding: ${why.code}`); // R5 before the cancel side effect
    try {
      await this.ports[order.incoming.network].hold.cancel(order.paymentHash);
    } catch (e) {
      this.log("warn", `cancel failed (will re-attempt via events/recovery): ${String(e)}`, orderId);
      return; // stay in REFUNDING; INCOMING_CANCELLED event or recovery completes it
    }
    await this.fail(orderId, why, false);
  }

  private async fail(orderId: string, why: ProtocolError, cancelIncoming: boolean): Promise<void> {
    const order = this.store.get(orderId)!;
    if (order.state === "FAILED" || order.state === "SUCCEEDED") return;
    this.store.transition(orderId, (o) => {
      o.state = "FAILED";
      o.incoming.status = o.incoming.status === "SETTLED" ? o.incoming.status : "CANCELLED";
      o.failure = o.failure ?? why;
      o.updatedAt = this.now();
    }, `failed: ${why.code}`);
    if (cancelIncoming) {
      await this.ports[order.incoming.network].hold.cancel(order.paymentHash).catch((e) => {
        this.log("warn", `post-fail cancel failed: ${String(e)}`, orderId);
      });
    }
  }

  /* ---------------- I4 recovery ---------------- */

  private async reconcile(orderId: string): Promise<void> {
    const order = this.store.get(orderId)!;
    this.log("info", `recovering order in state ${order.state}`, orderId);

    if (order.state === "PENDING" && order.incoming.invoice === "") {
      // crashed between persist and hold-invoice creation: nothing node-side
      await this.fail(orderId, failure("INTERNAL", "crashed before incoming invoice was issued", true), true);
      return;
    }

    const incoming = await this.ports[order.incoming.network].hold.invoiceState(order.paymentHash);
    if (incoming === "HELD" && order.state === "PENDING") {
      await this.handle(orderId, {
        network: order.incoming.network, paymentHash: order.paymentHash,
        kind: "INCOMING_HELD", observedAt: this.now(),
      });
    } else if (incoming === "CANCELLED") {
      await this.handle(orderId, {
        network: order.incoming.network, paymentHash: order.paymentHash,
        kind: "INCOMING_CANCELLED", observedAt: this.now(),
      });
      return;
    } else if (incoming === "SETTLED" && order.state === "OUTGOING_SETTLED") {
      await this.handle(orderId, {
        network: order.incoming.network, paymentHash: order.paymentHash,
        kind: "INCOMING_SETTLED", observedAt: this.now(),
      });
      return;
    }

    const fresh = this.store.get(orderId)!;
    if (fresh.state === "OUTGOING_IN_FLIGHT" || fresh.state === "OUTGOING_SETTLED") {
      await this.reconcileOutgoing(orderId);
    } else if (fresh.state === "REFUNDING") {
      await this.refundRetry(orderId);
    }
  }

  /** Query node truth for the outgoing leg and act on the definitive signal (I3). */
  private async reconcileOutgoing(orderId: string): Promise<void> {
    const order = this.store.get(orderId)!;
    const state = await this.ports[order.outgoing.network].pay.paymentState(order.paymentHash);
    switch (state.status) {
      case "SUCCEEDED":
        await this.handle(orderId, {
          network: order.outgoing.network, paymentHash: order.paymentHash,
          kind: "OUTGOING_SETTLED", observedAt: this.now(),
          ...(state.preimage ? { preimage: state.preimage } : {}),
        });
        return;
      case "FAILED":
        await this.handle(orderId, {
          network: order.outgoing.network, paymentHash: order.paymentHash,
          kind: "OUTGOING_FAILED", observedAt: this.now(),
          ...(state.failureReason ? { failureReason: state.failureReason } : {}),
        });
        return;
      case "NONE": {
        // definitive absence: the node never saw the dispatch → safe single re-dispatch
        const o = this.store.get(orderId)!;
        if (o.state !== "OUTGOING_IN_FLIGHT") return;
        this.log("info", "node has no payment record — re-dispatching once (I3 definitive-absence)", orderId);
        try {
          await this.ports[o.outgoing.network].pay.pay(o.outgoing.invoice, {
            maxFee: this.maxFeeFor(BigInt(o.outgoing.amount)),
            tlcExpiryLimitMs: o.outgoing.tlcExpiryAt - this.now(),
          });
        } catch (e) {
          this.log("warn", `re-dispatch failed: ${String(e)}`, orderId);
        }
        return;
      }
      case "IN_FLIGHT":
        return; // wait for events
    }
  }

  private async refundRetry(orderId: string): Promise<void> {
    const order = this.store.get(orderId)!;
    const incoming = await this.ports[order.incoming.network].hold.invoiceState(order.paymentHash);
    if (incoming === "CANCELLED" || incoming === "UNKNOWN") {
      await this.fail(orderId, order.failure ?? failure("OUTGOING_FAILED", "refund completed on recovery", false), false);
    } else {
      await this.ports[order.incoming.network].hold.cancel(order.paymentHash)
        .then(() => this.fail(orderId, order.failure ?? failure("OUTGOING_FAILED", "refund completed on recovery", false), false))
        .catch((e) => this.log("warn", `refund retry failed: ${String(e)}`, orderId));
    }
  }
}
