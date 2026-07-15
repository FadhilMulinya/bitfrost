/** Data layer: REST fetchers + a WS hook. All shapes come from mock/contract.ts. */
import { useEffect, useRef, useState } from "react";
import type { Order } from "@bifrost/sdk";
import {
  ENDPOINTS,
  type HealthReport,
  type InventorySnapshot,
  type OrdersPage,
  type QuoteStats,
  type StreamMessage,
} from "../mock/contract.ts";

async function get<T>(path: string): Promise<T> {
  const res = await fetch(path);
  if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  return res.json() as Promise<T>;
}

export const fetchOrders = () => get<OrdersPage>(ENDPOINTS.orders);
export const fetchInventory = () => get<InventorySnapshot>(ENDPOINTS.inventory);
export const fetchHealth = () => get<HealthReport>(ENDPOINTS.health);
export const fetchQuoteStats = () => get<QuoteStats>(ENDPOINTS.quoteStats);

/** Poll a fetcher on an interval (inventory/health/stats are read-mostly). */
export function usePolled<T>(fn: () => Promise<T>, ms: number): T | undefined {
  const [value, setValue] = useState<T>();
  useEffect(() => {
    let live = true;
    const run = () => fn().then((v) => live && setValue(v)).catch(() => undefined);
    run();
    const t = setInterval(run, ms);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [fn, ms]);
  return value;
}

/** Live order book: initial REST load + at-least-once WS updates (dedupe on orderId+updatedAt). */
export function useOrderStream(): { orders: Map<string, Order>; connected: boolean; lastEvent?: StreamMessage | undefined } {
  const [orders, setOrders] = useState(new Map<string, Order>());
  const [connected, setConnected] = useState(false);
  const [lastEvent, setLastEvent] = useState<StreamMessage>();
  const seen = useRef(new Map<string, number>());

  useEffect(() => {
    fetchOrders().then((p) =>
      setOrders((prev) => {
        const next = new Map(prev);
        for (const o of p.orders) if (!next.has(o.orderId)) next.set(o.orderId, o);
        return next;
      }),
    ).catch(() => undefined);

    const proto = location.protocol === "https:" ? "wss" : "ws";
    const ws = new WebSocket(`${proto}://${location.host}${ENDPOINTS.stream}`);
    ws.onopen = () => setConnected(true);
    ws.onclose = () => setConnected(false);
    ws.onmessage = (ev) => {
      const msg = JSON.parse(String(ev.data)) as StreamMessage;
      setLastEvent(msg);
      if (msg.type !== "order") return;
      const o = msg.data;
      const last = seen.current.get(o.orderId);
      if (last !== undefined && last >= o.updatedAt) return; // at-least-once dedupe
      seen.current.set(o.orderId, o.updatedAt);
      setOrders((prev) => new Map(prev).set(o.orderId, o));
    };
    return () => ws.close();
  }, []);

  return { orders, connected, lastEvent };
}

/** Format an integer-string amount with thousands separators — bigint only, no floats. */
export function fmtAmount(v: string): string {
  return BigInt(v).toLocaleString("en-US");
}

/** percentage (0–100 integer) of part in total, integer math only */
export function pctOf(part: string, total: bigint): number {
  if (total === 0n) return 0;
  return Number((BigInt(part) * 100n) / total);
}
