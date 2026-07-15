/**
 * OrderEngine invariant tests — written BEFORE the engine (CLAUDE.md: encode
 * each invariant as a property test first). Invariants under test:
 *
 *   I1 (atomicity)      — incoming never settled before a VERIFIED outgoing
 *                         preimage (sha256(P) == H) exists; engine state must
 *                         be OUTGOING_SETTLED at the settle call (rule R1).
 *   I2 (timelock order) — incoming.tlcExpiryAt ≥ outgoing.tlcExpiryAt + delta
 *                         at creation (reject) and before dispatch (R3).
 *   I3 (single-flight)  — at most one outgoing dispatch per paymentHash, even
 *                         under duplicate/concurrent events (rules R2+R4).
 *   I4 (crash recovery) — transitions persisted before side effects (R5);
 *                         a restarted engine reconciles against node truth
 *                         without double-dispatch or unverified settles.
 *
 * Property style: seeded PRNG (mulberry32) over randomized adversarial event
 * sequences — wrong preimages, duplicates, reordering, crash points.
 */
import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import type { Order } from "bifrost-sdk";
import { OrderEngine, type CreateOrderParams } from "../src/orders/engine.js";
import { MemoryOrderStore, FileOrderStore } from "../src/orders/store.js";
import type { HoldPort, PayPort, NetworkPorts, HoldInvoiceState, PaymentStateResult } from "../src/orders/ports.js";
import type { Hash256, SwapLegEvent } from "../src/adapters/types.js";

/* ---------------- deterministic PRNG ---------------- */

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T,>(rnd: () => number, arr: T[]): T => arr[Math.floor(rnd() * arr.length)]!;
const shuffle = <T,>(rnd: () => number, arr: T[]): T[] => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j]!, a[i]!];
  }
  return a;
};

function hashPair(): { preimage: Hash256; hash: Hash256 } {
  const pre = randomBytes(32);
  return {
    preimage: `0x${pre.toString("hex")}`,
    hash: `0x${createHash("sha256").update(pre).digest("hex")}`,
  };
}

/* ---------------- fake node + ports ---------------- */

interface SettleCall { hash: Hash256; preimage: Hash256; engineStateAtCall: string }

/** Simulated node-side truth shared by hold + pay fakes for one network. */
class FakeNode {
  invoices = new Map<Hash256, HoldInvoiceState>();
  payments = new Map<Hash256, PaymentStateResult>();
  settleCalls: SettleCall[] = [];
  cancelCalls: Hash256[] = [];
  payCalls: string[] = [];
  /** hook so tests can observe persisted state at side-effect time (R5) */
  onPay?: (invoice: string) => void;
  payFails = false;
  cancelFailsOnce = false;

  constructor(private readonly stateOf: (hash: Hash256) => string) {}

  hold(): HoldPort {
    return {
      createHoldInvoice: async (p) => {
        this.invoices.set(p.paymentHash, "OPEN");
        return `fakeinv-${p.paymentHash.slice(2, 10)}`;
      },
      settle: async (hash, preimage) => {
        // node-side check mirrors FNN/LND: wrong preimage refused
        const expect = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
        this.settleCalls.push({ hash, preimage, engineStateAtCall: this.stateOf(hash) });
        if (expect !== hash) throw new Error("node refused: preimage does not match hash");
        this.invoices.set(hash, "SETTLED");
      },
      cancel: async (hash) => {
        this.cancelCalls.push(hash);
        if (this.cancelFailsOnce) {
          this.cancelFailsOnce = false;
          throw new Error("node unavailable");
        }
        this.invoices.set(hash, "CANCELLED");
      },
      invoiceState: async (hash) => this.invoices.get(hash) ?? "UNKNOWN",
    };
  }

  pay(): PayPort {
    return {
      pay: async (invoice) => {
        this.payCalls.push(invoice);
        this.onPay?.(invoice);
        if (this.payFails) throw new Error("dispatch refused");
      },
      paymentState: async (hash) => this.payments.get(hash) ?? { status: "NONE" },
    };
  }
}

function makeHarness(opts: { store?: MemoryOrderStore | FileOrderStore; minSafetyDeltaMs?: number; now?: () => number } = {}) {
  const store = opts.store ?? new MemoryOrderStore();
  const getState = (hash: Hash256) => store.getByHash(hash)?.state ?? "<none>";
  const fiber = new FakeNode(getState);
  const lightning = new FakeNode(getState);
  const ports: Record<"fiber" | "lightning", NetworkPorts> = {
    fiber: { hold: fiber.hold(), pay: fiber.pay() },
    lightning: { hold: lightning.hold(), pay: lightning.pay() },
  };
  const engine = new OrderEngine({
    store,
    ports,
    minSafetyDeltaMs: opts.minSafetyDeltaMs ?? 7_200_000,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { engine, store, fiber, lightning };
}

const NOW = 1_752_500_000_000;

function orderParams(hash: Hash256, over: Partial<CreateOrderParams> = {}): CreateOrderParams {
  return {
    quoteId: "01QUOTE00001",
    direction: "FIBER_TO_LN",
    paymentHash: hash,
    incoming: { network: "fiber", amount: 26_000_000n, tlcExpiryAt: NOW + 86_400_000 },
    outgoing: { network: "lightning", invoice: "lnbcrt10u1fake", amount: 1_000n, tlcExpiryAt: NOW + 43_200_000 },
    ...over,
  };
}

const ev = (
  kind: SwapLegEvent["kind"],
  hash: Hash256,
  network: "fiber" | "lightning",
  preimage?: Hash256,
): SwapLegEvent => ({
  network,
  paymentHash: hash,
  kind,
  ...(preimage ? { preimage } : {}),
  observedAt: NOW,
});

/* =============================== I1 =============================== */

describe("I1 / R1 — incoming settles only after verified outgoing preimage", () => {
  it("property: across random adversarial event sequences, every settle call carries sha256(P)==H and fires only in OUTGOING_SETTLED", async () => {
    for (let iter = 0; iter < 150; iter++) {
      const rnd = mulberry32(1000 + iter);
      const { engine, fiber, lightning } = makeHarness({ now: () => NOW });
      await engine.start();
      const { preimage, hash } = hashPair();
      const wrong = hashPair().preimage;
      await engine.createOrder(orderParams(hash));

      // adversarial pool: correct/wrong/missing preimages, dupes, cancels
      const pool: SwapLegEvent[] = [
        ev("INCOMING_HELD", hash, "fiber"),
        ev("INCOMING_HELD", hash, "fiber"),
        ev("OUTGOING_SETTLED", hash, "lightning", wrong), // attacker/garbled
        ev("OUTGOING_SETTLED", hash, "lightning"), // settled-no-preimage (fiber poll shape)
        ev("OUTGOING_SETTLED", hash, "lightning", preimage),
        ev("OUTGOING_FAILED", hash, "lightning"),
        ev("INCOMING_CANCELLED", hash, "fiber"),
        ev("INCOMING_SETTLED", hash, "fiber"),
      ];
      const seq = shuffle(rnd, pool).slice(0, 2 + Math.floor(rnd() * pool.length));
      for (const e of seq) await engine.onLegEvent(e).catch(() => undefined);

      for (const call of fiber.settleCalls) {
        const digest = `0x${createHash("sha256").update(Buffer.from(call.preimage.slice(2), "hex")).digest("hex")}`;
        expect(digest, `iter ${iter}: settle with unverified preimage`).toBe(hash);
        expect(
          ["OUTGOING_SETTLED", "SUCCEEDED"],
          `iter ${iter}: settle fired in state ${call.engineStateAtCall}`,
        ).toContain(call.engineStateAtCall);
      }
      expect(lightning.settleCalls.length).toBe(0); // outgoing side is never "settled" by us
    }
  });

  it("a wrong-preimage OUTGOING_SETTLED event never settles and never marks the order settled", async () => {
    const { engine, fiber, store } = makeHarness({ now: () => NOW });
    await engine.start();
    const { hash } = hashPair();
    const wrong = hashPair().preimage;
    await engine.createOrder(orderParams(hash));
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    await engine.onLegEvent(ev("OUTGOING_SETTLED", hash, "lightning", wrong));
    expect(fiber.settleCalls.length).toBe(0);
    expect(store.getByHash(hash)!.state).toBe("OUTGOING_IN_FLIGHT");
  });

  it("OUTGOING_SETTLED without a preimage (fiber poll path) parks the order until PutPreimage arrives", async () => {
    const { engine, fiber, lightning, store } = makeHarness({ now: () => NOW });
    await engine.start();
    const { preimage, hash } = hashPair();
    await engine.createOrder(orderParams(hash, {
      direction: "LN_TO_FIBER",
      incoming: { network: "lightning", amount: 1_000n, tlcExpiryAt: NOW + 86_400_000 },
      outgoing: { network: "fiber", invoice: "fibd1fake", amount: 26_000_000n, tlcExpiryAt: NOW + 43_200_000 },
    }));
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "lightning"));
    expect(fiber.payCalls.length).toBe(1); // outgoing dispatched on fiber after HELD
    await engine.onLegEvent(ev("OUTGOING_SETTLED", hash, "fiber")); // no preimage yet
    expect(store.getByHash(hash)!.state).toBe("OUTGOING_IN_FLIGHT");
    expect(lightning.settleCalls.length).toBe(0); // I1: nothing to verify yet
    await engine.onLegEvent(ev("OUTGOING_SETTLED", hash, "fiber", preimage)); // PutPreimage
    const o = store.getByHash(hash)!;
    expect(o.state).toBe("SUCCEEDED");
    expect(o.incoming.preimage).toBe(preimage);
    expect(lightning.settleCalls.length).toBe(1);
  });
});

/* =============================== I2 =============================== */

describe("I2 / R3 — timelock ordering", () => {
  it("property: createOrder rejects exactly when incoming < outgoing + minSafetyDeltaMs", async () => {
    const delta = 7_200_000;
    for (let iter = 0; iter < 200; iter++) {
      const rnd = mulberry32(2000 + iter);
      const { engine } = makeHarness({ now: () => NOW, minSafetyDeltaMs: delta });
      await engine.start();
      const { hash } = hashPair();
      const outExp = NOW + Math.floor(rnd() * 100_000_000);
      const gap = Math.floor(rnd() * 4 - 2) * delta + Math.floor(rnd() * 1000); // straddles the boundary
      const inExp = outExp + gap;
      const shouldReject = inExp < outExp + delta;
      const attempt = engine.createOrder(orderParams(hash, {
        incoming: { network: "fiber", amount: 1n, tlcExpiryAt: inExp },
        outgoing: { network: "lightning", invoice: "lnbcrt1fake", amount: 1n, tlcExpiryAt: outExp },
      }));
      if (shouldReject) {
        await expect(attempt, `iter ${iter} in=${inExp} out=${outExp}`).rejects.toMatchObject({ code: "EXPIRY_INVARIANT_VIOLATION" });
      } else {
        await expect(attempt, `iter ${iter}`).resolves.toBeDefined();
      }
    }
  });

  it("re-evaluates before dispatch: an order whose incoming expiry has drifted too close refunds instead of dispatching (R3)", async () => {
    let now = NOW;
    const { engine, fiber, lightning, store } = makeHarness({ now: () => now, minSafetyDeltaMs: 7_200_000 });
    await engine.start();
    const { hash } = hashPair();
    await engine.createOrder(orderParams(hash, {
      incoming: { network: "fiber", amount: 1n, tlcExpiryAt: NOW + 50_400_000 },
      outgoing: { network: "lightning", invoice: "lnbcrt1fake", amount: 1n, tlcExpiryAt: NOW + 43_200_000 },
    }));
    now = NOW + 46_000_000; // now + delta ≥ incoming expiry
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    expect(lightning.payCalls.length).toBe(0);
    const order = store.getByHash(hash)!;
    expect(order.state).toBe("FAILED"); // cancel confirmed synchronously → terminal
    expect(store.events(order.orderId).map((e) => e.toState)).toContain("REFUNDING"); // R5: transition persisted before cancel
    expect(fiber.cancelCalls).toContain(hash);
  });

  it("sweepExpiries drives held orders past the safety threshold into REFUNDING and cancels the hold", async () => {
    let now = NOW;
    const { engine, fiber, store } = makeHarness({ now: () => now });
    await engine.start();
    const { hash } = hashPair();
    await engine.createOrder(orderParams(hash));
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    expect(store.getByHash(hash)!.state).toBe("OUTGOING_IN_FLIGHT");
    now = NOW + 86_400_000; // beyond incoming expiry
    await engine.sweepExpiries();
    const order = store.getByHash(hash)!;
    expect(order.state).toBe("FAILED");
    expect(store.events(order.orderId).map((e) => e.toState)).toContain("REFUNDING");
    expect(fiber.cancelCalls).toContain(hash);
  });
});

/* =============================== I3 =============================== */

describe("I3 / R2+R4 — single outgoing dispatch per paymentHash", () => {
  it("property: duplicate + concurrent INCOMING_HELD events yield exactly one pay() call", async () => {
    for (let iter = 0; iter < 100; iter++) {
      const rnd = mulberry32(3000 + iter);
      const { engine, lightning } = makeHarness({ now: () => NOW });
      await engine.start();
      const { hash } = hashPair();
      await engine.createOrder(orderParams(hash));
      const n = 2 + Math.floor(rnd() * 6);
      await Promise.all(
        Array.from({ length: n }, () => engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber")).catch(() => undefined)),
      );
      expect(lightning.payCalls.length, `iter ${iter}: ${n} held events`).toBe(1);
    }
  });

  it("R2: no dispatch before INCOMING_HELD — outgoing events in PENDING never trigger pay()", async () => {
    const { engine, lightning } = makeHarness({ now: () => NOW });
    await engine.start();
    const { preimage, hash } = hashPair();
    await engine.createOrder(orderParams(hash));
    await engine.onLegEvent(ev("OUTGOING_SETTLED", hash, "lightning", preimage)).catch(() => undefined);
    await engine.onLegEvent(ev("OUTGOING_FAILED", hash, "lightning")).catch(() => undefined);
    expect(lightning.payCalls.length).toBe(0);
  });

  it("R3: definitive outgoing failure → REFUNDING (persisted) → cancel incoming → FAILED", async () => {
    const { engine, fiber, store } = makeHarness({ now: () => NOW });
    await engine.start();
    const { hash } = hashPair();
    await engine.createOrder(orderParams(hash));
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    await engine.onLegEvent(ev("OUTGOING_FAILED", hash, "lightning"));
    const o = store.getByHash(hash)!;
    expect(store.events(o.orderId).map((e) => e.toState)).toContain("REFUNDING");
    expect(fiber.cancelCalls).toContain(hash);
    expect(o.state).toBe("FAILED");
    expect(o.failure?.code).toBeDefined();
  });

  it("R3: when the cancel RPC fails, the order stays in REFUNDING until the cancel event/recovery confirms", async () => {
    const { engine, fiber, store } = makeHarness({ now: () => NOW });
    await engine.start();
    const { hash } = hashPair();
    await engine.createOrder(orderParams(hash));
    fiber.cancelFailsOnce = true;
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    await engine.onLegEvent(ev("OUTGOING_FAILED", hash, "lightning"));
    expect(store.getByHash(hash)!.state).toBe("REFUNDING"); // parked, not falsely FAILED
    await engine.onLegEvent(ev("INCOMING_CANCELLED", hash, "fiber")); // node-side expiry confirms
    expect(store.getByHash(hash)!.state).toBe("FAILED");
  });
});

/* =============================== I4 / R5 =============================== */

describe("I4 / R5 — durability and crash recovery", () => {
  it("R5: the OUTGOING_IN_FLIGHT transition is persisted BEFORE pay() is invoked", async () => {
    const { engine, store, lightning } = makeHarness({ now: () => NOW });
    await engine.start();
    const { hash } = hashPair();
    let stateAtPay = "";
    lightning.onPay = () => { stateAtPay = store.getByHash(hash)!.state; };
    await engine.createOrder(orderParams(hash));
    await engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber"));
    expect(stateAtPay).toBe("OUTGOING_IN_FLIGHT");
  });

  it("property: crash at a random persisted point + recover() against node truth → consistent terminal outcome, no double dispatch, no unverified settle", async () => {
    for (let iter = 0; iter < 100; iter++) {
      const rnd = mulberry32(4000 + iter);
      const dir = mkdtempSync(join(tmpdir(), "bifrost-i4-"));
      const file = join(dir, "orders.jsonl");
      const { preimage, hash } = hashPair();

      // phase 1: run up to a random crash point
      const store1 = new FileOrderStore(file);
      const h1 = makeHarness({ store: store1, now: () => NOW });
      await h1.engine.start();
      await h1.engine.createOrder(orderParams(hash));
      const steps: SwapLegEvent[] = [
        ev("INCOMING_HELD", hash, "fiber"),
        ev("OUTGOING_SETTLED", hash, "lightning", preimage),
      ];
      const crashAfter = Math.floor(rnd() * (steps.length + 1));
      for (const e of steps.slice(0, crashAfter)) await h1.engine.onLegEvent(e).catch(() => undefined);
      const payCallsBefore = h1.lightning.payCalls.length;
      // "crash": drop engine; node-side truth carries over
      store1.close();

      // phase 2: fresh engine + store over the SAME file; fake node reflects reality
      const store2 = new FileOrderStore(file);
      const h2 = makeHarness({ store: store2, now: () => NOW });
      // seed node truth from phase 1
      h2.fiber.invoices = h1.fiber.invoices;
      h2.lightning.payments = h1.lightning.payments;
      if (payCallsBefore > 0) {
        // dispatched before crash: node either settled it or has it in flight
        const settled = crashAfter >= 2 || rnd() < 0.5;
        h2.lightning.payments.set(hash, settled ? { status: "SUCCEEDED", preimage } : { status: "IN_FLIGHT" });
      }
      await h2.engine.start(); // runs recovery before accepting work

      const o = store2.getByHash(hash)!;
      const totalPays = payCallsBefore + h2.lightning.payCalls.length;
      expect(totalPays, `iter ${iter}: double dispatch`).toBeLessThanOrEqual(1 + 0); // node truth NONE → exactly one re-dispatch is the only legal duplicate
      for (const call of [...h1.fiber.settleCalls, ...h2.fiber.settleCalls]) {
        const digest = `0x${createHash("sha256").update(Buffer.from(call.preimage.slice(2), "hex")).digest("hex")}`;
        expect(digest, `iter ${iter}: unverified settle after recovery`).toBe(hash);
      }
      if (h2.lightning.payments.get(hash)?.status === "SUCCEEDED") {
        expect(o.state, `iter ${iter}: settled payment must recover to SUCCEEDED`).toBe("SUCCEEDED");
        expect(o.incoming.preimage).toBe(preimage);
      }
      store2.close();
    }
  });

  it("recovery re-dispatches when the node has NO record of a persisted IN_FLIGHT dispatch (definitive-absence signal)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-i4b-"));
    const file = join(dir, "orders.jsonl");
    const { hash } = hashPair();
    const store1 = new FileOrderStore(file);
    const h1 = makeHarness({ store: store1, now: () => NOW });
    await h1.engine.start();
    await h1.engine.createOrder(orderParams(hash));
    h1.lightning.payFails = true; // crash exactly between persist and node ack
    await h1.engine.onLegEvent(ev("INCOMING_HELD", hash, "fiber")).catch(() => undefined);
    expect(store1.getByHash(hash)!.state).toBe("OUTGOING_IN_FLIGHT");
    store1.close();

    const store2 = new FileOrderStore(file);
    const h2 = makeHarness({ store: store2, now: () => NOW });
    h2.fiber.invoices = h1.fiber.invoices; // incoming still held node-side
    h2.fiber.invoices.set(hash, "HELD");
    await h2.engine.start();
    expect(h2.lightning.payCalls.length).toBe(1); // exactly one re-dispatch
    store2.close();
  });

  it("refuses new work until recovery has run (I4)", async () => {
    const { engine } = makeHarness({ now: () => NOW });
    const { hash } = hashPair();
    await expect(engine.createOrder(orderParams(hash))).rejects.toMatchObject({ code: "INTERNAL" });
  });
});

/* ---------------- store durability ---------------- */

describe("FileOrderStore", () => {
  it("round-trips orders and events across reopen; tolerates a torn final line", async () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-store-"));
    const file = join(dir, "orders.jsonl");
    const s1 = new FileOrderStore(file);
    const { hash } = hashPair();
    const order: Order = {
      protocol: "bifrost/0.1",
      orderId: "01ORDER000001",
      quoteId: "01QUOTE000001",
      direction: "FIBER_TO_LN",
      paymentHash: hash,
      state: "PENDING",
      incoming: { network: "fiber", invoice: "fib1", amount: "10", tlcExpiryAt: NOW + 86_400_000, status: "WAITING" },
      outgoing: { network: "lightning", invoice: "lnbcrt1", amount: "1", tlcExpiryAt: NOW + 43_200_000, status: "WAITING" },
      failure: null,
      createdAt: NOW,
      updatedAt: NOW,
    };
    s1.create(order);
    s1.transition(order.orderId, (o) => { o.state = "INCOMING_HELD"; o.incoming.status = "HELD"; }, "test");
    s1.close();

    const { appendFileSync } = await import("node:fs");
    appendFileSync(file, '{"t":"update","order":{"orderId":"01ORDER0'); // torn write

    const s2 = new FileOrderStore(file);
    const back = s2.get(order.orderId)!;
    expect(back.state).toBe("INCOMING_HELD");
    expect(back.incoming.status).toBe("HELD");
    expect(s2.listNonTerminal().length).toBe(1);
    expect(() => s2.create(order)).toThrow(/exists|duplicate/i);
    s2.close();
  });
});
