/**
 * Executes every PROTOCOL §10 vector in spec/vectors/ against the SDK.
 * An implementation passing these plus the §9 checklist may claim
 * bifrost/0.1 conformance.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalBytes, canonicalize, signingDigest, type SignedType } from "../src/canonical.js";
import { expiryInvariantHolds, type LegExpiryInput } from "../src/expiry.js";
import type { OrderState } from "../src/types.js";

const VECTORS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "..", "spec", "vectors");

function load<T>(dir: string): { file: string; vector: T }[] {
  return readdirSync(join(VECTORS, dir))
    .filter((f) => f.endsWith(".json"))
    .map((file) => ({
      file,
      vector: JSON.parse(readFileSync(join(VECTORS, dir, file), "utf8")) as T,
    }));
}

describe("spec/vectors/canonical-json", () => {
  interface V {
    typeTag: SignedType;
    object: Record<string, unknown>;
    canonical: string;
    canonicalBytesHex: string;
    digestHex: string;
  }
  for (const { file, vector } of load<V>("canonical-json")) {
    it(`${file}: canonical form and digest match`, () => {
      expect(canonicalize(vector.object)).toBe(vector.canonical);
      expect(bytesToHex(canonicalBytes(vector.object))).toBe(vector.canonicalBytesHex);
      expect(bytesToHex(signingDigest(vector.object, vector.typeTag))).toBe(vector.digestHex);
    });
  }
});

describe("spec/vectors/signatures", () => {
  interface V {
    privateKeyHex: string;
    publicKeyHex: string;
    typeTag: SignedType;
    object: Record<string, unknown>;
    digestHex: string;
    signatureHex: string;
    signedObject: Record<string, unknown>;
    tamperedObject: Record<string, unknown>;
    tamperedMustVerify: boolean;
  }
  for (const { file, vector } of load<V>("signatures")) {
    it(`${file}: signature verifies and tampering breaks it`, () => {
      expect(bytesToHex(schnorr.getPublicKey(hexToBytes(vector.privateKeyHex)))).toBe(
        vector.publicKeyHex,
      );
      const digest = signingDigest(vector.signedObject, vector.typeTag);
      expect(bytesToHex(digest)).toBe(vector.digestHex);
      expect(
        schnorr.verify(hexToBytes(vector.signatureHex), digest, hexToBytes(vector.publicKeyHex)),
      ).toBe(true);
      const tamperedDigest = signingDigest(vector.tamperedObject, vector.typeTag);
      expect(
        schnorr.verify(
          hexToBytes(vector.signatureHex),
          tamperedDigest,
          hexToBytes(vector.publicKeyHex),
        ),
      ).toBe(vector.tamperedMustVerify);
    });
  }
});

describe("spec/vectors/expiry", () => {
  interface V {
    now: number;
    incoming: LegExpiryInput;
    outgoing: LegExpiryInput;
    minSafetyDeltaMs: number;
    expected: "accept" | "reject";
  }
  for (const { file, vector } of load<V>("expiry")) {
    it(`${file}: ${vector.expected}`, () => {
      expect(
        expiryInvariantHolds(vector.incoming, vector.outgoing, vector.minSafetyDeltaMs, vector.now),
      ).toBe(vector.expected === "accept");
    });
  }
});

describe("spec/vectors/state-machine", () => {
  // Legal transitions per PROTOCOL §4.4 + rules R1–R3. Reaching SUCCEEDED
  // (settling incoming) is only legal from OUTGOING_SETTLED (R1); dispatching
  // outgoing (entering OUTGOING_IN_FLIGHT) only from INCOMING_HELD (R2);
  // REFUNDING only from INCOMING_HELD / OUTGOING_IN_FLIGHT (R3).
  const LEGAL: Record<OrderState, OrderState[]> = {
    PENDING: ["INCOMING_HELD", "FAILED"],
    INCOMING_HELD: ["OUTGOING_IN_FLIGHT", "REFUNDING"],
    OUTGOING_IN_FLIGHT: ["OUTGOING_SETTLED", "REFUNDING"],
    OUTGOING_SETTLED: ["SUCCEEDED"],
    REFUNDING: ["FAILED"],
    SUCCEEDED: [],
    FAILED: [],
  };

  function trajectoryIsValid(t: OrderState[]): boolean {
    if (t[0] !== "PENDING") return false;
    for (let i = 1; i < t.length; i++) {
      if (!LEGAL[t[i - 1]!]?.includes(t[i]!)) return false;
    }
    return true;
  }

  interface V {
    trajectory: OrderState[];
    expected: "valid" | "invalid";
  }
  const vectors = load<V>("state-machine");

  it("covers every REFUNDING entry point (PROTOCOL §10)", () => {
    const refundPredecessors = new Set<OrderState>();
    for (const { vector } of vectors) {
      vector.trajectory.forEach((s, i) => {
        if (s === "REFUNDING" && i > 0 && vector.expected === "valid") {
          refundPredecessors.add(vector.trajectory[i - 1]!);
        }
      });
    }
    expect(refundPredecessors).toEqual(new Set(["INCOMING_HELD", "OUTGOING_IN_FLIGHT"]));
  });

  for (const { file, vector } of vectors) {
    it(`${file}: trajectory is ${vector.expected}`, () => {
      expect(trajectoryIsValid(vector.trajectory)).toBe(vector.expected === "valid");
    });
  }
});
