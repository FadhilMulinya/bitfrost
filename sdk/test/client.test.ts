/**
 * Mock-hub harness: a fake fetch implementing POST /quotes and /orders with
 * correctly signed quotes, exercising the client end to end.
 */
import { describe, expect, it } from "vitest";
import { Bifrost } from "../src/client.js";
import { BifrostError } from "../src/errors.js";
import type { Order, Quote } from "../src/types.js";
import { PROTOCOL_VERSION } from "../src/types.js";
import { encodeTestBolt11, makeSignedQuote } from "./helpers.js";

const HUB = "https://hub.test/v1";
const NOW = 1_010_000;
const HASH = new Uint8Array(32).fill(7);

// getAmount 49888 sat => invoice must carry 49888 sat = 49888000 msat.
// BOLT11 HRP: 49888 sat = 49_888_0 * 10n? Use n multiplier: 1n = 100 msat... simpler: 49888000m? No.
// 49888 sat = 4.9888e-4 BTC = 498880n (1n = 10^-9 BTC = 100 msat) -> 498880n * 100 msat = 49_888_000 msat. Exact.
const TARGET_INVOICE = encodeTestBolt11({ paymentHash: HASH, hrpAmount: "498880n" });

interface HubBehavior {
  quote?: Quote;
  quoteResponse?: { status: number; body: unknown };
  orderResponse?: { status: number; body: unknown };
}

function makeOrder(quote: Quote): Order {
  return {
    protocol: PROTOCOL_VERSION,
    orderId: "01TESTORDER",
    quoteId: quote.quoteId,
    direction: "FIBER_TO_LN",
    paymentHash: "07".repeat(32),
    state: "PENDING",
    incoming: {
      network: "fiber",
      invoice: "fibt13000000000...",
      amount: quote.giveAmount,
      tlcExpiryAt: NOW + 21_600_000,
      status: "WAITING",
    },
    outgoing: {
      network: "lightning",
      invoice: TARGET_INVOICE,
      amount: quote.getAmount,
      tlcExpiryAt: NOW + 3_600_000,
      status: "WAITING",
    },
    failure: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Fake fetch: records requests, serves /quotes and /orders per behavior. */
function mockHub(behavior: HubBehavior) {
  const requests: { url: string; body: unknown; headers: Record<string, string> }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    requests.push({ url, body, headers: (init?.headers ?? {}) as Record<string, string> });
    const respond = (status: number, payload: unknown) =>
      new Response(JSON.stringify(payload), {
        status,
        headers: { "content-type": "application/json" },
      });
    if (url === `${HUB}/quotes`) {
      if (behavior.quoteResponse) return respond(behavior.quoteResponse.status, behavior.quoteResponse.body);
      return respond(200, behavior.quote);
    }
    if (url === `${HUB}/orders`) {
      if (behavior.orderResponse) return respond(behavior.orderResponse.status, behavior.orderResponse.body);
      return respond(200, makeOrder(behavior.quote!));
    }
    return respond(404, { error: { code: "INTERNAL", message: "no such route", retryable: false } });
  };
  return { fetchImpl, requests };
}

function client(fetchImpl: typeof fetch): Bifrost {
  return new Bifrost({ fetchImpl, apiKey: "test-key", now: () => NOW });
}

describe("Bifrost client against a mock hub", () => {
  it("payAnyInvoice happy path: quote verified, order created under that quote", async () => {
    const quote = makeSignedQuote();
    const { fetchImpl, requests } = mockHub({ quote });
    const { order, quote: returnedQuote } = await client(fetchImpl).payAnyInvoice(
      HUB,
      TARGET_INVOICE,
      { network: "fiber", unit: "shannon" },
    );
    expect(returnedQuote.quoteId).toBe(quote.quoteId);
    expect(order.orderId).toBe("01TESTORDER");
    expect(order.quoteId).toBe(quote.quoteId);
    // wire assertions: correct endpoints, bearer auth, order pinned to quoteId
    expect(requests.map((r) => r.url)).toEqual([`${HUB}/quotes`, `${HUB}/orders`]);
    expect(requests[0]!.headers["authorization"]).toBe("Bearer test-key");
    expect((requests[0]!.body as { mode: string }).mode).toBe("PAY_INVOICE");
    expect((requests[1]!.body as { quoteId: string }).quoteId).toBe(quote.quoteId);
  });

  it("throws UNAUTHORIZED when the hub returns a tampered quote", async () => {
    const quote = makeSignedQuote();
    const tampered = { ...quote, getAmount: "999999" }; // signature no longer covers this
    const { fetchImpl } = mockHub({ quote: tampered });
    await expect(
      client(fetchImpl).payAnyInvoice(HUB, TARGET_INVOICE, { network: "fiber", unit: "shannon" }),
    ).rejects.toMatchObject({ name: "BifrostError", code: "UNAUTHORIZED", retryable: false });
  });

  it("throws QUOTE_EXPIRED (retryable) on an expired quote", async () => {
    const quote = makeSignedQuote({ issuedAt: 900_000, expiresAt: 1_000_000 }); // <= NOW
    const { fetchImpl } = mockHub({ quote });
    await expect(
      client(fetchImpl).payAnyInvoice(HUB, TARGET_INVOICE, { network: "fiber", unit: "shannon" }),
    ).rejects.toMatchObject({ code: "QUOTE_EXPIRED", retryable: true });
  });

  it("passes the hub's error envelope through with code/retryable/hint intact", async () => {
    const { fetchImpl } = mockHub({
      quoteResponse: {
        status: 422,
        body: {
          error: {
            code: "INVENTORY_INSUFFICIENT",
            message: "not enough lightning liquidity",
            hint: "try a smaller amount",
            retryable: true,
          },
        },
      },
    });
    try {
      await client(fetchImpl).payAnyInvoice(HUB, TARGET_INVOICE, { network: "fiber", unit: "shannon" });
      expect.unreachable();
    } catch (e) {
      const err = e as BifrostError;
      expect(err).toBeInstanceOf(BifrostError);
      expect(err.code).toBe("INVENTORY_INSUFFICIENT");
      expect(err.retryable).toBe(true);
      expect(err.hint).toBe("try a smaller amount");
      expect(err.message).toBe("not enough lightning liquidity");
    }
  });

  it("passes an order-creation error envelope through (with orderId)", async () => {
    const quote = makeSignedQuote();
    const { fetchImpl } = mockHub({
      quote,
      orderResponse: {
        status: 409,
        body: {
          error: {
            code: "EXPIRY_INVARIANT_VIOLATION",
            message: "invoice CLTV too tight for safety delta",
            retryable: false,
            orderId: "01REJECTED",
          },
        },
      },
    });
    await expect(
      client(fetchImpl).payAnyInvoice(HUB, TARGET_INVOICE, { network: "fiber", unit: "shannon" }),
    ).rejects.toMatchObject({
      code: "EXPIRY_INVARIANT_VIOLATION",
      retryable: false,
      orderId: "01REJECTED",
    });
  });
});

describe("payAnyInvoice §9 item 3 — sub-sat guard", () => {
  it("rejects msat-precision invoices instead of skipping the amount check", async () => {
    // 25n = 2500 msat = 2.5 sat: not sat-exact, so info.amount is undefined and
    // the getAmount === invoiceAmount check would silently be skipped.
    const subSat = encodeTestBolt11({ paymentHash: HASH, hrpAmount: "25n" });
    const fetchImpl = () => {
      throw new Error("must reject before any network call");
    };
    await expect(
      client(fetchImpl as never).payAnyInvoice(HUB, subSat, { network: "fiber", unit: "shannon" }),
    ).rejects.toMatchObject({ code: "INVOICE_INVALID" });
  });
});
