/**
 * Статика + WebSocket: карта мира (регионы), фиксированные команды, лимит 200 на команду.
 * Запуск: npm start
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

const GRID_W = 320;
const GRID_H = 320;
const COOLDOWN_MS = 1200;
const MAX_PER_TEAM = 200;

/** Слоты команд (id и цвет фиксированы). Название и эмодзи настраивают участники. */
const TEAMS = [
  { id: 1, name: "Альфа", color: "#e94560", emoji: "🔴" },
  { id: 2, name: "Бета", color: "#00cec9", emoji: "🔵" },
  { id: 3, name: "Гамма", color: "#fdcb6e", emoji: "🟡" },
  { id: 4, name: "Дельта", color: "#6c5ce7", emoji: "🟣" },
  { id: 5, name: "Эпсилон", color: "#e17055", emoji: "🟠" },
  { id: 6, name: "Дзета", color: "#0984e3", emoji: "💙" },
  { id: 7, name: "Эта", color: "#00b894", emoji: "💚" },
  { id: 8, name: "Тета", color: "#fab1a0", emoji: "🩷" },
];

const TEAM_CUSTOM_PATH = path.join(ROOT, "data", "team-custom.json");

/** @type {Record<string, { name?: string, emoji?: string }>} */
let teamCustom = {};

function loadTeamCustom() {
  try {
    if (fs.existsSync(TEAM_CUSTOM_PATH)) {
      teamCustom = JSON.parse(fs.readFileSync(TEAM_CUSTOM_PATH, "utf8"));
      if (!teamCustom || typeof teamCustom !== "object") teamCustom = {};
    }
  } catch (e) {
    console.warn("team-custom load:", e.message);
    teamCustom = {};
  }
}

function saveTeamCustom() {
  try {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(TEAM_CUSTOM_PATH, JSON.stringify(teamCustom), "utf8");
  } catch (e) {
    console.warn("team-custom save:", e.message);
  }
}

function sanitizeTeamName(s) {
  return String(s ?? "")
    .replace(/[\u0000-\u001F<>]/g, "")
    .trim()
    .slice(0, 40);
}

function sanitizeTeamEmoji(s) {
  const t = String(s ?? "").trim().slice(0, 8);
  return t;
}

function getMergedTeam(teamId) {
  const base = TEAMS.find((t) => t.id === teamId);
  if (!base) return null;
  const c = teamCustom[String(teamId)] || {};
  const name = typeof c.name === "string" && c.name.trim() ? sanitizeTeamName(c.name) : base.name;
  const emoji = typeof c.emoji === "string" && c.emoji.trim() ? sanitizeTeamEmoji(c.emoji) : base.emoji;
  return { id: teamId, color: base.color, name, emoji };
}

function teamsForMeta() {
  return TEAMS.map((t) => getMergedTeam(t.id));
}

loadTeamCustom();

/** @type {WeakMap<object, number>} */
const lastTeamUpdate = new WeakMap();

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

/** @type {Uint8Array} id страны на клетку, 0 = океан */
let landGrid = null;
try {
  const raw = fs.readFileSync(path.join(ROOT, "data", "regions-320.json"), "utf8");
  const j = JSON.parse(raw);
  landGrid = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (landGrid.length !== GRID_W * GRID_H) {
    console.warn("regions-320.json: неверный размер сетки");
    landGrid = null;
  }
} catch (e) {
  console.warn("Нет data/regions-320.json — npm run build-map", e.message);
}

function isLand(x, y) {
  if (!landGrid) return true;
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false;
  return landGrid[y * GRID_W + x] > 0;
}

/** @type {Map<string, number>} key "x,y" -> teamId */
const pixels = new Map();
/** @type {Map<object, number>} */
const lastPlace = new WeakMap();
/** @type {Map<number, number>} teamId -> число игроков */
const teamPlayerCounts = new Map();

function countTeamPixels(teamId) {
  let n = 0;
  for (const v of pixels.values()) {
    if (v === teamId) n++;
  }
  return n;
}

function hasAdjacentOwn(teamId, x, y) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= GRID_W || ny < 0 || ny >= GRID_H) continue;
      if (pixels.get(`${nx},${ny}`) === teamId) return true;
    }
  }
  return false;
}

function canPlace(teamId, x, y) {
  if (!isLand(x, y)) return "ocean";
  if (countTeamPixels(teamId) === 0) return "ok";
  if (hasAdjacentOwn(teamId, x, y)) return "ok";
  return "no_adj";
}

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
  for (const [key, t] of pixels) {
    const [x, y] = key.split(",").map(Number);
    list.push([x, y, t]);
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
  ws.teamId = null;

  const teamCountsObj = {};
  for (const [id, c] of teamPlayerCounts) {
    teamCountsObj[id] = c;
  }

  ws.send(
    JSON.stringify({
      type: "meta",
      teams: teamsForMeta(),
      teamCounts: teamCountsObj,
      maxPerTeam: MAX_PER_TEAM,
      grid: { w: GRID_W, h: GRID_H },
    })
  );
  ws.send(fullPayload());

  ws.on("message", (data) => {
    let msg;
    try {
      msg = JSON.parse(String(data));
    } catch {
      return;
    }

    if (msg.type === "updateTeam") {
      if (ws.teamId == null) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "no_team" }));
        return;
      }
      const prev = lastTeamUpdate.get(ws) || 0;
      if (Date.now() - prev < 5000) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "rate" }));
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const emoji = sanitizeTeamEmoji(msg.emoji);
      if (!name) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "name" }));
        return;
      }
      if (!emoji) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "emoji" }));
        return;
      }
      const tid = ws.teamId;
      const key = String(tid);
      if (!teamCustom[key]) teamCustom[key] = {};
      teamCustom[key].name = name;
      teamCustom[key].emoji = emoji;
      saveTeamCustom();
      lastTeamUpdate.set(ws, Date.now());
      broadcast({ type: "teamDisplay", teamId: tid, name, emoji });
      return;
    }

    if (msg.type === "joinTeam") {
      const tid = Number(msg.teamId) | 0;
      const valid = TEAMS.some((t) => t.id === tid);
      if (!valid) {
        ws.send(JSON.stringify({ type: "joinError", reason: "team" }));
        return;
      }
      if (ws.teamId != null) {
        ws.send(JSON.stringify({ type: "joinError", reason: "already" }));
        return;
      }
      const cur = teamPlayerCounts.get(tid) || 0;
      if (cur >= MAX_PER_TEAM) {
        ws.send(JSON.stringify({ type: "joinError", reason: "full" }));
        return;
      }
      ws.teamId = tid;
      teamPlayerCounts.set(tid, cur + 1);
      ws.send(JSON.stringify({ type: "joined", teamId: tid }));
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      return;
    }

    if (msg.type === "clear") {
      pixels.clear();
      broadcast({ type: "full", pixels: [] });
      return;
    }

    if (msg.type === "pixel") {
      if (ws.teamId == null) {
        ws.send(JSON.stringify({ type: "pixelReject", reason: "no_team" }));
        return;
      }
      const x = msg.x | 0;
      const y = msg.y | 0;
      const teamId = ws.teamId;
      if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return;

      const rule = canPlace(teamId, x, y);
      if (rule === "ocean") {
        ws.send(JSON.stringify({ type: "pixelReject", reason: "ocean" }));
        return;
      }
      if (rule === "no_adj") {
        ws.send(JSON.stringify({ type: "pixelReject", reason: "no_adj" }));
        return;
      }

      const now = Date.now();
      const last = lastPlace.get(ws) || 0;
      if (now - last < COOLDOWN_MS) {
        ws.send(JSON.stringify({ type: "pixelReject", reason: "cooldown" }));
        return;
      }
      lastPlace.set(ws, now);

      const key = `${x},${y}`;
      pixels.set(key, teamId);
      broadcast({ type: "pixel", x, y, t: teamId });
      return;
    }
  });

  ws.on("close", () => {
    if (ws.teamId != null) {
      const tid = ws.teamId;
      const c = teamPlayerCounts.get(tid) ?? 0;
      teamPlayerCounts.set(tid, Math.max(0, c - 1));
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    }
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Battle: http://localhost:${PORT}  (WS ${WS_PATH})`);
});
