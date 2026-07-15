/**
 * E2E: publish a signed ad (fresh @noble/curves keypair), query it back
 * verbatim, filter by pair/amount, expire it, and assert every rejection
 * path (tamper, stale, future, malformed, rate-bearing).
 */
import { afterEach, describe, expect, it } from "vitest";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex } from "@noble/hashes/utils";
import { randomBytes } from "node:crypto";
import {
  PROTOCOL_VERSION,
  signingDigest,
  verifyAdvertisement,
  type Advertisement,
} from "@bifrost/sdk";
import { openStore } from "../src/db.js";
import { buildServer, MAX_AD_AGE_MS, MAX_CLOCK_SKEW_MS } from "../src/server.js";

const NOW = 1_752_505_200_000;

function makeApp(now: () => number = () => NOW) {
  const store = openStore(":memory:");
  const app = buildServer({ store, now });
  return { app, store };
}

function signedAd(priv: Uint8Array, overrides: Partial<Advertisement> = {}): Advertisement {
  const unsigned: Omit<Advertisement, "signature"> = {
    protocol: PROTOCOL_VERSION,
    hubPubkey: bytesToHex(schnorr.getPublicKey(priv)),
    endpoints: { api: "https://hub.example.com/v1" },
    pairs: [
      {
        give: { network: "fiber", unit: "shannon" },
        get: { network: "lightning", unit: "sat" },
        minAmount: "1000",
        maxAmount: "10000000",
      },
    ],
    fiberNodeId: "QmaFDJb9CkMrXy7nhTWBY5y9mvuykre3EzzRsCJUAVXprZ",
    lightningNodeId: "03e347d089c071c27680e26299223e80a740cf2e3fbbade63dd6a614a8b567e21c",
    issuedAt: NOW,
    ttlMs: 3_600_000,
    ...overrides,
  };
  const digest = signingDigest(unsigned as unknown as Record<string, unknown>, "ad");
  return { ...unsigned, signature: bytesToHex(schnorr.sign(digest, priv)) };
}

let cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup) await fn();
  cleanup = [];
});

describe("registry e2e (PROTOCOL §4.5)", () => {
  it("publish → query round-trip: ad served VERBATIM and re-verifiable by the sdk", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const priv = randomBytes(32);
    const ad = signedAd(priv);

    const post = await app.inject({ method: "POST", url: "/ads", payload: ad });
    expect(post.statusCode).toBe(204);

    const get = await app.inject({
      method: "GET",
      url: "/ads?giveNetwork=fiber&giveUnit=shannon&getNetwork=lightning&getUnit=sat&amount=50000",
    });
    expect(get.statusCode).toBe(200);
    const ads = get.json() as Advertisement[];
    expect(ads).toHaveLength(1);
    expect(ads[0]).toEqual(ad); // MUST NOT modify ads
    // the client-side trust check passes on what the registry served
    verifyAdvertisement(ads[0]!, NOW + 1);
    // and the served ad carries no rate anywhere
    expect(JSON.stringify(ads[0])).not.toMatch(/"rate/);
  });

  it("TAMPERED ad is rejected UNAUTHORIZED (endpoint redirect attack)", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const ad = signedAd(randomBytes(32));
    const tampered = { ...ad, endpoints: { api: "https://evil.example.com/v1" } };
    const res = await app.inject({ method: "POST", url: "/ads", payload: tampered });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatchObject({ code: "UNAUTHORIZED", retryable: false });
  });

  it("wrong-key signature is rejected UNAUTHORIZED", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const ad = signedAd(randomBytes(32));
    const mallory = signedAd(randomBytes(32));
    const res = await app.inject({ method: "POST", url: "/ads", payload: { ...ad, signature: mallory.signature } });
    expect(res.statusCode).toBe(401);
  });

  it("anti-replay: issuedAt older than 5 min or >60s in the future is rejected", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const priv = randomBytes(32);
    const stale = signedAd(priv, { issuedAt: NOW - MAX_AD_AGE_MS - 1 });
    expect((await app.inject({ method: "POST", url: "/ads", payload: stale })).statusCode).toBe(401);
    const future = signedAd(priv, { issuedAt: NOW + MAX_CLOCK_SKEW_MS + 1 });
    expect((await app.inject({ method: "POST", url: "/ads", payload: future })).statusCode).toBe(401);
    // boundary values are accepted
    const edgeOld = signedAd(priv, { issuedAt: NOW - MAX_AD_AGE_MS });
    expect((await app.inject({ method: "POST", url: "/ads", payload: edgeOld })).statusCode).toBe(204);
  });

  it("ads expire at issuedAt + ttlMs and vanish from queries", async () => {
    let t = NOW;
    const { app } = makeApp(() => t);
    cleanup.push(() => app.close());
    const ad = signedAd(randomBytes(32), { ttlMs: 60_000 });
    await app.inject({ method: "POST", url: "/ads", payload: ad });
    expect((await app.inject({ method: "GET", url: "/ads" })).json()).toHaveLength(1);
    t = NOW + 60_000; // exactly at expiry: expired (strict >)
    expect((await app.inject({ method: "GET", url: "/ads" })).json()).toHaveLength(0);
  });

  it("pair/amount filters exclude non-matching ads; republish replaces by hubPubkey", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const priv = randomBytes(32);
    await app.inject({ method: "POST", url: "/ads", payload: signedAd(priv) });
    // amount outside [min,max]
    expect((await app.inject({ method: "GET", url: "/ads?amount=999" })).json()).toHaveLength(0);
    expect((await app.inject({ method: "GET", url: "/ads?amount=10000001" })).json()).toHaveLength(0);
    // wrong pair direction
    expect((await app.inject({ method: "GET", url: "/ads?giveNetwork=lightning&giveUnit=sat" })).json()).toHaveLength(0);
    // republish (newer issuedAt) replaces, never duplicates
    await app.inject({ method: "POST", url: "/ads", payload: signedAd(priv, { issuedAt: NOW + 1 }) });
    const all = (await app.inject({ method: "GET", url: "/ads" })).json() as Advertisement[];
    expect(all).toHaveLength(1);
    expect(all[0]!.issuedAt).toBe(NOW + 1);
  });

  it("malformed ads are 400 INTERNAL: bad protocol, http endpoint, rate smuggling", async () => {
    const { app } = makeApp();
    cleanup.push(() => app.close());
    const priv = randomBytes(32);
    const cases: Array<Partial<Advertisement> & Record<string, unknown>> = [
      { protocol: "bifrost/0.2" as never },
      { endpoints: { api: "http://insecure.example.com/v1" } },
      { pairs: [] },
      { rate: { num: "1", den: "1" } }, // registry never stores/serves rates
    ];
    for (const o of cases) {
      const res = await app.inject({ method: "POST", url: "/ads", payload: { ...signedAd(priv), ...o } });
      expect(res.statusCode, JSON.stringify(o)).toBe(400);
      expect(res.json().error.code).toBe("INTERNAL");
    }
  });
});
