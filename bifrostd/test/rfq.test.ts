/**
 * RFQ engine tests — written FIRST, against spec/PROTOCOL.md §4.1–4.2, §7 and
 * SYSTEM-DESIGN §4.3. The decisive gate: every quote QuoteService signs must
 * pass the SDK's own verifyQuote (§9 checklist), including the ±1-unit
 * hub-favorable rounding rule.
 */
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { BifrostError, PROTOCOL_VERSION, verifyQuote, type QuoteRequest } from "@bifrost/sdk";
import { mulDivFloor, mulDivCeil, normalize, rational } from "../src/rfq/rational.js";
import { staticPeg, feedSpread, inventorySkew, type PricingContext } from "../src/rfq/pricing.js";
import { QuoteService } from "../src/rfq/quote-service.js";

const PRIV = new Uint8Array(32).fill(7);
const NOW = 1_752_505_200_000;

const SAT_SHANNON_PAIR = {
  give: { network: "fiber", unit: "shannon" },
  get: { network: "lightning", unit: "sat" },
} as const;

function ctx(overrides: Partial<PricingContext> = {}): PricingContext {
  return {
    inventory: { giveAvailable: 10_000_000_000n, getAvailable: 10_000_000_000n },
    inFlightExposure: 0n,
    now: NOW,
    ...overrides,
  };
}

function req(overrides: Partial<QuoteRequest> = {}): QuoteRequest {
  return {
    protocol: PROTOCOL_VERSION,
    pair: SAT_SHANNON_PAIR,
    amount: { side: "get", value: "50000" },
    mode: "RECEIVE",
    ...overrides,
  } as QuoteRequest;
}

function service(overrides: Partial<ConstructorParameters<typeof QuoteService>[0]> = {}) {
  return new QuoteService({
    privkey: PRIV,
    strategy: staticPeg({ rate: rational(1n, 1n), spreadPpm: 0n, hubFeePpm: 2000n, flatFee: 0n }),
    quoteTtlMs: 30_000,
    maxIncomingHoldMs: 21_600_000,
    minSafetyDeltaMs: 7_200_000,
    estNetworkFee: () => 12n,
    minAmount: 1_000n,
    maxAmount: 1_000_000_000n,
    now: () => NOW,
    ...overrides,
  });
}

/* ---------- rational math ---------- */

describe("rational (exact, no floats)", () => {
  it("normalizes via gcd and forbids zero denominators", () => {
    expect(normalize(rational(50_000n, 13_000_000_000n))).toEqual({ num: 1n, den: 260_000n });
    expect(() => rational(1n, 0n)).toThrow();
    expect(() => rational(-1n, 5n)).toThrow(); // rates are positive
  });

  it("mulDivFloor / mulDivCeil round in the stated direction", () => {
    expect(mulDivFloor(10n, 1n, 3n)).toBe(3n);
    expect(mulDivCeil(10n, 1n, 3n)).toBe(4n);
    expect(mulDivFloor(9n, 1n, 3n)).toBe(3n);
    expect(mulDivCeil(9n, 1n, 3n)).toBe(3n); // exact: no bump
  });
});

/* ---------- strategies ---------- */

describe("static-peg", () => {
  it("applies the configured spread hub-favorably (client gets less)", async () => {
    const s = staticPeg({ rate: rational(1n, 1n), spreadPpm: 10_000n, hubFeePpm: 0n, flatFee: 0n }); // 1%
    const d = await s.price(req(), ctx());
    if (!d.accept) throw new Error("expected accept");
    // 1:1 minus 1% = 990000/1000000 = 99/100
    expect(normalize(d.rate)).toEqual({ num: 99n, den: 100n });
  });
});

describe("feed-spread", () => {
  it("prices from the feed minus spread", async () => {
    const s = feedSpread({ spreadPpm: 5_000n, maxFeedAgeMs: 10_000 });
    const d = await s.price(req(), ctx({ feedRate: rational(50_000n, 13_000_000_000n), feedUpdatedAt: NOW - 1_000 }));
    if (!d.accept) throw new Error("expected accept");
    // (1/260000) × 995/1000
    expect(normalize(d.rate)).toEqual(normalize(rational(995_000n, 260_000n * 1_000_000n)));
  });

  it("REJECTS a stale feed with PRICING_UNAVAILABLE (closed registry)", async () => {
    const s = feedSpread({ spreadPpm: 5_000n, maxFeedAgeMs: 10_000 });
    const stale = await s.price(req(), ctx({ feedRate: rational(1n, 260_000n), feedUpdatedAt: NOW - 10_001 }));
    expect(stale).toEqual({ accept: false, reason: "PRICING_UNAVAILABLE" });
  });

  it("REJECTS a missing feed with PRICING_UNAVAILABLE", async () => {
    const s = feedSpread({ spreadPpm: 5_000n, maxFeedAgeMs: 10_000 });
    expect(await s.price(req(), ctx())).toEqual({ accept: false, reason: "PRICING_UNAVAILABLE" });
  });
});

describe("inventory-skew (composing wrapper)", () => {
  const inner = staticPeg({ rate: rational(1n, 1n), spreadPpm: 0n, hubFeePpm: 0n, flatFee: 0n });

  it("widens the spread when the trade drains the scarce get-side inventory", async () => {
    const s = inventorySkew(inner, { maxSkewPpm: 100_000n }); // ±10%
    // get side nearly empty: hub paying out its scarce asset → worse client rate
    const d = await s.price(req(), ctx({ inventory: { giveAvailable: 9_000_000n, getAvailable: 1_000_000n } }));
    if (!d.accept) throw new Error("expected accept");
    // imbalance = (1M−9M)/10M = −0.8 → skew = 0.8 × 10% = 8% worse
    expect(normalize(d.rate)).toEqual(normalize(rational(920_000n, 1_000_000n)));
  });

  it("tightens (improves) the rate when the trade rebalances the hub", async () => {
    const s = inventorySkew(inner, { maxSkewPpm: 100_000n });
    // get side overweight: this trade sheds it → better-than-inner client rate
    const d = await s.price(req(), ctx({ inventory: { giveAvailable: 1_000_000n, getAvailable: 9_000_000n } }));
    if (!d.accept) throw new Error("expected accept");
    expect(normalize(d.rate)).toEqual(normalize(rational(1_080_000n, 1_000_000n)));
  });

  it("short-circuits inner rejections untouched", async () => {
    const rejecting = feedSpread({ spreadPpm: 0n, maxFeedAgeMs: 1 });
    const s = inventorySkew(rejecting, { maxSkewPpm: 100_000n });
    expect(await s.price(req(), ctx())).toEqual({ accept: false, reason: "PRICING_UNAVAILABLE" });
  });
});

/* ---------- QuoteService ---------- */

describe("QuoteService — signed quotes that pass the SDK §9 checklist", () => {
  it("side=get: quote verifies via sdk verifyQuote incl signature, amounts, expiry", async () => {
    const svc = service();
    const r = req(); // fixed get = 50000
    const quote = await svc.quote(r, ctx());
    expect(quote.getAmount).toBe("50000");
    expect(quote.hubPubkey).toBe(bytesToHex(schnorr.getPublicKey(PRIV)));
    expect(quote.issuedAt).toBe(NOW);
    expect(quote.expiresAt).toBe(NOW + 30_000);
    // the SDK's verifier IS the spec contract — must not throw
    verifyQuote(quote, r, { now: NOW, invoiceAmount: 50_000n });
  });

  it("side=give: quote verifies and fees come out of the get side", async () => {
    const r = req({ amount: { side: "give", value: "1000000" } });
    const quote = await service().quote(r, ctx());
    expect(quote.giveAmount).toBe("1000000");
    // 1:1 rate, 2000ppm fee on gross 1_000_000 = 2000, +12 network fee
    expect(BigInt(quote.getAmount)).toBe(1_000_000n - 2_000n - 12n);
    verifyQuote(quote, r, { now: NOW });
  });

  it("ROUNDING RULE (PROTOCOL §4.2): hub-favorable by AT MOST 1 unit, both sides, adversarial sweep", async () => {
    // Awkward rational (7/13) × awkward amounts: forces every rounding branch.
    const svc = service({
      strategy: staticPeg({ rate: rational(7n, 13n), spreadPpm: 3_333n, hubFeePpm: 1_234n, flatFee: 5n }),
    });
    for (const value of ["1009", "12345", "999983", "500000021"]) {
      // fixed get: client must receive exactly `value`; give rounds UP (hub-favorable)
      const rGet = req({ amount: { side: "get", value } });
      const qGet = await svc.quote(rGet, ctx());
      expect(BigInt(qGet.getAmount)).toBe(BigInt(value));
      verifyQuote(qGet, rGet, { now: NOW }); // enforces 0 ≤ expected−get ≤ 1
      // hub-favorable: one fewer give unit must NOT satisfy the client's get
      const give = BigInt(qGet.giveAmount);
      const num = BigInt(qGet.rate.num);
      const den = BigInt(qGet.rate.den);
      const grossMinus = ((give - 1n) * num) / den;
      const ppm = BigInt(qGet.feeBreakdown.hubFeePpm);
      const netMinus = grossMinus - (grossMinus * ppm) / 1_000_000n - BigInt(qGet.feeBreakdown.flatFee) - BigInt(qGet.feeBreakdown.estNetworkFee);
      expect(netMinus).toBeLessThan(BigInt(value)); // give is minimal → ceil, not over-rounded

      // fixed give: get rounds DOWN (hub-favorable), within 1 unit of exact
      const rGive = req({ amount: { side: "give", value } });
      const qGive = await svc.quote(rGive, ctx());
      expect(BigInt(qGive.giveAmount)).toBe(BigInt(value));
      verifyQuote(qGive, rGive, { now: NOW });
    }
  });

  it("PAY_INVOICE: INVOICE_MISMATCH when request amount ≠ invoice amount; INVOICE_INVALID when invoice missing", async () => {
    const svc = service();
    const r = req({ mode: "PAY_INVOICE", targetInvoice: "lnbcrt..." });
    await expect(svc.quote(r, ctx(), { invoiceAmount: 49_999n })).rejects.toMatchObject({ code: "INVOICE_MISMATCH" });
    await expect(svc.quote(req({ mode: "PAY_INVOICE" }), ctx())).rejects.toMatchObject({ code: "INVOICE_INVALID" });
    // matching amount succeeds and passes the sdk's own §9 item-3 check
    const quote = await svc.quote(r, ctx(), { invoiceAmount: 50_000n });
    verifyQuote(quote, r, { now: NOW, invoiceAmount: 50_000n });
  });

  it("rejections use ONLY the closed error registry", async () => {
    const svc = service();
    // amount bounds
    await expect(svc.quote(req({ amount: { side: "get", value: "999" } }), ctx()))
      .rejects.toMatchObject({ code: "AMOUNT_OUT_OF_BOUNDS" });
    await expect(svc.quote(req({ amount: { side: "get", value: "1000000001" } }), ctx()))
      .rejects.toMatchObject({ code: "AMOUNT_OUT_OF_BOUNDS" });
    // inventory: hub cannot pay out more than the get side holds
    await expect(svc.quote(req(), ctx({ inventory: { giveAvailable: 10n ** 12n, getAvailable: 10_000n } })))
      .rejects.toMatchObject({ code: "INVENTORY_INSUFFICIENT" });
    // strategy rejection propagates its registry code
    const staleSvc = service({ strategy: feedSpread({ spreadPpm: 0n, maxFeedAgeMs: 1 }) });
    await expect(staleSvc.quote(req(), ctx())).rejects.toMatchObject({ code: "PRICING_UNAVAILABLE" });
    // unsupported pair
    const paired = service({ supportsPair: () => false });
    await expect(paired.quote(req(), ctx())).rejects.toMatchObject({ code: "PAIR_UNSUPPORTED" });
    // all of the above are BifrostErrors (registry-typed), never bare strings
    await expect(paired.quote(req(), ctx())).rejects.toBeInstanceOf(BifrostError);
  });

  it("tampered quotes fail sdk verification (signature covers every field)", async () => {
    const r = req();
    const quote = await service().quote(r, ctx());
    const tampered = { ...quote, getAmount: "50001" };
    expect(() => verifyQuote(tampered, r, { now: NOW })).toThrow();
  });

  it("chain composition: inventory-skew(feed-spread) end-to-end still verifier-clean", async () => {
    const svc = service({
      strategy: inventorySkew(feedSpread({ spreadPpm: 5_000n, maxFeedAgeMs: 10_000 }), { maxSkewPpm: 50_000n }),
    });
    const r = req({ amount: { side: "give", value: "260000000" } });
    const quote = await svc.quote(
      r,
      ctx({
        feedRate: rational(50_000n, 13_000_000_000n),
        feedUpdatedAt: NOW - 500,
        inventory: { giveAvailable: 3_000_000n, getAvailable: 1_000_000n },
      }),
    );
    verifyQuote(quote, r, { now: NOW });
  });
});
