import { BifrostError } from "bifrost-sdk";
import { HUB_URL, NGROK_HEADERS } from "./config.js";

async function post(path, body) {
  const res = await fetch(`${HUB_URL}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...NGROK_HEADERS },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw BifrostError.fromWire(json.error);
  return json;
}

async function get(path) {
  const res = await fetch(`${HUB_URL}${path}`, { headers: { ...NGROK_HEADERS } });
  const json = await res.json();
  if (!res.ok) throw BifrostError.fromWire(json.error);
  return json;
}

/** Builds the QuoteRequest for "customer pays with Fiber to settle a Lightning invoice". */
export function buildQuoteRequest(invoice, amountSat) {
  return {
    protocol: "bifrost/0.1",
    pair: {
      give: { network: "fiber", unit: "shannon" },
      get: { network: "lightning", unit: "sat" },
    },
    amount: { side: "get", value: String(amountSat) },
    mode: "PAY_INVOICE",
    targetInvoice: invoice,
  };
}

export function getQuote(quoteRequest) {
  return post("/v1/quotes", quoteRequest);
}

export function createOrder(quoteId, targetInvoice) {
  return post("/v1/orders", { protocol: "bifrost/0.1", quoteId, targetInvoice });
}

export function getOrder(orderId) {
  return get(`/v1/orders/${orderId}`);
}

/** Dev-only helper endpoint — mints a throwaway regtest invoice from the hub's payee-side node. */
export function getDemoInvoice(amountSat, memo) {
  const params = new URLSearchParams({ amt: String(amountSat), memo });
  return get(`/v1/demo/invoice?${params.toString()}`);
}

/** Dev-only helper endpoint — simulates a customer's Fiber wallet paying the hold invoice. */
export function simulatePayment(fiberInvoice) {
  return post("/v1/demo/pay", { fiberInvoice });
}

export function getHealth() {
  return get("/v1/health");
}

export function getRecentPayments(limit = 5) {
  const params = new URLSearchParams({ state: "SUCCEEDED", limit: String(limit) });
  return get(`/v1/orders?${params.toString()}`);
}
