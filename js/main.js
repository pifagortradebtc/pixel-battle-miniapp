/**
 * Pixel Battle — карта мира, команды, WebSocket.
 * Локально: палитра кисти. Онлайн: соло и создатель команды меняют цвет снизу;
 * остальные в команде рисуют цветом команды (задаёт создатель).
 */

import { createBoardVfx, spawnFloatingText } from "./vfx.js";
import {
  BASE_ACTION_COOLDOWN_SEC,
  getCurrentCooldownMs,
  getEffectiveRecoverySec,
  PRICES_QUANT,
} from "../lib/tournament-economy.js";

let gridW = 640;
let gridH = 640;
const BASE_CELL = 4;
const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
/** Видимых клеток больше — без градиента на каждую (иначе createLinearGradient ×10⁵/сек). */
const DRAW_DETAIL_GRADIENT_MAX_CELLS = 7000;
/** Ещё тяжелее — без анимированных рёбер между командами (второй полный проход по сетке). */
const DRAW_DETAIL_EDGE_SHIMMER_MAX_CELLS = 11000;
const COOLDOWN_MS = 0;
/** Длительность баффов «личное/командное восстановление» — как на сервере (tournament-economy). */
const RECOVERY_BUFF_DURATION_MS = 2 * 60 * 1000;

/** Последние покупки для боковой панели «Повторить» */
const QUICK_BUY_HISTORY_KEY = "pixel-battle-quick-buy-v1";
const MAX_QUICK_BUY_ITEMS = 5;

const STORAGE_KEY = "pixel-battle-v2";
const LEGACY_STORAGE_KEY = "pixel-battle-v1";
const SESSION_TEAM = "pixel-battle-team";
/** JSON: { [teamId: string]: editToken } — у создателя публичной команды */
const SESSION_TEAM_EDIT = "pixel-battle-team-edit-tokens";
/** Сохраняется в localStorage: команда, соло-токен, имя, цвет — переживает закрытие Mini App */
const ONLINE_SESSION_KEY = "pixel-battle-online-session";
/** Токен победителя для участия в раундах после первого (claim при переподключении) */
const ROUND_ELIGIBLE_KEY = "pixel-battle-round-eligible";
/** Стабильный id игрока на устройстве (или tg_<id> в Telegram) — сервер выдаёт токен победителя по ключу */
const PLAYER_KEY_STORAGE = "pixel-battle-player-key";
const WS_PATH = "/ws";
/** Совпадает с NOWPayments: USDT в сети BEP20 (Binance Smart Chain) */
const DEPOSIT_PAY_CURRENCY = "usdtbsc";

/** Если localStorage недоступен — один стабильный ключ на сессию страницы */
let cachedAnonPlayerKey = null;

/**
 * Без проверки подписи — только чтение user.id из строки initData (как на сервере после verify).
 * Нужно, когда Telegram.WebApp.initDataUnsafe ещё пуст, а initData уже есть (часто Desktop).
 */
function parseTelegramUserIdFromInitDataString(initData) {
  if (typeof initData !== "string" || !initData.trim()) return null;
  try {
    const params = new URLSearchParams(initData);
    const userStr = params.get("user");
    if (!userStr) return null;
    const user = JSON.parse(userStr);
    if (!user || user.id == null) return null;
    const id = Number(user.id);
    return Number.isFinite(id) ? id : null;
  } catch {
    return null;
  }
}

function getOrCreatePlayerKey() {
  try {
    const u = window.Telegram?.WebApp?.initDataUnsafe?.user;
    if (u && u.id != null) return `tg_${u.id}`;
  } catch {
    /* ignore */
  }
  try {
    const raw = window.Telegram?.WebApp?.initData;
    const id = parseTelegramUserIdFromInitDataString(typeof raw === "string" ? raw : "");
    if (id != null) return `tg_${id}`;
  } catch {
    /* ignore */
  }
  try {
    let k = localStorage.getItem(PLAYER_KEY_STORAGE);
    if (!k) {
      k =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `p_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
      localStorage.setItem(PLAYER_KEY_STORAGE, k);
    }
    return k;
  } catch {
    if (!cachedAnonPlayerKey) {
      cachedAnonPlayerKey =
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : `anon_${Date.now()}_${Math.random().toString(36).slice(2, 12)}`;
    }
    return cachedAnonPlayerKey;
  }
}

/** Для сервера: id и @username из Mini App (финальное уведомление победителям). */
function getTelegramUserForServer() {
  try {
    const u = window.Telegram?.WebApp?.initDataUnsafe?.user;
    if (u && u.id != null) {
      return { id: u.id, username: typeof u.username === "string" ? u.username : "" };
    }
  } catch {
    /* ignore */
  }
  return null;
}

/** Строка initData для проверки подписи на сервере (привязка аккаунта к Telegram). */
function getTelegramInitDataForServer() {
  try {
    const s = window.Telegram?.WebApp?.initData;
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

/** Быстрый выбор эмодзи для команды */
const EMOJI_PRESETS = [
  "🔥", "🦁", "🐉", "🦅", "🐻", "🐋", "⚡", "🌟", "💎", "🎯", "🚀", "🛡️", "⚔️", "🌊", "🌸", "❄️",
  "🦊", "🐙", "🦄", "☀️", "🌙", "💀", "👑", "🏴",
];

/** 16 ярких, хорошо различимых цветов (на тёмном фоне UI и на карте) */
const PALETTE = [
  "#FF1744",
  "#FF6D00",
  "#FFC400",
  "#FFEB3B",
  "#C6FF00",
  "#00E676",
  "#00BFA5",
  "#00E5FF",
  "#2979FF",
  "#651FFF",
  "#D500F9",
  "#E91E63",
  "#FF5722",
  "#1DE9B6",
  "#8E24AA",
  "#FFFFFF",
];

const canvas = document.getElementById("board");
/** desynchronized: ниже задержка вывода на части устройств (плавность важнее идеального compositing). */
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: true });
const paletteEl = document.getElementById("palette");
const paletteTriggerBtn = document.getElementById("palette-trigger");
const palettePickerOverlay = document.getElementById("palette-picker-overlay");
const palettePickerCloseBtn = document.getElementById("palette-picker-close");
const teamBadge = document.getElementById("team-badge");
const teamBadgeName = document.getElementById("team-badge-name");
const teamBadgeCount = document.getElementById("team-badge-count");
const cooldownLabel = document.getElementById("cooldown-label");
const connStatus = document.getElementById("conn-status");
const btnToolbarSession = document.getElementById("btn-toolbar-session");
const welcomeOverlay = document.getElementById("welcome-overlay");
const btnWelcomeCreate = document.getElementById("btn-welcome-create");
const btnWelcomeJoin = document.getElementById("btn-welcome-join");
const btnWelcomeClose = document.getElementById("btn-welcome-close");
const welcomeDiscussionWrap = document.getElementById("welcome-discussion-wrap");
const welcomeDiscussionLink = document.getElementById("welcome-discussion-link");
const toolbarDiscussionLink = document.getElementById("toolbar-discussion-link");
/** Макс. длина названия команды в боковой панели и в списке (графемы Unicode). */
const TEAM_NAME_DISPLAY_MAX = 6;
const teamOverlay = document.getElementById("team-overlay");
const btnTeamOverlayBack = document.getElementById("btn-team-overlay-back");
const teamListEl = document.getElementById("team-list");
const teamBadgeEmoji = document.getElementById("team-badge-emoji");
const teamSettingsOverlay = document.getElementById("team-settings-overlay");
const teamSettingsName = document.getElementById("team-settings-name");
const teamSettingsEmojiInput = document.getElementById("team-settings-emoji");
const teamSettingsEmojiPresets = document.getElementById("team-settings-emoji-presets");
const teamSettingsColorPaletteEl = document.getElementById("team-settings-color-palette");
const btnTeamSettingsSave = document.getElementById("team-settings-save");
const btnTeamSettingsCancel = document.getElementById("team-settings-cancel");
const createTeamOverlay = document.getElementById("create-team-overlay");
const createTeamNameInput = document.getElementById("create-team-name");
const createTeamEmojiInput = document.getElementById("create-team-emoji");
const createTeamEmojiPresets = document.getElementById("create-team-emoji-presets");
const createTeamColorPaletteEl = document.getElementById("create-team-color-palette");
const btnOpenCreateTeam = document.getElementById("btn-open-create-team");
const btnCreateTeamCancel = document.getElementById("create-team-cancel");
const btnCreateTeamSubmit = document.getElementById("create-team-submit");
const referralSplashOverlay = document.getElementById("referral-splash-overlay");
const referralSplashText = document.getElementById("referral-splash-text");
const btnReferralSplashCopy = document.getElementById("referral-splash-copy");
const btnReferralSplashOk = document.getElementById("referral-splash-ok");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const onlineCountEl = document.getElementById("online-count");
const leaderboardListEl = document.getElementById("leaderboard-list");
const roundTimerEl = document.getElementById("round-timer");
const spectatorBadgeEl = document.getElementById("spectator-badge");
const walletBalanceEl = document.getElementById("wallet-balance");
const toolbarPixelTimerEl = document.getElementById("toolbar-pixel-timer");
const toolbarBuffsEl = document.getElementById("toolbar-buffs");
const toolbarBuffPersonalEl = document.getElementById("toolbar-buff-personal");
const toolbarBuffPersonalLabelEl = document.getElementById("toolbar-buff-personal-label");
const toolbarBuffPersonalFillEl = document.getElementById("toolbar-buff-personal-fill");
const eventBannerEl = document.getElementById("event-banner");
const teamBuffBannerEl = document.getElementById("team-buff-banner");
const crisisOverlayEl = document.getElementById("crisis-overlay");
const btnDeposit = document.getElementById("btn-deposit");
const btnShop = document.getElementById("btn-shop");
const depositOverlay = document.getElementById("deposit-overlay");
const depositCustom = document.getElementById("deposit-custom");
const depositError = document.getElementById("deposit-error");
const depositCancel = document.getElementById("deposit-cancel");
const depositSubmit = document.getElementById("deposit-submit");
const shopOverlay = document.getElementById("shop-overlay");
const shopClose = document.getElementById("shop-close");
const shopStageHint = document.getElementById("shop-stage-hint");
const shopEffects = document.getElementById("shop-effects");
const shopPending = document.getElementById("shop-pending");
const canvasVfx = document.getElementById("board-vfx");
const floatFxHost = document.getElementById("float-fx");

/** После успешной покупки в открытом магазине: остальные «Купить» неактивны, на купленной — «✓». */
let shopPurchaseUiLock = false;

/** @type {ReturnType<typeof createBoardVfx> | null} */
let boardVfx = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let mapAnimTimer = null;
/** Последний draw(): число видимых клеток — для реже перерисовки при отдалении. */
let lastDrawVisibleCellCount = 0;
let lastZoneGx = 0;
let lastZoneGy = 0;
let prevWalletQuant = null;

/** @type {Map<string, number>} key "x,y" -> teamId (онлайн) или индекс палитры (локально) */
const pixels = new Map();

/** @type {Uint8Array | null} id страны на клетку, 0 = океан */
let regionCells = null;
/** @type {Uint8Array | null} RGB шаблон из regions-*.json (длина gridW*gridH*3), если есть — рисуем постер до закраски команд */
let regionRgb = null;

let selectedColor = 5;
/** Индекс в PALETTE для welcome / создания команды / настроек (онлайн) */
let welcomeColorIdx = 5;
let createTeamColorIdx = 5;
let teamSettingsColorIdx = 5;
/** Откуда открыли форму создания команды — «Назад» ведёт на welcome или список команд */
let createTeamFromWelcome = false;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let lastPlaceAt = 0;

/** Пан/щипок: упрощённая отрисовка + coalescing в rAF. */
let mapInteractionActive = false;
/** Колесо: отдельно, чтобы таймаут не сбрасывал режим во время перетаскивания мышью. */
let mapWheelActive = false;
/** Один rAF на кадр: пан/zoom и сетевые перерисовки не дублируют draw(). */
let canvasFrameRafId = 0;
let mapWheelEndTimer = 0;

/** Следующий кадр: полный проход видимой области (true) или только dirtyRect (false). */
let pendingRedrawFull = false;
/** @type {{ gx0: number, gy0: number, gx1: number, gy1: number } | null} */
let pendingDirtyRect = null;

/** ?perf=1 или localStorage pixel-battle-perf=1 — лог draw и window.__pixelBattlePerf */
const perfDebug =
  typeof window !== "undefined" &&
  (() => {
    try {
      if (new URLSearchParams(window.location.search).get("perf") === "1") return true;
      if (typeof localStorage !== "undefined" && localStorage.getItem("pixel-battle-perf") === "1")
        return true;
    } catch {
      /* ignore */
    }
    return false;
  })();

let perfDrawsLite = 0;
let perfDrawsFull = 0;
let perfMsLiteSum = 0;
let perfMsFullSum = 0;
let perfBucketDraws = 0;
let perfBucketStart = typeof performance !== "undefined" ? performance.now() : 0;

function perfRecordDraw(ms, lite) {
  if (lite) {
    perfDrawsLite++;
    perfMsLiteSum += ms;
  } else {
    perfDrawsFull++;
    perfMsFullSum += ms;
  }
  perfBucketDraws++;
  const now = performance.now();
  if (now - perfBucketStart < 2000) return;
  const span = (now - perfBucketStart) / 1000;
  const dps = perfBucketDraws / span;
  const avgL = perfDrawsLite ? perfMsLiteSum / perfDrawsLite : 0;
  const avgF = perfDrawsFull ? perfMsFullSum / perfDrawsFull : 0;
  console.log(
    `[pixel-battle perf] ~${dps.toFixed(0)} draws/s · avg draw lite ${avgL.toFixed(2)} ms · full ${avgF.toFixed(2)} ms (cumulative n=${perfDrawsLite + perfDrawsFull})`
  );
  perfBucketStart = now;
  perfBucketDraws = 0;
}

/** Оптимистичный пиксель до ответа сервера: { key, prev } */
let optimisticPixelPending = null;

/**
 * Оптимистичный захват зоны до purchaseOk / purchaseVfx.
 * @type {{ kind: string, gx: number, gy: number, size: number, keys: string[], prev: Map<string, ReturnType<typeof snapshotPixelCell>> } | null}
 */
let optimisticWeaponPending = null;

/** Кэш id команды → цвет (пересборка только при смене teamsMeta / цвета команды). */
let teamColorByIdCache = null;
/** @type {typeof teamsMeta} */
let teamColorByIdCacheTeamsRef = null;

function invalidateTeamColorByIdCache() {
  teamColorByIdCache = null;
  teamColorByIdCacheTeamsRef = null;
}

/** @typedef {{ gx0: number, gy0: number, gx1: number, gy1: number }} DirtyRect */

function expandDirtyRect(d, pad) {
  const p = pad | 0;
  return {
    gx0: d.gx0 - p,
    gy0: d.gy0 - p,
    gx1: d.gx1 + p,
    gy1: d.gy1 + p,
  };
}

function mergeDirtyRects(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    gx0: Math.min(a.gx0, b.gx0),
    gy0: Math.min(a.gy0, b.gy0),
    gx1: Math.max(a.gx1, b.gx1),
    gy1: Math.max(a.gy1, b.gy1),
  };
}

function dirtyRectFromKeys(keys) {
  let gx0 = Infinity;
  let gy0 = Infinity;
  let gx1 = -Infinity;
  let gy1 = -Infinity;
  for (let i = 0; i < keys.length; i++) {
    const parts = keys[i].split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    gx0 = Math.min(gx0, x);
    gy0 = Math.min(gy0, y);
    gx1 = Math.max(gx1, x);
    gy1 = Math.max(gy1, y);
  }
  if (gx0 === Infinity) return null;
  return { gx0, gy0, gx1, gy1 };
}

let persistTimer = null;
let ws = null;
let reconnectTimer = null;
/** Если сокет завис в CONNECTING — закрыть и дать сработать переподключению */
let connectingHangTimer = null;

/** Онлайн-режим: есть URL WebSocket */
let wantOnline = false;
/** Успешно выбрана команда (онлайн) */
let myTeamId = null;
/** Пока сервер восстанавливает команду из localStorage (tryRestoreSession), не слать соло/создать — иначе «already». */
let sessionRestorePending = false;
let sessionRestoreTimer = null;

function beginSessionRestore() {
  sessionRestorePending = true;
  if (sessionRestoreTimer) clearTimeout(sessionRestoreTimer);
  sessionRestoreTimer = setTimeout(() => {
    sessionRestorePending = false;
    sessionRestoreTimer = null;
  }, 5000);
}

function endSessionRestore() {
  sessionRestorePending = false;
  if (sessionRestoreTimer) {
    clearTimeout(sessionRestoreTimer);
    sessionRestoreTimer = null;
  }
}
/** Мета с сервера */
let teamsMeta = null;
let teamCounts = {};
let maxPerTeam = 200;
/** Сервер: false — только просмотр, без пикселей и команд */
let spectatorMode = false;
/** Время окончания текущего раунда (мс, Date.now()); null — ожидание старта 1-го раунда по «go» */
let roundEndsAtMs = null;
let roundIndexMeta = 0;
/** С сервера: игра полностью завершена (финал) */
let gameFinishedMeta = false;
/** После leaveTeam открыть список команд (кнопка «Вступить», уже не в команде) */
let pendingLeaveToTeamList = false;
/** После leaveTeam открыть форму «Новая команда» (кнопка «Создать», пока ещё в команде) */
let pendingLeaveToCreate = false;

/** Экономика с сервера */
let walletState = null;
let lastStatsGlobalEvent = null;
let lastMyTeamPercent = null;
let crisisCooldownUntil = 0;
/** Ожидание тапа по карте: зона 4×4 или 6×6 */
let pendingMapAction = null;
/** Бонус квантов к депозиту (см. пакеты на сервере) */
let depositBonusQuant = 0;

const QUANT_PER_USDT = 7;

/** Склонение «квант» для числа n (1 квант, 2 кванта, 5 квантов). */
function quantWord(n) {
  const x = Math.abs(Math.round(n)) % 100;
  const v = x % 10;
  if (x > 10 && x < 20) return "квантов";
  if (v === 1) return "квант";
  if (v >= 2 && v <= 4) return "кванта";
  return "квантов";
}

function usdtToQuant(usdt) {
  return Math.round(Number(usdt) * QUANT_PER_USDT);
}

function formatApproxUsdt(usdt) {
  if (!Number.isFinite(usdt) || usdt <= 0) return "~0 USDT";
  const s = usdt >= 10 ? String(Math.round(usdt)) : String(Math.round(usdt * 10) / 10).replace(/\.0$/, "");
  return `~${s} USDT`;
}

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
  const w = gridW;
  const h = gridH;
  try {
    const r = await fetch(`/data/regions-${w}.json`);
    if (!r.ok) throw new Error("no regions");
    const j = await r.json();
    regionCells = b64ToUint8(j.cellsBase64);
    if (regionCells.length !== w * h) regionCells = null;
    regionRgb = null;
    if (j.rgbBase64 && typeof j.rgbBase64 === "string") {
      const raw = b64ToUint8(j.rgbBase64);
      if (raw.length === w * h * 3) regionRgb = raw;
    }
  } catch {
    regionCells = null;
    regionRgb = null;
  }
}

/** Смена размера сетки с сервера (новый раунд / мета). */
async function applyGridFromServer(w, h) {
  const nw = Math.max(1, w | 0);
  const nh = Math.max(1, h | 0);
  if (nw === gridW && nh === gridH && regionCells !== null) return;
  gridW = nw;
  gridH = nh;
  offsetX = 0;
  offsetY = 0;
  scale = 1;
  await loadRegions();
  resizeCanvas();
}

function syncWelcomeForRound() {
  /* Раньше скрывали соло в финале — соло отключён. */
}

function countryColor(regionId) {
  if (regionId === 0) return "#0a1a32"; /* небо / фон плаката */
  if (regionId === 1) return `hsl(38 32% 30%)`;
  const h = ((regionId - 2) * 53) % 360;
  return `hsl(${h} 36% 30%)`;
}

function teamColor(teamId) {
  const t = teamsMeta?.find((x) => x.id === teamId);
  return t ? t.color : "#888888";
}

function hexToRgb(hex) {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || "");
  return m
    ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) }
    : { r: 136, g: 136, b: 136 };
}

function getVfxTransform() {
  return { offsetX, offsetY, scale, gridW, gridH, BASE_CELL };
}

function paletteIndexForHex(hex) {
  const i = PALETTE.indexOf(hex);
  return i >= 0 ? i : 5;
}

function setConnState(state, text) {
  if (!connStatus) return;
  connStatus.dataset.state = state;
  connStatus.textContent = text;
  connStatus.title = text;
  /* «Онлайн» дублирует счётчик в панели слева — не показываем в шапке. */
  connStatus.hidden = state === "online";
}

function migrateLegacySessionStorage() {
  try {
    const oldTeam = sessionStorage.getItem(SESSION_TEAM);
    if (oldTeam != null && oldTeam !== "" && !localStorage.getItem(ONLINE_SESSION_KEY)) {
      const n = Number(oldTeam);
      if (Number.isFinite(n)) {
        saveOnlineSessionRaw({ teamId: n });
        sessionStorage.removeItem(SESSION_TEAM);
      }
    }
    const oldEdit = sessionStorage.getItem(SESSION_TEAM_EDIT);
    if (oldEdit && !localStorage.getItem(SESSION_TEAM_EDIT)) {
      localStorage.setItem(SESSION_TEAM_EDIT, oldEdit);
      sessionStorage.removeItem(SESSION_TEAM_EDIT);
    }
  } catch {
    /* ignore */
  }
}

function loadOnlineSession() {
  try {
    const raw = localStorage.getItem(ONLINE_SESSION_KEY);
    if (!raw) return null;
    const o = JSON.parse(raw);
    if (o && typeof o.teamId === "number") return o;
  } catch {
    /* ignore */
  }
  return null;
}

function saveOnlineSessionRaw(obj) {
  try {
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(obj));
  } catch {
    /* ignore */
  }
}

/** @param {Record<string, unknown>} patch */
function saveOnlineSession(patch) {
  try {
    const cur = loadOnlineSession() || {};
    const next = { ...cur, ...patch };
    if (patch.solo === false) {
      delete next.soloResumeToken;
      next.solo = false;
    }
    localStorage.setItem(ONLINE_SESSION_KEY, JSON.stringify(next));
  } catch {
    /* ignore */
  }
}

/** Сбросить команду, оставить имя и цвет для экрана входа (после выхода или ошибки вступления). */
function clearTeamIdentityFromSession() {
  try {
    const s = loadOnlineSession();
    if (!s) return;
    saveOnlineSessionRaw({
      playerName: s.playerName,
      welcomeColorIdx: s.welcomeColorIdx,
    });
  } catch {
    /* ignore */
  }
}

/** Убрать сохранённую соло-сессию (режим отключён на сервере). */
function clearSoloFromSession() {
  try {
    const s = loadOnlineSession();
    if (!s || !s.solo) return;
    saveOnlineSessionRaw({
      playerName: s.playerName,
      welcomeColorIdx: s.welcomeColorIdx,
    });
  } catch {
    /* ignore */
  }
}

/** Короткая подпись названия команды для компактного UI (лидерборд, бейдж). */
function truncateTeamDisplayName(raw, maxLen = TEAM_NAME_DISPLAY_MAX) {
  if (raw == null || raw === "") return "";
  const s = String(raw);
  const chars = [...s];
  if (chars.length <= maxLen) return s;
  return chars.slice(0, maxLen).join("");
}

function setCompactTeamName(el, fullName) {
  if (!el) return;
  const t = truncateTeamDisplayName(fullName);
  el.textContent = t;
  if (fullName != null && String(fullName).length > TEAM_NAME_DISPLAY_MAX) {
    el.title = String(fullName);
  } else {
    el.removeAttribute("title");
  }
}

let lastClaimEligibilityAt = 0;

function tryClaimEligibility() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (!wantOnline) return;
  const tok = localStorage.getItem(ROUND_ELIGIBLE_KEY) || "";
  const pk = getOrCreatePlayerKey();
  const now = Date.now();
  if (!tok && lastClaimEligibilityAt > 0 && now - lastClaimEligibilityAt < 2500) return;
  lastClaimEligibilityAt = now;
  ws.send(
    JSON.stringify({
      type: "claimEligibility",
      token: tok,
      playerKey: pk,
      telegramUser: getTelegramUserForServer(),
      initData: getTelegramInitDataForServer(),
    })
  );
}

function updateRoundTimer() {
  if (!roundTimerEl) return;
  try {
    const online = wantOnline && getWsUrl();
    if (!online) {
      roundTimerEl.hidden = true;
      return;
    }
    if (gameFinishedMeta) {
      roundTimerEl.hidden = true;
      return;
    }
    if (roundEndsAtMs == null && roundIndexMeta === 0) {
      roundTimerEl.hidden = false;
      roundTimerEl.textContent = "Ожидание старта\n«go» в боте";
      return;
    }
    if (roundEndsAtMs == null) {
      roundTimerEl.hidden = true;
      return;
    }
    roundTimerEl.hidden = false;
    const ms = roundEndsAtMs - Date.now();
    if (ms <= 0) {
      roundTimerEl.textContent = "Конец раунда…";
      return;
    }
    const s = Math.floor(ms / 1000);
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    roundTimerEl.textContent = h > 0 ? `${h}ч ${m}м` : m > 0 ? `${m}м ${sec}с` : `${sec}с`;
  } finally {
    syncEventBanner();
    syncTeamBuffBanner();
    syncToolbarHeightCssVar();
  }
}

function cacheTeamDisplayInSession() {
  if (myTeamId == null) return;
  const t = teamsMeta?.find((x) => x.id === myTeamId);
  if (!t) return;
  saveOnlineSession({
    cachedTeamName: t.name,
    cachedEmoji: t.emoji,
  });
}

function getTeamEditToken(teamId) {
  try {
    const raw = localStorage.getItem(SESSION_TEAM_EDIT) || sessionStorage.getItem(SESSION_TEAM_EDIT);
    if (!raw) return null;
    const o = JSON.parse(raw);
    const t = o[String(teamId)];
    return typeof t === "string" && t.length > 0 ? t : null;
  } catch {
    return null;
  }
}

function setTeamEditToken(teamId, token) {
  try {
    const raw = localStorage.getItem(SESSION_TEAM_EDIT) || sessionStorage.getItem(SESSION_TEAM_EDIT);
    const o = raw ? JSON.parse(raw) : {};
    o[String(teamId)] = token;
    localStorage.setItem(SESSION_TEAM_EDIT, JSON.stringify(o));
  } catch {
    /* ignore */
  }
}

function isCurrentTeamSolo() {
  if (myTeamId == null) return false;
  if (teamsMeta) return !!teamsMeta.find((x) => x.id === myTeamId)?.solo;
  return !!loadOnlineSession()?.solo;
}

/** Публичная команда: только создатель с токеном. Соло настраивается только при входе. */
function canEditTeamSettings() {
  if (myTeamId == null) return false;
  if (isCurrentTeamSolo()) return false;
  return !!getTeamEditToken(myTeamId);
}

/** Онлайн: цвет кисти выбирают только соло или создатель команды; остальные рисуют цветом команды. */
function canPickOnlineDrawColor() {
  if (myTeamId == null) return false;
  return isCurrentTeamSolo() || canEditTeamSettings();
}

/** Подсветить нижнюю палитру по текущему цвету команды в мета. */
function syncPaletteSelectionFromTeam() {
  if (!myTeamId || !teamsMeta || !paletteEl?.querySelector(".palette__swatch")) return;
  const t = teamsMeta.find((x) => x.id === myTeamId);
  if (!t?.color) return;
  const idx = paletteIndexForHex(t.color);
  selectedColor = idx;
  paletteEl.querySelectorAll(".palette__swatch").forEach((el) => {
    el.setAttribute("aria-selected", el.dataset.index === String(idx) ? "true" : "false");
  });
  updatePaletteTriggerPreview();
}

function sendOnlineColorChoice(hex) {
  if (spectatorMode) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (isCurrentTeamSolo()) {
    const sess = loadOnlineSession();
    const tok = sess?.soloResumeToken;
    if (!tok) return;
    ws.send(JSON.stringify({ type: "soloSetColor", color: hex, resumeToken: tok }));
    return;
  }
  if (canEditTeamSettings()) {
    const tok = getTeamEditToken(myTeamId);
    if (!tok) return;
    ws.send(JSON.stringify({ type: "setTeamColor", color: hex, editToken: tok }));
  }
}

function setFooterMode() {
  const online = wantOnline;
  const joined = myTeamId != null;
  const localMode = !online;
  const showPalette =
    localMode || (online && joined && canPickOnlineDrawColor() && !spectatorMode);
  if (paletteTriggerBtn) paletteTriggerBtn.hidden = !showPalette;
  /* Локально без команды: показываем только компактный квадрат цвета (не прячем весь блок из‑за hidden team-badge). */
  const showTeamPaletteOnly = localMode && showPalette;
  if (teamBadge) {
    teamBadge.classList.toggle("team-badge--palette-only", showTeamPaletteOnly);
    teamBadge.hidden = showTeamPaletteOnly ? false : !online || !joined;
  }
  if (spectatorBadgeEl) {
    spectatorBadgeEl.hidden = !online || !spectatorMode;
  }
  if (online && joined) updateTeamBadge();
  if (showPalette && online && joined) syncPaletteSelectionFromTeam();
  refreshToolbarSessionButton();
  updateWalletBar();
  renderQuickBuyRail();
}

/** Подпись кнопки в шапке: не глобальная очистка карты, а сессия / локальный сброс. */
function refreshToolbarSessionButton() {
  if (!btnToolbarSession) return;
  const online = wantOnline && getWsUrl();
  if (online && spectatorMode) {
    btnToolbarSession.hidden = true;
    return;
  }
  btnToolbarSession.hidden = false;
  if (online) {
    if (myTeamId != null) {
      btnToolbarSession.textContent = "Сменить команду";
      btnToolbarSession.title = isCurrentTeamSolo()
        ? "Выбор другой команды или создание новой. Можно закрыть окно (×) — останетесь в соло."
        : "Выбор другой команды или создание новой. Можно закрыть окно (×) — останетесь в текущей команде.";
    } else {
      btnToolbarSession.textContent = "Войти";
      btnToolbarSession.title = "Создать команду или вступить в существующую (окно можно закрыть без действия)";
    }
  } else {
    btnToolbarSession.textContent = "Очистить локально";
    btnToolbarSession.title =
      "Стереть только вашу локальную картинку на этом устройстве (на общую карту не влияет)";
  }
}

function updateTeamBadge() {
  if (!myTeamId) return;
  const t = teamsMeta?.find((x) => x.id === myTeamId);
  const s = loadOnlineSession();
  if (t) {
    if (teamBadgeEmoji) teamBadgeEmoji.textContent = t.emoji || "";
    setCompactTeamName(teamBadgeName, t.name);
    teamBadgeName.style.removeProperty("color");
    const cnt = teamCounts[t.id] ?? 0;
    teamBadgeCount.textContent = `${cnt} / ${maxPerTeam}`;
    return;
  }
  if (s && s.teamId === myTeamId && s.cachedTeamName) {
    if (teamBadgeEmoji) teamBadgeEmoji.textContent = s.cachedEmoji || "";
    setCompactTeamName(teamBadgeName, s.cachedTeamName);
    const cnt = teamCounts[myTeamId] ?? 0;
    teamBadgeCount.textContent = `${cnt} / ${maxPerTeam}`;
  }
}

function formatPercent(pct) {
  const n = typeof pct === "number" ? pct : 0;
  if (n >= 10) return n.toFixed(1);
  if (n >= 1) return n.toFixed(1);
  return n.toFixed(2);
}

function renderLeaderboard(msg) {
  if (!onlineCountEl || !leaderboardListEl) return;
  if (msg.globalEvent) lastStatsGlobalEvent = msg.globalEvent;
  onlineCountEl.textContent = String(msg.online ?? 0);
  leaderboardListEl.replaceChildren();
  for (const row of msg.rows || []) {
    const li = document.createElement("li");
    li.className = "leaderboard__row";
    if (myTeamId != null && row.teamId === myTeamId) li.classList.add("leaderboard__row--mine");
    li.style.borderLeftColor = row.color || "#888";
    const top = document.createElement("div");
    top.className = "leaderboard__topline";
    const rank = document.createElement("span");
    rank.className = "leaderboard__rank";
    rank.textContent = `#${row.rank}`;
    const em = document.createElement("span");
    em.className = "leaderboard__emoji";
    em.textContent = row.emoji || "";
    top.append(rank, em);
    const name = document.createElement("div");
    name.className = "leaderboard__name";
    setCompactTeamName(name, row.name || "");
    const meta = document.createElement("div");
    meta.className = "leaderboard__meta";
    const pct = typeof row.percent === "number" ? row.percent : 0;
    const players = typeof row.players === "number" ? row.players : 0;
    meta.textContent = `${formatPercent(pct)}% территории · ${players} чел.`;
    li.append(top, name, meta);
    leaderboardListEl.appendChild(li);
  }
  if (myTeamId != null && !spectatorMode && !gameFinishedMeta) {
    const mine = (msg.rows || []).find((r) => r.teamId === myTeamId);
    const pct = mine && typeof mine.percent === "number" ? mine.percent : 0;
    if (lastMyTeamPercent != null && pct < lastMyTeamPercent - 1.5 && Date.now() > crisisCooldownUntil) {
      crisisCooldownUntil = Date.now() + 120000;
      showCrisisOverlay();
    }
    lastMyTeamPercent = pct;
  }
}

function applyTeamDisplay(teamId, name, emoji, color) {
  if (!teamsMeta) return;
  const t = teamsMeta.find((x) => x.id === teamId);
  if (!t) return;
  t.name = name;
  t.emoji = emoji;
  if (color && typeof color === "string") t.color = color;
  invalidateTeamColorByIdCache();
  scheduleDraw();
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
    if (t.solo) continue;
    const cnt = teamCounts[t.id] ?? 0;
    const full = cnt >= maxPerTeam;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-list__btn";
    btn.disabled = full;
    btn.setAttribute("role", "option");
    const em = document.createElement("span");
    em.className = "team-list__emoji";
    em.textContent = t.emoji || "●";
    const name = document.createElement("span");
    setCompactTeamName(name, t.name);
    const left = document.createElement("span");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.appendChild(em);
    left.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "team-list__meta";
    meta.textContent = `${cnt} / ${maxPerTeam}`;
    btn.appendChild(left);
    btn.appendChild(meta);
    btn.addEventListener("click", () => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      if (sessionRestorePending) {
        const tg = window.Telegram?.WebApp;
        const t = "Подождите секунду — восстанавливается вход в команду.";
        if (typeof tg?.showAlert === "function") tg.showAlert(t);
        else alert(t);
        return;
      }
      ws.send(
        JSON.stringify({ type: "joinTeam", teamId: t.id, playerKey: getOrCreatePlayerKey() })
      );
    });
    teamListEl.appendChild(btn);
  }
}

function tryRestoreSession() {
  const sess = loadOnlineSession();
  if (!sess || !ws || ws.readyState !== WebSocket.OPEN) return;
  if (sess.solo) {
    clearSoloFromSession();
    return;
  }
  ws.send(JSON.stringify({ type: "joinTeam", teamId: sess.teamId, playerKey: getOrCreatePlayerKey() }));
}

/**
 * Сервер отвечает «already» (сокет всё ещё в команде), а клиент рассинхрон — принудительный leaveTeam.
 * @returns {boolean} true если отправили leaveTeam
 */
function sendLeaveTeamToRecoverFromStaleServer() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  try {
    ws.send(JSON.stringify({ type: "leaveTeam", playerKey: getOrCreatePlayerKey() }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Реферал: ?team= / ?ref=; опционально ?refu= (Telegram id пригласившего).
 * В Telegram: startapp=team_5 или team_5_r_123456 (id пригласившего).
 */
function parseStartParamRef() {
  const q = new URLSearchParams(location.search);
  const raw = q.get("team") ?? q.get("ref");
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n === Math.floor(n)) {
      const refu = q.get("refu");
      const inviteTg = refu != null && refu !== "" ? Number(refu) : null;
      return {
        teamId: n,
        inviteTelegramId: Number.isFinite(inviteTg) ? inviteTg : null,
      };
    }
  }
  const tg = window.Telegram?.WebApp;
  const sp = tg?.initDataUnsafe?.start_param;
  if (sp && typeof sp === "string") {
    const s = sp.trim();
    const m = /^team_?(\d+)(?:_r_(\d+))?$/i.exec(s) ?? /^t(\d+)$/i.exec(s);
    if (m) {
      const teamId = Number(m[1]);
      const inviteTg = m[2] != null ? Number(m[2]) : null;
      return {
        teamId,
        inviteTelegramId: inviteTg != null && Number.isFinite(inviteTg) ? inviteTg : null,
      };
    }
  }
  return { teamId: null, inviteTelegramId: null };
}

function getReferralTeamId() {
  return parseStartParamRef().teamId;
}

function stripTeamFromUrl() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("team") && !u.searchParams.has("ref") && !u.searchParams.has("refu")) return;
    u.searchParams.delete("team");
    u.searchParams.delete("ref");
    u.searchParams.delete("refu");
    const qs = u.searchParams.toString();
    history.replaceState({}, "", u.pathname + (qs ? `?${qs}` : "") + u.hash);
  } catch {
    /* ignore */
  }
}

function buildWebReferralUrl() {
  if (myTeamId == null) return "";
  const nu = new URL(location.href);
  nu.searchParams.set("team", String(myTeamId));
  nu.searchParams.delete("ref");
  const tgUser = getTelegramUserForServer();
  if (tgUser && tgUser.id != null) nu.searchParams.set("refu", String(tgUser.id));
  else nu.searchParams.delete("refu");
  return nu.toString();
}

function buildTelegramReferralUrl() {
  const bot = document.querySelector('meta[name="pixel-battle-tg-bot"]')?.getAttribute("content")?.trim();
  const app = document.querySelector('meta[name="pixel-battle-tg-app"]')?.getAttribute("content")?.trim();
  if (!bot || !app || myTeamId == null) return null;
  const cleanBot = bot.replace(/^@/, "");
  const cleanApp = app.replace(/^\//, "");
  const u = getTelegramUserForServer();
  const refSuffix = u && u.id != null ? `_r_${u.id}` : "";
  return `https://t.me/${cleanBot}/${cleanApp}?startapp=team_${myTeamId}${refSuffix}`;
}

function getReferralLinkText() {
  if (myTeamId == null) return "";
  const web = buildWebReferralUrl();
  const tgUrl = buildTelegramReferralUrl();
  return tgUrl ? `${web}\n${tgUrl}` : web;
}

async function copyReferralLink() {
  if (myTeamId == null) return;
  const text = getReferralLinkText();
  const tg = window.Telegram?.WebApp;
  try {
    await navigator.clipboard.writeText(text);
    if (typeof tg?.showAlert === "function") tg.showAlert("Ссылка скопирована в буфер.");
    else if (typeof tg?.HapticFeedback?.notificationOccurred === "function") {
      tg.HapticFeedback.notificationOccurred("success");
    }
  } catch {
    if (typeof tg?.showAlert === "function") {
      tg.showAlert(text.slice(0, 350) + (text.length > 350 ? "…" : ""));
    } else {
      window.prompt("Скопируйте ссылку:", text);
    }
  }
}

function setupReferralButton() {
  const b = document.getElementById("btn-referral");
  if (!b) return;
  b.addEventListener("click", () => {
    copyReferralLink();
  });
}

function showReferralSplash() {
  if (referralSplashText) referralSplashText.value = getReferralLinkText();
  if (referralSplashOverlay) referralSplashOverlay.hidden = false;
}

function hideReferralSplash() {
  if (referralSplashOverlay) referralSplashOverlay.hidden = true;
}

function showCrisisOverlay() {
  if (crisisOverlayEl) crisisOverlayEl.hidden = false;
}

function hideCrisisOverlay() {
  if (crisisOverlayEl) crisisOverlayEl.hidden = true;
}

function syncCreateEmojiPresetHighlight() {
  if (!createTeamEmojiPresets || !createTeamEmojiInput) return;
  const cur = createTeamEmojiInput.value.trim();
  createTeamEmojiPresets.querySelectorAll(".emoji-presets__btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.textContent === cur ? "true" : "false");
  });
}

function buildCreateTeamEmojiPresets() {
  if (!createTeamEmojiPresets) return;
  createTeamEmojiPresets.innerHTML = "";
  for (const e of EMOJI_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-presets__btn";
    b.textContent = e;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      if (createTeamEmojiInput) createTeamEmojiInput.value = e;
      syncCreateEmojiPresetHighlight();
    });
    createTeamEmojiPresets.appendChild(b);
  }
  createTeamEmojiInput?.addEventListener("input", syncCreateEmojiPresetHighlight);
}

function buildSwatchPalette(container, selectedIdx, onPick) {
  if (!container) return;
  container.innerHTML = "";
  PALETTE.forEach((hex, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette__swatch";
    b.style.backgroundColor = hex;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === selectedIdx ? "true" : "false");
    b.dataset.index = String(i);
    b.title = hex;
    b.addEventListener("click", () => {
      onPick(i);
      container.querySelectorAll(".palette__swatch").forEach((el) => {
        el.setAttribute("aria-selected", el.dataset.index === String(i) ? "true" : "false");
      });
    });
    container.appendChild(b);
  });
}

function buildCreateTeamPalette() {
  buildSwatchPalette(createTeamColorPaletteEl, createTeamColorIdx, (i) => {
    createTeamColorIdx = i;
  });
}

function buildTeamSettingsColorPalette() {
  buildSwatchPalette(teamSettingsColorPaletteEl, teamSettingsColorIdx, (i) => {
    teamSettingsColorIdx = i;
  });
}

function openCreateTeamOverlay(fromWelcome) {
  createTeamFromWelcome = !!fromWelcome;
  if (createTeamNameInput) createTeamNameInput.value = "";
  if (createTeamEmojiInput) createTeamEmojiInput.value = EMOJI_PRESETS[0] || "🔥";
  syncCreateEmojiPresetHighlight();
  createTeamColorIdx = fromWelcome ? welcomeColorIdx : 5;
  buildCreateTeamPalette();
  if (createTeamOverlay) createTeamOverlay.hidden = false;
}

function closeCreateTeamOverlay() {
  if (createTeamOverlay) createTeamOverlay.hidden = true;
}

function submitCreateTeam() {
  if (sessionRestorePending) {
    const tg = window.Telegram?.WebApp;
    const m = "Подождите секунду — восстанавливается сессия.";
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    else alert(m);
    return;
  }
  const name = createTeamNameInput?.value.trim() ?? "";
  const emoji = createTeamEmojiInput?.value.trim() ?? "";
  const color = PALETTE[createTeamColorIdx];
  if (!name || !emoji || !color) {
    const tg = window.Telegram?.WebApp;
    const msg = "Укажите название, смайлик и цвет команды.";
    if (typeof tg?.showAlert === "function") tg.showAlert(msg);
    else alert(msg);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({ type: "createTeam", name, emoji, color, playerKey: getOrCreatePlayerKey() })
  );
}

function showWelcomeOverlay() {
  if (welcomeOverlay) welcomeOverlay.hidden = false;
}

function setupWelcomeUi() {
  btnWelcomeClose?.addEventListener("click", () => {
    if (welcomeOverlay) welcomeOverlay.hidden = true;
  });
  welcomeOverlay?.addEventListener("click", (e) => {
    if (e.target === welcomeOverlay) welcomeOverlay.hidden = true;
  });
  btnWelcomeCreate?.addEventListener("click", () => {
    if (myTeamId != null) {
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = true;
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      sendLeaveTeamRequest();
      return;
    }
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    openCreateTeamOverlay(true);
  });
  btnWelcomeJoin?.addEventListener("click", () => {
    if (myTeamId != null) {
      pendingLeaveToTeamList = true;
      pendingLeaveToCreate = false;
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      sendLeaveTeamRequest();
      return;
    }
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    if (teamOverlay) teamOverlay.hidden = false;
  });
  btnTeamOverlayBack?.addEventListener("click", () => {
    if (teamOverlay) teamOverlay.hidden = true;
    showWelcomeOverlay();
  });
  welcomeDiscussionLink?.addEventListener("click", openDiscussionChatLink);
  toolbarDiscussionLink?.addEventListener("click", openDiscussionChatLink);
}

function setupCreateTeamUi() {
  buildCreateTeamEmojiPresets();
  btnOpenCreateTeam?.addEventListener("click", () => openCreateTeamOverlay(false));
  btnCreateTeamCancel?.addEventListener("click", () => {
    closeCreateTeamOverlay();
    if (createTeamFromWelcome) {
      showWelcomeOverlay();
    } else if (teamOverlay) {
      teamOverlay.hidden = false;
    }
  });
  btnCreateTeamSubmit?.addEventListener("click", submitCreateTeam);
  createTeamOverlay?.addEventListener("click", (e) => {
    if (e.target === createTeamOverlay) closeCreateTeamOverlay();
  });
  btnReferralSplashCopy?.addEventListener("click", () => {
    copyReferralLink();
  });
  btnReferralSplashOk?.addEventListener("click", hideReferralSplash);
  referralSplashOverlay?.addEventListener("click", (e) => {
    if (e.target === referralSplashOverlay) hideReferralSplash();
  });
  document.getElementById("crisis-cta-boost")?.addEventListener("click", () => {
    hideCrisisOverlay();
    const root = document.getElementById("shop-overlay");
    if (root) {
      root.querySelectorAll(".game-shop__tab").forEach((t) => {
        const on = t.dataset.tab === "recovery";
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      root.querySelectorAll(".game-shop__panel").forEach((p) => {
        p.hidden = p.dataset.panel !== "recovery";
      });
    }
    if (shopOverlay) shopOverlay.hidden = false;
    resetShopPurchaseButtonsUi();
    syncShopHeaderBalance();
    updateShopAvailability();
  });
  document.getElementById("crisis-cta-team-recovery")?.addEventListener("click", () => {
    hideCrisisOverlay();
    const root = document.getElementById("shop-overlay");
    if (root) {
      root.querySelectorAll(".game-shop__tab").forEach((t) => {
        const on = t.dataset.tab === "team";
        t.classList.toggle("is-active", on);
        t.setAttribute("aria-selected", on ? "true" : "false");
      });
      root.querySelectorAll(".game-shop__panel").forEach((p) => {
        p.hidden = p.dataset.panel !== "team";
      });
    }
    if (shopOverlay) shopOverlay.hidden = false;
    resetShopPurchaseButtonsUi();
    syncShopHeaderBalance();
    updateShopAvailability();
  });
  document.getElementById("crisis-cta-raid")?.addEventListener("click", () => {
    hideCrisisOverlay();
    pendingMapAction = { type: "massCapture" };
    setPendingHint();
  });
  document.getElementById("crisis-dismiss")?.addEventListener("click", hideCrisisOverlay);
  crisisOverlayEl?.addEventListener("click", (e) => {
    if (e.target === crisisOverlayEl) hideCrisisOverlay();
  });
}

function syncEmojiPresetHighlight() {
  if (!teamSettingsEmojiPresets || !teamSettingsEmojiInput) return;
  const cur = teamSettingsEmojiInput.value.trim();
  teamSettingsEmojiPresets.querySelectorAll(".emoji-presets__btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", btn.textContent === cur ? "true" : "false");
  });
}

function buildEmojiPresets() {
  if (!teamSettingsEmojiPresets) return;
  teamSettingsEmojiPresets.innerHTML = "";
  for (const e of EMOJI_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-presets__btn";
    b.textContent = e;
    b.setAttribute("aria-pressed", "false");
    b.addEventListener("click", () => {
      teamSettingsEmojiInput.value = e;
      syncEmojiPresetHighlight();
    });
    teamSettingsEmojiPresets.appendChild(b);
  }
  teamSettingsEmojiInput?.addEventListener("input", syncEmojiPresetHighlight);
}

function openTeamSettings() {
  if (!myTeamId || !teamsMeta || !teamSettingsOverlay) return;
  if (!canEditTeamSettings()) return;
  const t = teamsMeta.find((x) => x.id === myTeamId);
  if (!t) return;
  if (teamSettingsName) teamSettingsName.value = t.name || "";
  if (teamSettingsEmojiInput) teamSettingsEmojiInput.value = t.emoji || "";
  syncEmojiPresetHighlight();
  teamSettingsColorIdx = paletteIndexForHex(t.color);
  buildTeamSettingsColorPalette();
  teamSettingsOverlay.hidden = false;
}

function closeTeamSettings() {
  teamSettingsOverlay.hidden = true;
}

function saveTeamSettings() {
  if (!teamSettingsName || !teamSettingsEmojiInput) return;
  const name = teamSettingsName.value.trim();
  const emoji = teamSettingsEmojiInput.value.trim();
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const tok = getTeamEditToken(myTeamId);
  if (!tok) return;
  const color = PALETTE[teamSettingsColorIdx];
  ws.send(JSON.stringify({ type: "updateTeam", name, emoji, editToken: tok, color }));
  closeTeamSettings();
}

function setupTeamSettingsUi() {
  buildEmojiPresets();
  btnTeamSettingsCancel?.addEventListener("click", closeTeamSettings);
  btnTeamSettingsSave?.addEventListener("click", saveTeamSettings);
  teamSettingsOverlay?.addEventListener("click", (e) => {
    if (e.target === teamSettingsOverlay) closeTeamSettings();
  });
}

/** Запрос выхода из команды по WebSocket (какой экран показать после «left» — флаги pending*). */
function sendLeaveTeamRequest() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(JSON.stringify({ type: "leaveTeam", playerKey: getOrCreatePlayerKey() }));
}

/** Ссылка на чат обсуждения из `meta.discussionChatUrl` (сервер: TELEGRAM_DISCUSSION_CHAT_URL). */
let discussionChatUrl = "";

function openDiscussionChatLink(ev) {
  if (ev) ev.preventDefault();
  const url = discussionChatUrl;
  if (!url) return;
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.openLink === "function") tg.openLink(url, { try_instant_view: false });
  else window.open(url, "_blank", "noopener,noreferrer");
}

function syncDiscussionChatLinks() {
  const url = discussionChatUrl;
  const show = Boolean(url);
  if (welcomeDiscussionWrap) welcomeDiscussionWrap.hidden = !show;
  if (toolbarDiscussionLink) toolbarDiscussionLink.hidden = !show;
  if (welcomeDiscussionLink) welcomeDiscussionLink.href = url || "#";
  if (toolbarDiscussionLink) toolbarDiscussionLink.href = url || "#";
}

function onMeta(msg) {
  discussionChatUrl =
    typeof msg.discussionChatUrl === "string" && msg.discussionChatUrl.trim()
      ? msg.discussionChatUrl.trim()
      : "";
  syncDiscussionChatLinks();

  teamsMeta = msg.teams || [];
  invalidateTeamColorByIdCache();
  teamCounts = msg.teamCounts || {};
  maxPerTeam = msg.maxPerTeam ?? 200;
  gameFinishedMeta = !!msg.gameFinished;
  roundEndsAtMs =
    typeof msg.roundEndsAt === "number" && !Number.isNaN(msg.roundEndsAt) ? msg.roundEndsAt : null;
  roundIndexMeta = typeof msg.roundIndex === "number" ? msg.roundIndex : 0;
  spectatorMode = msg.eligible === false || msg.gameFinished === true;

  if (msg.eligible === false && !msg.gameFinished) {
    tryClaimEligibility();
  }

  const gw = typeof msg.grid?.w === "number" ? msg.grid.w : gridW;
  const gh = typeof msg.grid?.h === "number" ? msg.grid.h : gridH;

  applyGridFromServer(gw, gh).then(() => {
    rebuildTeamList();
    updateRoundTimer();
    syncWelcomeForRound();

    if (spectatorMode) {
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = true;
      createTeamOverlay.hidden = true;
      teamSettingsOverlay.hidden = true;
      hideReferralSplash();
      setFooterMode();
      return;
    }

    const ref = getReferralTeamId();
    const validRef = ref != null && teamsMeta.some((t) => t.id === ref && !t.solo);

    if (validRef) {
      saveOnlineSession({ teamId: ref, solo: false });
      beginSessionRestore();
      tryRestoreSession();
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = true;
      setFooterMode();
      return;
    }

    const sess = loadOnlineSession();
    if (sess?.solo) {
      clearSoloFromSession();
      myTeamId = null;
      endSessionRestore();
      showWelcomeOverlay();
      teamOverlay.hidden = true;
    } else if (sess?.teamId != null) {
      beginSessionRestore();
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      tryRestoreSession();
    } else {
      endSessionRestore();
      showWelcomeOverlay();
      teamOverlay.hidden = true;
    }
    setFooterMode();
  });
}

/** Сообщение для наблюдателей и не прошедших отбор в раунд (сервер: playRejected spectator / not_eligible). */
const MSG_WATCH_ONLY = "Остались сильнейшие, просто наблюдайте.";

function notifyReject(reason) {
  const map = {
    out_of_bounds: "Сюда нельзя (вне карты).",
    cooldown: "Слишком часто.",
    "cooldown not ready": "Интервал между действиями: подождите до следующего хода.",
    "pixel is shielded": "Пиксель под щитом.",
    no_team: "Сначала выберите команду.",
    spectator: MSG_WATCH_ONLY,
    not_eligible: MSG_WATCH_ONLY,
    need_telegram: "Откройте игру из Telegram Mini App (нужна подпись initData).",
    rate_limited: "Слишком много действий подряд. Подождите секунду.",
    same_cell: "Для линии выберите другую клетку — так задаётся направление.",
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

function notifyPurchaseError(reason) {
  const m = {
    "not enough balance": "Недостаточно средств на балансе.",
    "not available": "В этой стадии турнира недоступно.",
    "zone capture cooldown": "Зона 4×4: подождите перед повтором (~60 с).",
    "mass capture cooldown": "Масс-захват 6×6: подождите перед повтором (~2 мин).",
    "zone12 capture cooldown": "Зона 12×12: подождите перед повтором (~2 мин).",
    "cooldown not ready": "Сначала дождитесь обычного интервала между действиями.",
    "bad request": "Некорректный запрос.",
    rate_limited: "Слишком частые покупки. Подождите несколько секунд.",
  };
  notifyReject(m[reason] || reason);
}

const ROUND_END_BANNER_MS = 10 * 60 * 1000;

function syncEventBanner() {
  if (!eventBannerEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || gameFinishedMeta) {
    eventBannerEl.hidden = true;
    return;
  }
  if (roundEndsAtMs == null) {
    eventBannerEl.hidden = true;
    return;
  }
  const left = roundEndsAtMs - Date.now();
  if (left <= 0 || left > ROUND_END_BANNER_MS) {
    eventBannerEl.hidden = true;
    return;
  }
  eventBannerEl.hidden = false;
  const m = Math.max(1, Math.ceil(left / 60000));
  eventBannerEl.textContent = `⏱ До конца раунда · ещё ~${m} мин`;
}

function syncClientCooldownFromWalletFields() {
  if (!walletState) return;
  const u = {
    personalRecoveryUntil: walletState.personalRecoveryUntil,
    personalRecoverySec: walletState.personalRecoverySec,
  };
  const te = walletState.teamEffects;
  const teamFx = te
    ? { teamRecoveryUntil: te.teamRecoveryUntil, teamRecoverySec: te.teamRecoverySec }
    : { teamRecoveryUntil: 0, teamRecoverySec: BASE_ACTION_COOLDOWN_SEC };
  const st = walletState.tournamentStage || "MASS_BATTLE";
  walletState.effectiveRecoverySec = getEffectiveRecoverySec(u, teamFx);
  walletState.cooldownMs = getCurrentCooldownMs(u, teamFx, st);
}

/** Интервал между пикселями (мс) — как на сервере; не использовать `cooldownMs || fallback` (ломает 0 и баффы). */
function getWalletActionCooldownMs() {
  if (!walletState) return BASE_ACTION_COOLDOWN_SEC * 1000;
  /* Без пересчёта по текущему времени после окончания personalRecoveryUntil остаётся устаревший effectiveRecoverySec (напр. 1 с). */
  syncClientCooldownFromWalletFields();
  const sec = walletState.effectiveRecoverySec;
  if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) {
    return Math.max(0, Math.round(sec * 1000));
  }
  const cd = Number(walletState.cooldownMs);
  if (Number.isFinite(cd) && cd >= 0) return cd;
  return BASE_ACTION_COOLDOWN_SEC * 1000;
}

/**
 * Последнее действие по пикселю для онлайна: max(сервер, локальный отправленный клик).
 * Пока `wallet.lastActionAt` не пришёл по WS, без этого интервал «0» и клики проходят каждую секунду.
 */
function getOnlineLastPixelActionAt() {
  const w = Number(walletState?.lastActionAt) || 0;
  return Math.max(w, lastPlaceAt);
}

function applyWalletFromServer(msg) {
  walletState = msg;
  syncClientCooldownFromWalletFields();
  updateWalletBar();
  updateShopAvailability();
  syncEventBanner();
  syncTeamBuffBanner();
}

function syncShopHeaderBalance() {
  const el = document.getElementById("shop-display-balance");
  const unitEl = document.getElementById("shop-display-balance-unit");
  const subEl = document.getElementById("shop-display-usdt-sub");
  if (!el) return;
  const online = wantOnline && getWsUrl();
  if (!online || !walletState) {
    el.textContent = "—";
    if (unitEl) unitEl.textContent = "";
    if (subEl) {
      subEl.textContent = "";
      subEl.hidden = true;
    }
    syncDevUnlimitedShopHints();
    return;
  }
  if (walletState.devUnlimited) {
    el.textContent = "∞";
    if (unitEl) unitEl.textContent = "квантов";
    if (subEl) {
      subEl.textContent = "";
      subEl.hidden = true;
    }
    syncDevUnlimitedShopHints();
    return;
  }
  const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
  const t = usdtToQuant(b);
  el.textContent = String(t);
  if (unitEl) unitEl.textContent = quantWord(t);
  if (subEl) {
    subEl.textContent = "";
    subEl.hidden = true;
  }
  syncDevUnlimitedShopHints();
}

function syncShopDepositButton() {
  const b = document.getElementById("shop-open-deposit");
  if (!b) return;
  if (!walletState) {
    b.hidden = true;
    return;
  }
  b.hidden = spectatorMode || !!walletState.devUnlimited;
}

function formatPixelCooldownLeft(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  if (s >= 60) {
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${String(r).padStart(2, "0")}`;
  }
  return `${s} с`;
}

function formatBuffRemainingMs(ms) {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${String(r).padStart(2, "0")}`;
}

function syncTeamBuffBanner() {
  if (!teamBuffBannerEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || gameFinishedMeta || !walletState || myTeamId == null) {
    teamBuffBannerEl.hidden = true;
    return;
  }
  const te = walletState.teamEffects;
  if (!te || (typeof te.teamId === "number" && te.teamId !== myTeamId)) {
    teamBuffBannerEl.hidden = true;
    return;
  }
  const until = typeof te.teamRecoveryUntil === "number" ? te.teamRecoveryUntil : 0;
  const now = Date.now();
  if (until <= now) {
    teamBuffBannerEl.hidden = true;
    return;
  }
  const secRaw = te.teamRecoverySec;
  const sec =
    typeof secRaw === "number" && Number.isFinite(secRaw) && secRaw >= 0 ? secRaw : BASE_ACTION_COOLDOWN_SEC;
  const left = until - now;
  teamBuffBannerEl.hidden = false;
  teamBuffBannerEl.textContent = `👥 Командное усиление · пиксель каждые ${sec} с · ещё ${formatBuffRemainingMs(left)}`;
}

function updateActiveBuffBars() {
  if (!toolbarBuffsEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || !walletState) {
    toolbarBuffsEl.hidden = true;
    if (toolbarBuffPersonalEl) toolbarBuffPersonalEl.hidden = true;
    return;
  }
  const now = Date.now();
  const pu = typeof walletState.personalRecoveryUntil === "number" && walletState.personalRecoveryUntil > now;

  if (pu && toolbarBuffPersonalEl && toolbarBuffPersonalLabelEl && toolbarBuffPersonalFillEl) {
    const left = walletState.personalRecoveryUntil - now;
    const sec = walletState.personalRecoverySec ?? "?";
    const pct = Math.min(
      100,
      Math.max(0, (Math.min(left, RECOVERY_BUFF_DURATION_MS) / RECOVERY_BUFF_DURATION_MS) * 100)
    );
    toolbarBuffPersonalLabelEl.textContent = `⚡ Лично ${sec} с/ход · ещё ${formatBuffRemainingMs(left)}`;
    toolbarBuffPersonalFillEl.style.width = `${pct}%`;
    toolbarBuffPersonalEl.hidden = false;
    toolbarBuffPersonalEl.title = `Суперсила: пиксель каждые ${sec} с. Действует ещё ${formatBuffRemainingMs(left)} (всего 2 мин с покупки).`;
    toolbarBuffsEl.hidden = false;
  } else {
    if (toolbarBuffPersonalEl) toolbarBuffPersonalEl.hidden = true;
    toolbarBuffsEl.hidden = true;
  }
}

function updateToolbarHud() {
  updateToolbarPixelTimer();
  updateActiveBuffBars();
  updateQuickBuyBuffRings();
  syncToolbarHeightCssVar();
}

/** Синхронизирует --toolbar-h с реальной высотой шапки (несколько строк, баффы). */
function syncToolbarHeightCssVar() {
  const tb = document.querySelector(".toolbar");
  if (!tb) return;
  const h = Math.ceil(tb.getBoundingClientRect().height);
  if (h > 0) {
    document.documentElement.style.setProperty("--toolbar-h", `${h}px`);
  }
}

function updateToolbarPixelTimer() {
  const el = toolbarPixelTimerEl;
  if (!el) return;
  el.classList.remove(
    "toolbar__pixel-timer--ready",
    "toolbar__pixel-timer--wait",
    "toolbar__pixel-timer--muted"
  );
  const online = wantOnline && getWsUrl();
  if (!online) {
    if (COOLDOWN_MS > 0) {
      const left = COOLDOWN_MS - (Date.now() - lastPlaceAt);
      if (left > 500) {
        el.textContent = formatPixelCooldownLeft(left);
        el.classList.add("toolbar__pixel-timer--wait");
        el.title = `До следующего пикселя: ~${(left / 1000).toFixed(1)} с`;
      } else {
        el.textContent = "Готово";
        el.classList.add("toolbar__pixel-timer--ready");
        el.title = "Можно ставить пиксель";
      }
    } else {
      el.textContent = "—";
      el.classList.add("toolbar__pixel-timer--muted");
      el.title = "Локальный режим";
    }
    return;
  }
  if (spectatorMode) {
    el.textContent = "Наблюдение";
    el.classList.add("toolbar__pixel-timer--muted");
    el.title = "Пиксели недоступны";
    return;
  }
  if (!walletState) {
    el.textContent = "—";
    el.classList.add("toolbar__pixel-timer--muted");
    el.title = "Загрузка…";
    return;
  }
  if (myTeamId == null) {
    el.textContent = "—";
    el.classList.add("toolbar__pixel-timer--muted");
    el.title = "Вступите в команду";
    return;
  }
  const cd = getWalletActionCooldownMs();
  const la = getOnlineLastPixelActionAt();
  const left = la + cd - Date.now();
  const erSec =
    typeof walletState.effectiveRecoverySec === "number" && Number.isFinite(walletState.effectiveRecoverySec)
      ? walletState.effectiveRecoverySec
      : cd / 1000;
  const intervalHint =
    erSec >= 19.5
      ? `База ${BASE_ACTION_COOLDOWN_SEC} с между кликами (без буста в магазине).`
      : `Сейчас ~${erSec.toFixed(erSec < 1 ? 1 : 0)} с между кликами (буст из магазина).`;
  if (left > 500) {
    el.textContent = formatPixelCooldownLeft(left);
    el.classList.add("toolbar__pixel-timer--wait");
    el.title = `${intervalHint} Осталось ~${(left / 1000).toFixed(1)} с до следующего клика.`;
  } else {
    el.textContent = "Готово";
    el.classList.add("toolbar__pixel-timer--ready");
    el.title = `${intervalHint} Можно кликнуть по карте.`;
  }
}

function updateWalletBar() {
  if (!walletBalanceEl) {
    updateToolbarHud();
    return;
  }
  const online = wantOnline && getWsUrl();
  if (!online) {
    prevWalletQuant = null;
    walletBalanceEl.hidden = true;
    if (btnDeposit) btnDeposit.hidden = true;
    if (btnShop) btnShop.hidden = true;
    syncShopHeaderBalance();
    syncShopDepositButton();
    syncEventBanner();
    syncTeamBuffBanner();
    updateToolbarHud();
    return;
  }
  walletBalanceEl.hidden = false;
  if (!walletState) {
    prevWalletQuant = null;
    walletBalanceEl.textContent = "💰 загрузка…";
    walletBalanceEl.title = "Баланс квантов с сервера";
    if (btnDeposit) btnDeposit.hidden = true;
    if (btnShop) btnShop.hidden = spectatorMode;
    syncShopHeaderBalance();
    syncShopDepositButton();
    syncEventBanner();
    syncTeamBuffBanner();
    updateToolbarHud();
    return;
  }
  if (btnDeposit) btnDeposit.hidden = spectatorMode || !!walletState.devUnlimited;
  if (btnShop) btnShop.hidden = spectatorMode;
  if (walletState.devUnlimited) {
    prevWalletQuant = null;
    walletBalanceEl.textContent = "💰 ∞ квантов (тест)";
    walletBalanceEl.title =
      "Режим теста: бесконечные кванты. Интервал между пикселями — как у всех (таймер слева).";
  } else {
    const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
    const t = usdtToQuant(b);
    if (prevWalletQuant !== null && prevWalletQuant !== t) {
      walletBalanceEl.classList.add("toolbar__wallet--pulse");
      setTimeout(() => walletBalanceEl.classList.remove("toolbar__wallet--pulse"), 700);
    }
    prevWalletQuant = t;
    walletBalanceEl.textContent = `💰 ${t} ${quantWord(t)}`;
    walletBalanceEl.title = "Баланс в квантах. Пауза до следующего обычного пикселя — слева.";
  }
  syncShopHeaderBalance();
  syncShopDepositButton();
  syncEventBanner();
  syncTeamBuffBanner();
  updateToolbarHud();
}

/**
 * Визуальные эффекты покупок для всех зрителей (сервер шлёт broadcast `purchaseVfx` / `teamEffect`).
 */
function flushBoardVfxFrame() {
  if (!boardVfx || !canvasVfx) return;
  try {
    boardVfx.render(performance.now(), getVfxTransform());
  } catch {
    /* ignore */
  }
}

function applyGlobalPurchaseVfx(msg) {
  const app = document.getElementById("app");
  const tr = getVfxTransform();
  const kind = msg.kind;
  const gx = Number(msg.gx);
  const gy = Number(msg.gy);
  const hasGrid = Number.isFinite(gx) && Number.isFinite(gy);

  if (
    (kind === "zoneCapture" || kind === "massCapture" || kind === "zone12Capture") &&
    consumeDuplicatePurchaseVfx(msg)
  ) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : kind === "zoneCapture"
          ? 4
          : kind === "massCapture"
            ? 6
            : 12;
    const gxi = gx | 0;
    const gyi = gy | 0;
    scheduleDraw({
      dirty: { gx0: gxi, gy0: gyi, gx1: gxi + sz - 1, gy1: gyi + sz - 1 },
    });
    return;
  }

  if (kind === "personalRecovery") {
    if (boardVfx) {
      boardVfx.lightningBurst(canvas.clientWidth, canvas.clientHeight);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "zoneCapture" && boardVfx && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 4;
    boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
    return;
  }
  if (kind === "massCapture" && boardVfx && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 6;
    boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
    boardVfx.lightningBurst(canvas.clientWidth, canvas.clientHeight);
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
    return;
  }
  if (kind === "zone12Capture" && boardVfx && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 12;
    boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
    boardVfx.lightningBurst(canvas.clientWidth, canvas.clientHeight);
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
    return;
  }
  if (kind === "teamRecovery") {
    app?.classList.add("fx-team-boost");
    setTimeout(() => app?.classList.remove("fx-team-boost"), 2000);
    boardVfx?.lightningBurst(canvas.clientWidth, canvas.clientHeight);
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
  }
}

/** Только для покупателя: всплывающие подсказки и «Повторить»; карта — через applyGlobalPurchaseVfx. */
function handlePurchaseOk(msg) {
  const kind = msg.kind;
  const flo = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.36 };

  if (kind === "personalRecovery") {
    const s = typeof msg.tierSec === "number" ? msg.tierSec : "?";
    spawnFloatingText(floatFxHost, `⚡ ЛИЧНО: ${s} С`, flo, "float-fx__pop--gold");
  }
  if (kind === "zoneCapture") {
    spawnFloatingText(floatFxHost, "ЗОНА 4×4", flo, "float-fx__pop--gold");
  }
  if (kind === "massCapture") {
    spawnFloatingText(floatFxHost, "МАСС-ЗАХВАТ 6×6", { x: flo.x, y: flo.y - 8 }, "float-fx__pop--raid");
  }
  if (kind === "zone12Capture") {
    spawnFloatingText(floatFxHost, "ЗОНА 12×12", { x: flo.x, y: flo.y - 10 }, "float-fx__pop--raid");
  }
  if (kind === "teamRecovery") {
    const s = typeof msg.tierSec === "number" ? msg.tierSec : "?";
    spawnFloatingText(floatFxHost, `👥 КОМАНДА: ${s} С`, { x: flo.x, y: flo.y - 4 }, "float-fx__pop--gold");
  }
  recordQuickBuyAfterPurchase(kind, msg);
  applyShopPurchaseSuccessUi(msg);
}

function ensureShopBtnDefaultLabels() {
  const root = document.getElementById("shop-overlay");
  if (!root) return;
  root.querySelectorAll(".shop-btn").forEach((btn) => {
    if (btn.dataset.shopDefaultLabel == null) {
      btn.dataset.shopDefaultLabel = btn.textContent.trim();
    }
  });
}

function resetShopPurchaseButtonsUi() {
  shopPurchaseUiLock = false;
  const root = document.getElementById("shop-overlay");
  if (!root) return;
  ensureShopBtnDefaultLabels();
  root.querySelectorAll(".shop-btn").forEach((btn) => {
    const def = btn.dataset.shopDefaultLabel;
    if (def != null) btn.textContent = def;
    btn.classList.remove("game-shop__buy--success");
    btn.removeAttribute("aria-label");
  });
}

function shopBtnMatchesPurchase(btn, msg) {
  const kind = msg.kind;
  const action = btn.dataset.action;
  if (!action || !kind) return false;
  if (kind === "personalRecovery") {
    return action === "personalRecovery" && Number(btn.dataset.tierSec) === Number(msg.tierSec);
  }
  if (kind === "teamRecovery") {
    return action === "teamRecovery" && Number(btn.dataset.tierSec) === Number(msg.tierSec);
  }
  if (kind === "zoneCapture") return action === "zoneCapture";
  if (kind === "massCapture") return action === "massCapture";
  if (kind === "zone12Capture") return action === "zone12Capture";
  return false;
}

function applyShopPurchaseSuccessUi(msg) {
  const root = document.getElementById("shop-overlay");
  if (!root || root.hidden) return;
  ensureShopBtnDefaultLabels();
  const buttons = Array.from(root.querySelectorAll(".shop-btn"));
  const winner = buttons.find((b) => shopBtnMatchesPurchase(b, msg));
  if (!winner) return;
  shopPurchaseUiLock = true;
  for (const btn of buttons) {
    btn.disabled = true;
    if (btn === winner) {
      btn.textContent = "✓";
      btn.classList.add("game-shop__buy--success");
      btn.setAttribute("aria-label", "Куплено");
    }
  }
}

function loadQuickBuyHistory() {
  try {
    const raw = localStorage.getItem(QUICK_BUY_HISTORY_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function pushQuickBuyHistory(entry) {
  try {
    let list = loadQuickBuyHistory();
    const key = (e) => `${e.action}:${e.tierSec ?? ""}`;
    const k = key(entry);
    list = list.filter((x) => key(x) !== k);
    list.unshift({ ...entry, at: Date.now() });
    list = list.slice(0, MAX_QUICK_BUY_ITEMS);
    localStorage.setItem(QUICK_BUY_HISTORY_KEY, JSON.stringify(list));
  } catch {
    /* ignore */
  }
  renderQuickBuyRail();
}

function recordQuickBuyAfterPurchase(kind, msg) {
  const tier = typeof msg.tierSec === "number" ? msg.tierSec | 0 : 0;
  if (kind === "personalRecovery" && [10, 5, 2, 1].includes(tier)) {
    pushQuickBuyHistory({ action: "personalRecovery", tierSec: tier });
  } else if (kind === "teamRecovery" && [15, 10, 5, 2, 1].includes(tier)) {
    pushQuickBuyHistory({ action: "teamRecovery", tierSec: tier });
  } else if (kind === "zoneCapture") {
    pushQuickBuyHistory({ action: "zoneCapture" });
  } else if (kind === "massCapture") {
    pushQuickBuyHistory({ action: "massCapture" });
  } else if (kind === "zone12Capture") {
    pushQuickBuyHistory({ action: "zone12Capture" });
  }
}

function getQuickBuyPriceQuant(entry) {
  if (entry.action === "personalRecovery") return PRICES_QUANT.personal[entry.tierSec] ?? 0;
  if (entry.action === "teamRecovery") return PRICES_QUANT.team[entry.tierSec] ?? 0;
  if (entry.action === "zoneCapture") return PRICES_QUANT.zone4;
  if (entry.action === "massCapture") return PRICES_QUANT.zone6;
  if (entry.action === "zone12Capture") return PRICES_QUANT.zone12;
  return 0;
}

function quickBuyShortLabel(entry) {
  if (entry.action === "personalRecovery") return `⚡ ${entry.tierSec} с`;
  if (entry.action === "teamRecovery") return `👥 ${entry.tierSec} с`;
  if (entry.action === "zoneCapture") return "4×4";
  if (entry.action === "massCapture") return "6×6";
  if (entry.action === "zone12Capture") return "12×12";
  return "?";
}

function playerCanAffordQuickBuy(entry) {
  const q = getQuickBuyPriceQuant(entry);
  if (!q) return false;
  if (!walletState) return false;
  if (walletState.devUnlimited) return true;
  const need = quantToUsdt(q);
  return walletState.balanceUSDT + 1e-9 >= need;
}

function isQuickBuyEntryBlocked(entry) {
  if (spectatorMode) return true;
  if (!walletState) return true;
  if (!walletState.devUnlimited) {
    const st = walletState.tournamentStage || "MASS_BATTLE";
    if (st === "DUEL" || st === "GRAND_FINAL") return true;
  }
  if (entry.action === "teamRecovery" && myTeamId == null) return true;
  if (
    (entry.action === "zoneCapture" || entry.action === "massCapture" || entry.action === "zone12Capture") &&
    myTeamId == null
  ) {
    return true;
  }
  if (!playerCanAffordQuickBuy(entry)) return true;
  return false;
}

function executeQuickBuy(entry) {
  if (isQuickBuyEntryBlocked(entry)) {
    if (walletState && !walletState.devUnlimited && !playerCanAffordQuickBuy(entry)) {
      const q = getQuickBuyPriceQuant(entry);
      const tg = window.Telegram?.WebApp;
      const text = `Недостаточно квантов (нужно ${q} ${quantWord(q)}).`;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
      else alert(text);
    }
    return;
  }
  if (entry.action === "personalRecovery" && [10, 5, 2, 1].includes(entry.tierSec)) {
    wsSendJson({ type: "purchasePersonalRecovery", tierSec: entry.tierSec });
    return;
  }
  if (entry.action === "teamRecovery" && [15, 10, 5, 2, 1].includes(entry.tierSec)) {
    wsSendJson({ type: "purchaseTeamRecovery", tierSec: entry.tierSec });
    return;
  }
  if (entry.action === "zoneCapture") {
    pendingMapAction = { type: "zoneCapture" };
    setPendingHint();
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
  if (entry.action === "massCapture") {
    pendingMapAction = { type: "massCapture" };
    setPendingHint();
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
  if (entry.action === "zone12Capture") {
    pendingMapAction = { type: "zone12Capture" };
    setPendingHint();
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
}

const QUICK_BUY_RING_R = 14;
const QUICK_BUY_RING_C = 2 * Math.PI * QUICK_BUY_RING_R;

function renderQuickBuyRail() {
  const rail = document.getElementById("quick-buy-rail");
  const host = document.getElementById("quick-buy-list");
  if (!rail || !host) return;
  const online = wantOnline && getWsUrl();
  if (!online) {
    rail.hidden = true;
    host.innerHTML = "";
    return;
  }
  const list = loadQuickBuyHistory().slice(0, 3);
  if (!list.length) {
    rail.hidden = true;
    host.innerHTML = "";
    return;
  }
  rail.hidden = false;
  host.innerHTML = "";
  for (const entry of list) {
    const q = getQuickBuyPriceQuant(entry);
    if (!q) continue;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "quick-buy-rail__btn";
    btn.dataset.action = entry.action;
    if (entry.tierSec != null) btn.dataset.tierSec = String(entry.tierSec);
    const blocked = isQuickBuyEntryBlocked(entry);
    btn.disabled = blocked;
    const short = quickBuyShortLabel(entry);
    if (entry.action === "zoneCapture" || entry.action === "massCapture" || entry.action === "zone12Capture") {
      btn.title = `${short} · ${q} кв. — тап по карте, затем списание`;
    } else if (!playerCanAffordQuickBuy(entry)) {
      btn.title = `${short} · ${q} кв. — не хватает квантов`;
    } else {
      btn.title = `${short} · ${q} кв. — быстрая покупка`;
    }
    btn.dataset.titleBase = btn.title;

    const isRecovery =
      entry.action === "personalRecovery" || entry.action === "teamRecovery";

    if (isRecovery) {
      btn.classList.add(
        entry.action === "teamRecovery"
          ? "quick-buy-rail__btn--kind-team"
          : "quick-buy-rail__btn--kind-personal"
      );
      const face = document.createElement("div");
      face.className = "quick-buy-rail__face";

      const orbit = document.createElement("div");
      orbit.className = "quick-buy-rail__orbit";
      orbit.setAttribute("aria-hidden", "true");
      const svgNs = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("class", "quick-buy-rail__svg");
      svg.setAttribute("viewBox", "0 0 40 40");
      const track = document.createElementNS(svgNs, "circle");
      track.setAttribute("class", "quick-buy-rail__ring-track");
      track.setAttribute("cx", "20");
      track.setAttribute("cy", "20");
      track.setAttribute("r", String(QUICK_BUY_RING_R));
      track.setAttribute("fill", "none");
      const arc = document.createElementNS(svgNs, "circle");
      arc.setAttribute("class", "quick-buy-rail__ring-arc");
      arc.setAttribute("cx", "20");
      arc.setAttribute("cy", "20");
      arc.setAttribute("r", String(QUICK_BUY_RING_R));
      arc.setAttribute("fill", "none");
      arc.setAttribute("transform", "rotate(-90 20 20)");
      arc.style.strokeDasharray = String(QUICK_BUY_RING_C);
      arc.style.strokeDashoffset = String(QUICK_BUY_RING_C);
      svg.appendChild(track);
      svg.appendChild(arc);
      orbit.appendChild(svg);

      const inner = document.createElement("div");
      inner.className = "quick-buy-rail__orbit-inner";

      const badge = document.createElement("span");
      badge.className = "quick-buy-rail__source-badge";
      badge.textContent = entry.action === "teamRecovery" ? "Команда" : "Лично";

      const label = document.createElement("span");
      label.className = "quick-buy-rail__label";
      label.textContent = short;
      const price = document.createElement("span");
      price.className = "quick-buy-rail__price";
      price.textContent = `${q} кв.`;

      inner.appendChild(badge);
      inner.appendChild(label);
      inner.appendChild(price);
      face.appendChild(orbit);
      face.appendChild(inner);
      btn.appendChild(face);
    } else {
      const label = document.createElement("span");
      label.className = "quick-buy-rail__label";
      label.textContent = short;
      const price = document.createElement("span");
      price.className = "quick-buy-rail__price";
      price.textContent = `${q} кв.`;
      btn.appendChild(label);
      btn.appendChild(price);
    }

    host.appendChild(btn);
  }
  updateQuickBuyBuffRings();
}

/** Круговой «радар» оставшегося времени баффа на кнопке «Повторить» (личн. / команда). */
function updateQuickBuyBuffRings() {
  const host = document.getElementById("quick-buy-list");
  if (!host) return;
  const now = Date.now();
  host.querySelectorAll(".quick-buy-rail__btn").forEach((btn) => {
    const action = btn.dataset.action;
    const tierRaw = btn.dataset.tierSec;
    const tier = tierRaw !== undefined && tierRaw !== "" ? Number(tierRaw) : null;
    const arc = btn.querySelector(".quick-buy-rail__ring-arc");
    if (!arc || tier == null || !Number.isFinite(tier)) return;

    let remain01 = 0;
    let active = false;
    let hintExtra = "";

    if (action === "personalRecovery" && walletState) {
      const until = walletState.personalRecoveryUntil;
      const sec = walletState.personalRecoverySec;
      if (until > now && sec === tier) {
        active = true;
        remain01 = Math.max(
          0,
          Math.min(1, (until - now) / RECOVERY_BUFF_DURATION_MS)
        );
        hintExtra = ` Буст активен · осталось ${formatBuffRemainingMs(until - now)} из 2 мин.`;
      }
    } else if (action === "teamRecovery" && walletState?.teamEffects) {
      const te = walletState.teamEffects;
      const until = te.teamRecoveryUntil;
      const sec = te.teamRecoverySec;
      if (until > now && sec === tier) {
        active = true;
        remain01 = Math.max(
          0,
          Math.min(1, (until - now) / RECOVERY_BUFF_DURATION_MS)
        );
        hintExtra = ` Командный буст активен · осталось ${formatBuffRemainingMs(until - now)} (купил ты или сокомандник).`;
      }
    }

    btn.classList.toggle("quick-buy-rail__btn--buff-ticking", active);
    arc.style.strokeDashoffset = String(QUICK_BUY_RING_C * (1 - remain01));

    const base = btn.dataset.titleBase || "";
    btn.title = active && hintExtra ? base + hintExtra : base;
  });
}

function setupQuickBuyRail() {
  const host = document.getElementById("quick-buy-list");
  if (!host || host.dataset.quickBuyBound === "1") return;
  host.dataset.quickBuyBound = "1";
  host.addEventListener("click", (e) => {
    const btn = e.target.closest(".quick-buy-rail__btn");
    if (!btn || btn.disabled) return;
    const action = btn.dataset.action;
    const tierRaw = btn.dataset.tierSec;
    /** @type {{ action: string, tierSec?: number }} */
    const entry = { action };
    if (tierRaw !== undefined && tierRaw !== "") entry.tierSec = Number(tierRaw);
    executeQuickBuy(entry);
  });
}

function startMapAnimLoop() {
  if (mapAnimTimer) return;
  const tick = () => {
    mapAnimTimer = null;
    if (!wantOnline || !getWsUrl()) return;
    if (!mapDrawUseLite()) drawFull(performance.now());
    const ms =
      lastDrawVisibleCellCount > 16000 ? 160
      : lastDrawVisibleCellCount > 10000 ? 90
      : 45;
    mapAnimTimer = setTimeout(tick, ms);
  };
  mapAnimTimer = setTimeout(tick, 45);
}

function stopMapAnimLoop() {
  if (mapAnimTimer) {
    clearTimeout(mapAnimTimer);
    mapAnimTimer = null;
  }
}

function vfxLoop(now) {
  if (boardVfx && canvasVfx) {
    boardVfx.render(now || performance.now(), getVfxTransform());
  }
  requestAnimationFrame(vfxLoop);
}

function updateShopAvailability() {
  if (!shopStageHint || !walletState) {
    renderQuickBuyRail();
    return;
  }
  syncClientCooldownFromWalletFields();
  const st = walletState.tournamentStage || "MASS_BATTLE";
  const hints = {
    MASS_BATTLE: "",
    SEMI_FINAL: "",
    FINAL: "",
    DUEL: "Дуэль: покупки отключены.",
    GRAND_FINAL: "Наблюдение: покупки отключены.",
  };
  const msg = Object.prototype.hasOwnProperty.call(hints, st) ? hints[st] : st;
  shopStageHint.textContent = msg;
  shopStageHint.hidden = !msg;
  const dis =
    walletState.devUnlimited === true
      ? false
      : st === "GRAND_FINAL" || st === "DUEL" || spectatorMode;
  document.querySelectorAll(".shop-btn").forEach((btn) => {
    btn.disabled = !!dis || shopPurchaseUiLock;
  });
  const effEl = document.getElementById("shop-effective-recovery-hint");
  if (effEl) {
    const now = Date.now();
    const sec = walletState.effectiveRecoverySec ?? BASE_ACTION_COOLDOWN_SEC;
    const pu = walletState.personalRecoveryUntil > now;
    const tu = walletState.teamEffects?.teamRecoveryUntil > now;
    let sub = "";
    if (pu || tu) {
      const p = pu ? `личн. ${walletState.personalRecoverySec} с` : null;
      const t = tu ? `ком. ${walletState.teamEffects.teamRecoverySec} с` : null;
      sub = ` Активно: ${[p, t].filter(Boolean).join(", ")}.`;
    }
    effEl.textContent = `Сейчас пиксель каждые ~${sec} с (минимум из базы ${BASE_ACTION_COOLDOWN_SEC} с и баффов).${sub}`;
  }
  if (shopEffects) {
    const te = walletState.teamEffects;
    const now = Date.now();
    const parts = [];
    if (walletState.referralBonusActive) parts.push("Приглашённый онлайн");
    if (te && te.teamRecoveryUntil > now) {
      parts.push(
        `Команда: пиксель каждые ${te.teamRecoverySec ?? "?"} с до ${fmtTime(te.teamRecoveryUntil)}`
      );
    }
    if (walletState.personalRecoveryUntil > now) {
      parts.push(
        `Лично: каждые ${walletState.personalRecoverySec ?? "?"} с до ${fmtTime(walletState.personalRecoveryUntil)}`
      );
    }
    shopEffects.textContent = parts.length ? parts.join(" · ") : "Нет активных баффов восстановления.";
  }
  renderQuickBuyRail();
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

/** Тестовый безлимит на сервере — пополнение USDT не используется. */
function isWalletDevUnlimited() {
  return walletState?.devUnlimited === true;
}

function notifyDevUnlimitedNoDeposit(hint) {
  const msg =
    hint ||
    "У вас тестовый безлимитный баланс. Пополнение USDT не нужно — откройте магазин и покупайте предметы за кванты.";
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.showAlert === "function") tg.showAlert(msg);
  else alert(msg);
}

function syncDevUnlimitedShopHints() {
  const dev = isWalletDevUnlimited();
  document.querySelectorAll(".shop-topup-pack").forEach((btn) => {
    btn.style.opacity = dev ? "0.55" : "";
    btn.title = dev ? "В тестовом режиме пополнение не требуется" : "";
  });
}

function setupEconomyUi() {
  btnDeposit?.addEventListener("click", () => {
    if (isWalletDevUnlimited()) {
      notifyDevUnlimitedNoDeposit();
      return;
    }
    depositBonusQuant = 0;
    if (depositOverlay) depositOverlay.hidden = false;
    if (depositError) depositError.hidden = true;
  });
  depositCancel?.addEventListener("click", () => {
    if (depositOverlay) depositOverlay.hidden = true;
  });
  depositOverlay?.addEventListener("click", (e) => {
    if (e.target === depositOverlay) depositOverlay.hidden = true;
  });
  document.querySelectorAll(".deposit-amt").forEach((b) => {
    b.addEventListener("click", () => {
      const a = Number(b.dataset.amt);
      const bon = Number(b.dataset.bonus ?? 0);
      depositBonusQuant = Number.isFinite(bon) ? bon | 0 : 0;
      if (depositCustom) depositCustom.value = String(a);
    });
  });
  depositCustom?.addEventListener("input", () => {
    depositBonusQuant = 0;
  });
  depositSubmit?.addEventListener("click", async () => {
    if (depositSubmit?.disabled) return;
    if (isWalletDevUnlimited()) {
      if (depositError) {
        depositError.textContent = "В тестовом режиме пополнение отключено.";
        depositError.hidden = false;
      }
      notifyDevUnlimitedNoDeposit();
      return;
    }
    const raw = depositCustom?.value.trim() || "10";
    const amount = parseFloat(raw.replace(",", "."));
    if (!Number.isFinite(amount) || amount < 1) {
      if (depositError) {
        depositError.textContent = "Укажите сумму от 1 USDT.";
        depositError.hidden = false;
      }
      return;
    }
    if (depositError) depositError.hidden = true;
    const prevLabel = depositSubmit.textContent;
    depositSubmit.disabled = true;
    depositSubmit.textContent = "Создаём счёт…";
    try {
      const res = await fetch(`${location.origin}/api/deposit/create`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          playerKey: getOrCreatePlayerKey(),
          amount,
          bonusQuant: depositBonusQuant,
          payCurrency: DEPOSIT_PAY_CURRENCY,
          initData: getTelegramInitDataForServer(),
        }),
      });
      const text = await res.text();
      let j;
      try {
        j = JSON.parse(text);
      } catch {
        throw new Error(
          res.ok ? "Некорректный ответ сервера" : `Сервер: ${res.status} ${text.slice(0, 120)}`
        );
      }
      if (!res.ok || !j.ok || !j.paymentUrl) {
        if (depositError) {
          let msg =
            j.error ||
            (typeof j === "object" && j.message) ||
            "Не удалось создать счёт. Проверьте NOWPAYMENTS_API_KEY и PUBLIC_BASE_URL на Render.";
          if (msg === "initData required" || msg.includes("initData")) {
            msg = "Откройте игру из Telegram Mini App — нужна подпись для оплаты.";
          }
          if (msg === "bad initData" || msg.includes("bad initData")) {
            msg = "Обновите Mini App (закройте и откройте снова) и повторите.";
          }
          if (msg === "rate limit" || msg.includes("rate")) {
            msg = "Слишком много попыток. Подождите минуту.";
          }
          if (msg === "bad bonus" || msg.includes("bad bonus")) {
            msg = "Выберите пакет из списка или введите свою сумму без бонуса.";
          }
          depositError.textContent = msg;
          depositError.hidden = false;
        }
        return;
      }
      if (depositOverlay) depositOverlay.hidden = true;
      const payUrl = String(j.paymentUrl).trim();
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.openLink === "function") {
        tg.openLink(payUrl, { try_instant_view: false });
      } else {
        window.open(payUrl, "_blank", "noopener,noreferrer");
      }
    } catch (e) {
      if (depositError) {
        depositError.textContent = String(e.message || e);
        depositError.hidden = false;
      }
    } finally {
      depositSubmit.disabled = false;
      depositSubmit.textContent = prevLabel;
    }
  });

  btnShop?.addEventListener("click", () => {
    resetShopPurchaseButtonsUi();
    if (shopOverlay) shopOverlay.hidden = false;
    const bal = document.getElementById("shop-display-balance");
    if (bal) {
      bal.setAttribute("data-pulse", "1");
      setTimeout(() => bal.removeAttribute("data-pulse"), 500);
    }
    syncShopHeaderBalance();
    updateShopAvailability();
    setPendingHint();
  });

  document.getElementById("shop-open-deposit")?.addEventListener("click", () => {
    if (isWalletDevUnlimited()) {
      notifyDevUnlimitedNoDeposit();
      return;
    }
    depositBonusQuant = 0;
    if (shopOverlay) shopOverlay.hidden = true;
    if (depositOverlay) depositOverlay.hidden = false;
    if (depositError) depositError.hidden = true;
  });

  document.querySelectorAll(".shop-topup-pack").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (isWalletDevUnlimited()) {
        notifyDevUnlimitedNoDeposit();
        return;
      }
      const a = Number(btn.dataset.amt);
      const bon = Number(btn.dataset.bonus ?? 0);
      depositBonusQuant = Number.isFinite(bon) ? bon | 0 : 0;
      if (depositCustom) depositCustom.value = String(a);
      if (shopOverlay) shopOverlay.hidden = true;
      if (depositOverlay) depositOverlay.hidden = false;
      if (depositError) depositError.hidden = true;
    });
  });

  (function setupGameShopTabs() {
    const root = document.getElementById("shop-overlay");
    if (!root) return;
    root.querySelectorAll(".game-shop__tab").forEach((tab) => {
      tab.addEventListener("click", () => {
        const id = tab.dataset.tab;
        root.querySelectorAll(".game-shop__tab").forEach((t) => {
          const on = t.dataset.tab === id;
          t.classList.toggle("is-active", on);
          t.setAttribute("aria-selected", on ? "true" : "false");
        });
        root.querySelectorAll(".game-shop__panel").forEach((p) => {
          p.hidden = p.dataset.panel !== id;
        });
      });
    });
  })();
  shopClose?.addEventListener("click", () => {
    if (shopOverlay) shopOverlay.hidden = true;
    pendingMapAction = null;
    setPendingHint();
  });
  shopOverlay?.addEventListener("click", (e) => {
    if (e.target === shopOverlay) {
      shopOverlay.hidden = true;
      pendingMapAction = null;
      setPendingHint();
    }
  });

  document.querySelectorAll(".shop-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      if (action === "personalRecovery") {
        const tier = Number(btn.dataset.tierSec);
        if ([10, 5, 2, 1].includes(tier)) {
          wsSendJson({ type: "purchasePersonalRecovery", tierSec: tier });
        }
        return;
      }
      if (action === "teamRecovery") {
        const tier = Number(btn.dataset.tierSec);
        if ([15, 10, 5, 2, 1].includes(tier)) {
          wsSendJson({ type: "purchaseTeamRecovery", tierSec: tier });
        }
        return;
      }
      if (action === "zoneCapture") {
        pendingMapAction = { type: "zoneCapture" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "massCapture") {
        pendingMapAction = { type: "massCapture" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "zone12Capture") {
        pendingMapAction = { type: "zone12Capture" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
    });
  });

  setInterval(() => {
    if (walletState) updateWalletBar();
  }, 1000);

  document.querySelectorAll(".game-shop__buy, .shop-topup-pack, .deposit-amt").forEach((btn) => {
    btn.addEventListener(
      "click",
      () => {
        btn.classList.remove("fx-btn-press");
        void btn.offsetWidth;
        btn.classList.add("fx-btn-press");
        setTimeout(() => btn.classList.remove("fx-btn-press"), 280);
      },
      { passive: true }
    );
  });
}

function setPendingHint() {
  const full = (() => {
    if (!pendingMapAction) return "";
    if (pendingMapAction.type === "zoneCapture")
      return "Зона 4×4: тап по углу области — все 16 клеток перекрасятся";
    if (pendingMapAction.type === "massCapture")
      return "Масс-захват 6×6: тап по центру — все 36 клеток перекрасятся";
    if (pendingMapAction.type === "zone12Capture")
      return "Зона 12×12: тап по центру — 144 клетки перекрасятся";
    return "";
  })();
  /** Короткая строка в шапке — иначе длинный текст раздувает toolbar на пол-экрана */
  const short = (() => {
    if (!pendingMapAction) return "";
    if (pendingMapAction.type === "zoneCapture") return "4×4 · тап по карте";
    if (pendingMapAction.type === "massCapture") return "6×6 · тап по центру";
    if (pendingMapAction.type === "zone12Capture") return "12×12 · тап по центру";
    return "";
  })();
  const text = short;
  if (shopPending) {
    shopPending.hidden = !full;
    shopPending.textContent = full;
  }
  if (cooldownLabel && text) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = text;
    cooldownLabel.title = full;
  } else if (cooldownLabel && !text) {
    cooldownLabel.hidden = true;
    cooldownLabel.title = "";
  }
}

function wsSendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(JSON.stringify({ ...obj, playerKey: getOrCreatePlayerKey() }));
  } catch {
    /* ignore */
  }
}

function connectWs() {
  clearTimeout(reconnectTimer);
  const url = getWsUrl();
  wantOnline = !!url;
  if (!url) {
    stopMapAnimLoop();
    if (leaderboardPanel) leaderboardPanel.hidden = true;
    setConnState("local", "локально");
    setFooterMode();
    return;
  }

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  setConnState("connecting", "подключение…");
  clearTimeout(connectingHangTimer);
  connectingHangTimer = null;
  try {
    ws = new WebSocket(url);
  } catch {
    setConnState("error", "ошибка WS");
    reconnectTimer = setTimeout(connectWs, 3500);
    return;
  }

  connectingHangTimer = setTimeout(() => {
    connectingHangTimer = null;
    if (ws && ws.readyState === WebSocket.CONNECTING) {
      try {
        ws.close();
      } catch {
        /* ignore */
      }
    }
  }, 15000);

  ws.addEventListener("open", () => {
    clearTimeout(connectingHangTimer);
    connectingHangTimer = null;
    lastClaimEligibilityAt = 0;
    setConnState("online", "онлайн");
    const sess = loadOnlineSession();
    if (sess?.solo) {
      clearSoloFromSession();
      myTeamId = null;
    } else {
      myTeamId = sess?.teamId ?? null;
    }
    if (leaderboardPanel) leaderboardPanel.hidden = false;
    setFooterMode();
    updateRoundTimer();
    startMapAnimLoop();
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "clientProfile",
            playerKey: getOrCreatePlayerKey(),
            telegramUser: getTelegramUserForServer(),
            initData: getTelegramInitDataForServer(),
            inviteTelegramId: (() => {
              const x = parseStartParamRef().inviteTelegramId;
              return x != null ? x : undefined;
            })(),
          })
        );
      }
    } catch {
      /* ignore */
    }
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "gameEnded") {
      endSessionRestore();
      try {
        localStorage.removeItem(SESSION_TEAM_EDIT);
      } catch {
        /* ignore */
      }
      clearTeamIdentityFromSession();
      myTeamId = null;
      stripTeamFromUrl();
      hideReferralSplash();
      closeTeamSettings();
      closeCreateTeamOverlay();
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      spectatorMode = true;
      gameFinishedMeta = true;
      lastMyTeamPercent = null;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : 64;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : 64;
      applyGridFromServer(gw, gh).then(() => {
        const tg = window.Telegram?.WebApp;
        const p = typeof msg.percent === "number" ? formatPercent(msg.percent) : "—";
        const text = `Финал завершён. Победитель: «${msg.winnerName || "—"}» (${p}% территории).`;
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
        setFooterMode();
        schedulePersist();
      });
      return;
    }
    if (msg.type === "roundEnded") {
      endSessionRestore();
      try {
        localStorage.removeItem(SESSION_TEAM_EDIT);
      } catch {
        /* ignore */
      }
      clearTeamIdentityFromSession();
      myTeamId = null;
      stripTeamFromUrl();
      hideReferralSplash();
      closeTeamSettings();
      closeCreateTeamOverlay();
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      lastMyTeamPercent = null;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : gridW;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : gridH;
      applyGridFromServer(gw, gh).then(() => {
        const tg = window.Telegram?.WebApp;
        const cap = typeof msg.maxPerTeam === "number" ? msg.maxPerTeam : maxPerTeam;
        const text = msg.duel
          ? `Финал команд завершён. Победитель: «${msg.winnerName || "—"}». Дуэль 1 на 1 на той же сетке; в команде до ${cap} чел.`
          : `Раунд завершён. Победитель: «${msg.winnerName || "—"}». Новая карта; в команде до ${cap} чел.`;
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
        setFooterMode();
        schedulePersist();
      });
      return;
    }
    if (msg.type === "roundWinnerPass") {
      spectatorMode = false;
      if (typeof msg.token === "string" && msg.token.length > 0) {
        try {
          localStorage.setItem(ROUND_ELIGIBLE_KEY, msg.token);
        } catch {
          /* ignore */
        }
      }
      setFooterMode();
      return;
    }
    if (msg.type === "claimedOk") {
      return;
    }
    if (msg.type === "claimError") {
      try {
        localStorage.removeItem(ROUND_ELIGIBLE_KEY);
      } catch {
        /* ignore */
      }
      if (msg.reason === "not_eligible") {
        const tg = window.Telegram?.WebApp;
        if (typeof tg?.showAlert === "function") tg.showAlert(MSG_WATCH_ONLY);
        else if (typeof window.alert === "function") window.alert(MSG_WATCH_ONLY);
      }
      if (msg.reason === "rate") {
        const tg = window.Telegram?.WebApp;
        const text = "Слишком много попыток с токеном. Подождите минуту.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
      }
      if (msg.reason === "need_telegram") {
        const tg = window.Telegram?.WebApp;
        const text = "Откройте игру из Telegram Mini App (нужна подпись initData).";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
      }
      return;
    }
    if (msg.type === "playRejected") {
      if (msg.reason === "spectator" || msg.reason === "not_eligible") spectatorMode = true;
      notifyReject(
        msg.reason === "spectator" || msg.reason === "not_eligible"
          ? msg.reason
          : msg.reason || ""
      );
      setFooterMode();
      return;
    }

    if (msg.type === "meta") {
      onMeta(msg);
      return;
    }
    if (msg.type === "globalEvent") {
      if (walletState) {
        walletState.globalEvent = { active: false, kind: null, until: 0 };
      }
      lastStatsGlobalEvent = { active: false, kind: null, until: 0 };
      syncEventBanner();
      syncTeamBuffBanner();
      return;
    }
    if (msg.type === "stats") {
      renderLeaderboard(msg);
      return;
    }
    if (msg.type === "counts") {
      teamCounts = msg.teamCounts || {};
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      return;
    }
    if (msg.type === "teamDisplay") {
      applyTeamDisplay(msg.teamId, msg.name, msg.emoji, msg.color);
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      syncPaletteSelectionFromTeam();
      return;
    }
    if (msg.type === "teamsFull") {
      teamsMeta = msg.teams || [];
      invalidateTeamColorByIdCache();
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      syncPaletteSelectionFromTeam();
      return;
    }
    if (msg.type === "created") {
      endSessionRestore();
      teamsMeta = msg.teams || [];
      invalidateTeamColorByIdCache();
      teamCounts = msg.teamCounts || {};
      myTeamId = msg.teamId;
      saveOnlineSession({
        teamId: msg.teamId,
        solo: false,
        cachedTeamName: msg.team?.name,
        cachedEmoji: msg.team?.emoji,
      });
      if (typeof msg.editToken === "string" && msg.editToken.length > 0 && msg.teamId != null) {
        setTeamEditToken(msg.teamId, msg.editToken);
      }
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = true;
      closeCreateTeamOverlay();
      stripTeamFromUrl();
      rebuildTeamList();
      setFooterMode();
      schedulePersist();
      showReferralSplash();
      lastMyTeamPercent = null;
      return;
    }
    if (msg.type === "setTeamColorError" || msg.type === "soloColorError") {
      return;
    }
    if (msg.type === "soloError") {
      endSessionRestore();
      if (msg.reason === "already") {
        if (sendLeaveTeamToRecoverFromStaleServer()) {
          const tg = window.Telegram?.WebApp;
          const text =
            "На сервере оставалась сессия в команде — выход выполнен. Создайте команду или вступите в списке ещё раз.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        } else {
          const tg = window.Telegram?.WebApp;
          const text =
            "Нет соединения с сервером. Закройте и откройте Mini App снова, затем повторите вход.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        }
        return;
      }
      if (msg.reason === "disabled") {
        const tg = window.Telegram?.WebApp;
        const text = "Соло-режим отключён — создайте команду или вступите в существующую.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else alert(text);
        clearSoloFromSession();
        showWelcomeOverlay();
        if (teamOverlay) teamOverlay.hidden = true;
        setFooterMode();
        return;
      }
      const map = {
        fields: "Введите имя и выберите цвет.",
        limit: "Достигнут лимит команд на сервере.",
        round:
          "В финале команд (команды по 2 человека) доступны только команды — создайте команду из двух или вступите в существующую.",
      };
      const text = map[msg.reason] || "Соло недоступно.";
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
      else alert(text);
      return;
    }
    if (msg.type === "soloJoined") {
      endSessionRestore();
      clearSoloFromSession();
      myTeamId = null;
      showWelcomeOverlay();
      if (teamOverlay) teamOverlay.hidden = true;
      rebuildTeamList();
      setFooterMode();
      return;
    }
    if (msg.type === "createTeamError") {
      endSessionRestore();
      if (msg.reason === "already") {
        if (sendLeaveTeamToRecoverFromStaleServer()) {
          const tg = window.Telegram?.WebApp;
          const text =
            "На сервере оставалась сессия в команде — выход выполнен. Нажмите «Создать команду» ещё раз.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        } else {
          const tg = window.Telegram?.WebApp;
          const text =
            "Нет соединения с сервером. Закройте и откройте Mini App снова, затем повторите вход.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        }
        return;
      }
      const map = {
        fields: "Укажите название, смайлик и цвет команды.",
        limit: "Достигнут лимит команд на сервере.",
        duel: "Финальная дуэль 1 на 1 — публичные команды в этот момент недоступны.",
      };
      const text = map[msg.reason] || "Не удалось создать команду.";
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
      else alert(text);
      return;
    }
    if (msg.type === "updateTeamError") {
      const map = {
        rate: "Подождите несколько секунд перед следующим изменением.",
        name: "Укажите название команды.",
        emoji: "Выберите смайлик (эмодзи).",
        no_team: "Сначала вступите в команду.",
        not_owner: "Название и смайлик может менять только создатель этой команды.",
        solo: "Соло-режим отключён. Вступите в команду или создайте свою.",
      };
      const text = map[msg.reason] || "Не удалось сохранить.";
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
      else {
        cooldownLabel.hidden = false;
        cooldownLabel.textContent = text;
        setTimeout(() => {
          cooldownLabel.hidden = true;
        }, 2200);
      }
      if (msg.reason !== "rate" && msg.reason !== "not_owner") openTeamSettings();
      return;
    }
    if (msg.type === "joined") {
      endSessionRestore();
      myTeamId = msg.teamId;
      saveOnlineSession({ teamId: msg.teamId, solo: false });
      cacheTeamDisplayInSession();
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = true;
      stripTeamFromUrl();
      setFooterMode();
      schedulePersist();
      return;
    }
    if (msg.type === "soloResumeError") {
      endSessionRestore();
      if (msg.reason === "already") {
        if (sendLeaveTeamToRecoverFromStaleServer()) {
          const tg = window.Telegram?.WebApp;
          const text =
            "На сервере уже была активная команда — выход выполнен. Создайте команду или вступите в списке снова.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        } else {
          const tg = window.Telegram?.WebApp;
          const text =
            "Нет соединения с сервером. Закройте и откройте Mini App снова, затем повторите вход.";
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
          else alert(text);
        }
        return;
      }
      if (msg.reason === "disabled") {
        clearSoloFromSession();
        showWelcomeOverlay();
        if (teamOverlay) teamOverlay.hidden = true;
        rebuildTeamList();
        setFooterMode();
        return;
      }
      if (msg.reason === "round") {
        const tg = window.Telegram?.WebApp;
        const text =
          "В финале команд (команды по 2) нужна команда — создайте из двух человек или вступите в существующую.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        showWelcomeOverlay();
        teamOverlay.hidden = true;
        rebuildTeamList();
        setFooterMode();
        return;
      }
      if (msg.reason === "invalid" || msg.reason === "full") {
        clearTeamIdentityFromSession();
        stripTeamFromUrl();
        myTeamId = null;
      }
      showWelcomeOverlay();
      teamOverlay.hidden = true;
      rebuildTeamList();
      setFooterMode();
      return;
    }
    if (msg.type === "joinError") {
      /* Уже в команде на сервере (часто после повторного joinTeam при каждом meta — не трогаем UI) */
      if (msg.reason === "already") {
        endSessionRestore();
        return;
      }
      endSessionRestore();
      if (msg.reason === "duel") {
        const tg = window.Telegram?.WebApp;
        const text = "В дуэли 1 на 1 нельзя вступать в чужие команды — играйте только за свою команду.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else alert(text);
        rebuildTeamList();
        setFooterMode();
        return;
      }
      if (msg.reason === "full" || msg.reason === "team") {
        clearTeamIdentityFromSession();
        stripTeamFromUrl();
        myTeamId = null;
      }
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = false;
      rebuildTeamList();
      setFooterMode();
      return;
    }
    if (msg.type === "left") {
      myTeamId = null;
      clearTeamIdentityFromSession();
      stripTeamFromUrl();
      const openTeamList = pendingLeaveToTeamList;
      const openCreate = pendingLeaveToCreate;
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      if (openCreate) {
        if (welcomeOverlay) welcomeOverlay.hidden = true;
        teamOverlay.hidden = true;
        openCreateTeamOverlay(true);
      } else if (openTeamList) {
        if (welcomeOverlay) welcomeOverlay.hidden = true;
        teamOverlay.hidden = false;
      } else {
        showWelcomeOverlay();
        teamOverlay.hidden = true;
      }
      closeCreateTeamOverlay();
      closeTeamSettings();
      hideReferralSplash();
      rebuildTeamList();
      setFooterMode();
      schedulePersist();
      return;
    }
    if (msg.type === "leaveError") {
      const hadPendingIntent = pendingLeaveToTeamList || pendingLeaveToCreate;
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      if (hadPendingIntent && welcomeOverlay) welcomeOverlay.hidden = false;
      return;
    }
    if (msg.type === "full") {
      optimisticPixelPending = null;
      optimisticWeaponPending = null;
      pixels.clear();
      for (const p of msg.pixels || []) {
        if (!Array.isArray(p) || p.length < 3) continue;
        if (msg.pixelFormat === "v2" && p.length >= 5) {
          const [x, y, t, , sh] = p;
          pixels.set(`${x},${y}`, { teamId: t, shieldedUntil: sh || 0 });
        } else {
          const [x, y, t] = p;
          pixels.set(`${x},${y}`, { teamId: t, shieldedUntil: 0 });
        }
      }
      scheduleDraw();
      if (wantOnline) flushToStorage();
      else schedulePersist();
      return;
    }
    if (msg.type === "pixel") {
      const pk = `${msg.x},${msg.y}`;
      /* Оптимистичный пиксель: эхо своей клетки — без второго popPixel (уже показали локально). */
      const skipOwnPop =
        optimisticPixelPending &&
        optimisticPixelPending.key === pk &&
        msg.t === myTeamId;
      if (optimisticPixelPending && optimisticPixelPending.key === pk) {
        optimisticPixelPending = null;
      }
      const prev = pixels.get(pk);
      const prevSh = typeof prev === "object" && prev ? prev.shieldedUntil || 0 : 0;
      const newSh = typeof msg.shieldedUntil === "number" ? msg.shieldedUntil : 0;
      pixels.set(pk, {
        teamId: msg.t,
        shieldedUntil: newSh,
      });
      const tr = getVfxTransform();
      const col = teamColor(msg.t);
      if (boardVfx) {
        if (!skipOwnPop) {
          boardVfx.popPixel(msg.x, msg.y, col, tr);
        }
        if (newSh > Date.now() && newSh > prevSh) {
          boardVfx.shieldBurst(msg.x, msg.y, col, tr);
        }
      }
      scheduleDraw({
        dirty: { gx0: msg.x, gy0: msg.y, gx1: msg.x, gy1: msg.y },
      });
      schedulePersist();
      return;
    }
    if (msg.type === "wallet") {
      applyWalletFromServer(msg);
      return;
    }
    if (msg.type === "purchaseVfx") {
      applyGlobalPurchaseVfx(msg);
      return;
    }
    if (msg.type === "purchaseOk") {
      handlePurchaseOk(msg);
      return;
    }
    if (msg.type === "purchaseError") {
      const wk = optimisticWeaponPending?.keys;
      revertOptimisticWeapon();
      notifyPurchaseError(msg.reason || "");
      const dr = wk && wk.length ? dirtyRectFromKeys(wk) : null;
      scheduleDraw(dr ? { dirty: dr } : undefined);
      return;
    }
    if (msg.type === "teamEffect") {
      if (walletState && msg.teamId === myTeamId) {
        if (!walletState.teamEffects) {
          walletState.teamEffects = {
            teamId: msg.teamId,
            teamRecoveryUntil: 0,
            teamRecoverySec: BASE_ACTION_COOLDOWN_SEC,
          };
        }
        const te = walletState.teamEffects;
        if (msg.kind === "teamRecovery" && typeof msg.until === "number") {
          te.teamRecoveryUntil = msg.until;
          if (typeof msg.teamRecoverySec === "number") te.teamRecoverySec = msg.teamRecoverySec;
        }
        syncClientCooldownFromWalletFields();
        updateShopAvailability();
        updateToolbarHud();
        syncTeamBuffBanner();
      }
      if (msg.kind === "teamRecovery") {
        applyGlobalPurchaseVfx({ kind: "teamRecovery", teamId: msg.teamId });
      }
      return;
    }
    if (msg.type === "pixelReject") {
      let rejDirty = null;
      if (optimisticPixelPending?.key) {
        const p = optimisticPixelPending.key.split(",");
        const rx = Number(p[0]);
        const ry = Number(p[1]);
        if (Number.isFinite(rx) && Number.isFinite(ry)) {
          rejDirty = { gx0: rx, gy0: ry, gx1: rx, gy1: ry };
        }
      }
      revertOptimisticPixel();
      if (msg.reason !== "cooldown" && msg.reason !== "cooldown not ready") {
        lastPlaceAt = 0;
      }
      notifyReject(msg.reason || "");
      scheduleDraw(rejDirty ? { dirty: rejDirty } : undefined);
      updateToolbarHud();
      return;
    }
  });

  ws.addEventListener("close", () => {
    clearTimeout(connectingHangTimer);
    connectingHangTimer = null;
    ws = null;
    stopMapAnimLoop();
    const sess = loadOnlineSession();
    myTeamId = sess?.solo ? null : sess?.teamId ?? null;
    teamsMeta = null;
    invalidateTeamColorByIdCache();
    if (leaderboardPanel) leaderboardPanel.hidden = true;
    setConnState("error", "нет связи");
    reconnectTimer = setTimeout(connectWs, 3500);
    setFooterMode();
  });

  ws.addEventListener("error", () => {
    setConnState("error", "ошибка");
  });
}

function sendPixelOnline(gx, gy) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
    ws.send(
      JSON.stringify({ type: "pixel", x: gx, y: gy, playerKey: getOrCreatePlayerKey() })
    );
  } catch {
    /* буфер/закрытие — не роняем UI */
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
  /* После expand вьюпорт меняется не сразу — пересчёт canvas, иначе верх/стороны «пустые». */
  scheduleResizeCanvas();
}

function updatePaletteTriggerPreview() {
  if (!paletteTriggerBtn) return;
  const hex = PALETTE[selectedColor] ?? "#ffffff";
  paletteTriggerBtn.style.backgroundColor = hex;
}

function closePalettePicker() {
  if (palettePickerOverlay) palettePickerOverlay.hidden = true;
  if (paletteTriggerBtn) paletteTriggerBtn.setAttribute("aria-expanded", "false");
  paletteTriggerBtn?.focus();
}

function openPalettePicker() {
  if (!palettePickerOverlay || paletteTriggerBtn?.hidden) return;
  palettePickerOverlay.hidden = false;
  paletteTriggerBtn?.setAttribute("aria-expanded", "true");
}

function setupPalettePickerUi() {
  paletteTriggerBtn?.addEventListener("click", () => {
    if (paletteTriggerBtn.hidden) return;
    openPalettePicker();
  });
  palettePickerCloseBtn?.addEventListener("click", () => closePalettePicker());
  palettePickerOverlay?.addEventListener("click", (e) => {
    if (e.target === palettePickerOverlay) closePalettePicker();
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (!palettePickerOverlay || palettePickerOverlay.hidden) return;
    closePalettePicker();
  });
}

function buildPalette() {
  if (!paletteEl) return;
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
      updatePaletteTriggerPreview();
      if (wantOnline && getWsUrl() && canPickOnlineDrawColor()) {
        sendOnlineColorChoice(hex);
      }
      schedulePersist();
      closePalettePicker();
    });
    paletteEl.appendChild(b);
  });
  updatePaletteTriggerPreview();
}

/** Два rAF — после первого кадра layout в Telegram Desktop/WebView часто ещё не финальный размер wrap. */
function scheduleResizeCanvas() {
  requestAnimationFrame(() => {
    requestAnimationFrame(() => resizeCanvas());
  });
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const rect = wrap.getBoundingClientRect();
  const w = Math.max(1, Math.round(rect.width));
  const h = Math.max(1, Math.round(rect.height));
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  canvas.width = bw;
  canvas.height = bh;
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.imageSmoothingEnabled = false;
  if (canvasVfx) {
    canvasVfx.width = bw;
    canvasVfx.height = bh;
    canvasVfx.style.width = `${w}px`;
    canvasVfx.style.height = `${h}px`;
    const vctx = canvasVfx.getContext("2d", { alpha: true, desynchronized: true });
    if (vctx) {
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.imageSmoothingEnabled = false;
    }
  }
  centerIfNeeded(w, h);
  syncToolbarHeightCssVar();
  draw();
}

/** Смена размеров без window.resize (Telegram expand, адресная строка, клавиатура). */
function setupStageLayoutSync() {
  const wrap = canvas?.parentElement;
  if (!wrap) return;
  if (typeof ResizeObserver !== "undefined") {
    const ro = new ResizeObserver(() => scheduleResizeCanvas());
    ro.observe(wrap);
  }
  if (window.visualViewport) {
    window.visualViewport.addEventListener("resize", scheduleResizeCanvas);
  }
}

function centerIfNeeded(w, h) {
  if (offsetX === 0 && offsetY === 0 && scale === 1) {
    const cell = BASE_CELL * scale;
    offsetX = (w - gridW * cell) / 2;
    offsetY = (h - gridH * cell) / 2;
  }
}

function screenToGrid(sx, sy) {
  const cell = BASE_CELL * scale;
  const gx = Math.floor((sx - offsetX) / cell);
  const gy = Math.floor((sy - offsetY) / cell);
  return { gx, gy };
}

function getTeamColorByIdMap() {
  if (teamColorByIdCache != null && teamsMeta === teamColorByIdCacheTeamsRef) {
    return teamColorByIdCache;
  }
  teamColorByIdCacheTeamsRef = teamsMeta;
  teamColorByIdCache = null;
  if (!teamsMeta || !teamsMeta.length) return null;
  const m = new Map();
  for (let i = 0; i < teamsMeta.length; i++) {
    const t = teamsMeta[i];
    if (t && t.id != null) m.set(t.id, t.color);
  }
  teamColorByIdCache = m;
  return teamColorByIdCache;
}

/** Пан / щипок / колесо — «живой» жест; пока true, карта в lite-режиме. */
function isMapInteracting() {
  return mapInteractionActive || mapWheelActive;
}

function mapDrawUseLite() {
  return isMapInteracting();
}

/** Полное качество (после жеста / в покое). */
function drawFull(time) {
  draw(time ?? performance.now(), { lite: false });
}

/** Упрощённый кадр (явный вызов; жесты обычно идут через mapDrawUseLite). */
function drawFast(time) {
  draw(time ?? performance.now(), { lite: true });
}

function flushCanvasFrame() {
  canvasFrameRafId = 0;
  const full = pendingRedrawFull;
  const dirty = pendingDirtyRect;
  pendingRedrawFull = false;
  pendingDirtyRect = null;
  const lite = mapDrawUseLite();
  draw(performance.now(), {
    lite,
    dirtyGrid: full || lite ? null : dirty,
  });
}

/**
 * Запрос кадра (пан/zoom): состояние dirty/full не трогаем — в колбэке только lite.
 */
function scheduleCanvasFrame() {
  if (canvasFrameRafId) return;
  canvasFrameRafId = requestAnimationFrame(flushCanvasFrame);
}

/**
 * Перерисовка карты: объединяет несколько событий в один rAF; опционально только dirty-регион.
 * @param {{ full?: boolean, dirty?: { gx0: number, gy0: number, gx1: number, gy1: number } } | void} opts
 */
function scheduleDraw(opts) {
  if (!opts) {
    pendingRedrawFull = true;
    pendingDirtyRect = null;
  } else if (opts.full) {
    pendingRedrawFull = true;
    pendingDirtyRect = null;
  } else if (opts.dirty) {
    if (!pendingRedrawFull) {
      pendingDirtyRect = mergeDirtyRects(pendingDirtyRect, expandDirtyRect(opts.dirty, 1));
    }
  } else {
    pendingRedrawFull = true;
    pendingDirtyRect = null;
  }
  scheduleCanvasFrame();
}

function endMapInteraction() {
  mapInteractionActive = false;
  if (canvasFrameRafId) {
    cancelAnimationFrame(canvasFrameRafId);
    canvasFrameRafId = 0;
  }
  if (!mapWheelActive) drawFull();
  else scheduleCanvasFrame();
}

function endMapWheelInteraction() {
  mapWheelActive = false;
  if (mapWheelEndTimer) {
    clearTimeout(mapWheelEndTimer);
    mapWheelEndTimer = 0;
  }
  if (!mapInteractionActive) {
    if (canvasFrameRafId) {
      cancelAnimationFrame(canvasFrameRafId);
      canvasFrameRafId = 0;
    }
    drawFull();
  }
}

/** Снимок значения клетки для отката при pixelReject. */
function snapshotPixelCell(pk) {
  const v = pixels.get(pk);
  if (v === undefined) return undefined;
  if (typeof v === "number") return v;
  return { teamId: v.teamId, shieldedUntil: Number(v.shieldedUntil) || 0 };
}

function revertOptimisticPixel() {
  if (!optimisticPixelPending) return;
  const { key, prev } = optimisticPixelPending;
  optimisticPixelPending = null;
  if (prev === undefined) pixels.delete(key);
  else pixels.set(key, prev);
}

/** Список клеток в прямоугольнике захвата — как на сервере (planCaptureRect). */
function planClientCaptureCells(kind, cx, cy) {
  let x0;
  let y0;
  let x1;
  let y1;
  if (kind === "zoneCapture") {
    x0 = cx - 1;
    y0 = cy - 1;
    x1 = cx + 2;
    y1 = cy + 2;
  } else if (kind === "massCapture") {
    x0 = cx - 2;
    y0 = cy - 2;
    x1 = cx + 3;
    y1 = cy + 3;
  } else if (kind === "zone12Capture") {
    x0 = cx - 5;
    y0 = cy - 5;
    x1 = cx + 6;
    y1 = cy + 6;
  } else {
    return [];
  }
  const keys = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

function applyOptimisticWeapon(kind, cx, cy) {
  if (myTeamId == null) return;
  const keys = planClientCaptureCells(kind, cx, cy);
  if (!keys.length) return;
  revertOptimisticWeapon();
  const prev = new Map();
  for (const k of keys) {
    prev.set(k, snapshotPixelCell(k));
    pixels.set(k, { teamId: myTeamId, shieldedUntil: 0 });
  }
  const gx0 = kind === "zoneCapture" ? cx - 1 : kind === "massCapture" ? cx - 2 : cx - 5;
  const gy0 = kind === "zoneCapture" ? cy - 1 : kind === "massCapture" ? cy - 2 : cy - 5;
  const size = kind === "zoneCapture" ? 4 : kind === "massCapture" ? 6 : 12;
  optimisticWeaponPending = { kind, gx: gx0, gy: gy0, size, keys, prev };
  if (boardVfx) {
    const tr = getVfxTransform();
    const col = teamColor(myTeamId);
    boardVfx.zoneFlash(gx0, gy0, col, tr, size);
    if (kind !== "zoneCapture") {
      boardVfx.lightningBurst(canvas.clientWidth, canvas.clientHeight);
    }
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
  }
  const dr = dirtyRectFromKeys(keys);
  scheduleDraw(dr ? { dirty: dr } : undefined);
}

function revertOptimisticWeapon() {
  if (!optimisticWeaponPending) return;
  const { keys, prev } = optimisticWeaponPending;
  optimisticWeaponPending = null;
  for (const k of keys) {
    const p = prev.get(k);
    if (p === undefined) pixels.delete(k);
    else pixels.set(k, p);
  }
}

/** Наш оптимистичный zoneFlash совпал с broadcast purchaseVfx — не дублировать VFX. */
function consumeDuplicatePurchaseVfx(msg) {
  if (!optimisticWeaponPending) return false;
  const o = optimisticWeaponPending;
  if ((msg.teamId | 0) !== (myTeamId | 0)) return false;
  if (msg.kind !== o.kind) return false;
  if ((Number(msg.gx) | 0) !== o.gx || (Number(msg.gy) | 0) !== o.gy) return false;
  const sz = typeof msg.size === "number" && Number.isFinite(msg.size) ? msg.size | 0 : 0;
  if (sz !== o.size) return false;
  optimisticWeaponPending = null;
  return true;
}

function draw(time = performance.now(), drawOpts = {}) {
  const _perf0 = perfDebug ? performance.now() : 0;
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const cell = BASE_CELL * scale;
  const lite = drawOpts.lite === true;
  const pulse = lite ? 0 : 0.5 + 0.5 * Math.sin(time * 0.0018);

  const vx0 = Math.max(0, Math.floor((0 - offsetX) / cell));
  const vy0 = Math.max(0, Math.floor((0 - offsetY) / cell));
  const vx1 = Math.min(gridW - 1, Math.ceil((w - offsetX) / cell));
  const vy1 = Math.min(gridH - 1, Math.ceil((h - offsetY) / cell));

  const dirtyGrid = drawOpts.dirtyGrid;
  const partial =
    !lite &&
    dirtyGrid != null &&
    dirtyGrid.gx0 <= dirtyGrid.gx1 &&
    dirtyGrid.gy0 <= dirtyGrid.gy1;

  let x0;
  let y0;
  let x1;
  let y1;
  if (partial) {
    const d = dirtyGrid;
    x0 = Math.max(vx0, d.gx0);
    y0 = Math.max(vy0, d.gy0);
    x1 = Math.min(vx1, d.gx1);
    y1 = Math.min(vy1, d.gy1);
    if (x0 > x1 || y0 > y1) {
      if (perfDebug) perfRecordDraw(performance.now() - _perf0, lite);
      return;
    }
  } else {
    x0 = vx0;
    y0 = vy0;
    x1 = vx1;
    y1 = vy1;
  }

  if (partial) {
    const pxClip = offsetX + x0 * cell;
    const pyClip = offsetY + y0 * cell;
    const pw = (x1 - x0 + 1) * cell;
    const ph = (y1 - y0 + 1) * cell;
    const rx = Math.floor(pxClip) - 2;
    const ry = Math.floor(pyClip) - 2;
    const rw = Math.ceil(pw) + 4;
    const rh = Math.ceil(ph) + 4;
    ctx.save();
    ctx.beginPath();
    ctx.rect(rx, ry, rw, rh);
    ctx.clip();
    ctx.fillStyle = "#050810";
    ctx.fillRect(rx, ry, rw, rh);
  } else {
    ctx.fillStyle = "#050810";
    ctx.fillRect(0, 0, w, h);
  }

  const online = wantOnline && getWsUrl();
  const visibleCellCount = (x1 - x0 + 1) * (y1 - y0 + 1);
  const drawGradientShine =
    !lite && (!online || visibleCellCount <= DRAW_DETAIL_GRADIENT_MAX_CELLS);
  const drawEdgeShimmer =
    !lite &&
    !partial &&
    online &&
    cell >= 3 &&
    visibleCellCount <= DRAW_DETAIL_EDGE_SHIMMER_MAX_CELLS;

  const teamColorById = online ? getTeamColorByIdMap() : null;

  const shNow = lite ? 0 : Date.now();

  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const key = `${gx},${gy}`;
      const idx = regionCells ? regionCells[gy * gridW + gx] : 2;
      let base;
      if (regionRgb && regionRgb.length === gridW * gridH * 3) {
        if (idx === 0) {
          base = countryColor(0);
        } else if (idx === 1) {
          base = countryColor(1);
        } else {
          const ri = (gy * gridW + gx) * 3;
          base = `rgb(${regionRgb[ri]},${regionRgb[ri + 1]},${regionRgb[ri + 2]})`;
        }
      } else {
        base = countryColor(idx);
      }
      const owner = pixels.get(key);
      const px = offsetX + gx * cell;
      const py = offsetY + gy * cell;
      const cw = Math.ceil(cell);
      const ch = Math.ceil(cell);

      ctx.fillStyle = base;
      ctx.fillRect(px, py, cw, ch);

      if (owner !== undefined) {
        if (online) {
          const tid = typeof owner === "number" ? owner : owner.teamId;
          const tc = teamColorById?.get(tid) ?? teamColor(tid);
          ctx.fillStyle = tc;
          ctx.fillRect(px, py, cw, ch);
          if (drawGradientShine) {
            const { r, g, b } = hexToRgb(tc);
            const lg = ctx.createLinearGradient(px, py, px + cw, py + ch);
            lg.addColorStop(0, `rgba(255,255,255,${0.06 + pulse * 0.04})`);
            lg.addColorStop(0.5, `rgba(${r},${g},${b},0.12)`);
            lg.addColorStop(1, `rgba(0,0,0,${0.12 + pulse * 0.04})`);
            ctx.fillStyle = lg;
            ctx.fillRect(px, py, cw, ch);
          }
          if (drawGradientShine && tid === myTeamId) {
            ctx.shadowColor = tc;
            ctx.shadowBlur = Math.min(18, cell * 0.45);
            ctx.strokeStyle = `rgba(255,255,255,${0.2 + pulse * 0.08})`;
            ctx.lineWidth = Math.max(1, cell * 0.06);
            ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
            ctx.shadowBlur = 0;
          }
          /* В lite (пан/зум) щиты и лишние stroke убраны — меньше работы на горячем пути. */
          if (!lite) {
            const sh = typeof owner === "object" && owner ? owner.shieldedUntil || 0 : 0;
            if (sh > shNow) {
              ctx.strokeStyle = `rgba(120, 220, 255, ${0.75 + pulse * 0.15})`;
              ctx.lineWidth = Math.max(1, cell * 0.06);
              ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
              if (drawGradientShine) {
                ctx.fillStyle = `rgba(100, 200, 255, ${0.06 + pulse * 0.03})`;
                ctx.fillRect(px, py, cw, ch);
              }
            }
          }
        } else {
          ctx.fillStyle = PALETTE[owner] ?? "#888";
          ctx.fillRect(px, py, cw, ch);
        }
      }
    }
  }

  if (drawEdgeShimmer) {
    const edgePhase = (Math.sin(time * 0.0022) + 1) * 0.5;
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const key = `${gx},${gy}`;
        const owner = pixels.get(key);
        if (!owner) continue;
        const tid = typeof owner === "number" ? owner : owner.teamId;
        const cw = Math.ceil(cell);
        const ch = Math.ceil(cell);
        const px = offsetX + gx * cell;
        const py = offsetY + gy * cell;
        const neighbors = [
          [1, 0],
          [0, 1],
        ];
        for (let i = 0; i < neighbors.length; i++) {
          const dx = neighbors[i][0];
          const dy = neighbors[i][1];
          const nk = `${gx + dx},${gy + dy}`;
          const ow = pixels.get(nk);
          const ntid = ow ? (typeof ow === "number" ? ow : ow.teamId) : null;
          if (ntid !== tid) {
            const ph = time * 0.003 + gx * 0.15 + gy * 0.15;
            const a = 0.08 + edgePhase * 0.12 * (0.5 + 0.5 * Math.sin(ph));
            ctx.strokeStyle = `rgba(255,255,255,${a})`;
            ctx.lineWidth = 1;
            ctx.beginPath();
            if (dx === 1) {
              ctx.moveTo(px + cw, py);
              ctx.lineTo(px + cw, py + ch);
            } else {
              ctx.moveTo(px, py + ch);
              ctx.lineTo(px + cw, py + ch);
            }
            ctx.stroke();
          }
        }
      }
    }
  }

  if (!lite && !partial && cell >= 6 && visibleCellCount <= 22000) {
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

  if (partial) {
    ctx.restore();
  }

  lastDrawVisibleCellCount = visibleCellCount;
  if (perfDebug) perfRecordDraw(performance.now() - _perf0, lite);
}

function placePixel(gx, gy) {
  if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) {
    notifyReject("out_of_bounds");
    return;
  }

  const online = wantOnline && getWsUrl();
  if (online && spectatorMode) {
    notifyReject("spectator");
    return;
  }
  if (online) {
    if (myTeamId == null) {
      notifyReject("no_team");
      showWelcomeOverlay();
      if (teamOverlay) teamOverlay.hidden = true;
      return;
    }
  }

  if (online && pendingMapAction) {
    if (pendingMapAction.type === "zoneCapture") {
      lastZoneGx = gx - 1;
      lastZoneGy = gy - 1;
      applyOptimisticWeapon("zoneCapture", gx, gy);
      wsSendJson({ type: "purchaseZoneCapture", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "massCapture") {
      lastZoneGx = gx - 2;
      lastZoneGy = gy - 2;
      applyOptimisticWeapon("massCapture", gx, gy);
      wsSendJson({ type: "purchaseMassCapture", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "zone12Capture") {
      lastZoneGx = gx - 5;
      lastZoneGy = gy - 5;
      applyOptimisticWeapon("zone12Capture", gx, gy);
      wsSendJson({ type: "purchaseZone12Capture", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
  }

  const now = Date.now();
  if (online && walletState) {
    const cd = getWalletActionCooldownMs();
    const la = getOnlineLastPixelActionAt();
    if (now < la + cd) {
      showCooldown(la + cd - now);
      return;
    }
  } else if (COOLDOWN_MS > 0 && now - lastPlaceAt < COOLDOWN_MS) {
    showCooldown(COOLDOWN_MS - (now - lastPlaceAt));
    return;
  }
  lastPlaceAt = now;

  if (online) {
    const pk = `${gx},${gy}`;
    optimisticPixelPending = { key: pk, prev: snapshotPixelCell(pk) };
    pixels.set(pk, { teamId: myTeamId, shieldedUntil: 0 });
    if (boardVfx) {
      boardVfx.popPixel(gx, gy, teamColor(myTeamId), getVfxTransform());
    }
    scheduleDraw({ dirty: { gx0: gx, gy0: gy, gx1: gx, gy1: gy } });
    sendPixelOnline(gx, gy);
    updateToolbarHud();
  } else {
    pixels.set(`${gx},${gy}`, selectedColor);
    if (boardVfx) {
      boardVfx.popPixel(gx, gy, PALETTE[selectedColor] ?? "#ffffff", getVfxTransform());
    }
    if (COOLDOWN_MS > 0) {
      updateToolbarHud();
    }
    schedulePersist();
    draw();
  }
}

function showCooldown(_ms) {
  /** Обратный отсчёт и «Готово» только в `#toolbar-pixel-timer` слева — не дублируем в шапке справа. */
  updateToolbarHud();
}

function setupToolbarSession() {
  if (!btnToolbarSession) return;
  btnToolbarSession.addEventListener("click", () => {
    const online = wantOnline && getWsUrl();
    if (online) {
      showWelcomeOverlay();
      if (teamOverlay) teamOverlay.hidden = true;
      return;
    }
    const runLocalClear = () => {
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
      draw();
      resizeCanvas();
    };
    const tg = window.Telegram?.WebApp;
    const q = "Очистить только локальную картинку на этом устройстве? Общая онлайн-карта не меняется.";
    if (typeof tg?.showConfirm === "function") {
      tg.showConfirm(q, (ok) => {
        if (ok) runLocalClear();
      });
    } else if (confirm(q)) {
      runLocalClear();
    }
  });
}

function setupGestures() {
  let pinchStartDist = 0;
  let pinchStartScale = 1;
  /** @type {{ x: number, y: number, t: number, ox: number, oy: number, panning: boolean } | null} */
  let oneFinger = null;
  /** Десктоп / мышь: панорама и тап (touch на canvas не даёт mousedown для пальца) */
  /** @type {{ x: number, y: number, t: number, ox: number, oy: number, panning: boolean } | null} */
  let mousePan = null;

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
          mapInteractionActive = true;
          scheduleCanvasFrame();
        }
      } else if (e.touches.length === 1 && oneFinger) {
        const t = e.touches[0];
        const dx = t.clientX - oneFinger.x;
        const dy = t.clientY - oneFinger.y;
        // Порог выше, иначе лёгкая дрожь пальца считается «панорамой» и тап не ставит пиксель
        if (Math.hypot(dx, dy) > 28) oneFinger.panning = true;
        if (oneFinger.panning) {
          offsetX = oneFinger.ox + dx;
          offsetY = oneFinger.oy + dy;
          mapInteractionActive = true;
          scheduleCanvasFrame();
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
        if (t) {
          const dx = t.clientX - oneFinger.x;
          const dy = t.clientY - oneFinger.y;
          const dt = Date.now() - oneFinger.t;
          const move = Math.hypot(dx, dy);
          // Тап: небольшое смещение и время — не опираемся на panning (иначе дрожь ломает клик)
          if (move < 32 && dt < 750) {
            const rect = canvas.getBoundingClientRect();
            const sx = t.clientX - rect.left;
            const sy = t.clientY - rect.top;
            const { gx, gy } = screenToGrid(sx, sy);
            placePixel(gx, gy);
          }
        }
        oneFinger = null;
      }
      if (e.touches.length === 0) {
        if (mapInteractionActive) endMapInteraction();
        schedulePersist();
      }
      e.preventDefault();
    },
    { passive: false }
  );

  canvas.addEventListener("touchcancel", () => {
    oneFinger = null;
    pinchStartDist = 0;
    mapInteractionActive = false;
    mapWheelActive = false;
    if (mapWheelEndTimer) {
      clearTimeout(mapWheelEndTimer);
      mapWheelEndTimer = 0;
    }
    if (canvasFrameRafId) {
      cancelAnimationFrame(canvasFrameRafId);
      canvasFrameRafId = 0;
    }
    drawFull();
    schedulePersist();
  });

  function onMouseMove(e) {
    if (!mousePan) return;
    const dx = e.clientX - mousePan.x;
    const dy = e.clientY - mousePan.y;
    if (Math.hypot(dx, dy) > 28) mousePan.panning = true;
    if (mousePan.panning) {
      offsetX = mousePan.ox + dx;
      offsetY = mousePan.oy + dy;
      mapInteractionActive = true;
      scheduleCanvasFrame();
    }
  }

  function onMouseUp(e) {
    if (!mousePan) return;
    const dx = e.clientX - mousePan.x;
    const dy = e.clientY - mousePan.y;
    const dt = Date.now() - mousePan.t;
    const move = Math.hypot(dx, dy);
    const wasPanning = mousePan.panning;
    mousePan = null;
    window.removeEventListener("mousemove", onMouseMove);
    window.removeEventListener("mouseup", onMouseUp);
    if (wasPanning) {
      endMapInteraction();
      schedulePersist();
      return;
    }
    if (move < 32 && dt < 750) {
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { gx, gy } = screenToGrid(sx, sy);
      placePixel(gx, gy);
    }
  }

  canvas.addEventListener("mousedown", (e) => {
    if (e.button !== 0) return;
    if (mousePan) return;
    mousePan = {
      x: e.clientX,
      y: e.clientY,
      t: Date.now(),
      ox: offsetX,
      oy: offsetY,
      panning: false,
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
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
      mapWheelActive = true;
      scheduleCanvasFrame();
      if (mapWheelEndTimer) clearTimeout(mapWheelEndTimer);
      mapWheelEndTimer = window.setTimeout(() => {
        mapWheelEndTimer = 0;
        endMapWheelInteraction();
      }, 140);
      schedulePersist();
    },
    { passive: false }
  );
}

async function bootstrap() {
  initTelegram();
  await loadRegions();
  loadFromStorage();
  migrateLegacySessionStorage();
  clearSoloFromSession();
  const os = loadOnlineSession();
  if (
    typeof os?.welcomeColorIdx === "number" &&
    os.welcomeColorIdx >= 0 &&
    os.welcomeColorIdx < PALETTE.length
  ) {
    welcomeColorIdx = os.welcomeColorIdx;
  }
  wantOnline = !!getWsUrl();
  buildPalette();
  setupPalettePickerUi();
  setFooterMode();
  setupReferralButton();
  setupWelcomeUi();
  setupTeamSettingsUi();
  setupCreateTeamUi();
  setupToolbarSession();
  setupGestures();
  setupEconomyUi();
  setupQuickBuyRail();
  renderQuickBuyRail();

  setInterval(updateRoundTimer, 1000);
  setInterval(updateToolbarHud, 300);
  updateToolbarHud();

  window.addEventListener("resize", scheduleResizeCanvas);
  setupStageLayoutSync();
  window.addEventListener("pagehide", () => {
    flushToStorage();
  });
  if (document.fonts?.ready) await document.fonts.ready;
  resizeCanvas();
  scheduleResizeCanvas();
  if (canvasVfx) boardVfx = createBoardVfx(canvasVfx);
  requestAnimationFrame(vfxLoop);
  connectWs();

  if (perfDebug) {
    window.__pixelBattlePerf = () => ({
      drawsLite: perfDrawsLite,
      drawsFull: perfDrawsFull,
      avgLiteMs: perfDrawsLite ? perfMsLiteSum / perfDrawsLite : 0,
      avgFullMs: perfDrawsFull ? perfMsFullSum / perfDrawsFull : 0,
      hint: "Консоль: лог каждые ~2 с. Включение: ?perf=1 или localStorage pixel-battle-perf=1",
    });
  }
}

bootstrap();
