/**
 * Smoke runner — drives ONE full swap through the real OrderEngine + adapters
 * against the compose dev stack (deploy/docker-compose.dev.yml), replacing
 * stock CCH with bifrostd's engine. Invoked by deploy/scripts/smoke-bifrost.sh
 * INSIDE the bifrostd container (the stack publishes no RPC to the host).
 *
 *   node dist/smoke/runner.js fiber_to_ln --amt 50000
 *   node dist/smoke/runner.js ln_to_fiber --amt 20000
 *
 * The runner plays two roles, kept separate on purpose:
 *  - the HUB: OrderEngine wired to fnn-hub (JSON-RPC/WS) + lnd-hub (REST);
 *  - the COUNTERPARTIES: fnn-client / lnd-payee driven by raw RPC, exactly
 *    what an external wallet would do. Counterparty secrets (the payee
 *    preimage in ln_to_fiber) never touch the engine — the hub must learn
 *    the preimage from its own node (I1), or the swap fails.
 *
 * Rate is 1:1 wBTC-unit:sat (the stock-CCH convention) — pricing is the RFQ
 * module's job and is unit-tested there; this exercises the money path.
 */
import { randomBytes } from "node:crypto";
import { mkdirSync } from "node:fs";
import { FiberAdapter } from "../adapters/fiber.js";
import { LightningAdapter } from "../adapters/lightning.js";
import { WsJsonRpc, HttpJsonRpc, LndRestHttp } from "../adapters/transport.js";
import type { Hash256, Script } from "../adapters/types.js";
import { encodeU128Hex, encodeU64Hex } from "../fnn/codec.js";
import { OrderEngine } from "../orders/engine.js";
import { fiberPorts, lightningPorts } from "../orders/ports.js";
import { FileOrderStore } from "../orders/store.js";
import { outgoingBlocksToMs, incomingBlocksToMs, type Order, type OrderState } from "@bifrost/sdk";

const HOUR = 3_600_000;
const env = (k: string, dflt?: string): string => {
  const v = process.env[k] ?? dflt;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};

const FNN_HUB_URL = env("FNN_HUB_URL", "http://127.0.0.1:21716");
const FNN_HUB_WS = env("FNN_HUB_WS", "ws://127.0.0.1:21716");
const FNN_CLIENT_URL = env("FNN_CLIENT_URL", "http://127.0.0.1:21714");
const LND_HUB_REST = env("LND_HUB_REST", "http://127.0.0.1:8080");
const LND_PAYEE_REST = env("LND_PAYEE_REST", "http://127.0.0.1:8180");
const MIN_SAFETY_DELTA_MS = Number(env("MIN_SAFETY_DELTA_MS", String(2 * HOUR)));
const WBTC_SCRIPT: Script = {
  code_hash: env("UDT_CODE_HASH"),
  hash_type: "data2",
  args: env("WBTC_ARGS"),
};

const log = (msg: string): void => console.log(`[smoke-runner] ${msg}`);

async function waitState(
  store: FileOrderStore,
  orderId: string,
  want: OrderState[],
  timeoutMs: number,
): Promise<Order> {
  const deadline = Date.now() + timeoutMs;
  let lastLogged = "";
  while (Date.now() < deadline) {
    const o = store.get(orderId)!;
    if (o.state !== lastLogged) {
      lastLogged = o.state;
      log(`order state → ${o.state}`);
    }
    if (want.includes(o.state)) return o;
    if (o.state === "FAILED") throw new Error(`order FAILED: ${JSON.stringify(o.failure)}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for ${want.join("|")} (stuck in ${store.get(orderId)!.state})`);
}

/** Forward an adapter event stream into the engine until aborted. */
function pump(events: AsyncIterable<Parameters<OrderEngine["onLegEvent"]>[0]>, engine: OrderEngine, label: string, ac: AbortController): void {
  void (async () => {
    try {
      for await (const ev of events) {
        if (ac.signal.aborted) return;
        log(`event[${label}]: ${ev.kind}${ev.preimage ? " (+preimage)" : ""}`);
        await engine.onLegEvent(ev);
      }
    } catch (e) {
      if (!ac.signal.aborted) log(`event pump ${label} ended: ${String(e)}`);
    }
  })();
}

async function main(): Promise<void> {
  const direction = process.argv[2];
  const amtFlag = process.argv.indexOf("--amt");
  const amount = BigInt(amtFlag > 0 ? process.argv[amtFlag + 1]! : "50000");
  if (direction !== "fiber_to_ln" && direction !== "ln_to_fiber") {
    throw new Error("usage: runner.js <fiber_to_ln|ln_to_fiber> [--amt sats]");
  }

  // --- hub side: real adapters + engine ---
  const fnnHub = new FiberAdapter({ transport: new WsJsonRpc(FNN_HUB_WS), currency: "Fibd" });
  const fnnHubHttp = new FiberAdapter({ transport: new HttpJsonRpc({ url: FNN_HUB_URL }), currency: "Fibd" });
  const lndHub = new LightningAdapter({ transport: new LndRestHttp({ baseUrl: LND_HUB_REST, allowSelfSigned: LND_HUB_REST.startsWith("https") }) });
  mkdirSync("/tmp/bifrostd-smoke", { recursive: true });
  const store = new FileOrderStore(`/tmp/bifrostd-smoke/orders-${Date.now()}.jsonl`);
  const engine = new OrderEngine({
    store,
    ports: {
      fiber: fiberPorts(fnnHubHttp, { assetScript: WBTC_SCRIPT }),
      lightning: lightningPorts(lndHub),
    },
    minSafetyDeltaMs: MIN_SAFETY_DELTA_MS,
    log: (level, msg, orderId) => log(`engine[${level}]${orderId ? ` ${orderId}` : ""}: ${msg}`),
  });
  await engine.start();

  // --- counterparties: raw RPC, as an external wallet would ---
  const fnnClient = new HttpJsonRpc({ url: FNN_CLIENT_URL });
  const lndPayee = new LndRestHttp({ baseUrl: LND_PAYEE_REST, allowSelfSigned: LND_PAYEE_REST.startsWith("https") });

  const ac = new AbortController();
  const sweeper = setInterval(() => void engine.sweepExpiries(), 10_000);

  try {
    if (direction === "fiber_to_ln") {
      await fiberToLn(engine, store, fnnHub, fnnHubHttp, lndHub, fnnClient, lndPayee, amount, ac);
    } else {
      await lnToFiber(engine, store, fnnHub, fnnHubHttp, lndHub, fnnClient, lndPayee, amount, ac);
    }
  } finally {
    ac.abort();
    clearInterval(sweeper);
    store.close();
  }
  log(`=== ${direction.toUpperCase()} SWAP SUCCEEDED THROUGH BIFROSTD ===`);
  process.exit(0);
}

async function fiberToLn(
  engine: OrderEngine,
  store: FileOrderStore,
  fnnHubWs: FiberAdapter,
  fnnHub: FiberAdapter,
  lndHub: LightningAdapter,
  fnnClient: HttpJsonRpc,
  lndPayee: LndRestHttp,
  amount: bigint,
  ac: AbortController,
): Promise<void> {
  const now = Date.now();

  log(`1. payee creates a ${amount}-sat BOLT11 invoice (lnd-payee)`);
  const inv = await lndPayee.post<{ payment_request: string; r_hash: string }>("/v1/invoices", {
    value: amount.toString(),
    expiry: "86400",
  });
  const bolt11 = inv.payment_request;
  const decoded = await lndHub.decodeInvoice(bolt11);
  const paymentHash: Hash256 = decoded.paymentHash;
  log(`   payment_hash ${paymentHash}, cltv_expiry ${decoded.cltvExpiry} blocks`);

  // outgoing budget: final CLTV + 40-block route budget, slow-block pessimism
  const outgoingDeltaMs = outgoingBlocksToMs(decoded.cltvExpiry + 40);
  const incomingDeltaMs = Math.max(16 * HOUR + HOUR, outgoingDeltaMs + MIN_SAFETY_DELTA_MS + 2 * HOUR);

  log("2. createOrder — hub issues a Fiber wBTC HOLD invoice locked to the LN hash");
  const order = await engine.createOrder({
    quoteId: "SMOKE-QUOTE",
    direction: "FIBER_TO_LN",
    paymentHash,
    incoming: { network: "fiber", amount, tlcExpiryAt: now + incomingDeltaMs }, // 1:1 wBTC:sat
    outgoing: { network: "lightning", invoice: bolt11, amount, tlcExpiryAt: now + outgoingDeltaMs },
  });
  log(`   orderId ${order.orderId}, fiber hold invoice issued`);

  pump(fnnHubWs.legEvents(), engine, "fiber-ws", ac); // incoming status + PutPreimage
  pump(fnnHub.pollLegEvents(paymentHash, "incoming", { intervalMs: 1000, signal: ac.signal }), engine, "fiber-poll", ac);

  log("3. fnn-client pays the hub's Fiber hold invoice");
  await fnnClient.call("send_payment", { invoice: order.incoming.invoice });

  await waitState(store, order.orderId, ["OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED"], 60_000);
  pump(lndHub.legEvents(paymentHash, "outgoing"), engine, "ln-track", ac);

  log("4. waiting for the swap to complete (LN payment → preimage → Fiber settle)");
  const done = await waitState(store, order.orderId, ["SUCCEEDED"], 120_000);
  if (done.incoming.preimage !== done.outgoing.preimage) throw new Error("preimage mismatch across legs");

  log("5. verifying the payee ACTUALLY received the sats");
  const settled = await lndPayee.get<{ state: string }>(`/v1/invoice/${paymentHash.slice(2)}`);
  if (settled.state !== "SETTLED") throw new Error(`payee invoice state ${settled.state}, expected SETTLED`);
  printTrail(store, done.orderId);
}

async function lnToFiber(
  engine: OrderEngine,
  store: FileOrderStore,
  fnnHubWs: FiberAdapter,
  fnnHub: FiberAdapter,
  lndHub: LightningAdapter,
  fnnClient: HttpJsonRpc,
  lndPayee: LndRestHttp,
  amount: bigint,
  ac: AbortController,
): Promise<void> {
  const now = Date.now();

  log(`1. fnn-client creates a ${amount}-unit wBTC invoice (client controls the preimage)`);
  const clientPreimage: Hash256 = `0x${randomBytes(32).toString("hex")}`;
  const created = await fnnClient.call<{ invoice_address: string; invoice: { data: { payment_hash: Hash256 } } }>("new_invoice", {
    amount: encodeU128Hex(amount),
    currency: "Fibd",
    payment_preimage: clientPreimage,
    // PROTOCOL §5: both legs MUST lock to sha256. FNN's default here is
    // ckb_hash — omitting this makes the engine (correctly) refuse to settle.
    hash_algorithm: "sha256",
    udt_type_script: WBTC_SCRIPT,
    final_expiry_delta: encodeU64Hex(BigInt(17 * HOUR)),
    description: "bifrost smoke ln_to_fiber",
  });
  const paymentHash = created.invoice.data.payment_hash;
  const fiberInvoice = created.invoice_address;
  log(`   payment_hash ${paymentHash}`);

  const outgoingDeltaMs = 18 * HOUR; // covers the 17h final TLC + route
  const incomingBlocks = Math.ceil((outgoingDeltaMs + MIN_SAFETY_DELTA_MS + 2 * HOUR) / 300_000); // fast-block pessimism
  const incomingDeltaMs = incomingBlocksToMs(incomingBlocks);

  log("2. createOrder — hub issues an LN HOLD invoice locked to the Fiber hash");
  const order = await engine.createOrder({
    quoteId: "SMOKE-QUOTE",
    direction: "LN_TO_FIBER",
    paymentHash,
    incoming: { network: "lightning", amount, tlcExpiryAt: now + incomingDeltaMs },
    outgoing: { network: "fiber", invoice: fiberInvoice, amount, tlcExpiryAt: now + outgoingDeltaMs },
  });
  log(`   orderId ${order.orderId}, LN hold invoice: ${order.incoming.invoice.slice(0, 40)}…`);

  pump(lndHub.legEvents(paymentHash, "incoming"), engine, "ln-invoice", ac);
  pump(fnnHubWs.legEvents(), engine, "fiber-ws", ac); // PutPreimage is the ONLY preimage source (I1)

  log("3. lnd-payee pays the hub's LN hold invoice (completes only after the hub settles)");
  const payeeSend = (async () => {
    for await (const frame of lndPayee.stream("/v2/router/send", {
      payment_request: order.incoming.invoice,
      fee_limit_sat: "100",
      timeout_seconds: 120,
    })) {
      const p = (frame as { result?: { status?: string } }).result;
      if (p?.status && p.status !== "IN_FLIGHT") return p.status;
    }
    return "UNKNOWN";
  })();

  await waitState(store, order.orderId, ["OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED"], 60_000);
  pump(fnnHub.pollLegEvents(paymentHash, "outgoing", { intervalMs: 1000, signal: ac.signal }), engine, "fiber-poll", ac);

  log("4. waiting for the swap to complete (Fiber payment → PutPreimage → LN settle)");
  const done = await waitState(store, order.orderId, ["SUCCEEDED"], 120_000);
  if (done.incoming.preimage !== done.outgoing.preimage) throw new Error("preimage mismatch across legs");
  if (done.incoming.preimage !== clientPreimage) throw new Error("hub settled with a preimage that is not the payee's — impossible unless I1 broke");

  log("5. verifying node-side truth: client invoice Paid, payee payment SUCCEEDED");
  const cliInv = await fnnClient.call<{ status: string }>("get_invoice", { payment_hash: paymentHash });
  if (cliInv.status !== "Paid") throw new Error(`client fiber invoice status ${cliInv.status}, expected Paid`);
  const payeeStatus = await payeeSend;
  if (payeeStatus !== "SUCCEEDED") throw new Error(`payee LN payment status ${payeeStatus}, expected SUCCEEDED`);
  printTrail(store, done.orderId);
}

function printTrail(store: FileOrderStore, orderId: string): void {
  log("state trail:");
  for (const e of store.events(orderId)) {
    log(`   ${new Date(e.at).toISOString()}  ${e.fromState ?? "·"} → ${e.toState}${e.detail ? `  (${e.detail})` : ""}`);
  }
}

main().catch((e) => {
  console.error(`[smoke-runner] FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
