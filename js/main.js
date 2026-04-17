/**
 * Pixel Battle — карта мира, команды, WebSocket.
 * Локально: палитра кисти. Онлайн: цвет команды выбирается только при создании (TEAM_CREATE_PALETTE);
 * после создания смена запрещена — в панели только индикатор из метаданных.
 */

import { createBoardVfx, spawnFloatingText, spawnQuantumFarmIncomeFloat } from "./vfx.js";
import {
  initEventPresentation,
  resetEventPresentationForRound,
  notifyRoundEventFromServer,
  syncPremiumBattlePresentation,
  fillPremiumAlertPanel,
  notifySeismicPreview,
  enqueueBaseCapturedPresentation,
  enqueueTerritoryCapturePresentation,
  getEffectiveAltSeasonRevengeUntilMs,
  setPresentationNowProvider,
} from "./event-presentation.js";
import {
  initGameAudio,
  setGameplayMusicAllowed,
  setSuppressAudioUntilOpenedInBrowser,
  playUiError,
  playPurchaseSuccess,
  playPixelPlace,
  playFlagBaseHit,
  playBombExplosion,
  playNukeExplosionSfx,
  playQuantumConnect,
  playQuantumDisconnect,
  playAlertBaseUnderAttack,
  playAlertLastCells,
  playAlertLastCell,
  playAlertTerritoryCutOff,
  playSeismicImpactSfx,
  scheduleSeismicAftermathSfx,
  playRoundEndSfx,
  playFinalVictorySfx,
  playTreasureFoundSfx,
  playBuffPersonalSfx,
  playBuffTeamSfx,
  playTerritoryExpand,
  playMenuChoiceSfx,
  playMenuOpenSfx,
  playMilitaryBaseDeploySound,
  playGreatWallHit,
  playGreatWallBreak,
  playGreatWallBuilt,
  registerSpatialAudioListener,
  registerSpatialAmbientAnchor,
} from "./game-audio.js";
import {
  BASE_ACTION_COOLDOWN_SEC,
  PRICES_QUANT,
  REFERRAL_JOIN_INVITER_QUANT,
  getAuthoritativePixelCooldownMs,
  quantumFarmUpgradePriceQuant,
  resolveAuthoritativeRecoverySec,
} from "../lib/tournament-economy.js";
import { computeNukeBombBlastCells } from "../lib/nuke-bomb-shape.js";
import {
  BASE_REPAIR_HP_DELTA,
  flagCellFromSpawn,
  flagCellFromMilitaryOutpost,
  FLAG_BASE_MAX_HP,
  FLAG_MAIN_BASE_MAX_HP,
  FLAG_SPAWN_SIZE,
  MILITARY_OUTPOST_SIZE,
  FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS,
  FLAG_REGEN_DURATION_MS,
  FLAG_REGEN_IDLE_MS,
  FLAG_VISUAL_CELLS_ABOVE,
  computeEffectiveBaseHp,
  toEpochMsSafe,
} from "../lib/flag-capture.js";
import { pointInRect, tournamentCompressionMultiplierForCell } from "../lib/battle-events.js";
import { GRID8_DELTAS, TERRITORY_ISOLATION_GRACE_MS, makeGridCellKey, neighborKeysInSet8 } from "../lib/territory-isolation.js";
import { getQuantumFarmInfluenceKeys, scoreTeamsAroundFarm, resolveFarmControl } from "../lib/quantum-farms.js";
import {
  normalizeQuantumFarmLevel,
  QUANTUM_FARM_MAX_LEVEL,
  quantumFarmTierMeta,
} from "../lib/quantum-farm-upgrades.js";
import {
  getMstimAltSeasonClientBurstUntilMs,
  getMstimAltSeasonClientBurstUntilStored,
  setMstimAltSeasonClientBurstUntilMs,
  setMstimClientNowProvider,
} from "./mstim-alt-season-client.js";
import { GREAT_WALL_MAX_HP, normalizeWallHp } from "../lib/great-wall.js";
import { isPosterOceanWaterRgb } from "../lib/visual-map-water.js";
import { isUsdtDepositsEnabled } from "../lib/usdt-deposits-enabled.js";

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
/**
 * Подсветка зон турнира на суше (gold / дуэль / экономика / shift / сжатие / сейсмика и т.д., evt из Telegram).
 * BATTLE_EVENT_MAP_ZONE_INTENSITY: общая яркость этих оверлеев на карте (~0.5 ≈ на 50% слабее).
 */
const BATTLE_EVENT_MAP_ZONE_INTENSITY = 0.5;
const BATTLE_EVENT_OVERLAY_RGB_MUL = BATTLE_EVENT_MAP_ZONE_INTENSITY;
const BATTLE_EVENT_OVERLAY_ALPHA_MUL = BATTLE_EVENT_MAP_ZONE_INTENSITY;
/** К целевой α из вызовов: заметность на тайле (~×5 к прошлому «двойному» затуханию 0.6²). */
const BATTLE_EVENT_OVERLAY_ALPHA_BOOST = 1.85;
/** Клетка без пикселя игрока: лёгкое затемнение базового цвета карты (пиксели команд читаются ярче). */
const MAP_FREE_CELL_DIM_ALPHA = 0.17;
/** База из плаката (regionRgb): чуть темнее, чтобы цвета команд контрастнее. */
const MAP_BASE_RGB_DIM = 0.88;

function battleEventOverlayRgba(r, g, b, a) {
  const aa = Math.min(1, a * BATTLE_EVENT_OVERLAY_ALPHA_MUL * BATTLE_EVENT_OVERLAY_ALPHA_BOOST);
  return `rgba(${Math.round(r * BATTLE_EVENT_OVERLAY_RGB_MUL)},${Math.round(g * BATTLE_EVENT_OVERLAY_RGB_MUL)},${Math.round(b * BATTLE_EVENT_OVERLAY_RGB_MUL)},${aa})`;
}

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
/** Подсказка для отключённых платёжных кнопок (fair play). */
const FAIR_PLAY_DISABLED_TOOLTIP = "Disabled for fair play · Отключено ради честной игры";

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

/** После «моста» из Mini App initData хранится в sessionStorage (в обычном браузере нет Telegram.WebApp). */
const BRIDGE_INIT_STORAGE_KEY = "pixelBattleBridgeInitData";

/** Строка initData для проверки подписи на сервере (привязка аккаунта к Telegram). */
function getTelegramInitDataForServer() {
  try {
    const bridged = sessionStorage.getItem(BRIDGE_INIT_STORAGE_KEY);
    if (typeof bridged === "string" && bridged.trim()) return bridged;
  } catch {
    /* ignore */
  }
  try {
    const s = window.Telegram?.WebApp?.initData;
    return typeof s === "string" ? s : "";
  } catch {
    return "";
  }
}

/**
 * Открытие ссылки ?tg_bridge=... после перехода из Telegram: одноразовый обмен токена на initData.
 */
async function tryConsumeTelegramBridgeFromUrl() {
  try {
    const u = new URL(window.location.href);
    const token = (u.searchParams.get("tg_bridge") || "").trim();
    if (!token) return;
    const expectLen = 48;
    if (!/^[a-f0-9]+$/i.test(token) || token.length !== expectLen) return;
    const r = await fetch("/api/auth/telegram-bridge-consume", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
    });
    const j = await r.json().catch(() => ({}));
    if (!j || !j.ok || typeof j.initData !== "string" || !j.initData.trim()) return;
    sessionStorage.setItem(BRIDGE_INIT_STORAGE_KEY, j.initData.trim());
    u.searchParams.delete("tg_bridge");
    const clean = `${u.pathname}${u.search}${u.hash}` || "/";
    window.history.replaceState({}, "", clean);
    syncWelcomeOnboardingLayout();
  } catch {
    /* ignore */
  }
}

/** Синхронно: в URL есть токен моста — считаем, что это уже переход в браузер (до async consume). */
function hasTelegramBridgeTokenInUrl() {
  try {
    const u = new URL(window.location.href);
    const t = (u.searchParams.get("tg_bridge") || "").trim();
    return t.length === 48 && /^[a-f0-9]+$/i.test(t);
  } catch {
    return false;
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
const welcomeOpenBrowserWrap = document.getElementById("welcome-open-browser-wrap");
const btnWelcomeOpenBrowser = document.getElementById("btn-welcome-open-browser");
const welcomePanel = document.getElementById("welcome-panel");
const welcomePromoBubble = document.getElementById("welcome-promo-bubble");
const welcomeLeadStandard = document.getElementById("welcome-lead-standard");
const welcomeTeamFlow = document.getElementById("welcome-team-flow");
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
const createTeamReferralHintEl = document.getElementById("create-team-referral-hint");
const createTeamInlineErrorEl = document.getElementById("create-team-inline-error");
const referralSplashOverlay = document.getElementById("referral-splash-overlay");
const referralSplashText = document.getElementById("referral-splash-text");
const btnReferralSplashCopy = document.getElementById("referral-splash-copy");
const btnReferralSplashOk = document.getElementById("referral-splash-ok");
const browserTelegramInviteOverlay = document.getElementById("browser-telegram-invite-overlay");
const browserTelegramInviteHint = document.getElementById("browser-telegram-invite-hint");
const browserTelegramInviteOpen = document.getElementById("browser-telegram-invite-open");
const browserTelegramInviteDismiss = document.getElementById("browser-telegram-invite-dismiss");
const leaderboardPanel = document.getElementById("leaderboard-panel");
const leaderboardToggleEl = document.getElementById("leaderboard-toggle");
const onlineCountEl = document.getElementById("online-count");
const leaderboardListEl = document.getElementById("leaderboard-list");
const roundTimerEl = document.getElementById("round-timer");
const spectatorBadgeEl = document.getElementById("spectator-badge");
const walletBalanceEl = document.getElementById("wallet-balance");
const toolbarQuantumObjectiveEl = document.getElementById("toolbar-quantum-objective");
const toolbarPixelTimerEl = document.getElementById("toolbar-pixel-timer");
const toolbarBuffsEl = document.getElementById("toolbar-buffs");
const toolbarBuffPersonalEl = document.getElementById("toolbar-buff-personal");
const toolbarBuffPersonalLabelEl = document.getElementById("toolbar-buff-personal-label");
const toolbarBuffPersonalFillEl = document.getElementById("toolbar-buff-personal-fill");
const serverAnnouncementBannerEl = document.getElementById("server-announcement-banner");
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
const treasureFoundOverlayEl = document.getElementById("treasure-found-overlay");
const treasureFoundAmountEl = document.getElementById("treasure-found-amount");
const treasureFoundDismissBtn = document.getElementById("treasure-found-dismiss");
const quantumFarmPanelEl = document.getElementById("quantum-farm-panel");
const quantumFarmPanelBackdropEl = document.getElementById("quantum-farm-panel-backdrop");
const quantumFarmPanelCloseEl = document.getElementById("quantum-farm-panel-close");
const quantumFarmPanelTitleEl = document.getElementById("quantum-farm-panel-title");
const quantumFarmPanelLevelEl = document.getElementById("quantum-farm-panel-level");
const quantumFarmPanelBlurbEl = document.getElementById("quantum-farm-panel-blurb");
const quantumFarmPanelIncomeEl = document.getElementById("quantum-farm-panel-income");
const quantumFarmPanelHintEl = document.getElementById("quantum-farm-panel-hint");
const quantumFarmPanelUpgradeEl = document.getElementById("quantum-farm-panel-upgrade");
const quantumFarmPanelDockEl = document.getElementById("quantum-farm-panel-dock");
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
const adminGamePauseOverlayEl = document.getElementById("admin-game-pause-overlay");
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

/** После успешной покупки в открытом магазине: на совпавшей кнопке — «✓»; остальные не отключаются из-за этой покупки — только этап турнира и режим наблюдения. */

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

/** Неподобранные клады: ключи "x,y" (сервер не присылает количество квантов). */
const treasureSpotKeys = new Set();

/** @type {Uint8Array | null} id страны на клетку, 0 = океан */
let regionCells = null;
/** @type {Uint8Array | null} RGB шаблон из regions-*.json (длина gridW*gridH*3), если есть — рисуем постер до закраски команд */
let regionRgb = null;

let selectedColor = 5;
/** Откуда открыли форму создания команды — «Назад» ведёт на welcome или список команд */
let createTeamFromWelcome = false;
/** После touchend на «Создать» игнорируем синтетический submit/click в течение короткого окна. */
let createTeamIgnoreSubmitUntilMs = 0;
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
/** Последнее значение `cellsRemaining` из `teamDanger` (для музыки / алертов). */
let lastTeamDangerCellsRemaining = 999;
/** Сильная пульсация при одной клетке. */
let myTerritoryLastCellUntil = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let territoryBannerHideTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let seismicBannerHideTimer = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let serverAnnouncementHideTimer = null;
/** Автоскрытие алертов «база / последняя клетка» (мс). */
const ALERT_AUTO_HIDE_MS = 2000;
/** Макс. время показа верхних всплывающих плашек (не закрываем «Магазин» / «База» надолго). */
const BANNER_MAX_VISIBLE_MS = 5000;
const ALERT_SWIPE_MIN_PX = 44;
const ALERT_FLY_OUT_PX = 180;

/** @type {{ territory: { cleanup: (() => void) | null }; flag: { cleanup: (() => void) | null }; seismic: { cleanup: (() => void) | null }; placement: { cleanup: (() => void) | null }; serverSay: { cleanup: (() => void) | null }; eventBanner: { cleanup: (() => void) | null }; teamBuff: { cleanup: (() => void) | null } }} */
const swipeDismissSlots = {
  territory: { cleanup: null },
  flag: { cleanup: null },
  seismic: { cleanup: null },
  placement: { cleanup: null },
  serverSay: { cleanup: null },
  eventBanner: { cleanup: null },
  teamBuff: { cleanup: null },
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
 * @param {"territory" | "flag" | "seismic" | "placement" | "serverSay" | "eventBanner" | "teamBuff"} slot
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
    if (slot === "placement" && placementFeedbackHideTimer) {
      clearTimeout(placementFeedbackHideTimer);
      placementFeedbackHideTimer = null;
    }
    if (slot === "serverSay" && serverAnnouncementHideTimer) {
      clearTimeout(serverAnnouncementHideTimer);
      serverAnnouncementHideTimer = null;
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

/** Один BFS «связь с базой» на кадр отрисовки (зелёная зона расширения). */
let drawConnectivityFrameId = 0;
let baseConnCacheFrameId = -1;
let baseConnCachedTeam = 0;
/** @type {Set<string>} */
let baseConnCachedSet = new Set();

function addClientBfsSeedsFromRectInVertices(vertices, x0, y0, w, h, out, stack) {
  const ww = w | 0;
  const hh = h | 0;
  const ox = x0 | 0;
  const oy = y0 | 0;
  for (let y = oy; y < oy + hh; y++) {
    for (let x = ox; x < ox + ww; x++) {
      const k = makeGridCellKey(x, y);
      if (vertices.has(k) && !out.has(k)) {
        out.add(k);
        stack.push(k);
      }
    }
  }
}

function addClientBfsSeedsTouchingBaseRectsInVertices(vertices, sp, mos, defaultSize, out, stack) {
  const S = defaultSize | 0;
  /** @type {{ x0: number, y0: number, w: number, h: number }[]} */
  const rects = [];
  if (sp && typeof sp.x0 === "number" && typeof sp.y0 === "number") {
    rects.push({
      x0: sp.x0 | 0,
      y0: sp.y0 | 0,
      w: typeof sp.w === "number" ? sp.w | 0 : S,
      h: typeof sp.h === "number" ? sp.h | 0 : S,
    });
  }
  for (let i = 0; i < mos.length; i++) {
    const r = mos[i];
    if (!r || typeof r.x0 !== "number" || typeof r.y0 !== "number") continue;
    rects.push({
      x0: r.x0 | 0,
      y0: r.y0 | 0,
      w: typeof r.w === "number" ? r.w | 0 : MILITARY_OUTPOST_SIZE,
      h: typeof r.h === "number" ? r.h | 0 : MILITARY_OUTPOST_SIZE,
    });
  }
  for (let ri = 0; ri < rects.length; ri++) {
    const r = rects[ri];
    const ox = r.x0;
    const oy = r.y0;
    const ww = r.w;
    const hh = r.h;
    for (let y = oy; y < oy + hh; y++) {
      for (let x = ox; x < ox + ww; x++) {
        for (let di = 0; di < GRID8_DELTAS.length; di++) {
          const d = GRID8_DELTAS[di];
          const nk = makeGridCellKey(x + d[0], y + d[1]);
          if (vertices.has(nk) && !out.has(nk)) {
            out.add(nk);
            stack.push(nk);
          }
        }
      }
    }
  }
}

function computeClientBaseConnectedPixelKeys(teamId) {
  const tid = teamId | 0;
  if (!tid) return new Set();
  const vertices = new Set();
  for (const [k, v] of pixels) {
    const o = typeof v === "number" ? v : v.teamId;
    if ((o | 0) === tid) vertices.add(k);
  }
  const out = new Set();
  const stack = [];
  const neighBuf = [];
  const sp = clientTeamSpawnRect(tid);
  if (sp) {
    const w = typeof sp.w === "number" ? sp.w : FLAG_SPAWN_SIZE;
    const h = typeof sp.h === "number" ? sp.h : FLAG_SPAWN_SIZE;
    addClientBfsSeedsFromRectInVertices(vertices, sp.x0, sp.y0, w, h, out, stack);
  }
  const mos = clientMilitaryOutpostRects(tid);
  for (let i = 0; i < mos.length; i++) {
    const r = mos[i];
    addClientBfsSeedsFromRectInVertices(vertices, r.x0, r.y0, r.w, r.h, out, stack);
  }
  addClientBfsSeedsTouchingBaseRectsInVertices(vertices, sp, mos, sp ? clientMainSpawnSideFromSpawn(sp) : FLAG_SPAWN_SIZE, out, stack);
  if (!stack.length) return new Set();
  while (stack.length) {
    const cur = stack.pop();
    const neigh = neighborKeysInSet8(cur, vertices, neighBuf);
    for (let i = 0; i < neigh.length; i++) {
      const nk = neigh[i];
      if (out.has(nk)) continue;
      out.add(nk);
      stack.push(nk);
    }
  }
  return out;
}

function getBaseConnSetForDrawFrame(teamId) {
  const tid = teamId | 0;
  if (baseConnCacheFrameId === drawConnectivityFrameId && baseConnCachedTeam === tid) {
    return baseConnCachedSet;
  }
  const s = computeClientBaseConnectedPixelKeys(tid);
  baseConnCacheFrameId = drawConnectivityFrameId;
  baseConnCachedTeam = tid;
  baseConnCachedSet = s;
  return s;
}
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

/** Антиспам: повторный purchaseVfx плацдарма своей команды (сетевой дубль / гонка). */
let lastMyTeamMilitaryPurchaseVfxAtMs = 0;

/** Повторный звук military_base для того же якоря 2×2 (дубль сообщения / репликация). */
let lastMilitaryDeploySoundKey = "";
let lastMilitaryDeploySoundAtMs = 0;

function playMilitaryBaseDeploySoundOncePerAnchor(teamId, gx, gy) {
  const tid = teamId | 0;
  const x = gx | 0;
  const y = gy | 0;
  const key = `${tid}:${x}:${y}`;
  const now = Date.now();
  if (key === lastMilitaryDeploySoundKey && now - lastMilitaryDeploySoundAtMs < 8000) return;
  lastMilitaryDeploySoundKey = key;
  lastMilitaryDeploySoundAtMs = now;
  playMilitaryBaseDeploySound();
}

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

/** Защита от чрезмерно больших JSON по WebSocket (память / parse). */
const MAX_WS_INCOMING_CHARS = 5_000_000;

/**
 * Пачка с сервера: больше порога — не вызывать pop/shield на каждую клетку (на телефоне это главный источник микрофризов).
 * Одиночные pixel / маленькие батчи визуально без изменений.
 */
const PIXEL_BATCH_VFX_MAX_CELLS = 22;

/** Минимум между перерисовками DOM рейтинга (stats); реже — меньше работы на слабых телефонах. */
const STATS_UI_MIN_INTERVAL_MS = 300;

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
/** Последний пакет stats для перерисовки при смене режима лидерборда. */
let lastStatsPayload = null;
/** Очки команд на прошлом кадре рейтинга — для лёгкой анимации при росте. */
const lastLbScoreByTeam = new Map();
/** Сколько строк рейтинга без прокрутки (остальные — только в полном списке на сервере). */
const LB_TOP_TEAMS_SHOWN = 15;
/** Сброс кинематографии событий при смене раунда. */
let lastRoundIndexForPresentation = -1;
let maxPerTeam = 200;
/** Сервер: false — только просмотр, без пикселей и команд */
let spectatorMode = false;
/** Время окончания текущего раунда (мс, Date.now()); null — лобби до «go» или нет таймера конца */
let roundEndsAtMs = null;
/** Когда начинается фаза боя после разминки; null — нет отсчёта (лобби до «go» и т.п.) */
let playStartsAtMs = null;
/** Сервер всегда шлёт 1×; раньше был тестовый «speed»-таймлайн. */
let tournamentTimeScaleClient = 1;
let roundIndexMeta = 0;
/** Сервер: до команды «go» можно свободно играть на карте (meta.lobbyBeforeGo). */
let lobbyBeforeGoMeta = false;
/** С сервера: игра полностью завершена (финал) */
let gameFinishedMeta = false;
/** С сервера: полная пауза (бот pause / unpause). */
let gamePausedMeta = false;
/** Wall-time старта паузы (как на сервере); 0 если не на паузе. Для «Мстим» на паузе таймер замирает. */
let pauseWallStartedAtMeta = 0;
/** С сервера: в момент паузы шла разминка (для подписи таймера). */
let pauseCapturedWarmupMeta = false;
/**
 * Если пауза пришла без валидного pauseWallStartedAt (meta без поля и т.п.), иначе таймер раунда
 * считает на живом Date.now() и «уезжает» за время паузы.
 */
let pauseUiFreezeWallMs = 0;
/** serverWallMs − Date.now() при последнем meta/wallet: lastActionAt и until с сервера в том же epoch (иначе «+N с» при рассинхроне часов). */
let walletServerSkewMs = 0;

/** Epoch ms из WS/meta: не использовать `x|0` — int32 обрезает wall-time после ~2038 и даёт неверную паузу/таймеры. */
function clampWsEpochMs(n) {
  const t = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(n)));
  return Number.isFinite(t) && t > 0 ? t : 0;
}

function reconcilePausedUiFreezeClock() {
  if (!gamePausedMeta) {
    pauseUiFreezeWallMs = 0;
    return;
  }
  if (pauseWallStartedAtMeta > 0) {
    pauseUiFreezeWallMs = 0;
    return;
  }
  if (pauseUiFreezeWallMs <= 0) pauseUiFreezeWallMs = Date.now();
}

/** UI «сейчас»: пауза — заморозка wall; иначе время, выровненное под сервер (serverWallMs из meta/wallet). */
function effectiveClientUiNowMs() {
  if (gamePausedMeta && pauseWallStartedAtMeta > 0) return pauseWallStartedAtMeta;
  if (gamePausedMeta && pauseUiFreezeWallMs > 0) return pauseUiFreezeWallMs;
  return Date.now() + walletServerSkewMs;
}

setMstimClientNowProvider(effectiveClientUiNowMs);
setPresentationNowProvider(effectiveClientUiNowMs);

function syncBackgroundMusicAllowed() {
  const allow = !spectatorMode && !gameFinishedMeta && !gamePausedMeta;
  setGameplayMusicAllowed(allow);
}
/** После leaveTeam открыть список команд (кнопка «Вступить», уже не в команде) */
let pendingLeaveToTeamList = false;
/** После leaveTeam открыть форму «Новая команда» (кнопка «Создать», пока ещё в команде) */
let pendingLeaveToCreate = false;

/** Экономика с сервера */
let walletState = null;

function getGreatWallChargesClient() {
  const n = Number(walletState?.greatWallCharges);
  return Number.isFinite(n) && n > 0 ? Math.min(999, n | 0) : 0;
}

function updateGreatWallShopStockUi() {
  const el = document.getElementById("shop-great-wall-stock");
  if (!el) return;
  const n = getGreatWallChargesClient();
  el.textContent = `Запас кирпичей: ${n}`;
  el.hidden = n < 1;
}

/** Позиции квантовых ферм с сервера (2×2 якоря). */
/** @type {{ id: number, x0: number, y0: number, w: number, h: number, level?: number }[]} */
let quantumFarmsMeta = [];
/** id фермы, к которой привязано контекстное меню (позиция обновляется в draw). */
let quantumFarmPanelAnchorFarmId = /** @type {number | null} */ (null);
let lastStatsGlobalEvent = null;
/** Предупреждение сейсмики: подсветка зон до удара. */
let seismicPreviewClient = null;
/** Визуальный «хвост» после удара (пыль / трещины). */
let seismicAftermathUntilMs = 0;
/** Кратковременный «ожог» зоны после тактической бомбы (сеточные координаты, пока gx1 >= gx0). */
let nukeAftermathUntilMs = 0;
let nukeAftermathGx0 = 0;
let nukeAftermathGy0 = 0;
let nukeAftermathGx1 = -1;
let nukeAftermathGy1 = -1;
/** Точная органическая маска взрыва для ожога (не заливка прямоугольником). */
/** @type {Set<string> | null} */
let nukeAftermathBlastKeys = null;
/** Тремор body.pb-seismic-tremor: превью + несколько секунд после удара (vfxLoop подстраховывает класс). */
let seismicAfterglowTremorUntilMs = 0;
/** @type {ReturnType<typeof setTimeout> | null} */
let boardSeismicShakeClearTimer = null;
/** Доля доступных очков (score share), для кризис-оверлея при просадке. */
let lastMyTeamScoreShare = null;
/** Прогресс захвата флага по защищающейся команде: teamId → { progress, attackerTeamId }. */
let flagCaptureClientState = new Map();

function clientMainFlagKey(teamId) {
  return `b:${teamId | 0}`;
}
function clientMilitaryFlagKey(teamId, x0, y0) {
  return `m:${teamId | 0}:${x0 | 0}:${y0 | 0}`;
}
/** Сообщения flag* с опциональным militaryAnchor для плацдарма 2×2 (левый верх). */
function clientFlagKeyFromServerMsg(msg) {
  if (
    msg.militaryAnchor &&
    typeof msg.militaryAnchor.x0 === "number" &&
    typeof msg.militaryAnchor.y0 === "number"
  ) {
    return clientMilitaryFlagKey(msg.defenderTeamId | 0, msg.militaryAnchor.x0, msg.militaryAnchor.y0);
  }
  return clientMainFlagKey(msg.defenderTeamId | 0);
}

/** Удалить состояние HP флага главной базы и всех FOB защитника (при полном захвате главной). */
function deleteFlagCaptureStateForDefenderTeam(did) {
  const d = did | 0;
  if (d <= 0) return;
  flagCaptureClientState.delete(clientMainFlagKey(d));
  const prefix = `m:${d}:`;
  for (const k of [...flagCaptureClientState.keys()]) {
    if (typeof k === "string" && k.startsWith(prefix)) flagCaptureClientState.delete(k);
  }
}
/** До какого времени показывать пульс/тревогу по своему флагу. */
let myFlagUnderAttackUntil = 0;
/** HP ≤ 1 у своей базы — усиленная тревога / тряска. */
let myFlagCriticalUntil = 0;
let crisisCooldownUntil = 0;
/** Ожидание тапа по карте: зона 4×4 или 6×6 */
let pendingMapAction = null;

/** Сетка под курсором для превью размещения передовой базы (-1 = нет). */
let mapHoverGx = -1;
let mapHoverGy = -1;

const CLIENT_MILITARY_GAP_OWN_MAIN = 4;
const CLIENT_MILITARY_GAP_ENEMY_MAIN = 6;
const CLIENT_SPAWN_RECT_GAP = 1;
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

/** Тот же центр-ячейки, что в server.js при сборке landGrid из базы размера sw×sh. */
function resampleRegionCells(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const bx = Math.min(sw - 1, Math.floor(((x + 0.5) / dw) * sw));
      const by = Math.min(sh - 1, Math.floor(((y + 0.5) / dh) * sh));
      out[y * dw + x] = src[by * sw + bx];
    }
  }
  return out;
}

function resampleRegionRgb(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 3);
  for (let y = 0; y < dh; y++) {
    for (let x = 0; x < dw; x++) {
      const bx = Math.min(sw - 1, Math.floor(((x + 0.5) / dw) * sw));
      const by = Math.min(sh - 1, Math.floor(((y + 0.5) / dh) * sh));
      const si = (by * sw + bx) * 3;
      const di = (y * dw + x) * 3;
      out[di] = src[si];
      out[di + 1] = src[si + 1];
      out[di + 2] = src[si + 2];
    }
  }
  return out;
}

/** Если нет regions-{gridW}.json (старый деплой / другой размер сетки), подгружаем известный JSON и ресэмплим. */
const REGION_JSON_FALLBACK_WIDTHS = [360, 640, 320, 160, 64];

function isClientLandCell(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!regionCells || regionCells.length !== gridW * gridH) {
    /* Онлайн без маски региона не считаем клетку игровой — иначе можно «закрасить всё подряд». */
    return !(wantOnline && getWsUrl());
  }
  return regionCells[y * gridW + x] !== 0;
}

/**
 * Куда можно ставить пиксель: region≠0 и цвет плаката не «океан» (как playableGrid на сервере).
 */
function isClientPlayableCell(x, y) {
  if (!isClientLandCell(x, y)) return false;
  if (!regionRgb || regionRgb.length !== gridW * gridH * 3) return true;
  const i = (y * gridW + x) * 3;
  return !isPosterOceanWaterRgb(regionRgb[i], regionRgb[i + 1], regionRgb[i + 2]);
}

function clientPixelTeamIdAt(x, y) {
  const v = pixels.get(`${x},${y}`);
  if (v === undefined) return null;
  const id = typeof v === "number" ? v : v.teamId;
  if (id == null || id === "") return null;
  return Number(id) | 0;
}

function clientPixelWallHpAt(x, y) {
  const v = pixels.get(`${x},${y}`);
  if (!v || typeof v !== "object") return 0;
  return normalizeWallHp(v.wallHp);
}

/** Прямоугольник базы команды из meta (как на сервере spawn, до 6×6). */
function clientTeamSpawnRect(teamId) {
  if (teamId == null || !teamsMeta) return null;
  const t = teamsMeta.find((x) => (x.id | 0) === (teamId | 0));
  const s = t?.spawn;
  if (!s || typeof s.x0 !== "number" || typeof s.y0 !== "number") return null;
  const w = typeof s.w === "number" ? s.w : FLAG_SPAWN_SIZE;
  const h = typeof s.h === "number" ? s.h : FLAG_SPAWN_SIZE;
  return { x0: s.x0, y0: s.y0, w, h };
}

/** Сторона главной базы из объекта spawn в teamsMeta (1…FLAG_SPAWN_SIZE). */
function clientMainSpawnSideFromSpawn(sp) {
  if (sp && typeof sp.w === "number" && sp.w >= 1) {
    return Math.max(1, Math.min(FLAG_SPAWN_SIZE, sp.w | 0));
  }
  return FLAG_SPAWN_SIZE;
}

function clientCellInsideSpawnRect(x, y, sp) {
  return x >= sp.x0 && x < sp.x0 + sp.w && y >= sp.y0 && y < sp.y0 + sp.h;
}

/** Прямоугольники передовых баз команды из meta (плацдарм 2×2, якорь — левый верх). */
function clientMilitaryOutpostRects(teamId) {
  if (teamId == null || !teamsMeta) return [];
  const t = teamsMeta.find((x) => (x.id | 0) === (teamId | 0));
  const arr = t?.militaryOutposts;
  if (!Array.isArray(arr)) return [];
  /** @type {{ x0: number, y0: number, w: number, h: number }[]} */
  const out = [];
  for (let i = 0; i < arr.length; i++) {
    const r = arr[i];
    if (!r || typeof r.x0 !== "number" || typeof r.y0 !== "number") continue;
    const w = typeof r.w === "number" ? r.w : MILITARY_OUTPOST_SIZE;
    const h = typeof r.h === "number" ? r.h : MILITARY_OUTPOST_SIZE;
    out.push({ x0: r.x0 | 0, y0: r.y0 | 0, w, h });
  }
  return out;
}

function clientCellInsideAnyMilitaryOutpost(x, y, teamId) {
  const rects = clientMilitaryOutpostRects(teamId);
  for (let i = 0; i < rects.length; i++) {
    if (clientCellInsideSpawnRect(x, y, rects[i])) return true;
  }
  return false;
}

/**
 * 8-соседство: своя закрашенная клетка только если в компоненте, снабжаемом с любой активной базы (главная 6×6 или плацдарм 2×2);
 * иначе — пустые клетки внутри прямоугольника главной базы / плацдарма.
 * `baseConnOverride` — свежий BFS при клике; иначе кэш на кадр (отрисовка зоны расширения).
 * Совпадает с cellTouchesTeamTerritory на сервере.
 */
function cellTouchesTeamTerritoryClient(x, y, teamId, baseConnOverride) {
  if (teamId == null) return false;
  const tid = teamId | 0;
  const sp = clientTeamSpawnRect(tid);
  const baseConn = baseConnOverride ?? getBaseConnSetForDrawFrame(tid);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const nk = `${nx},${ny}`;
      const o = clientPixelTeamIdAt(nx, ny);
      if (o != null && o === tid) {
        if (baseConn.has(nk)) return true;
        continue;
      }
      if (sp && clientCellInsideSpawnRect(nx, ny, sp)) return true;
      if (clientCellInsideAnyMilitaryOutpost(nx, ny, tid)) return true;
    }
  }
  return false;
}

/**
 * Клетки из keyStrings, достижимые от текущей территории команды через цепочку внутри множества (8-связность).
 * Совпадает с логикой filterPlannedReachableFromTeam на сервере для покупок зон.
 */
function filterClientKeysReachableFromTeam(keyStrings, teamId) {
  const baseConn = computeClientBaseConnectedPixelKeys(teamId | 0);
  const inSet = new Set(keyStrings);
  const seen = new Set();
  const queue = [];
  for (const k of keyStrings) {
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if (cellTouchesTeamTerritoryClient(x, y, teamId, baseConn) && !seen.has(k)) {
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
  const targetScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, 2.65));
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

/**
 * После создания/входа в команду canvas может быть ещё 0×0 (оверлеи только что закрылись).
 * Ждём нормальный размер и центрируем камеру на базе — это первое, что должен видеть игрок.
 */
function scheduleFocusOnMyTeamSpawn(spawn, withOnboarding) {
  if (!spawn) return;
  let attempts = 0;
  const maxAttempts = 40;
  const step = () => {
    attempts++;
    const cw = canvas.clientWidth | 0;
    const ch = canvas.clientHeight | 0;
    if (cw < 48 || ch < 48) {
      if (attempts < maxAttempts) {
        requestAnimationFrame(step);
        return;
      }
    }
    focusCameraOnTeamSpawn(spawn);
    if (withOnboarding) startTeamSpawnOnboarding(spawn);
    drawFull(performance.now());
  };
  requestAnimationFrame(step);
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
  detachSwipeDismissSlot("placement");
  if (placementFeedbackBannerEl) {
    resetDismissibleBannerNode(placementFeedbackBannerEl);
    placementFeedbackBannerEl.hidden = true;
    placementFeedbackBannerEl.classList.remove(
      "event-banner--feedback-warn",
      "event-banner--feedback-error",
      "event-banner--feedback-success",
      "event-banner--swipe-dismiss"
    );
  }
  if (cooldownLabel) {
    cooldownLabel.classList.remove("toolbar__cooldown--alert");
    setPendingHint();
  }
}

/**
 * Явный фидбек: полоска в тулбаре (cooldown-label) и/или верхний event-banner + тактильный отклик.
 * По умолчанию при показе тулбара верхняя плашка не дублируется; `skipEventBanner: false` — принудительно показать верх.
 * @param {"warn"|"error"|"success"|"ok"} severity
 * @param {{ telegramAlert?: boolean, bannerDurationMs?: number, skipCooldownChrome?: boolean, skipEventBanner?: boolean }} opts
 */
function showPlacementFeedback(text, severity, opts = {}) {
  const telegramAlert = opts.telegramAlert === true;
  const skipCooldownChrome = opts.skipCooldownChrome === true;
  const skipEventBanner = Object.prototype.hasOwnProperty.call(opts, "skipEventBanner")
    ? opts.skipEventBanner === true
    : !skipCooldownChrome;
  const rawHide =
    typeof opts.bannerDurationMs === "number" && Number.isFinite(opts.bannerDurationMs) && opts.bannerDurationMs > 0
      ? opts.bannerDurationMs
      : 5000;
  const hideMs = Math.min(rawHide, BANNER_MAX_VISIBLE_MS);
  let scheduleHide = false;
  if (placementFeedbackBannerEl && text && !skipEventBanner) {
    detachSwipeDismissSlot("placement");
    resetDismissibleBannerNode(placementFeedbackBannerEl);
    placementFeedbackBannerEl.textContent = text;
    placementFeedbackBannerEl.hidden = false;
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-warn", severity === "warn");
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-error", severity === "error");
    placementFeedbackBannerEl.classList.toggle("event-banner--feedback-success", severity === "success" || severity === "ok");
    placementFeedbackBannerEl.classList.add("event-banner--swipe-dismiss");
    attachSwipeDismissSlot("placement", placementFeedbackBannerEl, hidePlacementFeedbackBanner);
    scheduleHide = true;
  }
  if (cooldownLabel && text && !skipCooldownChrome) {
    cooldownLabel.hidden = false;
    cooldownLabel.textContent = text;
    cooldownLabel.classList.add("toolbar__cooldown--alert");
    cooldownLabel.title = text;
    scheduleHide = true;
  }
  if (scheduleHide && hideMs > 0) {
    if (placementFeedbackHideTimer) clearTimeout(placementFeedbackHideTimer);
    placementFeedbackHideTimer = setTimeout(() => {
      placementFeedbackHideTimer = null;
      hidePlacementFeedbackBanner();
    }, hideMs);
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

function triggerMapShake(ms = 560, mode = "default") {
  if (!stageWrapEl) return;
  stageWrapEl.classList.remove("map-shake", "map-shake--nuke");
  void stageWrapEl.offsetWidth;
  if (mode === "nuke") stageWrapEl.classList.add("map-shake--nuke");
  else stageWrapEl.classList.add("map-shake");
  setTimeout(() => {
    stageWrapEl.classList.remove("map-shake", "map-shake--nuke");
  }, ms);
}

/** Короткая тряска сцены при ударе по Великой стене (сильнее при обрушении). */
function triggerGreatWallImpactShake(mode = "hit") {
  const ms = mode === "break" ? 720 : 380;
  triggerMapShake(ms, "default");
}

/** Детерминированный «шум» для силы ожога по клетке (хаотично, но стабильно на кадрах). */
function nukeScorchHash01(gx, gy) {
  let h = ((gx | 0) * 374761393 + (gy | 0) * 668265263) >>> 0;
  h = (h ^ (h >>> 13) ^ (gx * 31 + gy)) >>> 0;
  return (h & 4095) / 4096;
}

/** «Ожог» только по клеткам реальной формы взрыва (как computeNukeBombBlastCells на сервере). */
function applyNukeAftermathFromEpicenter(gxi, gyi) {
  if (!Number.isFinite(gxi) || !Number.isFinite(gyi)) return;
  const xi = gxi | 0;
  const yi = gyi | 0;
  nukeAftermathUntilMs = Math.max(nukeAftermathUntilMs, Date.now() + 5200);
  const pairs = computeNukeBombBlastCells(
    xi,
    yi,
    roundIndexMeta,
    gridW,
    gridH,
    isClientPlayableCell,
    clientNoNukeBlastHoleExclusion
  );
  if (pairs.length === 0) {
    nukeAftermathBlastKeys = null;
    nukeAftermathGx1 = -1;
    return;
  }
  nukeAftermathBlastKeys = new Set();
  let mnX = Infinity;
  let mnY = Infinity;
  let mxX = -1;
  let mxY = -1;
  const myTAfter = myTeamId | 0;
  for (let i = 0; i < pairs.length; i++) {
    const x = pairs[i][0] | 0;
    const y = pairs[i][1] | 0;
    const pk = `${x},${y}`;
    if (myTAfter) {
      const v = pixels.get(pk);
      if (v != null) {
        const tid = typeof v === "number" ? v | 0 : Number(v.teamId) | 0;
        if (tid === myTAfter) continue;
      }
    }
    nukeAftermathBlastKeys.add(pk);
    mnX = Math.min(mnX, x);
    mnY = Math.min(mnY, y);
    mxX = Math.max(mxX, x);
    mxY = Math.max(mxY, y);
  }
  if (nukeAftermathBlastKeys.size === 0) {
    nukeAftermathBlastKeys = null;
    nukeAftermathGx1 = -1;
    return;
  }
  const margin = 1;
  nukeAftermathGx0 = Math.max(0, mnX - margin);
  nukeAftermathGy0 = Math.max(0, mnY - margin);
  nukeAftermathGx1 = Math.min(gridW - 1, mxX + margin);
  nukeAftermathGy1 = Math.min(gridH - 1, mxY + margin);
}

/** Центр клетки в клиентских координатах (для всплывающего текста над взрывом). */
function gridBlastCenterClientPx(gxi, gyi) {
  if (!canvas) return { x: window.innerWidth * 0.5, y: window.innerHeight * 0.36 };
  const cellPx = BASE_CELL * scale;
  const lx = offsetX + (gxi | 0) * cellPx + cellPx * 0.5;
  const ly = offsetY + (gyi | 0) * cellPx + cellPx * 0.5;
  const r = canvas.getBoundingClientRect();
  return { x: r.left + lx, y: r.top + ly };
}

/** Есть ли в органической зоне бомбы закрашенные клетки (для превью зелёный / красный). */
function clientNukeBlastWouldClearTerritory(cx, cy) {
  const pairs = computeNukeBombBlastCells(
    cx | 0,
    cy | 0,
    roundIndexMeta,
    gridW,
    gridH,
    isClientPlayableCell,
    clientNoNukeBlastHoleExclusion
  );
  const myT = myTeamId | 0;
  for (let i = 0; i < pairs.length; i++) {
    const x = pairs[i][0];
    const y = pairs[i][1];
    if (clientCellNukeProtectedSpawn(x, y)) {
      if (!myT || !teamsMeta) continue;
      for (const t of teamsMeta) {
        if (t.solo || t.eliminated || !t.spawn) continue;
        if ((t.id | 0) === myT) continue;
        const x0 = t.spawn.x0 | 0;
        const y0 = t.spawn.y0 | 0;
        const sw = clientMainSpawnSideFromSpawn(t.spawn);
        if (x >= x0 && x < x0 + sw && y >= y0 && y < y0 + sw) return true;
      }
      continue;
    }
    const v = pixels.get(`${x},${y}`);
    if (v == null) continue;
    const tid = typeof v === "number" ? v | 0 : Number(v.teamId) | 0;
    if (tid === 0) continue;
    if (myT && tid === myT) continue;
    return true;
  }
  return false;
}

/** Один раз на эпицентр ~10 с — не дублировать при позднем purchaseVfx после purchaseOk. */
let lastNukeFlashDedupeKey = "";
let lastNukeFlashDedupeAt = 0;
/** Совпадает с handlePurchaseOk — не дублировать boardVfx / «УДАР!» при позднем purchaseVfx. */
let lastNukeBoardVfxDedupeKey = "";
let lastNukeBoardVfxDedupeAt = 0;
function tryRunNukeFlashPresentation(epicGx, epicGy) {
  if (!Number.isFinite(epicGx) || !Number.isFinite(epicGy)) {
    runNukeFlashPresentation(epicGx, epicGy);
    return;
  }
  const k = `${epicGx | 0},${epicGy | 0}`;
  const t = performance.now();
  if (k === lastNukeFlashDedupeKey && t - lastNukeFlashDedupeAt < 10_000) return;
  lastNukeFlashDedupeKey = k;
  lastNukeFlashDedupeAt = t;
  runNukeFlashPresentation(epicGx, epicGy);
}

/** Красная вспышка + тряска силой по близости эпицентра к центру экрана. */
function runNukeFlashPresentation(epicGx, epicGy) {
  let closeness = 1;
  if (canvas && Number.isFinite(epicGx) && Number.isFinite(epicGy)) {
    const cellPx = BASE_CELL * scale;
    const scrCx = offsetX + (epicGx | 0) * cellPx + cellPx * 0.5;
    const scrCy = offsetY + (epicGy | 0) * cellPx + cellPx * 0.5;
    const mcx = canvas.clientWidth * 0.5;
    const mcy = canvas.clientHeight * 0.5;
    const d = Math.hypot(scrCx - mcx, scrCy - mcy);
    const ref = Math.max(130, Math.min(canvas.clientWidth, canvas.clientHeight) * 0.36);
    closeness = Math.max(0.12, 1 - Math.min(1, d / ref) * 0.94);
  }
  const shakeMs = Math.round(400 + closeness * 520);
  triggerMapShake(shakeMs, "nuke");
  runBoardSeismicHitShake();
  seismicAfterglowTremorUntilMs = Math.max(
    seismicAfterglowTremorUntilMs,
    Date.now() + 2400 + closeness * 900
  );
  applySeismicTremorBodyOverride();
  try {
    const ov = document.createElement("div");
    ov.className = "pb-nuke-flash-overlay";
    ov.setAttribute("aria-hidden", "true");
    document.body.appendChild(ov);
    const done = () => {
      ov.removeEventListener("animationend", done);
      ov.remove();
    };
    ov.addEventListener("animationend", done, { once: true });
    setTimeout(() => {
      if (ov.parentNode) ov.remove();
    }, 3200);
  } catch {
    /* ignore */
  }
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
  } catch {
    /* ignore */
  }
}

/**
 * Золотая вспышка + тряска: премиум-развёртывание передовой базы (все игроки).
 * Тяжёлая вибрация — только у игроков этой команды, чтобы не спамить зрителям.
 */
function runMilitaryBaseDeployPresentation(deployerTeamId) {
  triggerMapShake(1050);
  startBoardSeismicPreviewShake(820);
  const appEl = document.getElementById("app");
  if (appEl) {
    appEl.classList.add("fx-military-deploy-moment");
    setTimeout(() => appEl.classList.remove("fx-military-deploy-moment"), 1500);
  }
  try {
    const ov = document.createElement("div");
    ov.className = "pb-military-deploy-overlay";
    ov.setAttribute("aria-hidden", "true");
    document.body.appendChild(ov);
    const done = () => {
      ov.removeEventListener("animationend", done);
      ov.remove();
    };
    ov.addEventListener("animationend", done, { once: true });
    setTimeout(() => {
      if (ov.parentNode) ov.remove();
    }, 2400);
  } catch {
    /* ignore */
  }
  const tid = deployerTeamId | 0;
  if (myTeamId != null && tid && (myTeamId | 0) === tid) {
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("heavy");
    } catch {
      /* ignore */
    }
  }
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
 * Тот же изолированный карман, что уже был, только с новыми клетками (коридор к базе / сброс 20 с).
 * groupId с сервера = canonicalIsolationSig(cells) и меняется на каждый новый пиксель — дедуп только по множеству клеток.
 * @param {Set<string>} newCells
 * @param {Set<string>[]} priorCellSets
 */
function isolationPocketIsGrowthOrSameAsSomePrior(newCells, priorCellSets) {
  if (!priorCellSets.length || !newCells.size) return false;
  for (let i = 0; i < priorCellSets.length; i++) {
    const oldC = priorCellSets[i];
    if (!oldC || !oldC.size) continue;
    let allOldInNew = true;
    for (const k of oldC) {
      if (!newCells.has(k)) {
        allOldInNew = false;
        break;
      }
    }
    if (allOldInNew && newCells.size >= oldC.size) return true;
  }
  return false;
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
  /** @type {Set<string>[]} */
  const prevIsolationCellSetsMine = [];
  if (myTeamId != null) {
    const byGid = new Map();
    for (const [key, meta] of territoryIsolationCellMeta) {
      if ((meta.teamId | 0) !== (myTeamId | 0) || !meta.groupId) continue;
      if (!byGid.has(meta.groupId)) byGid.set(meta.groupId, new Set());
      byGid.get(meta.groupId).add(key);
    }
    for (const s of byGid.values()) prevIsolationCellSetsMine.push(s);
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

    const newCells = new Set();
    const cells = Array.isArray(g.cells) ? g.cells : [];
    for (let ci = 0; ci < cells.length; ci++) {
      const c = cells[ci];
      if (!Array.isArray(c) || c.length < 2) continue;
      newCells.add(`${c[0] | 0},${c[1] | 0}`);
    }
    if (isolationPocketIsGrowthOrSameAsSomePrior(newCells, prevIsolationCellSetsMine)) continue;

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
      playAlertTerritoryCutOff();
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
  durationMs = Math.min(
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : ALERT_AUTO_HIDE_MS,
    BANNER_MAX_VISIBLE_MS
  );
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

function hideServerAnnouncementBannerNow() {
  if (!serverAnnouncementBannerEl) return;
  if (serverAnnouncementHideTimer) {
    clearTimeout(serverAnnouncementHideTimer);
    serverAnnouncementHideTimer = null;
  }
  detachSwipeDismissSlot("serverSay");
  resetDismissibleBannerNode(serverAnnouncementBannerEl);
  serverAnnouncementBannerEl.hidden = true;
  serverAnnouncementBannerEl.textContent = "";
  serverAnnouncementBannerEl.classList.remove("event-banner--swipe-dismiss");
}

function showServerAnnouncementBanner(text, durationMs = 5000) {
  if (!serverAnnouncementBannerEl) return;
  if (serverAnnouncementHideTimer) {
    clearTimeout(serverAnnouncementHideTimer);
    serverAnnouncementHideTimer = null;
  }
  detachSwipeDismissSlot("serverSay");
  resetDismissibleBannerNode(serverAnnouncementBannerEl);
  serverAnnouncementBannerEl.textContent = String(text || "");
  serverAnnouncementBannerEl.hidden = false;
  serverAnnouncementBannerEl.classList.add("event-banner--swipe-dismiss");
  attachSwipeDismissSlot("serverSay", serverAnnouncementBannerEl, hideServerAnnouncementBannerNow);
  const dRaw =
    typeof durationMs === "number" && !Number.isNaN(durationMs) && durationMs > 0 ? durationMs : 5000;
  const d = Math.min(dRaw, BANNER_MAX_VISIBLE_MS);
  serverAnnouncementHideTimer = setTimeout(() => {
    serverAnnouncementHideTimer = null;
    hideServerAnnouncementBannerNow();
  }, d);
}

function showSeismicWarningBanner(
  title,
  sub,
  durationMs = SEISMIC_WARNING_BANNER_MS
) {
  if (!seismicWarningBannerEl) return;
  durationMs = Math.min(
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0
      ? durationMs
      : SEISMIC_WARNING_BANNER_MS,
    BANNER_MAX_VISIBLE_MS
  );
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
  const now = Date.now();
  /* Один взрыв на команду: flagCaptured и teamEliminated приходят подряд с разными координатами. */
  const key = `${tid}`;
  if (lastTeamElimVfxKey === key && now - lastTeamElimVfxAt < 900) return;
  lastTeamElimVfxKey = key;
  lastTeamElimVfxAt = now;
  boardVfx.defeatExplosion(gx | 0, gy | 0, msg.teamColor || "#ff3344", getVfxTransform());
}

/** Сразу пометить защитника выбывшим в кэше меты (до teamsFull), чтобы не оставалась «живая» база в UI. */
function patchTeamsMetaDefenderEliminated(defenderTeamId) {
  if (teamsMeta == null || defenderTeamId == null) return;
  const id = defenderTeamId | 0;
  teamsMeta = teamsMeta.map((t) => {
    if ((Number(t.id) | 0) !== id) return t;
    return { ...t, eliminated: true, spawn: null, militaryOutposts: [] };
  });
  invalidateTeamColorByIdCache();
}

/**
 * Сервер снял команду с игрока (захват базы / потеря территории). Синхронизация клиента без «оболочки» команды.
 * @param {boolean} canReenter раунд 0 — снова создать/вступить
 * @param {string} [defeatMessage]
 */
function applyMyTeamEliminatedClientState(canReenter, defeatMessage) {
  endSessionRestore();
  myTeamId = null;
  clearTeamIdentityFromSession();
  stripTeamFromUrl();
  hidePlacementFeedbackBanner();
  baseReminderUntil = 0;
  myTerritoryDangerUntil = 0;
  myTerritoryLastCellUntil = 0;
  lastTeamDangerCellsRemaining = 999;
  myFlagUnderAttackUntil = 0;
  myFlagCriticalUntil = 0;
  flagCaptureClientState.clear();
  invalidateTeamColorByIdCache();
  closeCreateTeamOverlay();
  closeTeamSettings();
  hideReferralSplash();
  if (canReenter) {
    showWelcomeOverlay();
    if (teamOverlay) teamOverlay.hidden = true;
  } else {
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    if (teamOverlay) teamOverlay.hidden = true;
    if (createTeamOverlay) createTeamOverlay.hidden = true;
    if (teamSettingsOverlay) teamSettingsOverlay.hidden = true;
  }
  rebuildTeamList();
  setFooterMode();
  schedulePersist();
  const line =
    typeof defeatMessage === "string" && defeatMessage.trim()
      ? defeatMessage.trim()
      : "Your base was captured. Your team has been destroyed.";
  showPlacementFeedback(line, "error", { telegramAlert: false });
  scheduleTeamDefeatOverlay(canReenter, line);
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("error");
  } catch {
    /* ignore */
  }
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
  scheduleFocusOnMyTeamSpawn(sp, true);
}

/** Нельзя держать/рисовать пиксель (вода по маске регионов). */
function isClientWaterCell(x, y) {
  return !isClientPlayableCell(x, y);
}

async function loadRegions() {
  const w = gridW;
  const h = gridH;
  regionCells = null;
  regionRgb = null;
  const widthsToTry = [...new Set([w, ...REGION_JSON_FALLBACK_WIDTHS.filter((x) => x !== w)])];
  for (const tw of widthsToTry) {
    try {
      const r = await fetch(`/data/regions-${tw}.json`);
      if (!r.ok) continue;
      const j = await r.json();
      const jw = j.w | 0;
      const jh = j.h | 0;
      let cells = b64ToUint8(j.cellsBase64);
      if (cells.length !== jw * jh) continue;
      if (jw !== w || jh !== h) cells = resampleRegionCells(cells, jw, jh, w, h);
      if (cells.length !== w * h) continue;
      regionCells = cells;
      if (j.rgbBase64 && typeof j.rgbBase64 === "string") {
        let raw = b64ToUint8(j.rgbBase64);
        if (raw.length === jw * jh * 3) {
          if (jw !== w || jh !== h) raw = resampleRegionRgb(raw, jw, jh, w, h);
          if (raw.length === w * h * 3) regionRgb = raw;
        }
      }
      return;
    } catch {
      /* следующий кандидат */
    }
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
  if (regionId === 0) return "#071222"; /* вода / небо — темнее, суше контраст */
  if (regionId === 1) return `hsl(38 32% 23%)`;
  const h = ((regionId - 2) * 53) % 360;
  return `hsl(${h} 36% 23%)`;
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

/** Центр клетки сетки → клиентские px (для DOM поверх карты). */
function gridCellCenterToClientPx(gcx, gcy) {
  if (!canvas) return null;
  const cell = BASE_CELL * scale;
  const bx = offsetX + gcx * cell;
  const by = offsetY + gcy * cell;
  const r = canvas.getBoundingClientRect();
  const cw = canvas.clientWidth || 1;
  const ch = canvas.clientHeight || 1;
  return {
    x: r.left + (bx / cw) * r.width,
    y: r.top + (by / ch) * r.height,
  };
}

/** Плавающий +N у фермы: только при «вчитанном» зуме и в центре внимания (без шума на обзоре). */
function clientWantsQuantumFarmIncomeFloatNearGrid(gcx, gcy) {
  if (!canvas) return false;
  const cell = BASE_CELL * scale;
  if (scale < 0.74 || cell < 6.1) return false;
  const bx = offsetX + gcx * cell;
  const by = offsetY + gcy * cell;
  const cw = canvas.clientWidth || 0;
  const ch = canvas.clientHeight || 0;
  const margin = 28;
  if (bx < margin || by < margin || bx > cw - margin || by > ch - margin) return false;
  const cx = cw * 0.5;
  const cy = ch * 0.5;
  const maxD = Math.min(cw, ch) * 0.42;
  const dx = bx - cx;
  const dy = by - cy;
  return dx * dx + dy * dy <= maxD * maxD;
}

function layoutQuantumFarmContextualPanel(f) {
  const dock = quantumFarmPanelDockEl;
  if (!dock || !f || !canvas) return;
  const gcx = f.x0 + f.w * 0.5;
  const gcy = f.y0 + f.h * 0.5;
  const tip = gridCellCenterToClientPx(gcx, gcy);
  if (!tip) return;
  const wasVis = dock.style.visibility;
  dock.style.visibility = "hidden";
  dock.style.left = "-9999px";
  dock.style.top = "0";
  const rect0 = dock.getBoundingClientRect();
  const dw = rect0.width || 268;
  const dh = rect0.height || 210;
  dock.style.visibility = wasVis || "";
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const pad = 10;
  let left = tip.x;
  let top = tip.y - dh - 20;
  left = Math.max(pad + dw * 0.5, Math.min(vw - pad - dw * 0.5, left));
  top = Math.max(pad, Math.min(vh - dh - pad - 12, top));
  dock.style.left = `${left}px`;
  dock.style.top = `${top}px`;
  const nib = dock.querySelector(".qf-command__nib");
  if (nib) {
    const dockLeft = left - dw * 0.5;
    const nibX = tip.x - dockLeft;
    const clamped = Math.max(32, Math.min(dw - 32, nibX));
    nib.style.left = `${clamped}px`;
  }
}

function syncQuantumFarmPanelLayoutIfOpen() {
  if (!quantumFarmPanelEl || quantumFarmPanelEl.hidden || quantumFarmPanelAnchorFarmId == null) return;
  const af = quantumFarmsMeta.find((x) => (x.id | 0) === (quantumFarmPanelAnchorFarmId | 0));
  if (!af) {
    closeQuantumFarmPanel();
    return;
  }
  layoutQuantumFarmContextualPanel(af);
}

function celebrateQuantumFarmUpgrade(f, lv) {
  const tr = getVfxTransform();
  const gcx = f.x0 + f.w * 0.5;
  const gcy = f.y0 + f.h * 0.5;
  boardVfx?.ripple(gcx | 0, gcy | 0, "#67e8f9", tr);
  boardVfx?.burst(gcx | 0, gcy | 0, "#a5f3fc", tr, 22);
  flushBoardVfxFrame();
  requestAnimationFrame(() => flushBoardVfxFrame());
  if (floatFxHost && clientWantsQuantumFarmIncomeFloatNearGrid(gcx, gcy)) {
    const pos = gridCellCenterToClientPx(gcx, gcy);
    if (pos) {
      spawnFloatingText(
        floatFxHost,
        `Уровень ${lv}`,
        { x: pos.x, y: pos.y - 22 },
        "float-fx__pop--quant-upgrade"
      );
    }
  }
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

/** Рейтинг: максимум 5 символов + «…», полное имя в title. */
const LEADERBOARD_NAME_MAX_CHARS = 5;

function setLeaderboardRowTeamName(el, fullName) {
  if (!el) return;
  const s = String(fullName ?? "").trim();
  const chars = [...s];
  if (chars.length <= LEADERBOARD_NAME_MAX_CHARS) {
    el.textContent = s;
    el.removeAttribute("title");
  } else {
    el.textContent = `${chars.slice(0, LEADERBOARD_NAME_MAX_CHARS).join("")}…`;
    el.title = s;
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
    bodyHtml: `<ul><li>До <strong>200</strong> игроков в команде, команд сколько угодно</li><li>Бой после разминки: <strong>5 ч</strong></li><li>Счёт = сумма весов захваченных клеток (суша = 1)</li><li>Пиксель только рядом с территорией (8 направлений), от базы 6×6</li><li><strong>Чужая главная база</strong>: удары по <strong>клетке флага</strong> — до <strong>50</strong> HP + добивание; <strong>плацдарм</strong> 2×2 (магазин) — <strong>20</strong> HP на весь блок; удар по любой клетке плацдарма; обычным пикселем базу не перекрасить; захват главной — вся команда</li><li>Победа: <strong>наибольший счёт</strong> к концу таймера</li></ul>`,
  },
  {
    title: "РАУНД 2 — КОМАНДНЫЙ БОЙ",
    splashKicker: "КОМАНДНЫЙ БОЙ",
    splashTitle: "РАУНД 2 СТАРТОВАЛ",
    bodyHtml: `<ul><li>До <strong>10</strong> игроков в команде</li><li>Бой: <strong>4 ч</strong></li><li>Цель: максимальный счёт</li><li><strong>Захват базы</strong> — с первой секунды боя: удары по клетке флага врага (смежно с вашей территорией)</li><li>Дальше проходит только <strong>одна</strong> победившая команда</li></ul>`,
  },
  {
    title: "РАУНД 3 — ПАРЫ",
    splashKicker: "СТАДИЯ ПАР",
    splashTitle: "РАУНД 3 СТАРТОВАЛ",
    bodyHtml: `<ul><li>Команды по <strong>2</strong> игрока</li><li>Бой: <strong>3 ч</strong></li><li>Счёт и захват как раньше; <strong>база врага</strong> уязвима со старта боя (клетка флага)</li><li>Дальше проходит только <strong>одна пара</strong></li></ul>`,
  },
  {
    title: "ФИНАЛ — 1 НА 1",
    splashKicker: "ДУЭЛЬ",
    splashTitle: "ФИНАЛ СТАРТОВАЛ",
    bodyHtml: `<ul><li><strong>2</strong> игрока — каждый создаёт <strong>свою</strong> команду из одного человека (в дуэль нельзя вступить чужой join)</li><li>Бой до <strong>2 ч</strong>: победа только <strong>захватом базы</strong> соперника <strong>или</strong> по <strong>большему счёту</strong>, когда истечёт время</li><li>В магазине — ускорение пикселя (личное и командное) и <strong>улучшение квантовых ферм</strong>; зоны, бомба и плацдарм отключены</li><li><strong>База</strong>: удары по клетке флага с начала боя</li></ul>`,
  },
];

function tournamentRoundCopy(ri) {
  const i = Math.min(Math.max(ri | 0, 0), 3);
  return TOURNAMENT_ROUND_COPY[i] || TOURNAMENT_ROUND_COPY[0];
}

function isClientWarmupPhase() {
  if (!wantOnline || !getWsUrl() || gameFinishedMeta || spectatorMode || gamePausedMeta) return false;
  if (playStartsAtMs == null || Number.isNaN(playStartsAtMs)) return false;
  if (roundIndexMeta === 0 && roundEndsAtMs == null) return false;
  return effectiveClientUiNowMs() < playStartsAtMs;
}

/** Совпадает с серверным isQuantumFarmIncomeAccrualPhaseNow: доход ферм/зон только в бою. */
function isClientQuantumFarmIncomeAccrualPhase() {
  if (!wantOnline || !getWsUrl() || gameFinishedMeta || spectatorMode || gamePausedMeta) return false;
  if (lobbyBeforeGoMeta) return false;
  if (isClientWarmupPhase()) return false;
  return true;
}

function syncAdminGamePauseOverlay() {
  if (!adminGamePauseOverlayEl) return;
  adminGamePauseOverlayEl.hidden = !gamePausedMeta;
  if (gamePausedMeta) {
    pendingMapAction = null;
    setPendingHint();
  }
  renderQuickBuyRail();
}

function syncTournamentWarmupOverlay() {
  if (!tournamentWarmupOverlayEl) return;
  if (gamePausedMeta) {
    tournamentWarmupOverlayEl.hidden = true;
    return;
  }
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
    const left = Math.max(0, playStartsAtMs - effectiveClientUiNowMs());
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

/** Все очки в UI: сырой счёт с сервера × множитель (единый для всех игроков). */
const HUD_SCORE_DISPLAY_SCALE = 0.0001;

function formatHudScore(n) {
  if (n == null || !Number.isFinite(Number(n))) return "—";
  const num = Number(n) * HUD_SCORE_DISPLAY_SCALE;
  const ax = Math.abs(num);
  if (ax >= 1_000_000) {
    const v = num / 1_000_000;
    const s = ax >= 10_000_000 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    return `${s}M`;
  }
  if (ax >= 1000) {
    const v = num / 1000;
    const s = ax >= 10_000 ? v.toFixed(0) : v.toFixed(1).replace(/\.0$/, "");
    return `${s}K`;
  }
  return (Math.round(num * 10) / 10).toFixed(1).replace(/\.0$/, "");
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
    if (sc != null) parts.push(`Счёт: ${formatHudScore(sc)} оч.`);
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
            `<div class="round-ended-overlay__row"><span>#${r.rank} ${r.emoji || ""} ${escapeHtml(String(r.name || ""))}</span><span>${typeof r.score === "number" ? formatHudScore(r.score) : "—"} оч.</span></div>`
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
  playRoundEndSfx();
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
      roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
      return;
    }
    if (gameFinishedMeta) {
      roundTimerEl.hidden = true;
      roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
      return;
    }
    if (gamePausedMeta) {
      roundTimerEl.hidden = false;
      roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
      const nowU = effectiveClientUiNowMs();
      if (roundEndsAtMs == null && roundIndexMeta === 0) {
        roundTimerEl.textContent = "ПАУЗА\nадмин";
      } else if (roundEndsAtMs != null && playStartsAtMs != null && nowU < playStartsAtMs) {
        const wLeft = Math.max(0, playStartsAtMs - nowU);
        const ws = Math.max(0, Math.ceil(wLeft / 1000));
        const wm = Math.floor(ws / 60);
        const wsec = ws % 60;
        roundTimerEl.textContent = `ПАУЗА · разминка ${wm}:${String(wsec).padStart(2, "0")}\nдо боя`;
      } else if (roundEndsAtMs != null) {
        const ms = roundEndsAtMs - nowU;
        if (ms <= 0) {
          roundTimerEl.textContent = "ПАУЗА\nКонец раунда…";
        } else {
          const s = Math.floor(ms / 1000);
          const h = Math.floor(s / 3600);
          const m = Math.floor((s % 3600) / 60);
          const sec = s % 60;
          const body =
            h > 0 ? `Бой ${h}ч ${m}м` : m > 0 ? `Бой ${m}м ${sec}с` : `Бой ${sec}с`;
          roundTimerEl.textContent = `ПАУЗА · ${body}`;
          if (ms <= 3 * 60 * 1000) roundTimerEl.classList.add("toolbar__round--critical");
          else if (ms <= 10 * 60 * 1000) roundTimerEl.classList.add("toolbar__round--urgent");
        }
      } else {
        roundTimerEl.textContent = "ПАУЗА\nадмин";
      }
      syncTournamentWarmupOverlay();
      return;
    }
    if (roundEndsAtMs == null && roundIndexMeta === 0) {
      roundTimerEl.hidden = false;
      roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
      roundTimerEl.textContent = lobbyBeforeGoMeta ? "Разминка" : "Ожидание старта\n«go» в боте";
      syncTournamentWarmupOverlay();
      return;
    }
    if (roundEndsAtMs == null) {
      roundTimerEl.hidden = true;
      roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
      syncTournamentWarmupOverlay();
      return;
    }
    roundTimerEl.hidden = false;
    roundTimerEl.classList.remove("toolbar__round--urgent", "toolbar__round--critical");
    if (isClientWarmupPhase()) {
      const wLeft = Math.max(0, (playStartsAtMs || 0) - effectiveClientUiNowMs());
      const ws = Math.max(0, Math.ceil(wLeft / 1000));
      const wm = Math.floor(ws / 60);
      const wsec = ws % 60;
      roundTimerEl.textContent = `Разминка ${wm}:${String(wsec).padStart(2, "0")}\nдо боя`;
    } else {
      const ms = roundEndsAtMs - effectiveClientUiNowMs();
      if (ms <= 0) {
        roundTimerEl.textContent = "Конец раунда…";
      } else {
        const s = Math.floor(ms / 1000);
        const h = Math.floor(s / 3600);
        const m = Math.floor((s % 3600) / 60);
        const sec = s % 60;
        roundTimerEl.textContent = h > 0 ? `Бой ${h}ч ${m}м` : m > 0 ? `Бой ${m}м ${sec}с` : `Бой ${sec}с`;
        if (ms <= 3 * 60 * 1000) roundTimerEl.classList.add("toolbar__round--critical");
        else if (ms <= 10 * 60 * 1000) roundTimerEl.classList.add("toolbar__round--urgent");
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
  syncBackgroundMusicAllowed();
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

let statsUiThrottleTimer = null;
/** @type {object | null} */
let statsUiPending = null;
let statsUiLastApplyAt = 0;

function flushThrottledStatsUi() {
  if (statsUiThrottleTimer != null) {
    clearTimeout(statsUiThrottleTimer);
    statsUiThrottleTimer = null;
  }
  if (!statsUiPending) return;
  const msg = statsUiPending;
  statsUiPending = null;
  statsUiLastApplyAt = Date.now();
  renderLeaderboardImmediate(msg);
}

/** Отложенное обновление таблицы очков: сливает частые пакеты stats в один проход. */
function scheduleThrottledStatsUi(msg) {
  statsUiPending = msg;
  const now = Date.now();
  if (now - statsUiLastApplyAt >= STATS_UI_MIN_INTERVAL_MS) {
    flushThrottledStatsUi();
    return;
  }
  if (statsUiThrottleTimer != null) return;
  statsUiThrottleTimer = setTimeout(() => {
    statsUiThrottleTimer = null;
    flushThrottledStatsUi();
  }, STATS_UI_MIN_INTERVAL_MS - (now - statsUiLastApplyAt));
}

function renderLeaderboardImmediate(msg) {
  if (!onlineCountEl || !leaderboardListEl) return;
  lastStatsPayload = msg;
  if (msg.globalEvent) {
    const incAlt0 = Number(msg.globalEvent.altSeasonRevengeUntilMs) || 0;
    if (incAlt0 > Date.now()) {
      setMstimAltSeasonClientBurstUntilMs(Math.max(incAlt0, getMstimAltSeasonClientBurstUntilStored()));
    }
    lastStatsGlobalEvent = msg.globalEvent;
    if (walletState) walletState.globalEvent = msg.globalEvent;
    syncClientCooldownFromWalletFields();
  }
  const rows = Array.isArray(msg.rows) ? msg.rows : [];
  lastLeaderboardRows = rows;
  onlineCountEl.textContent = String(msg.online ?? 0);

  const prevScores = new Map(lastLbScoreByTeam);
  const slice = rows.slice(0, LB_TOP_TEAMS_SHOWN);
  const myRow = myTeamId != null ? rows.find((r) => (r.teamId | 0) === (myTeamId | 0)) : null;
  const myInSlice = !!(myRow && slice.some((r) => (r.teamId | 0) === (myTeamId | 0)));

  leaderboardListEl.replaceChildren();

  for (let i = 0; i < slice.length; i++) {
    const row = slice[i];
    const li = document.createElement("li");
    li.className = "lb-row" + (i >= 3 ? " lb-row--past-top3" : "");
    li.style.setProperty("--lb-accent", row.color || "#64748b");
    if ((row.rank | 0) === 1) li.classList.add("lb-row--leader");
    if (myTeamId != null && (row.teamId | 0) === (myTeamId | 0)) li.classList.add("lb-row--mine");

    const main = document.createElement("div");
    main.className = "lb-row__main";
    const rankEl = document.createElement("span");
    rankEl.className = "lb-row__rank";
    rankEl.textContent = String(row.rank | 0);
    const em = document.createElement("span");
    em.className = "lb-row__emoji";
    em.textContent = row.emoji || "";
    const name = document.createElement("span");
    name.className = "lb-row__name";
    setLeaderboardRowTeamName(name, row.name || "");
    const scoreEl = document.createElement("span");
    scoreEl.className = "lb-row__score";
    const sc = typeof row.score === "number" ? row.score : null;
    scoreEl.textContent = formatHudScore(sc);
    const prevSc = prevScores.get(row.teamId | 0);
    if (prevSc != null && sc != null && sc > prevSc) {
      scoreEl.classList.add("lb-row__score--tick");
      setTimeout(() => scoreEl.classList.remove("lb-row__score--tick"), 550);
    }
    main.append(rankEl, em, name, scoreEl);
    li.append(main);

    const sub = document.createElement("div");
    sub.className = "lb-row__sub";
    const players = typeof row.players === "number" ? row.players : 0;
    const behind =
      typeof row.pointsBehindLeader === "number" &&
      (row.rank | 0) > 1 &&
      row.pointsBehindLeader > 0
        ? ` · −${formatHudScore(row.pointsBehindLeader)} до лидера`
        : "";
    sub.textContent = `${players} в команде${behind}`;
    li.append(sub);
    leaderboardListEl.appendChild(li);
  }

  if (myRow && !myInSlice && !spectatorMode && myTeamId != null && !gameFinishedMeta) {
    const sep = document.createElement("li");
    sep.className = "lb-row lb-row--sep lb-row--past-top3";
    sep.textContent = "···";
    leaderboardListEl.appendChild(sep);
    const yours = document.createElement("li");
    yours.className = "lb-row lb-row--mine lb-row--yours lb-row--past-top3";
    yours.style.setProperty("--lb-accent", myRow.color || "#5288c1");
    const yMain = document.createElement("div");
    yMain.className = "lb-row__main";
    const yLabel = document.createElement("span");
    yLabel.className = "lb-row__name";
    yLabel.textContent = "Ваша команда";
    yLabel.style.flex = "1";
    const ySc = document.createElement("span");
    ySc.className = "lb-row__score";
    ySc.textContent = `#${myRow.rank | 0} · ${formatHudScore(myRow.score)}`;
    yMain.append(yLabel, ySc);
    yours.append(yMain);
    leaderboardListEl.appendChild(yours);
  }

  lastLbScoreByTeam.clear();
  for (let ri = 0; ri < rows.length; ri++) {
    const r = rows[ri];
    if (typeof r.score === "number") lastLbScoreByTeam.set(r.teamId | 0, r.score);
  }

  if (myTeamId != null && !spectatorMode && !gameFinishedMeta) {
    const mine = rows.find((r) => (r.teamId | 0) === (myTeamId | 0));
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

/** Свернуть / развернуть виджет рейтинга (класс `lb-widget--collapsed` в hud-premium.css). */
function syncLeaderboardCollapsedChrome() {
  if (!leaderboardPanel || !leaderboardToggleEl) return;
  const collapsed = leaderboardPanel.classList.contains("lb-widget--collapsed");
  leaderboardToggleEl.setAttribute("aria-expanded", collapsed ? "false" : "true");
  leaderboardPanel.setAttribute("aria-expanded", collapsed ? "false" : "true");
  leaderboardToggleEl.title = collapsed ? "Показать полный рейтинг" : "Свернуть до топ‑3";
}

function setupLeaderboardPanelUi() {
  if (!leaderboardPanel || !leaderboardToggleEl) return;
  syncLeaderboardCollapsedChrome();
  leaderboardToggleEl.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    leaderboardPanel.classList.toggle("lb-widget--collapsed");
    syncLeaderboardCollapsedChrome();
    playMenuChoiceSfx();
  });
}

function clientPrefersReducedMotion() {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches === true;
  } catch {
    return false;
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

function isClientDuelRound() {
  return (roundIndexMeta | 0) === 3 || walletState?.tournamentStage === "DUEL";
}

/** Дуэль 1×1: вступление в чужие команды выключено; своя команда — через «Создать». */
function syncDuelTeamUi() {
  const duel = isClientDuelRound();
  if (btnWelcomeJoin) {
    btnWelcomeJoin.disabled = duel;
    btnWelcomeJoin.title = duel
      ? "В финальной дуэли нельзя вступить в чужую команду. Создайте свою — в ней только вы."
      : "";
    btnWelcomeJoin.style.opacity = duel ? "0.55" : "";
  }
  const lbl = document.getElementById("team-list-label");
  if (lbl) {
    lbl.textContent = duel
      ? "В дуэли в чужие команды войти нельзя. Создайте только свою (1 игрок на команду):"
      : "Или вступите в уже существующую:";
  }
}

function rebuildTeamList() {
  teamListEl.innerHTML = "";
  if (!teamsMeta) return;
  const duel = isClientDuelRound();
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated) continue;
    const cnt = teamCounts[t.id] ?? 0;
    const full = cnt >= maxPerTeam;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "team-list__btn";
    btn.disabled = full || duel;
    if (duel) btn.title = "В дуэли 1×1 только своя команда — создайте новую.";
    btn.setAttribute("role", "option");
    const swatch = document.createElement("span");
    swatch.className = "team-list__swatch";
    swatch.setAttribute("aria-hidden", "true");
    swatch.title = "Цвет команды на карте";
    swatch.style.backgroundColor = teamColor(t.id);
    const em = document.createElement("span");
    em.className = "team-list__emoji";
    em.textContent = t.emoji || "●";
    const name = document.createElement("span");
    setCompactTeamName(name, t.name);
    const left = document.createElement("span");
    left.style.display = "flex";
    left.style.alignItems = "center";
    left.appendChild(swatch);
    left.appendChild(em);
    left.appendChild(name);
    const meta = document.createElement("span");
    meta.className = "team-list__meta";
    meta.textContent = `${cnt} / ${maxPerTeam}`;
    btn.appendChild(left);
    btn.appendChild(meta);
    btn.addEventListener("click", () => {
      playMenuChoiceSfx();
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
  syncDuelTeamUi();
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

function hideTreasureFoundOverlay() {
  if (treasureFoundOverlayEl) treasureFoundOverlayEl.hidden = true;
}

/**
 * @param {number} quant
 */
function showTreasureFoundOverlay(quant) {
  if (!treasureFoundOverlayEl || !treasureFoundAmountEl) return;
  const q = quant | 0;
  if (q < 1) return;
  treasureFoundAmountEl.textContent = `+${q} ${quantWord(q)}`;
  treasureFoundOverlayEl.hidden = false;
  playTreasureFoundSfx();
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
  } catch {
    /* ignore */
  }
}

function cancelTeamDefeatUiTimer() {
  if (teamDefeatUiTimer) {
    clearTimeout(teamDefeatUiTimer);
    teamDefeatUiTimer = null;
  }
}

/**
 * @param {boolean} canReenter — раунд 0: можно снова создать/вступить в команду
 * @param {string} [primaryLine] — текст с сервера (например захват базы); иначе общий русский текст
 */
function scheduleTeamDefeatOverlay(canReenter, primaryLine) {
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
      typeof primaryLine === "string" && primaryLine.trim()
        ? primaryLine.trim()
        : "Вы проиграли. Ваша команда потеряла всю территорию и уничтожена.";
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

function getEmojiPresetButtonValue(btn) {
  const g = btn.querySelector(".emoji-presets__glyph");
  return (g?.textContent ?? btn.textContent ?? "").trim();
}

function syncCreateEmojiPresetHighlight() {
  if (!createTeamEmojiPresets || !createTeamEmojiInput) return;
  const cur = createTeamEmojiInput.value.trim();
  createTeamEmojiPresets.querySelectorAll(".emoji-presets__btn").forEach((btn) => {
    btn.setAttribute("aria-pressed", getEmojiPresetButtonValue(btn) === cur ? "true" : "false");
  });
}

function buildCreateTeamEmojiPresets() {
  if (!createTeamEmojiPresets) return;
  createTeamEmojiPresets.innerHTML = "";
  for (const e of EMOJI_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-presets__btn";
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `Смайлик ${e}`);
    const glyph = document.createElement("span");
    glyph.className = "emoji-presets__glyph";
    glyph.textContent = e;
    glyph.setAttribute("aria-hidden", "true");
    b.appendChild(glyph);
    b.addEventListener("click", () => {
      if (createTeamEmojiInput) createTeamEmojiInput.value = e;
      syncCreateEmojiPresetHighlight();
    });
    createTeamEmojiPresets.appendChild(b);
  }
  createTeamEmojiInput?.addEventListener("input", syncCreateEmojiPresetHighlight);
}

function normalizeCreateTeamPaletteHex(s) {
  let t = String(s || "").trim();
  if (!t) return "";
  let h = t.startsWith("#") ? t : `#${t}`;
  if (h.length === 4 && /^#[0-9a-f]{3}$/i.test(h)) {
    h = `#${h[1]}${h[1]}${h[2]}${h[2]}${h[3]}${h[3]}`;
  }
  return h.toUpperCase();
}

/** Индексы TEAM_CREATE_PALETTE, уже занятые командами (не eliminated). */
function getTakenCreateTeamPaletteIndexSet() {
  const taken = new Set();
  const paletteUp = TEAM_CREATE_PALETTE.map((hex) => normalizeCreateTeamPaletteHex(hex));
  if (!teamsMeta || !teamsMeta.length) return taken;
  for (const t of teamsMeta) {
    if (t.eliminated) continue;
    const c = normalizeCreateTeamPaletteHex(t.color);
    if (!c) continue;
    const idx = paletteUp.indexOf(c);
    if (idx >= 0) taken.add(idx);
  }
  return taken;
}

function pickFirstAvailableCreateTeamColorIdx() {
  const taken = getTakenCreateTeamPaletteIndexSet();
  for (let i = 0; i < TEAM_CREATE_PALETTE.length; i++) {
    if (!taken.has(i)) return i;
  }
  return 0;
}

function refreshCreateTeamColorPaletteIfOverlayOpen() {
  if (!createTeamOverlay || createTeamOverlay.hidden) return;
  const taken = getTakenCreateTeamPaletteIndexSet();
  if (taken.has(createTeamColorIdx)) {
    createTeamColorIdx = pickFirstAvailableCreateTeamColorIdx();
  }
  buildCreateTeamColorPalette();
}

function buildCreateTeamColorPalette() {
  if (!createTeamColorPaletteEl) return;
  createTeamColorPaletteEl.innerHTML = "";
  const taken = getTakenCreateTeamPaletteIndexSet();
  TEAM_CREATE_PALETTE.forEach((hex, i) => {
    const isTaken = taken.has(i);
    const b = document.createElement("button");
    b.type = "button";
    b.className = "palette__swatch";
    if (hex.toUpperCase() === "#FFFFFF" || hex.toUpperCase() === "#EEFF41") {
      b.classList.add("palette__swatch--needs-ring");
    }
    if (isTaken) {
      b.classList.add("palette__swatch--taken");
      b.disabled = true;
      b.setAttribute("aria-disabled", "true");
      b.title = "Этот цвет уже занят другой командой";
    }
    b.style.setProperty("--swatch", hex);
    b.setAttribute("role", "option");
    b.setAttribute("aria-selected", !isTaken && i === createTeamColorIdx ? "true" : "false");
    b.dataset.index = String(i);
    if (!isTaken) b.title = hex;
    if (!isTaken) {
      b.addEventListener("click", () => {
        createTeamColorIdx = i;
        createTeamColorPaletteEl.querySelectorAll(".palette__swatch").forEach((el) => {
          if (el.classList.contains("palette__swatch--taken") || el.disabled) return;
          el.setAttribute("aria-selected", el.dataset.index === String(i) ? "true" : "false");
        });
      });
    }
    createTeamColorPaletteEl.appendChild(b);
  });
}

/** Текст про рефералку и +10 квантов — только в массовом раунде (индекс 0). */
function syncCreateTeamReferralHintVisibility() {
  if (!createTeamReferralHintEl) return;
  createTeamReferralHintEl.hidden = (roundIndexMeta | 0) !== 0;
}

function setCreateTeamInlineError(text) {
  if (!createTeamInlineErrorEl) return;
  const t = String(text || "").trim();
  if (!t) {
    createTeamInlineErrorEl.hidden = true;
    createTeamInlineErrorEl.textContent = "";
    return;
  }
  createTeamInlineErrorEl.textContent = t;
  createTeamInlineErrorEl.hidden = false;
  try {
    createTeamInlineErrorEl.scrollIntoView({ block: "nearest", behavior: "smooth" });
  } catch {
    /* ignore */
  }
}

/** Подсказки в форме «Создать команду» при ответе сервера `playRejected`. */
const CREATE_TEAM_PLAY_REJECT_HINTS = {
  spectator:
    "Сервер отклонил создание команды: нет допуска к этому этапу или включён режим наблюдателя. Обновите Mini App (меню ⋯) или откройте ссылку из бота после прошлого раунда — нужен токен победителя.",
  not_eligible:
    "В списке допущенных к этому этапу вас нет (обычно только участники победившей команды прошлого раунда). Играйте с той же учётной записью Telegram, что и раньше.",
  need_telegram: "Откройте игру из Telegram Mini App (нужна подпись initData).",
};

function setCreateTeamInlineErrorIfOverlayOpenForPlayReject(reason) {
  if (!createTeamOverlay || createTeamOverlay.hidden) return;
  const r = String(reason || "").trim();
  const line = CREATE_TEAM_PLAY_REJECT_HINTS[r];
  if (line) setCreateTeamInlineError(line);
}

function openCreateTeamOverlay(fromWelcome) {
  hideRoundEndedOverlay();
  createTeamFromWelcome = !!fromWelcome;
  setCreateTeamInlineError("");
  if (createTeamNameInput) createTeamNameInput.value = "";
  if (createTeamEmojiInput) createTeamEmojiInput.value = EMOJI_PRESETS[0] || "🔥";
  syncCreateEmojiPresetHighlight();
  createTeamColorIdx = Math.min(createTeamColorIdx, TEAM_CREATE_PALETTE.length - 1);
  if (getTakenCreateTeamPaletteIndexSet().has(createTeamColorIdx)) {
    createTeamColorIdx = pickFirstAvailableCreateTeamColorIdx();
  }
  buildCreateTeamColorPalette();
  syncCreateTeamReferralHintVisibility();
  if (createTeamOverlay) createTeamOverlay.hidden = false;
  requestAnimationFrame(() => {
    try {
      createTeamNameInput?.focus();
      createTeamNameInput?.scrollIntoView({ block: "center", behavior: "smooth" });
    } catch {
      /* ignore */
    }
  });
}

function closeCreateTeamOverlay() {
  setCreateTeamInlineError("");
  if (createTeamOverlay) createTeamOverlay.hidden = true;
}

function submitCreateTeamCommitted() {
  if (sessionRestorePending) {
    const m = "Подождите секунду — восстанавливается сессия.";
    setCreateTeamInlineError(m);
    showPlacementFeedback(m, "warn", { telegramAlert: false });
    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    return;
  }
  const name = createTeamNameInput?.value.trim() ?? "";
  const emoji = createTeamEmojiInput?.value.trim() ?? "";
  if (!name || !emoji) {
    const msg = !name
      ? "Введите название команды (поле вверху формы)."
      : "Выберите или введите смайлик команды.";
    setCreateTeamInlineError(msg);
    showPlacementFeedback(msg, "warn", { telegramAlert: false });
    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showAlert === "function") tg.showAlert(msg);
    if (!name) {
      try {
        createTeamNameInput?.focus();
        createTeamNameInput?.scrollIntoView({ block: "center", behavior: "smooth" });
      } catch {
        /* ignore */
      }
    }
    return;
  }
  const ci = Math.max(0, Math.min(createTeamColorIdx, TEAM_CREATE_PALETTE.length - 1));
  if (getTakenCreateTeamPaletteIndexSet().has(ci)) {
    const m = "Этот цвет уже занят — выберите другой.";
    setCreateTeamInlineError(m);
    showPlacementFeedback(m, "warn", { telegramAlert: false });
    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    createTeamColorIdx = pickFirstAvailableCreateTeamColorIdx();
    buildCreateTeamColorPalette();
    return;
  }
  const color = TEAM_CREATE_PALETTE[ci];
  if (!color) {
    const m = "Выберите цвет команды.";
    setCreateTeamInlineError(m);
    showPlacementFeedback(m, "warn", { telegramAlert: false });
    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const m =
      "Нет соединения с сервером (WebSocket). Подождите «онлайн» в интерфейсе или обновите страницу. Если не помогает — проверьте, что сервер на Render запущен и Cloudflare пропускает WebSocket.";
    setCreateTeamInlineError(m);
    showPlacementFeedback(m, "error", { telegramAlert: false });
    const tg = window.Telegram?.WebApp;
    if (typeof tg?.showAlert === "function") tg.showAlert(m);
    return;
  }
  if (spectatorMode && !gameFinishedMeta) {
    const m =
      roundIndexMeta > 0
        ? "Клиент в режиме наблюдателя или допуск к этапу ещё не подтверждён. Подождите секунду, обновите Mini App или откройте ссылку из бота — затем снова «Создать команду»."
        : "Клиент в режиме наблюдателя — создание команды сейчас недоступно. Обновите страницу или откройте игру из Telegram.";
    setCreateTeamInlineError(m);
    showPlacementFeedback(m, "warn", { telegramAlert: false });
    tryClaimEligibility();
    return;
  }
  setCreateTeamInlineError("");
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

function submitCreateTeam() {
  submitCreateTeamCommitted();
}

function showWelcomeOverlay() {
  hideRoundEndedOverlay();
  if (welcomeOverlay) welcomeOverlay.hidden = false;
  syncWelcomeOnboardingLayout();
}

function hasBridgedTelegramInitInSession() {
  try {
    return Boolean(sessionStorage.getItem(BRIDGE_INIT_STORAGE_KEY)?.trim());
  } catch {
    return false;
  }
}

/**
 * Первый экран только в Telegram Mini App: есть подписанный initData, и это не сценарий «уже в браузере» (мост).
 * Без подписи не считаем Mini App — иначе в обычном браузере повторялся блок «откройте в браузере».
 */
function isWelcomeTelegramMiniBeforeBrowser() {
  if (hasBridgedTelegramInitInSession()) return false;
  if (hasTelegramBridgeTokenInUrl()) return false;
  const tg = window.Telegram?.WebApp;
  if (!tg) return false;
  const signed = typeof tg.initData === "string" ? tg.initData.trim() : "";
  return signed.length > 0;
}

/**
 * Любой шелл Telegram Mini App до перехода «Открыть в браузере» — без Web Audio (включая BGM).
 * В обычном браузере после моста объекта WebApp обычно нет.
 */
function shouldSuppressGameAudioInTelegramShell() {
  if (hasBridgedTelegramInitInSession()) return false;
  if (hasTelegramBridgeTokenInUrl()) return false;
  return !!window.Telegram?.WebApp;
}

/** В Mini App — текст + «Открыть в браузере», кнопки команд неактивны; в браузере после моста — полное меню. */
function syncWelcomeOnboardingLayout() {
  let miniFirst = false;
  try {
    miniFirst = isWelcomeTelegramMiniBeforeBrowser();
    if (miniFirst) {
      if (welcomePromoBubble) welcomePromoBubble.hidden = true;
      if (welcomeLeadStandard) welcomeLeadStandard.hidden = true;
      if (welcomeTeamFlow) welcomeTeamFlow.hidden = false;
      if (welcomeOpenBrowserWrap) welcomeOpenBrowserWrap.hidden = false;
      if (welcomeDiscussionWrap) welcomeDiscussionWrap.hidden = true;
      welcomePanel?.classList.add("welcome-panel--mini-browser-first");
      if (btnWelcomeCreate) btnWelcomeCreate.disabled = true;
      if (btnWelcomeJoin) btnWelcomeJoin.disabled = true;
    } else {
      if (welcomePromoBubble) welcomePromoBubble.hidden = false;
      if (welcomeLeadStandard) welcomeLeadStandard.hidden = false;
      if (welcomeTeamFlow) welcomeTeamFlow.hidden = false;
      if (welcomeOpenBrowserWrap) welcomeOpenBrowserWrap.hidden = true;
      welcomePanel?.classList.remove("welcome-panel--mini-browser-first");
      if (btnWelcomeCreate) btnWelcomeCreate.disabled = false;
      if (btnWelcomeJoin) btnWelcomeJoin.disabled = false;
      syncDiscussionChatLinks();
    }
  } catch {
    /* ignore */
  }
  setSuppressAudioUntilOpenedInBrowser(shouldSuppressGameAudioInTelegramShell());
}

let welcomeOpenBrowserClickBound = false;

function setupWelcomeOpenBrowserBridge() {
  if (!btnWelcomeOpenBrowser || welcomeOpenBrowserClickBound) return;
  welcomeOpenBrowserClickBound = true;
  btnWelcomeOpenBrowser.addEventListener("click", async () => {
    const tg = window.Telegram?.WebApp;
    const initData = getTelegramInitDataForServer().trim();
    if (!initData) {
      const m =
        "Telegram ещё не передал подписанные данные. Подождите секунду и нажмите снова или выберите «Обновить страницу» в меню (⋯).";
      if (typeof tg?.showAlert === "function") tg.showAlert(m);
      else alert(m);
      syncWelcomeOnboardingLayout();
      return;
    }
    try {
      const r = await fetch("/api/auth/telegram-bridge-token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initData }),
      });
      const j = await r.json().catch(() => ({}));
      if (!j?.ok || typeof j.url !== "string" || !j.url.trim()) {
        const msg =
          j?.error === "PUBLIC_BASE_URL not set"
            ? "На сервере не задан PUBLIC_BASE_URL."
            : "Не удалось получить ссылку. Попробуйте позже.";
        if (typeof tg?.showAlert === "function") tg.showAlert(msg);
        else alert(msg);
        return;
      }
      if (typeof tg?.openLink === "function") {
        tg.openLink(j.url.trim(), { try_instant_view: false });
      } else {
        window.open(j.url.trim(), "_blank", "noopener,noreferrer");
      }
    } catch {
      if (typeof tg?.showAlert === "function") tg.showAlert("Ошибка сети.");
      else alert("Ошибка сети.");
    }
  });
  syncWelcomeOnboardingLayout();
  for (const ms of [0, 50, 200, 500, 1500]) {
    window.setTimeout(() => syncWelcomeOnboardingLayout(), ms);
  }
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.onEvent === "function") {
    tg.onEvent("viewportChanged", () => syncWelcomeOnboardingLayout());
  }
}

function setupWelcomeUi() {
  btnWelcomeClose?.addEventListener("click", () => {
    if (welcomeOverlay) welcomeOverlay.hidden = true;
  });
  welcomeOverlay?.addEventListener("click", (e) => {
    if (e.target === welcomeOverlay) welcomeOverlay.hidden = true;
  });
  btnWelcomeCreate?.addEventListener("click", () => {
    playMenuChoiceSfx();
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
    if (isClientDuelRound()) {
      const tg = window.Telegram?.WebApp;
      const m =
        "В финальной дуэли нельзя вступить в чужую команду. Нажмите «Создать команду» — в команде будете только вы.";
      if (typeof tg?.showAlert === "function") tg.showAlert(m);
      else alert(m);
      return;
    }
    playMenuChoiceSfx();
    if (myTeamId != null) {
      pendingLeaveToTeamList = true;
      pendingLeaveToCreate = false;
      if (welcomeOverlay) welcomeOverlay.hidden = true;
      sendLeaveTeamRequest();
      return;
    }
    if (welcomeOverlay) welcomeOverlay.hidden = true;
    hideRoundEndedOverlay();
    if (teamOverlay) teamOverlay.hidden = false;
  });
  btnTeamOverlayBack?.addEventListener("click", () => {
    if (teamOverlay) teamOverlay.hidden = true;
    showWelcomeOverlay();
  });
  welcomeDiscussionLink?.addEventListener("click", openDiscussionChatLink);
  toolbarDiscussionLink?.addEventListener("click", openDiscussionChatLink);

  setupWelcomeOpenBrowserBridge();
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
  const createTeamForm = document.getElementById("create-team-form");
  createTeamForm?.addEventListener("submit", (e) => {
    e.preventDefault();
    if (Date.now() < createTeamIgnoreSubmitUntilMs) return;
    submitCreateTeamCommitted();
  });
  /* Telegram WebView / iOS: первый тап по кнопке иногда только снимает фокус с input — touchend + preventDefault даёт надёжный submit */
  btnCreateTeamSubmit?.addEventListener(
    "touchend",
    (e) => {
      e.preventDefault();
      createTeamIgnoreSubmitUntilMs = Date.now() + 450;
      submitCreateTeamCommitted();
    },
    { passive: false }
  );
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
    playMenuOpenSfx();
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
    refreshUsdtDepositUi();
    updateShopAvailability();
  });
  document.getElementById("crisis-cta-team-recovery")?.addEventListener("click", () => {
    hideCrisisOverlay();
    playMenuOpenSfx();
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
    refreshUsdtDepositUi();
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
    playMenuChoiceSfx();
    hideDefeatOverlay();
    openCreateTeamOverlay(true);
  });
  defeatBtnJoin?.addEventListener("click", () => {
    playMenuChoiceSfx();
    hideDefeatOverlay();
    hideRoundEndedOverlay();
    if (teamOverlay) teamOverlay.hidden = false;
  });
  defeatBtnDismiss?.addEventListener("click", hideDefeatOverlay);
  defeatOverlayEl?.addEventListener("click", (e) => {
    if (e.target === defeatOverlayEl) hideDefeatOverlay();
  });
  treasureFoundDismissBtn?.addEventListener("click", hideTreasureFoundOverlay);
  initQuantumFarmPanel();
  treasureFoundOverlayEl?.addEventListener("click", (e) => {
    if (e.target === treasureFoundOverlayEl) hideTreasureFoundOverlay();
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
    btn.setAttribute("aria-pressed", getEmojiPresetButtonValue(btn) === cur ? "true" : "false");
  });
}

function buildEmojiPresets() {
  if (!teamSettingsEmojiPresets) return;
  teamSettingsEmojiPresets.innerHTML = "";
  for (const e of EMOJI_PRESETS) {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "emoji-presets__btn";
    b.setAttribute("aria-pressed", "false");
    b.setAttribute("aria-label", `Смайлик ${e}`);
    const glyph = document.createElement("span");
    glyph.className = "emoji-presets__glyph";
    glyph.textContent = e;
    glyph.setAttribute("aria-hidden", "true");
    b.appendChild(glyph);
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
  playMenuOpenSfx();
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
  if (welcomeDiscussionWrap) {
    welcomeDiscussionWrap.hidden = !show || isWelcomeTelegramMiniBeforeBrowser();
  }
  if (toolbarDiscussionLink) toolbarDiscussionLink.hidden = !show;
  if (welcomeDiscussionLink) welcomeDiscussionLink.href = url || "#";
  if (toolbarDiscussionLink) toolbarDiscussionLink.href = url || "#";
}

function syncTreasureSpotsFromMeta(msg) {
  if (!Array.isArray(msg.treasureSpots)) return;
  const gw = typeof msg.grid?.w === "number" ? msg.grid.w | 0 : gridW;
  const gh = typeof msg.grid?.h === "number" ? msg.grid.h | 0 : gridH;
  treasureSpotKeys.clear();
  for (let i = 0; i < msg.treasureSpots.length; i++) {
    const s = msg.treasureSpots[i];
    if (typeof s !== "string") continue;
    const m = /^(\d+),(\d+)$/.exec(s.trim());
    if (!m) continue;
    const x = Number(m[1]);
    const y = Number(m[2]);
    if (x >= 0 && x < gw && y >= 0 && y < gh) treasureSpotKeys.add(`${x},${y}`);
  }
  scheduleDraw({ full: true });
}

function onMeta(msg) {
  if (typeof msg.serverWallMs === "number" && Number.isFinite(msg.serverWallMs) && msg.serverWallMs > 946684800000) {
    walletServerSkewMs = msg.serverWallMs - Date.now();
  }
  discussionChatUrl =
    typeof msg.discussionChatUrl === "string" && msg.discussionChatUrl.trim()
      ? msg.discussionChatUrl.trim()
      : "";
  syncDiscussionChatLinks();
  syncTreasureSpotsFromMeta(msg);

  teamsMeta = msg.teams || [];
  baseConnCacheFrameId = -1;
  invalidateTeamColorByIdCache();
  syncFlagCaptureStateFromMeta(msg.flags);
  teamCounts = msg.teamCounts || {};
  maxPerTeam = msg.maxPerTeam ?? 200;
  gameFinishedMeta = !!msg.gameFinished;
  gamePausedMeta = !!msg.gamePaused;
  if (!gamePausedMeta) {
    pauseWallStartedAtMeta = 0;
  } else {
    const pw =
      typeof msg.pauseWallStartedAt === "number" && !Number.isNaN(msg.pauseWallStartedAt)
        ? clampWsEpochMs(msg.pauseWallStartedAt)
        : 0;
    if (pw > 0) pauseWallStartedAtMeta = pw;
  }
  pauseCapturedWarmupMeta =
    gamePausedMeta && typeof msg.pauseCapturedWarmup === "boolean" ? !!msg.pauseCapturedWarmup : false;
  reconcilePausedUiFreezeClock();
  syncAdminGamePauseOverlay();
  syncClientCooldownFromWalletFields();
  roundEndsAtMs =
    typeof msg.roundEndsAt === "number" && !Number.isNaN(msg.roundEndsAt) ? msg.roundEndsAt : null;
  playStartsAtMs =
    typeof msg.playStartsAt === "number" && !Number.isNaN(msg.playStartsAt)
      ? msg.playStartsAt
      : typeof msg.warmupEndsAt === "number" && !Number.isNaN(msg.warmupEndsAt)
        ? msg.warmupEndsAt
        : null;
  const nextRi = typeof msg.roundIndex === "number" ? msg.roundIndex : 0;
  /* Итог раунда (z-index 230) иначе перекрывает welcome/команду (100) — убираем при смене этапа по meta. */
  if (typeof msg.roundIndex === "number" && nextRi !== roundIndexMeta) {
    hideRoundEndedOverlay();
  }
  if (nextRi !== lastRoundIndexForPresentation) {
    lastRoundIndexForPresentation = nextRi;
    resetEventPresentationForRound();
    seismicAfterglowTremorUntilMs = 0;
    stopBoardSeismicShake();
  }
  roundIndexMeta = nextRi;
  syncCreateTeamReferralHintVisibility();
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

  if (Array.isArray(msg.quantumFarms)) {
    mergeQuantumFarmsFromServerPayload(msg.quantumFarms);
  }

  applyGridFromServer(gw, gh).then(() => {
    try {
      rebuildTeamList();
      updateRoundTimer();
      syncTournamentWarmupOverlay();
      syncAdminGamePauseOverlay();
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
      syncDuelTeamUi();
      refreshCreateTeamColorPaletteIfOverlayOpen();
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
    paused: "Игра на паузе (администратор). Действия временно отключены.",
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
    nuke_no_effect:
      "Бомба не дала эффекта: в кратере нет закраски для сброса и не задета чужая главная база 6×6.",
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
    /* Только верхняя плашка — строка таймера занята подсказкой need_telegram */
    skipCooldownChrome: reason === "need_telegram",
  });
  if (reason === "not_adjacent" || reason === "enemy_base_not_adjacent") {
    remindInvalidPlacementBase(false);
  }
  playUiError();
}

/**
 * HP полоски флага: якорь + lastHitAt и при наличии снимок effectiveHp с сервера (реген без рассинхрона).
 * @param {number} [maxHpFallback] если нет записи в raw — главная {@link FLAG_MAIN_BASE_MAX_HP} или FOB {@link FLAG_BASE_MAX_HP}
 */
function computeClientFlagDisplayEffHp(raw, nowMs, maxHpFallback) {
  let maxH =
    typeof maxHpFallback === "number" && Number.isFinite(maxHpFallback) && maxHpFallback > 0
      ? maxHpFallback | 0
      : FLAG_BASE_MAX_HP;
  if (raw && typeof raw.maxHp === "number" && Number.isFinite(raw.maxHp) && raw.maxHp > 0) {
    maxH = raw.maxHp | 0;
  }
  if (!raw || typeof raw.hp !== "number") return maxH;
  const h0 = Math.min(maxH, Math.max(0, raw.hp | 0));
  if (h0 >= maxH) return maxH;
  const tHit = toEpochMsSafe(raw.lastHitAt);
  let eff = computeEffectiveBaseHp({ hp: h0, lastHitAt: tHit }, nowMs, maxH);
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

function getClientMyMainBaseHpRatio01(nowMs = Date.now()) {
  if (myTeamId == null) return 1;
  const raw = flagCaptureClientState.get(clientMainFlagKey(myTeamId));
  const cap =
    raw && typeof raw.maxHp === "number" && Number.isFinite(raw.maxHp) && raw.maxHp > 0
      ? raw.maxHp | 0
      : FLAG_MAIN_BASE_MAX_HP;
  return computeClientFlagDisplayEffHp(raw, nowMs, FLAG_MAIN_BASE_MAX_HP) / Math.max(1, cap);
}

function syncFlagCaptureStateFromMeta(flags) {
  /* Не очищаем карту до проверки: иначе при meta без flags вся карта «сбрасывается» в полный HP для всех баз. */
  if (!Array.isArray(flags)) return;
  const next = new Map();
  for (const f of flags) {
    const tid = Number(f.teamId) | 0;
    if (tid <= 0) continue;
    const slotKeyEarly =
      typeof f.clientKey === "string" && f.clientKey.trim() !== "" ? f.clientKey.trim() : clientMainFlagKey(tid);
    const isMilitaryFlag = slotKeyEarly.startsWith("m:");
    let maxHp = isMilitaryFlag ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP;
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
    const slotKey = slotKeyEarly;
    const prev = flagCaptureClientState.get(slotKey);
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
    next.set(slotKey, entry);
  }
  flagCaptureClientState = next;
}

function showFlagAlertBanner(text, durationMs = ALERT_AUTO_HIDE_MS) {
  const el = document.getElementById("flag-alert-banner");
  if (!el) return;
  const hideAfter = Math.min(
    typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs > 0 ? durationMs : ALERT_AUTO_HIDE_MS,
    BANNER_MAX_VISIBLE_MS
  );
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
  }, hideAfter);
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
    nuke_no_effect:
      "Бомба не дала эффекта: в кратере нет закраски для сброса и не задета чужая главная база 6×6.",
    military_cooldown: "Перед следующим развёртыванием подождите (~2 мин).",
    military_occupied: "Нужен полностью свободный блок суши 2×2 без чужих пикселей.",
    military_water: "Нельзя разместить на воде.",
    military_bounds: "Слишком близко к краю карты (нужен полный квадрат 2×2).",
    military_conflict: "Пересечение с базой, передовой базой или запретной зоной.",
    military_too_close_own_main: "Слишком близко к вашей главной базе.",
    military_too_close_enemy_main: "Слишком близко к чужой главной базе.",
    military_invalid: "Нельзя разместить здесь.",
    paused: "Игра на паузе (администратор). Покупки временно недоступны.",
    wall_not_yours: "Стену можно ставить только на свою закрашенную клетку.",
    wall_already: "Здесь уже стоит стена.",
    wall_flag_cell: "Нельзя укреплять клетку флага базы.",
    no_wall_charges: "Нет кирпичей стены в запасе — купите в магазине (раздел «Зоны»).",
    no_team: "Сначала выберите команду.",
    water: "Нельзя укреплять воду.",
    out_of_bounds: "Сюда нельзя (вне карты).",
    quantum_farm_not_controlled: "Ферма не под контролем вашей команды или нет связи.",
    quantum_farm_no_supply: "Нет связи территории фермы с базой — улучшение недоступно.",
    quantum_farm_max_level: "Ферма уже максимального уровня.",
    base_repair_invalid_target: "You can only repair your own base",
    base_repair_full: "Base already at full HP",
    base_repair_needs_quants: "Not enough quants",
  };
  const text = m[reason] || String(reason);
  const severe =
    reason === "team_eliminated" || reason === "bad request" || reason === "not available";
  showPlacementFeedback(text, severe ? "error" : "warn", { telegramAlert: false });
  if (reason === "not_adjacent") remindInvalidPlacementBase(false);
  playUiError();
}

const ROUND_END_BANNER_MS = 10 * 60 * 1000;
/** «До конца раунда»: короткие всплытия при смене оценки минут, не висит всю декаду минут. */
let roundEndHintLastMinuteBucket = /** @type {number | null} */ (null);
let roundEndHintVisibleUntilMs = 0;
/** После смаха «до конца раунда» не показываем ту же минуту снова, пока не истечёт окно. */
let eventBannerDismissedUntilMs = 0;
let eventBannerDismissedMinuteBucket = /** @type {number | null} */ (null);
/** Командный бафф: ключ `${until}|${sec}` и время, до которого не показываем после смаха. */
let teamBuffSwipeSuppressUntilMs = 0;
let teamBuffSwipeSuppressKey = "";

function resetRoundEndHintToastState() {
  roundEndHintLastMinuteBucket = null;
  roundEndHintVisibleUntilMs = 0;
  eventBannerDismissedUntilMs = 0;
  eventBannerDismissedMinuteBucket = null;
}

function eventBannerRoundHintDismissalBlocks(minutes) {
  return (
    eventBannerDismissedMinuteBucket != null &&
    minutes === eventBannerDismissedMinuteBucket &&
    effectiveClientUiNowMs() < eventBannerDismissedUntilMs
  );
}

function hideEventBannerRoundHintSwipe() {
  if (!eventBannerEl) return;
  const left = roundEndsAtMs != null ? roundEndsAtMs - effectiveClientUiNowMs() : 0;
  const m = Math.max(1, Math.ceil(left / 60000));
  eventBannerDismissedMinuteBucket = m;
  eventBannerDismissedUntilMs = effectiveClientUiNowMs() + 75000;
  detachSwipeDismissSlot("eventBanner");
  resetDismissibleBannerNode(eventBannerEl);
  try {
    delete eventBannerEl.dataset.roundHintTxt;
  } catch {
    /* ignore */
  }
  eventBannerEl.hidden = true;
}

function clearEventBannerRoundHintVisual() {
  if (!eventBannerEl) return;
  detachSwipeDismissSlot("eventBanner");
  resetDismissibleBannerNode(eventBannerEl);
  try {
    delete eventBannerEl.dataset.roundHintTxt;
  } catch {
    /* ignore */
  }
  eventBannerEl.hidden = true;
}

function clearTeamBuffBannerVisual() {
  if (!teamBuffBannerEl) return;
  teamBuffSwipeSuppressUntilMs = 0;
  teamBuffSwipeSuppressKey = "";
  detachSwipeDismissSlot("teamBuff");
  resetDismissibleBannerNode(teamBuffBannerEl);
  try {
    delete teamBuffBannerEl.dataset.buffBannerKey;
    delete teamBuffBannerEl.dataset.buffUntil;
  } catch {
    /* ignore */
  }
  teamBuffBannerEl.hidden = true;
}

function hideTeamBuffBannerSwipe() {
  if (!teamBuffBannerEl) return;
  teamBuffSwipeSuppressKey = teamBuffBannerEl.dataset.buffBannerKey || "";
  const u = Number(teamBuffBannerEl.dataset.buffUntil);
  teamBuffSwipeSuppressUntilMs =
    Number.isFinite(u) && u > effectiveClientUiNowMs() ? u : effectiveClientUiNowMs() + 90000;
  detachSwipeDismissSlot("teamBuff");
  resetDismissibleBannerNode(teamBuffBannerEl);
  try {
    delete teamBuffBannerEl.dataset.buffBannerKey;
    delete teamBuffBannerEl.dataset.buffUntil;
  } catch {
    /* ignore */
  }
  teamBuffBannerEl.hidden = true;
}

/**
 * @param {number} leftMs
 * @returns {{ show: boolean, minutes: number }}
 */
function computeRoundEndHintToast(leftMs) {
  if (leftMs <= 0 || leftMs > ROUND_END_BANNER_MS) {
    resetRoundEndHintToastState();
    return { show: false, minutes: 0 };
  }
  const minutes = Math.max(1, Math.ceil(leftMs / 60000));
  const now = effectiveClientUiNowMs();
  if (roundEndHintLastMinuteBucket !== minutes) {
    roundEndHintLastMinuteBucket = minutes;
    roundEndHintVisibleUntilMs = now + BANNER_MAX_VISIBLE_MS;
  }
  if (now >= roundEndHintVisibleUntilMs) {
    return { show: false, minutes };
  }
  return { show: true, minutes };
}

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
    return `До лидера по очкам +${formatHudScore(gap)}`;
  }
  if (gap < 0) return "Вы впереди по очкам";
  return "";
}

function getClientGlobalEventSnapshot() {
  const w = walletState?.globalEvent;
  const s = lastStatsGlobalEvent;
  if (!w && !s) return null;
  return { ...(typeof s === "object" && s ? s : {}), ...(typeof w === "object" && w ? w : {}) };
}

function syncEventBanner() {
  if (!eventBannerEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || gameFinishedMeta) {
    clearEventBannerRoundHintVisual();
    resetRoundEndHintToastState();
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
    if (seismicPreviewClient && effectiveClientUiNowMs() > (seismicPreviewClient.impactAtMs || 0) + 3000) {
      seismicPreviewClient = null;
    }
    const leftR = roundEndsAtMs != null ? roundEndsAtMs - effectiveClientUiNowMs() : 0;
    const hintR = computeRoundEndHintToast(leftR);
    if (hintR.show && !eventBannerRoundHintDismissalBlocks(hintR.minutes)) {
      const txt = `\u23f1 До конца раунда · ещё ~${hintR.minutes} мин`;
      const needAttach = eventBannerEl.hidden || eventBannerEl.dataset.roundHintTxt !== txt;
      eventBannerEl.hidden = false;
      eventBannerEl.className = "event-banner event-banner--mini-round event-banner--swipe-dismiss";
      eventBannerEl.textContent = txt;
      eventBannerEl.dataset.roundHintTxt = txt;
      if (needAttach) {
        detachSwipeDismissSlot("eventBanner");
        resetDismissibleBannerNode(eventBannerEl);
        attachSwipeDismissSlot("eventBanner", eventBannerEl, hideEventBannerRoundHintSwipe);
      }
      return;
    }
    clearEventBannerRoundHintVisual();
    return;
  }

  if (ge && ge.active && ge.title && typeof ge.until === "number" && ge.until > effectiveClientUiNowMs()) {
    /* Активное событие боя: заголовок и таймер только в #event-hud-dock, без закреплённой верхней «золотой» плашки. */
    clearEventBannerRoundHintVisual();
    eventBannerEl.textContent = "";
    return;
  }
  if (seismicPreviewClient && effectiveClientUiNowMs() > (seismicPreviewClient.impactAtMs || 0) + 3000) {
    seismicPreviewClient = null;
  }
  if (roundEndsAtMs == null) {
    resetRoundEndHintToastState();
    clearEventBannerRoundHintVisual();
    return;
  }
  const left = roundEndsAtMs - effectiveClientUiNowMs();
  const hint = computeRoundEndHintToast(left);
  if (!hint.show || eventBannerRoundHintDismissalBlocks(hint.minutes)) {
    clearEventBannerRoundHintVisual();
    return;
  }
  const txt = `\u23f1 До конца раунда · ещё ~${hint.minutes} мин`;
  const needAttach = eventBannerEl.hidden || eventBannerEl.dataset.roundHintTxt !== txt;
  eventBannerEl.hidden = false;
  eventBannerEl.className = "event-banner event-banner--swipe-dismiss";
  eventBannerEl.textContent = txt;
  eventBannerEl.dataset.roundHintTxt = txt;
  if (needAttach) {
    detachSwipeDismissSlot("eventBanner");
    resetDismissibleBannerNode(eventBannerEl);
    attachSwipeDismissSlot("eventBanner", eventBannerEl, hideEventBannerRoundHintSwipe);
  }
}

/** Согласовано с server: globalSpeedMstimActive → until (wall) > Date.now(). */
function isAltSeasonRevengeWallActive(arUntilRaw) {
  const u = Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Number(arUntilRaw)));
  if (!Number.isFinite(u) || u < 1) return false;
  return u > effectiveClientUiNowMs();
}

function syncClientCooldownFromWalletFields() {
  if (!walletState) return;
  const ge = walletState.globalEvent;
  const geUntil = Number(ge?.altSeasonRevengeUntilMs) || 0;
  const clientLive = getMstimAltSeasonClientBurstUntilMs();
  const combinedUntil = Math.max(geUntil, clientLive);
  const globalAltSeasonActive = isAltSeasonRevengeWallActive(combinedUntil);
  const u = {
    personalRecoveryUntil: walletState.personalRecoveryUntil,
    personalRecoverySec: walletState.personalRecoverySec,
  };
  const te = walletState.teamEffects;
  const teamFx = te
    ? { teamRecoveryUntil: te.teamRecoveryUntil, teamRecoverySec: te.teamRecoverySec }
    : { teamRecoveryUntil: 0, teamRecoverySec: BASE_ACTION_COOLDOWN_SEC };
  const st = walletState.tournamentStage || "MASS_BATTLE";
  /* Личные/командные until — wall-epoch; одна шкала времени с тулбаром и handleMapClick (effectiveClientUiNowMs). */
  const recoveryNowMs = effectiveClientUiNowMs();
  walletState.effectiveRecoverySec = resolveAuthoritativeRecoverySec(globalAltSeasonActive, u, teamFx, recoveryNowMs);
  walletState.cooldownMs = getAuthoritativePixelCooldownMs({
    globalSpeedActive: globalAltSeasonActive,
    user: u,
    teamFx,
    stage: st,
    nowMs: recoveryNowMs,
  });
}

/** Интервал между пикселями (мс) — как на сервере; не использовать `cooldownMs || fallback` (ломает 0 и баффы). */
function getWalletActionCooldownMs() {
  if (!walletState) return BASE_ACTION_COOLDOWN_SEC * 1000;
  /* Без пересчёта по текущему времени после окончания personalRecoveryUntil остаётся устаревший effectiveRecoverySec (напр. 1 с). */
  syncClientCooldownFromWalletFields();
  const sec = walletState.effectiveRecoverySec;
  if (typeof sec === "number" && Number.isFinite(sec) && sec >= 0) {
    return Math.max(0, Math.trunc(sec) * 1000);
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

/** Сумма уровней ферм под контролем команды (+N квант / 5 с на команду при связи). */
function computeClientQuantumFarmIncomePer5s() {
  const tid = myTeamId | 0;
  if (!tid || !quantumFarmsMeta.length || gridW < 1 || gridH < 1 || !isClientQuantumFarmIncomeAccrualPhase()) return 0;
  let sum = 0;
  for (let i = 0; i < quantumFarmsMeta.length; i++) {
    const f = quantumFarmsMeta[i];
    const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, (key) => {
      const parts = key.split(",");
      const x = Number(parts[0]);
      const y = Number(parts[1]);
      const v = clientPixelTeamIdAt(x, y);
      return v == null ? 0 : v | 0;
    });
    const st = resolveFarmControl(scores);
    if ((st.owner | 0) === tid && !st.contested && clientQuantumFarmSupplyConnected(tid, f)) {
      sum += normalizeQuantumFarmLevel(f.level);
    }
  }
  return sum;
}

function mergeQuantumFarmsFromServerPayload(rows) {
  if (!Array.isArray(rows)) return;
  quantumFarmsMeta = rows
    .filter((f) => f && typeof f.x0 === "number" && typeof f.y0 === "number")
    .map((f) => ({
      id: Number(f.id) | 0,
      x0: f.x0 | 0,
      y0: f.y0 | 0,
      w: typeof f.w === "number" ? f.w | 0 : 2,
      h: typeof f.h === "number" ? f.h | 0 : 2,
      level: normalizeQuantumFarmLevel(f.level),
    }));
  syncToolbarQuantumObjective();
  refreshPassiveIncomeDisplays();
  if (quantumFarmPanelAnchorFarmId != null) {
    const ok = quantumFarmsMeta.some((x) => (x.id | 0) === (quantumFarmPanelAnchorFarmId | 0));
    if (!ok) closeQuantumFarmPanel();
  }
}

function findQuantumFarmCoveringCell(gx, gy) {
  if (!quantumFarmsMeta.length) return null;
  const x = gx | 0;
  const y = gy | 0;
  for (let i = 0; i < quantumFarmsMeta.length; i++) {
    const f = quantumFarmsMeta[i];
    if (x >= f.x0 && x < f.x0 + f.w && y >= f.y0 && y < f.y0 + f.h) return f;
  }
  return null;
}

/** Режимы «тап по карте»: не перехватывать квантофермой (иначе кирпич/зона/бомба «молча» не срабатывают). */
function pendingMapActionTargetsMapCell(pm) {
  const t = pm?.type;
  return (
    t === "greatWall" ||
    t === "zoneCapture" ||
    t === "massCapture" ||
    t === "zone12Capture" ||
    t === "nukeBomb" ||
    t === "militaryBase"
  );
}

/**
 * Связь фермы с «снабжением» команды: хотя бы одна наша клетка в зоне влияния входит в компонент территории, связанный с базой.
 * (Согласовано с визуализацией зональных покупок через computeClientBaseConnectedPixelKeys.)
 */
function clientQuantumFarmSupplyConnected(teamId, farm) {
  const tid = teamId | 0;
  if (!tid || !farm || gridW < 1 || gridH < 1) return false;
  const keys = getQuantumFarmInfluenceKeys(farm.x0 | 0, farm.y0 | 0, gridW, gridH);
  const baseConn = computeClientBaseConnectedPixelKeys(tid);
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const parts = k.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if ((clientPixelTeamIdAt(x, y) | 0) !== tid) continue;
    if (baseConn.has(k)) return true;
  }
  return false;
}

function closeQuantumFarmPanel() {
  if (!quantumFarmPanelEl) return;
  quantumFarmPanelAnchorFarmId = null;
  quantumFarmPanelDockEl?.classList.remove("qf-command__dock--in");
  const card = quantumFarmPanelEl.querySelector(".quantum-farm-panel__card");
  card?.classList.remove(
    "quantum-farm-panel__card--tier-1",
    "quantum-farm-panel__card--tier-2",
    "quantum-farm-panel__card--tier-3",
    "quantum-farm-panel__card--tier-4"
  );
  quantumFarmPanelUpgradeEl?.classList.remove("qf-command__cta--warn");
  quantumFarmPanelEl.hidden = true;
  quantumFarmPanelEl.setAttribute("aria-hidden", "true");
}

function openQuantumFarmPanel(f) {
  if (!quantumFarmPanelEl || !f) return;
  const onlineQ = wantOnline && getWsUrl();
  if ((onlineQ && myTeamId == null) || (welcomeOverlay && welcomeOverlay.hidden === false)) {
    return;
  }
  const lvl = normalizeQuantumFarmLevel(f.level);
  const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, (key) => {
    const parts = key.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    const v = clientPixelTeamIdAt(x, y);
    return v == null ? 0 : v | 0;
  });
  const st = resolveFarmControl(scores);
  const owner = st.owner | 0;
  const contested = !!st.contested;
  const myT = myTeamId != null ? myTeamId | 0 : 0;
  const ours = myT && owner === myT;

  const tierNow = quantumFarmTierMeta(lvl);
  const supplyLinked =
    owner && !contested && myT && owner === myT ? clientQuantumFarmSupplyConnected(myT, f) : true;
  if (quantumFarmPanelTitleEl) {
    quantumFarmPanelTitleEl.textContent = "Квантовая ферма";
  }
  if (quantumFarmPanelLevelEl) {
    quantumFarmPanelLevelEl.textContent = `Уровень ${lvl} · ${tierNow.name} · #${f.id | 0}`;
  }
  if (quantumFarmPanelBlurbEl) {
    quantumFarmPanelBlurbEl.textContent = tierNow.blurb;
  }
  const card = quantumFarmPanelEl.querySelector(".quantum-farm-panel__card");
  if (card) {
    card.classList.remove(
      "quantum-farm-panel__card--tier-1",
      "quantum-farm-panel__card--tier-2",
      "quantum-farm-panel__card--tier-3",
      "quantum-farm-panel__card--tier-4"
    );
    card.classList.add(`quantum-farm-panel__card--tier-${lvl}`);
  }
  if (quantumFarmPanelIncomeEl) {
    if (!owner) {
      quantumFarmPanelIncomeEl.textContent = "Спор — доход: 0 / 5 с";
    } else if (contested) {
      quantumFarmPanelIncomeEl.textContent = "Спор — доход: 0 / 5 с";
    } else if (owner === myT) {
      quantumFarmPanelIncomeEl.textContent = supplyLinked
        ? `Доход: +${lvl} / 5 с (каждому члену команды)`
        : "Доход: 0 / 5 с (нет связи с базой)";
    } else {
      quantumFarmPanelIncomeEl.textContent = `Чужой контроль · их доход: +${lvl} / 5 с на игрока`;
    }
  }

  let hint = "";
  let showUpgrade = false;
  if (spectatorMode) {
    hint = "Режим наблюдателя.";
  } else if (!myT) {
    hint = "Вступите в команду для улучшений.";
  } else if (!ours) {
    hint = "Улучшать может только команда, контролирующая ферму.";
  } else if (contested) {
    hint = "Нет стабильного контроля — нельзя улучшить.";
  } else if (!supplyLinked) {
    hint = "Нет связи с территорией — доход и улучшения недоступны.";
  } else if (lvl >= QUANTUM_FARM_MAX_LEVEL) {
    hint = "Максимальный уровень — вершина удерживается или перехватывается.";
  } else {
    const cost = quantumFarmUpgradePriceQuant(lvl);
    const next = lvl + 1;
    const nextTier = quantumFarmTierMeta(next);
    hint = `Улучшить до «${nextTier.name}» (ур. ${next}): ${cost} квантов.`;
    showUpgrade = true;
  }

  if (quantumFarmPanelHintEl) {
    const needMoney =
      showUpgrade &&
      walletState &&
      !walletState.devUnlimited &&
      typeof walletState.balanceUSDT === "number";
    const qNeed = showUpgrade ? quantumFarmUpgradePriceQuant(lvl) : 0;
    const qHave = needMoney ? usdtToQuant(walletState.balanceUSDT) : 999999;
    if (showUpgrade && needMoney && qHave < qNeed) {
      quantumFarmPanelHintEl.textContent = `Недостаточно квантов (нужно ${qNeed}).`;
      quantumFarmPanelHintEl.hidden = false;
    } else {
      quantumFarmPanelHintEl.textContent = hint;
      quantumFarmPanelHintEl.hidden = !hint;
    }
  }

  if (quantumFarmPanelUpgradeEl) {
    const cost = quantumFarmUpgradePriceQuant(lvl);
    const affordable =
      !walletState ||
      walletState.devUnlimited ||
      typeof walletState.balanceUSDT !== "number" ||
      usdtToQuant(walletState.balanceUSDT) >= cost;
    quantumFarmPanelUpgradeEl.classList.toggle("qf-command__cta--warn", showUpgrade && !affordable);
    quantumFarmPanelUpgradeEl.dataset.farmId = String(f.id | 0);
    if (lvl >= QUANTUM_FARM_MAX_LEVEL) {
      quantumFarmPanelUpgradeEl.hidden = false;
      quantumFarmPanelUpgradeEl.disabled = true;
      quantumFarmPanelUpgradeEl.textContent = "Макс. уровень";
      quantumFarmPanelUpgradeEl.classList.remove("qf-command__cta--warn");
    } else if (showUpgrade) {
      quantumFarmPanelUpgradeEl.hidden = false;
      quantumFarmPanelUpgradeEl.disabled = !affordable;
      const next = lvl + 1;
      const nextTier = quantumFarmTierMeta(next);
      quantumFarmPanelUpgradeEl.textContent = affordable
        ? `Улучшить до ур. ${next} — ${cost} кв.`
        : `Нужно ${cost} кв. · до «${nextTier.name}»`;
    } else {
      quantumFarmPanelUpgradeEl.hidden = true;
      quantumFarmPanelUpgradeEl.disabled = true;
      quantumFarmPanelUpgradeEl.textContent = "Улучшить";
    }
  }

  quantumFarmPanelAnchorFarmId = f.id | 0;
  quantumFarmPanelEl.hidden = false;
  quantumFarmPanelEl.removeAttribute("aria-hidden");
  requestAnimationFrame(() => {
    layoutQuantumFarmContextualPanel(f);
    if (quantumFarmPanelDockEl) {
      quantumFarmPanelDockEl.classList.remove("qf-command__dock--in");
      void quantumFarmPanelDockEl.offsetWidth;
      quantumFarmPanelDockEl.classList.add("qf-command__dock--in");
    }
  });
  try {
    window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("light");
  } catch {
    /* ignore */
  }
}

function initQuantumFarmPanel() {
  if (!quantumFarmPanelEl || quantumFarmPanelEl.dataset.qfUiBound === "1") return;
  quantumFarmPanelEl.dataset.qfUiBound = "1";

  let lastQuantumFarmUpgradeSentMs = 0;

  const trySendQuantumFarmUpgrade = () => {
    const btn = quantumFarmPanelUpgradeEl;
    if (!btn || quantumFarmPanelEl.hidden || btn.hidden || btn.disabled) return;
    const id = Number(btn.dataset?.farmId);
    if (!Number.isFinite(id) || id < 1) return;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      showPlacementFeedback("Нет соединения с сервером.", "error", { telegramAlert: false });
      return;
    }
    const t = Date.now();
    if (t - lastQuantumFarmUpgradeSentMs < 420) return;
    lastQuantumFarmUpgradeSentMs = t;
    wsSendJson({ type: "purchaseQuantumFarmUpgrade", farmId: id });
  };

  /**
   * Прямая привязка к подложке и кнопкам (не делегирование с capture): в TG WebView надёжнее для тапа.
   * touchend + click: гашение дублей; preventDefault на touchend снимает лишний скролл/задержку.
   * @param {HTMLElement | null} el
   * @param {() => void} fn
   */
  const bindQuantumFarmTap = (el, fn) => {
    if (!el) return;
    let lastMs = 0;
    const run = () => {
      if (quantumFarmPanelEl.hidden) return;
      const n = Date.now();
      if (n - lastMs < 450) return;
      lastMs = n;
      fn();
    };
    el.addEventListener(
      "touchend",
      (e) => {
        e.stopPropagation();
        try {
          e.preventDefault();
        } catch {
          /* ignore */
        }
        run();
      },
      { passive: false }
    );
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      run();
    });
  };

  bindQuantumFarmTap(quantumFarmPanelBackdropEl, () => closeQuantumFarmPanel());
  bindQuantumFarmTap(quantumFarmPanelCloseEl, () => closeQuantumFarmPanel());
  bindQuantumFarmTap(quantumFarmPanelUpgradeEl, () => trySendQuantumFarmUpgrade());

  closeQuantumFarmPanel();
}

const BATTLE_EVENT_ZONE_QUANT_PER_STACK = 5;

function clientTeamTerritoryOverlapsRect(teamId, rect) {
  const tid = teamId | 0;
  if (!tid || !rect) return false;
  for (const [key] of pixels) {
    const parts = key.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if ((clientPixelTeamIdAt(x, y) | 0) !== tid) continue;
    if (pointInRect(x, y, rect)) return true;
  }
  return false;
}

function clientTeamTerritoryOverlapsBestCompression(teamId, comp) {
  const tid = teamId | 0;
  if (!tid || !comp || gridW < 1 || gridH < 1) return false;
  const candidates = [comp.centerMult, comp.nonCenterMult];
  if (comp.outerRingMult != null && Number.isFinite(comp.outerRingMult)) candidates.push(comp.outerRingMult);
  const best = Math.max(...candidates);
  for (const [key] of pixels) {
    const parts = key.split(",");
    const x = Number(parts[0]);
    const y = Number(parts[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    if ((clientPixelTeamIdAt(x, y) | 0) !== tid) continue;
    const m = tournamentCompressionMultiplierForCell(x, y, gridW, gridH, comp);
    if (m >= best - 1e-8) return true;
  }
  return false;
}

/**
 * Оценка +квантов / 5 с за пересечение территории с зонами турнира (золото, бум-регион, лучший слой сжатия карты).
 * Должна совпадать с сервером при актуальном globalEvent и карте.
 */
function computeClientBattleEventZoneQuantsPer5s() {
  const tid = myTeamId | 0;
  if (!tid || gridW < 1 || gridH < 1 || !isClientQuantumFarmIncomeAccrualPhase()) return 0;
  const ge = getClientGlobalEventSnapshot();
  const be = ge?.battleEvents;
  const layers = be?.layers;
  if (!Array.isArray(layers) || !layers.length) return 0;
  const now = Date.now();
  const battleEndsAt = typeof be.battleEndsAt === "number" ? be.battleEndsAt : 0;
  let stack = 0;

  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    if (!L || typeof L.untilMs !== "number" || L.untilMs <= now) continue;
    const k = L.kind;
    if (k === "gold_zone" || k === "target_zone" || k === "duel_zone") {
      if (L.rect && clientTeamTerritoryOverlapsRect(tid, L.rect)) stack++;
      continue;
    }
    if (k === "economic_shift" || k === "economic_rotation" || k === "resource_surge") {
      const rects =
        Array.isArray(L.rects) && L.rects.length ? L.rects : L.rect ? [L.rect] : [];
      let bonus = false;
      for (let ri = 0; ri < rects.length; ri++) {
        const rr = rects[ri];
        if (rr && typeof rr.mult === "number" && rr.mult > 1 && clientTeamTerritoryOverlapsRect(tid, rr)) {
          bonus = true;
          break;
        }
      }
      if (bonus) stack++;
      continue;
    }
    if (k === "map_compression" && L.compression) {
      const mcUntil = Math.min(L.untilMs, battleEndsAt > now ? battleEndsAt : L.untilMs);
      if (now >= mcUntil) continue;
      if (clientTeamTerritoryOverlapsBestCompression(tid, L.compression)) stack++;
    }
  }

  return stack * BATTLE_EVENT_ZONE_QUANT_PER_STACK;
}

/**
 * Пассив для подписи в UI: в онлайне — суммы с сервера (wallet); каждому члену команды начисляется столько же / 5 с.
 */
function getDisplayedPassiveQuantumBreakdown() {
  if (myTeamId == null || spectatorMode) return { farm: 0, zone: 0, total: 0 };
  if (wantOnline && getWsUrl() && walletState) {
    const farm = walletState.quantFarmIncomeQuantsPer5s;
    const zone = walletState.battleEventZoneQuantsPer5s;
    if (typeof farm === "number" && typeof zone === "number" && Number.isFinite(farm) && Number.isFinite(zone)) {
      const ff = Math.max(0, farm | 0);
      const zz = Math.max(0, zone | 0);
      return { farm: ff, zone: zz, total: ff + zz };
    }
  }
  const farm = computeClientQuantumFarmIncomePer5s();
  const zone = computeClientBattleEventZoneQuantsPer5s();
  return { farm, zone, total: farm + zone };
}

function computePassiveQuantumIncomeQuantsPer5s() {
  return getDisplayedPassiveQuantumBreakdown().total;
}

function passiveQuantumIncomeSubtitle(farm, zone, total) {
  if (total < 1) return { text: "", hidden: true };
  if (farm > 0 && zone > 0) {
    return { text: `+${total} / 5 с (фермы + зоны турнира)`, hidden: false };
  }
  if (zone > 0) {
    return { text: `+${total} / 5 с за зоны турнира на карте`, hidden: false };
  }
  return { text: `+${total} / 5 с с квантовых ферм (команда, каждому)`, hidden: false };
}

/** Обновление подписи пассива при движении по карте / смене событий (без полного updateWalletBar). */
function refreshPassiveIncomeDisplays() {
  const online = wantOnline && getWsUrl();
  if (!online || !walletState || spectatorMode || myTeamId == null) return;
  syncShopHeaderBalance();
  refreshUsdtDepositUi();
  if (!walletBalanceEl || walletState.devUnlimited) return;
  const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
  const t = usdtToQuant(b);
  const { farm: farmOnly, zone: zoneOnly, total: passiveTotal } = getDisplayedPassiveQuantumBreakdown();
  const farmSuffix = passiveTotal > 0 ? ` (+${passiveTotal} / 5 с)` : "";
  walletBalanceEl.textContent = `💰 ${t} ${quantWord(t)}${farmSuffix}`;
  walletBalanceEl.title =
    passiveTotal > 0
      ? `Баланс в квантах. Каждому в команде: до +${passiveTotal} кв. / 5 с (фермы: ${farmOnly}, зоны турнира: ${zoneOnly}). Таймер пикселя — слева.`
      : "Баланс в квантах. Пауза до следующего обычного пикселя — слева.";
}

/**
 * Пассивный доход: вспышки на фермах, премиальные +N у удерживаемых ферм (с зумом/фокусом),
 * отдельно подсказка у кошелька для зон турнира или если сервер не прислал разбивку по фермам.
 * @param {{ farmQuants?: number, eventZoneQuants?: number }} [opts]
 */
function playQuantumFarmIncomeClientFx(quants, opts = {}) {
  const q = quants | 0;
  if (q < 1 || spectatorMode || !isClientQuantumFarmIncomeAccrualPhase()) return;
  const tid = myTeamId | 0;
  if (!tid) return;
  const tr = getVfxTransform();
  const gold = "#f0c040";
  const farmQ = typeof opts.farmQuants === "number" && Number.isFinite(opts.farmQuants) ? opts.farmQuants | 0 : -1;
  const zoneQ =
    typeof opts.eventZoneQuants === "number" && Number.isFinite(opts.eventZoneQuants) ? opts.eventZoneQuants | 0 : 0;
  const doPerFarmFloats = farmQ > 0;
  if (quantumFarmsMeta.length) {
    let farmFloatIdx = 0;
    for (let i = 0; i < quantumFarmsMeta.length; i++) {
      const f = quantumFarmsMeta[i];
      const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, (key) => {
        const p = key.split(",");
        const v = clientPixelTeamIdAt(Number(p[0]), Number(p[1]));
        return v == null ? 0 : v | 0;
      });
      const ctrl = resolveFarmControl(scores);
      if ((ctrl.owner | 0) !== tid || ctrl.contested || !clientQuantumFarmSupplyConnected(tid, f)) continue;
      const gcx = f.x0 + f.w * 0.5;
      const gcy = f.y0 + f.h * 0.5;
      const gxi = gcx | 0;
      const gyi = gcy | 0;
      if (boardVfx) {
        boardVfx.ripple(gxi, gyi, gold, tr);
        boardVfx.burst(gxi, gyi, "#ffd85c", tr, 14);
      }
      if (doPerFarmFloats && floatFxHost && clientWantsQuantumFarmIncomeFloatNearGrid(gcx, gcy)) {
        const pos = gridCellCenterToClientPx(gcx, gcy);
        if (pos) {
          const inc = normalizeQuantumFarmLevel(f.level);
          const delay = farmFloatIdx * 44;
          farmFloatIdx++;
          window.setTimeout(() => {
            spawnQuantumFarmIncomeFloat(floatFxHost, pos, inc);
          }, delay);
        }
      }
    }
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
  }
  if (toolbarQuantumObjectiveEl && !toolbarQuantumObjectiveEl.hidden) {
    toolbarQuantumObjectiveEl.classList.remove("toolbar__wallet--pulse");
    void toolbarQuantumObjectiveEl.offsetWidth;
    toolbarQuantumObjectiveEl.classList.add("toolbar__wallet--pulse");
    setTimeout(() => toolbarQuantumObjectiveEl.classList.remove("toolbar__wallet--pulse"), 600);
  }
  if (floatFxHost && walletBalanceEl) {
    const r = walletBalanceEl.getBoundingClientRect();
    const wx = r.left + r.width * 0.5;
    const wy = r.top + r.height * 0.14;
    if (zoneQ > 0) {
      spawnFloatingText(floatFxHost, `+${zoneQ} зона`, { x: wx, y: wy }, "float-fx__pop--gold");
    } else if (!doPerFarmFloats && q > 0) {
      spawnFloatingText(floatFxHost, `+${q} ${quantWord(q)} 💵`, { x: wx, y: wy }, "float-fx__pop--gold");
    }
  }
  try {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
  } catch {
    /* ignore */
  }
}

/** Бейдж цели «квантофермы» в шапке: центр и периферия карты. */
function syncToolbarQuantumObjective() {
  if (!toolbarQuantumObjectiveEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || !quantumFarmsMeta.length) {
    toolbarQuantumObjectiveEl.hidden = true;
    toolbarQuantumObjectiveEl.classList.remove(
      "toolbar__quantum-objective--held",
      "toolbar__quantum-objective--contested"
    );
    return;
  }
  toolbarQuantumObjectiveEl.hidden = false;
  const total = quantumFarmsMeta.length;
  if (spectatorMode || myTeamId == null) {
    toolbarQuantumObjectiveEl.textContent = `⚛ Квантофермы · ${total}`;
    toolbarQuantumObjectiveEl.title = `${total} ферм: ур. 1–4 (базовая → вершина). Доход суммируется (до +4 кв. / 5 с с одной точки макс. уровня).`;
    toolbarQuantumObjectiveEl.classList.remove(
      "toolbar__quantum-objective--held",
      "toolbar__quantum-objective--contested"
    );
    return;
  }
  const tid = myTeamId | 0;
  const accrual = isClientQuantumFarmIncomeAccrualPhase();
  let held = 0;
  let incomeSum = 0;
  let contestedNearUs = 0;
  for (let i = 0; i < quantumFarmsMeta.length; i++) {
    const f = quantumFarmsMeta[i];
    const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, (key) => {
      const p = key.split(",");
      const v = clientPixelTeamIdAt(Number(p[0]), Number(p[1]));
      return v == null ? 0 : v | 0;
    });
    const st = resolveFarmControl(scores);
    if (
      accrual &&
      (st.owner | 0) === tid &&
      !st.contested &&
      clientQuantumFarmSupplyConnected(tid, f)
    ) {
      held++;
      incomeSum += normalizeQuantumFarmLevel(f.level);
    }
    if (st.contested && (scores.get(tid) | 0) > 0) contestedNearUs++;
  }
  toolbarQuantumObjectiveEl.textContent =
    held > 0 ? `⚛ Удерживаем ${held}/${total}` : `⚛ Штурм ферм 0/${total}`;
  toolbarQuantumObjectiveEl.title = `Фермы: ур. 1…4 при контроле и связи с базой. С ферм каждому в команде: +${incomeSum} кв. / 5 с (сумма удерживаемых точек, ${held}/${total}). Тап по ферме — улучшение.`;
  toolbarQuantumObjectiveEl.classList.toggle("toolbar__quantum-objective--held", held > 0);
  toolbarQuantumObjectiveEl.classList.toggle(
    "toolbar__quantum-objective--contested",
    contestedNearUs > 0 && held < total
  );
}

function applyWalletFromServer(msg) {
  if (typeof msg?.serverWallMs === "number" && Number.isFinite(msg.serverWallMs) && msg.serverWallMs > 946684800000) {
    walletServerSkewMs = msg.serverWallMs - Date.now();
  }
  const altW = Number(msg?.globalEvent?.altSeasonRevengeUntilMs) || 0;
  if (altW > effectiveClientUiNowMs()) {
    setMstimAltSeasonClientBurstUntilMs(Math.max(altW, getMstimAltSeasonClientBurstUntilStored()));
  }
  /* Не вызывать set(0) здесь: устаревший ответ wallet после пикселя затирал бы mstim, пришедший раньше по mstimAltSeasonSync. Сброс — sync(0) или истечение until. */
  walletState = msg;
  if (walletState && typeof walletState.greatWallCharges !== "number") {
    walletState.greatWallCharges = 0;
  }
  syncClientCooldownFromWalletFields();
  updateWalletBar();
  updateShopAvailability();
  syncEventBanner();
  syncTeamBuffBanner();
  syncDuelTeamUi();
  syncToolbarQuantumObjective();
  refreshPassiveIncomeDisplays();
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
    return;
  }
  if (walletState.devUnlimited) {
    el.textContent = "∞";
    if (unitEl) unitEl.textContent = "квантов";
    if (subEl) {
      subEl.textContent = "";
      subEl.hidden = true;
    }
    return;
  }
  const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
  const t = usdtToQuant(b);
  el.textContent = String(t);
  if (unitEl) unitEl.textContent = quantWord(t);
  const { farm: farmOnly, zone: zoneOnly, total: passiveTotal } = getDisplayedPassiveQuantumBreakdown();
  if (subEl) {
    const sub = passiveQuantumIncomeSubtitle(farmOnly, zoneOnly, passiveTotal);
    subEl.textContent = sub.text;
    subEl.hidden = sub.hidden;
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
    clearTeamBuffBannerVisual();
    return;
  }
  const te = walletState.teamEffects;
  if (!te || (te.teamId != null && (te.teamId | 0) !== (myTeamId | 0))) {
    clearTeamBuffBannerVisual();
    return;
  }
  const until = typeof te.teamRecoveryUntil === "number" ? te.teamRecoveryUntil : 0;
  const now = effectiveClientUiNowMs();
  if (until <= now) {
    clearTeamBuffBannerVisual();
    return;
  }
  const secRaw = te.teamRecoverySec;
  const sec =
    typeof secRaw === "number" && Number.isFinite(secRaw) && secRaw >= 0 ? secRaw : BASE_ACTION_COOLDOWN_SEC;
  const buffKey = `${until}|${sec}`;
  if (teamBuffSwipeSuppressKey === buffKey && now < teamBuffSwipeSuppressUntilMs) {
    detachSwipeDismissSlot("teamBuff");
    resetDismissibleBannerNode(teamBuffBannerEl);
    try {
      delete teamBuffBannerEl.dataset.buffBannerKey;
      delete teamBuffBannerEl.dataset.buffUntil;
    } catch {
      /* ignore */
    }
    teamBuffBannerEl.hidden = true;
    return;
  }
  if (teamBuffSwipeSuppressKey !== buffKey || now >= teamBuffSwipeSuppressUntilMs) {
    teamBuffSwipeSuppressKey = "";
    teamBuffSwipeSuppressUntilMs = 0;
  }
  const left = until - now;
  const needAttach = teamBuffBannerEl.hidden || teamBuffBannerEl.dataset.buffBannerKey !== buffKey;
  teamBuffBannerEl.hidden = false;
  teamBuffBannerEl.className = "event-banner event-banner--team event-banner--swipe-dismiss";
  teamBuffBannerEl.textContent = `👥️ Командное усиление · пиксель каждые ${sec} с · ещё ${formatBuffRemainingMs(left)}`;
  teamBuffBannerEl.dataset.buffBannerKey = buffKey;
  teamBuffBannerEl.dataset.buffUntil = String(until);
  if (needAttach) {
    detachSwipeDismissSlot("teamBuff");
    resetDismissibleBannerNode(teamBuffBannerEl);
    attachSwipeDismissSlot("teamBuff", teamBuffBannerEl, hideTeamBuffBannerSwipe);
  }
}

function updateActiveBuffBars() {
  if (!toolbarBuffsEl) return;
  const online = wantOnline && getWsUrl();
  if (!online || spectatorMode || !walletState) {
    toolbarBuffsEl.hidden = true;
    if (toolbarBuffPersonalEl) toolbarBuffPersonalEl.hidden = true;
    return;
  }
  const now = effectiveClientUiNowMs();
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
  refreshPassiveIncomeDisplays();
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
      const left = COOLDOWN_MS - (effectiveClientUiNowMs() - lastPlaceAt);
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
  const left = la + cd - effectiveClientUiNowMs();
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
    syncToolbarQuantumObjective();
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
    refreshUsdtDepositUi();
    syncEventBanner();
    syncTeamBuffBanner();
    syncToolbarQuantumObjective();
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
    refreshUsdtDepositUi();
    syncEventBanner();
    syncTeamBuffBanner();
    syncToolbarQuantumObjective();
    updateToolbarHud();
    return;
  }
  if (btnDeposit) btnDeposit.hidden = spectatorMode || !!walletState.devUnlimited;
  if (btnShop) btnShop.hidden = spectatorMode;
  if (walletState.devUnlimited) {
    prevWalletQuant = null;
    const qFarmDev =
      !spectatorMode && myTeamId != null ? computePassiveQuantumIncomeQuantsPer5s() : 0;
    const farmDev = qFarmDev > 0 ? ` · пассив +${qFarmDev}/5 с` : "";
    walletBalanceEl.textContent = `💰 ∞ квантов (тест)${farmDev}`;
    walletBalanceEl.title =
      "Режим теста: бесконечные кванты. Интервал между пикселями — как у всех (таймер слева)." +
      (qFarmDev > 0 ? ` Оценка пассива (фермы + зоны турнира): ${qFarmDev} квант. / 5 с.` : "");
  } else {
    const b = typeof walletState.balanceUSDT === "number" ? walletState.balanceUSDT : 0;
    const t = usdtToQuant(b);
    if (prevWalletQuant !== null && prevWalletQuant !== t) {
      walletBalanceEl.classList.add("toolbar__wallet--pulse");
      setTimeout(() => walletBalanceEl.classList.remove("toolbar__wallet--pulse"), 700);
    }
    prevWalletQuant = t;
    const { farm: farmOnly, zone: zoneOnly, total: passiveTotal } = getDisplayedPassiveQuantumBreakdown();
    const farmSuffix = passiveTotal > 0 ? ` (+${passiveTotal} / 5 с)` : "";
    walletBalanceEl.textContent = `💰 ${t} ${quantWord(t)}${farmSuffix}`;
    walletBalanceEl.title =
      passiveTotal > 0
        ? `Баланс в квантах. Пассивный доход: ${passiveTotal} квант. / 5 с (фермы: ${farmOnly}, зоны турнира на карте: ${zoneOnly}). Таймер пикселя — слева.`
        : "Баланс в квантах. Пауза до следующего обычного пикселя — слева.";
  }
  syncShopHeaderBalance();
  refreshUsdtDepositUi();
  syncEventBanner();
  syncTeamBuffBanner();
  syncToolbarQuantumObjective();
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

/** Центр базы команды в клетках — якорь для командных/личных баффов без координаты события. */
function teamSoundAnchor(teamId) {
  const tid = teamId | 0;
  const def = teamsMeta?.find((x) => (Number(x.id) | 0) === tid);
  const sp = def?.spawn;
  if (!sp || typeof sp.x0 !== "number" || typeof sp.y0 !== "number") {
    return { gx: gridW * 0.5, gy: gridH * 0.5 };
  }
  const w = typeof sp.w === "number" ? sp.w | 0 : 6;
  const h = typeof sp.h === "number" ? sp.h | 0 : 6;
  return { gx: sp.x0 + w * 0.5, gy: sp.y0 + h * 0.5 };
}

/**
 * Захват зоны: своя команда — личный полный; чужая — локально от центра зоны.
 * @param {number} teamId
 * @param {number} gx
 * @param {number} gy
 * @param {number} sz
 * @returns {import("./audio-spatial.js").SpatialSpec}
 */
function spatialForZoneCapture(teamId, gx, gy, sz) {
  const s = sz | 0;
  const cx = (gx | 0) + s * 0.5;
  const cy = (gy | 0) + s * 0.5;
  const tid = teamId | 0;
  if (myTeamId != null && tid === (myTeamId | 0)) {
    return { scope: "personal", weight: 1 };
  }
  const weight = s >= 12 ? 0.92 : s >= 6 ? 0.74 : 0.56;
  return { scope: "local", gx: cx, gy: cy, weight };
}

/**
 * @param {unknown[][]} cells
 * @param {number} [weight]
 * @returns {import("./audio-spatial.js").SpatialSpec}
 */
function spatialCentroidFromCells(cells, weight = 0.9) {
  if (!Array.isArray(cells) || !cells.length) return { scope: "global", weight };
  let sx = 0;
  let sy = 0;
  let n = 0;
  for (let i = 0; i < cells.length; i++) {
    const p = cells[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    sx += p[0] | 0;
    sy += p[1] | 0;
    n++;
  }
  if (!n) return { scope: "global", weight };
  return { scope: "local", gx: sx / n, gy: sy / n, weight };
}

/** SFX зоны 4×4 / 6×6 / 12×12 (сервер может прислать только kind). */
function playTerritoryCaptureZoneSfx(kind, sz, spatial) {
  const raw = sz | 0;
  const side =
    raw === 4 || raw === 6 || raw === 12
      ? raw
      : kind === "zone12Capture"
        ? 12
        : kind === "massCapture"
          ? 6
          : 4;
  playTerritoryExpand(/** @type {4 | 6 | 12} */ (side), spatial);
}

function applyGlobalPurchaseVfx(msg) {
  const app = document.getElementById("app");
  const tr = getVfxTransform();
  const kind = msg.kind;
  const gx = Number(msg.gx);
  const gy = Number(msg.gy);
  const hasGrid = Number.isFinite(gx) && Number.isFinite(gy);

  if (kind === "nukeBomb") {
    if (consumeDuplicatePurchaseVfx(msg)) {
      /* optimistic снят — визуал ниже, как у остальных */
    }
    if (hasGrid) {
      const sample = Array.isArray(msg.cellsSample) ? msg.cellsSample : [];
      const nCleared =
        typeof msg.cellsCleared === "number" && Number.isFinite(msg.cellsCleared)
          ? msg.cellsCleared | 0
          : sample.length;
      const gxi = gx | 0;
      const gyi = gy | 0;
      const dupK = `${gxi},${gyi}`;
      const nowVfx = performance.now();
      const skipHeavyNukeFx =
        dupK === lastNukeBoardVfxDedupeKey && nowVfx - lastNukeBoardVfxDedupeAt < 10_000;
      if (!skipHeavyNukeFx) {
        if (boardVfx) {
          lastNukeBoardVfxDedupeKey = dupK;
          lastNukeBoardVfxDedupeAt = nowVfx;
          boardVfx.nukeExplosion(gxi, gyi, tr, sample);
          flushBoardVfxFrame();
          requestAnimationFrame(() => flushBoardVfxFrame());
        }
        const pos = gridBlastCenterClientPx(gxi, gyi);
        spawnFloatingText(floatFxHost, "УДАР!", pos, "float-fx__pop--raid");
        if (nCleared >= 48) {
          setTimeout(() => {
            spawnFloatingText(
              floatFxHost,
              "Массовое поражение!",
              { x: pos.x, y: pos.y - 30 },
              "float-fx__pop--raid"
            );
          }, 240);
        }
      }
      tryRunNukeFlashPresentation(gxi, gyi);
      playNukeExplosionSfx(gxi, gyi);
      applyNukeAftermathFromEpicenter(gxi, gyi);
      const pad = 10;
      scheduleDraw({
        dirty: {
          gx0: Math.max(0, gxi - pad),
          gy0: Math.max(0, gyi - pad),
          gx1: Math.min(gridW - 1, gxi + pad),
          gy1: Math.min(gridH - 1, gyi + pad),
        },
      });
    }
    return;
  }

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
    const zoneSp = hasGrid
      ? spatialForZoneCapture(msg.teamId | 0, gx | 0, gy | 0, sz)
      : myTeamId != null && (msg.teamId | 0) === (myTeamId | 0)
        ? { scope: /** @type {const} */ ("personal"), weight: 1 }
        : (() => {
            const a = teamSoundAnchor(msg.teamId | 0);
            return { scope: /** @type {const} */ ("local"), gx: a.gx, gy: a.gy, weight: 0.45 };
          })();
    playTerritoryCaptureZoneSfx(kind, sz, zoneSp);
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
    {
      const a = teamSoundAnchor(msg.teamId | 0);
      const isMine = myTeamId != null && (msg.teamId | 0) === (myTeamId | 0);
      playBuffPersonalSfx(
        isMine
          ? { scope: /** @type {const} */ ("personal"), weight: 1 }
          : { scope: /** @type {const} */ ("local"), gx: a.gx, gy: a.gy, weight: 0.42 }
      );
    }
    return;
  }
  if (kind === "zoneCapture" && hasGrid) {
    const sz =
      typeof msg.size === "number" && Number.isFinite(msg.size) && msg.size > 0
        ? msg.size | 0
        : 4;
    const zoneSp = spatialForZoneCapture(msg.teamId | 0, gx | 0, gy | 0, sz);
    enqueueTerritoryCapturePresentation(
      "zoneCapture",
      teamNameForPresentation(msg.teamId),
      sz,
      zoneSp
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
    const zoneSp = spatialForZoneCapture(msg.teamId | 0, gx | 0, gy | 0, sz);
    enqueueTerritoryCapturePresentation(
      "massCapture",
      teamNameForPresentation(msg.teamId),
      sz,
      zoneSp
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
    const zoneSp = spatialForZoneCapture(msg.teamId | 0, gx | 0, gy | 0, sz);
    enqueueTerritoryCapturePresentation(
      "zone12Capture",
      teamNameForPresentation(msg.teamId),
      sz,
      zoneSp
    );
    if (boardVfx) {
      boardVfx.zoneFlash(gx | 0, gy | 0, teamColor(msg.teamId | 0), tr, sz);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    return;
  }
  if (kind === "militaryBase" && hasGrid) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const nowMs = Date.now();
    const tid = msg.teamId | 0;
    if (myTeamId != null && (tid | 0) === (myTeamId | 0)) {
      if (nowMs - lastMyTeamMilitaryPurchaseVfxAtMs < 2800) return;
      lastMyTeamMilitaryPurchaseVfxAtMs = nowMs;
    }
    const col = teamColor(msg.teamId | 0);
    enqueueTerritoryCapturePresentation("militaryBase", teamNameForPresentation(msg.teamId), MILITARY_OUTPOST_SIZE, {
      scope: /** @type {const} */ ("global"),
      weight: 1,
    });
    playMilitaryBaseDeploySoundOncePerAnchor(tid, gxi, gyi);
    runMilitaryBaseDeployPresentation(msg.teamId | 0);
    if (boardVfx) {
      boardVfx.militaryBaseDeploy(gxi, gyi, col, tr);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
      requestAnimationFrame(() => {
        flushBoardVfxFrame();
      });
    }
    scheduleDraw({
      dirty: {
        gx0: gxi,
        gy0: gyi,
        gx1: gxi + MILITARY_OUTPOST_SIZE - 1,
        gy1: gyi + MILITARY_OUTPOST_SIZE - 1,
      },
    });
    return;
  }
  if ((kind === "greatWallBuilt" || kind === "greatWallHit" || kind === "greatWallBreak") && hasGrid) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const tr = getVfxTransform();
    if (kind === "greatWallBuilt") {
      const col = teamColor(msg.teamId | 0);
      boardVfx?.greatWallBuilt(gxi, gyi, col, tr);
      const sp = spatialForZoneCapture(msg.teamId | 0, gxi, gyi, 1);
      playGreatWallBuilt(sp);
    } else if (kind === "greatWallHit") {
      const col = teamColor(msg.defenderTeamId | 0);
      triggerGreatWallImpactShake("hit");
      boardVfx?.greatWallHit(gxi, gyi, col, tr);
      const sp = spatialForZoneCapture(msg.defenderTeamId | 0, gxi, gyi, 1);
      playGreatWallHit(sp);
    } else {
      const ac = teamColor(msg.attackerTeamId | 0);
      const dc = teamColor(msg.defenderTeamId | 0);
      triggerGreatWallImpactShake("break");
      boardVfx?.greatWallBreak(gxi, gyi, ac, dc, tr);
      const sp = spatialForZoneCapture(msg.attackerTeamId | 0, gxi, gyi, 1);
      playGreatWallBreak(sp);
    }
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
    scheduleDraw({ dirty: { gx0: gxi, gy0: gyi, gx1: gxi, gy1: gyi } });
    return;
  }
  if (kind === "baseRepair" && hasGrid) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const tid = msg.teamId | 0;
    const mode = msg.mode === "military" ? "military" : "main";
    const col = teamColor(tid);
    if (boardVfx) {
      boardVfx.baseRepairHeal(gxi, gyi, col, tr, mode);
      flushBoardVfxFrame();
      requestAnimationFrame(() => flushBoardVfxFrame());
    }
    {
      const isMine = myTeamId != null && (tid | 0) === (myTeamId | 0);
      const a = teamSoundAnchor(tid);
      playBuffPersonalSfx(
        isMine
          ? { scope: /** @type {const} */ ("personal"), weight: 1 }
          : { scope: /** @type {const} */ ("local"), gx: a.gx, gy: a.gy, weight: 0.48 }
      );
    }
    const pos = gridCellCenterToClientPx(gxi + 0.5, gyi + 0.5);
    const d = typeof msg.delta === "number" && Number.isFinite(msg.delta) ? msg.delta | 0 : BASE_REPAIR_HP_DELTA;
    if (pos && floatFxHost) {
      spawnFloatingText(floatFxHost, `+${d} HP`, pos, "float-fx__pop--gold");
    }
    scheduleDraw({
      dirty: {
        gx0: Math.max(0, gxi - 2),
        gy0: Math.max(0, gyi - 2),
        gx1: Math.min(gridW - 1, gxi + 2),
        gy1: Math.min(gridH - 1, gyi + 2),
      },
    });
    return;
  }
  if (kind === "quantumFarmUpgrade") {
    const fid = msg.farmId | 0;
    const lv = normalizeQuantumFarmLevel(msg.level);
    if (fid) {
      for (let i = 0; i < quantumFarmsMeta.length; i++) {
        if ((quantumFarmsMeta[i].id | 0) === fid) {
          quantumFarmsMeta[i] = { ...quantumFarmsMeta[i], level: lv };
          break;
        }
      }
    }
    {
      const a = teamSoundAnchor(msg.teamId | 0);
      const isMine = myTeamId != null && (msg.teamId | 0) === (myTeamId | 0);
      playBuffTeamSfx(
        isMine
          ? { scope: /** @type {const} */ ("personal"), weight: 1 }
          : { scope: /** @type {const} */ ("local"), gx: a.gx, gy: a.gy, weight: 0.42 }
      );
    }
    refreshPassiveIncomeDisplays();
    syncToolbarQuantumObjective();
    scheduleDraw({ full: true });
    return;
  }
  if (kind === "teamRecovery") {
    app?.classList.add("fx-team-boost");
    setTimeout(() => app?.classList.remove("fx-team-boost"), 2000);
    boardVfx?.lightningBurst(getVfxTransform());
    flushBoardVfxFrame();
    requestAnimationFrame(() => flushBoardVfxFrame());
    {
      const a = teamSoundAnchor(msg.teamId | 0);
      const isMine = myTeamId != null && (msg.teamId | 0) === (myTeamId | 0);
      playBuffTeamSfx(
        isMine
          ? { scope: /** @type {const} */ ("personal"), weight: 1 }
          : { scope: /** @type {const} */ ("local"), gx: a.gx, gy: a.gy, weight: 0.48 }
      );
    }
  }
}

/** Только для покупателя: всплывающие подсказки и «Повторить»; карта — через applyGlobalPurchaseVfx. */
function handlePurchaseOk(msg) {
  const kind = msg.kind;
  const flo = { x: window.innerWidth * 0.5, y: window.innerHeight * 0.36 };

  if (kind === "greatWallCharge") {
    const n =
      typeof msg.charges === "number" && Number.isFinite(msg.charges)
        ? Math.max(0, msg.charges | 0)
        : getGreatWallChargesClient();
    if (walletState) walletState.greatWallCharges = n;
    updateGreatWallShopStockUi();
    showPlacementFeedback(`Кирпич куплен. Запас: ${n}. «На карту» или «Повторить» → разместить.`, "ok", {
      telegramAlert: false,
    });
    try {
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch {
      /* ignore */
    }
  }
  if (kind === "greatWall") {
    optimisticGreatWallPending = null;
    const leftRaw = msg.chargesLeft;
    const leftKnown =
      typeof leftRaw === "number" && Number.isFinite(leftRaw) ? Math.max(0, leftRaw | 0) : null;
    if (leftKnown !== null && walletState) walletState.greatWallCharges = leftKnown;
    updateGreatWallShopStockUi();
    const effectiveLeft = leftKnown !== null ? leftKnown : getGreatWallChargesClient();
    if (effectiveLeft <= 0) {
      pendingMapAction = null;
    } else {
      pendingMapAction = { type: "greatWall" };
    }
    setPendingHint();
    const wx = typeof msg.x === "number" ? msg.x | 0 : NaN;
    const wy = typeof msg.y === "number" ? msg.y | 0 : NaN;
    if (Number.isFinite(wx) && Number.isFinite(wy)) {
      showPlacementFeedback(
        effectiveLeft > 0
          ? `Стена установлена. Осталось кирпичей: ${effectiveLeft}.`
          : "Стена установлена. Запас исчерпан.",
        "ok",
        {
          telegramAlert: false,
        }
      );
    }
  }
  if (kind === "baseRepair") {
    const d = typeof msg.deltaHp === "number" && Number.isFinite(msg.deltaHp) ? msg.deltaHp | 0 : BASE_REPAIR_HP_DELTA;
    showPlacementFeedback(`База отремонтирована: +${d} HP`, "ok", { telegramAlert: false });
    try {
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch {
      /* ignore */
    }
  }
  if (kind === "quantumFarmUpgrade") {
    const fid = msg.farmId | 0;
    const lv = normalizeQuantumFarmLevel(msg.level);
    if (fid) {
      for (let i = 0; i < quantumFarmsMeta.length; i++) {
        if ((quantumFarmsMeta[i].id | 0) === fid) {
          quantumFarmsMeta[i] = { ...quantumFarmsMeta[i], level: lv };
          break;
        }
      }
    }
    playPurchaseSuccess();
    refreshPassiveIncomeDisplays();
    syncToolbarQuantumObjective();
    scheduleDraw({ full: true });
    const keepOpen =
      quantumFarmPanelAnchorFarmId != null &&
      (quantumFarmPanelAnchorFarmId | 0) === (fid | 0) &&
      quantumFarmPanelEl &&
      !quantumFarmPanelEl.hidden;
    if (keepOpen) {
      const nf = quantumFarmsMeta.find((x) => (x.id | 0) === (fid | 0));
      if (nf) {
        openQuantumFarmPanel(nf);
        celebrateQuantumFarmUpgrade(nf, lv);
        return;
      }
    }
    closeQuantumFarmPanel();
    showPlacementFeedback(`Квантовая ферма: уровень ${lv}.`, "ok", { telegramAlert: false });
  }
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
  if (kind === "nukeBomb") {
    const nx = typeof msg.x === "number" && Number.isFinite(msg.x) ? msg.x | 0 : NaN;
    const ny = typeof msg.y === "number" && Number.isFinite(msg.y) ? msg.y | 0 : NaN;
    if (Number.isFinite(nx) && Number.isFinite(ny)) {
      tryRunNukeFlashPresentation(nx, ny);
      playNukeExplosionSfx(nx, ny);
      if (boardVfx) {
        const tr = getVfxTransform();
        const sample = Array.isArray(msg.cellsSample) ? msg.cellsSample : [];
        const t = performance.now();
        lastNukeBoardVfxDedupeKey = `${nx},${ny}`;
        lastNukeBoardVfxDedupeAt = t;
        boardVfx.nukeExplosion(nx, ny, tr, sample);
        flushBoardVfxFrame();
        requestAnimationFrame(() => flushBoardVfxFrame());
      }
      applyNukeAftermathFromEpicenter(nx, ny);
      const posOk = gridBlastCenterClientPx(nx, ny);
      spawnFloatingText(floatFxHost, "УДАР!", posOk, "float-fx__pop--raid");
      const nClearOk = typeof msg.cells === "number" && Number.isFinite(msg.cells) ? msg.cells | 0 : 0;
      if (nClearOk >= 48) {
        setTimeout(() => {
          spawnFloatingText(
            floatFxHost,
            "Массовое поражение!",
            { x: posOk.x, y: posOk.y - 30 },
            "float-fx__pop--raid"
          );
        }, 240);
      }
    } else {
      tryRunNukeFlashPresentation(NaN, NaN);
      playNukeExplosionSfx(NaN, NaN);
    }
    spawnFloatingText(floatFxHost, "☢ БОМБА ЗАПУЩЕНА", { x: flo.x, y: flo.y - 14 }, "float-fx__pop--raid");
    setTimeout(() => {
      spawnFloatingText(floatFxHost, "Списаны кванты — эпицентр на карте", { x: flo.x, y: flo.y + 8 }, "float-fx__pop--raid");
    }, 280);
  }
  if (kind === "militaryBase") {
    const mx0 = typeof msg.x0 === "number" && Number.isFinite(msg.x0) ? msg.x0 | 0 : NaN;
    const my0 = typeof msg.y0 === "number" && Number.isFinite(msg.y0) ? msg.y0 | 0 : NaN;
    const tidOk = myTeamId != null ? myTeamId | 0 : 0;
    if (teamsMeta && tidOk && Number.isFinite(mx0) && Number.isFinite(my0)) {
      teamsMeta = teamsMeta.map((t) => {
        if ((t.id | 0) !== tidOk) return t;
        const mos = Array.isArray(t.militaryOutposts) ? t.militaryOutposts.slice() : [];
        const dup = mos.some((o) => o && (o.x0 | 0) === mx0 && (o.y0 | 0) === my0);
        if (!dup) {
          mos.push({ x0: mx0, y0: my0, w: MILITARY_OUTPOST_SIZE, h: MILITARY_OUTPOST_SIZE });
        }
        return { ...t, militaryOutposts: mos };
      });
      drawConnectivityFrameId++;
    }
    spawnFloatingText(floatFxHost, "ПЛАЦДАРМ ЗАКРЕПЛЁН", { x: flo.x, y: flo.y - 18 }, "float-fx__pop--military");
    setTimeout(() => {
      spawnFloatingText(floatFxHost, "НОВЫЙ ВЕКТОР НА КАРТЕ", { x: flo.x, y: flo.y + 8 }, "float-fx__pop--military-sub");
    }, 420);
    showPlacementFeedback(
      "Передовая база — второй активный корень: территория от неё снабжается так же, как от главной; изоляция только если оторваны от всех баз.",
      "success",
      { telegramAlert: false }
    );
    try {
      window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("success");
    } catch {
      /* ignore */
    }
  }
  if (kind === "teamRecovery") {
    const s = typeof msg.tierSec === "number" ? msg.tierSec : "?";
    spawnFloatingText(floatFxHost, `👥 КОМАНДА: ${s} С`, { x: flo.x, y: flo.y - 4 }, "float-fx__pop--gold");
  }
  recordQuickBuyAfterPurchase(kind, msg);
  applyShopPurchaseSuccessUi(msg);
  playPurchaseSuccess();
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
  if (kind === "nukeBomb") return action === "nukeBomb";
  if (kind === "militaryBase") return action === "militaryBase";
  if (kind === "greatWallCharge") return action === "greatWallBuy";
  if (kind === "greatWall") return false;
  if (kind === "baseRepair") return action === "baseRepair";
  return false;
}

function applyShopPurchaseSuccessUi(msg) {
  const root = document.getElementById("shop-overlay");
  if (!root || root.hidden) return;
  /* Стена: много кликов «Купить» подряд — не затираем подпись кнопки галочкой. */
  if (msg.kind === "greatWallCharge") {
    updateGreatWallShopStockUi();
    updateShopAvailability();
    return;
  }
  resetShopPurchaseButtonsUi();
  const buttons = Array.from(root.querySelectorAll(".shop-btn"));
  const winner = buttons.find((b) => shopBtnMatchesPurchase(b, msg));
  if (!winner) return;
  winner.textContent = "✓";
  winner.classList.add("game-shop__buy--success");
  winner.setAttribute("aria-label", "Куплено");
  updateShopAvailability();
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
  } else if (kind === "teamRecovery" && [10, 5, 2, 1].includes(tier)) {
    pushQuickBuyHistory({ action: "teamRecovery", tierSec: tier });
  } else if (kind === "zoneCapture") {
    pushQuickBuyHistory({ action: "zoneCapture" });
  } else if (kind === "massCapture") {
    pushQuickBuyHistory({ action: "massCapture" });
  } else if (kind === "zone12Capture") {
    pushQuickBuyHistory({ action: "zone12Capture" });
  } else if (kind === "nukeBomb") {
    pushQuickBuyHistory({ action: "nukeBomb" });
  } else if (kind === "militaryBase") {
    pushQuickBuyHistory({ action: "militaryBase" });
  } else if (kind === "greatWallCharge") {
    pushQuickBuyHistory({ action: "greatWall" });
  } else if (kind === "baseRepair") {
    pushQuickBuyHistory({ action: "baseRepair" });
  }
}

function getQuickBuyPriceQuant(entry) {
  if (entry.action === "personalRecovery") return PRICES_QUANT.personal[entry.tierSec] ?? 0;
  if (entry.action === "teamRecovery") return PRICES_QUANT.team[entry.tierSec] ?? 0;
  if (entry.action === "zoneCapture") return PRICES_QUANT.zone4;
  if (entry.action === "massCapture") return PRICES_QUANT.zone6;
  if (entry.action === "zone12Capture") return PRICES_QUANT.zone12;
  if (entry.action === "nukeBomb") return PRICES_QUANT.nukeBomb;
  if (entry.action === "militaryBase") return PRICES_QUANT.militaryBase;
  if (entry.action === "greatWall") return PRICES_QUANT.greatWall;
  if (entry.action === "baseRepair") return PRICES_QUANT.baseRepair;
  return 0;
}

function quickBuyShortLabel(entry) {
  if (entry.action === "personalRecovery") return `⚡ ${entry.tierSec} с`;
  if (entry.action === "teamRecovery") return `👥 ${entry.tierSec} с`;
  if (entry.action === "zoneCapture") return "4×4";
  if (entry.action === "massCapture") return "6×6";
  if (entry.action === "zone12Capture") return "12×12";
  if (entry.action === "nukeBomb") return "☢";
  if (entry.action === "militaryBase") return "FOB";
  if (entry.action === "greatWall") return "Стена";
  if (entry.action === "baseRepair") return "Ремонт";
  return "?";
}

/** Иконка в круглой FAB-кнопке (без крупных подписей). */
function quickBuyFabGlyphMeta(entry) {
  if (entry.action === "personalRecovery") return { char: "⚡", glyphClass: "" };
  if (entry.action === "teamRecovery") return { char: "👥", glyphClass: "" };
  if (entry.action === "zoneCapture") return { char: "4", glyphClass: " quick-buy-rail__glyph--num" };
  if (entry.action === "massCapture") return { char: "6", glyphClass: " quick-buy-rail__glyph--num" };
  if (entry.action === "zone12Capture")
    return { char: "12", glyphClass: " quick-buy-rail__glyph--num quick-buy-rail__glyph--num12" };
  if (entry.action === "nukeBomb") return { char: "☢", glyphClass: "" };
  if (entry.action === "militaryBase") return { char: "⛺", glyphClass: "" };
  if (entry.action === "greatWall") return { char: "🧱", glyphClass: "" };
  if (entry.action === "baseRepair") return { char: "🔧", glyphClass: "" };
  return { char: "?", glyphClass: "" };
}

/** Краткое имя для aria-label на FAB. */
function quickBuyAriaName(entry) {
  if (entry.action === "personalRecovery") return `Личное ускорение, ${entry.tierSec} с`;
  if (entry.action === "teamRecovery") return `Командное ускорение, ${entry.tierSec} с`;
  if (entry.action === "zoneCapture") return "Захват зоны 4×4";
  if (entry.action === "massCapture") return "Масс-захват 6×6";
  if (entry.action === "zone12Capture") return "Зона 12×12";
  if (entry.action === "nukeBomb") return "Тактическая бомба";
  if (entry.action === "militaryBase") return "Плацдарм";
  if (entry.action === "greatWall") return "Великая стена";
  if (entry.action === "baseRepair") return "Ремонт базы, таргет на карте";
  return "Покупка";
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
  if (wantOnline && gamePausedMeta) return true;
  if (!walletState) return true;
  if (!walletState.devUnlimited) {
    const st = walletState.tournamentStage || "MASS_BATTLE";
    if (st === "GRAND_FINAL") return true;
    if (st === "DUEL") {
      const recovery =
        entry.action === "personalRecovery" || entry.action === "teamRecovery";
      if (!recovery) return true;
    }
  }
  if (entry.action === "teamRecovery" && myTeamId == null) return true;
    if (
      (entry.action === "zoneCapture" ||
      entry.action === "massCapture" ||
      entry.action === "zone12Capture" ||
      entry.action === "nukeBomb" ||
      entry.action === "militaryBase" ||
      entry.action === "greatWall" ||
      entry.action === "baseRepair") &&
    myTeamId == null
  ) {
    return true;
  }
  const affordBlocked =
    entry.action === "greatWall" && getGreatWallChargesClient() > 0
      ? false
      : !playerCanAffordQuickBuy(entry);
  if (affordBlocked) return true;
  return false;
}

function executeQuickBuy(entry) {
  if (wantOnline && gamePausedMeta) {
    notifyPurchaseError("paused");
    return;
  }
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
  if (entry.action === "teamRecovery" && [10, 5, 2, 1].includes(entry.tierSec)) {
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
  if (entry.action === "nukeBomb") {
    pendingMapAction = { type: "nukeBomb" };
    setPendingHint();
    showPlacementFeedback(
      "Тактическая бомба: тап по карте. Зона ~12×12 с неровным краем — снимает чужую закраску и стены; ваши клетки не затрагиваются.",
      "warn",
      { telegramAlert: false }
    );
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("heavy");
    } catch {
      /* ignore */
    }
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
  if (entry.action === "greatWall") {
    if (getGreatWallChargesClient() > 0) {
      pendingMapAction = { type: "greatWall" };
      setPendingHint();
      showPlacementFeedback(
        `Стена: запас ${getGreatWallChargesClient()} шт. Тап по своей клетке (не флаг).`,
        "info",
        { telegramAlert: false }
      );
      try {
        window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
      } catch {
        /* ignore */
      }
      if (shopOverlay) shopOverlay.hidden = true;
      return;
    }
    wsSendJson({ type: "purchaseGreatWallCharge" });
    return;
  }
  if (entry.action === "baseRepair") {
    pendingMapAction = { type: "baseRepair" };
    setPendingHint();
    showPlacementFeedback(
      `Ремонт базы — таргет на карте (не мгновенная покупка). Тап: клетка флага главной или любая клетка своего плацдарма. +${BASE_REPAIR_HP_DELTA} HP, не выше max. ${PRICES_QUANT.baseRepair} кв. спишутся только если ремонт применён.`,
      "info",
      { telegramAlert: false }
    );
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
    } catch {
      /* ignore */
    }
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
  if (entry.action === "militaryBase") {
    pendingMapAction = { type: "militaryBase" };
    setPendingHint();
    showPlacementFeedback(
      "Плацдарм готов: выберите точку на карте — это сильнейший стратегический ход команды.",
      "info",
      { telegramAlert: false }
    );
    try {
      window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
    } catch {
      /* ignore */
    }
    if (shopOverlay) shopOverlay.hidden = true;
    return;
  }
}

const QUICK_BUY_RING_R = 10;
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
    btn.className = "quick-buy-rail__btn quick-buy-rail__btn--fab";
    btn.dataset.action = entry.action;
    if (entry.tierSec != null) btn.dataset.tierSec = String(entry.tierSec);
    const blocked = isQuickBuyEntryBlocked(entry);
    btn.disabled = blocked;
    const short = quickBuyShortLabel(entry);
    if (entry.action === "greatWall") {
      const stock = getGreatWallChargesClient();
      btn.title =
        stock > 0
          ? `${short} · запас ${stock} — тап: поставить стену (кванты не списываются)`
          : `${short} · ${q} кв. — тап: купить 1 кирпич в запас`;
    } else if (entry.action === "baseRepair") {
      btn.title = `${short} · ${q} кв. — таргет: тап по своей базе на карте, +${BASE_REPAIR_HP_DELTA} HP (не выше max); кванты списываются только после успеха`;
    } else if (
      entry.action === "zoneCapture" ||
      entry.action === "massCapture" ||
      entry.action === "zone12Capture" ||
      entry.action === "nukeBomb" ||
      entry.action === "militaryBase"
    ) {
      btn.title = `${short} · ${q} кв. — тап по карте, затем списание`;
    } else if (!playerCanAffordQuickBuy(entry)) {
      btn.title = `${short} · ${q} кв. — не хватает квантов`;
    } else {
      btn.title = `${short} · ${q} кв. — быстрая покупка`;
    }
    btn.dataset.titleBase = btn.title;
    btn.setAttribute("aria-label", `${quickBuyAriaName(entry)}, ${q} квантов`);

    const fab = document.createElement("span");
    fab.className = "quick-buy-rail__fab";

    const isRecovery =
      entry.action === "personalRecovery" || entry.action === "teamRecovery";
    const { char: glyphChar, glyphClass } = quickBuyFabGlyphMeta(entry);

    if (isRecovery) {
      fab.classList.add("quick-buy-rail__fab--recovery");
      btn.classList.add(
        entry.action === "teamRecovery"
          ? "quick-buy-rail__btn--kind-team"
          : "quick-buy-rail__btn--kind-personal"
      );
      const orbit = document.createElement("div");
      orbit.className = "quick-buy-rail__orbit";
      orbit.setAttribute("aria-hidden", "true");
      const svgNs = "http://www.w3.org/2000/svg";
      const svg = document.createElementNS(svgNs, "svg");
      svg.setAttribute("class", "quick-buy-rail__svg");
      svg.setAttribute("viewBox", "0 0 36 36");
      const track = document.createElementNS(svgNs, "circle");
      track.setAttribute("class", "quick-buy-rail__ring-track");
      track.setAttribute("cx", "18");
      track.setAttribute("cy", "18");
      track.setAttribute("r", String(QUICK_BUY_RING_R));
      track.setAttribute("fill", "none");
      const arc = document.createElementNS(svgNs, "circle");
      arc.setAttribute("class", "quick-buy-rail__ring-arc");
      arc.setAttribute("cx", "18");
      arc.setAttribute("cy", "18");
      arc.setAttribute("r", String(QUICK_BUY_RING_R));
      arc.setAttribute("fill", "none");
      arc.setAttribute("transform", "rotate(-90 18 18)");
      arc.style.strokeDasharray = String(QUICK_BUY_RING_C);
      arc.style.strokeDashoffset = String(QUICK_BUY_RING_C);
      svg.appendChild(track);
      svg.appendChild(arc);
      orbit.appendChild(svg);
      fab.appendChild(orbit);
    }

    const glyph = document.createElement("span");
    glyph.className = `quick-buy-rail__glyph${glyphClass}`;
    glyph.setAttribute("aria-hidden", "true");
    glyph.textContent = glyphChar;

    const cost = document.createElement("span");
    cost.className = "quick-buy-rail__cost";
    cost.setAttribute("aria-hidden", "true");
    cost.textContent = String(q);

    fab.appendChild(glyph);
    fab.appendChild(cost);
    if (entry.action === "greatWall") {
      const gwSt = getGreatWallChargesClient();
      if (gwSt > 0) {
        const stEl = document.createElement("span");
        stEl.className = "quick-buy-rail__gw-stock";
        stEl.textContent = `×${gwSt}`;
        fab.appendChild(stEl);
      }
    }
    btn.appendChild(fab);

    host.appendChild(btn);
  }
  updateQuickBuyBuffRings();
  syncQuickBuyRailMapPending();
}

/** Подсветка кнопок 4×4 / 6×6 / 12×12 в «Повторить», пока ждём тап по карте. */
function syncQuickBuyRailMapPending() {
  const host = document.getElementById("quick-buy-list");
  if (!host) return;
  const t = pendingMapAction?.type;
  const mapKinds = new Set([
    "zoneCapture",
    "massCapture",
    "zone12Capture",
    "nukeBomb",
    "militaryBase",
    "greatWall",
    "baseRepair",
  ]);
  host.querySelectorAll(".quick-buy-rail__btn").forEach((btn) => {
    const a = btn.dataset.action || "";
    const armed = mapKinds.has(a) && t === a;
    btn.classList.toggle("quick-buy-rail__btn--map-armed", armed);
    if (armed) btn.setAttribute("aria-pressed", "true");
    else btn.removeAttribute("aria-pressed");
  });
}

/** Круговой «радар» оставшегося времени баффа на кнопке «Повторить» (личн. / команда). */
function updateQuickBuyBuffRings() {
  const host = document.getElementById("quick-buy-list");
  if (!host) return;
  const now = effectiveClientUiNowMs();
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
    if (typeof document !== "undefined" && document.visibilityState === "hidden") {
      mapAnimTimer = setTimeout(tick, 900);
      return;
    }
    if (!mapDrawUseLite()) drawFull(performance.now());
    const base =
      lastDrawVisibleCellCount > 16000 ? 160
      : lastDrawVisibleCellCount > 10000 ? 90
      : 45;
    /* Фермы у центра — заметнее пульсация маяков без лишней нагрузки на слабых устройствах. */
    const ms = quantumFarmsMeta.length > 0 ? Math.max(30, base - 14) : base;
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
  /* В фоне (свёрнули Telegram) не крутим VFX — меньше CPU/GPU и шанс, что система убьёт WebView. */
  if (typeof document !== "undefined" && document.visibilityState === "hidden") {
    requestAnimationFrame(vfxLoop);
    return;
  }
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
    DUEL:
      "Дуэль: ускорение пикселя (личное и командное) и улучшение квантовых ферм. Зоны и тактика отключены.",
    GRAND_FINAL: "Наблюдение: покупки отключены.",
  };
  const msg = Object.prototype.hasOwnProperty.call(hints, st) ? hints[st] : st;
  shopStageHint.textContent = msg;
  shopStageHint.hidden = !msg;
  document.querySelectorAll(".shop-btn").forEach((btn) => {
    const action = btn.dataset.action || "";
    const recovery = action === "personalRecovery" || action === "teamRecovery";
    let blocked = false;
    if (walletState.devUnlimited !== true) {
      if (st === "GRAND_FINAL" || spectatorMode) blocked = true;
      else if (st === "DUEL" && !recovery) blocked = true;
    }
    btn.disabled = blocked;
  });
  const effEl = document.getElementById("shop-effective-recovery-hint");
  if (effEl) {
    const now = effectiveClientUiNowMs();
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
    const now = effectiveClientUiNowMs();
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
  updateGreatWallShopStockUi();
  const gwStock = getGreatWallChargesClient();
  const gwStageBlocked =
    walletState.devUnlimited !== true &&
    (st === "GRAND_FINAL" || spectatorMode || st === "DUEL");
  document.querySelectorAll('.shop-btn[data-action="greatWallPlace"]').forEach((b) => {
    b.disabled = gwStageBlocked || myTeamId == null || gwStock < 1;
  });
  document.querySelectorAll('.shop-btn[data-action="greatWallBuy"]').forEach((b) => {
    let bBuy = gwStageBlocked || myTeamId == null;
    if (!walletState.devUnlimited && walletState.balanceUSDT != null) {
      const need = quantToUsdt(PRICES_QUANT.greatWall);
      if (walletState.balanceUSDT + 1e-9 < need) bBuy = true;
    }
    b.disabled = bBuy;
  });
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

function notifyUsdtPurchasesDisabled() {
  const msg =
    "Покупки за реальные деньги отключены ради честной игры. Все соревнуются на равных условиях.";
  const tg = window.Telegram?.WebApp;
  if (typeof tg?.showAlert === "function") tg.showAlert(msg);
  else alert(msg);
  playUiError();
}

function syncDevUnlimitedShopHints() {
  const dev = isWalletDevUnlimited();
  const usdt = isUsdtDepositsEnabled();
  document.querySelectorAll(".shop-topup-pack").forEach((btn) => {
    if (!usdt) {
      btn.style.opacity = "";
      return;
    }
    btn.style.opacity = dev ? "0.55" : "";
    btn.title = dev ? "В тестовом режиме пополнение не требуется" : "";
  });
}

function applyUsdtDepositsDisabledUi() {
  const enabled = isUsdtDepositsEnabled();
  document
    .querySelector("#shop-overlay .game-shop")
    ?.classList.toggle("game-shop--usdt-deposits-off", !enabled);
  const fairPlayNotice = document.getElementById("shop-fair-play-notice");
  if (fairPlayNotice) fairPlayNotice.hidden = enabled;

  document.querySelectorAll(".shop-topup-pack").forEach((btn) => {
    btn.disabled = !enabled;
    btn.setAttribute("aria-disabled", enabled ? "false" : "true");
    btn.classList.toggle("shop-topup-pack--usdt-off", !enabled);
    if (!enabled) btn.title = FAIR_PLAY_DISABLED_TOOLTIP;
    else btn.title = "";
  });

  document.querySelectorAll(".deposit-amt").forEach((btn) => {
    btn.disabled = !enabled;
    btn.setAttribute("aria-disabled", enabled ? "false" : "true");
    btn.classList.toggle("deposit-amt--usdt-off", !enabled);
    if (!enabled) btn.title = FAIR_PLAY_DISABLED_TOOLTIP;
    else btn.title = "";
  });

  if (depositCustom) {
    depositCustom.disabled = !enabled;
    depositCustom.readOnly = !enabled;
    depositCustom.title = !enabled ? FAIR_PLAY_DISABLED_TOOLTIP : "";
  }

  if (depositSubmit) {
    if (!enabled) {
      depositSubmit.disabled = true;
      depositSubmit.textContent = "Отключено";
      depositSubmit.title = FAIR_PLAY_DISABLED_TOOLTIP;
    } else {
      depositSubmit.disabled = false;
      if (depositSubmit.textContent === "Отключено") depositSubmit.textContent = "Создать счёт";
      depositSubmit.title = "";
    }
  }

  const shopOpen = document.getElementById("shop-open-deposit");
  if (shopOpen) {
    shopOpen.disabled = !enabled;
    shopOpen.classList.toggle("game-shop__deposit-btn--usdt-off", !enabled);
    if (!enabled) shopOpen.title = FAIR_PLAY_DISABLED_TOOLTIP;
    else if (!isWalletDevUnlimited()) shopOpen.title = "";
  }

  if (btnDeposit) {
    if (!enabled) {
      btnDeposit.disabled = true;
      btnDeposit.title = FAIR_PLAY_DISABLED_TOOLTIP;
      btnDeposit.classList.add("toolbar__btn--usdt-deposit-off");
    } else {
      btnDeposit.disabled = false;
      btnDeposit.title = "Пополнить кванты (оплата USDT)";
      btnDeposit.classList.remove("toolbar__btn--usdt-deposit-off");
    }
  }

  syncDevUnlimitedShopHints();
}

function refreshUsdtDepositUi() {
  syncShopDepositButton();
  applyUsdtDepositsDisabledUi();
}

function setupEconomyUi() {
  btnDeposit?.addEventListener("click", () => {
    if (isWalletDevUnlimited()) {
      notifyDevUnlimitedNoDeposit();
      return;
    }
    if (!isUsdtDepositsEnabled()) {
      notifyUsdtPurchasesDisabled();
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
    if (!isUsdtDepositsEnabled()) {
      notifyUsdtPurchasesDisabled();
      return;
    }
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
          if (
            msg === "Purchases are currently disabled" ||
            (typeof msg === "string" && msg.includes("Purchases are currently disabled"))
          ) {
            msg = "Покупки отключены ради честной игры.";
          }
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
      const depOn = isUsdtDepositsEnabled();
      depositSubmit.disabled = !depOn;
      depositSubmit.textContent = depOn ? prevLabel : "Отключено";
    }
  });

  btnShop?.addEventListener("click", () => {
    playMenuOpenSfx();
    resetShopPurchaseButtonsUi();
    if (shopOverlay) shopOverlay.hidden = false;
    const bal = document.getElementById("shop-display-balance");
    if (bal) {
      bal.setAttribute("data-pulse", "1");
      setTimeout(() => bal.removeAttribute("data-pulse"), 500);
    }
    syncShopHeaderBalance();
    refreshUsdtDepositUi();
    updateShopAvailability();
    setPendingHint();
  });

  document.getElementById("shop-open-deposit")?.addEventListener("click", () => {
    if (wantOnline && gamePausedMeta) {
      notifyPurchaseError("paused");
      return;
    }
    if (isWalletDevUnlimited()) {
      notifyDevUnlimitedNoDeposit();
      return;
    }
    if (!isUsdtDepositsEnabled()) {
      notifyUsdtPurchasesDisabled();
      return;
    }
    depositBonusQuant = 0;
    if (shopOverlay) shopOverlay.hidden = true;
    if (depositOverlay) depositOverlay.hidden = false;
    if (depositError) depositError.hidden = true;
  });

  document.querySelectorAll(".shop-topup-pack").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (wantOnline && gamePausedMeta) {
        notifyPurchaseError("paused");
        return;
      }
      if (isWalletDevUnlimited()) {
        notifyDevUnlimitedNoDeposit();
        return;
      }
      if (!isUsdtDepositsEnabled()) {
        notifyUsdtPurchasesDisabled();
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
        resetShopPurchaseButtonsUi();
        updateShopAvailability();
      });
    });
  })();
  shopClose?.addEventListener("click", () => {
    if (shopOverlay) shopOverlay.hidden = true;
    if (pendingMapAction?.type !== "greatWall") {
      pendingMapAction = null;
    }
    setPendingHint();
  });
  shopOverlay?.addEventListener("click", (e) => {
    if (e.target === shopOverlay) {
      shopOverlay.hidden = true;
      if (pendingMapAction?.type !== "greatWall") {
        pendingMapAction = null;
      }
      setPendingHint();
    }
  });

  document.querySelectorAll(".shop-btn").forEach((btn) => {
    btn.addEventListener("click", () => {
      if (wantOnline && gamePausedMeta) {
        notifyPurchaseError("paused");
        return;
      }
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
        if ([10, 5, 2, 1].includes(tier)) {
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
      if (action === "nukeBomb") {
        pendingMapAction = { type: "nukeBomb" };
        setPendingHint();
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "greatWallBuy") {
        wsSendJson({ type: "purchaseGreatWallCharge" });
        return;
      }
      if (action === "greatWallPlace") {
        if (getGreatWallChargesClient() < 1) {
          notifyPurchaseError("no_wall_charges");
          return;
        }
        pendingMapAction = { type: "greatWall" };
        setPendingHint();
        showPlacementFeedback(
          `Стена: запас ${getGreatWallChargesClient()} шт. Тап по своей клетке (не флаг).`,
          "info",
          { telegramAlert: false }
        );
        try {
          window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
        } catch {
          /* ignore */
        }
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "baseRepair") {
        pendingMapAction = { type: "baseRepair" };
        setPendingHint();
        showPlacementFeedback(
          `Режим ремонта базы: укажите на карте только свою базу (флаг или плацдарм). +${BASE_REPAIR_HP_DELTA} HP до лимита. ${PRICES_QUANT.baseRepair} кв. — только после успешного тапа.`,
          "info",
          { telegramAlert: false }
        );
        try {
          window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
        } catch {
          /* ignore */
        }
        if (shopOverlay) shopOverlay.hidden = true;
        return;
      }
      if (action === "militaryBase") {
        pendingMapAction = { type: "militaryBase" };
        setPendingHint();
        showPlacementFeedback(
          "Плацдарм готов: выберите точку на карте — это сильнейший стратегический ход команды.",
          "info",
          { telegramAlert: false }
        );
        try {
          window.Telegram?.WebApp?.HapticFeedback?.impactOccurred?.("medium");
        } catch {
          /* ignore */
        }
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
        if (btn.disabled) return;
        btn.classList.remove("fx-btn-press");
        void btn.offsetWidth;
        btn.classList.add("fx-btn-press");
        setTimeout(() => btn.classList.remove("fx-btn-press"), 280);
      },
      { passive: true }
    );
  });

  refreshUsdtDepositUi();
}

function setPendingHint() {
  if (!pendingMapAction) {
    mapHoverGx = -1;
    mapHoverGy = -1;
  }
  const full = (() => {
    if (!pendingMapAction) return "";
    if (pendingMapAction.type === "zoneCapture")
      return "Зона 4×4: тап по углу области — все 16 клеток перекрасятся";
    if (pendingMapAction.type === "massCapture")
      return "Масс-захват 6×6: тап по центру — все 36 клеток перекрасятся";
    if (pendingMapAction.type === "zone12Capture")
      return "Зона 12×12: тап по центру — 144 клетки перекрасятся";
    if (pendingMapAction.type === "nukeBomb")
      return "Бомба: тап по эпицентру — взрыв ~12×12; чужие клетки снимаются, свои не страдают";
    if (pendingMapAction.type === "militaryBase")
      return "Плацдарм 2×2 — второй корень команды для расширения и снабжения. Тап по левому верхнему углу блока на чистой суше";
    if (pendingMapAction.type === "greatWall") {
      const gwn = getGreatWallChargesClient();
      return `Великая стена: тап по своей клетке (не флаг). Осталось кирпичей: ${gwn}.`;
    }
    if (pendingMapAction.type === "baseRepair")
      return `Таргет · ремонт базы: тап только по своей базе — клетка флага (центр 6×6) или любая клетка своего плацдарма 2×2. +${BASE_REPAIR_HP_DELTA} HP, не выше max HP этой базы. ${PRICES_QUANT.baseRepair} кв. спишутся только после успешного применения (не мгновенная покупка).`;
    return "";
  })();
  /** Короткая строка в шапке — иначе длинный текст раздувает toolbar на пол-экрана */
  const short = (() => {
    if (!pendingMapAction) return "";
    if (pendingMapAction.type === "zoneCapture") return "4×4 · тап по карте";
    if (pendingMapAction.type === "massCapture") return "6×6 · тап по центру";
    if (pendingMapAction.type === "zone12Capture") return "12×12 · тап по центру";
    if (pendingMapAction.type === "nukeBomb") return "☢ бомба · ~12×12, край неровный · тап";
    if (pendingMapAction.type === "militaryBase") return "Плацдарм 2×2 · превью";
    if (pendingMapAction.type === "greatWall")
      return `Стена · осталось ${getGreatWallChargesClient()} · тап по клетке`;
    if (pendingMapAction.type === "baseRepair")
      return `🔧 Таргет · своя база · затем ${PRICES_QUANT.baseRepair} кв.`;
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
  syncQuickBuyRailMapPending();
}

/** Покупки с карты / магазина — на паузе сервер всё равно отклонит; не шлём лишнего. */
const WS_PAUSE_BLOCKED_TYPES = new Set([
  "purchasePersonalRecovery",
  "purchaseTeamRecovery",
  "purchaseZoneCapture",
  "purchaseMassCapture",
  "purchaseZone12Capture",
  "purchaseNukeBomb",
  "purchaseMilitaryBase",
  "purchaseGreatWall",
  "purchaseGreatWallCharge",
]);

function wsSendJson(obj) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  if (gamePausedMeta && obj && WS_PAUSE_BLOCKED_TYPES.has(obj.type)) return;
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
      const raw = ev.data;
      if (typeof raw === "string" && raw.length > MAX_WS_INCOMING_CHARS) return;
      msg = JSON.parse(typeof raw === "string" ? raw : String(raw));
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
      gamePausedMeta = false;
      pauseWallStartedAtMeta = 0;
      pauseUiFreezeWallMs = 0;
      playFinalVictorySfx();
      syncAdminGamePauseOverlay();
      lastMyTeamScoreShare = null;
      const gw = typeof msg.grid?.w === "number" ? msg.grid.w : 64;
      const gh = typeof msg.grid?.h === "number" ? msg.grid.h : 64;
      applyGridFromServer(gw, gh).then(() => {
        const tg = window.Telegram?.WebApp;
        const ws =
          typeof msg.winnerScore === "number" && Number.isFinite(msg.winnerScore)
            ? ` Счёт победителя: ${formatHudScore(msg.winnerScore)} оч.`
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
      if (msg.reason === "paused") {
        gamePausedMeta = true;
        pauseWallStartedAtMeta =
          typeof msg.pauseWallStartedAt === "number" && !Number.isNaN(msg.pauseWallStartedAt)
            ? clampWsEpochMs(msg.pauseWallStartedAt)
            : pauseWallStartedAtMeta;
        pauseCapturedWarmupMeta =
          gamePausedMeta && typeof msg.pauseCapturedWarmup === "boolean"
            ? !!msg.pauseCapturedWarmup
            : pauseCapturedWarmupMeta;
        reconcilePausedUiFreezeClock();
        syncAdminGamePauseOverlay();
        updateRoundTimer();
        syncTournamentWarmupOverlay();
        notifyReject("paused");
        if (createTeamOverlay && !createTeamOverlay.hidden) {
          setCreateTeamInlineError("Игра на паузе (администратор). Создание команды временно недоступно.");
        }
        setFooterMode();
        return;
      }
      if (msg.reason === "spectator" || msg.reason === "not_eligible") spectatorMode = true;
      notifyReject(
        msg.reason === "spectator" || msg.reason === "not_eligible"
          ? msg.reason
          : msg.reason || ""
      );
      setCreateTeamInlineErrorIfOverlayOpenForPlayReject(msg.reason);
      setFooterMode();
      return;
    }

    if (msg.type === "gamePauseSync") {
      gamePausedMeta = !!msg.paused;
      if (!gamePausedMeta) {
        pauseWallStartedAtMeta = 0;
      } else {
        const pw =
          typeof msg.pauseWallStartedAt === "number" && !Number.isNaN(msg.pauseWallStartedAt)
            ? clampWsEpochMs(msg.pauseWallStartedAt)
            : 0;
        if (pw > 0) pauseWallStartedAtMeta = pw;
      }
      pauseCapturedWarmupMeta =
        gamePausedMeta && typeof msg.pauseCapturedWarmup === "boolean" ? !!msg.pauseCapturedWarmup : false;
      reconcilePausedUiFreezeClock();
      /* Один пакет с актуальными таймстампами — без гонки с отдельным tournamentTimeScale после unpause. */
      if ("roundEndsAt" in msg) {
        roundEndsAtMs =
          msg.roundEndsAt == null || Number.isNaN(Number(msg.roundEndsAt))
            ? null
            : Number(msg.roundEndsAt);
      }
      const psRaw = msg.playStartsAt ?? msg.warmupEndsAt;
      if (typeof psRaw === "number" && !Number.isNaN(psRaw)) {
        playStartsAtMs = psRaw;
      }
      syncAdminGamePauseOverlay();
      updateRoundTimer();
      syncTournamentWarmupOverlay();
      syncBackgroundMusicAllowed();
      syncClientCooldownFromWalletFields();
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
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
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
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
      if (
        msg.phase === "start" &&
        String(msg.eventType || "") === "alt_season_revenge" &&
        typeof msg.untilMs === "number" &&
        Number.isFinite(msg.untilMs) &&
        Number(msg.untilMs) > 0
      ) {
        setMstimAltSeasonClientBurstUntilMs(msg.untilMs);
      }
      notifyRoundEventFromServer(msg);
      syncClientCooldownFromWalletFields();
      syncEventBanner();
      syncTeamBuffBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "serverAnnouncement") {
      const dur =
        typeof msg.durationMs === "number" && !Number.isNaN(msg.durationMs) && msg.durationMs > 0
          ? msg.durationMs
          : 5000;
      showServerAnnouncementBanner(msg.text, dur);
      return;
    }
    if (msg.type === "globalEvent") {
      if (msg.globalEvent && typeof msg.globalEvent === "object") {
        const altG = Number(msg.globalEvent.altSeasonRevengeUntilMs) || 0;
        if (altG > Date.now()) {
          setMstimAltSeasonClientBurstUntilMs(Math.max(altG, getMstimAltSeasonClientBurstUntilStored()));
        }
        if (walletState) walletState.globalEvent = msg.globalEvent;
        lastStatsGlobalEvent = msg.globalEvent;
        syncClientCooldownFromWalletFields();
      }
      syncEventBanner();
      syncTeamBuffBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "mstimAltSeasonSync") {
      const u = Number(msg.untilMs) || 0;
      const until = u > 0 ? u : 0;
      setMstimAltSeasonClientBurstUntilMs(until);
      const patch = { altSeasonRevengeUntilMs: until };
      if (walletState) {
        walletState.globalEvent = { ...(walletState.globalEvent || {}), ...patch };
      }
      lastStatsGlobalEvent = { ...(lastStatsGlobalEvent || {}), ...patch };
      syncClientCooldownFromWalletFields();
      syncEventBanner();
      syncTeamBuffBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "seismicPreview") {
      let impactAtMs = typeof msg.impactAtMs === "number" ? msg.impactAtMs : 0;
      if (!impactAtMs || impactAtMs <= Date.now()) {
        impactAtMs = Date.now() + SEISMIC_WARNING_BANNER_MS;
      }
      seismicPreviewClient = {
        eventId: typeof msg.eventId === "string" ? msg.eventId : "",
        regions: Array.isArray(msg.regions) ? msg.regions : [],
        impactAtMs,
      };
      const leadMs = Math.min(
        Math.max(impactAtMs - Date.now(), 400),
        BANNER_MAX_VISIBLE_MS
      );
      startBoardSeismicPreviewShake(Math.max(leadMs, 800));
      showSeismicWarningBanner(
        "Землетрясение",
        "Часть захваченных клеток в зонах удара исчезнет.",
        Math.min(leadMs + 200, BANNER_MAX_VISIBLE_MS)
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
      {
        const sp = spatialCentroidFromCells(cells, 0.9);
        playSeismicImpactSfx(sp);
        scheduleSeismicAftermathSfx(sp);
      }
      applySeismicTremorBodyOverride();
      syncEventBanner();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "nukeBombImpact") {
      const cells = Array.isArray(msg.cells) ? msg.cells : [];
      for (let i = 0; i < cells.length; i++) {
        const p = cells[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        pixels.delete(`${p[0] | 0},${p[1] | 0}`);
      }
      const ecx = typeof msg.cx === "number" && Number.isFinite(msg.cx) ? msg.cx | 0 : NaN;
      const ecy = typeof msg.cy === "number" && Number.isFinite(msg.cy) ? msg.cy | 0 : NaN;
      if (Number.isFinite(ecx) && Number.isFinite(ecy)) {
        playNukeExplosionSfx(ecx, ecy);
        applyNukeAftermathFromEpicenter(ecx, ecy);
      } else {
        playBombExplosion();
      }
      seismicAfterglowTremorUntilMs = Math.max(seismicAfterglowTremorUntilMs, Date.now() + 2800);
      applySeismicTremorBodyOverride();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagCaptureProgress") {
      const did = msg.defenderTeamId | 0;
      const slotKey = clientFlagKeyFromServerMsg(msg);
      if (msg.reset) {
        flagCaptureClientState.delete(slotKey);
      } else {
        const maxHp = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
        const hp =
          typeof msg.hp === "number"
            ? msg.hp | 0
            : Math.max(0, maxHp - (msg.progress | 0));
        if (hp >= maxHp) flagCaptureClientState.delete(slotKey);
        else {
          const prev = flagCaptureClientState.get(slotKey);
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
          flagCaptureClientState.set(slotKey, row);
          if (!msg.regen && !msg.repair && teamsMeta && boardVfx) {
            let fgx = NaN;
            let fgy = NaN;
            if (
              msg.militaryAnchor &&
              typeof msg.militaryAnchor.x0 === "number" &&
              typeof msg.militaryAnchor.y0 === "number"
            ) {
              const a = flagCellFromMilitaryOutpost(msg.militaryAnchor.x0 | 0, msg.militaryAnchor.y0 | 0);
              /* Эпицентр VFX — центр блока 2×2 (якорь HP — левый верх). */
              fgx = a.x + MILITARY_OUTPOST_SIZE * 0.5;
              fgy = a.y + MILITARY_OUTPOST_SIZE * 0.5;
            } else {
              const def = teamsMeta.find((x) => (Number(x.id) | 0) === did);
              if (def?.spawn) {
                const a = flagCellFromSpawn(def.spawn.x0, def.spawn.y0, clientMainSpawnSideFromSpawn(def.spawn));
                fgx = a.x;
                fgy = a.y;
              }
            }
            if (Number.isFinite(fgx) && Number.isFinite(fgy)) {
              const aid = msg.attackerTeamId | 0;
              const col = aid ? teamColor(aid) : "#ffaa66";
              boardVfx.flagBaseHitImpact(fgx, fgy, col, getVfxTransform());
              flushBoardVfxFrame();
              /* У атакующей команды уже был playPixelPlace на тапе; «удар по базе» не дублировать
               * (иначе после плацдарма каждый удар по флагу врага звучит как тяжёлый стинг). */
              const iAmOnAttackingTeam = myTeamId != null && (aid | 0) === (myTeamId | 0);
              if (!iAmOnAttackingTeam) {
                playFlagBaseHit({
                  scope: /** @type {const} */ ("local"),
                  gx: fgx + 0.5,
                  gy: fgy + 0.5,
                  weight: 0.84,
                });
              }
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
      flagCaptureClientState.delete(clientFlagKeyFromServerMsg(msg));
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagUnderAttack") {
      if ((msg.defenderTeamId | 0) === (myTeamId | 0)) {
        myFlagUnderAttackUntil = Date.now() + 16_000;
        const mx = typeof msg.maxHp === "number" ? msg.maxHp | 0 : FLAG_BASE_MAX_HP;
        const h = typeof msg.hp === "number" ? msg.hp | 0 : mx - 1;
        playAlertBaseUnderAttack();
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
    if (msg.type === "militaryOutpostCaptured") {
      const aid = msg.attackerTeamId | 0;
      const did = msg.defenderTeamId | 0;
      const x0 = msg.x0 | 0;
      const y0 = msg.y0 | 0;
      flagCaptureClientState.delete(clientMilitaryFlagKey(did, x0, y0));
      const Mcap = MILITARY_OUTPOST_SIZE;
      for (let yy = y0; yy < y0 + Mcap; yy++) {
        for (let xx = x0; xx < x0 + Mcap; xx++) {
          pixels.set(`${xx},${yy}`, { teamId: aid, ownerPlayerKey: "", shieldedUntil: 0 });
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
      const an = teamsMeta?.find((x) => (Number(x.id) | 0) === aid)?.name || "атакующие";
      const dn = teamsMeta?.find((x) => (Number(x.id) | 0) === did)?.name || "защита";
      showPlacementFeedback(
        `Передовая база захвачена: плацдарм 2×2 у «${an}» (команда «${dn}» не выбыла).`,
        "warn",
        { telegramAlert: false }
      );
      if ((did | 0) === (myTeamId | 0)) {
        try {
          window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred?.("warning");
        } catch {
          /* ignore */
        }
      }
      scheduleDraw({ full: true });
      schedulePersist();
      return;
    }
    if (msg.type === "militaryOutpostRemoved") {
      const tid = msg.teamId | 0;
      const x0 = msg.x0 | 0;
      const y0 = msg.y0 | 0;
      flagCaptureClientState.delete(clientMilitaryFlagKey(tid, x0, y0));
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "flagCaptured") {
      const aid = msg.attackerTeamId | 0;
      const did = msg.defenderTeamId | 0;
      const wasMyDefeat = myTeamId != null && (myTeamId | 0) === did;
      const fullWipe = msg.fullTeamElimination !== false;
      deleteFlagCaptureStateForDefenderTeam(did);
      for (const [k, v] of [...pixels.entries()]) {
        const tid = typeof v === "number" ? v : v.teamId;
        if ((tid | 0) === did) {
          pixels.set(k, { teamId: aid, ownerPlayerKey: "", shieldedUntil: 0 });
        }
      }
      if (fullWipe) patchTeamsMetaDefenderEliminated(did);
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
        const defeatLine =
          typeof msg.defeatMessage === "string" && msg.defeatMessage.trim()
            ? msg.defeatMessage.trim()
            : undefined;
        applyMyTeamEliminatedClientState(canRe, defeatLine);
      }
      const an = teamsMeta?.find((x) => (Number(x.id) | 0) === aid)?.name || "attacker";
      const dn = teamsMeta?.find((x) => (Number(x.id) | 0) === did)?.name || "defender";
      enqueueBaseCapturedPresentation(String(an), String(dn));
      if (!wasMyDefeat) {
        triggerMapShake(1200);
        const victoryLine =
          typeof msg.victoryMessage === "string" && msg.victoryMessage.trim()
            ? msg.victoryMessage.trim()
            : "Enemy base captured. All enemy territory is now yours.";
        showFlagAlertBanner(victoryLine, 5200);
        showPlacementFeedback(victoryLine, "error", { telegramAlert: false });
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
        flagCaptureClientState.set(clientFlagKeyFromServerMsg(msg), {
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
      scheduleThrottledStatsUi(msg);
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
      refreshCreateTeamColorPaletteIfOverlayOpen();
      return;
    }
    if (msg.type === "teamsFull") {
      teamsMeta = msg.teams || [];
      baseConnCacheFrameId = -1;
      invalidateTeamColorByIdCache();
      const allowedKeys = new Set();
      for (const t of teamsMeta || []) {
        if (t.solo || t.eliminated) continue;
        const tid = Number(t.id) | 0;
        if (tid <= 0) continue;
        if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
          allowedKeys.add(clientMainFlagKey(tid));
        }
        const mos = clientMilitaryOutpostRects(tid);
        for (let mi = 0; mi < mos.length; mi++) {
          const o = mos[mi];
          allowedKeys.add(clientMilitaryFlagKey(tid, o.x0 | 0, o.y0 | 0));
        }
      }
      for (const k of [...flagCaptureClientState.keys()]) {
        if (!allowedKeys.has(k)) flagCaptureClientState.delete(k);
      }
      rebuildTeamList();
      updateTeamBadge();
      cacheTeamDisplayInSession();
      refreshCreateTeamColorPaletteIfOverlayOpen();
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "created") {
      endSessionRestore();
      teamsMeta = msg.teams || [];
      baseConnCacheFrameId = -1;
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
      lastMyTeamScoreShare = null;
      window.setTimeout(() => showReferralSplash(), TEAM_SPAWN_ONBOARD_MS);
      {
        const sp = msg.team?.spawn ?? getMyTeamSpawn();
        if (sp) scheduleFocusOnMyTeamSpawn(sp, true);
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
          setCreateTeamInlineError(text);
          showPlacementFeedback(text, "warn", { telegramAlert: false });
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
        } else {
          const tg = window.Telegram?.WebApp;
          const text =
            "Нет соединения с сервером. Закройте и откройте Mini App снова, затем повторите вход.";
          setCreateTeamInlineError(text);
          showPlacementFeedback(text, "error", { telegramAlert: false });
          if (typeof tg?.showAlert === "function") tg.showAlert(text);
        }
        return;
      }
      const map = {
        fields: "Укажите название и смайлик команды.",
        limit: "Достигнут лимит команд на сервере.",
        duel: "В дуэли нельзя вступить в чужую команду — создайте свою (один игрок).",
        spawn_failed:
          "Не удалось разместить стартовую базу на карте (мало места). Попробуйте позже или сообщите администратору.",
      };
      const text = map[msg.reason] || "Не удалось создать команду.";
      setCreateTeamInlineError(text);
      showPlacementFeedback(text, "error", { telegramAlert: false });
      const tg = window.Telegram?.WebApp;
      if (typeof tg?.showAlert === "function") tg.showAlert(text);
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
        if (sp) scheduleFocusOnMyTeamSpawn(sp, true);
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
            if (sp) scheduleFocusOnMyTeamSpawn(sp, true);
          }
        } catch {
          /* ignore */
        }
        return;
      }
      endSessionRestore();
      if (msg.reason === "paused") {
        showPlacementFeedback("Игра на паузе (админ). Вступление в команду недоступно.", "warn", {
          telegramAlert: false,
        });
        return;
      }
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
      hideRoundEndedOverlay();
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
      lastTeamDangerCellsRemaining = 999;
      const openTeamList = pendingLeaveToTeamList;
      const openCreate = pendingLeaveToCreate;
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      if (openCreate) {
        if (welcomeOverlay) welcomeOverlay.hidden = true;
        teamOverlay.hidden = true;
        openCreateTeamOverlay(true);
      } else if (openTeamList) {
        closeCreateTeamOverlay();
        if (welcomeOverlay) welcomeOverlay.hidden = true;
        hideRoundEndedOverlay();
        teamOverlay.hidden = false;
      } else {
        closeCreateTeamOverlay();
        showWelcomeOverlay();
        teamOverlay.hidden = true;
      }
      closeTeamSettings();
      hideReferralSplash();
      rebuildTeamList();
      setFooterMode();
      schedulePersist();
      return;
    }
    if (msg.type === "leaveError") {
      if (msg.reason === "paused") {
        showPlacementFeedback("Игра на паузе (админ). Выход из команды недоступен.", "warn", {
          telegramAlert: false,
        });
      }
      const hadPendingIntent = pendingLeaveToTeamList || pendingLeaveToCreate;
      pendingLeaveToTeamList = false;
      pendingLeaveToCreate = false;
      if (hadPendingIntent && welcomeOverlay) welcomeOverlay.hidden = false;
      return;
    }
    if (msg.type === "teamEliminated") {
      tryPlayTeamEliminationVfx(msg);
      const tid = msg.teamId | 0;
      patchTeamsMetaDefenderEliminated(tid);
      if (myTeamId != null && (myTeamId | 0) === tid) {
        const defLine =
          typeof msg.defeatMessage === "string" && msg.defeatMessage.trim()
            ? msg.defeatMessage.trim()
            : undefined;
        applyMyTeamEliminatedClientState(msg.canReenter === true, defLine);
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
        /* Не фильтруем по isClientWaterCell: плакат/regions для 320/160/64 может расходиться с playableGrid
         * сервера — иначе база 6×6 не попадает в pixels, клиент думает «нет соседей» (not_adjacent). */
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
        if (msg.pixelFormat === "v2" && p.length >= 5) {
          const [, , t, , sh] = p;
          const wh = p.length >= 6 ? normalizeWallHp(p[5]) : 0;
          /** @type {{ teamId: number, shieldedUntil: number, wallHp?: number }} */
          const o = { teamId: t, shieldedUntil: sh || 0 };
          if (wh > 0) o.wallHp = wh;
          pixels.set(`${x},${y}`, o);
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
        /* После обрыва: meta мог прийти с устаревшим eligible до clientProfile — повторяем claim и join. */
        requestAnimationFrame(() => {
          if (!ws || ws.readyState !== WebSocket.OPEN) return;
          tryClaimEligibility();
          const sess = loadOnlineSession();
          if (!sess?.solo && sess?.teamId != null && !spectatorMode) tryRestoreSession();
        });
      }
      return;
    }
    if (msg.type === "pixelBatch") {
      const fmt = msg.pixelFormat === "v2" ? "v2" : "v1";
      const list = Array.isArray(msg.cells) ? msg.cells : [];
      const allowBatchVfx =
        list.length <= PIXEL_BATCH_VFX_MAX_CELLS && !clientPrefersReducedMotion();
      /** @type {{ gx0: number, gy0: number, gx1: number, gy1: number } | null} */
      let dr = null;
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!Array.isArray(row) || row.length < 3) continue;
        any = true;
        const x = row[0] | 0;
        const y = row[1] | 0;
        const t = row[2];
        const newSh = fmt === "v2" && row.length >= 5 ? Number(row[4]) || 0 : 0;
        const wallHp = fmt === "v2" && row.length >= 6 ? normalizeWallHp(row[5]) : 0;
        const pk = `${x},${y}`;
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) {
          pixels.delete(pk);
          if (optimisticPixelPending?.key === pk) optimisticPixelPending = null;
          dr = mergeDirtyRects(dr, { gx0: x, gy0: y, gx1: x, gy1: y });
          continue;
        }
        if (wantOnline && clientShouldIgnoreTerritoryPixelOnEnemyFlagAnchor(x, y, t | 0)) {
          dr = mergeDirtyRects(dr, { gx0: x, gy0: y, gx1: x, gy1: y });
          continue;
        }
        const skipOwnPop =
          optimisticPixelPending && optimisticPixelPending.key === pk && t === myTeamId;
        if (optimisticPixelPending && optimisticPixelPending.key === pk) {
          optimisticPixelPending = null;
        }
        const prev = pixels.get(pk);
        const prevSh = typeof prev === "object" && prev ? prev.shieldedUntil || 0 : 0;
        /** @type {{ teamId: number, shieldedUntil: number, wallHp?: number }} */
        const cellRec = { teamId: t, shieldedUntil: newSh };
        if (wallHp > 0) cellRec.wallHp = wallHp;
        pixels.set(pk, cellRec);
        const tr = getVfxTransform();
        const col = teamColor(t);
        if (boardVfx && allowBatchVfx) {
          if (!skipOwnPop) {
            boardVfx.popPixel(x, y, col, tr);
          }
          if (newSh > Date.now() && newSh > prevSh) {
            boardVfx.shieldBurst(x, y, col, tr);
          }
        }
        dr = mergeDirtyRects(dr, { gx0: x, gy0: y, gx1: x, gy1: y });
      }
      if (any) {
        if (dr) scheduleDraw({ dirty: dr });
        else scheduleDraw();
        schedulePersist();
        syncToolbarQuantumObjective();
        refreshPassiveIncomeDisplays();
      }
      return;
    }
    if (msg.type === "pixel") {
      const x = msg.x | 0;
      const y = msg.y | 0;
      const pk = `${x},${y}`;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) {
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
      if (boardVfx && !clientPrefersReducedMotion()) {
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
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
      return;
    }
    if (msg.type === "wallet") {
      applyWalletFromServer(msg);
      return;
    }
    if (msg.type === "quantumFarmsInit") {
      mergeQuantumFarmsFromServerPayload(Array.isArray(msg.farms) ? msg.farms : []);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "quantumFarmNotice") {
      const tid = msg.teamId | 0;
      if (!myTeamId || (tid | 0) !== (myTeamId | 0)) return;
      const kind = typeof msg.kind === "string" ? msg.kind : "";
      if (kind === "connected") {
        playQuantumConnect();
        showPlacementFeedback(
          "Квантовая ферма под контролем: доход зависит от уровня (до +4 кв. / 5 с), тап по ферме — улучшение.",
          "ok",
          { telegramAlert: false }
        );
      } else if (kind === "disconnected") {
        playQuantumDisconnect();
        showPlacementFeedback(
          "Квантовая ферма потеряна — пассивный доход с этой точки остановлен.",
          "warn",
          { telegramAlert: false }
        );
      } else if (kind === "lost") {
        playQuantumDisconnect();
        showPlacementFeedback("Враг перехватил вашу квантовую ферму.", "warn", { telegramAlert: false });
      } else if (kind === "captured_from") {
        playQuantumConnect();
        showPlacementFeedback("Ваша команда захватила квантовую ферму.", "ok", {
          telegramAlert: false,
        });
      }
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
      return;
    }
    if (msg.type === "quantFarmIncomePulse") {
      const tid = msg.teamId | 0;
      if (!myTeamId || (tid | 0) !== (myTeamId | 0)) return;
      const q = typeof msg.quants === "number" && Number.isFinite(msg.quants) ? msg.quants | 0 : 0;
      playQuantumFarmIncomeClientFx(q, {
        farmQuants: typeof msg.farmQuants === "number" ? msg.farmQuants : undefined,
        eventZoneQuants: typeof msg.eventZoneQuants === "number" ? msg.eventZoneQuants : undefined,
      });
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
      return;
    }
    if (msg.type === "treasureClaimed") {
      const k = typeof msg.key === "string" ? msg.key.trim() : "";
      if (k) treasureSpotKeys.delete(k);
      scheduleDraw({ full: true });
      return;
    }
    if (msg.type === "treasureFound") {
      const q = typeof msg.quant === "number" ? msg.quant | 0 : 0;
      if (q > 0) showTreasureFoundOverlay(q);
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
      if (optimisticGreatWallPending) {
        const { key: gwk, prev: gwp } = optimisticGreatWallPending;
        optimisticGreatWallPending = null;
        if (gwp === undefined) pixels.delete(gwk);
        else pixels.set(gwk, gwp);
      }
      const pur = typeof msg.reason === "string" ? msg.reason : "";
      const keepQuantumFarmPanelOpen =
        quantumFarmPanelEl &&
        !quantumFarmPanelEl.hidden &&
        (pur === "quantum_farm_not_controlled" ||
          pur === "quantum_farm_no_supply" ||
          pur === "quantum_farm_max_level" ||
          pur === "not enough balance");
      if (!keepQuantumFarmPanelOpen) closeQuantumFarmPanel();
      if (pur === "no_wall_charges") {
        pendingMapAction = null;
        setPendingHint();
      }
      const wk = optimisticWeaponPending?.blastKeys ?? optimisticWeaponPending?.keys;
      revertOptimisticWeapon();
      notifyPurchaseError(pur);
      if (keepQuantumFarmPanelOpen && quantumFarmPanelAnchorFarmId != null) {
        const f = quantumFarmsMeta.find((x) => (x.id | 0) === (quantumFarmPanelAnchorFarmId | 0));
        if (f) openQuantumFarmPanel(f);
      }
      const dr = wk && wk.length ? dirtyRectFromKeys(wk) : null;
      scheduleDraw(dr ? { dirty: dr } : undefined);
      return;
    }
    if (msg.type === "teamEffect") {
      if (walletState && (msg.teamId | 0) === (myTeamId | 0)) {
        if (!walletState.teamEffects) {
          walletState.teamEffects = {
            teamId: msg.teamId | 0,
            teamRecoveryUntil: 0,
            teamRecoverySec: BASE_ACTION_COOLDOWN_SEC,
          };
        }
        const te = walletState.teamEffects;
        te.teamId = msg.teamId | 0;
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
      lastTeamDangerCellsRemaining = n;
      if (n <= 6) playAlertLastCells();
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
      lastTeamDangerCellsRemaining = 1;
      playAlertLastCell();
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
        scheduleFocusOnMyTeamSpawn(sp, true);
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
      syncToolbarQuantumObjective();
      refreshPassiveIncomeDisplays();
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
      const r = typeof msg.reason === "string" ? msg.reason : "";
      const cooldownRej = r === "cooldown" || r === "cooldown not ready";
      if (cooldownRej) {
        /* Иначе lastPlaceAt от неудачного клика сдвигает «готово» дальше серверного lastActionAt — баффы кажутся медленнее. */
        const srv = Number(walletState?.lastActionAt) || 0;
        lastPlaceAt = Number.isFinite(srv) && srv > 0 ? srv : 0;
      } else {
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
    /* Не сбрасывать teamsMeta: при кратком обрыве иначе «вылет» из команд до прихода meta. */
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
  if (wantOnline && gamePausedMeta) return;
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
  const o = { teamId: v.teamId, shieldedUntil: Number(v.shieldedUntil) || 0 };
  const wh = normalizeWallHp(v.wallHp);
  if (wh > 0) o.wallHp = wh;
  return o;
}

/** @type {{ key: string, prev: ReturnType<typeof snapshotPixelCell> } | null} */
let optimisticGreatWallPending = null;

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
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    if (tid === aid) continue;
    if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0, clientMainSpawnSideFromSpawn(t.spawn));
      if (fx === gx && fy === gy) {
        const owner = clientPixelOwnerTeamAt(gx, gy);
        return owner === tid;
      }
    }
    const mos = clientMilitaryOutpostRects(tid);
    for (let mi = 0; mi < mos.length; mi++) {
      const r = mos[mi];
      if (!clientCellInsideSpawnRect(gx, gy, r)) continue;
      const owner = clientPixelOwnerTeamAt(gx, gy);
      return owner === tid;
    }
  }
  return false;
}

/** Якорь флага любой команды (клетка флага главной или плацдарма) — нельзя ставить Великую стену. */
function clientCellIsAnyFlagAnchor(gx, gy) {
  if (!teamsMeta) return false;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated) continue;
    if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0, clientMainSpawnSideFromSpawn(t.spawn));
      if (fx === gx && fy === gy) return true;
    }
    const mos = clientMilitaryOutpostRects(t.id | 0);
    for (let mi = 0; mi < mos.length; mi++) {
      const r = mos[mi];
      if (clientCellInsideSpawnRect(gx, gy, r)) return true;
    }
  }
  return false;
}

/** Клетка флага своей главной базы или любая клетка своего плацдарма 2×2 — цель «Ремонт базы». */
function clientCellIsOwnRepairableBase(gx, gy) {
  if (myTeamId == null || teamsMeta == null) return false;
  const mid = myTeamId | 0;
  const t = teamsMeta.find((x) => !x.solo && !x.eliminated && (x.id | 0) === mid);
  if (!t) return false;
  const xi = gx | 0;
  const yi = gy | 0;
  if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
    const fc = flagCellFromSpawn(t.spawn.x0, t.spawn.y0, clientMainSpawnSideFromSpawn(t.spawn));
    if (fc.x === xi && fc.y === yi) return true;
  }
  const mos = clientMilitaryOutpostRects(mid);
  for (let mi = 0; mi < mos.length; mi++) {
    if (clientCellInsideSpawnRect(xi, yi, mos[mi])) return true;
  }
  return false;
}

/** Координаты якоря флага любой чужой (не своя команда) базы — для отдельной ветки атаки, без оптимистичной покраски. */
function clientIsEnemyBaseFlagCellCoords(gx, gy) {
  if (myTeamId == null || teamsMeta == null) return false;
  const mid = myTeamId | 0;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    if (tid === mid) continue;
    if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0, clientMainSpawnSideFromSpawn(t.spawn));
      if (fx === gx && fy === gy) return true;
    }
    const mos = clientMilitaryOutpostRects(tid);
    for (let mi = 0; mi < mos.length; mi++) {
      const r = mos[mi];
      if (clientCellInsideSpawnRect(gx, gy, r)) return true;
    }
  }
  return false;
}

/**
 * Сообщение `pixel` не должно перекрашивать якорь активной базы «чужим» teamId:
 * HP — через flagCaptureProgress / flagHitAck; главная — flagCaptured; FOB — militaryOutpostCaptured.
 */
function clientShouldIgnoreTerritoryPixelOnEnemyFlagAnchor(x, y, newTeamId) {
  if (teamsMeta == null) return false;
  const nid = newTeamId | 0;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const { x: fx, y: fy } = flagCellFromSpawn(t.spawn.x0, t.spawn.y0, clientMainSpawnSideFromSpawn(t.spawn));
      if (fx === x && fy === y) return tid !== nid;
    }
    const mos = clientMilitaryOutpostRects(tid);
    for (let mi = 0; mi < mos.length; mi++) {
      const r = mos[mi];
      if (clientCellInsideSpawnRect(x, y, r)) return tid !== nid;
    }
  }
  return false;
}

/** Кратер бомбы на клиенте: суша в форме не вырезается (защита баз — в логике очистки / сервере). */
function clientNoNukeBlastHoleExclusion(_gx, _gy) {
  return false;
}

function clientCellNukeProtectedSpawn(gx, gy) {
  if (!teamsMeta) return false;
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated || !t.spawn) continue;
    const x0 = t.spawn.x0 | 0;
    const y0 = t.spawn.y0 | 0;
    const sw = clientMainSpawnSideFromSpawn(t.spawn);
    if (gx >= x0 && gx < x0 + sw && gy >= y0 && gy < y0 + sw) return true;
    for (const r of clientMilitaryOutpostRects(t.id)) {
      const rx0 = r.x0 | 0;
      const ry0 = r.y0 | 0;
      const rw = r.w | 0;
      const rh = r.h | 0;
      if (gx >= rx0 && gx < rx0 + rw && gy >= ry0 && gy < ry0 + rh) return true;
    }
  }
  return false;
}

function clientSpawnRectsConflict(x0, y0, ox0, oy0) {
  const g = CLIENT_SPAWN_RECT_GAP;
  const S = FLAG_SPAWN_SIZE;
  const ax0 = x0 - g;
  const ay0 = y0 - g;
  const ax1 = x0 + S + g - 1;
  const ay1 = y0 + S + g - 1;
  const bx0 = ox0 - g;
  const by0 = oy0 - g;
  const bx1 = ox0 + S + g - 1;
  const by1 = oy0 + S + g - 1;
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
}

function clientRectChebyshevEdgeGap(x0, y0, w, h, ox0, oy0, ow, oh) {
  const dx = Math.max(0, Math.max(ox0 - (x0 + w), x0 - (ox0 + ow)));
  const dy = Math.max(0, Math.max(oy0 - (y0 + h), y0 - (oy0 + oh)));
  return Math.max(dx, dy);
}

function clientAllSpawnLikeRectsForMilitaryPreview() {
  if (!teamsMeta) return [];
  /** @type {{ x0: number, y0: number, w: number, h: number }[]} */
  const out = [];
  for (const t of teamsMeta) {
    if (t.solo || t.eliminated) continue;
    if (t.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const sp = t.spawn;
      const w = typeof sp.w === "number" ? sp.w | 0 : FLAG_SPAWN_SIZE;
      const h = typeof sp.h === "number" ? sp.h | 0 : FLAG_SPAWN_SIZE;
      out.push({ x0: sp.x0 | 0, y0: sp.y0 | 0, w, h });
    }
    for (const r of clientMilitaryOutpostRects(t.id)) {
      out.push({ x0: r.x0, y0: r.y0, w: r.w | 0, h: r.h | 0 });
    }
  }
  return out;
}

function clientSpawnRectsConflictSized(ax0, ay0, aw, ah, bx0, by0, bw, bh) {
  const g = CLIENT_SPAWN_RECT_GAP;
  const aL = ax0 - g;
  const aT = ay0 - g;
  const aR = ax0 + aw + g - 1;
  const aB = ay0 + ah + g - 1;
  const bL = bx0 - g;
  const bT = by0 - g;
  const bR = bx0 + bw + g - 1;
  const bB = by0 + bh + g - 1;
  return !(aR < bL || bR < aL || aB < bT || bB < aT);
}

/**
 * Клиентская проверка плацдарма 2×2 для превью (клик = левый верх блока).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateClientMilitaryBasePreview(cx, cy) {
  if (myTeamId == null) return { ok: false, reason: "no_team" };
  const tid = myTeamId | 0;
  const x0 = cx | 0;
  const y0 = cy | 0;
  const S = MILITARY_OUTPOST_SIZE;
  if (x0 < 0 || y0 < 0 || x0 + S > gridW || y0 + S > gridH) {
    return { ok: false, reason: "military_bounds" };
  }
  for (let y = y0; y < y0 + S; y++) {
    for (let x = x0; x < x0 + S; x++) {
      if (!isClientPlayableCell(x, y)) return { ok: false, reason: "military_water" };
      if (pixels.has(`${x},${y}`)) return { ok: false, reason: "military_occupied" };
    }
  }
  const reserved = clientAllSpawnLikeRectsForMilitaryPreview();
  for (let i = 0; i < reserved.length; i++) {
    const o = reserved[i];
    if (clientSpawnRectsConflictSized(x0, y0, S, S, o.x0, o.y0, o.w, o.h)) {
      return { ok: false, reason: "military_conflict" };
    }
  }
  const mySpawn = clientTeamSpawnRect(tid);
  if (mySpawn) {
    const g0 = clientRectChebyshevEdgeGap(x0, y0, S, S, mySpawn.x0, mySpawn.y0, mySpawn.w, mySpawn.h);
    if (g0 < CLIENT_MILITARY_GAP_OWN_MAIN) return { ok: false, reason: "military_too_close_own_main" };
  }
  if (teamsMeta) {
    for (const t of teamsMeta) {
      if (t.solo || t.eliminated) continue;
      if ((t.id | 0) === tid) continue;
      const sp = t.spawn;
      if (!sp || typeof sp.x0 !== "number" || typeof sp.y0 !== "number") continue;
      const w = typeof sp.w === "number" ? sp.w : FLAG_SPAWN_SIZE;
      const h = typeof sp.h === "number" ? sp.h : FLAG_SPAWN_SIZE;
      const g1 = clientRectChebyshevEdgeGap(x0, y0, S, S, sp.x0 | 0, sp.y0 | 0, w, h);
      if (g1 < CLIENT_MILITARY_GAP_ENEMY_MAIN) return { ok: false, reason: "military_too_close_enemy_main" };
    }
  }
  return { ok: true };
}

/** Ключи клеток в зоне бомбы — тот же алгоритм, что на сервере. */
function planClientNukeBombKeys(cx, cy) {
  const pairs = computeNukeBombBlastCells(
    cx | 0,
    cy | 0,
    roundIndexMeta,
    gridW,
    gridH,
    isClientPlayableCell,
    clientNoNukeBlastHoleExclusion
  );
  return pairs.map(([x, y]) => `${x},${y}`);
}

function applyOptimisticNukeBomb(cx, cy) {
  if (myTeamId == null) return false;
  const blastKeys = planClientNukeBombKeys(cx, cy);
  if (blastKeys.length === 0) {
    notifyReject("water");
    return false;
  }
  revertOptimisticWeapon();
  const prev = new Map();
  /** @type {string[]} */
  const touchedKeys = [];
  for (const k of blastKeys) {
    const [px, py] = k.split(",").map(Number);
    if (clientCellNukeProtectedSpawn(px, py)) continue;
    const cell = snapshotPixelCell(k);
    if (cell === undefined) continue;
    const tid = typeof cell === "number" ? cell | 0 : Number(cell.teamId) | 0;
    if (tid === 0) continue;
    if (tid === (myTeamId | 0)) continue;
    const wh = typeof cell === "object" && cell ? normalizeWallHp(cell.wallHp) : 0;
    const sh = typeof cell === "object" && cell ? Number(cell.shieldedUntil) || 0 : 0;
    prev.set(k, cell);
    touchedKeys.push(k);
    if (wh > 0) {
      const nextHp = wh - 1;
      if (nextHp > 0) {
        pixels.set(k, { teamId: tid, shieldedUntil: sh, wallHp: nextHp });
      } else {
        pixels.delete(k);
      }
    } else {
      pixels.delete(k);
    }
  }
  if (touchedKeys.length === 0) {
    if (!clientNukeBlastWouldClearTerritory(cx | 0, cy | 0)) {
      notifyReject("nuke_no_effect");
      return false;
    }
    return true;
  }
  optimisticWeaponPending = {
    kind: "nukeBomb",
    gx: cx | 0,
    gy: cy | 0,
    size: 14,
    keys: touchedKeys,
    blastKeys,
    prev,
  };
  const dr = dirtyRectFromKeys(blastKeys.length ? blastKeys : touchedKeys);
  scheduleDraw(dr ? { dirty: dr } : { full: true });
  return true;
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
  const myT = myTeamId | 0;
  for (const k of paintKeys) {
    const prevSnap = snapshotPixelCell(k);
    prev.set(k, prevSnap);
    if (prevSnap === undefined) {
      pixels.set(k, { teamId: myTeamId, shieldedUntil: 0 });
      continue;
    }
    const prevTid = typeof prevSnap === "number" ? prevSnap | 0 : prevSnap.teamId | 0;
    const wh =
      typeof prevSnap === "object" && prevSnap && prevSnap.wallHp != null
        ? normalizeWallHp(prevSnap.wallHp)
        : 0;
    const sh = typeof prevSnap === "object" && prevSnap ? Number(prevSnap.shieldedUntil) || 0 : 0;
    if (prevTid === myT) {
      if (wh > 0) {
        pixels.set(k, { teamId: myTeamId, shieldedUntil: sh, wallHp: wh });
      } else {
        pixels.set(k, { teamId: myTeamId, shieldedUntil: 0 });
      }
      continue;
    }
    if (prevTid !== 0 && wh > 0) {
      const nextHp = wh - 1;
      if (nextHp > 0) {
        pixels.set(k, { teamId: prevTid, shieldedUntil: sh, wallHp: nextHp });
      } else {
        pixels.set(k, { teamId: myTeamId, shieldedUntil: 0 });
      }
      continue;
    }
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
  if (msg.kind === "nukeBomb") {
    optimisticWeaponPending = null;
    return true;
  }
  const sz = typeof msg.size === "number" && Number.isFinite(msg.size) ? msg.size | 0 : 0;
  if (sz !== o.size) return false;
  optimisticWeaponPending = null;
  return true;
}

/**
 * Метка клада на карте: сундук по центру клетки, без анимации (хорошо читается при любом зуме).
 */
function drawMapTreasureChestIcon(ctx, px, py, cw, ch) {
  const s = Math.min(cw, ch);
  if (s < 2) return;
  const scale = Math.min(s * 0.68, Math.max(s - 1, 6));
  const cx = px + cw * 0.5;
  const cy = py + ch * 0.5;
  ctx.save();
  ctx.translate(cx, cy);
  const bw = scale * 0.4;
  const bh = scale * 0.28;
  const lw = Math.max(1, scale * 0.075);
  ctx.lineJoin = "round";
  ctx.lineCap = "round";

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  ctx.beginPath();
  ctx.ellipse(0, bh * 1.05, bw * 1.15, scale * 0.09, 0, 0, Math.PI * 2);
  ctx.fill();

  ctx.beginPath();
  ctx.moveTo(-bw * 1.1, -bh * 0.22);
  ctx.lineTo(-bw * 0.68, -bh * 1.12);
  ctx.lineTo(bw * 0.68, -bh * 1.12);
  ctx.lineTo(bw * 1.1, -bh * 0.22);
  ctx.closePath();
  ctx.fillStyle = "#edc843";
  ctx.strokeStyle = "#3d2a0a";
  ctx.lineWidth = lw;
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.rect(-bw * 1.1, -bh * 0.22, bw * 2.2, bh * 1.4);
  ctx.fillStyle = "#cfa21a";
  ctx.fill();
  ctx.stroke();

  ctx.beginPath();
  ctx.moveTo(0, -bh * 0.22);
  ctx.lineTo(0, bh * 1.18);
  ctx.strokeStyle = "#3d2a0a";
  ctx.lineWidth = lw * 0.95;
  ctx.stroke();

  const lkW = scale * 0.22;
  const lkH = bh * 0.58;
  ctx.fillStyle = "#fff7dc";
  ctx.strokeStyle = "#3d2a0a";
  ctx.lineWidth = lw * 0.65;
  ctx.beginPath();
  ctx.rect(-lkW * 0.5, bh * 0.08, lkW, lkH);
  ctx.fill();
  ctx.stroke();

  ctx.fillStyle = "#3d2a0a";
  ctx.beginPath();
  ctx.arc(0, bh * 0.28, Math.max(1.2, scale * 0.055), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

/**
 * Великая стена: псевдо-объём, тень, камень/металл; трещины по HP (3→чисто, 2→скол, 1→разрушение).
 */
function drawGreatWallStoneDecor(ctx, px, py, cw, ch, teamHex, wallHp, time) {
  const wh = wallHp | 0;
  if (wh < 1 || wh > GREAT_WALL_MAX_HP) return;
  const { r, g, b } = hexToRgb(teamHex);
  const pulse = 0.5 + 0.5 * Math.sin(time * 0.0031);
  const lift = Math.max(1, Math.min(7, ch * 0.14));
  const pad = Math.max(0.5, cw * 0.028);
  const stress = (GREAT_WALL_MAX_HP - wh) / GREAT_WALL_MAX_HP;
  const faceX = px + pad;
  const faceY = py + pad - lift * 0.55;
  const faceW = cw - pad * 2;
  const faceH = ch - pad * 2 + lift * 0.45;
  const capH = Math.max(2, lift * 0.85);

  ctx.save();
  ctx.lineJoin = "miter";
  ctx.lineCap = "butt";

  /* Мягкая тень под «блоком» — ощущение веса и высоты */
  const shGrad = ctx.createRadialGradient(
    px + cw * 0.5,
    py + ch * 0.94,
    cw * 0.06,
    px + cw * 0.5,
    py + ch * 0.94,
    cw * 0.58
  );
  shGrad.addColorStop(0, `rgba(0,0,0,${0.38 + stress * 0.12})`);
  shGrad.addColorStop(0.55, `rgba(0,0,0,${0.12 + stress * 0.06})`);
  shGrad.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = shGrad;
  ctx.beginPath();
  ctx.ellipse(px + cw * 0.5, py + ch * 0.93, cw * 0.46, ch * 0.16, 0, 0, Math.PI * 2);
  ctx.fill();

  /* Боковая грань (тёмнее) — глубина */
  const sideW = Math.max(1.5, cw * 0.07);
  ctx.fillStyle = `rgba(${Math.max(0, r - 70)},${Math.max(0, g - 70)},${Math.max(0, b - 70)},0.55)`;
  ctx.beginPath();
  ctx.moveTo(px + cw - pad, py + ch - pad);
  ctx.lineTo(px + cw - pad + sideW * 0.35, py + ch - pad + lift * 0.25);
  ctx.lineTo(px + cw - pad + sideW * 0.35, faceY + faceH);
  ctx.lineTo(px + cw - pad, py + ch - pad);
  ctx.fill();

  /* Основная грань: камень + лёгкий оттенок команды (не «плоский пиксель») */
  const faceGrad = ctx.createLinearGradient(faceX, faceY, faceX + faceW, faceY + faceH);
  faceGrad.addColorStop(0, `rgba(210, 200, 188, ${0.92 - stress * 0.08})`);
  faceGrad.addColorStop(0.35, `rgba(${Math.min(255, r + 40)},${Math.min(255, g + 35)},${Math.min(255, b + 30)},0.42)`);
  faceGrad.addColorStop(0.65, `rgba(78, 72, 68, ${0.55 + stress * 0.12})`);
  faceGrad.addColorStop(1, `rgba(22, 18, 16, ${0.72 + stress * 0.1})`);
  ctx.fillStyle = faceGrad;
  ctx.fillRect(faceX, faceY, faceW, faceH);

  ctx.globalCompositeOperation = "multiply";
  ctx.fillStyle = `rgba(${r},${g},${b},${0.38 + pulse * 0.06})`;
  ctx.fillRect(faceX, faceY, faceW, faceH);
  ctx.globalCompositeOperation = "source-over";

  /* Кладка / армированная текстура */
  ctx.strokeStyle = `rgba(18, 16, 14, ${0.35 + stress * 0.15})`;
  ctx.lineWidth = Math.max(0.6, ch * 0.018);
  const rows = 4;
  for (let i = 1; i < rows; i++) {
    const yy = faceY + (faceH * i) / rows;
    ctx.beginPath();
    ctx.moveTo(faceX + faceW * 0.04, yy);
    ctx.lineTo(faceX + faceW * 0.96, yy);
    ctx.stroke();
  }
  ctx.fillStyle = `rgba(255, 252, 245, ${0.04 + pulse * 0.04})`;
  for (let i = 0; i < 3; i++) {
    const ox = faceX + faceW * (0.18 + i * 0.28);
    ctx.fillRect(ox, faceY + faceH * 0.12, faceW * 0.08, faceH * 0.78);
  }

  /* Верхний парапет (свет сверху) */
  const capGrad = ctx.createLinearGradient(faceX, faceY, faceX, faceY + capH);
  capGrad.addColorStop(0, `rgba(255,255,255,${0.35 + pulse * 0.1})`);
  capGrad.addColorStop(0.55, `rgba(${r},${g},${b},0.35)`);
  capGrad.addColorStop(1, "rgba(40,32,28,0.55)");
  ctx.fillStyle = capGrad;
  ctx.fillRect(faceX - pad * 0.2, faceY - capH * 0.2, faceW + pad * 0.4, capH);

  /* Толстая внешняя рамка-барьер */
  ctx.strokeStyle = `rgba(240, 232, 220, ${0.55 + pulse * 0.12})`;
  ctx.lineWidth = Math.max(2, ch * 0.095);
  ctx.strokeRect(faceX + 0.5, faceY + 0.5, faceW - 1, faceH - 1);
  ctx.strokeStyle = `rgba(12, 10, 8, ${0.75 + stress * 0.1})`;
  ctx.lineWidth = Math.max(1.2, ch * 0.055);
  ctx.strokeRect(px + 0.5, py + 0.5, cw - 1, ch - 1);

  /* «Заклёпки» (металл) — только при полном HP */
  if (wh >= 3) {
    const rivet = Math.max(1.2, ch * 0.055);
    ctx.fillStyle = "rgba(180, 175, 168, 0.9)";
    for (const [rx, ry] of [
      [faceX + faceW * 0.12, faceY + faceH * 0.2],
      [faceX + faceW * 0.88, faceY + faceH * 0.2],
      [faceX + faceW * 0.12, faceY + faceH * 0.8],
      [faceX + faceW * 0.88, faceY + faceH * 0.8],
    ]) {
      ctx.beginPath();
      ctx.arc(rx, ry, rivet * 0.5, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  /* Трещины по урону */
  if (wh <= 2) {
    ctx.strokeStyle = `rgba(18, 14, 12, ${0.75 + pulse * 0.15})`;
    ctx.lineWidth = Math.max(1.1, ch * 0.055);
    ctx.beginPath();
    ctx.moveTo(faceX + faceW * 0.1, faceY + faceH * 0.38);
    ctx.lineTo(faceX + faceW * 0.82, faceY + faceH * 0.72);
    ctx.stroke();
    ctx.strokeStyle = `rgba(18, 14, 12, ${0.45 + pulse * 0.1})`;
    ctx.lineWidth = Math.max(0.6, ch * 0.032);
    ctx.beginPath();
    ctx.moveTo(faceX + faceW * 0.72, faceY + faceH * 0.28);
    ctx.lineTo(faceX + faceW * 0.45, faceY + faceH * 0.55);
    ctx.stroke();
  }
  if (wh <= 1) {
    ctx.strokeStyle = `rgba(110, 48, 28, ${0.85 + pulse * 0.1})`;
    ctx.lineWidth = Math.max(1.15, ch * 0.065);
    ctx.beginPath();
    ctx.moveTo(faceX + faceW * 0.88, faceY + faceH * 0.18);
    ctx.lineTo(faceX + faceW * 0.18, faceY + faceH * 0.92);
    ctx.moveTo(faceX + faceW * 0.78, faceY + faceH * 0.12);
    ctx.lineTo(faceX + faceW * 0.08, faceY + faceH * 0.62);
    ctx.stroke();
    ctx.fillStyle = `rgba(255, 90, 40, ${0.12 + pulse * 0.06})`;
    ctx.fillRect(faceX, faceY, faceW, faceH);
  }

  /* HP-бейдж */
  const badgeW = Math.max(10, cw * 0.34);
  const badgeH = Math.max(8, ch * 0.22);
  const bx = px + cw * 0.5 - badgeW * 0.5;
  const by = py + ch - badgeH - pad * 0.8;
  ctx.fillStyle = "rgba(0,0,0,0.45)";
  ctx.fillRect(bx, by, badgeW, badgeH);
  ctx.strokeStyle = `rgba(${r},${g},${b},0.85)`;
  ctx.lineWidth = Math.max(1, ch * 0.04);
  ctx.strokeRect(bx + 0.5, by + 0.5, badgeW - 1, badgeH - 1);
  ctx.fillStyle = `rgba(255, 250, 240, 0.95)`;
  ctx.font = `800 ${Math.max(7, ch * 0.26)}px system-ui,Segoe UI,sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(String(wh), bx + badgeW * 0.5, by + badgeH * 0.52);
  ctx.restore();
}

function draw(time = performance.now(), drawOpts = {}) {
  const _perf0 = perfDebug ? performance.now() : 0;
  let w = canvas.clientWidth;
  let h = canvas.clientHeight;
  if (w < 1 || h < 1) {
    scheduleResizeCanvas();
    return;
  }
  drawConnectivityFrameId++;
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
        const d = MAP_BASE_RGB_DIM;
        base = `rgb(${Math.round(regionRgb[ri] * d)},${Math.round(regionRgb[ri + 1] * d)},${Math.round(
          regionRgb[ri + 2] * d
        )})`;
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
      if (owner === undefined) {
        ctx.fillStyle = `rgba(0,0,0,${MAP_FREE_CELL_DIM_ALPHA})`;
        ctx.fillRect(px, py, cw, ch);
      }

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
            const wHp = typeof owner === "object" && owner ? normalizeWallHp(owner.wallHp) : 0;
            if (wHp > 0 && cell >= 1.6) {
              drawGreatWallStoneDecor(ctx, px, py, cw, ch, tc, wHp, time);
            }
          }
        } else {
          ctx.fillStyle = PALETTE[owner] ?? "#888";
          ctx.fillRect(px, py, cw, ch);
        }
      }

      if (online && treasureSpotKeys.has(key)) {
        drawMapTreasureChestIcon(ctx, px, py, cw, ch);
      }
    }
  }

  /** Кэш владения ферм на один кадр: нижний маяк, реактор и «корона» читают одни и те же данные. */
  /** @type {Map<number, { owner: number, contested: boolean, topScore: number }> | null} */
  let qFarmCtrlOnce = null;
  function qFarmCtrl(f) {
    if (qFarmCtrlOnce === null) qFarmCtrlOnce = new Map();
    const id = f.id | 0;
    const hit = qFarmCtrlOnce.get(id);
    if (hit) return hit;
    const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, (key) => {
      const p = key.split(",");
      const v = clientPixelTeamIdAt(Number(p[0]), Number(p[1]));
      return v == null ? 0 : v | 0;
    });
    const st = resolveFarmControl(scores);
    qFarmCtrlOnce.set(id, st);
    return st;
  }

  /* Квантовые фермы: широкий маяк и контур зоны боя (под остальными оверлеями карты). */
  const drawQuantumUnderlay =
    !lite &&
    !partial &&
    online &&
    quantumFarmsMeta.length > 0 &&
    cell >= 1.15 &&
    visibleCellCount <= 28000;
  if (drawQuantumUnderlay) {
    for (let fi = 0; fi < quantumFarmsMeta.length; fi++) {
      const f = quantumFarmsMeta[fi];
      const farmLvl = normalizeQuantumFarmLevel(f.level);
      const tierFootprint = 1 + (farmLvl - 1) * 0.16;
      const igx0 = Math.max(0, f.x0 - 1);
      const igy0 = Math.max(0, f.y0 - 1);
      const igx1 = Math.min(gridW - 1, f.x0 + f.w);
      const igy1 = Math.min(gridH - 1, f.y0 + f.h);
      if (igx1 < x0 || igx0 > x1 || igy1 < y0 || igy0 > y1) continue;
      const { owner, contested } = qFarmCtrl(f);
      const sx0 = offsetX + f.x0 * cell;
      const sy0 = offsetY + f.y0 * cell;
      const sw = f.w * cell;
      const sh = f.h * cell;
      const cx = sx0 + sw * 0.5;
      const cy = sy0 + sh * 0.5;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.0029 + fi * 0.47);
      const teamHex = owner ? teamColor(owner) : null;
      const { r: tr, g: tg, b: tb } = teamHex ? hexToRgb(teamHex) : { r: 110, g: 200, b: 255 };
      const rx = offsetX + igx0 * cell;
      const ry = offsetY + igy0 * cell;
      const rw = (igx1 - igx0 + 1) * cell;
      const rh = (igy1 - igy0 + 1) * cell;
      ctx.save();
      ctx.fillStyle = contested
        ? `rgba(255, 120, 60, ${0.045 + pulse * 0.055})`
        : owner
          ? `rgba(${tr},${tg},${tb},${0.038 + pulse * 0.048})`
          : `rgba(80, 190, 255, ${0.04 + pulse * 0.05})`;
      ctx.fillRect(rx, ry, rw, rh);
      ctx.restore();
      ctx.save();
      ctx.globalCompositeOperation = "screen";
      const bloomR = Math.min(w, h, cell * 4.2 * (0.92 + pulse * 0.1)) * tierFootprint;
      const bg = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloomR);
      if (contested) {
        bg.addColorStop(0, `rgba(255, 240, 200, ${0.2 + pulse * 0.12})`);
        bg.addColorStop(0.45, `rgba(255, 100, 70, ${0.09 + pulse * 0.06})`);
        bg.addColorStop(1, "rgba(20, 40, 90, 0)");
      } else if (owner) {
        bg.addColorStop(0, `rgba(255, 255, 255, ${0.14 + pulse * 0.1})`);
        bg.addColorStop(0.5, `rgba(${tr},${tg},${tb},${0.11 + pulse * 0.08})`);
        bg.addColorStop(1, "rgba(15, 30, 70, 0)");
      } else {
        bg.addColorStop(0, `rgba(200, 245, 255, ${0.16 + pulse * 0.09})`);
        bg.addColorStop(0.55, `rgba(80, 180, 255, ${0.08 + pulse * 0.05})`);
        bg.addColorStop(1, "rgba(10, 40, 80, 0)");
      }
      if (farmLvl >= 3 && !contested) {
        const goldA = farmLvl >= 4 ? 0.08 + pulse * 0.06 : 0.06 + pulse * 0.05;
        bg.addColorStop(0.2, `rgba(255, 210, 120, ${goldA})`);
      }
      ctx.fillStyle = bg;
      ctx.beginPath();
      ctx.arc(cx, cy, bloomR, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
      ctx.save();
      ctx.strokeStyle = contested
        ? `rgba(255, 90, 50, ${0.38 + pulse * 0.28})`
        : owner
          ? `rgba(${tr},${tg},${tb},${0.28 + pulse * 0.22})`
          : `rgba(160, 230, 255, ${0.26 + pulse * 0.2})`;
      ctx.lineWidth = Math.max(1.2, cell * (0.085 + (farmLvl - 1) * 0.035));
      ctx.setLineDash([Math.max(4, cell * 0.42), Math.max(3, cell * 0.28)]);
      ctx.lineDashOffset = -(time * 0.035 + fi * 7);
      ctx.strokeRect(rx + 0.5, ry + 0.5, rw - 1, rh - 1);
      ctx.setLineDash([]);
      ctx.restore();
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
  if (online) {
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
              ctx.fillStyle = battleEventOverlayRgba(255, 235, 60, 0.92 + pulseEv * 0.08);
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
                ctx.fillStyle = battleEventOverlayRgba(80, 255, 150, 0.72 + pulseEv * 0.14);
                ctx.fillRect(px, py, cw, ch);
              } else if (zone === "rec") {
                ctx.fillStyle = battleEventOverlayRgba(130, 210, 255, 0.68 + pulseEv * 0.12);
                ctx.fillRect(px, py, cw, ch);
              }
            }
          }
          if (compLayer && compLayer.compression) {
            const m = tournamentCompressionMultiplierForCell(gx, gy, gridW, gridH, compLayer.compression);
            if (m < 0.92) {
              ctx.fillStyle = battleEventOverlayRgba(45, 65, 120, Math.min(0.78, (1 - m) * 0.95));
              ctx.fillRect(px, py, cw, ch);
            } else if (m > 1.08) {
              ctx.fillStyle = battleEventOverlayRgba(255, 225, 100, Math.min(0.78, (m - 1) * 1.05));
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
      const blackOutlinePulse = 0.5 + 0.5 * (0.5 + 0.5 * Math.sin(time * 0.0075));
      for (let oli = 0; oli < layers.length; oli++) {
        const L = layers[oli];
        if (goldKindsOutline.includes(L.kind) && L.rect) {
          const r = L.rect;
          const sx0 = offsetX + r.x0 * cell;
          const sy0 = offsetY + r.y0 * cell;
          const sw = r.w * cell;
          const sh = r.h * cell;
          const p = 0.92 + pulseEv * 0.08;
          const padOut = Math.max(6, cell * 0.78);
          ctx.save();
          ctx.strokeStyle = battleEventOverlayRgba(0, 0, 0, 0.72 * blackOutlinePulse + 0.28);
          ctx.lineWidth = Math.max(8, cell * 0.86);
          ctx.strokeRect(sx0 - padOut, sy0 - padOut, sw + padOut * 2, sh + padOut * 2);
          ctx.strokeStyle = battleEventOverlayRgba(255, 228, 55, 0.99 * p);
          ctx.lineWidth = Math.max(5.5, cell * 0.6);
          ctx.strokeRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
          ctx.strokeStyle = battleEventOverlayRgba(255, 255, 250, 0.96 * p);
          ctx.lineWidth = Math.max(3.2, cell * 0.3);
          ctx.strokeRect(sx0 + cell * 0.1, sy0 + cell * 0.1, sw - cell * 0.2, sh - cell * 0.2);
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
            const padOut = Math.max(5, cell * 0.58);
            ctx.save();
            ctx.strokeStyle = battleEventOverlayRgba(0, 0, 0, 0.6 * blackOutlinePulse + 0.26);
            ctx.lineWidth = Math.max(6.5, cell * 0.64);
            ctx.strokeRect(sx0 - padOut, sy0 - padOut, sw + padOut * 2, sh + padOut * 2);
            ctx.strokeStyle = boom ? battleEventOverlayRgba(40, 255, 125, 0.98) : battleEventOverlayRgba(135, 215, 255, 0.98);
            ctx.lineWidth = Math.max(4.2, cell * 0.48);
            ctx.strokeRect(sx0 - 2, sy0 - 2, sw + 4, sh + 4);
            ctx.strokeStyle = boom ? battleEventOverlayRgba(210, 255, 230, 0.72) : battleEventOverlayRgba(230, 240, 255, 0.68);
            ctx.lineWidth = Math.max(2.6, cell * 0.22);
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
        grd.addColorStop(0.5, battleEventOverlayRgba(255, 252, 120, 0.96));
        grd.addColorStop(1, "rgba(255,255,255,0)");
        ctx.fillStyle = grd;
        ctx.globalCompositeOperation = "source-over";
        ctx.fillRect(sx0, sy0, sw, sh);
        ctx.restore();
      }
      if (compLayer && compLayer.compression) {
        const cx = offsetX + (gridW * 0.5) * cell;
        const cy = offsetY + (gridH * 0.5) * cell;
        const maxR = Math.min(w, h) * 0.58;
        ctx.save();
        ctx.globalCompositeOperation = "source-over";
        for (let ring = 0; ring < 4; ring++) {
          const phase = (time * 0.0003 + ring * 0.26) % 1;
          const rad = maxR * (0.16 + phase * 0.82);
          const a = Math.min(0.55, 0.16 + 0.42 * (1 - phase));
          ctx.strokeStyle = battleEventOverlayRgba(255, 200, 110, a);
          ctx.lineWidth = 4.2 + ring * 0.58;
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
                ctx.fillStyle = battleEventOverlayRgba(255, 70, 40, 0.48 + pulseS * 0.22);
                ctx.fillRect(px, py, cw, ch);
                ctx.strokeStyle = battleEventOverlayRgba(255, 175, 100, 0.92);
                ctx.lineWidth = Math.max(2, cell * 0.18);
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
      const dust =
        BATTLE_EVENT_MAP_ZONE_INTENSITY * (0.06 * fade + 0.04 * fade * Math.sin(time * 0.01));
      ctx.fillStyle = `rgba(180, 150, 120, ${dust})`;
      ctx.fillRect(0, 0, w, h);
    }
  }

  if (!lite && !partial && online) {
    const nuAft = Date.now();
    if (nuAft >= nukeAftermathUntilMs) {
      nukeAftermathBlastKeys = null;
    } else if (
      nukeAftermathBlastKeys &&
      nukeAftermathBlastKeys.size > 0 &&
      nukeAftermathGx1 >= nukeAftermathGx0
    ) {
      const fade = Math.min(1, (nukeAftermathUntilMs - nuAft) / 5200);
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.022 + nukeScorchHash01(x0, y0) * 2);
      const flicker = 0.5 + 0.5 * Math.sin(time * 0.031 + nukeScorchHash01(y0, x0) * 3.1);
      for (let gy = y0; gy <= y1; gy++) {
        for (let gx = x0; gx <= x1; gx++) {
          if (gx < nukeAftermathGx0 || gx > nukeAftermathGx1 || gy < nukeAftermathGy0 || gy > nukeAftermathGy1) {
            continue;
          }
          const pk = `${gx},${gy}`;
          if (!nukeAftermathBlastKeys.has(pk)) continue;
          const h = nukeScorchHash01(gx, gy);
          const h2 = nukeScorchHash01(gy + 17, gx - 3);
          const edgeWobble = 0.65 + 0.35 * h2;
          const ember =
            fade * edgeWobble * (0.028 + h * 0.055 + pulse * 0.028 * h + flicker * 0.018 * (1 - h));
          const px = offsetX + gx * cell;
          const py = offsetY + gy * cell;
          const cw = Math.ceil(cell);
          const ch = Math.ceil(cell);
          ctx.fillStyle = `rgba(255, ${40 + (h * 95) | 0}, ${15 + (h2 * 40) | 0}, ${ember})`;
          ctx.fillRect(px, py, cw, ch);
          ctx.fillStyle = `rgba(${22 + (h * 25) | 0}, ${8 + (h2 * 12) | 0}, 4, ${ember * (0.45 + h * 0.35)})`;
          ctx.fillRect(px, py, cw, ch);
          if (h > 0.82 && flicker > 0.72) {
            ctx.fillStyle = `rgba(255, 240, 200, ${ember * 0.35})`;
            ctx.fillRect(px + cw * 0.15, py + ch * 0.15, cw * 0.7, ch * 0.7);
          }
        }
      }
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

  const drawMilitaryPlacePreview =
    !lite &&
    !partial &&
    online &&
    myTeamId != null &&
    !spectatorMode &&
    pendingMapAction?.type === "militaryBase" &&
    mapHoverGx >= 0 &&
    cell >= 2;
  if (drawMilitaryPlacePreview) {
    const cx = mapHoverGx | 0;
    const cy = mapHoverGy | 0;
    const bx0 = cx;
    const by0 = cy;
    const sx0 = offsetX + bx0 * cell;
    const sy0 = offsetY + by0 * cell;
    const sw = MILITARY_OUTPOST_SIZE * cell;
    const sh = MILITARY_OUTPOST_SIZE * cell;
    const v = validateClientMilitaryBasePreview(cx, cy);
    const ok = v.ok;
    const pulse = ok ? 0.5 + 0.5 * Math.sin(time * 0.007) : 1;
    ctx.save();
    ctx.fillStyle = ok
      ? `rgba(120, 255, 190, ${0.1 + pulse * 0.08})`
      : "rgba(255, 55, 70, 0.14)";
    ctx.fillRect(sx0, sy0, sw, sh);
    ctx.strokeStyle = ok ? `rgba(253, 230, 138, ${0.55 + pulse * 0.35})` : "rgba(255, 120, 130, 0.9)";
    ctx.lineWidth = Math.max(2, cell * 0.11);
    ctx.strokeRect(sx0 + 0.5, sy0 + 0.5, sw - 1, sh - 1);
    ctx.strokeStyle = ok ? `rgba(129, 140, 248, ${0.35 + pulse * 0.25})` : "rgba(255,200,200,0.38)";
    ctx.lineWidth = Math.max(1, cell * 0.05);
    ctx.strokeRect(sx0 + cell * 0.15, sy0 + cell * 0.15, sw - cell * 0.3, sh - cell * 0.3);
    ctx.restore();
  }

  const drawBaseRepairTargeting =
    !lite &&
    !partial &&
    online &&
    myTeamId != null &&
    !spectatorMode &&
    pendingMapAction?.type === "baseRepair" &&
    teamsMeta &&
    cell >= 2;
  if (drawBaseRepairTargeting) {
    const mid = myTeamId | 0;
    const t = teamsMeta.find((x) => !x.solo && !x.eliminated && (x.id | 0) === mid);
    const pulse = 0.5 + 0.5 * Math.sin(time * 0.0065);
    ctx.save();
    if (t?.spawn && typeof t.spawn.x0 === "number" && typeof t.spawn.y0 === "number") {
      const sx0 = t.spawn.x0 | 0;
      const sy0 = t.spawn.y0 | 0;
      const side = clientMainSpawnSideFromSpawn(t.spawn);
      const sw = side * cell;
      const sh = side * cell;
      const px = offsetX + sx0 * cell;
      const py = offsetY + sy0 * cell;
      ctx.fillStyle = `rgba(56, 189, 248, ${0.07 + pulse * 0.06})`;
      ctx.fillRect(px, py, sw, sh);
      ctx.strokeStyle = `rgba(125, 211, 252, ${0.38 + pulse * 0.22})`;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.strokeRect(px + 0.5, py + 0.5, sw - 1, sh - 1);
      const fc = flagCellFromSpawn(sx0, sy0, side);
      const fx = offsetX + fc.x * cell;
      const fy = offsetY + fc.y * cell;
      ctx.strokeStyle = `rgba(34, 211, 238, ${0.62 + pulse * 0.18})`;
      ctx.lineWidth = Math.max(2, cell * 0.11);
      ctx.strokeRect(fx + 0.5, fy + 0.5, cell - 1, cell - 1);
    }
    const mosBr = clientMilitaryOutpostRects(mid);
    for (let mi = 0; mi < mosBr.length; mi++) {
      const r = mosBr[mi];
      const rx0 = r.x0 | 0;
      const ry0 = r.y0 | 0;
      const rw = MILITARY_OUTPOST_SIZE * cell;
      const rh = MILITARY_OUTPOST_SIZE * cell;
      const px = offsetX + rx0 * cell;
      const py = offsetY + ry0 * cell;
      ctx.fillStyle = `rgba(56, 189, 248, ${0.09 + pulse * 0.07})`;
      ctx.fillRect(px, py, rw, rh);
      ctx.strokeStyle = `rgba(165, 243, 252, ${0.48 + pulse * 0.26})`;
      ctx.lineWidth = Math.max(2, cell * 0.09);
      ctx.strokeRect(px + 0.5, py + 0.5, rw - 1, rh - 1);
    }
    if (mapHoverGx >= 0) {
      const hx = mapHoverGx | 0;
      const hy = mapHoverGy | 0;
      const ok = clientCellIsOwnRepairableBase(hx, hy);
      const hpx = offsetX + hx * cell;
      const hpy = offsetY + hy * cell;
      const cw = Math.ceil(cell);
      const ch = Math.ceil(cell);
      ctx.fillStyle = ok ? `rgba(74, 222, 128, ${0.2 + pulse * 0.08})` : `rgba(248, 113, 113, ${0.16})`;
      ctx.fillRect(hpx, hpy, cw, ch);
    }
    ctx.restore();
  }

  const drawNukeBombTargetingPreview =
    !lite &&
    !partial &&
    online &&
    myTeamId != null &&
    !spectatorMode &&
    pendingMapAction?.type === "nukeBomb" &&
    mapHoverGx >= 0 &&
    cell >= 1.6 &&
    visibleCellCount <= 20000;
  if (drawNukeBombTargetingPreview) {
    const tcx = mapHoverGx | 0;
    const tcy = mapHoverGy | 0;
    const valid =
      isClientPlayableCell(tcx, tcy) &&
      clientNukeBlastWouldClearTerritory(tcx, tcy);
    const pulseT = 0.5 + 0.5 * Math.sin(time * 0.0065);
    const blastPairs = computeNukeBombBlastCells(
      tcx,
      tcy,
      roundIndexMeta,
      gridW,
      gridH,
      isClientPlayableCell,
      clientNoNukeBlastHoleExclusion
    );
    const inBlast = new Set(blastPairs.map(([bx, by]) => `${bx},${by}`));
    ctx.save();
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const pk = `${gx},${gy}`;
        if (!inBlast.has(pk)) continue;
        const wob = nukeScorchHash01(gx, gy);
        const px = offsetX + gx * cell;
        const py = offsetY + gy * cell;
        const cw = Math.ceil(cell);
        const ch = Math.ceil(cell);
        if (valid) {
          ctx.fillStyle = `rgba(72, 255, 140, ${0.07 + pulseT * 0.06 + wob * 0.04})`;
          ctx.fillRect(px, py, cw, ch);
          ctx.strokeStyle = `rgba(200, 255, 220, ${0.16 + pulseT * 0.14 + wob * 0.08})`;
        } else {
          ctx.fillStyle = `rgba(255, 70, 50, ${0.09 + pulseT * 0.08 + wob * 0.05})`;
          ctx.fillRect(px, py, cw, ch);
          ctx.strokeStyle = `rgba(255, 200, 160, ${0.22 + pulseT * 0.18 + wob * 0.1})`;
        }
        ctx.lineWidth = Math.max(1, cell * 0.055);
        ctx.strokeRect(px + 0.5, py + 0.5, Math.max(1, cw - 1), Math.max(1, ch - 1));
      }
    }
    const scx = offsetX + tcx * cell + cell * 0.5;
    const scy = offsetY + tcy * cell + cell * 0.5;
    ctx.strokeStyle = valid
      ? `rgba(120, 255, 180, ${0.42 + pulseT * 0.2})`
      : `rgba(255, 120, 80, ${0.5 + pulseT * 0.22})`;
    ctx.lineWidth = Math.max(1.5, cell * 0.085);
    ctx.setLineDash([cell * 0.2, cell * 0.35, cell * 0.12, cell * 0.28]);
    ctx.lineDashOffset = -(time * 0.055);
    ctx.beginPath();
    ctx.arc(scx, scy, 1.15 * cell, 0, Math.PI * 2);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
  }

  const drawQuantumFarmsLayer =
    !lite &&
    !partial &&
    online &&
    quantumFarmsMeta.length > 0 &&
    cell >= 1.5 &&
    visibleCellCount <= 22000;
  if (drawQuantumFarmsLayer) {
    const myT = myTeamId | 0;
    for (let fi = 0; fi < quantumFarmsMeta.length; fi++) {
      const f = quantumFarmsMeta[fi];
      const fx1 = f.x0 + f.w - 1;
      const fy1 = f.y0 + f.h - 1;
      if (fx1 < x0 || f.x0 > x1 || fy1 < y0 || f.y0 > y1) continue;
      const { owner, contested } = qFarmCtrl(f);
      const lvl = normalizeQuantumFarmLevel(f.level);
      const tierBoost = lvl <= 1 ? 1 : lvl === 2 ? 1.22 : lvl === 3 ? 1.52 : 1.68;
      const sx0 = offsetX + f.x0 * cell;
      const sy0 = offsetY + f.y0 * cell;
      const sw = f.w * cell;
      const sh = f.h * cell;
      const cx = sx0 + sw * 0.5;
      const cy = sy0 + sh * 0.5;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.0038 + fi * 0.61);
      const pulse2 = 0.5 + 0.5 * Math.sin(time * 0.0055 + fi * 0.31);
      const pulseL3 = lvl >= 3 ? 0.5 + 0.5 * Math.sin(time * 0.0024 + fi * 0.41) : 0;
      const pad = cell * (0.056 + (lvl - 1) * 0.03);
      const teamHex = owner ? teamColor(owner) : null;
      const rgb = teamHex
        ? hexToRgb(teamHex)
        : lvl === 1
          ? { r: 92, g: 188, b: 245 }
          : lvl === 2
            ? { r: 118, g: 208, b: 255 }
            : lvl === 3
              ? { r: 150, g: 225, b: 255 }
              : { r: 175, g: 235, b: 255 };
      const tr = rgb.r;
      const tg = rgb.g;
      const tb = rgb.b;
      const mine = myT && owner === myT;
      const ringCount = lvl === 1 ? 3 : lvl === 2 ? 5 : lvl === 3 ? 7 : 8;
      const ringAlphaMul = lvl === 1 ? 0.82 : lvl === 2 ? 1 : lvl === 3 ? 1.14 : 1.22;
      for (let ring = 0; ring < ringCount; ring++) {
        const phase = (time * 0.0019 + fi * 0.31 + ring * 0.21) % 1;
        const rad = Math.min(sw, sh) * (0.52 + ring * 0.28 + phase * 0.22) * tierBoost;
        const a =
          (0.07 + 0.14 * (1 - phase)) * (contested ? 1.25 : 1) * ringAlphaMul * (lvl >= 3 ? 1 + pulseL3 * 0.08 : 1);
        ctx.save();
        ctx.strokeStyle = contested
          ? `rgba(255, 160, 90, ${a})`
          : owner
            ? `rgba(${tr},${tg},${tb},${a * 0.95})`
            : lvl >= 2
              ? `rgba(${Math.min(255, tr + 15)},${tg},${tb},${a})`
              : `rgba(92, 188, 245, ${a})`;
        ctx.lineWidth = Math.max(1, cell * (0.048 + ring * 0.02 + (lvl - 1) * 0.012));
        ctx.beginPath();
        ctx.arc(cx, cy, rad, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.save();
      ctx.strokeStyle = contested
        ? `rgba(255, 220, 120, ${0.35 + pulse2 * 0.35})`
        : owner
          ? `rgba(${tr},${tg},${tb},${0.3 + pulse * 0.35})`
          : `rgba(190, 240, 255, ${0.28 + pulse * 0.3})`;
      ctx.lineWidth = Math.max(1.5, cell * (0.07 + (lvl - 1) * 0.028));
      ctx.setLineDash([cell * 0.5, cell * 0.35]);
      ctx.lineDashOffset = -(time * 0.055 + fi * 11);
      ctx.beginPath();
      ctx.arc(cx, cy, Math.min(sw, sh) * (0.6 + (lvl - 1) * 0.02), 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.restore();
      ctx.save();
      if (mine) {
        ctx.shadowColor = `rgba(${tr},${tg},${tb},0.85)`;
        ctx.shadowBlur = Math.min(36, cell * (0.75 + lvl * 0.28));
      }
      ctx.fillStyle = contested
        ? `rgba(52, 36, 48, ${0.48 + pulse2 * 0.12})`
        : `rgba(14, 22, 38, ${0.5 + pulse * 0.1})`;
      ctx.fillRect(sx0 + pad, sy0 + pad, sw - pad * 2, sh - pad * 2);
      ctx.shadowBlur = 0;
      if (contested) {
        const flash = 0.5 + 0.5 * Math.sin(time * 0.016);
        ctx.strokeStyle = `rgba(255, ${40 + flash * 200 | 0}, 55, ${0.68 + flash * 0.22})`;
      } else if (owner) {
        ctx.strokeStyle = `rgba(${tr},${tg},${tb},${0.58 + pulse * 0.38})`;
      } else {
        ctx.strokeStyle = `rgba(190, 240, 255, ${0.48 + pulse * 0.34})`;
      }
      ctx.lineWidth = Math.max(2.2, cell * (0.12 + (lvl - 1) * 0.045));
      ctx.strokeRect(sx0 + pad * 0.65, sy0 + pad * 0.65, sw - pad * 1.3, sh - pad * 1.3);
      if (lvl === 2) {
        ctx.save();
        ctx.strokeStyle = `rgba(255, 200, 100, ${0.28 + pulse * 0.22})`;
        ctx.lineWidth = Math.max(1, cell * 0.055);
        ctx.setLineDash([cell * 0.22, cell * 0.18]);
        ctx.lineDashOffset = -(time * 0.07 + fi * 3);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(sw, sh) * 0.44, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.restore();
      } else if (lvl >= 3) {
        ctx.save();
        ctx.strokeStyle = `rgba(255, 245, 200, ${0.32 + pulse * 0.25})`;
        ctx.lineWidth = Math.max(1.2, cell * 0.065);
        ctx.setLineDash([cell * 0.2, cell * 0.14]);
        ctx.lineDashOffset = -(time * 0.095 + fi * 3);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(sw, sh) * 0.46, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(120, 255, 255, ${0.18 + pulseL3 * 0.2})`;
        ctx.lineWidth = Math.max(1, cell * 0.04);
        ctx.beginPath();
        ctx.arc(cx, cy, Math.min(sw, sh) * 0.36, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      const cr = Math.max(2.8, Math.min(sw, sh) * 0.21 * tierBoost);
      const grd = ctx.createRadialGradient(cx, cy, 0, cx, cy, cr * 2.55);
      if (contested) {
        const wob = 0.5 + 0.5 * Math.sin(time * 0.021);
        grd.addColorStop(0, "rgba(255, 255, 255, 1)");
        grd.addColorStop(0.32, `rgba(255, ${90 + wob * 120 | 0}, 70, 0.82)`);
        grd.addColorStop(1, "rgba(60, 90, 200, 0)");
      } else if (owner) {
        grd.addColorStop(0, "rgba(255, 255, 255, 0.98)");
        grd.addColorStop(0.38, `rgba(${tr},${tg},${tb},0.72)`);
        grd.addColorStop(1, "rgba(25, 45, 95, 0)");
      } else {
        grd.addColorStop(0, "rgba(255, 255, 255, 0.96)");
        grd.addColorStop(
          0.4,
          lvl >= 4
            ? "rgba(175, 240, 255, 0.68)"
            : lvl >= 3
              ? "rgba(160, 235, 255, 0.62)"
              : lvl === 2
                ? "rgba(130, 215, 255, 0.58)"
                : "rgba(110, 200, 250, 0.52)"
        );
        grd.addColorStop(1, "rgba(20, 70, 120, 0)");
      }
      ctx.fillStyle = grd;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 2.15, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = contested
        ? `rgba(255, 255, 255, ${0.55 + pulse2 * 0.35})`
        : `rgba(255, 255, 255, ${0.4 + pulse * 0.25})`;
      ctx.beginPath();
      ctx.arc(cx, cy, cr * 0.42, 0, Math.PI * 2);
      ctx.fill();
      const nRay = lvl === 1 ? 9 : lvl === 2 ? 14 : lvl === 3 ? 18 : 21;
      const rayAlpha = lvl === 1 ? 0.85 : lvl === 2 ? 1 : lvl === 3 ? 1.12 : 1.2;
      for (let ri = 0; ri < nRay; ri++) {
        const ang = (ri / nRay) * Math.PI * 2 + time * 0.0014 + fi * 0.17;
        const len = Math.min(sw, sh) * (0.46 + pulse * 0.16 + (lvl - 1) * 0.04) * tierBoost;
        const ra = rayAlpha;
        ctx.strokeStyle = contested
          ? `rgba(255, 230, 150, ${(0.16 + pulse2 * 0.26) * ra})`
          : owner
            ? `rgba(${tr},${tg},${tb},${(0.13 + pulse * 0.24) * ra})`
            : lvl >= 3
              ? `rgba(200, 245, 255, ${(0.14 + pulse * 0.22) * ra})`
              : `rgba(150, 220, 255, ${(0.1 + pulse * 0.18) * ra})`;
        ctx.lineWidth = Math.max(1.2, cell * (0.062 + (lvl - 1) * 0.022));
        ctx.beginPath();
        ctx.moveTo(cx + Math.cos(ang) * cr * 0.45, cy + Math.sin(ang) * cr * 0.45);
        ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
        ctx.stroke();
      }
      if (lvl >= 3) {
        ctx.save();
        const beaconR = Math.min(sw, sh) * (0.72 + pulseL3 * 0.06);
        ctx.strokeStyle = `rgba(255, 215, 130, ${0.28 + pulseL3 * 0.32})`;
        ctx.lineWidth = Math.max(1.4, cell * 0.09);
        ctx.setLineDash([cell * 0.45, cell * 0.2]);
        ctx.lineDashOffset = -(time * 0.031 + fi * 5);
        ctx.beginPath();
        ctx.arc(cx, cy, beaconR, 0, Math.PI * 2);
        ctx.stroke();
        ctx.setLineDash([]);
        ctx.strokeStyle = `rgba(255, 120, 200, ${0.12 + pulseL3 * 0.14})`;
        ctx.lineWidth = Math.max(1, cell * 0.055);
        ctx.beginPath();
        ctx.arc(cx, cy, beaconR * 1.08, 0, Math.PI * 2);
        ctx.stroke();
        ctx.restore();
      }
      ctx.restore();
    }
  }

  /* Флаги баз: главная до 50 HP, плацдарм 20; реген по lastHitAt. */
  if (!lite && online && teamsMeta && cell >= 1.5) {
    const shNowF = Date.now();
    /** Главная база и FOB — одна логика HP (`flagCaptureClientState` по clientKey). */
    const drawClientFlagBaseHpUi = (
      fgx,
      fgy,
      tidFlag,
      stateKey,
      teamHex,
      compact,
      teamDisplayName,
      teamEmoji,
      compactFootprintCells = 1
    ) => {
      const maxHpFallback = compact ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP;
      const visTop = fgy - FLAG_VISUAL_CELLS_ABOVE;
      if (fgx < x0 || fgx > x1 || fgy < y0 || visTop > y1) return;
      const raw = flagCaptureClientState.get(stateKey);
      let rawForEff = raw;
      if (
        raw &&
        !compact &&
        maxHpFallback === FLAG_MAIN_BASE_MAX_HP &&
        (raw.maxHp | 0) === FLAG_BASE_MAX_HP
      ) {
        rawForEff = { ...raw, maxHp: FLAG_MAIN_BASE_MAX_HP };
      }
      const effHpFloat = computeClientFlagDisplayEffHp(rawForEff, shNowF, maxHpFallback);
      let maxH = maxHpFallback;
      if (rawForEff && typeof rawForEff.maxHp === "number" && Number.isFinite(rawForEff.maxHp) && rawForEff.maxHp > 0) {
        maxH = rawForEff.maxHp | 0;
      }
      /* Главная база — 50 HP: починить устаревшее состояние, если в кэше ошибочно 20. */
      if (!compact && maxHpFallback === FLAG_MAIN_BASE_MAX_HP && maxH === FLAG_BASE_MAX_HP) {
        maxH = FLAG_MAIN_BASE_MAX_HP;
      }
      const displayHp = Math.min(maxH, Math.max(0, Math.floor(effHpFloat + 1e-9)));
      const dmgTaken = maxH - displayHp;
      const px = offsetX + fgx * cell;
      const py = offsetY + fgy * cell;
      const cw = Math.ceil(cell);
      const ch = Math.ceil(cell);
      const thrLow = Math.max(2, Math.floor(maxH * 0.22));
      const thrMid = Math.max(1, Math.floor(maxH * 0.11));
      const dangerLow = displayHp <= thrLow && displayHp > 0;
      const dangerMid = displayHp <= thrMid && displayHp > 0;
      const dangerCrit = displayHp <= 1 && displayHp > 0;
      const dangerHpZero = displayHp <= 0 && raw != null;
      const pulseF = compact
        ? 0.55 + 0.45 * Math.sin(time * 0.004 + fgx * 0.19)
        : 0.5 + 0.5 * Math.sin(time * 0.012 + dmgTaken * 0.15);
      const pulseRed =
        dangerCrit && shNowF < myFlagCriticalUntil && tidFlag === (myTeamId | 0)
          ? 0.35 + 0.35 * Math.sin(time * 0.055)
          : dangerMid
            ? 0.12 + 0.12 * Math.sin(time * 0.035)
            : dangerLow
              ? 0.06 + 0.06 * Math.sin(time * 0.022)
              : 0;
      const { r, g, b } = hexToRgb(teamHex);
      const rb = Math.min(255, Math.round(r * 1.14 + 28));
      const gb = Math.min(255, Math.round(g * 1.14 + 28));
      const bb = Math.min(255, Math.round(b * 1.14 + 28));
      const mastW = compact ? Math.max(3, cell * 0.17) : Math.max(4, cell * 0.24);
      const mastX = px + cw * (compact ? 0.58 : 0.66);
      const topY = compact
        ? py - Math.max(1.5, cell * 0.22) * ch
        : py - FLAG_VISUAL_CELLS_ABOVE * ch;
      const wave = compact
        ? Math.sin(time * 0.004 + fgx * 0.19) * ch * 0.06
        : Math.sin(time * 0.0033 + fgx * 0.35 + fgy * 0.22) * ch * 0.11;
      ctx.save();
      if (compact) {
        ctx.fillStyle = "rgba(34,36,42,0.96)";
        ctx.fillRect(mastX, topY, mastW, py + ch - topY);
      } else {
        ctx.fillStyle = "rgba(0,0,0,0.35)";
        ctx.fillRect(mastX + 1.6, topY + 1.6, mastW, py + ch - topY);
        ctx.fillStyle = "rgba(48,48,52,0.98)";
        ctx.fillRect(mastX, topY, mastW, py + ch - topY);
      }
      const cLeft = px - cw * (compact ? 0.04 : 0.1);
      const cTop = topY + ch * 0.06;
      const cW = cw * (compact ? 0.9 : 1.02);
      const cH = py + ch * (compact ? 0.9 : 0.92) - cTop;
      ctx.beginPath();
      if (compact) {
        ctx.moveTo(mastX, cTop);
        ctx.lineTo(cLeft + cW, cTop + 1.5);
        ctx.lineTo(cLeft + cW * 0.87, cTop + cH + wave * 0.08);
        ctx.lineTo(cLeft, cTop + cH * 0.96);
      } else {
        ctx.moveTo(mastX, cTop + wave * 0.25);
        ctx.lineTo(cLeft + cW, cTop + wave);
        ctx.lineTo(cLeft + cW * 0.9, cTop + cH + wave * 0.15);
        ctx.lineTo(cLeft, cTop + cH * 0.96);
      }
      ctx.closePath();
      const clothA = (compact ? 0.86 : 0.94) + pulseF * 0.05 - pulseRed * 0.22;
      ctx.fillStyle = `rgba(${rb},${gb},${bb},${Math.max(0.9, clothA)})`;
      ctx.fill();
      if (pulseRed > 0) {
        ctx.fillStyle = `rgba(255, 40, 60, ${pulseRed * 0.55})`;
        ctx.fill();
      }
      ctx.strokeStyle = compact ? "rgba(0,0,0,0.5)" : "rgba(0,0,0,0.62)";
      ctx.lineWidth = Math.max(1, compact ? cell * 0.055 : cell * 0.085);
      ctx.stroke();
      if (!compact) {
        ctx.strokeStyle = `rgba(255,255,255,${0.42 + pulseF * 0.12})`;
        ctx.lineWidth = Math.max(1, cell * 0.045);
        ctx.stroke();
      }
      ctx.restore();
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
        displayHp <= thrMid
          ? "#ff4444"
          : displayHp <= thrLow
            ? "#ffaa33"
            : displayHp < maxH
              ? "#66dd88"
              : "rgba(100,220,130,0.85)";
      ctx.fillRect(bx, by, barW * hpFrac, barH);
      ctx.strokeStyle = "rgba(255,255,255,0.45)";
      ctx.lineWidth = Math.max(1, cell * 0.035);
      ctx.strokeRect(bx + 0.5, by + 0.5, barW - 1, barH - 1);
      if (cell >= 2.8) {
        ctx.save();
        const em =
          teamEmoji != null && String(teamEmoji).trim() !== "" ? `${String(teamEmoji).trim()} ` : "";
        const nameRaw = String(teamDisplayName || "").trim();
        const nameMax = compact ? 16 : 22;
        const nameLbl = nameRaw.slice(0, nameMax);
        const hpPart = `${displayHp} / ${maxH} HP`;
        let hpLabel;
        if (displayHp <= 0) {
          hpLabel = "FINISH!";
        } else if (nameLbl) {
          hpLabel = `${em}${nameLbl} — ${hpPart}`;
        } else {
          hpLabel = hpPart;
        }
        let fs = Math.max(8, Math.min(15, cell * (compact ? 0.34 : 0.4)));
        ctx.font = `700 ${fs}px system-ui,sans-serif`;
        const labelCap = compact ? Math.max(cw * 4.2, compactFootprintCells * cell * 0.92) : cw * 4.2;
        if (ctx.measureText(hpLabel).width > labelCap) {
          fs = Math.max(7, fs * 0.88);
          ctx.font = `700 ${fs}px system-ui,sans-serif`;
        }
        ctx.textAlign = "center";
        ctx.textBaseline = "bottom";
        const tx = px + cw / 2;
        const ty = by - 3;
        ctx.shadowColor = "rgba(0,0,0,0.92)";
        ctx.shadowBlur = Math.max(2, fs * 0.22);
        ctx.shadowOffsetX = 0;
        ctx.shadowOffsetY = 0;
        ctx.fillStyle = dangerCrit ? "#ffcccc" : "rgba(255,252,240,0.96)";
        ctx.fillText(hpLabel, tx, ty);
        ctx.shadowBlur = 0;
        ctx.restore();
      }
    };
    for (const t of teamsMeta) {
      if (t.solo || t.eliminated || !t.spawn) continue;
      const sp = t.spawn;
      const { x: fgx, y: fgy } = flagCellFromSpawn(sp.x0, sp.y0, clientMainSpawnSideFromSpawn(sp));
      const tidFlag = Number(t.id) | 0;
      drawClientFlagBaseHpUi(
        fgx,
        fgy,
        tidFlag,
        clientMainFlagKey(tidFlag),
        t.color || teamColor(t.id),
        false,
        typeof t.name === "string" ? t.name : "",
        t.emoji
      );
    }
    for (const tm of teamsMeta) {
      if (tm.solo || tm.eliminated) continue;
      const mos = clientMilitaryOutpostRects(tm.id);
      if (!mos.length) continue;
      const teamHex = tm.color || teamColor(tm.id);
      const { r: rr, g: gg, b: bb } = hexToRgb(teamHex);
      const tidM = Number(tm.id) | 0;
      for (let mi = 0; mi < mos.length; mi++) {
        const r = mos[mi];
        const gx00 = r.x0 | 0;
        const gy00 = r.y0 | 0;
        const gw = r.w | 0;
        const gh = r.h | 0;
        if (gx00 + gw < x0 || gx00 > x1 || gy00 + gh < y0 || gy00 > y1) continue;
        const obx0 = offsetX + gx00 * cell;
        const oby0 = offsetY + gy00 * cell;
        const osw = gw * cell;
        const osh = gh * cell;
        ctx.save();
        ctx.strokeStyle = `rgba(${Math.min(255, rr + 50)},${Math.min(255, gg + 50)},${Math.min(255, bb + 35)},0.78)`;
        ctx.lineWidth = Math.max(2, cell * 0.1);
        ctx.setLineDash([Math.max(3, cell * 0.22), Math.max(2, cell * 0.16)]);
        ctx.strokeRect(obx0 + 1, oby0 + 1, osw - 2, osh - 2);
        ctx.setLineDash([]);
        ctx.strokeStyle = "rgba(255, 210, 120, 0.55)";
        ctx.lineWidth = Math.max(1, cell * 0.055);
        ctx.strokeRect(obx0 + cell * 0.18, oby0 + cell * 0.18, osw - cell * 0.36, osh - cell * 0.36);
        ctx.restore();
        const fgx = gx00 + gw * 0.5 - 0.5;
        const fgy = gy00 + gh * 0.5 - 0.5;
        drawClientFlagBaseHpUi(
          fgx,
          fgy,
          tidM,
          clientMilitaryFlagKey(tidM, gx00, gy00),
          teamHex,
          true,
          typeof tm.name === "string" ? tm.name : "",
          tm.emoji,
          Math.max(gw, gh)
        );
      }
    }
  }

  /* Квантовые фермы: «корона» над флагами — якорь внимания на главной цели матча. */
  const drawQuantumCrown =
    !lite &&
    !partial &&
    online &&
    quantumFarmsMeta.length > 0 &&
    cell >= 2 &&
    visibleCellCount <= 22000;
  if (drawQuantumCrown) {
    for (let fi = 0; fi < quantumFarmsMeta.length; fi++) {
      const f = quantumFarmsMeta[fi];
      const fx1 = f.x0 + f.w - 1;
      const fy1 = f.y0 + f.h - 1;
      if (fx1 < x0 || f.x0 > x1 || fy1 < y0 || f.y0 > y1) continue;
      const { owner, contested } = qFarmCtrl(f);
      const farmLvlC = normalizeQuantumFarmLevel(f.level);
      const sx0 = offsetX + f.x0 * cell;
      const sy0 = offsetY + f.y0 * cell;
      const sw = f.w * cell;
      const sh = f.h * cell;
      const cx = sx0 + sw * 0.5;
      const pulse = 0.5 + 0.5 * Math.sin(time * 0.0048 + fi * 0.52);
      const pulseL3c = farmLvlC >= 3 ? 0.5 + 0.5 * Math.sin(time * 0.0035 + fi * 0.4) : 0;
      const fsMul = farmLvlC === 1 ? 1 : farmLvlC === 2 ? 1.06 : farmLvlC === 3 ? 1.14 : 1.22;
      const fs = Math.max(12, Math.min(26, cell * 0.56 * fsMul));
      const ty = sy0 - cell * (0.1 + (farmLvlC - 1) * 0.03) - pulse * cell * 0.04;
      const teamHexC = owner ? teamColor(owner) : null;
      const rgbC = teamHexC ? hexToRgb(teamHexC) : { r: 186, g: 240, b: 255 };
      const roman = farmLvlC === 1 ? "I" : farmLvlC === 2 ? "II" : farmLvlC === 3 ? "III" : "IV";
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "bottom";
      ctx.font = `900 ${fs}px system-ui,Segoe UI,sans-serif`;
      ctx.lineWidth = Math.max(2, fs * 0.14);
      ctx.strokeStyle = "rgba(0,0,0,0.82)";
      ctx.strokeText("⚛", cx, ty);
      ctx.fillStyle = contested
        ? `rgba(255, ${180 + (pulse * 75) | 0}, 90, 0.98)`
        : farmLvlC >= 3 && !contested
          ? `rgba(${Math.min(255, rgbC.r + 25)},${Math.min(255, rgbC.g + 35)},255,${0.92 + pulseL3c * 0.06})`
          : `rgba(${rgbC.r},${rgbC.g},${rgbC.b},0.96)`;
      ctx.fillText("⚛", cx, ty);
      if (cell >= 3.2) {
        const subFs = Math.max(7, fs * 0.36);
        ctx.font = `800 ${subFs}px system-ui,Segoe UI,sans-serif`;
        const subY = ty + subFs * 1.05;
        const sub = contested ? "СПОР" : `УЗЕЛ ${roman}`;
        ctx.lineWidth = Math.max(1, subFs * 0.12);
        ctx.strokeStyle = "rgba(0,0,0,0.78)";
        ctx.strokeText(sub, cx, subY);
        ctx.fillStyle = contested
          ? "rgba(255,220,180,0.92)"
          : farmLvlC === 2
            ? "rgba(255, 210, 140, 0.95)"
            : farmLvlC >= 3
              ? `rgba(255, 245, 200, ${0.92 + pulseL3c * 0.06})`
              : "rgba(190, 230, 255, 0.9)";
        ctx.fillText(sub, cx, subY);
      }
      ctx.restore();
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
      /* Имя и HP базы — только у флага (drawClientFlagBaseHpUi), без второй подписи по центру 6×6. */
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
  syncQuantumFarmPanelLayoutIfOpen();
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

  /* Тап по квантоферме: панель улучшения — до паузы/наблюдателя/разминки и даже при активном «оружии» из магазина (раньше warmup/pending блокировали открытие). */
  if (online && myTeamId != null && !onEnemyFlag) {
    const qFarmCell = findQuantumFarmCoveringCell(gx, gy);
    if (qFarmCell) {
      if (pendingMapAction?.type === "baseRepair") {
        notifyPurchaseError("base_repair_invalid_target");
        return;
      }
      if (!pendingMapActionTargetsMapCell(pendingMapAction)) {
        if (pendingMapAction) {
          pendingMapAction = null;
          setPendingHint();
        }
        openQuantumFarmPanel(qFarmCell);
        return;
      }
    }
  }

  if (quantumFarmPanelEl && !quantumFarmPanelEl.hidden) closeQuantumFarmPanel();

  if (online && gamePausedMeta) {
    notifyReject("paused");
    return;
  }
  if (online && spectatorMode) {
    notifyReject("spectator");
    return;
  }

  if (online && isClientWarmupPhase() && !onEnemyFlag) {
    notifyReject("warmup");
    return;
  }

  if (online && pendingMapAction?.type === "baseRepair") {
    if (!clientCellIsOwnRepairableBase(gx, gy)) {
      notifyPurchaseError("base_repair_invalid_target");
      return;
    }
    if (walletState && !walletState.devUnlimited) {
      const need = quantToUsdt(PRICES_QUANT.baseRepair);
      if (walletState.balanceUSDT + 1e-9 < need) {
        notifyPurchaseError("base_repair_needs_quants");
        return;
      }
    }
    wsSendJson({ type: "purchaseBaseRepair", x: gx, y: gy });
    pendingMapAction = null;
    mapHoverGx = -1;
    mapHoverGy = -1;
    setPendingHint();
    updateToolbarHud();
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
    if (pendingMapAction.type === "nukeBomb") {
      if (!applyOptimisticNukeBomb(gx, gy)) {
        pendingMapAction = null;
        setPendingHint();
        return;
      }
      showPlacementFeedback("Бомба запущена — удар по выбранной точке.", "ok", { telegramAlert: false });
      wsSendJson({ type: "purchaseNukeBomb", x: gx, y: gy });
      pendingMapAction = null;
      setPendingHint();
      return;
    }
    if (pendingMapAction.type === "greatWall") {
      if (getGreatWallChargesClient() < 1) {
        notifyPurchaseError("no_wall_charges");
        pendingMapAction = null;
        setPendingHint();
        return;
      }
      if ((clientPixelTeamIdAt(gx, gy) | 0) !== (myTeamId | 0)) {
        notifyPurchaseError("wall_not_yours");
        return;
      }
      if (clientPixelWallHpAt(gx, gy) > 0) {
        notifyPurchaseError("wall_already");
        return;
      }
      if (clientCellIsAnyFlagAnchor(gx, gy)) {
        notifyPurchaseError("wall_flag_cell");
        return;
      }
      const pkGw = `${gx},${gy}`;
      optimisticGreatWallPending = { key: pkGw, prev: snapshotPixelCell(pkGw) };
      const cur = pixels.get(pkGw);
      const sh0 = typeof cur === "object" && cur ? Number(cur.shieldedUntil) || 0 : 0;
      pixels.set(pkGw, { teamId: myTeamId | 0, shieldedUntil: sh0, wallHp: GREAT_WALL_MAX_HP });
      scheduleDraw({ dirty: { gx0: gx, gy0: gy, gx1: gx, gy1: gy } });
      wsSendJson({ type: "purchaseGreatWall", x: gx, y: gy });
      pendingMapAction = { type: "greatWall" };
      setPendingHint();
      playPurchaseSuccess();
      updateToolbarHud();
      return;
    }
    if (pendingMapAction.type === "militaryBase") {
      const v = validateClientMilitaryBasePreview(gx, gy);
      if (!v.ok) {
        notifyPurchaseError(v.reason || "military_invalid");
        return;
      }
      wsSendJson({ type: "purchaseMilitaryBase", x: gx, y: gy });
      pendingMapAction = null;
      mapHoverGx = -1;
      mapHoverGy = -1;
      setPendingHint();
      return;
    }
  }

  const now = effectiveClientUiNowMs();
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
    if (!cellTouchesTeamTerritoryClient(gx, gy, myTeamId, computeClientBaseConnectedPixelKeys(myTeamId | 0))) {
      notifyReject(onEnemyFlag ? "enemy_base_not_adjacent" : "not_adjacent");
      lastPlaceAt = 0;
      return;
    }

    const wHpEnemy = clientPixelWallHpAt(gx, gy);
    const oTid = clientPixelTeamIdAt(gx, gy);
    if (!onEnemyFlag && wHpEnemy > 0 && oTid != null && (oTid | 0) !== (myTeamId | 0)) {
      sendPixelOnline(gx, gy);
      updateToolbarHud();
      return;
    }

    if (onEnemyFlag) {
      sendPixelOnline(gx, gy);
      playPixelPlace();
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
    playPixelPlace();
    updateToolbarHud();
  } else {
    pixels.set(`${gx},${gy}`, selectedColor);
    if (boardVfx) {
      boardVfx.popPixel(gx, gy, PALETTE[selectedColor] ?? "#ffffff", getVfxTransform());
    }
    playPixelPlace();
    if (COOLDOWN_MS > 0) {
      updateToolbarHud();
    }
    schedulePersist();
    draw();
  }
}

function showCooldown(_ms) {
  /** Состояние пикселя — в `#toolbar-pixel-timer` под рядом кнопок (`.toolbar__hud-row`). */
  updateToolbarHud();
}

function setupToolbarSession() {
  if (!btnToolbarSession) return;
  btnToolbarSession.addEventListener("click", () => {
    const online = wantOnline && getWsUrl();
    if (online) {
      hideRoundEndedOverlay();
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
        if (pendingMapAction?.type === "militaryBase" || pendingMapAction?.type === "baseRepair") {
          const rect = canvas.getBoundingClientRect();
          const { gx, gy } = screenToGrid(t.clientX - rect.left, t.clientY - rect.top);
          if (mapHoverGx !== gx || mapHoverGy !== gy) {
            mapHoverGx = gx;
            mapHoverGy = gy;
            scheduleCanvasFrame();
          }
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
    "pointermove",
    (e) => {
      if (pendingMapAction?.type !== "militaryBase" && pendingMapAction?.type !== "baseRepair") return;
      const rect = canvas.getBoundingClientRect();
      const sx = e.clientX - rect.left;
      const sy = e.clientY - rect.top;
      const { gx, gy } = screenToGrid(sx, sy);
      if (mapHoverGx !== gx || mapHoverGy !== gy) {
        mapHoverGx = gx;
        mapHoverGy = gy;
        scheduleCanvasFrame();
      }
    },
    { passive: true }
  );

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
  await tryConsumeTelegramBridgeFromUrl();
  syncWelcomeOnboardingLayout();
  await loadRegions();
  loadFromStorage();
  initGameAudio();
  registerSpatialAudioListener(() => {
    if (!canvas) return { gx: gridW * 0.5, gy: gridH * 0.5 };
    const rect = canvas.getBoundingClientRect();
    return screenToGrid(rect.width * 0.5, rect.height * 0.5);
  });
  registerSpatialAmbientAnchor(() => ({ gx: gridW * 0.5, gy: gridH * 0.5 }));
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
  setupLeaderboardPanelUi();
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
    if (document.visibilityState === "visible") {
      const now = Date.now();
      if (now - lastVisibilityWalletRefreshAt >= 2500) {
        lastVisibilityWalletRefreshAt = now;
        sendClientProfileToServer();
      }
      /* Один кадр карты после возврата — экран не «пустой» до следующего тика. */
      scheduleDraw();
    }
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
