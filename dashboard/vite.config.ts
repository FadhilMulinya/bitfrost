import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// REST + WS proxied to the mock (later: real bifrostd) so the app always
// talks same-origin /v1/*.
const target = process.env["BIFROSTD_URL"] ?? "http://127.0.0.1:8391";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5180,
    proxy: {
      "/v1/stream": { target, ws: true },
      "/v1": { target },
    },
  },
  test: { environment: "node" },
});
