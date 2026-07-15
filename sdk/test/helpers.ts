/**
 * Test-only invoice encoders and quote signing.
 * The BOLT11 encoder emits structurally valid invoices with a zeroed signature
 * (light-bolt11-decoder does not verify signatures). The Fiber encoder mirrors
 * the layout documented in src/invoice.ts.
 */
import { bech32, bech32m } from "@scure/base";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { signingDigest } from "../src/canonical.js";
import type { Quote } from "../src/types.js";
import { PROTOCOL_VERSION } from "../src/types.js";

const BECH32_CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";

function intToWords(n: number, len: number): number[] {
  const w: number[] = [];
  for (let i = len - 1; i >= 0; i--) w.push((n >> (5 * i)) & 31);
  return w;
}

function tag(type: string, dataWords: number[]): number[] {
  return [BECH32_CHARSET.indexOf(type), ...intToWords(dataWords.length, 2), ...dataWords];
}

export interface TestBolt11Opts {
  paymentHash: Uint8Array; // 32 bytes
  /** HRP amount part, e.g. "500u" (= 50_000 sat). Omit for amountless. */
  hrpAmount?: string;
  timestamp?: number; // unix seconds
  expirySeconds?: number;
  network?: "bc" | "tb";
}

export function encodeTestBolt11(opts: TestBolt11Opts): string {
  const words: number[] = [...intToWords(opts.timestamp ?? 1_752_505_200, 7)];
  words.push(...tag("p", bech32.toWords(opts.paymentHash)));
  words.push(...tag("d", [])); // empty description
  if (opts.expirySeconds !== undefined) {
    const e: number[] = [];
    let n = opts.expirySeconds;
    do { e.unshift(n & 31); n >>= 5; } while (n > 0);
    words.push(...tag("x", e));
  }
  words.push(...bech32.toWords(new Uint8Array(65))); // zeroed recoverable sig
  return bech32.encode(`ln${opts.network ?? "bc"}${opts.hrpAmount ?? ""}`, words, 2000);
}

export interface TestFiberOpts {
  paymentHash: Uint8Array; // 32 bytes
  /** amount in shannon, encoded in the HRP */
  amountShannon?: bigint;
  timestamp?: number; // unix seconds
  prefix?: "fib" | "fibt" | "fibd";
}

export function encodeTestFiberInvoice(opts: TestFiberOpts): string {
  const payload = new Uint8Array(1 + 8 + 32);
  payload[0] = 0x00; // version
  const ts = BigInt(opts.timestamp ?? 1_752_505_200);
  for (let i = 0; i < 8; i++) payload[1 + i] = Number((ts >> BigInt(8 * (7 - i))) & 0xffn);
  payload.set(opts.paymentHash, 9);
  const hrp = `${opts.prefix ?? "fibt"}${opts.amountShannon !== undefined ? opts.amountShannon.toString() : ""}`;
  return bech32m.encode(hrp, bech32m.toWords(payload), 2000);
}

/* ---------- quote signing (same pattern as verify.test.ts) ---------- */

export const TEST_PRIV = hexToBytes(
  "0000000000000000000000000000000000000000000000000000000000000001",
);
export const TEST_PUB = bytesToHex(schnorr.getPublicKey(TEST_PRIV));

export function makeSignedQuote(overrides: Partial<Quote> = {}): Quote {
  const base = {
    protocol: PROTOCOL_VERSION,
    quoteId: "01TESTQUOTE",
    pair: {
      give: { network: "fiber", unit: "shannon" },
      get: { network: "lightning", unit: "sat" },
    },
    rate: { num: "50000", den: "13000000000" },
    giveAmount: "13000000000",
    getAmount: "49888", // gross 50000 - 2000ppm fee (100) - flat 0 - net 12
    feeBreakdown: { hubFeePpm: "2000", flatFee: "0", estNetworkFee: "12" },
    issuedAt: 1_000_000,
    expiresAt: 1_030_000,
    maxIncomingHoldMs: 21_600_000,
    minSafetyDeltaMs: 7_200_000,
    hubPubkey: TEST_PUB,
    ...overrides,
  } as Omit<Quote, "signature">;
  const digest = signingDigest(base as unknown as Record<string, unknown>, "quote");
  const signature = bytesToHex(schnorr.sign(digest, TEST_PRIV, new Uint8Array(32)));
  return { ...base, signature } as Quote;
}
