/**
 * THE API CONTRACT (SYSTEM-DESIGN §4.5 subset the dashboard consumes).
 *
 * This module is the single source of truth for endpoint paths and response
 * shapes. The mock server implements it; test/contract.test.ts asserts it;
 * when bifrostd's real api/ lands, pointing the same test suite at bifrostd
 * IS the contract test. Do not fork these shapes.
 *
 * PROPOSED SPEC ADDITION (not yet in SYSTEM-DESIGN §4.5): GET /v1/quotes/stats
 * — §4.10 requires quote hit-rate in the dashboard but §4.5 defines no
 * endpoint for it. Tracked as a spec change proposal; the path is stable and
 * operator-authed like /v1/inventory. Never silently diverge further.
 */
import type { Order, OrderState } from "@bifrost/sdk";

export const ENDPOINTS = {
  orders: "/v1/orders",
  orderById: (id: string) => `/v1/orders/${id}`,
  cancelOrder: (id: string) => `/v1/orders/${id}/cancel`,
  inventory: "/v1/inventory",
  health: "/v1/health",
  quoteStats: "/v1/quotes/stats", // PROPOSED addition, see header
  stream: "/v1/stream",
} as const;

export interface OrdersPage {
  orders: Order[];
  cursor: string | null;
}

/** per-asset, per-side availability (§4.10 inventory panel) */
export interface InventoryAsset {
  asset: { network: "fiber" | "lightning"; unit: string };
  /** base-10 integer strings — amounts are never JSON numbers */
  available: string;
  inFlight: string;
}
export interface InventorySnapshot {
  assets: InventoryAsset[];
  updatedAt: number;
}

export interface HealthReport {
  fnn: { connected: boolean; nodeId: string; version: string };
  lnd: { connected: boolean; nodeId: string; version: string };
  feed: { fresh: boolean; ageMs: number };
  expiryGuard: {
    minSafetyDeltaMs: number;
    maxIncomingHoldMs: number;
    /** rejected-order log (most recent first) */
    rejections: Array<{ orderId: string; at: number; code: string; hint: string }>;
  };
}

export interface QuoteStats {
  issued: number;
  accepted: number;
  expired: number;
  rejected: number;
  /** integer basis points, computed with integer math: accepted*10000/issued */
  hitRateBps: number;
  windowMs: number;
}

export type StreamMessage =
  | { type: "order"; data: Order }
  | { type: "quote_expired"; quoteId: string };

/* ---------- runtime shape validators (used by the contract test) ---------- */

const ORDER_STATES: OrderState[] = [
  "PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED", "REFUNDING", "FAILED",
];
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

function fail(path: string, msg: string): never {
  throw new Error(`contract violation at ${path}: ${msg}`);
}

export function assertOrder(o: Order, path = "order"): void {
  if (o.protocol !== "bifrost/0.1") fail(path, "bad protocol");
  if (typeof o.orderId !== "string" || o.orderId.length === 0) fail(path, "orderId");
  if (!ORDER_STATES.includes(o.state)) fail(path, `unknown state ${o.state}`);
  for (const leg of [o.incoming, o.outgoing]) {
    if (leg.network !== "fiber" && leg.network !== "lightning") fail(path, "leg.network");
    if (!AMOUNT_RE.test(leg.amount)) fail(path, "leg.amount must be integer string");
    if (typeof leg.tlcExpiryAt !== "number") fail(path, "leg.tlcExpiryAt");
  }
  if (!/^0x[0-9a-f]{64}$/.test(o.paymentHash)) fail(path, "paymentHash");
  if (o.state === "SUCCEEDED" && !o.incoming.preimage) fail(path, "SUCCEEDED order without incoming preimage");
}

export function assertOrdersPage(p: OrdersPage): void {
  if (!Array.isArray(p.orders)) fail("ordersPage", "orders not an array");
  p.orders.forEach((o, i) => assertOrder(o, `orders[${i}]`));
  if (p.cursor !== null && typeof p.cursor !== "string") fail("ordersPage", "cursor");
}

export function assertInventory(s: InventorySnapshot): void {
  if (!Array.isArray(s.assets) || s.assets.length === 0) fail("inventory", "assets");
  for (const a of s.assets) {
    if (!AMOUNT_RE.test(a.available) || !AMOUNT_RE.test(a.inFlight)) {
      fail("inventory", "amounts must be base-10 integer strings, never JSON numbers");
    }
  }
  if (typeof s.updatedAt !== "number") fail("inventory", "updatedAt");
}

export function assertHealth(h: HealthReport): void {
  for (const node of [h.fnn, h.lnd]) {
    if (typeof node?.connected !== "boolean" || typeof node.nodeId !== "string") fail("health", "node block");
  }
  if (typeof h.feed?.fresh !== "boolean" || typeof h.feed.ageMs !== "number") fail("health", "feed");
  const g = h.expiryGuard;
  if (typeof g?.minSafetyDeltaMs !== "number" || typeof g.maxIncomingHoldMs !== "number") fail("health", "guard deltas");
  if (!Array.isArray(g.rejections)) fail("health", "guard rejections");
}

export function assertQuoteStats(q: QuoteStats): void {
  for (const k of ["issued", "accepted", "expired", "rejected", "hitRateBps", "windowMs"] as const) {
    if (!Number.isInteger(q[k]) || q[k] < 0) fail("quoteStats", `${k} must be a non-negative integer`);
  }
  if (q.accepted > q.issued) fail("quoteStats", "accepted exceeds issued");
  if (q.issued > 0 && q.hitRateBps !== Math.floor((q.accepted * 10_000) / q.issued)) {
    fail("quoteStats", "hitRateBps must equal floor(accepted*10000/issued)");
  }
}

export function assertStreamMessage(m: StreamMessage): void {
  if (m.type === "order") assertOrder(m.data, "stream.order");
  else if (m.type === "quote_expired") {
    if (typeof m.quoteId !== "string") fail("stream", "quote_expired.quoteId");
  } else fail("stream", `unknown type ${(m as { type: string }).type}`);
}
