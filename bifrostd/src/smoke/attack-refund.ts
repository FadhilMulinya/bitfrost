/**
 * QA attack: kill lnd-hub mid-swap and prove the refund path
 * (SYSTEM-DESIGN §5.3 / rule R3): order → REFUNDING → FAILED, and the
 * client's held Fiber TLC is actually released node-side.
 *
 * Orchestrated by deploy/scripts/qa-attack-refund.sh:
 *   1. runner creates the order (Fiber hold invoice issued), writes READY file
 *   2. bash stops lnd-hub, writes KILLED file
 *   3. runner has fnn-client pay the hold invoice → INCOMING_HELD
 *   4. dispatch to LND fails (node dead); engine stays OUTGOING_IN_FLIGHT
 *   5. expiry sweep crosses the (deliberately tight) safety threshold → R3:
 *      REFUNDING → cancel incoming hold → FAILED
 *   6. runner asserts: REFUNDING in the event trail, terminal FAILED with a
 *      registry failure code, hub invoice Cancelled, client TLC balance freed
 *
 * Expiries are engineered so the R3 window opens ~60 s after creation while
 * still satisfying I2 at creation time and FNN's ≥16 h final-expiry clamp.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { FiberAdapter } from "../adapters/fiber.js";
import { LightningAdapter } from "../adapters/lightning.js";
import { HttpJsonRpc, LndRestHttp, WsJsonRpc } from "../adapters/transport.js";
import type { Script } from "../adapters/types.js";
import { decodeU128Hex } from "../fnn/codec.js";
import { OrderEngine } from "../orders/engine.js";
import { fiberPorts, lightningPorts } from "../orders/ports.js";
import { FileOrderStore } from "../orders/store.js";

const HOUR = 3_600_000;
const env = (k: string, dflt?: string): string => {
  const v = process.env[k] ?? dflt;
  if (v === undefined) throw new Error(`missing env ${k}`);
  return v;
};
const log = (m: string): void => console.log(`[attack-refund] ${m}`);

const FNN_HUB_URL = env("FNN_HUB_URL", "http://127.0.0.1:21716");
const FNN_HUB_WS = env("FNN_HUB_WS", "ws://127.0.0.1:21716");
const FNN_CLIENT_URL = env("FNN_CLIENT_URL", "http://127.0.0.1:21714");
const LND_HUB_REST = env("LND_HUB_REST", "http://127.0.0.1:8080");
const LND_PAYEE_REST = env("LND_PAYEE_REST", "http://127.0.0.1:8180");
const SIGNAL_DIR = env("QA_SIGNAL_DIR", "/repo/deploy/.qa-attack");
const WBTC_SCRIPT: Script = { code_hash: env("UDT_CODE_HASH"), hash_type: "data2", args: env("WBTC_ARGS") };

async function waitForFile(path: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`timeout waiting for signal file ${path}`);
}

async function main(): Promise<void> {
  const amount = 5_000n;
  const now0 = Date.now();

  // R3 window opens ~60 s in: incoming = +16h150s, delta = 16h95s, outgoing = +50s.
  // Creation check: 16h150s ≥ 50s + 16h95s = 16h145s ✓ (I2 holds by 5 s).
  // Sweep condition now+delta ≥ incoming becomes true at now0+55s.
  const incomingExpiryAt = now0 + 16 * HOUR + 150_000;
  const outgoingExpiryAt = now0 + 50_000;
  const minSafetyDeltaMs = 16 * HOUR + 95_000;

  const fnnHubWs = new FiberAdapter({ transport: new WsJsonRpc(FNN_HUB_WS), currency: "Fibd" });
  const fnnHub = new FiberAdapter({ transport: new HttpJsonRpc({ url: FNN_HUB_URL }), currency: "Fibd" });
  const lndHub = new LightningAdapter({ transport: new LndRestHttp({ baseUrl: LND_HUB_REST }) });
  const lndPayee = new LndRestHttp({ baseUrl: LND_PAYEE_REST });
  const fnnClient = new HttpJsonRpc({ url: FNN_CLIENT_URL });

  mkdirSync(SIGNAL_DIR, { recursive: true });
  const store = new FileOrderStore(`${SIGNAL_DIR}/attack-orders-${now0}.jsonl`);
  const engine = new OrderEngine({
    store,
    ports: { fiber: fiberPorts(fnnHub, { assetScript: WBTC_SCRIPT }), lightning: lightningPorts(lndHub) },
    minSafetyDeltaMs,
    log: (level, msg, orderId) => log(`engine[${level}]${orderId ? ` ${orderId}` : ""}: ${msg}`),
  });
  await engine.start();

  log("1. payee invoice + decode (lnd-hub still alive)");
  const inv = await lndPayee.post<{ payment_request: string }>("/v1/invoices", { value: amount.toString(), expiry: "86400" });
  const decoded = await lndHub.decodeInvoice(inv.payment_request);

  log("2. createOrder — I2 holds at creation by a deliberate hair (5 s)");
  const order = await engine.createOrder({
    quoteId: "QA-ATTACK",
    direction: "FIBER_TO_LN",
    paymentHash: decoded.paymentHash,
    incoming: { network: "fiber", amount, tlcExpiryAt: incomingExpiryAt },
    outgoing: { network: "lightning", invoice: inv.payment_request, amount, tlcExpiryAt: outgoingExpiryAt },
  });
  log(`   orderId ${order.orderId}`);

  log("3. signalling READY — orchestrator will now kill lnd-hub");
  writeFileSync(`${SIGNAL_DIR}/ready`, order.orderId);
  await waitForFile(`${SIGNAL_DIR}/killed`, 60_000);
  log("   KILLED ack received — lnd-hub is down");

  // event pumps (fiber only; the LN side is dead, which is the point)
  const ac = new AbortController();
  const pump = (events: AsyncIterable<Parameters<OrderEngine["onLegEvent"]>[0]>, label: string): void => {
    void (async () => {
      try {
        for await (const ev of events) {
          if (ac.signal.aborted) return;
          log(`event[${label}]: ${ev.kind}`);
          await engine.onLegEvent(ev).catch((e) => log(`event[${label}] handler error: ${String(e)}`));
        }
      } catch (e) {
        if (!ac.signal.aborted) log(`pump ${label} ended: ${String(e)}`);
      }
    })();
  };
  pump(fnnHubWs.legEvents(), "fiber-ws");
  const sweeper = setInterval(() => void engine.sweepExpiries().catch((e) => log(`sweep error: ${String(e)}`)), 5_000);

  log("4. fnn-client pays the hub's Fiber hold invoice (mid-swap state)");
  await fnnClient.call("send_payment", { invoice: order.incoming.invoice });

  log("5. waiting for R3: dispatch must fail, sweep must refund");
  const deadline = Date.now() + 180_000;
  let last = "";
  for (;;) {
    const o = store.get(order.orderId)!;
    if (o.state !== last) { last = o.state; log(`   order state → ${o.state}`); }
    if (o.state === "FAILED") break;
    if (o.state === "SUCCEEDED") throw new Error("ATTACK FAILED THE WRONG WAY: swap succeeded with lnd-hub dead?!");
    if (Date.now() > deadline) throw new Error(`timeout: stuck in ${o.state}`);
    await new Promise((r) => setTimeout(r, 1_000));
  }
  ac.abort();
  clearInterval(sweeper);

  log("6. asserting the refund actually happened");
  const final = store.get(order.orderId)!;
  const trail = store.events(order.orderId).map((e) => e.toState);
  if (!trail.includes("REFUNDING")) throw new Error(`no REFUNDING in trail: ${trail.join(" → ")}`);
  if (!final.failure?.code) throw new Error("terminal FAILED order carries no failure code");
  log(`   trail: ${trail.join(" → ")}`);
  log(`   failure: ${final.failure.code} — ${final.failure.message}`);

  const invoiceStatus = await fnnHub.getInvoiceStatus(final.paymentHash);
  if (invoiceStatus !== "Cancelled") throw new Error(`hub hold invoice is ${invoiceStatus}, expected Cancelled`);
  log(`   hub hold invoice: Cancelled ✓`);

  // client's money must be free again: no offered TLC left on the channel
  const ch = await fnnClient.call<{ channels: Array<{ offered_tlc_balance: string }> }>("list_channels", { peer_id: null });
  const locked = ch.channels.reduce((acc, c) => acc + decodeU128Hex(c.offered_tlc_balance), 0n);
  if (locked !== 0n) throw new Error(`client still has ${locked} locked in offered TLCs`);
  log("   client offered-TLC balance: 0 ✓ (funds released, hub never possessed them)");

  store.close();
  log("=== REFUND PATH SURVIVED THE lnd-hub KILL (REFUNDING → FAILED, hold cancelled) ===");
  process.exit(0);
}

main().catch((e) => {
  console.error(`[attack-refund] FAILED: ${e instanceof Error ? e.stack ?? e.message : String(e)}`);
  process.exit(1);
});
