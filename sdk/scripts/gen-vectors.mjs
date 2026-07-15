/**
 * Generates PROTOCOL §10 test vectors into spec/vectors/.
 * Deterministic: fixed keys, fixed timestamps, zeroed BIP-340 aux randomness.
 * Run: npm run build && node scripts/gen-vectors.mjs
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { schnorr } from "@noble/curves/secp256k1";
import { bytesToHex, hexToBytes } from "@noble/hashes/utils";
import { canonicalBytes, canonicalize, signingDigest } from "../dist/canonical.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = join(ROOT, "spec", "vectors");

const PRIV = "0000000000000000000000000000000000000000000000000000000000000003";
const PUB = bytesToHex(schnorr.getPublicKey(hexToBytes(PRIV)));
const AUX = new Uint8Array(32); // deterministic signatures

function write(rel, obj) {
  const path = join(OUT, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(obj, null, 2) + "\n");
  console.log("wrote", rel);
}

/* ---------- shared fixtures ---------- */

const quote = {
  protocol: "bifrost/0.1",
  quoteId: "01JVECTORQUOTE0000000000",
  pair: {
    give: { network: "fiber", unit: "shannon" },
    get: { network: "lightning", unit: "sat" },
  },
  rate: { num: "50000", den: "13000000000" },
  giveAmount: "13000000000",
  getAmount: "49888",
  feeBreakdown: { hubFeePpm: "2000", flatFee: "0", estNetworkFee: "12" },
  issuedAt: 1752505200000,
  expiresAt: 1752505230000,
  maxIncomingHoldMs: 21600000,
  minSafetyDeltaMs: 7200000,
  hubPubkey: PUB,
};

const ad = {
  protocol: "bifrost/0.1",
  hubPubkey: PUB,
  endpoints: { api: "https://hub.example.com/v1" },
  pairs: [
    {
      give: { network: "fiber", unit: "shannon" },
      get: { network: "lightning", unit: "sat" },
      minAmount: "1000",
      maxAmount: "10000000",
    },
  ],
  fiberNodeId: "fiber-node-vector",
  lightningNodeId: "ln-node-vector",
  issuedAt: 1752505200000,
  ttlMs: 3600000,
};

/* ---------- canonical-json ---------- */

const nested = {
  b: { z: "last", a: "first" },
  a: ["x", 1, true, null],
  emptyObj: {},
  unicode: "héllo ✓",
};

for (const [name, tag, obj] of [
  ["quote", "quote", quote],
  ["advertisement", "ad", ad],
  ["key-ordering", "quote", nested],
]) {
  write(`canonical-json/${name}.json`, {
    description: `canonicalize per RFC 8785, digest = sha256("bifrost/0.1|" + typeTag + "|" + canonical)`,
    typeTag: tag,
    object: obj,
    canonical: canonicalize(obj),
    canonicalBytesHex: bytesToHex(canonicalBytes(obj)),
    digestHex: bytesToHex(signingDigest(obj, tag)),
  });
}

/* ---------- signatures ---------- */

for (const [name, tag, obj] of [
  ["quote", "quote", quote],
  ["advertisement", "ad", ad],
]) {
  const digest = signingDigest(obj, tag);
  const signature = bytesToHex(schnorr.sign(digest, hexToBytes(PRIV), AUX));
  write(`signatures/${name}.json`, {
    description: "BIP-340 Schnorr over the domain-separated digest; auxRand = 32 zero bytes",
    privateKeyHex: PRIV,
    publicKeyHex: PUB,
    typeTag: tag,
    object: obj,
    digestHex: bytesToHex(digest),
    signatureHex: signature,
    signedObject: { ...obj, signature },
    tamperedObject: { ...obj, getAmount: obj.getAmount ?? undefined, issuedAt: obj.issuedAt + 1, signature },
    tamperedMustVerify: false,
  });
}

/* ---------- expiry (PROTOCOL §6) ---------- */

const NOW = 1752505200000;
const expiryCases = [
  {
    name: "fiber-in-ln-out-accept",
    description: "Fiber incoming (wall-clock), LN outgoing 6 blocks: 6*600000=3600000 out; 12h in >= 3.6e6 + 7.2e6",
    now: NOW,
    incoming: { tlcExpiryAt: NOW + 43200000 },
    outgoing: { blocksFromNow: 6 },
    minSafetyDeltaMs: 7200000,
    expected: "accept",
  },
  {
    name: "fiber-in-ln-out-reject-tight",
    description: "outgoing 80 blocks * 600000 = 48e6 ms; incoming 12h cannot cover 48e6 + 7.2e6",
    now: NOW,
    incoming: { tlcExpiryAt: NOW + 43200000 },
    outgoing: { blocksFromNow: 80 },
    minSafetyDeltaMs: 7200000,
    expected: "reject",
  },
  {
    name: "ln-in-fiber-out-accept",
    description: "LN incoming 144 blocks with FAST-block pessimism (300000): 43.2e6; fiber outgoing 6h wall-clock",
    now: NOW,
    incoming: { blocksFromNow: 144 },
    outgoing: { tlcExpiryAt: NOW + 21600000 },
    minSafetyDeltaMs: 7200000,
    expected: "accept",
  },
  {
    name: "ln-in-fiber-out-reject-fast-block-pessimism",
    description: "40 incoming blocks look like 24e6 ms at 600000/block but MUST be bounded at 300000/block = 12e6 < 14.4e6 + 7.2e6",
    now: NOW,
    incoming: { blocksFromNow: 40 },
    outgoing: { tlcExpiryAt: NOW + 14400000 },
    minSafetyDeltaMs: 7200000,
    expected: "reject",
  },
  {
    name: "exact-boundary-accepts",
    description: "incoming == outgoing + delta exactly: invariant uses >=, so accept",
    now: NOW,
    incoming: { tlcExpiryAt: NOW + 21600000 },
    outgoing: { tlcExpiryAt: NOW + 14400000 },
    minSafetyDeltaMs: 7200000,
    expected: "accept",
  },
  {
    name: "one-ms-under-boundary-rejects",
    description: "incoming one ms short of outgoing + delta: reject",
    now: NOW,
    incoming: { tlcExpiryAt: NOW + 21599999 },
    outgoing: { tlcExpiryAt: NOW + 14400000 },
    minSafetyDeltaMs: 7200000,
    expected: "reject",
  },
];
for (const c of expiryCases) write(`expiry/${c.name}.json`, c);

/* ---------- state-machine (PROTOCOL §4.4 R1–R5) ---------- */

const smCases = [
  {
    name: "happy-path",
    description: "full success trajectory",
    events: ["incoming_held", "outgoing_dispatched", "outgoing_settled", "incoming_settled"],
    trajectory: ["PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "SUCCEEDED"],
    expected: "valid",
  },
  {
    name: "expire-before-hold",
    description: "quote/hold expiry before any HTLC arrives",
    events: ["expired"],
    trajectory: ["PENDING", "FAILED"],
    expected: "valid",
  },
  {
    name: "refund-from-incoming-held",
    description: "R3: safety delta breached while held -> REFUNDING -> FAILED",
    events: ["safety_delta_breached", "incoming_cancelled"],
    trajectory: ["PENDING", "INCOMING_HELD", "REFUNDING", "FAILED"],
    expected: "valid",
  },
  {
    name: "refund-from-outgoing-in-flight",
    description: "R3: outgoing failure while in flight -> REFUNDING -> FAILED",
    events: ["incoming_held", "outgoing_dispatched", "outgoing_failed", "incoming_cancelled"],
    trajectory: ["PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "REFUNDING", "FAILED"],
    expected: "valid",
  },
  {
    name: "r1-violation-settle-before-outgoing-settled",
    description: "R1: settling incoming before OUTGOING_SETTLED is illegal",
    events: ["incoming_held", "incoming_settled"],
    trajectory: ["PENDING", "INCOMING_HELD", "SUCCEEDED"],
    expected: "invalid",
  },
  {
    name: "r2-violation-dispatch-before-held",
    description: "R2: dispatching outgoing before INCOMING_HELD is illegal",
    events: ["outgoing_dispatched"],
    trajectory: ["PENDING", "OUTGOING_IN_FLIGHT"],
    expected: "invalid",
  },
  {
    name: "no-refund-after-outgoing-settled",
    description: "once outgoing settled, refunding would strand the hub; only SUCCEEDED is legal",
    events: ["incoming_held", "outgoing_dispatched", "outgoing_settled", "refund_attempt"],
    trajectory: ["PENDING", "INCOMING_HELD", "OUTGOING_IN_FLIGHT", "OUTGOING_SETTLED", "REFUNDING"],
    expected: "invalid",
  },
];
for (const c of smCases) write(`state-machine/${c.name}.json`, c);

console.log("done");
