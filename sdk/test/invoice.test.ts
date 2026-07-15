import { describe, expect, it } from "vitest";
import { bytesToHex } from "@noble/hashes/utils";
import { detectInvoice } from "../src/invoice.js";
import { BifrostError } from "../src/errors.js";
import { encodeTestBolt11, encodeTestFiberInvoice } from "./helpers.js";

const HASH = new Uint8Array(32).fill(1);
HASH[31] = 2;
const HASH_HEX = bytesToHex(HASH);

describe("invoice detection + metadata extraction", () => {
  it("decodes a BOLT11 invoice: network, payment hash, amount in sat", () => {
    const inv = encodeTestBolt11({ paymentHash: HASH, hrpAmount: "500u" }); // 500 µBTC = 50 000 sat
    const info = detectInvoice(inv);
    expect(info.network).toBe("lightning");
    expect(info.paymentHash).toBe(HASH_HEX);
    expect(info.amount).toBe(50_000n);
    expect(info.amountMsat).toBe(50_000_000n);
  });

  it("decodes an amountless BOLT11 invoice", () => {
    const inv = encodeTestBolt11({ paymentHash: HASH });
    const info = detectInvoice(inv);
    expect(info.network).toBe("lightning");
    expect(info.paymentHash).toBe(HASH_HEX);
    expect(info.amount).toBeUndefined();
    expect(info.amountMsat).toBeUndefined();
  });

  it("leaves sat amount undefined for sub-sat msat precision", () => {
    // 1p = 0.1 msat per unit... use 10p = 1 msat -> not divisible by 1000
    const inv = encodeTestBolt11({ paymentHash: HASH, hrpAmount: "10p" });
    const info = detectInvoice(inv);
    expect(info.amountMsat).toBe(1n);
    expect(info.amount).toBeUndefined();
  });

  it("extracts expiry when the x tag is present", () => {
    const inv = encodeTestBolt11({ paymentHash: HASH, timestamp: 1_752_505_200, expirySeconds: 3600 });
    const info = detectInvoice(inv);
    expect(info.expiresAt).toBe((1_752_505_200 + 3600) * 1000);
  });

  it("detects testnet BOLT11 (lntb)", () => {
    const inv = encodeTestBolt11({ paymentHash: HASH, network: "tb" });
    expect(detectInvoice(inv).network).toBe("lightning");
  });

  it("decodes a Fiber invoice: payment hash + shannon amount from HRP", () => {
    const inv = encodeTestFiberInvoice({ paymentHash: HASH, amountShannon: 13_000_000_000n });
    const info = detectInvoice(inv);
    expect(info.network).toBe("fiber");
    expect(info.paymentHash).toBe(HASH_HEX);
    expect(info.amount).toBe(13_000_000_000n);
  });

  it("decodes an amountless Fiber invoice", () => {
    const inv = encodeTestFiberInvoice({ paymentHash: HASH });
    const info = detectInvoice(inv);
    expect(info.network).toBe("fiber");
    expect(info.paymentHash).toBe(HASH_HEX);
    expect(info.amount).toBeUndefined();
  });

  it("throws INVOICE_INVALID on a corrupted BOLT11 checksum", () => {
    const inv = encodeTestBolt11({ paymentHash: HASH });
    const bad = inv.slice(0, -1) + (inv.endsWith("q") ? "p" : "q");
    try {
      detectInvoice(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as BifrostError).code).toBe("INVOICE_INVALID");
    }
  });

  it("throws INVOICE_INVALID on a corrupted Fiber payload", () => {
    const inv = encodeTestFiberInvoice({ paymentHash: HASH });
    const bad = inv.slice(0, -1) + (inv.endsWith("q") ? "p" : "q");
    try {
      detectInvoice(bad);
      expect.unreachable();
    } catch (e) {
      expect((e as BifrostError).code).toBe("INVOICE_INVALID");
    }
  });

  it("throws INVOICE_INVALID on garbage", () => {
    try {
      detectInvoice("hello-world");
      expect.unreachable();
    } catch (e) {
      expect((e as BifrostError).code).toBe("INVOICE_INVALID");
    }
  });
});

describe("BOLT11 default expiry", () => {
  it("applies the 3600s BOLT11 default when the expiry tag is absent", () => {
    const ts = 1_752_505_200;
    const inv = encodeTestBolt11({ paymentHash: HASH, hrpAmount: "498880n", timestamp: ts });
    const info = detectInvoice(inv);
    expect(info.expiresAt).toBe((ts + 3600) * 1000);
  });
});
