/** bifrost-sdk — protocol types for bifrost/0.1. Mirrors spec/PROTOCOL.md exactly. */

export const PROTOCOL_VERSION = "bifrost/0.1" as const;

/* ---------- Assets & pairs (PROTOCOL §2) ---------- */

export interface CkbScript {
  codeHash: string;
  hashType: "type" | "data" | "data1" | "data2";
  args: string;
}

export type AssetRef =
  | { network: "lightning"; unit: "sat" }
  | { network: "fiber"; unit: "shannon" }
  | { network: "fiber"; unit: "udt"; udtScript: CkbScript };

export interface Pair {
  give: AssetRef;
  get: AssetRef;
}

/** All wire amounts are base-10 integer strings (PROTOCOL §3). */
export type Amount = string;

/* ---------- Quotes (PROTOCOL §4.1–4.2) ---------- */

export type QuoteMode = "PAY_INVOICE" | "RECEIVE";

export interface QuoteRequest {
  protocol: typeof PROTOCOL_VERSION;
  pair: Pair;
  amount: { side: "give" | "get"; value: Amount };
  mode: QuoteMode;
  targetInvoice?: string;
}

export interface FeeBreakdown {
  hubFeePpm: Amount;
  flatFee: Amount;
  estNetworkFee: Amount;
}

export interface Quote {
  protocol: typeof PROTOCOL_VERSION;
  quoteId: string;
  pair: Pair;
  rate: { num: Amount; den: Amount };
  giveAmount: Amount;
  getAmount: Amount;
  feeBreakdown: FeeBreakdown;
  issuedAt: number;
  expiresAt: number;
  maxIncomingHoldMs: number;
  minSafetyDeltaMs: number;
  hubPubkey: string;
  signature: string;
}

/* ---------- Orders (PROTOCOL §4.3–4.4) ---------- */

export type OrderState =
  | "PENDING"
  | "INCOMING_HELD"
  | "OUTGOING_IN_FLIGHT"
  | "OUTGOING_SETTLED"
  | "SUCCEEDED"
  | "REFUNDING"
  | "FAILED";

export type LegStatus =
  | "WAITING"
  | "HELD"
  | "IN_FLIGHT"
  | "SETTLED"
  | "CANCELLED"
  | "FAILED";

export interface Leg {
  network: "fiber" | "lightning";
  invoice: string;
  amount: Amount;
  tlcExpiryAt: number;
  status: LegStatus;
  preimage?: string;
}

export interface OrderCreate {
  protocol: typeof PROTOCOL_VERSION;
  quoteId: string;
  targetInvoice?: string;
}

export interface Order {
  protocol: typeof PROTOCOL_VERSION;
  orderId: string;
  quoteId: string;
  direction: "FIBER_TO_LN" | "LN_TO_FIBER";
  paymentHash: string;
  state: OrderState;
  incoming: Leg;
  outgoing: Leg;
  failure: ProtocolError | null;
  createdAt: number;
  updatedAt: number;
}

/* ---------- Advertisements (PROTOCOL §4.5) ---------- */

export interface AdvertisedPair extends Pair {
  minAmount: Amount;
  maxAmount: Amount;
}

export interface Advertisement {
  protocol: typeof PROTOCOL_VERSION;
  hubPubkey: string;
  endpoints: { api: string };
  pairs: AdvertisedPair[];
  fiberNodeId: string;
  lightningNodeId: string;
  issuedAt: number;
  ttlMs: number;
  signature: string;
}

/* ---------- Errors (PROTOCOL §7, closed registry) ---------- */

export const ERROR_CODES = [
  "PAIR_UNSUPPORTED",
  "AMOUNT_OUT_OF_BOUNDS",
  "INVENTORY_INSUFFICIENT",
  "PRICING_UNAVAILABLE",
  "INVOICE_INVALID",
  "INVOICE_MISMATCH",
  "HASH_ALGO_UNSUPPORTED",
  "QUOTE_EXPIRED",
  "QUOTE_UNKNOWN",
  "EXPIRY_INVARIANT_VIOLATION",
  "NO_ROUTE",
  "OUTGOING_TIMEOUT",
  "OUTGOING_FAILED",
  "HUB_OVEREXPOSED",
  "RATE_LIMITED",
  "UNAUTHORIZED",
  "INTERNAL",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ProtocolError {
  code: ErrorCode;
  message: string;
  hint?: string;
  retryable: boolean;
  orderId?: string;
}

/* ---------- Stream events (PROTOCOL §8) ---------- */

export type StreamEvent =
  | { type: "order"; data: Order }
  | { type: "quote_expired"; quoteId: string };
