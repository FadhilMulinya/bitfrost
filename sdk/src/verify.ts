/**
 * BIP-340 Schnorr verification for Quotes and Advertisements, plus the
 * normative client-side verification checklist from PROTOCOL.md §9.
 */
import { schnorr } from "@noble/curves/secp256k1";
import { hexToBytes } from "@noble/hashes/utils";
import { signingDigest } from "./canonical.js";
import { BifrostError } from "./errors.js";
import type { Advertisement, Quote, QuoteRequest } from "./types.js";
import { PROTOCOL_VERSION } from "./types.js";

export function verifyQuoteSignature(quote: Quote): boolean {
  const digest = signingDigest(quote as unknown as Record<string, unknown>, "quote");
  return schnorr.verify(hexToBytes(quote.signature), digest, hexToBytes(quote.hubPubkey));
}

export function verifyAdSignature(ad: Advertisement): boolean {
  const digest = signingDigest(ad as unknown as Record<string, unknown>, "ad");
  return schnorr.verify(hexToBytes(ad.signature), digest, hexToBytes(ad.hubPubkey));
}

function sameAsset(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b); // AssetRefs are small, order-stable literals from our own types
}

/**
 * PROTOCOL §9 checklist. Throws BifrostError on the first failure.
 * `now` is injectable for tests.
 */
export function verifyQuote(
  quote: Quote,
  request: QuoteRequest,
  opts: { now?: number; invoiceAmount?: bigint | undefined } = {},
): void {
  const now = opts.now ?? Date.now();

  if (quote.protocol !== PROTOCOL_VERSION) {
    throw new BifrostError("INTERNAL", `unsupported protocol ${quote.protocol}`, false);
  }
  if (quote.expiresAt <= now) {
    throw new BifrostError("QUOTE_EXPIRED", "quote has expired", true);
  }
  if (!verifyQuoteSignature(quote)) {
    throw new BifrostError("UNAUTHORIZED", "quote signature verification failed", false);
  }
  if (
    !sameAsset(quote.pair.give, request.pair.give) ||
    !sameAsset(quote.pair.get, request.pair.get)
  ) {
    throw new BifrostError("PAIR_UNSUPPORTED", "quote pair does not match request", false);
  }

  // Amount arithmetic check: getAmount ≈ giveAmount × rate − fees, within 1 unit,
  // rounding only in the hub's favor (PROTOCOL §4.2).
  const give = BigInt(quote.giveAmount);
  const num = BigInt(quote.rate.num);
  const den = BigInt(quote.rate.den);
  const get = BigInt(quote.getAmount);
  const flat = BigInt(quote.feeBreakdown.flatFee);
  const netFee = BigInt(quote.feeBreakdown.estNetworkFee);
  const ppm = BigInt(quote.feeBreakdown.hubFeePpm);
  if (den === 0n) {
    throw new BifrostError("PRICING_UNAVAILABLE", "quote rate denominator is zero", false);
  }
  const gross = (give * num) / den;
  const expected = gross - (gross * ppm) / 1_000_000n - flat - netFee;
  const diff = expected - get;
  if (diff < 0n || diff > 1n) {
    throw new BifrostError(
      "PRICING_UNAVAILABLE",
      `quote amounts inconsistent with rate (expected ~${expected}, got ${get})`,
      false,
    );
  }

  if (request.mode === "PAY_INVOICE" && opts.invoiceAmount !== undefined) {
    if (get !== opts.invoiceAmount) {
      throw new BifrostError(
        "INVOICE_MISMATCH",
        `quote getAmount ${get} does not equal invoice amount ${opts.invoiceAmount}`,
        false,
      );
    }
  }
}

/** Advertisement freshness + signature (registry results are untrusted). */
export function verifyAdvertisement(ad: Advertisement, now: number = Date.now()): void {
  if (ad.protocol !== PROTOCOL_VERSION) {
    throw new BifrostError("INTERNAL", `unsupported protocol ${ad.protocol}`, false);
  }
  if (now >= ad.issuedAt + ad.ttlMs) {
    throw new BifrostError("INTERNAL", "advertisement expired", true);
  }
  if (!verifyAdSignature(ad)) {
    throw new BifrostError("UNAUTHORIZED", "advertisement signature verification failed", false);
  }
}
