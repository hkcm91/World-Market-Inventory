#!/usr/bin/env node
/*
 * World Market Inventory — product-image finder MCP server.
 *
 * Tools:
 *   list_targets        — show which labels still need a photo
 *   find_product_images — for each label, find a product image (World Market first,
 *                         then a general web image search) and push it to the sync
 *                         backend, in batches. The web app's "Sync photos" button
 *                         then pulls them in by SKU.
 *
 * Data flow:  web app  --POST /labels-->  backend  <--GET /labels--  this MCP
 *             this MCP --POST /images-->  backend  <--GET /images--   web app
 *
 * Config (env):
 *   WM_BACKEND        base URL of server/backend.mjs   (default http://localhost:8787)
 *   SERPAPI_API_KEY   key for the web-image-search fallback (https://serpapi.com)
 *                     — optional; without it, only World Market is checked.
 *
 * NOTE: World Market has no public product API, so the extraction below scrapes the
 * public search/product pages. Retailers change their markup, so the selectors in
 * worldMarketImage() are the most likely thing to need tuning against the live site.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const BACKEND = (process.env.WM_BACKEND || "http://localhost:8787").replace(/\/+$/, "");
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
const UA = "Mozilla/5.0 (compatible; WMImageFinder/0.1; +store-inventory)";
const MAX_IMG_BYTES = 1_500_000;
const CONCURRENCY = 4;

/* ---------- backend I/O ---------- */
async function getJSON(path) {
  const r = await fetch(BACKEND + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("backend " + path + " -> HTTP " + r.status);
  return r.json();
}
async function postImages(map) {
  const r = await fetch(BACKEND + "/images", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(map),
  });
  if (!r.ok) throw new Error("POST /images -> HTTP " + r.status);
  return r.json();
}

/* ---------- image sources (World Market first) ---------- */
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}
function firstMatch(html, re) { const m = html.match(re); return m ? m[1] : null; }

// Best-effort scrape of worldmarket.com. Tune these selectors against the live page.
async function worldMarketImage(sku, desc) {
  const queries = [sku, (desc || "").split(/\s+/).slice(0, 4).join(" ")].filter(Boolean);
  for (const q of queries) {
    try {
      const html = await fetchText("https://www.worldmarket.com/search?q=" + encodeURIComponent(q));
      // 1) product open-graph image (present on product pages the search may redirect to)
      let img = firstMatch(html, /<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i)
             || firstMatch(html, /<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i);
      // 2) otherwise, first product image off their image CDN (scene7)
      if (!img) img = firstMatch(html, /(https?:\/\/[^"']*scene7\.com\/is\/image\/[^"'?\s]+)/i);
      if (img && !/logo|sprite|placeholder|icon/i.test(img)) return img.replace(/&amp;/g, "&");
    } catch { /* try next query */ }
  }
  return null;
}

// Fallback: general web image search (SerpAPI Google Images). Optional.
async function webSearchImage(desc) {
  if (!SERPAPI_API_KEY || !desc) return null;
  try {
    const u = "https://serpapi.com/search.json?engine=google_images&ijn=0&q=" +
      encodeURIComponent(desc + " product package") + "&api_key=" + SERPAPI_API_KEY;
    const r = await fetch(u); if (!r.ok) return null;
    const j = await r.json();
    const hit = (j.images_results || []).find((x) => x && (x.original || x.thumbnail));
    return hit ? (hit.original || hit.thumbnail) : null;
  } catch { return null; }
}

async function toDataURI(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error("image HTTP " + r.status);
  const ct = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\//.test(ct)) throw new Error("not an image (" + ct + ")");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES) throw new Error("image too large (" + buf.length + " bytes)");
  return "data:" + ct + ";base64," + buf.toString("base64");
}

// Resolve one label to an image data-URI, or null. Records which source hit.
async function findImage(label) {
  const chain = [
    ["worldmarket", () => worldMarketImage(label.sku, label.desc)],
    ["web", () => webSearchImage(label.desc)],
  ];
  for (const [source, fn] of chain) {
    let src; try { src = await fn(); } catch { src = null; }
    if (!src) continue;
    try { return { dataUri: await toDataURI(src), source, url: src }; } catch { /* try next source */ }
  }
  return null;
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

/* ---------- targets ---------- */
async function targets({ only_missing = true, skus = null, limit = 25 } = {}) {
  const labels = await getJSON("/labels");
  const images = only_missing ? await getJSON("/images") : {};
  const wanted = skus && skus.length ? new Set(skus.map(String)) : null;
  const seen = new Set();
  const list = [];
  for (const l of labels) {
    const sku = String(l.sku);
    if (seen.has(sku)) continue; seen.add(sku);          // one lookup per unique SKU
    if (wanted && !wanted.has(sku)) continue;
    if (only_missing && images[sku]) continue;
    list.push({ sku, desc: l.desc || "" });
    if (list.length >= limit) break;
  }
  return list;
}

/* ---------- MCP wiring ---------- */
const server = new Server({ name: "wm-image-finder", version: "0.1.0" }, { capabilities: { tools: {} } });

const TOOLS = [
  {
    name: "list_targets",
    description: "List labels (from the sync backend) that still need a product photo. Use before find_product_images to preview the batch.",
    inputSchema: {
      type: "object",
      properties: {
        only_missing: { type: "boolean", description: "Only labels without an image yet (default true)." },
        skus: { type: "array", items: { type: "string" }, description: "Restrict to these SKUs." },
        limit: { type: "number", description: "Max labels to return (default 25)." },
      },
    },
  },
  {
    name: "find_product_images",
    description: "For each label needing a photo, find a product image (World Market first, then web-search fallback) and push it to the backend by SKU. Runs in one batch; call repeatedly to page through a large list.",
    inputSchema: {
      type: "object",
      properties: {
        only_missing: { type: "boolean", description: "Skip labels that already have an image (default true)." },
        skus: { type: "array", items: { type: "string" }, description: "Restrict to these SKUs." },
        limit: { type: "number", description: "Max labels to process this batch (default 25)." },
        dry_run: { type: "boolean", description: "Find images but do not write to the backend (default false)." },
      },
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args = {} } = req.params;
  try {
    if (name === "list_targets") {
      const list = await targets(args);
      return { content: [{ type: "text", text: JSON.stringify({ backend: BACKEND, count: list.length, targets: list }, null, 2) }] };
    }
    if (name === "find_product_images") {
      const list = await targets(args);
      if (!list.length) return { content: [{ type: "text", text: "Nothing to do — no labels need photos (with the given filters)." }] };
      const results = await mapLimit(list, CONCURRENCY, async (label) => ({ label, hit: await findImage(label) }));
      const map = {}, found = [], missed = [];
      for (const { label, hit } of results) {
        if (hit) { map[label.sku] = hit.dataUri; found.push({ sku: label.sku, source: hit.source, url: hit.url }); }
        else missed.push({ sku: label.sku, desc: label.desc });
      }
      let posted = 0;
      if (!args.dry_run && found.length) posted = (await postImages(map)).added || 0;
      return { content: [{ type: "text", text: JSON.stringify({
        backend: BACKEND, processed: list.length,
        found: found.length, missed: missed.length,
        posted: args.dry_run ? "(dry run — not written)" : posted,
        serpapi: SERPAPI_API_KEY ? "enabled" : "disabled (World Market only)",
        details: { found, missed },
      }, null, 2) }] };
    }
    return { content: [{ type: "text", text: "Unknown tool: " + name }], isError: true };
  } catch (e) {
    return { content: [{ type: "text", text: "Error: " + e.message }], isError: true };
  }
});

await server.connect(new StdioServerTransport());
console.error("wm-image-finder MCP ready · backend=" + BACKEND + " · web-search=" + (SERPAPI_API_KEY ? "on" : "off"));
