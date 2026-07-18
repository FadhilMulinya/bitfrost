/**
 * Startup env validation and hub configuration resolution.
 *
 * HUB_MODE picks how bifrostd finds its Lightning/Fiber nodes and its quote
 * signing key:
 *   "dev"      - the docker-compose dev stack (deploy/docker-compose.dev.yml).
 *                Keys/nodes are throwaway fixtures; HUB_SIGNING_KEY may be
 *                left unset (an ephemeral key is generated, with a loud
 *                warning — never used for real funds in this mode).
 *   "managed"  - same shape as dev but intended for an operator's own
 *                docker-compose-managed nodes; HUB_SIGNING_KEY is required.
 *   "external" - bifrostd points at an operator's existing LND + FNN nodes.
 *                HUB_SIGNING_KEY, LND cert/macaroon, and the UDT identifying
 *                the real wBTC asset are all required — no safe defaults
 *                exist for real funds.
 *
 * Required vars with no safe default are collected up front and reported as
 * ONE error listing everything missing, then the process exits(1) — never a
 * mid-startup throw from a random line deep in index.ts.
 */
import { readFileSync } from "node:fs";
import { schnorr } from "@noble/curves/secp256k1";

export type HubMode = "dev" | "managed" | "external";

const REQUIRED = ["UDT_CODE_HASH", "WBTC_ARGS"] as const;

export interface RequiredEnv {
  UDT_CODE_HASH: string;
  WBTC_ARGS: string;
}

export function loadRequiredEnv(): RequiredEnv {
  const missing = REQUIRED.filter((k) => !process.env[k]);
  if (missing.length > 0) {
    console.error(
      `[bifrostd] FATAL: missing required env var(s): ${missing.join(", ")}\n` +
        `  See deploy/.env.example for what each one is and how to set it.`,
    );
    process.exit(1);
  }
  return {
    UDT_CODE_HASH: process.env["UDT_CODE_HASH"]!,
    WBTC_ARGS: process.env["WBTC_ARGS"]!,
  };
}

export interface HubConfig {
  mode: HubMode;
  /** Raw 32-byte private key, signs RFQ quotes. Never touches funds. */
  hubSigningKey: Uint8Array;
  hubPubkeyHex: string;
  lnd: {
    /** Resolved REST base URL, e.g. https://127.0.0.1:8080 */
    baseUrl: string;
    /** Hex-encoded macaroon, read from LND_MACAROON_PATH. Absent = --no-macaroons dev node. */
    macaroonHex?: string;
    allowSelfSigned: boolean;
  };
  fnn: {
    url: string;
    wsUrl: string;
  };
  udt: {
    codeHash: string;
    wbtcArgs: string;
  };
  demoEndpointsEnabled: boolean;
}

function fatal(message: string): never {
  console.error(`[bifrostd] FATAL: ${message}`);
  process.exit(1);
}

function resolveHubSigningKey(mode: HubMode): Uint8Array {
  const hex = process.env["HUB_SIGNING_KEY"] || process.env["BIFROST_HUB_SIGNING_KEY"];
  if (hex) {
    if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
      fatal("HUB_SIGNING_KEY must be 64 hex chars (32 bytes).");
    }
    return Buffer.from(hex, "hex");
  }
  if (mode !== "dev") {
    fatal(
      `HUB_SIGNING_KEY is required for HUB_MODE=${mode}.\n` +
        "  Generate one with: node scripts/generate-hub-key.mjs\n" +
        "  Then add to deploy/.env: HUB_SIGNING_KEY=<the hex key>",
    );
  }
  console.warn("[bifrostd] WARNING: HUB_SIGNING_KEY not set -- using an ephemeral dev key.");
  console.warn("[bifrostd] Quotes will use a different key each restart.");
  console.warn("[bifrostd] Set HUB_SIGNING_KEY in deploy/.env for a stable hub identity.");
  return crypto.getRandomValues(new Uint8Array(32));
}

function resolveLnd(mode: HubMode, errors: string[]): HubConfig["lnd"] {
  // LND_HUB_REST is the existing dev-stack override (deploy/docker-compose.dev.yml);
  // LND_HOST/LND_REST_PORT are the operator-facing external/managed vars.
  const explicitRest = process.env["LND_HUB_REST"];
  const host = process.env["LND_HOST"];
  const port = process.env["LND_REST_PORT"] || "8080";
  const baseUrl = explicitRest || (host ? `http://${host}:${port}` : "http://127.0.0.1:8080");

  const macaroonPath = process.env["LND_MACAROON_PATH"];
  let macaroonHex: string | undefined;
  if (macaroonPath) {
    try {
      macaroonHex = readFileSync(macaroonPath).toString("hex");
    } catch (err) {
      errors.push(`LND_MACAROON_PATH (${macaroonPath}) could not be read: ${(err as Error).message}`);
    }
  } else if (mode === "external") {
    errors.push("LND_MACAROON_PATH required for external mode");
  }

  const tlsCertPath = process.env["LND_TLS_CERT_PATH"];
  if (mode === "external" && !tlsCertPath) {
    errors.push("LND_TLS_CERT_PATH required for external mode");
  }
  // Node's fetch has no per-request CA option; a real cert path is handled
  // via NODE_EXTRA_CA_CERTS (see LndRestHttp's allowSelfSigned doc comment) —
  // bifrostd itself only needs to know the path exists for external mode.
  if (tlsCertPath) {
    try {
      readFileSync(tlsCertPath);
    } catch (err) {
      errors.push(`LND_TLS_CERT_PATH (${tlsCertPath}) could not be read: ${(err as Error).message}`);
    }
  }

  return {
    baseUrl,
    ...(macaroonHex !== undefined ? { macaroonHex } : {}),
    allowSelfSigned: mode !== "external" && baseUrl.startsWith("https"),
  };
}

function resolveFnn(mode: HubMode): HubConfig["fnn"] {
  const explicitUrl = process.env["FNN_HUB_URL"];
  const explicitWs = process.env["FNN_HUB_WS"];
  const host = process.env["FNN_HOST"];
  const port = process.env["FNN_RPC_PORT"] || "21716";

  const url = explicitUrl || (host ? `http://${host}:${port}` : "http://127.0.0.1:21716");
  const wsUrl = explicitWs || (host ? `ws://${host}:${port}` : "ws://127.0.0.1:21716");
  return { url, wsUrl };
}

export function resolveHubConfig(): HubConfig {
  const mode = (process.env["HUB_MODE"] ?? "dev") as HubMode;
  if (mode !== "dev" && mode !== "managed" && mode !== "external") {
    fatal(`HUB_MODE must be "dev", "managed", or "external" (got "${mode}").`);
  }

  const errors: string[] = [];

  if (!process.env["UDT_CODE_HASH"]) errors.push("UDT_CODE_HASH required");
  if (!process.env["WBTC_ARGS"]) errors.push("WBTC_ARGS required");

  const lnd = resolveLnd(mode, errors);

  if (errors.length > 0) {
    fatal(
      `missing/invalid required configuration for HUB_MODE=${mode}:\n` +
        errors.map((e) => `  - ${e}`).join("\n") +
        "\n  See deploy/.env.example for what each one is and how to set it.",
    );
  }

  const hubSigningKey = resolveHubSigningKey(mode);
  const hubPubkeyHex = Buffer.from(schnorr.getPublicKey(hubSigningKey)).toString("hex");

  const demoEndpointsEnabled = process.env["DEMO_ENDPOINTS_ENABLED"] === "true";
  if (demoEndpointsEnabled && mode === "external") {
    fatal("DEMO_ENDPOINTS_ENABLED=true is not allowed with HUB_MODE=external. Never enable demo endpoints against real funds.");
  }

  return {
    mode,
    hubSigningKey,
    hubPubkeyHex,
    lnd,
    fnn: resolveFnn(mode),
    udt: {
      codeHash: process.env["UDT_CODE_HASH"]!,
      wbtcArgs: process.env["WBTC_ARGS"]!,
    },
    demoEndpointsEnabled,
  };
}
