/**
 * API CONTRACT TEST. Today it runs against mock/server.ts; when bifrostd's
 * api/ module lands, set BIFROSTD_URL to point this same suite at the real
 * daemon — the assertions in mock/contract.ts are the contract.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import {
  ENDPOINTS,
  assertHealth,
  assertInventory,
  assertOrder,
  assertOrdersPage,
  assertQuoteStats,
  assertStreamMessage,
  type OrdersPage,
  type StreamMessage,
} from "../mock/contract.ts";
import { startMockBifrostd } from "../mock/server.ts";

const external = process.env["BIFROSTD_URL"];
let base: string;
let mock: Awaited<ReturnType<typeof startMockBifrostd>> | undefined;

beforeAll(() => {
  if (external) {
    base = external;
  } else {
    mock = startMockBifrostd({ port: 8395, tickMs: 0, seedOrders: 3 }); // manual ticking
    base = "http://127.0.0.1:8395";
  }
});
afterAll(async () => mock?.close());

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`);
  expect(res.headers.get("content-type")).toContain("application/json");
  return { status: res.status, body: await res.json() };
};

describe("§4.5 contract", () => {
  it("GET /v1/orders returns a valid page; every order passes shape assertions", async () => {
    const { status, body } = await get(ENDPOINTS.orders);
    expect(status).toBe(200);
    assertOrdersPage(body as OrdersPage);
    expect((body as OrdersPage).orders.length).toBeGreaterThan(0);
  });

  it("GET /v1/orders?state= filters by state", async () => {
    const { body } = await get(`${ENDPOINTS.orders}?state=PENDING`);
    for (const o of (body as OrdersPage).orders) expect(o.state).toBe("PENDING");
  });

  it("GET /v1/orders/:id round-trips; unknown id yields the §7 error envelope", async () => {
    const page = (await get(ENDPOINTS.orders)).body as OrdersPage;
    const id = page.orders[0]!.orderId;
    const one = await get(ENDPOINTS.orderById(id));
    expect(one.status).toBe(200);
    assertOrder(one.body as never);
    const missing = await get(ENDPOINTS.orderById("01NOPE"));
    expect(missing.status).toBe(404);
    expect((missing.body as { error: { code: string; retryable: boolean } }).error).toMatchObject({
      code: expect.any(String),
      retryable: expect.any(Boolean),
    });
  });

  it("GET /v1/inventory: amounts are integer STRINGS (never JSON numbers)", async () => {
    const { status, body } = await get(ENDPOINTS.inventory);
    expect(status).toBe(200);
    assertInventory(body as never);
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/"available":\s*\d/); // would indicate a bare number
  });

  it("GET /v1/health: node connectivity, feed freshness, ExpiryGuard block", async () => {
    const { status, body } = await get(ENDPOINTS.health);
    expect(status).toBe(200);
    assertHealth(body as never);
  });

  it("GET /v1/quotes/stats: integer-math hit rate (PROPOSED §4.5 addition)", async () => {
    const { status, body } = await get(ENDPOINTS.quoteStats);
    expect(status).toBe(200);
    assertQuoteStats(body as never);
  });

  it("POST /v1/orders/:id/cancel only from PENDING/INCOMING_HELD; 409 otherwise", async () => {
    if (!mock) return; // state manipulation only possible against the mock
    const page = (await get(ENDPOINTS.orders)).body as OrdersPage;
    const pending = page.orders.find((o) => o.state === "PENDING")!;
    const res = await fetch(`${base}${ENDPOINTS.cancelOrder(pending.orderId)}`, { method: "POST" });
    expect(res.status).toBe(200);
    const cancelled = (await res.json()) as { state: string };
    expect(cancelled.state).toBe("FAILED");
    const again = await fetch(`${base}${ENDPOINTS.cancelOrder(pending.orderId)}`, { method: "POST" });
    expect(again.status).toBe(409);
  });

  it("WS /v1/stream: replays current orders, pushes valid transitions, dedupe-able", async () => {
    const ws = new WebSocket(`${base.replace("http", "ws")}${ENDPOINTS.stream}`);
    const messages: StreamMessage[] = [];
    await new Promise<void>((resolve, reject) => {
      ws.on("open", () => {
        // drive transitions deterministically when running against the mock
        if (mock) setTimeout(() => { mock!.tick(); mock!.tick(); }, 50);
        setTimeout(resolve, 500);
      });
      ws.on("message", (d) => messages.push(JSON.parse(String(d)) as StreamMessage));
      ws.on("error", reject);
    });
    ws.close();
    expect(messages.length).toBeGreaterThan(0);
    for (const m of messages) assertStreamMessage(m);
    const orderMsgs = messages.filter((m) => m.type === "order");
    expect(orderMsgs.length).toBeGreaterThan(0);
  });

  it("state machine sanity on the stream: SUCCEEDED orders carry the incoming preimage (I1)", async () => {
    if (!mock) return;
    for (let i = 0; i < 30; i++) mock.tick(); // run several orders to completion
    const page = (await get(ENDPOINTS.orders)).body as OrdersPage;
    const succeeded = page.orders.filter((o) => o.state === "SUCCEEDED");
    expect(succeeded.length).toBeGreaterThan(0);
    for (const o of succeeded) {
      expect(o.incoming.preimage).toBeDefined();
      expect(o.incoming.preimage).toBe(o.outgoing.preimage); // same key crossed the bridge
    }
  });
});
