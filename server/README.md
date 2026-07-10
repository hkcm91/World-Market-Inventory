# Product photos: sync server + image finder

Two ways to get product photos onto the labels:

- **Import photos** (in the app) — no server. Pick a `{ "sku": "image" }` JSON file and it
  applies the images locally. Simplest for a one-off.
- **Sync photos** (this folder) — a small server finds product images automatically and the
  app pulls them by SKU. Set it up once, re-run the finder whenever the list changes.

## Sync setup (the easy path)

You need a computer with **Node 18+** that's on the **same Wi‑Fi** as the phone. No Claude
client required — it's two commands.

**1. Run the server** (serves the app *and* the sync API from one place):

```bash
node server/backend.mjs          # listens on :8787
```

Find the computer's LAN address (e.g. `192.168.1.42`): macOS `ipconfig getifaddr en0`,
Windows `ipconfig`, Linux `hostname -I`.

**2. Open the app on the phone** at `http://<computer-ip>:8787/` (same Wi‑Fi). Because the app
is served *from* the sync server, everything is same‑origin — no URL typing, no mixed‑content
blocks. Go to the **Labels** tab and tap **Sync photos** once (the URL is pre‑filled — just
tap OK). That pushes your label list up to the server.

**3. Find the photos:**

```bash
node server/fetch-images.mjs                       # World Market only
SERPAPI_API_KEY=xxxx node server/fetch-images.mjs  # + web-search fallback for misses
```

It reads your labels from the server, finds a product photo for each SKU (World Market first,
then the optional web search), and posts them back.

**4. Back on the phone, tap Sync photos again** — the real product images appear.

Re-run steps 3–4 anytime you add SKUs. Env vars: `WM_BACKEND` (default `http://localhost:8787`),
`SERPAPI_API_KEY` (optional), `ONLY_MISSING=0` to refetch everything.

### Reaching it when phone and computer aren't on the same network

Put a tunnel in front of the server (gives an `https://…` URL that works anywhere):

```bash
cloudflared tunnel --url http://localhost:8787      # or: ngrok http 8787
```

Open that URL on the phone instead. (If you serve the app from somewhere else over HTTPS,
the sync server must also be HTTPS — browsers block an HTTPS page from calling an HTTP server.
Serving the app from this server, as above, avoids that entirely.)

## Alternative: the MCP (for Claude Desktop / `claude mcp` users)

`mcp/` exposes the same finder as MCP tools (`list_targets`, `find_product_images`) so you can
drive it from a Claude client. It talks to the same backend. See `mcp/` and register it with
`WM_BACKEND` set. The standalone `fetch-images.mjs` above does the same job without a client.

## Server API

`GET /` (the app) · `GET /health` · `GET|POST /labels` · `GET|POST /images` · `DELETE /images`.
CORS-enabled. Data persists to `wm-data.json` (override with `DATA_FILE`). Images are stored as
`data:` URIs so they render in the PDF with no cross-origin issues.

## Caveats

- **World Market has no public product API.** The finder scrapes the public search pages. The
  store SKU doubles as the site's product id (`data-pid`), and the product photo lives under
  `Sites-wm-master-catalog/.../images/large/`. Verified against the live site — a spot-check of
  the seed list resolved ~72% of SKUs straight from World Market; the rest were items not in
  WM's web catalog and need the web-search fallback (or a per-row upload). If WM changes its
  markup, `worldMarketImage()` in `fetch-images.mjs` / `mcp/index.mjs` is what to re-tune.
