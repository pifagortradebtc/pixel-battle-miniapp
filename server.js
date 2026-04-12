/**
 * Статика + WebSocket: карта, только пользовательские команды (динамические).
 * Публичные команды — в списке для вступления. Цвет при создании — из палитры (или автоподбор); смена после создания запрещена.
 * Запуск: npm start
 */

import http from "http";
import fs from "fs";
import path from "path";
import crypto from "crypto";
import { fileURLToPath } from "url";
import { WebSocketServer } from "ws";
import {
  BASE_ACTION_COOLDOWN_SEC,
  PRICES_QUANT,
  RECOVERY_BUFF_DURATION_MS,
  getCurrentCooldownMs,
  getEffectiveRecoverySec,
  quantToUsdt,
  stageAllows,
  tournamentStage,
} from "./lib/tournament-economy.js";
import { createWalletBackend } from "./lib/wallet-backend.js";
import {
  createNowpaymentInvoice,
  verifyNowpaymentsSignature,
  verifyNowpaymentsSignatureRaw,
  API_BASE_PROD,
  API_BASE_SANDBOX,
} from "./lib/nowpayments-api.js";
import { verifyTelegramWebAppInitData } from "./lib/telegram-webapp.js";
import {
  clampTournamentTimeScale,
  reanchorRoundStartForScaleChange,
  TOURNAMENT_TIME_SCALE_DEFAULT,
} from "./lib/tournament-time.js";
import { SlidingWindowRateLimiter } from "./lib/rate-limit.js";
import {
  ROUND_ZERO_POST_GO_WARMUP_MS,
  WARMUP_MS,
  battleDurationForRound,
  DUEL_INSTANT_WIN_SCORE_SHARE,
} from "./lib/tournament-flow.js";
import {
  aggregateScoresFromPixels,
  computeTotalAvailableScore,
} from "./lib/scoring.js";
import {
  buildBattleEventsClientPayload,
  cellsInManhattanBall,
  computeBattleScoringSnapshot,
  computeSeismicManhattanBalls,
  eventWindowEndMs,
  getNextTimelineEvent,
  getRoundTimeline,
  isEventActiveAt,
  MANUAL_BATTLE_EVENT_HELP_RU,
  MANUAL_TELEGRAM_CMD_FIRST_WORDS,
  mergeManualBattleSlotsIntoSnapshot,
  resolveManualBattleCommandToTimelineDef,
} from "./lib/battle-events.js";
import {
  FLAG_BASE_MAX_HP,
  FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC,
  FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS,
  FLAG_REGEN_IDLE_MS,
  FLAG_WARN_THRESHOLDS,
  computeEffectiveBaseHp,
  flagCellFromSpawn,
} from "./lib/flag-capture.js";
import {
  TERRITORY_ISOLATION_GRACE_MS,
  computeIsolatedTerritoryGroups,
} from "./lib/territory-isolation.js";
import { isWorldMapWaterPixel } from "./lib/world-map-water.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const WS_PATH = "/ws";

/** Создаётся после http.createServer; до этого broadcast/stats не трогают клиентов. */
/** @type {import("ws").WebSocketServer | null} */
let wss = null;

const DATA_DIR = path.join(ROOT, "data");
/** @type {Awaited<ReturnType<typeof createWalletBackend>>} */
const walletStore = await createWalletBackend(DATA_DIR);

/** Пакеты пополнения: бонус в квантах (1 USDT = 7 квантов). Кредит USDT += bonusQuant/7. */
const DEPOSIT_PACK_BONUS_QUANT = new Map([
  [1, 0],
  [5, 3],
  [10, 10],
  [20, 25],
  [50, 80],
  [300, 500],
]);

function depositBonusQuantAllowed(amountUsdt, bonusQuant) {
  const bt = bonusQuant | 0;
  const rounded = Math.round(Number(amountUsdt) * 100) / 100;
  const match = [...DEPOSIT_PACK_BONUS_QUANT.keys()].find((k) => Math.abs(k - rounded) < 1e-6);
  if (match === undefined) return bt === 0;
  return DEPOSIT_PACK_BONUS_QUANT.get(match) === bt;
}

const NOWPAYMENTS_API_KEY = (process.env.NOWPAYMENTS_API_KEY || "").trim();
const NOWPAYMENTS_IPN_SECRET = (process.env.NOWPAYMENTS_IPN_SECRET || "").trim();
/** USDT на Binance Smart Chain (BEP20) в NOWPayments — обычно `usdtbsc` */
const NOWPAYMENTS_PAY_CURRENCY = (process.env.NOWPAYMENTS_PAY_CURRENCY || "usdtbsc").trim().toLowerCase();
/** База суммы счёта: `usdtbsc` = та же сеть, что оплата — на инвойсе ~ровно N USDT, без пересчёта из USD */
const NOWPAYMENTS_PRICE_CURRENCY = (process.env.NOWPAYMENTS_PRICE_CURRENCY || "usdtbsc").trim().toLowerCase();
const PUBLIC_BASE_URL = (process.env.PUBLIC_BASE_URL || process.env.APP_URL || "").replace(/\/$/, "");
const NOWPAYMENTS_API_BASE = /^true$/i.test(String(process.env.NOWPAYMENTS_SANDBOX || "").trim())
  ? API_BASE_SANDBOX
  : API_BASE_PROD;

const TRUST_PROXY = /^(1|true|yes)$/i.test(String(process.env.TRUST_PROXY || "").trim());
const WS_MAX_CONN_PER_IP = Math.min(200, Math.max(3, Number(process.env.WS_MAX_CONN_PER_IP) || 40));
const WS_MSG_PER_SEC = Math.min(200, Math.max(8, Number(process.env.WS_MSG_PER_SEC) || 45));
const WS_PIXEL_BURST_PER_SEC = Math.min(40, Math.max(2, Number(process.env.WS_PIXEL_BURST_PER_SEC) || 10));
const API_DEPOSIT_PER_MIN = Math.min(500, Math.max(2, Number(process.env.API_DEPOSIT_PER_MIN) || 25));
const API_IPN_PER_MIN = Math.min(20000, Math.max(20, Number(process.env.API_IPN_PER_MIN) || 400));
const MAX_DEPOSIT_USDT = Math.min(1e9, Math.max(1, Number(process.env.MAX_DEPOSIT_USDT) || 100_000));
const TELEGRAM_INITDATA_MAX_AGE_SEC = Math.min(604800, Math.max(120, Number(process.env.TELEGRAM_INITDATA_MAX_AGE_SEC) || 86400));
const HTTP_BODY_MAX = Math.min(2_000_000, Math.max(4096, Number(process.env.HTTP_BODY_MAX) || 65536));

const apiDepositLimiter = new SlidingWindowRateLimiter();
const apiIpnLimiter = new SlidingWindowRateLimiter();
const wsMsgLimiter = new SlidingWindowRateLimiter();
const wsPixelBurstLimiter = new SlidingWindowRateLimiter();
const claimAttemptLimiter = new SlidingWindowRateLimiter();
const wsJoinLimiter = new SlidingWindowRateLimiter();
const flagTeamHitLimiter = new SlidingWindowRateLimiter();
/** Покупки по WebSocket: защита от спама кликов / мультивкладок (на ключ игрока). */
const wsPurchaseLimiter = new SlidingWindowRateLimiter();
const WS_PURCHASE_PER_10S = Math.min(40, Math.max(4, Number(process.env.WS_PURCHASE_PER_10S) || 12));

/** Лог таймлайна событий раунда (elapsed / активные / следующее). */
const DEBUG_ROUND_EVENTS = /^true$/i.test(String(process.env.DEBUG_ROUND_EVENTS || "").trim());

/** Redis Pub/Sub: общий канал для нескольких инстансов (Render scale). Пусто — режим один процесс. */
const REDIS_URL = (process.env.REDIS_URL || "").trim();
const REDIS_GAME_CHANNEL = (process.env.REDIS_GAME_CHANNEL || "pixel-battle:game").trim();

function isClusterLeader() {
  if (!REDIS_URL) return true;
  const v = String(process.env.CLUSTER_LEADER || "").trim().toLowerCase();
  if (v === "false" || v === "0" || v === "no") return false;
  if (v === "true" || v === "1" || v === "yes") return true;
  // Redis задан, переменная не задана: один веб-инстанс + Redis (частый случай на Render) — лидер.
  // При scale > 1 задайте CLUSTER_LEADER=false на всех кроме одного (там true).
  return true;
}

/** @type {((raw: string) => void | Promise<void>) | null} */
let redisGamePublish = null;

/** @type {Map<string, number>} IP → число активных WS (best-effort). */
const activeWsByIp = new Map();

/** IP клиента; X-Forwarded-For только при TRUST_PROXY=1 (за доверенным прокси). */
function getClientIpFromReq(req) {
  if (!req || !req.socket) return "0.0.0.0";
  let raw = "";
  if (TRUST_PROXY) {
    const xff = req.headers["x-forwarded-for"];
    if (typeof xff === "string" && xff.trim()) {
      raw = xff.split(",")[0].trim();
    }
  }
  if (!raw) {
    raw = req.socket.remoteAddress || "";
    raw = raw.replace(/^::ffff:/, "");
  }
  return raw.slice(0, 64) || "0.0.0.0";
}

/** Разрешение исходной карты `data/regions-360.json` (даунсэмпл на меньшие раунды). */
const BASE_GRID = 360;
/** Сторона сетки по раунду: 0 массовый, 1 полуфинал, 2 финал команд, 3 дуэль. */
const GRID_SIZE_MASS = 360;
const GRID_SIZE_SEMI = 320;
const GRID_SIZE_FINAL_TEAMS = 160;
const GRID_SIZE_DUEL = 64;
let gridW = GRID_SIZE_MASS;
let gridH = GRID_SIZE_MASS;
/** @deprecated используйте getCurrentCooldownMs для игрока */
const COOLDOWN_MS = 0;
/** Длительность раунда по умолчанию (100 ч); фактическое значение — roundDurationMs (задаётся «go 12» и т.д.) */
const ROUND_MS = 100 * 60 * 60 * 1000;
/** Длина фазы боя текущего раунда в мс (после разминки). */
let roundDurationMs = ROUND_MS;
const MAX_PER_TEAM_FIRST = 200;
const MAX_PER_TEAM_NEXT = 10;
/** Финальный раунд (команды по 2 человека) */
const MAX_PER_TEAM_FINAL = 2;
/**
 * После полуфинала (конец раунда с индексом 1, на карте 320×320, в команде до 10 чел.)
 * в следующий раунд (финал команд, в команде до 2 чел.) проходят только первые N игроков победившей команды.
 * Порядок — порядок добавления ключей в Set участников команды на сервере.
 */
const MAX_PLAYERS_ADVANCING_FROM_SEMI = 10;

const ROUND_STATE_PATH = path.join(ROOT, "data", "round-state.json");

/** Токен бота и список user id админов (через запятую), которые могут отправить «go» для старта 1-го раунда */
const TELEGRAM_BOT_TOKEN = (process.env.TELEGRAM_BOT_TOKEN || "").trim();
/**
 * Только для локальной отладки: разрешить подставлять playerKey с клиента без проверки initData.
 * В продакшене с TELEGRAM_BOT_TOKEN должен быть false (по умолчанию).
 */
const ALLOW_CLIENT_PLAYER_KEY = /^true$/i.test(String(process.env.ALLOW_CLIENT_PLAYER_KEY || "").trim());
/** Игровые действия и кошелёк привязаны к tg_<id> только после проверки подписи initData. */
const REQUIRE_TELEGRAM_AUTH_FOR_PLAY =
  Boolean(TELEGRAM_BOT_TOKEN) && !ALLOW_CLIENT_PLAYER_KEY;
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

/** По умолчанию выкл.: «рестарт»/restart в боте не перезапускает процесс (избегаем случайного сброса всех сессий). */
const TELEGRAM_ENABLE_PROCESS_RESTART = /^true$/i.test(String(process.env.TELEGRAM_ENABLE_PROCESS_RESTART || "").trim());

/**
 * Mini App URL (одно из):
 * - Прямой HTTPS игры, тот же что в BotFather → Mini App (рекомендуется): `https://xxx.onrender.com/`
 * - Или `https://t.me/BotUser/shortname` — shortname должен ТОЧНО совпадать с именем Mini App в BotFather, иначе «Веб-приложение не найдено».
 */
const TELEGRAM_MINIAPP_LINK = (process.env.TELEGRAM_MINIAPP_LINK || "").trim();
const TELEGRAM_BOT_USERNAME = (process.env.TELEGRAM_BOT_USERNAME || "").replace(/^@/, "").trim();
const TELEGRAM_MINIAPP_SHORT_NAME = (process.env.TELEGRAM_MINIAPP_SHORT_NAME || "").trim();
const TELEGRAM_START_MESSAGE =
  (process.env.TELEGRAM_START_MESSAGE || "").trim() ||
  "Создай команду, захвати больше территорий, попади в финал и получи 5000 usd.";
const TELEGRAM_START_BUTTON_TEXT =
  (process.env.TELEGRAM_START_BUTTON_TEXT || "").trim() || "🕹️ Запустить игру";

function getTelegramMiniAppLaunchUrl() {
  if (TELEGRAM_MINIAPP_LINK) return TELEGRAM_MINIAPP_LINK.replace(/\/$/, "");
  if (TELEGRAM_BOT_USERNAME && TELEGRAM_MINIAPP_SHORT_NAME) {
    return `https://t.me/${TELEGRAM_BOT_USERNAME}/${TELEGRAM_MINIAPP_SHORT_NAME}`;
  }
  return "";
}

/** Публичная ссылка на чат/канал обсуждения игры (например `https://t.me/yourgroup`). Пусто — не показывать в клиенте. */
const TELEGRAM_DISCUSSION_CHAT_URL = (process.env.TELEGRAM_DISCUSSION_CHAT_URL || "").trim();

function getDiscussionChatUrlForClient() {
  const raw = TELEGRAM_DISCUSSION_CHAT_URL;
  if (!raw) return "";
  try {
    const u = new URL(raw);
    if (u.protocol !== "https:") return "";
    const host = u.hostname.toLowerCase();
    if (host !== "t.me" && host !== "telegram.me") return "";
    return u.toString();
  } catch {
    return "";
  }
}

/** Параметр после /start (реферал и т.д.) → добавляем в ссылку как ?startapp= */
function parseStartPayload(text) {
  const m = /^\/start(?:@[\w]+)?\s*(.*)$/i.exec(String(text || "").trim());
  return m ? m[1].trim() : "";
}

function buildMiniAppOpenUrl(startPayload) {
  const base = getTelegramMiniAppLaunchUrl();
  if (!base) return "";
  if (!startPayload) return base;
  if (/^https:\/\/t\.me\//i.test(base)) {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}startapp=${encodeURIComponent(startPayload)}`;
  }
  try {
    const u = new URL(base);
    u.searchParams.set("startapp", startPayload);
    return u.toString();
  } catch {
    const sep = base.includes("?") ? "&" : "?";
    return `${base}${sep}startapp=${encodeURIComponent(startPayload)}`;
  }
}

/**
 * Кнопка «Запустить игру»: для t.me/бот/shortname — поле url; для https://ваш-сайт — web_app (домен в BotFather → Mini App).
 * Иначе Telegram часто показывает «Веб-приложение не найдено», если short name в env не совпадает с BotFather.
 */
function buildTelegramStartInlineButton(launchUrl) {
  if (!launchUrl || !/^https:\/\//i.test(launchUrl)) return null;
  const row = { text: TELEGRAM_START_BUTTON_TEXT };
  if (/^https:\/\/t\.me\//i.test(launchUrl)) {
    return { ...row, url: launchUrl };
  }
  return { ...row, web_app: { url: launchUrl } };
}

function isStartCommand(text) {
  return /^\/start(?:@[\w]+)?(?:\s|$)/i.test(String(text || "").trim());
}

/** Текст похож на админ-команду (для ответа не-админам вместо полного молчания). */
function telegramMessageLooksLikePrivilegedCommand(text) {
  let norm = String(text || "")
    .trim()
    .toLowerCase()
    .replace(/^\/+/, "")
    .replace(/\s+/g, " ");
  norm = norm.replace(/^\/speed\b/, "speed");
  norm = norm.replace(/^\/go\b/, "go");
  norm = norm.replace(/^гол(\s+)/, "go$1").replace(/^гол(\d)/, "go $1");
  norm = norm.replace(/^го(\s+)/u, "go$1").replace(/^го(\d)/u, "go $1");
  const fw = (norm.split(/\s+/)[0] || "").replace(/@\w+$/i, "");
  if (fw === "go" || norm === "go" || norm.startsWith("go ")) return true;
  if (fw === "speed") return true;
  if (fw === "restart" || fw === "рестарт") return true;
  if (fw === "paint") return true;
  if (fw === "evt" || fw === "event") return true;
  return MANUAL_TELEGRAM_CMD_FIRST_WORDS.has(fw);
}

/**
 * Бесконечный баланс для выбранных аккаунтов (playerKey вида tg_<id> после валидного initData).
 * Задайте на сервере: DEV_UNLIMITED_WALLET_TG_IDS=123456789 (несколько id через запятую).
 * Либо DEV_UNLIMITED_WALLET_MATCH_ADMIN=true и добавьте id в TELEGRAM_ADMIN_IDS.
 */
function buildDevUnlimitedWalletTgSet() {
  const s = new Set();
  for (const id of (process.env.DEV_UNLIMITED_WALLET_TG_IDS || "").split(",")) {
    const n = Number(String(id).trim());
    if (Number.isFinite(n)) s.add(n);
  }
  if (/^(1|true|yes)$/i.test(String(process.env.DEV_UNLIMITED_WALLET_MATCH_ADMIN || "").trim())) {
    for (const id of TELEGRAM_ADMIN_IDS) s.add(id);
  }
  return s;
}
const DEV_UNLIMITED_WALLET_TG_IDS = buildDevUnlimitedWalletTgSet();

function isDevUnlimitedWallet(pk) {
  const m = /^tg_(\d+)$/.exec(sanitizePlayerKey(pk));
  if (!m) return false;
  return DEV_UNLIMITED_WALLET_TG_IDS.has(Number(m[1]));
}

/** @type {number} 0..3 — игровые раунды; после финала gameFinished и roundIndex может быть 3 (последний сыгранный). */
let roundIndex = 0;
/** @type {number} */
let roundStartMs = Date.now();
/**
 * Начало фазы боя (пиксели разрешены). До этого — разминка 2 мин.
 * В старых сохранениях отсутствует: тогда = roundStartMs (без отдельной разминки).
 */
let playStartMs = Date.now();
/**
 * Только для сохранения в JSON (кэш); логика — {@link getPlayStartMs}.
 * Dev-only: сжимает на реальной оси разминку, длительность боя и конец раунда.
 * Не ускоряет кулдауны, реген HP базы, лимиты ударов по флагу и прочий combat-время.
 */
let tournamentTimeScale = TOURNAMENT_TIME_SCALE_DEFAULT;
/** Первый раунд: таймер не идёт, пока админ не отправит «go» боту (если включён WAIT_FOR_TELEGRAM_GO). До «go» — свободная игра на карте. */
let roundTimerStarted = true;
/** Длительность паузы до боя в раунде 0 (мс). До «go» на таймлайн не влияет; после «go» = {@link ROUND_ZERO_POST_GO_WARMUP_MS} (или сохранённое). */
let round0WarmupMs = WARMUP_MS;
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
/** После финала дуэли — только просмотр, новых игроков нет */
let gameFinished = false;
/** Ключи playerKey, допущенные в текущий раунд (после 0-го — только победители прошлого). Пустой при roundIndex===0 = не используется. */
let eligiblePlayerKeys = new Set();

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

/** Сколько WS сейчас держат этот playerKey (несколько вкладок). */
const onlinePkRefCounts = new Map();

function trackOnlinePk(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return;
  onlinePkRefCounts.set(k, (onlinePkRefCounts.get(k) || 0) + 1);
}

function untrackOnlinePk(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return;
  const n = (onlinePkRefCounts.get(k) || 0) - 1;
  if (n <= 0) onlinePkRefCounts.delete(k);
  else onlinePkRefCounts.set(k, n);
}

function isPlayerKeyOnline(pk) {
  const k = sanitizePlayerKey(pk);
  return k ? (onlinePkRefCounts.get(k) || 0) > 0 : false;
}

function ensureWsOnlineTracked(ws) {
  const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  if (!pk) return;
  if (ws._trackedPk === pk) return;
  if (ws._trackedPk) untrackOnlinePk(ws._trackedPk);
  ws._trackedPk = pk;
  trackOnlinePk(pk);
}

function attachPlayerKey(ws, msg) {
  if (ws.telegramVerified) return;
  /** В продакшене playerKey задаётся только через verifyTelegramWebAppInitData в rememberPlayerProfile. */
  if (REQUIRE_TELEGRAM_AUTH_FOR_PLAY) return;
  if (TELEGRAM_BOT_TOKEN && roundIndex > 0) return;
  const pk = sanitizePlayerKey(msg?.playerKey);
  if (pk) ws.playerKey = pk;
}

/**
 * В следующий раунд попадают только игроки из **победившей команды** прошлого раунда
 * (`teamId` — лидер по счёту очков клеток в `maybeEndRound` / `advanceToDuelRound`).
 * Остальные получают `not_eligible` / наблюдателей. Лимит «сколько команд» не задаётся отдельно:
 * его ограничивают число допущенных ключей и `getMaxPerTeam()` (10 в полуфинале, 2 в финале команд).
 */
function setEligibleKeysFromWinnerTeam(teamId, maxKeys) {
  const raw = [...(teamMemberKeys.get(teamId) || [])].map(sanitizePlayerKey).filter(Boolean);
  if (typeof maxKeys === "number" && maxKeys > 0) {
    eligiblePlayerKeys = new Set(raw.slice(0, maxKeys));
  } else {
    eligiblePlayerKeys = new Set(raw);
  }
}

function isPlayerKeyEligibleForCurrentRound(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return false;
  if (roundIndex === 0) return true;
  if (eligiblePlayerKeys.size > 0) return eligiblePlayerKeys.has(k);
  return Object.prototype.hasOwnProperty.call(winnerTokensByPlayerKey, k);
}

function applyEligibilityFromServerState(ws) {
  if (gameFinished) {
    ws.eligible = false;
    return;
  }
  const pk = sanitizePlayerKey(ws.playerKey);
  if (!pk) {
    ws.eligible = roundIndex === 0;
    return;
  }
  if (roundIndex === 0) {
    ws.eligible = true;
    return;
  }
  if (!isPlayerKeyEligibleForCurrentRound(pk)) {
    ws.eligible = false;
    return;
  }
  const tok = winnerTokensByPlayerKey[pk];
  ws.eligible = !!(tok && eligibleTokenSet.has(tok));
}

/** Сохраняет Telegram id/username для финального отчёта; при валидном initData жёстко привязывает playerKey к tg_<id>. */
async function rememberPlayerProfile(ws, msg) {
  const initData = typeof msg?.initData === "string" ? msg.initData : "";
  if (TELEGRAM_BOT_TOKEN && initData) {
    const v = verifyTelegramWebAppInitData(initData, TELEGRAM_BOT_TOKEN, {
      maxAgeSec: TELEGRAM_INITDATA_MAX_AGE_SEC,
    });
    if (v) {
      ws.telegramVerified = true;
      const pk = sanitizePlayerKey(`tg_${v.id}`);
      ws.playerKey = pk;
      const username = typeof v.username === "string" ? v.username.trim().slice(0, 64) : "";
      const prev = playerTelegramMeta.get(pk);
      playerTelegramMeta.set(pk, {
        id: v.id | 0,
        username: username || prev?.username || "",
      });
    }
  }
  if (!ws.telegramVerified) {
    attachPlayerKey(ws, msg);
  }
  const tu = msg?.telegramUser;
  if (!ws.telegramVerified && tu && typeof tu.id === "number") {
    const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
    if (!pk) {
      applyEligibilityFromServerState(ws);
      return;
    }
    const username = typeof tu.username === "string" ? tu.username.trim().slice(0, 64) : "";
    const prev = playerTelegramMeta.get(pk);
    playerTelegramMeta.set(pk, {
      id: tu.id | 0,
      username: username || prev?.username || "",
    });
  }
  applyEligibilityFromServerState(ws);
  const pkInvite = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  /** Реферал только при подтверждённом Telegram — иначе можно привязать чужой tg_<id> к своему кошельку. */
  if (pkInvite && ws.telegramVerified) {
    let invTg = msg?.inviteTelegramId ?? msg?.inviteRef;
    if (typeof invTg === "string" && /^\d+$/.test(String(invTg).trim())) {
      invTg = Number(String(invTg).trim());
    }
    if (typeof invTg === "number" && invTg > 0 && Number.isFinite(invTg)) {
      const refPk = sanitizePlayerKey(`tg_${Math.floor(invTg)}`);
      if (refPk && refPk !== pkInvite) {
        const eu = await walletStore.getOrCreateUser(pkInvite);
        if (!eu.invitedByPlayerKey) {
          eu.invitedByPlayerKey = refPk;
          await walletStore.save();
        }
      }
    }
    ensureWsOnlineTracked(ws);
  }
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

/** Сбрасывает ws.teamId, если команда удалена или этот playerKey не в составе (после смены раунда / рассинхрона). */
function reconcileWsTeamMembership(ws) {
  if (ws.teamId == null) return;
  const tid = ws.teamId;
  const dt = dynamicTeams.find((t) => t.id === tid);
  if (!dt || dt.eliminated) {
    ws.teamId = null;
    return;
  }
  const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  if (!pk) return;
  const set = teamMemberKeys.get(tid);
  if (!set || !set.has(pk)) {
    ws.teamId = null;
  }
}

/** Цвет команды #RRGGBB */
function sanitizeHexColor(s) {
  const t = String(s ?? "")
    .trim()
    .replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(t)) return "";
  return `#${t.toLowerCase()}`;
}

/**
 * 30 ярких цветов для выбора при создании команды (как на клиенте в TEAM_CREATE_PALETTE).
 * После создания смена цвета запрещена — принимаем только значения из этого списка.
 */
const TEAM_CREATE_COLORS = [
  "#ff1744",
  "#ff3d00",
  "#ff6d00",
  "#ffc400",
  "#ffea00",
  "#c6ff00",
  "#76ff03",
  "#00e676",
  "#00c853",
  "#00bfa5",
  "#00b8d4",
  "#00e5ff",
  "#00b0ff",
  "#2979ff",
  "#304ffe",
  "#6200ea",
  "#651fff",
  "#aa00ff",
  "#d500f9",
  "#e040fb",
  "#f50057",
  "#e91e63",
  "#c51162",
  "#ff4081",
  "#18ffff",
  "#64ffda",
  "#eeff41",
  "#ffab40",
  "#000000",
  "#ffffff",
];

const TEAM_CREATE_COLOR_SET = new Set(TEAM_CREATE_COLORS);

/** Цвет из сообщения createTeam: только из белого списка. */
function pickCreateTeamColorFromMessage(msgColor) {
  const hex = sanitizeHexColor(msgColor);
  if (!hex || !TEAM_CREATE_COLOR_SET.has(hex)) return "";
  return hex;
}

function pickAutoTeamColor(name, emoji, salt) {
  const raw = `${name}\0${emoji}\0${salt}`;
  const h = crypto.createHash("sha256").update(raw, "utf8").digest();
  const idx = h.readUInt32BE(0) % TEAM_CREATE_COLORS.length;
  return TEAM_CREATE_COLORS[idx];
}

/** Стартовая база команды на карте (только суша). */
const TEAM_SPAWN_SIZE = 6;
const TEAM_SPAWN_GAP = 1;

/** Сохранённые одноразовые шаги событий (сейсмика / предупреждение). */
let battleEventsApplied = {};

/** Ручные события карты (Telegram evt …): ключ команды → untilMs (конец действия). Только лидер кластера меняет. */
const manualBattleSlotsByCmd = new Map();

function normalizeManualBattleCmdKey(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/^\/+/, "");
  if (s === "золото") return "gold";
  return s;
}

function pruneExpiredManualBattleSlots(nowMs = Date.now()) {
  for (const [k, u] of [...manualBattleSlotsByCmd]) {
    if (typeof u === "number" && u <= nowMs) manualBattleSlotsByCmd.delete(k);
  }
}

function getActiveManualBattleSlots(nowMs = Date.now()) {
  pruneExpiredManualBattleSlots(nowMs);
  /** @type {{ cmd: string, untilMs: number }[]} */
  const out = [];
  for (const [cmd, untilMs] of manualBattleSlotsByCmd) {
    if (typeof untilMs === "number" && untilMs > nowMs) {
      out.push({ cmd: normalizeManualBattleCmdKey(cmd), untilMs });
    }
  }
  return out;
}

function computeBattleScoringSnapshotWithManualBattle(nowMs, ctx) {
  const snap = computeBattleScoringSnapshot(nowMs, ctx);
  mergeManualBattleSlotsIntoSnapshot(snap, getActiveManualBattleSlots(nowMs), nowMs, ctx);
  return snap;
}

function broadcastManualBattleSyncAndStats() {
  broadcast({
    type: "manualBattleSync",
    slots: Object.fromEntries(manualBattleSlotsByCmd),
  });
  scheduleStatsBroadcast();
}

/** Чтобы не слать повторно roundEvent start/end при каждом тике. */
let lastAnnouncedActiveEventIds = new Set();

function getBattleEventsContext(nowMs) {
  if (gameFinished) return null;
  if (isWarmupPhaseNow()) return null;
  if (roundIndex === 0 && !roundTimerStarted) return null;
  if (!landGrid) return null;
  const playStartMs = getPlayStartMs();
  const battleEndMs = getRoundBattleEndRealMs();
  if (nowMs < playStartMs || nowMs >= battleEndMs) return null;
  return {
    roundIndex,
    playStartMs,
    battleEndMs,
    gridW,
    gridH,
    landGrid,
  };
}

function countOnlineMembersForTeam(teamId) {
  const keys = teamMemberKeys.get(teamId);
  if (!keys || keys.size === 0) return 0;
  let n = 0;
  for (const pk of keys) {
    if (isPlayerKeyOnline(pk)) n++;
  }
  return n;
}

/**
 * Множитель синергии по командам (только очки территории), см. round timeline.
 * @param {import("./lib/battle-events.js").BattleScoringSnapshot} snap
 */
function buildSynergyMultByTeamMap(snap) {
  if (!snap?.teamSynergy?.active) return null;
  const minO = snap.teamSynergy.minOnline | 0;
  const mult = typeof snap.teamSynergy.mult === "number" ? snap.teamSynergy.mult : 1.12;
  /** @type {Map<number, number>} */
  const m = new Map();
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    if (countOnlineMembersForTeam(tid) >= minO) m.set(tid, mult);
    else m.set(tid, 1);
  }
  return m;
}

function getGlobalEventPayload(nowMs = Date.now()) {
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) {
    return {
      active: false,
      kind: null,
      title: "",
      subtitle: "",
      until: 0,
      battleEvents: { serverNow: nowMs, active: false, layers: [], primary: null, battleEndsAt: 0 },
      debugRoundEvents: DEBUG_ROUND_EVENTS ? { note: "warmup_or_idle" } : undefined,
    };
  }
  const snap = computeBattleScoringSnapshotWithManualBattle(nowMs, ctx);
  const be = buildBattleEventsClientPayload(snap, nowMs, ctx.battleEndMs);
  const pr = be.primary;
  /** @type {Record<string, unknown> | undefined} */
  let debugRoundEvents;
  if (DEBUG_ROUND_EVENTS) {
    const elapsed = nowMs - ctx.playStartMs;
    const timeline = getRoundTimeline(roundIndex);
    const activeIds = [];
    for (const ev of timeline) {
      if (isEventActiveAt(nowMs, ctx.playStartMs, ctx.battleEndMs, ev)) activeIds.push(ev.eventId);
    }
    debugRoundEvents = {
      roundIndex,
      elapsedMs: elapsed,
      activeEventIds: activeIds,
      next: getNextTimelineEvent(nowMs, roundIndex, ctx.playStartMs, ctx.battleEndMs),
    };
  }
  return {
    active: !!be.active,
    kind: pr ? pr.kind : null,
    title: pr && pr.title ? pr.title : "",
    subtitle: pr && pr.subtitle ? pr.subtitle : "",
    until: pr && typeof pr.untilMs === "number" ? pr.untilMs : 0,
    battleEvents: be,
    debugRoundEvents,
  };
}

function buildBattleProtectedMask() {
  const mask = new Uint8Array(gridW * gridH);
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    for (let yy = t.spawnY0; yy < t.spawnY0 + TEAM_SPAWN_SIZE; yy++) {
      for (let xx = t.spawnX0; xx < t.spawnX0 + TEAM_SPAWN_SIZE; xx++) {
        if (xx >= 0 && xx < gridW && yy >= 0 && yy < gridH) mask[yy * gridW + xx] = 1;
      }
    }
  }
  return mask;
}

function applySeismicForLeader(defId, uniqueEventKey) {
  const play = getPlayStartMs();
  const protectedMask = buildBattleProtectedMask();
  const balls = computeSeismicManhattanBalls(roundIndex, play, defId, gridW, gridH, landGrid, protectedMask);
  /** @type [number, number][] */
  const cells = [];
  for (const b of balls) {
    const part = cellsInManhattanBall(b, landGrid, protectedMask, gridW, gridH);
    for (let i = 0; i < part.length; i++) cells.push(part[i]);
  }
  const seen = new Set();
  /** @type [number, number][] */
  const unique = [];
  for (let i = 0; i < cells.length; i++) {
    const x = cells[i][0] | 0;
    const y = cells[i][1] | 0;
    const k = `${x},${y}`;
    if (seen.has(k)) continue;
    seen.add(k);
    unique.push([x, y]);
  }
  /** @type [number, number][] */
  const cleared = [];
  for (let i = 0; i < unique.length; i++) {
    const x = unique[i][0];
    const y = unique[i][1];
    const key = `${x},${y}`;
    const v = pixels.get(key);
    if (v == null) continue;
    if ((pixelTeam(v) | 0) === 0) continue;
    pixels.delete(key);
    cleared.push([x, y]);
  }
  if (!cleared.length) return;
  const tl = getRoundTimeline(roundIndex);
  const sev = tl.find((e) => e.eventType === "seismic");
  const aftermathMs =
    sev && typeof sev.payload?.aftermathMs === "number" ? sev.payload.aftermathMs | 0 : 20_000;
  const impactNow = Date.now();
  broadcast({
    type: "seismicImpact",
    eventId: uniqueEventKey,
    cells: cleared,
    aftermathUntilMs: impactNow + aftermathMs,
  });
  afterTerritoryMutation();
}

function tickRoundEventTransitions(nowMs) {
  if (!isClusterLeader()) return;
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) return;
  const timeline = getRoundTimeline(roundIndex);
  /** @type {Set<string>} */
  const active = new Set();
  for (let i = 0; i < timeline.length; i++) {
    const ev = timeline[i];
    if (ev.eventType === "seismic") continue;
    if (!isEventActiveAt(nowMs, ctx.playStartMs, ctx.battleEndMs, ev)) continue;
    active.add(ev.eventId);
    if (!lastAnnouncedActiveEventIds.has(ev.eventId)) {
      const until = eventWindowEndMs(ev, ctx.playStartMs, ctx.battleEndMs);
      broadcast({
        type: "roundEvent",
        phase: "start",
        eventId: ev.eventId,
        eventType: ev.eventType,
        title: ev.uiTitle,
        subtitle: ev.uiSubtitle,
        untilMs: until,
        roundIndex,
      });
    }
  }
  for (const prev of lastAnnouncedActiveEventIds) {
    if (!active.has(prev)) {
      broadcast({ type: "roundEvent", phase: "end", eventId: prev, roundIndex });
    }
  }
  lastAnnouncedActiveEventIds = active;

  if (DEBUG_ROUND_EVENTS && Math.floor(nowMs / 10_000) !== tickRoundEventTransitions._lastLogDeca) {
    tickRoundEventTransitions._lastLogDeca = Math.floor(nowMs / 10_000);
    const elapsed = nowMs - ctx.playStartMs;
    const next = getNextTimelineEvent(nowMs, roundIndex, ctx.playStartMs, ctx.battleEndMs);
    console.log(
      `[round-events] ri=${roundIndex} elapsed=${(elapsed / 60000).toFixed(1)}m active=${[...active].join(",") || "—"} next=${next.next?.eventId ?? "—"}`
    );
  }
}
tickRoundEventTransitions._lastLogDeca = -1;

function tickBattleEvents(nowMs) {
  if (!isClusterLeader()) return;
  if (gameFinished || isWarmupPhaseNow()) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) return;

  tickRoundEventTransitions(nowMs);

  const timeline = getRoundTimeline(roundIndex);
  for (let i = 0; i < timeline.length; i++) {
    const def = timeline[i];
    if (def.eventType !== "seismic") continue;
    const id = def.eventId;
    const warnKey = `${id}__warn`;
    const atMs = ctx.playStartMs + def.startOffsetMs;
    const warnLead = Math.max(3500, Number(def.warnLeadMs) || 4500);

    if (!battleEventsApplied[warnKey] && nowMs >= atMs - warnLead && nowMs < atMs) {
      battleEventsApplied[warnKey] = true;
      const protectedMask = buildBattleProtectedMask();
      const balls = computeSeismicManhattanBalls(roundIndex, ctx.playStartMs, id, gridW, gridH, landGrid, protectedMask);
      const regions = balls.map((b) => ({
        kind: "manhattan_ball",
        cx: b.cx,
        cy: b.cy,
        r: b.r,
      }));
      broadcast({ type: "seismicPreview", eventId: id, regions, impactAtMs: atMs });
      saveRoundState();
    }

    if (!battleEventsApplied[id] && nowMs >= atMs) {
      battleEventsApplied[id] = true;
      applySeismicForLeader(id, id);
      saveRoundState();
    }
  }
}

function resetBattleEventsStateForNewBattleRound() {
  battleEventsApplied = {};
  lastAnnouncedActiveEventIds = new Set();
  manualBattleSlotsByCmd.clear();
}

function teamsForMeta() {
  return dynamicTeams.map((t) => ({
    id: t.id,
    name: t.name,
    emoji: t.emoji,
    color: t.color,
    solo: !!t.solo,
    eliminated: !!t.eliminated,
    spawn:
      !t.solo && typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number"
        ? { x0: t.spawnX0, y0: t.spawnY0, w: TEAM_SPAWN_SIZE, h: TEAM_SPAWN_SIZE }
        : null,
  }));
}

const DYNAMIC_TEAMS_PATH = path.join(ROOT, "data", "dynamic-teams.json");

/** @type {{ id: number, name: string, emoji: string, color: string, editToken?: string, solo?: boolean, soloResumeToken?: string, spawnX0?: number, spawnY0?: number, eliminated?: boolean }[]} */
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
          id: Number(t.id) | 0,
          color,
          solo: !!t.solo,
          eliminated: !!t.eliminated,
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

function isTeamEliminated(teamId) {
  const t = dynamicTeams.find((x) => x.id === teamId);
  return !!(t && t.eliminated);
}

function validTeamId(teamId) {
  const t = dynamicTeams.find((x) => x.id === teamId);
  return !!(t && !t.solo && !t.eliminated);
}

function getMaxPerTeam() {
  if (gameFinished) return 0;
  if (roundIndex === 0) return MAX_PER_TEAM_FIRST;
  if (roundIndex === 1) return MAX_PER_TEAM_NEXT;
  if (roundIndex === 2) return MAX_PER_TEAM_FINAL;
  if (roundIndex === 3) return 1;
  return 0;
}

function saveRoundState() {
  try {
    playStartMs = getPlayStartMs();
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(
      ROUND_STATE_PATH,
      JSON.stringify({
        roundIndex,
        roundStartMs,
        playStartMs,
        roundDurationMs,
        tournamentTimeScale: getTournamentTimeScale(),
        round0WarmupMs,
        roundTimerStarted,
        eligibleTokens: [...eligibleTokenSet],
        eligiblePlayerKeys: [...eligiblePlayerKeys],
        gameFinished,
        winnerTokensByPlayerKey,
        battleEventsApplied,
        manualBattleSlots: Object.fromEntries(manualBattleSlotsByCmd),
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
      if (typeof j.playStartMs === "number" && Number.isFinite(j.playStartMs)) {
        playStartMs = j.playStartMs;
      } else {
        playStartMs = roundStartMs;
      }
      if (typeof j.roundDurationMs === "number" && j.roundDurationMs >= 1000 && j.roundDurationMs <= 8760 * 3600000) {
        roundDurationMs = j.roundDurationMs;
      } else {
        roundDurationMs = battleDurationForRound(roundIndex);
      }
      if (typeof j.tournamentTimeScale === "number" && j.tournamentTimeScale >= 1) {
        tournamentTimeScale = clampTournamentTimeScale(j.tournamentTimeScale);
      } else {
        tournamentTimeScale = TOURNAMENT_TIME_SCALE_DEFAULT;
      }
      if (typeof j.round0WarmupMs === "number" && Number.isFinite(j.round0WarmupMs)) {
        const w = Math.round(j.round0WarmupMs);
        round0WarmupMs = w >= 5000 && w <= 600000 ? w : WARMUP_MS;
      } else {
        round0WarmupMs = WARMUP_MS;
      }
      if (typeof j.roundTimerStarted === "boolean") {
        roundTimerStarted = j.roundTimerStarted;
      } else {
        roundTimerStarted = true;
      }
      eligibleTokenSet = new Set(Array.isArray(j.eligibleTokens) ? j.eligibleTokens : []);
      eligiblePlayerKeys = new Set(
        Array.isArray(j.eligiblePlayerKeys) ? j.eligiblePlayerKeys.map(sanitizePlayerKey).filter(Boolean) : []
      );
      if (typeof j.gameFinished === "boolean") gameFinished = j.gameFinished;
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
      if (eligiblePlayerKeys.size === 0 && roundIndex > 0 && winnerTokensByPlayerKey && typeof winnerTokensByPlayerKey === "object") {
        eligiblePlayerKeys = new Set(Object.keys(winnerTokensByPlayerKey).map(sanitizePlayerKey).filter(Boolean));
      }
      if (roundIndex >= 1 || gameFinished) roundTimerStarted = true;
      playStartMs = getPlayStartMs();
      if (j.battleEventsApplied && typeof j.battleEventsApplied === "object" && !Array.isArray(j.battleEventsApplied)) {
        battleEventsApplied = { ...j.battleEventsApplied };
      } else {
        battleEventsApplied = {};
      }
      manualBattleSlotsByCmd.clear();
      if (j.manualBattleSlots && typeof j.manualBattleSlots === "object" && !Array.isArray(j.manualBattleSlots)) {
        for (const [k, v] of Object.entries(j.manualBattleSlots)) {
          const u = Number(v);
          if (Number.isFinite(u) && u > 0) manualBattleSlotsByCmd.set(normalizeManualBattleCmdKey(k), u);
        }
      }
    } else {
      roundIndex = 0;
      roundStartMs = Date.now();
      tournamentTimeScale = TOURNAMENT_TIME_SCALE_DEFAULT;
      playStartMs = roundStartMs;
      roundDurationMs = battleDurationForRound(0);
      eligibleTokenSet = new Set();
      gameFinished = false;
      winnerTokensByPlayerKey = {};
      battleEventsApplied = {};
      manualBattleSlotsByCmd.clear();
      roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
      round0WarmupMs = WARMUP_MS;
      saveRoundState();
    }
  } catch (e) {
    console.warn("round-state load:", e.message);
    roundIndex = 0;
    roundStartMs = Date.now();
    tournamentTimeScale = TOURNAMENT_TIME_SCALE_DEFAULT;
    playStartMs = roundStartMs;
    roundDurationMs = battleDurationForRound(0);
    eligibleTokenSet = new Set();
    gameFinished = false;
    winnerTokensByPlayerKey = {};
    battleEventsApplied = {};
    manualBattleSlotsByCmd.clear();
    roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
    round0WarmupMs = WARMUP_MS;
  }
}

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

/** @type {Uint8Array | null} исходный регион 360×360 (даунсэмпл под раунд; 0 вода, ≥2 суша). */
let baseRegion360 = null;
/** @type {Uint8Array | null} RGB плаката 360×360 для запрета ставки на «визуальную воду» при cells=суша. */
let baseRgb360 = null;
try {
  const raw = fs.readFileSync(path.join(ROOT, "data", "regions-360.json"), "utf8");
  const j = JSON.parse(raw);
  baseRegion360 = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (baseRegion360.length !== BASE_GRID * BASE_GRID) {
    console.warn("regions-360.json: неверный размер сетки");
    baseRegion360 = null;
  }
  if (j.rgbBase64 && typeof j.rgbBase64 === "string") {
    baseRgb360 = Uint8Array.from(Buffer.from(j.rgbBase64, "base64"));
    if (baseRgb360.length !== BASE_GRID * BASE_GRID * 3) {
      baseRgb360 = null;
    }
  }
} catch (e) {
  console.warn("Нет data/regions-360.json — npm run rasterize-world-map", e.message);
}

/** @type {Uint8Array | null} маска: 0 вода (нельзя ставить пиксель), ≠0 — суша. */
let landGrid = null;
/** @type {Uint8Array | null} 1 = можно ставить пиксель (суша по cells и не «вода» по RGB плаката). */
let playableGrid = null;
/** Веса клеток для очков (суша; по умолчанию 1; вода 0). */
let scoreWeightGrid = null;
/** Число игровых клеток суши на текущей сетке (для справки / UI). */
let landPixelsTotal = GRID_SIZE_MASS * GRID_SIZE_MASS;
/** Сумма базовых весов суши (сейчас = число клеток суши). */
let landWeightTotal = GRID_SIZE_MASS * GRID_SIZE_MASS;
/** Для тай-брейка: макс. очки команды → первый момент достижения этого макс. */
const teamPeakScoreForTiebreak = new Map();
const teamFirstHitPeakAt = new Map();

/**
 * HP базы по защищающейся команде. hp — целое после последнего удара; реген вычисляется по lastHitAt.
 * @type {Map<number, { hp: number, lastHitAt: number, attackerTeamId: number, _lastRegenBroadcastHp?: number, _flagRegenBroadcastPhase?: boolean, _lastRegenBroadcastAt?: number }>}
 */
const flagCaptureByDefender = new Map();

function clearAllFlagCaptureState() {
  flagCaptureByDefender.clear();
}

function clearFlagCaptureStateForDefender(defenderId) {
  flagCaptureByDefender.delete(defenderId | 0);
}

/** Снимок числа клеток по командам до последнего изменения (драма). До rebuildLandFromRound. */
let lastTerritoryCountSnapshot = new Map();

function gridSizeForRoundIndex(ri) {
  if (ri <= 0) return GRID_SIZE_MASS;
  if (ri === 1) return GRID_SIZE_SEMI;
  if (ri === 2) return GRID_SIZE_FINAL_TEAMS;
  if (ri === 3) return GRID_SIZE_DUEL;
  return GRID_SIZE_DUEL;
}

/** @param {number} ri — размеры: массовый 360, полуфинал 320, финал команд 160, дуэль 64 */
function rebuildLandFromRound(ri) {
  const w = gridSizeForRoundIndex(ri);
  const h = w;
  gridW = w;
  gridH = h;

  if (!baseRegion360 || baseRegion360.length !== BASE_GRID * BASE_GRID) {
    landGrid = null;
    playableGrid = null;
    scoreWeightGrid = null;
    landPixelsTotal = gridW * gridH;
    landWeightTotal = gridW * gridH;
    return;
  }

  landGrid = new Uint8Array(gridW * gridH);
  playableGrid = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const bx = Math.min(BASE_GRID - 1, Math.floor(((x + 0.5) / gridW) * BASE_GRID));
      const by = Math.min(BASE_GRID - 1, Math.floor(((y + 0.5) / gridH) * BASE_GRID));
      const idx = y * gridW + x;
      landGrid[idx] = baseRegion360[by * BASE_GRID + bx];
      let play = landGrid[idx] !== 0 ? 1 : 0;
      if (play && baseRgb360 && baseRgb360.length === BASE_GRID * BASE_GRID * 3) {
        const bi = (by * BASE_GRID + bx) * 3;
        const r = baseRgb360[bi];
        const g = baseRgb360[bi + 1];
        const b = baseRgb360[bi + 2];
        if (isWorldMapWaterPixel(r, g, b, 255)) play = 0;
      }
      playableGrid[idx] = play;
    }
  }
  applyRoundShapeMask(ri, landGrid, gridW, gridH);
  applyRoundShapeMask(ri, playableGrid, gridW, gridH);
  let landN = 0;
  for (let i = 0; i < landGrid.length; i++) {
    if (landGrid[i] !== 0) landN++;
  }
  landPixelsTotal = landN;
  scoreWeightGrid = new Float32Array(landGrid.length);
  let wsum = 0;
  for (let i = 0; i < landGrid.length; i++) {
    if (landGrid[i] !== 0) {
      scoreWeightGrid[i] = 1;
      wsum += 1;
    } else {
      scoreWeightGrid[i] = 0;
    }
  }
  landWeightTotal = wsum > 0 ? wsum : landN;
  for (const key of [...pixels.keys()]) {
    const parts = key.split(",");
    const px = Number(parts[0]);
    const py = Number(parts[1]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      pixels.delete(key);
      continue;
    }
    const pidx = py * gridW + px;
    if (
      px < 0 ||
      px >= gridW ||
      py < 0 ||
      py >= gridH ||
      !playableGrid ||
      playableGrid[pidx] === 0
    ) {
      pixels.delete(key);
    }
  }
  clearAllFlagCaptureState();
  afterTerritoryMutation();
}

function cellIsLand(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!landGrid) return false;
  return landGrid[y * gridW + x] !== 0;
}

/** Размещение пикселей и баз: суша по маске и не океан по цвету плаката. */
function cellAllowsPixelPlacement(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!playableGrid || playableGrid.length !== gridW * gridH) return cellIsLand(x, y);
  return playableGrid[y * gridW + x] !== 0;
}

/** Контекст для lib/scoring.js: roundIndex, сетка, суша, снимок событий боя. */
function buildScoringContext(nowMs = Date.now()) {
  if (!landGrid) return null;
  const ctxEv = getBattleEventsContext(nowMs);
  const battle = ctxEv ? computeBattleScoringSnapshotWithManualBattle(nowMs, ctxEv) : null;
  const synergyMultByTeamId = battle ? buildSynergyMultByTeamMap(battle) : null;
  return {
    roundIndex,
    gridW,
    gridH,
    landGrid,
    baseValueGrid: scoreWeightGrid,
    battle,
    synergyMultByTeamId,
  };
}

/**
 * Полный авторитетный пересчёт: очки и число занятых клеток по текущему `pixels` и getCellValue.
 * Вызывается из buildStatsPayload; при конце раунда — тот же путь (без отдельного кэша на кластере).
 */
function recalculateAllTeamScores(nowMs = Date.now()) {
  const ctx = buildScoringContext(nowMs);
  if (!ctx) return { agg: new Map(), totalAvailableScore: 0 };
  const agg = aggregateScoresFromPixels(pixels, pixelTeam, ctx);
  const totalAvailableScore = computeTotalAvailableScore(ctx);
  return { agg, totalAvailableScore };
}

function getTournamentTimeScale() {
  return tournamentTimeScale >= 1 ? tournamentTimeScale : TOURNAMENT_TIME_SCALE_DEFAULT;
}

function getWarmupDurationMs() {
  if (roundIndex !== 0) return WARMUP_MS;
  const w = round0WarmupMs | 0;
  return w >= 5000 && w <= 600000 ? w : WARMUP_MS;
}

/** Реальный timestamp начала боя (пиксели): roundStart + разминка в игровых мс, сжатых по scale. */
function getPlayStartMs() {
  return roundStartMs + Math.round(getWarmupDurationMs() / getTournamentTimeScale());
}

/** Реальный timestamp конца фазы боя текущего раунда. */
function getRoundBattleEndRealMs() {
  return getPlayStartMs() + Math.round(roundDurationMs / getTournamentTimeScale());
}

function applyTournamentTimeScale(newScaleRaw) {
  const next = clampTournamentTimeScale(newScaleRaw);
  const prev = getTournamentTimeScale();
  const now = Date.now();
  if (roundTimerStarted && !gameFinished && next !== prev) {
    roundStartMs = reanchorRoundStartForScaleChange(now, roundStartMs, prev, next);
  }
  tournamentTimeScale = next;
  playStartMs = getPlayStartMs();
  saveRoundState();
  schedulePlayStartBroadcast();
  broadcastTournamentTimeScaleToClients();
  return next;
}

function broadcastTournamentTimeScaleToClients() {
  broadcast({
    type: "tournamentTimeScale",
    tournamentTimeScale: getTournamentTimeScale(),
    roundStartMs,
    round0WarmupMs: getWarmupDurationMs(),
    roundTimerStarted,
    roundEndsAt: roundEndsAtForMeta(),
    playStartsAt: getPlayStartMs(),
    warmupEndsAt: getPlayStartMs(),
  });
}

function isWarmupPhaseNow() {
  if (gameFinished) return false;
  if (roundIndex === 0 && !roundTimerStarted) return false;
  return Date.now() < getPlayStartMs();
}

function clearTiebreakSnapshots() {
  teamPeakScoreForTiebreak.clear();
  teamFirstHitPeakAt.clear();
}

/** @type {ReturnType<typeof setTimeout> | null} */
let playStartBroadcastTimer = null;

/**
 * После разминки 1-го раунда: чистая карта, только 6×6 базы команд (как «старт с нуля»).
 * Всё, что успели нарисовать до боя (в т.ч. в разминке), сбрасывается.
 */
function resetMassRoundBattlefieldAfterWarmup() {
  if (!isClusterLeader()) return;

  clearAllFlagCaptureState();
  clearTiebreakSnapshots();
  resetBattleEventsStateForNewBattleRound();
  clearTeamEffectsMap();

  let teamsChanged = false;
  for (const t of dynamicTeams) {
    if (t.solo) continue;
    if (t.eliminated) teamsChanged = true;
    t.eliminated = false;
  }

  pixels.clear();

  if (!landGrid) {
    if (teamsChanged) saveDynamicTeams();
    afterTerritoryMutation();
    saveRoundState();
    broadcast(JSON.parse(fullPayload()));
    broadcast({ type: "teamsFull", teams: teamsForMeta() });
    broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    broadcastStatsImmediate();
    return;
  }

  for (const t of dynamicTeams) {
    if (t.solo) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") {
      const sp = findValidSpawnRect6();
      if (!sp) {
        console.warn("[reset-after-warmup] нет места 6×6 для команды", t.id, t.name);
        continue;
      }
      t.spawnX0 = sp.x0;
      t.spawnY0 = sp.y0;
      teamsChanged = true;
    }
    fillTeamSpawnAreaSilent(t.id, t.spawnX0, t.spawnY0, "");
  }
  if (teamsChanged) saveDynamicTeams();

  afterTerritoryMutation();
  saveRoundState();
  broadcast(JSON.parse(fullPayload()));
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
  broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
  broadcastStatsImmediate();
}

function schedulePlayStartBroadcast() {
  if (REDIS_URL && !isClusterLeader()) return;
  if (playStartBroadcastTimer) {
    clearTimeout(playStartBroadcastTimer);
    playStartBroadcastTimer = null;
  }
  if (gameFinished) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  const ps = getPlayStartMs();
  const delay = ps - Date.now();
  if (delay <= 0) return;
  playStartBroadcastTimer = setTimeout(() => {
    playStartBroadcastTimer = null;
    if (gameFinished) return;
    if (roundIndex === 0) {
      resetMassRoundBattlefieldAfterWarmup();
    }
    broadcast({
      type: "roundPlayStarted",
      roundIndex,
      tournamentStage: tournamentStage(roundIndex, false),
    });
    if (wss) {
      void Promise.all(
        [...wss.clients].filter((c) => c.readyState === 1).map((c) => sendConnectionMeta(c))
      );
    }
  }, delay);
}

function updateTiebreakFromStatsPayload(stats) {
  const rows = stats?.rows || [];
  for (const row of rows) {
    const tid = row.teamId;
    if (typeof tid !== "number") continue;
    const sc = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
    const peak = teamPeakScoreForTiebreak.get(tid) || 0;
    if (sc > peak) {
      teamPeakScoreForTiebreak.set(tid, sc);
      teamFirstHitPeakAt.set(tid, Date.now());
    }
  }
}

function checkDuelInstantWin(stats) {
  if (!isClusterLeader()) return;
  if (gameFinished || roundEnding || roundIndex !== 3) return;
  if (isWarmupPhaseNow()) return;
  const rows = stats?.rows || [];
  const top = rows[0];
  if (!top || typeof top.teamId !== "number") return;
  const total =
    typeof stats?.totalAvailableScore === "number" && stats.totalAvailableScore > 0
      ? stats.totalAvailableScore
      : 0;
  const sc = typeof top.score === "number" && Number.isFinite(top.score) ? top.score : 0;
  if (total > 0 && sc / total >= DUEL_INSTANT_WIN_SCORE_SHARE - 1e-9) {
    void finalizeGameEnd(top);
  }
}

/**
 * Раунд 0 — без маски (вся сетка из даунсэмпла regions-320).
 * Полуфинал — квадрат с отступом по краям.
 * Финал команд и дуэль — ромб (манхэттен от центра).
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
  if (ri >= 2) {
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

/** @type {Map<string, { teamId: number, ownerPlayerKey: string, shieldedUntil: number } | number>} */
const pixels = new Map();

/**
 * Изолированные карманы: ключ = groupId (каноническое множество клеток кармана).
 * Каждая связная компонента отрезанной территории — отдельная запись и свой дедлайн.
 * @type {Map<string, { teamId: number, cells: Set<string>, deadlineMs: number, groupId: string }>}
 */
let territoryIsolationByGroupId = new Map();

/** Дедуп WS/Redis: не слать territoryIsolationSync без изменений. */
let lastTerritoryIsolationSyncJson = "[]";

/** @type {Map<number, { teamRecoveryUntil: number, teamRecoverySec: number }>} */
const teamEffects = new Map();

/** Всегда число (0 = пусто/битые данные), чтобы не ломать повторные удары по флагу из‑за string vs number в JSON/Redis. */
function pixelTeam(val) {
  if (val && typeof val === "object") return Number(val.teamId) | 0;
  return Number(val) | 0;
}

function cellSetsEqual(a, b) {
  if (!(a instanceof Set) || !(b instanceof Set)) return false;
  if (a.size !== b.size) return false;
  for (const x of a) {
    if (!b.has(x)) return false;
  }
  return true;
}

function clearTerritoryIsolationState() {
  territoryIsolationByGroupId = new Map();
  lastTerritoryIsolationSyncJson = "[]";
}

/** Удалить группы команд, которых уже нет или они выбыли — без таймеров «в вакууме». */
function pruneTerritoryIsolationEliminatedTeams() {
  const alive = new Set();
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    alive.add(t.id | 0);
  }
  for (const [gid, g] of [...territoryIsolationByGroupId]) {
    if (!alive.has(g.teamId | 0)) territoryIsolationByGroupId.delete(gid);
  }
}

function removeTerritoryIsolationGroupsForTeam(teamId) {
  const tid = teamId | 0;
  for (const [gid, g] of [...territoryIsolationByGroupId]) {
    if ((g.teamId | 0) === tid) territoryIsolationByGroupId.delete(gid);
  }
}

function buildTerritoryIsolationGroupsPayload(serverNow) {
  /** @type {object[]} */
  const groups = [];
  for (const [, g] of territoryIsolationByGroupId) {
    const gid = g.groupId;
    const cells = [...g.cells]
      .sort()
      .map((k) => {
        const parts = k.split(",");
        const x = Number(parts[0]);
        const y = Number(parts[1]);
        return [x | 0, y | 0];
      });
    groups.push({
      groupId: gid,
      sig: gid,
      teamId: g.teamId | 0,
      /* Не использовать | 0 — обрезает до int32 и ломает epoch-ms (таймер изоляции → «0 с»). */
      expiresAtMs: Number.isFinite(g.deadlineMs) ? Math.trunc(g.deadlineMs) : 0,
      cells,
    });
  }
  groups.sort((a, b) => String(a.groupId).localeCompare(String(b.groupId)));
  return { serverNow, groups };
}

function broadcastTerritoryIsolationSyncIfChanged(serverNow) {
  const body = buildTerritoryIsolationGroupsPayload(serverNow);
  const j = JSON.stringify(body.groups);
  if (j === lastTerritoryIsolationSyncJson) return;
  lastTerritoryIsolationSyncJson = j;
  broadcast({
    type: "territoryIsolationSync",
    serverNow: body.serverNow,
    groups: body.groups,
  });
}

/**
 * Таймеры изоляции + нейтрализация просроченных карманов. Только лидер кластера.
 * @returns {boolean} были ли удалены клетки из pixels
 */
function advanceTerritoryIsolationState() {
  if (!isClusterLeader() || gameFinished) return false;
  pruneTerritoryIsolationEliminatedTeams();
  let pixelsMutated = false;
  /** @type {Map<string, { teamId: number, cells: Set<string>, deadlineMs: number, groupId: string }>} */
  let carry = territoryIsolationByGroupId;
  for (let iter = 0; iter < 96; iter++) {
    const now = Date.now();
    const isolatedGroups = computeIsolatedTerritoryGroups(pixels, dynamicTeams, pixelTeam, flagCellFromSpawn);
    /** @type {{ groupId: string, teamId: number, cells: Set<string>, deadlineMs: number }[]} */
    const meta = [];
    for (let i = 0; i < isolatedGroups.length; i++) {
      const p = isolatedGroups[i];
      const groupId = p.groupId;
      const old = carry.get(groupId);
      const cellSet = new Set(p.cells);
      const deadlineMs =
        old && cellSetsEqual(old.cells, cellSet) ? old.deadlineMs : now + TERRITORY_ISOLATION_GRACE_MS;
      meta.push({ groupId, teamId: p.teamId | 0, cells: cellSet, deadlineMs });
    }
    const expired = meta.filter((m) => m.deadlineMs <= now);
    if (!expired.length) {
      const nextMap = new Map();
      for (let j = 0; j < meta.length; j++) {
        const m = meta[j];
        nextMap.set(m.groupId, {
          teamId: m.teamId,
          cells: m.cells,
          deadlineMs: m.deadlineMs,
          groupId: m.groupId,
        });
      }
      territoryIsolationByGroupId = nextMap;
      broadcastTerritoryIsolationSyncIfChanged(now);
      return pixelsMutated;
    }
    /** @type {Map<string, { teamId: number, cells: Set<string>, deadlineMs: number, groupId: string }>} */
    const nextCarry = new Map();
    for (let e = 0; e < meta.length; e++) {
      const m = meta[e];
      if (m.deadlineMs <= now) {
        /** @type [number, number][] */
        const xyList = [];
        for (const k of m.cells) {
          pixels.delete(k);
          const parts = k.split(",");
          const sx = Number(parts[0]);
          const sy = Number(parts[1]);
          if (Number.isFinite(sx) && Number.isFinite(sy)) xyList.push([sx | 0, sy | 0]);
        }
        broadcast({
          type: "territoryIsolationCollapse",
          teamId: m.teamId,
          groupId: m.groupId,
          sig: m.groupId,
          cells: xyList,
        });
        pixelsMutated = true;
      } else {
        nextCarry.set(m.groupId, {
          teamId: m.teamId,
          cells: m.cells,
          deadlineMs: m.deadlineMs,
          groupId: m.groupId,
        });
      }
    }
    carry = nextCarry;
  }
  return pixelsMutated;
}

function normalizePixel(val) {
  if (val == null) {
    return { teamId: 0, ownerPlayerKey: "", shieldedUntil: 0 };
  }
  if (typeof val === "object") {
    return {
      teamId: val.teamId | 0,
      ownerPlayerKey: String(val.ownerPlayerKey || "").slice(0, 128),
      shieldedUntil: Number(val.shieldedUntil) || 0,
    };
  }
  const tid = Number(val) | 0;
  return { teamId: tid, ownerPlayerKey: "", shieldedUntil: 0 };
}

function clearTeamEffectsMap() {
  teamEffects.clear();
}

function getTeamFx(tid) {
  if (!teamEffects.has(tid)) {
    teamEffects.set(tid, { teamRecoveryUntil: 0, teamRecoverySec: BASE_ACTION_COOLDOWN_SEC });
  }
  const fx = teamEffects.get(tid);
  if (fx.teamRecoveryUntil == null && fx.teamBoostUntil != null) {
    fx.teamRecoveryUntil = fx.teamBoostUntil;
  }
  if (typeof fx.teamRecoveryUntil !== "number") fx.teamRecoveryUntil = 0;
  if (typeof fx.teamRecoverySec !== "number" || fx.teamRecoverySec < 1) {
    fx.teamRecoverySec = BASE_ACTION_COOLDOWN_SEC;
  }
  delete fx.teamBoostUntil;
  delete fx.raidBoostUntil;
  delete fx.shieldZone;
  return fx;
}

function zoneRect4(cx, cy) {
  return { x0: cx - 1, y0: cy - 1, x1: cx + 2, y1: cy + 2 };
}

function planCaptureRect(x0, y0, x1, y1) {
  const planned = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!cellAllowsPixelPlacement(x, y)) continue;
      planned.push([x, y]);
    }
  }
  return planned;
}

function applyPlannedCapture(pk, tid, planned) {
  for (const [x, y] of planned) {
    if (!cellAllowsPixelPlacement(x, y)) continue;
    if (isEnemyOwnedFlagBaseCell(tid, x, y)) continue;
    const k = `${x},${y}`;
    pixels.set(k, {
      teamId: tid,
      ownerPlayerKey: pk,
      shieldedUntil: 0,
    });
    broadcast({ type: "pixel", x, y, t: tid, ownerPlayerKey: pk, shieldedUntil: 0 });
  }
  afterTerritoryMutation();
}

/** @type {Map<object, number>} */
const lastPlace = new WeakMap();
/** @type {Map<number, number>} teamId -> число игроков */
const teamPlayerCounts = new Map();

loadDynamicTeams();
loadRoundState();
if (gameFinished) {
  rebuildLandFromRound(Math.min(Math.max(roundIndex, 2), 3));
} else {
  rebuildLandFromRound(roundIndex);
}
ensureAllTeamSpawnsAfterLoad();

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
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(full).pipe(res);
  });
}

function fullPayload() {
  const list = [];
  for (const [key, val] of pixels) {
    const [x, y] = key.split(",").map(Number);
    const p = normalizePixel(val);
    list.push([x, y, p.teamId, p.ownerPlayerKey, p.shieldedUntil]);
  }
  return JSON.stringify({ type: "full", pixels: list, pixelFormat: "v2" });
}

async function buildWalletPayload(ws) {
  const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  const u = await walletStore.getOrCreateUser(pk);
  const now = Date.now();
  const st = tournamentStage(roundIndex, gameFinished);
  const tid = ws.teamId | 0;
  const fx = tid ? getTeamFx(tid) : { teamRecoveryUntil: 0, teamRecoverySec: BASE_ACTION_COOLDOWN_SEC };
  const devUnl = pk && isDevUnlimitedWallet(pk);
  const teamFxPayload = { teamRecoveryUntil: fx.teamRecoveryUntil, teamRecoverySec: fx.teamRecoverySec };
  /* Безлимит только баланс/списания — интервал пикселя и баффы как у всех */
  const cd = pk ? getCurrentCooldownMs(u, teamFxPayload, st, now) : BASE_ACTION_COOLDOWN_SEC * 1000;
  const ref = u.invitedByPlayerKey ? sanitizePlayerKey(u.invitedByPlayerKey) : "";
  const effectiveRecoverySec = pk ? getEffectiveRecoverySec(u, teamFxPayload, now) : BASE_ACTION_COOLDOWN_SEC;
  return {
    type: "wallet",
    balanceUSDT: devUnl ? 999999999 : u.balanceUSDT,
    cooldownMs: cd,
    effectiveRecoverySec,
    personalRecoveryUntil: u.personalRecoveryUntil,
    personalRecoverySec: u.personalRecoverySec,
    lastActionAt: u.lastActionAt,
    lastZoneCaptureAt: u.lastZoneCaptureAt ?? 0,
    lastMassCaptureAt: u.lastMassCaptureAt ?? 0,
    lastZone12CaptureAt: u.lastZone12CaptureAt ?? 0,
    referralBonusActive: !!(ref && isPlayerKeyOnline(ref)),
    globalEvent: getGlobalEventPayload(now),
    tournamentStage: st,
    roundIndex,
    devUnlimited: !!devUnl,
    teamEffects: tid
      ? {
          teamId: tid,
          teamRecoveryUntil: fx.teamRecoveryUntil,
          teamRecoverySec: fx.teamRecoverySec,
        }
      : null,
  };
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

function applyFullMessageToPixelsCluster(msg) {
  pixels.clear();
  const list = Array.isArray(msg.pixels) ? msg.pixels : [];
  const fmt = msg.pixelFormat;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (!Array.isArray(p) || p.length < 3) continue;
    const x = p[0] | 0;
    const y = p[1] | 0;
    if (!cellAllowsPixelPlacement(x, y)) continue;
    if (fmt === "v2" && p.length >= 5) {
      const t = p[2] | 0;
      const opk = String(p[3] || "").slice(0, 128);
      const sh = Number(p[4]) || 0;
      pixels.set(`${x},${y}`, { teamId: t, ownerPlayerKey: opk, shieldedUntil: sh });
    } else {
      pixels.set(`${x},${y}`, { teamId: p[2] | 0, ownerPlayerKey: "", shieldedUntil: 0 });
    }
  }
}

/**
 * Применить игровое событие с другого инстанса (после Redis) — держим pixels/команды в памяти в синхроне.
 * Персональные wallet / meta по-прежнему только на том инстансе, куда пришёл WS.
 */
function applyClusterGameReplication(msg) {
  if (!msg || typeof msg !== "object" || typeof msg.type !== "string") return;
  switch (msg.type) {
    case "pixel": {
      const x = msg.x | 0;
      const y = msg.y | 0;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) return;
      if (!cellAllowsPixelPlacement(x, y)) return;
      pixels.set(`${x},${y}`, {
        teamId: msg.t | 0,
        ownerPlayerKey: String(msg.ownerPlayerKey || "").slice(0, 128),
        shieldedUntil: Number(msg.shieldedUntil) || 0,
      });
      return;
    }
    case "full":
      applyFullMessageToPixelsCluster(msg);
      return;
    case "teamsFull":
      if (Array.isArray(msg.teams)) {
        dynamicTeams = msg.teams.map((t) => {
          const sp = t.spawn && typeof t.spawn === "object" ? t.spawn : null;
          const sx = typeof t.spawnX0 === "number" ? t.spawnX0 : sp && typeof sp.x0 === "number" ? sp.x0 : undefined;
          const sy = typeof t.spawnY0 === "number" ? t.spawnY0 : sp && typeof sp.y0 === "number" ? sp.y0 : undefined;
          return {
            id: t.id | 0,
            name: sanitizeTeamName(t.name),
            emoji: sanitizeTeamEmoji(t.emoji),
            color: sanitizeHexColor(t.color) || "#888888",
            solo: !!t.solo,
            eliminated: !!t.eliminated,
            editToken: typeof t.editToken === "string" ? t.editToken.slice(0, 128) : undefined,
            soloResumeToken: typeof t.soloResumeToken === "string" ? t.soloResumeToken.slice(0, 128) : undefined,
            ...(typeof sx === "number" && typeof sy === "number" ? { spawnX0: sx, spawnY0: sy } : {}),
          };
        });
        const maxId = dynamicTeams.reduce((m, t) => Math.max(m, t.id || 0), 0);
        nextTeamId = Math.max(nextTeamId, maxId + 1);
        saveDynamicTeams();
      }
      return;
    case "counts":
      if (msg.teamCounts && typeof msg.teamCounts === "object") {
        teamPlayerCounts.clear();
        for (const k of Object.keys(msg.teamCounts)) {
          teamPlayerCounts.set(Number(k), Number(msg.teamCounts[k]) | 0);
        }
      }
      return;
    case "seismicPreview":
      return;
    case "roundEvent":
      return;
    case "seismicImpact": {
      const list = Array.isArray(msg.cells) ? msg.cells : [];
      for (let i = 0; i < list.length; i++) {
        const pair = list[i];
        if (!Array.isArray(pair) || pair.length < 2) continue;
        const x = pair[0] | 0;
        const y = pair[1] | 0;
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
        pixels.delete(`${x},${y}`);
      }
      return;
    }
    case "globalEvent":
      return;
    case "teamDisplay": {
      const tid = msg.teamId | 0;
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (dt) {
        dt.name = sanitizeTeamName(msg.name);
        dt.emoji = sanitizeTeamEmoji(msg.emoji);
        const nc = sanitizeHexColor(msg.color);
        if (nc) dt.color = nc;
        saveDynamicTeams();
      }
      return;
    }
    case "teamEffect":
      if (msg.kind === "teamRecovery" && typeof msg.teamId === "number") {
        const fx = getTeamFx(msg.teamId);
        fx.teamRecoveryUntil = Number(msg.until) || 0;
        fx.teamRecoverySec = Number(msg.teamRecoverySec) || BASE_ACTION_COOLDOWN_SEC;
      }
      return;
    case "manualBattleSync": {
      manualBattleSlotsByCmd.clear();
      const sl = msg.slots && typeof msg.slots === "object" && !Array.isArray(msg.slots) ? msg.slots : {};
      for (const [k, v] of Object.entries(sl)) {
        const u = Number(v);
        if (Number.isFinite(u)) manualBattleSlotsByCmd.set(normalizeManualBattleCmdKey(k), u);
      }
      return;
    }
    case "teamEliminated": {
      const tid = msg.teamId | 0;
      const ri = typeof msg.roundIndex === "number" ? msg.roundIndex : roundIndex;
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (dt) dt.eliminated = true;
      clearFlagCaptureStateForDefender(tid);
      removeTerritoryIsolationGroupsForTeam(tid);
      teamEffects.delete(tid);
      teamMemberKeys.delete(tid);
      teamPlayerCounts.delete(tid);
      if (wss) {
        for (const c of wss.clients) {
          if (c.readyState === 1 && c.teamId === tid) {
            c.teamId = null;
            if (ri === 0) {
              applyEligibilityFromServerState(c);
            } else {
              c.eligible = false;
            }
          }
        }
      }
      return;
    }
    case "roundEnded":
    case "gameEnded":
      try {
        clearAllFlagCaptureState();
        clearTerritoryIsolationState();
        loadRoundState();
        loadDynamicTeams();
        clearTeamEffectsMap();
        teamMemberKeys.clear();
        teamPlayerCounts.clear();
        pixels.clear();
        if (gameFinished) rebuildLandFromRound(Math.min(Math.max(roundIndex, 2), 3));
        else rebuildLandFromRound(roundIndex);
        ensureAllTeamSpawnsAfterLoad();
      } catch (e) {
        console.warn("[cluster] round sync:", e.message);
      }
      return;
    case "flagCaptureProgress": {
      const did = msg.defenderTeamId | 0;
      if (msg.reset) {
        flagCaptureByDefender.delete(did);
        return;
      }
      let hp;
      const rawHp = msg.hp;
      if (typeof rawHp === "number" && Number.isFinite(rawHp)) hp = rawHp | 0;
      else if (typeof rawHp === "string" && String(rawHp).trim() !== "") {
        const n = Number(rawHp);
        if (Number.isFinite(n)) hp = n | 0;
      }
      if (hp === undefined) hp = Math.max(0, FLAG_BASE_MAX_HP - (msg.progress | 0));
      if (hp >= FLAG_BASE_MAX_HP) {
        flagCaptureByDefender.delete(did);
        return;
      }
      let lastHitAt = 0;
      const rawLh = msg.lastHitAt;
      if (typeof rawLh === "number" && Number.isFinite(rawLh)) lastHitAt = rawLh | 0;
      else if (typeof rawLh === "string" && String(rawLh).trim() !== "") {
        const n = Number(rawLh);
        if (Number.isFinite(n)) lastHitAt = n | 0;
      }
      const nowRepl = Date.now();
      if (!Number.isFinite(lastHitAt) || lastHitAt < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
        lastHitAt = nowRepl - FLAG_REGEN_IDLE_MS;
      }
      const prevSt = flagCaptureByDefender.get(did);
      flagCaptureByDefender.set(did, {
        hp,
        lastHitAt,
        attackerTeamId: msg.attackerTeamId | 0,
        ...(prevSt && typeof prevSt === "object"
          ? {
              _lastRegenBroadcastHp: prevSt._lastRegenBroadcastHp,
              _flagRegenBroadcastPhase: prevSt._flagRegenBroadcastPhase,
              _lastRegenBroadcastAt: prevSt._lastRegenBroadcastAt,
            }
          : {}),
      });
      return;
    }
    case "flagCaptureStopped": {
      flagCaptureByDefender.delete(msg.defenderTeamId | 0);
      return;
    }
    case "flagCaptured": {
      const aid = msg.attackerTeamId | 0;
      const did = msg.defenderTeamId | 0;
      for (const [k, val] of [...pixels.entries()]) {
        if ((pixelTeam(val) | 0) === did) {
          pixels.set(k, { teamId: aid, ownerPlayerKey: "", shieldedUntil: 0 });
        }
      }
      clearFlagCaptureStateForDefender(did);
      return;
    }
    case "territoryIsolationSync": {
      territoryIsolationByGroupId = new Map();
      const groups = Array.isArray(msg.groups) ? msg.groups : [];
      for (let gi = 0; gi < groups.length; gi++) {
        const g = groups[gi];
        const groupId =
          typeof g.groupId === "string" && g.groupId
            ? g.groupId
            : typeof g.sig === "string"
              ? g.sig
              : "";
        if (!groupId) continue;
        const cells = new Set();
        const rawCells = Array.isArray(g.cells) ? g.cells : [];
        for (let ci = 0; ci < rawCells.length; ci++) {
          const c = rawCells[ci];
          if (!Array.isArray(c) || c.length < 2) continue;
          cells.add(`${c[0] | 0},${c[1] | 0}`);
        }
        territoryIsolationByGroupId.set(groupId, {
          teamId: g.teamId | 0,
          cells,
          deadlineMs: Number(g.expiresAtMs) || 0,
          groupId,
        });
      }
      const sn = typeof msg.serverNow === "number" ? msg.serverNow : Date.now();
      lastTerritoryIsolationSyncJson = JSON.stringify(buildTerritoryIsolationGroupsPayload(sn).groups);
      return;
    }
    case "territoryIsolationCollapse": {
      const raw = Array.isArray(msg.cells) ? msg.cells : [];
      for (let i = 0; i < raw.length; i++) {
        const p = raw[i];
        if (!Array.isArray(p) || p.length < 2) continue;
        pixels.delete(`${p[0] | 0},${p[1] | 0}`);
      }
      const collapseGid =
        typeof msg.groupId === "string" && msg.groupId
          ? msg.groupId
          : typeof msg.sig === "string"
            ? msg.sig
            : "";
      if (collapseGid) territoryIsolationByGroupId.delete(collapseGid);
      return;
    }
    case "flagUnderAttack":
    case "flagDefendWarn":
    case "flagHitAck":
      return;
    case "stats":
    case "purchaseVfx":
    case "teamDanger":
    case "teamLastCell":
    case "teamCreated":
    case "teamBaseHighlighted":
    case "invalidPlacement":
      return;
    case "roundPlayStarted":
      return;
    case "tournamentTimeScale": {
      tournamentTimeScale =
        typeof msg.tournamentTimeScale === "number"
          ? clampTournamentTimeScale(msg.tournamentTimeScale)
          : TOURNAMENT_TIME_SCALE_DEFAULT;
      if (typeof msg.roundStartMs === "number" && Number.isFinite(msg.roundStartMs)) {
        roundStartMs = msg.roundStartMs;
      }
      if (typeof msg.round0WarmupMs === "number" && Number.isFinite(msg.round0WarmupMs)) {
        const w = Math.round(msg.round0WarmupMs);
        if (w >= 5000 && w <= 600000) round0WarmupMs = w;
      }
      if (typeof msg.roundTimerStarted === "boolean") {
        roundTimerStarted = msg.roundTimerStarted;
      }
      playStartMs = getPlayStartMs();
      schedulePlayStartBroadcast();
      return;
    }
    default:
      return;
  }
}

function broadcastToWebSocketClients(raw) {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try {
      client.send(raw);
    } catch {
      /* сокет закрыт при отправке */
    }
  }
}

function broadcast(obj) {
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  broadcastToWebSocketClients(raw);
  if (redisGamePublish) {
    try {
      const out = redisGamePublish(raw);
      if (out && typeof out.then === "function") out.catch((e) => console.warn("[redis publish]", e.message));
    } catch (e) {
      console.warn("[redis publish]", e.message);
    }
  }
}

/** Соседи по 8 направлениям: есть ли клетка команды teamId. */
function cellTouchesTeamTerritory(x, y, teamId) {
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const v = pixels.get(`${nx},${ny}`);
      if (v != null && pixelTeam(v) === (teamId | 0)) return true;
    }
  }
  return false;
}

/** Псевдоним для правил размещения: можно ставить, если среди 8 соседей есть своя клетка. */
function canPlaceForTeam(x, y, teamId) {
  return cellTouchesTeamTerritory(x, y, teamId);
}

function findDefenderTeamAtFlagCell(x, y) {
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    const fc = flagCellFromSpawn(t.spawnX0, t.spawnY0);
    if (fc.x === x && fc.y === y) return t;
  }
  return null;
}

/** Клетка — якорь флага чужой (не атакующей) команды: отдельная ветка атаки базы, не обычная покраска. */
function findEnemyFlagDefenderAtCell(attackerTeamId, x, y) {
  const def = findDefenderTeamAtFlagCell(x, y);
  if (!def) return null;
  if ((def.id | 0) === (attackerTeamId | 0)) return null;
  return def;
}

/**
 * Клетка флага (центр стартового квадрата) чужой команды, всё ещё окрашенная ею.
 * Такую клетку нельзя перекрасить обычным пикселем / зоной — только 20 «ударов» по флагу.
 */
function isEnemyOwnedFlagBaseCell(attackerTeamId, x, y) {
  const def = findDefenderTeamAtFlagCell(x, y);
  if (!def || (def.id | 0) === (attackerTeamId | 0)) return false;
  const existing = pixels.get(`${x},${y}`);
  const owner = existing != null ? pixelTeam(existing) : 0;
  return owner === (def.id | 0);
}

function buildFlagsSnapshot() {
  const out = [];
  const now = Date.now();
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    const { x, y } = flagCellFromSpawn(t.spawnX0, t.spawnY0);
    const st = flagCaptureByDefender.get(Number(t.id) | 0);
    if (st) {
      const lh = Number(st.lastHitAt) | 0;
      if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
        st.lastHitAt = now - FLAG_REGEN_IDLE_MS;
      }
    }
    const eff = computeEffectiveBaseHp(st, now);
    const displayFloor = Math.min(FLAG_BASE_MAX_HP, Math.max(0, Math.floor(eff + 1e-9)));
    /* В meta/клиент: hp = якорь после дискретных ударов (st.hp), не floor(eff) — иначе реген ломает computeEffectiveBaseHp. */
    const metaHp = st
      ? Math.min(FLAG_BASE_MAX_HP, Math.max(0, st.hp | 0))
      : displayFloor;
    const attackerTeamId = (st?.attackerTeamId | 0) || 0;
    let lhMeta = now;
    if (st) {
      const lh = Number(st.lastHitAt) | 0;
      lhMeta =
        Number.isFinite(lh) && lh >= FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS
          ? lh
          : now - FLAG_REGEN_IDLE_MS;
    }
    out.push({
      teamId: t.id,
      fx: x,
      fy: y,
      hp: metaHp,
      maxHp: FLAG_BASE_MAX_HP,
      lastHitAt: lhMeta,
      attackerTeamId,
      underAttack: displayFloor < FLAG_BASE_MAX_HP,
      effectiveHp: eff,
      flagStateServerNow: now,
    });
  }
  return out;
}

function tickFlagBaseRegen(now) {
  if (!isClusterLeader()) return;
  if (gameFinished || roundEnding) return;
  const regenBroadcastPeriodMs = 800;
  for (const [did, st] of [...flagCaptureByDefender.entries()]) {
    const d = did | 0;
    if (!st) continue;
    /* Без валидного lastHitAt computeEffectiveBaseHp не даёт рост eff — регена нет (см. FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS). */
    const lh0 = Number(st.lastHitAt) | 0;
    if (!Number.isFinite(lh0) || lh0 < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
      st.lastHitAt = now - FLAG_REGEN_IDLE_MS;
    }
    const eff = computeEffectiveBaseHp(st, now);
    if (eff >= FLAG_BASE_MAX_HP - 1e-9) {
      flagCaptureByDefender.delete(d);
      broadcast({ type: "flagCaptureStopped", defenderTeamId: d, reason: "regen_full" });
      continue;
    }
    const idleEnd = st.lastHitAt + FLAG_REGEN_IDLE_MS;
    if (now < idleEnd) {
      st._flagRegenBroadcastPhase = false;
      continue;
    }
    if (!st._flagRegenBroadcastPhase) {
      st._flagRegenBroadcastPhase = true;
      st._lastRegenBroadcastHp = -1;
    }
    const curInt = Math.max(0, Math.min(FLAG_BASE_MAX_HP - 1, Math.floor(eff + 1e-9)));
    const needBroadcast =
      st._lastRegenBroadcastHp !== curInt ||
      !st._lastRegenBroadcastAt ||
      now - st._lastRegenBroadcastAt >= regenBroadcastPeriodMs;
    if (!needBroadcast) continue;
    st._lastRegenBroadcastHp = curInt;
    st._lastRegenBroadcastAt = now;
    broadcast({
      type: "flagCaptureProgress",
      defenderTeamId: d,
      attackerTeamId: st.attackerTeamId | 0,
      hp: Math.min(FLAG_BASE_MAX_HP, Math.max(0, st.hp | 0)),
      maxHp: FLAG_BASE_MAX_HP,
      lastHitAt: st.lastHitAt,
      regen: true,
      effectiveHp: eff,
      serverNow: now,
    });
  }
}

/**
 * Удар по базе: HP −1; при HP уже 0 — захват.
 * Не вызывает обычную покраску: `pixels` на клетке флага не трогаем до {@link executeFlagCaptureSuccess}.
 * @returns {null | { rateLimited?: true } | { hit: true, defenderTeamId: number, hp: number, maxHp: number } | { captured: true, defenderTeamId: number }}
 */
function tryFlagCaptureHit(attackerTeamId, x, y, now) {
  const defTeam = findDefenderTeamAtFlagCell(x, y);
  if (!defTeam) return null;
  const did = defTeam.id | 0;
  const aid = attackerTeamId | 0;
  if (did === 0 || did === aid) return null;
  if (isTeamEliminated(aid) || isTeamEliminated(did)) return null;
  /* Без отдельных таймеров/фаз: удар по флагу возможен в том же запросе pixel, что и обычный ход
   * (разминка, кулдаун, соседство, вода и т.д. уже проверены выше по коду). */
  if (!canPlaceForTeam(x, y, aid)) return null;

  const key = `${x},${y}`;
  const existing = pixels.get(key);
  let owner = existing != null ? pixelTeam(existing) | 0 : 0;
  /* Якорь базы — не обычная клетка: допускаем пустую клетку (сейсмика/изоляция) и числовое совпадение owner/def.id. */
  if (owner !== 0 && owner !== did) return null;
  if (owner === 0) {
    pixels.set(key, { teamId: did, ownerPlayerKey: "", shieldedUntil: 0 });
    broadcast({ type: "pixel", x, y, t: did, ownerPlayerKey: "", shieldedUntil: 0 });
  }

  if (!flagTeamHitLimiter.allow(`fc:${aid}`, FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC, 1000)) {
    return { rateLimited: true };
  }

  let st = flagCaptureByDefender.get(did);
  if (st) {
    const lh = Number(st.lastHitAt) | 0;
    if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) st.lastHitAt = now;
  }
  const curHpFloat = computeEffectiveBaseHp(st, now);
  const curHp = Math.min(FLAG_BASE_MAX_HP, Math.max(0, Math.floor(curHpFloat + 1e-9)));

  if (curHp <= 0) {
    executeFlagCaptureSuccess(aid, did);
    return { captured: true, defenderTeamId: did };
  }

  const newHp = curHp - 1;
  if (!st) {
    st = { hp: newHp, lastHitAt: now, attackerTeamId: aid };
    flagCaptureByDefender.set(did, st);
  } else {
    st.hp = newHp;
    st.lastHitAt = now;
    st.attackerTeamId = aid;
  }
  st._lastRegenBroadcastHp = newHp;
  st._flagRegenBroadcastPhase = false;

  if (curHp === FLAG_BASE_MAX_HP) {
    broadcast({
      type: "flagUnderAttack",
      defenderTeamId: did,
      attackerTeamId: aid,
      hp: newHp,
      maxHp: FLAG_BASE_MAX_HP,
    });
  }

  const effAfterHit = computeEffectiveBaseHp(st, now);
  broadcast({
    type: "flagCaptureProgress",
    defenderTeamId: did,
    attackerTeamId: aid,
    hp: newHp,
    maxHp: FLAG_BASE_MAX_HP,
    lastHitAt: now,
    effectiveHp: effAfterHit,
    serverNow: now,
  });

  for (const th of FLAG_WARN_THRESHOLDS) {
    if (newHp === th) {
      broadcast({
        type: "flagDefendWarn",
        defenderTeamId: did,
        attackerTeamId: aid,
        hp: newHp,
        maxHp: FLAG_BASE_MAX_HP,
        level: th,
      });
      break;
    }
  }

  return { hit: true, defenderTeamId: did, hp: newHp, maxHp: FLAG_BASE_MAX_HP };
}

/** Единственная точка смены владельца клетки флага и всей территории защитника (после добивающего удара). */
function executeFlagCaptureSuccess(attackerId, defenderId) {
  const dtDef = dynamicTeams.find((t) => t.id === defenderId);
  const dtAtk = dynamicTeams.find((t) => t.id === attackerId);
  if (!dtDef || dtDef.eliminated || dtDef.solo) return;
  if (!dtAtk || dtAtk.eliminated) return;

  const { x: gx, y: gy } =
    typeof dtDef.spawnX0 === "number" && typeof dtDef.spawnY0 === "number"
      ? flagCellFromSpawn(dtDef.spawnX0, dtDef.spawnY0)
      : { x: 0, y: 0 };

  clearFlagCaptureStateForDefender(defenderId);

  for (const [k, val] of [...pixels.entries()]) {
    if ((pixelTeam(val) | 0) === (defenderId | 0)) {
      pixels.set(k, { teamId: attackerId, ownerPlayerKey: "", shieldedUntil: 0 });
    }
  }

  broadcast({
    type: "flagCaptured",
    attackerTeamId: attackerId,
    defenderTeamId: defenderId,
    gx,
    gy,
    attackerColor: dtAtk.color || "#888888",
    defenderColor: dtDef.color || "#888888",
    banner: "BASE CAPTURED",
    roundIndex,
    canReenter: roundIndex === 0,
  });

  eliminateTeamByTerritoryLoss(defenderId);
  afterTerritoryMutation();
}

/** Клетки из planned, достижимые от уже существующей территории команды через 8-соседство, оставаясь внутри planned. */
function filterPlannedReachableFromTeam(planned, teamId) {
  const inPlanned = new Set(planned.map(([x, y]) => `${x},${y}`));
  const out = [];
  const seen = new Set();
  const queue = [];
  for (const [x, y] of planned) {
    if (cellTouchesTeamTerritory(x, y, teamId)) {
      const k = `${x},${y}`;
      if (!seen.has(k)) {
        seen.add(k);
        queue.push([x, y]);
      }
    }
  }
  while (queue.length) {
    const [x, y] = queue.pop();
    out.push([x, y]);
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx;
        const ny = y + dy;
        const nk = `${nx},${ny}`;
        if (!inPlanned.has(nk) || seen.has(nk)) continue;
        seen.add(nk);
        queue.push([nx, ny]);
      }
    }
  }
  return out;
}

function spawnRectsConflict(x0, y0, ox0, oy0) {
  const g = TEAM_SPAWN_GAP;
  const ax0 = x0 - g;
  const ay0 = y0 - g;
  const ax1 = x0 + TEAM_SPAWN_SIZE + g - 1;
  const ay1 = y0 + TEAM_SPAWN_SIZE + g - 1;
  const bx0 = ox0 - g;
  const by0 = oy0 - g;
  const bx1 = ox0 + TEAM_SPAWN_SIZE + g - 1;
  const by1 = oy0 + TEAM_SPAWN_SIZE + g - 1;
  return !(ax1 < bx0 || bx1 < ax0 || ay1 < by0 || by1 < ay0);
}

function rectAllLandSpan(x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (!cellAllowsPixelPlacement(x, y)) return false;
    }
  }
  return true;
}

function rectFreeOfPixels(x0, y0, w, h) {
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      if (pixels.has(`${x},${y}`)) return false;
    }
  }
  return true;
}

function existingSpawnPositions() {
  const out = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
      out.push({ x0: t.spawnX0, y0: t.spawnY0 });
    }
  }
  return out;
}

function findValidSpawnRect6() {
  if (!landGrid) return null;
  const maxX = gridW - TEAM_SPAWN_SIZE;
  const maxY = gridH - TEAM_SPAWN_SIZE;
  if (maxX < 0 || maxY < 0) return null;
  const others = existingSpawnPositions();
  let seed = (Date.now() ^ (nextTeamId * 0x9e3779b9)) >>> 0;
  const rand = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 0x100000000;
  };
  for (let attempt = 0; attempt < 500; attempt++) {
    const x0 = (rand() * (maxX + 1)) | 0;
    const y0 = (rand() * (maxY + 1)) | 0;
    if (!rectAllLandSpan(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) continue;
    if (!rectFreeOfPixels(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) continue;
    let clash = false;
    for (const o of others) {
      if (spawnRectsConflict(x0, y0, o.x0, o.y0)) {
        clash = true;
        break;
      }
    }
    if (!clash) return { x0, y0 };
  }
  for (let y0 = 0; y0 <= maxY; y0++) {
    for (let x0 = 0; x0 <= maxX; x0++) {
      if (!rectAllLandSpan(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) continue;
      if (!rectFreeOfPixels(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) continue;
      let clash = false;
      for (const o of others) {
        if (spawnRectsConflict(x0, y0, o.x0, o.y0)) {
          clash = true;
          break;
        }
      }
      if (!clash) return { x0, y0 };
    }
  }
  return null;
}

/** Залить 6×6 базу без WS-сообщений (для массового сброса карты). */
function fillTeamSpawnAreaSilent(teamId, x0, y0, ownerPk) {
  const opk = String(ownerPk || "").slice(0, 128);
  for (let y = y0; y < y0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
      if (!cellAllowsPixelPlacement(x, y)) continue;
      pixels.set(`${x},${y}`, { teamId, ownerPlayerKey: opk, shieldedUntil: 0 });
    }
  }
}

function paintTeamSpawnArea(teamId, x0, y0, ownerPk) {
  const opk = String(ownerPk || "").slice(0, 128);
  for (let y = y0; y < y0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
      if (!cellAllowsPixelPlacement(x, y)) continue;
      const k = `${x},${y}`;
      pixels.set(k, { teamId, ownerPlayerKey: opk, shieldedUntil: 0 });
      broadcast({
        type: "pixel",
        x,
        y,
        t: teamId,
        ownerPlayerKey: opk,
        shieldedUntil: 0,
      });
    }
  }
  afterTerritoryMutation();
}

function teamSpawnMissingPixels(t) {
  if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") return true;
  for (let y = t.spawnY0; y < t.spawnY0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = t.spawnX0; x < t.spawnX0 + TEAM_SPAWN_SIZE; x++) {
      const p = pixels.get(`${x},${y}`);
      if (!p || pixelTeam(p) !== (t.id | 0)) return true;
    }
  }
  return false;
}

/** Миграция и восстановление 6×6 баз после загрузки команд / сетки. */
function ensureAllTeamSpawnsAfterLoad() {
  if (!landGrid) return;
  let changed = false;
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") {
      const sp = findValidSpawnRect6();
      if (!sp) {
        console.warn("[spawn] нет места 6×6 для команды", t.id, t.name);
        continue;
      }
      t.spawnX0 = sp.x0;
      t.spawnY0 = sp.y0;
      changed = true;
      paintTeamSpawnArea(t.id, sp.x0, sp.y0, "");
    } else if (teamSpawnMissingPixels(t)) {
      paintTeamSpawnArea(t.id, t.spawnX0, t.spawnY0, "");
      changed = true;
    }
  }
  if (changed) saveDynamicTeams();
  afterTerritoryMutation();
}

/** Подсчёт пикселей по teamId на суше (как в stats). */
function computeTeamTerritoryCounts() {
  /** @type {Map<number, number>} */
  const byTeam = new Map();
  for (const [key, val] of pixels.entries()) {
    const parts = key.split(",");
    const px = Number(parts[0]);
    const py = Number(parts[1]);
    if (
      landGrid &&
      (!Number.isFinite(px) ||
        !Number.isFinite(py) ||
        px < 0 ||
        px >= gridW ||
        py < 0 ||
        py >= gridH ||
        landGrid[py * gridW + px] === 0)
    ) {
      continue;
    }
    const tid = pixelTeam(val);
    if (!tid) continue;
    byTeam.set(tid, (byTeam.get(tid) || 0) + 1);
  }
  return byTeam;
}

function notifyTerritoryDramaEvents(prev, next) {
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id;
    const n = next.get(tid) || 0;
    if (n < 1) continue;
    const p = prev.has(tid) ? prev.get(tid) : n;
    if (n <= 6 && (p > 6 || n < p)) {
      broadcast({ type: "teamDanger", teamId: tid, cellsRemaining: n });
    }
    if (n === 1 && p > 1) {
      broadcast({ type: "teamLastCell", teamId: tid, cellsRemaining: 1 });
    }
  }
}

/**
 * После любого изменения владельцев клеток: драма по территории, затем выбывание с 0 клеток.
 * Только лидер кластера (или одиночный процесс), иначе дублирование событий.
 */
function afterTerritoryMutation() {
  if (gameFinished) return;
  if (REDIS_URL && !isClusterLeader()) return;
  advanceTerritoryIsolationState();
  const next = computeTeamTerritoryCounts();
  notifyTerritoryDramaEvents(lastTerritoryCountSnapshot, next);
  lastTerritoryCountSnapshot = new Map(next);
  scanAndEliminateTeamsWithNoTerritory();
  const st = buildStatsPayload();
  updateTiebreakFromStatsPayload(st);
  checkDuelInstantWin(st);
}

function scanAndEliminateTeamsWithNoTerritory() {
  const byTeam = computeTeamTerritoryCounts();
  const victims = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const n = byTeam.get(t.id) | 0;
    if (n === 0) victims.push(t.id);
  }
  for (const tid of victims) {
    eliminateTeamByTerritoryLoss(tid);
  }
}

function eliminateTeamByTerritoryLoss(teamId) {
  const dt = dynamicTeams.find((t) => t.id === teamId);
  if (!dt || dt.solo || dt.eliminated) return;
  clearFlagCaptureStateForDefender(teamId);
  removeTerritoryIsolationGroupsForTeam(teamId);
  if (isClusterLeader() && !gameFinished) {
    broadcastTerritoryIsolationSyncIfChanged(Date.now());
  }
  dt.eliminated = true;
  saveDynamicTeams();
  teamEffects.delete(teamId);
  teamMemberKeys.delete(teamId);
  teamPlayerCounts.delete(teamId);
  let destroyGx = 0;
  let destroyGy = 0;
  if (typeof dt.spawnX0 === "number" && typeof dt.spawnY0 === "number") {
    destroyGx = (dt.spawnX0 + TEAM_SPAWN_SIZE / 2) | 0;
    destroyGy = (dt.spawnY0 + TEAM_SPAWN_SIZE / 2) | 0;
  }
  const payload = {
    type: "teamEliminated",
    teamId,
    roundIndex,
    canReenter: roundIndex === 0,
    destroyGx,
    destroyGy,
    teamColor: dt.color || "#888888",
  };
  if (wss) {
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      if (c.teamId === teamId) {
        c.teamId = null;
        if (roundIndex === 0) {
          applyEligibilityFromServerState(c);
        } else {
          c.eligible = false;
        }
        safeSend(c, payload);
        void sendConnectionMeta(c);
      }
    }
  }
  broadcast(payload);
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
  broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
  scheduleStatsBroadcast();
}

async function readRequestBody(req, maxBytes = HTTP_BODY_MAX) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let total = 0;
    req.on("data", (c) => {
      total += c.length;
      if (total > maxBytes) {
        try {
          req.destroy();
        } catch {
          /* ignore */
        }
        reject(new Error("body too large"));
        return;
      }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

async function handleApi(req, res) {
  const url = (req.url || "").split("?")[0];
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const clientIp = getClientIpFromReq(req);

  if (req.method === "POST" && url === "/api/ipn") {
    if (!apiIpnLimiter.allow(`ipn:${clientIp}`, API_IPN_PER_MIN, 60_000)) {
      res.writeHead(429);
      res.end(JSON.stringify({ ok: false, error: "rate limit" }));
      return;
    }
    let rawBuf;
    try {
      rawBuf = await readRequestBody(req);
    } catch {
      res.writeHead(413);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const raw = rawBuf.toString("utf8");
    let body;
    try {
      body = JSON.parse(raw);
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const sig =
      req.headers["x-nowpayments-sig"] ||
      req.headers["x-nowpayments-signature"] ||
      body.signature ||
      "";
    const okSig =
      verifyNowpaymentsSignature(body, String(sig), NOWPAYMENTS_IPN_SECRET) ||
      verifyNowpaymentsSignatureRaw(raw, String(sig), NOWPAYMENTS_IPN_SECRET);
    if (!NOWPAYMENTS_IPN_SECRET || !okSig) {
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: "bad signature" }));
      return;
    }
    const status = String(body.payment_status || body.status || "");
    const finished = status === "finished" || status === "confirmed" || status === "partially_paid";
    if (!finished) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }
    const npId = body.payment_id ?? body.id;
    if (npId == null) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: "no payment id" }));
      return;
    }
    const orderId = String(body.order_id || "");
    const parts = orderId.split("|");
    if (parts[0] !== "dep" || !parts[1]) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: "bad order" }));
      return;
    }
    const playerKey = sanitizePlayerKey(parts[1]);
    const creditUsdt = Number(body.price_amount ?? body.actually_paid ?? body.pay_amount);
    if (!playerKey || !Number.isFinite(creditUsdt) || creditUsdt <= 0) {
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const bonusQuant = parts.length >= 4 ? Number(parts[3]) | 0 : 0;
    const rounded = Math.round(creditUsdt * 100) / 100;
    let extraUsdt = 0;
    if (bonusQuant > 0) {
      const matchKey = [...DEPOSIT_PACK_BONUS_QUANT.keys()].find((k) => Math.abs(k - rounded) < 1e-6);
      const expected = matchKey !== undefined ? DEPOSIT_PACK_BONUS_QUANT.get(matchKey) : undefined;
      if (expected === bonusQuant) {
        extraUsdt = Math.round((bonusQuant / 7) * 1e6) / 1e6;
      }
    }
    const dep = await walletStore.finalizeDeposit(npId, playerKey, creditUsdt + extraUsdt, {
      txHash: String(body.outcome_hash || ""),
    });
    res.writeHead(200);
    res.end(JSON.stringify({ ok: dep.ok, duplicate: dep.duplicate === true }));
    return;
  }

  if (req.method === "POST" && url === "/api/deposit/create") {
    if (!apiDepositLimiter.allow(`dep:${clientIp}`, API_DEPOSIT_PER_MIN, 60_000)) {
      res.writeHead(429);
      res.end(JSON.stringify({ ok: false, error: "rate limit" }));
      return;
    }
    if (!NOWPAYMENTS_API_KEY || !PUBLIC_BASE_URL) {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: "deposits not configured" }));
      return;
    }
    let rawBuf;
    try {
      rawBuf = await readRequestBody(req);
    } catch {
      res.writeHead(413);
      res.end(JSON.stringify({ ok: false, error: "body too large" }));
      return;
    }
    let body;
    try {
      body = JSON.parse(rawBuf.toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const amount = Number(body.amount);
    const bonusQuant = Number.isFinite(Number(body.bonusQuant ?? body.bonusTugry))
      ? Number(body.bonusQuant ?? body.bonusTugry) | 0
      : 0;
    if (!Number.isFinite(amount) || amount < 1 || amount > MAX_DEPOSIT_USDT) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "bad request" }));
      return;
    }
    if (!depositBonusQuantAllowed(amount, bonusQuant)) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "bad bonus" }));
      return;
    }
    /** В Mini App ключ берём только из подписанного initData (клиент мог отдать anon UUID, если initDataUnsafe ещё не был). */
    let playerKey = "";
    if (TELEGRAM_BOT_TOKEN) {
      const initData = typeof body.initData === "string" ? body.initData : "";
      if (!initData.trim()) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "initData required" }));
        return;
      }
      const v = verifyTelegramWebAppInitData(initData, TELEGRAM_BOT_TOKEN, {
        maxAgeSec: TELEGRAM_INITDATA_MAX_AGE_SEC,
      });
      if (!v) {
        res.writeHead(403);
        res.end(JSON.stringify({ ok: false, error: "bad initData" }));
        return;
      }
      playerKey = sanitizePlayerKey(`tg_${v.id}`);
    } else {
      playerKey = sanitizePlayerKey(body.playerKey);
      if (!playerKey) {
        res.writeHead(400);
        res.end(JSON.stringify({ ok: false, error: "bad request" }));
        return;
      }
    }
    const orderId =
      bonusQuant > 0
        ? `dep|${playerKey}|${Date.now()}|${bonusQuant}`
        : `dep|${playerKey}|${Date.now()}`;
    const ipnUrl = `${PUBLIC_BASE_URL}/api/ipn`;
    try {
      const payCur =
        typeof body.payCurrency === "string" && body.payCurrency.trim()
          ? body.payCurrency.trim().toLowerCase()
          : NOWPAYMENTS_PAY_CURRENCY;
      const inv = await createNowpaymentInvoice({
        apiKey: NOWPAYMENTS_API_KEY,
        apiBase: NOWPAYMENTS_API_BASE,
        amountUsd: amount,
        orderId,
        ipnUrl,
        payCurrency: payCur,
        priceCurrency: NOWPAYMENTS_PRICE_CURRENCY,
        orderDescription: `Pixel Battle — ${amount} USDT (BEP20)`,
        successUrl: body.successUrl || `${PUBLIC_BASE_URL}/`,
        cancelUrl: body.cancelUrl || `${PUBLIC_BASE_URL}/`,
      });
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: true,
          paymentId: inv.id,
          paymentUrl: inv.paymentUrl,
          payAddress: inv.payAddress,
          orderId,
        })
      );
    } catch (e) {
      res.writeHead(500);
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    }
    return;
  }

  res.writeHead(404);
  res.end(JSON.stringify({ ok: false }));
}

const server = http.createServer((req, res) => {
  const u = (req.url || "").split("?")[0];
  if (u.startsWith("/api/")) {
    handleApi(req, res).catch((e) => {
      res.writeHead(500);
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ ok: false, error: String(e.message || e) }));
    });
    return;
  }
  serveStatic(req, res);
});

let wsConnSeq = 0;

wss = new WebSocketServer({
  server,
  path: WS_PATH,
  maxPayload: 131072,
  verifyClient: (info) => {
    const ip = getClientIpFromReq(info.req);
    if ((activeWsByIp.get(ip) || 0) >= WS_MAX_CONN_PER_IP) return false;
    return wsJoinLimiter.allow(`wsjoin:${ip}`, 90, 60_000);
  },
});

setInterval(() => {
  apiDepositLimiter.prune();
  apiIpnLimiter.prune();
  wsMsgLimiter.prune();
  wsPixelBurstLimiter.prune();
  claimAttemptLimiter.prune();
  wsJoinLimiter.prune();
  wsPurchaseLimiter.prune();
}, 120000);

async function broadcastWalletToAll() {
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    safeSend(client, await buildWalletPayload(client));
  }
}

/** Схлопывание частых рассылок кошелька (пиксели/покупки) — меньше O(N×клиентов) под нагрузкой. */
let walletBroadcastTimer = null;
function scheduleBroadcastWalletDebounced() {
  if (walletBroadcastTimer) return;
  walletBroadcastTimer = setTimeout(() => {
    walletBroadcastTimer = null;
    void broadcastWalletToAll();
  }, 50);
}

function countOnlineClients() {
  if (!wss) return 0;
  let n = 0;
  for (const c of wss.clients) {
    if (c.readyState === 1) n++;
  }
  return n;
}

function buildStatsPayload() {
  const nowMs = Date.now();
  const { agg, totalAvailableScore } = recalculateAllTeamScores(nowMs);
  const list = teamsForMeta().filter((t) => !t.solo && !t.eliminated);
  const rows = list.map((t) => {
    const a = agg.get(t.id) || { score: 0, cells: 0 };
    const score = Math.round(a.score * 1000) / 1000;
    const pix = a.cells | 0;
    const scoreSharePercent =
      totalAvailableScore > 0 ? Math.round((a.score / totalAvailableScore) * 100000) / 1000 : 0;
    const players = teamPlayerCounts.get(t.id) || 0;
    return {
      teamId: t.id,
      emoji: t.emoji,
      name: t.name,
      color: t.color,
      players,
      pixels: pix,
      score,
      scoreSharePercent,
      /** Доля суммарно доступных очков (не «% занятой карты»). Совместимость: старые клиенты читали `percent`. */
      percent: scoreSharePercent,
    };
  });
  rows.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.pixels !== a.pixels) return b.pixels - a.pixels;
    const ta = teamFirstHitPeakAt.has(a.teamId) ? teamFirstHitPeakAt.get(a.teamId) : Infinity;
    const tb = teamFirstHitPeakAt.has(b.teamId) ? teamFirstHitPeakAt.get(b.teamId) : Infinity;
    if (ta !== tb) return ta - tb;
    return a.teamId - b.teamId;
  });
  rows.forEach((row, i) => {
    row.rank = i + 1;
  });
  const leaderScore = rows.length && typeof rows[0].score === "number" ? rows[0].score : 0;
  for (const row of rows) {
    const sc = typeof row.score === "number" ? row.score : 0;
    row.pointsBehindLeader = Math.round((leaderScore - sc) * 1000) / 1000;
  }
  return {
    type: "stats",
    online: countOnlineClients(),
    landTotal: landPixelsTotal,
    landWeightTotal,
    totalAvailableScore,
    globalEvent: getGlobalEventPayload(nowMs),
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

function blockWarmupPurchase(ws) {
  if (!isWarmupPhaseNow()) return false;
  safeSend(ws, { type: "purchaseError", reason: "warmup" });
  return true;
}

function blockPrePlayPurchases(ws) {
  return blockWarmupPurchase(ws);
}

function assertCanPlay(ws) {
  if (gameFinished) {
    safeSend(ws, { type: "playRejected", reason: "spectator" });
    return false;
  }
  if (REQUIRE_TELEGRAM_AUTH_FOR_PLAY && !ws.telegramVerified) {
    safeSend(ws, { type: "playRejected", reason: "need_telegram" });
    return false;
  }
  if (roundIndex > 0 && ws.playerKey && !isPlayerKeyEligibleForCurrentRound(ws.playerKey)) {
    safeSend(ws, { type: "playRejected", reason: "not_eligible" });
    return false;
  }
  if (!ws.eligible) {
    safeSend(ws, { type: "playRejected", reason: "spectator" });
    return false;
  }
  return true;
}

/** Конец фазы боя (после разминки). null — 1-й раунд ждёт «go». */
function roundEndsAtForMeta() {
  if (gameFinished) return getRoundBattleEndRealMs();
  if (roundIndex === 0 && !roundTimerStarted) return null;
  return getRoundBattleEndRealMs();
}

async function sendConnectionMeta(ws) {
  const teamCountsObj = {};
  for (const [id, c] of teamPlayerCounts) {
    teamCountsObj[id] = c;
  }
  const warmupEndsAt =
    gameFinished || (roundIndex === 0 && !roundTimerStarted) ? null : getPlayStartMs();
  const isoNow = Date.now();
  safeSend(ws, {
    type: "meta",
    teams: teamsForMeta(),
    teamCounts: teamCountsObj,
    maxPerTeam: getMaxPerTeam(),
    grid: { w: gridW, h: gridH },
    roundIndex,
    roundEndsAt: roundEndsAtForMeta(),
    warmupEndsAt,
    playStartsAt: warmupEndsAt,
    warmupMs: getWarmupDurationMs(),
    lobbyBeforeGo: !!(WAIT_FOR_TELEGRAM_GO && roundIndex === 0 && !roundTimerStarted),
    eligible: !!ws.eligible,
    gameFinished: !!gameFinished,
    tournamentStage: tournamentStage(roundIndex, gameFinished),
    discussionChatUrl: getDiscussionChatUrlForClient(),
    flags: buildFlagsSnapshot(),
    tournamentTimeScale: getTournamentTimeScale(),
    territoryIsolation: buildTerritoryIsolationGroupsPayload(isoNow),
  });
  safeSend(ws, await buildWalletPayload(ws));
}

/** Финал: победитель дуэли 1v1 — игра окончена. */
async function finalizeGameEnd(winnerRow) {
  roundEnding = true;
  try {
    const winnerTeamId = winnerRow.teamId;
    const winningTeamName = winnerRow.name || "";
    const scoreShare =
      typeof winnerRow.scoreSharePercent === "number" && Number.isFinite(winnerRow.scoreSharePercent)
        ? winnerRow.scoreSharePercent
        : typeof winnerRow.percent === "number" && Number.isFinite(winnerRow.percent)
          ? winnerRow.percent
          : 0;
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
    clearAllFlagCaptureState();
    clearTerritoryIsolationState();
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    gameFinished = true;
    tournamentTimeScale = TOURNAMENT_TIME_SCALE_DEFAULT;
    roundStartMs = Date.now();
    if (playStartBroadcastTimer) {
      clearTimeout(playStartBroadcastTimer);
      playStartBroadcastTimer = null;
    }
    saveRoundState();

    void notifyFinalWinnersTelegram(winnerKeysSnapshot, winningTeamName, winnerRow);

    const winScore =
      typeof winnerRow.score === "number" && Number.isFinite(winnerRow.score) ? winnerRow.score : null;
    broadcast({
      type: "gameEnded",
      winnerTeamId,
      winnerName: winningTeamName,
      scoreSharePercent: scoreShare,
      percent: scoreShare,
      winnerScore: winScore,
      roundIndex,
      grid: { w: gridW, h: gridH },
    });

    broadcast({ type: "full", pixels: [] });
    broadcast({ type: "teamsFull", teams: teamsForMeta() });
    broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    broadcastStatsImmediate();
    await Promise.all(
      [...wss.clients]
        .filter((c) => c.readyState === 1)
        .map((c) => sendConnectionMeta(c))
    );
  } finally {
    roundEnding = false;
  }
}

/** После раунда «5×2» — только 2 участника победившей команды переходят в дуэль 1v1 (тот же размер карты). */
async function advanceToDuelRound(winnerRow) {
  roundEnding = true;
  try {
    const winnerTeamId = winnerRow.teamId;
    const winningTeamName = winnerRow.name || "";
    const statsSnap = buildStatsPayload();
    const rowsSnap = statsSnap.rows || [];
    const topTeams = rowsSnap.slice(0, 10).map((r) => ({
      rank: r.rank,
      teamId: r.teamId,
      name: r.name,
      emoji: r.emoji,
      score: r.score,
      scoreSharePercent: r.scoreSharePercent,
      percent: r.percent,
      pixels: r.pixels,
    }));
    const winnerScore = typeof winnerRow.score === "number" ? winnerRow.score : 0;
    const winnerScoreShare =
      typeof winnerRow.scoreSharePercent === "number"
        ? winnerRow.scoreSharePercent
        : typeof winnerRow.percent === "number"
          ? winnerRow.percent
          : 0;
    setEligibleKeysFromWinnerTeam(winnerTeamId, 2);

    eligibleTokenSet = new Set();
    winnerTokensByPlayerKey = {};
    const tokenByPlayerKey = new Map();
    for (const pk of eligiblePlayerKeys) {
      const tok = crypto.randomBytes(18).toString("hex");
      eligibleTokenSet.add(tok);
      winnerTokensByPlayerKey[pk] = tok;
      tokenByPlayerKey.set(pk, tok);
    }

    const winnerTokenByClient = new Map();
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const pk = client.playerKey ? sanitizePlayerKey(client.playerKey) : "";
      const tok = pk && tokenByPlayerKey.has(pk) ? tokenByPlayerKey.get(pk) : null;
      if (tok) {
        winnerTokenByClient.set(client, tok);
        client.eligible = true;
        client.eliminated = false;
      } else {
        client.eligible = false;
        client.eliminated = true;
      }
      client.teamId = null;
    }

    teamMemberKeys.clear();
    teamPlayerCounts.clear();
    clearAllFlagCaptureState();
    clearTerritoryIsolationState();
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    roundIndex = 3;
    roundTimerStarted = true;
    roundStartMs = Date.now();
    roundDurationMs = battleDurationForRound(3);
    clearTiebreakSnapshots();
    resetBattleEventsStateForNewBattleRound();
    rebuildLandFromRound(3);
    saveRoundState();

    broadcast({
      type: "roundEnded",
      roundIndex: 3,
      endedRoundIndex: 2,
      winnerTeamId,
      winnerName: winningTeamName,
      winnerScore,
      winnerScoreSharePercent: winnerScoreShare,
      winnerPercent: winnerScoreShare,
      topTeams,
      roundEndsAt: getRoundBattleEndRealMs(),
      maxPerTeam: getMaxPerTeam(),
      grid: { w: gridW, h: gridH },
      duel: true,
    });

    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const tok = winnerTokenByClient.get(client);
      if (tok) {
        safeSend(client, {
          type: "roundWinnerPass",
          token: tok,
          roundIndex: 3,
        });
      }
    }

    broadcast({ type: "full", pixels: [] });
    broadcast({ type: "teamsFull", teams: teamsForMeta() });
    broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
    broadcastStatsImmediate();
    await Promise.all(
      [...wss.clients]
        .filter((c) => c.readyState === 1)
        .map((c) => sendConnectionMeta(c))
    );
    schedulePlayStartBroadcast();
  } finally {
    roundEnding = false;
  }
}

async function runMaybeEndRound() {
  if (!isClusterLeader()) return;
  if (roundEnding) return;
  if (gameFinished) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  if (Date.now() < getRoundBattleEndRealMs()) return;
  /* Авторитетный итог: полный пересчёт очков по pixels внутри buildStatsPayload (recalculateAllTeamScores). */
  const stats = buildStatsPayload();
  const rows = stats.rows || [];
  if (rows.length === 0) {
    roundStartMs = Date.now();
    saveRoundState();
    return;
  }

  if (roundIndex === 3) {
    const top = rows[0];
    if (!top || typeof top.teamId !== "number") {
      roundStartMs = Date.now();
      saveRoundState();
      return;
    }
    await finalizeGameEnd(top);
    return;
  }
  if (roundIndex === 2) {
    const top = rows[0];
    if (!top || typeof top.teamId !== "number") {
      roundStartMs = Date.now();
      saveRoundState();
      return;
    }
    await advanceToDuelRound(top);
    return;
  }

  roundEnding = true;
  try {
    const winnerTeamId = rows[0].teamId;
    const winningTeamName = rows[0].name || "";
    const winnerScore = typeof rows[0].score === "number" ? rows[0].score : 0;
    const winnerScoreShare =
      typeof rows[0].scoreSharePercent === "number"
        ? rows[0].scoreSharePercent
        : typeof rows[0].percent === "number"
          ? rows[0].percent
          : 0;

    /** Конец раунда 1 (полуфинал) → в раунд 2 только MAX_PLAYERS_ADVANCING_FROM_SEMI человек; конец раунда 0 → все победители. */
    const eligibleCap = roundIndex === 1 ? MAX_PLAYERS_ADVANCING_FROM_SEMI : undefined;
    setEligibleKeysFromWinnerTeam(winnerTeamId, eligibleCap);

    eligibleTokenSet = new Set();
    winnerTokensByPlayerKey = {};
    /** @type {Map<string, string>} */
    const tokenByPlayerKey = new Map();
    for (const pk of eligiblePlayerKeys) {
      const tok = crypto.randomBytes(18).toString("hex");
      eligibleTokenSet.add(tok);
      winnerTokensByPlayerKey[pk] = tok;
      tokenByPlayerKey.set(pk, tok);
    }

    /** @type {Map<object, string>} */
    const winnerTokenByClient = new Map();

    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const pk = client.playerKey ? sanitizePlayerKey(client.playerKey) : "";
      const tok = pk && tokenByPlayerKey.has(pk) ? tokenByPlayerKey.get(pk) : null;
      if (tok) {
        winnerTokenByClient.set(client, tok);
        client.eligible = true;
        client.eliminated = false;
      } else {
        client.eligible = false;
        client.eliminated = true;
      }
      client.teamId = null;
    }

    teamMemberKeys.clear();
    teamPlayerCounts.clear();
    clearAllFlagCaptureState();
    clearTerritoryIsolationState();
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    const endedRoundIndex = roundIndex;
    roundIndex++;
    roundTimerStarted = true;
    round0WarmupMs = WARMUP_MS;
    roundStartMs = Date.now();
    roundDurationMs = battleDurationForRound(roundIndex);
    clearTiebreakSnapshots();
    resetBattleEventsStateForNewBattleRound();
    rebuildLandFromRound(roundIndex);
    saveRoundState();

    const topTeams = rows.slice(0, 10).map((r) => ({
      rank: r.rank,
      teamId: r.teamId,
      name: r.name,
      emoji: r.emoji,
      score: r.score,
      scoreSharePercent: r.scoreSharePercent,
      percent: r.percent,
      pixels: r.pixels,
    }));

    broadcast({
      type: "roundEnded",
      roundIndex,
      endedRoundIndex,
      winnerTeamId,
      winnerName: winningTeamName,
      winnerScore,
      winnerScoreSharePercent: winnerScoreShare,
      winnerPercent: winnerScoreShare,
      topTeams,
      roundEndsAt: getRoundBattleEndRealMs(),
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
    await Promise.all(
      [...wss.clients]
        .filter((c) => c.readyState === 1)
        .map((c) => sendConnectionMeta(c))
    );
    schedulePlayStartBroadcast();
  } finally {
    roundEnding = false;
  }
}

function maybeEndRound() {
  void runMaybeEndRound();
}

setInterval(() => maybeEndRound(), 30000);
setInterval(() => tickFlagBaseRegen(Date.now()), 500);
setInterval(() => tickBattleEvents(Date.now()), 1000);
setInterval(() => {
  if (gameFinished) return;
  if (REDIS_URL && !isClusterLeader()) return;
  const removed = advanceTerritoryIsolationState();
  if (!removed) return;
  const next = computeTeamTerritoryCounts();
  notifyTerritoryDramaEvents(lastTerritoryCountSnapshot, next);
  lastTerritoryCountSnapshot = new Map(next);
  scanAndEliminateTeamsWithNoTerritory();
  const st = buildStatsPayload();
  updateTiebreakFromStatsPayload(st);
  checkDuelInstantWin(st);
  scheduleStatsBroadcast();
}, 250);

wss.on("connection", (ws, req) => {
  const ip = getClientIpFromReq(req);
  ws._clientIp = ip;
  ws._connId = ++wsConnSeq;
  activeWsByIp.set(ip, (activeWsByIp.get(ip) || 0) + 1);

  ws.teamId = null;
  ws.telegramVerified = false;
  ws.eligible = !gameFinished && roundIndex === 0;
  ws.eliminated = gameFinished || roundIndex !== 0;

  void (async () => {
    await sendConnectionMeta(ws);
    safeSend(ws, fullPayload());
    broadcastStatsImmediate();
  })();

  ws.on("message", (data) => {
    void (async () => {
    if (!wsMsgLimiter.allow(`m:${ws._connId}`, WS_MSG_PER_SEC, 1000)) {
      try {
        ws.close(1008, "rate");
      } catch {
        /* ignore */
      }
      return;
    }
    const raw = String(data);
    if (raw.length > 131072) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (!msg || typeof msg !== "object") return;

    maybeEndRound();

    if (msg.type === "clientProfile") {
      await rememberPlayerProfile(ws, msg);
      await sendConnectionMeta(ws);
      safeSend(ws, await buildWalletPayload(ws));
      return;
    }

    if (msg.type === "claimEligibility") {
      if (gameFinished) {
        safeSend(ws,{ type: "claimError", reason: "invalid" });
        return;
      }
      await rememberPlayerProfile(ws, msg);
      if (REQUIRE_TELEGRAM_AUTH_FOR_PLAY && !ws.telegramVerified) {
        safeSend(ws, { type: "claimError", reason: "need_telegram" });
        return;
      }
      const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
      if (roundIndex > 0 && (!pk || !isPlayerKeyEligibleForCurrentRound(pk))) {
        safeSend(ws, { type: "claimError", reason: "not_eligible" });
        return;
      }
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
        await sendConnectionMeta(ws);
      } else if (explicitToken) {
        const cip = ws._clientIp || "unknown";
        if (!claimAttemptLimiter.allow(`claim:${cip}`, 25, 60_000)) {
          safeSend(ws, { type: "claimError", reason: "rate" });
          return;
        }
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
      if (dt.eliminated) {
        safeSend(ws, { type: "updateTeamError", reason: "no_team" });
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
      safeSend(ws, { type: "setTeamColorError", reason: "locked" });
      return;
    }

    if (msg.type === "soloSetColor") {
      safeSend(ws, { type: "soloColorError", reason: "locked" });
      return;
    }

    if (msg.type === "createTeam") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      reconcileWsTeamMembership(ws);
      if (roundIndex === 3) {
        safeSend(ws, { type: "createTeamError", reason: "duel" });
        return;
      }
      if (ws.teamId != null) {
        safeSend(ws,{ type: "createTeamError", reason: "already" });
        return;
      }
      const name = sanitizeTeamName(msg.name);
      const emoji = sanitizeTeamEmoji(msg.emoji);
      if (!name || !emoji) {
        safeSend(ws,{ type: "createTeamError", reason: "fields" });
        return;
      }
      if (nextTeamId > 255) {
        safeSend(ws,{ type: "createTeamError", reason: "limit" });
        return;
      }
      const spawn = findValidSpawnRect6();
      if (!spawn) {
        safeSend(ws, { type: "createTeamError", reason: "spawn_failed" });
        return;
      }
      const id = nextTeamId++;
      const pkForColor = sanitizePlayerKey(ws.playerKey);
      const fromClient = pickCreateTeamColorFromMessage(msg.color);
      const color = fromClient || pickAutoTeamColor(name, emoji, pkForColor || `id:${id}`);
      const editToken = newTeamEditToken();
      dynamicTeams.push({
        id,
        name,
        emoji,
        color,
        editToken,
        solo: false,
        eliminated: false,
        spawnX0: spawn.x0,
        spawnY0: spawn.y0,
      });
      saveDynamicTeams();
      paintTeamSpawnArea(id, spawn.x0, spawn.y0, pkForColor || "");
      ws.teamId = id;
      teamPlayerCounts.set(id, 1);
      if (ws.playerKey) addTeamMemberKey(id, ws.playerKey);
      const team = {
        id,
        name,
        emoji,
        color,
        solo: false,
        spawn: { x0: spawn.x0, y0: spawn.y0, w: TEAM_SPAWN_SIZE, h: TEAM_SPAWN_SIZE },
      };
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
      broadcast({
        type: "teamCreated",
        teamId: id,
        spawn: { x0: spawn.x0, y0: spawn.y0, w: TEAM_SPAWN_SIZE, h: TEAM_SPAWN_SIZE },
      });
      broadcastStatsImmediate();
      return;
    }

    if (msg.type === "soloPlay") {
      safeSend(ws, { type: "soloError", reason: "disabled" });
      return;
    }

    if (msg.type === "soloResume") {
      safeSend(ws, { type: "soloResumeError", reason: "disabled" });
      return;
    }

    if (msg.type === "joinTeam") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      reconcileWsTeamMembership(ws);
      if (roundIndex === 3) {
        safeSend(ws, { type: "joinError", reason: "duel" });
        return;
      }
      const tid = Number(msg.teamId) | 0;
      const valid = validTeamId(tid);
      if (!valid) {
        safeSend(ws,{ type: "joinError", reason: "team" });
        return;
      }
      const dtJoin = dynamicTeams.find((t) => t.id === tid);
      if (!dtJoin || dtJoin.solo || dtJoin.eliminated) {
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
      const sp =
        typeof dtJoin.spawnX0 === "number" && typeof dtJoin.spawnY0 === "number"
          ? { x0: dtJoin.spawnX0, y0: dtJoin.spawnY0, w: TEAM_SPAWN_SIZE, h: TEAM_SPAWN_SIZE }
          : null;
      safeSend(ws, { type: "joined", teamId: tid, spawn: sp });
      if (sp) {
        safeSend(ws, { type: "teamBaseHighlighted", teamId: tid, spawn: sp });
      }
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

    if (msg.type === "purchasePersonalRecovery") {
      if (!assertCanPlay(ws)) return;
      if (blockPrePlayPurchases(ws)) return;
      attachPlayerKey(ws, msg);
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!pk) return;
      if (!wsPurchaseLimiter.allow(`pur:${pk}`, WS_PURCHASE_PER_10S, 10_000)) {
        safeSend(ws, { type: "purchaseError", reason: "rate_limited" });
        return;
      }
      const devUnl = isDevUnlimitedWallet(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      if (!stageAllows(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const tier = [10, 5, 2, 1].includes(msg.tierSec | 0) ? msg.tierSec | 0 : 0;
      if (!tier) {
        safeSend(ws, { type: "purchaseError", reason: "bad request" });
        return;
      }
      const priceQuant = PRICES_QUANT.personal[tier];
      const u = await walletStore.getOrCreateUser(pk);
      const now = Date.now();
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      u.personalRecoverySec = tier;
      u.personalRecoveryUntil = now + RECOVERY_BUFF_DURATION_MS;
      if (!devUnl) {
        await walletStore.recordSpend(pk, quantToUsdt(priceQuant), `personal_recovery_${tier}s`, { deferSave: true });
      }
      await walletStore.save();
      broadcast({
        type: "purchaseVfx",
        kind: "personalRecovery",
        teamId: ws.teamId | 0,
        tierSec: tier,
      });
      safeSend(ws, { type: "purchaseOk", kind: "personalRecovery", tierSec: tier });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseZoneCapture") {
      if (!assertCanPlay(ws)) return;
      if (blockPrePlayPurchases(ws)) return;
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
        return;
      }
      if (isTeamEliminated(ws.teamId)) {
        safeSend(ws, { type: "purchaseError", reason: "team_eliminated" });
        return;
      }
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!wsPurchaseLimiter.allow(`pur:${pk}`, WS_PURCHASE_PER_10S, 10_000)) {
        safeSend(ws, { type: "purchaseError", reason: "rate_limited" });
        return;
      }
      const devUnl = isDevUnlimitedWallet(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      if (!stageAllows(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const u = await walletStore.getOrCreateUser(pk);
      const tid = ws.teamId;
      const now = Date.now();
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      const r = zoneRect4(cx, cy);
      const planned = planCaptureRect(r.x0, r.y0, r.x1, r.y1);
      if (planned.length === 0) {
        safeSend(ws, { type: "purchaseError", reason: "no_playable_land" });
        return;
      }
      const connected = filterPlannedReachableFromTeam(planned, tid);
      if (connected.length === 0 || connected.length !== planned.length) {
        safeSend(ws, { type: "purchaseError", reason: "not_adjacent" });
        return;
      }
      const priceQuant = PRICES_QUANT.zone4;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, connected);
      /* lastActionAt не трогаем — интервал между обычными пикселями идёт отдельно от зоны 4×4. */
      u.lastZoneCaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "zone_capture_4x4", { deferSave: true });
      await walletStore.save();
      scheduleStatsBroadcast();
      broadcast({
        type: "purchaseVfx",
        kind: "zoneCapture",
        teamId: tid,
        gx: r.x0,
        gy: r.y0,
        size: 4,
      });
      safeSend(ws, { type: "purchaseOk", kind: "zoneCapture", cells: connected.length, size: 4 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseMassCapture") {
      if (!assertCanPlay(ws)) return;
      if (blockPrePlayPurchases(ws)) return;
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
        return;
      }
      if (isTeamEliminated(ws.teamId)) {
        safeSend(ws, { type: "purchaseError", reason: "team_eliminated" });
        return;
      }
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!wsPurchaseLimiter.allow(`pur:${pk}`, WS_PURCHASE_PER_10S, 10_000)) {
        safeSend(ws, { type: "purchaseError", reason: "rate_limited" });
        return;
      }
      const devUnl = isDevUnlimitedWallet(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      if (!stageAllows(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const u = await walletStore.getOrCreateUser(pk);
      const tid = ws.teamId;
      const now = Date.now();
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      const planned = planCaptureRect(cx - 2, cy - 2, cx + 3, cy + 3);
      if (planned.length === 0) {
        safeSend(ws, { type: "purchaseError", reason: "no_playable_land" });
        return;
      }
      const connected = filterPlannedReachableFromTeam(planned, tid);
      if (connected.length === 0 || connected.length !== planned.length) {
        safeSend(ws, { type: "purchaseError", reason: "not_adjacent" });
        return;
      }
      const priceQuant = PRICES_QUANT.zone6;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, connected);
      /* lastActionAt не трогаем — интервал между обычными пикселями идёт отдельно от масс-захвата 6×6. */
      u.lastMassCaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "mass_capture_6x6", { deferSave: true });
      await walletStore.save();
      scheduleStatsBroadcast();
      broadcast({
        type: "purchaseVfx",
        kind: "massCapture",
        teamId: tid,
        gx: cx - 2,
        gy: cy - 2,
        size: 6,
      });
      safeSend(ws, { type: "purchaseOk", kind: "massCapture", cells: connected.length, size: 6 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseZone12Capture") {
      if (!assertCanPlay(ws)) return;
      if (blockPrePlayPurchases(ws)) return;
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
        return;
      }
      if (isTeamEliminated(ws.teamId)) {
        safeSend(ws, { type: "purchaseError", reason: "team_eliminated" });
        return;
      }
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!wsPurchaseLimiter.allow(`pur:${pk}`, WS_PURCHASE_PER_10S, 10_000)) {
        safeSend(ws, { type: "purchaseError", reason: "rate_limited" });
        return;
      }
      const devUnl = isDevUnlimitedWallet(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      if (!stageAllows(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const u = await walletStore.getOrCreateUser(pk);
      const tid = ws.teamId;
      const now = Date.now();
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      const planned = planCaptureRect(cx - 5, cy - 5, cx + 6, cy + 6);
      if (planned.length === 0) {
        safeSend(ws, { type: "purchaseError", reason: "no_playable_land" });
        return;
      }
      const connected = filterPlannedReachableFromTeam(planned, tid);
      if (connected.length === 0 || connected.length !== planned.length) {
        safeSend(ws, { type: "purchaseError", reason: "not_adjacent" });
        return;
      }
      const priceQuant = PRICES_QUANT.zone12;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, connected);
      u.lastZone12CaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "zone_capture_12x12", { deferSave: true });
      await walletStore.save();
      scheduleStatsBroadcast();
      broadcast({
        type: "purchaseVfx",
        kind: "zone12Capture",
        teamId: tid,
        gx: cx - 5,
        gy: cy - 5,
        size: 12,
      });
      safeSend(ws, { type: "purchaseOk", kind: "zone12Capture", cells: connected.length, size: 12 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseTeamRecovery") {
      if (!assertCanPlay(ws)) return;
      if (blockPrePlayPurchases(ws)) return;
      attachPlayerKey(ws, msg);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
        return;
      }
      if (isTeamEliminated(ws.teamId)) {
        safeSend(ws, { type: "purchaseError", reason: "team_eliminated" });
        return;
      }
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!wsPurchaseLimiter.allow(`pur:${pk}`, WS_PURCHASE_PER_10S, 10_000)) {
        safeSend(ws, { type: "purchaseError", reason: "rate_limited" });
        return;
      }
      const devUnl = isDevUnlimitedWallet(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      if (!stageAllows(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const tier = [15, 10, 5, 2, 1].includes(msg.tierSec | 0) ? msg.tierSec | 0 : 0;
      if (!tier) {
        safeSend(ws, { type: "purchaseError", reason: "bad request" });
        return;
      }
      const priceQuant = PRICES_QUANT.team[tier];
      const tid = ws.teamId;
      const fx = getTeamFx(tid);
      const now = Date.now();
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      fx.teamRecoverySec = tier;
      fx.teamRecoveryUntil = now + RECOVERY_BUFF_DURATION_MS;
      if (!devUnl) {
        await walletStore.recordSpend(pk, quantToUsdt(priceQuant), `team_recovery_${tier}s`, { deferSave: true });
      }
      await walletStore.save();
      broadcast({
        type: "teamEffect",
        teamId: tid,
        kind: "teamRecovery",
        until: fx.teamRecoveryUntil,
        teamRecoverySec: fx.teamRecoverySec,
      });
      safeSend(ws, { type: "purchaseOk", kind: "teamRecovery", tierSec: tier });
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "pixel") {
      if (REDIS_URL && !isClusterLeader()) {
        safeSend(ws, { type: "pixelReject", reason: "not_leader" });
        return;
      }
      if (!assertCanPlay(ws)) return;
      if (ws.teamId == null) {
        safeSend(ws,{ type: "pixelReject", reason: "no_team" });
        return;
      }
      const x = msg.x | 0;
      const y = msg.y | 0;
      const teamId = ws.teamId;
      if (isTeamEliminated(teamId)) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "team_eliminated" });
        safeSend(ws, { type: "pixelReject", reason: "team_eliminated" });
        return;
      }
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "out_of_bounds" });
        safeSend(ws, { type: "pixelReject", reason: "out_of_bounds" });
        return;
      }
      if (!cellAllowsPixelPlacement(x, y)) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "water" });
        safeSend(ws, { type: "pixelReject", reason: "water" });
        return;
      }

      const key = `${x},${y}`;
      const enemyFlagDef = findEnemyFlagDefenderAtCell(teamId, x, y);

      if (isWarmupPhaseNow() && !enemyFlagDef) {
        const tid = ws.teamId | 0;
        safeSend(ws, { type: "invalidPlacement", teamId: tid, reason: "warmup" });
        safeSend(ws, { type: "pixelReject", reason: "warmup" });
        return;
      }

      if (!enemyFlagDef) {
        const existingPx = pixels.get(key);
        if (existingPx != null && pixelTeam(existingPx) === (teamId | 0)) {
          safeSend(ws, { type: "invalidPlacement", teamId, reason: "already_yours" });
          safeSend(ws, { type: "pixelReject", reason: "already_yours" });
          return;
        }
      }
      if (!canPlaceForTeam(x, y, teamId)) {
        const adjReason = enemyFlagDef ? "enemy_base_not_adjacent" : "not_adjacent";
        safeSend(ws, { type: "invalidPlacement", teamId, reason: adjReason });
        safeSend(ws, { type: "pixelReject", reason: adjReason });
        return;
      }

      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      const pk = sanitizePlayerKey(ws.playerKey);
      if (!pk) {
        safeSend(ws, { type: "pixelReject", reason: "no_team" });
        return;
      }
      if (!wsPixelBurstLimiter.allow(`px:${pk}`, WS_PIXEL_BURST_PER_SEC, 1000)) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "rate_limited" });
        safeSend(ws, { type: "pixelReject", reason: "rate_limited" });
        return;
      }
      const u = await walletStore.getOrCreateUser(pk);
      const st = tournamentStage(roundIndex, gameFinished);
      const fx = getTeamFx(teamId);
      const teamFxPayload = { teamRecoveryUntil: fx.teamRecoveryUntil, teamRecoverySec: fx.teamRecoverySec };
      const now = Date.now();
      const cd = getCurrentCooldownMs(u, teamFxPayload, st, now);
      if (now < u.lastActionAt + cd) {
        await walletStore.save();
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "cooldown not ready" });
        safeSend(ws, { type: "pixelReject", reason: "cooldown not ready" });
        return;
      }

      const fc = tryFlagCaptureHit(teamId, x, y, now);
      if (fc && fc.rateLimited) {
        await walletStore.save();
        safeSend(ws, { type: "pixelReject", reason: "flag_rate" });
        return;
      }
      if (fc && (fc.hit || fc.captured)) {
        u.lastActionAt = now;
        await walletStore.save();
        if (!fc.captured) {
          scheduleStatsBroadcast();
        }
        safeSend(ws, await buildWalletPayload(ws));
        if (fc.hit && typeof fc.hp === "number") {
          safeSend(ws, {
            type: "flagHitAck",
            defenderTeamId: fc.defenderTeamId | 0,
            hp: fc.hp | 0,
            maxHp: (fc.maxHp ?? FLAG_BASE_MAX_HP) | 0,
          });
        }
        return;
      }

      if (enemyFlagDef) {
        await walletStore.save();
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "enemy_base" });
        safeSend(ws, { type: "pixelReject", reason: "enemy_base" });
        return;
      }

      u.lastActionAt = now;
      await walletStore.save();

      /* Обычная покраска: не якорь чужой базы (это только tryFlagCaptureHit / executeFlagCaptureSuccess). */
      const rec = { teamId, ownerPlayerKey: pk, shieldedUntil: 0 };
      pixels.set(key, rec);
      broadcast({ type: "pixel", x, y, t: teamId, ownerPlayerKey: pk, shieldedUntil: 0 });
      scheduleStatsBroadcast();
      afterTerritoryMutation();
      safeSend(ws, await buildWalletPayload(ws));
      return;
    }
    })();
  });

  ws.on("close", () => {
    if (ws._trackedPk) {
      untrackOnlinePk(ws._trackedPk);
      ws._trackedPk = null;
    }
    const cip = ws._clientIp || "0.0.0.0";
    const left = (activeWsByIp.get(cip) || 1) - 1;
    if (left <= 0) activeWsByIp.delete(cip);
    else activeWsByIp.set(cip, left);

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
async function notifyFinalWinnersTelegram(winnerPlayerKeys, teamName, winnerRow) {
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
  const sc =
    winnerRow && typeof winnerRow.score === "number" && Number.isFinite(winnerRow.score)
      ? winnerRow.score.toFixed(2)
      : "—";
  const shareRaw =
    winnerRow && typeof winnerRow.scoreSharePercent === "number"
      ? winnerRow.scoreSharePercent
      : winnerRow && typeof winnerRow.percent === "number"
        ? winnerRow.percent
        : null;
  const shareStr =
    typeof shareRaw === "number" && Number.isFinite(shareRaw) ? shareRaw.toFixed(3) : String(shareRaw ?? "—");
  const body =
    `Финал Pixel Battle\n` +
    `Победители: «${teamName}» — счёт ${sc} оч., доля доступных очков ${shareStr}%\n` +
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
async function startRoundOneTimer(durationHours) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  if (gameFinished) return { ok: false, reason: "game_finished" };
  if (roundIndex !== 0) return { ok: false, reason: "not_round_first" };
  if (roundTimerStarted) return { ok: false, reason: "already_started" };
  let ms = battleDurationForRound(0);
  if (typeof durationHours === "number" && Number.isFinite(durationHours) && durationHours > 0) {
    ms = Math.round(durationHours * 60 * 60 * 1000);
    ms = Math.min(Math.max(ms, 1000), 8760 * 60 * 60 * 1000);
  }
  roundDurationMs = ms;
  round0WarmupMs = ROUND_ZERO_POST_GO_WARMUP_MS;
  roundTimerStarted = true;
  roundStartMs = Date.now();
  clearTiebreakSnapshots();
  resetMassRoundBattlefieldAfterWarmup();
  schedulePlayStartBroadcast();
  broadcastTournamentTimeScaleToClients();
  await Promise.all(
    [...wss.clients]
      .filter((c) => c.readyState === 1)
      .map((c) => sendConnectionMeta(c))
  );
  broadcastStatsImmediate();
  return { ok: true, durationMs: ms, warmupMs: ROUND_ZERO_POST_GO_WARMUP_MS };
}

async function telegramSendMessage(chatId, text, extra = {}) {
  const payload = { chat_id: chatId, text, ...extra };
  const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  let data;
  try {
    data = await res.json();
  } catch {
    return;
  }
  if (!data.ok) console.warn("Telegram sendMessage:", data.description || res.status);
}

/** Команда paint: playerKey в игре = tg_<Telegram user id>. */
function findTeamIdForTelegramUid(uid) {
  const pk = sanitizePlayerKey(`tg_${uid}`);
  if (!pk) return null;
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const set = teamMemberKeys.get(t.id | 0);
    if (set) {
      for (const k of set) {
        if (sanitizePlayerKey(k) === pk) return t.id | 0;
      }
    }
  }
  if (wss) {
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      if (sanitizePlayerKey(c.playerKey) !== pk) continue;
      const tid = c.teamId | 0;
      if (tid) return tid;
    }
  }
  return null;
}

/** Свободная суша: нет записи в pixels или teamId 0. Не перекрашивает чужие/свои клетки. */
function isLandCellUnclaimedPixel(x, y) {
  if (!cellAllowsPixelPlacement(x, y)) return false;
  const k = `${x},${y}`;
  if (!pixels.has(k)) return true;
  return pixelTeam(pixels.get(k)) === 0;
}

/**
 * Закрасить всю свободную сушу в цвет команды (только для админской команды paint в Telegram).
 * @returns {number} сколько клеток закрашено
 */
function paintAllFreeLandPixelsForTeam(teamId, ownerPlayerKey) {
  const tid = teamId | 0;
  const pk = sanitizePlayerKey(ownerPlayerKey);
  let n = 0;
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      if (!isLandCellUnclaimedPixel(x, y)) continue;
      const key = `${x},${y}`;
      pixels.set(key, { teamId: tid, ownerPlayerKey: pk, shieldedUntil: 0 });
      n++;
    }
  }
  afterTerritoryMutation();
  scheduleStatsBroadcast();
  broadcast(JSON.parse(fullPayload()));
  return n;
}

/** Только TELEGRAM_ADMIN_IDS; карта — цвет команды, в которой состоит этот Telegram-аккаунт (Mini App). */
async function handleTelegramPaintCommand(chatId, telegramUid) {
  if (!isClusterLeader()) {
    await telegramSendMessage(
      chatId,
      "Команда paint выполняется только на лидере кластера (CLUSTER_LEADER=true на одном инстансе)."
    );
    return;
  }
  if (gameFinished) {
    await telegramSendMessage(chatId, "Игра завершена — paint недоступен.");
    return;
  }
  const teamId = findTeamIdForTelegramUid(telegramUid);
  if (!teamId) {
    await telegramSendMessage(
      chatId,
      "Не найдена ваша команда: зайдите в Mini App и вступите в команду (нужна привязка аккаунта tg_" +
        telegramUid +
        ")."
    );
    return;
  }
  const dt = dynamicTeams.find((t) => (t.id | 0) === teamId);
  if (!dt || dt.eliminated) {
    await telegramSendMessage(chatId, "Команда выбыла или недоступна.");
    return;
  }
  const ownerPk = sanitizePlayerKey(`tg_${telegramUid}`);
  const painted = paintAllFreeLandPixelsForTeam(teamId, ownerPk);
  await telegramSendMessage(
    chatId,
    `paint: закрашено свободных клеток: ${painted}. Цвет команды «${dt.name || ""}» (id ${teamId}).`
  );
}

/**
 * Ручное включение событий карты (только TELEGRAM_ADMIN_IDS, только лидер кластера).
 * Сообщения: evt gold, gold, evt mapcomp 45 (минут), gold off, evt off, seismic, evt help.
 */
async function handleTelegramManualBattleCommand(chatId, lineRaw) {
  if (!isClusterLeader()) {
    await telegramSendMessage(
      chatId,
      "Ручные события выполняет только лидер кластера (на вторичных инстансах задано CLUSTER_LEADER=false)."
    );
    return;
  }
  const parts = String(lineRaw || "")
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) {
    await telegramSendMessage(chatId, MANUAL_BATTLE_EVENT_HELP_RU);
    return;
  }
  if (parts[0] === "help" || parts[0] === "list") {
    await telegramSendMessage(chatId, MANUAL_BATTLE_EVENT_HELP_RU);
    return;
  }
  if (parts[0] === "off" && parts.length === 1) {
    manualBattleSlotsByCmd.clear();
    saveRoundState();
    broadcastManualBattleSyncAndStats();
    await telegramSendMessage(chatId, "Все ручные события сняты.");
    return;
  }
  const cmd0 = normalizeManualBattleCmdKey(parts[0]);
  if (parts[1] === "off") {
    manualBattleSlotsByCmd.delete(cmd0);
    saveRoundState();
    broadcastManualBattleSyncAndStats();
    await telegramSendMessage(chatId, `Событие «${cmd0}» выключено.`);
    return;
  }
  if (cmd0 === "seismic") {
    const now = Date.now();
    const ctx = getBattleEventsContext(now);
    if (!ctx) {
      await telegramSendMessage(
        chatId,
        "Сейсмика: доступна только во время боя (после разминки, до конца раунда)."
      );
      return;
    }
    const seed = `manual_seismic_${now}`;
    applySeismicForLeader(seed, seed);
    await telegramSendMessage(chatId, "Сейсмика выполнена (очистка клеток по шарам Манхэттена).");
    return;
  }
  const def = resolveManualBattleCommandToTimelineDef(cmd0, roundIndex);
  if (!def) {
    await telegramSendMessage(
      chatId,
      `Неизвестная команда «${cmd0}». Отправьте: evt help`
    );
    return;
  }
  const battleEnd = getRoundBattleEndRealMs();
  const now = Date.now();
  let until = battleEnd;
  if (parts[1] && /^\d/.test(parts[1])) {
    const mins = parseFloat(parts[1].replace(",", "."));
    if (Number.isFinite(mins) && mins > 0) {
      until = Math.min(now + Math.round(mins * 60000), battleEnd);
    }
  }
  if (until <= now) {
    await telegramSendMessage(chatId, "Окно боя уже закрыто или время until в прошлом.");
    return;
  }
  manualBattleSlotsByCmd.set(cmd0, until);
  pruneExpiredManualBattleSlots(now);
  saveRoundState();
  broadcastManualBattleSyncAndStats();
  const leftMin = Math.max(1, Math.round((until - now) / 60000));
  await telegramSendMessage(
    chatId,
    `OK: «${cmd0}» активно ~${leftMin} мин (до ${new Date(until).toLocaleString("ru-RU")} или конца боя).`
  );
}

async function telegramPollLoop() {
  if (!TELEGRAM_BOT_TOKEN) return;
  let offset = 0;
  for (;;) {
    try {
      const res = await fetch(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/getUpdates?timeout=30&offset=${offset}`
      );
      if (!res.ok) {
        console.warn("Telegram getUpdates HTTP:", res.status);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
      let data;
      try {
        data = await res.json();
      } catch (e) {
        console.warn("Telegram getUpdates JSON:", e?.message || e);
        await new Promise((r) => setTimeout(r, 5000));
        continue;
      }
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
        if (uid == null) continue;
        const chatId = msg.chat.id;
        let t = String(msg.text).trim();

        if (isStartCommand(t)) {
          const launchUrl = buildMiniAppOpenUrl(parseStartPayload(t));
          const startBtn = launchUrl ? buildTelegramStartInlineButton(launchUrl) : null;
          if (startBtn) {
            await telegramSendMessage(chatId, TELEGRAM_START_MESSAGE, {
              reply_markup: {
                inline_keyboard: [[startBtn]],
              },
            });
          } else {
            await telegramSendMessage(
              chatId,
              `${TELEGRAM_START_MESSAGE}\n\n(Админу: задайте TELEGRAM_MINIAPP_LINK или TELEGRAM_BOT_USERNAME + TELEGRAM_MINIAPP_SHORT_NAME — тогда здесь появится кнопка запуска.)`
            );
          }
          continue;
        }

        if (!TELEGRAM_ADMIN_IDS.has(uid)) {
          if (telegramMessageLooksLikePrivilegedCommand(t)) {
            await telegramSendMessage(
              chatId,
              "Сервер не считает вас администратором: в TELEGRAM_ADMIN_IDS на сервере должен быть ваш числовой user id (узнать: @userinfobot). Без этого go, speed, evt и др. игнорируются."
            );
          }
          continue;
        }
        const restartNorm = t
          .toLowerCase()
          .replace(/^\/+/, "")
          .replace(/\s+/g, " ");
        const speedCmd = restartNorm.replace(/^\/speed\b/, "speed").trim();
        if (speedCmd === "speed" || speedCmd.startsWith("speed ")) {
          const parts = speedCmd.split(/\s+/).filter(Boolean);
          const sub = (parts[1] || "").toLowerCase();
          let target = 60;
          if (parts.length === 1) {
            target = getTournamentTimeScale() > 1 ? TOURNAMENT_TIME_SCALE_DEFAULT : 60;
          } else if (sub === "off" || sub === "0") {
            target = TOURNAMENT_TIME_SCALE_DEFAULT;
          } else {
            const n = parseFloat(parts[1].replace(",", "."));
            if (!Number.isFinite(n) || n < 1) {
              await telegramSendMessage(
                chatId,
                "speed — ускорение турнира для теста. Примеры: speed (×60 или выкл), speed off, speed 1, speed 120."
              );
              continue;
            }
            target = n;
          }
          const applied = applyTournamentTimeScale(target);
          if (applied <= 1) {
            await telegramSendMessage(chatId, "Speed mode: OFF (таймеры раунда в реальном времени).");
          } else {
            await telegramSendMessage(
              chatId,
              `Speed mode: ×${applied} (1 реальная минута ≈ 1 игровой час). Сжаты только разминка/бой/конец раунда. Кулдауны, реген HP базы и темп ударов по флагу — как в обычном времени.`
            );
          }
          continue;
        }

        {
          const paintWord = (restartNorm.split(/\s+/)[0] || "").replace(/@\w+$/i, "");
          if (paintWord === "paint" && restartNorm.split(/\s+/).length === 1) {
            await handleTelegramPaintCommand(chatId, uid);
            continue;
          }
        }

        let manualBattleLine = null;
        if (restartNorm.startsWith("evt ") || restartNorm.startsWith("event ")) {
          manualBattleLine = restartNorm.replace(/^(evt|event)\s+/i, "").trim();
        } else {
          const fw = restartNorm.split(/\s+/)[0] || "";
          if (fw !== "off" && MANUAL_TELEGRAM_CMD_FIRST_WORDS.has(fw)) manualBattleLine = restartNorm;
        }
        if (manualBattleLine != null) {
          await handleTelegramManualBattleCommand(chatId, manualBattleLine);
          continue;
        }

        if (restartNorm === "рестарт" || restartNorm === "restart") {
          if (TELEGRAM_ENABLE_PROCESS_RESTART) {
            await telegramSendMessage(chatId, "Перезапуск приложения…");
            setTimeout(() => process.exit(0), 400);
          } else {
            await telegramSendMessage(
              chatId,
              "Перезапуск процесса через бота отключён (чтобы не сбрасывать игру всем). Задайте TELEGRAM_ENABLE_PROCESS_RESTART=true и перезапустите сервер — или перезапустите деплой вручную (Render и т.п.)."
            );
          }
          continue;
        }
        t = t.replace(/^\/go\b/i, "go");
        t = t.replace(/^гол(\s+)/i, "go$1").replace(/^гол(\d)/i, "go $1");
        t = t.replace(/^го(\s+)/iu, "go$1").replace(/^го(\d)/iu, "go $1");
        const tl = t.toLowerCase();
        if (!tl.startsWith("go")) {
          if (t.trim().startsWith("/")) {
            await telegramSendMessage(
              chatId,
              "Неизвестная команда. Админ: /start, go [часы], speed, paint, restart, evt help, gold, seismic…"
            );
          }
          continue;
        }
        const rest = t.slice(2).trim();
        let hours = 8;
        if (rest.length) {
          const n = parseFloat(rest.replace(",", "."));
          if (!Number.isFinite(n) || n <= 0) {
            await telegramSendMessage(
              chatId,
              "Укажите положительное число часов: go 100, го 50, го 0.1 (латиница go, кириллица го или «гол»)."
            );
            continue;
          }
          hours = n;
        }
        const result = await startRoundOneTimer(hours);
        let reply;
        if (result.ok) {
          const h = (result.durationMs ?? roundDurationMs) / 3600000;
          const sc = getTournamentTimeScale();
          const warmMs = result.warmupMs ?? ROUND_ZERO_POST_GO_WARMUP_MS;
          const warmRealSec = Math.max(1, Math.round(warmMs / sc / 1000));
          const battleRealMin = Math.round(result.durationMs / sc / 60000);
          reply =
            sc > 1
              ? `Раунд 1 (TEST ×${sc}): карта очищена; до боя ~${warmRealSec} с реальных, затем бой ~${battleRealMin} мин (${h.toFixed(h < 1 ? 2 : 1)} игр. ч). Обычные пиксели с ${new Date(getPlayStartMs()).toISOString()}`
              : `Раунд 1: карта очищена, ${warmRealSec} с до старта боя, затем бой ${h.toFixed(h < 1 ? 2 : 1)} ч. Обычные пиксели с ${new Date(getPlayStartMs()).toISOString()}`;
        } else if (result.reason === "already_started") {
          reply = "Таймер первого раунда уже идёт.";
        } else if (result.reason === "game_finished") {
          reply = "Игра уже завершена.";
        } else if (result.reason === "not_leader") {
          reply =
            "Этот процесс не лидер кластера (CLUSTER_LEADER=false). Команды «go» и таймеры выполняет только лидер.";
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
  schedulePlayStartBroadcast();
  if (REDIS_URL) {
    const ch = REDIS_GAME_CHANNEL;
    import("./lib/redis-game-bus.mjs")
      .then(({ connectGameRedisBus }) =>
        connectGameRedisBus({
          url: REDIS_URL,
          channel: ch,
          onMessage: (raw) => {
            try {
              const msg = JSON.parse(raw);
              applyClusterGameReplication(msg);
              broadcastToWebSocketClients(raw);
            } catch (e) {
              console.warn("[redis game] inbound:", e.message);
            }
          },
        })
      )
      .then((bus) => {
        redisGamePublish = bus.publish;
        const leader = isClusterLeader();
        console.log(
          `[cluster] Redis Pub/Sub «${ch}» (CLUSTER_LEADER=${leader ? "true" : "false"} — таймеры раунда и Telegram long poll только на лидере; явно false — вторичный инстанс)`
        );
        if (REDIS_URL && !String(process.env.CLUSTER_LEADER || "").trim()) {
          console.log(
            "[cluster] CLUSTER_LEADER не задан — процесс считается лидером. При нескольких веб-инстансах: true на одном, false на остальных."
          );
        }
      })
      .catch((e) => console.warn("[cluster] Redis:", e.message || e));
  }
  if (TELEGRAM_BOT_TOKEN) {
    void (async () => {
      try {
        const wh = await fetch(
          `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`
        );
        const j = await wh.json().catch(() => ({}));
        if (!j.ok) console.warn("[Telegram] deleteWebhook:", j.description || wh.status);
      } catch (e) {
        console.warn("[Telegram] deleteWebhook:", e?.message || e);
      }
      if (isClusterLeader()) {
        console.log("[Telegram] long poll запущен (getUpdates).");
        telegramPollLoop().catch((e) => console.warn("Telegram poll:", e));
      } else {
        console.log("[cluster] Telegram long poll отключён (CLUSTER_LEADER=false на этом инстансе).");
      }
    })();
    if (getTelegramMiniAppLaunchUrl()) {
      console.log(
        "Telegram: команда /start — сообщение с кнопкой «Запустить игру» (TELEGRAM_MINIAPP_LINK или TELEGRAM_BOT_USERNAME + TELEGRAM_MINIAPP_SHORT_NAME)."
      );
    } else {
      console.warn(
        "[Pixel Battle] Задайте TELEGRAM_MINIAPP_LINK или TELEGRAM_BOT_USERNAME + TELEGRAM_MINIAPP_SHORT_NAME — иначе /start без кнопки Mini App."
      );
    }
    if (WAIT_FOR_TELEGRAM_GO) {
      console.log(
        'Первый раунд: «go» + часы; ускорение теста турнира: «speed» (×60 / выкл), speed off, speed 120. Рестарт процесса — TELEGRAM_ENABLE_PROCESS_RESTART=true.'
      );
    } else if (TELEGRAM_ADMIN_IDS.size === 0) {
      console.warn(
        "[Pixel Battle] Пуст TELEGRAM_ADMIN_IDS — команды «go» / «рестарт» недоступны (только /start и локальная игра)."
      );
    }
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_IDS.size > 0) {
    console.log(
      "После финала (3-й раунд) бот отправит каждому id из TELEGRAM_ADMIN_IDS username и Telegram ID участников победившей команды (до 2 чел.)."
    );
  }
});
