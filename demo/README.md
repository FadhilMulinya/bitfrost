# Bifrost Merchant Checkout (demo/)

A standalone Vite + React tool merchants embed so their customers can pay a
Lightning (BOLT11) invoice using Fiber assets, through a live Bifrost hub —
speaks `bifrost/0.1` end to end (signed quotes, hash-consistent orders,
§9 client verification checklist) via `bifrost-sdk`.

This is separate from `bifrostd/`, `sdk/`, and `dashboard/` — it only talks
to a hub's public `/v1` API, nothing here runs the daemon or touches its
code.

## Pages

- **`/`** — Merchant Dashboard. Paste a Lightning invoice + shop name,
  generate a shareable `/checkout` link (with a QR code of the link itself),
  or click **Try Demo** to preview the checkout flow with a placeholder
  invoice.
- **`/checkout?invoice=lnbc...&amount=...&merchant=...`** — Customer Payment
  Page. Get a signed quote (verified client-side via `verifyQuote` from
  `bifrost-sdk`, PROTOCOL.md §9), confirm to create an order, scan the
  returned Fiber hold invoice as a QR code, and watch live status until the
  swap settles.

## Hub

By default this points at `bifrostd`'s api/ gateway running **locally**
(`http://localhost:8391`, the port `deploy/docker-compose.dev.yml`
publishes on the host — see `src/config.js`). Bring up the dev stack
(`deploy/README.md`) and this demo talks to it directly, no tunnel needed.

To point the demo at a non-local hub instead — e.g. sharing it with
someone off your machine via an ngrok tunnel — set `VITE_HUB_URL` at build
or dev time:

```bash
VITE_HUB_URL=https://your-tunnel.ngrok-free.app npm run dev
# or for a production build:
VITE_HUB_URL=https://your-tunnel.ngrok-free.app npm run build
```

`src/config.js` always sends `ngrok-skip-browser-warning: true` on every
request — a no-op against a local hub, but required against an ngrok
free-tier tunnel, whose interstitial warning page otherwise intercepts
requests and returns HTML instead of the hub's JSON.

## Local development

```bash
cd demo
npm install
npm run dev      # http://localhost:5173
npm run build    # production build, output in dist/
```

## Deploy to Vercel

```bash
npm i -g vercel && vercel
```

## Embed checkout in any website

```html
<a href="https://your-demo.vercel.app/checkout?invoice=BOLT11&merchant=YourShop">
  Pay with Fiber
</a>
```

`invoice` should be the raw BOLT11 string and `amount` (sat) is normally
derived automatically from the invoice by the Merchant Dashboard when it
builds the link — pass it explicitly if you're constructing the URL by hand.
