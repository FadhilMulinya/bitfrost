#!/usr/bin/env node
// CLI over the fnn hex codec so shell scripts share the one codec module.
// Usage: codec-cli.mjs encode-u128 100000000  -> 0x5f5e100
//        codec-cli.mjs decode-u128 0x5f5e100  -> 100000000
import { encodeU128Hex, decodeU128Hex, encodeU64Hex, decodeU64Hex } from "../../dist/fnn/codec.js";

const [op, arg] = process.argv.slice(2);
const ops = {
  "encode-u64": (a) => encodeU64Hex(BigInt(a)),
  "decode-u64": (a) => decodeU64Hex(a).toString(),
  "encode-u128": (a) => encodeU128Hex(BigInt(a)),
  "decode-u128": (a) => decodeU128Hex(a).toString(),
};
if (!op || !(op in ops) || arg === undefined) {
  console.error("usage: codec-cli.mjs <encode-u64|decode-u64|encode-u128|decode-u128> <value>");
  process.exit(2);
}
try {
  process.stdout.write(ops[op](arg) + "\n");
} catch (e) {
  console.error(String(e.message ?? e));
  process.exit(1);
}
