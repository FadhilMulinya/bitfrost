/**
 * bifrostd entrypoint — wires the real Fiber/Lightning adapters, the
 * OrderEngine, the QuoteService, and the api/ HTTP+WS gateway into one
 * long-running process. Env conventions and defaults mirror
 * bifrostd/src/smoke/runner.ts exactly (same compose network, same ports)
 * so this can run inside the SAME `bifrostd` compose container.
 *
 *   node dist/index.js
 *
 * See docs/STATUS.md for what's real vs. simplified in this v0.1 (no auth,
 * no webhooks, in-memory quote cache, staticPeg pricing only).
 */
import { FiberAdapter } from "./adapters/fiber.js";
import { LightningAdapter } from "./adapters/lightning.js";
import { WsJsonRpc, HttpJsonRpc, LndRestHttp } from "./adapters/transport.js";
import type { Script } from "./adapters/types.js";
import { startApiServer } from "./api/server.js";
import { SwapCoordinator } from "./api/coordinator.js";
import { OrderEngine } from "./orders/engine.js";
import { fiberPorts, lightningPorts } from "./orders/ports.js";
import { FileOrderStore } from "./orders/store.js";
import { QuoteService, staticPeg, rational } from "./rfq/index.js";

const HOUR = 3_600_000;
const env = (k: string, dflt?: string): string => {
  const v = process.env[k] ?? dflt;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const FNN_HUB_URL = env("FNN_HUB_URL", "http://127.0.0.1:21716");
const FNN_HUB_WS = env("FNN_HUB_WS", "ws://127.0.0.1:21716");
const LND_HUB_REST = env("LND_HUB_REST", "http://127.0.0.1:8080");
const MIN_SAFETY_DELTA_MS = Number(env("MIN_SAFETY_DELTA_MS", String(2 * HOUR)));
const MAX_INCOMING_HOLD_MS = Number(env("MAX_INCOMING_HOLD_MS", String(21 * HOUR))); // covers the 16-21h FNN hold window used across this repo
const API_PORT = Number(env("API_PORT", "8391"));
const API_HOST = env("API_HOST", "127.0.0.1");
const WBTC_SCRIPT: Script = {
  code_hash: env("UDT_CODE_HASH"),
  hash_type: "data2",
  args: env("WBTC_ARGS"),
};

// DEV-ONLY signing key (throwaway, same convention as the vendored fiber dev
// keys in deploy/vendor — never used for real funds). Override with
// BIFROST_HUB_SIGNING_KEY (64 hex chars) for a stable pubkey across restarts;
// otherwise a fresh key is generated every start (fine for local dev: quotes
// are self-verified by the SDK against the pubkey embedded in the same
// response, no external registry trust is involved yet).
function hubSigningKey(): Uint8Array {
  const hex = process.env["BIFROST_HUB_SIGNING_KEY"];
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) throw new Error("BIFROST_HUB_SIGNING_KEY must be 64 hex chars");
    return Buffer.from(hex, "hex");
  }
  return crypto.getRandomValues(new Uint8Array(32));
}

const log = (msg: string): void => console.log(`[bifrostd] ${msg}`);

async function main(): Promise<void> {
  const fnnHubWs = new FiberAdapter({ transport: new WsJsonRpc(FNN_HUB_WS), currency: "Fibd" });
  const fnnHubHttp = new FiberAdapter({ transport: new HttpJsonRpc({ url: FNN_HUB_URL }), currency: "Fibd" });
  const lndHub = new LightningAdapter({ transport: new LndRestHttp({ baseUrl: LND_HUB_REST, allowSelfSigned: LND_HUB_REST.startsWith("https") }) });

  const store = new FileOrderStore(env("ORDER_STORE_PATH", "/tmp/bifrostd/orders.jsonl"));
  const engine = new OrderEngine({
    store,
    ports: {
      fiber: fiberPorts(fnnHubHttp, { assetScript: WBTC_SCRIPT }),
      lightning: lightningPorts(lndHub),
    },
    minSafetyDeltaMs: MIN_SAFETY_DELTA_MS,
    log: (level, msg, orderId) => log(`engine[${level}]${orderId ? ` ${orderId}` : ""}: ${msg}`),
  });

  const quoteService = new QuoteService({
    privkey: hubSigningKey(),
    // 1:1 wBTC-unit:sat parity, no spread/fee — the stock-CCH demo
    // convention (see smoke/runner.ts). Feed-backed / inventory-skew
    // strategies are unit-tested (rfq/) but not wired to this gateway yet.
    strategy: staticPeg({ rate: rational(1n, 1n), spreadPpm: 0n, hubFeePpm: 0n, flatFee: 0n }),
    quoteTtlMs: Number(env("QUOTE_TTL_MS", "30000")),
    maxIncomingHoldMs: MAX_INCOMING_HOLD_MS,
    minSafetyDeltaMs: MIN_SAFETY_DELTA_MS,
    estNetworkFee: () => 0n,
    minAmount: 1n,
    maxAmount: BigInt(env("MAX_QUOTE_AMOUNT", "100000000")),
  });

  await engine.start();
  log(`engine started, ${store.list().length} orders recovered`);

  const coordinator = new SwapCoordinator({
    engine,
    store,
    fnnHubWs,
    fnnHubHttp,
    lndHub,
    onOrderChanged: () => undefined, // api/server.ts wires its own broadcast via the same store/coordinator instance
    log,
  });
  const rootAc = new AbortController();
  coordinator.startGlobalPumps(rootAc.signal);
  // re-attach pumps for anything I4 recovery left non-terminal
  for (const order of store.list()) {
    if (order.state !== "SUCCEEDED" && order.state !== "FAILED") coordinator.watchOrder(order);
  }

  const sweepTimer = setInterval(() => void engine.sweepExpiries(), 10_000);

  const api = startApiServer({
    port: API_PORT,
    host: API_HOST,
    engine,
    store,
    coordinator,
    quoteService,
    fnnHub: fnnHubHttp,
    lndHub,
    minSafetyDeltaMs: MIN_SAFETY_DELTA_MS,
    maxIncomingHoldMs: MAX_INCOMING_HOLD_MS,
    log,
  });
  log(`api listening on http://${API_HOST}:${API_PORT} (WS /v1/stream)`);

  const shutdown = async (): Promise<void> => {
    log("shutting down");
    clearInterval(sweepTimer);
    rootAc.abort();
    await api.close();
    store.close();
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  console.error(`[bifrostd] FATAL: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.exit(1);
});
