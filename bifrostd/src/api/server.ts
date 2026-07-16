/**
 * bifrostd api/ — SYSTEM-DESIGN §4.5 gateway, backed by the REAL OrderEngine
 * + adapters (not a simulation). Implements the subset the dashboard
 * consumes (api/contract.ts, kept in sync with dashboard/mock/contract.ts)
 * plus POST /v1/quotes and POST /v1/orders, which are what
 * sdk/src/client.ts's Bifrost.payAnyInvoice actually calls.
 *
 * v0.1 scope, documented honestly (docs/STATUS.md) rather than silently
 * faked:
 *  - No API-key auth, no per-key rate limits, no operator-key gate on
 *    /v1/inventory (PROTOCOL/SYSTEM-DESIGN §4.5 calls for both) — single
 *    trusted operator, localhost-bound, matches every other service in this
 *    compose stack (never expose unauthenticated RPC beyond localhost).
 *  - No webhooks (events/ §4.6 not started).
 *  - Quote issuance is in-memory (QuoteCache) — lost on restart; a
 *    short-lived (seconds) window, not silently ignored (see quotes.ts).
 *  - Only QuoteMode "PAY_INVOICE" is implemented; "RECEIVE" returns a clear
 *    INTERNAL error rather than pretending to support it.
 *  - price feed is not wired (staticPeg strategy only) — GET /v1/health
 *    always reports feed.fresh=true, ageMs=0; documented, not invented data.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { WebSocketServer } from "ws";
import {
  BifrostError,
  detectInvoice,
  PROTOCOL_VERSION,
  type OrderCreate,
  type ProtocolError,
  type QuoteRequest,
} from "bifrost-sdk";
import type { FiberAdapter } from "../adapters/fiber.js";
import type { LightningAdapter } from "../adapters/lightning.js";
import type { OrderEngine } from "../orders/engine.js";
import type { OrderStore } from "../orders/store.js";
import type { QuoteService } from "../rfq/quote-service.js";
import { ENDPOINTS, ORDER_STATES, type HealthReport, type InventorySnapshot, type OrdersPage, type QuoteStats, type StreamMessage } from "./contract.js";
import type { SwapCoordinator } from "./coordinator.js";
import { fiberLiquidity, lightningLiquidity } from "./inventory.js";
import { planLegs } from "./legs.js";
import { QuoteCache } from "./quotes.js";
import type { StreamHub } from "./stream.js";

const PAGE_SIZE = 50;

export interface ApiServerOptions {
  port: number;
  host?: string;
  engine: OrderEngine;
  store: OrderStore;
  coordinator: SwapCoordinator;
  quoteService: QuoteService;
  fnnHub: FiberAdapter;
  lndHub: LightningAdapter;
  stream: StreamHub;
  minSafetyDeltaMs: number;
  maxIncomingHoldMs: number;
  log: (msg: string) => void;
}

export function startApiServer(opts: ApiServerOptions) {
  const quoteCache = new QuoteCache(3_600_000, (quoteId) => opts.stream.broadcast({ type: "quote_expired", quoteId }));

  function json(res: ServerResponse, code: number, body: unknown): void {
    res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
    res.end(JSON.stringify(body));
  }

  function errorEnvelope(res: ServerResponse, httpCode: number, err: ProtocolError): void {
    json(res, httpCode, { error: err });
  }

  function httpCodeFor(code: string): number {
    switch (code) {
      case "QUOTE_UNKNOWN":
      case "INTERNAL":
        return 404;
      case "QUOTE_EXPIRED":
        return 410;
      case "PAIR_UNSUPPORTED":
      case "AMOUNT_OUT_OF_BOUNDS":
      case "INVOICE_INVALID":
      case "INVOICE_MISMATCH":
      case "HASH_ALGO_UNSUPPORTED":
      case "EXPIRY_INVARIANT_VIOLATION":
        return 400;
      case "INVENTORY_INSUFFICIENT":
      case "PRICING_UNAVAILABLE":
      case "HUB_OVEREXPOSED":
        return 409;
      case "RATE_LIMITED":
        return 429;
      case "UNAUTHORIZED":
        return 401;
      default:
        return 500;
    }
  }

  async function readBody(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks).toString("utf8");
    return raw.length > 0 ? JSON.parse(raw) : {};
  }

  async function handleQuotes(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: QuoteRequest;
    try {
      body = (await readBody(req)) as QuoteRequest;
    } catch {
      return errorEnvelope(res, 400, { code: "INVOICE_INVALID", message: "malformed JSON body", retryable: false });
    }
    if (body.protocol !== PROTOCOL_VERSION) {
      quoteCache.reject();
      return errorEnvelope(res, 400, { code: "INTERNAL", message: `unsupported protocol ${String(body.protocol)}`, retryable: false });
    }
    const give = body.pair?.give;
    const get = body.pair?.get;
    const supported =
      (give?.network === "fiber" && get?.network === "lightning") ||
      (give?.network === "lightning" && get?.network === "fiber");
    if (!supported) {
      quoteCache.reject();
      return errorEnvelope(res, 400, { code: "PAIR_UNSUPPORTED", message: "only fiber<->lightning is offered", retryable: false });
    }
    try {
      const now = Date.now();
      const [giveLiq, getLiq] = await Promise.all([
        give!.network === "fiber" ? fiberLiquidity(opts.fnnHub) : lightningLiquidity(opts.lndHub),
        get!.network === "fiber" ? fiberLiquidity(opts.fnnHub) : lightningLiquidity(opts.lndHub),
      ]);
      let invoiceAmount: bigint | undefined;
      if (body.mode === "PAY_INVOICE" && body.targetInvoice) {
        try {
          invoiceAmount = detectInvoice(body.targetInvoice).amount;
        } catch {
          quoteCache.reject();
          return errorEnvelope(res, 400, { code: "INVOICE_INVALID", message: "targetInvoice could not be decoded", retryable: false });
        }
      }
      const quote = await opts.quoteService.quote(
        body,
        { inventory: { giveAvailable: giveLiq.available, getAvailable: getLiq.available }, inFlightExposure: 0n, now },
        invoiceAmount !== undefined ? { invoiceAmount } : {},
      );
      quoteCache.issue(quote, body);
      return json(res, 200, quote);
    } catch (e) {
      quoteCache.reject();
      const be = e instanceof BifrostError ? e : new BifrostError("INTERNAL", String(e), false);
      return errorEnvelope(res, httpCodeFor(be.code), { code: be.code, message: be.message, retryable: be.retryable, ...(be.hint ? { hint: be.hint } : {}) });
    }
  }

  async function handleCreateOrder(req: IncomingMessage, res: ServerResponse): Promise<void> {
    let body: OrderCreate;
    try {
      body = (await readBody(req)) as OrderCreate;
    } catch {
      return errorEnvelope(res, 400, { code: "INVOICE_INVALID", message: "malformed JSON body", retryable: false });
    }
    if (body.protocol !== PROTOCOL_VERSION || !body.quoteId) {
      return errorEnvelope(res, 400, { code: "INTERNAL", message: "quoteId required", retryable: false });
    }
    const now = Date.now();
    const cached = quoteCache.consume(body.quoteId, now);
    if (!cached) {
      return errorEnvelope(res, 404, { code: "QUOTE_UNKNOWN", message: `quote ${body.quoteId} unknown or already redeemed`, retryable: false });
    }
    if (cached.request.mode !== "PAY_INVOICE" || !cached.request.targetInvoice) {
      return errorEnvelope(res, 400, { code: "INTERNAL", message: "only PAY_INVOICE quotes can be redeemed today (RECEIVE not yet implemented)", retryable: false });
    }
    try {
      const plan = await planLegs({
        give: cached.request.pair.give,
        get: cached.request.pair.get,
        targetInvoice: cached.request.targetInvoice,
        giveAmount: BigInt(cached.quote.giveAmount),
        getAmount: BigInt(cached.quote.getAmount),
        now,
        minSafetyDeltaMs: opts.minSafetyDeltaMs,
        lndHub: opts.lndHub,
      });
      const order = await opts.engine.createOrder({
        quoteId: cached.quote.quoteId,
        direction: plan.direction,
        paymentHash: plan.paymentHash,
        incoming: plan.incoming,
        outgoing: plan.outgoing,
      });
      opts.coordinator.watchOrder(order);
      opts.stream.onOrderChanged(order);
      return json(res, 200, order);
    } catch (e) {
      const be = e instanceof BifrostError ? e : new BifrostError("INTERNAL", String(e), false);
      return errorEnvelope(res, httpCodeFor(be.code), { code: be.code, message: be.message, retryable: be.retryable, ...(be.hint ? { hint: be.hint } : {}) });
    }
  }

  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? "/", "http://localhost");
      const { pathname } = url;

      if (req.method === "OPTIONS") {
        res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST", "Access-Control-Allow-Headers": "content-type" });
        return res.end();
      }

      if (req.method === "POST" && pathname === ENDPOINTS.quotes) return handleQuotes(req, res);
      if (req.method === "POST" && pathname === ENDPOINTS.orders) return handleCreateOrder(req, res);

      if (req.method === "GET" && pathname === ENDPOINTS.orders) {
        const stateFilter = url.searchParams.get("state");
        let list = opts.store.list();
        if (stateFilter) {
          if (!ORDER_STATES.includes(stateFilter as (typeof ORDER_STATES)[number])) {
            return errorEnvelope(res, 400, { code: "INTERNAL", message: `unknown state ${stateFilter}`, retryable: false });
          }
          list = list.filter((o) => o.state === stateFilter);
        }
        const offset = Number(url.searchParams.get("cursor") ?? "0") || 0;
        const page = list.slice(offset, offset + PAGE_SIZE);
        const nextOffset = offset + PAGE_SIZE;
        const result: OrdersPage = { orders: page, cursor: nextOffset < list.length ? String(nextOffset) : null };
        return json(res, 200, result);
      }

      const orderMatch = pathname.match(/^\/v1\/orders\/([^/]+)$/);
      if (req.method === "GET" && orderMatch) {
        const order = opts.store.get(orderMatch[1]!);
        return order ? json(res, 200, order) : errorEnvelope(res, 404, { code: "INTERNAL", message: "order not found", retryable: false });
      }

      const cancelMatch = pathname.match(/^\/v1\/orders\/([^/]+)\/cancel$/);
      if (req.method === "POST" && cancelMatch) {
        try {
          // engine.cancelOrder is already terminal (FAILED) by the time it
          // resolves; the order's per-hash pumps self-stop the next time
          // they observe an event (e.g. the INCOMING_CANCELLED this triggers)
          // via SwapCoordinator's own TERMINAL check — no separate call needed.
          const order = await opts.engine.cancelOrder(cancelMatch[1]!);
          opts.stream.onOrderChanged(order);
          return json(res, 200, order);
        } catch (e) {
          const be = e instanceof BifrostError ? e : new BifrostError("INTERNAL", String(e), false);
          const httpCode = /unknown order/.test(be.message) ? 404 : 409;
          return errorEnvelope(res, httpCode, { code: be.code, message: be.message, retryable: be.retryable });
        }
      }

      if (req.method === "GET" && pathname === ENDPOINTS.inventory) {
        const [fiberLiq, lnLiq] = await Promise.all([fiberLiquidity(opts.fnnHub), lightningLiquidity(opts.lndHub)]);
        const snap: InventorySnapshot = {
          assets: [
            { asset: { network: "fiber", unit: "shannon" }, available: fiberLiq.available.toString(), inFlight: fiberLiq.inFlight.toString() },
            { asset: { network: "lightning", unit: "sat" }, available: lnLiq.available.toString(), inFlight: lnLiq.inFlight.toString() },
          ],
          updatedAt: Date.now(),
        };
        return json(res, 200, snap);
      }

      if (req.method === "GET" && pathname === ENDPOINTS.health) {
        const [fnnInfo, lndInfo] = await Promise.all([
          opts.fnnHub.nodeInfo().catch(() => undefined),
          opts.lndHub.getInfo().catch(() => undefined),
        ]);
        const health: HealthReport = {
          fnn: { connected: fnnInfo !== undefined, nodeId: fnnInfo?.nodeId ?? "", version: fnnInfo?.version ?? "" },
          lnd: { connected: lndInfo !== undefined, nodeId: lndInfo?.nodeId ?? "", version: lndInfo?.version ?? "" },
          // no external price feed wired (staticPeg strategy, v0.1) — documented, not invented
          feed: { fresh: true, ageMs: 0 },
          expiryGuard: { minSafetyDeltaMs: opts.minSafetyDeltaMs, maxIncomingHoldMs: opts.maxIncomingHoldMs, rejections: [...opts.stream.rejections] },
        };
        return json(res, 200, health);
      }

      if (req.method === "GET" && pathname === ENDPOINTS.quoteStats) {
        const stats: QuoteStats = quoteCache.snapshot(Date.now());
        return json(res, 200, stats);
      }

      errorEnvelope(res, 404, { code: "INTERNAL", message: `no route ${req.method} ${pathname}`, retryable: false });
    })().catch((e) => {
      opts.log(`unhandled request error: ${String(e)}`);
      if (!res.headersSent) errorEnvelope(res, 500, { code: "INTERNAL", message: "internal error", retryable: true });
    });
  });

  const wss = new WebSocketServer({ server, path: ENDPOINTS.stream });
  wss.on("connection", (ws) => {
    opts.stream.add(ws);
    for (const order of opts.store.list()) ws.send(JSON.stringify({ type: "order", data: order } satisfies StreamMessage));
    ws.on("close", () => opts.stream.remove(ws));
  });

  // periodic sweep so quote_expired pushes fire promptly, not only when a
  // client happens to hit /v1/quotes/stats
  const sweepTimer = setInterval(() => quoteCache.snapshot(Date.now()), 5_000);

  server.listen(opts.port, opts.host ?? "127.0.0.1");

  return {
    port: opts.port,
    quoteCache,
    async close() {
      clearInterval(sweepTimer);
      opts.stream.closeAll();
      wss.close();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
