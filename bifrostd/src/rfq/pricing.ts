/**
 * PricingStrategy plugin interface + the three v0.1 strategies
 * (SYSTEM-DESIGN §4.3). Strategies compose as a chain, e.g.
 * `inventorySkew(feedSpread(...))`; rejections short-circuit and use ONLY the
 * closed error registry codes valid for quote rejection (PROTOCOL §4.2/§7).
 */
import type { QuoteRequest } from "bifrost-sdk";
import { applyPpm, normalize, rational, type Rational } from "./rational.js";

/** Quote-rejection subset of the closed §7 registry. */
export type QuoteRejectCode =
  | "PAIR_UNSUPPORTED"
  | "AMOUNT_OUT_OF_BOUNDS"
  | "INVENTORY_INSUFFICIENT"
  | "PRICING_UNAVAILABLE";

export interface InventorySnapshot {
  /** spendable balance on the asset the hub RECEIVES (give side) */
  giveAvailable: bigint;
  /** spendable balance on the asset the hub PAYS OUT (get side) */
  getAvailable: bigint;
}

export interface PricingContext {
  inventory: InventorySnapshot;
  /** sum of outgoing legs not yet settled */
  inFlightExposure: bigint;
  /** wall-clock ms (injected for testability) */
  now: number;
  /** configured price feed, if any: exact get/give rational */
  feedRate?: Rational;
  /** wall-clock ms of the feed's last update */
  feedUpdatedAt?: number;
}

export type PriceDecision =
  | { accept: true; rate: Rational; hubFeePpm: bigint; flatFee: bigint }
  | { accept: false; reason: QuoteRejectCode };

export interface PricingStrategy {
  name: string;
  price(req: QuoteRequest, ctx: PricingContext): Promise<PriceDecision>;
}

/* ---------- 1. static-peg ---------- */

export interface StaticPegConfig {
  /** fixed pre-fee rate get/give (e.g. 1:1 wBTC↔BTC parity with stock CCH) */
  rate: Rational;
  /** spread applied hub-favorably (client receives rate × (1 − spread)) */
  spreadPpm: bigint;
  hubFeePpm: bigint;
  flatFee: bigint;
}

export function staticPeg(cfg: StaticPegConfig): PricingStrategy {
  const base = rational(cfg.rate.num, cfg.rate.den);
  return {
    name: "static-peg",
    async price(): Promise<PriceDecision> {
      return {
        accept: true,
        rate: applyPpm(base, -cfg.spreadPpm),
        hubFeePpm: cfg.hubFeePpm,
        flatFee: cfg.flatFee,
      };
    },
  };
}

/* ---------- 2. feed-spread ---------- */

export interface FeedSpreadConfig {
  spreadPpm: bigint;
  /** feeds older than this are STALE → PRICING_UNAVAILABLE, never quoted */
  maxFeedAgeMs: number;
  hubFeePpm?: bigint;
  flatFee?: bigint;
}

export function feedSpread(cfg: FeedSpreadConfig): PricingStrategy {
  return {
    name: "feed-spread",
    async price(_req, ctx): Promise<PriceDecision> {
      if (ctx.feedRate === undefined || ctx.feedUpdatedAt === undefined) {
        return { accept: false, reason: "PRICING_UNAVAILABLE" };
      }
      if (ctx.now - ctx.feedUpdatedAt > cfg.maxFeedAgeMs) {
        return { accept: false, reason: "PRICING_UNAVAILABLE" };
      }
      return {
        accept: true,
        rate: applyPpm(normalize(ctx.feedRate), -cfg.spreadPpm),
        hubFeePpm: cfg.hubFeePpm ?? 0n,
        flatFee: cfg.flatFee ?? 0n,
      };
    },
  };
}

/* ---------- 3. inventory-skew (composing wrapper) ---------- */

export interface InventorySkewConfig {
  /** maximum rate adjustment at full imbalance, in ppm of the inner rate */
  maxSkewPpm: bigint;
}

/**
 * Wraps another strategy: widens the spread when this trade drains the
 * already-scarce get-side inventory, tightens it when the trade rebalances
 * the hub — quoting doubles as passive rebalancing.
 *
 * skewPpm = maxSkewPpm × (getAvailable − giveAvailable) / total, exact bigint.
 * Positive (get side overweight → trade sheds it) improves the client rate;
 * negative (get side scarce → trade drains it) worsens it. Bounded ±maxSkewPpm.
 */
export function inventorySkew(inner: PricingStrategy, cfg: InventorySkewConfig): PricingStrategy {
  return {
    name: `inventory-skew(${inner.name})`,
    async price(req, ctx): Promise<PriceDecision> {
      const d = await inner.price(req, ctx);
      if (!d.accept) return d; // rejections short-circuit untouched
      const { giveAvailable, getAvailable } = ctx.inventory;
      const total = giveAvailable + getAvailable;
      if (total <= 0n) return { accept: false, reason: "INVENTORY_INSUFFICIENT" };
      const skewPpm = (cfg.maxSkewPpm * (getAvailable - giveAvailable)) / total;
      return { ...d, rate: applyPpm(d.rate, skewPpm) };
    },
  };
}
