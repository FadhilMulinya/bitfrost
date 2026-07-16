/**
 * bifrost-registry — PROTOCOL §4.5, SYSTEM-DESIGN §4.8.
 *
 * Trust model: untrusted for everything except availability. It stores signed
 * ads verbatim and serves them verbatim. RATES NEVER APPEAR HERE — ads carry
 * none by schema, and any unexpected `rate`-bearing payload is rejected as
 * malformed. Clients always fetch live signed quotes from hubs directly.
 *
 * Rejections use the closed §7 registry: UNAUTHORIZED for signature and
 * freshness (anti-replay) failures, INTERNAL for malformed payloads.
 */
import Fastify, { type FastifyInstance } from "fastify";
import {
  PROTOCOL_VERSION,
  verifyAdSignature,
  type Advertisement,
  type AssetRef,
} from "bifrost-sdk";
import type { AdStore } from "./db.js";

export const MAX_AD_AGE_MS = 5 * 60_000; // §4.5: reject issuedAt older than 5 min
export const MAX_CLOCK_SKEW_MS = 60_000; // §4.5: or >60 s in the future

export interface RegistryOptions {
  store: AdStore;
  now?: () => number;
  logger?: boolean;
}

interface ErrorBody {
  error: { code: "UNAUTHORIZED" | "INTERNAL"; message: string; retryable: boolean };
}

function err(code: ErrorBody["error"]["code"], message: string, retryable = false): ErrorBody {
  return { error: { code, message, retryable } };
}

function isAssetRef(v: unknown): v is AssetRef {
  const a = v as AssetRef;
  return (
    (a?.network === "lightning" && a.unit === "sat") ||
    (a?.network === "fiber" && (a.unit === "shannon" || (a.unit === "udt" && typeof (a as { udtScript?: unknown }).udtScript === "object")))
  );
}

const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

/** Structural validation only — cryptographic trust comes from the signature. */
function malformedReason(ad: Advertisement): string | undefined {
  if (ad.protocol !== PROTOCOL_VERSION) return `protocol must be ${PROTOCOL_VERSION}`;
  if (!/^[0-9a-f]{64}$/.test(ad.hubPubkey)) return "hubPubkey must be 32-byte x-only hex";
  if (!/^[0-9a-f]{128}$/.test(ad.signature)) return "signature must be 64-byte hex";
  if (typeof ad.endpoints?.api !== "string" || !ad.endpoints.api.startsWith("https://")) {
    return "endpoints.api must be an https URL";
  }
  if (!Array.isArray(ad.pairs) || ad.pairs.length === 0) return "pairs must be non-empty";
  for (const p of ad.pairs) {
    if (!isAssetRef(p.give) || !isAssetRef(p.get)) return "pair assets malformed";
    if (!AMOUNT_RE.test(p.minAmount) || !AMOUNT_RE.test(p.maxAmount)) return "amounts must be base-10 integer strings";
    if (BigInt(p.minAmount) > BigInt(p.maxAmount)) return "minAmount exceeds maxAmount";
    if ("rate" in p) return "ads must not carry rates"; // trust model: never store/serve rates
  }
  if ("rate" in ad || "rates" in ad) return "ads must not carry rates";
  if (!Number.isInteger(ad.issuedAt) || !Number.isInteger(ad.ttlMs) || ad.ttlMs <= 0) {
    return "issuedAt/ttlMs must be positive integers";
  }
  if (typeof ad.fiberNodeId !== "string" || typeof ad.lightningNodeId !== "string") {
    return "fiberNodeId/lightningNodeId required";
  }
  return undefined;
}

function assetMatches(a: AssetRef, network: string, unit: string): boolean {
  return a.network === network && a.unit === unit;
}

export function buildServer(opts: RegistryOptions): FastifyInstance {
  const now = opts.now ?? Date.now;
  const app = Fastify({ logger: opts.logger ?? false });

  app.post("/ads", async (req, reply) => {
    const ad = req.body as Advertisement;
    const reason = malformedReason(ad);
    if (reason) return reply.code(400).send(err("INTERNAL", `malformed advertisement: ${reason}`));

    // anti-replay window BEFORE the (more expensive) signature check
    const t = now();
    if (ad.issuedAt < t - MAX_AD_AGE_MS) {
      return reply.code(401).send(err("UNAUTHORIZED", "issuedAt older than 5 minutes (anti-replay)"));
    }
    if (ad.issuedAt > t + MAX_CLOCK_SKEW_MS) {
      return reply.code(401).send(err("UNAUTHORIZED", "issuedAt more than 60s in the future"));
    }
    let ok = false;
    try {
      ok = verifyAdSignature(ad);
    } catch {
      ok = false;
    }
    if (!ok) return reply.code(401).send(err("UNAUTHORIZED", "advertisement signature verification failed"));

    opts.store.upsert(ad);
    return reply.code(204).send();
  });

  app.get("/ads", async (req, reply) => {
    const q = req.query as Partial<Record<"giveNetwork" | "giveUnit" | "getNetwork" | "getUnit" | "amount", string>>;
    let amount: bigint | undefined;
    if (q.amount !== undefined) {
      if (!AMOUNT_RE.test(q.amount)) return reply.code(400).send(err("INTERNAL", "amount must be a base-10 integer"));
      amount = BigInt(q.amount);
    }
    const ads = opts.store.fresh(now()).filter((ad) =>
      ad.pairs.some((p) => {
        if (q.giveNetwork && !assetMatches(p.give, q.giveNetwork, q.giveUnit ?? p.give.unit)) return false;
        if (q.getNetwork && !assetMatches(p.get, q.getNetwork, q.getUnit ?? p.get.unit)) return false;
        if (amount !== undefined && (amount < BigInt(p.minAmount) || amount > BigInt(p.maxAmount))) return false;
        return true;
      }),
    );
    return reply.send(ads); // verbatim — clients re-verify signatures locally
  });

  return app;
}
