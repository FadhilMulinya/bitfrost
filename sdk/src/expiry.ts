/**
 * Expiry semantics (PROTOCOL §6). The ONLY module that converts Lightning
 * CLTV block heights to wall-clock ms. Conversion is deliberately asymmetric:
 * always in the direction that SHRINKS the apparent safety gap.
 */

/** Slow-block pessimism when the OUTGOING leg's timelock is in blocks. */
export const OUTGOING_MS_PER_BLOCK = 600_000;
/** Fast-block pessimism when the INCOMING leg's timelock is in blocks. */
export const INCOMING_MS_PER_BLOCK = 300_000;

/** Outgoing-side CLTV → wall-clock ms (overestimates how long the outgoing leg can hang). */
export function outgoingBlocksToMs(blocks: number): number {
  return blocks * OUTGOING_MS_PER_BLOCK;
}

/** Incoming-side CLTV → wall-clock ms (underestimates how long the incoming hold really lasts). */
export function incomingBlocksToMs(blocks: number): number {
  return blocks * INCOMING_MS_PER_BLOCK;
}

export interface LegExpiryInput {
  /** wall-clock ms expiry (Fiber), mutually exclusive with blocksFromNow */
  tlcExpiryAt?: number;
  /** Lightning CLTV delta in blocks from `now` */
  blocksFromNow?: number;
}

/** Normalize a leg expiry to wall-clock ms using the conservative conversion for its side. */
export function normalizeLegExpiry(
  leg: LegExpiryInput,
  side: "incoming" | "outgoing",
  now: number,
): number {
  if (leg.tlcExpiryAt !== undefined) return leg.tlcExpiryAt;
  if (leg.blocksFromNow !== undefined) {
    const perBlock = side === "incoming" ? INCOMING_MS_PER_BLOCK : OUTGOING_MS_PER_BLOCK;
    return now + leg.blocksFromNow * perBlock;
  }
  throw new Error("leg expiry requires tlcExpiryAt or blocksFromNow");
}

/** PROTOCOL §6 invariant: incoming ≥ outgoing + minSafetyDeltaMs, conservatively converted. */
export function expiryInvariantHolds(
  incoming: LegExpiryInput,
  outgoing: LegExpiryInput,
  minSafetyDeltaMs: number,
  now: number,
): boolean {
  const inMs = normalizeLegExpiry(incoming, "incoming", now);
  const outMs = normalizeLegExpiry(outgoing, "outgoing", now);
  return inMs >= outMs + minSafetyDeltaMs;
}
