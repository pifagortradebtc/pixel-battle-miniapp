/**
 * Pixel Battle — Telegram Mini App
 * Локальное сохранение, сброс, WebSocket к server.js (тот же хост, путь /ws).
 */

const GRID_W = 320;
const GRID_H = 320;
const BASE_CELL = 4;
const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
const COOLDOWN_MS = 1200;

const STORAGE_KEY = "pixel-battle-v1";
const WS_PATH = "/ws";

const PALETTE = [
  "#1a1a2e", "#16213e", "#0f3460", "#533483", "#e94560",
  "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ffffff",
  "#c8d6e5", "#576574", "#8395a7", "#222f3e", "#b8e994", "#686de0",
];

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: false });
const paletteEl = document.getElementById("palette");
const cooldownLabel = document.getElementById("cooldown-label");
const connStatus = document.getElementById("conn-status");
const btnReset = document.getElementById("btn-reset");

/** @type {Map<string, number>} key "x,y" -> palette index */
const pixels = new Map();

let selectedColor = 5;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let lastPlaceAt = 0;

let persistTimer = null;
let ws = null;
let reconnectTimer = null;

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

function setConnState(state, text) {
  connStatus.dataset.state = state;
  connStatus.textContent = text;
  connStatus.title = text;
}

function loadFromStorage() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (data.version !== 1) return;
    pixels.clear();
    if (Array.isArray(data.pixels)) {
      for (const item of data.pixels) {
        if (Array.isArray(item) && item.length === 3) {
          const [x, y, c] = item;
          pixels.set(`${x},${y}`, c);
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
  const list = [];
  for (const [key, c] of pixels) {
    const [x, y] = key.split(",").map(Number);
    list.push([x, y, c]);
  }
  const payload = {
    version: 1,
    pixels: list,
    view: { scale, offsetX, offsetY, color: selectedColor },
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

function connectWs() {
  clearTimeout(reconnectTimer);
  const url = getWsUrl();
  if (!url) {
    setConnState("local", "локально");
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
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === "full") {
      pixels.clear();
      for (const p of msg.pixels || []) {
        if (Array.isArray(p) && p.length === 3) {
          const [x, y, c] = p;
          pixels.set(`${x},${y}`, c);
        }
      }
      draw();
      flushToStorage();
    } else if (msg.type === "pixel") {
      pixels.set(`${msg.x},${msg.y}`, msg.c);
      draw();
      schedulePersist();
    }
  });

  ws.addEventListener("close", () => {
    ws = null;
    setConnState("error", "нет связи");
    reconnectTimer = setTimeout(connectWs, 3500);
  });

  ws.addEventListener("error", () => {
    setConnState("error", "ошибка");
  });
}

function sendPixel(gx, gy, c) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify({ type: "pixel", x: gx, y: gy, c }));
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

  ctx.fillStyle = "#0d1117";
  ctx.fillRect(0, 0, w, h);

  const x0 = Math.max(0, Math.floor((0 - offsetX) / cell));
  const y0 = Math.max(0, Math.floor((0 - offsetY) / cell));
  const x1 = Math.min(GRID_W - 1, Math.ceil((w - offsetX) / cell));
  const y1 = Math.min(GRID_H - 1, Math.ceil((h - offsetY) / cell));

  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const key = `${gx},${gy}`;
      const idx = pixels.get(key);
      const px = offsetX + gx * cell;
      const py = offsetY + gy * cell;
      ctx.fillStyle = idx !== undefined ? PALETTE[idx] : "#1e2630";
      ctx.fillRect(px, py, Math.ceil(cell), Math.ceil(cell));
    }
  }

  if (cell >= 6) {
    ctx.strokeStyle = "rgba(255,255,255,0.04)";
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
  const now = Date.now();
  if (now - lastPlaceAt < COOLDOWN_MS) {
    showCooldown(COOLDOWN_MS - (now - lastPlaceAt));
    return;
  }
  lastPlaceAt = now;
  pixels.set(`${gx},${gy}`, selectedColor);
  sendPixel(gx, gy, selectedColor);
  cooldownLabel.hidden = false;
  cooldownLabel.textContent = `Пауза ${(COOLDOWN_MS / 1000).toFixed(1)} с`;
  setTimeout(() => {
    cooldownLabel.hidden = true;
  }, 400);
  schedulePersist();
  draw();
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
      } catch {
        /* ignore */
      }
      sendClearToServer();
      draw();
      resizeCanvas();
    };

    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showConfirm === "function") {
      tg.showConfirm("Очистить поле? (для всех, если есть связь с сервером)", (ok) => {
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

initTelegram();
loadFromStorage();
buildPalette();
setupReset();
setupGestures();

window.addEventListener("resize", resizeCanvas);
window.addEventListener("pagehide", () => {
  flushToStorage();
});
if (document.fonts?.ready) document.fonts.ready.then(resizeCanvas);
else resizeCanvas();

connectWs();
