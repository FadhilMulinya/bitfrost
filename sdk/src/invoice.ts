/**
 * Invoice detection + minimal metadata extraction.
 * v0.1 scope: detect network, extract payment hash and amount where cheaply
 * possible. Full BOLT11 decode should be delegated to a dedicated decoder in a
 * later milestone; the daemon always re-verifies via its nodes (source of truth).
 */
import { BifrostError } from "./errors.js";

export type InvoiceNetwork = "lightning" | "fiber";

export interface InvoiceInfo {
  network: InvoiceNetwork;
  raw: string;
  /** Present when extractable client-side; the hub/nodes remain authoritative. */
  paymentHash?: string;
  amount?: bigint;
}

const LN_PREFIXES = ["lnbc", "lntb", "lntbs", "lnbcrt"];
const FIBER_PREFIXES = ["fib", "fibt", "fibd"]; // mainnet / testnet / dev

export function detectInvoice(raw: string): InvoiceInfo {
  const s = raw.trim().toLowerCase();
  if (LN_PREFIXES.some((p) => s.startsWith(p))) {
    return { network: "lightning", raw: raw.trim() };
  }
  if (FIBER_PREFIXES.some((p) => s.startsWith(p))) {
    return { network: "fiber", raw: raw.trim() };
  }
  throw new BifrostError("INVOICE_INVALID", "unrecognized invoice format", false,
    "expected a BOLT11 (lnbc…/lntb…) or Fiber (fib…/fibt…) payment request");
}
