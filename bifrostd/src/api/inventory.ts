/**
 * Live per-network spendable liquidity, shared by GET /v1/inventory and the
 * QuoteService's PricingContext. Same formulas verified live against the
 * real nodes for the deploy/scripts smoke-liquidity preflight
 * (docs/RPC-NOTES.md "In-flight TLC amounts per channel"):
 *
 *   fiber:      spendable = local_balance  - offered_tlc_balance
 *   lightning:  spendable = local_balance  - chan_reserve - unsettled_balance
 */
import type { FiberAdapter } from "../adapters/fiber.js";
import type { LightningAdapter } from "../adapters/lightning.js";

export interface NetworkLiquidity {
  available: bigint;
  inFlight: bigint;
}

export async function fiberLiquidity(fnnHub: FiberAdapter): Promise<NetworkLiquidity> {
  const channels = await fnnHub.getChannels();
  let available = 0n;
  let inFlight = 0n;
  for (const c of channels) {
    if (c.state !== "ChannelReady") continue;
    available += c.localBalance - c.offeredTlcBalance;
    inFlight += c.offeredTlcBalance;
  }
  return { available, inFlight };
}

export async function lightningLiquidity(lndHub: LightningAdapter): Promise<NetworkLiquidity> {
  const channels = await lndHub.getChannels();
  let available = 0n;
  let inFlight = 0n;
  for (const c of channels) {
    if (!c.active) continue;
    available += c.localBalanceSat - c.localChanReserveSat - c.unsettledBalanceSat;
    inFlight += c.unsettledBalanceSat;
  }
  return { available, inFlight };
}
