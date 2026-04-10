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

const BASE_GRID = 320;
/** После 1-го раунда сетка ÷5, после 2-го ещё ÷3 (итого 320→64→21). */
const ROUND2_DIV = 5;
const ROUND3_DIV = 3;
let gridW = BASE_GRID;
let gridH = BASE_GRID;
const COOLDOWN_MS = 0;
/** Длительность раунда по умолчанию (100 ч); фактическое значение — roundDurationMs (задаётся «go 12» и т.д.) */
const ROUND_MS = 100 * 60 * 60 * 1000;
/** Длина текущего раунда в мс (одинакова для всех раундов после старта) */
let roundDurationMs = ROUND_MS;
const MAX_PER_TEAM_FIRST = 200;
const MAX_PER_TEAM_NEXT = 10;
/** Финальный раунд (команды по 2 человека) */
const MAX_PER_TEAM_FINAL = 2;

const ROUND_STATE_PATH = path.join(ROOT, "data", "round-state.json");

/** Токен бота и список user id админов (через запятую), которые могут отправить «go» для старта 1-го раунда */
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
const TELEGRAM_ADMIN_IDS = new Set(
  (process.env.TELEGRAM_ADMIN_IDS || "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
);
/** Первый раунд ждёт «go» в Telegram, только если задан бот и хотя бы один admin id */
const WAIT_FOR_TELEGRAM_GO = Boolean(TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_IDS.size > 0);

/** @type {number} 0 = первый раунд (200 чел.), 1 = второй (10), 2 = третий (2), 3 = игра завершена */
let roundIndex = 0;
/** @type {number} */
let roundStartMs = Date.now();
/** Первый раунд: таймер 100 ч не идёт, пока админ не отправит «go» боту (если включён WAIT_FOR_TELEGRAM_GO) */
let roundTimerStarted = true;
/** @type {Set<string>} токены победителей прошлого раунда — для claim при переподключении */
let eligibleTokenSet = new Set();
/**
 * Ключ игрока (Telegram id или UUID в localStorage) → токен для текущего этапа допуска.
 * Сохраняется на диск: победитель может вернуться без токена в браузере, подставив ключ.
 */
let winnerTokensByPlayerKey = {};
/** Участники команд по раунду: teamId → Set(playerKey) — для выдачи токенов всем победителям, не только онлайн. */
const teamMemberKeys = new Map();
/** playerKey → { id, username } — данные из Mini App для уведомления о финальных победителях */
const playerTelegramMeta = new Map();
let roundEnding = false;
/** После третьего раунда — только просмотр, новых игроков нет */
let gameFinished = false;

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

function sanitizePlayerKey(s) {
  const t = String(s ?? "").trim().slice(0, 128);
  return t;
}

function attachPlayerKey(ws, msg) {
  const pk = sanitizePlayerKey(msg?.playerKey);
  if (pk) ws.playerKey = pk;
}

/** Сохраняет Telegram id/username для финального отчёта (до 2 человек в команде-победителе). */
function rememberPlayerProfile(ws, msg) {
  attachPlayerKey(ws, msg);
  const tu = msg?.telegramUser;
  if (!tu || typeof tu.id !== "number") return;
  const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  if (!pk) return;
  const username = typeof tu.username === "string" ? tu.username.trim().slice(0, 64) : "";
  const prev = playerTelegramMeta.get(pk);
  playerTelegramMeta.set(pk, {
    id: tu.id | 0,
    username: username || prev?.username || "",
  });
}

function addTeamMemberKey(teamId, playerKey) {
  const pk = sanitizePlayerKey(playerKey);
  if (!pk) return;
  if (!teamMemberKeys.has(teamId)) teamMemberKeys.set(teamId, new Set());
  teamMemberKeys.get(teamId).add(pk);
}

function removeTeamMemberKey(teamId, playerKey) {
  const pk = sanitizePlayerKey(playerKey);
  if (!pk || !teamMemberKeys.has(teamId)) return;
  teamMemberKeys.get(teamId).delete(pk);
  if (teamMemberKeys.get(teamId).size === 0) teamMemberKeys.delete(teamId);
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

/** @type {{ id: number, name: string, emoji: string, color: string, editToken?: string, solo?: boolean, soloResumeToken?: string }[]} */
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

function getMaxPerTeam() {
  if (gameFinished) return 0;
  if (roundIndex === 0) return MAX_PER_TEAM_FIRST;
  if (roundIndex === 1) return MAX_PER_TEAM_NEXT;
  return MAX_PER_TEAM_FINAL;
}

function saveRoundState() {
  try {
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(
      ROUND_STATE_PATH,
      JSON.stringify({
        roundIndex,
        roundStartMs,
        roundDurationMs,
        roundTimerStarted,
        eligibleTokens: [...eligibleTokenSet],
        gameFinished,
        winnerTokensByPlayerKey,
      }),
      "utf8"
    );
  } catch (e) {
    console.warn("round-state save:", e.message);
  }
}

function loadRoundState() {
  try {
    if (fs.existsSync(ROUND_STATE_PATH)) {
      const j = JSON.parse(fs.readFileSync(ROUND_STATE_PATH, "utf8"));
      if (typeof j.roundIndex === "number") roundIndex = j.roundIndex;
      if (typeof j.roundStartMs === "number") roundStartMs = j.roundStartMs;
      if (typeof j.roundDurationMs === "number" && j.roundDurationMs >= 1000 && j.roundDurationMs <= 8760 * 3600000) {
        roundDurationMs = j.roundDurationMs;
      } else {
        roundDurationMs = ROUND_MS;
      }
      if (typeof j.roundTimerStarted === "boolean") {
        roundTimerStarted = j.roundTimerStarted;
      } else {
        roundTimerStarted = true;
      }
      eligibleTokenSet = new Set(Array.isArray(j.eligibleTokens) ? j.eligibleTokens : []);
      if (typeof j.gameFinished === "boolean") gameFinished = j.gameFinished;
      if (roundIndex >= 3) gameFinished = true;
      if (j.winnerTokensByPlayerKey && typeof j.winnerTokensByPlayerKey === "object" && !Array.isArray(j.winnerTokensByPlayerKey)) {
        winnerTokensByPlayerKey = {};
        for (const [k, v] of Object.entries(j.winnerTokensByPlayerKey)) {
          const key = sanitizePlayerKey(k);
          if (!key || typeof v !== "string") continue;
          const tok = v.trim();
          if (!tok) continue;
          winnerTokensByPlayerKey[key] = tok;
          eligibleTokenSet.add(tok);
        }
      } else {
        winnerTokensByPlayerKey = {};
      }
      if (roundIndex >= 1 || gameFinished) roundTimerStarted = true;
    } else {
      roundIndex = 0;
      roundStartMs = Date.now();
      roundDurationMs = ROUND_MS;
      eligibleTokenSet = new Set();
      gameFinished = false;
      winnerTokensByPlayerKey = {};
      roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
      saveRoundState();
    }
  } catch (e) {
    console.warn("round-state load:", e.message);
    roundIndex = 0;
    roundStartMs = Date.now();
    roundDurationMs = ROUND_MS;
    eligibleTokenSet = new Set();
    gameFinished = false;
    winnerTokensByPlayerKey = {};
    roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
  }
}

/** @type {WeakMap<object, number>} */
const lastTeamUpdate = new WeakMap();
/** Троттлинг смены только цвета (палитра внизу) */
const lastColorOnlySet = new WeakMap();

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

/** @type {Uint8Array | null} исходный регион 320×320 (для даунсэмплинга под раунд) */
let baseRegion320 = null;
try {
  const raw = fs.readFileSync(path.join(ROOT, "data", "regions-320.json"), "utf8");
  const j = JSON.parse(raw);
  baseRegion320 = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (baseRegion320.length !== BASE_GRID * BASE_GRID) {
    console.warn("regions-320.json: неверный размер сетки");
    baseRegion320 = null;
  }
} catch (e) {
  console.warn("Нет data/regions-320.json — npm run build-map", e.message);
}

/** @type {Uint8Array | null} регион: 0 океан, 1 река, ≥2 — регионы (для справки; закрасить можно любую клетку сетки). */
let landGrid = null;
/** Знаменатель для «% территории» — все клетки текущей сетки (w×h). */
let landPixelsTotal = BASE_GRID * BASE_GRID;

/** Размер стороны сетки по индексу раунда (0: 320, 1: 64, 2: 21). */
function gridSizeForRoundIndex(ri) {
  if (ri <= 0) return BASE_GRID;
  if (ri === 1) return Math.max(1, Math.floor(BASE_GRID / ROUND2_DIV));
  return Math.max(1, Math.floor(BASE_GRID / ROUND2_DIV / ROUND3_DIV));
}

/** @param {number} ri — 0: 320×320, 1: 64×64, 2: 21×21 */
function rebuildLandFromRound(ri) {
  const w = gridSizeForRoundIndex(ri);
  const h = w;
  gridW = w;
  gridH = h;

  if (!baseRegion320 || baseRegion320.length !== BASE_GRID * BASE_GRID) {
    landGrid = null;
    landPixelsTotal = gridW * gridH;
    return;
  }

  landGrid = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const bx = Math.min(BASE_GRID - 1, Math.floor(((x + 0.5) / gridW) * BASE_GRID));
      const by = Math.min(BASE_GRID - 1, Math.floor(((y + 0.5) / gridH) * BASE_GRID));
      landGrid[y * gridW + x] = baseRegion320[by * BASE_GRID + bx];
    }
  }
  applyRoundShapeMask(ri, landGrid, gridW, gridH);
  /** Знаменатель % территории: все клетки сетки (океан и реки тоже можно закрашивать). */
  landPixelsTotal = gridW * gridH;
}

/**
 * Раунд 1 — форма зашита в regions-320 (круг + остров ₿).
 * Раунд 2 — квадрат с отступом (другая «форма» карты).
 * Раунд 3 — ромб (манхэттен от центра) — снова другая форма.
 */
function applyRoundShapeMask(ri, buf, w, h) {
  if (ri === 0) return;
  if (ri === 1) {
    const m = Math.max(1, Math.floor(w * 0.08));
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (x < m || x >= w - m || y < m || y >= h - m) {
          buf[y * w + x] = 0;
        }
      }
    }
    return;
  }
  if (ri === 2) {
    const cx = (w - 1) / 2;
    const cy = (h - 1) / 2;
    const R = Math.floor((Math.min(w, h) - 1) / 2);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const d = Math.abs(x - cx) + Math.abs(y - cy);
        if (d > R + 1e-6) buf[y * w + x] = 0;
      }
    }
  }
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

loadDynamicTeams();
loadRoundState();
if (gameFinished) {
  rebuildLandFromRound(2);
} else {
  rebuildLandFromRound(roundIndex);
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

/** Безопасная отправка одному клиенту (не роняет процесс при закрытом/битом сокете). */
function safeSend(ws, data) {
  if (!ws || ws.readyState !== 1) return false;
  try {
    const raw = typeof data === "string" ? data : JSON.stringify(data);
    ws.send(raw);
    return true;
  } catch {
    return false;
  }
}

function broadcast(obj) {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(raw);
    } catch {
      /* сокет закрыт при отправке */
    }
  }
}

const server = http.createServer(serveStatic);

const wss = new WebSocketServer({ server, path: WS_PATH, maxPayload: 262144 });

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

function assertCanPlay(ws) {
  if (gameFinished) {
    safeSend(ws, { type: "playRejected", reason: "spectator" });
    return false;
  }
  if (!ws.eligible) {
    safeSend(ws, { type: "playRejected", reason: "spectator" });
    return false;
  }
  return true;
}

/** null — первый раунд ещё не запущен командой «go» в Telegram */
function roundEndsAtForMeta() {
  if (gameFinished) return roundStartMs + roundDurationMs;
  if (roundIndex === 0 && !roundTimerStarted) return null;
  return roundStartMs + roundDurationMs;
}

function sendConnectionMeta(ws) {
  const teamCountsObj = {};
  for (const [id, c] of teamPlayerCounts) {
    teamCountsObj[id] = c;
  }
  safeSend(ws, {
    type: "meta",
    teams: teamsForMeta(),
    teamCounts: teamCountsObj,
    maxPerTeam: getMaxPerTeam(),
    grid: { w: gridW, h: gridH },
    roundIndex,
    roundEndsAt: roundEndsAtForMeta(),
    eligible: !!ws.eligible,
    gameFinished: !!gameFinished,
  });
}

function finalizeThirdRound(winnerRow) {
  roundEnding = true;
  try {
    const winnerTeamId = winnerRow.teamId;
    const winningTeamName = winnerRow.name || "";
    const pct =
      typeof winnerRow.percent === "number" && Number.isFinite(winnerRow.percent) ? winnerRow.percent : 0;
    const winnerKeysSnapshot = teamMemberKeys.has(winnerTeamId)
      ? new Set(teamMemberKeys.get(winnerTeamId))
      : new Set();

    eligibleTokenSet = new Set();
    winnerTokensByPlayerKey = {};
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.eligible = false;
      client.eliminated = true;
      client.teamId = null;
    }

    teamMemberKeys.clear();
    teamPlayerCounts.clear();
    pixels.clear();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    gameFinished = true;
    roundIndex = 3;
    roundStartMs = Date.now();
    saveRoundState();

    void notifyFinalWinnersTelegram(winnerKeysSnapshot, winningTeamName, pct);

    broadcast({
      type: "gameEnded",
      winnerTeamId,
      winnerName: winningTeamName,
      percent: pct,
      roundIndex: 3,
      grid: { w: gridW, h: gridH },
    });

    broadcast({ type: "full", pixels: [] });
    broadcast({ type: "teamsFull", teams: teamsForMeta() });
    broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    broadcastStatsImmediate();
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      sendConnectionMeta(client);
    }
  } finally {
    roundEnding = false;
  }
}

function maybeEndRound() {
  if (roundEnding) return;
  if (gameFinished) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  if (Date.now() < roundStartMs + roundDurationMs) return;
  const stats = buildStatsPayload();
  const rows = stats.rows || [];
  if (rows.length === 0) {
    roundStartMs = Date.now();
    saveRoundState();
    return;
  }

  if (roundIndex >= 2) {
    const top = rows[0];
    if (!top || typeof top.teamId !== "number") {
      roundStartMs = Date.now();
      saveRoundState();
      return;
    }
    finalizeThirdRound(top);
    return;
  }

  roundEnding = true;
  try {
    const winnerTeamId = rows[0].teamId;
    const winningTeamName = rows[0].name || "";

    eligibleTokenSet = new Set();
    winnerTokensByPlayerKey = {};
    /** @type {Map<string, string>} */
    const tokenByPlayerKey = new Map();
    const winnerKeys = teamMemberKeys.get(winnerTeamId) || new Set();
    for (const pk of winnerKeys) {
      const tok = crypto.randomBytes(18).toString("hex");
      eligibleTokenSet.add(tok);
      winnerTokensByPlayerKey[pk] = tok;
      tokenByPlayerKey.set(pk, tok);
    }

    /** @type {Map<object, string>} */
    const winnerTokenByClient = new Map();

    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      if (client.teamId === winnerTeamId) {
        const pk = client.playerKey ? sanitizePlayerKey(client.playerKey) : "";
        let tok = pk ? tokenByPlayerKey.get(pk) : null;
        if (!tok) {
          tok = crypto.randomBytes(18).toString("hex");
          eligibleTokenSet.add(tok);
          if (pk) {
            winnerTokensByPlayerKey[pk] = tok;
            tokenByPlayerKey.set(pk, tok);
          }
        }
        winnerTokenByClient.set(client, tok);
        client.eligible = true;
        client.eliminated = false;
      } else {
        client.eligible = false;
        client.eliminated = true;
      }
    }

    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.teamId = null;
    }

    teamMemberKeys.clear();
    teamPlayerCounts.clear();
    pixels.clear();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    roundIndex++;
    roundTimerStarted = true;
    roundStartMs = Date.now();
    rebuildLandFromRound(roundIndex);
    saveRoundState();

    broadcast({
      type: "roundEnded",
      roundIndex,
      winnerTeamId,
      winnerName: winningTeamName,
      roundEndsAt: roundStartMs + roundDurationMs,
      maxPerTeam: getMaxPerTeam(),
      grid: { w: gridW, h: gridH },
    });

    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const tok = winnerTokenByClient.get(client);
      if (tok) {
        safeSend(client, {
          type: "roundWinnerPass",
          token: tok,
          roundIndex,
        });
      }
    }

    broadcast({ type: "full", pixels: [] });
    broadcast({ type: "teamsFull", teams: teamsForMeta() });
    broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    broadcastStatsImmediate();
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      sendConnectionMeta(client);
    }
  } finally {
    roundEnding = false;
  }
}

setInterval(() => maybeEndRound(), 30000);

wss.on("connection", (ws) => {
  ws.teamId = null;
  ws.eligible = !gameFinished && roundIndex === 0;
  ws.eliminated = gameFinished || roundIndex !== 0;

  sendConnectionMeta(ws);
  safeSend(ws, fullPayload());
  broadcastStatsImmediate();

  ws.on("message", (data) => {
    const raw = String(data);
    if (raw.length > 262144) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    maybeEndRound();

    if (msg.type === "clientProfile") {
      rememberPlayerProfile(ws, msg);
      return;
    }

    if (msg.type === "claimEligibility") {
      if (gameFinished) {
        safeSend(ws,{ type: "claimError", reason: "invalid" });
        return;
      }
      rememberPlayerProfile(ws, msg);
      const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
      let t = typeof msg.token === "string" ? msg.token.trim() : "";
      const explicitToken = t.length > 0;
      const serverTok = pk ? winnerTokensByPlayerKey[pk] : "";
      if (serverTok && eligibleTokenSet.has(serverTok)) {
        t = serverTok;
      } else if (t && !eligibleTokenSet.has(t)) {
        t = "";
      }
      if (t && eligibleTokenSet.has(t)) {
        ws.eligible = true;
        ws.eliminated = false;
        safeSend(ws,{ type: "claimedOk" });
        safeSend(ws,{ type: "roundWinnerPass", token: t, roundIndex });
        sendConnectionMeta(ws);
      } else if (explicitToken) {
        safeSend(ws,{ type: "claimError", reason: "invalid" });
      }
      return;
    }

    if (msg.type === "updateTeam") {
      if (!assertCanPlay(ws)) return;
      if (ws.teamId == null) {
        safeSend(ws,{ type: "updateTeamError", reason: "no_team" });
        return;
      }
      const prev = lastTeamUpdate.get(ws) || 0;
      if (Date.now() - prev < 5000) {
        safeSend(ws,{ type: "updateTeamError", reason: "rate" });
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const emoji = sanitizeTeamEmoji(msg.emoji);
      if (!name) {
        safeSend(ws,{ type: "updateTeamError", reason: "name" });
        return;
      }
      if (!emoji) {
        safeSend(ws,{ type: "updateTeamError", reason: "emoji" });
        return;
      }
      const tid = ws.teamId;
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (!dt) {
        safeSend(ws,{ type: "updateTeamError", reason: "no_team" });
        return;
      }
      if (dt.solo) {
        safeSend(ws,{ type: "updateTeamError", reason: "solo" });
        return;
      }
      const sent = typeof msg.editToken === "string" ? msg.editToken.trim() : "";
      if (dt.editToken) {
        if (sent !== dt.editToken) {
          safeSend(ws,{ type: "updateTeamError", reason: "not_owner" });
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

    if (msg.type === "setTeamColor") {
      if (!assertCanPlay(ws)) return;
      if (ws.teamId == null) {
        safeSend(ws,{ type: "setTeamColorError", reason: "no_team" });
        return;
      }
      const prevC = lastColorOnlySet.get(ws) || 0;
      if (Date.now() - prevC < 320) return;
      const tid = ws.teamId;
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (!dt || dt.solo) {
        safeSend(ws,{ type: "setTeamColorError", reason: "solo" });
        return;
      }
      const sent = typeof msg.editToken === "string" ? msg.editToken.trim() : "";
      if (dt.editToken && sent !== dt.editToken) {
        safeSend(ws,{ type: "setTeamColorError", reason: "not_owner" });
        return;
      }
      const color = sanitizeHexColor(msg.color);
      if (!color) {
        safeSend(ws,{ type: "setTeamColorError", reason: "color" });
        return;
      }
      dt.color = color;
      saveDynamicTeams();
      lastColorOnlySet.set(ws, Date.now());
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({
        type: "teamDisplay",
        teamId: tid,
        name: dt.name,
        emoji: dt.emoji,
        color: dt.color,
      });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "soloSetColor") {
      if (!assertCanPlay(ws)) return;
      if (ws.teamId == null) {
        safeSend(ws,{ type: "soloColorError", reason: "no_team" });
        return;
      }
      const prevC = lastColorOnlySet.get(ws) || 0;
      if (Date.now() - prevC < 320) return;
      const tid = ws.teamId;
      const dt = dynamicTeams.find((x) => x.id === tid);
      const sent = typeof msg.resumeToken === "string" ? msg.resumeToken.trim() : "";
      if (!dt || !dt.solo || !dt.soloResumeToken || sent !== dt.soloResumeToken) {
        safeSend(ws,{ type: "soloColorError", reason: "invalid" });
        return;
      }
      const color = sanitizeHexColor(msg.color);
      if (!color) {
        safeSend(ws,{ type: "soloColorError", reason: "color" });
        return;
      }
      dt.color = color;
      saveDynamicTeams();
      lastColorOnlySet.set(ws, Date.now());
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({
        type: "teamDisplay",
        teamId: tid,
        name: dt.name,
        emoji: dt.emoji,
        color: dt.color,
      });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "createTeam") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      if (ws.teamId != null) {
        safeSend(ws,{ type: "createTeamError", reason: "already" });
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const emoji = sanitizeTeamEmoji(msg.emoji);
      const color = sanitizeHexColor(msg.color);
      if (!name || !emoji || !color) {
        safeSend(ws,{ type: "createTeamError", reason: "fields" });
        return;
      }
      if (nextTeamId > 255) {
        safeSend(ws,{ type: "createTeamError", reason: "limit" });
        return;
      }
      const id = nextTeamId++;
      const editToken = newTeamEditToken();
      dynamicTeams.push({ id, name, emoji, color, editToken, solo: false });
      saveDynamicTeams();
      ws.teamId = id;
      teamPlayerCounts.set(id, 1);
      if (ws.playerKey) addTeamMemberKey(id, ws.playerKey);
      const team = { id, name, emoji, color, solo: false };
      safeSend(ws, {
        type: "created",
        teamId: id,
        team,
        editToken,
        teams: teamsForMeta(),
        teamCounts: Object.fromEntries(teamPlayerCounts),
      });
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "soloPlay") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      if (roundIndex >= 2) {
        safeSend(ws,{ type: "soloError", reason: "round" });
        return;
      }
      if (ws.teamId != null) {
        safeSend(ws,{ type: "soloError", reason: "already" });
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const color = sanitizeHexColor(msg.color);
      if (!name || !color) {
        safeSend(ws,{ type: "soloError", reason: "fields" });
        return;
      }
      if (nextTeamId > 255) {
        safeSend(ws,{ type: "soloError", reason: "limit" });
        return;
      }
      const id = nextTeamId++;
      const emoji = sanitizeTeamEmoji(msg.emoji) || "🙂";
      const soloResumeToken = newTeamEditToken();
      dynamicTeams.push({ id, name, emoji, color, solo: true, soloResumeToken });
      saveDynamicTeams();
      ws.teamId = id;
      teamPlayerCounts.set(id, 1);
      if (ws.playerKey) addTeamMemberKey(id, ws.playerKey);
      const team = { id, name, emoji, color, solo: true };
      safeSend(ws, {
        type: "soloJoined",
        teamId: id,
        team,
        resumeToken: soloResumeToken,
        teams: teamsForMeta(),
        teamCounts: Object.fromEntries(teamPlayerCounts),
      });
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "soloResume") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      if (roundIndex >= 2) {
        safeSend(ws,{ type: "soloResumeError", reason: "round" });
        return;
      }
      if (ws.teamId != null) {
        safeSend(ws,{ type: "soloResumeError", reason: "already" });
        return;
      }
      const tid = Number(msg.teamId) | 0;
      const sent = typeof msg.resumeToken === "string" ? msg.resumeToken.trim() : "";
      const dt = dynamicTeams.find((t) => t.id === tid);
      if (!dt || !dt.solo || !dt.soloResumeToken || sent !== dt.soloResumeToken) {
        safeSend(ws,{ type: "soloResumeError", reason: "invalid" });
        return;
      }
      const cur = teamPlayerCounts.get(tid) || 0;
      if (cur >= getMaxPerTeam()) {
        safeSend(ws,{ type: "soloResumeError", reason: "full" });
        return;
      }
      ws.teamId = tid;
      teamPlayerCounts.set(tid, cur + 1);
      if (ws.playerKey) addTeamMemberKey(tid, ws.playerKey);
      const team = {
        id: tid,
        name: dt.name,
        emoji: dt.emoji,
        color: dt.color,
        solo: true,
      };
      safeSend(ws, {
        type: "soloJoined",
        teamId: tid,
        team,
        resumeToken: dt.soloResumeToken,
        teams: teamsForMeta(),
        teamCounts: Object.fromEntries(teamPlayerCounts),
      });
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "joinTeam") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      const tid = Number(msg.teamId) | 0;
      const valid = validTeamId(tid);
      if (!valid) {
        safeSend(ws,{ type: "joinError", reason: "team" });
        return;
      }
      const dtJoin = dynamicTeams.find((t) => t.id === tid);
      if (!dtJoin || dtJoin.solo) {
        safeSend(ws,{ type: "joinError", reason: "team" });
        return;
      }
      if (ws.teamId != null) {
        safeSend(ws,{ type: "joinError", reason: "already" });
        return;
      }
      const cur = teamPlayerCounts.get(tid) || 0;
      if (cur >= getMaxPerTeam()) {
        safeSend(ws,{ type: "joinError", reason: "full" });
        return;
      }
      ws.teamId = tid;
      teamPlayerCounts.set(tid, cur + 1);
      if (ws.playerKey) addTeamMemberKey(tid, ws.playerKey);
      safeSend(ws,{ type: "joined", teamId: tid });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "leaveTeam") {
      attachPlayerKey(ws, msg);
      if (ws.teamId == null) {
        safeSend(ws,{ type: "leaveError", reason: "no_team" });
        return;
      }
      const tid = ws.teamId;
      if (ws.playerKey) removeTeamMemberKey(tid, ws.playerKey);
      const c = teamPlayerCounts.get(tid) ?? 0;
      teamPlayerCounts.set(tid, Math.max(0, c - 1));
      ws.teamId = null;
      safeSend(ws,{ type: "left" });
      broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "pixel") {
      if (!assertCanPlay(ws)) return;
      if (ws.teamId == null) {
        safeSend(ws,{ type: "pixelReject", reason: "no_team" });
        return;
      }
      const x = msg.x | 0;
      const y = msg.y | 0;
      const teamId = ws.teamId;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) {
        safeSend(ws, { type: "pixelReject", reason: "out_of_bounds" });
        return;
      }

      const now = Date.now();
      const last = lastPlace.get(ws) || 0;
      if (COOLDOWN_MS > 0 && now - last < COOLDOWN_MS) {
        safeSend(ws,{ type: "pixelReject", reason: "cooldown" });
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

async function telegramFetchChatUsername(userId) {
  if (!TELEGRAM_BOT_TOKEN) return "";
  try {
    const res = await fetch(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getChat?chat_id=${encodeURIComponent(String(userId))}`
    );
    const data = await res.json();
    if (data.ok && data.result?.username) return String(data.result.username).slice(0, 64);
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * Уведомляет админов (TELEGRAM_ADMIN_IDS) о финалистах: username и Telegram ID участников победившей команды (до 2).
 */
async function notifyFinalWinnersTelegram(winnerPlayerKeys, teamName, pct) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_ADMIN_IDS.size === 0) return;
  const lines = [];
  let n = 0;
  for (const pk of winnerPlayerKeys) {
    const meta = playerTelegramMeta.get(pk);
    const m = /^tg_(\d+)$/.exec(pk);
    const tgId = meta?.id ?? (m ? Number(m[1]) : null);
    let username = meta?.username?.trim() || "";
    if (tgId != null && !username) {
      username = await telegramFetchChatUsername(tgId);
    }
    n += 1;
    if (tgId != null) {
      const un = username ? `@${username}` : "(username не указан или скрыт)";
      lines.push(`${n}. ${un}\n   Telegram ID: ${tgId}`);
    } else {
      lines.push(`${n}. не из Telegram Mini App (playerKey: ${pk.slice(0, 32)}…)`);
    }
  }
  const pctStr = typeof pct === "number" && Number.isFinite(pct) ? pct.toFixed(3) : String(pct ?? "—");
  const body =
    `Финал Pixel Battle\n` +
    `Победители: «${teamName}» — ${pctStr}% территории\n` +
    `Участники победившей команды (${winnerPlayerKeys.size} чел.):\n\n` +
    (lines.length ? lines.join("\n\n") : "(нет записанных участников — возможно, снимок был пуст)");
  const text = body.slice(0, 4000);
  for (const adminId of TELEGRAM_ADMIN_IDS) {
    try {
      await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: adminId, text }),
      });
    } catch (e) {
      console.warn("notifyFinalWinnersTelegram:", e.message || e);
    }
  }
}

/**
 * @param {number} [durationHours] положительное число часов (0.01 = 36 с); без аргумента — 100 ч
 */
function startRoundOneTimer(durationHours) {
  if (gameFinished) return { ok: false, reason: "game_finished" };
  if (roundIndex !== 0) return { ok: false, reason: "not_round_first" };
  if (roundTimerStarted) return { ok: false, reason: "already_started" };
  let ms = ROUND_MS;
  if (typeof durationHours === "number" && Number.isFinite(durationHours) && durationHours > 0) {
    ms = Math.round(durationHours * 60 * 60 * 1000);
    ms = Math.min(Math.max(ms, 1000), 8760 * 60 * 60 * 1000);
  }
  roundDurationMs = ms;
  roundTimerStarted = true;
  roundStartMs = Date.now();
  saveRoundState();
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    sendConnectionMeta(client);
  }
  broadcastStatsImmediate();
  return { ok: true, durationMs: ms };
}

async function telegramSendMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

async function telegramPollLoop() {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_ADMIN_IDS.size === 0) return;
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`
      );
      const data = await res.json();
      if (!data.ok) {
        console.warn("Telegram getUpdates:", data.description || JSON.stringify(data));
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      for (const u of data.result || []) {
        offset = u.update_id + 1;
        const msg = u.message || u.edited_message;
        if (!msg || typeof msg.text !== "string") continue;
        const uid = msg.from?.id;
        if (uid == null || !TELEGRAM_ADMIN_IDS.has(uid)) continue;
        let t = String(msg.text).trim();
        t = t.replace(/^\/go\b/i, "go").replace(/^гол\s*/i, "go ");
        const tl = t.toLowerCase();
        if (!tl.startsWith("go")) continue;
        const chatId = msg.chat.id;
        const rest = t.slice(2).trim();
        let hours = 100;
        if (rest.length) {
          const n = parseFloat(rest.replace(",", "."));
          if (!Number.isFinite(n) || n <= 0) {
            await telegramSendMessage(
              chatId,
              "Укажите положительное число часов: go 100, go 1 или go 0.01 (латиница go или «гол»)."
            );
            continue;
          }
          hours = n;
        }
        const result = startRoundOneTimer(hours);
        let reply;
        if (result.ok) {
          const h = (result.durationMs ?? roundDurationMs) / 3600000;
          reply = `Первый раунд: таймер ${h} ч. Старт: ${new Date(roundStartMs).toISOString()}`;
        } else if (result.reason === "already_started") {
          reply = "Таймер первого раунда уже идёт.";
        } else if (result.reason === "game_finished") {
          reply = "Игра уже завершена.";
        } else {
          reply = "Команда «go» действует только до перехода ко 2-му раунду (сейчас не раунд 1).";
        }
        await telegramSendMessage(chatId, reply);
      }
    } catch (e) {
      console.warn("Telegram poll:", e.message || e);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

server.listen(PORT, () => {
  console.log(`Pixel Battle: http://localhost:${PORT}  (WS ${WS_PATH})`);
  if (WAIT_FOR_TELEGRAM_GO) {
    console.log(
      'Первый раунд: в личку боту — «go», «go 100» (часов), «go 0.01» или «гол 1» (кириллица вместо go).'
    );
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`).catch(
      () => {}
    );
    telegramPollLoop().catch((e) => console.warn("Telegram poll:", e));
  } else if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_IDS.size === 0) {
    console.warn(
      "[Pixel Battle] Задан TELEGRAM_BOT_TOKEN, но пуст TELEGRAM_ADMIN_IDS — polling не запущен; без «go» используйте только локальную разработку или добавьте ID через запятую."
    );
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_IDS.size > 0) {
    console.log(
      "После финала (3-й раунд) бот отправит каждому id из TELEGRAM_ADMIN_IDS username и Telegram ID участников победившей команды (до 2 чел.)."
    );
  }
});
