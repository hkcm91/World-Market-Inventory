#!/usr/bin/env node
/*
 * World Market Inventory — standalone product-image finder.
 *
 * Reads the label list from the sync backend, finds a product photo for each SKU
 * (World Market first, then an optional web-image-search fallback), and posts them
 * back to the backend. This is the same logic as the MCP, but as a plain CLI so you
 * DON'T need a Claude client to run it.
 *
 *   node server/backend.mjs                 # terminal 1: run the server
 *   node server/fetch-images.mjs            # terminal 2: fill in the photos
 *   # then tap "Sync photos" in the app
 *
 * Config (env):
 *   WM_BACKEND        backend base URL          (default http://localhost:8787)
 *   SERPAPI_API_KEY   web-search fallback key    (optional; WM-only without it)
 *   ONLY_MISSING      "0" to refetch everything  (default: skip SKUs already done)
 */
const BACKEND = (process.env.WM_BACKEND || "http://localhost:8787").replace(/\/+$/, "");
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
const ONLY_MISSING = process.env.ONLY_MISSING !== "0";
const UA = "Mozilla/5.0 (compatible; WMImageFinder/0.1; +store-inventory)";
const MAX_IMG_BYTES = 1_500_000, CONCURRENCY = 4;

async function getJSON(path) {
  const r = await fetch(BACKEND + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("backend " + path + " -> HTTP " + r.status);
  return r.json();
}
async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.text();
}

// World Market: the store SKU is the site's product id (data-pid); grab that tile's large image.
async function worldMarketImage(sku) {
  try {
    const html = await fetchText("https://www.worldmarket.com/search?q=" + encodeURIComponent(sku));
    const i = html.indexOf('data-pid="' + sku + '"');
    if (i < 0) return null;
    const seg = html.slice(Math.max(0, i - 3000), i + 3000);
    const m = seg.match(/https:\/\/www\.worldmarket\.com\/dw\/image\/v2\/[^"' ]*?images\/large\/[^"' ]+?\.(?:jpg|jpeg|png)/);
    return m ? m[0].split("?")[0] + "?sw=240&sh=240&sm=fit&q=82" : null;
  } catch { return null; }
}
// Fallback: general web image search (SerpAPI Google Images). Optional.
async function webSearchImage(desc) {
  if (!SERPAPI_API_KEY || !desc) return null;
  try {
    const u = "https://serpapi.com/search.json?engine=google_images&ijn=0&q=" +
      encodeURIComponent(desc + " product package") + "&api_key=" + SERPAPI_API_KEY;
    const r = await fetch(u); if (!r.ok) return null;
    const hit = ((await r.json()).images_results || []).find((x) => x && (x.original || x.thumbnail));
    return hit ? hit.original || hit.thumbnail : null;
  } catch { return null; }
}
async function toDataURI(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error("image HTTP " + r.status);
  const ct = (r.headers.get("content-type") || "image/jpeg").split(";")[0].trim();
  if (!/^image\//.test(ct)) throw new Error("not an image");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES) throw new Error("too large");
  return "data:" + ct + ";base64," + buf.toString("base64");
}
async function findImage(label) {
  for (const [src, fn] of [["WM", () => worldMarketImage(label.sku)], ["web", () => webSearchImage(label.desc)]]) {
    let u; try { u = await fn(); } catch { u = null; }
    if (!u) continue;
    try { return { uri: await toDataURI(u), src }; } catch { /* next source */ }
  }
  return null;
}
async function mapLimit(items, limit, worker) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; await worker(items[idx]); }
  }));
}

(async () => {
  console.log("backend: " + BACKEND + "  ·  web-search: " + (SERPAPI_API_KEY ? "on" : "off"));
  const labels = await getJSON("/labels");
  if (!labels.length) { console.log('No labels on the server yet — open the app and tap "Sync photos" once to push your list up, then run this again.'); return; }
  const have = ONLY_MISSING ? await getJSON("/images") : {};
  const seen = new Set(), todo = [];
  for (const l of labels) { const sku = String(l.sku); if (seen.has(sku)) continue; seen.add(sku); if (ONLY_MISSING && have[sku]) continue; todo.push({ sku, desc: l.desc || "" }); }
  console.log("looking up " + todo.length + " SKU(s)…\n");
  const found = {}; let ok = 0, miss = 0;
  await mapLimit(todo, CONCURRENCY, async (l) => {
    const hit = await findImage(l);
    if (hit) { found[l.sku] = hit.uri; ok++; console.log("  ✓ " + l.sku + " (" + hit.src + ")  " + l.desc); }
    else { miss++; console.log("  · " + l.sku + " — no image  " + l.desc); }
  });
  if (Object.keys(found).length) await fetch(BACKEND + "/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(found) });
  console.log("\nfound " + ok + ", missed " + miss + ". " + (ok ? 'Now tap "Sync photos" in the app.' : "") +
    (miss && !SERPAPI_API_KEY ? "\n(Set SERPAPI_API_KEY to fill the misses via web search.)" : ""));
})().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
