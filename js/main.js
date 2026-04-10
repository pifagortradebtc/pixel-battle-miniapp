/**
 * Pixel Battle — карта мира, команды, WebSocket.
 * Локально: палитра кисти. Онлайн: соло и создатель команды меняют цвет снизу;
 * остальные в команде рисуют цветом команды (задаёт создатель).
 */

let gridW = 320;
let gridH = 320;
const BASE_CELL = 4;
const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
const COOLDOWN_MS = 0;

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

function getOrCreatePlayerKey() {
  try {
    const u = window.Telegram?.WebApp?.initDataUnsafe?.user;
    if (u && u.id != null) return `tg_${u.id}`;
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

const PALETTE = [
  "#1a1a2e", "#16213e", "#0f3460", "#533483", "#e94560",
  "#ff6b6b", "#feca57", "#48dbfb", "#1dd1a1", "#ffffff",
  "#c8d6e5", "#576574", "#8395a7", "#222f3e", "#b8e994", "#686de0",
];

const canvas = document.getElementById("board");
const ctx = canvas.getContext("2d", { alpha: false });
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
const welcomeNameInput = document.getElementById("welcome-name");
const welcomePaletteEl = document.getElementById("welcome-palette");
const btnWelcomeSolo = document.getElementById("btn-welcome-solo");
const btnWelcomeCreate = document.getElementById("btn-welcome-create");
const btnWelcomeJoin = document.getElementById("btn-welcome-join");
const teamOverlay = document.getElementById("team-overlay");
const btnTeamOverlayBack = document.getElementById("btn-team-overlay-back");
const teamListEl = document.getElementById("team-list");
const btnReferral = document.getElementById("btn-referral");
const btnLeaveTeam = document.getElementById("btn-leave-team");
const teamBadgeEmoji = document.getElementById("team-badge-emoji");
const teamSettingsOverlay = document.getElementById("team-settings-overlay");
const teamSettingsName = document.getElementById("team-settings-name");
const teamSettingsEmojiInput = document.getElementById("team-settings-emoji");
const teamSettingsEmojiPresets = document.getElementById("team-settings-emoji-presets");
const teamSettingsColorPaletteEl = document.getElementById("team-settings-color-palette");
const btnTeamSettings = document.getElementById("btn-team-settings");
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

/** @type {Map<string, number>} key "x,y" -> teamId (онлайн) или индекс палитры (локально) */
const pixels = new Map();

/** @type {Uint8Array | null} id страны на клетку, 0 = океан */
let regionCells = null;

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
/** После выхода из соло открыть список команд, а не приветственный экран */
let pendingLeaveToTeamList = false;

/** Экономика с сервера */
let walletState = null;
/** Ожидание тапа по карте: линия / щит / зона */
let pendingMapAction = null;

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
  } catch {
    regionCells = null;
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
  draw();
}

function syncWelcomeForRound() {
  const hideSolo = wantOnline && roundIndexMeta >= 2;
  if (btnWelcomeSolo) btnWelcomeSolo.hidden = hideSolo;
}

function countryColor(regionId) {
  if (regionId === 0) return "#071018";
  if (regionId === 1) return `hsl(38 32% 30%)`;
  const h = ((regionId - 2) * 53) % 360;
  return `hsl(${h} 36% 30%)`;
}

function teamColor(teamId) {
  const t = teamsMeta?.find((x) => x.id === teamId);
  return t ? t.color : "#888888";
}

function paletteIndexForHex(hex) {
  const i = PALETTE.indexOf(hex);
  return i >= 0 ? i : 5;
}

function setConnState(state, text) {
  connStatus.dataset.state = state;
  connStatus.textContent = text;
  connStatus.title = text;
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
    roundTimerEl.textContent = "Ожидание старта (отправьте боту «go»)";
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
  teamBadge.hidden = !online || !joined;
  if (spectatorBadgeEl) {
    spectatorBadgeEl.hidden = !online || !spectatorMode;
  }
  if (btnReferral) btnReferral.hidden = !online || !joined || isCurrentTeamSolo();
  if (btnTeamSettings) btnTeamSettings.hidden = !online || !joined || !canEditTeamSettings();
  if (btnLeaveTeam) {
    btnLeaveTeam.hidden = !online || !joined;
    if (online && joined) {
      btnLeaveTeam.textContent = isCurrentTeamSolo() ? "Войти в команду" : "Выйти из команды";
    }
  }
  if (online && joined) updateTeamBadge();
  if (showPalette && online && joined) syncPaletteSelectionFromTeam();
  refreshToolbarSessionButton();
  updateWalletBar();
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
      if (isCurrentTeamSolo()) {
        btnToolbarSession.textContent = "Войти в команду";
        btnToolbarSession.title =
          "Выйти из соло и открыть список команд — вступить или создать команду (карта на сервере сохраняется)";
      } else {
        btnToolbarSession.textContent = "Сменить команду";
        btnToolbarSession.title =
          "Выйти из текущей команды и снова выбрать соло или другую команду (карта для всех не сбрасывается)";
      }
    } else {
      btnToolbarSession.textContent = "Войти";
      btnToolbarSession.title = "Открыть экран входа: имя, соло или команда";
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
    teamBadgeName.textContent = t.name;
    teamBadgeName.style.removeProperty("color");
    const cnt = teamCounts[t.id] ?? 0;
    teamBadgeCount.textContent = `${cnt} / ${maxPerTeam}`;
    return;
  }
  if (s && s.teamId === myTeamId && s.cachedTeamName) {
    if (teamBadgeEmoji) teamBadgeEmoji.textContent = s.cachedEmoji || "";
    teamBadgeName.textContent = s.cachedTeamName;
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
    name.textContent = row.name || "";
    const meta = document.createElement("div");
    meta.className = "leaderboard__meta";
    const pct = typeof row.percent === "number" ? row.percent : 0;
    const players = typeof row.players === "number" ? row.players : 0;
    meta.textContent = `${formatPercent(pct)}% территории · ${players} чел.`;
    li.append(top, name, meta);
    leaderboardListEl.appendChild(li);
  }
}

function applyTeamDisplay(teamId, name, emoji, color) {
  if (!teamsMeta) return;
  const t = teamsMeta.find((x) => x.id === teamId);
  if (!t) return;
  t.name = name;
  t.emoji = emoji;
  if (color && typeof color === "string") t.color = color;
  draw();
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
    name.textContent = t.name;
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
  if (sess.solo && sess.soloResumeToken) {
    ws.send(
      JSON.stringify({
        type: "soloResume",
        teamId: sess.teamId,
        resumeToken: sess.soloResumeToken,
        playerKey: getOrCreatePlayerKey(),
      })
    );
  } else {
    ws.send(
      JSON.stringify({ type: "joinTeam", teamId: sess.teamId, playerKey: getOrCreatePlayerKey() })
    );
  }
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
 * Реферал: ?team= или ?ref= (число id команды), либо Telegram Mini App start_param: team_1, team1, t1
 */
function getReferralTeamId() {
  const q = new URLSearchParams(location.search);
  const raw = q.get("team") ?? q.get("ref");
  if (raw != null && raw !== "") {
    const n = Number(raw);
    if (Number.isFinite(n) && n === Math.floor(n)) return n;
  }
  const tg = window.Telegram?.WebApp;
  const sp = tg?.initDataUnsafe?.start_param;
  if (sp && typeof sp === "string") {
    const s = sp.trim();
    const m = /^team_?(\d+)$/i.exec(s) ?? /^t(\d+)$/i.exec(s);
    if (m) return Number(m[1]);
  }
  return null;
}

function stripTeamFromUrl() {
  try {
    const u = new URL(location.href);
    if (!u.searchParams.has("team") && !u.searchParams.has("ref")) return;
    u.searchParams.delete("team");
    u.searchParams.delete("ref");
    const qs = u.searchParams.toString();
    history.replaceState({}, "", u.pathname + (qs ? `?${qs}` : "") + u.hash);
  } catch {
    /* ignore */
  }
}

function buildWebReferralUrl() {
  if (myTeamId == null) return "";
  const u = new URL(location.href);
  u.searchParams.set("team", String(myTeamId));
  u.searchParams.delete("ref");
  return u.toString();
}

function buildTelegramReferralUrl() {
  const bot = document.querySelector('meta[name="pixel-battle-tg-bot"]')?.getAttribute("content")?.trim();
  const app = document.querySelector('meta[name="pixel-battle-tg-app"]')?.getAttribute("content")?.trim();
  if (!bot || !app || myTeamId == null) return null;
  const cleanBot = bot.replace(/^@/, "");
  const cleanApp = app.replace(/^\//, "");
  return `https://t.me/${cleanBot}/${cleanApp}?startapp=team_${myTeamId}`;
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
  if (!btnReferral) return;
  btnReferral.addEventListener("click", () => {
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

function buildWelcomePalette() {
  buildSwatchPalette(welcomePaletteEl, welcomeColorIdx, (i) => {
    welcomeColorIdx = i;
    saveOnlineSession({ welcomeColorIdx: i });
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

function submitWelcomeSolo() {
  if (sessionRestorePending) {
    const tg = window.Telegram?.WebApp;
    const m = "Подождите секунду — восстанавливается сессия.";
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    else alert(m);
    return;
  }
  const name = welcomeNameInput?.value.trim() ?? "";
  if (!name) {
    const tg = window.Telegram?.WebApp;
    const msg = "Введите имя.";
    if (typeof tg?.showAlert === "function") tg.showAlert(msg);
    else alert(msg);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  saveOnlineSession({ playerName: name, welcomeColorIdx });
  ws.send(
    JSON.stringify({
      type: "soloPlay",
      name,
      color: PALETTE[welcomeColorIdx],
      playerKey: getOrCreatePlayerKey(),
    })
  );
}

function setupWelcomeUi() {
  buildWelcomePalette();
  welcomeNameInput?.addEventListener("input", () => {
    const v = welcomeNameInput.value.trim();
    if (v) saveOnlineSession({ playerName: v });
  });
  btnWelcomeSolo?.addEventListener("click", submitWelcomeSolo);
  btnWelcomeCreate?.addEventListener("click", () => {
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    openCreateTeamOverlay(true);
  });
  btnWelcomeJoin?.addEventListener("click", () => {
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    if (teamOverlay) teamOverlay.hidden = false;
  });
  btnTeamOverlayBack?.addEventListener("click", () => {
    if (teamOverlay) teamOverlay.hidden = true;
    if (welcomeOverlay) welcomeOverlay.hidden = false;
  });
}

function setupCreateTeamUi() {
  buildCreateTeamEmojiPresets();
  btnOpenCreateTeam?.addEventListener("click", () => openCreateTeamOverlay(false));
  btnCreateTeamCancel?.addEventListener("click", () => {
    closeCreateTeamOverlay();
    if (createTeamFromWelcome) {
      if (welcomeOverlay) welcomeOverlay.hidden = false;
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
  btnTeamSettings?.addEventListener("click", openTeamSettings);
  btnTeamSettingsCancel?.addEventListener("click", closeTeamSettings);
  btnTeamSettingsSave?.addEventListener("click", saveTeamSettings);
  teamSettingsOverlay?.addEventListener("click", (e) => {
    if (e.target === teamSettingsOverlay) closeTeamSettings();
  });
}

function requestLeaveTeam() {
  const tg = window.Telegram?.WebApp;
  const solo = isCurrentTeamSolo();
  const run = () => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (solo) pendingLeaveToTeamList = true;
    ws.send(JSON.stringify({ type: "leaveTeam", playerKey: getOrCreatePlayerKey() }));
  };
  const text = solo
    ? "Чтобы вступить в команду, вы выходите из соло. Ваши пиксели на карте остаются. Продолжить?"
    : "Выйти из команды? Затем можно создать свою или вступить в другую.";
  if (typeof tg?.showConfirm === "function") {
    tg.showConfirm(text, (ok) => {
      if (ok) run();
    });
  } else if (confirm(text)) {
    run();
  }
}

function setupLeaveTeamUi() {
  btnLeaveTeam?.addEventListener("click", requestLeaveTeam);
}

function onMeta(msg) {
  teamsMeta = msg.teams || [];
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
    const savedTeamId = sess?.teamId;
    if (savedTeamId != null) {
      beginSessionRestore();
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      tryRestoreSession();
    } else {
      endSessionRestore();
      if (welcomeOverlay) welcomeOverlay.hidden = false;
      teamOverlay.hidden = true;
    }
    setFooterMode();
  });
}

function notifyReject(reason) {
  const map = {
    out_of_bounds: "Сюда нельзя (вне карты).",
    cooldown: "Слишком часто.",
    "cooldown not ready": "Кулдаун: подождите до следующего хода.",
    "pixel is shielded": "Пиксель под щитом.",
    no_team: "Сначала выберите команду.",
    spectator: "Режим наблюдения: пиксели ставить нельзя.",
    not_eligible: "Вы не прошли в этот раунд турнира.",
    need_telegram: "Откройте игру из Telegram Mini App (нужна подпись initData).",
    rate_limited: "Слишком много действий подряд. Подождите секунду.",
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
    "speed boost already active": "Ускорение уже активно.",
    "pixel is shielded": "Пиксель под щитом.",
    "not your pixel": "Можно защитить только свой пиксель.",
    "shield zone already active": "Зона щита уже активна.",
    "raid boost cannot be used": "Рейд или другой буст уже активен.",
    "team_boost blocked": "Сначала дождитесь окончания рейда.",
    "line capture cooldown": "Линия: подождите перед повтором.",
    "cooldown not ready": "Сначала дождитесь обычного кулдауна.",
    "zones overlap": "Зона пересекается с чужой.",
  };
  notifyReject(m[reason] || reason);
}

function applyWalletFromServer(msg) {
  walletState = msg;
  updateWalletBar();
  updateShopAvailability();
}

function syncShopHeaderBalance() {
  const el = document.getElementById("shop-display-balance");
  if (!el) return;
  const online = wantOnline && getWsUrl();
  if (!online || !walletState) {
    el.textContent = "—";
    return;
  }
  if (walletState.devUnlimited) el.textContent = "∞";
  else {
    const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
    el.textContent = b.toFixed(2);
  }
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

function updateWalletBar() {
  if (!walletBalanceEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || !walletState) {
    walletBalanceEl.hidden = true;
    if (btnDeposit) btnDeposit.hidden = true;
    if (btnShop) btnShop.hidden = true;
    syncShopHeaderBalance();
    syncShopDepositButton();
    return;
  }
  walletBalanceEl.hidden = false;
  if (btnDeposit) btnDeposit.hidden = spectatorMode || !!walletState.devUnlimited;
  if (btnShop) btnShop.hidden = spectatorMode;
  if (walletState.devUnlimited) {
    walletBalanceEl.textContent = "💰 ∞ USDT (тест)";
    walletBalanceEl.title = "Режим теста на сервере: бесконечный баланс";
  } else {
    const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
    walletBalanceEl.textContent = `💰 ${b.toFixed(2)} USDT`;
  }
  const cd = walletState.cooldownMs || 30000;
  const la = walletState.lastActionAt || 0;
  const left = Math.max(0, la + cd - Date.now());
  if (left > 500 && !spectatorMode) {
    walletBalanceEl.title = `След. ход ~${(left / 1000).toFixed(1)} с`;
  } else {
    walletBalanceEl.title = "Внутренний баланс (без вывода)";
  }
  syncShopHeaderBalance();
  syncShopDepositButton();
}

function updateShopAvailability() {
  if (!shopStageHint || !walletState) return;
  const st = walletState.tournamentStage || "MASS_BATTLE";
  const hints = {
    MASS_BATTLE: "Стадия: массовая битва — все покупки доступны.",
    SEMI_FINAL: "Полуфинал: без линии, рейда и зоны щита.",
    FINAL: "Финал: только апгрейд кулдауна и щит на пиксель.",
    DUEL: "Дуэль 1 на 1: без платных преимуществ.",
    GRAND_FINAL: "Гранд-финал / зритель: без платных преимуществ.",
  };
  shopStageHint.textContent = hints[st] || st;
  const dis =
    walletState.devUnlimited === true
      ? false
      : st === "GRAND_FINAL" || st === "DUEL" || spectatorMode;
  const semi = st === "SEMI_FINAL";
  const fin = st === "FINAL";
  document.querySelectorAll(".shop-btn").forEach((btn) => {
    btn.disabled = !!dis;
  });
  const lineIds = ["shop-line-up", "shop-line-down", "shop-line-left", "shop-line-right"];
  lineIds.forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !!dis || semi || fin;
  });
  ["shop-raid", "shop-zone-mode"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !!dis || semi || fin;
  });
  ["shop-speed", "shop-team-boost"].forEach((id) => {
    const el = document.getElementById(id);
    if (el) el.disabled = !!dis || fin;
  });
  const sh = document.getElementById("shop-shield-mode");
  if (sh) sh.disabled = !!dis || fin;
  const up = document.getElementById("shop-upgrade");
  if (up) up.disabled = !!dis;
  if (shopEffects) {
    const te = walletState.teamEffects;
    const now = Date.now();
    const parts = [];
    if (te) {
      if (te.teamBoostUntil > now) parts.push(`Командный буст до ${fmtTime(te.teamBoostUntil)}`);
      if (te.raidBoostUntil > now) parts.push(`Рейд до ${fmtTime(te.raidBoostUntil)}`);
      if (te.shieldZone && te.shieldZone.until > now) {
        parts.push(`Зона щита до ${fmtTime(te.shieldZone.until)}`);
      }
    }
    if (walletState.speedBoostUntil > now) parts.push(`Личное ускорение до ${fmtTime(walletState.speedBoostUntil)}`);
    shopEffects.textContent = parts.length ? parts.join(" · ") : "Нет активных бустов.";
  }
}

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function setupEconomyUi() {
  btnDeposit?.addEventListener("click", () => {
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
      if (depositCustom) depositCustom.value = String(a);
    });
  });
  depositSubmit?.addEventListener("click", async () => {
    if (depositSubmit?.disabled) return;
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
    if (shopOverlay) shopOverlay.hidden = true;
    if (depositOverlay) depositOverlay.hidden = false;
    if (depositError) depositError.hidden = true;
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
      if (action === "speed") {
        wsSendJson({ type: "activateSpeedBoost" });
        return;
      }
      if (action === "upgrade") {
        wsSendJson({ type: "purchaseCooldownUpgrade" });
        return;
      }
      if (action === "teamBoost") {
        wsSendJson({ type: "purchaseTeamBoost" });
        return;
      }
      if (action === "raid") {
        wsSendJson({ type: "purchaseRaidBoost" });
        return;
      }
      if (action === "shieldMode") {
        pendingMapAction = { type: "shieldPixel" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "zoneMode") {
        pendingMapAction = { type: "zone" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "line") {
        pendingMapAction = { type: "line", dir: btn.dataset.dir || "up" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
      }
    });
  });

  setInterval(() => {
    if (walletState) updateWalletBar();
  }, 1000);
}

function setPendingHint() {
  const text = (() => {
    if (!pendingMapAction) return "";
    if (pendingMapAction.type === "line") return `Линия ${pendingMapAction.dir}: тап по карте`;
    if (pendingMapAction.type === "shieldPixel") return "Щит: тап по своему пикселю";
    if (pendingMapAction.type === "zone") return "Зона 4×4: тап по центру";
    return "";
  })();
  if (shopPending) {
    shopPending.hidden = !text;
    shopPending.textContent = text;
  }
  if (cooldownLabel && text) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = text;
  } else if (cooldownLabel && !text) {
    cooldownLabel.hidden = true;
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
    myTeamId = sess?.teamId ?? null;
    if (leaderboardPanel) leaderboardPanel.hidden = false;
    setFooterMode();
    updateRoundTimer();
    try {
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(
          JSON.stringify({
            type: "clientProfile",
            playerKey: getOrCreatePlayerKey(),
            telegramUser: getTelegramUserForServer(),
            initData: getTelegramInitDataForServer(),
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
      spectatorMode = true;
      gameFinishedMeta = true;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : 21;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : 21;
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
        const text = "Этот аккаунт не допущен в текущий раунд турнира.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
      }
      if (msg.reason === "rate") {
        const tg = window.Telegram?.WebApp;
        const text = "Слишком много попыток с токеном. Подождите минуту.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
      }
      return;
    }
    if (msg.type === "playRejected") {
      if (msg.reason === "spectator") spectatorMode = true;
      notifyReject(msg.reason === "spectator" ? "spectator" : msg.reason || "");
      setFooterMode();
      return;
    }

    if (msg.type === "meta") {
      onMeta(msg);
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
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      syncPaletteSelectionFromTeam();
      return;
    }
    if (msg.type === "created") {
      endSessionRestore();
      teamsMeta = msg.teams || [];
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
            "На сервере оставалась сессия в команде — выход выполнен. Нажмите «Играть соло» ещё раз.";
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
        fields: "Введите имя и выберите цвет.",
        limit: "Достигнут лимит команд на сервере.",
        round:
          "В финале команд (команды по 2 человека) соло недоступно — создайте команду из двух или вступите в существующую.",
      };
      const text = map[msg.reason] || "Не удалось начать соло.";
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
      else alert(text);
      return;
    }
    if (msg.type === "soloJoined") {
      endSessionRestore();
      teamsMeta = msg.teams || [];
      teamCounts = msg.teamCounts || {};
      myTeamId = msg.teamId;
      {
        const patch = {
          teamId: msg.teamId,
          solo: true,
          cachedTeamName: msg.team?.name,
          cachedEmoji: msg.team?.emoji,
        };
        if (typeof msg.resumeToken === "string" && msg.resumeToken.length > 0) {
          patch.soloResumeToken = msg.resumeToken;
        }
        saveOnlineSession(patch);
      }
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      teamOverlay.hidden = true;
      closeCreateTeamOverlay();
      stripTeamFromUrl();
      rebuildTeamList();
      setFooterMode();
      schedulePersist();
      draw();
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
        duel: "Финальная дуэль 1 на 1 — только соло; публичные команды недоступны.",
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
        solo: "В соло-режиме имя и цвет задаются при входе. Выйдите и зайдите снова или вступите в команду.",
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
            "На сервере уже была активная команда — выход выполнен. Нажмите «Играть соло» или вступите в команду снова.";
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
      if (msg.reason === "round") {
        const tg = window.Telegram?.WebApp;
        const text =
          "В финале команд (команды по 2) соло недоступно — создайте команду из двух человек или вступите в существующую.";
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        if (welcomeOverlay) welcomeOverlay.hidden = false;
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
      if (welcomeOverlay) welcomeOverlay.hidden = false;
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
        const text = "В дуэли 1 на 1 нельзя вступать в чужие команды — только своё соло.";
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
      pendingLeaveToTeamList = false;
      if (openTeamList) {
        if (welcomeOverlay) welcomeOverlay.hidden = true;
        teamOverlay.hidden = false;
      } else {
        if (welcomeOverlay) welcomeOverlay.hidden = false;
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
      pendingLeaveToTeamList = false;
      return;
    }
    if (msg.type === "full") {
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
      draw();
      if (wantOnline) flushToStorage();
      else schedulePersist();
      return;
    }
    if (msg.type === "pixel") {
      pixels.set(`${msg.x},${msg.y}`, {
        teamId: msg.t,
        shieldedUntil: typeof msg.shieldedUntil === "number" ? msg.shieldedUntil : 0,
      });
      draw();
      schedulePersist();
      return;
    }
    if (msg.type === "wallet") {
      applyWalletFromServer(msg);
      return;
    }
    if (msg.type === "purchaseError") {
      notifyPurchaseError(msg.reason || "");
      return;
    }
    if (msg.type === "teamEffect") {
      if (walletState && msg.teamId === myTeamId && walletState.teamEffects) {
        const te = walletState.teamEffects;
        if (msg.kind === "teamBoost") te.teamBoostUntil = msg.until;
        if (msg.kind === "raidBoost") te.raidBoostUntil = msg.until;
        if (msg.kind === "shieldZone") {
          te.shieldZone = { cx: msg.cx, cy: msg.cy, until: msg.until };
        }
        updateShopAvailability();
      }
      return;
    }
    if (msg.type === "pixelReject") {
      if (msg.reason !== "cooldown" && msg.reason !== "cooldown not ready") {
        lastPlaceAt = 0;
      }
      notifyReject(msg.reason || "");
      return;
    }
  });

  ws.addEventListener("close", () => {
    clearTimeout(connectingHangTimer);
    connectingHangTimer = null;
    ws = null;
    const sess = loadOnlineSession();
    myTeamId = sess?.teamId ?? null;
    teamsMeta = null;
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

function draw() {
  const w = canvas.clientWidth;
  const h = canvas.clientHeight;
  const cell = BASE_CELL * scale;

  ctx.fillStyle = "#050810";
  ctx.fillRect(0, 0, w, h);

  const x0 = Math.max(0, Math.floor((0 - offsetX) / cell));
  const y0 = Math.max(0, Math.floor((0 - offsetY) / cell));
  const x1 = Math.min(gridW - 1, Math.ceil((w - offsetX) / cell));
  const y1 = Math.min(gridH - 1, Math.ceil((h - offsetY) / cell));

  const online = wantOnline && getWsUrl();

  for (let gy = y0; gy <= y1; gy++) {
    for (let gx = x0; gx <= x1; gx++) {
      const key = `${gx},${gy}`;
      const idx = regionCells ? regionCells[gy * gridW + gx] : 2;
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
          const tid = typeof owner === "number" ? owner : owner.teamId;
          ctx.fillStyle = teamColor(tid);
          ctx.fillRect(px, py, cw, ch);
          const sh = typeof owner === "object" && owner ? owner.shieldedUntil || 0 : 0;
          if (sh > Date.now()) {
            ctx.strokeStyle = "rgba(80, 200, 255, 0.85)";
            ctx.lineWidth = Math.max(1, cell * 0.08);
            ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
          }
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
      if (welcomeOverlay) welcomeOverlay.hidden = false;
      if (teamOverlay) teamOverlay.hidden = true;
      return;
    }
  }

  if (online && pendingMapAction) {
    if (pendingMapAction.type === "line") {
      wsSendJson({ type: "lineCapture", x: gx, y: gy, dir: pendingMapAction.dir });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "zone") {
      wsSendJson({ type: "purchaseTeamShieldZone", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "shieldPixel") {
      wsSendJson({ type: "purchaseShieldPixel", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
  }

  const now = Date.now();
  if (online && walletState) {
    const cd = walletState.cooldownMs || 30000;
    const la = walletState.lastActionAt || 0;
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
    sendPixelOnline(gx, gy);
  } else {
    pixels.set(`${gx},${gy}`, selectedColor);
    if (COOLDOWN_MS > 0) {
      cooldownLabel.hidden = false;
      cooldownLabel.textContent = `Пауза ${(COOLDOWN_MS / 1000).toFixed(1)} с`;
      setTimeout(() => {
        cooldownLabel.hidden = true;
      }, 400);
    }
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

function setupToolbarSession() {
  if (!btnToolbarSession) return;
  btnToolbarSession.addEventListener("click", () => {
    const online = wantOnline && getWsUrl();
    if (online) {
      if (myTeamId != null) {
        requestLeaveTeam();
      } else {
        if (welcomeOverlay) welcomeOverlay.hidden = false;
        if (teamOverlay) teamOverlay.hidden = true;
      }
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
        // Порог выше, иначе лёгкая дрожь пальца считается «панорамой» и тап не ставит пиксель
        if (Math.hypot(dx, dy) > 28) oneFinger.panning = true;
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
  migrateLegacySessionStorage();
  const os = loadOnlineSession();
  if (os?.playerName && welcomeNameInput) welcomeNameInput.value = os.playerName;
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
  setupLeaveTeamUi();
  setupCreateTeamUi();
  setupToolbarSession();
  setupGestures();
  setupEconomyUi();

  setInterval(updateRoundTimer, 1000);

  window.addEventListener("resize", resizeCanvas);
  window.addEventListener("pagehide", () => {
    flushToStorage();
  });
  if (document.fonts?.ready) await document.fonts.ready;
  resizeCanvas();
  connectWs();
}

bootstrap();
