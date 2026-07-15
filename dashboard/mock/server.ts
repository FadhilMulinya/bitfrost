/**
 * Mock bifrostd (§4.5 subset in mock/contract.ts). Simulates an order book
 * whose orders walk the real state machine (SYSTEM-DESIGN §4.2), pushes every
 * transition over WS /v1/stream, and keeps inventory/quote-stats/health
 * coherent with the simulated flow. Localhost only.
 *
 * Run: npm run mock   (MOCK_PORT, default 8391)
 */
import { createServer, type ServerResponse } from "node:http";
import { createHash, randomBytes } from "node:crypto";
import { WebSocketServer, WebSocket } from "ws";
import type { Order, OrderState } from "bifrost-sdk";
import {
  ENDPOINTS,
  type HealthReport,
  type InventorySnapshot,
  type OrdersPage,
  type QuoteStats,
  type StreamMessage,
} from "./contract.ts";

const HAPPY_PATH: OrderState[] = ["PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED"];
const SAD_PATH: OrderState[] = ["PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "REFUNDING", "FAILED"];

export interface MockOptions {
  port?: number;
  /** ms between simulated state transitions */
  tickMs?: number;
  /** spawn a new order every N ticks (0 = never; drive manually) */
  spawnEveryTicks?: number;
  /** fraction of orders that fail, in percent (integer) */
  failPct?: number;
  seedOrders?: number;
}

export function startMockBifrostd(opts: MockOptions = {}) {
  const tickMs = opts.tickMs ?? 1500;
  const failPct = opts.failPct ?? 20;
  const spawnEvery = opts.spawnEveryTicks ?? 3;

  const orders = new Map<string, { order: Order; path: OrderState[]; step: number }>();
  const stats: QuoteStats = { issued: 0, accepted: 0, expired: 0, rejected: 0, hitRateBps: 0, windowMs: 3_600_000 };
  const rejections: HealthReport["expiryGuard"]["rejections"] = [];
  let inFlightFiber = 0n;
  let inFlightLn = 0n;
  const sockets = new Set<WebSocket>();
  let seq = 0;

  function push(msg: StreamMessage): void {
    const body = JSON.stringify(msg);
    for (const ws of sockets) if (ws.readyState === WebSocket.OPEN) ws.send(body);
  }

  function newOrder(): Order {
    const preimage = randomBytes(32);
    const paymentHash = `0x${createHash("sha256").update(preimage).digest("hex")}`;
    const now = Date.now();
    const fiberToLn = seq % 2 === 0;
    const amountGet = BigInt(25_000 + (seq * 7919) % 400_000);
    const amountGive = amountGet * 260_000n; // demo shannon/sat scale
    const id = `01MOCK${String(seq++).padStart(6, "0")}${randomBytes(4).toString("hex").toUpperCase()}`;
    const incoming = {
      network: fiberToLn ? ("fiber" as const) : ("lightning" as const),
      invoice: fiberToLn ? "fibd13000000000mock…" : "lnbcrt250u1mock…",
      amount: (fiberToLn ? amountGive : amountGet).toString(),
      tlcExpiryAt: now + 21_600_000,
      status: "WAITING" as const,
    };
    const outgoing = {
      network: fiberToLn ? ("lightning" as const) : ("fiber" as const),
      invoice: fiberToLn ? "lnbcrt250u1mock…" : "fibd13000000000mock…",
      amount: (fiberToLn ? amountGet : amountGive).toString(),
      tlcExpiryAt: now + 7_200_000,
      status: "WAITING" as const,
    };
    return {
      protocol: "bifrost/0.1",
      orderId: id,
      quoteId: `01QUOTE${String(seq).padStart(5, "0")}`,
      direction: fiberToLn ? "FIBER_TO_LN" : "LN_TO_FIBER",
      paymentHash,
      state: "PENDING",
      incoming,
      outgoing,
      failure: null,
      createdAt: now,
      updatedAt: now,
    };
  }

  const preimages = new Map<string, string>();

  function spawn(): Order {
    const order = newOrder();
    preimages.set(order.orderId, `0x${randomBytes(32).toString("hex")}`);
    // quote accounting: every order came from an accepted quote; some quotes never convert
    stats.issued += 1 + (seq % 3 === 0 ? 1 : 0); // occasionally an extra unconverted quote
    stats.accepted += 1;
    if (seq % 3 === 0) stats.expired += 1;
    stats.hitRateBps = stats.issued > 0 ? Math.floor((stats.accepted * 10_000) / stats.issued) : 0;
    const failing = (seq * 37) % 100 < failPct;
    orders.set(order.orderId, { order, path: failing ? SAD_PATH : HAPPY_PATH, step: 0 });
    push({ type: "order", data: order });
    return order;
  }

  function applyState(o: Order, state: OrderState): void {
    o.state = state;
    o.updatedAt = Date.now();
    const pre = preimages.get(o.orderId)!;
    switch (state) {
      case "INCOMING_HELD":
        o.incoming.status = "HELD";
        break;
      case "OUTGOING_IN_FLIGHT":
        o.outgoing.status = "IN_FLIGHT";
        if (o.outgoing.network === "fiber") inFlightFiber += BigInt(o.outgoing.amount);
        else inFlightLn += BigInt(o.outgoing.amount);
        break;
      case "OUTGOING_SETTLED":
        o.outgoing.status = "SETTLED";
        o.outgoing.preimage = pre;
        break;
      case "SUCCEEDED":
        o.incoming.status = "SETTLED";
        o.incoming.preimage = pre; // I1: incoming settles only with the learned preimage
        break;
      case "REFUNDING":
        o.outgoing.status = "FAILED";
        o.failure = { code: "NO_ROUTE", message: "no route to destination", hint: "destination may lack inbound capacity; try a smaller amount", retryable: true };
        break;
      case "FAILED":
        o.incoming.status = "CANCELLED";
        break;
      case "PENDING":
        break;
    }
    if (state === "OUTGOING_SETTLED" || state === "REFUNDING") {
      if (o.outgoing.network === "fiber") inFlightFiber -= BigInt(o.outgoing.amount);
      else inFlightLn -= BigInt(o.outgoing.amount);
    }
  }

  function tick(): void {
    for (const rec of orders.values()) {
      if (rec.step < rec.path.length - 1) {
        rec.step += 1;
        applyState(rec.order, rec.path[rec.step]!);
        push({ type: "order", data: rec.order });
        break; // one transition per tick keeps the theater legible
      }
    }
    if (spawnEvery > 0 && tickCount % spawnEvery === 0) spawn();
    if (tickCount % 7 === 0) push({ type: "quote_expired", quoteId: `01QUOTE${String(seq).padStart(5, "0")}` });
    if (tickCount % 11 === 0) {
      const id = `01MOCK${String(seq).padStart(6, "0")}R`;
      rejections.unshift({ orderId: id, at: Date.now(), code: "EXPIRY_INVARIANT_VIOLATION", hint: "incoming expiry too close to outgoing CLTV; ask payer for a longer invoice expiry" });
      rejections.splice(20);
    }
    tickCount += 1;
  }
  let tickCount = 1;

  function json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(body));
  }

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const { pathname } = url;

    if (req.method === "GET" && pathname === ENDPOINTS.orders) {
      const state = url.searchParams.get("state");
      let list = [...orders.values()].map((r) => r.order).sort((a, b) => b.createdAt - a.createdAt);
      if (state) list = list.filter((o) => o.state === state);
      const page: OrdersPage = { orders: list.slice(0, 50), cursor: list.length > 50 ? "mock-cursor-1" : null };
      return json(res, 200, page);
    }
    const orderMatch = pathname.match(/^\/v1\/orders\/([^/]+)$/);
    if (req.method === "GET" && orderMatch) {
      const rec = orders.get(orderMatch[1]!);
      return rec
        ? json(res, 200, rec.order)
        : json(res, 404, { error: { code: "INTERNAL", message: "order not found", retryable: false } });
    }
    const cancelMatch = pathname.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
    if (req.method === "POST" && cancelMatch) {
      const rec = orders.get(cancelMatch[1]!);
      if (!rec) return json(res, 404, { error: { code: "INTERNAL", message: "order not found", retryable: false } });
      if (rec.order.state !== "PENDING" && rec.order.state !== "INCOMING_HELD") {
        return json(res, 409, { error: { code: "INTERNAL", message: `cannot cancel in state ${rec.order.state}`, retryable: false } });
      }
      rec.path = ["PENDING", "FAILED"];
      rec.step = 0;
      applyState(rec.order, "FAILED");
      push({ type: "order", data: rec.order });
      return json(res, 200, rec.order);
    }
    if (req.method === "GET" && pathname === ENDPOINTS.inventory) {
      const snap: InventorySnapshot = {
        assets: [
          { asset: { network: "fiber", unit: "shannon" }, available: (500_000_000_000n - inFlightFiber).toString(), inFlight: inFlightFiber.toString() },
          { asset: { network: "lightning", unit: "sat" }, available: (2_500_000n - inFlightLn).toString(), inFlight: inFlightLn.toString() },
        ],
        updatedAt: Date.now(),
      };
      return json(res, 200, snap);
    }
    if (req.method === "GET" && pathname === ENDPOINTS.health) {
      const health: HealthReport = {
        fnn: { connected: true, nodeId: "03032b9994…21187", version: "0.9.0-rc7" },
        lnd: { connected: true, nodeId: "03e347d089…7e21c", version: "0.19.2-beta" },
        feed: { fresh: tickCount % 13 !== 0, ageMs: (tickCount % 13) * 900 },
        expiryGuard: { minSafetyDeltaMs: 7_200_000, maxIncomingHoldMs: 21_600_000, rejections },
      };
      return json(res, 200, health);
    }
    if (req.method === "GET" && pathname === ENDPOINTS.quoteStats) {
      return json(res, 200, stats);
    }
    json(res, 404, { error: { code: "INTERNAL", message: `no route ${req.method} ${pathname}`, retryable: false } });
  });

  const wss = new WebSocketServer({ server, path: ENDPOINTS.stream });
  wss.on("connection", (ws) => {
    sockets.add(ws);
    for (const rec of orders.values()) ws.send(JSON.stringify({ type: "order", data: rec.order } satisfies StreamMessage));
    ws.on("close", () => sockets.delete(ws));
  });

  for (let i = 0; i < (opts.seedOrders ?? 4); i++) spawn();
  const timer = opts.tickMs === 0 ? undefined : setInterval(tick, tickMs);

  const port = opts.port ?? Number(process.env["MOCK_PORT"] ?? 8391);
  server.listen(port, "127.0.0.1");

  return {
    port,
    tick, // manual stepping for tests
    spawn,
    async close() {
      if (timer) clearInterval(timer);
      for (const ws of sockets) ws.terminate();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}

// CLI entry
if (import.meta.url === `file://${process.argv[1]}`) {
  const { port } = startMockBifrostd();
  console.log(`mock bifrostd listening on http://127.0.0.1:${port} (WS ${ENDPOINTS.stream})`);
}
