/**
 * QuoteCache — bridges POST /v1/quotes (issues a signed Quote) and POST
 * /v1/orders ({quoteId} only, per sdk/src/client.ts's actual createOrder
 * call — it does not resend the pair/amount/targetInvoice). The daemon must
 * remember what a quoteId meant to redeem it later.
 *
 * v0.1: in-memory, lost on restart (matches the order store's own
 * documented gap — no SQLite yet, see bifrostd/src/orders/store.ts). A
 * restart mid-flight orphans any issued-but-not-yet-ordered quote; since
 * quotes are short-lived (seconds) this is a narrow, documented window, not
 * silently ignored.
 *
 * Also the ONLY place quote issue/accept/expire/reject counters exist —
 * QuoteService itself (rfq/quote-service.ts) is stateless per PROTOCOL
 * §4.1-4.2 and tracks nothing across calls.
 */
import type { Quote, QuoteRequest } from "bifrost-sdk";
import type { QuoteStats } from "./contract.js";

export interface CachedQuote {
  quote: Quote;
  request: QuoteRequest;
}

export class QuoteCache {
  private readonly quotes = new Map<string, CachedQuote>();
  private issued = 0;
  private accepted = 0;
  private expired = 0;
  private rejected = 0;
  private readonly windowMs: number;
  private readonly onExpired: ((quoteId: string) => void) | undefined;

  constructor(windowMs = 3_600_000, onExpired?: (quoteId: string) => void) {
    this.windowMs = windowMs;
    this.onExpired = onExpired;
  }

  /** Record a successfully issued quote so it can be redeemed by quoteId. */
  issue(quote: Quote, request: QuoteRequest): void {
    this.quotes.set(quote.quoteId, { quote, request });
    this.issued += 1;
  }

  /** Pricing/validation refused the request — never reached the wire. */
  reject(): void {
    this.rejected += 1;
  }

  /** Redeem a quoteId exactly once; undefined if unknown or already expired/swept. */
  consume(quoteId: string, now: number): CachedQuote | undefined {
    this.sweepExpired(now);
    const cached = this.quotes.get(quoteId);
    if (!cached) return undefined;
    this.quotes.delete(quoteId);
    this.accepted += 1;
    return cached;
  }

  private sweepExpired(now: number): void {
    for (const [id, cached] of this.quotes) {
      if (cached.quote.expiresAt <= now) {
        this.quotes.delete(id);
        this.expired += 1;
        this.onExpired?.(id);
      }
    }
  }

  snapshot(now: number): QuoteStats {
    this.sweepExpired(now);
    const hitRateBps = this.issued > 0 ? Math.floor((this.accepted * 10_000) / this.issued) : 0;
    return { issued: this.issued, accepted: this.accepted, expired: this.expired, rejected: this.rejected, hitRateBps, windowMs: this.windowMs };
  }
}
