#!/usr/bin/env node
/**
 * Repo-root convenience wrapper. The repo has no root node_modules (each
 * package under bifrostd/, sdk/, etc. installs its own deps independently),
 * so the actual key-generation logic lives at
 * bifrostd/scripts/generate-hub-key.mjs, next to its @noble/curves
 * dependency. This just re-execs it so `node scripts/generate-hub-key.mjs`
 * works from the repo root too.
 */
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const target = join(here, "..", "bifrostd", "scripts", "generate-hub-key.mjs");

try {
  execFileSync(process.execPath, [target], { stdio: "inherit", cwd: join(here, "..", "bifrostd") });
} catch (err) {
  process.exit(err.status ?? 1);
}
