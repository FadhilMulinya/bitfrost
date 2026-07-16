# Bifrost — hackathon submission notes

*("Gone in 60ms" Fiber Network Infrastructure Hackathon)*

## The gap

Fiber ships a working cross-chain hub prototype, CCH, and it's worth being precise about what it does: `send_btc` takes a BOLT11 invoice, pulls its payment hash, and opens a Fiber hold invoice keyed to that same hash, with a hard-coded expiry rule (outgoing CLTV under half the incoming CKB TLC expiry). That's a real atomic swap — the hash-lock mechanics are sound, and we didn't have to reinvent them. But it's wired for exactly one trade: 1:1 BTC↔wBTC, one fixed rate, no pricing negotiation, no way for a wallet to discover which hub can serve it, and no operator visibility into what the hub is doing while it holds someone's money. It proves the primitive works. It isn't a protocol.

## What Bifrost adds

- **A signed RFQ protocol (`bifrost/0.1`)** — quotes are BIP-340-signed, canonical-JSON, and expire in seconds; a client verifies before trusting, instead of taking a hub's word for a rate.
- **Multi-asset, both directions** — any Fiber UDT ⇄ Lightning sat pair a hub chooses to offer, priced by one of three composable strategies (static peg, feed-spread with staleness rejection, inventory-skew), not one number baked into client source.
- **A discovery registry** — hubs publish signed advertisements; a wallet queries `GET /ads?give=&get=&amount=` instead of needing a hub's URL hard-coded ahead of time.
- **A TypeScript SDK (`bifrost-sdk`)** — `payAnyInvoice()` is the whole integration surface: detect the invoice, get a verified quote, create the order, watch it settle. The §9 client checklist (signature, amount recomputation, timelock satisfiability) is enforced in the SDK, not left as an exercise for the integrator.
- **An operator gateway and dashboard** — a real HTTP+WS API backed by the actual `OrderEngine`, and a UI showing live order state, real spendable liquidity, quote hit-rate, and ExpiryGuard rejections — because holding other people's in-flight funds means you need to see what's happening, not tail logs.

## The hardest problem: the expiry invariant

The one rule that actually matters is this: **`incoming.tlcExpiryAt ≥ outgoing.tlcExpiryAt + minSafetyDeltaMs`**. If it's violated, there's a window where the outgoing leg can settle *after* the incoming leg has already been refunded — the hub pays out and never gets paid. That's not a bug class, it's the whole risk of running a hub.

The reason this is hard isn't the inequality — it's that the two legs don't speak the same clock. Fiber TLC expiries are wall-clock milliseconds; Lightning CLTV is block heights. Converting between them isn't one constant, because a naive `blocks × 600s` average is wrong in both directions depending on which side of the inequality you're shrinking. We convert asymmetrically on purpose: the *outgoing* leg's CLTV gets the slow-block, pessimistic estimate (`×600_000ms` — the hold looks longer than it might be, conservative for a leg you're about to be exposed on), and the *incoming* leg's hold window gets the fast-block estimate (`×300_000ms` — the safety margin looks shorter than it might be). Flip that asymmetry and the invariant check becomes the hole: a safety margin that's optimistic exactly where it needs to be pessimistic.

We didn't trust ourselves to get this right by eyeballing it. It's re-checked twice — at order creation, and again immediately before the outgoing leg dispatches, since block time keeps moving in between — and it's exercised by a seeded property test that adversarially generates boundary expiries and conversion directions to try to slip past the guard. It passes. That doesn't mean it's uncrackable; it means the property we cared most about proving is the one we spent the most adversarial effort trying to break.

## What's working vs. production-gap

Full component-by-component honesty table: **[`docs/STATUS.md`](./STATUS.md)**.

The short version: the protocol, SDK, `OrderEngine` state machine (all five normative rules, all four crash-recovery invariants), RFQ pricing, registry, and the `api/` gateway are real and verified live against actual Fiber and Lightning nodes — not mocked, not simulated. The honest gaps: no API-key auth or rate limiting yet (single-operator, localhost-bound for now), no webhook delivery, quote state is in-memory (a hub restart loses in-flight *unredeemed* quotes, not orders — those recover via the crash-recovery path), and persistence is an append-only JSONL log rather than the spec'd SQLite schema. None of these are silent — they're the exact things `docs/STATUS.md` calls out by name.

## Roadmap

- **PTLC swaps.** The adapter layer already parameterizes hash algorithm instead of hard-coding sha256 specifically so this doesn't require a rewrite later — it's a seam we built in, not a TODO we're hoping to get to.
- **Gossip-based ad distribution.** The registry's signed `Advertisement` schema doesn't care where it's transported; v0.1 is a single hosted indexer on purpose, and the same signed payload moves over Fiber's gossip extension or Nostr relays without a schema change once that matters.
- **Virtual channels.** CKB's programmability supports full Perun-style virtual channels in a way Bitcoin's script can't express. Bifrost's hub topology — one party already routing value between two networks — is a plausible substrate for that, but it's a research track, not a claim we're making today.
- **An agentic 402 gateway.** `payAnyInvoice()` already collapses "find a rate, prove it, pay it" into one call; HTTP 402 Payment Required as a machine-readable challenge in front of that same flow would let an AI agent pay for an API call the same way a wallet pays an invoice today. Newest idea on this list, least baked — flagged here as a direction, not a promise.
