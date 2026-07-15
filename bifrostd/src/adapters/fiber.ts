/**
 * FiberAdapter — SYSTEM-DESIGN §4.1, bound to what FNN actually exposes
 * (docs/RPC-NOTES.md, verified against fiber source 04e091b / deployed
 * v0.9.0-rc7 fixtures). Divergences from the spec interface are listed in
 * RPC-NOTES "Adapter divergence log" — capabilities are never faked.
 *
 * Wire facts this file depends on:
 * - new_invoice accepts an external payment_hash (hold invoice); preimage
 *   must then be absent; amounts are U128Hex, expiry seconds U64Hex,
 *   final_expiry_delta MILLISECONDS U64Hex (min 16h / max 14d node-side).
 * - settle_invoice { payment_hash, payment_preimage }, cancel_invoice
 *   { payment_hash } (Open only).
 * - send_payment { invoice, max_fee_amount?: U128Hex, tlc_expiry_limit?: u64 }.
 * - get_payment { payment_hash } → status Created|Inflight|Success|Failed.
 * - pubsub module: WS subscription `subscribe_store_changes` streaming
 *   StoreChange (PutPreimage / PutCkbInvoiceStatus / PutPaymentSession / …).
 */
import { decodeU128Hex, encodeU128Hex, encodeU64Hex } from "../fnn/codec.js";
import type { FnnTransport } from "./transport.js";
import {
  AdapterError,
  assertHash256,
  type FiberChannel,
  type FiberInvoice,
  type FiberInvoiceDetails,
  type FiberInvoiceStatus,
  type FiberNodeInfo,
  type FiberPaymentStatus,
  type Hash256,
  type PaymentHandle,
  type Script,
  type StoreChangeEvent,
  type SwapLegEvent,
} from "./types.js";

export type FiberCurrency = "Fibb" | "Fibt" | "Fibd";

export interface FiberAdapterOptions {
  transport: FnnTransport;
  /** must match the node's network; FNN rejects mismatches */
  currency: FiberCurrency;
  now?: () => number;
}

interface NewInvoiceResult {
  invoice_address: string;
  invoice: { data: { payment_hash: Hash256 } };
}
interface GetInvoiceResult {
  invoice_address: string;
  status: FiberInvoiceStatus;
}
interface GetPaymentResult {
  payment_hash: Hash256;
  status: FiberPaymentStatus;
  failed_error?: string | null;
}
interface ParseInvoiceResult {
  invoice: {
    amount?: string | null;
    data: { payment_hash: Hash256; attrs?: unknown[] };
  };
}

export class FiberAdapter {
  private readonly transport: FnnTransport;
  private readonly currency: FiberCurrency;
  private readonly now: () => number;

  constructor(opts: FiberAdapterOptions) {
    this.transport = opts.transport;
    this.currency = opts.currency;
    this.now = opts.now ?? Date.now;
  }

  /** Hold invoice keyed to an EXTERNAL payment hash (never sends a preimage). */
  async newHoldInvoice(p: {
    amount: bigint;
    assetScript?: Script;
    paymentHash: Hash256;
    /** milliseconds — FNN final_expiry_delta unit; node clamps to [16h, 14d] */
    finalTlcExpiryDeltaMs: number;
    /** invoice expiry in seconds */
    expirySeconds?: number;
    description?: string;
  }): Promise<FiberInvoice> {
    assertHash256(p.paymentHash, "paymentHash");
    const params: Record<string, unknown> = {
      amount: encodeU128Hex(p.amount),
      currency: this.currency,
      payment_hash: p.paymentHash, // hold semantics: hash set, preimage absent
      hash_algorithm: "sha256", // PTLC seam: parameterized here on purpose
      final_expiry_delta: encodeU64Hex(BigInt(p.finalTlcExpiryDeltaMs)),
    };
    if (p.assetScript) params["udt_type_script"] = p.assetScript;
    if (p.expirySeconds !== undefined) params["expiry"] = encodeU64Hex(BigInt(p.expirySeconds));
    if (p.description !== undefined) params["description"] = p.description;

    const res = await this.transport.call<NewInvoiceResult>("new_invoice", params);
    const echoed = res.invoice.data.payment_hash;
    if (echoed !== p.paymentHash) {
      // never trust silently — a hash mismatch here would break atomicity
      throw new AdapterError("fiber", "new_invoice", `node echoed payment_hash ${echoed}, expected ${p.paymentHash}`, false);
    }
    return { invoiceAddress: res.invoice_address, paymentHash: echoed };
  }

  async settleHoldInvoice(paymentHash: Hash256, preimage: Hash256): Promise<void> {
    assertHash256(paymentHash, "paymentHash");
    assertHash256(preimage, "preimage");
    await this.transport.call("settle_invoice", { payment_hash: paymentHash, payment_preimage: preimage });
  }

  async cancelHoldInvoice(paymentHash: Hash256): Promise<void> {
    assertHash256(paymentHash, "paymentHash");
    await this.transport.call("cancel_invoice", { payment_hash: paymentHash });
  }

  async getInvoiceStatus(paymentHash: Hash256): Promise<FiberInvoiceStatus> {
    const res = await this.transport.call<GetInvoiceResult>("get_invoice", { payment_hash: paymentHash });
    return res.status;
  }

  async sendPayment(invoice: string, maxFee: bigint, tlcExpiryLimitMs: number): Promise<PaymentHandle> {
    const res = await this.transport.call<GetPaymentResult>("send_payment", {
      invoice,
      max_fee_amount: encodeU128Hex(maxFee),
      tlc_expiry_limit: encodeU64Hex(BigInt(tlcExpiryLimitMs)),
    });
    return { network: "fiber", paymentHash: res.payment_hash, status: res.status };
  }

  async getPayment(paymentHash: Hash256): Promise<GetPaymentResult> {
    return this.transport.call<GetPaymentResult>("get_payment", { payment_hash: paymentHash });
  }

  /**
   * DIVERGENCE (logged in RPC-NOTES): spec §4.1 declares this sync, but FNN
   * only parses invoices via the `parse_invoice` RPC — so it is async here.
   */
  async parseInvoice(invoice: string): Promise<FiberInvoiceDetails> {
    const res = await this.transport.call<ParseInvoiceResult>("parse_invoice", { invoice });
    const details: FiberInvoiceDetails = { paymentHash: res.invoice.data.payment_hash };
    if (res.invoice.amount != null) details.amount = decodeU128Hex(res.invoice.amount);
    return details;
  }

  /** Raw jsonrpsee WS stream (requires a transport with subscribe support). */
  async *subscribeStoreChanges(): AsyncIterable<StoreChangeEvent> {
    if (!this.transport.subscribe) {
      throw new AdapterError(
        "fiber",
        "subscribe_store_changes",
        "transport has no WS subscription support; use pollLegEvents() or a WsJsonRpc transport",
        false,
      );
    }
    for await (const ev of this.transport.subscribe("subscribe_store_changes", {}, "unsubscribe_store_changes")) {
      yield ev as StoreChangeEvent;
    }
  }

  /** Normalize StoreChange payloads into SwapLegEvents (OrderEngine input). */
  async *legEvents(): AsyncIterable<SwapLegEvent> {
    for await (const change of this.subscribeStoreChanges()) {
      const ev = this.normalizeStoreChange(change);
      if (ev) yield ev;
    }
  }

  normalizeStoreChange(change: StoreChangeEvent): SwapLegEvent | undefined {
    const observedAt = this.now();
    if ("PutCkbInvoiceStatus" in change) {
      const c = (change as Extract<StoreChangeEvent, { PutCkbInvoiceStatus: unknown }>).PutCkbInvoiceStatus;
      const kind =
        c.invoice_status === "Received" ? "INCOMING_HELD"
        : c.invoice_status === "Paid" ? "INCOMING_SETTLED"
        : c.invoice_status === "Cancelled" || c.invoice_status === "Expired" ? "INCOMING_CANCELLED"
        : undefined;
      if (!kind) return undefined; // Open = no transition worth emitting
      return { network: "fiber", paymentHash: c.payment_hash, kind, observedAt, raw: change };
    }
    if ("PutPreimage" in change) {
      const c = (change as Extract<StoreChangeEvent, { PutPreimage: unknown }>).PutPreimage;
      return {
        network: "fiber",
        paymentHash: c.payment_hash,
        kind: "OUTGOING_SETTLED",
        preimage: c.payment_preimage,
        observedAt,
        raw: change,
      };
    }
    return undefined; // PutPaymentSession / PutAttempt / unknown: not leg transitions
  }

  /**
   * Poll-based fallback for HTTP-only transports (explicit alternative to the
   * WS stream — documented, never a silent substitute). Polls get_payment and
   * get_invoice for the given hash until a terminal event or abort.
   */
  async *pollLegEvents(
    paymentHash: Hash256,
    role: "incoming" | "outgoing",
    opts: { intervalMs?: number; signal?: AbortSignal } = {},
  ): AsyncIterable<SwapLegEvent> {
    const interval = opts.intervalMs ?? 1000;
    let last: string | undefined;
    while (!opts.signal?.aborted) {
      if (role === "incoming") {
        const status = await this.getInvoiceStatus(paymentHash);
        if (status !== last) {
          last = status;
          const kind =
            status === "Received" ? "INCOMING_HELD"
            : status === "Paid" ? "INCOMING_SETTLED"
            : status === "Cancelled" || status === "Expired" ? "INCOMING_CANCELLED"
            : undefined;
          if (kind) {
            yield { network: "fiber", paymentHash, kind, observedAt: this.now() };
            if (kind !== "INCOMING_HELD") return;
          }
        }
      } else {
        const p = await this.getPayment(paymentHash);
        if (p.status !== last) {
          last = p.status;
          if (p.status === "Inflight") {
            yield { network: "fiber", paymentHash, kind: "OUTGOING_IN_FLIGHT", observedAt: this.now() };
          } else if (p.status === "Success") {
            // preimage arrives via PutPreimage on the WS path; get_payment does
            // not return it — OrderEngine must read it from the settled TLC.
            yield { network: "fiber", paymentHash, kind: "OUTGOING_SETTLED", observedAt: this.now(), raw: p };
            return;
          } else if (p.status === "Failed") {
            const ev: SwapLegEvent = { network: "fiber", paymentHash, kind: "OUTGOING_FAILED", observedAt: this.now(), raw: p };
            if (p.failed_error != null) ev.failureReason = p.failed_error;
            yield ev;
            return;
          }
        }
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  async getChannels(): Promise<FiberChannel[]> {
    const res = await this.transport.call<{ channels: Array<Record<string, unknown>> }>("list_channels", { peer_id: null });
    return res.channels.map((c) => ({
      channelId: String(c["channel_id"]),
      peerId: String(c["peer_id"]),
      state: String((c["state"] as { state_name?: string } | undefined)?.state_name ?? c["state"]),
      localBalance: decodeU128Hex(String(c["local_balance"])),
      remoteBalance: decodeU128Hex(String(c["remote_balance"])),
      offeredTlcBalance: decodeU128Hex(String(c["offered_tlc_balance"] ?? "0x0")),
      receivedTlcBalance: decodeU128Hex(String(c["received_tlc_balance"] ?? "0x0")),
      ...(c["funding_udt_type_script"] ? { udtTypeScript: c["funding_udt_type_script"] as Script } : {}),
    }));
  }

  /**
   * FIX (found live 2026-07-15, wiring api/health against a real node): the
   * node's public key field is `pubkey`, not `node_id` — the previous
   * mapping and its unit test fixture both encoded the wrong field name and
   * silently agreed with each other. Verified against the live rc7 node's
   * actual node_info response (docs/RPC-NOTES.md has no entry for this RPC
   * yet; it's a small enough, obviously-correct fix not to need one).
   */
  async nodeInfo(): Promise<FiberNodeInfo> {
    const res = await this.transport.call<{ pubkey: string; version: string }>("node_info", {});
    return { nodeId: res.pubkey, version: res.version };
  }
}
