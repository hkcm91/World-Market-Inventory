# Product photos: sync backend + image-finder MCP

This adds product images to the label sheet. Three pieces work together:

```
  Web app (index.html)            Sync backend (server/)           Image-finder MCP (mcp/)
  ───────────────────             ──────────────────────           ───────────────────────
  Photo template renders          Tiny JSON store:                 Reads /labels, finds a
  a product image per label.      • /labels  (from the app)        product image per SKU
  "Sync photos" button:           • /images  (from the MCP)        (World Market first, then
   POST /labels, GET /images.     CORS-enabled, no deps.           a web-search fallback),
                                                                    POST /images.
```

The app stays offline-first: without a backend URL it still works with per-row
photo upload and **Import photos** (a `{ "sku": "image" }` JSON file). The backend
only powers the automatic **Sync photos** flow.

## 1. Run the backend

```bash
node server/backend.mjs                 # http://localhost:8787, data in ./wm-data.json
# or: PORT=9000 DATA_FILE=/var/wm.json node server/backend.mjs
```

Endpoints: `GET /health`, `GET|POST /labels`, `GET|POST /images`, `DELETE /images`.
Images are stored as strings — either `data:` URIs (recommended; no CORS issues in
the PDF) or `https://` URLs. For phones to reach it, host it somewhere both the
phone and the MCP can see (a small VM, a tunnel like `cloudflared`, etc.).

## 2. Point the app at it

In the **Labels** tab, tap **Sync photos** and enter the backend URL. The app pushes
its label list up and pulls any images already found. The URL is remembered on the device.

## 3. Run the image finder (MCP)

```bash
cd mcp && npm install
WM_BACKEND=http://localhost:8787 SERPAPI_API_KEY=<optional> node index.mjs
```

- `WM_BACKEND` — same URL as the backend.
- `SERPAPI_API_KEY` — enables the web-image-search fallback (https://serpapi.com).
  Without it, only World Market is checked.

Register it with your MCP client (Claude Desktop / `claude mcp`). Example
`claude_desktop_config.json` entry:

```json
{
  "mcpServers": {
    "wm-image-finder": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/index.mjs"],
      "env": { "WM_BACKEND": "http://localhost:8787", "SERPAPI_API_KEY": "" }
    }
  }
}
```

Then ask the assistant to run **`list_targets`** (preview what needs photos) and
**`find_product_images`** (find + upload them in a batch; call again to page through
a long list). Back in the app, tap **Sync photos** to pull the results.

## Caveats

- **World Market has no public product API.** The finder scrapes the public search
  pages; the selectors in `mcp/index.mjs → worldMarketImage()` are the most likely
  thing to need tuning if the site markup changes or a lookup comes back empty.
- Retail scraping should respect the site's terms and rate limits — the finder runs
  a small batch at low concurrency by design.
- Images are stored full-size as fetched. For a very large catalog you may want to
  downscale server-side (e.g. add `sharp`) to keep the app's local storage light.
