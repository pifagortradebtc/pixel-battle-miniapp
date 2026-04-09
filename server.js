/**
 * Статика + WebSocket одного общего поля.
 * Запуск: npm install && npm start → http://localhost:3847
 */

import http from "http";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const WS_PATH = "/ws";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
};

const GRID_W = 320;
const GRID_H = 320;
const PALETTE_LEN = 16;
const COOLDOWN_MS = 1200;

/** @type {Map<string, number>} */
const pixels = new Map();
/** @type {Map<object, number>} socket -> last place time */
const lastPlace = new WeakMap();

function safePath(urlPath) {
  const decoded = decodeURIComponent(urlPath.split("?")[0]);
  let p = path.normalize(decoded).replace(/^(\.\.(\/|\\|$))+/, "");
  if (p === "/" || p === "\\" || p === "") p = "index.html";
  const full = path.join(ROOT, p);
  if (!full.startsWith(ROOT)) return null;
  return full;
}

function serveStatic(req, res) {
  const full = safePath(req.url || "/");
  if (!full) {
    res.writeHead(403);
    res.end();
    return;
  }
  fs.stat(full, (err, st) => {
    if (err || !st.isFile()) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    const ext = path.extname(full).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream" });
    fs.createReadStream(full).pipe(res);
  });
}

function fullPayload() {
  const list = [];
  for (const [key, c] of pixels) {
    const [x, y] = key.split(",").map(Number);
    list.push([x, y, c]);
  }
  return JSON.stringify({ type: "full", pixels: list });
}

function broadcast(obj) {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    client.send(raw);
  }
}

const server = http.createServer(serveStatic);

const wss = new WebSocketServer({ server, path: WS_PATH });

wss.on("connection", (ws) => {
  ws.send(fullPayload());

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.type === "clear") {
      pixels.clear();
      broadcast({ type: "full", pixels: [] });
      return;
    }

    if (msg.type !== "pixel") return;
    const x = msg.x | 0;
    const y = msg.y | 0;
    const c = msg.c | 0;
    if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;
    if (c < 0 || c >= PALETTE_LEN) return;

    const now = Date.now();
    const last = lastPlace.get(ws) || 0;
    if (now - last < COOLDOWN_MS) return;
    lastPlace.set(ws, now);

    const key = `${x},${y}`;
    pixels.set(key, c);
    broadcast({ type: "pixel", x, y, c });
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Battle: http://localhost:${PORT}  (WS ${WS_PATH})`);
});
