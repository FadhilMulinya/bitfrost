/**
 * Shared adapter types (SYSTEM-DESIGN §4.1). The adapters normalize both
 * networks' invoice/TLC events into `SwapLegEvent`, consumed by the
 * OrderEngine (not implemented yet). bifrostd performs no HTLC cryptography
 * itself — the nodes do.
 */

/** 0x-prefixed lowercase 64-hex-char string (32 bytes). */
export type Hash256 = string;

const HASH256_RE = /^0x[0-9a-f]{64}$/;

export function assertHash256(v: string, label = "hash"): Hash256 {
  if (!HASH256_RE.test(v)) {
    throw new TypeError(`${label} must be 0x + 64 lowercase hex chars, got ${JSON.stringify(v)}`);
  }
  return v;
}

/** CKB script reference (matches ckb-jsonrpc-types Script). */
export interface Script {
  code_hash: string;
  hash_type: "type" | "data" | "data1" | "data2";
  args: string;
}

/** Hash algorithm is a parameter — the PTLC-readiness seam (§4.1 note 3). */
export type HashAlgorithm = "sha256" | "ckb_hash";

/* ---------- normalized events ---------- */

export type SwapLegEventKind =
  /** incoming hold invoice: TLC set accepted and held (NOT settled) */
  | "INCOMING_HELD"
  /** incoming hold invoice settled with preimage */
  | "INCOMING_SETTLED"
  /** incoming hold invoice cancelled / expired */
  | "INCOMING_CANCELLED"
  /** outgoing payment dispatched */
  | "OUTGOING_IN_FLIGHT"
  /** outgoing payment succeeded — preimage known */
  | "OUTGOING_SETTLED"
  /** outgoing payment definitively failed */
  | "OUTGOING_FAILED";

export interface SwapLegEvent {
  network: "fiber" | "lightning";
  paymentHash: Hash256;
  kind: SwapLegEventKind;
  /** present on OUTGOING_SETTLED (and Fiber PutPreimage store changes) */
  preimage?: Hash256;
  /** node-reported failure detail, when any */
  failureReason?: string;
  /** wall-clock ms when the adapter observed the event */
  observedAt: number;
  /** raw node payload, for logging/diagnosis only — never for decisions */
  raw?: unknown;
}

/* ---------- Fiber ---------- */

export type FiberInvoiceStatus = "Open" | "Cancelled" | "Expired" | "Received" | "Paid";
export type FiberPaymentStatus = "Created" | "Inflight" | "Success" | "Failed";

export interface FiberInvoice {
  invoiceAddress: string;
  paymentHash: Hash256;
}

export interface FiberInvoiceDetails {
  paymentHash: Hash256;
  amount?: bigint;
  udtTypeScript?: Script;
}

export interface FiberChannel {
  channelId: string;
  peerId: string;
  state: string;
  localBalance: bigint;
  remoteBalance: bigint;
  /** currently-locked outbound TLCs (docs/RPC-NOTES.md) — spendable outbound = localBalance - offeredTlcBalance */
  offeredTlcBalance: bigint;
  /** currently-locked inbound TLCs — spendable inbound = remoteBalance - receivedTlcBalance */
  receivedTlcBalance: bigint;
  udtTypeScript?: Script;
}

export interface FiberNodeInfo {
  nodeId: string;
  version: string;
}

/** jsonrpsee `subscribe_store_changes` payloads we act on (fiber store_impl::StoreChange). */
export type StoreChangeEvent =
  | { PutPreimage: { payment_hash: Hash256; payment_preimage: Hash256 } }
  | { PutCkbInvoiceStatus: { payment_hash: Hash256; invoice_status: FiberInvoiceStatus } }
  | { PutPaymentSession: { payment_hash: Hash256; payment_session: unknown } }
  | { PutAttempt: { payment_hash: Hash256; attempt_status: unknown } }
  | Record<string, unknown>; // forward-compatible: unknown variants pass through

/* ---------- Lightning ---------- */

export type LnPaymentStatus = "UNKNOWN" | "IN_FLIGHT" | "SUCCEEDED" | "FAILED";
export type LnInvoiceState = "OPEN" | "SETTLED" | "CANCELED" | "ACCEPTED";

export interface Bolt11 {
  paymentRequest: string;
  paymentHash: Hash256;
}

export interface Bolt11Details {
  paymentHash: Hash256;
  amountSat: bigint;
  expirySeconds: number;
  cltvExpiry: number;
  destination: string;
}

export interface LnChannel {
  channelPoint: string;
  remotePubkey: string;
  active: boolean;
  localBalanceSat: bigint;
  remoteBalanceSat: bigint;
  /** spendable outbound = localBalanceSat - localChanReserveSat - unsettledBalanceSat */
  localChanReserveSat: bigint;
  unsettledBalanceSat: bigint;
}

export interface LnNodeInfo {
  nodeId: string;
  version: string;
  syncedToChain: boolean;
}

export interface PaymentUpdate {
  paymentHash: Hash256;
  status: LnPaymentStatus | FiberPaymentStatus;
  preimage?: Hash256;
  failureReason?: string;
}

/** Returned by sendPayment on both adapters. */
export interface PaymentHandle {
  paymentHash: Hash256;
  network: "fiber" | "lightning";
  status: PaymentUpdate["status"];
}

/* ---------- errors ---------- */

export class AdapterError extends Error {
  constructor(
    readonly adapter: "fiber" | "lightning",
    readonly op: string,
    message: string,
    readonly retryable: boolean,
    readonly cause?: unknown,
  ) {
    super(`${adapter}.${op}: ${message}`);
    this.name = "AdapterError";
  }
}
