/**
 * Contract tests against the LIVE compose env (deploy/docker-compose.dev.yml).
 * Gated: run with BIFROST_IT=1 after `docker compose up` + fund-regtest.sh.
 *
 * RPC is intentionally not host-published (CLAUDE.md), so calls route through
 * `docker compose exec` exactly like deploy/scripts/lib.sh: FNN JSON-RPC via
 * curl in the ckb toolbox container; LND semantics via lncli.
 *
 * These verify the wire assumptions RPC-NOTES flags as "verify against the
 * actual node version": hold-invoice payment_hash support on the deployed
 * fiber tag, hex encodings, status vocabulary, and LND hold-invoice states.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { randomBytes, createHash } from "node:crypto";
import { FiberAdapter } from "../src/adapters/fiber.js";
import type { FnnTransport } from "../src/adapters/transport.js";

const IT = process.env["BIFROST_IT"] === "1";
const REPO = new URL("../..", import.meta.url).pathname;
const COMPOSE = ["compose", "-f", `${REPO}deploy/docker-compose.dev.yml`, "--env-file", `${REPO}deploy/.env`];
const FNN_HUB_PORT = 21716;

function dockerExec(args: string[], input?: string): string {
  return execFileSync("docker", [...COMPOSE, "exec", "-T", ...args], {
    encoding: "utf8",
    ...(input !== undefined ? { input } : {}),
    timeout: 30_000,
  });
}

/** FnnTransport routed through the ckb toolbox container (mirrors lib.sh rpc()). */
function execTransport(port: number): FnnTransport {
  let id = 1;
  return {
    async call<T>(method: string, params: unknown): Promise<T> {
      const req = JSON.stringify({ id: id++, jsonrpc: "2.0", method, params: [params] });
      const out = dockerExec(
        ["ckb", "curl", "-sS", "-X", "POST", `http://127.0.0.1:${port}`, "-H", "Content-Type: application/json", "--data-binary", "@-"],
        req,
      );
      const body = JSON.parse(out) as { result?: T; error?: { code: number; message: string } };
      if (body.error) throw new Error(`RPC ${method}: ${body.error.code} ${body.error.message}`);
      return body.result as T;
    },
  };
}

function lncli(node: "lnd-hub" | "lnd-payee", args: string[]): unknown {
  const dirs = { "lnd-hub": "lnd-ingrid", "lnd-payee": "lnd-bob" };
  const ports = { "lnd-hub": "10009", "lnd-payee": "11009" };
  const out = dockerExec([
    node, "lncli", "--network=regtest", "--no-macaroons",
    `--lnddir=/work/tests/deploy/lnd-init/${dirs[node]}`, `--rpcserver=localhost:${ports[node]}`,
    ...args,
  ]);
  return JSON.parse(out);
}

function freshHashPair(): { preimage: string; hash: string } {
  const pre = randomBytes(32);
  return { preimage: `0x${pre.toString("hex")}`, hash: `0x${createHash("sha256").update(pre).digest("hex")}` };
}

describe.skipIf(!IT)("FNN contract (deployed tag, via compose exec)", () => {
  const fiber = () => new FiberAdapter({ transport: execTransport(FNN_HUB_PORT), currency: "Fibd" });

  it("new_invoice accepts an external payment_hash (hold), get_invoice reports Open, cancel → Cancelled", async () => {
    const a = fiber();
    const { hash } = freshHashPair();
    const inv = await a.newHoldInvoice({
      amount: 1_000n,
      paymentHash: hash,
      finalTlcExpiryDeltaMs: 57_600_000,
      expirySeconds: 600,
      description: "bifrost contract test (hold)",
    });
    expect(inv.paymentHash).toBe(hash);
    expect(inv.invoiceAddress.startsWith("fib")).toBe(true);
    expect(await a.getInvoiceStatus(hash)).toBe("Open");
    await a.cancelHoldInvoice(hash);
    expect(await a.getInvoiceStatus(hash)).toBe("Cancelled");
  });

  it("rejects a duplicate payment_hash (atomicity anchor is unique node-side)", async () => {
    const a = fiber();
    const { hash } = freshHashPair();
    await a.newHoldInvoice({ amount: 1_000n, paymentHash: hash, finalTlcExpiryDeltaMs: 57_600_000 });
    await expect(
      a.newHoldInvoice({ amount: 1_000n, paymentHash: hash, finalTlcExpiryDeltaMs: 57_600_000 }),
    ).rejects.toThrow(/already exists/i);
    await a.cancelHoldInvoice(hash);
  });

  it("settle_invoice with a WRONG preimage is refused (I1 depends on this)", async () => {
    const a = fiber();
    const { hash } = freshHashPair();
    const wrong = freshHashPair().preimage;
    await a.newHoldInvoice({ amount: 1_000n, paymentHash: hash, finalTlcExpiryDeltaMs: 57_600_000 });
    await expect(a.settleHoldInvoice(hash, wrong)).rejects.toThrow();
    await a.cancelHoldInvoice(hash);
  });

  it("parse_invoice round-trips hash + amount; node_info/list_channels answer", async () => {
    const a = fiber();
    const { hash } = freshHashPair();
    const inv = await a.newHoldInvoice({ amount: 12_345n, paymentHash: hash, finalTlcExpiryDeltaMs: 57_600_000 });
    const details = await a.parseInvoice(inv.invoiceAddress);
    expect(details.paymentHash).toBe(hash);
    expect(details.amount).toBe(12_345n);
    const info = await a.nodeInfo();
    expect(info.version.length).toBeGreaterThan(0);
    await a.cancelHoldInvoice(hash);
  });
});

describe.skipIf(!IT)("LND contract (hold-invoice semantics via lncli)", () => {
  it("addholdinvoice → OPEN, cancelinvoice → CANCELED", () => {
    const { hash } = freshHashPair();
    const hashHex = hash.slice(2);
    const added = lncli("lnd-hub", ["addholdinvoice", hashHex, "--amt", "1000"]) as { payment_request: string };
    expect(added.payment_request.startsWith("lnbcrt")).toBe(true);
    const before = lncli("lnd-hub", ["lookupinvoice", hashHex]) as { state: string };
    expect(before.state).toBe("OPEN");
    lncli("lnd-hub", ["cancelinvoice", hashHex]);
    const after = lncli("lnd-hub", ["lookupinvoice", hashHex]) as { state: string };
    expect(after.state).toBe("CANCELED");
  });

  it("settleinvoice with an unknown preimage is refused", () => {
    const { preimage } = freshHashPair();
    expect(() => lncli("lnd-hub", ["settleinvoice", preimage.slice(2)])).toThrow();
  });
});
