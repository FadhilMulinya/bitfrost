import { describe, expect, it } from "vitest";
import { detectInvoice } from "../src/invoice.js";
import { BifrostError } from "../src/errors.js";

describe("invoice detection", () => {
  it("detects BOLT11 mainnet/testnet", () => {
    expect(detectInvoice("lnbc500u1pexample").network).toBe("lightning");
    expect(detectInvoice("LNTB500u1pexample").network).toBe("lightning");
  });
  it("detects Fiber invoices", () => {
    expect(detectInvoice("fibt1qexample").network).toBe("fiber");
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
