/**
 * StreamHub — the ONE broadcast point for /v1/stream, shared by SwapCoordinator
 * (order changes driven by adapter events) and api/server.ts's own request
 * handlers (order changes driven directly by a POST). Both must push through
 * the same object or WS clients silently miss half the transitions.
 */
import { WebSocket } from "ws";
import type { Order } from "@bifrost/sdk";
import type { StreamMessage } from "./contract.js";

const MAX_REJECTIONS = 20;

export interface Rejection { orderId: string; at: number; code: string; hint: string }

export class StreamHub {
  private readonly sockets = new Set<WebSocket>();
  readonly rejections: Rejection[] = [];

  add(ws: WebSocket): void {
    this.sockets.add(ws);
  }

  remove(ws: WebSocket): void {
    this.sockets.delete(ws);
  }

  broadcast(msg: StreamMessage): void {
    const body = JSON.stringify(msg);
    for (const ws of this.sockets) if (ws.readyState === WebSocket.OPEN) ws.send(body);
  }

  /** Call after every observed order mutation, whichever code path caused it. */
  onOrderChanged(order: Order): void {
    this.broadcast({ type: "order", data: order });
    if ((order.state === "REFUNDING" || order.state === "FAILED") && order.failure?.code === "EXPIRY_INVARIANT_VIOLATION") {
      this.rejections.unshift({ orderId: order.orderId, at: order.updatedAt, code: order.failure.code, hint: order.failure.hint ?? order.failure.message });
      this.rejections.length = Math.min(this.rejections.length, MAX_REJECTIONS);
    }
  }
}
