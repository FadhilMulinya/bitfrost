/**
 * QuoteService — issues signed, expiring quotes (PROTOCOL §4.1–4.2).
 *
 * Signing: BIP-340 Schnorr over the SDK's signingDigest (RFC 8785 canonical
 * JSON + "bifrost/0.1|quote|" domain prefix). Canonicalization is IMPORTED
 * from bifrost-sdk and never reimplemented — one implementation, one truth.
 *
 * Amount arithmetic (§4.2): amounts are fully fee-inclusive and final; the
 * rounding direction is always hub-favorable by AT MOST 1 unit, and the SDK's
 * verifyQuote recomputation (§9 item 2) is the binding contract:
 *   gross    = floor(giveAmount × rate.num / rate.den)
 *   expected = gross − floor(gross × hubFeePpm / 1e6) − flatFee − estNetworkFee
 *   require    0 ≤ expected − getAmount ≤ 1
 *
 * - side=give: gross via floor, hubFee via ceil → expected−get ∈ {0,1}.
 * - side=get:  the minimal gross covering get+fees is found exactly, give is
 *   ceil'd from the strategy rate, and the PUBLISHED rate is the effective
 *   exact rational {gross, give} so the verifier's floor lands on gross —
 *   hub-favorable by construction, never beyond 1 unit.
 */
import { randomBytes } from "node:crypto";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import {
  BifrostError,
  PROTOCOL_VERSION,
  signingDigest,
  type Quote,
  type QuoteRequest,
} from "bifrost-sdk";
import type { Pair } from "bifrost-sdk";
import { mulDivCeil, mulDivFloor, normalize, type Rational } from "./rational.js";
import type { PricingContext, PricingStrategy } from "./pricing.js";

const PPM = 1_000_000n;

export interface QuoteServiceConfig {
  /** 32-byte secp256k1 secret key; hubPubkey is its x-only public key */
  privkey: Uint8Array;
  strategy: PricingStrategy;
  quoteTtlMs: number; // §4.2: SHOULD be 15–60 s
  maxIncomingHoldMs: number;
  minSafetyDeltaMs: number;
  /** static per-request estimate in get-side units */
  estNetworkFee: (req: QuoteRequest) => bigint;
  minAmount: bigint;
  maxAmount: bigint;
  supportsPair?: (pair: Pair) => boolean;
  now?: () => number;
  quoteId?: () => string;
}

export class QuoteService {
  private readonly cfg: QuoteServiceConfig;
  private readonly hubPubkey: string;

  constructor(cfg: QuoteServiceConfig) {
    this.cfg = cfg;
    this.hubPubkey = bytesToHex(schnorr.getPublicKey(cfg.privkey));
  }

  /**
   * Issue a signed quote or throw a BifrostError from the closed §7 registry.
   * `opts.invoiceAmount` is the decoded target-invoice amount (get units)
   * supplied by the API layer for PAY_INVOICE requests.
   */
  async quote(
    req: QuoteRequest,
    ctx: PricingContext,
    opts: { invoiceAmount?: bigint } = {},
  ): Promise<Quote> {
    this.validate(req, opts);

    const decision = await this.cfg.strategy.price(req, ctx);
    if (!decision.accept) {
      throw new BifrostError(decision.reason, `pricing rejected by ${this.cfg.strategy.name}`, decision.reason === "PRICING_UNAVAILABLE");
    }
    const rate = normalize(decision.rate);
    if (rate.num === 0n) {
      throw new BifrostError("PRICING_UNAVAILABLE", "strategy produced a zero rate", true);
    }
    const netFee = this.cfg.estNetworkFee(req);
    const { hubFeePpm, flatFee } = decision;

    const value = BigInt(req.amount.value);
    let giveAmount: bigint;
    let getAmount: bigint;
    let publishedRate: Rational;

    if (req.amount.side === "give") {
      giveAmount = value;
      const gross = mulDivFloor(giveAmount, rate.num, rate.den);
      const hubFee = mulDivCeil(gross, hubFeePpm, PPM); // hub-favorable
      getAmount = gross - hubFee - flatFee - netFee;
      if (getAmount <= 0n) {
        throw new BifrostError("AMOUNT_OUT_OF_BOUNDS", "amount does not cover fees", false);
      }
      publishedRate = rate;
    } else {
      getAmount = value;
      const target = getAmount + flatFee + netFee;
      // minimal gross with gross − floor(gross×ppm/1e6) ≥ target (net(gross) is
      // nondecreasing, steps of 0/1 → land near the algebraic bound, walk exact)
      let gross = mulDivCeil(target, PPM, PPM - hubFeePpm);
      const net = (g: bigint) => g - mulDivFloor(g, hubFeePpm, PPM);
      while (net(gross) < target) gross += 1n;
      while (gross > 1n && net(gross - 1n) >= target) gross -= 1n;
      giveAmount = mulDivCeil(gross, rate.den, rate.num); // client pays up
      // publish the EFFECTIVE exact rational so the verifier's floor is exact
      publishedRate = normalize({ num: gross, den: giveAmount });
    }

    // inventory admission: the hub must actually hold what it pays out
    const grossOut = mulDivFloor(giveAmount, publishedRate.num, publishedRate.den);
    if (grossOut + ctx.inFlightExposure > ctx.inventory.getAvailable) {
      throw new BifrostError("INVENTORY_INSUFFICIENT", "insufficient outbound inventory for this amount", true);
    }

    const now = (this.cfg.now ?? Date.now)();
    const unsigned: Omit<Quote, "signature"> = {
      protocol: PROTOCOL_VERSION,
      quoteId: (this.cfg.quoteId ?? defaultQuoteId)(),
      pair: req.pair,
      rate: { num: publishedRate.num.toString(), den: publishedRate.den.toString() },
      giveAmount: giveAmount.toString(),
      getAmount: getAmount.toString(),
      feeBreakdown: {
        hubFeePpm: hubFeePpm.toString(),
        flatFee: flatFee.toString(),
        estNetworkFee: netFee.toString(),
      },
      issuedAt: now,
      expiresAt: now + this.cfg.quoteTtlMs,
      maxIncomingHoldMs: this.cfg.maxIncomingHoldMs,
      minSafetyDeltaMs: this.cfg.minSafetyDeltaMs,
      hubPubkey: this.hubPubkey,
    };

    const digest = signingDigest(unsigned as unknown as Record<string, unknown>, "quote");
    const signature = bytesToHex(schnorr.sign(digest, this.cfg.privkey));
    return { ...unsigned, signature };
  }

  private validate(req: QuoteRequest, opts: { invoiceAmount?: bigint }): void {
    if (req.protocol !== PROTOCOL_VERSION) {
      throw new BifrostError("INTERNAL", `unsupported protocol ${req.protocol}; this hub speaks ${PROTOCOL_VERSION}`, false);
    }
    if (this.cfg.supportsPair && !this.cfg.supportsPair(req.pair)) {
      throw new BifrostError("PAIR_UNSUPPORTED", "pair not offered by this hub", false);
    }
    let value: bigint;
    try {
      value = BigInt(req.amount.value);
    } catch {
      throw new BifrostError("AMOUNT_OUT_OF_BOUNDS", "amount is not a base-10 integer string", false);
    }
    if (value < this.cfg.minAmount || value > this.cfg.maxAmount) {
      throw new BifrostError(
        "AMOUNT_OUT_OF_BOUNDS",
        `amount ${value} outside [${this.cfg.minAmount}, ${this.cfg.maxAmount}]`,
        false,
      );
    }
    if (req.mode === "PAY_INVOICE") {
      if (!req.targetInvoice) {
        throw new BifrostError("INVOICE_INVALID", "PAY_INVOICE requires targetInvoice", false);
      }
      // §4.1: amount MUST match the invoice amount when the invoice carries one
      if (opts.invoiceAmount !== undefined && opts.invoiceAmount !== value) {
        throw new BifrostError(
          "INVOICE_MISMATCH",
          `request amount ${value} does not match invoice amount ${opts.invoiceAmount}`,
          false,
        );
      }
    }
  }
}

/** ULID-shaped id: 48-bit ms timestamp + 80 random bits, Crockford base32. */
const B32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
function defaultQuoteId(): string {
  let ts = BigInt(Date.now());
  const time = Array.from({ length: 10 }, () => {
    const c = B32[Number(ts % 32n)]!;
    ts /= 32n;
    return c;
  }).reverse().join("");
  const rand = Array.from(randomBytes(16).subarray(0, 16), (b) => B32[b % 32]).join("");
  return time + rand;
}
