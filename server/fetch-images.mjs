#!/usr/bin/env node
/*
 * World Market Inventory — standalone product-image finder.
 *
 * Finds a product photo for each SKU (World Market first, then an optional
 * web-image-search fallback). The World Market lookup is exact — the store SKU is
 * WM's own product id (data-pid) — so it never guesses a wrong image.
 *
 *   node server/fetch-images.mjs --skus skus.txt --out photos.json
 *        # feed a plain SKU list (one per line; extra text/qty ignored) and write
 *        # the bundle the app auto-loads. Safe for hundreds: throttled, retried,
 *        # and saved incrementally so you can stop/resume (re-run to fill misses).
 *
 *   node server/fetch-images.mjs --out photos.json      # SKUs from the app's seed
 *   node server/fetch-images.mjs                         # SKUs from the sync backend
 *
 * Config (env):
 *   WM_BACKEND        backend base URL          (default http://localhost:8787)
 *   SERPAPI_API_KEY   web-search fallback key    (optional; WM-only without it)
 *   ONLY_MISSING      "0" to refetch everything  (default: skip SKUs already done)
 *   CONCURRENCY       parallel lookups           (default 4)
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const argv = process.argv.slice(2);
const argVal = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const SKUS_FILE = argVal("--skus");
const OUT = argVal("--out") || process.env.OUT_FILE || null;
const BACKEND = (process.env.WM_BACKEND || "http://localhost:8787").replace(/\/+$/, "");
const SERPAPI_API_KEY = process.env.SERPAPI_API_KEY || "";
const ONLY_MISSING = process.env.ONLY_MISSING !== "0";
const CONCURRENCY = Math.max(1, parseInt(process.env.CONCURRENCY || "4", 10));
const UA = "Mozilla/5.0 (compatible; WMImageFinder/0.1; +store-inventory)";
const MAX_IMG_BYTES = 1_500_000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- label sources ---------- */
async function getJSON(path) {
  const r = await fetch(BACKEND + path, { headers: { Accept: "application/json" } });
  if (!r.ok) throw new Error("backend " + path + " -> HTTP " + r.status);
  return r.json();
}
function seedLabels() {
  const html = readFileSync(fileURLToPath(new URL("../index.html", import.meta.url)), "utf8");
  const block = (html.match(/const SEED\s*=\s*\[([\s\S]*?)\];/) || [])[1] || "";
  const out = [], re = /sku:\s*"(\d+)"\s*,\s*desc:\s*"([^"]*)"/g; let m;
  while ((m = re.exec(block)) !== null) out.push({ sku: m[1], desc: m[2] });
  return out;
}
// A plain list: one SKU per line (a JSON array works too). Extra columns/qty/desc are ignored
// except as a description hint for the web-search fallback.
function skusFromFile(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (raw[0] === "[") { try { return JSON.parse(raw).map((x) => typeof x === "object" ? { sku: String(x.sku), desc: x.desc || "" } : { sku: String(x), desc: "" }); } catch { /* fall through */ } }
  return raw.split(/\r?\n/).map((line) => {
    const s = line.trim(); if (!s || /^(sku|item)\b/i.test(s)) return null;   // skip blanks + header row
    const m = s.match(/\d{4,7}/); if (!m) return null;
    return { sku: m[0], desc: s.replace(m[0], "").replace(/[;,|\t]+/g, " ").trim() };
  }).filter(Boolean);
}
async function getLabels() { return SKUS_FILE ? skusFromFile(SKUS_FILE) : OUT ? seedLabels() : getJSON("/labels"); }
async function currentImages() {
  if (OUT) { try { return JSON.parse(readFileSync(OUT, "utf8")); } catch { return {}; } }
  return getJSON("/images");
}

/* ---------- image lookup (throttled + retried) ---------- */
async function fetchWithRetry(url, accept) {
  for (let a = 0; a < 3; a++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: accept }, redirect: "follow", signal: AbortSignal.timeout(25000) });
      if (r.status === 429 || r.status >= 500) { await sleep(900 * (a + 1)); continue; }
      return r;
    } catch (e) { if (a === 2) throw e; await sleep(700 * (a + 1)); }
  }
  throw new Error("gave up after retries");
}
async function worldMarketImage(sku) {
  try {
    const r = await fetchWithRetry("https://www.worldmarket.com/search?q=" + encodeURIComponent(sku), "text/html");
    if (!r.ok) return null;
    const html = await r.text();
    const i = html.indexOf('data-pid="' + sku + '"');
    if (i < 0) return null;
    const seg = html.slice(Math.max(0, i - 3000), i + 3000);
    const m = seg.match(/https:\/\/www\.worldmarket\.com\/dw\/image\/v2\/[^"' ]*?images\/large\/[^"' ]+?\.(?:jpg|jpeg|png)/);
    return m ? m[0].split("?")[0] + "?sw=240&sh=240&sm=fit&q=82" : null;
  } catch { return null; }
}
async function webSearchImage(desc) {
  if (!SERPAPI_API_KEY || !desc) return null;
  try {
    const r = await fetch("https://serpapi.com/search.json?engine=google_images&ijn=0&q=" + encodeURIComponent(desc + " product package") + "&api_key=" + SERPAPI_API_KEY);
    if (!r.ok) return null;
    const hit = ((await r.json()).images_results || []).find((x) => x && (x.original || x.thumbnail));
    return hit ? hit.original || hit.thumbnail : null;
  } catch { return null; }
}
async function toDataURI(url) {
  const r = await fetchWithRetry(url, "image/*");
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

/* ---------- run ---------- */
(async () => {
  console.log((OUT ? "writing bundle: " + OUT : "backend: " + BACKEND) +
    "  ·  source: " + (SKUS_FILE ? SKUS_FILE : OUT ? "app seed" : "backend") +
    "  ·  web-search: " + (SERPAPI_API_KEY ? "on" : "off") + "  ·  concurrency: " + CONCURRENCY);
  const labels = await getLabels();
  if (!labels.length) { console.log("No SKUs to look up."); return; }
  const have = { ...(ONLY_MISSING ? await currentImages() : {}) };
  const seen = new Set(), todo = [];
  for (const l of labels) { const sku = String(l.sku); if (seen.has(sku)) continue; seen.add(sku); if (ONLY_MISSING && have[sku]) continue; todo.push({ sku, desc: l.desc || "" }); }
  console.log("looking up " + todo.length + " new SKU(s)" + (ONLY_MISSING && Object.keys(have).length ? " (" + Object.keys(have).length + " already have photos)" : "") + "…\n");

  const found = { ...have };
  let ok = 0, miss = 0, done = 0;
  function persist() { if (OUT) writeFileSync(OUT, JSON.stringify(found)); }          // save-as-you-go
  async function postBatch() { if (!OUT && ok) await fetch(BACKEND + "/images", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(found) }); }

  let i = 0;
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, todo.length) }, async () => {
    while (i < todo.length) {
      const l = todo[i++];
      const hit = await findImage(l);
      done++;
      if (hit) { found[l.sku] = hit.uri; ok++; persist(); if (done % 10 === 0 || done === todo.length) console.log("  [" + done + "/" + todo.length + "] ✓ " + l.sku + " (" + hit.src + ")"); }
      else { miss++; console.log("  [" + done + "/" + todo.length + "] · " + l.sku + " — no image  " + l.desc); }
      await sleep(200);                                                                // be polite over hundreds of requests
    }
  }));
  await postBatch();
  console.log("\nfound " + ok + ", missed " + miss + " of " + todo.length + "." +
    (OUT ? "  Bundle now has " + Object.keys(found).length + " photo(s) in " + OUT + "." : "  Reload the app to see them.") +
    (miss && !SERPAPI_API_KEY ? "\n(" + miss + " miss(es) — set SERPAPI_API_KEY to try the web-search fallback, or add those per-row.)" : ""));
})().catch((e) => { console.error("Error: " + e.message); process.exit(1); });
