import { describe, expect, it } from "vitest";
import { canonicalize, signingDigest } from "../src/canonical.js";
import { bytesToHex } from "@noble/hashes/utils";

describe("canonicalize (RFC 8785 subset)", () => {
  it("sorts keys lexicographically at every level", () => {
    expect(canonicalize({ b: 1, a: { d: 2, c: 3 } })).toBe('{"a":{"c":3,"d":2},"b":1}');
  });
  it("drops undefined members and keeps nulls", () => {
    expect(canonicalize({ a: undefined, b: null })).toBe('{"b":null}');
  });
  it("serializes arrays in order", () => {
    expect(canonicalize({ a: ["x", "y"] })).toBe('{"a":["x","y"]}');
  });
  it("rejects floats — amounts must be strings", () => {
    expect(() => canonicalize({ amount: 1.5 })).toThrow(/safe integers/);
  });
  it("rejects non-finite numbers", () => {
    expect(() => canonicalize({ a: Infinity })).toThrow(/non-finite/);
  });
  it("is stable regardless of insertion order (property)", () => {
    const a = { x: 1, y: { p: "q", r: "s" }, z: [1, 2] };
    const b = { z: [1, 2], y: { r: "s", p: "q" }, x: 1 };
    expect(canonicalize(a)).toBe(canonicalize(b));
  });
});

describe("signingDigest", () => {
  it("is domain-separated by type tag", () => {
    const obj = { protocol: "bifrost/0.1", quoteId: "01J", signature: "ff" };
    const dQuote = bytesToHex(signingDigest(obj, "quote"));
    const dAd = bytesToHex(signingDigest(obj, "ad"));
    expect(dQuote).not.toBe(dAd);
  });
  it("excludes the signature field from the digest", () => {
    const a = { quoteId: "01J", signature: "aa" };
    const b = { quoteId: "01J", signature: "bb" };
    expect(bytesToHex(signingDigest(a, "quote"))).toBe(bytesToHex(signingDigest(b, "quote")));
  });
});
