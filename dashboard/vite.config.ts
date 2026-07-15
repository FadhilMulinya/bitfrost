import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

// REST + WS proxied to bifrostd (real gateway now — see bifrostd/src/api/,
// previously the mock/server.ts placeholder) so the app always talks
// same-origin /v1/*. Configurable via BIFROSTD_URL — never hard-coded — so
// dashboard/.env / .env.local (copy dashboard/.env.example) or a real shell
// env var both work. loadEnv's third arg "" (not the default "VITE_") is
// required: BIFROSTD_URL is consumed HERE, at config-eval time in Node, not
// by client code via import.meta.env, so it must NOT be prefixed VITE_.
export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");
  const target = env["BIFROSTD_URL"] ?? "http://127.0.0.1:8391";
  return {
    plugins: [react()],
    server: {
      port: 5180,
      proxy: {
        "/v1/stream": { target, ws: true },
        "/v1": { target },
      },
    },
    test: { environment: "node" },
  };
});
