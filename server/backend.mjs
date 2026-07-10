#!/usr/bin/env node
/*
 * World Market Inventory — tiny sync backend.
 *
 * Dependency-free (Node built-ins only). Stores two things in a JSON file:
 *   labels : [{ sku, desc }]   — pushed up by the web app
 *   images : { sku: imageDataURIorURL } — filled in by the image-finder MCP
 *
 * The web app POSTs its label list and GETs the image map (tap "Sync photos").
 * The MCP GETs the label list, finds product images, and POSTs the image map.
 *
 *   node server/backend.mjs           # listens on :8787, data in ./wm-data.json
 *   PORT=9000 DATA_FILE=/tmp/wm.json node server/backend.mjs
 */
import http from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// the app lives one level up from this file (repo root)
const APP_FILE = fileURLToPath(new URL("../index.html", import.meta.url));

const PORT = parseInt(process.env.PORT || "8787", 10);
const DATA_FILE = process.env.DATA_FILE || "wm-data.json";
const MAX_BODY = 24 * 1024 * 1024; // 24 MB (data-URI images add up)

let db = { labels: [], images: {} };
if (existsSync(DATA_FILE)) {
  try { db = { labels: [], images: {}, ...JSON.parse(readFileSync(DATA_FILE, "utf8")) }; }
  catch { console.error("Could not parse " + DATA_FILE + ", starting empty."); }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => { try { writeFileSync(DATA_FILE, JSON.stringify(db)); } catch (e) { console.error("save failed", e.message); } }, 100);
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
};
function send(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json", ...CORS });
  res.end(JSON.stringify(obj));
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", (c) => { size += c.length; if (size > MAX_BODY) { reject(new Error("body too large")); req.destroy(); } else data += c; });
    req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch (e) { reject(new Error("invalid JSON")); } });
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  const path = url.pathname.replace(/\/+$/, "") || "/";
  if (req.method === "OPTIONS") { res.writeHead(204, CORS); return res.end(); }

  try {
    // serve the app itself so a phone can load it straight from this server (same origin as the API)
    if (req.method === "GET" && (path === "/" || path === "/index.html")) {
      try {
        const html = readFileSync(APP_FILE);
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", ...CORS });
        return res.end(html);
      } catch { return send(res, 500, { error: "index.html not found next to server/" }); }
    }
    if (req.method === "GET" && path === "/health")
      return send(res, 200, { ok: true, labels: db.labels.length, images: Object.keys(db.images).length });

    if (req.method === "GET" && path === "/labels") return send(res, 200, db.labels);
    if (req.method === "POST" && path === "/labels") {
      const body = await readBody(req);
      const arr = Array.isArray(body) ? body : body.labels;
      if (!Array.isArray(arr)) return send(res, 400, { error: "expected an array of {sku,desc}" });
      db.labels = arr.filter((r) => r && r.sku != null).map((r) => ({ sku: String(r.sku), desc: String(r.desc || "") }));
      save();
      return send(res, 200, { ok: true, labels: db.labels.length });
    }

    if (req.method === "GET" && path === "/images") return send(res, 200, db.images);
    if (req.method === "POST" && path === "/images") {
      const body = await readBody(req);
      const map = body && typeof body === "object" && !Array.isArray(body) ? (body.images || body) : null;
      if (!map || typeof map !== "object") return send(res, 400, { error: 'expected {"sku":"data:...or https://..."}' });
      let n = 0;
      for (const [sku, v] of Object.entries(map)) { if (typeof v === "string" && v) { db.images[String(sku)] = v; n++; } }
      save();
      return send(res, 200, { ok: true, added: n, images: Object.keys(db.images).length });
    }
    if (req.method === "DELETE" && path === "/images") { db.images = {}; save(); return send(res, 200, { ok: true }); }

    return send(res, 404, { error: "not found: " + req.method + " " + path });
  } catch (e) {
    return send(res, e.message === "invalid JSON" ? 400 : 500, { error: e.message });
  }
});

server.listen(PORT, () => console.log("WM sync backend on http://localhost:" + PORT + " (data: " + DATA_FILE + ")"));
