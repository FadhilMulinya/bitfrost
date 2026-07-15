import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { FiberAdapter } from "../src/adapters/fiber.js";
import { AdapterError, type SwapLegEvent } from "../src/adapters/types.js";
import type { FnnTransport } from "../src/adapters/transport.js";

const FX = JSON.parse(readFileSync(new URL("./fixtures/fnn.json", import.meta.url), "utf8"));
const HASH = "0x2fd54b1b6d4e4c53c439f37e39a1e9a780545d0d92ff5f00bd1e778a56ab5f1d";
const PREIMAGE = "0x1111111111111111111111111111111111111111111111111111111111111111";
const NOW = 1_784_085_000_000;

interface Call { method: string; params: Record<string, unknown> }

/** fixture-backed FnnTransport that records every call */
function fakeTransport(routes: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  const calls: Call[] = [];
  const transport: FnnTransport = {
    async call<T>(method: string, params: unknown): Promise<T> {
      const p = params as Record<string, unknown>;
      calls.push({ method, params: p });
      const route = routes[method];
      if (route === undefined) throw new Error(`unexpected RPC ${method}`);
      return (typeof route === "function" ? route(p) : route) as T;
    },
  };
  return { transport, calls };
}

function adapter(routes: Record<string, unknown | ((p: Record<string, unknown>) => unknown)>) {
  const { transport, calls } = fakeTransport(routes);
  return { adapter: new FiberAdapter({ transport, currency: "Fibd", now: () => NOW }), calls };
}

describe("FiberAdapter hold invoices (RPC-NOTES wire contract)", () => {
  it("newHoldInvoice sends payment_hash WITHOUT preimage, hex-encoded amounts, sha256, ms delta", async () => {
    const { adapter: a, calls } = adapter({ new_invoice: FX.new_invoice });
    const inv = await a.newHoldInvoice({
      amount: 50_000n,
      paymentHash: HASH,
      finalTlcExpiryDeltaMs: 57_600_000, // 16h — FNN's documented minimum
      expirySeconds: 3600,
      description: "swap leg",
    });
    expect(inv.paymentHash).toBe(HASH);
    expect(inv.invoiceAddress).toBe(FX.new_invoice.invoice_address);
    const p = calls[0]!.params;
    expect(p["payment_hash"]).toBe(HASH);
    expect(p).not.toHaveProperty("payment_preimage"); // hold semantics: NEVER send one
    expect(p["amount"]).toBe("0xc350"); // U128Hex, not decimal
    expect(p["final_expiry_delta"]).toBe("0x36ee800"); // ms as U64Hex
    expect(p["expiry"]).toBe("0xe10"); // seconds as U64Hex
    expect(p["hash_algorithm"]).toBe("sha256");
    expect(p["currency"]).toBe("Fibd");
  });

  it("newHoldInvoice rejects when the node echoes a different payment_hash", async () => {
    const tampered = structuredClone(FX.new_invoice);
    tampered.invoice.data.payment_hash = "0x" + "ab".repeat(32);
    const { adapter: a } = adapter({ new_invoice: tampered });
    await expect(
      a.newHoldInvoice({ amount: 1n, paymentHash: HASH, finalTlcExpiryDeltaMs: 57_600_000 }),
    ).rejects.toThrow(AdapterError);
  });

  it("newHoldInvoice surfaces the node's duplicate-hash rejection untouched", async () => {
    const { adapter: a } = adapter({
      new_invoice: () => {
        throw new AdapterError("fiber", "new_invoice", "RPC error -32000: invoice already exists", false);
      },
    });
    await expect(
      a.newHoldInvoice({ amount: 1n, paymentHash: HASH, finalTlcExpiryDeltaMs: 57_600_000 }),
    ).rejects.toThrow(/invoice already exists/);
  });

  it("settle/cancel use the exact FNN param names", async () => {
    const { adapter: a, calls } = adapter({ settle_invoice: {}, cancel_invoice: FX.get_invoice_received });
    await a.settleHoldInvoice(HASH, PREIMAGE);
    await a.cancelHoldInvoice(HASH);
    expect(calls[0]).toEqual({
      method: "settle_invoice",
      params: { payment_hash: HASH, payment_preimage: PREIMAGE },
    });
    expect(calls[1]).toEqual({ method: "cancel_invoice", params: { payment_hash: HASH } });
  });

  it("rejects malformed hashes before any RPC leaves the process", async () => {
    const { adapter: a, calls } = adapter({});
    await expect(a.settleHoldInvoice("0xBEEF", PREIMAGE)).rejects.toThrow(TypeError);
    await expect(a.cancelHoldInvoice("2fd5")).rejects.toThrow(TypeError);
    expect(calls).toHaveLength(0);
  });
});

describe("FiberAdapter payments", () => {
  it("sendPayment hex-encodes max_fee_amount (u128) and tlc_expiry_limit (u64 ms)", async () => {
    const { adapter: a, calls } = adapter({ send_payment: FX.send_payment });
    const handle = await a.sendPayment("fibd50001q...", 100n, 57_600_000);
    expect(handle).toEqual({ network: "fiber", paymentHash: HASH, status: "Created" });
    expect(calls[0]!.params).toEqual({
      invoice: "fibd50001q...",
      max_fee_amount: "0x64",
      tlc_expiry_limit: "0x36ee800",
    });
  });

  it("parseInvoice (async divergence) decodes U128Hex amount to bigint", async () => {
    const { adapter: a } = adapter({ parse_invoice: FX.parse_invoice });
    const d = await a.parseInvoice("fibd50001q...");
    expect(d.paymentHash).toBe(HASH);
    expect(d.amount).toBe(50_000n);
  });
});

describe("FiberAdapter event normalization → SwapLegEvent", () => {
  it("maps StoreChange variants to leg events (Received/Paid/Cancelled/PutPreimage)", () => {
    const { adapter: a } = adapter({});
    expect(a.normalizeStoreChange(FX.store_change_put_invoice_status_received)).toMatchObject({
      network: "fiber",
      paymentHash: HASH,
      kind: "INCOMING_HELD",
      observedAt: NOW,
    });
    expect(
      a.normalizeStoreChange({ PutCkbInvoiceStatus: { payment_hash: HASH, invoice_status: "Paid" } }),
    ).toMatchObject({ kind: "INCOMING_SETTLED" });
    expect(
      a.normalizeStoreChange({ PutCkbInvoiceStatus: { payment_hash: HASH, invoice_status: "Cancelled" } }),
    ).toMatchObject({ kind: "INCOMING_CANCELLED" });
    expect(a.normalizeStoreChange(FX.store_change_put_preimage)).toMatchObject({
      kind: "OUTGOING_SETTLED",
      preimage: PREIMAGE,
    });
    // non-transitions produce nothing
    expect(
      a.normalizeStoreChange({ PutCkbInvoiceStatus: { payment_hash: HASH, invoice_status: "Open" } }),
    ).toBeUndefined();
    expect(a.normalizeStoreChange({ PutAttempt: { payment_hash: HASH, attempt_status: {} } })).toBeUndefined();
  });

  it("subscribeStoreChanges refuses (typed) on a transport without WS support — never fakes", async () => {
    const { adapter: a } = adapter({});
    const iter = a.legEvents()[Symbol.asyncIterator]();
    await expect(iter.next()).rejects.toThrow(/no WS subscription support/);
  });

  it("pollLegEvents(outgoing) emits IN_FLIGHT then terminal FAILED with node reason", async () => {
    const seq = [
      { ...FX.send_payment, status: "Inflight" },
      { ...FX.send_payment, status: "Inflight" }, // unchanged → no duplicate event
      FX.get_payment_failed,
    ];
    let i = 0;
    const { adapter: a } = adapter({ get_payment: () => seq[Math.min(i++, seq.length - 1)] });
    const events: SwapLegEvent[] = [];
    for await (const ev of a.pollLegEvents(HASH, "outgoing", { intervalMs: 1 })) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(["OUTGOING_IN_FLIGHT", "OUTGOING_FAILED"]);
    expect(events[1]!.failureReason).toBe("no path found");
  });

  it("pollLegEvents(incoming) emits HELD then SETTLED and terminates", async () => {
    const seq = ["Open", "Received", "Paid"];
    let i = 0;
    const { adapter: a } = adapter({
      get_invoice: () => ({ ...FX.get_invoice_received, status: seq[Math.min(i++, seq.length - 1)] }),
    });
    const events: SwapLegEvent[] = [];
    for await (const ev of a.pollLegEvents(HASH, "incoming", { intervalMs: 1 })) events.push(ev);
    expect(events.map((e) => e.kind)).toEqual(["INCOMING_HELD", "INCOMING_SETTLED"]);
  });
});

describe("FiberAdapter inventory", () => {
  it("getChannels decodes hex balances and CamelCase state_name", async () => {
    const { adapter: a } = adapter({ list_channels: FX.list_channels });
    const [ch] = await a.getChannels();
    expect(ch).toMatchObject({ state: "ChannelReady", localBalance: 200_000n, remoteBalance: 0n });
    expect(ch!.udtTypeScript?.hash_type).toBe("data2");
  });

  it("nodeInfo maps pubkey/version (FNN's node_info field is pubkey, not node_id)", async () => {
    const { adapter: a } = adapter({ node_info: FX.node_info });
    expect(await a.nodeInfo()).toEqual({
      nodeId: FX.node_info.pubkey,
      version: "0.9.0-rc7",
    });
  });
});
