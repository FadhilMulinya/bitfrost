/**
 * Direction + leg-timing resolution for POST /v1/orders. Adapted from
 * bifrostd/src/smoke/runner.ts's fiberToLn/lnToFiber expiry math (PROTOCOL
 * §6 conservative conversions), generalized from fixed demo amounts to
 * whatever a redeemed Quote actually specifies.
 */
import { detectInvoice, incomingBlocksToMs, outgoingBlocksToMs, type AssetRef } from "bifrost-sdk";
import type { LightningAdapter } from "../adapters/lightning.js";
import type { Hash256 } from "../adapters/types.js";

const HOUR = 3_600_000;
// Fiber invoice decode carries no expiry (docs/STATUS.md production gap: sdk
// invoice.ts's decodeFiber cannot read one off the wire format). This mirrors
// the fixed 17h client-set final_expiry_delta convention used throughout
// this repo's own Fiber invoices (smoke runner, deploy scripts) plus a 1h
// route/dispatch margin. Revisit once Fiber invoices carry a real expiry.
const FIBER_OUTGOING_DELTA_MS = 18 * HOUR;

export interface LegPlan {
  direction: "FIBER_TO_LN" | "LN_TO_FIBER";
  paymentHash: Hash256;
  incoming: { network: "fiber" | "lightning"; amount: bigint; tlcExpiryAt: number };
  outgoing: { network: "fiber" | "lightning"; invoice: string; amount: bigint; tlcExpiryAt: number };
}

export async function planLegs(opts: {
  give: AssetRef;
  get: AssetRef;
  targetInvoice: string;
  giveAmount: bigint;
  getAmount: bigint;
  now: number;
  minSafetyDeltaMs: number;
  lndHub: LightningAdapter;
}): Promise<LegPlan> {
  const info = detectInvoice(opts.targetInvoice);
  if (info.network !== opts.get.network) {
    throw new Error(`targetInvoice network ${info.network} does not match quote get.network ${opts.get.network}`);
  }
  if (!info.paymentHash) throw new Error("target invoice carries no payment hash");
  const paymentHash = `0x${info.paymentHash}` as Hash256;
  const now = opts.now;

  if (opts.give.network === "fiber" && opts.get.network === "lightning") {
    // outgoing budget: final CLTV + 40-block route budget, slow-block pessimism
    const decoded = await opts.lndHub.decodeInvoice(opts.targetInvoice);
    const outgoingDeltaMs = outgoingBlocksToMs(decoded.cltvExpiry + 40);
    const incomingDeltaMs = Math.max(16 * HOUR + HOUR, outgoingDeltaMs + opts.minSafetyDeltaMs + 2 * HOUR);
    return {
      direction: "FIBER_TO_LN",
      paymentHash,
      incoming: { network: "fiber", amount: opts.giveAmount, tlcExpiryAt: now + incomingDeltaMs },
      outgoing: { network: "lightning", invoice: opts.targetInvoice, amount: opts.getAmount, tlcExpiryAt: now + outgoingDeltaMs },
    };
  }
  if (opts.give.network === "lightning" && opts.get.network === "fiber") {
    const outgoingDeltaMs = FIBER_OUTGOING_DELTA_MS;
    // fast-block pessimism when converting the incoming LN hold window to Fiber blocks
    const incomingBlocks = Math.ceil((outgoingDeltaMs + opts.minSafetyDeltaMs + 2 * HOUR) / 300_000);
    const incomingDeltaMs = incomingBlocksToMs(incomingBlocks);
    return {
      direction: "LN_TO_FIBER",
      paymentHash,
      incoming: { network: "lightning", amount: opts.getAmount, tlcExpiryAt: now + incomingDeltaMs },
      outgoing: { network: "fiber", invoice: opts.targetInvoice, amount: opts.giveAmount, tlcExpiryAt: now + outgoingDeltaMs },
    };
  }
  throw new Error(`unsupported pair give=${opts.give.network} get=${opts.get.network}`);
}
