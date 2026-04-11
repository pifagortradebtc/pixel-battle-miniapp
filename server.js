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
import { SlidingWindowRateLimiter } from "./lib/rate-limit.js";
import {
  WARMUP_MS,
  battleDurationForRound,
  DUEL_INSTANT_WIN_SCORE_SHARE,
} from "./lib/tournament-flow.js";
import {
  aggregateScoresFromPixels,
  computeTotalAvailableScore,
} from "./lib/scoring.js";
import {
  FLAG_CAPTURE_HITS_REQUIRED,
  FLAG_CAPTURE_IDLE_MS,
  FLAG_CAPTURE_DECAY_STEP_MS,
  FLAG_CAPTURE_ENABLE_AFTER_BATTLE_FRACTION,
  FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC,
  flagCellFromSpawn,
} from "./lib/flag-capture.js";

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

/** Redis Pub/Sub: общий канал для нескольких инстансов (Render scale). Пусто — режим один процесс. */
const REDIS_URL = (process.env.REDIS_URL || "").trim();
const REDIS_GAME_CHANNEL = (process.env.REDIS_GAME_CHANNEL || "pixel-battle:game").trim();

function isClusterLeader() {
  if (!REDIS_URL) return true;
  return /^true$/i.test(String(process.env.CLUSTER_LEADER || "").trim());
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
/** Первый раунд: таймер не идёт, пока админ не отправит «go» боту (если включён WAIT_FOR_TELEGRAM_GO) */
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

/** Зарезервировано под кошелёк; отдельных «событий карты» на сервере нет (плашка на клиенте — по таймеру раунда). */
function getGlobalEventPayload() {
  return { active: false, kind: null, until: 0 };
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
    fs.mkdirSync(path.join(ROOT, "data"), { recursive: true });
    fs.writeFileSync(
      ROUND_STATE_PATH,
      JSON.stringify({
        roundIndex,
        roundStartMs,
        playStartMs,
        roundDurationMs,
        roundTimerStarted,
        eligibleTokens: [...eligibleTokenSet],
        eligiblePlayerKeys: [...eligiblePlayerKeys],
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
    } else {
      roundIndex = 0;
      roundStartMs = Date.now();
      playStartMs = roundStartMs;
      roundDurationMs = battleDurationForRound(0);
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
    playStartMs = roundStartMs;
    roundDurationMs = battleDurationForRound(0);
    eligibleTokenSet = new Set();
    gameFinished = false;
    winnerTokensByPlayerKey = {};
    roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
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
try {
  const raw = fs.readFileSync(path.join(ROOT, "data", "regions-360.json"), "utf8");
  const j = JSON.parse(raw);
  baseRegion360 = Uint8Array.from(Buffer.from(j.cellsBase64, "base64"));
  if (baseRegion360.length !== BASE_GRID * BASE_GRID) {
    console.warn("regions-360.json: неверный размер сетки");
    baseRegion360 = null;
  }
} catch (e) {
  console.warn("Нет data/regions-360.json — npm run rasterize-world-map", e.message);
}

/** @type {Uint8Array | null} маска: 0 вода (нельзя ставить пиксель), ≠0 — суша. */
let landGrid = null;
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
 * Захват флага: прогресс по защищающейся команде. Объявлено до rebuildLandFromRound (старт модуля вызывает rebuild).
 * @type {Map<number, { progress: number, lastHitAt: number, attackerTeamId: number, nextDecayAt: number | null }>}
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
    scoreWeightGrid = null;
    landPixelsTotal = gridW * gridH;
    landWeightTotal = gridW * gridH;
    return;
  }

  landGrid = new Uint8Array(gridW * gridH);
  for (let y = 0; y < gridH; y++) {
    for (let x = 0; x < gridW; x++) {
      const bx = Math.min(BASE_GRID - 1, Math.floor(((x + 0.5) / gridW) * BASE_GRID));
      const by = Math.min(BASE_GRID - 1, Math.floor(((y + 0.5) / gridH) * BASE_GRID));
      landGrid[y * gridW + x] = baseRegion360[by * BASE_GRID + bx];
    }
  }
  applyRoundShapeMask(ri, landGrid, gridW, gridH);
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
    if (px < 0 || px >= gridW || py < 0 || py >= gridH || landGrid[py * gridW + px] === 0) {
      pixels.delete(key);
    }
  }
  clearAllFlagCaptureState();
  afterTerritoryMutation();
}

function cellIsLand(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!landGrid) return true;
  return landGrid[y * gridW + x] !== 0;
}

/** Контекст для lib/scoring.js: roundIndex, сетка, суша, базовые веса клеток, глобальное событие. */
function buildScoringContext() {
  if (!landGrid) return null;
  return {
    roundIndex,
    gridW,
    gridH,
    landGrid,
    baseValueGrid: scoreWeightGrid,
    globalEvent: getGlobalEventPayload(),
  };
}

/**
 * Полный авторитетный пересчёт: очки и число занятых клеток по текущему `pixels` и getCellValue.
 * Вызывается из buildStatsPayload; при конце раунда — тот же путь (без отдельного кэша на кластере).
 */
function recalculateAllTeamScores() {
  const ctx = buildScoringContext();
  if (!ctx) return { agg: new Map(), totalAvailableScore: 0 };
  const agg = aggregateScoresFromPixels(pixels, pixelTeam, ctx);
  const totalAvailableScore = computeTotalAvailableScore(ctx);
  return { agg, totalAvailableScore };
}

function getPlayStartMs() {
  return typeof playStartMs === "number" && Number.isFinite(playStartMs) ? playStartMs : roundStartMs;
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

function schedulePlayStartBroadcast() {
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

/** @type {Map<number, { teamRecoveryUntil: number, teamRecoverySec: number }>} */
const teamEffects = new Map();

function pixelTeam(val) {
  if (val && typeof val === "object") return val.teamId;
  return val;
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
      if (!cellIsLand(x, y)) continue;
      planned.push([x, y]);
    }
  }
  return planned;
}

function applyPlannedCapture(pk, tid, planned) {
  for (const [x, y] of planned) {
    if (!cellIsLand(x, y)) continue;
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
    globalEvent: getGlobalEventPayload(),
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
    if (landGrid && (x < 0 || x >= gridW || y < 0 || y >= gridH || landGrid[y * gridW + x] === 0)) continue;
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
      if (landGrid && landGrid[y * gridW + x] === 0) return;
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
    case "teamEliminated": {
      const tid = msg.teamId | 0;
      const ri = typeof msg.roundIndex === "number" ? msg.roundIndex : roundIndex;
      const dt = dynamicTeams.find((x) => x.id === tid);
      if (dt) dt.eliminated = true;
      clearFlagCaptureStateForDefender(tid);
      removeAttackerFromAllFlagCaptures(tid, false);
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
      const p = msg.progress | 0;
      if (p <= 0) {
        flagCaptureByDefender.delete(did);
        return;
      }
      const prev = flagCaptureByDefender.get(did);
      flagCaptureByDefender.set(did, {
        progress: p,
        lastHitAt: Date.now(),
        attackerTeamId: msg.attackerTeamId | 0,
        nextDecayAt: prev?.nextDecayAt ?? null,
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
      if (v != null && pixelTeam(v) === teamId) return true;
    }
  }
  return false;
}

/** Псевдоним для правил размещения: можно ставить, если среди 8 соседей есть своя клетка. */
function canPlaceForTeam(x, y, teamId) {
  return cellTouchesTeamTerritory(x, y, teamId);
}

/** @param {boolean} emitStopped — false при репликации кластера (без повторного broadcast). */
function removeAttackerFromAllFlagCaptures(attackerTeamId, emitStopped) {
  const aid = attackerTeamId | 0;
  if (!aid) return;
  for (const [did, st] of [...flagCaptureByDefender.entries()]) {
    if ((st.attackerTeamId | 0) === aid) {
      flagCaptureByDefender.delete(did);
      if (emitStopped) {
        broadcast({ type: "flagCaptureStopped", defenderTeamId: did, reason: "attacker_gone" });
      }
    }
  }
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

function isFlagCaptureMechanicEnabled(now) {
  if (gameFinished || roundEnding) return false;
  if (roundIndex === 0 && !roundTimerStarted) return false;
  if (isWarmupPhaseNow()) return false;
  const start = getPlayStartMs();
  const end = start + roundDurationMs;
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now >= end) return false;
  const elapsed = now - start;
  const need = roundDurationMs * FLAG_CAPTURE_ENABLE_AFTER_BATTLE_FRACTION;
  return elapsed >= need;
}

function buildFlagsSnapshot() {
  const out = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
    const { x, y } = flagCellFromSpawn(t.spawnX0, t.spawnY0);
    const st = flagCaptureByDefender.get(t.id);
    const progress = Math.max(0, Math.min(FLAG_CAPTURE_HITS_REQUIRED, st?.progress | 0));
    const attackerTeamId = (st?.attackerTeamId | 0) || 0;
    out.push({
      teamId: t.id,
      fx: x,
      fy: y,
      progress,
      attackerTeamId,
      underAttack: progress > 0,
    });
  }
  return out;
}

function tickFlagCaptureDecay(now) {
  if (!isClusterLeader()) return;
  if (!isFlagCaptureMechanicEnabled(now)) return;
  for (const [did, st] of [...flagCaptureByDefender.entries()]) {
    const d = did | 0;
    let p = st.progress | 0;
    if (p <= 0) {
      flagCaptureByDefender.delete(d);
      continue;
    }
    if (now - st.lastHitAt < FLAG_CAPTURE_IDLE_MS) continue;
    if (st.nextDecayAt == null) {
      st.nextDecayAt = st.lastHitAt + FLAG_CAPTURE_IDLE_MS + FLAG_CAPTURE_DECAY_STEP_MS;
    }
    let changed = false;
    while (now >= (st.nextDecayAt || 0) && p > 0) {
      p--;
      st.progress = p;
      st.nextDecayAt = (st.nextDecayAt || 0) + FLAG_CAPTURE_DECAY_STEP_MS;
      changed = true;
    }
    if (!changed) continue;
    if (p <= 0) {
      flagCaptureByDefender.delete(d);
      broadcast({ type: "flagCaptureStopped", defenderTeamId: d, reason: "decay" });
    } else {
      broadcast({
        type: "flagCaptureProgress",
        defenderTeamId: d,
        attackerTeamId: st.attackerTeamId | 0,
        progress: p,
        decay: true,
      });
    }
  }
}

/**
 * Удар по флагу: без смены владельца клетки до завершения захвата.
 * @returns {null | { rateLimited?: true } | { hit: true } | { captured: true }}
 */
function tryFlagCaptureHit(attackerTeamId, x, y, now) {
  const defTeam = findDefenderTeamAtFlagCell(x, y);
  if (!defTeam || defTeam.id === attackerTeamId) return null;
  if (isTeamEliminated(attackerTeamId) || isTeamEliminated(defTeam.id)) return null;
  if (!isFlagCaptureMechanicEnabled(now)) return null;
  if (!canPlaceForTeam(x, y, attackerTeamId)) return null;

  const existing = pixels.get(`${x},${y}`);
  const owner = existing != null ? pixelTeam(existing) : 0;
  if (owner !== defTeam.id) return null;

  if (!flagTeamHitLimiter.allow(`fc:${attackerTeamId}`, FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC, 1000)) {
    return { rateLimited: true };
  }

  let st = flagCaptureByDefender.get(defTeam.id);
  if (!st) {
    st = { progress: 0, lastHitAt: 0, attackerTeamId: 0, nextDecayAt: null };
    flagCaptureByDefender.set(defTeam.id, st);
  }

  if ((st.attackerTeamId | 0) !== (attackerTeamId | 0)) {
    const prevA = st.attackerTeamId | 0;
    st.progress = 0;
    st.attackerTeamId = attackerTeamId | 0;
    st.nextDecayAt = null;
    if (prevA) {
      broadcast({
        type: "flagCaptureProgress",
        defenderTeamId: defTeam.id,
        attackerTeamId: attackerTeamId | 0,
        progress: 0,
        reset: true,
      });
    }
  }

  st.progress = Math.min(FLAG_CAPTURE_HITS_REQUIRED, (st.progress | 0) + 1);
  st.lastHitAt = now;
  st.nextDecayAt = null;

  if (st.progress === 1) {
    broadcast({
      type: "flagUnderAttack",
      defenderTeamId: defTeam.id,
      attackerTeamId: attackerTeamId | 0,
      progress: st.progress,
    });
  }

  broadcast({
    type: "flagCaptureProgress",
    defenderTeamId: defTeam.id,
    attackerTeamId: attackerTeamId | 0,
    progress: st.progress,
  });

  for (const threshold of [5, 10, 15, 18]) {
    if (st.progress === threshold) {
      broadcast({
        type: "flagDefendWarn",
        defenderTeamId: defTeam.id,
        attackerTeamId: attackerTeamId | 0,
        progress: st.progress,
      });
      break;
    }
  }

  if (st.progress >= FLAG_CAPTURE_HITS_REQUIRED) {
    executeFlagCaptureSuccess(attackerTeamId | 0, defTeam.id);
    return { captured: true, defenderTeamId: defTeam.id };
  }
  return { hit: true, defenderTeamId: defTeam.id, progress: st.progress };
}

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
  });

  eliminateTeamByTerritoryLoss(defenderId);
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
      if (!cellIsLand(x, y)) return false;
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

function paintTeamSpawnArea(teamId, x0, y0, ownerPk) {
  const opk = String(ownerPk || "").slice(0, 128);
  for (let y = y0; y < y0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
      if (!cellIsLand(x, y)) continue;
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
      if (!p || pixelTeam(p) !== t.id) return true;
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
  removeAttackerFromAllFlagCaptures(teamId, true);
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
  const { agg, totalAvailableScore } = recalculateAllTeamScores();
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
    globalEvent: getGlobalEventPayload(),
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
  if (gameFinished) return getPlayStartMs() + roundDurationMs;
  if (roundIndex === 0 && !roundTimerStarted) return null;
  return getPlayStartMs() + roundDurationMs;
}

async function sendConnectionMeta(ws) {
  const teamCountsObj = {};
  for (const [id, c] of teamPlayerCounts) {
    teamCountsObj[id] = c;
  }
  const warmupEndsAt =
    gameFinished || (roundIndex === 0 && !roundTimerStarted) ? null : getPlayStartMs();
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
    warmupMs: WARMUP_MS,
    eligible: !!ws.eligible,
    gameFinished: !!gameFinished,
    tournamentStage: tournamentStage(roundIndex, gameFinished),
    discussionChatUrl: getDiscussionChatUrlForClient(),
    flags: buildFlagsSnapshot(),
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
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    gameFinished = true;
    roundStartMs = Date.now();
    playStartMs = roundStartMs;
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
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    roundIndex = 3;
    roundTimerStarted = true;
    roundStartMs = Date.now();
    playStartMs = roundStartMs + WARMUP_MS;
    roundDurationMs = battleDurationForRound(3);
    clearTiebreakSnapshots();
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
      roundEndsAt: getPlayStartMs() + roundDurationMs,
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
  if (Date.now() < getPlayStartMs() + roundDurationMs) return;
  /* Авторитетный итог: полный пересчёт очков по pixels внутри buildStatsPayload (recalculateAllTeamScores). */
  const stats = buildStatsPayload();
  const rows = stats.rows || [];
  if (rows.length === 0) {
    roundStartMs = Date.now();
    playStartMs = roundStartMs;
    saveRoundState();
    return;
  }

  if (roundIndex === 3) {
    const top = rows[0];
    if (!top || typeof top.teamId !== "number") {
      roundStartMs = Date.now();
      playStartMs = roundStartMs;
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
      playStartMs = roundStartMs;
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
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    const endedRoundIndex = roundIndex;
    roundIndex++;
    roundTimerStarted = true;
    roundStartMs = Date.now();
    playStartMs = roundStartMs + WARMUP_MS;
    roundDurationMs = battleDurationForRound(roundIndex);
    clearTiebreakSnapshots();
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
      roundEndsAt: getPlayStartMs() + roundDurationMs,
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
setInterval(() => tickFlagCaptureDecay(Date.now()), 500);

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
      if (blockWarmupPurchase(ws)) return;
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
      if (blockWarmupPurchase(ws)) return;
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
      if (blockWarmupPurchase(ws)) return;
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
      if (blockWarmupPurchase(ws)) return;
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
      if (blockWarmupPurchase(ws)) return;
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
      if (!assertCanPlay(ws)) return;
      if (isWarmupPhaseNow()) {
        const tid = ws.teamId | 0;
        safeSend(ws, { type: "invalidPlacement", teamId: tid, reason: "warmup" });
        safeSend(ws, { type: "pixelReject", reason: "warmup" });
        return;
      }
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
      if (!cellIsLand(x, y)) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "water" });
        safeSend(ws, { type: "pixelReject", reason: "water" });
        return;
      }

      const key = `${x},${y}`;
      const existingPx = pixels.get(key);
      if (existingPx != null && pixelTeam(existingPx) === teamId) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "already_yours" });
        safeSend(ws, { type: "pixelReject", reason: "already_yours" });
        return;
      }
      if (!canPlaceForTeam(x, y, teamId)) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "not_adjacent" });
        safeSend(ws, { type: "pixelReject", reason: "not_adjacent" });
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
        if (fc.hit && typeof fc.defenderTeamId === "number" && typeof fc.progress === "number") {
          safeSend(ws, {
            type: "flagHitAck",
            defenderTeamId: fc.defenderTeamId,
            progress: fc.progress,
            max: FLAG_CAPTURE_HITS_REQUIRED,
          });
        }
        return;
      }

      if (isEnemyOwnedFlagBaseCell(teamId, x, y)) {
        await walletStore.save();
        const locked = !isFlagCaptureMechanicEnabled(now);
        const r = locked ? "enemy_base_locked" : "enemy_base";
        safeSend(ws, { type: "invalidPlacement", teamId, reason: r });
        safeSend(ws, { type: "pixelReject", reason: r });
        return;
      }

      u.lastActionAt = now;
      await walletStore.save();

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
  roundTimerStarted = true;
  roundStartMs = Date.now();
  playStartMs = roundStartMs + WARMUP_MS;
  clearTiebreakSnapshots();
  saveRoundState();
  schedulePlayStartBroadcast();
  await Promise.all(
    [...wss.clients]
      .filter((c) => c.readyState === 1)
      .map((c) => sendConnectionMeta(c))
  );
  broadcastStatsImmediate();
  return { ok: true, durationMs: ms, warmupMs: WARMUP_MS };
}

async function telegramSendMessage(chatId, text, extra = {}) {
  const payload = { chat_id: chatId, text, ...extra };
  await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
}

async function telegramPollLoop() {
  if (!TELEGRAM_BOT_TOKEN) return;
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

        if (!TELEGRAM_ADMIN_IDS.has(uid)) continue;
        const restartNorm = t
          .toLowerCase()
          .replace(/^\/+/, "")
          .replace(/\s+/g, " ");
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
        if (!tl.startsWith("go")) continue;
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
          reply = `Раунд 1: сначала разминка 2 мин (без пикселей), затем бой ${h.toFixed(h < 1 ? 2 : 1)} ч. Пиксели с ${new Date(playStartMs).toISOString()}`;
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
        console.log(
          `[cluster] Redis Pub/Sub «${ch}» (CLUSTER_LEADER=${isClusterLeader() ? "true" : "false"} — таймеры раунда и Telegram только на лидере)`
        );
      })
      .catch((e) => console.warn("[cluster] Redis:", e.message || e));
  }
  if (TELEGRAM_BOT_TOKEN) {
    fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/deleteWebhook?drop_pending_updates=true`).catch(
      () => {}
    );
    if (isClusterLeader()) {
      telegramPollLoop().catch((e) => console.warn("Telegram poll:", e));
    } else {
      console.log("[cluster] Telegram long poll отключён (не CLUSTER_LEADER).");
    }
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
        'Первый раунд: в личку боту — «go», «го», «гол» + часы: go 100, го 50, го 0.1. Перезапуск процесса по «рестарт»/restart — только если TELEGRAM_ENABLE_PROCESS_RESTART=true.'
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
