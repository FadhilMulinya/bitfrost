// Local dev: bifrostd's api/ gateway, published on the host at 127.0.0.1:8391
// (see deploy/docker-compose.dev.yml's netbase port publish). To point this
// demo at a non-local hub instead (e.g. an ngrok tunnel), override at build
// time with VITE_HUB_URL — see demo/README.md.
export const HUB_URL = import.meta.env.VITE_HUB_URL ?? "http://localhost:8391";

// Harmless no-op against a local hub; only load-bearing when HUB_URL points
// at an ngrok tunnel, whose free-tier interstitial warning page otherwise
// intercepts requests and returns HTML instead of the hub's JSON.
export const NGROK_HEADERS = { "ngrok-skip-browser-warning": "true" };
