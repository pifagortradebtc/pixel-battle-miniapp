/**
 * Статика + WebSocket: карта, только пользовательские команды (динамические).
 * Публичные команды — в списке для вступления. Цвет команды назначается сервером при создании и не меняется.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const WS_PATH = "/ws";

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
/** Длина текущего раунда в мс (одинакова для всех раундов после старта) */
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
 * (`teamId` — лидер по % территории в `maybeEndRound` / `advanceToDuelRound`).
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
  if (!dt) {
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

/** Автоназначение цвета — клиент не выбирает (единообразно с игрой без палитры). */
const TEAM_AUTO_COLORS = [
  "#ff1744",
  "#ff6d00",
  "#ffc400",
  "#c6ff00",
  "#00e676",
  "#00bfa5",
  "#00e5ff",
  "#2979ff",
  "#651fff",
  "#d500f9",
  "#e91e63",
  "#ff5722",
  "#1de9b6",
  "#8e24aa",
  "#ffeb3b",
];

function pickAutoTeamColor(name, emoji, salt) {
  const raw = `${name}\0${emoji}\0${salt}`;
  const h = crypto.createHash("sha256").update(raw, "utf8").digest();
  const idx = h.readUInt32BE(0) % TEAM_AUTO_COLORS.length;
  return TEAM_AUTO_COLORS[idx];
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
/** Знаменатель для «% территории» — число игровых клеток суши на текущей сетке. */
let landPixelsTotal = GRID_SIZE_MASS * GRID_SIZE_MASS;

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
    landPixelsTotal = gridW * gridH;
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
}

function cellIsLand(x, y) {
  if (x < 0 || x >= gridW || y < 0 || y >= gridH) return false;
  if (!landGrid) return true;
  return landGrid[y * gridW + x] !== 0;
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
    const k = `${x},${y}`;
    pixels.set(k, {
      teamId: tid,
      ownerPlayerKey: pk,
      shieldedUntil: 0,
    });
    broadcast({ type: "pixel", x, y, t: tid, ownerPlayerKey: pk, shieldedUntil: 0 });
  }
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
        dynamicTeams = msg.teams.map((t) => ({
          id: t.id | 0,
          name: sanitizeTeamName(t.name),
          emoji: sanitizeTeamEmoji(t.emoji),
          color: sanitizeHexColor(t.color) || "#888888",
          solo: !!t.solo,
          editToken: typeof t.editToken === "string" ? t.editToken.slice(0, 128) : undefined,
          soloResumeToken: typeof t.soloResumeToken === "string" ? t.soloResumeToken.slice(0, 128) : undefined,
        }));
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
    case "roundEnded":
    case "gameEnded":
      try {
        loadRoundState();
        loadDynamicTeams();
        clearTeamEffectsMap();
        teamMemberKeys.clear();
        teamPlayerCounts.clear();
        pixels.clear();
        if (gameFinished) rebuildLandFromRound(Math.min(Math.max(roundIndex, 2), 3));
        else rebuildLandFromRound(roundIndex);
      } catch (e) {
        console.warn("[cluster] round sync:", e.message);
      }
      return;
    case "stats":
    case "purchaseVfx":
      return;
    default:
      return;
  }
}

function broadcastToWebSocketClients(raw) {
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

const wss = new WebSocketServer({
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
  let n = 0;
  for (const c of wss.clients) {
    if (c.readyState === 1) n++;
  }
  return n;
}

function buildStatsPayload() {
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

/** null — первый раунд ещё не запущен командой «go» в Telegram */
function roundEndsAtForMeta() {
  if (gameFinished) return roundStartMs + roundDurationMs;
  if (roundIndex === 0 && !roundTimerStarted) return null;
  return roundStartMs + roundDurationMs;
}

async function sendConnectionMeta(ws) {
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
    tournamentStage: tournamentStage(roundIndex, gameFinished),
    discussionChatUrl: getDiscussionChatUrlForClient(),
  });
  safeSend(ws, await buildWalletPayload(ws));
}

/** Финал: победитель дуэли 1v1 — игра окончена. */
async function finalizeGameEnd(winnerRow) {
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
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    gameFinished = true;
    roundStartMs = Date.now();
    saveRoundState();

    void notifyFinalWinnersTelegram(winnerKeysSnapshot, winningTeamName, pct);

    broadcast({
      type: "gameEnded",
      winnerTeamId,
      winnerName: winningTeamName,
      percent: pct,
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
    pixels.clear();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    roundIndex = 3;
    roundTimerStarted = true;
    roundStartMs = Date.now();
    rebuildLandFromRound(3);
    saveRoundState();

    broadcast({
      type: "roundEnded",
      roundIndex: 3,
      winnerTeamId,
      winnerName: winningTeamName,
      roundEndsAt: roundStartMs + roundDurationMs,
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
  } finally {
    roundEnding = false;
  }
}

async function runMaybeEndRound() {
  if (!isClusterLeader()) return;
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
    pixels.clear();
    clearTeamEffectsMap();
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
    await Promise.all(
      [...wss.clients]
        .filter((c) => c.readyState === 1)
        .map((c) => sendConnectionMeta(c))
    );
  } finally {
    roundEnding = false;
  }
}

function maybeEndRound() {
  void runMaybeEndRound();
}

setInterval(() => maybeEndRound(), 30000);

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
      const id = nextTeamId++;
      const pkForColor = sanitizePlayerKey(ws.playerKey);
      const color = pickAutoTeamColor(name, emoji, pkForColor || `id:${id}`);
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

    if (msg.type === "purchasePersonalRecovery") {
      if (!assertCanPlay(ws)) return;
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
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
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
      const priceQuant = PRICES_QUANT.zone4;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, planned);
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
      safeSend(ws, { type: "purchaseOk", kind: "zoneCapture", cells: planned.length, size: 4 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseMassCapture") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
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
      const priceQuant = PRICES_QUANT.zone6;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, planned);
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
      safeSend(ws, { type: "purchaseOk", kind: "massCapture", cells: planned.length, size: 6 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseZone12Capture") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      ensureWsOnlineTracked(ws);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
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
      const priceQuant = PRICES_QUANT.zone12;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      applyPlannedCapture(pk, tid, planned);
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
      safeSend(ws, { type: "purchaseOk", kind: "zone12Capture", cells: planned.length, size: 12 });
      safeSend(ws, await buildWalletPayload(ws));
      scheduleBroadcastWalletDebounced();
      return;
    }

    if (msg.type === "purchaseTeamRecovery") {
      if (!assertCanPlay(ws)) return;
      attachPlayerKey(ws, msg);
      if (ws.teamId == null) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
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
      if (!cellIsLand(x, y)) {
        safeSend(ws, { type: "pixelReject", reason: "water" });
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
        safeSend(ws, { type: "pixelReject", reason: "cooldown not ready" });
        return;
      }

      u.lastActionAt = now;
      await walletStore.save();

      const key = `${x},${y}`;
      const rec = { teamId, ownerPlayerKey: pk, shieldedUntil: 0 };
      pixels.set(key, rec);
      broadcast({ type: "pixel", x, y, t: teamId, ownerPlayerKey: pk, shieldedUntil: 0 });
      scheduleStatsBroadcast();
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
async function startRoundOneTimer(durationHours) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
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
  await Promise.all(
    [...wss.clients]
      .filter((c) => c.readyState === 1)
      .map((c) => sendConnectionMeta(c))
  );
  broadcastStatsImmediate();
  return { ok: true, durationMs: ms };
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
        let hours = 100;
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
