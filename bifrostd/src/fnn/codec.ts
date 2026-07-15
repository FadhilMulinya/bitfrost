/**
 * FNN JSON-RPC numeric codec — THE single place hex wire numbers are
 * encoded/decoded (FNN serializes u64/u128 via U64Hex/U128Hex, e.g.
 * "0x5f5e100"). All amounts are bigint; floats are rejected by type and at
 * runtime. Mirrors fiber's crates/fiber-json-types serde_utils behavior:
 * lowercase hex, 0x prefix, no leading zeros ("0x0" for zero).
 */

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const HEX_RE = /^0x(0|[1-9a-f][0-9a-f]*)$/;

function assertBigInt(v: unknown): bigint {
  if (typeof v !== "bigint") {
    throw new TypeError(`fnn codec: expected bigint, got ${typeof v} (floats are forbidden in money paths)`);
  }
  return v;
}

function encodeHex(v: unknown, max: bigint, label: string): string {
  const n = assertBigInt(v);
  if (n < 0n || n > max) throw new RangeError(`fnn codec: ${label} out of range: ${n}`);
  return "0x" + n.toString(16);
}

function decodeHex(s: unknown, max: bigint, label: string): bigint {
  if (typeof s !== "string" || !HEX_RE.test(s)) {
    throw new TypeError(`fnn codec: ${label} must be a 0x-prefixed lowercase hex string, got ${JSON.stringify(s)}`);
  }
  const n = BigInt(s);
  if (n > max) throw new RangeError(`fnn codec: ${label} out of range: ${s}`);
  return n;
}

export const encodeU64Hex = (v: bigint): string => encodeHex(v, U64_MAX, "u64");
export const decodeU64Hex = (s: string): bigint => decodeHex(s, U64_MAX, "u64");
export const encodeU128Hex = (v: bigint): string => encodeHex(v, U128_MAX, "u128");
export const decodeU128Hex = (s: string): bigint => decodeHex(s, U128_MAX, "u128");
