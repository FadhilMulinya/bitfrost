/**
 * Canonical JSON (RFC 8785 / JCS) serialization + Bifrost signing digest.
 * PROTOCOL.md §3. Because all protocol amounts are strings, the only JSON
 * numbers on signed objects are integer timestamps/durations, which JCS
 * serializes identically to JSON.stringify for safe integers. We enforce that.
 */
import { sha256 } from "@noble/hashes/sha256";
import { utf8ToBytes } from "@noble/hashes/utils";

export type SignedType = "quote" | "ad";

/** Recursively serialize a JSON value in RFC 8785 canonical form. */
export function canonicalize(value: unknown): string {
  if (value === null) return "null";
  const t = typeof value;
  if (t === "boolean") return value ? "true" : "false";
  if (t === "string") return JSON.stringify(value);
  if (t === "number") {
    const n = value as number;
    if (!Number.isFinite(n)) throw new Error("canonicalize: non-finite number");
    if (!Number.isInteger(n) || !Number.isSafeInteger(n)) {
      throw new Error(
        "canonicalize: only safe integers permitted in signed objects (amounts must be strings)",
      );
    }
    return String(n);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(canonicalize).join(",") + "]";
  }
  if (t === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj)
      .filter((k) => obj[k] !== undefined)
      .sort();
    return (
      "{" +
      keys.map((k) => JSON.stringify(k) + ":" + canonicalize(obj[k])).join(",") +
      "}"
    );
  }
  throw new Error(`canonicalize: unsupported type ${t}`);
}

/** Strip the signature field and produce the canonical bytes to be signed. */
export function canonicalBytes(obj: Record<string, unknown>): Uint8Array {
  const { signature: _sig, ...rest } = obj;
  return utf8ToBytes(canonicalize(rest));
}

/** digest = sha256("bifrost/0.1|" + type_tag + "|" + canonical_bytes) */
export function signingDigest(
  obj: Record<string, unknown>,
  typeTag: SignedType,
): Uint8Array {
  const prefix = utf8ToBytes(`bifrost/0.1|${typeTag}|`);
  const body = canonicalBytes(obj);
  const buf = new Uint8Array(prefix.length + body.length);
  buf.set(prefix, 0);
  buf.set(body, prefix.length);
  return sha256(buf);
}
