import { BifrostError } from "bifrost-sdk";

// Human-readable text for the closed PROTOCOL.md §7 error-code registry.
const MESSAGES = {
  PAIR_UNSUPPORTED: "This hub doesn't support that asset pair.",
  AMOUNT_OUT_OF_BOUNDS: "That amount is outside what this hub will quote.",
  INVENTORY_INSUFFICIENT: "The hub doesn't have enough liquidity for this payment right now.",
  PRICING_UNAVAILABLE: "Pricing is temporarily unavailable — try again shortly.",
  INVOICE_INVALID: "That doesn't look like a valid invoice.",
  INVOICE_MISMATCH: "The invoice amount doesn't match the requested amount.",
  HASH_ALGO_UNSUPPORTED: "This invoice uses an unsupported hash algorithm.",
  QUOTE_EXPIRED: "That quote expired — please get a new one.",
  QUOTE_UNKNOWN: "That quote is unknown or was already used — please get a new one.",
  EXPIRY_INVARIANT_VIOLATION: "The invoice's timelock is too tight for a safe swap.",
  NO_ROUTE: "No route to the destination — the invoice may lack inbound capacity.",
  OUTGOING_TIMEOUT: "The payment timed out on the way to the merchant.",
  OUTGOING_FAILED: "The payment to the merchant failed.",
  HUB_OVEREXPOSED: "The hub can't take on this payment right now — try a smaller amount.",
  RATE_LIMITED: "Too many requests — please wait a moment and try again.",
  UNAUTHORIZED: "This request could not be authorized.",
  INTERNAL: "Something went wrong on the hub's side.",
};

export function humanError(err) {
  if (err instanceof BifrostError) {
    return MESSAGES[err.code] ?? err.message;
  }
  return err?.message ?? "Something went wrong.";
}
