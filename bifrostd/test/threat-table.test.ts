/**
 * Adversarial tests attacking SYSTEM-DESIGN §6 threat table rows that the
 * OrderEngine must defeat. Written by /qa as attacks, not happy-path tests:
 * each test tries to make the engine do the WRONG thing and asserts it won't.
 *
 *   Row 1 — "Hub settles incoming, never pays outgoing"
 *   Row 2 — "Timelock race (outgoing settles after incoming refund)"
 *   Row 7 — "Crash mid-swap"
 *
 * Rows 3/5 (feed staleness, quote forgery) are attacked in rfq.test.ts and
 * registry.e2e.test.ts; rows 4/6/8 are guard/deployment scope (see QA report).
 */
import { describe, expect, it } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  INCOMING_MS_PER_BLOCK,
  OUTGOING_MS_PER_BLOCK,
  expiryInvariantHolds,
} from "bifrost-sdk";
import { OrderEngine } from "../src/orders/engine.js";
import { FileOrderStore, MemoryOrderStore } from "../src/orders/store.js";
import type { HoldPort, NetworkPorts, PayPort, HoldInvoiceState, PaymentStateResult } from "../src/orders/ports.js";
import type { Hash256, SwapLegEvent } from "../src/adapters/types.js";

const NOW = 1_752_500_000_000;
const DELTA = 7_200_000;

function pair(): { preimage: Hash256; hash: Hash256 } {
  const p = randomBytes(32);
  return { preimage: `0x${p.toString("hex")}`, hash: `0x${createHash("sha256").update(p).digest("hex")}` };
}

interface Recorded { settles: Array<{ hash: Hash256; preimage: Hash256 }>; cancels: Hash256[]; pays: string[] }

function fakePorts(rec: Recorded, node: { invoices: Map<Hash256, HoldInvoiceState>; payments: Map<Hash256, PaymentStateResult> }): NetworkPorts {
  const hold: HoldPort = {
    createHoldInvoice: async (p) => {
      node.invoices.set(p.paymentHash, "OPEN");
      return `inv-${p.paymentHash.slice(2, 8)}`;
    },
    settle: async (hash, preimage) => {
      rec.settles.push({ hash, preimage });
      const digest = `0x${createHash("sha256").update(Buffer.from(preimage.slice(2), "hex")).digest("hex")}`;
      if (digest !== hash) throw new Error("node refused wrong preimage");
      node.invoices.set(hash, "SETTLED");
    },
    cancel: async (hash) => {
      rec.cancels.push(hash);
      node.invoices.set(hash, "CANCELLED");
    },
    invoiceState: async (hash) => node.invoices.get(hash) ?? "UNKNOWN",
  };
  const pay: PayPort = {
    pay: async (invoice) => { rec.pays.push(invoice); },
    paymentState: async (hash) => node.payments.get(hash) ?? { status: "NONE" },
  };
  return { hold, pay };
}

function harness(opts: { now?: () => number; store?: MemoryOrderStore | FileOrderStore } = {}) {
  const rec: Recorded = { settles: [], cancels: [], pays: [] };
  const node = { invoices: new Map<Hash256, HoldInvoiceState>(), payments: new Map<Hash256, PaymentStateResult>() };
  const ports = fakePorts(rec, node);
  const store = opts.store ?? new MemoryOrderStore();
  const engine = new OrderEngine({
    store,
    ports: { fiber: ports, lightning: ports },
    minSafetyDeltaMs: DELTA,
    ...(opts.now ? { now: opts.now } : {}),
  });
  return { engine, store, rec, node };
}

const mkOrder = (hash: Hash256, inExp: number, outExp: number) => ({
  quoteId: "Q",
  direction: "FIBER_TO_LN" as const,
  paymentHash: hash,
  incoming: { network: "fiber" as const, amount: 1_000n, tlcExpiryAt: inExp },
  outgoing: { network: "lightning" as const, invoice: "lnbcrt1attack", amount: 1_000n, tlcExpiryAt: outExp },
});

const ev = (kind: SwapLegEvent["kind"], hash: Hash256, preimage?: Hash256): SwapLegEvent => ({
  network: "lightning",
  paymentHash: hash,
  kind,
  ...(preimage ? { preimage } : {}),
  observedAt: NOW,
});

/* ---------------- Row 1: settle incoming without paying outgoing ---------------- */

describe("threat row 1 — hub settles incoming, never pays outgoing", () => {
  it("ATTACK: forged INCOMING_SETTLED in every pre-settlement state never produces a settle call", async () => {
    for (const prep of [[], ["INCOMING_HELD"]] as const) {
      const { engine, rec } = harness({ now: () => NOW });
      await engine.start();
      const { hash } = pair();
      await engine.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000));
      for (const k of prep) await engine.onLegEvent(ev(k as SwapLegEvent["kind"], hash));
      await engine.onLegEvent(ev("INCOMING_SETTLED", hash)); // adversary claims it settled
      expect(rec.settles).toHaveLength(0);
    }
  });

  it("ATTACK: cross-order preimage replay — H2's OUTGOING_SETTLED carrying H1's (valid!) preimage settles nothing", async () => {
    const { engine, rec, store } = harness({ now: () => NOW });
    await engine.start();
    const a = pair();
    const b = pair();
    await engine.createOrder(mkOrder(a.hash, NOW + 86_400_000, NOW + 43_200_000));
    await engine.createOrder(mkOrder(b.hash, NOW + 86_400_000, NOW + 43_200_000));
    await engine.onLegEvent(ev("INCOMING_HELD", a.hash));
    await engine.onLegEvent(ev("INCOMING_HELD", b.hash));
    // replay order-A's genuine preimage against order B
    await engine.onLegEvent(ev("OUTGOING_SETTLED", b.hash, a.preimage));
    expect(rec.settles).toHaveLength(0);
    expect(store.getByHash(b.hash)!.state).toBe("OUTGOING_IN_FLIGHT");
  });

  it("ATTACK: duplicate paymentHash across orders is refused at creation (one hash = one order, R4 anchor)", async () => {
    const { engine } = harness({ now: () => NOW });
    await engine.start();
    const { hash } = pair();
    await engine.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000));
    await expect(engine.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000))).rejects.toThrow(/duplicate/i);
  });

  it("ATTACK: preimage that hashes correctly but arrives while incoming was already cancelled → no settle, alarm only", async () => {
    const { engine, rec, store } = harness({ now: () => NOW });
    await engine.start();
    const { preimage, hash } = pair();
    await engine.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000));
    await engine.onLegEvent(ev("INCOMING_HELD", hash));
    await engine.onLegEvent(ev("OUTGOING_FAILED", hash)); // → REFUNDING → FAILED (cancel succeeded)
    expect(store.getByHash(hash)!.state).toBe("FAILED");
    await engine.onLegEvent(ev("OUTGOING_SETTLED", hash, preimage)); // late straggler
    expect(rec.settles).toHaveLength(0);
    expect(store.getByHash(hash)!.state).toBe("FAILED");
  });
});

/* ---------------- Row 2: timelock race ---------------- */

describe("threat row 2 — timelock race", () => {
  it("ATTACK: exact-boundary orders — incoming == outgoing + delta is accepted, one ms less is rejected", async () => {
    const { engine } = harness({ now: () => NOW });
    await engine.start();
    const out = NOW + 43_200_000;
    const ok = pair();
    await expect(engine.createOrder(mkOrder(ok.hash, out + DELTA, out))).resolves.toBeDefined();
    const bad = pair();
    await expect(engine.createOrder(mkOrder(bad.hash, out + DELTA - 1, out))).rejects.toMatchObject({
      code: "EXPIRY_INVARIANT_VIOLATION",
    });
  });

  it("ATTACK: conversion-direction — a blocks-denominated incoming that only passes under the OPTIMISTIC conversion must fail", () => {
    // incoming 100 blocks: optimistic (600k/block) claims 60,000,000 ms;
    // conservative (300k/block) claims 30,000,000 ms. Outgoing 25,000,000 ms.
    // With delta 7,200,000: optimistic would pass (60M ≥ 32.2M) — the
    // conservative rule must reject (30M < 32.2M).
    const incoming = { blocksFromNow: 100 };
    const outgoing = { tlcExpiryAt: NOW + 25_000_000 };
    expect(expiryInvariantHolds(incoming, outgoing, DELTA, NOW)).toBe(false);
    // sanity: the optimistic reading really would have passed
    expect(NOW + 100 * OUTGOING_MS_PER_BLOCK).toBeGreaterThanOrEqual(NOW + 25_000_000 + DELTA);
    expect(100 * INCOMING_MS_PER_BLOCK).toBeLessThan(25_000_000 + DELTA);
  });

  it("ATTACK: conversion-direction — a blocks-denominated OUTGOING that only passes under the optimistic (fast-block) reading must fail", () => {
    // outgoing 100 blocks: optimistic fast-block reading (300k) claims it ends
    // at +30M; conservative slow-block (600k) says +60M. Incoming +40M.
    const incoming = { tlcExpiryAt: NOW + 40_000_000 };
    const outgoing = { blocksFromNow: 100 };
    expect(expiryInvariantHolds(incoming, outgoing, DELTA, NOW)).toBe(false);
    expect(40_000_000).toBeGreaterThanOrEqual(100 * INCOMING_MS_PER_BLOCK + DELTA); // optimistic would pass
  });

  it("ATTACK: race the dispatch — expiry crosses the safety threshold exactly when INCOMING_HELD lands → refund, not dispatch", async () => {
    let now = NOW;
    const { engine, rec, store } = harness({ now: () => now });
    await engine.start();
    const { hash } = pair();
    const inExp = NOW + 50_400_000;
    await engine.createOrder(mkOrder(hash, inExp, NOW + 43_200_000));
    now = inExp - DELTA; // now + delta == incoming expiry, the first losing instant
    await engine.onLegEvent(ev("INCOMING_HELD", hash));
    expect(rec.pays).toHaveLength(0);
    expect(rec.cancels).toContain(hash);
    expect(store.events(store.getByHash(hash)!.orderId).map((e) => e.toState)).toContain("REFUNDING");
  });

  it("ATTACK: one ms before the threshold the dispatch is still allowed (no over-rejection)", async () => {
    let now = NOW;
    const { engine, rec } = harness({ now: () => now });
    await engine.start();
    const { hash } = pair();
    const inExp = NOW + 50_400_000;
    await engine.createOrder(mkOrder(hash, inExp, NOW + 43_200_000));
    now = inExp - DELTA - 1;
    await engine.onLegEvent(ev("INCOMING_HELD", hash));
    expect(rec.pays).toHaveLength(1);
  });
});

/* ---------------- Row 7: crash mid-swap ---------------- */

describe("threat row 7 — crash mid-swap", () => {
  it("ATTACK: crash between persisting OUTGOING_SETTLED and settling incoming — recovery settles with the persisted verified preimage, exactly once", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-row7-"));
    const file = join(dir, "orders.jsonl");
    const { preimage, hash } = pair();

    // phase 1: drive to OUTGOING_SETTLED but make the settle call crash
    const store1 = new FileOrderStore(file);
    const rec1: Recorded = { settles: [], cancels: [], pays: [] };
    const node = { invoices: new Map<Hash256, HoldInvoiceState>(), payments: new Map<Hash256, PaymentStateResult>() };
    const ports1 = fakePorts(rec1, node);
    const crashingHold: HoldPort = { ...ports1.hold, settle: async () => { throw new Error("crash: process died mid-settle"); } };
    const engine1 = new OrderEngine({
      store: store1,
      ports: { fiber: { hold: crashingHold, pay: ports1.pay }, lightning: ports1 },
      minSafetyDeltaMs: DELTA,
      now: () => NOW,
    });
    await engine1.start();
    await engine1.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000));
    await engine1.onLegEvent(ev("INCOMING_HELD", hash));
    await engine1.onLegEvent(ev("OUTGOING_SETTLED", hash, preimage)).catch(() => undefined);
    expect(store1.getByHash(hash)!.state).toBe("OUTGOING_SETTLED"); // persisted BEFORE the failed side effect (R5)
    store1.close();

    // phase 2: restart over the same log; node truth: payment settled, invoice still held
    const store2 = new FileOrderStore(file);
    const rec2: Recorded = { settles: [], cancels: [], pays: [] };
    const ports2 = fakePorts(rec2, node);
    node.invoices.set(hash, "HELD");
    node.payments.set(hash, { status: "SUCCEEDED", preimage });
    const engine2 = new OrderEngine({ store: store2, ports: { fiber: ports2, lightning: ports2 }, minSafetyDeltaMs: DELTA, now: () => NOW });
    await engine2.start();

    expect(rec2.settles).toHaveLength(1);
    expect(rec2.settles[0]).toEqual({ hash, preimage });
    const o = store2.getByHash(hash)!;
    expect(o.state).toBe("SUCCEEDED");
    expect(o.incoming.preimage).toBe(preimage);
    store2.close();
  });

  it("ATTACK: poisoned event log — a hand-tampered OUTGOING_SETTLED entry with a wrong preimage cannot make recovery settle", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qa-row7b-"));
    const file = join(dir, "orders.jsonl");
    const { hash } = pair();
    const wrong = pair().preimage; // valid-shaped but wrong preimage

    const store1 = new FileOrderStore(file);
    const rec1: Recorded = { settles: [], cancels: [], pays: [] };
    const node = { invoices: new Map<Hash256, HoldInvoiceState>(), payments: new Map<Hash256, PaymentStateResult>() };
    const engine1 = new OrderEngine({ store: store1, ports: { fiber: fakePorts(rec1, node), lightning: fakePorts(rec1, node) }, minSafetyDeltaMs: DELTA, now: () => NOW });
    await engine1.start();
    await engine1.createOrder(mkOrder(hash, NOW + 86_400_000, NOW + 43_200_000));
    await engine1.onLegEvent(ev("INCOMING_HELD", hash));
    store1.close();

    // adversary edits the log: claims OUTGOING_SETTLED with a bogus preimage
    const { readFileSync, appendFileSync } = await import("node:fs");
    const lastLine = readFileSync(file, "utf8").trim().split("\n").pop()!;
    const forged = JSON.parse(lastLine) as { order: { state: string; outgoing: { status: string; preimage?: string } } };
    forged.order.state = "OUTGOING_SETTLED";
    forged.order.outgoing.status = "SETTLED";
    forged.order.outgoing.preimage = wrong;
    appendFileSync(file, `${JSON.stringify(forged)}\n`);

    const store2 = new FileOrderStore(file);
    const rec2: Recorded = { settles: [], cancels: [], pays: [] };
    node.invoices.set(hash, "HELD");
    const engine2 = new OrderEngine({ store: store2, ports: { fiber: fakePorts(rec2, node), lightning: fakePorts(rec2, node) }, minSafetyDeltaMs: DELTA, now: () => NOW });
    await engine2.start();
    // settleIncoming re-verifies sha256(P)==H against the PERSISTED preimage — refuses
    expect(rec2.settles).toHaveLength(0);
    expect(store2.getByHash(hash)!.state).not.toBe("SUCCEEDED");
    store2.close();
  });
});
