import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveHubConfig } from "../src/config.js";

const ENV_KEYS = [
  "HUB_MODE",
  "HUB_SIGNING_KEY",
  "BIFROST_HUB_SIGNING_KEY",
  "UDT_CODE_HASH",
  "WBTC_ARGS",
  "LND_HOST",
  "LND_REST_PORT",
  "LND_HUB_REST",
  "LND_TLS_CERT_PATH",
  "LND_MACAROON_PATH",
  "FNN_HOST",
  "FNN_RPC_PORT",
  "FNN_HUB_URL",
  "FNN_HUB_WS",
  "DEMO_ENDPOINTS_ENABLED",
] as const;

let savedEnv: Record<string, string | undefined>;

beforeEach(() => {
  savedEnv = {};
  for (const k of ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

function expectFatalExit(): void {
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Error(`process.exit(${code})`);
  }) as never);
}

describe("resolveHubConfig", () => {
  it("dev mode: generates an ephemeral signing key with no HUB_SIGNING_KEY set", () => {
    process.env["UDT_CODE_HASH"] = "0xabc";
    process.env["WBTC_ARGS"] = "0xdef";
    vi.spyOn(console, "warn").mockImplementation(() => {});

    const cfg = resolveHubConfig();

    expect(cfg.mode).toBe("dev");
    expect(cfg.hubSigningKey).toHaveLength(32);
    expect(cfg.hubPubkeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(cfg.lnd.baseUrl).toBe("http://127.0.0.1:8080");
    expect(cfg.fnn.url).toBe("http://127.0.0.1:21716");
  });

  it("dev mode: uses a stable pubkey derived from an explicit HUB_SIGNING_KEY", () => {
    process.env["UDT_CODE_HASH"] = "0xabc";
    process.env["WBTC_ARGS"] = "0xdef";
    process.env["HUB_SIGNING_KEY"] = "11".repeat(32);

    const cfg = resolveHubConfig();

    expect(Buffer.from(cfg.hubSigningKey).toString("hex")).toBe("11".repeat(32));
  });

  it("external mode: fails fast with every missing var listed when nothing is configured", () => {
    process.env["HUB_MODE"] = "external";
    expectFatalExit();

    expect(() => resolveHubConfig()).toThrow(/process\.exit/);
    const message = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toContain("UDT_CODE_HASH required");
    expect(message).toContain("WBTC_ARGS required");
    expect(message).toContain("LND_MACAROON_PATH required for external mode");
    expect(message).toContain("LND_TLS_CERT_PATH required for external mode");
  });

  it("external mode: fails fast when HUB_SIGNING_KEY is missing even if node config is present", () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-config-test-"));
    const macaroonPath = join(dir, "admin.macaroon");
    const tlsPath = join(dir, "tls.cert");
    writeFileSync(macaroonPath, Buffer.from("deadbeef", "hex"));
    writeFileSync(tlsPath, "cert");

    process.env["HUB_MODE"] = "external";
    process.env["UDT_CODE_HASH"] = "0xabc";
    process.env["WBTC_ARGS"] = "0xdef";
    process.env["LND_MACAROON_PATH"] = macaroonPath;
    process.env["LND_TLS_CERT_PATH"] = tlsPath;
    expectFatalExit();

    expect(() => resolveHubConfig()).toThrow(/process\.exit/);
    const message = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toContain("HUB_SIGNING_KEY is required");
  });

  it("external mode: resolves LND base URL, macaroon hex, and FNN URL from host/port vars", () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-config-test-"));
    const macaroonPath = join(dir, "admin.macaroon");
    const tlsPath = join(dir, "tls.cert");
    writeFileSync(macaroonPath, Buffer.from("deadbeef", "hex"));
    writeFileSync(tlsPath, "cert");

    process.env["HUB_MODE"] = "external";
    process.env["UDT_CODE_HASH"] = "0xabc";
    process.env["WBTC_ARGS"] = "0xdef";
    process.env["HUB_SIGNING_KEY"] = "22".repeat(32);
    process.env["LND_HOST"] = "lnd.example.com";
    process.env["LND_REST_PORT"] = "8080";
    process.env["LND_MACAROON_PATH"] = macaroonPath;
    process.env["LND_TLS_CERT_PATH"] = tlsPath;
    process.env["FNN_HOST"] = "fnn.example.com";
    process.env["FNN_RPC_PORT"] = "8227";

    const cfg = resolveHubConfig();

    expect(cfg.lnd.baseUrl).toBe("http://lnd.example.com:8080");
    expect(cfg.lnd.macaroonHex).toBe("deadbeef");
    expect(cfg.fnn.url).toBe("http://fnn.example.com:8227");
    expect(cfg.fnn.wsUrl).toBe("ws://fnn.example.com:8227");
  });

  it("rejects DEMO_ENDPOINTS_ENABLED=true combined with HUB_MODE=external", () => {
    const dir = mkdtempSync(join(tmpdir(), "bifrost-config-test-"));
    const macaroonPath = join(dir, "admin.macaroon");
    const tlsPath = join(dir, "tls.cert");
    writeFileSync(macaroonPath, Buffer.from("deadbeef", "hex"));
    writeFileSync(tlsPath, "cert");

    process.env["HUB_MODE"] = "external";
    process.env["UDT_CODE_HASH"] = "0xabc";
    process.env["WBTC_ARGS"] = "0xdef";
    process.env["HUB_SIGNING_KEY"] = "33".repeat(32);
    process.env["LND_MACAROON_PATH"] = macaroonPath;
    process.env["LND_TLS_CERT_PATH"] = tlsPath;
    process.env["DEMO_ENDPOINTS_ENABLED"] = "true";
    expectFatalExit();

    expect(() => resolveHubConfig()).toThrow(/process\.exit/);
    const message = (console.error as ReturnType<typeof vi.fn>).mock.calls[0]![0] as string;
    expect(message).toContain("DEMO_ENDPOINTS_ENABLED=true is not allowed with HUB_MODE=external");
  });

  it("rejects an unknown HUB_MODE", () => {
    process.env["HUB_MODE"] = "bogus";
    expectFatalExit();

    expect(() => resolveHubConfig()).toThrow(/process\.exit/);
  });
});
