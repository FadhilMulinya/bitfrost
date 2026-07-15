/**
 * Transport layer, dependency-injected so unit tests run against recorded
 * fixtures and contract tests can route through `docker compose exec`.
 *
 * FNN: JSON-RPC 2.0 over HTTP POST (jsonrpsee), Biscuit bearer token.
 * Subscriptions (`subscribe_store_changes`) require the WS endpoint; the
 * HTTP transport refuses them with a typed error rather than faking.
 *
 * LND: REST proxy of the gRPC services (invoicesrpc/routerrpc map 1:1 to
 * /v2/invoices/* and /v2/router/*). See RPC-NOTES "Adapter divergence log".
 */
import { AdapterError } from "./types.js";

/* ---------- FNN JSON-RPC ---------- */

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface FnnTransport {
  call<T>(method: string, params: unknown): Promise<T>;
  /** WS subscription; yields notification payloads until closed. */
  subscribe?(method: string, params: unknown, unsubscribeMethod: string): AsyncIterable<unknown>;
}

export interface HttpJsonRpcOptions {
  url: string; // e.g. http://127.0.0.1:21716
  /** Biscuit bearer token, scoped to the needed modules only (§4.1 note 1). */
  token?: string;
  fetchImpl?: typeof fetch;
}

export class HttpJsonRpc implements FnnTransport {
  private nextId = 1;
  constructor(private readonly opts: HttpJsonRpcOptions) {}

  async call<T>(method: string, params: unknown): Promise<T> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.token) headers["Authorization"] = `Bearer ${this.opts.token}`;
    const res = await fetchImpl(this.opts.url, {
      method: "POST",
      headers,
      body: JSON.stringify({ id: this.nextId++, jsonrpc: "2.0", method, params: [params] }),
    });
    if (!res.ok) {
      throw new AdapterError("fiber", method, `HTTP ${res.status}`, res.status >= 500);
    }
    const body = (await res.json()) as { result?: T; error?: JsonRpcError };
    if (body.error) {
      throw new AdapterError("fiber", method, `RPC error ${body.error.code}: ${body.error.message}`, false, body.error);
    }
    return body.result as T;
  }
}

/**
 * WS JSON-RPC with jsonrpsee subscription support. Uses the global WebSocket
 * (Node >= 21 / Node 20 with --experimental-websocket). Constructor throws a
 * clear error when unavailable — never silently degrades.
 */
export class WsJsonRpc implements FnnTransport {
  private nextId = 1;
  private wsPromise: Promise<WebSocket> | undefined;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: unknown) => void }>();
  private readonly subs = new Map<string, (payload: unknown) => void>();

  constructor(private readonly url: string, private readonly token?: string) {
    if (typeof WebSocket === "undefined") {
      throw new AdapterError(
        "fiber",
        "ws",
        "global WebSocket unavailable (need Node >= 21 or --experimental-websocket); use HttpJsonRpc + polling instead",
        false,
      );
    }
  }

  private ws(): Promise<WebSocket> {
    this.wsPromise ??= new Promise((resolve, reject) => {
      // jsonrpsee WS auth also uses the Authorization header via protocols is
      // not supported by the browser API; FNN dev setups run token-less on
      // localhost. Token-over-WS is a known gap surfaced at construction.
      if (this.token) {
        reject(new AdapterError("fiber", "ws", "bearer token over WebSocket not supported by this transport", false));
        return;
      }
      const ws = new WebSocket(this.url);
      ws.onopen = () => resolve(ws);
      ws.onerror = (e) => reject(new AdapterError("fiber", "ws", "WebSocket connect failed", true, e));
      ws.onmessage = (ev) => this.onMessage(String(ev.data));
    });
    return this.wsPromise;
  }

  private onMessage(data: string): void {
    let msg: {
      id?: number;
      result?: unknown;
      error?: JsonRpcError;
      method?: string;
      params?: { subscription?: string; result?: unknown };
    };
    try {
      msg = JSON.parse(data);
    } catch {
      return; // non-JSON frames are ignored
    }
    if (msg.id !== undefined && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)!;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new AdapterError("fiber", "rpc", `RPC error ${msg.error.code}: ${msg.error.message}`, false, msg.error));
      else p.resolve(msg.result);
      return;
    }
    const subId = msg.params?.subscription;
    if (subId !== undefined) this.subs.get(String(subId))?.(msg.params?.result);
  }

  async call<T>(method: string, params: unknown): Promise<T> {
    const ws = await this.ws();
    const id = this.nextId++;
    const result = new Promise<unknown>((resolve, reject) => this.pending.set(id, { resolve, reject }));
    ws.send(JSON.stringify({ id, jsonrpc: "2.0", method, params: [params] }));
    return (await result) as T;
  }

  async *subscribe(method: string, params: unknown, unsubscribeMethod: string): AsyncIterable<unknown> {
    const subId = String(await this.call<unknown>(method, params));
    const queue: unknown[] = [];
    let wake: (() => void) | undefined;
    this.subs.set(subId, (payload) => {
      queue.push(payload);
      wake?.();
    });
    try {
      for (;;) {
        while (queue.length > 0) yield queue.shift();
        await new Promise<void>((r) => (wake = r));
      }
    } finally {
      this.subs.delete(subId);
      await this.call(unsubscribeMethod, subId).catch(() => undefined);
    }
  }
}

/* ---------- LND REST ---------- */

export interface LndTransport {
  get<T>(path: string): Promise<T>;
  post<T>(path: string, body: unknown): Promise<T>;
  /** Server-streaming REST endpoint: yields one parsed JSON object per line. */
  stream(path: string, body?: unknown): AsyncIterable<unknown>;
}

export interface LndRestOptions {
  baseUrl: string; // e.g. https://127.0.0.1:8080
  /** hex-encoded admin/invoices macaroon; omit for --no-macaroons dev nodes */
  macaroonHex?: string;
  /**
   * Trust LND's self-signed TLS cert (dev only). Production must supply the
   * cert to Node via NODE_EXTRA_CA_CERTS instead.
   */
  allowSelfSigned?: boolean;
  fetchImpl?: typeof fetch;
}

export class LndRestHttp implements LndTransport {
  constructor(private readonly opts: LndRestOptions) {}

  private headers(): Record<string, string> {
    const h: Record<string, string> = { "Content-Type": "application/json" };
    if (this.opts.macaroonHex) h["Grpc-Metadata-macaroon"] = this.opts.macaroonHex;
    return h;
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const fetchImpl = this.opts.fetchImpl ?? fetch;
    if (this.opts.allowSelfSigned) {
      // Node's fetch (undici) has no per-request CA option; the supported
      // dev-only escape hatch is the env toggle. Set narrowly by the caller.
      process.env["NODE_TLS_REJECT_UNAUTHORIZED"] = "0";
    }
    const res = await fetchImpl(`${this.opts.baseUrl}${path}`, { ...init, headers: this.headers() });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new AdapterError("lightning", path, `HTTP ${res.status}: ${text}`, res.status >= 500);
    }
    return res;
  }

  async get<T>(path: string): Promise<T> {
    return (await (await this.request(path, { method: "GET" })).json()) as T;
  }

  async post<T>(path: string, body: unknown): Promise<T> {
    return (await (await this.request(path, { method: "POST", body: JSON.stringify(body) })).json()) as T;
  }

  async *stream(path: string, body?: unknown): AsyncIterable<unknown> {
    const res = await this.request(path, body === undefined ? { method: "GET" } : { method: "POST", body: JSON.stringify(body) });
    if (!res.body) return;
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) yield JSON.parse(line);
      }
    }
    const tail = buf.trim();
    if (tail) yield JSON.parse(tail);
  }
}
