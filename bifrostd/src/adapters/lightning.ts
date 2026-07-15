/**
 * LightningAdapter — SYSTEM-DESIGN §4.1, bound to LND's invoicesrpc
 * (AddHoldInvoice / SettleInvoice / CancelInvoice / SubscribeSingleInvoice)
 * and routerrpc (SendPaymentV2 / TrackPaymentV2).
 *
 * Transport is LND's REST proxy of those exact gRPC methods
 * (/v2/invoices/*, /v2/router/*) — a 1:1 mapping, chosen over native gRPC to
 * avoid proto/grpc dependencies. Logged in RPC-NOTES "Adapter divergence log".
 *
 * REST encoding quirks (per LND docs):
 * - byte fields (hash, preimage) are BASE64 on the wire, not hex;
 *   URL path params (trackpayment, subscribe) are base64url.
 * - int64 fields (value, fee limits) are JSON strings.
 */
import type { LndTransport } from "./transport.js";
import {
  AdapterError,
  assertHash256,
  type Bolt11,
  type Bolt11Details,
  type Hash256,
  type LnChannel,
  type LnInvoiceState,
  type LnPaymentStatus,
  type PaymentHandle,
  type PaymentUpdate,
  type SwapLegEvent,
} from "./types.js";

/* hex(0x…) <-> base64 helpers, kept here: this is a wire-encoding concern */
export function hexToBase64(hex0x: string): string {
  return Buffer.from(hex0x.slice(2), "hex").toString("base64");
}
export function hexToBase64Url(hex0x: string): string {
  // grpc-gateway decodes path bytes with base64.URLEncoding, which REQUIRES
  // padding; Node's "base64url" drops it, so restore the '=' padding.
  const b64 = Buffer.from(hex0x.slice(2), "hex").toString("base64url");
  return b64 + "=".repeat((4 - (b64.length % 4)) % 4);
}
export function base64ToHex(b64: string): Hash256 {
  return `0x${Buffer.from(b64, "base64").toString("hex")}`;
}

export interface LightningAdapterOptions {
  transport: LndTransport;
  now?: () => number;
}

interface RestInvoice {
  state: LnInvoiceState;
  r_hash: string; // base64
  payment_request: string;
}
interface RestPayment {
  status: LnPaymentStatus;
  payment_hash: string; // hex (routerrpc Payment uses hex strings)
  payment_preimage?: string; // hex
  failure_reason?: string;
}

export class LightningAdapter {
  private readonly transport: LndTransport;
  private readonly now: () => number;

  constructor(opts: LightningAdapterOptions) {
    this.transport = opts.transport;
    this.now = opts.now ?? Date.now;
  }

  /** invoicesrpc.AddHoldInvoice — hold invoice keyed to an external hash. */
  async addHoldInvoice(p: { amountSat: bigint; paymentHash: Hash256; cltvExpiry: number; memo?: string }): Promise<Bolt11> {
    assertHash256(p.paymentHash, "paymentHash");
    if (p.amountSat < 0n) throw new AdapterError("lightning", "addHoldInvoice", "negative amount", false);
    const res = await this.transport.post<{ payment_request: string }>("/v2/invoices/hodl", {
      hash: hexToBase64(p.paymentHash),
      value: p.amountSat.toString(), // int64 → JSON string
      cltv_expiry: String(p.cltvExpiry),
      ...(p.memo !== undefined ? { memo: p.memo } : {}),
    });
    return { paymentRequest: res.payment_request, paymentHash: p.paymentHash };
  }

  /** invoicesrpc.SettleInvoice — keyed by preimage (LND derives the hash). */
  async settleHoldInvoice(preimage: Hash256): Promise<void> {
    assertHash256(preimage, "preimage");
    await this.transport.post("/v2/invoices/settle", { preimage: hexToBase64(preimage) });
  }

  /** invoicesrpc.CancelInvoice. */
  async cancelHoldInvoice(paymentHash: Hash256): Promise<void> {
    assertHash256(paymentHash, "paymentHash");
    await this.transport.post("/v2/invoices/cancel", { payment_hash: hexToBase64(paymentHash) });
  }

  /**
   * routerrpc.SendPaymentV2 (server-streaming). Returns after the FIRST
   * status frame — the definitive outcome arrives via trackPayment
   * (single-flight retries belong to the OrderEngine, not here).
   */
  async sendPayment(bolt11: string, maxFeeSat: bigint, cltvLimit: number): Promise<PaymentHandle> {
    const stream = this.transport.stream("/v2/router/send", {
      payment_request: bolt11,
      fee_limit_sat: maxFeeSat.toString(),
      cltv_limit: cltvLimit,
      timeout_seconds: 60,
      no_inflight_updates: false,
    });
    for await (const frame of stream) {
      const p = unwrapStreamFrame<RestPayment>(frame);
      return { network: "lightning", paymentHash: `0x${p.payment_hash}`, status: p.status };
    }
    throw new AdapterError("lightning", "sendPayment", "stream ended without a status frame", true);
  }

  /** routerrpc.TrackPaymentV2 — yields until terminal; preimage on success. */
  async *trackPayment(paymentHash: Hash256): AsyncIterable<PaymentUpdate> {
    assertHash256(paymentHash, "paymentHash");
    const path = `/v2/router/track/${hexToBase64Url(paymentHash)}?no_inflight_updates=false`;
    for await (const frame of this.transport.stream(path)) {
      const p = unwrapStreamFrame<RestPayment>(frame);
      const update: PaymentUpdate = { paymentHash, status: p.status };
      if (p.payment_preimage && !/^0+$/.test(p.payment_preimage)) {
        update.preimage = `0x${p.payment_preimage}`;
      }
      if (p.failure_reason && p.failure_reason !== "FAILURE_REASON_NONE") {
        update.failureReason = p.failure_reason;
      }
      yield update;
      if (p.status === "SUCCEEDED" || p.status === "FAILED") return;
    }
  }

  /** lnrpc.LookupInvoice (REST GET /v1/invoice/{r_hash_str}, hex path param). */
  async lookupInvoice(paymentHash: Hash256): Promise<RestInvoice> {
    assertHash256(paymentHash, "paymentHash");
    return this.transport.get<RestInvoice>(`/v1/invoice/${paymentHash.slice(2)}`);
  }

  /** invoicesrpc.SubscribeSingleInvoice — hold-invoice lifecycle stream. */
  async *subscribeInvoice(paymentHash: Hash256): AsyncIterable<RestInvoice> {
    assertHash256(paymentHash, "paymentHash");
    for await (const frame of this.transport.stream(`/v2/invoices/subscribe/${hexToBase64Url(paymentHash)}`)) {
      yield unwrapStreamFrame<RestInvoice>(frame);
    }
  }

  /** Normalized leg events for one hash (incoming = invoice, outgoing = payment). */
  async *legEvents(paymentHash: Hash256, role: "incoming" | "outgoing"): AsyncIterable<SwapLegEvent> {
    if (role === "incoming") {
      for await (const inv of this.subscribeInvoice(paymentHash)) {
        const kind =
          inv.state === "ACCEPTED" ? "INCOMING_HELD"
          : inv.state === "SETTLED" ? "INCOMING_SETTLED"
          : inv.state === "CANCELED" ? "INCOMING_CANCELLED"
          : undefined;
        if (kind) {
          yield { network: "lightning", paymentHash, kind, observedAt: this.now(), raw: inv };
          if (kind !== "INCOMING_HELD") return;
        }
      }
    } else {
      for await (const u of this.trackPayment(paymentHash)) {
        if (u.status === "IN_FLIGHT") {
          yield { network: "lightning", paymentHash, kind: "OUTGOING_IN_FLIGHT", observedAt: this.now(), raw: u };
        } else if (u.status === "SUCCEEDED") {
          const ev: SwapLegEvent = { network: "lightning", paymentHash, kind: "OUTGOING_SETTLED", observedAt: this.now(), raw: u };
          if (u.preimage) ev.preimage = u.preimage;
          yield ev;
          return;
        } else if (u.status === "FAILED") {
          const ev: SwapLegEvent = { network: "lightning", paymentHash, kind: "OUTGOING_FAILED", observedAt: this.now(), raw: u };
          if (u.failureReason) ev.failureReason = u.failureReason;
          yield ev;
          return;
        }
      }
    }
  }

  /** lnrpc.DecodePayReq (REST GET /v1/payreq/{payreq}). */
  async decodeInvoice(bolt11: string): Promise<Bolt11Details> {
    const res = await this.transport.get<{
      payment_hash: string; // hex
      num_satoshis: string;
      expiry: string;
      cltv_expiry: string;
      destination: string;
    }>(`/v1/payreq/${encodeURIComponent(bolt11)}`);
    return {
      paymentHash: `0x${res.payment_hash}`,
      amountSat: BigInt(res.num_satoshis),
      expirySeconds: Number(res.expiry),
      cltvExpiry: Number(res.cltv_expiry),
      destination: res.destination,
    };
  }

  /** lnrpc.ListChannels (REST GET /v1/channels). */
  async getChannels(): Promise<LnChannel[]> {
    const res = await this.transport.get<{ channels: Array<Record<string, unknown>> }>("/v1/channels");
    return (res.channels ?? []).map((c) => ({
      channelPoint: String(c["channel_point"]),
      remotePubkey: String(c["remote_pubkey"]),
      active: Boolean(c["active"]),
      localBalanceSat: BigInt(String(c["local_balance"] ?? "0")),
      remoteBalanceSat: BigInt(String(c["remote_balance"] ?? "0")),
    }));
  }
}

/** LND REST streams wrap each frame as {"result": …} (grpc-gateway); errors as {"error": …}. */
function unwrapStreamFrame<T>(frame: unknown): T {
  const f = frame as { result?: T; error?: { message?: string } };
  if (f.error) {
    throw new AdapterError("lightning", "stream", f.error.message ?? "stream error", true, f.error);
  }
  return (f.result ?? frame) as T;
}
