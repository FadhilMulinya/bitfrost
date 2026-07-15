/**
 * Order persistence (SYSTEM-DESIGN §4.7, rule R5 / invariant I4).
 *
 * v0.1 ships an append-only JSONL event log with fsync-per-append —
 * "the append-only events table is the recovery source of truth" — instead of
 * the spec's SQLite tables. DIVERGENCE (logged in docs/STATUS.md): SQLite is
 * deferred so bifrostd stays free of native modules (the smoke runner executes
 * inside the compose network in a different libc/Node than the host build).
 * The `OrderStore` interface is what the engine binds to; a SqliteStore can
 * slot in without touching the engine.
 *
 * Durability contract: `create` / `transition` return only after the record
 * is on disk (fsync). One process owns the file; the engine serializes writes.
 */
import { closeSync, fsyncSync, openSync, readFileSync, writeSync } from "node:fs";
import type { Order, OrderState } from "@bifrost/sdk";
import type { Hash256 } from "../adapters/types.js";

const TERMINAL: ReadonlySet<OrderState> = new Set(["SUCCEEDED", "FAILED"]);

export interface OrderEvent {
  orderId: string;
  at: number;
  fromState: OrderState | null;
  toState: OrderState;
  detail?: string;
}

export interface OrderStore {
  /** Persist a new order; MUST reject a duplicate orderId or paymentHash (R4 anchor). */
  create(order: Order): void;
  /** Apply `mutate` to the stored order and persist atomically before returning (R5). */
  transition(orderId: string, mutate: (order: Order) => void, detail?: string): Order;
  get(orderId: string): Order | undefined;
  getByHash(paymentHash: Hash256): Order | undefined;
  listNonTerminal(): Order[];
  events(orderId: string): OrderEvent[];
  close(): void;
}

type LogLine =
  | { t: "create"; order: Order; at: number }
  | { t: "update"; order: Order; at: number; detail?: string; fromState: OrderState };

abstract class BaseStore implements OrderStore {
  protected readonly orders = new Map<string, Order>();
  protected readonly byHash = new Map<Hash256, string>();
  protected readonly log = new Map<string, OrderEvent[]>();

  protected abstract persist(line: LogLine): void;

  create(order: Order): void {
    if (this.orders.has(order.orderId)) throw new Error(`order ${order.orderId} already exists`);
    if (this.byHash.has(order.paymentHash)) {
      throw new Error(`duplicate paymentHash ${order.paymentHash} (order ${this.byHash.get(order.paymentHash)})`);
    }
    this.persist({ t: "create", order, at: order.createdAt });
    this.index(order);
    this.log.set(order.orderId, [
      { orderId: order.orderId, at: order.createdAt, fromState: null, toState: order.state },
    ]);
  }

  transition(orderId: string, mutate: (order: Order) => void, detail?: string): Order {
    const current = this.orders.get(orderId);
    if (!current) throw new Error(`unknown order ${orderId}`);
    const fromState = current.state;
    const next: Order = structuredClone(current);
    mutate(next);
    this.persist({ t: "update", order: next, at: next.updatedAt, fromState, ...(detail !== undefined ? { detail } : {}) });
    this.index(next);
    const events = this.log.get(orderId) ?? [];
    events.push({ orderId, at: next.updatedAt, fromState, toState: next.state, ...(detail !== undefined ? { detail } : {}) });
    this.log.set(orderId, events);
    return structuredClone(next);
  }

  private index(order: Order): void {
    this.orders.set(order.orderId, structuredClone(order));
    this.byHash.set(order.paymentHash, order.orderId);
  }

  get(orderId: string): Order | undefined {
    const o = this.orders.get(orderId);
    return o ? structuredClone(o) : undefined;
  }

  getByHash(paymentHash: Hash256): Order | undefined {
    const id = this.byHash.get(paymentHash);
    return id ? this.get(id) : undefined;
  }

  listNonTerminal(): Order[] {
    return [...this.orders.values()].filter((o) => !TERMINAL.has(o.state)).map((o) => structuredClone(o));
  }

  events(orderId: string): OrderEvent[] {
    return [...(this.log.get(orderId) ?? [])];
  }

  close(): void {}
}

export class MemoryOrderStore extends BaseStore {
  protected persist(): void {}
}

export class FileOrderStore extends BaseStore {
  private fd: number;

  constructor(private readonly path: string) {
    super();
    this.replay();
    this.fd = openSync(path, "a");
  }

  private replay(): void {
    let raw: string;
    try {
      raw = readFileSync(this.path, "utf8");
    } catch {
      return; // fresh file
    }
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      let parsed: LogLine;
      try {
        parsed = JSON.parse(line) as LogLine;
      } catch {
        continue; // torn final line from a crash mid-append: ignore, prior state is intact
      }
      const { order } = parsed;
      this.orders.set(order.orderId, order);
      this.byHash.set(order.paymentHash, order.orderId);
      const events = this.log.get(order.orderId) ?? [];
      events.push({
        orderId: order.orderId,
        at: parsed.at,
        fromState: parsed.t === "create" ? null : parsed.fromState,
        toState: order.state,
        ...(parsed.t === "update" && parsed.detail !== undefined ? { detail: parsed.detail } : {}),
      });
      this.log.set(order.orderId, events);
    }
  }

  protected persist(line: LogLine): void {
    writeSync(this.fd, `${JSON.stringify(line)}\n`);
    fsyncSync(this.fd); // R5: durable before the caller proceeds to the side effect
  }

  override close(): void {
    closeSync(this.fd);
  }
}
