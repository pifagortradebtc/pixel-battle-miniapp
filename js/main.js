/**
 * Pixel Battle — карта мира, команды (только из списка), WebSocket.
 * Локально (?nows / без сервера): палитра. Онлайн: цвет команды, выбор команды, лимит 200.
 */

const GRID_W = 320;
const GRID_H = 320;
const BASE_CELL = 4;
const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
const COOLDOWN_MS = 1200;

const STORAGE_KEY = "pixel-battle-v2";
const LEGACY_STORAGE_KEY = "pixel-battle-v1";
const SESSION_TEAM = "pixel-battle-team";
const WS_PATH = "/ws";

const PALETTE = [
  "#1a1a2e", "#16213e", "#0f3460", "#533483", "#e94560",
  "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ffffff",
  "#c8d6e5", "#576574", "#8395a7", "#222f3e", "#b8e994", "#686de0",
];

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: false });
const paletteEl = document.getElementById("palette");
const teamBadge = document.getElementById("team-badge");
const teamBadgeName = document.getElementById("team-badge-name");
const teamBadgeCount = document.getElementById("team-badge-count");
const cooldownLabel = document.getElementById("cooldown-label");
const connStatus = document.getElementById("conn-status");
const btnReset = document.getElementById("btn-reset");
const teamOverlay = document.getElementById("team-overlay");
const teamListEl = document.getElementById("team-list");

/** @type {Map<string, number>} key "x,y" -> teamId (онлайн) или индекс палитры (локально) */
const pixels = new Map();

/** @type {Uint8Array | null} id страны на клетку, 0 = океан */
let regionCells = null;

let selectedColor = 5;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let lastPlaceAt = 0;

let persistTimer = null;
let ws = null;
let reconnectTimer = null;

/** Онлайн-режим: есть URL WebSocket */
let wantOnline = false;
/** Успешно выбрана команда (онлайн) */
let myTeamId = null;
/** Мета с сервера */
let teamsMeta = null;
let teamCounts = {};
let maxPerTeam = 200;

function parseQuery() {
  const q = new URLSearchParams(location.search);
  return {
    noWs: q.has("nows"),
    wsOverride: q.get("ws"),
  };
}

function getWsUrl() {
  const { noWs, wsOverride } = parseQuery();
  if (noWs) return null;
  if (wsOverride) return wsOverride;
  if (location.protocol === "file:") return null;
  const proto = location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${location.host}${WS_PATH}`;
}

function b64ToUint8(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function loadRegions() {
  try {
    const r = await fetch("/data/regions-320.json");
    if (!r.ok) throw new Error("no regions");
    const j = await r.json();
    regionCells = b64ToUint8(j.cellsBase64);
    if (regionCells.length !== GRID_W * GRID_H) regionCells = null;
  } catch {
    regionCells = null;
  }
}

function countryColor(regionId) {
  if (!regionId) return "#0a1628";
  const h = (regionId * 53) % 360;
  return `hsl(${h} 38% 32%)`;
}

function teamColor(teamId) {
  const t = teamsMeta?.find((x) => x.id === teamId);
  return t ? t.color : "#888888";
}

function setConnState(state, text) {
  connStatus.dataset.state = state;
  connStatus.textContent = text;
  connStatus.title = text;
}

function setFooterMode() {
  const online = wantOnline;
  const joined = myTeamId != null;
  paletteEl.hidden = online;
  teamBadge.hidden = !online || !joined;
  if (online && joined) updateTeamBadge();
}

function updateTeamBadge() {
  if (!myTeamId || !teamsMeta) return;
  const t = teamsMeta.find((x) => x.id === myTeamId);
  if (!t) return;
  teamBadgeName.textContent = t.name;
  teamBadgeName.style.color = t.color;
  const cnt = teamCounts[t.id] ?? 0;
  teamBadgeCount.textContent = `${cnt} / ${maxPerTeam}`;
}

function loadFromStorage() {
  try {
    let raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) {
      raw = localStorage.getItem(LEGACY_STORAGE_KEY);
      if (!raw) return;
    }
    const data = JSON.parse(raw);
    if (data.version !== 1 && data.version !== 2) return;
    pixels.clear();
    if (Array.isArray(data.pixels)) {
      for (const item of data.pixels) {
        if (Array.isArray(item) && item.length === 3) {
          const [x, y, v] = item;
          pixels.set(`${x},${y}`, v);
        }
      }
    }
    if (data.view && typeof data.view === "object") {
      const v = data.view;
      if (typeof v.scale === "number" && v.scale >= MIN_SCALE && v.scale <= MAX_SCALE) scale = v.scale;
      if (typeof v.offsetX === "number") offsetX = v.offsetX;
      if (typeof v.offsetY === "number") offsetY = v.offsetY;
      if (typeof v.color === "number" && v.color >= 0 && v.color < PALETTE.length) selectedColor = v.color;
    }
  } catch {
    /* ignore */
  }
}

function flushToStorage() {
  const wantSavePixels = !wantOnline;
  const list = [];
  if (wantSavePixels) {
    for (const [key, v] of pixels) {
      const [x, y] = key.split(",").map(Number);
      list.push([x, y, v]);
    }
  }
  const payload = {
    version: 2,
    pixels: wantSavePixels ? list : [],
    view: { scale, offsetX, offsetY, color: selectedColor },
    teamId: myTeamId,
  };
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
  } catch {
    /* quota */
  }
}

function schedulePersist() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(flushToStorage, 420);
}

function rebuildTeamList() {
  teamListEl.innerHTML = "";
  if (!teamsMeta) return;
  for (const t of teamsMeta) {
    const cnt = teamCounts[t.id] ?? 0;
    const full = cnt >= maxPerTeam;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-list__btn";
    btn.disabled = full;
    btn.setAttribute("role", "option");
    const dot = document.createElement("span");
    dot.textContent = "● ";
    dot.style.color = t.color;
    const name = document.createElement("span");
    name.textContent = t.name;
    const left = document.createElement("span");
    left.appendChild(dot);
    left.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "team-list__meta";
    meta.textContent = `${cnt} / ${maxPerTeam}`;
    btn.appendChild(left);
    btn.appendChild(meta);
    btn.addEventListener("click", () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ type: "joinTeam", teamId: t.id }));
    });
    teamListEl.appendChild(btn);
  }
}

function trySessionJoin() {
  const saved = sessionStorage.getItem(SESSION_TEAM);
  if (!saved || !ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "joinTeam", teamId: Number(saved) }));
}

function onMeta(msg) {
  teamsMeta = msg.teams || [];
  teamCounts = msg.teamCounts || {};
  maxPerTeam = msg.maxPerTeam ?? 200;
  rebuildTeamList();
  const saved = sessionStorage.getItem(SESSION_TEAM);
  if (saved) {
    trySessionJoin();
  } else {
    teamOverlay.hidden = false;
  }
}

function notifyReject(reason) {
  const map = {
    ocean: "Сюда нельзя (океан или вне карты).",
    no_adj: "Сначала захватите соседнюю клетку своей командой.",
    cooldown: "Слишком часто.",
    no_team: "Сначала выберите команду.",
  };
  const text = map[reason] || reason;
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.showAlert === "function") tg.showAlert(text);
  else {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = text;
    setTimeout(() => {
      cooldownLabel.hidden = true;
    }, 1600);
  }
}

function connectWs() {
  clearTimeout(reconnectTimer);
  const url = getWsUrl();
  wantOnline = !!url;
  if (!url) {
    setConnState("local", "локально");
    setFooterMode();
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnState("connecting", "подключение…");
  try {
    ws = new WebSocket(url);
  } catch {
    setConnState("error", "ошибка WS");
    reconnectTimer = setTimeout(connectWs, 3500);
    return;
  }

  ws.addEventListener("open", () => {
    setConnState("online", "онлайн");
    myTeamId = null;
    setFooterMode();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }

    if (msg.type === "meta") {
      onMeta(msg);
      return;
    }
    if (msg.type === "counts") {
      teamCounts = msg.teamCounts || {};
      rebuildTeamList();
      updateTeamBadge();
      return;
    }
    if (msg.type === "joined") {
      myTeamId = msg.teamId;
      sessionStorage.setItem(SESSION_TEAM, String(msg.teamId));
      teamOverlay.hidden = true;
      setFooterMode();
      schedulePersist();
      return;
    }
    if (msg.type === "joinError") {
      if (msg.reason === "full") {
        sessionStorage.removeItem(SESSION_TEAM);
      }
      teamOverlay.hidden = false;
      rebuildTeamList();
      return;
    }
    if (msg.type === "full") {
      pixels.clear();
      for (const p of msg.pixels || []) {
        if (Array.isArray(p) && p.length === 3) {
          const [x, y, t] = p;
          pixels.set(`${x},${y}`, t);
        }
      }
      draw();
      if (wantOnline) flushToStorage();
      else schedulePersist();
      return;
    }
    if (msg.type === "pixel") {
      pixels.set(`${msg.x},${msg.y}`, msg.t);
      draw();
      schedulePersist();
      return;
    }
    if (msg.type === "pixelReject") {
      if (msg.reason !== "cooldown") {
        lastPlaceAt = 0;
      }
      notifyReject(msg.reason || "");
      return;
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
    myTeamId = null;
    teamsMeta = null;
    setConnState("error", "нет связи");
    reconnectTimer = setTimeout(connectWs, 3500);
    setFooterMode();
  });

  ws.addEventListener("error", () => {
    setConnState("error", "ошибка");
  });
}

function sendPixelOnline(gx, gy) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "pixel", x: gx, y: gy }));
  }
}

function sendClearToServer() {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "clear" }));
  }
}

function initTelegram() {
  const tg = window.Telegram?.WebApp;
  if (!tg) return;
  tg.ready();
  tg.expand();
  if (tg.disableVerticalSwipes) tg.disableVerticalSwipes();
  document.body.style.backgroundColor = tg.themeParams.bg_color || "";
  tg.onEvent("themeChanged", () => {
    document.body.style.backgroundColor = tg.themeParams.bg_color || "";
  });
}

function buildPalette() {
  paletteEl.innerHTML = "";
  PALETTE.forEach((hex, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette__swatch";
    b.style.backgroundColor = hex;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === selectedColor ? "true" : "false");
    b.dataset.index = String(i);
    b.title = hex;
    b.addEventListener("click", () => {
      selectedColor = i;
      paletteEl.querySelectorAll(".palette__swatch").forEach((el) => {
        el.setAttribute("aria-selected", el.dataset.index === String(i) ? "true" : "false");
      });
      schedulePersist();
    });
    paletteEl.appendChild(b);
  });
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;
  canvas.width = Math.floor(w * dpr);
  canvas.height = Math.floor(h * dpr);
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  centerIfNeeded(w, h);
  draw();
}

function centerIfNeeded(w, h) {
  if (offsetX === 0 && offsetY === 0 && scale === 1) {
    const cell = BASE_CELL * scale;
    offsetX = (w - GRID_W * cell) / 2;
    offsetY = (h - GRID_H * cell) / 2;
  }
}

function screenToGrid(sx, sy) {
  const cell = BASE_CELL * scale;
  const gx = Math.floor((sx - offsetX) / cell);
  const gy = Math.floor((sy - offsetY) / cell);
  return { gx, gy };
}

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const cell = BASE_CELL * scale;

  ctx.fillStyle = "#050810";
  ctx.fillRect(0, 0, w, h);

  const x0 = Math.max(0, Math.floor((0 - offsetX) / cell));
  const y0 = Math.max(0, Math.floor((0 - offsetY) / cell));
  const x1 = Math.min(GRID_W - 1, Math.ceil((w - offsetX) / cell));
  const y1 = Math.min(GRID_H - 1, Math.ceil((h - offsetY) / cell));

  const online = wantOnline && getWsUrl();

  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const key = `${gx},${gy}`;
      const idx = regionCells ? regionCells[gy * GRID_W + gx] : 1;
      const base = countryColor(idx);
      const owner = pixels.get(key);
      const px = offsetX + gx * cell;
      const py = offsetY + gy * cell;
      const cw = Math.ceil(cell);
      const ch = Math.ceil(cell);

      ctx.fillStyle = base;
      ctx.fillRect(px, py, cw, ch);

      if (owner !== undefined) {
        if (online) {
          ctx.fillStyle = teamColor(owner);
          ctx.globalAlpha = 0.78;
          ctx.fillRect(px, py, cw, ch);
          ctx.globalAlpha = 1;
        } else {
          ctx.fillStyle = PALETTE[owner] ?? "#888";
          ctx.fillRect(px, py, cw, ch);
        }
      }
    }
  }

  if (cell >= 6) {
    ctx.strokeStyle = "rgba(255,255,255,0.035)";
    ctx.lineWidth = 1;
    for (let gx = x0; gx <= x1 + 1; gx++) {
      const x = offsetX + gx * cell;
      ctx.beginPath();
      ctx.moveTo(x, 0);
      ctx.lineTo(x, h);
      ctx.stroke();
    }
    for (let gy = y0; gy <= y1 + 1; gy++) {
      const y = offsetY + gy * cell;
      ctx.beginPath();
      ctx.moveTo(0, y);
      ctx.lineTo(w, y);
      ctx.stroke();
    }
  }
}

function placePixel(gx, gy) {
  if (gx < 0 || gx >= GRID_W || gy < 0 || gy >= GRID_H) return;

  const online = wantOnline && getWsUrl();
  if (online) {
    if (myTeamId == null) {
      notifyReject("no_team");
      teamOverlay.hidden = false;
      return;
    }
  }

  const now = Date.now();
  if (now - lastPlaceAt < COOLDOWN_MS) {
    showCooldown(COOLDOWN_MS - (now - lastPlaceAt));
    return;
  }
  lastPlaceAt = now;

  if (online) {
    sendPixelOnline(gx, gy);
  } else {
    pixels.set(`${gx},${gy}`, selectedColor);
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = `Пауза ${(COOLDOWN_MS / 1000).toFixed(1)} с`;
    setTimeout(() => {
      cooldownLabel.hidden = true;
    }, 400);
    schedulePersist();
    draw();
  }
}

function showCooldown(ms) {
  cooldownLabel.hidden = false;
  cooldownLabel.textContent = `Подождите ${(ms / 1000).toFixed(1)} с`;
  clearTimeout(showCooldown._t);
  showCooldown._t = setTimeout(() => {
    cooldownLabel.hidden = true;
  }, 800);
}

function setupReset() {
  btnReset.addEventListener("click", () => {
    const run = () => {
      pixels.clear();
      lastPlaceAt = 0;
      scale = 1;
      offsetX = 0;
      offsetY = 0;
      try {
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(LEGACY_STORAGE_KEY);
      } catch {
        /* ignore */
      }
      sendClearToServer();
      draw();
      resizeCanvas();
    };

    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showConfirm === "function") {
      tg.showConfirm("Очистить захваченные клетки для всех?", (ok) => {
        if (ok) run();
      });
    } else if (confirm("Очистить поле?")) {
      run();
    }
  });
}

function setupGestures() {
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  /** @type {{ x: number, y: number, t: number, ox: number, oy: number, panning: boolean } | null} */
  let oneFinger = null;

  function dist(t1, t2) {
    const dx = t1.clientX - t2.clientX;
    const dy = t1.clientY - t2.clientY;
    return Math.hypot(dx, dy);
  }

  canvas.addEventListener(
    "touchstart",
    (e) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        pinchStartDist = dist(a, b);
        pinchStartScale = scale;
        oneFinger = null;
      } else if (e.touches.length === 1) {
        const t = e.touches[0];
        oneFinger = {
          x: t.clientX,
          y: t.clientY,
          t: Date.now(),
          ox: offsetX,
          oy: offsetY,
          panning: false,
        };
      }
      e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchmove",
    (e) => {
      if (e.touches.length === 2) {
        const [a, b] = [e.touches[0], e.touches[1]];
        const d = dist(a, b);
        if (pinchStartDist > 0) {
          const factor = d / pinchStartDist;
          const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, pinchStartScale * factor));
          const midX = (a.clientX + b.clientX) / 2;
          const midY = (a.clientY + b.clientY) / 2;
          const worldXBefore = (midX - offsetX) / (BASE_CELL * scale);
          const worldYBefore = (midY - offsetY) / (BASE_CELL * scale);
          scale = newScale;
          offsetX = midX - worldXBefore * BASE_CELL * scale;
          offsetY = midY - worldYBefore * BASE_CELL * scale;
        }
        draw();
      } else if (e.touches.length === 1 && oneFinger) {
        const t = e.touches[0];
        const dx = t.clientX - oneFinger.x;
        const dy = t.clientY - oneFinger.y;
        if (Math.hypot(dx, dy) > 10) oneFinger.panning = true;
        if (oneFinger.panning) {
          offsetX = oneFinger.ox + dx;
          offsetY = oneFinger.oy + dy;
          draw();
        }
      }
      e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener(
    "touchend",
    (e) => {
      if (e.touches.length < 2) pinchStartDist = 0;
      if (e.touches.length === 0 && oneFinger) {
        const t = e.changedTouches[0];
        const dx = t.clientX - oneFinger.x;
        const dy = t.clientY - oneFinger.y;
        const dt = Date.now() - oneFinger.t;
        if (!oneFinger.panning && Math.hypot(dx, dy) < 16 && dt < 400) {
          const rect = canvas.getBoundingClientRect();
          const sx = t.clientX - rect.left;
          const sy = t.clientY - rect.top;
          const { gx, gy } = screenToGrid(sx, sy);
          placePixel(gx, gy);
        }
        oneFinger = null;
      }
      if (e.touches.length === 0) schedulePersist();
      e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener("touchcancel", () => {
    oneFinger = null;
    pinchStartDist = 0;
    schedulePersist();
  });

  canvas.addEventListener("click", (e) => {
    if ("ontouchstart" in window) return;
    const rect = canvas.getBoundingClientRect();
    const sx = e.clientX - rect.left;
    const sy = e.clientY - rect.top;
    const { gx, gy } = screenToGrid(sx, sy);
    placePixel(gx, gy);
  });

  canvas.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left;
      const my = e.clientY - rect.top;
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      const newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale * delta));
      const worldX = (mx - offsetX) / (BASE_CELL * scale);
      const worldY = (my - offsetY) / (BASE_CELL * scale);
      scale = newScale;
      offsetX = mx - worldX * BASE_CELL * scale;
      offsetY = my - worldY * BASE_CELL * scale;
      draw();
      schedulePersist();
    },
    { passive: false }
  );
}

async function bootstrap() {
  initTelegram();
  await loadRegions();
  loadFromStorage();
  wantOnline = !!getWsUrl();
  if (!wantOnline) {
    buildPalette();
  }
  setFooterMode();
  setupReset();
  setupGestures();

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("pagehide", () => {
    flushToStorage();
  });
  if (document.fonts?.ready) await document.fonts.ready;
  resizeCanvas();
  connectWs();
}

bootstrap();
