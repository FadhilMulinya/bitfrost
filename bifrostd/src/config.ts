/**
 * Startup env validation. Required vars (no safe default — e.g. WBTC_SCRIPT
 * identifies real on-chain funds) are collected up front and reported as ONE
 * error listing everything missing, then the process exits(1) — never a
 * mid-startup throw from a random line deep in index.ts.
 */
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
