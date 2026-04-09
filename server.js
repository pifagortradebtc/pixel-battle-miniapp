/**
 * Статика + WebSocket: карта, только пользовательские команды (динамические).
 * Соло: имя + цвет; публичные команды — в списке для вступления. Цвет команды один на всех.
 * Запуск: npm start
 */

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const WS_PATH = "/ws";

const GRID_W = 320;
const GRID_H = 320;
const COOLDOWN_MS = 0;
const MAX_PER_TEAM = 200;

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

/** Цвет команды #RRGGBB */
function sanitizeHexColor(s) {
  const t = String(s ?? "")
    .trim()
    .replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return "";
  return `#${t.toLowerCase()}`;
}

function teamsForMeta() {
  return dynamicTeams.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    color: t.color,
    solo: !!t.solo,
  }));
}

const DYNAMIC_TEAMS_PATH = path.join(ROOT, "data", "dynamic-teams.json");

/** @type {{ id: number, name: string, emoji: string, color: string, editToken?: string, solo?: boolean }[]} */
let dynamicTeams = [];
let nextTeamId = 1;

function newTeamEditToken() {
  return crypto.randomBytes(24).toString("hex");
}

function loadDynamicTeams() {
  try {
    if (fs.existsSync(DYNAMIC_TEAMS_PATH)) {
      const j = JSON.parse(fs.readFileSync(DYNAMIC_TEAMS_PATH, "utf8"));
      dynamicTeams = Array.isArray(j.teams) ? j.teams : [];
      dynamicTeams = dynamicTeams.map((t) => {
        const raw = typeof t.color === "string" ? t.color.trim() : "";
        const hex = raw ? sanitizeHexColor(raw) : "";
        const color = hex || (raw || "#888888");
        return {
          ...t,
          color,
          solo: !!t.solo,
        };
      });
      if (typeof j.nextId === "number" && j.nextId >= 1) {
        nextTeamId = j.nextId;
      } else {
        const maxId = dynamicTeams.reduce((m, t) => Math.max(m, t.id || 0), 0);
        nextTeamId = Math.max(1, maxId + 1);
      }
    }
  } catch (e) {
    console.warn("dynamic-teams load:", e.message);
    dynamicTeams = [];
    nextTeamId = 1;
  }
}

function saveDynamicTeams() {
  try {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(
      DYNAMIC_TEAMS_PATH,
      JSON.stringify({ nextId: nextTeamId, teams: dynamicTeams }),
      "utf8"
    );
  } catch (e) {
    console.warn("dynamic-teams save:", e.message);
  }
}

function validTeamId(teamId) {
  return dynamicTeams.some((t) => t.id === teamId);
}

loadDynamicTeams();

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

/** @type {Uint8Array} регион: 0 океан, 1 река (не захватывается), ≥2 суша (регион Вороного) */
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

/** Все клетки суши — знаменатель для «% территории» (100% = вся суша). */
let landPixelsTotal = GRID_W * GRID_H;
if (landGrid) {
  let n = 0;
  for (let i = 0; i < landGrid.length; i++) {
    if (landGrid[i] >= 2) n++;
  }
  landPixelsTotal = n;
}

/** 0 — океан, 1 — река, ≥2 — суша (регион). Рисовать можно только на суше. */
function isLand(x, y) {
  if (!landGrid) return true;
  if (x < 0 || x >= GRID_W || y < 0 || y >= GRID_H) return false;
  return landGrid[y * GRID_W + x] >= 2;
}

/** @type {Map<string, number>} key "x,y" → teamId */
const pixels = new Map();

function pixelTeam(val) {
  if (val && typeof val === "object") return val.teamId;
  return val;
}
/** @type {Map<object, number>} */
const lastPlace = new WeakMap();
/** @type {Map<number, number>} teamId -> число игроков */
const teamPlayerCounts = new Map();

/** Любая клетка суши; соседство с своими пикселями не требуется. */
function canPlace(_teamId, x, y) {
  if (!isLand(x, y)) return "ocean";
  return "ok";
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
  for (const [key, val] of pixels) {
    const [x, y] = key.split(",").map(Number);
    const tid = pixelTeam(val);
    list.push([x, y, tid]);
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

function countOnlineClients() {
  let n = 0;
  for (const c of wss.clients) {
    if (c.readyState === 1) n++;
  }
  return n;
}

function buildStatsPayload() {
  /** @type {Map<number, number>} */
  const byTeam = new Map();
  for (const val of pixels.values()) {
    const tid = pixelTeam(val);
    byTeam.set(tid, (byTeam.get(tid) || 0) + 1);
  }
  const list = teamsForMeta();
  const rows = list.map((t) => {
    const pix = byTeam.get(t.id) || 0;
    const pct = landPixelsTotal > 0 ? (pix / landPixelsTotal) * 100 : 0;
    const players = teamPlayerCounts.get(t.id) || 0;
    return {
      teamId: t.id,
      emoji: t.emoji,
      name: t.name,
      color: t.color,
      players,
      pixels: pix,
      percent: Math.round(pct * 1000) / 1000,
    };
  });
  rows.sort((a, b) => {
    if (b.percent !== a.percent) return b.percent - a.percent;
    if (b.pixels !== a.pixels) return b.pixels - a.pixels;
    return a.teamId - b.teamId;
  });
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  return {
    type: "stats",
    online: countOnlineClients(),
    landTotal: landPixelsTotal,
    rows,
  };
}

let statsBroadcastTimer = null;
function scheduleStatsBroadcast() {
  if (statsBroadcastTimer != null) return;
  statsBroadcastTimer = setTimeout(() => {
    statsBroadcastTimer = null;
    broadcast(buildStatsPayload());
  }, 200);
}

function broadcastStatsImmediate() {
  broadcast(buildStatsPayload());
}

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
  broadcastStatsImmediate();

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
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (!dt) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "no_team" }));
        return;
      }
      if (dt.solo) {
        ws.send(JSON.stringify({ type: "updateTeamError", reason: "solo" }));
        return;
      }
      const sent = typeof msg.editToken === "string" ? msg.editToken.trim() : "";
      if (dt.editToken) {
        if (sent !== dt.editToken) {
          ws.send(JSON.stringify({ type: "updateTeamError", reason: "not_owner" }));
          return;
        }
      }
      dt.name = name;
      dt.emoji = emoji;
      const newColor = sanitizeHexColor(msg.color);
      if (newColor) dt.color = newColor;
      saveDynamicTeams();
      lastTeamUpdate.set(ws, Date.now());
      broadcast({
        type: "teamDisplay",
        teamId: tid,
        name,
        emoji,
        color: dt.color,
      });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "createTeam") {
      if (ws.teamId != null) {
        ws.send(JSON.stringify({ type: "createTeamError", reason: "already" }));
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const emoji = sanitizeTeamEmoji(msg.emoji);
      const color = sanitizeHexColor(msg.color);
      if (!name || !emoji || !color) {
        ws.send(JSON.stringify({ type: "createTeamError", reason: "fields" }));
        return;
      }
      if (nextTeamId > 255) {
        ws.send(JSON.stringify({ type: "createTeamError", reason: "limit" }));
        return;
      }
      const id = nextTeamId++;
      const editToken = newTeamEditToken();
      dynamicTeams.push({ id, name, emoji, color, editToken, solo: false });
      saveDynamicTeams();
      ws.teamId = id;
      teamPlayerCounts.set(id, 1);
      const team = { id, name, emoji, color, solo: false };
      ws.send(
        JSON.stringify({
          type: "created",
          teamId: id,
          team,
          editToken,
          teams: teamsForMeta(),
          teamCounts: Object.fromEntries(teamPlayerCounts),
        })
      );
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "soloPlay") {
      if (ws.teamId != null) {
        ws.send(JSON.stringify({ type: "soloError", reason: "already" }));
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const color = sanitizeHexColor(msg.color);
      if (!name || !color) {
        ws.send(JSON.stringify({ type: "soloError", reason: "fields" }));
        return;
      }
      if (nextTeamId > 255) {
        ws.send(JSON.stringify({ type: "soloError", reason: "limit" }));
        return;
      }
      const id = nextTeamId++;
      const emoji = sanitizeTeamEmoji(msg.emoji) || "🙂";
      dynamicTeams.push({ id, name, emoji, color, solo: true });
      saveDynamicTeams();
      ws.teamId = id;
      teamPlayerCounts.set(id, 1);
      const team = { id, name, emoji, color, solo: true };
      ws.send(
        JSON.stringify({
          type: "soloJoined",
          teamId: id,
          team,
          teams: teamsForMeta(),
          teamCounts: Object.fromEntries(teamPlayerCounts),
        })
      );
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "joinTeam") {
      const tid = Number(msg.teamId) | 0;
      const valid = validTeamId(tid);
      if (!valid) {
        ws.send(JSON.stringify({ type: "joinError", reason: "team" }));
        return;
      }
      const dtJoin = dynamicTeams.find((t) => t.id === tid);
      if (!dtJoin || dtJoin.solo) {
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
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "leaveTeam") {
      if (ws.teamId == null) {
        ws.send(JSON.stringify({ type: "leaveError", reason: "no_team" }));
        return;
      }
      const tid = ws.teamId;
      const c = teamPlayerCounts.get(tid) ?? 0;
      teamPlayerCounts.set(tid, Math.max(0, c - 1));
      ws.teamId = null;
      ws.send(JSON.stringify({ type: "left" }));
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "clear") {
      pixels.clear();
      broadcast({ type: "full", pixels: [] });
      broadcastStatsImmediate();
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

      const now = Date.now();
      const last = lastPlace.get(ws) || 0;
      if (COOLDOWN_MS > 0 && now - last < COOLDOWN_MS) {
        ws.send(JSON.stringify({ type: "pixelReject", reason: "cooldown" }));
        return;
      }
      lastPlace.set(ws, now);

      const key = `${x},${y}`;
      pixels.set(key, teamId);
      broadcast({ type: "pixel", x, y, t: teamId });
      scheduleStatsBroadcast();
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
    broadcastStatsImmediate();
  });
});

server.listen(PORT, () => {
  console.log(`Pixel Battle: http://localhost:${PORT}  (WS ${WS_PATH})`);
});
