/** Entry point. Binds localhost only by default (CLAUDE.md: never expose
 * unauthenticated RPC beyond localhost; put a TLS proxy in front for prod). */
import { openStore } from "./db.js";
import { buildServer } from "./server.js";

const port = Number(process.env["REGISTRY_PORT"] ?? 8380);
const host = process.env["REGISTRY_HOST"] ?? "127.0.0.1";
const dbPath = process.env["REGISTRY_DB"] ?? "registry.sqlite3";

const app = buildServer({ store: openStore(dbPath), logger: true });
app.listen({ port, host }).catch((e) => {
  app.log.error(e);
  process.exit(1);
});
