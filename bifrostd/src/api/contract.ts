/**
 * THE API CONTRACT (SYSTEM-DESIGN §4.5). Endpoint paths and response shapes
 * for the order/inventory/health/quote-stats/stream surface are kept in
 * MANUAL SYNC with dashboard/mock/contract.ts, which remains the single
 * source of truth (dashboard/test/contract.test.ts asserts against it and,
 * per its own header comment, is meant to retarget BIFROSTD_URL at this
 * server). bifrostd does not depend on the dashboard package, so the shapes
 * are duplicated here rather than imported — do not let the two drift; if
 * you change one, change both.
 *
 * quotes/orders (POST /v1/quotes, POST /v1/orders) are NOT in the dashboard
 * mock (the dashboard never issues quotes) — their shapes instead follow
 * sdk/src/client.ts's actual fetch/parse calls, which are the tested,
 * load-bearing contract for those two routes.
 */
import type { Order, OrderState } from "bifrost-sdk";

export const ENDPOINTS = {
  quotes: "/v1/quotes",
  orders: "/v1/orders",
  orderById: (id: string) => `/v1/orders/${id}`,
  cancelOrder: (id: string) => `/v1/orders/${id}/cancel`,
  inventory: "/v1/inventory",
  health: "/v1/health",
  quoteStats: "/v1/quotes/stats", // PROPOSED §4.5 addition — see dashboard/mock/contract.ts header
  stream: "/v1/stream",
  demoInvoice: "/v1/demo/invoice", // dev-only, see server.ts's handleDemoInvoice
  demoPay: "/v1/demo/pay", // dev-only, see server.ts's handleDemoPay

} as const;

export interface OrdersPage {
  orders: Order[];
  cursor: string | null;
}

export interface InventoryAsset {
  asset: { network: "fiber" | "lightning"; unit: string };
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
    rejections: Array<{ orderId: string; at: number; code: string; hint: string }>;
  };
}

export interface QuoteStats {
  issued: number;
  accepted: number;
  expired: number;
  rejected: number;
  hitRateBps: number;
  windowMs: number;
}

export type StreamMessage =
  | { type: "order"; data: Order }
  | { type: "quote_expired"; quoteId: string };

export const ORDER_STATES: OrderState[] = [
  "PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED", "REFUNDING", "FAILED",
];
