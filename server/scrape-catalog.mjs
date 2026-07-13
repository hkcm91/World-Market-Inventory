#!/usr/bin/env node
/*
 * World Market catalog scraper — builds the product library for gallery.html.
 *
 * WHY THIS EXISTS (the "stops at 300" fix)
 * ----------------------------------------
 * worldmarket.com runs on Salesforce Commerce Cloud (Demandware). Its storefront
 * product grid hard-caps a SINGLE request at ~300 hits: asking a category for
 * `?sz=300` (or larger) returns only ~300 tiles even when the category has 541.
 * So any one-shot fetch silently truncates at an even 300.
 *
 * The reachable results ARE all there — you just have to PAGE the grid with the
 * `start` offset (start=0, 300, 600 …) via the Search-UpdateGrid endpoint and
 * union the tiles, deduping by SKU. This script does exactly that, so a category
 * comes back complete (candy = ~540 unique) instead of capped at 300.
 *
 * Each tile is a <div class="product js-a-tile-data" …> carrying everything we
 * need as data-* attributes (data-sku, data-product-name, data-image-url,
 * data-price, data-category-names), so no fragile inner-HTML scraping.
 *
 * IMAGES: library.json stores images as inline base64 data URIs so gallery.html
 * is self-contained. This script preserves the image already on file for a SKU
 * and only downloads + inlines an image for NEW products (the ones the 300 cap
 * was hiding) — so re-running is cheap and never churns existing rows. Use
 * --refresh-images to re-fetch everything, or --no-images to store the CDN URL.
 *
 * Usage:
 *   node server/scrape-catalog.mjs                    # refresh candy dept, add any new SKUs
 *   node server/scrape-catalog.mjs --cgid 117110 --source candy-dept
 *   node server/scrape-catalog.mjs --q "hot sauce" --source pantry
 *   node server/scrape-catalog.mjs --dry              # report only, don't write
 *
 * Flags:
 *   --cgid <id>       category id to scrape (default 117110 = Candy & Chocolate)
 *   --q <text>        scrape a search query instead of a category
 *   --source <tag>    value written to each row's `source` (default candy-dept)
 *   --sz <n>          page size per request (default 300 — the cap; we page past it)
 *   --out <file>      output file (default library.json at repo root)
 *   --refresh-images  re-download images for every product (default: only new SKUs)
 *   --no-images       keep the remote CDN image URL instead of inlining a data URI
 *   --replace-all     drop existing rows for this source instead of merging
 *   --dry             scrape and report, but don't write the file
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const UA = "Mozilla/5.0 (compatible; WMCatalogScraper/1.0; +store-inventory)";
const SITE = "https://www.worldmarket.com/on/demandware.store/Sites-World_Market-Site/en_US";
const OUT_DEFAULT = fileURLToPath(new URL("../library.json", import.meta.url));
const MAX_IMG_BYTES = 1_500_000;
const IMG_CONCURRENCY = 6;

/* ---------- args ---------- */
function arg(name, def = null) {
  const i = process.argv.indexOf("--" + name);
  if (i < 0) return def;
  const v = process.argv[i + 1];
  return v && !v.startsWith("--") ? v : true;
}
const CGID = arg("q") ? null : String(arg("cgid", "117110"));
const QUERY = arg("q") || null;
const SOURCE = String(arg("source", "candy-dept"));
const SZ = Math.max(1, parseInt(arg("sz", "300"), 10) || 300);
const OUT = arg("out") ? String(arg("out")) : OUT_DEFAULT;
const REFRESH_IMAGES = !!arg("refresh-images", false);
const NO_IMAGES = !!arg("no-images", false);
const REPLACE_ALL = !!arg("replace-all", false);
const DRY = !!arg("dry", false);

/* ---------- http ---------- */
async function fetchText(url) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, redirect: "follow" });
      if (r.status === 429 || r.status >= 500) throw new Error("HTTP " + r.status);
      return { status: r.status, text: await r.text() };
    } catch (e) {
      if (attempt === 3) throw e;
      await new Promise((res) => setTimeout(res, 400 * 2 ** attempt));
    }
  }
}
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&gt;/g, ">").replace(/&lt;/g, "<");
const attr = (block, name) => {
  const m = block.match(new RegExp('data-' + name + '="([^"]*)"'));
  return m ? decode(m[1]) : "";
};

async function toDataURI(url) {
  // Request a small square render straight from the CDN to keep the data URI light.
  const sized = url.split("?")[0] + "?sw=385&sh=385&sm=fit&q=80";
  const r = await fetch(sized, { headers: { "User-Agent": UA }, redirect: "follow" });
  if (!r.ok) throw new Error("image HTTP " + r.status);
  const ct = (r.headers.get("content-type") || "").split(";")[0].trim();
  if (!/^image\//.test(ct)) throw new Error("not an image (" + ct + ")");
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length > MAX_IMG_BYTES) throw new Error("image too large");
  return "data:" + ct + ";base64," + buf.toString("base64");
}

async function mapLimit(items, limit, worker) {
  const out = new Array(items.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) { const idx = i++; out[idx] = await worker(items[idx], idx); }
  }));
  return out;
}

function gridUrl(start) {
  const q = CGID ? "cgid=" + encodeURIComponent(CGID) : "q=" + encodeURIComponent(QUERY);
  return SITE + "/Search-UpdateGrid?" + q + "&sz=" + SZ + "&start=" + start;
}

/* ---------- parse one grid page into product rows ---------- */
function parseTiles(html) {
  const rows = [];
  const re = /<div class="product js-a-tile-data"[\s\S]*?data-image-url="[^"]*"/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const block = m[0];
    const sku = attr(block, "sku");
    if (!sku || sku === "null") continue;
    let cats = [];
    try { cats = JSON.parse(attr(block, "category-names") || "[]"); } catch { /* ignore */ }
    rows.push({
      sku,
      name: attr(block, "product-name"),
      imgUrl: attr(block, "image-url").split("?")[0],
      cat: cats[0] || "",
      price: attr(block, "price"), // keep as string to match library.json's existing format
      source: SOURCE,
    });
  }
  return rows;
}

/* ---------- page the whole category, past the 300 cap ---------- */
async function scrapeAll() {
  const bySku = new Map();
  let start = 0, emptyStreak = 0, pages = 0;
  const label = CGID ? "cgid=" + CGID : 'q="' + QUERY + '"';
  console.error(`Scraping ${label} (source=${SOURCE}, sz=${SZ}) — paging past the SFCC 300 cap…`);
  while (start < 5000) {
    const { status, text } = await fetchText(gridUrl(start));
    const tiles = parseTiles(text);
    let added = 0;
    for (const t of tiles) if (!bySku.has(t.sku)) { bySku.set(t.sku, t); added++; }
    pages++;
    console.error(`  start=${start} → HTTP ${status}, tiles=${tiles.length}, new=${added}, total=${bySku.size}`);
    if (added === 0) { if (++emptyStreak >= 2) break; } else emptyStreak = 0;
    start += Math.max(tiles.length, SZ); // grid caps ~300; advance by what it actually returned
  }
  console.error(`Done paging: ${bySku.size} unique products across ${pages} page(s).`);
  return [...bySku.values()];
}

/* ---------- merge + images + write ---------- */
function loadExisting(file) {
  if (!existsSync(file)) return [];
  try { const d = JSON.parse(readFileSync(file, "utf8")); return Array.isArray(d) ? d : []; }
  catch { return []; }
}

const scraped = await scrapeAll();
if (!scraped.length) { console.error("No products scraped — aborting without writing."); process.exit(1); }

const existing = loadExisting(OUT);
const existingBySku = new Map(existing.map((r) => [String(r.sku), r]));

// Decide, per scraped product, which image to use and whether we must download it.
const needImage = [];
const rows = scraped.map((p) => {
  const prev = existingBySku.get(p.sku);
  const keepImg = !REFRESH_IMAGES && prev && typeof prev.img === "string" && prev.img.startsWith("data:");
  const row = { sku: p.sku, name: p.name, img: keepImg ? prev.img : (NO_IMAGES ? p.imgUrl : ""), cat: p.cat, price: p.price, source: SOURCE, _url: p.imgUrl, _need: !keepImg && !NO_IMAGES };
  if (row._need) needImage.push(row);
  return row;
});

console.error(`${rows.length} products · reusing ${rows.length - needImage.length} existing image(s) · fetching ${needImage.length} new image(s).`);

if (!DRY && needImage.length) {
  let ok = 0, fail = 0;
  await mapLimit(needImage, IMG_CONCURRENCY, async (row) => {
    try { row.img = await toDataURI(row._url); ok++; }
    catch { row.img = row._url; fail++; } // fall back to the CDN URL if the download fails
  });
  console.error(`Images: ${ok} inlined, ${fail} fell back to URL.`);
}
rows.forEach((r) => { delete r._url; delete r._need; });

// Assemble final file: keep other sources untouched; replace this source with the scrape.
let out;
if (REPLACE_ALL) {
  out = existing.filter((r) => r.source !== SOURCE).concat(rows);
} else {
  const others = existing.filter((r) => r.source !== SOURCE);
  const mine = new Set(rows.map((r) => r.sku));
  // Preserve any prior rows of this source whose SKU dropped out of the live grid,
  // so a transient grid hiccup can't silently delete products.
  const keptOld = existing.filter((r) => r.source === SOURCE && !mine.has(r.sku));
  if (keptOld.length) console.error(`Kept ${keptOld.length} prior ${SOURCE} row(s) not seen in this scrape.`);
  out = others.concat(rows, keptOld);
}

const bySource = out.reduce((a, r) => ((a[r.source] = (a[r.source] || 0) + 1), a), {});
const added = rows.filter((r) => !existingBySku.has(r.sku)).length;
console.error("Result by source:", bySource, "· total", out.length, "· new this run:", added);

if (DRY) { console.error("(--dry) not writing."); process.exit(0); }
writeFileSync(OUT, JSON.stringify(out));
console.error("Wrote " + OUT + " (" + out.length + " rows).");
