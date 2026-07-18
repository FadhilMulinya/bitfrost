#!/usr/bin/env node
/**
 * Generate a new Bifrost hub signing key.
 *
 * Usage: node bifrostd/scripts/generate-hub-key.mjs
 * (or, from repo root: node scripts/generate-hub-key.mjs)
 *
 * This key is used to sign RFQ quotes — it proves quotes came from your
 * hub. It is NOT a wallet key and does not control funds.
 *
 * Back this up! If you lose it, clients with a pinned pubkey cannot verify
 * your quotes until they update to your new pubkey.
 */

import { schnorr } from "@noble/curves/secp256k1";

const privateKey = schnorr.utils.randomPrivateKey();
const publicKey = schnorr.getPublicKey(privateKey);

const privHex = Buffer.from(privateKey).toString("hex");
const pubHex = Buffer.from(publicKey).toString("hex");

console.log("═══════════════════════════════════════════════");
console.log("  Bifrost Hub Signing Key");
console.log("═══════════════════════════════════════════════");
console.log("");
console.log("  Public key (share this — goes in registry):");
console.log("  " + pubHex);
console.log("");
console.log("  Private key (KEEP SECRET — BACK UP NOW):");
console.log("  " + privHex);
console.log("");
console.log("═══════════════════════════════════════════════");
console.log("");
console.log("  Add to deploy/.env:");
console.log("  HUB_SIGNING_KEY=" + privHex);
console.log("");
console.log("  This is NOT a wallet key. It does not control");
console.log("  Bitcoin or CKB funds. It only signs price quotes.");
console.log("");
console.log("  Your actual funds are controlled by:");
console.log("  - LND wallet (back up the 24-word seed)");
console.log("  - FNN/CKB key (back up your FNN node's own key store)");
console.log("═══════════════════════════════════════════════");
