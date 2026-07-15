/**
 * Network ports — the narrow surface the OrderEngine needs per network
 * (SYSTEM-DESIGN §4.2), implemented over the real adapters (§4.1). Property
 * tests substitute fakes; the smoke runner binds Fiber/Lightning adapters.
 *
 * CLTV↔ms conversions live in @bifrost/sdk's expiry module (PROTOCOL §6) and
 * are applied here in the conservative direction only:
 *  - incoming LN hold window: blocks = ceil(ms / INCOMING_MS_PER_BLOCK), so
 *    the fast-block underestimate of the real hold still covers the claim;
 *  - outgoing LN cltv_limit: blocks = floor(ms / OUTGOING_MS_PER_BLOCK), so
 *    the slow-block overestimate of the route budget stays within the limit.
 */
import { INCOMING_MS_PER_BLOCK, OUTGOING_MS_PER_BLOCK } from "@bifrost/sdk";
import type { FiberAdapter } from "../adapters/fiber.js";
import type { LightningAdapter } from "../adapters/lightning.js";
import { AdapterError, type Hash256, type Script } from "../adapters/types.js";

export type HoldInvoiceState = "OPEN" | "HELD" | "SETTLED" | "CANCELLED" | "UNKNOWN";

export interface HoldPort {
  /** Create a hold invoice locked to the external hash; returns the invoice string. */
  createHoldInvoice(p: {
    paymentHash: Hash256;
    amount: bigint;
    /** how long the final TLC/HTLC may hold, wall-clock ms from now */
    tlcExpiryDeltaMs: number;
    expirySeconds?: number;
    description?: string;
  }): Promise<string>;
  settle(paymentHash: Hash256, preimage: Hash256): Promise<void>;
  cancel(paymentHash: Hash256): Promise<void>;
  invoiceState(paymentHash: Hash256): Promise<HoldInvoiceState>;
}

export interface PaymentStateResult {
  status: "NONE" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED";
  preimage?: Hash256;
  failureReason?: string;
}

export interface PayPort {
  pay(invoice: string, p: { maxFee: bigint; tlcExpiryLimitMs: number }): Promise<void>;
  paymentState(paymentHash: Hash256): Promise<PaymentStateResult>;
}

export interface NetworkPorts {
  hold: HoldPort;
  pay: PayPort;
}

const isNotFound = (e: unknown): boolean =>
  e instanceof AdapterError && /not\s*found|unable to locate|no such/i.test(String(e.cause ? JSON.stringify(e.cause) : e.message) + e.message);

export function fiberPorts(adapter: FiberAdapter, opts: { assetScript?: Script } = {}): NetworkPorts {
  return {
    hold: {
      async createHoldInvoice(p) {
        const inv = await adapter.newHoldInvoice({
          amount: p.amount,
          paymentHash: p.paymentHash,
          finalTlcExpiryDeltaMs: p.tlcExpiryDeltaMs, // FNN units are already ms
          ...(opts.assetScript ? { assetScript: opts.assetScript } : {}),
          ...(p.expirySeconds !== undefined ? { expirySeconds: p.expirySeconds } : {}),
          ...(p.description !== undefined ? { description: p.description } : {}),
        });
        return inv.invoiceAddress;
      },
      settle: (hash, preimage) => adapter.settleHoldInvoice(hash, preimage),
      cancel: (hash) => adapter.cancelHoldInvoice(hash),
      async invoiceState(hash) {
        try {
          const s = await adapter.getInvoiceStatus(hash);
          return s === "Open" ? "OPEN" : s === "Received" ? "HELD" : s === "Paid" ? "SETTLED" : "CANCELLED";
        } catch (e) {
          if (isNotFound(e)) return "UNKNOWN";
          throw e;
        }
      },
    },
    pay: {
      async pay(invoice, p) {
        await adapter.sendPayment(invoice, p.maxFee, p.tlcExpiryLimitMs);
      },
      async paymentState(hash) {
        try {
          const p = await adapter.getPayment(hash);
          if (p.status === "Failed") {
            return { status: "FAILED", ...(p.failed_error != null ? { failureReason: p.failed_error } : {}) };
          }
          // NOTE: FNN get_payment never returns the preimage (RPC-NOTES); on
          // Success the engine must wait for a PutPreimage-derived event.
          return { status: p.status === "Success" ? "SUCCEEDED" : "IN_FLIGHT" };
        } catch (e) {
          if (isNotFound(e)) return { status: "NONE" };
          throw e;
        }
      },
    },
  };
}

export function lightningPorts(adapter: LightningAdapter): NetworkPorts {
  return {
    hold: {
      async createHoldInvoice(p) {
        const inv = await adapter.addHoldInvoice({
          amountSat: p.amount,
          paymentHash: p.paymentHash,
          cltvExpiry: Math.ceil(p.tlcExpiryDeltaMs / INCOMING_MS_PER_BLOCK),
          ...(p.description !== undefined ? { memo: p.description } : {}),
        });
        return inv.paymentRequest;
      },
      settle: (_hash, preimage) => adapter.settleHoldInvoice(preimage), // LND keys settle by preimage
      cancel: (hash) => adapter.cancelHoldInvoice(hash),
      async invoiceState(hash) {
        try {
          const s = (await adapter.lookupInvoice(hash)).state;
          return s === "OPEN" ? "OPEN" : s === "ACCEPTED" ? "HELD" : s === "SETTLED" ? "SETTLED" : "CANCELLED";
        } catch (e) {
          if (isNotFound(e)) return "UNKNOWN";
          throw e;
        }
      },
    },
    pay: {
      async pay(invoice, p) {
        await adapter.sendPayment(invoice, p.maxFee, Math.floor(p.tlcExpiryLimitMs / OUTGOING_MS_PER_BLOCK));
      },
      async paymentState(hash) {
        try {
          for await (const u of adapter.trackPayment(hash)) {
            if (u.status === "SUCCEEDED") return { status: "SUCCEEDED", ...(u.preimage ? { preimage: u.preimage } : {}) };
            if (u.status === "FAILED") return { status: "FAILED", ...(u.failureReason ? { failureReason: u.failureReason } : {}) };
            return { status: "IN_FLIGHT" };
          }
          return { status: "NONE" };
        } catch (e) {
          if (isNotFound(e)) return { status: "NONE" };
          throw e;
        }
      },
    },
  };
}
