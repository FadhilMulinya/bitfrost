/** The Bifrost client facade. Registry discovery → verified quotes → orders → streaming. */
import { BifrostError } from "./errors.js";
import { detectInvoice } from "./invoice.js";
import type {
  Advertisement,
  Order,
  OrderCreate,
  Pair,
  ProtocolError,
  Quote,
  QuoteRequest,
  StreamEvent,
} from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";
import { verifyAdvertisement, verifyQuote } from "./verify.js";

export interface BifrostOptions {
  registryUrl?: string;
  apiKey?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

interface HubQuote {
  hub: Advertisement;
  quote: Quote;
}

export class Bifrost {
  private readonly registryUrl: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(opts: BifrostOptions = {}) {
    this.registryUrl = opts.registryUrl;
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.now = opts.now ?? Date.now;
  }

  /* ---------- Discovery ---------- */

  async discover(pair: Pair, amount: bigint): Promise<Advertisement[]> {
    if (!this.registryUrl) {
      throw new BifrostError("INTERNAL", "no registryUrl configured", false);
    }
    const q = new URLSearchParams({
      giveNetwork: pair.give.network,
      giveUnit: pair.give.unit,
      getNetwork: pair.get.network,
      getUnit: pair.get.unit,
      amount: amount.toString(),
    });
    const res = await this.fetchImpl(`${this.registryUrl}/ads?${q}`);
    const ads = (await this.json<Advertisement[]>(res)) ?? [];
    const fresh: Advertisement[] = [];
    for (const ad of ads) {
      try {
        verifyAdvertisement(ad, this.now());
        fresh.push(ad);
      } catch {
        /* drop unverifiable ads silently — registry is untrusted */
      }
    }
    return fresh;
  }

  /* ---------- Quotes ---------- */

  async getQuote(
    hubApi: string,
    request: QuoteRequest,
    opts: { invoiceAmount?: bigint | undefined } = {},
  ): Promise<Quote> {
    const res = await this.fetchImpl(`${hubApi}/quotes`, {
      method: "POST",
      headers: this.headers(hubApi),
      body: JSON.stringify(request),
    });
    const quote = await this.json<Quote>(res);
    verifyQuote(quote, request, { now: this.now(), invoiceAmount: opts.invoiceAmount });
    return quote;
  }

  async getQuotes(hubs: Advertisement[], request: QuoteRequest): Promise<HubQuote[]> {
    const settled = await Promise.allSettled(
      hubs.map(async (hub) => ({ hub, quote: await this.getQuote(hub.endpoints.api, request) })),
    );
    return settled
      .filter((s): s is PromiseFulfilledResult<HubQuote> => s.status === "fulfilled")
      .map((s) => s.value);
  }

  /** Best = max getAmount for fixed give, or min giveAmount for fixed get. */
  static bestQuote(quotes: HubQuote[], fixedSide: "give" | "get"): HubQuote {
    if (quotes.length === 0) {
      throw new BifrostError("PRICING_UNAVAILABLE", "no valid quotes received", true);
    }
    const sorted = [...quotes].sort((a, b) => {
      const ka = fixedSide === "give" ? BigInt(a.quote.getAmount) : -BigInt(a.quote.giveAmount);
      const kb = fixedSide === "give" ? BigInt(b.quote.getAmount) : -BigInt(b.quote.giveAmount);
      return ka === kb ? 0 : ka > kb ? -1 : 1;
    });
    return sorted[0]!;
  }

  /* ---------- Orders ---------- */

  async createOrder(hubApi: string, create: OrderCreate): Promise<Order> {
    const res = await this.fetchImpl(`${hubApi}/orders`, {
      method: "POST",
      headers: this.headers(hubApi),
      body: JSON.stringify(create),
    });
    return this.json<Order>(res);
  }

  /**
   * Convenience: detect invoice type, get a quote from the hub, create the
   * order, and return it with the incoming invoice the caller must pay.
   */
  async payAnyInvoice(
    hubApi: string,
    invoice: string,
    give: Pair["give"],
  ): Promise<{ order: Order; quote: Quote }> {
    const info = detectInvoice(invoice);
    // §9 item 3 requires quote.getAmount === invoice amount. A sub-sat (msat-
    // precision) invoice has no sat-exact amount, which would silently skip
    // that check and let the hub quote arbitrary amounts — reject instead.
    if (info.amountMsat !== undefined && info.amount === undefined) {
      throw new BifrostError(
        "INVOICE_INVALID",
        `invoice amount ${info.amountMsat} msat is not sat-exact; PAY_INVOICE requires a whole-sat amount`,
        false,
      );
    }
    const get: Pair["get"] =
      info.network === "lightning"
        ? { network: "lightning", unit: "sat" }
        : { network: "fiber", unit: "shannon" };
    const request: QuoteRequest = {
      protocol: PROTOCOL_VERSION,
      pair: { give, get },
      // amount from the decoded invoice when it carries one; "0" lets the hub
      // derive it from the invoice per PROTOCOL §4.1
      amount: { side: "get", value: info.amount?.toString() ?? "0" },
      mode: "PAY_INVOICE",
      targetInvoice: info.raw,
    };
    // §9 item 3: for PAY_INVOICE the quote's getAmount must equal the invoice amount
    const quote = await this.getQuote(hubApi, request, { invoiceAmount: info.amount });
    const order = await this.createOrder(hubApi, {
      protocol: PROTOCOL_VERSION,
      quoteId: quote.quoteId,
    });
    return { order, quote };
  }

  /* ---------- Streaming ---------- */

  /** At-least-once WS stream, deduped on orderId+updatedAt. Ends on terminal state. */
  async *watchOrder(hubApi: string, orderId: string): AsyncGenerator<Order> {
    const wsUrl = hubApi.replace(/^http/, "ws") + "/stream";
    const WsCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
    if (!WsCtor) {
      throw new BifrostError("INTERNAL", "WebSocket not available in this runtime", false,
        "on Node <22 pass a ws polyfill or poll GET /orders/:id");
    }
    const ws = new WsCtor(wsUrl);
    const queue: Order[] = [];
    let done = false;
    let notify: (() => void) | null = null;
    const seen = new Set<string>();

    ws.onmessage = (ev: MessageEvent) => {
      try {
        const event = JSON.parse(String(ev.data)) as StreamEvent;
        if (event.type !== "order" || event.data.orderId !== orderId) return;
        const key = `${event.data.orderId}:${event.data.updatedAt}:${event.data.state}`;
        if (seen.has(key)) return;
        seen.add(key);
        queue.push(event.data);
        notify?.();
      } catch {
        /* ignore malformed frames */
      }
    };
    ws.onclose = () => { done = true; notify?.(); };
    ws.onerror = () => { done = true; notify?.(); };

    try {
      while (true) {
        while (queue.length > 0) {
          const order = queue.shift()!;
          yield order;
          if (order.state === "SUCCEEDED" || order.state === "FAILED") return;
        }
        if (done) return;
        await new Promise<void>((r) => { notify = r; });
        notify = null;
      }
    } finally {
      try { ws.close(); } catch { /* already closed */ }
    }
  }

  /* ---------- internals ---------- */

  private headers(hubApi: string): Record<string, string> {
    const h: Record<string, string> = { "content-type": "application/json" };
    if (this.apiKey) h["authorization"] = `Bearer ${this.apiKey}`;
    // ngrok free-tier tunnels show an HTML interstitial to browser-like
    // requests unless this header is present; harmless to send elsewhere.
    if (hubApi.includes("ngrok-free.app")) h["ngrok-skip-browser-warning"] = "true";
    return h;
  }

  private async json<T>(res: Response): Promise<T> {
    const body = (await res.json().catch(() => null)) as
      | (T & { error?: ProtocolError })
      | { error: ProtocolError }
      | null;
    if (!res.ok) {
      const err = body && "error" in body && body.error
        ? BifrostError.fromWire(body.error)
        : new BifrostError("INTERNAL", `HTTP ${res.status}`, res.status >= 500);
      throw err;
    }
    if (body === null) throw new BifrostError("INTERNAL", "empty response body", true);
    return body as T;
  }
}
