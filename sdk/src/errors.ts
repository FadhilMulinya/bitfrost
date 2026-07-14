/** Typed errors mirroring the closed registry in PROTOCOL.md §7. */
import { ERROR_CODES, type ErrorCode, type ProtocolError } from "./types.js";

export class BifrostError extends Error {
  readonly code: ErrorCode;
  readonly retryable: boolean;
  readonly hint: string | undefined;
  readonly orderId: string | undefined;

  constructor(code: ErrorCode, message: string, retryable: boolean, hint?: string, orderId?: string) {
    super(message);
    this.name = "BifrostError";
    this.code = code;
    this.retryable = retryable;
    this.hint = hint;
    this.orderId = orderId;
  }

  static fromWire(e: ProtocolError): BifrostError {
    const code: ErrorCode = (ERROR_CODES as readonly string[]).includes(e.code) ? e.code : "INTERNAL";
    return new BifrostError(code, e.message, e.retryable, e.hint, e.orderId);
  }
}

export function isRetryable(err: unknown): boolean {
  return err instanceof BifrostError && err.retryable;
}
