import { describe, expect, it } from "vitest";
import {
  decodeU128Hex,
  decodeU64Hex,
  encodeU128Hex,
  encodeU64Hex,
} from "../src/fnn/codec.js";

describe("fnn hex codec (U64Hex/U128Hex wire format)", () => {
  it("encodes the canonical example: 100_000_000 -> 0x5f5e100", () => {
    expect(encodeU128Hex(100_000_000n)).toBe("0x5f5e100");
    expect(encodeU64Hex(100_000_000n)).toBe("0x5f5e100");
  });

  it("round-trips zero and boundary values", () => {
    expect(encodeU128Hex(0n)).toBe("0x0");
    expect(decodeU128Hex("0x0")).toBe(0n);
    const u64max = (1n << 64n) - 1n;
    expect(decodeU64Hex(encodeU64Hex(u64max))).toBe(u64max);
    const u128max = (1n << 128n) - 1n;
    expect(decodeU128Hex(encodeU128Hex(u128max))).toBe(u128max);
  });

  it("round-trip property over random u128 values", () => {
    for (let i = 0; i < 500; i++) {
      let n = 0n;
      for (let b = 0; b < 4; b++) n = (n << 32n) | BigInt((Math.random() * 2 ** 32) >>> 0);
      expect(decodeU128Hex(encodeU128Hex(n))).toBe(n);
    }
  });

  it("rejects out-of-range values", () => {
    expect(() => encodeU64Hex(1n << 64n)).toThrow(RangeError);
    expect(() => encodeU128Hex(1n << 128n)).toThrow(RangeError);
    expect(() => encodeU128Hex(-1n)).toThrow(RangeError);
    expect(() => decodeU64Hex("0x10000000000000000")).toThrow(RangeError);
  });

  it("rejects non-bigint inputs (floats are forbidden)", () => {
    expect(() => encodeU128Hex(1.5 as unknown as bigint)).toThrow(TypeError);
    expect(() => encodeU128Hex(100 as unknown as bigint)).toThrow(TypeError);
    expect(() => encodeU128Hex("100" as unknown as bigint)).toThrow(TypeError);
  });

  it("rejects malformed hex strings", () => {
    for (const bad of ["5f5e100", "0X5F5E100", "0x", "0x01", "0xG1", "", null, 5]) {
      expect(() => decodeU128Hex(bad as string)).toThrow(TypeError);
    }
  });
});
