/**
 * Invoice detection + metadata extraction (payment hash, amount, expiry).
 *
 * Lightning: full BOLT11 decode is delegated to light-bolt11-decoder
 * (signature verification intentionally skipped client-side; the daemon's
 * nodes remain the source of truth).
 *
 * Fiber: bech32m HRP `fib|fibt|fibd` + optional base-10 amount in shannon;
 * payload layout: version byte (0x00) | u64 BE timestamp seconds |
 * 32-byte payment hash | opaque attrs. Round-trip tested against the SDK's
 * own encoder; validation against live FNN invoices is tracked in
 * docs/STATUS.md.
 */
import { bech32m } from "@scure/base";
import { bytesToHex } from "@noble/hashes/utils";
import { decode as decodeBolt11 } from "light-bolt11-decoder";
import { BifrostError } from "./errors.js";

export type InvoiceNetwork = "lightning" | "fiber";

export interface InvoiceInfo {
  network: InvoiceNetwork;
  raw: string;
  /** hex sha256 payment hash; the hub/nodes remain authoritative. */
  paymentHash?: string;
  /** Amount in the network's protocol unit: sat (Lightning) or shannon (Fiber).
   *  For Lightning it is only set when the msat amount is sat-exact. */
  amount?: bigint;
  /** Lightning only: exact invoice amount in millisatoshi. */
  amountMsat?: bigint;
  /** Wall-clock expiry in Unix ms, when the invoice carries one. */
  expiresAt?: number;
}

const LN_PREFIXES = ["lnbcrt", "lntbs", "lntb", "lnbc"]; // longest-first
const FIBER_PREFIXES = ["fibd", "fibt", "fib"]; // dev / testnet / mainnet, longest-first

export function detectInvoice(raw: string): InvoiceInfo {
  const trimmed = raw.trim();
  const s = trimmed.toLowerCase();
  if (LN_PREFIXES.some((p) => s.startsWith(p))) {
    return decodeLightning(trimmed);
  }
  if (FIBER_PREFIXES.some((p) => s.startsWith(p))) {
    return decodeFiber(trimmed);
  }
  throw new BifrostError("INVOICE_INVALID", "unrecognized invoice format", false,
    "expected a BOLT11 (lnbc…/lntb…) or Fiber (fib…/fibt…) payment request");
}

function decodeLightning(raw: string): InvoiceInfo {
  let sections: { name: string; value?: unknown }[];
  try {
    sections = decodeBolt11(raw).sections;
  } catch (e) {
    throw new BifrostError("INVOICE_INVALID", `BOLT11 decode failed: ${(e as Error).message}`, false);
  }
  const get = (name: string) => sections.find((x) => x.name === name)?.value;

  const paymentHash = get("payment_hash") as string | undefined;
  if (!paymentHash || !/^[0-9a-f]{64}$/.test(paymentHash)) {
    throw new BifrostError("INVOICE_INVALID", "BOLT11 invoice missing sha256 payment hash", false);
  }

  const info: InvoiceInfo = { network: "lightning", raw, paymentHash };

  const amountMsatStr = get("amount") as string | undefined;
  if (amountMsatStr !== undefined) {
    const msat = BigInt(amountMsatStr);
    info.amountMsat = msat;
    if (msat % 1000n === 0n) info.amount = msat / 1000n; // sat-exact only
  }

  const timestamp = get("timestamp") as number | undefined;
  const expiry = get("expiry") as number | undefined;
  if (timestamp !== undefined) {
    // BOLT11: expiry defaults to 3600s when the x tag is absent
    info.expiresAt = (timestamp + (expiry ?? 3600)) * 1000;
  }
  return info;
}

const FIBER_VERSION = 0x00;
const FIBER_MIN_PAYLOAD = 1 + 8 + 32; // version | u64 timestamp | payment hash

function decodeFiber(raw: string): InvoiceInfo {
  let hrp: string;
  let payload: Uint8Array;
  try {
    const { prefix, words } = bech32m.decode(raw.toLowerCase() as `${string}1${string}`, 2000);
    hrp = prefix;
    payload = bech32m.fromWords(words);
  } catch (e) {
    throw new BifrostError("INVOICE_INVALID", `Fiber invoice decode failed: ${(e as Error).message}`, false);
  }

  const prefix = FIBER_PREFIXES.find((p) => hrp.startsWith(p));
  if (!prefix) {
    throw new BifrostError("INVOICE_INVALID", "Fiber invoice HRP has unknown network prefix", false);
  }
  const amountPart = hrp.slice(prefix.length);
  let amount: bigint | undefined;
  if (amountPart.length > 0) {
    if (!/^[0-9]+$/.test(amountPart)) {
      throw new BifrostError("INVOICE_INVALID", "Fiber invoice HRP amount is not a base-10 integer", false);
    }
    amount = BigInt(amountPart); // shannon
  }

  if (payload.length < FIBER_MIN_PAYLOAD || payload[0] !== FIBER_VERSION) {
    throw new BifrostError("INVOICE_INVALID", "Fiber invoice payload malformed or unsupported version", false);
  }
  const paymentHash = bytesToHex(payload.subarray(9, 41));

  const info: InvoiceInfo = { network: "fiber", raw, paymentHash };
  if (amount !== undefined) info.amount = amount;
  return info;
}
