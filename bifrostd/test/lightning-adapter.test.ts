import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { LightningAdapter, base64ToHex, hexToBase64, hexToBase64Url } from "../src/adapters/lightning.js";
import type { LndTransport } from "../src/adapters/transport.js";
import type { SwapLegEvent } from "../src/adapters/types.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/lnd.json", import.meta.url), "utf8"));
const HASH = "0x2fd54b1b6d4e4c53c439f37e39a1e9a780545d0d92ff5f00bd1e778a56ab5f1d";
const HASH_B64 = "L9VLG21OTFPEOfN+OaHpp4BUXQ2S/18AvR53ilarXx0=";
const PREIMAGE = "0x1111111111111111111111111111111111111111111111111111111111111111";
const NOW = 1_784_085_000_000;

interface Rec { kind: "get" | "post" | "stream"; path: string; body?: unknown }

function fakeTransport(routes: {
  get?: Record<string, unknown>;
  post?: Record<string, unknown>;
  stream?: Record<string, unknown[]>;
}) {
  const calls: Rec[] = [];
  const transport: LndTransport = {
    async get<T>(path: string): Promise<T> {
      calls.push({ kind: "get", path });
      const r = routes.get?.[path];
      if (r === undefined) throw new Error(`unexpected GET ${path}`);
      return r as T;
    },
    async post<T>(path: string, body: unknown): Promise<T> {
      calls.push({ kind: "post", path, body });
      const r = routes.post?.[path];
      if (r === undefined) throw new Error(`unexpected POST ${path}`);
      return r as T;
    },
    async *stream(path: string, body?: unknown): AsyncIterable<unknown> {
      calls.push({ kind: "stream", path, body });
      const frames = routes.stream?.[path];
      if (frames === undefined) throw new Error(`unexpected stream ${path}`);
      yield* frames;
    },
  };
  return { transport, calls };
}

function adapter(routes: Parameters<typeof fakeTransport>[0]) {
  const { transport, calls } = fakeTransport(routes);
  return { adapter: new LightningAdapter({ transport, now: () => NOW }), calls };
}

describe("hex/base64 wire encoding", () => {
  it("round-trips the payment hash exactly as LND REST expects", () => {
    expect(hexToBase64(HASH)).toBe(HASH_B64);
    expect(base64ToHex(HASH_B64)).toBe(HASH);
  });
});

describe("LightningAdapter invoicesrpc bindings", () => {
  it("addHoldInvoice posts base64 hash + string int64 value to /v2/invoices/hodl", async () => {
    const { adapter: a, calls } = adapter({ post: { "/v2/invoices/hodl": FX.add_hold_invoice } });
    const inv = await a.addHoldInvoice({ amountSat: 100_000n, paymentHash: HASH, cltvExpiry: 144 });
    expect(inv.paymentRequest).toBe(FX.add_hold_invoice.payment_request);
    expect(inv.paymentHash).toBe(HASH);
    expect(calls[0]!.body).toEqual({ hash: HASH_B64, value: "100000", cltv_expiry: "144" });
  });

  it("settleHoldInvoice is keyed by PREIMAGE (LND derives the hash)", async () => {
    const { adapter: a, calls } = adapter({ post: { "/v2/invoices/settle": {} } });
    await a.settleHoldInvoice(PREIMAGE);
    expect(calls[0]!.body).toEqual({ preimage: hexToBase64(PREIMAGE) });
  });

  it("cancelHoldInvoice posts base64 payment_hash", async () => {
    const { adapter: a, calls } = adapter({ post: { "/v2/invoices/cancel": {} } });
    await a.cancelHoldInvoice(HASH);
    expect(calls[0]!.body).toEqual({ payment_hash: HASH_B64 });
  });

  it("rejects malformed hashes before any network call", async () => {
    const { adapter: a, calls } = adapter({});
    await expect(a.addHoldInvoice({ amountSat: 1n, paymentHash: "beef", cltvExpiry: 40 })).rejects.toThrow(TypeError);
    await expect(a.settleHoldInvoice("0x11")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("LightningAdapter routerrpc bindings", () => {
  it("sendPayment streams /v2/router/send and returns after the first frame", async () => {
    const { adapter: a, calls } = adapter({ stream: { "/v2/router/send": FX.send_payment_stream } });
    const h = await a.sendPayment("lnbcrt1m1...", 10n, 144);
    expect(h).toEqual({ network: "lightning", paymentHash: HASH, status: "IN_FLIGHT" });
    expect(calls[0]!.body).toMatchObject({
      payment_request: "lnbcrt1m1...",
      fee_limit_sat: "10",
      cltv_limit: 144,
    });
  });

  it("trackPayment yields updates and surfaces the preimage ONLY when real (not zeroed)", async () => {
    const path = `/v2/router/track/${hexToBase64Url(HASH)}?no_inflight_updates=false`;
    const { adapter: a } = adapter({ stream: { [path]: FX.track_payment_stream_success } });
    const updates = [];
    for await (const u of a.trackPayment(HASH)) updates.push(u);
    expect(updates).toHaveLength(2);
    expect(updates[0]).toEqual({ paymentHash: HASH, status: "IN_FLIGHT" }); // zeroed preimage suppressed
    expect(updates[1]).toMatchObject({ status: "SUCCEEDED", preimage: PREIMAGE });
  });

  it("stream error frames become typed AdapterErrors", async () => {
    const path = `/v2/router/track/${hexToBase64Url(HASH)}?no_inflight_updates=false`;
    const { adapter: a } = adapter({ stream: { [path]: [FX.error_stream_frame] } });
    const iter = a.trackPayment(HASH)[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/payment isn't initiated/);
  });
});

describe("LightningAdapter event normalization → SwapLegEvent", () => {
  it("incoming: OPEN→ACCEPTED→SETTLED maps to HELD → SETTLED and terminates", async () => {
    const path = `/v2/invoices/subscribe/${hexToBase64Url(HASH)}`;
    const { adapter: a } = adapter({ stream: { [path]: FX.invoice_stream } });
    const events: SwapLegEvent[] = [];
    for await (const ev of a.legEvents(HASH, "incoming")) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(["INCOMING_HELD", "INCOMING_SETTLED"]);
    expect(events.every((e) => e.network === "lightning" && e.paymentHash === HASH && e.observedAt === NOW)).toBe(true);
  });

  it("outgoing failure carries the LND failure_reason", async () => {
    const path = `/v2/router/track/${hexToBase64Url(HASH)}?no_inflight_updates=false`;
    const { adapter: a } = adapter({ stream: { [path]: FX.track_payment_stream_failed } });
    const events: SwapLegEvent[] = [];
    for await (const ev of a.legEvents(HASH, "outgoing")) events.push(ev);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "OUTGOING_FAILED", failureReason: "FAILURE_REASON_NO_ROUTE" });
  });
});

describe("LightningAdapter queries", () => {
  it("decodeInvoice maps DecodePayReq fields to bigint/number types", async () => {
    const { adapter: a } = adapter({ get: { [`/v1/payreq/${encodeURIComponent("lnbcrt1m1...")}`]: FX.decode_payreq } });
    const d = await a.decodeInvoice("lnbcrt1m1...");
    expect(d).toEqual({
      paymentHash: HASH,
      amountSat: 100_000n,
      expirySeconds: 86_400,
      cltvExpiry: 144,
      destination: FX.decode_payreq.destination,
    });
  });

  it("lookupInvoice hits /v1/invoice/{hex} (no 0x prefix) and returns the state", async () => {
    const { adapter: a, calls } = adapter({
      get: { [`/v1/invoice/${HASH.slice(2)}`]: { state: "ACCEPTED", r_hash: HASH_B64, payment_request: "lnbcrt1..." } },
    });
    const inv = await a.lookupInvoice(HASH);
    expect(inv.state).toBe("ACCEPTED");
    expect(calls[0]).toMatchObject({ kind: "get", path: `/v1/invoice/${HASH.slice(2)}` });
  });

  it("getChannels maps string int64 balances to bigint", async () => {
    const { adapter: a } = adapter({ get: { "/v1/channels": FX.list_channels } });
    const [ch] = await a.getChannels();
    expect(ch).toMatchObject({ active: true, localBalanceSat: 900_000n, remoteBalanceSat: 96_530n });
  });
});
