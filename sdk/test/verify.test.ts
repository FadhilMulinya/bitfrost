import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { signingDigest } from "../src/canonical.js";
import { verifyQuote, verifyQuoteSignature } from "../src/verify.js";
import type { Quote, QuoteRequest } from "../src/types.js";
import { PROTOCOL_VERSION } from "../src/types.js";
import { BifrostError } from "../src/errors.js";

const priv = schnorr.utils.randomPrivateKey();
const pub = bytesToHex(schnorr.getPublicKey(priv));

function makeQuote(overrides: Partial<Quote> = {}): Quote {
  const base: Omit<Quote, "signature"> = {
    protocol: PROTOCOL_VERSION,
    quoteId: "01TESTQUOTE",
    pair: {
      give: { network: "fiber", unit: "shannon" },
      get: { network: "lightning", unit: "sat" },
    },
    // rate: 50_000 sat per 13_000_000_000 shannon
    rate: { num: "50000", den: "13000000000" },
    giveAmount: "13000000000",
    getAmount: "49888", // gross 50000 - ppm fee 100 (2000ppm) - flat 0 - net 12
    feeBreakdown: { hubFeePpm: "2000", flatFee: "0", estNetworkFee: "12" },
    issuedAt: 1_000_000,
    expiresAt: 1_030_000,
    maxIncomingHoldMs: 21_600_000,
    minSafetyDeltaMs: 7_200_000,
    hubPubkey: pub,
    ...overrides,
  } as Omit<Quote, "signature">;
  const digest = signingDigest(base as unknown as Record<string, unknown>, "quote");
  const signature = bytesToHex(schnorr.sign(digest, priv));
  return { ...base, signature } as Quote;
}

const request: QuoteRequest = {
  protocol: PROTOCOL_VERSION,
  pair: {
    give: { network: "fiber", unit: "shannon" },
    get: { network: "lightning", unit: "sat" },
  },
  amount: { side: "get", value: "49888" },
  mode: "PAY_INVOICE",
  targetInvoice: "lnbc…",
};

describe("quote verification (PROTOCOL §9)", () => {
  it("accepts a well-formed signed quote", () => {
    const q = makeQuote();
    expect(verifyQuoteSignature(q)).toBe(true);
    expect(() => verifyQuote(q, request, { now: 1_010_000 })).not.toThrow();
  });
  it("rejects a tampered amount (signature breaks)", () => {
    const q = makeQuote();
    const tampered = { ...q, getAmount: "999999" };
    expect(verifyQuoteSignature(tampered as Quote)).toBe(false);
  });
  it("rejects expired quotes with QUOTE_EXPIRED", () => {
    const q = makeQuote();
    try {
      verifyQuote(q, request, { now: 2_000_000 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BifrostError);
      expect((e as BifrostError).code).toBe("QUOTE_EXPIRED");
      expect((e as BifrostError).retryable).toBe(true);
    }
  });
  it("rejects arithmetic that doesn't match the signed rate", () => {
    // signed consistently but rate math off: sign a quote whose getAmount over-pays
    const q = makeQuote({ getAmount: "49999" });
    expect(() => verifyQuote(q, request, { now: 1_010_000 })).toThrow(/inconsistent/);
  });
  it("rejects pair mismatch with the original request", () => {
    const q = makeQuote();
    const wrongReq: QuoteRequest = {
      ...request,
      pair: { give: { network: "fiber", unit: "shannon" }, get: { network: "fiber", unit: "shannon" } },
    };
    expect(() => verifyQuote(q, wrongReq, { now: 1_010_000 })).toThrow(/pair/);
  });
  it("enforces invoice amount equality in PAY_INVOICE mode", () => {
    const q = makeQuote();
    try {
      verifyQuote(q, request, { now: 1_010_000, invoiceAmount: 50_000n });
      expect.unreachable();
    } catch (e) {
      expect((e as BifrostError).code).toBe("INVOICE_MISMATCH");
    }
  });
});
