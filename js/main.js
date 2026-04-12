/**
 * Pixel Battle — карта мира, команды, WebSocket.
 * Локально: палитра кисти. Онлайн: цвет команды выбирается только при создании (TEAM_CREATE_PALETTE);
 * после создания смена запрещена — в панели только индикатор из метаданных.
 */

import { createBoardVfx, spawnFloatingText } from "./vfx.js";
import {
  initEventPresentation,
  resetEventPresentationForRound,
  notifyRoundEventFromServer,
  syncPremiumBattlePresentation,
  fillPremiumAlertPanel,
  notifySeismicPreview,
  enqueueBaseCapturedPresentation,
  enqueueTerritoryCapturePresentation,
} from "./event-presentation.js";
import {
  BASE_ACTION_COOLDOWN_SEC,
  getCurrentCooldownMs,
  getEffectiveRecoverySec,
  PRICES_QUANT,
  REFERRAL_JOIN_INVITER_QUANT,
} from "../lib/tournament-economy.js";
import {
  flagCellFromSpawn,
  FLAG_BASE_MAX_HP,
  FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS,
  FLAG_REGEN_DURATION_MS,
  FLAG_REGEN_IDLE_MS,
  FLAG_VISUAL_CELLS_ABOVE,
  computeEffectiveBaseHp,
  toEpochMsSafe,
} from "../lib/flag-capture.js";
import { isWorldMapWaterPixel } from "../lib/world-map-water.js";
import { pointInRect, tournamentCompressionMultiplierForCell } from "../lib/battle-events.js";
import { TERRITORY_ISOLATION_GRACE_MS } from "../lib/territory-isolation.js";

let gridW = 360;
let gridH = 360;
const BASE_CELL = 4;
const MIN_SCALE = 0.35;
const MAX_SCALE = 8;
/** Предел сдвига карты (px) — защита от NaN/∞ при зуме в десктопном WebView. */
const MAP_VIEW_OFFSET_LIM = 8_000_000;
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

/** 16 ярких цветов — только локальная кисть (не путать с цветом команды). */
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

/** 30 цветов при создании команды — тот же набор, что TEAM_CREATE_COLORS на сервере (регистр не важен). */
const TEAM_CREATE_PALETTE = [
  "#FF1744",
  "#FF3D00",
  "#FF6D00",
  "#FFC400",
  "#FFEA00",
  "#C6FF00",
  "#76FF03",
  "#00E676",
  "#00C853",
  "#00BFA5",
  "#00B8D4",
  "#00E5FF",
  "#00B0FF",
  "#2979FF",
  "#304FFE",
  "#6200EA",
  "#651FFF",
  "#AA00FF",
  "#D500F9",
  "#E040FB",
  "#F50057",
  "#E91E63",
  "#C51162",
  "#FF4081",
  "#18FFFF",
  "#64FFDA",
  "#EEFF41",
  "#FFAB40",
  "#000000",
  "#FFFFFF",
];

const canvas = document.getElementById("board");
/** desynchronized: true давал мигание/чёрные полосы при зуме в Telegram Desktop (Chromium WebView); стабильный композитинг важнее. */
const ctx = canvas.getContext("2d", { alpha: false, desynchronized: false });
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
const teamBadgeColorEl = document.getElementById("team-badge-color");
const btnReferral = document.getElementById("btn-referral");
const teamSettingsOverlay = document.getElementById("team-settings-overlay");
const teamSettingsName = document.getElementById("team-settings-name");
const teamSettingsEmojiInput = document.getElementById("team-settings-emoji");
const teamSettingsEmojiPresets = document.getElementById("team-settings-emoji-presets");
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
const browserTelegramInviteOverlay = document.getElementById("browser-telegram-invite-overlay");
const browserTelegramInviteHint = document.getElementById("browser-telegram-invite-hint");
const browserTelegramInviteOpen = document.getElementById("browser-telegram-invite-open");
const browserTelegramInviteDismiss = document.getElementById("browser-telegram-invite-dismiss");
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
const defeatOverlayEl = document.getElementById("defeat-overlay");
const defeatOverlayTextEl = document.getElementById("defeat-overlay-text");
const defeatActionsReenterEl = document.getElementById("defeat-actions-reenter");
const defeatActionsSpectatorEl = document.getElementById("defeat-actions-spectator");
const defeatBtnCreate = document.getElementById("defeat-btn-create");
const defeatBtnJoin = document.getElementById("defeat-btn-join");
const defeatBtnDismiss = document.getElementById("defeat-btn-dismiss");
const defeatOverlayTitleEl = document.getElementById("defeat-overlay-title");
const territoryDramaBannerEl = document.getElementById("territory-drama-banner");
const seismicWarningBannerEl = document.getElementById("seismic-warning-banner");
const placementFeedbackBannerEl = document.getElementById("placement-feedback-banner");
const territoryIsolationHudEl = document.getElementById("territory-isolation-hud");
const defeatFlashEl = document.getElementById("defeat-flash");
const stageWrapEl = document.getElementById("stage-wrap");
const btnToolbarBase = document.getElementById("btn-toolbar-base");
const roundStartSplashEl = document.getElementById("round-start-splash");
const roundStartSplashKickerEl = document.getElementById("round-start-splash-kicker");
const roundStartSplashTitleEl = document.getElementById("round-start-splash-title");
const tournamentWarmupOverlayEl = document.getElementById("tournament-warmup-overlay");
const tournamentWarmupTitleEl = document.getElementById("tournament-warmup-title");
const tournamentWarmupCountdownEl = document.getElementById("tournament-warmup-countdown");
const tournamentWarmupBadgeEl = document.getElementById("tournament-warmup-badge");
const tournamentWarmupBodyEl = document.getElementById("tournament-warmup-body");
const roundEndedOverlayEl = document.getElementById("round-ended-overlay");
const roundEndedWinnerEl = document.getElementById("round-ended-winner");
const roundEndedScoreEl = document.getElementById("round-ended-score");
const roundEndedBoardEl = document.getElementById("round-ended-board");
const roundEndedNextEl = document.getElementById("round-ended-next");
const roundEndedDismissBtn = document.getElementById("round-ended-dismiss");
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
/** Откуда открыли форму создания команды — «Назад» ведёт на welcome или список команд */
let createTeamFromWelcome = false;
/** Индекс в TEAM_CREATE_PALETTE при создании команды */
let createTeamColorIdx = 0;
let scale = 1;
let offsetX = 0;
let offsetY = 0;
let lastPlaceAt = 0;
/** Подсветка базы + стрелка после входа в команду (мс по Date.now()). */
let teamSpawnOnboardUntil = 0;
/** Таймер скрытия подсказки у базы */
let teamSpawnHintTimer = 0;
/** Задержка перед оверлеем поражения (мс): время на VFX взрыва. */
const TEAM_DEFEAT_UI_DELAY_MS = 780;
/** @type {ReturnType<typeof setTimeout> | null} */
let teamDefeatUiTimer = null;
/** Повторная подсветка базы и стрелки после неверного клика. */
let baseReminderUntil = 0;
/** Красная пульсация оставшейся территории (мало клеток). */
let myTerritoryDangerUntil = 0;
/** Сильная пульсация при одной клетке. */
let myTerritoryLastCellUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let territoryBannerHideTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let seismicBannerHideTimer = null;
/** Автоскрытие алертов «база / последняя клетка» (мс). */
const ALERT_AUTO_HIDE_MS = 2000;
const ALERT_SWIPE_MIN_PX = 44;
const ALERT_FLY_OUT_PX = 180;

/** @type {{ territory: { cleanup: (() => void) | null }; flag: { cleanup: (() => void) | null }; seismic: { cleanup: (() => void) | null } }} */
const swipeDismissSlots = {
  territory: { cleanup: null },
  flag: { cleanup: null },
  seismic: { cleanup: null },
};

function detachSwipeDismissSlot(slot) {
  const o = swipeDismissSlots[slot];
  if (o.cleanup) {
    o.cleanup();
    o.cleanup = null;
  }
}

function resetDismissibleBannerNode(el) {
  if (!el) return;
  el.classList.remove("is-alert-fly-out");
  el.style.removeProperty("transform");
  el.style.removeProperty("opacity");
  el.style.removeProperty("transition");
}

function hideTerritoryDramaBannerNow() {
  if (!territoryDramaBannerEl) return;
  if (territoryBannerHideTimer) {
    clearTimeout(territoryBannerHideTimer);
    territoryBannerHideTimer = null;
  }
  detachSwipeDismissSlot("territory");
  resetDismissibleBannerNode(territoryDramaBannerEl);
  territoryDramaBannerEl.hidden = true;
  territoryDramaBannerEl.classList.remove("event-banner--critical");
}

function hideFlagAlertBannerNow() {
  const el = document.getElementById("flag-alert-banner");
  if (!el) return;
  if (showFlagAlertBanner._hideTimer) {
    clearTimeout(showFlagAlertBanner._hideTimer);
    showFlagAlertBanner._hideTimer = null;
  }
  detachSwipeDismissSlot("flag");
  resetDismissibleBannerNode(el);
  el.hidden = true;
}

function flyOutDismissibleBanner(el, dirX, dirY, hideNow) {
  const mult = 2.4;
  const tx = dirX * ALERT_FLY_OUT_PX * mult;
  const ty = dirY * ALERT_FLY_OUT_PX * mult;
  el.classList.add("is-alert-fly-out");
  el.style.transition = "transform 0.32s cubic-bezier(0.4, 0, 0.2, 1), opacity 0.32s ease-out";
  requestAnimationFrame(() => {
    el.style.transform = `translate(${tx}px, ${ty}px)`;
    el.style.opacity = "0";
  });
  window.setTimeout(hideNow, 340);
}

/**
 * Смахивание влево / вправо / вверх (вниз игнорируем).
 * @param {"territory" | "flag" | "seismic"} slot
 */
function attachSwipeDismissSlot(slot, el, hideNow) {
  detachSwipeDismissSlot(slot);
  let startX = 0;
  let startY = 0;
  let tracking = false;
  let capturedId = /** @type {number | null} */ (null);

  const onDown = (e) => {
    if (e.pointerType === "mouse" && e.button !== 0) return;
    tracking = true;
    startX = e.clientX;
    startY = e.clientY;
    capturedId = e.pointerId;
    try {
      el.setPointerCapture(e.pointerId);
    } catch {
      /* ignore */
    }
  };

  const onUp = (e) => {
    if (!tracking) return;
    const dx = e.clientX - startX;
    const dy = e.clientY - startY;
    const adx = Math.abs(dx);
    const ady = Math.abs(dy);
    tracking = false;
    if (capturedId != null) {
      try {
        el.releasePointerCapture(capturedId);
      } catch {
        /* ignore */
      }
      capturedId = null;
    }
    if (Math.max(adx, ady) < ALERT_SWIPE_MIN_PX) return;
    let ux = 0;
    let uy = 0;
    if (adx >= ady) {
      ux = dx > 0 ? 1 : -1;
    } else if (dy < 0) {
      uy = -1;
    } else {
      return;
    }
    if (slot === "territory" && territoryBannerHideTimer) {
      clearTimeout(territoryBannerHideTimer);
      territoryBannerHideTimer = null;
    }
    if (slot === "flag" && showFlagAlertBanner._hideTimer) {
      clearTimeout(showFlagAlertBanner._hideTimer);
      showFlagAlertBanner._hideTimer = null;
    }
    if (slot === "seismic" && seismicBannerHideTimer) {
      clearTimeout(seismicBannerHideTimer);
      seismicBannerHideTimer = null;
    }
    flyOutDismissibleBanner(el, ux, uy, hideNow);
  };

  const onCancel = () => {
    if (capturedId != null) {
      try {
        el.releasePointerCapture(capturedId);
      } catch {
        /* ignore */
      }
      capturedId = null;
    }
    tracking = false;
  };

  el.addEventListener("pointerdown", onDown);
  el.addEventListener("pointerup", onUp);
  el.addEventListener("pointercancel", onCancel);

  swipeDismissSlots[slot].cleanup = () => {
    el.removeEventListener("pointerdown", onDown);
    el.removeEventListener("pointerup", onUp);
    el.removeEventListener("pointercancel", onCancel);
    tracking = false;
    capturedId = null;
  };
}

/** Скрытие баннера отклонённого действия (всегда видимый фидбек, не только Telegram). */
/** @type {ReturnType<typeof setTimeout> | null} */
let placementFeedbackHideTimer = null;
/** Дедуп взрыва при teamEliminated (сервер шлёт участникам дважды). */
let lastTeamElimVfxKey = "";
let lastTeamElimVfxAt = 0;

/** Изоляция территории от базы: клетка → метаданные кармана (сервер). */
/** @type {Map<string, { expiresAtMs: number, teamId: number, groupId: string }>} */
let territoryIsolationCellMeta = new Map();
/** Уже показали предупреждение для groupId кармана (не спамить при каждом sync). */
const territoryIsolationWarnedGroupIds = new Set();
/** Смещение времени сервера относительно клиента: serverNow − Date.now() в момент последнего sync изоляции. */
let territoryIsolationSkewMs = 0;
/** Интервал обновления таймера «отрезанный участок» под кнопкой смены команды. */
let territoryIsolationHudIntervalId = null;

const INVALID_PLACEMENT_HINTS = [
  "Ставьте пиксели только рядом с территорией команды (включая диагональ).",
  "Начните с базы 6×6 и расширяйтесь от соседних клеток.",
  "Сюда пока нельзя — сначала захватите клетку рядом со своей территорией.",
  "Расширяйтесь только от клеток, которые касаются вашей команды.",
];

/** Пан/щипок: упрощённая отрисовка + coalescing в rAF. */
let mapInteractionActive = false;
/** Колесо: отдельно, чтобы таймаут не сбрасывал режим во время перетаскивания мышью. */
let mapWheelActive = false;
/** Один rAF на кадр: пан/zoom и сетевые перерисовки не дублируют draw(). */
let canvasFrameRafId = 0;
let mapWheelEndTimer = 0;

/** DPR слоя карты / board-vfx (обновляется в resizeCanvas) — для VFX после жёсткого reset контекста. */
let boardVfxDpr = 1;

/** Последний доверенный CSS-размер stage-wrap (TG Desktop / visualViewport иногда отдаёт краткий «нулевой» rect). */
let lastStableStageCssW = 0;
let lastStableStageCssH = 0;
/** Debounce цепочки ResizeObserver + visualViewport перед чтением layout. */
let resizeLayoutDebounceTimer = 0;

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
/** Throttle для повторной отправки clientProfile при возврате из фона (например после оплаты) */
let lastVisibilityWalletRefreshAt = 0;

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
/** Последние строки рейтинга (stats) — подсказка «вы впереди / отстаёте» в финале. */
let lastLeaderboardRows = [];
/** Сброс кинематографии событий при смене раунда. */
let lastRoundIndexForPresentation = -1;
let maxPerTeam = 200;
/** Сервер: false — только просмотр, без пикселей и команд */
let spectatorMode = false;
/** Время окончания текущего раунда (мс, Date.now()); null — лобби до «go» или нет таймера конца */
let roundEndsAtMs = null;
/** Когда начинается фаза боя после разминки; null — нет отсчёта (лобби до «go» и т.п.) */
let playStartsAtMs = null;
/** Сервер: tournamentTimeScale > 1 — ускоренный турнирный таймлайн (бот speed). */
let tournamentTimeScaleClient = 1;
let roundIndexMeta = 0;
/** Сервер: до команды «go» можно свободно играть на карте (meta.lobbyBeforeGo). */
let lobbyBeforeGoMeta = false;
/** С сервера: игра полностью завершена (финал) */
let gameFinishedMeta = false;
/** После leaveTeam открыть список команд (кнопка «Вступить», уже не в команде) */
let pendingLeaveToTeamList = false;
/** После leaveTeam открыть форму «Новая команда» (кнопка «Создать», пока ещё в команде) */
let pendingLeaveToCreate = false;

/** Экономика с сервера */
let walletState = null;
let lastStatsGlobalEvent = null;
/** Предупреждение сейсмики: подсветка зон до удара. */
let seismicPreviewClient = null;
/** Визуальный «хвост» после удара (пыль / трещины). */
let seismicAftermathUntilMs = 0;
/** Тремор body.pb-seismic-tremor: превью + несколько секунд после удара (vfxLoop подстраховывает класс). */
let seismicAfterglowTremorUntilMs = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let boardSeismicShakeClearTimer = null;
/** Доля доступных очков (score share), для кризис-оверлея при просадке. */
let lastMyTeamScoreShare = null;
/** Прогресс захвата флага по защищающейся команде: teamId → { progress, attackerTeamId }. */
let flagCaptureClientState = new Map();
/** До какого времени показывать пульс/тревогу по своему флагу. */
let myFlagUnderAttackUntil = 0;
/** HP ≤ 1 у своей базы — усиленная тревога / тряска. */
let myFlagCriticalUntil = 0;
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

function isClientLandCell(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!regionCells || regionCells.length !== gridW * gridH) {
    /* Онлайн без маски региона не считаем клетку игровой — иначе можно «закрасить всё подряд». */
    return !(wantOnline && getWsUrl());
  }
  return regionCells[y * gridW + x] !== 0;
}

/** Куда можно ставить пиксель: суша по cells и не океан по RGB плаката (как на сервере). */
function isClientPlayableCell(x, y) {
  if (!isClientLandCell(x, y)) return false;
  if (!regionRgb || regionRgb.length !== gridW * gridH * 3) return true;
  const i = (y * gridW + x) * 3;
  return !isWorldMapWaterPixel(regionRgb[i], regionRgb[i + 1], regionRgb[i + 2], 255);
}

function clientPixelTeamIdAt(x, y) {
  const v = pixels.get(`${x},${y}`);
  if (v === undefined) return null;
  const id = typeof v === "number" ? v : v.teamId;
  if (id == null || id === "") return null;
  return Number(id) | 0;
}

/** 8-соседство: есть ли рядом пиксель той же команды (как на сервере). */
function cellTouchesTeamTerritoryClient(x, y, teamId) {
  if (teamId == null) return false;
  const tid = teamId | 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const o = clientPixelTeamIdAt(nx, ny);
      if (o != null && o === tid) return true;
    }
  }
  return false;
}

/**
 * Клетки из keyStrings, достижимые от текущей территории команды через цепочку внутри множества (8-связность).
 * Совпадает с логикой filterPlannedReachableFromTeam на сервере для покупок зон.
 */
function filterClientKeysReachableFromTeam(keyStrings, teamId) {
  const inSet = new Set(keyStrings);
  const seen = new Set();
  const queue = [];
  for (const k of keyStrings) {
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (cellTouchesTeamTerritoryClient(x, y, teamId) && !seen.has(k)) {
      seen.add(k);
      queue.push(k);
    }
  }
  while (queue.length) {
    const k = queue.pop();
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nk = `${x + dx},${y + dy}`;
        if (!inSet.has(nk) || seen.has(nk)) continue;
        seen.add(nk);
        queue.push(nk);
      }
    }
  }
  return keyStrings.filter((kk) => seen.has(kk));
}

function getMyTeamSpawn() {
  if (myTeamId == null || !teamsMeta) return null;
  const t = teamsMeta.find((x) => x.id === myTeamId);
  const s = t?.spawn;
  if (!s || typeof s.x0 !== "number" || typeof s.y0 !== "number") return null;
  const w = typeof s.w === "number" ? s.w : 6;
  const h = typeof s.h === "number" ? s.h : 6;
  return { x0: s.x0, y0: s.y0, w, h };
}

const TEAM_SPAWN_ONBOARD_MS = 9000;

function focusCameraOnTeamSpawn(spawn) {
  if (!spawn) return;
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  if (cw < 32 || ch < 32) return;
  const targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, 2.4));
  scale = targetScale;
  const cell = BASE_CELL * scale;
  const cx = spawn.x0 + spawn.w / 2;
  const cy = spawn.y0 + spawn.h / 2;
  offsetX = cw / 2 - cx * cell;
  offsetY = ch / 2 - cy * cell;
  sanitizeMapPanOffsets();
  pendingRedrawFull = true;
  scheduleDraw();
}

function triggerDefeatScreenFlash() {
  if (!defeatFlashEl) return;
  const run = () => {
    defeatFlashEl.classList.remove("defeat-flash--on");
    void defeatFlashEl.offsetWidth;
    defeatFlashEl.classList.add("defeat-flash--on");
  };
  run();
  setTimeout(() => defeatFlashEl.classList.remove("defeat-flash--on"), 450);
  setTimeout(run, 220);
  setTimeout(() => defeatFlashEl.classList.remove("defeat-flash--on"), 900);
}

function formatTerritoryIsolationRemainMs(ms) {
  const m = Math.max(0, ms);
  if (m >= 60000) {
    const min = Math.floor(m / 60000);
    const rem = m - min * 60000;
    if (rem < 1000) return `${min} мин`;
    const sec = Math.ceil(rem / 1000);
    return `${min} мин ${sec} с`;
  }
  if (m >= 1000) return `${Math.ceil(m / 1000)} с`;
  if (m > 0) return `${Math.ceil(m / 1000)} с`;
  return "0 с";
}

function buildIsolationCorridorBannerLine(msLeft) {
  if (!Number.isFinite(msLeft)) return null;
  const human = formatTerritoryIsolationRemainMs(msLeft);
  return `Территория отрезана от базы! Соедините коридор за ${human} — иначе клетки станут нейтральными.`;
}

function stopTerritoryIsolationHud() {
  if (territoryIsolationHudIntervalId) {
    clearInterval(territoryIsolationHudIntervalId);
    territoryIsolationHudIntervalId = null;
  }
  if (territoryIsolationHudEl) territoryIsolationHudEl.hidden = true;
}

function syncTerritoryIsolationHudDom() {
  if (!territoryIsolationHudEl) return;
  const ms = getMyTeamIsolationMinMsLeft();
  if (!Number.isFinite(ms)) {
    stopTerritoryIsolationHud();
    return;
  }
  const t = formatTerritoryIsolationRemainMs(ms);
  territoryIsolationHudEl.textContent = `Отрезанный участок станет ничьим через ${t}`;
  territoryIsolationHudEl.hidden = false;
}

function ensureTerritoryIsolationHudInterval() {
  if (territoryIsolationHudIntervalId != null) return;
  territoryIsolationHudIntervalId = setInterval(() => syncTerritoryIsolationHudDom(), 250);
}

function refreshTerritoryIsolationHudPresence() {
  if (Number.isFinite(getMyTeamIsolationMinMsLeft())) {
    ensureTerritoryIsolationHudInterval();
    syncTerritoryIsolationHudDom();
  } else {
    stopTerritoryIsolationHud();
  }
}

/** Число с сервера (JSON иногда даёт строку). */
function parseServerTimeMs(v) {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string" && String(v).trim() !== "") {
    const n = Number(v);
    if (Number.isFinite(n)) return n;
  }
  return NaN;
}

/**
 * Изолированные карманы своей команды: одна запись на groupId (границы в клетках + дедлайн).
 * @returns {{ expiresAtMs: number, gx0: number, gy0: number, gx1: number, gy1: number }[]}
 */
function aggregateMyTeamIsolationPockets() {
  const mid = myTeamId | 0;
  /** @type {Map<string, { expiresAtMs: number, gx0: number, gy0: number, gx1: number, gy1: number }>} */
  const byGid = new Map();
  for (const [key, meta] of territoryIsolationCellMeta) {
    if ((meta.teamId | 0) !== mid) continue;
    const gid = meta.groupId && String(meta.groupId).length ? String(meta.groupId) : key;
    const parts = key.split(",");
    const gx = Number(parts[0]) | 0;
    const gy = Number(parts[1]) | 0;
    let b = byGid.get(gid);
    if (!b) {
      b = {
        expiresAtMs: Number(meta.expiresAtMs),
        gx0: gx,
        gy0: gy,
        gx1: gx,
        gy1: gy,
      };
      byGid.set(gid, b);
    } else {
      b.gx0 = Math.min(b.gx0, gx);
      b.gy0 = Math.min(b.gy0, gy);
      b.gx1 = Math.max(b.gx1, gx);
      b.gy1 = Math.max(b.gy1, gy);
    }
  }
  return [...byGid.values()];
}

/** Минимальный остаток до обвала среди изолированных карманов моей команды (мс). */
function getMyTeamIsolationMinMsLeft() {
  let minMs = Infinity;
  for (const [, meta] of territoryIsolationCellMeta) {
    if ((meta.teamId | 0) !== (myTeamId | 0)) continue;
    const exp = Number(meta.expiresAtMs);
    if (!Number.isFinite(exp)) continue;
    const raw = exp - Date.now() - territoryIsolationSkewMs;
    const ms = Math.max(0, raw);
    if (ms < minMs) minMs = ms;
  }
  return Number.isFinite(minMs) && minMs !== Infinity ? minMs : NaN;
}

function hidePlacementFeedbackBanner() {
  if (placementFeedbackHideTimer) {
    clearTimeout(placementFeedbackHideTimer);
    placementFeedbackHideTimer = null;
  }
  if (placementFeedbackBannerEl) {
    placementFeedbackBannerEl.hidden = true;
    placementFeedbackBannerEl.classList.remove(
      "event-banner--feedback-warn",
      "event-banner--feedback-error",
      "event-banner--feedback-success"
    );
  }
  if (cooldownLabel) {
    cooldownLabel.classList.remove("toolbar__cooldown--alert");
    setPendingHint();
  }
}

/**
 * Явный фидбек: полоска под статусом + тактильный отклик; не полагаемся только на Telegram alert.
 * @param {"warn"|"error"|"success"} severity
 * @param {{ telegramAlert?: boolean, bannerDurationMs?: number, skipCooldownChrome?: boolean }} opts
 */
function showPlacementFeedback(text, severity, opts = {}) {
  const telegramAlert = opts.telegramAlert === true;
  const skipCooldownChrome = opts.skipCooldownChrome === true;
  const hideMs =
    typeof opts.bannerDurationMs === "number" && Number.isFinite(opts.bannerDurationMs) && opts.bannerDurationMs > 0
      ? opts.bannerDurationMs
      : 5600;
  if (placementFeedbackBannerEl && text) {
    placementFeedbackBannerEl.textContent = text;
    placementFeedbackBannerEl.hidden = false;
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-warn", severity === "warn");
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-error", severity === "error");
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-success", severity === "success");
    if (placementFeedbackHideTimer) clearTimeout(placementFeedbackHideTimer);
    placementFeedbackHideTimer = setTimeout(() => {
      placementFeedbackHideTimer = null;
      hidePlacementFeedbackBanner();
    }, hideMs);
  }
  if (cooldownLabel && text && !skipCooldownChrome) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = text;
    cooldownLabel.classList.add("toolbar__cooldown--alert");
    cooldownLabel.title = text;
  }
  const tg = window.Telegram?.WebApp;
  try {
    if (severity === "error" && tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred("error");
    } else if (severity === "success" && tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred("success");
    } else if (tg?.HapticFeedback?.notificationOccurred) {
      tg.HapticFeedback.notificationOccurred("warning");
    }
  } catch {
    /* ignore */
  }
  if (telegramAlert && typeof tg?.showAlert === "function") {
    tg.showAlert(text);
  }
}

function triggerMapShake(ms = 560) {
  if (!stageWrapEl) return;
  stageWrapEl.classList.remove("map-shake");
  void stageWrapEl.offsetWidth;
  stageWrapEl.classList.add("map-shake");
  setTimeout(() => stageWrapEl.classList.remove("map-shake"), ms);
}

function stopBoardSeismicShake() {
  if (boardSeismicShakeClearTimer) {
    clearTimeout(boardSeismicShakeClearTimer);
    boardSeismicShakeClearTimer = null;
  }
  if (canvas) canvas.classList.remove("map-shake-board", "map-shake-board--hit");
}

/** Лёгкая тряска канвы на время превью сейсмики (не конфликтует с тремором #stage-wrap). */
function startBoardSeismicPreviewShake(durationMs = 3500) {
  if (!canvas) return;
  stopBoardSeismicShake();
  canvas.classList.remove("map-shake-board--hit");
  void canvas.offsetWidth;
  canvas.classList.add("map-shake-board");
  boardSeismicShakeClearTimer = setTimeout(() => {
    boardSeismicShakeClearTimer = null;
    canvas.classList.remove("map-shake-board");
  }, durationMs);
}

/** Крупные толчки в момент удара (~4–5 с). */
function runBoardSeismicHitShake() {
  if (!canvas) return;
  stopBoardSeismicShake();
  canvas.classList.remove("map-shake-board");
  void canvas.offsetWidth;
  canvas.classList.add("map-shake-board--hit");
  boardSeismicShakeClearTimer = setTimeout(() => {
    boardSeismicShakeClearTimer = null;
    canvas.classList.remove("map-shake-board--hit");
  }, 5000);
}

function applySeismicTremorBodyOverride() {
  if (typeof document === "undefined" || !document.body) return;
  const previewOn =
    seismicPreviewClient &&
    typeof seismicPreviewClient.impactAtMs === "number" &&
    Date.now() < seismicPreviewClient.impactAtMs;
  const want = previewOn || Date.now() < seismicAfterglowTremorUntilMs;
  document.body.classList.toggle("pb-seismic-tremor", want);
}

function clearClientTerritoryIsolation() {
  stopTerritoryIsolationHud();
  territoryIsolationCellMeta.clear();
  territoryIsolationWarnedGroupIds.clear();
}

function isolationGroupIdFromServerGroup(g) {
  if (g && typeof g.groupId === "string" && g.groupId) return g.groupId;
  if (g && typeof g.sig === "string" && g.sig) return g.sig;
  return "";
}

/**
 * Синхронизация изолированных карманов с сервера (meta или territoryIsolationSync).
 * @param {{ serverNow?: number, groups?: unknown[] } | null | undefined} payload
 */
function applyClientTerritoryIsolationFromServer(payload) {
  if (!payload || typeof payload !== "object") {
    clearClientTerritoryIsolation();
    return;
  }
  territoryIsolationCellMeta.clear();
  const clientAtReceive = Date.now();
  const serverNow = parseServerTimeMs(payload.serverNow);
  territoryIsolationSkewMs = Number.isFinite(serverNow) ? serverNow - clientAtReceive : 0;
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const activeGroupIds = new Set();
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const groupId = isolationGroupIdFromServerGroup(g);
    if (groupId) activeGroupIds.add(groupId);
    const tid = g.teamId | 0;
    let exp = parseServerTimeMs(g.expiresAtMs);
    if (!Number.isFinite(exp)) exp = parseServerTimeMs(g.deadlineMs);
    if (!Number.isFinite(exp) && Number.isFinite(serverNow)) {
      exp = serverNow + TERRITORY_ISOLATION_GRACE_MS;
    }
    if (!Number.isFinite(exp)) exp = clientAtReceive + TERRITORY_ISOLATION_GRACE_MS;
    const cells = Array.isArray(g.cells) ? g.cells : [];
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      if (!Array.isArray(c) || c.length < 2) continue;
      const key = `${c[0] | 0},${c[1] | 0}`;
      territoryIsolationCellMeta.set(key, { expiresAtMs: exp, teamId: tid, groupId });
    }
  }
  for (const s of [...territoryIsolationWarnedGroupIds]) {
    if (!activeGroupIds.has(s)) territoryIsolationWarnedGroupIds.delete(s);
  }
  for (let gi = 0; gi < groups.length; gi++) {
    const g = groups[gi];
    const tid = g.teamId | 0;
    const groupId = isolationGroupIdFromServerGroup(g);
    if ((tid | 0) !== (myTeamId | 0) || !groupId) continue;
    if (territoryIsolationWarnedGroupIds.has(groupId)) continue;
    territoryIsolationWarnedGroupIds.add(groupId);
    let exp = parseServerTimeMs(g.expiresAtMs);
    if (!Number.isFinite(exp)) exp = parseServerTimeMs(g.deadlineMs);
    let msLeft = NaN;
    if (Number.isFinite(exp) && Number.isFinite(serverNow)) {
      msLeft = exp - serverNow;
    } else if (Number.isFinite(exp)) {
      msLeft = exp - clientAtReceive;
    } else {
      msLeft = TERRITORY_ISOLATION_GRACE_MS;
    }
    msLeft = Math.max(0, msLeft);
    const line = buildIsolationCorridorBannerLine(msLeft);
    if (line) {
      showPlacementFeedback(line, "warn", {
        telegramAlert: false,
        skipCooldownChrome: true,
        bannerDurationMs: 2000,
      });
    }
    break;
  }
  refreshTerritoryIsolationHudPresence();
  scheduleDraw({ full: true });
}

function showTerritoryDramaBanner(text, durationMs = ALERT_AUTO_HIDE_MS, critical = false) {
  if (!territoryDramaBannerEl) return;
  const title = critical ? "LAST CELL" : "LAST 6 CELLS";
  const sub = String(text || "");
  if (territoryBannerHideTimer) {
    clearTimeout(territoryBannerHideTimer);
    territoryBannerHideTimer = null;
  }
  detachSwipeDismissSlot("territory");
  resetDismissibleBannerNode(territoryDramaBannerEl);
  fillPremiumAlertPanel(
    territoryDramaBannerEl,
    escapeHtml(title),
    escapeHtml(sub),
    critical ? "territory-crit" : "territory-warn",
    "event-banner event-banner--swipe-dismiss"
  );
  territoryDramaBannerEl.hidden = false;
  territoryDramaBannerEl.classList.toggle("event-banner--critical", critical);
  attachSwipeDismissSlot("territory", territoryDramaBannerEl, hideTerritoryDramaBannerNow);
  territoryBannerHideTimer = setTimeout(() => {
    territoryBannerHideTimer = null;
    hideTerritoryDramaBannerNow();
  }, durationMs);
}

const SEISMIC_WARNING_BANNER_MS = 3000;

function hideSeismicWarningBannerNow() {
  if (!seismicWarningBannerEl) return;
  if (seismicBannerHideTimer) {
    clearTimeout(seismicBannerHideTimer);
    seismicBannerHideTimer = null;
  }
  detachSwipeDismissSlot("seismic");
  resetDismissibleBannerNode(seismicWarningBannerEl);
  seismicWarningBannerEl.hidden = true;
}

function showSeismicWarningBanner(
  title,
  sub,
  durationMs = SEISMIC_WARNING_BANNER_MS
) {
  if (!seismicWarningBannerEl) return;
  if (seismicBannerHideTimer) {
    clearTimeout(seismicBannerHideTimer);
    seismicBannerHideTimer = null;
  }
  detachSwipeDismissSlot("seismic");
  resetDismissibleBannerNode(seismicWarningBannerEl);
  fillPremiumAlertPanel(
    seismicWarningBannerEl,
    escapeHtml(String(title || "")),
    escapeHtml(String(sub || "")),
    "seismic-warn",
    "event-banner event-banner--swipe-dismiss"
  );
  seismicWarningBannerEl.hidden = false;
  attachSwipeDismissSlot("seismic", seismicWarningBannerEl, hideSeismicWarningBannerNow);
  seismicBannerHideTimer = setTimeout(() => {
    seismicBannerHideTimer = null;
    hideSeismicWarningBannerNow();
  }, durationMs);
}

function tryPlayTeamEliminationVfx(msg) {
  const tid = msg.teamId | 0;
  const gx = Number(msg.destroyGx);
  const gy = Number(msg.destroyGy);
  if (!boardVfx || !Number.isFinite(gx) || !Number.isFinite(gy)) return;
  const key = `${tid}:${gx},${gy}`;
  const now = Date.now();
  if (lastTeamElimVfxKey === key && now - lastTeamElimVfxAt < 900) return;
  lastTeamElimVfxKey = key;
  lastTeamElimVfxAt = now;
  boardVfx.defeatExplosion(gx | 0, gy | 0, msg.teamColor || "#ff3344", getVfxTransform());
}

/**
 * После ошибки размещения: снова стрелка на базу; опционально — общий текст в шапке.
 * @param {boolean} [updateCooldownLabel] если false — не трогаем `#cooldown-label` (уже показан точный reason из notifyReject).
 */
function remindInvalidPlacementBase(updateCooldownLabel = true) {
  if (!wantOnline || spectatorMode || myTeamId == null) return;
  const now = Date.now();
  baseReminderUntil = now + 7000;
  teamSpawnOnboardUntil = Math.max(teamSpawnOnboardUntil, now + 5000);
  if (updateCooldownLabel && cooldownLabel) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent =
      INVALID_PLACEMENT_HINTS[Math.floor(Math.random() * INVALID_PLACEMENT_HINTS.length)];
  }
  scheduleDraw();
}

function startTeamSpawnOnboarding(spawn) {
  if (!spawn || spectatorMode) return;
  try {
    if (myTeamId != null) {
      sessionStorage.setItem(`pixel-battle-spawn-onboard:${myTeamId}`, "done");
    }
  } catch {
    /* ignore */
  }
  teamSpawnOnboardUntil = Date.now() + TEAM_SPAWN_ONBOARD_MS;
  if (teamSpawnHintTimer) {
    clearTimeout(teamSpawnHintTimer);
    teamSpawnHintTimer = 0;
  }
  if (cooldownLabel) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent =
      "Это ваша база. Начните расширение отсюда — пиксели только рядом с территорией команды (8 направлений).";
  }
  teamSpawnHintTimer = window.setTimeout(() => {
    teamSpawnHintTimer = 0;
    if (Date.now() >= teamSpawnOnboardUntil - 80 && cooldownLabel) {
      cooldownLabel.hidden = true;
    }
  }, TEAM_SPAWN_ONBOARD_MS);
}

/** Первый full после переподключения: показать базу, если ещё не показывали в этой вкладке. */
function maybeOnboardSpawnAfterFull() {
  if (!wantOnline || spectatorMode || myTeamId == null) return;
  try {
    if (sessionStorage.getItem(`pixel-battle-spawn-onboard:${myTeamId}`) === "done") return;
  } catch {
    return;
  }
  const sp = getMyTeamSpawn();
  if (!sp) return;
  focusCameraOnTeamSpawn(sp);
  startTeamSpawnOnboarding(sp);
}

/** Нельзя держать/рисовать пиксель (вода по маске или по цвету плаката). */
function isClientWaterCell(x, y) {
  return !isClientPlayableCell(x, y);
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
  return { offsetX, offsetY, scale, gridW, gridH, BASE_CELL, dpr: boardVfxDpr };
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

/** Сбросить команду, оставить имя для экрана входа (после выхода или ошибки вступления). */
function clearTeamIdentityFromSession() {
  try {
    const s = loadOnlineSession();
    if (!s) return;
    saveOnlineSessionRaw({
      playerName: s.playerName,
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

/** Тексты панели разминки / сплэша по roundIndex (0..3). */
const TOURNAMENT_ROUND_COPY = [
  {
    title: "РАУНД 1 — МАССОВАЯ БИТВА",
    splashKicker: "МАССОВАЯ БИТВА",
    splashTitle: "РАУНД 1 СТАРТОВАЛ",
    bodyHtml: `<ul><li>До <strong>200</strong> игроков в команде, команд сколько угодно</li><li>Бой после разминки: <strong>8 ч</strong></li><li>Счёт = сумма весов захваченных клеток (суша = 1)</li><li>Пиксель только рядом с территорией (8 направлений), от базы 6×6</li><li><strong>Чужая база</strong> с начала боя: бейте по <strong>клетке флага</strong> (центр базы 6×6) — снимаете HP; обычным пикселем базу не перекрасить; 20 попаданий + финальный удар — захват всей команды</li><li>Победа: <strong>наибольший счёт</strong> к концу таймера</li></ul>`,
  },
  {
    title: "РАУНД 2 — КОМАНДНЫЙ БОЙ",
    splashKicker: "КОМАНДНЫЙ БОЙ",
    splashTitle: "РАУНД 2 СТАРТОВАЛ",
    bodyHtml: `<ul><li>До <strong>10</strong> игроков в команде</li><li>Бой: <strong>5 ч</strong></li><li>Цель: максимальный счёт</li><li><strong>Захват базы</strong> — с первой секунды боя: удары по клетке флага врага (смежно с вашей территорией)</li><li>Дальше проходит только <strong>одна</strong> победившая команда</li></ul>`,
  },
  {
    title: "РАУНД 3 — ПАРЫ",
    splashKicker: "СТАДИЯ ПАР",
    splashTitle: "РАУНД 3 СТАРТОВАЛ",
    bodyHtml: `<ul><li>Команды по <strong>2</strong> игрока</li><li>Бой: <strong>4 ч</strong></li><li>Счёт и захват как раньше; <strong>база врага</strong> уязвима со старта боя (клетка флага)</li><li>Дальше проходит только <strong>одна пара</strong></li></ul>`,
  },
  {
    title: "ФИНАЛ — 1 НА 1",
    splashKicker: "ДУЭЛЬ",
    splashTitle: "ФИНАЛ СТАРТОВАЛ",
    bodyHtml: `<ul><li><strong>2</strong> игрока, бой <strong>75 мин</strong></li><li>Без донатов и бустов — только скилл</li><li><strong>База</strong>: удары по клетке флага с начала боя</li><li>Победа: больший счёт <strong>или</strong> ≥60% всех доступных очков на карте мгновенно</li></ul>`,
  },
];

function tournamentRoundCopy(ri) {
  const i = Math.min(Math.max(ri | 0, 0), 3);
  return TOURNAMENT_ROUND_COPY[i] || TOURNAMENT_ROUND_COPY[0];
}

function isClientWarmupPhase() {
  if (!wantOnline || !getWsUrl() || gameFinishedMeta || spectatorMode) return false;
  if (playStartsAtMs == null || Number.isNaN(playStartsAtMs)) return false;
  if (roundIndexMeta === 0 && roundEndsAtMs == null) return false;
  return Date.now() < playStartsAtMs;
}

function syncTournamentWarmupOverlay() {
  if (!tournamentWarmupOverlayEl) return;
  const show =
    wantOnline &&
    getWsUrl() &&
    !gameFinishedMeta &&
    !spectatorMode &&
    isClientWarmupPhase();
  tournamentWarmupOverlayEl.hidden = !show;
  if (tournamentWarmupTitleEl) {
    tournamentWarmupTitleEl.textContent = tournamentRoundCopy(roundIndexMeta).title;
  }
  if (tournamentWarmupBodyEl) {
    tournamentWarmupBodyEl.innerHTML = tournamentRoundCopy(roundIndexMeta).bodyHtml;
  }
  if (show && playStartsAtMs != null) {
    const left = Math.max(0, playStartsAtMs - Date.now());
    const s = Math.ceil(left / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    if (tournamentWarmupCountdownEl) {
      tournamentWarmupCountdownEl.textContent = `${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")} до боя`;
    }
    if (tournamentWarmupBadgeEl) {
      tournamentWarmupBadgeEl.textContent = `Разминка ${String(mm).padStart(2, "0")}:${String(ss).padStart(2, "0")}`;
    }
    if (myTeamId != null) {
      const until = playStartsAtMs;
      teamSpawnOnboardUntil = Math.max(teamSpawnOnboardUntil, until);
      baseReminderUntil = Math.max(baseReminderUntil, until);
      scheduleDraw();
    }
  }
}

function showRoundStartSplash(roundIdx) {
  if (!roundStartSplashEl || !roundStartSplashTitleEl) return;
  const c = tournamentRoundCopy(roundIdx);
  if (roundStartSplashKickerEl) roundStartSplashKickerEl.textContent = c.splashKicker;
  roundStartSplashTitleEl.textContent = c.splashTitle;
  roundStartSplashEl.hidden = false;
  roundStartSplashEl.classList.remove("round-start-splash--in");
  void roundStartSplashEl.offsetWidth;
  roundStartSplashEl.classList.add("round-start-splash--in");
  window.setTimeout(() => {
    roundStartSplashEl.classList.remove("round-start-splash--in");
    roundStartSplashEl.hidden = true;
  }, 2600);
}

function hideRoundEndedOverlay() {
  if (roundEndedOverlayEl) roundEndedOverlayEl.hidden = true;
}

function showRoundEndedOverlay(msg) {
  if (!roundEndedOverlayEl) return;
  const name = msg.winnerName || "—";
  if (roundEndedWinnerEl) {
    roundEndedWinnerEl.textContent = `Победитель: «${name}»`;
  }
  const sc = typeof msg.winnerScore === "number" ? msg.winnerScore : null;
  const pc =
    typeof msg.winnerScoreSharePercent === "number"
      ? msg.winnerScoreSharePercent
      : typeof msg.winnerPercent === "number"
        ? msg.winnerPercent
        : null;
  if (roundEndedScoreEl) {
    const parts = [];
    if (sc != null) parts.push(`Счёт: ${sc} оч.`);
    if (pc != null) parts.push(`Доля очков: ${pc.toFixed(2)}%`);
    roundEndedScoreEl.textContent = parts.length ? parts.join(" · ") : "";
    roundEndedScoreEl.hidden = parts.length === 0;
  }
  if (roundEndedBoardEl) {
    const rows = Array.isArray(msg.topTeams) ? msg.topTeams : [];
    if (rows.length === 0) {
      roundEndedBoardEl.innerHTML = "<p class=\"round-ended-overlay__next\" style=\"margin:0\">Таблица недоступна.</p>";
    } else {
      roundEndedBoardEl.innerHTML = rows
        .map(
          (r) =>
            `<div class="round-ended-overlay__row"><span>#${r.rank} ${r.emoji || ""} ${escapeHtml(String(r.name || ""))}</span><span>${typeof r.score === "number" ? r.score : "—"} оч.</span></div>`
        )
        .join("");
    }
  }
  const nextRi = typeof msg.roundIndex === "number" ? msg.roundIndex : roundIndexMeta;
  const cap = typeof msg.maxPerTeam === "number" ? msg.maxPerTeam : maxPerTeam;
  const stageNum = nextRi + 1;
  if (roundEndedNextEl) {
    roundEndedNextEl.textContent = msg.duel
      ? `Дальше — финал 1×1 (этап ${stageNum} из 4). Карта меньше, в «команде» до ${cap} чел. Сначала снова разминка 2 мин.`
      : `Следующий этап уже запущен: раунд ${stageNum} из 4, до ${cap} игроков в команде. Снова 2 мин разминки, затем бой.`;
  }
  roundEndedOverlayEl.hidden = false;
}

function escapeHtml(s) {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
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
      roundTimerEl.textContent = lobbyBeforeGoMeta ? "Разминка" : "Ожидание старта\n«go» в боте";
      syncTournamentWarmupOverlay();
      return;
    }
    if (roundEndsAtMs == null) {
      roundTimerEl.hidden = true;
      syncTournamentWarmupOverlay();
      return;
    }
    roundTimerEl.hidden = false;
    if (isClientWarmupPhase()) {
      const wLeft = Math.max(0, (playStartsAtMs || 0) - Date.now());
      const ws = Math.max(0, Math.ceil(wLeft / 1000));
      const wm = Math.floor(ws / 60);
      const wsec = ws % 60;
      roundTimerEl.textContent = `Разминка ${wm}:${String(wsec).padStart(2, "0")}\nдо боя`;
    } else {
      const ms = roundEndsAtMs - Date.now();
      if (ms <= 0) {
        roundTimerEl.textContent = "Конец раунда…";
      } else {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        roundTimerEl.textContent = h > 0 ? `Бой ${h}ч ${m}м` : m > 0 ? `Бой ${m}м ${sec}с` : `Бой ${sec}с`;
      }
    }
    syncTournamentWarmupOverlay();
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

function setFooterMode() {
  const online = wantOnline;
  const joined = myTeamId != null;
  const localMode = !online;
  /* Онлайн: палитра внизу скрыта — цвет команды только с сервера; локально палитра кисти. */
  const showPalette = localMode;
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
  if (teamBadgeColorEl) {
    const showSwatch =
      online && joined && !spectatorMode && !showTeamPaletteOnly;
    teamBadgeColorEl.hidden = !showSwatch;
  }
  if (online && joined) updateTeamBadge();
  if (btnReferral) {
    btnReferral.hidden =
      showTeamPaletteOnly || !online || !joined || spectatorMode || !!gameFinishedMeta;
  }
  if (btnToolbarBase) {
    btnToolbarBase.hidden = !online || !joined || spectatorMode;
  }
  refreshToolbarSessionButton();
  updateWalletBar();
  renderQuickBuyRail();
}

/** Кнопка сессии внизу у бейджа: онлайн в команде — только иконка двери; иначе короткий текст. */
function refreshToolbarSessionButton() {
  if (!btnToolbarSession) return;
  const labelEl = btnToolbarSession.querySelector(".btn-session-door__label");
  const online = wantOnline && getWsUrl();
  if (online && spectatorMode) {
    btnToolbarSession.hidden = true;
    return;
  }
  btnToolbarSession.hidden = false;
  if (online) {
    if (myTeamId != null) {
      btnToolbarSession.classList.add("btn-session-door--icon-only");
      if (labelEl) labelEl.textContent = "";
      btnToolbarSession.setAttribute("aria-label", "Сменить команду");
      btnToolbarSession.title = isCurrentTeamSolo()
        ? "Выбор другой команды или создание новой. Можно закрыть окно (×) — останетесь в соло."
        : "Выбор другой команды или создание новой. Можно закрыть окно (×) — останетесь в текущей команде.";
    } else {
      btnToolbarSession.classList.remove("btn-session-door--icon-only");
      if (labelEl) labelEl.textContent = "Войти";
      btnToolbarSession.setAttribute("aria-label", "Войти — создать команду или вступить");
      btnToolbarSession.title = "Создать команду или вступить в существующую (окно можно закрыть без действия)";
    }
  } else {
    btnToolbarSession.classList.remove("btn-session-door--icon-only");
    if (labelEl) labelEl.textContent = "Очистить локально";
    btnToolbarSession.setAttribute(
      "aria-label",
      "Очистить только локальную картинку на этом устройстве"
    );
    btnToolbarSession.title =
      "Стереть только вашу локальную картинку на этом устройстве (на общую карту не влияет)";
  }
}

function syncTeamBadgeColorSwatch() {
  if (!teamBadgeColorEl || teamBadgeColorEl.hidden) return;
  const hex = myTeamId != null ? teamColor(myTeamId) : "#888888";
  teamBadgeColorEl.style.backgroundColor = hex;
  teamBadgeColorEl.title = `Цвет команды: ${hex}`;
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
  } else if (s && s.teamId === myTeamId && s.cachedTeamName) {
    if (teamBadgeEmoji) teamBadgeEmoji.textContent = s.cachedEmoji || "";
    setCompactTeamName(teamBadgeName, s.cachedTeamName);
    const cnt = teamCounts[myTeamId] ?? 0;
    teamBadgeCount.textContent = `${cnt} / ${maxPerTeam}`;
  }
  syncTeamBadgeColorSwatch();
}

function renderLeaderboard(msg) {
  if (!onlineCountEl || !leaderboardListEl) return;
  if (msg.globalEvent) {
    lastStatsGlobalEvent = msg.globalEvent;
    if (walletState) walletState.globalEvent = msg.globalEvent;
  }
  lastLeaderboardRows = Array.isArray(msg.rows) ? msg.rows : [];
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
    const players = typeof row.players === "number" ? row.players : 0;
    const sc = typeof row.score === "number" ? row.score : null;
    const behind =
      typeof row.pointsBehindLeader === "number" && row.rank > 1 && row.pointsBehindLeader > 0
        ? ` · −${Math.round(row.pointsBehindLeader * 1000) / 1000} до лидера по очкам`
        : "";
    meta.textContent =
      sc != null ? `Очки ${sc}${behind} · ${players} чел.` : `${players} чел.`;
    li.append(top, name, meta);
    leaderboardListEl.appendChild(li);
  }
  if (myTeamId != null && !spectatorMode && !gameFinishedMeta) {
    const mine = (msg.rows || []).find((r) => r.teamId === myTeamId);
    const share =
      mine && typeof mine.scoreSharePercent === "number"
        ? mine.scoreSharePercent
        : mine && typeof mine.percent === "number"
          ? mine.percent
          : 0;
    if (lastMyTeamScoreShare != null && share < lastMyTeamScoreShare - 1.5 && Date.now() > crisisCooldownUntil) {
      crisisCooldownUntil = Date.now() + 120000;
      showCrisisOverlay();
    }
    lastMyTeamScoreShare = share;
  }
  syncEventBanner();
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
      sanitizeMapPanOffsets();
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
    if (t.solo || t.eliminated) continue;
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
 * Реферал: ?team= / ?ref=; ?refu= и startapp=…_r_<tgId> — привязка пригласившего (бонус +10 кв. ему при первом заходе новичка).
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
  const nu = new URL(`${location.origin}${location.pathname || "/"}`);
  nu.searchParams.set("team", String(myTeamId));
  nu.searchParams.delete("ref");
  const tgUser = getTelegramUserForServer();
  if (tgUser && tgUser.id != null) nu.searchParams.set("refu", String(tgUser.id));
  else nu.searchParams.delete("refu");
  return nu.toString();
}

function readTelegramMiniAppMeta() {
  const bot = document.querySelector('meta[name="pixel-battle-tg-bot"]')?.getAttribute("content")?.trim();
  const app = document.querySelector('meta[name="pixel-battle-tg-app"]')?.getAttribute("content")?.trim();
  if (!bot || !app) return null;
  return { bot: bot.replace(/^@/, ""), app: app.replace(/^\//, "") };
}

/** Payload для ?startapp= — совпадает с тем, что парсит parseStartParamRef из initDataUnsafe.start_param */
function buildTelegramStartAppInviteString(teamId, inviteTelegramId) {
  if (teamId == null || !Number.isFinite(Number(teamId))) return "";
  const tid = Math.floor(Number(teamId));
  const inv = inviteTelegramId != null ? Number(inviteTelegramId) : NaN;
  const refSuffix = Number.isFinite(inv) && inv > 0 ? `_r_${Math.floor(inv)}` : "";
  return `team_${tid}${refSuffix}`;
}

function buildTelegramInviteTmeUrl(teamId, inviteTelegramId) {
  const meta = readTelegramMiniAppMeta();
  if (!meta) return null;
  const payload = buildTelegramStartAppInviteString(teamId, inviteTelegramId);
  if (!payload) return null;
  return `https://t.me/${meta.bot}/${meta.app}?startapp=${encodeURIComponent(payload)}`;
}

function buildTelegramReferralUrl() {
  if (myTeamId == null) return null;
  const u = getTelegramUserForServer();
  return buildTelegramInviteTmeUrl(myTeamId, u && u.id != null ? u.id : null);
}

/** Для гостя в браузере: восстановить t.me-ссылку из ?team= / ?refu= и meta на странице */
function buildTelegramInviteDeepLinkFromUrlParams() {
  const { teamId, inviteTelegramId } = parseStartParamRef();
  if (teamId == null) return null;
  return buildTelegramInviteTmeUrl(teamId, inviteTelegramId);
}

function hasInviteQueryInUrl() {
  try {
    const q = new URLSearchParams(location.search);
    return q.has("team") || q.has("ref") || q.has("refu");
  } catch {
    return false;
  }
}

function setupBrowserTelegramInviteOverlay() {
  browserTelegramInviteDismiss?.addEventListener("click", () => {
    if (browserTelegramInviteOverlay) browserTelegramInviteOverlay.hidden = true;
  });
  browserTelegramInviteOverlay?.addEventListener("click", (e) => {
    if (e.target === browserTelegramInviteOverlay) browserTelegramInviteOverlay.hidden = true;
  });
}

function maybeShowBrowserTelegramInvite() {
  if (getTelegramInitDataForServer().trim()) return;
  if (!hasInviteQueryInUrl()) return;
  if (!browserTelegramInviteOverlay || !browserTelegramInviteHint) return;
  const deep = buildTelegramInviteDeepLinkFromUrlParams();
  if (browserTelegramInviteOpen) {
    if (deep) {
      browserTelegramInviteOpen.href = deep;
      browserTelegramInviteOpen.hidden = false;
    } else {
      browserTelegramInviteOpen.hidden = true;
      browserTelegramInviteOpen.removeAttribute("href");
    }
  }
  if (deep) {
    browserTelegramInviteHint.textContent =
      "Приглашение открыто в обычном браузере (Safari, Chrome). С аккаунтом и квантами игра работает только внутри Telegram Mini App. Нажмите кнопку — откроется бот и мини-приложение с нужной командой.";
  } else {
    browserTelegramInviteHint.textContent =
      "Ссылка ведёт на сайт без Telegram: подписи аккаунта нет, игра не сможет вас идентифицировать. Попросите друга прислать ссылку, которая начинается с https://t.me/… (из кнопки «Пригласить» в Mini App). Если в буфере только onrender.com — на сервере задайте TELEGRAM_BOT_USERNAME и TELEGRAM_MINIAPP_SHORT_NAME (имя Mini App из BotFather), затем перезапустите деплой.";
  }
  browserTelegramInviteOverlay.hidden = false;
}

/** Для приглашений важна ссылка t.me/…/…?startapp=… — она открывает Mini App в Telegram; веб-URL ведёт в браузер. */
function getReferralLinkText() {
  if (myTeamId == null) return "";
  const tgUrl = buildTelegramReferralUrl();
  if (tgUrl) return tgUrl;
  return buildWebReferralUrl();
}

async function copyReferralLink() {
  if (myTeamId == null) return;
  const text = getReferralLinkText();
  const usedTgMiniApp = /^https:\/\/t\.me\//i.test(text);
  const tg = window.Telegram?.WebApp;
  try {
    await navigator.clipboard.writeText(text);
    if (typeof tg?.showAlert === "function") {
      tg.showAlert(
        usedTgMiniApp
          ? "Ссылка для Telegram скопирована — по ней игра откроется в Mini App."
          : "Ссылка скопирована (веб). Чтобы давать ссылку в Telegram Mini App, на сервере задайте TELEGRAM_BOT_USERNAME и TELEGRAM_MINIAPP_SHORT_NAME (или TELEGRAM_MINIAPP_LINK на t.me)."
      );
    } else if (typeof tg?.HapticFeedback?.notificationOccurred === "function") {
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
    showReferralSplash();
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

function hideDefeatOverlay() {
  if (defeatOverlayEl) defeatOverlayEl.hidden = true;
}

function cancelTeamDefeatUiTimer() {
  if (teamDefeatUiTimer) {
    clearTimeout(teamDefeatUiTimer);
    teamDefeatUiTimer = null;
  }
}

/**
 * @param {boolean} canReenter — раунд 0: можно снова создать/вступить в команду
 */
function scheduleTeamDefeatOverlay(canReenter) {
  cancelTeamDefeatUiTimer();
  if (!defeatOverlayEl || !defeatOverlayTextEl) return;
  teamDefeatUiTimer = setTimeout(() => {
    teamDefeatUiTimer = null;
    hideCrisisOverlay();
    hideReferralSplash();
    hidePlacementFeedbackBanner();
    if (defeatOverlayTitleEl) {
      defeatOverlayTitleEl.textContent = "Команда уничтожена";
    }
    const base =
      "Вы проиграли. Ваша команда потеряла всю территорию и уничтожена.";
    if (canReenter) {
      defeatOverlayTextEl.textContent = `${base}\n\nВы можете создать новую команду или вступить в другую.`;
      if (defeatActionsReenterEl) defeatActionsReenterEl.hidden = false;
      if (defeatActionsSpectatorEl) defeatActionsSpectatorEl.hidden = true;
    } else {
      defeatOverlayTextEl.textContent = `${base}\n\nВы выбыли из этого раунда.`;
      if (defeatActionsReenterEl) defeatActionsReenterEl.hidden = true;
      if (defeatActionsSpectatorEl) defeatActionsSpectatorEl.hidden = false;
    }
    defeatOverlayEl.hidden = false;
  }, TEAM_DEFEAT_UI_DELAY_MS);
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

function buildCreateTeamColorPalette() {
  if (!createTeamColorPaletteEl) return;
  createTeamColorPaletteEl.innerHTML = "";
  TEAM_CREATE_PALETTE.forEach((hex, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette__swatch";
    if (hex.toUpperCase() === "#FFFFFF" || hex.toUpperCase() === "#EEFF41") {
      b.classList.add("palette__swatch--needs-ring");
    }
    b.style.backgroundColor = hex;
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", i === createTeamColorIdx ? "true" : "false");
    b.dataset.index = String(i);
    b.title = hex;
    b.addEventListener("click", () => {
      createTeamColorIdx = i;
      createTeamColorPaletteEl.querySelectorAll(".palette__swatch").forEach((el) => {
        el.setAttribute("aria-selected", el.dataset.index === String(i) ? "true" : "false");
      });
    });
    createTeamColorPaletteEl.appendChild(b);
  });
}

function openCreateTeamOverlay(fromWelcome) {
  createTeamFromWelcome = !!fromWelcome;
  if (createTeamNameInput) createTeamNameInput.value = "";
  if (createTeamEmojiInput) createTeamEmojiInput.value = EMOJI_PRESETS[0] || "🔥";
  syncCreateEmojiPresetHighlight();
  createTeamColorIdx = Math.min(createTeamColorIdx, TEAM_CREATE_PALETTE.length - 1);
  buildCreateTeamColorPalette();
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
  if (!name || !emoji) {
    const tg = window.Telegram?.WebApp;
    const msg = "Укажите название и смайлик команды.";
    if (typeof tg?.showAlert === "function") tg.showAlert(msg);
    else alert(msg);
    return;
  }
  const color = TEAM_CREATE_PALETTE[Math.max(0, Math.min(createTeamColorIdx, TEAM_CREATE_PALETTE.length - 1))];
  if (!color) {
    const tg = window.Telegram?.WebApp;
    const m = "Выберите цвет команды.";
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    else alert(m);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  ws.send(
    JSON.stringify({
      type: "createTeam",
      name,
      emoji,
      color,
      playerKey: getOrCreatePlayerKey(),
    })
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
  defeatBtnCreate?.addEventListener("click", () => {
    hideDefeatOverlay();
    openCreateTeamOverlay(true);
  });
  defeatBtnJoin?.addEventListener("click", () => {
    hideDefeatOverlay();
    if (teamOverlay) teamOverlay.hidden = false;
  });
  defeatBtnDismiss?.addEventListener("click", hideDefeatOverlay);
  defeatOverlayEl?.addEventListener("click", (e) => {
    if (e.target === defeatOverlayEl) hideDefeatOverlay();
  });
  roundEndedDismissBtn?.addEventListener("click", hideRoundEndedOverlay);
  btnToolbarBase?.addEventListener("click", () => {
    const sp = getMyTeamSpawn();
    if (!sp) return;
    focusCameraOnTeamSpawn(sp);
    const now = Date.now();
    baseReminderUntil = now + 6500;
    teamSpawnOnboardUntil = Math.max(teamSpawnOnboardUntil, now + 4500);
    if (cooldownLabel) {
      cooldownLabel.hidden = false;
      cooldownLabel.textContent =
        "База 6×6 — расширяйтесь только на соседние клетки (включая диагональ).";
    }
    scheduleDraw();
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
  ws.send(JSON.stringify({ type: "updateTeam", name, emoji, editToken: tok }));
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

function syncDevTimeScaleBanner() {
  const el = document.getElementById("dev-time-scale-banner");
  if (!el) return;
  if (tournamentTimeScaleClient > 1) {
    el.hidden = false;
    el.textContent = `TEST MODE ×${tournamentTimeScaleClient}`;
  } else {
    el.hidden = true;
  }
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
  syncFlagCaptureStateFromMeta(msg.flags);
  teamCounts = msg.teamCounts || {};
  maxPerTeam = msg.maxPerTeam ?? 200;
  gameFinishedMeta = !!msg.gameFinished;
  roundEndsAtMs =
    typeof msg.roundEndsAt === "number" && !Number.isNaN(msg.roundEndsAt) ? msg.roundEndsAt : null;
  playStartsAtMs =
    typeof msg.playStartsAt === "number" && !Number.isNaN(msg.playStartsAt)
      ? msg.playStartsAt
      : typeof msg.warmupEndsAt === "number" && !Number.isNaN(msg.warmupEndsAt)
        ? msg.warmupEndsAt
        : null;
  const nextRi = typeof msg.roundIndex === "number" ? msg.roundIndex : 0;
  if (nextRi !== lastRoundIndexForPresentation) {
    lastRoundIndexForPresentation = nextRi;
    resetEventPresentationForRound();
    seismicAfterglowTremorUntilMs = 0;
    stopBoardSeismicShake();
  }
  roundIndexMeta = nextRi;
  lobbyBeforeGoMeta = !!msg.lobbyBeforeGo;
  tournamentTimeScaleClient =
    typeof msg.tournamentTimeScale === "number" && msg.tournamentTimeScale >= 1
      ? msg.tournamentTimeScale | 0
      : 1;
  syncDevTimeScaleBanner();
  spectatorMode = msg.eligible === false || msg.gameFinished === true;

  if (msg.eligible === false && !msg.gameFinished) {
    tryClaimEligibility();
  }

  const gw = typeof msg.grid?.w === "number" ? msg.grid.w : gridW;
  const gh = typeof msg.grid?.h === "number" ? msg.grid.h : gridH;

  applyGridFromServer(gw, gh).then(() => {
    try {
      rebuildTeamList();
      updateRoundTimer();
      syncTournamentWarmupOverlay();
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
      const validRef =
        ref != null && teamsMeta.some((t) => t.id === ref && !t.solo && !t.eliminated);

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
    } finally {
      if (msg.territoryIsolation && typeof msg.territoryIsolation === "object") {
        applyClientTerritoryIsolationFromServer(msg.territoryIsolation);
      } else {
        clearClientTerritoryIsolation();
      }
    }
  });
}

/** Сообщение для наблюдателей и не прошедших отбор в раунд (сервер: playRejected spectator / not_eligible). */
const MSG_WATCH_ONLY = "Остались сильнейшие, просто наблюдайте.";

function notifyReject(reason) {
  const map = {
    out_of_bounds: "Сюда нельзя (вне карты).",
    water: "Нельзя ставить пиксель на воду.",
    cooldown: "Слишком часто.",
    "cooldown not ready": "Интервал между действиями: подождите до следующего хода.",
    "pixel is shielded": "Пиксель под щитом.",
    no_team: "Сначала выберите команду.",
    spectator: MSG_WATCH_ONLY,
    not_eligible: MSG_WATCH_ONLY,
    need_telegram: "Откройте игру из Telegram Mini App (нужна подпись initData).",
    rate_limited: "Слишком много действий подряд. Подождите секунду.",
    same_cell: "Для линии выберите другую клетку — так задаётся направление.",
    not_adjacent:
      "Сюда нельзя: ставьте только рядом с территорией команды (8 направлений, с базы 6×6).",
    already_yours: "Эта клетка уже закрашена вашей командой.",
    team_eliminated: "Команда уничтожена — территории не осталось.",
    warmup: "Разминка: пиксели включатся, когда закончится отсчёт 2 минут.",
    waiting_go: "Сервер ещё не готов к пикселям (обновите страницу или дождитесь «go»).",
    flag_rate: "Захват флага: слишком часто для вашей команды. Подождите мгновение.",
    enemy_base_not_adjacent:
      "Сначала расширьтесь к базе врага: ваши клетки должны быть рядом с клеткой флага (8 направлений).",
    enemy_base:
      "Чужая база: бейте по клетке флага, чтобы снимать HP. Обычным пикселем базу не перекрасить.",
    not_leader:
      "Сервер занят (реплика кластера). Обновите страницу или подождите — ход обрабатывает основной инстанс.",
  };
  const text = map[reason] || String(reason);
  const hard =
    reason === "no_team" ||
    reason === "spectator" ||
    reason === "not_eligible" ||
    reason === "need_telegram" ||
    reason === "team_eliminated";
  const telegramAlert = hard && reason !== "team_eliminated";
  showPlacementFeedback(text, hard ? "error" : "warn", {
    telegramAlert,
    /* Дубль: тот же текст на placement-banner и в строке таймера — выглядит как два разных предупреждения */
    skipCooldownChrome: reason === "need_telegram",
  });
  if (reason === "not_adjacent" || reason === "enemy_base_not_adjacent") {
    remindInvalidPlacementBase(false);
  }
}

/** HP полоски флага: якорь + lastHitAt и при наличии снимок effectiveHp с сервера (реген без рассинхрона). */
function computeClientFlagDisplayEffHp(raw, nowMs) {
  const maxH = FLAG_BASE_MAX_HP;
  if (!raw || typeof raw.hp !== "number") return maxH;
  const h0 = Math.min(maxH, Math.max(0, raw.hp | 0));
  if (h0 >= maxH) return maxH;
  const tHit = toEpochMsSafe(raw.lastHitAt);
  let eff = computeEffectiveBaseHp({ hp: h0, lastHitAt: tHit }, nowMs);
  const srv = raw.effectiveHp;
  const t0 = raw.flagStateServerNow;
  if (
    typeof srv === "number" &&
    Number.isFinite(srv) &&
    typeof t0 === "number" &&
    Number.isFinite(t0) &&
    h0 < maxH
  ) {
    const span = maxH - h0;
    if (span > 0 && srv > h0 + 1e-6) {
      const u0 = Math.min(1, Math.max(0, (srv - h0) / span));
      const regenStart = t0 - u0 * FLAG_REGEN_DURATION_MS;
      const u = (nowMs - regenStart) / FLAG_REGEN_DURATION_MS;
      if (u >= 1) eff = maxH;
      else if (u > 0) eff = h0 + span * u;
      else eff = h0;
    }
  }
  return Math.min(maxH, Math.max(0, eff));
}

function syncFlagCaptureStateFromMeta(flags) {
  /* Не очищаем карту до проверки: иначе при meta без flags вся карта «сбрасывается» в 20/20 для всех баз. */
  if (!Array.isArray(flags)) return;
  const next = new Map();
  for (const f of flags) {
    const tid = Number(f.teamId) | 0;
    if (tid <= 0) continue;
    let maxHp = FLAG_BASE_MAX_HP;
    if (typeof f.maxHp === "number" && Number.isFinite(f.maxHp)) maxHp = f.maxHp | 0;
    else if (f.maxHp != null && String(f.maxHp).trim() !== "") {
      const mx = Number(f.maxHp);
      if (Number.isFinite(mx) && mx > 0) maxHp = mx | 0;
    }
    let hp = NaN;
    if (typeof f.hp === "number" && Number.isFinite(f.hp)) hp = f.hp | 0;
    else if (f.hp != null && String(f.hp).trim() !== "") {
      const n = Number(f.hp);
      if (Number.isFinite(n)) hp = n | 0;
    }
    if (!Number.isFinite(hp)) hp = Math.max(0, maxHp - (f.progress | 0));
    if (hp >= maxHp) continue;
    const prev = flagCaptureClientState.get(tid);
    let lh = 0;
    if (typeof f.lastHitAt === "number" && Number.isFinite(f.lastHitAt)) lh = toEpochMsSafe(f.lastHitAt);
    else if (f.lastHitAt != null && String(f.lastHitAt).trim() !== "") {
      const n = Number(f.lastHitAt);
      if (Number.isFinite(n)) lh = toEpochMsSafe(n);
    }
    if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
      if (
        prev &&
        Number.isFinite(prev.lastHitAt) &&
        prev.lastHitAt >= FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS &&
        prev.hp === hp
      ) {
        lh = toEpochMsSafe(prev.lastHitAt);
      } else {
        lh = Date.now() - FLAG_REGEN_IDLE_MS;
      }
    }
    const entry = {
      hp,
      maxHp,
      lastHitAt: lh,
      attackerTeamId: Number(f.attackerTeamId) | 0,
    };
    if (typeof f.effectiveHp === "number" && Number.isFinite(f.effectiveHp)) {
      const newSn =
        typeof f.flagStateServerNow === "number" && Number.isFinite(f.flagStateServerNow)
          ? f.flagStateServerNow
          : NaN;
      let effOut = f.effectiveHp;
      let snOut = Number.isFinite(newSn) ? newSn : Date.now();
      if (
        prev &&
        prev.hp === hp &&
        typeof prev.effectiveHp === "number" &&
        Number.isFinite(prev.effectiveHp) &&
        typeof prev.flagStateServerNow === "number" &&
        Number.isFinite(prev.flagStateServerNow)
      ) {
        if (prev.flagStateServerNow > snOut + 300 || prev.effectiveHp > effOut + 0.03) {
          effOut = prev.effectiveHp;
          snOut = prev.flagStateServerNow;
        }
      }
      entry.effectiveHp = effOut;
      entry.flagStateServerNow = snOut;
    }
    next.set(tid, entry);
  }
  flagCaptureClientState = next;
}

function showFlagAlertBanner(text, durationMs = ALERT_AUTO_HIDE_MS) {
  const el = document.getElementById("flag-alert-banner");
  if (!el) return;
  const raw = String(text || "");
  let title = raw;
  let sub = "";
  const dash = raw.indexOf(" — ");
  if (dash > 0) {
    title = raw.slice(0, dash).trim();
    sub = raw.slice(dash + 3).trim();
  }
  let variant = "flag-warn";
  const hpM = raw.match(/(\d+)\s*\/\s*(\d+)\s*HP/i);
  if (/КРИТИЧНО|FINISH!|0\s*\/\s*\d+\s*HP/i.test(raw)) variant = "flag-crit";
  else if (hpM) {
    const cur = Number(hpM[1]);
    if (cur <= 1) variant = "flag-crit";
    else if (cur <= 5) variant = "flag-danger";
    else if (cur <= 10) variant = "flag-warn";
  }
  if (showFlagAlertBanner._hideTimer) {
    clearTimeout(showFlagAlertBanner._hideTimer);
    showFlagAlertBanner._hideTimer = null;
  }
  detachSwipeDismissSlot("flag");
  resetDismissibleBannerNode(el);
  fillPremiumAlertPanel(el, escapeHtml(title), escapeHtml(sub), variant, "event-banner event-banner--swipe-dismiss");
  el.hidden = false;
  attachSwipeDismissSlot("flag", el, hideFlagAlertBannerNow);
  showFlagAlertBanner._hideTimer = setTimeout(() => {
    showFlagAlertBanner._hideTimer = null;
    hideFlagAlertBannerNow();
  }, durationMs);
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
    no_playable_land: "В этой зоне нет суши для захвата.",
    not_adjacent:
      "Захват возможен только у клеток, соседних с территорией вашей команды (вся зона должна «прикасаться» к базе).",
    team_eliminated: "Команда выбыла — эти покупки недоступны.",
    warmup: "Разминка: покупки и бусты после старта боя.",
    waiting_go: "Покупка сейчас недоступна (обновите клиент или дождитесь старта раунда).",
  };
  const text = m[reason] || String(reason);
  const severe =
    reason === "team_eliminated" || reason === "bad request" || reason === "not available";
  showPlacementFeedback(text, severe ? "error" : "warn", { telegramAlert: false });
  if (reason === "not_adjacent") remindInvalidPlacementBase(false);
}

const ROUND_END_BANNER_MS = 10 * 60 * 1000;

function computeLeaderboardGapHint() {
  if (myTeamId == null || !lastLeaderboardRows.length) return "";
  const mine = lastLeaderboardRows.find((r) => (r.teamId | 0) === (myTeamId | 0));
  if (!mine) return "";
  const rank = mine.rank | 0;
  const leader = lastLeaderboardRows[0];
  if (!leader) return "";
  if (rank === 1) return "Вы лидируете";
  const scMine = typeof mine.score === "number" && Number.isFinite(mine.score) ? mine.score : 0;
  const scLead = typeof leader.score === "number" && Number.isFinite(leader.score) ? leader.score : 0;
  const gap = scLead - scMine;
  if (gap > 0) {
    const rounded = gap >= 100 ? Math.round(gap) : Math.round(gap * 10) / 10;
    return `До лидера по очкам +${rounded}`;
  }
  if (gap < 0) return "Вы впереди по очкам";
  return "";
}

function formatBattleCountdown(untilMs) {
  const left = untilMs - Date.now();
  if (left <= 0) return "0:00";
  const s = Math.max(0, Math.ceil(left / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

function getClientGlobalEventSnapshot() {
  return walletState?.globalEvent || lastStatsGlobalEvent;
}

function syncEventBanner() {
  if (!eventBannerEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || gameFinishedMeta) {
    eventBannerEl.hidden = true;
    seismicPreviewClient = null;
    seismicAfterglowTremorUntilMs = 0;
    stopBoardSeismicShake();
    hideSeismicWarningBannerNow();
    syncPremiumBattlePresentation({
      ge: null,
      seismicPreview: null,
      online: false,
      spectator: true,
      gameFinished: true,
      roundEndsAtMs: null,
      leaderboardHint: "",
    });
    return;
  }
  const ge = getClientGlobalEventSnapshot();
  const layersHint = ge?.battleEvents?.layers;
  const dramaticL =
    Array.isArray(layersHint) && layersHint.find((l) => l && l.kind === "dramatic_pressure");
  const dStyleHint = dramaticL ? String(dramaticL.style || "") : "";
  const finalTitleForHint = dramaticL?.title
    ? String(dramaticL.title)
    : ge && ge.title
      ? String(ge.title)
      : "";
  const subHint = dramaticL ? String(dramaticL.subtitle || "") : "";
  const finalHint =
    dramaticL &&
    (dStyleHint === "final_ten" ||
      dStyleHint === "final_hour" ||
      /финальн(ые)?\s*10|финальн(ый)?\s*час|10\s*минут/i.test(`${finalTitleForHint} ${subHint}`) ||
      /FINAL\s*10|FINAL\s*HOUR|10\s*MINUTES/i.test(finalTitleForHint))
      ? computeLeaderboardGapHint()
      : "";
  const hideLegacyBattle = syncPremiumBattlePresentation({
    ge,
    seismicPreview: seismicPreviewClient,
    online: true,
    spectator: false,
    gameFinished: false,
    roundEndsAtMs,
    leaderboardHint: finalHint,
  });
  applySeismicTremorBodyOverride();

  if (hideLegacyBattle) {
    if (seismicPreviewClient && Date.now() > (seismicPreviewClient.impactAtMs || 0) + 3000) {
      seismicPreviewClient = null;
    }
    const leftR = roundEndsAtMs != null ? roundEndsAtMs - Date.now() : 0;
    if (leftR > 0 && leftR <= ROUND_END_BANNER_MS) {
      eventBannerEl.hidden = false;
      eventBannerEl.className = "event-banner event-banner--mini-round";
      const m = Math.max(1, Math.ceil(leftR / 60000));
      eventBannerEl.textContent = `⏱ До конца раунда · ещё ~${m} мин`;
      return;
    }
    eventBannerEl.hidden = true;
    return;
  }

  const prim = ge?.battleEvents?.primary;
  const dramaticBanner =
    prim &&
    (prim.dramatic === true ||
      prim.kind === "dramatic_pressure" ||
      prim.style === "final_hour" ||
      prim.style === "final_ten");
  if (ge && ge.active && ge.title && typeof ge.until === "number" && ge.until > Date.now()) {
    eventBannerEl.hidden = false;
    eventBannerEl.className = dramaticBanner
      ? "event-banner event-banner--battle event-banner--dramatic"
      : "event-banner event-banner--battle";
    const sub = ge.subtitle ? String(ge.subtitle) : "";
    const timer = formatBattleCountdown(ge.until);
    eventBannerEl.innerHTML = `<strong>${escapeHtml(String(ge.title))}</strong><div class="event-banner__sub">${escapeHtml(sub)}</div><div class="event-banner__timer">${escapeHtml(timer)}</div>`;
    return;
  }
  if (seismicPreviewClient && Date.now() > (seismicPreviewClient.impactAtMs || 0) + 3000) {
    seismicPreviewClient = null;
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
  eventBannerEl.className = "event-banner";
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
  syncEventBanner();
}

/** Высота шапки для отступа лидерборда; всегда в пределах [34px … --toolbar-h-max], без раздувания на весь экран. */
function syncToolbarHeightCssVar() {
  const tb = document.querySelector(".toolbar");
  if (!tb) return;
  const root = getComputedStyle(document.documentElement);
  const cap = parseFloat(root.getPropertyValue("--toolbar-h-max")) || 58;
  const raw = Math.ceil(tb.getBoundingClientRect().height);
  const h = Math.min(Math.max(raw, 34), cap);
  document.documentElement.style.setProperty("--toolbar-h", `${h}px`);
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
  } catch (e) {
    console.error("[board-vfx] flushBoardVfxFrame render error", e);
  }
}

function teamNameForPresentation(teamId) {
  const id = teamId | 0;
  const t = teamsMeta?.find((x) => (Number(x.id) | 0) === id);
  const n = t?.name != null ? String(t.name).trim() : "";
  return n || `Команда ${id}`;
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
      boardVfx.lightningBurst(getVfxTransform());
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "zoneCapture" && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 4;
    enqueueTerritoryCapturePresentation(
      "zoneCapture",
      teamNameForPresentation(msg.teamId),
      sz
    );
    if (boardVfx) {
      boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "massCapture" && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 6;
    enqueueTerritoryCapturePresentation(
      "massCapture",
      teamNameForPresentation(msg.teamId),
      sz
    );
    if (boardVfx) {
      boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "zone12Capture" && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 12;
    enqueueTerritoryCapturePresentation(
      "zone12Capture",
      teamNameForPresentation(msg.teamId),
      sz
    );
    if (boardVfx) {
      boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "teamRecovery") {
    app?.classList.add("fx-team-boost");
    setTimeout(() => app?.classList.remove("fx-team-boost"), 2000);
    boardVfx?.lightningBurst(getVfxTransform());
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
  applySeismicTremorBodyOverride();
  try {
    if (boardVfx && canvasVfx) {
      boardVfx.render(now || performance.now(), getVfxTransform());
    }
  } catch (e) {
    /* Исключение здесь раньше рвало цепочку rAF — последний кадр VFX «залипал» на экране навсегда. */
    console.error("[board-vfx] vfxLoop render error (loop continues)", e);
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

function sendClientProfileToServer() {
  if (!wantOnline || !getWsUrl()) return;
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  try {
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
    sendClientProfileToServer();
  });

  ws.addEventListener("message", (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    if (msg.type === "referralJoinReward") {
      const q = Number(msg.quant);
      const n =
        Number.isFinite(q) && q > 0 ? Math.floor(q) : REFERRAL_JOIN_INVITER_QUANT;
      showPlacementFeedback(`+${n} квантов: игрок перешёл по вашей ссылке.`, "success", {
        bannerDurationMs: 8000,
        skipCooldownChrome: true,
      });
      return;
    }

    if (msg.type === "gameEnded") {
      endSessionRestore();
      clearClientTerritoryIsolation();
      seismicPreviewClient = null;
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
      lastMyTeamScoreShare = null;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : 64;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : 64;
      applyGridFromServer(gw, gh).then(() => {
        const tg = window.Telegram?.WebApp;
        const ws =
          typeof msg.winnerScore === "number" && Number.isFinite(msg.winnerScore)
            ? ` Счёт победителя: ${msg.winnerScore} оч.`
            : "";
        const text = `Турнир завершён. Победитель: «${msg.winnerName || "—"}».${ws} Приз $5000.`;
        showPlacementFeedback(text, "error", { telegramAlert: true });
        if (typeof tg?.showAlert === "function") tg.showAlert(text);
        else if (typeof window.alert === "function") window.alert(text);
        setFooterMode();
        schedulePersist();
      });
      return;
    }
    if (msg.type === "roundEnded") {
      endSessionRestore();
      clearClientTerritoryIsolation();
      seismicPreviewClient = null;
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
      lastMyTeamScoreShare = null;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : gridW;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : gridH;
      applyGridFromServer(gw, gh).then(() => {
        showRoundEndedOverlay(msg);
        const tg = window.Telegram?.WebApp;
        const cap = typeof msg.maxPerTeam === "number" ? msg.maxPerTeam : maxPerTeam;
        const text = msg.duel
          ? `Раунд завершён. Победитель: «${msg.winnerName || "—"}». Дальше дуэль 1×1, в команде до ${cap}.`
          : `Раунд завершён. Победитель: «${msg.winnerName || "—"}». Следующий этап — до ${cap} в команде.`;
        showPlacementFeedback(text, "warn", { telegramAlert: false });
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

    if (msg.type === "tournamentTimeScale") {
      tournamentTimeScaleClient =
        typeof msg.tournamentTimeScale === "number" && msg.tournamentTimeScale >= 1
          ? msg.tournamentTimeScale | 0
          : 1;
      if (typeof msg.roundEndsAt === "number" && !Number.isNaN(msg.roundEndsAt)) {
        roundEndsAtMs = msg.roundEndsAt;
      }
      if (typeof msg.playStartsAt === "number" && !Number.isNaN(msg.playStartsAt)) {
        playStartsAtMs = msg.playStartsAt;
      } else if (typeof msg.warmupEndsAt === "number" && !Number.isNaN(msg.warmupEndsAt)) {
        playStartsAtMs = msg.warmupEndsAt;
      }
      syncDevTimeScaleBanner();
      updateRoundTimer();
      syncTournamentWarmupOverlay();
      return;
    }
    if (msg.type === "meta") {
      onMeta(msg);
      return;
    }
    if (msg.type === "roundEvent") {
      if (msg.phase === "start" && typeof window !== "undefined" && window.console?.debug) {
        console.debug("[roundEvent]", msg.phase, msg.eventId, msg.title);
      }
      if (msg.phase === "start") notifyRoundEventFromServer(msg);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "globalEvent") {
      if (msg.globalEvent && typeof msg.globalEvent === "object") {
        if (walletState) walletState.globalEvent = msg.globalEvent;
        lastStatsGlobalEvent = msg.globalEvent;
      }
      syncEventBanner();
      syncTeamBuffBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "seismicPreview") {
      seismicPreviewClient = {
        eventId: typeof msg.eventId === "string" ? msg.eventId : "",
        regions: Array.isArray(msg.regions) ? msg.regions : [],
        impactAtMs: typeof msg.impactAtMs === "number" ? msg.impactAtMs : 0,
      };
      startBoardSeismicPreviewShake(3500);
      showSeismicWarningBanner(
        "Землетрясение",
        "Некоторые ваши пиксели могут быть повреждены.",
        SEISMIC_WARNING_BANNER_MS
      );
      applySeismicTremorBodyOverride();
      notifySeismicPreview({
        eventId: seismicPreviewClient.eventId,
        impactAtMs: seismicPreviewClient.impactAtMs,
      });
      syncEventBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "territoryIsolationSync") {
      applyClientTerritoryIsolationFromServer(msg);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "territoryIsolationCollapse") {
      const cells = Array.isArray(msg.cells) ? msg.cells : [];
      for (let i = 0; i < cells.length; i++) {
        const p = cells[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        const pk = `${p[0] | 0},${p[1] | 0}`;
        pixels.delete(pk);
        territoryIsolationCellMeta.delete(pk);
      }
      const collapseGid =
        (typeof msg.groupId === "string" && msg.groupId) || (typeof msg.sig === "string" ? msg.sig : "");
      if (collapseGid) {
        for (const [k, meta] of territoryIsolationCellMeta.entries()) {
          if (meta.groupId === collapseGid) territoryIsolationCellMeta.delete(k);
        }
      }
      if (boardVfx && cells.length) {
        boardVfx.territoryIsolationCollapseBurst(cells, getVfxTransform());
        flushBoardVfxFrame();
      }
      if ((msg.teamId | 0) === (myTeamId | 0) && cells.length) {
        showPlacementFeedback(
          "Отрезанная территория обрушилась — клетки стали нейтральными.",
          "error",
          { telegramAlert: false }
        );
      }
      refreshTerritoryIsolationHudPresence();
      triggerMapShake(480);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "seismicImpact") {
      hideSeismicWarningBannerNow();
      seismicPreviewClient = null;
      seismicAfterglowTremorUntilMs = Math.max(seismicAfterglowTremorUntilMs, Date.now() + 4500);
      const au = typeof msg.aftermathUntilMs === "number" ? msg.aftermathUntilMs : 0;
      if (au > Date.now()) seismicAftermathUntilMs = au;
      const cells = Array.isArray(msg.cells) ? msg.cells : [];
      for (let i = 0; i < cells.length; i++) {
        const p = cells[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        pixels.delete(`${p[0] | 0},${p[1] | 0}`);
      }
      if (boardVfx && cells.length) {
        boardVfx.seismicCrackBurst(cells);
        flushBoardVfxFrame();
      }
      runBoardSeismicHitShake();
      applySeismicTremorBodyOverride();
      syncEventBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagCaptureProgress") {
      const did = msg.defenderTeamId | 0;
      if (msg.reset) {
        flagCaptureClientState.delete(did);
      } else {
        const maxHp = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
        const hp =
          typeof msg.hp === "number"
            ? msg.hp | 0
            : Math.max(0, maxHp - (msg.progress | 0));
        if (hp >= maxHp) flagCaptureClientState.delete(did);
        else {
          const prev = flagCaptureClientState.get(did);
          let lh = NaN;
          if (typeof msg.lastHitAt === "number" && Number.isFinite(msg.lastHitAt)) lh = toEpochMsSafe(msg.lastHitAt);
          else if (msg.lastHitAt != null && String(msg.lastHitAt).trim() !== "") {
            const n = Number(msg.lastHitAt);
            if (Number.isFinite(n)) lh = toEpochMsSafe(n);
          }
          if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
            if (
              msg.regen &&
              prev &&
              Number.isFinite(prev.lastHitAt) &&
              prev.lastHitAt >= FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS
            ) {
              lh = toEpochMsSafe(prev.lastHitAt);
            } else if (
              msg.regen &&
              typeof msg.effectiveHp === "number" &&
              Number.isFinite(msg.effectiveHp) &&
              typeof msg.serverNow === "number" &&
              Number.isFinite(msg.serverNow) &&
              maxHp > hp
            ) {
              const srv = msg.effectiveHp;
              const t0 = msg.serverNow;
              const span = maxHp - hp;
              const u0 = span > 0 ? Math.min(1, Math.max(0, (srv - hp) / span)) : 0;
              lh = Math.floor(t0 - u0 * FLAG_REGEN_DURATION_MS - FLAG_REGEN_IDLE_MS);
              if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
                lh = Math.floor(t0 - FLAG_REGEN_IDLE_MS);
              }
            } else if (msg.regen && typeof msg.serverNow === "number" && Number.isFinite(msg.serverNow)) {
              lh = Math.floor(msg.serverNow - FLAG_REGEN_IDLE_MS);
            } else {
              lh = Date.now();
            }
          }
          const row = {
            hp,
            maxHp,
            lastHitAt: lh,
            attackerTeamId: msg.attackerTeamId | 0,
          };
          if (typeof msg.effectiveHp === "number" && Number.isFinite(msg.effectiveHp)) {
            row.effectiveHp = msg.effectiveHp;
            row.flagStateServerNow =
              typeof msg.serverNow === "number" && Number.isFinite(msg.serverNow)
                ? msg.serverNow
                : Date.now();
          }
          flagCaptureClientState.set(did, row);
          if (!msg.regen && teamsMeta && boardVfx) {
            const def = teamsMeta.find((x) => (Number(x.id) | 0) === did);
            if (def?.spawn) {
              const { x: fgx, y: fgy } = flagCellFromSpawn(def.spawn.x0, def.spawn.y0);
              const aid = msg.attackerTeamId | 0;
              const col = aid ? teamColor(aid) : "#ffaa66";
              boardVfx.flagBaseHitImpact(fgx, fgy, col, getVfxTransform());
              flushBoardVfxFrame();
            }
          }
          if ((did | 0) === (myTeamId | 0) && hp <= 1) {
            myFlagCriticalUntil = Date.now() + 10_000;
            triggerMapShake(720);
          }
        }
      }
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagCaptureStopped") {
      flagCaptureClientState.delete(msg.defenderTeamId | 0);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagUnderAttack") {
      if ((msg.defenderTeamId | 0) === (myTeamId | 0)) {
        myFlagUnderAttackUntil = Date.now() + 16_000;
        const mx = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
        const h = typeof msg.hp === "number" ? msg.hp | 0 : mx - 1;
        showFlagAlertBanner(`ВАША БАЗА ПОД АТАКОЙ — ${h} / ${mx} HP`);
        try {
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("warning");
        } catch {
          /* ignore */
        }
      }
      if ((msg.attackerTeamId | 0) === (myTeamId | 0)) {
        showPlacementFeedback("Атака базы: продолжайте бить по клетке флага.", "warn", { telegramAlert: false });
      }
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagDefendWarn") {
      if ((msg.defenderTeamId | 0) === (myTeamId | 0)) {
        myFlagUnderAttackUntil = Date.now() + 18_000;
        const mx = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
        const h = typeof msg.hp === "number" ? msg.hp | 0 : mx;
        const lv = msg.level | 0;
        let line = `БАЗА: ${h} / ${mx} HP — держите флаг!`;
        if (lv <= 1) {
          line = "КРИТИЧНО! 1 HP — ПОСЛЕДНИЙ УДАР ЗАХВАТИТ БАЗУ!";
          myFlagCriticalUntil = Date.now() + 12_000;
          triggerMapShake(900);
        } else if (lv <= 5) line = `ОПАСНО: ${h} / ${mx} HP — база рушится!`;
        else if (lv <= 10) line = `Тревога: ${h} / ${mx} HP`;
        else if (lv <= 15) line = `Внимание: ${h} / ${mx} HP`;
        showFlagAlertBanner(line);
        try {
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.(lv <= 5 ? "error" : "warning");
        } catch {
          /* ignore */
        }
      }
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagCaptured") {
      const aid = msg.attackerTeamId | 0;
      const did = msg.defenderTeamId | 0;
      const wasMyDefeat = myTeamId != null && (myTeamId | 0) === did;
      flagCaptureClientState.delete(did);
      for (const [k, v] of [...pixels.entries()]) {
        const tid = typeof v === "number" ? v : v.teamId;
        if ((tid | 0) === did) {
          pixels.set(k, { teamId: aid, ownerPlayerKey: "", shieldedUntil: 0 });
        }
      }
      if (boardVfx) {
        const tr = getVfxTransform();
        boardVfx.flagCaptureExplosion(
          msg.gx | 0,
          msg.gy | 0,
          msg.attackerColor,
          msg.defenderColor,
          tr
        );
        flushBoardVfxFrame();
        requestAnimationFrame(() => flushBoardVfxFrame());
      }
      if (wasMyDefeat) {
        tryPlayTeamEliminationVfx({
          teamId: did,
          destroyGx: msg.gx,
          destroyGy: msg.gy,
          teamColor: msg.defenderColor || "#888888",
        });
        const canRe =
          typeof msg.canReenter === "boolean" ? msg.canReenter : roundIndexMeta === 0;
        applyMyTeamEliminatedClientState(canRe);
      }
      const an = teamsMeta?.find((x) => (Number(x.id) | 0) === aid)?.name || "атакующие";
      const dn = teamsMeta?.find((x) => (Number(x.id) | 0) === did)?.name || "защита";
      enqueueBaseCapturedPresentation(String(an), String(dn));
      if (!wasMyDefeat) {
        triggerMapShake(1200);
        showFlagAlertBanner(`База захвачена — «${dn}» уничтожена`, 5200);
        /* Модальный showAlert в TG часто подвешивает WebView; баннеров достаточно. */
        showPlacementFeedback(
          `База захвачена. «${dn}» уничтожена — вся территория у «${an}».`,
          "error",
          { telegramAlert: false }
        );
        try {
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
        } catch {
          /* ignore */
        }
      }
      scheduleDraw({ full: true });
      schedulePersist();
      return;
    }
    if (msg.type === "flagHitAck") {
      const mx = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
      const h = typeof msg.hp === "number" ? msg.hp | 0 : mx;
      const did = typeof msg.defenderTeamId === "number" ? msg.defenderTeamId | 0 : 0;
      if (did > 0 && h < mx) {
        flagCaptureClientState.set(did, {
          hp: h,
          maxHp: mx,
          lastHitAt: Date.now(),
          attackerTeamId: myTeamId | 0,
        });
      }
      const line =
        h <= 0
          ? "У базы 0 HP — следующий ваш удар захватит её полностью."
          : `Попадание по базе: у врага ${h} / ${mx} HP.`;
      showPlacementFeedback(line, "warn", { telegramAlert: false });
      scheduleDraw({ full: true });
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
      return;
    }
    if (msg.type === "teamsFull") {
      teamsMeta = msg.teams || [];
      invalidateTeamColorByIdCache();
      const aliveIds = new Set((teamsMeta || []).map((x) => Number(x.id) | 0));
      for (const id of [...flagCaptureClientState.keys()]) {
        if (!aliveIds.has(id | 0)) flagCaptureClientState.delete(id);
      }
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      scheduleDraw({ full: true });
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
      lastMyTeamScoreShare = null;
      {
        const sp = msg.team?.spawn ?? getMyTeamSpawn();
        if (sp) {
          requestAnimationFrame(() => {
            focusCameraOnTeamSpawn(sp);
            startTeamSpawnOnboarding(sp);
            drawFull(performance.now());
          });
        }
      }
      return;
    }
    if (msg.type === "setTeamColorError" || msg.type === "soloColorError") {
      if (msg.reason === "locked") {
        notifyReject("Цвет команды нельзя изменить после создания.");
      }
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
        fields: "Укажите название и смайлик команды.",
        limit: "Достигнут лимит команд на сервере.",
        duel: "Финальная дуэль 1 на 1 — публичные команды в этот момент недоступны.",
        spawn_failed:
          "Не удалось разместить стартовую базу 6×6 на карте (мало места). Попробуйте позже или сообщите администратору.",
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
        not_owner: "Название и смайлик может менять только создатель команды (цвет не меняется).",
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
      {
        const sp =
          msg.spawn && typeof msg.spawn.x0 === "number" && typeof msg.spawn.y0 === "number"
            ? {
                x0: msg.spawn.x0,
                y0: msg.spawn.y0,
                w: typeof msg.spawn.w === "number" ? msg.spawn.w : 6,
                h: typeof msg.spawn.h === "number" ? msg.spawn.h : 6,
              }
            : getMyTeamSpawn();
        if (sp) {
          requestAnimationFrame(() => {
            focusCameraOnTeamSpawn(sp);
            startTeamSpawnOnboarding(sp);
            drawFull(performance.now());
          });
        }
      }
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
        try {
          if (myTeamId != null && sessionStorage.getItem(`pixel-battle-spawn-onboard:${myTeamId}`) !== "done") {
            const sp = getMyTeamSpawn();
            if (sp) {
              requestAnimationFrame(() => {
                focusCameraOnTeamSpawn(sp);
                startTeamSpawnOnboarding(sp);
                drawFull(performance.now());
              });
            }
          }
        } catch {
          /* ignore */
        }
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
      hidePlacementFeedbackBanner();
      baseReminderUntil = 0;
      myTerritoryDangerUntil = 0;
      myTerritoryLastCellUntil = 0;
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
    if (msg.type === "teamEliminated") {
      tryPlayTeamEliminationVfx(msg);
      const tid = msg.teamId | 0;
      if (myTeamId != null && (myTeamId | 0) === tid) {
        applyMyTeamEliminatedClientState(msg.canReenter === true);
      }
      return;
    }
    if (msg.type === "full") {
      optimisticPixelPending = null;
      optimisticWeaponPending = null;
      pixels.clear();
      for (const p of msg.pixels || []) {
        if (!Array.isArray(p) || p.length < 3) continue;
        const x = p[0] | 0;
        const y = p[1] | 0;
        if (wantOnline && isClientWaterCell(x, y)) continue;
        if (msg.pixelFormat === "v2" && p.length >= 5) {
          const [, , t, , sh] = p;
          pixels.set(`${x},${y}`, { teamId: t, shieldedUntil: sh || 0 });
        } else {
          const [, , t] = p;
          pixels.set(`${x},${y}`, { teamId: t, shieldedUntil: 0 });
        }
      }
      scheduleDraw();
      if (wantOnline) flushToStorage();
      else schedulePersist();
      if (wantOnline) {
        requestAnimationFrame(() => maybeOnboardSpawnAfterFull());
      }
      return;
    }
    if (msg.type === "pixel") {
      const x = msg.x | 0;
      const y = msg.y | 0;
      const pk = `${x},${y}`;
      if (wantOnline && isClientWaterCell(x, y)) {
        pixels.delete(pk);
        if (optimisticPixelPending?.key === pk) optimisticPixelPending = null;
        scheduleDraw({ dirty: { gx0: x, gy0: y, gx1: x, gy1: y } });
        schedulePersist();
        return;
      }
      if (wantOnline && clientShouldIgnoreTerritoryPixelOnEnemyFlagAnchor(x, y, msg.t | 0)) {
        scheduleDraw({ dirty: { gx0: x, gy0: y, gx1: x, gy1: y } });
        return;
      }
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
    if (msg.type === "teamDanger") {
      if ((msg.teamId | 0) !== (myTeamId | 0)) return;
      const n = msg.cellsRemaining | 0;
      myTerritoryDangerUntil = Date.now() + 9000;
      const lines = [
        `⚠ Мало территории: осталось ${n} клет. База под угрозой!`,
        "⚠ Команда сжимается — держите линию, иначе вылет!",
        "⚠ Последние клетки! Защищайте остаток карты!",
      ];
      showTerritoryDramaBanner(lines[Math.floor(Math.random() * lines.length)], ALERT_AUTO_HIDE_MS, false);
      try {
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("warning");
      } catch {
        /* ignore */
      }
      scheduleDraw();
      return;
    }
    if (msg.type === "teamLastCell") {
      if ((msg.teamId | 0) !== (myTeamId | 0)) return;
      const now = Date.now();
      myTerritoryLastCellUntil = now + 14000;
      myTerritoryDangerUntil = Math.max(myTerritoryDangerUntil, now + 14000);
      showTerritoryDramaBanner("ПОСЛЕДНЯЯ КЛЕТКА! ПОТЕРЯЕТЕ ЕЁ — ВЫ ЛЕТИТЕ!", ALERT_AUTO_HIDE_MS, true);
      try {
        window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
      } catch {
        /* ignore */
      }
      triggerMapShake(520);
      scheduleDraw();
      return;
    }
    if (msg.type === "invalidPlacement") {
      if ((msg.teamId | 0) !== (myTeamId | 0)) return;
      if (msg.reason === "not_adjacent" || msg.reason === "enemy_base_not_adjacent") {
        remindInvalidPlacementBase(true);
      }
      return;
    }
    if (msg.type === "teamBaseHighlighted") {
      if ((msg.teamId | 0) !== (myTeamId | 0)) return;
      const sp0 = msg.spawn;
      if (sp0 && typeof sp0.x0 === "number" && typeof sp0.y0 === "number") {
        const sp = {
          x0: sp0.x0,
          y0: sp0.y0,
          w: typeof sp0.w === "number" ? sp0.w : 6,
          h: typeof sp0.h === "number" ? sp0.h : 6,
        };
        requestAnimationFrame(() => {
          focusCameraOnTeamSpawn(sp);
          startTeamSpawnOnboarding(sp);
          drawFull(performance.now());
        });
      }
      return;
    }
    if (msg.type === "teamCreated") {
      return;
    }
    if (msg.type === "roundPlayStarted") {
      const ri = typeof msg.roundIndex === "number" ? msg.roundIndex : roundIndexMeta;
      showRoundStartSplash(ri);
      syncTournamentWarmupOverlay();
      updateRoundTimer();
      scheduleDraw();
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
      schedulePersist();
      closePalettePicker();
    });
    paletteEl.appendChild(b);
  });
  updatePaletteTriggerPreview();
}

function clampFiniteMap(n, fallback = 0) {
  if (typeof n !== "number" || !Number.isFinite(n)) return fallback;
  return Math.max(-MAP_VIEW_OFFSET_LIM, Math.min(MAP_VIEW_OFFSET_LIM, n));
}

function sanitizeMapPanOffsets() {
  offsetX = clampFiniteMap(offsetX);
  offsetY = clampFiniteMap(offsetY);
}

/**
 * Зум к точке (колесо / pinch): единый clamp scale, якорь в мировых координатах, без NaN offset.
 * @param {number} nextScale
 * @param {number} anchorClientX
 * @param {number} anchorClientY
 * @param {number} rectLeft
 * @param {number} rectTop
 */
function applyMapZoomAroundScreenPoint(nextScale, anchorClientX, anchorClientY, rectLeft, rectTop) {
  const mx = anchorClientX - rectLeft;
  const my = anchorClientY - rectTop;
  const oldScale = scale;
  let s = typeof nextScale === "number" && Number.isFinite(nextScale) ? nextScale : oldScale;
  s = Math.min(MAX_SCALE, Math.max(MIN_SCALE, s));
  const denomOld = BASE_CELL * oldScale;
  const safeDenom = Math.abs(denomOld) < 1e-9 ? BASE_CELL * MIN_SCALE : denomOld;
  const worldX = (mx - offsetX) / safeDenom;
  const worldY = (my - offsetY) / safeDenom;
  scale = s;
  offsetX = mx - worldX * BASE_CELL * scale;
  offsetY = my - worldY * BASE_CELL * scale;
  sanitizeMapPanOffsets();
}

/**
 * Один debounce + двойной rAF: бурст resize/visualViewport в Telegram Desktop успевает «успокоиться»,
 * иначе читаем промежуточный микро-rect → канва сбрасывается в полоску и кадр чёрный.
 */
let resizeCanvasChainScheduled = false;
function scheduleResizeCanvas() {
  if (resizeCanvasChainScheduled) return;
  if (resizeLayoutDebounceTimer) clearTimeout(resizeLayoutDebounceTimer);
  resizeLayoutDebounceTimer = window.setTimeout(() => {
    resizeLayoutDebounceTimer = 0;
    if (resizeCanvasChainScheduled) return;
    resizeCanvasChainScheduled = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resizeCanvasChainScheduled = false;
        resizeCanvas();
      });
    });
  }, 28);
}

/** Читает размер контейнера карты; подавляет кратковременные выбросы layout в десктопном WebView. */
function readStageWrapCssSize(wrap) {
  const rect = wrap.getBoundingClientRect();
  const crw = wrap.clientWidth | 0;
  const crh = wrap.clientHeight | 0;
  let w = Math.max(1, Math.round(rect.width), crw);
  let h = Math.max(1, Math.round(rect.height), crh);

  const MIN_STABLE = 72;
  /* Не трогаем законное сужение окна: только явный «глюк» (крошечная высота/ширина или <22% от стабильного). */
  if (lastStableStageCssW >= MIN_STABLE && lastStableStageCssH >= MIN_STABLE) {
    if (w < 48 || (w < 128 && w < lastStableStageCssW * 0.2)) w = lastStableStageCssW;
    if (h < 48 || (h < 128 && h < lastStableStageCssH * 0.2)) h = lastStableStageCssH;
  }

  if (w >= 48 && h >= 48) {
    lastStableStageCssW = w;
    lastStableStageCssH = h;
  }

  if (perfDebug && (crh > h * 2 || crw > w * 2 || rect.height < lastStableStageCssH * 0.25)) {
    console.debug("[canvas stage]", { rectW: rect.width, rectH: rect.height, crw, crh, usedW: w, usedH: h, lastW: lastStableStageCssW, lastH: lastStableStageCssH });
  }

  return { w, h };
}

function resizeCanvas() {
  const wrap = canvas.parentElement;
  if (!wrap) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const { w, h } = readStageWrapCssSize(wrap);
  const bw = Math.max(1, Math.round(w * dpr));
  const bh = Math.max(1, Math.round(h * dpr));
  const mainUnchanged =
    canvas.width === bw &&
    canvas.height === bh &&
    canvas.style.width === `${w}px` &&
    canvas.style.height === `${h}px` &&
    boardVfxDpr === dpr;
  const vfxUnchanged =
    !canvasVfx ||
    (canvasVfx.width === bw &&
      canvasVfx.height === bh &&
      canvasVfx.style.width === `${w}px` &&
      canvasVfx.style.height === `${h}px`);
  if (mainUnchanged && vfxUnchanged) {
    centerIfNeeded(w, h);
    syncToolbarHeightCssVar();
    draw(performance.now(), { lite: mapDrawUseLite() });
    return;
  }
  boardVfxDpr = dpr;
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
    const vctx = canvasVfx.getContext("2d", { alpha: true, desynchronized: false });
    if (vctx) {
      vctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      vctx.imageSmoothingEnabled = false;
    }
  }
  centerIfNeeded(w, h);
  syncToolbarHeightCssVar();
  /* Сразу полный кадр после сброса bitmap (clear→draw в одном синхронном проходе; lite при активном жесте). */
  draw(performance.now(), { lite: mapDrawUseLite() });
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
  if (
    wantOnline &&
    territoryIsolationCellMeta.size > 0 &&
    !lite &&
    !mapInteractionActive &&
    !mapWheelActive
  ) {
    pendingRedrawFull = true;
    canvasFrameRafId = requestAnimationFrame(flushCanvasFrame);
  }
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
    scheduleResizeCanvas();
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

function clientPixelOwnerTeamAt(gx, gy) {
  return clientPixelTeamIdAt(gx, gy);
}

/**
 * Клетка якоря флага чужой команды, всё ещё её по локальной карте — как isEnemyOwnedFlagBaseCell на сервере.
 * Не трогаем её оптимистичным зонным захватом (сервер тоже пропускает).
 */
function isClientEnemyOwnedFlagAnchor(attackerTeamId, gx, gy) {
  if (teamsMeta == null || attackerTeamId == null) return false;
  const aid = attackerTeamId | 0;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated || !t.spawn) continue;
    if ((t.id | 0) === aid) continue;
    const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0);
    if (fx !== gx || fy !== gy) continue;
    const owner = clientPixelOwnerTeamAt(gx, gy);
    return owner === (t.id | 0);
  }
  return false;
}

/** Координаты якоря флага любой чужой (не своя команда) базы — для отдельной ветки атаки, без оптимистичной покраски. */
function clientIsEnemyBaseFlagCellCoords(gx, gy) {
  if (myTeamId == null || teamsMeta == null) return false;
  const mid = myTeamId | 0;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated || !t.spawn) continue;
    if ((t.id | 0) === mid) continue;
    const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0);
    if (fx === gx && fy === gy) return true;
  }
  return false;
}

/**
 * Сообщение `pixel` не должно перекрашивать якорь активной базы «чужим» teamId:
 * HP — через flagCaptureProgress / flagHitAck; полная смена владельца — через flagCaptured.
 */
function clientShouldIgnoreTerritoryPixelOnEnemyFlagAnchor(x, y, newTeamId) {
  if (teamsMeta == null) return false;
  const nid = newTeamId | 0;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated || !t.spawn) continue;
    const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0);
    if (fx !== x || fy !== y) continue;
    return (t.id | 0) !== nid;
  }
  return false;
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
      if (!isClientPlayableCell(x, y)) continue;
      keys.push(`${x},${y}`);
    }
  }
  return keys;
}

function applyOptimisticWeapon(kind, cx, cy) {
  if (myTeamId == null) return false;
  let keys = planClientCaptureCells(kind, cx, cy);
  if (!keys.length) {
    notifyReject("water");
    return false;
  }
  const connected = filterClientKeysReachableFromTeam(keys, myTeamId);
  if (connected.length !== keys.length) {
    notifyReject("not_adjacent");
    return false;
  }
  keys = connected;
  revertOptimisticWeapon();
  const paintKeys = keys.filter((k) => {
    const [x, y] = k.split(",").map(Number);
    return !isClientEnemyOwnedFlagAnchor(myTeamId, x, y);
  });
  const prev = new Map();
  for (const k of paintKeys) {
    prev.set(k, snapshotPixelCell(k));
    pixels.set(k, { teamId: myTeamId, shieldedUntil: 0 });
  }
  const gx0 = kind === "zoneCapture" ? cx - 1 : kind === "massCapture" ? cx - 2 : cx - 5;
  const gy0 = kind === "zoneCapture" ? cy - 1 : kind === "massCapture" ? cy - 2 : cy - 5;
  const size = kind === "zoneCapture" ? 4 : kind === "massCapture" ? 6 : 12;
  optimisticWeaponPending = { kind, gx: gx0, gy: gy0, size, keys: paintKeys, prev };
  if (boardVfx) {
    const tr = getVfxTransform();
    const col = teamColor(myTeamId);
    boardVfx.zoneFlash(gx0, gy0, col, tr, size);
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
  }
  const dr = dirtyRectFromKeys(keys);
  scheduleDraw(dr ? { dirty: dr } : undefined);
  return true;
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
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;
  if (w < 1 || h < 1) {
    scheduleResizeCanvas();
    return;
  }
  const stage = canvas.parentElement;
  if (stage && (stage.clientHeight | 0) > 32 && h > 0 && h < (stage.clientHeight | 0) * 0.42) {
    scheduleResizeCanvas();
  }
  const cellRaw = BASE_CELL * scale;
  const cell = cellRaw < 1e-4 ? 1e-4 : cellRaw;
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
      /* Dirty-регион не пересёкся с вьюпортом — канву не трогаем (нет clear), предыдущий кадр остаётся. */
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
        const ri = (gy * gridW + gx) * 3;
        base = `rgb(${regionRgb[ri]},${regionRgb[ri + 1]},${regionRgb[ri + 2]})`;
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
          const dramaT = lite ? 0 : time;
          const nowD = shNow;
          const lastCellPulse =
            !lite &&
            myTeamId != null &&
            tid === myTeamId &&
            nowD < myTerritoryLastCellUntil;
          const dangerPulse =
            !lite && myTeamId != null && tid === myTeamId && nowD < myTerritoryDangerUntil;
          if (lastCellPulse || dangerPulse) {
            const amp = lastCellPulse ? 0.42 + 0.58 * Math.sin(dramaT * 0.022) : 0.18 + 0.22 * Math.sin(dramaT * 0.014);
            const a = lastCellPulse ? amp * 0.52 : amp * 0.32;
            ctx.fillStyle = `rgba(255, 45, 45, ${a})`;
            ctx.fillRect(px, py, cw, ch);
            if (lastCellPulse) {
              ctx.strokeStyle = `rgba(255, 200, 200, ${0.35 + amp * 0.35})`;
              ctx.lineWidth = Math.max(1, cell * 0.08);
              ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
            }
          }
          const isoMeta = territoryIsolationCellMeta.get(key);
          if (!lite && isoMeta) {
            const isoPulse = 0.5 + 0.5 * Math.sin(time * 0.018);
            const enemy = (isoMeta.teamId | 0) !== (myTeamId | 0);
            const tint = enemy ? 0.62 : 1;
            ctx.fillStyle = `rgba(255, 70, 30, ${(0.12 + isoPulse * 0.2) * tint})`;
            ctx.fillRect(px, py, cw, ch);
            ctx.strokeStyle = `rgba(255, 150, 70, ${(0.32 + isoPulse * 0.38) * tint})`;
            ctx.lineWidth = Math.max(1, cell * 0.09);
            ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
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

  /* Обратный отсчёт у отрезанного кармана своей команды — компактная метка сбоку от пятна. */
  if (!lite && online && myTeamId != null && cell >= 2 && territoryIsolationCellMeta.size > 0) {
    const pockets = aggregateMyTeamIsolationPockets();
    if (pockets.length > 0) {
      const nowAdj = Date.now() + territoryIsolationSkewMs;
      ctx.save();
      ctx.textBaseline = "middle";
      ctx.textAlign = "left";
      const fs = Math.max(9, Math.min(14, cell * 0.38));
      ctx.font = `700 ${fs}px system-ui,Segoe UI,sans-serif`;
      for (let pi = 0; pi < pockets.length; pi++) {
        const p = pockets[pi];
        if (p.gx1 < x0 || p.gx0 > x1 || p.gy1 < y0 || p.gy0 > y1) continue;
        const msLeft = p.expiresAtMs - nowAdj;
        const secLeft = Math.ceil(msLeft / 1000);
        if (secLeft < 0) continue;
        const label =
          secLeft >= 60
            ? `${Math.floor(secLeft / 60)}:${String(secLeft % 60).padStart(2, "0")}`
            : `${secLeft} с`;
        const pad = Math.max(3, cell * 0.08);
        const cy = offsetY + ((p.gy0 + p.gy1 + 1) * 0.5) * cell;
        let sx = offsetX + (p.gx1 + 1) * cell + pad;
        const tw = ctx.measureText(label).width + pad * 2.4;
        const th = fs + pad * 1.7;
        if (sx + tw > w - 4) sx = offsetX + p.gx0 * cell - tw - pad;
        if (sx < 4) sx = 4;
        const ry = cy - th * 0.5;
        ctx.fillStyle = "rgba(10,12,22,0.94)";
        ctx.fillRect(sx, ry, tw, th);
        ctx.strokeStyle = "rgba(255,130,80,0.9)";
        ctx.lineWidth = Math.max(1, cell * 0.045);
        ctx.strokeRect(sx + 0.5, ry + 0.5, tw - 1, th - 1);
        ctx.fillStyle = "#ffeae3";
        ctx.fillText(label, sx + pad * 1.15, cy);
      }
      ctx.restore();
    }
  }

  /* События боя: золото / сжатие / экономика / предпросмотр сейсмики (сервер задаёт зоны). */
  if (!lite && online) {
    const ge = getClientGlobalEventSnapshot();
    const rawLayers = ge?.battleEvents?.layers;
    const nowEv = Date.now();
    const layers =
      Array.isArray(rawLayers) && rawLayers.length
        ? rawLayers.filter((L) => L && typeof L.untilMs === "number" && L.untilMs > nowEv)
        : null;
    const compLayer = layers && layers.find((l) => l.kind === "map_compression");
    const pulseEv = 0.5 + 0.5 * Math.sin(time * 0.0022);
    function cellInEconomicLayer(L, gx, gy) {
      if (Array.isArray(L.rects) && L.rects.length) {
        for (let ri = 0; ri < L.rects.length; ri++) {
          const rr = L.rects[ri];
          if (rr && pointInRect(gx, gy, rr)) return rr.mult > 1 ? "boom" : "rec";
        }
        return null;
      }
      if (L.rect && pointInRect(gx, gy, L.rect)) {
        if (L.kind === "trade_boom" || L.mult > 1) return "boom";
        if (L.kind === "recession" || L.mult < 1) return "rec";
      }
      return null;
    }
    if (layers && layers.length) {
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          if (!isClientLandCell(gx, gy)) continue;
          const px = offsetX + gx * cell;
          const py = offsetY + gy * cell;
          const cw = Math.ceil(cell);
          const ch = Math.ceil(cell);
          for (let li = 0; li < layers.length; li++) {
            const L = layers[li];
            const goldKinds = ["gold_zone", "target_zone", "duel_zone"];
            if (goldKinds.includes(L.kind) && L.rect && pointInRect(gx, gy, L.rect)) {
              ctx.fillStyle = `rgba(255, 210, 40, ${0.72 + pulseEv * 0.2})`;
              ctx.fillRect(px, py, cw, ch);
            }
            const econKinds = [
              "trade_boom",
              "recession",
              "economic_shift",
              "economic_rotation",
              "resource_surge",
            ];
            if (econKinds.includes(L.kind)) {
              const zone = cellInEconomicLayer(L, gx, gy);
              if (zone === "boom") {
                ctx.fillStyle = `rgba(70, 255, 140, ${0.58 + pulseEv * 0.18})`;
                ctx.fillRect(px, py, cw, ch);
              } else if (zone === "rec") {
                ctx.fillStyle = `rgba(120, 195, 255, ${0.55 + pulseEv * 0.16})`;
                ctx.fillRect(px, py, cw, ch);
              }
            }
          }
          if (compLayer && compLayer.compression) {
            const m = tournamentCompressionMultiplierForCell(gx, gy, gridW, gridH, compLayer.compression);
            if (m < 0.92) {
              ctx.fillStyle = `rgba(35, 50, 95, ${Math.min(0.58, (1 - m) * 0.75)})`;
              ctx.fillRect(px, py, cw, ch);
            } else if (m > 1.08) {
              ctx.fillStyle = `rgba(255, 215, 85, ${Math.min(0.58, (m - 1) * 0.85)})`;
              ctx.fillRect(px, py, cw, ch);
            }
          }
        }
      }
    }
    if (layers && layers.length) {
      const goldKindsOutline = ["gold_zone", "target_zone", "duel_zone"];
      const econKindsOutline = [
        "trade_boom",
        "recession",
        "economic_shift",
        "economic_rotation",
        "resource_surge",
      ];
      const blackOutlinePulse = 0.42 + 0.58 * (0.5 + 0.5 * Math.sin(time * 0.0075));
      for (let oli = 0; oli < layers.length; oli++) {
        const L = layers[oli];
        if (goldKindsOutline.includes(L.kind) && L.rect) {
          const r = L.rect;
          const sx0 = offsetX + r.x0 * cell;
          const sy0 = offsetY + r.y0 * cell;
          const sw = r.w * cell;
          const sh = r.h * cell;
          const p = 0.78 + pulseEv * 0.2;
          const padOut = Math.max(4, cell * 0.5);
          ctx.save();
          ctx.strokeStyle = `rgba(0, 0, 0, ${0.55 * blackOutlinePulse + 0.2})`;
          ctx.lineWidth = Math.max(5, cell * 0.55);
          ctx.strokeRect(sx0 - padOut, sy0 - padOut, sw + padOut * 2, sh + padOut * 2);
          ctx.strokeStyle = `rgba(255, 200, 30, ${0.95 * p})`;
          ctx.lineWidth = Math.max(3.5, cell * 0.42);
          ctx.strokeRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
          ctx.strokeStyle = `rgba(255, 252, 220, ${0.72 * p})`;
          ctx.lineWidth = Math.max(2, cell * 0.2);
          ctx.strokeRect(sx0 + cell * 0.12, sy0 + cell * 0.12, sw - cell * 0.24, sh - cell * 0.24);
          ctx.restore();
        }
        if (econKindsOutline.includes(L.kind)) {
          const rectList =
            Array.isArray(L.rects) && L.rects.length > 0 ? L.rects : L.rect ? [L.rect] : [];
          for (let ri = 0; ri < rectList.length; ri++) {
            const rr = rectList[ri];
            if (!rr || !(rr.w > 0) || !(rr.h > 0)) continue;
            const boom = Number(rr.mult) > 1;
            const sx0 = offsetX + rr.x0 * cell;
            const sy0 = offsetY + rr.y0 * cell;
            const sw = rr.w * cell;
            const sh = rr.h * cell;
            const padOut = Math.max(4, cell * 0.48);
            ctx.save();
            ctx.strokeStyle = `rgba(0, 0, 0, ${0.52 * blackOutlinePulse + 0.22})`;
            ctx.lineWidth = Math.max(5, cell * 0.52);
            ctx.strokeRect(sx0 - padOut, sy0 - padOut, sw + padOut * 2, sh + padOut * 2);
            ctx.strokeStyle = boom ? "rgba(30, 255, 110, 0.95)" : "rgba(120, 200, 255, 0.95)";
            ctx.lineWidth = Math.max(3.5, cell * 0.4);
            ctx.strokeRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
            ctx.strokeStyle = boom ? "rgba(200, 255, 220, 0.55)" : "rgba(220, 235, 255, 0.5)";
            ctx.lineWidth = Math.max(2, cell * 0.18);
            ctx.strokeRect(sx0 + cell * 0.1, sy0 + cell * 0.1, sw - cell * 0.2, sh - cell * 0.2);
            ctx.restore();
          }
        }
      }
    }
    if (layers && layers.length) {
      const goldL = layers.find((l) => ["gold_zone", "target_zone", "duel_zone"].includes(l.kind) && l.rect);
      if (goldL && goldL.rect) {
        const r = goldL.rect;
        const gx0 = r.x0 | 0;
        const gy0 = r.y0 | 0;
        const gw = Math.max(1, r.w | 0);
        const gh = Math.max(1, r.h | 0);
        const sx0 = offsetX + gx0 * cell;
        const sy0 = offsetY + gy0 * cell;
        const sw = gw * cell;
        const sh = gh * cell;
        const sweep = (time * 0.00055) % 1;
        ctx.save();
        ctx.beginPath();
        for (let gy = gy0; gy < gy0 + gh; gy++) {
          for (let gx = gx0; gx < gx0 + gw; gx++) {
            if (!isClientLandCell(gx, gy)) continue;
            const px = offsetX + gx * cell;
            const py = offsetY + gy * cell;
            const cw = Math.ceil(cell);
            const ch = Math.ceil(cell);
            ctx.rect(px, py, cw, ch);
          }
        }
        ctx.clip();
        const grd = ctx.createLinearGradient(sx0 + sw * sweep, sy0, sx0 + sw * (sweep - 0.35), sy0 + sh);
        grd.addColorStop(0, "rgba(255,255,255,0)");
        grd.addColorStop(0.5, "rgba(255,230,120,0.72)");
        grd.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grd;
        ctx.globalCompositeOperation = "lighter";
        ctx.fillRect(sx0, sy0, sw, sh);
        ctx.restore();
      }
      if (compLayer && compLayer.compression) {
        const cx = offsetX + (gridW * 0.5) * cell;
        const cy = offsetY + (gridH * 0.5) * cell;
        const maxR = Math.min(w, h) * 0.58;
        ctx.save();
        ctx.globalCompositeOperation = "lighter";
        for (let ring = 0; ring < 4; ring++) {
          const phase = (time * 0.0003 + ring * 0.26) % 1;
          const rad = maxR * (0.16 + phase * 0.82);
          const a = 0.09 + 0.2 * (1 - phase);
          ctx.strokeStyle = `rgba(255,185,95,${a})`;
          ctx.lineWidth = 3 + ring * 0.45;
          ctx.beginPath();
          ctx.arc(cx, cy, rad, 0, Math.PI * 2);
          ctx.stroke();
        }
        ctx.restore();
      }
    }
    if (seismicPreviewClient?.regions?.length) {
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          if (!isClientLandCell(gx, gy)) continue;
          for (let ri = 0; ri < seismicPreviewClient.regions.length; ri++) {
            const reg = seismicPreviewClient.regions[ri];
            if (reg.kind === "manhattan_ball") {
              const d = Math.abs(gx - (reg.cx | 0)) + Math.abs(gy - (reg.cy | 0));
              if (d <= (reg.r | 0)) {
                const px = offsetX + gx * cell;
                const py = offsetY + gy * cell;
                const cw = Math.ceil(cell);
                const ch = Math.ceil(cell);
                const pulseS = 0.5 + 0.5 * Math.sin(time * 0.006);
                ctx.fillStyle = `rgba(255, 55, 25, ${0.32 + pulseS * 0.18})`;
                ctx.fillRect(px, py, cw, ch);
                ctx.strokeStyle = `rgba(255, 160, 90, ${0.82})`;
                ctx.lineWidth = Math.max(1.5, cell * 0.14);
                ctx.strokeRect(px + 0.5, py + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
              }
            }
          }
        }
      }
    }
    const aft = Date.now();
    if (aft < seismicAftermathUntilMs) {
      const fade = Math.min(1, (seismicAftermathUntilMs - aft) / 20_000);
      const dust = 0.06 * fade + 0.04 * fade * Math.sin(time * 0.01);
      ctx.fillStyle = `rgba(180, 150, 120, ${dust})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /* Допустимые клетки для следующего пикселя: пустая суша, 8-соседство с вашей территорией. */
  const drawExpansionFrontier =
    !lite &&
    !partial &&
    online &&
    myTeamId != null &&
    !spectatorMode &&
    cell >= 2.5 &&
    visibleCellCount <= 14000;
  if (drawExpansionFrontier) {
    const fp = 0.5 + 0.5 * Math.sin(time * 0.0033);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const pk = `${gx},${gy}`;
        if (pixels.has(pk)) continue;
        if (!isClientPlayableCell(gx, gy)) continue;
        if (!cellTouchesTeamTerritoryClient(gx, gy, myTeamId)) continue;
        const px = offsetX + gx * cell;
        const py = offsetY + gy * cell;
        const cw = Math.ceil(cell);
        const ch = Math.ceil(cell);
        ctx.fillStyle = `rgba(72, 255, 160, ${0.1 + fp * 0.1})`;
        ctx.fillRect(px, py, cw, ch);
        ctx.strokeStyle = `rgba(180, 255, 210, ${0.22 + fp * 0.18})`;
        ctx.lineWidth = Math.max(1, cell * 0.07);
        ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
      }
    }
  }

  /* Флаги баз: HP 0–20, реген на клиенте по lastHitAt; визуальные стадии опасности. */
  if (!lite && online && teamsMeta && cell >= 1.5) {
    const shNowF = Date.now();
    const maxH = FLAG_BASE_MAX_HP;
    for (const t of teamsMeta) {
      if (t.solo || t.eliminated || !t.spawn) continue;
      const sp = t.spawn;
      const { x: fgx, y: fgy } = flagCellFromSpawn(sp.x0, sp.y0);
      const visTop = fgy - FLAG_VISUAL_CELLS_ABOVE;
      if (fgx < x0 || fgx > x1 || fgy < y0 || visTop > y1) continue;
      const tidFlag = Number(t.id) | 0;
      const raw = flagCaptureClientState.get(tidFlag);
      const effHpFloat = computeClientFlagDisplayEffHp(raw, shNowF);
      const displayHp = Math.min(maxH, Math.max(0, Math.floor(effHpFloat + 1e-9)));
      const dmgTaken = maxH - displayHp;
      const px = offsetX + fgx * cell;
      const py = offsetY + fgy * cell;
      const cw = Math.ceil(cell);
      const ch = Math.ceil(cell);
      const dangerLow = displayHp <= 10 && displayHp > 0;
      const dangerMid = displayHp <= 5 && displayHp > 0;
      const dangerCrit = displayHp <= 1 && displayHp > 0;
      const dangerHpZero = displayHp <= 0 && raw != null;
      const pulseF = 0.5 + 0.5 * Math.sin(time * 0.012 + dmgTaken * 0.15);
      const pulseRed =
        dangerCrit && shNowF < myFlagCriticalUntil && tidFlag === (myTeamId | 0)
          ? 0.35 + 0.35 * Math.sin(time * 0.055)
          : dangerMid
            ? 0.12 + 0.12 * Math.sin(time * 0.035)
            : dangerLow
              ? 0.06 + 0.06 * Math.sin(time * 0.022)
              : 0;
      const teamHex = t.color || teamColor(t.id);
      const { r, g, b } = hexToRgb(teamHex);
      const rb = Math.min(255, Math.round(r * 1.14 + 28));
      const gb = Math.min(255, Math.round(g * 1.14 + 28));
      const bb = Math.min(255, Math.round(b * 1.14 + 28));
      const mastW = Math.max(4, cell * 0.24);
      const mastX = px + cw * 0.66;
      const topY = py - FLAG_VISUAL_CELLS_ABOVE * ch;
      const wave = Math.sin(time * 0.0033 + fgx * 0.35 + fgy * 0.22) * ch * 0.11;
      ctx.save();
      ctx.fillStyle = "rgba(0,0,0,0.35)";
      ctx.fillRect(mastX + 1.6, topY + 1.6, mastW, py + ch - topY);
      ctx.fillStyle = "rgba(48,48,52,0.98)";
      ctx.fillRect(mastX, topY, mastW, py + ch - topY);
      const cLeft = px - cw * 0.1;
      const cTop = topY + ch * 0.06;
      const cW = cw * 1.02;
      const cH = py + ch * 0.92 - cTop;
      ctx.beginPath();
      ctx.moveTo(mastX, cTop + wave * 0.25);
      ctx.lineTo(cLeft + cW, cTop + wave);
      ctx.lineTo(cLeft + cW * 0.9, cTop + cH + wave * 0.15);
      ctx.lineTo(cLeft, cTop + cH * 0.96);
      ctx.closePath();
      const clothA = 0.94 + pulseF * 0.05 - pulseRed * 0.22;
      ctx.fillStyle = `rgba(${rb},${gb},${bb},${Math.max(0.9, clothA)})`;
      ctx.fill();
      if (pulseRed > 0) {
        ctx.fillStyle = `rgba(255, 40, 60, ${pulseRed * 0.55})`;
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(0,0,0,0.62)";
      ctx.lineWidth = Math.max(1.5, cell * 0.085);
      ctx.stroke();
      ctx.strokeStyle = `rgba(255,255,255,${0.42 + pulseF * 0.12})`;
      ctx.lineWidth = Math.max(1, cell * 0.045);
      ctx.stroke();
      ctx.restore();
      /* Не заливаем якорь базы цветом атакующего: клетка остаётся цветом защитника в данных и на канве;
       * краткий «удар» атакующим цветом даёт только boardVfx.flagBaseHitImpact (сервер → flagCaptureProgress). */
      if (myTeamId != null && tidFlag === (myTeamId | 0) && shNowF < myFlagUnderAttackUntil && dmgTaken > 0) {
        const flash = 0.18 + 0.2 * Math.sin(time * 0.028);
        ctx.fillStyle = `rgba(255, 35, 60, ${flash})`;
        ctx.fillRect(px, py, cw, ch);
      }
      ctx.strokeStyle = dangerHpZero
        ? `rgba(255,90,40,${0.5 + 0.4 * Math.sin(time * 0.1)})`
        : dangerCrit
          ? `rgba(255,50,50,${0.55 + 0.35 * Math.sin(time * 0.08)})`
          : `rgba(255,255,255,${0.5 + pulseF * 0.22})`;
      ctx.lineWidth = Math.max(2, cell * (dangerHpZero ? 0.14 : dangerCrit ? 0.12 : 0.095));
      ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);
      ctx.strokeStyle = "rgba(0,0,0,0.45)";
      ctx.lineWidth = Math.max(1, cell * 0.055);
      ctx.strokeRect(px + 1.5, py + 1.5, cw - 3, ch - 3);
      const barW = cw * 0.94;
      const barH = Math.max(5, cell * 0.22);
      const bx = px + (cw - barW) / 2;
      const by = py + ch - barH - 2;
      ctx.fillStyle = "rgba(0,0,0,0.55)";
      ctx.fillRect(bx, by, barW, barH);
      const hpFrac = Math.min(1, Math.max(0, effHpFloat / maxH));
      ctx.fillStyle =
        displayHp <= 5 ? "#ff4444" : displayHp <= 10 ? "#ffaa33" : displayHp < maxH ? "#66dd88" : "rgba(100,220,130,0.85)";
      ctx.fillRect(bx, by, barW * hpFrac, barH);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = Math.max(1, cell * 0.035);
      ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);
      if (cell >= 2.8) {
        ctx.save();
        const fs = Math.max(8, Math.min(15, cell * 0.4));
        ctx.font = `700 ${fs}px system-ui,sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const tx = px + cw / 2;
        const ty = by - 3;
        const hpLabel =
          displayHp <= 0
            ? "FINISH!"
            : `${displayHp} / ${maxH} HP`;
        ctx.lineWidth = Math.max(2, fs * 0.18);
        ctx.strokeStyle = "rgba(0,0,0,0.8)";
        ctx.strokeText(hpLabel, tx, ty);
        ctx.fillStyle = dangerCrit ? "#ffcccc" : "rgba(255,252,240,0.96)";
        ctx.fillText(hpLabel, tx, ty);
        ctx.restore();
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

  if (!lite && !partial && online && myTeamId != null && !spectatorMode && cell >= 2) {
    const sp = getMyTeamSpawn();
    const tm = teamsMeta?.find((x) => x.id === myTeamId);
    if (sp && tm) {
      const px0 = offsetX + sp.x0 * cell;
      const py0 = offsetY + sp.y0 * cell;
      const pw = sp.w * cell;
      const ph = sp.h * cell;
      const nowMs = Date.now();
      const showBaseGuide = nowMs < teamSpawnOnboardUntil || nowMs < baseReminderUntil;
      const teamHex = tm.color || "#ffd54a";
      const slowPulse = 0.5 + 0.5 * Math.sin(time * 0.0042);
      /* Постоянная «якорная» рамка базы — игрок всегда видит, где центр команды. */
      ctx.save();
      ctx.setLineDash([Math.max(3, cell * 0.35), Math.max(2, cell * 0.22)]);
      const hexRing =
        typeof teamHex === "string" && /^#[0-9a-fA-F]{6}$/.test(teamHex)
          ? `${teamHex}${showBaseGuide ? "cc" : "55"}`
          : null;
      ctx.strokeStyle =
        hexRing ||
        (showBaseGuide ? "rgba(255, 213, 74, 0.72)" : "rgba(255, 213, 74, 0.38)");
      ctx.lineWidth = Math.max(1, cell * 0.08);
      ctx.strokeRect(px0 + 0.5, py0 + 0.5, pw - 1, ph - 1);
      ctx.restore();
      if (showBaseGuide) {
        const pulse = 0.5 + 0.5 * Math.sin(time * 0.01);
        ctx.strokeStyle = `rgba(255, 214, 80, ${0.42 + pulse * 0.38})`;
        ctx.lineWidth = Math.max(2, cell * 0.14);
        ctx.strokeRect(px0 - 2, py0 - 2, pw + 4, ph + 4);
        ctx.strokeStyle = `rgba(255, 240, 160, ${0.2 + slowPulse * 0.12})`;
        ctx.lineWidth = Math.max(1, cell * 0.05);
        ctx.strokeRect(px0 - 5, py0 - 5, pw + 10, ph + 10);
        const ax = offsetX + (sp.x0 + sp.w / 2) * cell;
        const ay = py0 - cell * (1.15 + pulse * 0.4);
        ctx.fillStyle = `rgba(255, 230, 120, ${0.88 + pulse * 0.08})`;
        ctx.beginPath();
        ctx.moveTo(ax, ay + cell * 0.95);
        ctx.lineTo(ax - cell * 0.58, ay);
        ctx.lineTo(ax + cell * 0.58, ay);
        ctx.closePath();
        ctx.fill();
      }
      const cx = px0 + pw / 2;
      const cy = py0 + ph / 2;
      const label = `${tm.emoji ? `${tm.emoji} ` : ""}${tm.name || "База"}`.trim();
      const fs = Math.min(15, Math.max(9, cell * 0.42));
      ctx.font = `600 ${fs}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      const textW = Math.min(pw - 8, ctx.measureText(label).width + 10);
      const textH = Math.min(ph * 0.55, Math.max(16, fs + 8));
      ctx.fillStyle = "rgba(4, 10, 28, 0.78)";
      ctx.fillRect(cx - textW / 2, cy - textH / 2, textW, textH);
      ctx.strokeStyle = `${tm.color || "#ffffff"}aa`;
      ctx.lineWidth = 1;
      ctx.strokeRect(cx - textW / 2 + 0.5, cy - textH / 2 + 0.5, textW - 1, textH - 1);
      ctx.fillStyle = "#f2f6ff";
      const short = label.length > 36 ? `${label.slice(0, 34)}…` : label;
      ctx.fillText(short, cx, cy);
    }
  }

  if (partial) {
    ctx.restore();
  }

  lastDrawVisibleCellCount = visibleCellCount;
  if (teamBadge && online && myTeamId != null && !spectatorMode) {
    const nowHud = Date.now();
    const lastCell = nowHud < myTerritoryLastCellUntil;
    const danger = nowHud < myTerritoryDangerUntil;
    teamBadge.classList.toggle("team-badge--last-cell", lastCell);
    teamBadge.classList.toggle("team-badge--danger", danger && !lastCell);
  } else if (teamBadge) {
    teamBadge.classList.remove("team-badge--last-cell", "team-badge--danger");
  }
  if (perfDebug) perfRecordDraw(performance.now() - _perf0, lite);
}

function placePixel(gx, gy) {
  if (gx < 0 || gx >= gridW || gy < 0 || gy >= gridH) {
    notifyReject("out_of_bounds");
    return;
  }
  if (!isClientPlayableCell(gx, gy)) {
    notifyReject("water");
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

  const onEnemyFlag =
    Boolean(online && myTeamId != null && clientIsEnemyBaseFlagCellCoords(gx, gy));

  if (online && isClientWarmupPhase() && !onEnemyFlag) {
    notifyReject("warmup");
    return;
  }

  if (online && pendingMapAction && !onEnemyFlag) {
    if (pendingMapAction.type === "zoneCapture") {
      lastZoneGx = gx - 1;
      lastZoneGy = gy - 1;
      if (!applyOptimisticWeapon("zoneCapture", gx, gy)) {
        pendingMapAction = null;
        setPendingHint();
        return;
      }
      wsSendJson({ type: "purchaseZoneCapture", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "massCapture") {
      lastZoneGx = gx - 2;
      lastZoneGy = gy - 2;
      if (!applyOptimisticWeapon("massCapture", gx, gy)) {
        pendingMapAction = null;
        setPendingHint();
        return;
      }
      wsSendJson({ type: "purchaseMassCapture", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "zone12Capture") {
      lastZoneGx = gx - 5;
      lastZoneGy = gy - 5;
      if (!applyOptimisticWeapon("zone12Capture", gx, gy)) {
        pendingMapAction = null;
        setPendingHint();
        return;
      }
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
    const onEnemyFlag = clientIsEnemyBaseFlagCellCoords(gx, gy);

    if (!onEnemyFlag && clientPixelTeamIdAt(gx, gy) === (myTeamId | 0)) {
      notifyReject("already_yours");
      lastPlaceAt = 0;
      return;
    }
    if (!cellTouchesTeamTerritoryClient(gx, gy, myTeamId)) {
      notifyReject(onEnemyFlag ? "enemy_base_not_adjacent" : "not_adjacent");
      lastPlaceAt = 0;
      return;
    }

    if (onEnemyFlag) {
      sendPixelOnline(gx, gy);
      updateToolbarHud();
      return;
    }

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
          const rect = canvas.getBoundingClientRect();
          applyMapZoomAroundScreenPoint(newScale, midX, midY, rect.left, rect.top);
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
          offsetX = clampFiniteMap(oneFinger.ox + dx);
          offsetY = clampFiniteMap(oneFinger.oy + dy);
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
      offsetX = clampFiniteMap(mousePan.ox + dx);
      offsetY = clampFiniteMap(mousePan.oy + dy);
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
      const delta = e.deltaY > 0 ? 0.92 : 1.08;
      applyMapZoomAroundScreenPoint(scale * delta, e.clientX, e.clientY, rect.left, rect.top);
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
  initEventPresentation();
  migrateLegacySessionStorage();
  clearSoloFromSession();
  wantOnline = !!getWsUrl();
  buildPalette();
  setupPalettePickerUi();
  setFooterMode();
  setupReferralButton();
  setupBrowserTelegramInviteOverlay();
  maybeShowBrowserTelegramInvite();
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
  sanitizeMapPanOffsets();
  if (canvasVfx) boardVfx = createBoardVfx(canvasVfx);
  requestAnimationFrame(vfxLoop);
  connectWs();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    const now = Date.now();
    if (now - lastVisibilityWalletRefreshAt < 2500) return;
    lastVisibilityWalletRefreshAt = now;
    sendClientProfileToServer();
  });

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
