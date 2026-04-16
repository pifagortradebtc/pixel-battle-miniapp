/**
 * Статика + WebSocket: карта, только пользовательские команды (динамические).
 * Публичные команды — в списке для вступления. Цвет при создании — из палитры (или автоподбор); смена после создания запрещена.
 * Запуск: npm start
 */

import "dotenv/config";

process.on("unhandledRejection", (reason) => {
  const msg = reason instanceof Error ? reason.stack || reason.message : String(reason);
  console.error("[unhandledRejection]", msg);
});
process.on("uncaughtException", (err) => {
  console.error("[uncaughtException]", err?.stack || err);
  process.exit(1);
});

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
  REFERRAL_JOIN_INVITER_QUANT,
  getEffectiveRecoverySec,
  quantToUsdt,
  resolveAuthoritativePixelCooldownMs,
  resolveAuthoritativeRecoverySec,
  stageAllows,
  stageAllowsRecoveryPurchases,
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
import { isUsdtDepositsEnabled } from "./lib/usdt-deposits-enabled.js";
import { startTelegramPollWhenRedisLockHeld } from "./lib/telegram-poll-redis-lock.mjs";
import { SlidingWindowRateLimiter } from "./lib/rate-limit.js";
import {
  ROUND_ZERO_POST_GO_WARMUP_MS,
  WARMUP_MS,
  battleDurationForRound,
} from "./lib/tournament-flow.js";
import { aggregateScoresFromPixels } from "./lib/scoring.js";
import {
  applyIncrementalTeamScorePixelStep,
  fillMassSumFromAggregate,
} from "./lib/team-score-incremental.js";
import {
  buildBattleEventsClientPayload,
  cellsInManhattanBall,
  computeBattleScoringSnapshot,
  computeSeismicManhattanBalls,
  getNextTimelineEvent,
  getRoundTimeline,
  MANUAL_BATTLE_EVENT_DEFAULT_DURATION_MS,
  MANUAL_BATTLE_EVENT_HELP_RU,
  MANUAL_TELEGRAM_CMD_FIRST_WORDS,
  mergeManualBattleSlotsIntoSnapshot,
  pointInRect,
  resolveManualBattleCommandToTimelineDef,
  tournamentCompressionMultiplierForCell,
} from "./lib/battle-events.js";
import {
  FLAG_BASE_MAX_HP,
  FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC,
  FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS,
  FLAG_MAIN_BASE_MAX_HP,
  FLAG_REGEN_IDLE_MS,
  FLAG_WARN_THRESHOLDS,
  FLAG_WARN_THRESHOLDS_MAIN,
  computeEffectiveBaseHp,
  flagCellFromSpawn,
  toEpochMsSafe,
} from "./lib/flag-capture.js";
import {
  GRID8_DELTAS,
  TERRITORY_ISOLATION_GRACE_MS,
  computeIsolatedTerritoryGroups,
  makeGridCellKey,
  neighborKeysInSet8,
} from "./lib/territory-isolation.js";
import { isWorldMapWaterPixel } from "./lib/world-map-water.js";
import { buildRandomTreasureMap } from "./lib/map-treasures.js";
import { computeNukeBombBlastCells } from "./lib/nuke-bomb-shape.js";
import {
  QUANTUM_FARM_TICK_MS,
  computeQuantumFarmLayouts,
  scoreTeamsAroundFarm,
  resolveFarmControl,
} from "./lib/quantum-farms.js";
import { GREAT_WALL_MAX_HP, normalizeWallHp } from "./lib/great-wall.js";
import { normalizeQuantumFarmLevel, QUANTUM_FARM_MAX_LEVEL } from "./lib/quantum-farm-upgrades.js";

/** За каждую активную «визуальную» зону события, где есть хотя бы одна клетка территории команды, +столько квантов / 5 с. */
const BATTLE_EVENT_ZONE_QUANT_PER_STACK = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const PORT = Number(process.env.PORT) || 3847;
const WS_PATH = "/ws";

/** Создаётся после http.createServer; до этого broadcast/stats не трогают клиентов. */
/** @type {import("ws").WebSocketServer | null} */
let wss = null;

/** Render Disk и др.: абсолютный путь к постоянной папке (например /var/data). Иначе — ./data рядом с server.js. */
const DATA_DIR = (() => {
  const raw = String(process.env.PIXEL_BATTLE_DATA_DIR || process.env.RENDER_DISK_PATH || "").trim();
  if (raw && path.isAbsolute(raw)) return path.normalize(raw);
  return path.join(ROOT, "data");
})();
/** Публичный префикс для music/, sfx/ (CDN). Должен быть объявлен до логов production — иначе ReferenceError при старте. */
const STATIC_ASSET_BASE_URL = (process.env.STATIC_ASSET_BASE_URL || process.env.ASSET_CDN_BASE || "")
  .trim()
  .replace(/\/$/, "");
if (process.env.NODE_ENV === "production") {
  console.log(`[data] persistent dir: ${DATA_DIR}`);
  if (STATIC_ASSET_BASE_URL) console.log(`[assets] STATIC_ASSET_BASE_URL=${STATIC_ASSET_BASE_URL}`);
}
/** @type {Awaited<ReturnType<typeof createWalletBackend>>} */
const walletStore = await createWalletBackend(DATA_DIR);

/** Chat id личных чатов с ботом (после /start) — для админской команды broadcast / рассылка. */
const TELEGRAM_SUBSCRIBERS_PATH = path.join(DATA_DIR, "telegram-bot-subscribers.json");
/** @type {Set<number>} */
let telegramSubscriberChatIds = new Set();

function loadTelegramSubscribersSync() {
  try {
    if (!fs.existsSync(TELEGRAM_SUBSCRIBERS_PATH)) return;
    const j = JSON.parse(fs.readFileSync(TELEGRAM_SUBSCRIBERS_PATH, "utf8"));
    const arr = Array.isArray(j.ids) ? j.ids : [];
    telegramSubscriberChatIds = new Set(arr.map(Number).filter((n) => Number.isFinite(n) && n > 0));
  } catch (e) {
    console.warn("[telegram] subscribers load:", e?.message || e);
  }
}

function persistTelegramSubscribersSync() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const ids = [...telegramSubscriberChatIds].sort((a, b) => a - b);
    fs.writeFileSync(TELEGRAM_SUBSCRIBERS_PATH, JSON.stringify({ ids }, null, 0), "utf8");
  } catch (e) {
    console.warn("[telegram] subscribers save:", e?.message || e);
  }
}

function rememberTelegramSubscriberChat(chatId) {
  const id = Number(chatId);
  if (!Number.isFinite(id) || id <= 0) return;
  if (telegramSubscriberChatIds.has(id)) return;
  telegramSubscriberChatIds.add(id);
  persistTelegramSubscribersSync();
}

loadTelegramSubscribersSync();

const SERVER_ANNOUNCEMENT_DURATION_MS = 5000;
const SAY_PROMPT_TTL_MS = 3 * 60 * 1000;
const SERVER_ANNOUNCEMENT_MAX_LEN = 240;
/** @type {Map<number, number>} админский Telegram uid → срок ожидания второго сообщения для say */
const telegramAdminSayPromptUntil = new Map();

function sanitizeServerAnnouncementText(raw) {
  let s = String(raw || "").replace(/\r\n/g, "\n");
  s = s.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
  s = s.replace(/\n{3,}/g, "\n\n").trim();
  if (s.length > SERVER_ANNOUNCEMENT_MAX_LEN) s = s.slice(0, SERVER_ANNOUNCEMENT_MAX_LEN);
  return s;
}

/** @returns {{ body: string } | null} */
function parseSayTelegramCommand(raw) {
  const s = String(raw || "").trim();
  const m = s.match(/^\/say\b\s*([\s\S]*)$/i) || s.match(/^say\b\s*([\s\S]*)$/i);
  if (!m) return null;
  return { body: String(m[1] ?? "").trim() };
}

function shouldInterruptPendingSayPrompt(raw, restartNorm) {
  const speedCmd = restartNorm.replace(/^\/speed\b/, "speed").trim();
  if (speedCmd === "speed" || speedCmd.startsWith("speed ")) return true;
  const rt = String(raw || "").trim();
  const goish = rt
    .replace(/^\/go\b/i, "go")
    .replace(/^гол(\s+)/i, "go$1")
    .replace(/^гол(\d)/i, "go $1")
    .replace(/^го(\s+)/iu, "go$1")
    .replace(/^го(\d)/iu, "go $1");
  if (goish.trim().toLowerCase().startsWith("go")) return true;
  const parts = restartNorm.split(/\s+/).filter(Boolean);
  const fw = (parts[0] || "").replace(/@\w+$/i, "");
  if (fw === "paint" && parts.length === 1) return true;
  if (fw === "broadcast" || fw === "рассылка") return true;
  if (fw === "quant") return true;
  if (fw === "restart" || fw === "рестарт") return true;
  if (restartNorm === "новая игра" || restartNorm === "newgame" || restartNorm === "wipe" || restartNorm === "с нуля")
    return true;
  if (/^(evt|event|события|событие)\b/iu.test(restartNorm)) return true;
  if (fw === "say") return true;
  if (fw !== "off" && MANUAL_TELEGRAM_CMD_FIRST_WORDS.has(fw)) return true;
  return false;
}

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
/** Реже слать stats всем клиентам при всплесках событий — меньше JSON и перерисовок на телефонах. */
const STATS_BROADCAST_DEBOUNCE_MS = Math.min(
  5000,
  Math.max(150, Number(process.env.STATS_BROADCAST_DEBOUNCE_MS) || 420)
);
/** До первого выполнения тела модуля могут вызвать scheduleStatsBroadcast (загрузка карты / выбывание команд). */
let statsBroadcastTimer = null;

const apiDepositLimiter = new SlidingWindowRateLimiter();
const apiIpnLimiter = new SlidingWindowRateLimiter();
/** Выдача одноразовых токенов для открытия игры вне Telegram WebView (мост initData → браузер). */
const telegramBridgeMintLimiter = new SlidingWindowRateLimiter();
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
/** Админ-команда бота «test»: фаза боя в каждом раунде одинаковая (2 мин), разминка короткая. */
const QUICK_TEST_ROUND_BATTLE_MS = 2 * 60 * 1000;
const QUICK_TEST_WARMUP_MS = 5 * 1000;
let tournamentQuickTestMode = false;

function applyQuickTestRoundTimingToState() {
  if (!tournamentQuickTestMode) return;
  roundDurationMs = QUICK_TEST_ROUND_BATTLE_MS;
  round0WarmupMs = QUICK_TEST_WARMUP_MS;
}

function effectiveBattleDurationForRound(ri) {
  if (tournamentQuickTestMode) return QUICK_TEST_ROUND_BATTLE_MS;
  return battleDurationForRound(ri);
}
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

const ROUND_STATE_PATH = path.join(DATA_DIR, "round-state.json");
/** Снимок карты для восстановления после рестарта (только лидер кластера или одиночный процесс). */
const PIXELS_SNAPSHOT_PATH = path.join(DATA_DIR, "pixels-snapshot.json");
const PIXELS_SNAPSHOT_TMP_PATH = path.join(DATA_DIR, "pixels-snapshot.json.tmp");
const PIXELS_SNAPSHOT_DISABLE = /^true$/i.test(String(process.env.PIXELS_SNAPSHOT_DISABLE || "").trim());
const PIXELS_SNAPSHOT_DEBOUNCE_MS = Math.min(
  120_000,
  Math.max(800, Number(process.env.PIXELS_SNAPSHOT_DEBOUNCE_MS) || 3000)
);
const PIXELS_SNAPSHOT_INTERVAL_MS = Math.min(
  600_000,
  Math.max(5000, Number(process.env.PIXELS_SNAPSHOT_INTERVAL_MS) || 45_000)
);
/** Макс. клеток в одном WS/Redis кадре pixelBatch (меньше — стабильнее при слабых сетях). */
const PIXEL_BATCH_MAX_CELLS = Math.min(
  4000,
  Math.max(120, Number(process.env.PIXEL_BATCH_MAX_CELLS) || 800)
);

/** Рассылка WS/Redis и батч пикселей — до любого вызова broadcast при загрузке модуля (rebuildLandFromRound и т.д.). */
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

/** Пакетная рассылка клеток: один кадр WS/PubSub на микротаску вместо N сообщений «pixel». */
/** @type {Map<string, { x: number, y: number, t: number, ownerPlayerKey: string, shieldedUntil: number, wallHp: number }>} */
const pendingPixelBroadcast = new Map();
let pixelBroadcastFlushScheduled = false;

function publishGameRaw(raw) {
  broadcastToWebSocketClients(raw);
  publishRedisGameInternal(raw);
}

/** Служебные сообщения между инстансами без рассылки сырого JSON клиентам (например обновление кошелька после IPN). */
function publishRedisGameInternal(raw) {
  if (!redisGamePublish) return;
  try {
    const out = redisGamePublish(raw);
    if (out && typeof out.then === "function") out.catch((e) => console.warn("[redis publish]", e.message));
  } catch (e) {
    console.warn("[redis publish]", e.message);
  }
}

function flushPixelBroadcastNow() {
  if (pendingPixelBroadcast.size === 0) return;
  const cells = [];
  for (const v of pendingPixelBroadcast.values()) {
    cells.push([v.x, v.y, v.t, v.ownerPlayerKey, v.shieldedUntil, v.wallHp | 0]);
  }
  pendingPixelBroadcast.clear();
  const chunk = PIXEL_BATCH_MAX_CELLS;
  for (let i = 0; i < cells.length; i += chunk) {
    const part = cells.slice(i, i + chunk);
    publishGameRaw(
      JSON.stringify({
        type: "pixelBatch",
        pixelFormat: "v2",
        cells: part,
      })
    );
  }
}

function queuePixelBroadcast(x, y, t, ownerPlayerKey, shieldedUntil, wallHp = 0) {
  const xi = x | 0;
  const yi = y | 0;
  const tid = t | 0;
  const opk = String(ownerPlayerKey || "").slice(0, 128);
  const sh = Number(shieldedUntil) || 0;
  const wh = normalizeWallHp(wallHp);
  pendingPixelBroadcast.set(`${xi},${yi}`, {
    x: xi,
    y: yi,
    t: tid,
    ownerPlayerKey: opk,
    shieldedUntil: sh,
    wallHp: wh,
  });
  if (!pixelBroadcastFlushScheduled) {
    pixelBroadcastFlushScheduled = true;
    queueMicrotask(() => {
      pixelBroadcastFlushScheduled = false;
      flushPixelBroadcastNow();
    });
  }
}

function broadcast(obj) {
  flushPixelBroadcastNow();
  const raw = typeof obj === "string" ? obj : JSON.stringify(obj);
  publishGameRaw(raw);
}

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

/**
 * Показывать ли в ответ на /start кнопку запуска игры (Mini App).
 * Если переменная не задана — true (как раньше). Выключить: false / 0 / no / off.
 */
function parseEnvBoolDefaultTrue(name) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === "") return true;
  return /^(1|true|yes|on)$/i.test(String(raw).trim());
}
const TELEGRAM_START_GAME_BUTTON_ENABLED = parseEnvBoolDefaultTrue("TELEGRAM_START_GAME_BUTTON_ENABLED");

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

function escapeHtmlAttr(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/[\r\n]/g, " ");
}

function envStrLoose(name) {
  const v = process.env[name];
  return typeof v === "string" ? v.trim() : "";
}

/**
 * Мета для рефералок в клиенте (`index.html` → pixel-battle-tg-*).
 * Берётся из TELEGRAM_BOT_USERNAME + TELEGRAM_MINIAPP_SHORT_NAME, из TELEGRAM_MINIAPP_LINK (t.me/бот/short),
 * иначе из Render-переменных pixel-battle-tg-bot / pixel-battle-tg-app (short name ≠ username бота).
 */
function getTelegramReferralMetaForHtml() {
  let bot = TELEGRAM_BOT_USERNAME;
  let app = TELEGRAM_MINIAPP_SHORT_NAME;
  if (!bot || !app) {
    const link = getTelegramMiniAppLaunchUrl();
    if (/^https:\/\/t\.me\//i.test(link)) {
      const parts = link
        .replace(/^https:\/\/t\.me\//i, "")
        .split("/")
        .filter(Boolean);
      if (parts.length >= 2) {
        if (!bot) bot = parts[0];
        if (!app) app = parts[1].split("?")[0];
      }
    }
  }
  if (!bot) bot = envStrLoose("pixel-battle-tg-bot").replace(/^@/, "");
  if (!app) app = envStrLoose("pixel-battle-tg-app");
  return { bot, app };
}

function injectTelegramMetaIntoIndexHtml(html) {
  const { bot, app } = getTelegramReferralMetaForHtml();
  let out = html
    .replace(
      /<meta\s+name="pixel-battle-tg-bot"\s+content="[^"]*"\s*\/>/i,
      `<meta name="pixel-battle-tg-bot" content="${escapeHtmlAttr(bot)}" />`
    )
    .replace(
      /<meta\s+name="pixel-battle-tg-app"\s+content="[^"]*"\s*\/>/i,
      `<meta name="pixel-battle-tg-app" content="${escapeHtmlAttr(app)}" />`
    );
  if (STATIC_ASSET_BASE_URL) {
    const baseJson = JSON.stringify(`${STATIC_ASSET_BASE_URL}/`);
    const snip = `<script>window.__PIXEL_STATIC_ASSET_BASE__=${baseJson};</script>`;
    if (!out.includes("__PIXEL_STATIC_ASSET_BASE__")) {
      out = out.replace(/<head(\s[^>]*)?>/i, (m) => `${m}\n  ${snip}`);
    }
  }
  return out;
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
  if (norm === "новая игра" || norm === "newgame" || norm === "wipe" || norm === "с нуля") return true;
  if (fw === "quant") return true;
  if (fw === "quantlist") return true;
  if (fw === "paint") return true;
  if (fw === "evt" || fw === "event" || fw === "события" || fw === "событие") return true;
  if (fw === "broadcast" || fw === "рассылка") return true;
  if (fw === "say") return true;
  if (fw === "teams" || fw === "pause" || fw === "unpause" || fw === "resume") return true;
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
/** «Мстим за Альт Сезон»: глобально пиксель раз в 1 с для всех (бот: speed). */
const MSTIM_ALT_SEASON_DURATION_MS = 5 * 60 * 1000;
const DEBUG_MSTIM_COOLDOWN = /^true$/i.test(String(process.env.DEBUG_MSTIM_COOLDOWN || "").trim());
/** До какого момента (epoch ms) действует режим; 0 — выкл. */
let mstimAltSeasonBurstUntilMs = 0;

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
/** Полная пауза (Telegram: pause / unpause). Таймеры и экономика не продвигаются, действия игроков отклоняются. */
let gamePaused = false;
/** Wall-clock момент начала паузы (только лидер кластера). */
let pauseWallStartedAt = 0;
/** Была ли на момент паузы фаза разминки (для продления warmup vs battle). */
let pauseCapturedWarmup = false;
/** Доп. мс к {@link WARMUP_MS} в раундах с roundIndex > 0 после паузы в разминке. */
let warmupPauseExtensionMs = 0;
/** Ручной бонус к очкам команды (админ), не из пикселей: teamId → очки. */
const teamManualScoreBonus = new Map();
/** Ключи playerKey, допущенные в текущий раунд (после 0-го — только победители прошлого). Пустой при roundIndex===0 = не используется. */
let eligiblePlayerKeys = new Set();
/** Восстановление кладов с диска после пересборки сетки (перезапуск в том же раунде). */
let pendingTreasureRestore = null;
/** Ключ "x,y" → бонус в квантах (1..50). */
let treasureQuantByCell = new Map();
/** Уже выданные клады по ключу клетки. */
let treasureClaimedKeys = new Set();

/** Координаты неподобранных кладов для карты (без раскрытия количества квантов). */
function buildTreasureSpotsForMeta() {
  const out = [];
  for (const k of treasureQuantByCell.keys()) {
    if (treasureClaimedKeys.has(k)) continue;
    out.push(k);
  }
  return out;
}

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

/**
 * После покупки с deferSave: узкая запись в БД (ledger + economy покупателя), без полного обхода кэша users.
 */
async function persistWalletPurchaseWrites(pkRaw) {
  const pk = sanitizePlayerKey(pkRaw);
  if (typeof walletStore.persistPurchaseWrites === "function") {
    await walletStore.persistPurchaseWrites(pk ? [pk] : []);
  } else {
    await walletStore.save();
  }
}

/**
 * Не блокировать обработчик WebSocket на Postgres: ответы клиенту уже ушли.
 * Очередь — без гонок по _pendingLedger и без всплеска параллельных pool.connect().
 */
let walletPurchasePersistChain = Promise.resolve();

function queuePersistWalletPurchaseWrites(pkRaw) {
  const pk = sanitizePlayerKey(pkRaw);
  walletPurchasePersistChain = walletPurchasePersistChain
    .then(() => persistWalletPurchaseWrites(pk))
    .catch((e) => console.warn("[wallet] persist purchase:", e?.message || e));
}

/**
 * Дебаунс записи economy (lastActionAt и др.) на диск: не блокировать event loop
 * `await walletStore.save()` на каждый пиксель (особенно WalletPg.save() проходил по всему кэшу users).
 */
const economyFlushPending = new Set();
let economyFlushTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
const ECONOMY_FLUSH_MS = Math.min(300, Math.max(40, Number(process.env.ECONOMY_FLUSH_MS) || 100));

function scheduleEconomyFlushForPlayer(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return;
  economyFlushPending.add(k);
  if (economyFlushTimer != null) return;
  economyFlushTimer = setTimeout(() => {
    economyFlushTimer = null;
    const keys = [...economyFlushPending];
    economyFlushPending.clear();
    void flushEconomyKeysNow(keys);
  }, ECONOMY_FLUSH_MS);
}

async function flushEconomyKeysNow(keys) {
  if (!keys.length) return;
  try {
    if (typeof walletStore.flushUsersEconomy === "function") {
      await walletStore.flushUsersEconomy(keys);
    } else {
      await walletStore.save();
    }
  } catch (e) {
    console.warn("[economy flush]", e?.message || e);
  }
}

/** Сколько WS сейчас держат этот playerKey (несколько вкладок). */
const onlinePkRefCounts = new Map();
/** Инкремент при смене «есть ли хотя бы одна вкладка» у ключа или состава teamMemberKeys — инвалидация кэша синергии. */
let synergyOnlineEpoch = 0;

function trackOnlinePk(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return;
  const prev = onlinePkRefCounts.get(k) || 0;
  onlinePkRefCounts.set(k, prev + 1);
  if (prev === 0) synergyOnlineEpoch++;
}

function untrackOnlinePk(pk) {
  const k = sanitizePlayerKey(pk);
  if (!k) return;
  const prev = onlinePkRefCounts.get(k) || 0;
  if (prev <= 0) return;
  const n = prev - 1;
  if (n <= 0) {
    onlinePkRefCounts.delete(k);
    synergyOnlineEpoch++;
  } else {
    onlinePkRefCounts.set(k, n);
  }
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

/**
 * Дуэль 1×1: в допуск обязаны попасть оба игрока победившей пары.
 * `teamMemberKeys` после боя бывает неполным (один ключ) — добираем создателя, владельцев клеток и онлайн WS
 * (см. collectWinnerTeamPlayerKeys).
 */
function setEligibleKeysForDuelFromWinningTeam(teamId) {
  const keys = [...collectWinnerTeamPlayerKeys(teamId | 0)].map(sanitizePlayerKey).filter(Boolean);
  keys.sort();
  eligiblePlayerKeys = new Set(keys.slice(0, 2));
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
          const refPayId = `referral_join_${pkInvite}`;
          const refAmt = quantToUsdt(REFERRAL_JOIN_INVITER_QUANT);
          const dep = await walletStore.finalizeDeposit(refPayId, refPk, refAmt, {});
          if (dep.ok && wss) {
            for (const c of wss.clients) {
              if (c.readyState !== 1) continue;
              if (sanitizePlayerKey(c.playerKey) !== refPk) continue;
              safeSend(c, { type: "referralJoinReward", quant: REFERRAL_JOIN_INVITER_QUANT });
              safeSend(c, await buildWalletPayload(c));
            }
          }
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
  synergyOnlineEpoch++;
}

function removeTeamMemberKey(teamId, playerKey) {
  const pk = sanitizePlayerKey(playerKey);
  if (!pk || !teamMemberKeys.has(teamId)) return;
  teamMemberKeys.get(teamId).delete(pk);
  if (teamMemberKeys.get(teamId).size === 0) teamMemberKeys.delete(teamId);
  synergyOnlineEpoch++;
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

/** Премиум «военная база»: макс. на команду, кулдаун между развёртываниями. */
const MILITARY_BASE_COOLDOWN_MS = 120_000;
/** Мин. зазор (Chebyshev между границами 6×6) от своей главной базы. */
const MILITARY_MIN_EDGE_GAP_OWN_MAIN = 4;
/** Мин. зазор от чужой главной базы (только спавн 6×6, не от их передовых баз). */
const MILITARY_MIN_EDGE_GAP_ENEMY_MAIN = 6;

/** Сохранённые одноразовые шаги событий (сейсмика / предупреждение). */
let battleEventsApplied = {};

/** Ручные события карты (Telegram evt …): ключ команды → untilMs (конец действия). Только лидер кластера меняет. */
const manualBattleSlotsByCmd = new Map();

function normalizeManualBattleCmdKey(raw) {
  const s = String(raw || "")
    .toLowerCase()
    .trim()
    .replace(/^\/+/, "");
  if (s === "золото" || s === "голд") return "gold";
  return s;
}

function pruneExpiredManualBattleSlots(nowMs = Date.now()) {
  if (gamePaused) return;
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

function manualBattleSlotsCacheSignature() {
  if (manualBattleSlotsByCmd.size === 0) return "";
  const arr = [...manualBattleSlotsByCmd.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
  return JSON.stringify(arr);
}

let battleSnapCacheKey = "";
/** @type {import("./lib/battle-events.js").BattleScoringSnapshot | null} */
let battleSnapCacheSnap = null;
let battleClientPayloadCacheKey = "";
/** @type {ReturnType<typeof buildBattleEventsClientPayload> | null} */
let battleClientPayloadCache = null;
let synergyMultCacheKey = "";
/** @type {Map<number, number> | null} */
let synergyMultCacheVal = null;

/**
 * Дорогой путь: computeBattleScoringSnapshot + mergeManualBattleSlots.
 * Кэш по «логическому» ключу (время, окно боя, сетка, пауза, ручные слоты) — убирает дубли в buildStatsPayload + buildScoringContext в одну миллисекунду.
 */
function computeBattleScoringSnapshotWithManualBattle(nowMs, ctx) {
  pruneExpiredManualBattleSlots(nowMs);
  const cacheKey = [
    nowMs | 0,
    roundIndex | 0,
    landGridLayoutSeq | 0,
    ctx.playStartMs | 0,
    ctx.battleEndMs | 0,
    ctx.gridW | 0,
    ctx.gridH | 0,
    gamePaused ? 1 : 0,
    pauseWallStartedAt | 0,
    manualBattleSlotsCacheSignature(),
  ].join("|");
  if (cacheKey === battleSnapCacheKey && battleSnapCacheSnap != null) {
    return battleSnapCacheSnap;
  }
  const snap = computeBattleScoringSnapshot(nowMs, ctx);
  mergeManualBattleSlotsIntoSnapshot(snap, getActiveManualBattleSlots(nowMs), nowMs, ctx);
  battleSnapCacheKey = cacheKey;
  battleSnapCacheSnap = snap;
  return snap;
}

function broadcastManualBattleSyncAndStats() {
  invalidateTeamScoresAggCache();
  broadcast({
    type: "manualBattleSync",
    slots: Object.fromEntries(manualBattleSlotsByCmd),
  });
  const nowSync = Date.now();
  broadcast({ type: "globalEvent", globalEvent: getGlobalEventPayload(nowSync) });
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

function synergyEligibleTeamIdsSig() {
  const ids = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    ids.push(t.id | 0);
  }
  ids.sort((a, b) => a - b);
  return ids.join(",");
}

/**
 * Множитель синергии по командам (только очки территории), см. round timeline.
 * Кэш при неизменных battleSnapCacheKey, составе команд, synergyOnlineEpoch — без обходов memberKeys (серии пикселей в одну миллисекунду).
 * @param {import("./lib/battle-events.js").BattleScoringSnapshot} snap
 */
function buildSynergyMultByTeamMap(snap) {
  if (!snap?.teamSynergy?.active) return null;
  const minO = snap.teamSynergy.minOnline | 0;
  const mult = typeof snap.teamSynergy.mult === "number" ? snap.teamSynergy.mult : 1.12;
  const teamSig = synergyEligibleTeamIdsSig();
  const fullKey = `${battleSnapCacheKey}|${minO}|${mult}|${teamSig}|${synergyOnlineEpoch | 0}`;
  if (fullKey === synergyMultCacheKey && synergyMultCacheVal) {
    return synergyMultCacheVal;
  }
  /** @type {Map<number, number>} */
  const m = new Map();
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    const n = countOnlineMembersForTeam(tid);
    m.set(tid, n >= minO ? mult : 1);
  }
  synergyMultCacheKey = fullKey;
  synergyMultCacheVal = m;
  return m;
}

function getGlobalEventPayload(nowMs = Date.now()) {
  const arUntil = isMstimAltSeasonBurstActive() ? (mstimAltSeasonBurstUntilMs | 0) : 0;
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) {
    return {
      active: arUntil > 0,
      kind: arUntil > 0 ? "alt_season_revenge" : null,
      title: arUntil > 0 ? "Мстим за Альт Сезон" : "",
      subtitle: arUntil > 0 ? "Пиксель раз в 1 с для всех" : "",
      until: arUntil,
      battleEvents: { serverNow: nowMs, active: false, layers: [], primary: null, battleEndsAt: 0 },
      altSeasonRevengeUntilMs: arUntil,
      debugRoundEvents: DEBUG_ROUND_EVENTS ? { note: "warmup_or_idle" } : undefined,
    };
  }
  const snap = computeBattleScoringSnapshotWithManualBattle(nowMs, ctx);
  let be = battleClientPayloadCache;
  if (battleClientPayloadCacheKey !== battleSnapCacheKey || !be) {
    be = buildBattleEventsClientPayload(snap, nowMs, ctx.battleEndMs);
    battleClientPayloadCacheKey = battleSnapCacheKey;
    battleClientPayloadCache = be;
  }
  const pr = be.primary;
  /** @type {Record<string, unknown> | undefined} */
  let debugRoundEvents;
  if (DEBUG_ROUND_EVENTS) {
    const elapsed = nowMs - ctx.playStartMs;
    const manualActive = [];
    for (const [cmd, u] of manualBattleSlotsByCmd) {
      if (typeof u === "number" && u > nowMs) manualActive.push(cmd);
    }
    debugRoundEvents = {
      roundIndex,
      elapsedMs: elapsed,
      manualBattleActive: manualActive,
      next: getNextTimelineEvent(nowMs, roundIndex, ctx.playStartMs, ctx.battleEndMs),
    };
  }
  return {
    active: !!be.active || arUntil > 0,
    kind: arUntil > 0 ? "alt_season_revenge" : pr ? pr.kind : null,
    title: arUntil > 0 ? "Мстим за Альт Сезон" : pr && pr.title ? pr.title : "",
    subtitle: arUntil > 0 ? "Пиксель раз в 1 с для всех" : pr && pr.subtitle ? pr.subtitle : "",
    until: arUntil > 0 ? arUntil : pr && typeof pr.untilMs === "number" ? pr.untilMs : 0,
    battleEvents: be,
    altSeasonRevengeUntilMs: arUntil,
    debugRoundEvents,
  };
}

function buildBattleProtectedMask() {
  const mask = new Uint8Array(gridW * gridH);
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
      for (let yy = t.spawnY0; yy < t.spawnY0 + TEAM_SPAWN_SIZE; yy++) {
        for (let xx = t.spawnX0; xx < t.spawnX0 + TEAM_SPAWN_SIZE; xx++) {
          if (xx >= 0 && xx < gridW && yy >= 0 && yy < gridH) mask[yy * gridW + xx] = 1;
        }
      }
    }
    for (const o of getTeamMilitaryOutposts(t)) {
      for (let yy = o.y0; yy < o.y0 + TEAM_SPAWN_SIZE; yy++) {
        for (let xx = o.x0; xx < o.x0 + TEAM_SPAWN_SIZE; xx++) {
          if (xx >= 0 && xx < gridW && yy >= 0 && yy < gridH) mask[yy * gridW + xx] = 1;
        }
      }
    }
  }
  return mask;
}

/** Пауза перед ударом сейсмики из бота: баннер у игроков + подсветка зон. */
const MANUAL_SEISMIC_WARNING_MS = 3000;

/** @type {ReturnType<typeof setTimeout> | null} */
let pendingManualSeismicTimer = null;
/** @type {{ cleared: [number, number][]; uniqueEventKey: string } | null} */
let pendingManualSeismicPayload = null;

function clearPendingManualSeismicSchedule() {
  if (pendingManualSeismicTimer != null) {
    clearTimeout(pendingManualSeismicTimer);
    pendingManualSeismicTimer = null;
  }
  pendingManualSeismicPayload = null;
}

/**
 * @returns {{ balls: { cx: number; cy: number; r: number }[]; cleared: [number, number][] }}
 */
function computeSeismicClearData(defId) {
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
    cleared.push([x, y]);
  }
  return { balls, cleared };
}

function broadcastSeismicImpact(cleared, uniqueEventKey) {
  if (!cleared.length) return;
  invalidateTeamScoresAggCache();
  for (let i = 0; i < cleared.length; i++) {
    const x = cleared[i][0];
    const y = cleared[i][1];
    pixels.delete(`${x},${y}`);
  }
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

/**
 * Ручная сейсмика из бота: сначала preview 3 с (баннер + зоны), затем очистка.
 * @returns {{ ok: true } | { ok: false; reason: "no_cells" }}
 */
function scheduleManualSeismicFromBot(defId, uniqueEventKey) {
  if (gamePaused) return { ok: false, reason: "paused" };
  clearPendingManualSeismicSchedule();
  const { balls, cleared } = computeSeismicClearData(defId);
  if (!cleared.length) return { ok: false, reason: "no_cells" };
  const regions = balls.map((b) => ({
    kind: "manhattan_ball",
    cx: b.cx,
    cy: b.cy,
    r: b.r,
  }));
  const impactAtMs = Date.now() + MANUAL_SEISMIC_WARNING_MS;
  broadcast({
    type: "seismicPreview",
    eventId: uniqueEventKey,
    regions,
    impactAtMs,
  });
  pendingManualSeismicPayload = { cleared, uniqueEventKey };
  pendingManualSeismicTimer = setTimeout(() => {
    pendingManualSeismicTimer = null;
    const p = pendingManualSeismicPayload;
    pendingManualSeismicPayload = null;
    if (!p) return;
    if (gamePaused) return;
    broadcastSeismicImpact(p.cleared, p.uniqueEventKey);
  }, MANUAL_SEISMIC_WARNING_MS);
  return { ok: true };
}

function tickRoundEventTransitions(nowMs) {
  if (!isClusterLeader()) return;
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) return;
  /** Старт/конец roundEvent по таймлайну отключён — кинематограф и HUD только после evt … в боте. */
  /** @type {Set<string>} */
  const active = new Set();
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
      `[round-events] ri=${roundIndex} elapsed=${(elapsed / 60000).toFixed(1)}m timeline_ui=off manual_next=${next.next?.eventId ?? "—"}`
    );
  }
}
tickRoundEventTransitions._lastLogDeca = -1;

function tickBattleEvents(nowMs) {
  if (!isClusterLeader()) return;
  if (gamePaused || gameFinished || isWarmupPhaseNow()) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) return;

  tickRoundEventTransitions(nowMs);
  /* События боя меняют getCellValue — инкрементальное табло сбрасываем раз в тик (1 Гц). */
  teamScoreStatsEpoch++;

  /* Автосейсмика по таймлайну отключена — только команда seismic / evt seismic в боте (лидер кластера). */
}

function resetBattleEventsStateForNewBattleRound() {
  battleEventsApplied = {};
  lastAnnouncedActiveEventIds = new Set();
  manualBattleSlotsByCmd.clear();
  clearPendingManualSeismicSchedule();
}

/** Нормализованный список передовых баз 6×6 команды (из `dynamicTeams`). */
function getTeamMilitaryOutposts(t) {
  if (!t || !Array.isArray(t.militaryOutposts)) return [];
  const out = [];
  for (let i = 0; i < t.militaryOutposts.length; i++) {
    const o = t.militaryOutposts[i];
    if (o && typeof o.x0 === "number" && typeof o.y0 === "number") {
      out.push({ x0: o.x0 | 0, y0: o.y0 | 0 });
    }
  }
  return out;
}

/** Углы 6×6 всех главных баз и передовых баз (для коллизий при спавне и размещении). */
function allSpawnLikeRectsForConflict() {
  /** @type {{ x0: number, y0: number }[]} */
  const out = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
      out.push({ x0: t.spawnX0, y0: t.spawnY0 });
    }
    for (const o of getTeamMilitaryOutposts(t)) {
      out.push({ x0: o.x0, y0: o.y0 });
    }
  }
  return out;
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
    militaryOutposts: !t.solo
      ? getTeamMilitaryOutposts(t).map((o) => ({
          x0: o.x0,
          y0: o.y0,
          w: TEAM_SPAWN_SIZE,
          h: TEAM_SPAWN_SIZE,
        }))
      : [],
  }));
}

const DYNAMIC_TEAMS_PATH = path.join(DATA_DIR, "dynamic-teams.json");

/** @type {{ id: number, name: string, emoji: string, color: string, editToken?: string, solo?: boolean, soloResumeToken?: string, spawnX0?: number, spawnY0?: number, eliminated?: boolean, createdByPlayerKey?: string, militaryOutposts?: { x0: number, y0: number }[], lastMilitaryBaseAt?: number }[]} */
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
        const mo = Array.isArray(t.militaryOutposts)
          ? t.militaryOutposts
              .filter((o) => o && typeof o.x0 === "number" && typeof o.y0 === "number")
              .map((o) => ({ x0: o.x0 | 0, y0: o.y0 | 0 }))
          : [];
        const lastMb = Number(t.lastMilitaryBaseAt);
        return {
          ...t,
          id: Number(t.id) | 0,
          color,
          solo: !!t.solo,
          eliminated: !!t.eliminated,
          militaryOutposts: mo,
          lastMilitaryBaseAt: Number.isFinite(lastMb) && lastMb > 0 ? lastMb : 0,
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
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
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(
      ROUND_STATE_PATH,
      JSON.stringify({
        roundIndex,
        roundStartMs,
        playStartMs,
        roundDurationMs,
        tournamentQuickTestMode,
        tournamentTimeScale: 1,
        mstimAltSeasonBurstUntilMs: Math.max(0, mstimAltSeasonBurstUntilMs | 0),
        round0WarmupMs,
        roundTimerStarted,
        eligibleTokens: [...eligibleTokenSet],
        eligiblePlayerKeys: [...eligiblePlayerKeys],
        gameFinished,
        winnerTokensByPlayerKey,
        battleEventsApplied,
        manualBattleSlots: Object.fromEntries(manualBattleSlotsByCmd),
        treasureGridW: gridW,
        treasureGridH: gridH,
        mapTreasures: Object.fromEntries(treasureQuantByCell),
        mapTreasureClaimed: [...treasureClaimedKeys],
        gamePaused: !!gamePaused,
        pauseWallStartedAt: gamePaused ? pauseWallStartedAt | 0 : 0,
        pauseCapturedWarmup: !!pauseCapturedWarmup,
        warmupPauseExtensionMs: Math.max(0, warmupPauseExtensionMs | 0),
        teamManualScoreBonus: Object.fromEntries(teamManualScoreBonus),
        quantumFarmLevels: quantumFarmLevels.length ? [...quantumFarmLevels] : [],
      }),
      "utf8"
    );
  } catch (e) {
    console.warn("round-state save:", e.message);
  }
}

let pixelsSnapshotSeq = 0;
let pixelsSnapshotDebounceTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);
let pixelsSnapshotWriteInFlight = false;

function shouldPersistPixelsSnapshot() {
  if (PIXELS_SNAPSHOT_DISABLE || gameFinished) return false;
  if (REDIS_URL && !isClusterLeader()) return false;
  return !!landGrid;
}

function schedulePixelsSnapshotSave() {
  if (!shouldPersistPixelsSnapshot()) return;
  if (pixelsSnapshotDebounceTimer) clearTimeout(pixelsSnapshotDebounceTimer);
  pixelsSnapshotDebounceTimer = setTimeout(() => {
    pixelsSnapshotDebounceTimer = null;
    void writePixelsSnapshotFileAsync();
  }, PIXELS_SNAPSHOT_DEBOUNCE_MS);
}

function buildPixelsSnapshotJson() {
  const body = fullPayloadObject();
  return JSON.stringify({
    v: 1,
    seq: ++pixelsSnapshotSeq,
    savedAtMs: Date.now(),
    roundIndex,
    gridW,
    gridH,
    pixelFormat: body.pixelFormat || "v2",
    pixels: body.pixels,
  });
}

async function writePixelsSnapshotFileAsync() {
  if (!shouldPersistPixelsSnapshot() || pixelsSnapshotWriteInFlight) return;
  pixelsSnapshotWriteInFlight = true;
  try {
    const json = buildPixelsSnapshotJson();
    await fs.promises.mkdir(DATA_DIR, { recursive: true });
    await fs.promises.writeFile(PIXELS_SNAPSHOT_TMP_PATH, json, "utf8");
    await fs.promises.rename(PIXELS_SNAPSHOT_TMP_PATH, PIXELS_SNAPSHOT_PATH);
  } catch (e) {
    console.warn("[pixels-snapshot] save:", e?.message || e);
  } finally {
    pixelsSnapshotWriteInFlight = false;
  }
}

function writePixelsSnapshotSyncForShutdown() {
  if (!shouldPersistPixelsSnapshot()) return;
  try {
    const json = buildPixelsSnapshotJson();
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(PIXELS_SNAPSHOT_TMP_PATH, json, "utf8");
    fs.renameSync(PIXELS_SNAPSHOT_TMP_PATH, PIXELS_SNAPSHOT_PATH);
  } catch (e) {
    console.warn("[pixels-snapshot] shutdown save:", e?.message || e);
  }
}

function loadPixelsSnapshotIfPresentSync() {
  if (PIXELS_SNAPSHOT_DISABLE) return;
  if (REDIS_URL && !isClusterLeader()) return;
  try {
    if (!fs.existsSync(PIXELS_SNAPSHOT_PATH)) return;
    const raw = fs.readFileSync(PIXELS_SNAPSHOT_PATH, "utf8");
    const j = JSON.parse(raw);
    if (j.v !== 1 || !Array.isArray(j.pixels)) return;
    if ((j.gridW | 0) !== gridW || (j.gridH | 0) !== gridH || (j.roundIndex | 0) !== roundIndex) {
      console.warn("[pixels-snapshot] пропуск: другой roundIndex или размер сетки");
      return;
    }
    if (typeof j.seq === "number" && Number.isFinite(j.seq)) pixelsSnapshotSeq = Math.max(pixelsSnapshotSeq, j.seq | 0);
    invalidateTeamScoresAggCache();
    const fmt = j.pixelFormat === "v2" ? "v2" : "v1";
    let n = 0;
    for (let i = 0; i < j.pixels.length; i++) {
      const p = j.pixels[i];
      if (!Array.isArray(p) || p.length < 3) continue;
      const x = p[0] | 0;
      const y = p[1] | 0;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
      if (!cellAllowsPixelPlacement(x, y)) continue;
      if (fmt === "v2" && p.length >= 5) {
        const wh = p.length >= 6 ? normalizeWallHp(p[5]) : 0;
        /** @type {{ teamId: number, ownerPlayerKey: string, shieldedUntil: number, wallHp?: number }} */
        const o = {
          teamId: p[2] | 0,
          ownerPlayerKey: String(p[3] || "").slice(0, 128),
          shieldedUntil: Number(p[4]) || 0,
        };
        if (wh > 0) o.wallHp = wh;
        pixels.set(`${x},${y}`, o);
      } else {
        pixels.set(`${x},${y}`, { teamId: p[2] | 0, ownerPlayerKey: "", shieldedUntil: 0 });
      }
      n++;
    }
    console.log(`[pixels-snapshot] загружено клеток: ${n} (файл seq=${j.seq})`);
  } catch (e) {
    console.warn("[pixels-snapshot] load:", e?.message || e);
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
      if (typeof j.tournamentQuickTestMode === "boolean") tournamentQuickTestMode = j.tournamentQuickTestMode;
      if (typeof j.roundDurationMs === "number" && j.roundDurationMs >= 1000 && j.roundDurationMs <= 8760 * 3600000) {
        roundDurationMs = j.roundDurationMs;
      } else {
        roundDurationMs = effectiveBattleDurationForRound(roundIndex);
      }
      if (typeof j.mstimAltSeasonBurstUntilMs === "number" && Number.isFinite(j.mstimAltSeasonBurstUntilMs)) {
        const u = j.mstimAltSeasonBurstUntilMs | 0;
        mstimAltSeasonBurstUntilMs = u > Date.now() ? u : 0;
      } else {
        mstimAltSeasonBurstUntilMs = 0;
      }
      if (typeof j.round0WarmupMs === "number" && Number.isFinite(j.round0WarmupMs)) {
        const w = Math.round(j.round0WarmupMs);
        round0WarmupMs = w >= 5000 && w <= 600000 ? w : WARMUP_MS;
      } else {
        round0WarmupMs = WARMUP_MS;
      }
      if (tournamentQuickTestMode) applyQuickTestRoundTimingToState();
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
      pendingTreasureRestore = null;
      const tw = typeof j.treasureGridW === "number" ? j.treasureGridW | 0 : 0;
      const th = typeof j.treasureGridH === "number" ? j.treasureGridH | 0 : 0;
      const expectSz = gridSizeForRoundIndex(roundIndex);
      if (
        j.mapTreasures &&
        typeof j.mapTreasures === "object" &&
        !Array.isArray(j.mapTreasures) &&
        tw === expectSz &&
        th === expectSz &&
        tw > 0
      ) {
        pendingTreasureRestore = {
          mapTreasures: j.mapTreasures,
          claimed: Array.isArray(j.mapTreasureClaimed) ? j.mapTreasureClaimed.filter((x) => typeof x === "string") : [],
        };
      }
      if (typeof j.gamePaused === "boolean") gamePaused = j.gamePaused;
      else gamePaused = false;
      if (typeof j.pauseWallStartedAt === "number" && Number.isFinite(j.pauseWallStartedAt)) {
        pauseWallStartedAt = Math.max(0, j.pauseWallStartedAt | 0);
      } else {
        pauseWallStartedAt = 0;
      }
      if (typeof j.pauseCapturedWarmup === "boolean") pauseCapturedWarmup = j.pauseCapturedWarmup;
      else pauseCapturedWarmup = false;
      if (typeof j.warmupPauseExtensionMs === "number" && Number.isFinite(j.warmupPauseExtensionMs)) {
        warmupPauseExtensionMs = Math.max(0, Math.min(7 * 24 * 3600000, j.warmupPauseExtensionMs | 0));
      } else {
        warmupPauseExtensionMs = 0;
      }
      teamManualScoreBonus.clear();
      if (j.teamManualScoreBonus && typeof j.teamManualScoreBonus === "object" && !Array.isArray(j.teamManualScoreBonus)) {
        for (const [k, v] of Object.entries(j.teamManualScoreBonus)) {
          const tid = Number(k) | 0;
          const n = Number(v);
          if (!tid || !Number.isFinite(n) || n === 0) continue;
          teamManualScoreBonus.set(tid, n);
        }
      }
      if (Array.isArray(j.quantumFarmLevels) && j.quantumFarmLevels.length) {
        pendingQuantumFarmLevelsRestore = j.quantumFarmLevels.map((x) => normalizeQuantumFarmLevel(x));
      } else {
        pendingQuantumFarmLevelsRestore = null;
      }
      if (gamePaused && pauseWallStartedAt > Date.now()) {
        gamePaused = false;
        pauseWallStartedAt = 0;
        pauseCapturedWarmup = false;
      }
    } else {
      roundIndex = 0;
      roundStartMs = Date.now();
      mstimAltSeasonBurstUntilMs = 0;
      playStartMs = roundStartMs;
      roundDurationMs = effectiveBattleDurationForRound(0);
      eligibleTokenSet = new Set();
      gameFinished = false;
      winnerTokensByPlayerKey = {};
      battleEventsApplied = {};
      manualBattleSlotsByCmd.clear();
      roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
      round0WarmupMs = WARMUP_MS;
      pendingTreasureRestore = null;
      saveRoundState();
    }
  } catch (e) {
    console.warn("round-state load:", e.message);
    roundIndex = 0;
    roundStartMs = Date.now();
    mstimAltSeasonBurstUntilMs = 0;
    playStartMs = roundStartMs;
    roundDurationMs = effectiveBattleDurationForRound(0);
    eligibleTokenSet = new Set();
    gameFinished = false;
    winnerTokensByPlayerKey = {};
    battleEventsApplied = {};
    manualBattleSlotsByCmd.clear();
    roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
    round0WarmupMs = WARMUP_MS;
    pendingTreasureRestore = null;
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
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".webm": "audio/webm",
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
/** Инкремент при каждой пересборке суши (invalidate кэша pickLandRectangle / scoring snapshot). */
let landGridLayoutSeq = 0;
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
/**
 * HP флага передовой базы: ключ `${defenderId}:${x0}:${y0}` (левый верх 6×6).
 * @type {Map<string, { hp: number, lastHitAt: number, attackerTeamId: number, _lastRegenBroadcastHp?: number, _flagRegenBroadcastPhase?: boolean, _lastRegenBroadcastAt?: number }>}
 */
const militaryFlagCaptureByKey = new Map();

function militaryOutpostFlagStateKey(defenderTeamId, ox0, oy0) {
  return `${defenderTeamId | 0}:${ox0 | 0}:${oy0 | 0}`;
}

function clearAllFlagCaptureState() {
  flagCaptureByDefender.clear();
  militaryFlagCaptureByKey.clear();
}

function clearFlagCaptureStateForDefender(defenderId) {
  const d = defenderId | 0;
  flagCaptureByDefender.delete(d);
  for (const k of [...militaryFlagCaptureByKey.keys()]) {
    const head = String(k).split(":")[0];
    if ((Number(head) | 0) === d) militaryFlagCaptureByKey.delete(k);
  }
}

function clearMilitaryFlagStateForOutpost(defenderTeamId, ox0, oy0) {
  militaryFlagCaptureByKey.delete(militaryOutpostFlagStateKey(defenderTeamId, ox0, oy0));
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
    landGridLayoutSeq++;
    return;
  }

  landGrid = new Uint8Array(gridW * gridH);
  landGridLayoutSeq++;
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
  const quantumFarmAvoidRects = allSpawnLikeRectsForConflict().map((r) => ({
    x0: r.x0 | 0,
    y0: r.y0 | 0,
    w: TEAM_SPAWN_SIZE,
    h: TEAM_SPAWN_SIZE,
  }));
  quantumFarmLayouts = computeQuantumFarmLayouts(playableGrid, gridW, gridH, ri, quantumFarmAvoidRects);
  quantumFarmOwnerPrev = quantumFarmLayouts.length ? computeQuantumFarmOwnersNow() : [];
  if (quantumFarmLayouts.length) {
    if (pendingQuantumFarmLevelsRestore && pendingQuantumFarmLevelsRestore.length === quantumFarmLayouts.length) {
      quantumFarmLevels = pendingQuantumFarmLevelsRestore.map((x) => normalizeQuantumFarmLevel(x));
      pendingQuantumFarmLevelsRestore = null;
    } else {
      quantumFarmLevels = quantumFarmLayouts.map(() => 1);
      pendingQuantumFarmLevelsRestore = null;
    }
    broadcast({
      type: "quantumFarmsInit",
      farms: buildQuantumFarmsClientPayload(),
    });
  } else {
    quantumFarmLevels = [];
    pendingQuantumFarmLevelsRestore = null;
    broadcast({ type: "quantumFarmsInit", farms: [] });
  }
  invalidateTeamScoresAggCache();
  afterTerritoryMutation();
  applyTreasuresAfterLandRebuild();
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

function regenerateMapTreasures() {
  treasureQuantByCell = new Map();
  treasureClaimedKeys = new Set();
  if (!playableGrid || playableGrid.length !== gridW * gridH) return;
  let playable = 0;
  for (let i = 0; i < playableGrid.length; i++) {
    if (playableGrid[i]) playable++;
  }
  const raw = process.env.MAP_TREASURE_COUNT;
  let target = NaN;
  if (raw != null && String(raw).trim() !== "") {
    const n = parseInt(String(raw), 10);
    if (Number.isFinite(n) && n >= 0) target = n;
  }
  if (!Number.isFinite(target) || target <= 0) {
    target = Math.min(180, Math.max(30, Math.floor(playable * 0.0012)));
  }
  target = Math.min(target | 0, playable);
  if (target <= 0) return;
  treasureQuantByCell = buildRandomTreasureMap(playableGrid, gridW, gridH, target);
}

function applyTreasuresAfterLandRebuild() {
  if (pendingTreasureRestore && typeof pendingTreasureRestore.mapTreasures === "object") {
    treasureQuantByCell = new Map();
    treasureClaimedKeys = new Set();
    for (const [ks, v] of Object.entries(pendingTreasureRestore.mapTreasures)) {
      const q = Number(v);
      if (!Number.isFinite(q) || q < 1 || q > 50) continue;
      const parts = String(ks).split(",");
      const sx = Number(parts[0]);
      const sy = Number(parts[1]);
      if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
      const xi = sx | 0;
      const yi = sy | 0;
      if (!cellAllowsPixelPlacement(xi, yi)) continue;
      treasureQuantByCell.set(`${xi},${yi}`, q | 0);
    }
    for (const c of pendingTreasureRestore.claimed) {
      if (typeof c === "string" && c) treasureClaimedKeys.add(c);
    }
    pendingTreasureRestore = null;
  } else {
    regenerateMapTreasures();
  }
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
 * Полный авторитетный пересчёт: очки (вклад клетки × число клеток команды) и число занятых клеток по `pixels`.
 * Вызывается из buildStatsPayload; при конце раунда — тот же путь (без отдельного кэша на кластере).
 */
function recalculateAllTeamScores(nowMs = Date.now()) {
  const ctx = buildScoringContext(nowMs);
  if (!ctx) return { agg: new Map(), totalAvailableScore: 0 };
  const agg = aggregateScoresFromPixels(pixels, pixelTeam, ctx);
  let totalAvailableScore = 0;
  for (const a of agg.values()) totalAvailableScore += a.score;
  return { agg, totalAvailableScore };
}

/** Инкрементальное табло: M клеток, S = сумма v по клеткам, score = M * S (как в aggregateScoresFromPixels). */
let teamScoreStatsEpoch = 0;
let teamScoreCacheEpochSynced = -1;
/** @type {Map<number, number>} */
const teamStatsMass = new Map();
/** @type {Map<number, number>} */
const teamStatsSumV = new Map();

function invalidateTeamScoresAggCache() {
  teamScoreCacheEpochSynced = -1;
  teamStatsMass.clear();
  teamStatsSumV.clear();
}

function rebuildTeamScoresAggFromFullScan(nowMs = Date.now()) {
  const r = recalculateAllTeamScores(nowMs);
  fillMassSumFromAggregate(r.agg, teamStatsMass, teamStatsSumV);
  teamScoreCacheEpochSynced = teamScoreStatsEpoch;
}

/**
 * После одиночного pixels.set на (x,y): обновить кэш без полного прохода по карте.
 * При рассинхроне — сброс кэша (следующий buildStatsPayload сделает full scan).
 */
function tryApplyIncrementalTeamScoreForPixel(x, y, prevVal, nextVal) {
  if (teamScoreCacheEpochSynced < 0 || teamScoreCacheEpochSynced !== teamScoreStatsEpoch) return;
  const nowMs = effectiveGameClockMs();
  const ctx = buildScoringContext(nowMs);
  if (!ctx) return;
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || xi >= gridW || yi < 0 || yi >= gridH) return;
  const step = applyIncrementalTeamScorePixelStep(xi, yi, prevVal, nextVal, ctx, pixelTeam, teamStatsMass, teamStatsSumV);
  if (step === "invalidate") invalidateTeamScoresAggCache();
}

function getTournamentTimeScale() {
  return 1;
}

/**
 * Во время глобальной паузы «игровые часы» застывают на момент нажатия pause:
 * очки/события/кулдауны в payload не уезжают от реального wall-clock.
 */
function effectiveGameClockMs() {
  if (gamePaused && (pauseWallStartedAt | 0) > 0) return pauseWallStartedAt | 0;
  return Date.now();
}

/** Окно «Мстим за Альт Сезон»: wall-clock, на паузе таймер замирает (until сдвигается при unpause). */
function isMstimAltSeasonBurstActive() {
  const until = mstimAltSeasonBurstUntilMs | 0;
  if (until <= 0) return false;
  if (gamePaused && (pauseWallStartedAt | 0) > 0) {
    return until > (pauseWallStartedAt | 0);
  }
  return until > Date.now();
}

function effectivePixelCooldownMs(u, teamFx, st, now) {
  return resolveAuthoritativePixelCooldownMs(isMstimAltSeasonBurstActive(), u, teamFx, st, now);
}

function effectiveRecoverySecForWallet(u, teamFx, now) {
  return resolveAuthoritativeRecoverySec(isMstimAltSeasonBurstActive(), u, teamFx, now);
}

function getWarmupDurationMs() {
  if (tournamentQuickTestMode) return QUICK_TEST_WARMUP_MS;
  if (roundIndex !== 0) return WARMUP_MS + Math.max(0, warmupPauseExtensionMs | 0);
  const w = round0WarmupMs | 0;
  return w >= 5000 && w <= 600000 ? w : WARMUP_MS;
}

/** Реальный timestamp начала боя (пиксели): roundStart + разминка. */
function getPlayStartMs() {
  return roundStartMs + getWarmupDurationMs();
}

/** Реальный timestamp конца фазы боя текущего раунда. */
function getRoundBattleEndRealMs() {
  return getPlayStartMs() + roundDurationMs;
}

function broadcastTournamentTimeScaleToClients() {
  broadcast({
    type: "tournamentTimeScale",
    tournamentTimeScale: getTournamentTimeScale(),
    roundStartMs,
    roundDurationMs,
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
  if (gamePaused) return pauseCapturedWarmup;
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
  invalidateTeamScoresAggCache();

  if (!landGrid) {
    if (teamsChanged) saveDynamicTeams();
    afterTerritoryMutation();
    saveRoundState();
    broadcast(fullPayloadObject());
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
  broadcast(fullPayloadObject());
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
  if (gamePaused) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  const ps = getPlayStartMs();
  const delay = ps - effectiveGameClockMs();
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

/** Дуэль: соперник выбыл по территории — один выживший в stats, при этом в dynamicTeams есть устранённые команды. */
function checkDuelWinByElimination(stats) {
  if (!isClusterLeader()) return;
  if (gamePaused || gameFinished || roundEnding || roundIndex !== 3) return;
  if (isWarmupPhaseNow()) return;
  const rows = stats?.rows || [];
  if (rows.length !== 1) return;
  const top = rows[0];
  if (!top || typeof top.teamId !== "number") return;
  const alive = dynamicTeams.filter((t) => !t.solo && !t.eliminated);
  const eliminated = dynamicTeams.filter((t) => !t.solo && t.eliminated);
  if (alive.length === 1 && eliminated.length >= 1) {
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

/** Квантовые фермы 2×2 у центра: позиции пересчитываются при rebuildLandFromRound. */
/** @type {{ id: number, x0: number, y0: number, w: number, h: number }[]} */
let quantumFarmLayouts = [];
/** @type {number[]} владельцы по индексу (для детекта смены и тика дохода). */
let quantumFarmOwnerPrev = [];
let quantumFarmIncomeTickSeq = 0;
/** Уровни ферм 1..3 по индексу quantumFarmLayouts (доход = level кв. / 5 с при контроле). */
let quantumFarmLevels = [];
/** Из round-state до первого rebuildLandFromRound (длина должна совпасть с layouts). */
let pendingQuantumFarmLevelsRestore = null;

function buildQuantumFarmsClientPayload() {
  const out = [];
  for (let i = 0; i < quantumFarmLayouts.length; i++) {
    const f = quantumFarmLayouts[i];
    const lv = normalizeQuantumFarmLevel(quantumFarmLevels[i]);
    out.push({ id: f.id, x0: f.x0, y0: f.y0, w: f.w, h: f.h, level: lv });
  }
  return out;
}

/** Всегда число (0 = пусто/битые данные), чтобы не ломать повторные удары по флагу из‑за string vs number в JSON/Redis. */
function pixelTeam(val) {
  if (val && typeof val === "object") return Number(val.teamId) | 0;
  return Number(val) | 0;
}

/**
 * Все известные playerKey победившей команды для уведомления админам.
 * В дуэли 1×1 teamMemberKeys иногда пуст — добираем из создателя команды, клеток pixels и открытых WS.
 * @param {number} winnerTeamId
 * @returns {Set<string>}
 */
function collectWinnerTeamPlayerKeys(winnerTeamId) {
  const tid = winnerTeamId | 0;
  const out = new Set();
  const add = (raw) => {
    const pk = sanitizePlayerKey(raw);
    if (pk) out.add(pk);
  };
  const memberSet = teamMemberKeys.get(tid);
  if (memberSet) {
    for (const pk of memberSet) add(pk);
  }
  const dt = dynamicTeams.find((t) => (t.id | 0) === tid);
  if (dt && typeof dt.createdByPlayerKey === "string") add(dt.createdByPlayerKey);
  for (const val of pixels.values()) {
    if (pixelTeam(val) !== tid) continue;
    if (val && typeof val === "object" && val.ownerPlayerKey) add(val.ownerPlayerKey);
  }
  if (wss) {
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      if ((c.teamId | 0) !== tid) continue;
      add(c.playerKey);
    }
  }
  return out;
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
  if (!isClusterLeader() || gameFinished || gamePaused) return false;
  pruneTerritoryIsolationEliminatedTeams();
  let pixelsMutated = false;
  /** @type {Map<string, { teamId: number, cells: Set<string>, deadlineMs: number, groupId: string }>} */
  let carry = territoryIsolationByGroupId;
  for (let iter = 0; iter < 96; iter++) {
    const now = Date.now();
    const isolatedGroups = computeIsolatedTerritoryGroups(
      pixels,
      dynamicTeams,
      pixelTeam,
      flagCellFromSpawn,
      TEAM_SPAWN_SIZE
    );
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
      if (pixelsMutated) invalidateTeamScoresAggCache();
      return pixelsMutated;
    }
    /** @type {Map<string, { teamId: number, cells: Set<string>, deadlineMs: number, groupId: string }>} */
    const nextCarry = new Map();
    for (let e = 0; e < meta.length; e++) {
      const m = meta[e];
      if (m.deadlineMs <= now) {
        /** @type [number, number][] */
        const xyList = [];
        let removedAny = false;
        for (const k of m.cells) {
          const parts = k.split(",");
          const sx = Number(parts[0]);
          const sy = Number(parts[1]);
          if (!Number.isFinite(sx) || !Number.isFinite(sy)) continue;
          const x = sx | 0;
          const y = sy | 0;
          if (cellInsideAnyActiveBaseRectForTeam(x, y, m.teamId)) continue;
          pixels.delete(k);
          xyList.push([x, y]);
          removedAny = true;
        }
        removeMilitaryOutpostsFullyInsideIsolationCellSet(m.teamId, m.cells);
        if (removedAny) {
          broadcast({
            type: "territoryIsolationCollapse",
            teamId: m.teamId,
            groupId: m.groupId,
            sig: m.groupId,
            cells: xyList,
          });
          pixelsMutated = true;
        }
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
  if (pixelsMutated) invalidateTeamScoresAggCache();
  return pixelsMutated;
}

function normalizePixel(val) {
  if (val == null) {
    return { teamId: 0, ownerPlayerKey: "", shieldedUntil: 0, wallHp: 0 };
  }
  if (typeof val === "object") {
    return {
      teamId: val.teamId | 0,
      ownerPlayerKey: String(val.ownerPlayerKey || "").slice(0, 128),
      shieldedUntil: Number(val.shieldedUntil) || 0,
      wallHp: normalizeWallHp(val.wallHp),
    };
  }
  const tid = Number(val) | 0;
  return { teamId: tid, ownerPlayerKey: "", shieldedUntil: 0, wallHp: 0 };
}

/** @param {unknown} val */
function pixelWallHp(val) {
  return normalizePixel(val).wallHp;
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

/**
 * Один удар по чужой Great Wall (−1 HP или захват атакующим при 0).
 * Обычный захват зоны / пиксель не должны перекрашивать стену за один раз.
 * @returns {{ handled: boolean, wallBroken: boolean }}
 */
function tryApplyGreatWallSiegeHit(x, y, attackerTeamId, attackerPk) {
  const xi = x | 0;
  const yi = y | 0;
  const key = `${xi},${yi}`;
  const exWall = pixels.get(key);
  const wh = pixelWallHp(exWall);
  if (exWall == null || pixelTeam(exWall) === (attackerTeamId | 0) || wh <= 0) {
    return { handled: false, wallBroken: false };
  }
  const pEx = normalizePixel(exWall);
  const nextHp = wh - 1;
  if (nextHp > 0) {
    const nextRec = {
      teamId: pEx.teamId,
      ownerPlayerKey: pEx.ownerPlayerKey,
      shieldedUntil: pEx.shieldedUntil,
      wallHp: nextHp,
    };
    pixels.set(key, nextRec);
    tryApplyIncrementalTeamScoreForPixel(xi, yi, exWall, nextRec);
    queuePixelBroadcast(xi, yi, pEx.teamId, pEx.ownerPlayerKey, pEx.shieldedUntil, nextHp);
    broadcast({
      type: "purchaseVfx",
      kind: "greatWallHit",
      gx: xi,
      gy: yi,
      wallHp: nextHp,
      defenderTeamId: pEx.teamId | 0,
    });
    return { handled: true, wallBroken: false };
  }
  const prevBr = pixels.get(key);
  const recBr = { teamId: attackerTeamId, ownerPlayerKey: attackerPk, shieldedUntil: 0 };
  pixels.set(key, recBr);
  tryApplyIncrementalTeamScoreForPixel(xi, yi, prevBr, recBr);
  queuePixelBroadcast(xi, yi, attackerTeamId, attackerPk, 0, 0);
  broadcast({
    type: "purchaseVfx",
    kind: "greatWallBreak",
    gx: xi,
    gy: yi,
    attackerTeamId: attackerTeamId | 0,
    defenderTeamId: pEx.teamId | 0,
  });
  return { handled: true, wallBroken: true };
}

function applyPlannedCapture(pk, tid, planned) {
  invalidateTeamScoresAggCache();
  for (const [x, y] of planned) {
    if (!cellAllowsPixelPlacement(x, y)) continue;
    if (isEnemyOwnedFlagBaseCell(tid, x, y)) continue;
    const k = `${x},${y}`;
    const prev = pixels.get(k);
    const prevTeam = prev == null ? 0 : pixelTeam(prev);
    if (prev != null && prevTeam === (tid | 0)) {
      const whOwn = pixelWallHp(prev);
      const pEx = normalizePixel(prev);
      if (whOwn > 0) {
        pixels.set(k, {
          teamId: tid,
          ownerPlayerKey: pk,
          shieldedUntil: pEx.shieldedUntil,
          wallHp: whOwn,
        });
        queuePixelBroadcast(x, y, tid, pk, pEx.shieldedUntil, whOwn);
      } else {
        pixels.set(k, { teamId: tid, ownerPlayerKey: pk, shieldedUntil: 0 });
        queuePixelBroadcast(x, y, tid, pk, 0, 0);
      }
      continue;
    }
    if (tryApplyGreatWallSiegeHit(x, y, tid, pk).handled) {
      continue;
    }
    pixels.set(k, {
      teamId: tid,
      ownerPlayerKey: pk,
      shieldedUntil: 0,
    });
    queuePixelBroadcast(x, y, tid, pk, 0);
  }
  afterTerritoryMutation();
}

/**
 * Выдаёт клад на клетке игроку (одиночный пиксель или часть зоны).
 * @param {string} pk
 * @param {string} cellKey "x,y"
 * @param {boolean} [deferRoundStateSave] при true — не вызывать saveRoundState (пакет в claimTreasuresInPlannedCells)
 * @returns {Promise<number>} кванты 1..50 или 0
 */
async function tryClaimMapTreasureForPlayer(pk, cellKey, deferRoundStateSave) {
  const key = typeof cellKey === "string" ? cellKey.trim() : "";
  if (!key || !pk) return 0;
  if (gamePaused) return 0;
  if (!treasureQuantByCell.has(key) || treasureClaimedKeys.has(key)) return 0;
  const tq = treasureQuantByCell.get(key) | 0;
  if (tq < 1 || tq > 50) return 0;
  treasureClaimedKeys.add(key);
  if (!isDevUnlimitedWallet(pk)) {
    await walletStore.credit(pk, quantToUsdt(tq), { txHash: `map_treasure:${key}` });
  }
  if (!deferRoundStateSave) saveRoundState();
  broadcast({ type: "treasureClaimed", key });
  return tq;
}

/**
 * Клады после супероружия 4×4 / 6×6 / 12×12 (каждая покрытая клетка проверяется отдельно).
 * @param {string} pk
 * @param {Array<[number, number]>} planned
 * @returns {Promise<{ total: number, first: { x: number, y: number } | null }>}
 */
async function claimTreasuresInPlannedCells(pk, planned) {
  let total = 0;
  let first = null;
  for (let i = 0; i < planned.length; i++) {
    const p = planned[i];
    if (!Array.isArray(p) || p.length < 2) continue;
    const x = p[0] | 0;
    const y = p[1] | 0;
    const k = `${x},${y}`;
    const q = await tryClaimMapTreasureForPlayer(pk, k, true);
    if (q > 0) {
      total += q;
      if (!first) first = { x, y };
    }
  }
  if (total > 0) saveRoundState();
  return { total, first };
}

/** @type {Map<object, number>} */
const lastPlace = new WeakMap();
/** @type {Map<number, number>} teamId -> число игроков */
const teamPlayerCounts = new Map();

/** Кэш «связь с снабжением»: 8-связность от **любой** активной базы 6×6 (главная + передовые). До loadRoundState/rebuildLandFromRound → afterTerritoryMutation. */
let baseConnectedPixelsCacheGen = 0;
/** @type {Map<number, Set<string>>} */
const baseConnectedPixelsCacheByTeam = new Map();

function invalidateBaseConnectedPixelsCache() {
  baseConnectedPixelsCacheGen++;
  baseConnectedPixelsCacheByTeam.clear();
}

loadDynamicTeams();
loadRoundState();
if (gameFinished) {
  rebuildLandFromRound(Math.min(Math.max(roundIndex, 2), 3));
} else {
  rebuildLandFromRound(roundIndex);
}
loadPixelsSnapshotIfPresentSync();
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
    if (ext === ".html" && path.basename(full) === "index.html") {
      fs.readFile(full, "utf8", (readErr, html) => {
        if (readErr) {
          res.writeHead(500);
          res.end("Error");
          return;
        }
        const out = injectTelegramMetaIntoIndexHtml(html);
        res.writeHead(200, {
          "Content-Type": MIME[".html"],
          "X-Content-Type-Options": "nosniff",
        });
        res.end(out);
      });
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[ext] || "application/octet-stream",
      "X-Content-Type-Options": "nosniff",
    });
    fs.createReadStream(full).pipe(res);
  });
}

function fullPayloadObject() {
  const list = [];
  for (const [key, val] of pixels) {
    const [x, y] = key.split(",").map(Number);
    const p = normalizePixel(val);
    list.push([x, y, p.teamId, p.ownerPlayerKey, p.shieldedUntil, p.wallHp | 0]);
  }
  return { type: "full", pixels: list, pixelFormat: "v2" };
}

function fullPayload() {
  return JSON.stringify(fullPayloadObject());
}

async function broadcastWalletPayloadToAllClients() {
  if (!wss) return;
  const clients = [...wss.clients].filter((c) => c.readyState === 1);
  await Promise.all(
    clients.map((c) =>
      buildWalletPayload(c).then((pl) => {
        safeSend(c, pl);
      })
    )
  );
}

async function buildWalletPayload(ws) {
  const pk = ws.playerKey ? sanitizePlayerKey(ws.playerKey) : "";
  const u = await walletStore.getOrCreateUser(pk);
  const now = effectiveGameClockMs();
  const st = tournamentStage(roundIndex, gameFinished);
  const tid = ws.teamId | 0;
  const fx = tid ? getTeamFx(tid) : { teamRecoveryUntil: 0, teamRecoverySec: BASE_ACTION_COOLDOWN_SEC };
  const devUnl = pk && isDevUnlimitedWallet(pk);
  const teamFxPayload = { teamRecoveryUntil: fx.teamRecoveryUntil, teamRecoverySec: fx.teamRecoverySec };
  /* Безлимит только баланс/списания — интервал пикселя и баффы как у всех */
  const cd = pk ? effectivePixelCooldownMs(u, teamFxPayload, st, now) : BASE_ACTION_COOLDOWN_SEC * 1000;
  const ref = u.invitedByPlayerKey ? sanitizePlayerKey(u.invitedByPlayerKey) : "";
  const effectiveRecoverySec = pk ? effectiveRecoverySecForWallet(u, teamFxPayload, now) : BASE_ACTION_COOLDOWN_SEC;
  const farmQ5 = tid && quantumFarmLayouts.length ? getQuantumFarmIncomeQuantsForTeam(tid) : 0;
  const zoneQ5 = tid ? getBattleEventZoneQuantumQuantsForTeam(tid, now) : 0;
  return {
    type: "wallet",
    balanceUSDT: devUnl ? 999999999 : u.balanceUSDT,
    quantFarmIncomeQuantsPer5s: farmQ5,
    battleEventZoneQuantsPer5s: zoneQ5,
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

function quantumPixelTeamAtKey(key) {
  const v = pixels.get(key);
  return v == null ? 0 : pixelTeam(v);
}

function computeQuantumFarmOwnersNow() {
  /** @type {number[]} */
  const out = [];
  for (let i = 0; i < quantumFarmLayouts.length; i++) {
    const f = quantumFarmLayouts[i];
    const scores = scoreTeamsAroundFarm(f.x0, f.y0, gridW, gridH, quantumPixelTeamAtKey);
    out.push(resolveFarmControl(scores).owner | 0);
  }
  return out;
}

function getQuantumFarmIncomeQuantsForTeam(teamId) {
  const tid = teamId | 0;
  if (!tid || !quantumFarmLayouts.length) return 0;
  const owners = computeQuantumFarmOwnersNow();
  let sum = 0;
  for (let i = 0; i < owners.length; i++) {
    if ((owners[i] | 0) !== tid) continue;
    sum += normalizeQuantumFarmLevel(quantumFarmLevels[i]);
  }
  return sum;
}

/** @param {string} key формат "x,y" */
function parsePixelKeyXY(key) {
  const i = String(key).indexOf(",");
  if (i < 1) return null;
  const x = Number(String(key).slice(0, i));
  const y = Number(String(key).slice(i + 1));
  if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
  return { x: x | 0, y: y | 0 };
}

function teamTerritoryOverlapsRect(teamId, rect) {
  const tid = teamId | 0;
  if (!tid || !rect) return false;
  for (const [key, cell] of pixels) {
    if (pixelTeam(cell) !== tid) continue;
    const p = parsePixelKeyXY(key);
    if (!p) continue;
    if (pointInRect(p.x, p.y, rect)) return true;
  }
  return false;
}

function teamTerritoryOverlapsBestCompressionRegion(teamId, comp) {
  const tid = teamId | 0;
  if (!tid || !comp) return false;
  const candidates = [comp.centerMult, comp.nonCenterMult];
  if (comp.outerRingMult != null && Number.isFinite(comp.outerRingMult)) candidates.push(comp.outerRingMult);
  let best = candidates[0];
  for (let i = 1; i < candidates.length; i++) best = Math.max(best, candidates[i]);
  for (const [key, cell] of pixels) {
    if (pixelTeam(cell) !== tid) continue;
    const p = parsePixelKeyXY(key);
    if (!p) continue;
    const m = tournamentCompressionMultiplierForCell(p.x, p.y, gridW, gridH, comp);
    if (m >= best - 1e-8) return true;
  }
  return false;
}

/**
 * Сколько «стеков» визуальных бонус-зон событий пересекается с территорией команды (золото, бум-регион, лучший слой сжатия карты).
 * @param {number} teamId
 * @param {number} nowMs
 */
function getBattleEventZoneQuantumStackForTeam(teamId, nowMs) {
  const ctx = getBattleEventsContext(nowMs);
  if (!ctx) return 0;
  const snap = computeBattleScoringSnapshotWithManualBattle(nowMs, ctx);
  const battleEndMs = ctx.battleEndMs;
  let stack = 0;

  if (snap.goldRect && snap.goldUntilMs != null && snap.goldUntilMs > nowMs) {
    if (teamTerritoryOverlapsRect(teamId, snap.goldRect)) stack++;
  }

  if (snap.economicRects?.length && snap.economicUntilMs != null && snap.economicUntilMs > nowMs) {
    let touchedBonus = false;
    for (let i = 0; i < snap.economicRects.length; i++) {
      const r = snap.economicRects[i];
      if (!r || typeof r.mult !== "number" || r.mult <= 1) continue;
      if (teamTerritoryOverlapsRect(teamId, r)) {
        touchedBonus = true;
        break;
      }
    }
    if (touchedBonus) stack++;
  }

  if (snap.mapCompression && battleEndMs > nowMs) {
    const mcUntil =
      typeof snap.mapCompressionUntilMs === "number" && Number.isFinite(snap.mapCompressionUntilMs)
        ? snap.mapCompressionUntilMs
        : battleEndMs;
    if (nowMs < mcUntil && teamTerritoryOverlapsBestCompressionRegion(teamId, snap.mapCompression)) {
      stack++;
    }
  }

  return stack;
}

function getBattleEventZoneQuantumQuantsForTeam(teamId, nowMs) {
  return getBattleEventZoneQuantumStackForTeam(teamId, nowMs) * BATTLE_EVENT_ZONE_QUANT_PER_STACK;
}

function broadcastQuantumFarmTeamNotice(teamId, payload) {
  const tid = teamId | 0;
  broadcast({ ...payload, teamId: tid });
}

function syncQuantumFarmStateAfterTerritoryChange() {
  if (gamePaused || gameFinished || !quantumFarmLayouts.length) return;
  if (REDIS_URL && !isClusterLeader()) return;
  const next = computeQuantumFarmOwnersNow();
  if (quantumFarmOwnerPrev.length !== next.length) {
    quantumFarmOwnerPrev = next;
    return;
  }
  for (let i = 0; i < next.length; i++) {
    const a = quantumFarmOwnerPrev[i] | 0;
    const b = next[i] | 0;
    if (a === b) continue;
    const farmId = quantumFarmLayouts[i].id;
    if (a && !b) {
      broadcastQuantumFarmTeamNotice(a, { type: "quantumFarmNotice", kind: "disconnected", farmId });
    } else if (!a && b) {
      broadcastQuantumFarmTeamNotice(b, {
        type: "quantumFarmNotice",
        kind: "connected",
        farmId,
      });
    } else if (a && b && a !== b) {
      if (quantumFarmLevels[i] !== 1) {
        quantumFarmLevels[i] = 1;
        try {
          saveRoundState();
        } catch {
          /* ignore */
        }
      }
      broadcastQuantumFarmTeamNotice(a, { type: "quantumFarmNotice", kind: "lost", farmId, capturedByTeamId: b });
      broadcastQuantumFarmTeamNotice(b, {
        type: "quantumFarmNotice",
        kind: "captured_from",
        farmId,
        prevTeamId: a,
      });
      broadcast({ type: "quantumFarmsInit", farms: buildQuantumFarmsClientPayload() });
    }
  }
  quantumFarmOwnerPrev = next;
}

async function tickQuantumFarmIncome() {
  if (REDIS_URL && !isClusterLeader()) return;
  if (gamePaused || gameFinished) return;
  const nowMs = effectiveGameClockMs();

  /** @type {Map<number, number>} */
  const farmsPerTeam = new Map();
  if (quantumFarmLayouts.length) {
    const owners = computeQuantumFarmOwnersNow();
    for (let i = 0; i < owners.length; i++) {
      const t = owners[i] | 0;
      if (!t) continue;
      const inc = normalizeQuantumFarmLevel(quantumFarmLevels[i]);
      farmsPerTeam.set(t, (farmsPerTeam.get(t) | 0) + inc);
    }
  }

  /** @type {Map<number, number>} */
  const zoneQuantsByTeam = new Map();
  for (let ti = 0; ti < dynamicTeams.length; ti++) {
    const t = dynamicTeams[ti];
    if (!t || t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    if (!tid) continue;
    const zq = getBattleEventZoneQuantumQuantsForTeam(tid, nowMs) | 0;
    if (zq > 0) zoneQuantsByTeam.set(tid, zq);
  }

  if (farmsPerTeam.size === 0 && zoneQuantsByTeam.size === 0) return;

  quantumFarmIncomeTickSeq += 1;
  const tickTag = `${roundIndex}_${quantumFarmIncomeTickSeq}_${Date.now()}`;
  /** @type {Map<string, number>} */
  const quantByPk = new Map();

  for (const [tid, nf] of farmsPerTeam) {
    const nFarm = nf | 0;
    if (nFarm < 1) continue;
    if (isTeamEliminated(tid)) continue;
    const playerKeys = collectWinnerTeamPlayerKeys(tid);
    for (const pk of playerKeys) {
      if (!pk || isDevUnlimitedWallet(pk)) continue;
      quantByPk.set(pk, (quantByPk.get(pk) | 0) + nFarm);
    }
  }

  for (const [tid, zq] of zoneQuantsByTeam) {
    const zoneQ = zq | 0;
    if (zoneQ < 1) continue;
    const playerKeys = collectWinnerTeamPlayerKeys(tid);
    for (const pk of playerKeys) {
      if (!pk || isDevUnlimitedWallet(pk)) continue;
      quantByPk.set(pk, (quantByPk.get(pk) | 0) + zoneQ);
    }
  }

  if (quantByPk.size === 0) return;
  for (const [pk, q] of quantByPk) {
    const qq = q | 0;
    if (qq < 1) continue;
    await walletStore.credit(pk, quantToUsdt(qq), { txHash: `passive_quant:${tickTag}:${pk.slice(0, 24)}` });
  }
  await walletStore.save();
  await broadcastWalletPayloadToAllClients();

  /** Пульс клиенту: сумма ферм + зоны событий за тик (на игрока). */
  const pulseTeams = new Set([...farmsPerTeam.keys(), ...zoneQuantsByTeam.keys()]);
  for (const tid of pulseTeams) {
    if (isTeamEliminated(tid)) continue;
    const nFarm = farmsPerTeam.get(tid) | 0;
    const nZone = zoneQuantsByTeam.get(tid) | 0;
    const total = nFarm + nZone;
    if (total < 1) continue;
    broadcast({
      type: "quantFarmIncomePulse",
      teamId: tid | 0,
      quants: total,
      farmQuants: nFarm > 0 ? nFarm : undefined,
      eventZoneQuants: nZone > 0 ? nZone : undefined,
    });
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
      const wh = p.length >= 6 ? normalizeWallHp(p[5]) : 0;
      /** @type {{ teamId: number, ownerPlayerKey: string, shieldedUntil: number, wallHp?: number }} */
      const o = { teamId: t, ownerPlayerKey: opk, shieldedUntil: sh };
      if (wh > 0) o.wallHp = wh;
      pixels.set(`${x},${y}`, o);
    } else {
      pixels.set(`${x},${y}`, { teamId: p[2] | 0, ownerPlayerKey: "", shieldedUntil: 0 });
    }
  }
  invalidateTeamScoresAggCache();
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
      const wh = normalizeWallHp(msg.wallHp);
      /** @type {{ teamId: number, ownerPlayerKey: string, shieldedUntil: number, wallHp?: number }} */
      const o = {
        teamId: msg.t | 0,
        ownerPlayerKey: String(msg.ownerPlayerKey || "").slice(0, 128),
        shieldedUntil: Number(msg.shieldedUntil) || 0,
      };
      if (wh > 0) o.wallHp = wh;
      pixels.set(`${x},${y}`, o);
      return;
    }
    case "pixelBatch": {
      const fmt = msg.pixelFormat === "v2" ? "v2" : "v1";
      const list = Array.isArray(msg.cells) ? msg.cells : [];
      let any = false;
      for (let i = 0; i < list.length; i++) {
        const row = list[i];
        if (!Array.isArray(row) || row.length < 3) continue;
        const x = row[0] | 0;
        const y = row[1] | 0;
        if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
        if (!cellAllowsPixelPlacement(x, y)) continue;
        if (fmt === "v2" && row.length >= 5) {
          const wh = row.length >= 6 ? normalizeWallHp(row[5]) : 0;
          /** @type {{ teamId: number, ownerPlayerKey: string, shieldedUntil: number, wallHp?: number }} */
          const o = {
            teamId: row[2] | 0,
            ownerPlayerKey: String(row[3] || "").slice(0, 128),
            shieldedUntil: Number(row[4]) || 0,
          };
          if (wh > 0) o.wallHp = wh;
          pixels.set(`${x},${y}`, o);
        } else {
          pixels.set(`${x},${y}`, { teamId: row[2] | 0, ownerPlayerKey: "", shieldedUntil: 0 });
        }
        any = true;
      }
      if (any) invalidateTeamScoresAggCache();
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
    case "roundEvent": {
      /**
       * Кластер: надёжная синхронизация mstim с roundEvent (speed шлёт и mstimAltSeasonSync, и roundEvent).
       * Если sync-пакет не дошёл до инстанса, раньше здесь был «return» — оставались until=0 и кулдаун 15 с при живом HUD.
       */
      if (msg.phase === "start" && String(msg.eventType || "") === "alt_season_revenge") {
        const u = Number(msg.untilMs);
        if (Number.isFinite(u) && u > 0) {
          const next = u | 0;
          if ((mstimAltSeasonBurstUntilMs | 0) !== next) {
            mstimAltSeasonBurstUntilMs = next;
            if (DEBUG_MSTIM_COOLDOWN) {
              console.log(`[mstim] cluster roundEvent hydrate untilMs=${next} leader=${isClusterLeader()}`);
            }
          }
        }
      }
      return;
    }
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
    case "nukeBombImpact": {
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
    case "serverAnnouncement":
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
      if (dt) {
        dt.eliminated = true;
        dt.militaryOutposts = [];
        dt.lastMilitaryBaseAt = 0;
        delete dt.spawnX0;
        delete dt.spawnY0;
        saveDynamicTeams();
      }
      clearFlagCaptureStateForDefender(tid);
      removeTerritoryIsolationGroupsForTeam(tid);
      teamEffects.delete(tid);
      teamMemberKeys.delete(tid);
      synergyOnlineEpoch++;
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
        synergyOnlineEpoch++;
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
      const mil =
        msg.militaryAnchor && typeof msg.militaryAnchor.x0 === "number" && typeof msg.militaryAnchor.y0 === "number"
          ? { x0: msg.militaryAnchor.x0 | 0, y0: msg.militaryAnchor.y0 | 0 }
          : null;
      const stKey = mil ? militaryOutpostFlagStateKey(did, mil.x0, mil.y0) : did;
      const prevSt = mil ? militaryFlagCaptureByKey.get(stKey) : flagCaptureByDefender.get(did);
      if (msg.reset) {
        if (mil) militaryFlagCaptureByKey.delete(stKey);
        else flagCaptureByDefender.delete(did);
        return;
      }
      let hp;
      const rawHp = msg.hp;
      if (typeof rawHp === "number" && Number.isFinite(rawHp)) hp = rawHp | 0;
      else if (typeof rawHp === "string" && String(rawHp).trim() !== "") {
        const n = Number(rawHp);
        if (Number.isFinite(n)) hp = n | 0;
      }
      const capHp = typeof msg.maxHp === "number" && Number.isFinite(msg.maxHp) ? msg.maxHp | 0 : mil ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP;
      if (hp === undefined) hp = Math.max(0, capHp - (msg.progress | 0));
      if (hp >= capHp) {
        if (mil) militaryFlagCaptureByKey.delete(stKey);
        else flagCaptureByDefender.delete(did);
        return;
      }
      let lastHitAt = 0;
      const rawLh = msg.lastHitAt;
      if (typeof rawLh === "number" && Number.isFinite(rawLh)) lastHitAt = toEpochMsSafe(rawLh);
      else if (typeof rawLh === "string" && String(rawLh).trim() !== "") {
        const n = Number(rawLh);
        if (Number.isFinite(n)) lastHitAt = toEpochMsSafe(n);
      }
      const nowRepl = Date.now();
      if (!Number.isFinite(lastHitAt) || lastHitAt < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
        lastHitAt = nowRepl - FLAG_REGEN_IDLE_MS;
      }
      const entry = {
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
      };
      if (mil) militaryFlagCaptureByKey.set(stKey, entry);
      else flagCaptureByDefender.set(did, entry);
      return;
    }
    case "flagCaptureStopped": {
      const did = msg.defenderTeamId | 0;
      const mil =
        msg.militaryAnchor && typeof msg.militaryAnchor.x0 === "number" && typeof msg.militaryAnchor.y0 === "number"
          ? { x0: msg.militaryAnchor.x0 | 0, y0: msg.militaryAnchor.y0 | 0 }
          : null;
      if (mil) militaryFlagCaptureByKey.delete(militaryOutpostFlagStateKey(did, mil.x0, mil.y0));
      else flagCaptureByDefender.delete(did);
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
      if (msg.fullTeamElimination !== false) {
        const dtDef = dynamicTeams.find((x) => (x.id | 0) === did);
        if (dtDef && !dtDef.solo) {
          dtDef.eliminated = true;
          dtDef.militaryOutposts = [];
          dtDef.lastMilitaryBaseAt = 0;
          delete dtDef.spawnX0;
          delete dtDef.spawnY0;
          saveDynamicTeams();
        }
      }
      return;
    }
    case "militaryOutpostCaptured": {
      const did = msg.defenderTeamId | 0;
      const aid = msg.attackerTeamId | 0;
      const x0 = msg.x0 | 0;
      const y0 = msg.y0 | 0;
      const dt = dynamicTeams.find((t) => t.id === did);
      if (dt && Array.isArray(dt.militaryOutposts)) {
        const idx = dt.militaryOutposts.findIndex((o) => o && (o.x0 | 0) === x0 && (o.y0 | 0) === y0);
        if (idx >= 0) dt.militaryOutposts.splice(idx, 1);
      }
      clearMilitaryFlagStateForOutpost(did, x0, y0);
      for (let yy = y0; yy < y0 + TEAM_SPAWN_SIZE; yy++) {
        for (let xx = x0; xx < x0 + TEAM_SPAWN_SIZE; xx++) {
          pixels.set(`${xx},${yy}`, { teamId: aid, ownerPlayerKey: "", shieldedUntil: 0 });
        }
      }
      return;
    }
    case "militaryOutpostRemoved": {
      const did = msg.teamId | 0;
      const x0 = msg.x0 | 0;
      const y0 = msg.y0 | 0;
      const dt = dynamicTeams.find((t) => t.id === did);
      if (dt && Array.isArray(dt.militaryOutposts)) {
        const idx = dt.militaryOutposts.findIndex((o) => o && (o.x0 | 0) === x0 && (o.y0 | 0) === y0);
        if (idx >= 0) dt.militaryOutposts.splice(idx, 1);
      }
      clearMilitaryFlagStateForOutpost(did, x0, y0);
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
    case "quantFarmIncomePulse":
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
      if (typeof msg.roundStartMs === "number" && Number.isFinite(msg.roundStartMs)) {
        roundStartMs = msg.roundStartMs;
      }
      if (typeof msg.roundDurationMs === "number" && msg.roundDurationMs >= 1000 && msg.roundDurationMs <= 8760 * 3600000) {
        roundDurationMs = msg.roundDurationMs;
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
    case "mstimAltSeasonSync": {
      const u = Number(msg.untilMs);
      mstimAltSeasonBurstUntilMs = Number.isFinite(u) && u > 0 ? u | 0 : 0;
      if (DEBUG_MSTIM_COOLDOWN) {
        console.log(
          `[mstim] cluster sync untilMs=${mstimAltSeasonBurstUntilMs} active=${isMstimAltSeasonBurstActive()} leader=${isClusterLeader()}`
        );
      }
      return;
    }
    case "quantumFarmsInit": {
      if (Array.isArray(msg.farms)) {
        quantumFarmLayouts = msg.farms
          .filter((f) => f && typeof f.x0 === "number" && typeof f.y0 === "number")
          .map((f) => ({
            id: Number(f.id) | 0,
            x0: f.x0 | 0,
            y0: f.y0 | 0,
            w: typeof f.w === "number" ? f.w | 0 : 2,
            h: typeof f.h === "number" ? f.h | 0 : 2,
          }));
        quantumFarmLevels = quantumFarmLayouts.map((_, i) => {
          const raw = msg.farms[i] && msg.farms[i].level;
          return normalizeQuantumFarmLevel(raw);
        });
        quantumFarmOwnerPrev = quantumFarmLayouts.length ? computeQuantumFarmOwnersNow() : [];
      }
      return;
    }
    case "gamePauseSync": {
      gamePaused = !!msg.paused;
      if (typeof msg.pauseCapturedWarmup === "boolean") pauseCapturedWarmup = msg.pauseCapturedWarmup;
      if (gamePaused && typeof msg.pauseWallStartedAt === "number" && Number.isFinite(msg.pauseWallStartedAt)) {
        const pw = msg.pauseWallStartedAt | 0;
        if (pw > 0) pauseWallStartedAt = pw;
      }
      if (typeof msg.round0WarmupMs === "number" && Number.isFinite(msg.round0WarmupMs)) {
        const w = Math.round(msg.round0WarmupMs);
        if (w >= 5000 && w <= 600000) round0WarmupMs = w;
      }
      if (typeof msg.roundDurationMs === "number" && msg.roundDurationMs >= 1000 && msg.roundDurationMs <= 8760 * 3600000) {
        roundDurationMs = msg.roundDurationMs;
      }
      if (typeof msg.warmupPauseExtensionMs === "number" && Number.isFinite(msg.warmupPauseExtensionMs)) {
        warmupPauseExtensionMs = Math.max(0, Math.min(7 * 24 * 3600000, msg.warmupPauseExtensionMs | 0));
      }
      if (!msg.paused) {
        pauseWallStartedAt = 0;
        pauseCapturedWarmup = false;
      }
      playStartMs = getPlayStartMs();
      if (isClusterLeader()) schedulePlayStartBroadcast();
      return;
    }
    case "teamManualScoreBonusSync": {
      teamManualScoreBonus.clear();
      const bon = msg.bonuses && typeof msg.bonuses === "object" && !Array.isArray(msg.bonuses) ? msg.bonuses : {};
      for (const [k, v] of Object.entries(bon)) {
        const tid = Number(k) | 0;
        const n = Number(v);
        if (!tid || !Number.isFinite(n) || n === 0) continue;
        teamManualScoreBonus.set(tid, n);
      }
      return;
    }
    default:
      return;
  }
}

/** Клетка внутри прямоугольника стартовой базы команды (6×6), даже без пикселя в `pixels`. */
function cellInsideTeamSpawnRect(x, y, t) {
  if (!t || typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") return false;
  return (
    x >= t.spawnX0 &&
    x < t.spawnX0 + TEAM_SPAWN_SIZE &&
    y >= t.spawnY0 &&
    y < t.spawnY0 + TEAM_SPAWN_SIZE
  );
}

/** Старт BFS «связь с базой»: все закрашенные клетки команды внутри прямоугольника базы 6×6. */
function addBfsSeedsFromRectInVertices(vertices, x0, y0, size, out, stack) {
  const ox = x0 | 0;
  const oy = y0 | 0;
  const S = size | 0;
  for (let y = oy; y < oy + S; y++) {
    for (let x = ox; x < ox + S; x++) {
      const k = makeGridCellKey(x, y);
      if (vertices.has(k) && !out.has(k)) {
        out.add(k);
        stack.push(k);
      }
    }
  }
}

/** Если внутри 6×6 базы ещё нет своих пикселей — BFS стартует от любых клеток V, 8-соседних с прямоугольником базы (плацдарм / вода в квадрате). */
function addBfsSeedsTouchingTeamBaseRectsInVertices(vertices, t, size, out, stack) {
  const S = size | 0;
  if (!t || S < 1) return;
  /** @type {[number, number][]} */
  const corners = [];
  if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
    corners.push([t.spawnX0 | 0, t.spawnY0 | 0]);
  }
  for (const o of getTeamMilitaryOutposts(t)) {
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    corners.push([o.x0 | 0, o.y0 | 0]);
  }
  for (const [ox0, oy0] of corners) {
    for (let y = oy0; y < oy0 + S; y++) {
      for (let x = ox0; x < ox0 + S; x++) {
        for (let i = 0; i < GRID8_DELTAS.length; i++) {
          const nk = makeGridCellKey(x + GRID8_DELTAS[i][0], y + GRID8_DELTAS[i][1]);
          if (vertices.has(nk) && !out.has(nk)) {
            out.add(nk);
            stack.push(nk);
          }
        }
      }
    }
  }
}

/**
 * Все закрашенные клетки команды, 8-достижимые от любой активной базы (главная + плацдармы):
 * корни — любые клетки V внутри соответствующего 6×6 (не только центр флага).
 */
function computeBaseConnectedPixelKeysForTeam(teamId) {
  const tid = teamId | 0;
  if (!tid) return new Set();
  const hit = baseConnectedPixelsCacheByTeam.get(tid);
  if (hit) return hit;

  const vertices = new Set();
  for (const [k, v] of pixels) {
    if ((pixelTeam(v) | 0) === tid) vertices.add(k);
  }
  const out = new Set();
  const t = dynamicTeams.find((dt) => !dt.solo && !dt.eliminated && (dt.id | 0) === tid);
  if (!t || typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") {
    baseConnectedPixelsCacheByTeam.set(tid, out);
    return out;
  }
  const stack = [];
  const neighBuf = [];
  addBfsSeedsFromRectInVertices(vertices, t.spawnX0, t.spawnY0, TEAM_SPAWN_SIZE, out, stack);
  for (const o of getTeamMilitaryOutposts(t)) {
    if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
    addBfsSeedsFromRectInVertices(vertices, o.x0, o.y0, TEAM_SPAWN_SIZE, out, stack);
  }
  /* Всегда touch-seeds от всех баз (как в computeSupplyReachableFromTeamBases), иначе FOB без связи с семенами главной не стартует BFS. */
  addBfsSeedsTouchingTeamBaseRectsInVertices(vertices, t, TEAM_SPAWN_SIZE, out, stack);
  if (!stack.length) {
    baseConnectedPixelsCacheByTeam.set(tid, out);
    return out;
  }
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
  baseConnectedPixelsCacheByTeam.set(tid, out);
  return out;
}

/**
 * 8-соседство: своя закрашенная клетка только если она в компоненте, снабжаемом с любой активной базы 6×6;
 * иначе — только пустые клетки внутри 6×6 главной базы / плацдарма.
 * Отрезанный «мигающий» карман не даёт строить дальше от себя.
 */
function cellTouchesTeamTerritory(x, y, teamId) {
  const tid = teamId | 0;
  const t = dynamicTeams.find((dt) => !dt.solo && !dt.eliminated && (dt.id | 0) === tid);
  const baseConn = computeBaseConnectedPixelKeysForTeam(tid);
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || nx >= gridW || ny < 0 || ny >= gridH) continue;
      const nk = `${nx},${ny}`;
      const v = pixels.get(nk);
      if (v != null && pixelTeam(v) === tid) {
        if (baseConn.has(nk)) return true;
        continue;
      }
      if (t && cellInsideTeamSpawnRect(nx, ny, t)) return true;
      if (t && cellInsideAnyMilitaryOutpostRect(nx, ny, tid)) return true;
    }
  }
  return false;
}

/** Клетка внутри прямоугольника передовой базы команды (6×6). */
function cellInsideAnyMilitaryOutpostRect(x, y, teamId) {
  const tid = teamId | 0;
  const t = dynamicTeams.find((dt) => !dt.solo && !dt.eliminated && (dt.id | 0) === tid);
  if (!t) return false;
  for (const o of getTeamMilitaryOutposts(t)) {
    if (
      x >= o.x0 &&
      x < o.x0 + TEAM_SPAWN_SIZE &&
      y >= o.y0 &&
      y < o.y0 + TEAM_SPAWN_SIZE
    ) {
      return true;
    }
  }
  return false;
}

/** Главная 6×6 или любой плацдарм — не должны стираться таймером изоляции. */
function cellInsideAnyActiveBaseRectForTeam(x, y, teamId) {
  const tid = teamId | 0;
  const t = dynamicTeams.find((dt) => !dt.solo && !dt.eliminated && (dt.id | 0) === tid);
  if (!t) return false;
  if (cellInsideTeamSpawnRect(x, y, t)) return true;
  return cellInsideAnyMilitaryOutpostRect(x, y, tid);
}

/** Можно ставить пиксель, если из (x,y) 8-соседство с закрашенной территорией или с клеткой базы 6×6. */
function canPlaceForTeam(x, y, teamId) {
  return cellTouchesTeamTerritory(x, y, teamId);
}

/**
 * Якорь флага главной базы или передовой 6×6.
 * @returns {{ kind: "main", team: object } | { kind: "military", team: object, outpost: { x0: number, y0: number } } | null}
 */
function resolveFlagBaseAtCell(x, y) {
  const xi = x | 0;
  const yi = y | 0;
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
      const fc = flagCellFromSpawn(t.spawnX0, t.spawnY0);
      if (fc.x === xi && fc.y === yi) return { kind: "main", team: t };
    }
    for (const o of getTeamMilitaryOutposts(t)) {
      const fc = flagCellFromSpawn(o.x0, o.y0);
      if (fc.x === xi && fc.y === yi) return { kind: "military", team: t, outpost: { x0: o.x0 | 0, y0: o.y0 | 0 } };
    }
  }
  return null;
}

function findDefenderTeamAtFlagCell(x, y) {
  const r = resolveFlagBaseAtCell(x, y);
  return r ? r.team : null;
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
  const r = resolveFlagBaseAtCell(x, y);
  if (!r || (r.team.id | 0) === (attackerTeamId | 0)) return false;
  const did = r.team.id | 0;
  const existing = pixels.get(`${x},${y}`);
  const owner = existing != null ? pixelTeam(existing) : 0;
  return owner === did;
}

function pushOneFlagSnapshotRow(out, now, teamId, fx, fy, st, clientKey, militaryAnchor) {
  const maxHp = militaryAnchor ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP;
  if (st) {
    const lh = toEpochMsSafe(st.lastHitAt);
    if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
      st.lastHitAt = now - FLAG_REGEN_IDLE_MS;
    }
  }
  const eff = computeEffectiveBaseHp(st, now, maxHp);
  const displayFloor = Math.min(maxHp, Math.max(0, Math.floor(eff + 1e-9)));
  const metaHp = st ? Math.min(maxHp, Math.max(0, st.hp | 0)) : displayFloor;
  const attackerTeamId = (st?.attackerTeamId | 0) || 0;
  let lhMeta = now;
  if (st) {
    const lh = toEpochMsSafe(st.lastHitAt);
    lhMeta =
      Number.isFinite(lh) && lh >= FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS
        ? lh
        : now - FLAG_REGEN_IDLE_MS;
  }
  /** @type {Record<string, unknown>} */
  const row = {
    teamId,
    fx,
    fy,
    hp: metaHp,
    maxHp,
    lastHitAt: lhMeta,
    attackerTeamId,
    underAttack: displayFloor < maxHp,
    effectiveHp: eff,
    flagStateServerNow: now,
    clientKey,
  };
  if (militaryAnchor) row.militaryAnchor = militaryAnchor;
  out.push(row);
}

function buildFlagsSnapshot() {
  const out = [];
  const now = Date.now();
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const tid = Number(t.id) | 0;
    if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
      const { x, y } = flagCellFromSpawn(t.spawnX0, t.spawnY0);
      const st = flagCaptureByDefender.get(tid);
      pushOneFlagSnapshotRow(out, now, tid, x, y, st, `b:${tid}`, null);
    }
    for (const o of getTeamMilitaryOutposts(t)) {
      const ox0 = o.x0 | 0;
      const oy0 = o.y0 | 0;
      const mk = militaryOutpostFlagStateKey(tid, ox0, oy0);
      const stM = militaryFlagCaptureByKey.get(mk);
      const { x, y } = flagCellFromSpawn(ox0, oy0);
      pushOneFlagSnapshotRow(out, now, tid, x, y, stM, `m:${tid}:${ox0}:${oy0}`, { x0: ox0, y0: oy0 });
    }
  }
  return out;
}

function tickFlagBaseRegen(now) {
  if (!isClusterLeader()) return;
  if (gamePaused || gameFinished || roundEnding) return;
  scanMilitaryOutpostsVacancyAndExpire(now);
  const regenBroadcastPeriodMs = 800;
  for (const [did, st] of [...flagCaptureByDefender.entries()]) {
    const d = did | 0;
    if (!st) continue;
    const maxHp = FLAG_MAIN_BASE_MAX_HP;
    /* Без валидного lastHitAt computeEffectiveBaseHp не даёт рост eff — регена нет (см. FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS). */
    const lh0 = toEpochMsSafe(st.lastHitAt);
    if (!Number.isFinite(lh0) || lh0 < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
      st.lastHitAt = now - FLAG_REGEN_IDLE_MS;
    }
    const eff = computeEffectiveBaseHp(st, now, maxHp);
    if (eff >= maxHp - 1e-9) {
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
    const curInt = Math.max(0, Math.min(maxHp - 1, Math.floor(eff + 1e-9)));
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
      hp: Math.min(maxHp, Math.max(0, st.hp | 0)),
      maxHp,
      lastHitAt: st.lastHitAt,
      regen: true,
      effectiveHp: eff,
      serverNow: now,
    });
  }
  for (const [mkey, st] of [...militaryFlagCaptureByKey.entries()]) {
    if (!st) continue;
    const parts = String(mkey).split(":");
    const d = (Number(parts[0]) | 0) || 0;
    if (!d) continue;
    const maxHp = FLAG_BASE_MAX_HP;
    const lh0 = toEpochMsSafe(st.lastHitAt);
    if (!Number.isFinite(lh0) || lh0 < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) {
      st.lastHitAt = now - FLAG_REGEN_IDLE_MS;
    }
    const eff = computeEffectiveBaseHp(st, now, maxHp);
    if (eff >= maxHp - 1e-9) {
      militaryFlagCaptureByKey.delete(mkey);
      const ox0 = Number(parts[1]) | 0;
      const oy0 = Number(parts[2]) | 0;
      broadcast({
        type: "flagCaptureStopped",
        defenderTeamId: d,
        reason: "regen_full",
        militaryAnchor: { x0: ox0, y0: oy0 },
      });
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
    const curInt = Math.max(0, Math.min(maxHp - 1, Math.floor(eff + 1e-9)));
    const needBroadcast =
      st._lastRegenBroadcastHp !== curInt ||
      !st._lastRegenBroadcastAt ||
      now - st._lastRegenBroadcastAt >= regenBroadcastPeriodMs;
    if (!needBroadcast) continue;
    st._lastRegenBroadcastHp = curInt;
    st._lastRegenBroadcastAt = now;
    const ox0 = Number(parts[1]) | 0;
    const oy0 = Number(parts[2]) | 0;
    broadcast({
      type: "flagCaptureProgress",
      defenderTeamId: d,
      attackerTeamId: st.attackerTeamId | 0,
      hp: Math.min(maxHp, Math.max(0, st.hp | 0)),
      maxHp,
      lastHitAt: st.lastHitAt,
      regen: true,
      effectiveHp: eff,
      serverNow: now,
      militaryAnchor: { x0: ox0, y0: oy0 },
    });
  }
}

/**
 * Удар по базе: HP −1; при HP уже 0 — захват (главная или передовая 6×6).
 * @param {{ skipAdjacency?: boolean, skipRateLimit?: boolean }} [opts]
 * @returns {null | { rateLimited?: true } | { hit: true, defenderTeamId: number, hp: number, maxHp: number, militaryAnchor?: { x0: number, y0: number } } | { captured: true, defenderTeamId: number, militaryAnchor?: { x0: number, y0: number } }}
 */
function tryFlagCaptureHit(attackerTeamId, x, y, now, opts) {
  opts = opts || {};
  const skipAdjacency = opts.skipAdjacency === true;
  const skipRateLimit = opts.skipRateLimit === true;
  const resolved = resolveFlagBaseAtCell(x, y);
  if (!resolved) return null;
  const did = resolved.team.id | 0;
  const aid = attackerTeamId | 0;
  if (did === 0 || did === aid) return null;
  if (isTeamEliminated(aid) || isTeamEliminated(did)) return null;
  if (!skipAdjacency && !canPlaceForTeam(x, y, aid)) return null;

  const isMil = resolved.kind === "military";
  const ox0 = isMil ? resolved.outpost.x0 | 0 : 0;
  const oy0 = isMil ? resolved.outpost.y0 | 0 : 0;
  const mk = isMil ? militaryOutpostFlagStateKey(did, ox0, oy0) : null;
  const milAnchor = isMil ? { x0: ox0, y0: oy0 } : undefined;

  const key = `${x},${y}`;
  const existing = pixels.get(key);
  let owner = existing != null ? pixelTeam(existing) | 0 : 0;
  if (owner !== 0 && owner !== did) return null;
  if (owner === 0) {
    pixels.set(key, { teamId: did, ownerPlayerKey: "", shieldedUntil: 0 });
    queuePixelBroadcast(x, y, did, "", 0);
  }

  if (!skipRateLimit && !flagTeamHitLimiter.allow(`fc:${aid}`, FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC, 1000)) {
    return { rateLimited: true };
  }

  let st = isMil ? militaryFlagCaptureByKey.get(mk) : flagCaptureByDefender.get(did);
  const maxHp = isMil ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP;
  if (st) {
    const lh = toEpochMsSafe(st.lastHitAt);
    if (!Number.isFinite(lh) || lh < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) st.lastHitAt = now;
  }
  const curHpFloat = computeEffectiveBaseHp(st, now, maxHp);
  const curHp = Math.min(maxHp, Math.max(0, Math.floor(curHpFloat + 1e-9)));

  if (curHp <= 0) {
    if (isMil) executeMilitaryOutpostCaptureSuccess(aid, did, ox0, oy0);
    else executeFlagCaptureSuccess(aid, did);
    return { captured: true, defenderTeamId: did, ...(milAnchor ? { militaryAnchor: milAnchor } : {}) };
  }

  const newHp = curHp - 1;
  if (!st) {
    st = { hp: newHp, lastHitAt: now, attackerTeamId: aid };
    if (isMil) militaryFlagCaptureByKey.set(mk, st);
    else flagCaptureByDefender.set(did, st);
  } else {
    st.hp = newHp;
    st.lastHitAt = now;
    st.attackerTeamId = aid;
  }
  st._lastRegenBroadcastHp = newHp;
  st._flagRegenBroadcastPhase = false;

  if (curHp === maxHp) {
    broadcast({
      type: "flagUnderAttack",
      defenderTeamId: did,
      attackerTeamId: aid,
      hp: newHp,
      maxHp,
      ...(milAnchor ? { militaryAnchor: milAnchor } : {}),
    });
  }

  const effAfterHit = computeEffectiveBaseHp(st, now, maxHp);
  broadcast({
    type: "flagCaptureProgress",
    defenderTeamId: did,
    attackerTeamId: aid,
    hp: newHp,
    maxHp,
    lastHitAt: now,
    effectiveHp: effAfterHit,
    serverNow: now,
    ...(milAnchor ? { militaryAnchor: milAnchor } : {}),
  });

  const warnLevels = isMil ? FLAG_WARN_THRESHOLDS : FLAG_WARN_THRESHOLDS_MAIN;
  for (const th of warnLevels) {
    if (newHp === th) {
      broadcast({
        type: "flagDefendWarn",
        defenderTeamId: did,
        attackerTeamId: aid,
        hp: newHp,
        maxHp,
        level: th,
        ...(milAnchor ? { militaryAnchor: milAnchor } : {}),
      });
      break;
    }
  }

  return {
    hit: true,
    defenderTeamId: did,
    hp: newHp,
    maxHp,
    ...(milAnchor ? { militaryAnchor: milAnchor } : {}),
  };
}

/** Единственная точка смены владельца клетки флага и всей территории защитника (после добивающего удара). */
function executeFlagCaptureSuccess(attackerId, defenderId) {
  const dtDef = dynamicTeams.find((t) => t.id === defenderId);
  const dtAtk = dynamicTeams.find((t) => t.id === attackerId);
  if (!dtDef || dtDef.eliminated || dtDef.solo) return;
  if (!dtAtk || dtAtk.eliminated) return;

  invalidateTeamScoresAggCache();

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
    fullTeamElimination: true,
    defeatMessage: "Your base was captured. Your team has been destroyed.",
    victoryMessage: "Enemy base captured. All enemy territory is now yours.",
  });

  eliminateTeamByTerritoryLoss(defenderId);
  afterTerritoryMutation();
}

/**
 * Удаление передовой базы из меты и рассылка клиентам без afterTerritoryMutation
 * (иначе рекурсия из advanceTerritoryIsolationState).
 */
function removeMilitaryOutpostAtIndexCore(dt, index, reason) {
  if (!dt || !Array.isArray(dt.militaryOutposts)) return;
  const o = dt.militaryOutposts[index];
  if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") return;
  const ox0 = o.x0 | 0;
  const oy0 = o.y0 | 0;
  clearMilitaryFlagStateForOutpost(dt.id | 0, ox0, oy0);
  dt.militaryOutposts.splice(index, 1);
  saveDynamicTeams();
  broadcast({
    type: "militaryOutpostRemoved",
    teamId: dt.id | 0,
    x0: ox0,
    y0: oy0,
    reason: reason || "removed",
  });
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
}

/**
 * Раньше: снять FOB при коллапсе изоляции. Плацдарм из магазина не должен исчезать из‑за таймера/кармана.
 */
function removeMilitaryOutpostsFullyInsideIsolationCellSet(_teamId, _cellSet) {
  /* no-op: военная база (плацдарм) самодостаточна, без автоснятия при изоляции */
}

function removeMilitaryOutpostAtIndex(dt, index, reason) {
  removeMilitaryOutpostAtIndexCore(dt, index, reason);
  afterTerritoryMutation();
}

function scanMilitaryOutpostsVacancyAndExpire(_now) {
  /* no-op: плацдарм из магазина не снимается по таймеру «пустой 6×6» */
}

/** Захват передовой базы: снять узел с защитника, перекрасить 6×6 атакующему (команда защитника не выбывает). */
function executeMilitaryOutpostCaptureSuccess(attackerId, defenderId, ox0, oy0) {
  const dtDef = dynamicTeams.find((t) => t.id === defenderId);
  const dtAtk = dynamicTeams.find((t) => t.id === attackerId);
  if (!dtDef || dtDef.eliminated || dtDef.solo) return;
  if (!dtAtk || dtAtk.eliminated) return;
  invalidateTeamScoresAggCache();
  const x0 = ox0 | 0;
  const y0 = oy0 | 0;
  if (!Array.isArray(dtDef.militaryOutposts)) return;
  const idx = dtDef.militaryOutposts.findIndex((o) => o && (o.x0 | 0) === x0 && (o.y0 | 0) === y0);
  if (idx < 0) return;

  clearMilitaryFlagStateForOutpost(defenderId, x0, y0);
  dtDef.militaryOutposts.splice(idx, 1);

  const { x: fgx, y: fgy } = flagCellFromSpawn(x0, y0);
  for (let yy = y0; yy < y0 + TEAM_SPAWN_SIZE; yy++) {
    for (let xx = x0; xx < x0 + TEAM_SPAWN_SIZE; xx++) {
      pixels.set(`${xx},${yy}`, { teamId: attackerId, ownerPlayerKey: "", shieldedUntil: 0 });
      queuePixelBroadcast(xx, yy, attackerId, "", 0);
    }
  }

  broadcast({
    type: "militaryOutpostCaptured",
    attackerTeamId: attackerId,
    defenderTeamId: defenderId,
    x0,
    y0,
    gx: fgx,
    gy: fgy,
    attackerColor: dtAtk.color || "#888888",
    defenderColor: dtDef.color || "#888888",
    roundIndex,
  });

  saveDynamicTeams();
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
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

/** Chebyshev-зазор между границами двух осевых прямоугольников (клетки между краями). */
function rectChebyshevEdgeGap(x0, y0, w, h, ox0, oy0, ow, oh) {
  const dx = Math.max(0, Math.max(ox0 - (x0 + w), x0 - (ox0 + ow)));
  const dy = Math.max(0, Math.max(oy0 - (y0 + h), y0 - (oy0 + oh)));
  return Math.max(dx, dy);
}

/**
 * Проверка размещения передовой базы (левый верх 6×6).
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
function validateMilitaryBasePlacement(teamId, x0, y0) {
  const tid = teamId | 0;
  if (x0 < 0 || y0 < 0 || x0 + TEAM_SPAWN_SIZE > gridW || y0 + TEAM_SPAWN_SIZE > gridH) {
    return { ok: false, reason: "military_bounds" };
  }
  if (!rectAllLandSpan(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) {
    return { ok: false, reason: "military_water" };
  }
  if (!rectFreeOfPixels(x0, y0, TEAM_SPAWN_SIZE, TEAM_SPAWN_SIZE)) {
    return { ok: false, reason: "military_occupied" };
  }
  const t = dynamicTeams.find((dt) => !dt.solo && !dt.eliminated && (dt.id | 0) === tid);
  if (!t) return { ok: false, reason: "no_team" };
  const reserved = allSpawnLikeRectsForConflict();
  for (let i = 0; i < reserved.length; i++) {
    const o = reserved[i];
    if (spawnRectsConflict(x0, y0, o.x0, o.y0)) {
      return { ok: false, reason: "military_conflict" };
    }
  }
  if (typeof t.spawnX0 === "number" && typeof t.spawnY0 === "number") {
    const gOwn = rectChebyshevEdgeGap(
      x0,
      y0,
      TEAM_SPAWN_SIZE,
      TEAM_SPAWN_SIZE,
      t.spawnX0,
      t.spawnY0,
      TEAM_SPAWN_SIZE,
      TEAM_SPAWN_SIZE
    );
    if (gOwn < MILITARY_MIN_EDGE_GAP_OWN_MAIN) {
      return { ok: false, reason: "military_too_close_own_main" };
    }
  }
  for (const ot of dynamicTeams) {
    if (ot.solo || ot.eliminated) continue;
    if ((ot.id | 0) === tid) continue;
    if (typeof ot.spawnX0 !== "number" || typeof ot.spawnY0 !== "number") continue;
    const gEn = rectChebyshevEdgeGap(
      x0,
      y0,
      TEAM_SPAWN_SIZE,
      TEAM_SPAWN_SIZE,
      ot.spawnX0,
      ot.spawnY0,
      TEAM_SPAWN_SIZE,
      TEAM_SPAWN_SIZE
    );
    if (gEn < MILITARY_MIN_EDGE_GAP_ENEMY_MAIN) {
      return { ok: false, reason: "military_too_close_enemy_main" };
    }
  }
  return { ok: true };
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
  const others = allSpawnLikeRectsForConflict();
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
  invalidateTeamScoresAggCache();
  const opk = String(ownerPk || "").slice(0, 128);
  for (let y = y0; y < y0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
      if (!cellAllowsPixelPlacement(x, y)) continue;
      pixels.set(`${x},${y}`, { teamId, ownerPlayerKey: opk, shieldedUntil: 0 });
    }
  }
}

/** Закрасить 6×6 без afterTerritoryMutation (пакетное восстановление плацдармов). */
function paintTeamSpawnCellsOnly(teamId, x0, y0, ownerPk) {
  const opk = String(ownerPk || "").slice(0, 128);
  const tid = teamId | 0;
  for (let y = y0; y < y0 + TEAM_SPAWN_SIZE; y++) {
    for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
      if (!cellAllowsPixelPlacement(x, y)) continue;
      const k = `${x},${y}`;
      pixels.set(k, { teamId: tid, ownerPlayerKey: opk, shieldedUntil: 0 });
      queuePixelBroadcast(x, y, tid, opk, 0);
    }
  }
}

function paintTeamSpawnArea(teamId, x0, y0, ownerPk) {
  invalidateTeamScoresAggCache();
  paintTeamSpawnCellsOnly(teamId, x0, y0, ownerPk);
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
  ensureMilitaryOutpostPixelsAfterLoad();
  afterTerritoryMutation();
}

/** После рестарта сервера: заново закрасить 6×6 купленных плацдармов (мета уже в dynamic-teams.json). */
function ensureMilitaryOutpostPixelsAfterLoad() {
  let any = false;
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const tid = t.id | 0;
    for (const o of getTeamMilitaryOutposts(t)) {
      if (!o || typeof o.x0 !== "number" || typeof o.y0 !== "number") continue;
      const x0 = o.x0 | 0;
      const y0 = o.y0 | 0;
      let need = false;
      for (let y = y0; y < y0 + TEAM_SPAWN_SIZE && !need; y++) {
        for (let x = x0; x < x0 + TEAM_SPAWN_SIZE; x++) {
          const p = pixels.get(`${x},${y}`);
          if (!p || pixelTeam(p) !== tid) {
            need = true;
            break;
          }
        }
      }
      if (need) {
        any = true;
        paintTeamSpawnCellsOnly(tid, x0, y0, "");
      }
    }
  }
  if (any) invalidateTeamScoresAggCache();
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
  if (!gameFinished && !gamePaused && (!REDIS_URL || isClusterLeader())) {
    advanceTerritoryIsolationState();
    const next = computeTeamTerritoryCounts();
    notifyTerritoryDramaEvents(lastTerritoryCountSnapshot, next);
    lastTerritoryCountSnapshot = new Map(next);
    scanAndEliminateTeamsWithNoTerritory(next);
    syncQuantumFarmStateAfterTerritoryChange();
    const st = buildStatsPayload();
    updateTiebreakFromStatsPayload(st);
    checkDuelWinByElimination(st);
    scanMilitaryOutpostsVacancyAndExpire(Date.now()); /* no-op: плацдарм без автотаймера */
    schedulePixelsSnapshotSave();
  }
  /* Всегда: иначе при паузе / раннем return кэш «связь с базой» устаревает — нельзя ставить пиксели от передовой базы. */
  invalidateBaseConnectedPixelsCache();
}

/** @param {Map<number, number> | undefined} byTeam — если уже есть результат computeTeamTerritoryCounts, не второй проход по pixels. */
function scanAndEliminateTeamsWithNoTerritory(byTeam) {
  const counts = byTeam ?? computeTeamTerritoryCounts();
  const victims = [];
  for (const t of dynamicTeams) {
    if (t.solo || t.eliminated) continue;
    const n = counts.get(t.id) | 0;
    if (n === 0) victims.push(t.id);
  }
  for (const tid of victims) {
    eliminateTeamByTerritoryLoss(tid);
  }
}

function eliminateTeamByTerritoryLoss(teamId) {
  const dt = dynamicTeams.find((t) => t.id === teamId);
  if (!dt || dt.solo || dt.eliminated) return;
  invalidateTeamScoresAggCache();
  clearFlagCaptureStateForDefender(teamId);
  removeTerritoryIsolationGroupsForTeam(teamId);
  if (isClusterLeader() && !gameFinished) {
    broadcastTerritoryIsolationSyncIfChanged(Date.now());
  }
  dt.eliminated = true;
  dt.militaryOutposts = [];
  dt.lastMilitaryBaseAt = 0;
  let destroyGx = 0;
  let destroyGy = 0;
  if (typeof dt.spawnX0 === "number" && typeof dt.spawnY0 === "number") {
    destroyGx = (dt.spawnX0 + TEAM_SPAWN_SIZE / 2) | 0;
    destroyGy = (dt.spawnY0 + TEAM_SPAWN_SIZE / 2) | 0;
  }
  delete dt.spawnX0;
  delete dt.spawnY0;
  saveDynamicTeams();
  teamManualScoreBonus.delete(teamId);
  teamPeakScoreForTiebreak.delete(teamId);
  teamFirstHitPeakAt.delete(teamId);
  teamEffects.delete(teamId);
  teamMemberKeys.delete(teamId);
  synergyOnlineEpoch++;
  teamPlayerCounts.delete(teamId);
  const payload = {
    type: "teamEliminated",
    teamId,
    roundIndex,
    canReenter: roundIndex === 0,
    destroyGx,
    destroyGy,
    teamColor: dt.color || "#888888",
    defeatMessage: "Your team was destroyed.",
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

/**
 * Если в публичной команде 0 игроков — полностью удаляет её из мира и dynamic-teams.json,
 * освобождает цвет и снимает все пиксели/флаги/баффы команды.
 * @returns {boolean} true если команда удалена
 */
function tryDeleteTeamWithNoMembers(teamId) {
  const tid = teamId | 0;
  if (!tid) return false;
  const players = teamPlayerCounts.get(tid) ?? 0;
  if (players > 0) return false;
  const dt = dynamicTeams.find((t) => (t.id | 0) === tid);
  if (!dt || dt.solo) return false;
  const mem = teamMemberKeys.get(tid);
  if (mem && mem.size > 0) {
    teamMemberKeys.delete(tid);
    synergyOnlineEpoch++;
  }
  invalidateTeamScoresAggCache();
  clearFlagCaptureStateForDefender(tid);
  removeTerritoryIsolationGroupsForTeam(tid);
  const keysToDelete = [];
  for (const [k, val] of pixels.entries()) {
    if ((pixelTeam(val) | 0) === tid) keysToDelete.push(k);
  }
  for (let i = 0; i < keysToDelete.length; i++) {
    const k = keysToDelete[i];
    pixels.delete(k);
    const p = parsePixelKeyXY(k);
    if (p) queuePixelBroadcast(p.x, p.y, 0, "", 0, 0);
  }
  teamEffects.delete(tid);
  teamManualScoreBonus.delete(tid);
  teamPeakScoreForTiebreak.delete(tid);
  teamFirstHitPeakAt.delete(tid);
  teamPlayerCounts.delete(tid);
  teamMemberKeys.delete(tid);
  synergyOnlineEpoch++;
  const ix = dynamicTeams.findIndex((t) => t.id === tid);
  if (ix >= 0) dynamicTeams.splice(ix, 1);
  saveDynamicTeams();
  afterTerritoryMutation();
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
  broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
  scheduleStatsBroadcast();
  return true;
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

/** После NOWPayments IPN баланс в БД обновлён, но открытый Mini App не узнаёт об этом без пакета wallet по WebSocket. */
async function pushWalletToPlayerKey(playerKey) {
  if (!wss) return;
  const pk = sanitizePlayerKey(playerKey);
  if (!pk) return;
  for (const c of wss.clients) {
    if (c.readyState !== 1) continue;
    if (sanitizePlayerKey(c.playerKey) !== pk) continue;
    try {
      safeSend(c, await buildWalletPayload(c));
    } catch (e) {
      console.warn("[ipn] push wallet:", e?.message || e);
    }
  }
}

function parseNowpaymentsIpnCreditUsdt(body) {
  const pick = (v) => {
    const n = typeof v === "string" && String(v).trim() !== "" ? Number(String(v).trim()) : Number(v);
    return Number.isFinite(n) && n > 0 ? Math.round(n * 100) / 100 : NaN;
  };
  const keys = ["price_amount", "outcome_amount", "pay_amount", "actually_paid"];
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    if (body[k] == null || body[k] === "") continue;
    const n = pick(body[k]);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

function nowpaymentsIpnStatusMeansCredited(statusRaw) {
  const s = String(statusRaw || "").trim().toLowerCase();
  return (
    s === "finished" ||
    s === "confirmed" ||
    s === "partially_paid" ||
    s === "completed"
  );
}

async function handleApi(req, res) {
  const url = (req.url || "").split("?")[0];
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  const clientIp = getClientIpFromReq(req);

  if (req.method === "POST" && url === "/api/auth/telegram-bridge-token") {
    if (!TELEGRAM_BOT_TOKEN) {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: "telegram not configured" }));
      return;
    }
    if (!PUBLIC_BASE_URL) {
      res.writeHead(503);
      res.end(JSON.stringify({ ok: false, error: "PUBLIC_BASE_URL not set" }));
      return;
    }
    if (!telegramBridgeMintLimiter.allow(`bridgemint:${clientIp}`, TELEGRAM_BRIDGE_MINT_PER_HOUR, 3_600_000)) {
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
    let body;
    try {
      body = JSON.parse(rawBuf.toString("utf8"));
    } catch {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false }));
      return;
    }
    const initData = typeof body.initData === "string" ? body.initData.trim() : "";
    if (!initData) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "initData required" }));
      return;
    }
    const v = verifyTelegramWebAppInitData(initData, TELEGRAM_BOT_TOKEN, {
      maxAgeSec: TELEGRAM_INITDATA_MAX_AGE_SEC,
    });
    if (!v) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "bad initData" }));
      return;
    }
    pruneTelegramBridgeTokens();
    const token = crypto.randomBytes(TELEGRAM_BRIDGE_TOKEN_BYTES).toString("hex");
    telegramBridgeTokens.set(token, { initData, exp: Date.now() + TELEGRAM_BRIDGE_TOKEN_TTL_MS });
    const base = PUBLIC_BASE_URL.replace(/\/$/, "");
    const openUrl = `${base}/?tg_bridge=${encodeURIComponent(token)}`;
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, url: openUrl }));
    return;
  }

  if (req.method === "POST" && url === "/api/auth/telegram-bridge-consume") {
    let rawBuf;
    try {
      rawBuf = await readRequestBody(req);
    } catch {
      res.writeHead(413);
      res.end(JSON.stringify({ ok: false }));
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
    const token = typeof body.token === "string" ? body.token.trim() : "";
    if (!token || !/^[a-f0-9]+$/i.test(token) || token.length !== TELEGRAM_BRIDGE_TOKEN_BYTES * 2) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "bad token" }));
      return;
    }
    pruneTelegramBridgeTokens();
    const entry = telegramBridgeTokens.get(token);
    if (!entry || entry.exp < Date.now()) {
      res.writeHead(400);
      res.end(JSON.stringify({ ok: false, error: "invalid or expired token" }));
      return;
    }
    telegramBridgeTokens.delete(token);
    res.writeHead(200);
    res.end(JSON.stringify({ ok: true, initData: entry.initData }));
    return;
  }

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
      console.warn("[ipn] отклонено: неверная подпись или пустой NOWPAYMENTS_IPN_SECRET");
      res.writeHead(401);
      res.end(JSON.stringify({ ok: false, error: "bad signature" }));
      return;
    }
    if (!isUsdtDepositsEnabled()) {
      console.warn("[ipn] пропуск: USDT-пополнения отключены (политика)");
      res.writeHead(200);
      res.end(
        JSON.stringify({
          ok: false,
          error: "Purchases are currently disabled",
          message: "Purchases are currently disabled",
        })
      );
      return;
    }
    const status = String(body.payment_status || body.status || "");
    const finished = nowpaymentsIpnStatusMeansCredited(status);
    if (!finished) {
      console.warn("[ipn] пропуск статуса:", status || "(пусто)");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: true, ignored: true }));
      return;
    }
    const npId = body.payment_id ?? body.id;
    if (npId == null) {
      console.warn("[ipn] нет payment_id в теле");
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: "no payment id" }));
      return;
    }
    const orderId = String(body.order_id || body.orderId || "");
    const parts = orderId.split("|");
    if (parts[0] !== "dep" || !parts[1]) {
      console.warn("[ipn] неверный order_id:", orderId.slice(0, 120));
      res.writeHead(200);
      res.end(JSON.stringify({ ok: false, error: "bad order" }));
      return;
    }
    const playerKey = sanitizePlayerKey(parts[1]);
    const creditUsdt = parseNowpaymentsIpnCreditUsdt(body);
    if (!playerKey || !Number.isFinite(creditUsdt) || creditUsdt <= 0) {
      console.warn("[ipn] нет суммы или playerKey; order=", orderId.slice(0, 80));
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
    if (dep.ok) {
      console.warn("[ipn] зачислено", String(npId), "→", playerKey.slice(0, 28));
    } else if (dep.duplicate === true) {
      console.warn("[ipn] повтор callback (уже зачислено)", String(npId));
    } else {
      console.warn("[ipn] finalizeDeposit не прошёл", String(npId));
    }
    /* Несколько инстансов (Render): IPN может прийти не на тот узел, где висит WebSocket игрока — шлём сигнал в Redis, каждый узел пушит wallet своим клиентам. */
    if (dep.ok || dep.duplicate === true) {
      if (redisGamePublish) {
        publishRedisGameInternal(
          JSON.stringify({ type: "walletRefreshPlayer", playerKey: sanitizePlayerKey(playerKey) })
        );
      } else {
        await pushWalletToPlayerKey(playerKey);
      }
    }
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
    if (!isUsdtDepositsEnabled()) {
      res.writeHead(403);
      res.end(
        JSON.stringify({
          ok: false,
          error: "Purchases are currently disabled",
          message: "Purchases are currently disabled",
        })
      );
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
  /* Лёгкий ответ без БД/файлов — для Render Health Checks и диагностики 502 (прокси не достучался до процесса). */
  if (u === "/health" || u === "/healthz") {
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    res.end("ok");
    return;
  }
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

/* Дольше, чем типичные 60s у LB — иначе «тихие» соединения и WS могут резаться раньше времени. */
server.keepAliveTimeout = 76_000;
server.headersTimeout = 78_000;

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

/** Пинг по WebSocket: прокси (Render, nginx) часто рвут «тихие» сокеты через 60–120 с. */
const WS_APP_PING_INTERVAL_MS = Math.min(
  120_000,
  Math.max(15_000, Number(process.env.WS_APP_PING_INTERVAL_MS) || 25_000)
);
setInterval(() => {
  if (!wss) return;
  for (const client of wss.clients) {
    if (client.readyState !== 1) continue;
    try {
      client.ping();
    } catch {
      /* ignore */
    }
  }
}, WS_APP_PING_INTERVAL_MS);

/** @type {Map<string, { initData: string, exp: number }>} */
const telegramBridgeTokens = new Map();
const TELEGRAM_BRIDGE_TOKEN_TTL_MS = 12 * 60 * 1000;
const TELEGRAM_BRIDGE_TOKEN_BYTES = 24;
const TELEGRAM_BRIDGE_MINT_PER_HOUR = 48;

function pruneTelegramBridgeTokens() {
  const now = Date.now();
  for (const [k, v] of telegramBridgeTokens) {
    if (v.exp < now) telegramBridgeTokens.delete(k);
  }
}

setInterval(() => {
  apiDepositLimiter.prune();
  apiIpnLimiter.prune();
  telegramBridgeMintLimiter.prune();
  wsMsgLimiter.prune();
  wsPixelBurstLimiter.prune();
  claimAttemptLimiter.prune();
  wsJoinLimiter.prune();
  wsPurchaseLimiter.prune();
  pruneTelegramBridgeTokens();
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
  const nowMs = effectiveGameClockMs();
  if (REDIS_URL && !isClusterLeader()) {
    rebuildTeamScoresAggFromFullScan(nowMs);
  } else if (teamScoreCacheEpochSynced !== teamScoreStatsEpoch) {
    rebuildTeamScoresAggFromFullScan(nowMs);
  }
  /** @type {Map<number, { score: number; cells: number }>} */
  const agg = new Map();
  for (const tid of teamStatsMass.keys()) {
    const M = teamStatsMass.get(tid) | 0;
    const S = teamStatsSumV.get(tid) || 0;
    if (M <= 0) continue;
    agg.set(tid, { score: M * S, cells: M });
  }
  const list = teamsForMeta().filter((t) => !t.solo && !t.eliminated);
  let totalAvailableScore = 0;
  for (const t of list) {
    const a = agg.get(t.id) || { score: 0, cells: 0 };
    const bonus = teamManualScoreBonus.get(t.id) | 0;
    totalAvailableScore += a.score + bonus;
  }
  const rows = list.map((t) => {
    const a = agg.get(t.id) || { score: 0, cells: 0 };
    const bonus = teamManualScoreBonus.get(t.id) | 0;
    const score = Math.round((a.score + bonus) * 1000) / 1000;
    const pix = a.cells | 0;
    const scoreSharePercent =
      totalAvailableScore > 0 ? Math.round(((a.score + bonus) / totalAvailableScore) * 100000) / 1000 : 0;
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
      /** Доля от суммы очков всех команд в этом stats (не «% карты»). Совместимость: старые клиенты читали `percent`. */
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

function scheduleStatsBroadcast() {
  if (statsBroadcastTimer != null) return;
  statsBroadcastTimer = setTimeout(() => {
    statsBroadcastTimer = null;
    broadcast(buildStatsPayload());
  }, STATS_BROADCAST_DEBOUNCE_MS);
}

function broadcastStatsImmediate() {
  broadcast(buildStatsPayload());
}

function logAdminAction(entry) {
  console.log(`[admin] ${JSON.stringify({ ts: new Date().toISOString(), ...entry })}`);
}

/** Максимум квантов за одну админ-операцию (+/-/=), защита от опечаток. */
const ADMIN_QUANT_SINGLE_OP_MAX = 1_000_000_000;

function quantsFromBalanceUsdt(usdt) {
  return Math.round(Number(usdt) * 7);
}

function roundEconomyUsdt(u) {
  return Math.round(Number(u) * 1e6) / 1e6;
}

/**
 * @param {string} normRaw нормализованная строка, напр. "quant 123 +50"
 * @returns {{ ok: true, tgId: number, op: "+" | "-" | "=", amount: number } | { ok: false }}
 */
function parseTelegramAdminQuantCommand(normRaw) {
  const s = String(normRaw || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, " ");
  const m = /^quant (\d{1,18})\s*([+\-=])\s*(\d{1,12})$/i.exec(s);
  if (!m) return { ok: false };
  const tgId = parseInt(m[1], 10);
  const op = m[2];
  const amount = parseInt(m[3], 10);
  if (!Number.isFinite(tgId) || tgId < 1) return { ok: false };
  if (!Number.isFinite(amount) || amount < 0) return { ok: false };
  if (amount > ADMIN_QUANT_SINGLE_OP_MAX) return { ok: false };
  if (op !== "+" && op !== "-" && op !== "=") return { ok: false };
  if (op !== "=" && amount === 0) return { ok: false };
  return { ok: true, tgId, op, amount };
}

/**
 * @param {number} chatId
 * @param {number} adminTelegramUid
 * @param {{ ok: true, tgId: number, op: "+" | "-" | "=", amount: number }} parsed
 */
async function applyAdminQuantTelegramCommand(chatId, adminTelegramUid, parsed) {
  const pk = sanitizePlayerKey(`tg_${parsed.tgId}`);
  const exists = await walletStore.hasEconomyUserRecord(pk);
  if (!exists) {
    await telegramSendMessage(
      chatId,
      `No economy record for numeric Telegram user ID ${parsed.tgId} (not @username / team name). Player must have logged in at least once.`
    );
    return;
  }
  const u = await walletStore.getOrCreateUser(pk);
  const oldUsdt = Number(u.balanceUSDT) || 0;
  const oldQ = quantsFromBalanceUsdt(oldUsdt);

  let newUsdt = oldUsdt;
  if (parsed.op === "+") {
    newUsdt = oldUsdt + quantToUsdt(parsed.amount);
  } else if (parsed.op === "-") {
    const sub = quantToUsdt(parsed.amount);
    if (oldUsdt + 1e-9 < sub) {
      await telegramSendMessage(
        chatId,
        `Insufficient balance: cannot subtract ${parsed.amount} quants from Telegram ID ${parsed.tgId} (current ${oldQ} quants).`
      );
      return;
    }
    newUsdt = oldUsdt - sub;
  } else {
    newUsdt = quantToUsdt(parsed.amount);
  }
  u.balanceUSDT = roundEconomyUsdt(Math.max(0, newUsdt));
  const newQ = quantsFromBalanceUsdt(u.balanceUSDT);

  await walletStore.flushUsersEconomy([pk]);

  logAdminAction({
    command: "quant",
    byTelegramId: adminTelegramUid,
    targetTelegramId: parsed.tgId,
    playerKey: pk,
    op: parsed.op,
    quantArg: parsed.amount,
    oldBalanceQuants: oldQ,
    newBalanceQuants: newQ,
    oldBalanceUSDT: oldUsdt,
    newBalanceUSDT: u.balanceUSDT,
  });

  let msg;
  if (parsed.op === "+") {
    msg = `Added ${parsed.amount} quants to Telegram ID ${parsed.tgId}. New balance: ${newQ}`;
  } else if (parsed.op === "-") {
    msg = `Subtracted ${parsed.amount} quants from Telegram ID ${parsed.tgId}. New balance: ${newQ}`;
  } else {
    msg = `Set balance to ${newQ} quants for Telegram ID ${parsed.tgId}.`;
  }
  await telegramSendMessage(chatId, msg);

  if (wss) {
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      if (sanitizePlayerKey(c.playerKey) !== pk) continue;
      safeSend(c, await buildWalletPayload(c));
      void sendConnectionMeta(c);
    }
  }
}

/** Максимум Telegram ID в одном сообщении quantlist (лимит длины ответа в Telegram). */
const ADMIN_QUANTLIST_MAX_IDS = 20;

/**
 * @param {string} normRaw напр. "quantlist 123456789" или "quantlist 1 2 3"
 * @returns {{ ok: true, tgIds: number[] } | { ok: false, reason: "usage" | "invalid" | "too_many" }}
 */
function parseTelegramAdminQuantlistCommand(normRaw) {
  const s = String(normRaw || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\s+/g, " ");
  const m = /^quantlist(?:\s+(.*))?$/i.exec(s);
  if (!m) return { ok: false, reason: "invalid" };
  const rest = (m[1] || "").trim();
  if (!rest) return { ok: false, reason: "usage" };
  const parts = rest.split(/\s+/);
  /** @type {number[]} */
  const tgIds = [];
  for (const p of parts) {
    if (!/^\d{1,18}$/.test(p)) return { ok: false, reason: "invalid" };
    const id = parseInt(p, 10);
    if (!Number.isFinite(id) || id < 1) return { ok: false, reason: "invalid" };
    tgIds.push(id);
  }
  if (tgIds.length > ADMIN_QUANTLIST_MAX_IDS) return { ok: false, reason: "too_many" };
  return { ok: true, tgIds };
}

/** @returns {number} teamId или 0 */
function resolveTeamIdForPlayerKey(pkRaw) {
  const k = sanitizePlayerKey(pkRaw);
  if (!k) return 0;
  for (const [tid, set] of teamMemberKeys) {
    if (set.has(k)) return tid | 0;
  }
  return 0;
}

/**
 * Онлайн — кэш процесса (тот же объект, что у игры). Офлайн — перечитать из БД/файла, без устаревшего RAM.
 * @returns {Promise<{ user: Awaited<ReturnType<typeof walletStore.getOrCreateUser>>; balanceSource: "live" | "persisted" }>}
 */
async function resolveQuantlistEconomyUser(pk) {
  const online = isPlayerKeyOnline(pk);
  if (online) {
    const user = await walletStore.getOrCreateUser(pk);
    return { user, balanceSource: "live" };
  }
  if (typeof walletStore.refreshEconomyUserFromPersistence === "function") {
    const user = await walletStore.refreshEconomyUserFromPersistence(pk);
    return { user, balanceSource: "persisted" };
  }
  const user = await walletStore.getOrCreateUser(pk);
  return { user, balanceSource: "persisted" };
}

/**
 * @param {number} tgId
 * @returns {Promise<{ ok: true, text: string } | { ok: false, text: string }>}
 */
async function formatQuantlistEntryForTelegram(tgId) {
  const pk = sanitizePlayerKey(`tg_${tgId}`);
  const exists = await walletStore.hasEconomyUserRecord(pk);
  if (!exists) {
    return { ok: false, text: `User with Telegram ID ${tgId} not found.` };
  }
  const { user: u, balanceSource } = await resolveQuantlistEconomyUser(pk);
  const meta = playerTelegramMeta.get(pk);
  const username = meta?.username ? String(meta.username).trim() : "";
  const userLine = username ? `@${username}` : "—";
  const online = isPlayerKeyOnline(pk) ? "yes" : "no";
  const tid = resolveTeamIdForPlayerKey(pk);
  const teamRow = tid ? dynamicTeams.find((t) => (t.id | 0) === (tid | 0)) : null;
  const teamName = teamRow?.name ? sanitizeTeamName(teamRow.name) : "—";
  const devUnl = isDevUnlimitedWallet(pk);
  const usdt = roundEconomyUsdt(Number(u.balanceUSDT) || 0);
  const sourceTag = balanceSource === "live" ? "live" : "persisted";
  const quantsLine = devUnl
    ? `Quants: — (dev unlimited, ${sourceTag})`
    : `Quants: ${quantsFromBalanceUsdt(usdt)} (${sourceTag})`;
  const usdtLine = devUnl ? `Balance USDT: (dev unlimited)` : `Balance USDT: ${usdt}`;
  const text = [
    quantsLine,
    `Telegram ID: ${tgId} (lookup by numeric ID only)`,
    `User: ${userLine}`,
    `Player key: ${pk}`,
    usdtLine,
    `Online: ${online}`,
    `Team: ${teamName}`,
  ].join("\n");
  return { ok: true, text };
}

/**
 * @param {number} chatId
 * @param {number} adminTelegramUid
 * @param {{ ok: true, tgIds: number[] }} parsed
 */
async function applyAdminQuantlistTelegramCommand(chatId, adminTelegramUid, parsed) {
  logAdminAction({
    command: "quantlist",
    byTelegramId: adminTelegramUid,
    queriedTelegramIds: parsed.tgIds,
  });
  const blocks = [];
  for (const tgId of parsed.tgIds) {
    const entry = await formatQuantlistEntryForTelegram(tgId);
    blocks.push(entry.text);
  }
  let msg = blocks.join("\n\n—\n\n");
  if (msg.length > 4000) msg = `${msg.slice(0, 3997)}...`;
  await telegramSendMessage(chatId, msg);
}

function broadcastTeamManualScoreBonusSync() {
  broadcast({
    type: "teamManualScoreBonusSync",
    bonuses: Object.fromEntries(teamManualScoreBonus),
  });
}

function normTeamAdminQuery(s) {
  return String(s || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

/**
 * @returns {{ kind: "one"; team: (typeof dynamicTeams)[0] } | { kind: "none" } | { kind: "many"; names: string[] }}
 */
function resolveTeamForAdminBonus(needleRaw) {
  const needle = normTeamAdminQuery(needleRaw);
  if (!needle) return { kind: "none" };
  const candidates = dynamicTeams.filter((t) => !t.solo && !t.eliminated);
  const exact = candidates.filter((t) => normTeamAdminQuery(t.name) === needle);
  if (exact.length === 1) return { kind: "one", team: exact[0] };
  if (exact.length > 1) return { kind: "many", names: exact.map((t) => t.name) };
  const partial = candidates.filter((t) => normTeamAdminQuery(t.name).includes(needle));
  if (partial.length === 1) return { kind: "one", team: partial[0] };
  if (partial.length > 1) return { kind: "many", names: partial.map((t) => t.name) };
  return { kind: "none" };
}

/**
 * @returns {{ ok: true; teamName: string; points: number } | { ok: false; error: string }}
 */
function parseTeamsTelegramAddPoints(body) {
  const m = /^([\s\S]+?)\s*\+\s*(\d+)\s*$/i.exec(String(body || "").trim());
  if (!m) {
    return {
      ok: false,
      error: "Формат: teams Имя +очки — например: teams Alpha +500 или teams \"Team Alpha\" +500",
    };
  }
  let name = m[1].trim();
  if (
    (name.startsWith('"') && name.endsWith('"') && name.length >= 2) ||
    (name.startsWith("'") && name.endsWith("'") && name.length >= 2)
  ) {
    name = name.slice(1, -1).trim();
  }
  const points = parseInt(m[2], 10);
  if (!Number.isFinite(points) || points < 1 || points > 1_000_000_000) {
    return { ok: false, error: "Число очков должно быть от 1 до 1e9." };
  }
  if (!name) return { ok: false, error: "Укажите имя команды." };
  return { ok: true, teamName: name, points };
}

/**
 * Сколько миллисекунд реального времени прошло с момента pause (для сдвига конца боя / разминки).
 * Если pauseWallStartedAt потерян (0), раньше получалось d ≈ Date.now() и roundDurationMs упиралось в 8760ч.
 */
function msElapsedSincePauseWallOrZero() {
  const start = pauseWallStartedAt | 0;
  const nowWall = Date.now();
  const MIN_START = 946684800000; /* 2000-01-01 UTC — отсекаем мусор и start=0 */
  if (!start || start > nowWall || start < MIN_START) {
    if (gamePaused) {
      console.warn(
        "[pause] unpause: invalid or missing pauseWallStartedAt; skip extending timers (start=%s)",
        start
      );
    }
    return 0;
  }
  return nowWall - start;
}

function shiftManualBattleSlotsAfterPause(d, pauseStart) {
  const ps = pauseStart | 0;
  const dd = d | 0;
  if (dd < 1 || !ps) return;
  for (const [k, u] of [...manualBattleSlotsByCmd]) {
    if (typeof u === "number" && u > ps) {
      manualBattleSlotsByCmd.set(k, u + dd);
    }
  }
}

function shiftMstimAfterPause(d, pauseStart) {
  const u = mstimAltSeasonBurstUntilMs | 0;
  const ps = pauseStart | 0;
  const dd = d | 0;
  if (dd < 1 || !ps || u <= ps) return;
  mstimAltSeasonBurstUntilMs = u + dd;
}

/**
 * @param {number} telegramUserId
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
function applyAdminPause(telegramUserId) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  if (gameFinished) return { ok: false, reason: "game_finished" };
  if (gamePaused) return { ok: false, reason: "already" };
  const wasWarmup = isWarmupPhaseNow();
  gamePaused = true;
  pauseWallStartedAt = Date.now();
  pauseCapturedWarmup = wasWarmup;
  clearPendingManualSeismicSchedule();
  if (statsBroadcastTimer != null) {
    clearTimeout(statsBroadcastTimer);
    statsBroadcastTimer = null;
  }
  if (playStartBroadcastTimer) {
    clearTimeout(playStartBroadcastTimer);
    playStartBroadcastTimer = null;
  }
  saveRoundState();
  logAdminAction({ command: "pause", byTelegramId: telegramUserId, pauseCapturedWarmup });
  broadcast({
    type: "gamePauseSync",
    paused: true,
    pauseWallStartedAt: pauseWallStartedAt | 0,
    pauseCapturedWarmup: wasWarmup,
    round0WarmupMs,
    roundDurationMs,
    warmupPauseExtensionMs,
    roundStartMs,
    roundEndsAt: roundEndsAtForMeta(),
    playStartsAt: getPlayStartMs(),
    warmupEndsAt: getPlayStartMs(),
  });
  void Promise.all(
    wss ? [...wss.clients].filter((c) => c.readyState === 1).map((c) => sendConnectionMeta(c)) : []
  );
  broadcastStatsImmediate();
  void broadcastWalletPayloadToAllClients();
  return { ok: true };
}

/**
 * @param {number} telegramUserId
 * @returns {{ ok: true } | { ok: false; reason: string }}
 */
function applyAdminUnpause(telegramUserId) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  if (!gamePaused) return { ok: false, reason: "not_paused" };
  const start = pauseWallStartedAt | 0;
  const d = msElapsedSincePauseWallOrZero();
  if (pauseCapturedWarmup) {
    if (roundIndex === 0) {
      const w = (round0WarmupMs | 0) + d;
      round0WarmupMs = Math.min(600000, Math.max(5000, w));
    } else {
      warmupPauseExtensionMs = Math.min(7 * 24 * 3600000, (warmupPauseExtensionMs | 0) + d);
    }
  } else {
    roundDurationMs = Math.min(8760 * 3600000, (roundDurationMs | 0) + d);
  }
  shiftManualBattleSlotsAfterPause(d, start);
  shiftMstimAfterPause(d, start);
  gamePaused = false;
  pauseWallStartedAt = 0;
  pauseCapturedWarmup = false;
  saveRoundState();
  logAdminAction({ command: "unpause", byTelegramId: telegramUserId, pauseDurationMs: d });
  broadcast({
    type: "gamePauseSync",
    paused: false,
    pauseWallStartedAt: 0,
    round0WarmupMs,
    roundDurationMs,
    warmupPauseExtensionMs,
    roundStartMs,
    roundEndsAt: roundEndsAtForMeta(),
    playStartsAt: getPlayStartMs(),
    warmupEndsAt: getPlayStartMs(),
  });
  broadcastTournamentTimeScaleToClients();
  broadcast({ type: "mstimAltSeasonSync", untilMs: mstimAltSeasonBurstUntilMs });
  broadcastManualBattleSyncAndStats();
  schedulePlayStartBroadcast();
  void Promise.all(
    wss ? [...wss.clients].filter((c) => c.readyState === 1).map((c) => sendConnectionMeta(c)) : []
  );
  return { ok: true };
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
  if (gamePaused) {
    safeSend(ws, { type: "playRejected", reason: "paused" });
    return false;
  }
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
  const isoNow = effectiveGameClockMs();
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
    gamePaused: !!gamePaused,
    pauseWallStartedAt: gamePaused ? pauseWallStartedAt | 0 : 0,
    lobbyBeforeGo: !!(WAIT_FOR_TELEGRAM_GO && roundIndex === 0 && !roundTimerStarted),
    eligible: !!ws.eligible,
    gameFinished: !!gameFinished,
    tournamentStage: tournamentStage(roundIndex, gameFinished),
    discussionChatUrl: getDiscussionChatUrlForClient(),
    flags: buildFlagsSnapshot(),
    tournamentTimeScale: getTournamentTimeScale(),
    territoryIsolation: buildTerritoryIsolationGroupsPayload(isoNow),
    treasureSpots: buildTreasureSpotsForMeta(),
    quantumFarms: buildQuantumFarmsClientPayload(),
  });
  try {
    safeSend(ws, await buildWalletPayload(ws));
  } catch (e) {
    console.warn("[ws] wallet on connect:", e?.message || e);
    safeSend(ws, {
      type: "wallet",
      balanceUSDT: 0,
      quantFarmIncomeQuantsPer5s: 0,
      battleEventZoneQuantsPer5s: 0,
      cooldownMs: BASE_ACTION_COOLDOWN_SEC * 1000,
      effectiveRecoverySec: BASE_ACTION_COOLDOWN_SEC,
      personalRecoveryUntil: 0,
      personalRecoverySec: BASE_ACTION_COOLDOWN_SEC,
      lastActionAt: 0,
      lastZoneCaptureAt: 0,
      lastMassCaptureAt: 0,
      lastZone12CaptureAt: 0,
      referralBonusActive: false,
      globalEvent: getGlobalEventPayload(effectiveGameClockMs()),
      tournamentStage: tournamentStage(roundIndex, gameFinished),
      roundIndex,
      devUnlimited: false,
      teamEffects: null,
    });
  }
}

/** Финал: победитель дуэли 1v1 — игра окончена. */
async function finalizeGameEnd(winnerRow) {
  roundEnding = true;
  try {
    gamePaused = false;
    pauseWallStartedAt = 0;
    pauseCapturedWarmup = false;
    warmupPauseExtensionMs = 0;
    teamManualScoreBonus.clear();
    clearPendingManualSeismicSchedule();
    const winnerTeamId = winnerRow.teamId;
    const winningTeamName = winnerRow.name || "";
    const scoreShare =
      typeof winnerRow.scoreSharePercent === "number" && Number.isFinite(winnerRow.scoreSharePercent)
        ? winnerRow.scoreSharePercent
        : typeof winnerRow.percent === "number" && Number.isFinite(winnerRow.percent)
          ? winnerRow.percent
          : 0;
    const winnerKeysSnapshot = collectWinnerTeamPlayerKeys(winnerTeamId);

    eligibleTokenSet = new Set();
    winnerTokensByPlayerKey = {};
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      client.eligible = false;
      client.eliminated = true;
      client.teamId = null;
    }

    teamMemberKeys.clear();
    synergyOnlineEpoch++;
    teamPlayerCounts.clear();
    clearAllFlagCaptureState();
    clearTerritoryIsolationState();
    pixels.clear();
    invalidateTeamScoresAggCache();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    gameFinished = true;
    mstimAltSeasonBurstUntilMs = 0;
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
    setEligibleKeysForDuelFromWinningTeam(winnerTeamId);

    void notifyTournamentStageAdvancersTelegram({
      stageTitle: "Финал команд завершён",
      stageSubtitle: "Дуэль 1×1: проходят два участника победившей команды.",
      winnerRow,
      advancingKeys: new Set(eligiblePlayerKeys),
    });

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
    synergyOnlineEpoch++;
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
    roundDurationMs = effectiveBattleDurationForRound(3);
    applyQuickTestRoundTimingToState();
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
  if (gamePaused) return;
  if (roundIndex === 0 && !roundTimerStarted) return;
  if (effectiveGameClockMs() < getRoundBattleEndRealMs()) return;
  /* Авторитетный итог: buildStatsPayload (кэш M×S + full scan при необходимости). */
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

    if (roundIndex === 0) {
      void notifyTournamentStageAdvancersTelegram({
        stageTitle: "Массовый раунд завершён",
        stageSubtitle: "Полуфинал: проходят все зафиксированные участники победившей по очкам команды.",
        winnerRow: rows[0],
        advancingKeys: new Set(eligiblePlayerKeys),
      });
    } else if (roundIndex === 1) {
      void notifyTournamentStageAdvancersTelegram({
        stageTitle: "Полуфинал завершён",
        stageSubtitle: `Финал команд: в следующий этап проходят до ${MAX_PLAYERS_ADVANCING_FROM_SEMI} участников победившей команды.`,
        winnerRow: rows[0],
        advancingKeys: new Set(eligiblePlayerKeys),
      });
    }

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
    synergyOnlineEpoch++;
    teamPlayerCounts.clear();
    clearAllFlagCaptureState();
    clearTerritoryIsolationState();
    pixels.clear();
    invalidateTeamScoresAggCache();
    clearTeamEffectsMap();
    dynamicTeams = [];
    nextTeamId = 1;
    saveDynamicTeams();

    const endedRoundIndex = roundIndex;
    roundIndex++;
    roundTimerStarted = true;
    round0WarmupMs = tournamentQuickTestMode ? QUICK_TEST_WARMUP_MS : WARMUP_MS;
    roundStartMs = Date.now();
    roundDurationMs = effectiveBattleDurationForRound(roundIndex);
    applyQuickTestRoundTimingToState();
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

/* Было 30 с — при тестовых раундах по 30 с конец этапа запаздывал почти на минуту. */
setInterval(() => maybeEndRound(), 5000);
setInterval(() => tickFlagBaseRegen(Date.now()), 500);
setInterval(() => tickBattleEvents(Date.now()), 1000);
setInterval(() => {
  if (gameFinished || gamePaused) return;
  if (REDIS_URL && !isClusterLeader()) return;
  const removed = advanceTerritoryIsolationState();
  if (!removed) return;
  const next = computeTeamTerritoryCounts();
  notifyTerritoryDramaEvents(lastTerritoryCountSnapshot, next);
  lastTerritoryCountSnapshot = new Map(next);
  scanAndEliminateTeamsWithNoTerritory(next);
  const st = buildStatsPayload();
  updateTiebreakFromStatsPayload(st);
  checkDuelWinByElimination(st);
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
  /** Первый meta после connect: только один раз и после clientProfile (иначе eligible=false для r>0 затирает корректный meta). */
  ws._handshakeMetaSent = false;

  /**
   * Тяжёлый full + stats по всем пикселям на одном тике блокирует event loop (десятки мс–секунды)
   * и даёт таймаут 502/500 на прокси при всплеске переподключений — уводим в следующие тики.
   * meta ждём из clientProfile; иначе fallback через несколько секунд (старые клиенты без profile).
   */
  void (async () => {
    const deadline = Date.now() + 4000;
    while (ws.readyState === 1 && !ws._handshakeMetaSent && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 25));
    }
    if (ws.readyState !== 1) return;
    if (!ws._handshakeMetaSent) {
      try {
        await sendConnectionMeta(ws);
      } catch (e) {
        console.warn("[ws] sendConnectionMeta (fallback):", e?.message || e);
      }
      ws._handshakeMetaSent = true;
    }
    await new Promise((r) => setImmediate(r));
    if (ws.readyState !== 1) return;
    try {
      safeSend(ws, fullPayloadObject());
    } catch (e) {
      console.warn("[ws] full payload:", e?.message || e);
    }
    await new Promise((r) => setImmediate(r));
    if (ws.readyState !== 1) return;
    try {
      /* Не broadcastStatsImmediate(): волна входов заставляла бы пересчёт stats и рассылку всем при каждом connect. */
      safeSend(ws, buildStatsPayload());
    } catch (e) {
      console.warn("[ws] stats on connect:", e?.message || e);
    }
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
      try {
        await sendConnectionMeta(ws);
        ws._handshakeMetaSent = true;
      } catch (e) {
        console.warn("[ws] sendConnectionMeta:", e?.message || e);
      }
      try {
        safeSend(ws, await buildWalletPayload(ws));
      } catch (e) {
        console.warn("[ws] wallet on clientProfile:", e?.message || e);
      }
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
      /* Раунд 3 (дуэль): своя команда из одного человека — joinTeam по-прежнему запрещён. */
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
        createdByPlayerKey: pkForColor || "",
        militaryOutposts: [],
        lastMilitaryBaseAt: 0,
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
      if (gamePaused) {
        safeSend(ws, { type: "leaveError", reason: "paused" });
        return;
      }
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
      if (!tryDeleteTeamWithNoMembers(tid)) {
        broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      }
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
      if (!stageAllowsRecoveryPurchases(st)) {
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
      safeSend(ws, { type: "purchaseOk", kind: "personalRecovery", tierSec: tier });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({
        type: "purchaseVfx",
        kind: "personalRecovery",
        teamId: ws.teamId | 0,
        tierSec: tier,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
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
      const tr = await claimTreasuresInPlannedCells(pk, connected);
      /* lastActionAt не трогаем — интервал между обычными пикселями идёт отдельно от зоны 4×4. */
      u.lastZoneCaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "zone_capture_4x4", { deferSave: true });
      scheduleStatsBroadcast();
      safeSend(ws, { type: "purchaseOk", kind: "zoneCapture", cells: connected.length, size: 4 });
      safeSend(ws, await buildWalletPayload(ws));
      if (tr.total > 0 && tr.first) {
        safeSend(ws, { type: "treasureFound", quant: tr.total, x: tr.first.x, y: tr.first.y });
      }
      broadcast({
        type: "purchaseVfx",
        kind: "zoneCapture",
        teamId: tid,
        gx: r.x0,
        gy: r.y0,
        size: 4,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
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
      const tr = await claimTreasuresInPlannedCells(pk, connected);
      /* lastActionAt не трогаем — интервал между обычными пикселями идёт отдельно от масс-захвата 6×6. */
      u.lastMassCaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "mass_capture_6x6", { deferSave: true });
      scheduleStatsBroadcast();
      safeSend(ws, { type: "purchaseOk", kind: "massCapture", cells: connected.length, size: 6 });
      safeSend(ws, await buildWalletPayload(ws));
      if (tr.total > 0 && tr.first) {
        safeSend(ws, { type: "treasureFound", quant: tr.total, x: tr.first.x, y: tr.first.y });
      }
      broadcast({
        type: "purchaseVfx",
        kind: "massCapture",
        teamId: tid,
        gx: cx - 2,
        gy: cy - 2,
        size: 6,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
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
      const tr = await claimTreasuresInPlannedCells(pk, connected);
      u.lastZone12CaptureAt = now;
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "zone_capture_12x12", { deferSave: true });
      scheduleStatsBroadcast();
      safeSend(ws, { type: "purchaseOk", kind: "zone12Capture", cells: connected.length, size: 12 });
      safeSend(ws, await buildWalletPayload(ws));
      if (tr.total > 0 && tr.first) {
        safeSend(ws, { type: "treasureFound", quant: tr.total, x: tr.first.x, y: tr.first.y });
      }
      broadcast({
        type: "purchaseVfx",
        kind: "zone12Capture",
        teamId: tid,
        gx: cx - 5,
        gy: cy - 5,
        size: 12,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
      return;
    }

    if (msg.type === "purchaseNukeBomb") {
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
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) {
        safeSend(ws, { type: "purchaseError", reason: "out_of_bounds" });
        return;
      }
      if (!cellAllowsPixelPlacement(cx, cy)) {
        safeSend(ws, { type: "purchaseError", reason: "water" });
        return;
      }
      const protectedMask = buildBattleProtectedMask();
      const blast = computeNukeBombBlastCells(
        cx,
        cy,
        roundIndex,
        gridW,
        gridH,
        cellAllowsPixelPlacement,
        () => false
      );
      if (blast.length === 0) {
        safeSend(ws, { type: "purchaseError", reason: "nuke_no_effect" });
        return;
      }
      const nowNuke = Date.now();
      const aidNuke = ws.teamId | 0;
      /** Клетки, которые станут нейтральными (удаление). Стены: −1 HP за бомбу; при 0 HP — сюда же. */
      /** @type {[number, number][]} */
      const deleteTargets = [];
      /** @type {{ x: number, y: number, nextHp: number, pEx: ReturnType<typeof normalizePixel> }[]} */
      const nukeWallChips = [];
      for (let i = 0; i < blast.length; i++) {
        const x = blast[i][0];
        const y = blast[i][1];
        if (protectedMask[y * gridW + x]) continue;
        const key = `${x},${y}`;
        const v = pixels.get(key);
        if (v == null) continue;
        if ((pixelTeam(v) | 0) === 0) continue;
        if ((pixelTeam(v) | 0) === aidNuke) continue;
        const wh = pixelWallHp(v);
        if (wh > 0) {
          const pEx = normalizePixel(v);
          const nextHp = wh - 1;
          if (nextHp > 0) {
            nukeWallChips.push({ x: x | 0, y: y | 0, nextHp, pEx });
          } else {
            deleteTargets.push([x | 0, y | 0]);
          }
        } else {
          deleteTargets.push([x | 0, y | 0]);
        }
      }
      let nukeDidFlagDamage = false;
      for (const t of dynamicTeams) {
        if (t.solo || t.eliminated) continue;
        if (typeof t.spawnX0 !== "number" || typeof t.spawnY0 !== "number") continue;
        const did = t.id | 0;
        if (did === aidNuke) continue;
        const sx0 = t.spawnX0 | 0;
        const sy0 = t.spawnY0 | 0;
        let spawnInBlast = false;
        for (let j = 0; j < blast.length; j++) {
          const bx = blast[j][0];
          const by = blast[j][1];
          if (bx >= sx0 && bx < sx0 + TEAM_SPAWN_SIZE && by >= sy0 && by < sy0 + TEAM_SPAWN_SIZE) {
            spawnInBlast = true;
            break;
          }
        }
        if (!spawnInBlast) continue;
        const fc = flagCellFromSpawn(sx0, sy0);
        const fr = tryFlagCaptureHit(aidNuke, fc.x, fc.y, nowNuke, { skipAdjacency: true, skipRateLimit: true });
        if (fr && !fr.rateLimited && (fr.hit || fr.captured)) nukeDidFlagDamage = true;
      }
      for (const t of dynamicTeams) {
        if (t.solo || t.eliminated) continue;
        const did = t.id | 0;
        if (did === aidNuke) continue;
        for (const o of getTeamMilitaryOutposts(t)) {
          const sx0 = o.x0 | 0;
          const sy0 = o.y0 | 0;
          let moInBlast = false;
          for (let j = 0; j < blast.length; j++) {
            const bx = blast[j][0];
            const by = blast[j][1];
            if (bx >= sx0 && bx < sx0 + TEAM_SPAWN_SIZE && by >= sy0 && by < sy0 + TEAM_SPAWN_SIZE) {
              moInBlast = true;
              break;
            }
          }
          if (!moInBlast) continue;
          const fc = flagCellFromSpawn(sx0, sy0);
          const fr = tryFlagCaptureHit(aidNuke, fc.x, fc.y, nowNuke, { skipAdjacency: true, skipRateLimit: true });
          if (fr && !fr.rateLimited && (fr.hit || fr.captured)) nukeDidFlagDamage = true;
        }
      }
      if (deleteTargets.length === 0 && nukeWallChips.length === 0 && !nukeDidFlagDamage) {
        safeSend(ws, { type: "purchaseError", reason: "nuke_no_effect" });
        return;
      }
      const priceQuant = PRICES_QUANT.nukeBomb;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      for (let i = 0; i < nukeWallChips.length; i++) {
        const w = nukeWallChips[i];
        const xi = w.x | 0;
        const yi = w.y | 0;
        const wkey = `${xi},${yi}`;
        const prev = pixels.get(wkey);
        if (!prev) continue;
        const nextRec = {
          teamId: w.pEx.teamId,
          ownerPlayerKey: w.pEx.ownerPlayerKey,
          shieldedUntil: w.pEx.shieldedUntil,
          wallHp: w.nextHp,
        };
        pixels.set(wkey, nextRec);
        tryApplyIncrementalTeamScoreForPixel(xi, yi, prev, nextRec);
        queuePixelBroadcast(xi, yi, w.pEx.teamId, w.pEx.ownerPlayerKey, w.pEx.shieldedUntil, w.nextHp);
        broadcast({
          type: "purchaseVfx",
          kind: "greatWallHit",
          gx: xi,
          gy: yi,
          wallHp: w.nextHp,
          defenderTeamId: w.pEx.teamId | 0,
        });
      }
      for (let i = 0; i < deleteTargets.length; i++) {
        pixels.delete(`${deleteTargets[i][0]},${deleteTargets[i][1]}`);
      }
      invalidateTeamScoresAggCache();
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "nuke_bomb", { deferSave: true });
      afterTerritoryMutation();
      scheduleStatsBroadcast();
      safeSend(ws, { type: "purchaseOk", kind: "nukeBomb", cells: deleteTargets.length, x: cx, y: cy });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({
        type: "purchaseVfx",
        kind: "nukeBomb",
        teamId: ws.teamId | 0,
        gx: cx,
        gy: cy,
        size: 14,
        cellsCleared: deleteTargets.length,
        cellsSample: deleteTargets.slice(0, 120),
      });
      broadcast({
        type: "nukeBombImpact",
        cx,
        cy,
        cells: deleteTargets,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
      return;
    }

    if (msg.type === "purchaseMilitaryBase") {
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
      const tid = ws.teamId | 0;
      const dt = dynamicTeams.find((t) => !t.solo && !t.eliminated && (t.id | 0) === tid);
      if (!dt) {
        safeSend(ws, { type: "purchaseError", reason: "no_team" });
        return;
      }
      const now = Date.now();
      const lastMb = Number(dt.lastMilitaryBaseAt) | 0;
      if (lastMb > 0 && now - lastMb < MILITARY_BASE_COOLDOWN_MS) {
        safeSend(ws, { type: "purchaseError", reason: "military_cooldown" });
        return;
      }
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      const x0 = cx - 2;
      const y0 = cy - 2;
      const val = validateMilitaryBasePlacement(tid, x0, y0);
      if (!val.ok) {
        safeSend(ws, { type: "purchaseError", reason: val.reason || "military_invalid" });
        return;
      }
      const priceQuant = PRICES_QUANT.militaryBase;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      if (!Array.isArray(dt.militaryOutposts)) dt.militaryOutposts = [];
      dt.militaryOutposts.push({ x0, y0 });
      dt.lastMilitaryBaseAt = now;
      saveDynamicTeams();
      if (!devUnl) await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "military_base", { deferSave: true });
      /* Сначала meta с плацдармом — иначе клиенты получают пиксели 6×6 раньше teamsFull и отклоняют ходы как «не рядом». */
      broadcast({ type: "teamsFull", teams: teamsForMeta() });
      paintTeamSpawnArea(tid, x0, y0, pk);
      scheduleStatsBroadcast();
      safeSend(ws, {
        type: "purchaseOk",
        kind: "militaryBase",
        x0,
        y0,
        size: TEAM_SPAWN_SIZE,
        total: getTeamMilitaryOutposts(dt).length,
      });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({
        type: "purchaseVfx",
        kind: "militaryBase",
        teamId: tid,
        gx: x0,
        gy: y0,
        size: TEAM_SPAWN_SIZE,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
      return;
    }

    if (msg.type === "purchaseGreatWall") {
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
      if (isWarmupPhaseNow()) {
        safeSend(ws, { type: "purchaseError", reason: "warmup" });
        return;
      }
      const tid = ws.teamId | 0;
      const cx = msg.x | 0;
      const cy = msg.y | 0;
      if (cx < 0 || cx >= gridW || cy < 0 || cy >= gridH) {
        safeSend(ws, { type: "purchaseError", reason: "out_of_bounds" });
        return;
      }
      if (!cellAllowsPixelPlacement(cx, cy)) {
        safeSend(ws, { type: "purchaseError", reason: "water" });
        return;
      }
      if (resolveFlagBaseAtCell(cx, cy)) {
        safeSend(ws, { type: "purchaseError", reason: "wall_flag_cell" });
        return;
      }
      const wkey = `${cx},${cy}`;
      const cell = pixels.get(wkey);
      if (!cell || pixelTeam(cell) !== tid) {
        safeSend(ws, { type: "purchaseError", reason: "wall_not_yours" });
        return;
      }
      if (pixelWallHp(cell) > 0) {
        safeSend(ws, { type: "purchaseError", reason: "wall_already" });
        return;
      }
      const priceQuant = PRICES_QUANT.greatWall;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      if (!devUnl) {
        await walletStore.recordSpend(pk, quantToUsdt(priceQuant), "great_wall", { deferSave: true });
      }
      const p0 = normalizePixel(cell);
      const nextRec = {
        teamId: tid,
        ownerPlayerKey: pk,
        shieldedUntil: p0.shieldedUntil,
        wallHp: GREAT_WALL_MAX_HP,
      };
      pixels.set(wkey, nextRec);
      tryApplyIncrementalTeamScoreForPixel(cx, cy, cell, nextRec);
      queuePixelBroadcast(cx, cy, tid, pk, p0.shieldedUntil, GREAT_WALL_MAX_HP);
      scheduleStatsBroadcast();
      afterTerritoryMutation();
      safeSend(ws, { type: "purchaseOk", kind: "greatWall", x: cx, y: cy });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({
        type: "purchaseVfx",
        kind: "greatWallBuilt",
        teamId: tid,
        gx: cx,
        gy: cy,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
      return;
    }

    if (msg.type === "purchaseQuantumFarmUpgrade") {
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
      if (isWarmupPhaseNow()) {
        safeSend(ws, { type: "purchaseError", reason: "warmup" });
        return;
      }
      const tid = ws.teamId | 0;
      const farmId = msg.farmId | 0;
      if (!farmId || !quantumFarmLayouts.length) {
        safeSend(ws, { type: "purchaseError", reason: "bad request" });
        return;
      }
      let idx = -1;
      for (let i = 0; i < quantumFarmLayouts.length; i++) {
        if ((quantumFarmLayouts[i].id | 0) === farmId) {
          idx = i;
          break;
        }
      }
      if (idx < 0) {
        safeSend(ws, { type: "purchaseError", reason: "bad request" });
        return;
      }
      const owners = computeQuantumFarmOwnersNow();
      if ((owners[idx] | 0) !== tid) {
        safeSend(ws, { type: "purchaseError", reason: "quantum_farm_not_controlled" });
        return;
      }
      const curLv = normalizeQuantumFarmLevel(quantumFarmLevels[idx]);
      if (curLv >= QUANTUM_FARM_MAX_LEVEL) {
        safeSend(ws, { type: "purchaseError", reason: "quantum_farm_max_level" });
        return;
      }
      const priceQuant = curLv === 1 ? PRICES_QUANT.quantumFarmTo2 : PRICES_QUANT.quantumFarmTo3;
      const spend = await walletStore.trySpendQuant(pk, priceQuant, { devUnlimited: devUnl, deferSave: true });
      if (!spend.ok) {
        safeSend(ws, { type: "purchaseError", reason: "not enough balance" });
        return;
      }
      if (!devUnl) {
        await walletStore.recordSpend(pk, quantToUsdt(priceQuant), `quantum_farm_L${curLv + 1}`, { deferSave: true });
      }
      quantumFarmLevels[idx] = curLv + 1;
      saveRoundState();
      safeSend(ws, {
        type: "purchaseOk",
        kind: "quantumFarmUpgrade",
        farmId,
        level: quantumFarmLevels[idx],
      });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({ type: "quantumFarmsInit", farms: buildQuantumFarmsClientPayload() });
      broadcast({
        type: "purchaseVfx",
        kind: "quantumFarmUpgrade",
        teamId: tid,
        farmId,
        level: quantumFarmLevels[idx],
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
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
      if (!stageAllowsRecoveryPurchases(st)) {
        safeSend(ws, { type: "purchaseError", reason: "not available" });
        return;
      }
      const tier = [10, 5, 2, 1].includes(msg.tierSec | 0) ? msg.tierSec | 0 : 0;
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
      safeSend(ws, { type: "purchaseOk", kind: "teamRecovery", tierSec: tier });
      safeSend(ws, await buildWalletPayload(ws));
      broadcast({
        type: "teamEffect",
        teamId: tid,
        kind: "teamRecovery",
        until: fx.teamRecoveryUntil,
        teamRecoverySec: fx.teamRecoverySec,
      });
      scheduleBroadcastWalletDebounced();
      queuePersistWalletPurchaseWrites(pk);
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
      const cd = effectivePixelCooldownMs(u, teamFxPayload, st, now);
      if (now < u.lastActionAt + cd) {
        if (DEBUG_MSTIM_COOLDOWN) {
          const mA = isMstimAltSeasonBurstActive();
          console.log(
            `[mstim] pixel cooldown reject pk=${String(pk).slice(0, 16)} cd=${cd} needWait=${u.lastActionAt + cd - now}ms mstimUntil=${mstimAltSeasonBurstUntilMs} active=${mA}`
          );
        }
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "cooldown not ready" });
        safeSend(ws, { type: "pixelReject", reason: "cooldown not ready" });
        return;
      }

      const fc = tryFlagCaptureHit(teamId, x, y, now);
      if (fc && fc.rateLimited) {
        safeSend(ws, { type: "pixelReject", reason: "flag_rate" });
        return;
      }
      if (fc && (fc.hit || fc.captured)) {
        u.lastActionAt = now;
        scheduleEconomyFlushForPlayer(pk);
        if (!fc.captured) {
          scheduleStatsBroadcast();
        }
        safeSend(ws, await buildWalletPayload(ws));
        if (fc.hit && typeof fc.hp === "number") {
          safeSend(ws, {
            type: "flagHitAck",
            defenderTeamId: fc.defenderTeamId | 0,
            hp: fc.hp | 0,
            maxHp: (fc.maxHp ?? (fc.militaryAnchor ? FLAG_BASE_MAX_HP : FLAG_MAIN_BASE_MAX_HP)) | 0,
            ...(fc.militaryAnchor ? { militaryAnchor: fc.militaryAnchor } : {}),
          });
        }
        return;
      }

      if (!enemyFlagDef) {
        const wallRes = tryApplyGreatWallSiegeHit(x, y, teamId, pk);
        if (wallRes.handled) {
          u.lastActionAt = now;
          scheduleEconomyFlushForPlayer(pk);
          scheduleStatsBroadcast();
          afterTerritoryMutation();
          safeSend(ws, await buildWalletPayload(ws));
          if (wallRes.wallBroken) {
            const foundTreasureQuant = await tryClaimMapTreasureForPlayer(pk, key, false);
            if (foundTreasureQuant > 0) {
              safeSend(ws, { type: "treasureFound", quant: foundTreasureQuant, x, y });
            }
          }
          return;
        }
      }

      if (enemyFlagDef) {
        safeSend(ws, { type: "invalidPlacement", teamId, reason: "enemy_base" });
        safeSend(ws, { type: "pixelReject", reason: "enemy_base" });
        return;
      }

      u.lastActionAt = now;
      scheduleEconomyFlushForPlayer(pk);

      /* Обычная покраска: не якорь чужой базы (это только tryFlagCaptureHit / executeFlagCaptureSuccess). */
      const rec = { teamId, ownerPlayerKey: pk, shieldedUntil: 0 };
      const prevCell = pixels.get(key);
      pixels.set(key, rec);
      tryApplyIncrementalTeamScoreForPixel(x, y, prevCell, rec);
      queuePixelBroadcast(x, y, teamId, pk, 0, 0);
      scheduleStatsBroadcast();
      afterTerritoryMutation();

      const foundTreasureQuant = await tryClaimMapTreasureForPlayer(pk, key, false);

      safeSend(ws, await buildWalletPayload(ws));
      if (foundTreasureQuant > 0) {
        safeSend(ws, { type: "treasureFound", quant: foundTreasureQuant, x, y });
      }
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
      if (ws.playerKey) removeTeamMemberKey(tid, ws.playerKey);
      const c = teamPlayerCounts.get(tid) ?? 0;
      teamPlayerCounts.set(tid, Math.max(0, c - 1));
      if (!tryDeleteTeamWithNoMembers(tid)) {
        broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
      }
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
 * @param {Iterable<string>} playerKeys
 * @returns {Promise<string[]>}
 */
async function formatPlayerKeyTelegramLines(playerKeys) {
  const lines = [];
  let n = 0;
  for (const pkRaw of playerKeys) {
    const pk = sanitizePlayerKey(pkRaw);
    if (!pk) continue;
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
      lines.push(`${n}. не из Telegram Mini App (playerKey: ${pk.slice(0, 48)}…)`);
    }
  }
  return lines;
}

async function sendTelegramMessageToAdmins(fullText) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_ADMIN_IDS.size === 0) return;
  const hardLimit = 3900;
  let remaining = String(fullText || "").replace(/\r\n/g, "\n").trim();
  const chunks = [];
  while (remaining.length > 0) {
    if (remaining.length <= hardLimit) {
      chunks.push(remaining);
      break;
    }
    let cut = remaining.lastIndexOf("\n\n", hardLimit);
    if (cut < hardLimit * 0.35) cut = remaining.lastIndexOf("\n", hardLimit);
    if (cut < hardLimit * 0.35) cut = hardLimit;
    const piece = remaining.slice(0, cut).trimEnd();
    if (!piece) {
      chunks.push(remaining.slice(0, hardLimit));
      remaining = remaining.slice(hardLimit).trimStart();
      continue;
    }
    chunks.push(piece);
    remaining = remaining.slice(cut).trimStart();
  }
  for (const text of chunks) {
    if (!text) continue;
    const safe = text.slice(0, 4000);
    for (const adminId of TELEGRAM_ADMIN_IDS) {
      try {
        await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: adminId, text: safe }),
        });
      } catch (e) {
        console.warn("sendTelegramMessageToAdmins:", e.message || e);
      }
    }
  }
}

/**
 * После смены раунда: кто проходит дальше (username + Telegram ID).
 * @param {{ stageTitle: string, stageSubtitle?: string, winnerRow: object, advancingKeys: Iterable<string> }} opts
 */
async function notifyTournamentStageAdvancersTelegram(opts) {
  const { stageTitle, stageSubtitle, winnerRow, advancingKeys } = opts;
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_ADMIN_IDS.size === 0) return;
  const lines = await formatPlayerKeyTelegramLines(advancingKeys);
  const teamName = winnerRow?.name || "—";
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
  const sub = stageSubtitle ? `${stageSubtitle}\n` : "";
  const body =
    `${stageTitle}\n` +
    `${sub}` +
    `Команда-лидер по очкам: «${teamName}» — счёт ${sc} оч., доля доступных очков ${shareStr}%\n` +
    `Игроки, проходящие дальше (${lines.length}):\n\n` +
    (lines.length
      ? lines.join("\n\n")
      : "(не удалось сопоставить playerKey — участники должны заходить из Telegram Mini App.)");
  await sendTelegramMessageToAdmins(body);
}

/**
 * Уведомляет админов (TELEGRAM_ADMIN_IDS) о победителях дуэли: username и Telegram ID.
 */
async function notifyFinalWinnersTelegram(winnerPlayerKeys, teamName, winnerRow) {
  if (!TELEGRAM_BOT_TOKEN || TELEGRAM_ADMIN_IDS.size === 0) return;
  const lines = await formatPlayerKeyTelegramLines(winnerPlayerKeys);
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
  const sz = winnerPlayerKeys instanceof Set ? winnerPlayerKeys.size : [...winnerPlayerKeys].length;
  const body =
    `Финал Pixel Battle (дуэль 1×1)\n` +
    `Победители: «${teamName}» — счёт ${sc} оч., доля доступных очков ${shareStr}%\n` +
    `Игроки команды-победителя (Telegram / playerKey), найдено: ${sz}\n\n` +
    (lines.length
      ? lines.join("\n\n")
      : "(не удалось сопоставить playerKey — проверьте, что финалисты заходили из Telegram Mini App)");
  await sendTelegramMessageToAdmins(body);
}

/**
 * @param {number} [durationHours] положительное число часов (0.01 = 36 с); без аргумента — 100 ч
 */
async function startRoundOneTimer(durationHours) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  if (gameFinished) return { ok: false, reason: "game_finished" };
  if (roundIndex !== 0) return { ok: false, reason: "not_round_first" };
  if (roundTimerStarted) return { ok: false, reason: "already_started" };
  let ms = effectiveBattleDurationForRound(0);
  if (!tournamentQuickTestMode && typeof durationHours === "number" && Number.isFinite(durationHours) && durationHours > 0) {
    ms = Math.round(durationHours * 60 * 60 * 1000);
    ms = Math.min(Math.max(ms, 1000), 8760 * 60 * 60 * 1000);
  }
  if (tournamentQuickTestMode) ms = QUICK_TEST_ROUND_BATTLE_MS;
  roundDurationMs = ms;
  round0WarmupMs = tournamentQuickTestMode ? QUICK_TEST_WARMUP_MS : ROUND_ZERO_POST_GO_WARMUP_MS;
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
  return {
    ok: true,
    durationMs: ms,
    warmupMs: tournamentQuickTestMode ? QUICK_TEST_WARMUP_MS : ROUND_ZERO_POST_GO_WARMUP_MS,
  };
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
    return false;
  }
  if (!data.ok) {
    console.warn("Telegram sendMessage:", data.description || res.status);
    return false;
  }
  return true;
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
  invalidateTeamScoresAggCache();
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
  broadcast(fullPayloadObject());
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
 * Сообщения: evt gold, gold, gold 45 (минут, иначе 20 мин по умолчанию), gold off, evt off (в т.ч. speed / «Мстим»), seismic, evt help.
 */
async function handleTelegramManualBattleCommand(chatId, lineRaw) {
  if (!isClusterLeader()) {
    await telegramSendMessage(
      chatId,
      "Ручные события выполняет только лидер кластера (на вторичных инстансах задано CLUSTER_LEADER=false)."
    );
    return;
  }
  if (gamePaused) {
    await telegramSendMessage(chatId, "Игра на паузе — события карты (evt / seismic) недоступны до unpause.");
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
    clearPendingManualSeismicSchedule();
    manualBattleSlotsByCmd.clear();
    mstimAltSeasonBurstUntilMs = 0;
    saveRoundState();
    broadcast({ type: "mstimAltSeasonSync", untilMs: 0 });
    broadcast({ type: "roundEvent", phase: "end", roundIndex });
    broadcastManualBattleSyncAndStats();
    void broadcastWalletPayloadToAllClients();
    await telegramSendMessage(
      chatId,
      "Все ручные события сняты. Режим «Мстим за Альт Сезон» (speed), если был включён, тоже выключен."
    );
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
    const res = scheduleManualSeismicFromBot(seed, seed);
    if (!res.ok) {
      await telegramSendMessage(
        chatId,
        "Сейсмика: в зонах удара нет закрашенных клеток (или карта уже пустая в этих шарах)."
      );
      return;
    }
    await telegramSendMessage(
      chatId,
      `Сейсмика: предупреждение игрокам ${MANUAL_SEISMIC_WARNING_MS / 1000} с, затем очистка клеток по шарам Манхэттена.`
    );
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
  let until = Math.min(now + MANUAL_BATTLE_EVENT_DEFAULT_DURATION_MS, battleEnd);
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
  const eventIdForClient = `${def.eventId}_${until}`;
  broadcast({
    type: "roundEvent",
    phase: "start",
    eventId: eventIdForClient,
    eventType: def.eventType,
    title: def.uiTitle,
    subtitle: def.uiSubtitle,
    untilMs: until,
    roundIndex,
  });
  const leftMin = Math.max(1, Math.round((until - now) / 60000));
  await telegramSendMessage(
    chatId,
    `OK: «${cmd0}» активно ~${leftMin} мин (до ${new Date(until).toLocaleString("ru-RU")} или конца боя).`
  );
}

/**
 * Сброс «только карта и очки», команды сохраняются. Из Telegram бота не вызывается — в UI один полный сброс.
 * Оставлено для возможного ручного/сервисного вызова.
 * @param {number} telegramUserId
 * @returns {Promise<{ ok: true } | { ok: false; reason: string }>}
 */
async function applyAdminTrainingScoreReset(telegramUserId) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  logAdminAction({ command: "reset_training_scores", byTelegramId: telegramUserId });

  teamManualScoreBonus.clear();
  clearPendingManualSeismicSchedule();
  manualBattleSlotsByCmd.clear();
  mstimAltSeasonBurstUntilMs = 0;
  clearTerritoryIsolationState();

  resetMassRoundBattlefieldAfterWarmup();
  regenerateMapTreasures();
  saveRoundState();

  broadcastTerritoryIsolationSyncIfChanged(Date.now());
  broadcast({ type: "mstimAltSeasonSync", untilMs: 0 });
  broadcast({ type: "roundEvent", phase: "end", roundIndex });
  broadcastTeamManualScoreBonusSync();
  broadcast({ type: "manualBattleSync", slots: {} });
  broadcast({ type: "globalEvent", globalEvent: getGlobalEventPayload(Date.now()) });
  scheduleStatsBroadcast();

  try {
    if (typeof walletStore.adminResetAllTrainingEconomy === "function") {
      await walletStore.adminResetAllTrainingEconomy();
    }
  } catch (e) {
    console.warn("[admin] wallet reset training:", e?.message || e);
    return { ok: false, reason: "wallet_reset_failed" };
  }

  await broadcastWalletPayloadToAllClients();
  if (wss) {
    await Promise.all(
      [...wss.clients].filter((c) => c.readyState === 1).map((c) => sendConnectionMeta(c))
    );
  }
  return { ok: true };
}

/**
 * Полный «как новая игра»: не частичный сброс — всё игровое состояние с нуля.
 * Удаляются команды (dynamic-teams.json), пиксели, раунд/таймеры/пауза/roundEnding, изоляция, флаги баз,
 * ручные очки, evt/slots, tiebreak, квантовые фермы пересчитываются, клады заново, round-state.json и снимок карты.
 * Экономика тренировки: adminResetTrainingEconomyKeepBalances (кулдауны/поля сбрасываются, кванты сохраняются). Список подписчиков бота не трогаем.
 * Закрытие мини-приложения сервер не чистит — только эта команда.
 * @param {number} telegramUserId
 * @returns {Promise<{ ok: true } | { ok: false; reason: string }>}
 */
async function applyAdminFullNewGameReset(telegramUserId) {
  if (!isClusterLeader()) return { ok: false, reason: "not_leader" };
  logAdminAction({ command: "full_new_game_reset", byTelegramId: telegramUserId });

  clearAllFlagCaptureState();
  lastTerritoryCountSnapshot = new Map();
  roundEnding = false;

  if (statsBroadcastTimer != null) {
    clearTimeout(statsBroadcastTimer);
    statsBroadcastTimer = null;
  }
  if (playStartBroadcastTimer) {
    clearTimeout(playStartBroadcastTimer);
    playStartBroadcastTimer = null;
  }
  if (pixelsSnapshotDebounceTimer) {
    clearTimeout(pixelsSnapshotDebounceTimer);
    pixelsSnapshotDebounceTimer = null;
  }

  battleSnapCacheKey = "";
  battleSnapCacheSnap = null;
  battleClientPayloadCacheKey = "";
  battleClientPayloadCache = null;
  synergyMultCacheKey = "";
  synergyMultCacheVal = null;
  quantumFarmIncomeTickSeq = 0;
  teamScoreStatsEpoch++;

  gamePaused = false;
  pauseWallStartedAt = 0;
  pauseCapturedWarmup = false;
  warmupPauseExtensionMs = 0;

  teamManualScoreBonus.clear();
  clearPendingManualSeismicSchedule();
  manualBattleSlotsByCmd.clear();
  mstimAltSeasonBurstUntilMs = 0;
  clearTerritoryIsolationState();

  dynamicTeams = [];
  nextTeamId = 1;
  saveDynamicTeams();

  teamMemberKeys.clear();
  synergyOnlineEpoch++;
  teamPlayerCounts.clear();
  clearTeamEffectsMap();
  pixels.clear();
  invalidateTeamScoresAggCache();

  roundIndex = 0;
  gameFinished = false;
  roundTimerStarted = !WAIT_FOR_TELEGRAM_GO;
  roundStartMs = Date.now();
  playStartMs = roundStartMs;
  round0WarmupMs = tournamentQuickTestMode ? QUICK_TEST_WARMUP_MS : WARMUP_MS;
  roundDurationMs = effectiveBattleDurationForRound(0);
  applyQuickTestRoundTimingToState();
  eligibleTokenSet = new Set();
  eligiblePlayerKeys = new Set();
  winnerTokensByPlayerKey = {};
  battleEventsApplied = {};
  pendingTreasureRestore = null;

  clearTiebreakSnapshots();
  resetBattleEventsStateForNewBattleRound();

  if (wss) {
    for (const c of wss.clients) {
      if (c.readyState !== 1) continue;
      c.teamId = null;
      if (typeof c.eliminated === "boolean") c.eliminated = false;
      applyEligibilityFromServerState(c);
    }
  }

  rebuildLandFromRound(0);
  saveRoundState();

  broadcastTerritoryIsolationSyncIfChanged(Date.now());
  broadcast({ type: "mstimAltSeasonSync", untilMs: 0 });
  broadcast({ type: "roundEvent", phase: "end", roundIndex });
  broadcastTeamManualScoreBonusSync();
  broadcast({ type: "manualBattleSync", slots: {} });
  broadcast({ type: "globalEvent", globalEvent: getGlobalEventPayload(Date.now()) });
  broadcast({
    type: "gamePauseSync",
    paused: false,
    pauseWallStartedAt: 0,
    round0WarmupMs,
    roundDurationMs,
    warmupPauseExtensionMs,
    roundStartMs,
    roundEndsAt: roundEndsAtForMeta(),
    playStartsAt: getPlayStartMs(),
    warmupEndsAt: getPlayStartMs(),
  });
  broadcastTournamentTimeScaleToClients();
  broadcast(fullPayloadObject());
  broadcast({ type: "teamsFull", teams: teamsForMeta() });
  broadcast({ type: "counts", teamCounts: Object.fromEntries(teamPlayerCounts) });
  broadcastStatsImmediate();
  scheduleStatsBroadcast();
  schedulePlayStartBroadcast();

  try {
    if (typeof walletStore.adminResetTrainingEconomyKeepBalances === "function") {
      await walletStore.adminResetTrainingEconomyKeepBalances();
    }
  } catch (e) {
    console.warn("[admin] wallet reset full new game:", e?.message || e);
    return { ok: false, reason: "wallet_reset_failed" };
  }

  await broadcastWalletPayloadToAllClients();
  if (wss) {
    await Promise.all(
      [...wss.clients].filter((c) => c.readyState === 1).map((c) => sendConnectionMeta(c))
    );
  }
  /* Сразу записать пустую карту в файл — не ждать debounce, чтобы после рестарта не подтянулся старый снимок. */
  try {
    if (shouldPersistPixelsSnapshot()) {
      pixelsSnapshotWriteInFlight = false;
      await writePixelsSnapshotFileAsync();
    }
  } catch (e) {
    console.warn("[full-reset] pixels snapshot flush:", e?.message || e);
  }
  schedulePixelsSnapshotSave();
  return { ok: true };
}

/**
 * @param {string} callbackQueryId
 * @param {{ text?: string; show_alert?: boolean }} [opts]
 */
async function telegramAnswerCallbackQuery(callbackQueryId, opts = {}) {
  if (!TELEGRAM_BOT_TOKEN || !callbackQueryId) return;
  const body = {
    callback_query_id: callbackQueryId,
    text: opts.text != null ? String(opts.text).slice(0, 200) : undefined,
    show_alert: !!opts.show_alert,
  };
  try {
    const res = await fetch(`https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/answerCallbackQuery`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const d = await res.json().catch(() => ({}));
      console.warn("Telegram answerCallbackQuery:", d.description || res.status);
    }
  } catch (e) {
    console.warn("Telegram answerCallbackQuery:", e?.message || e);
  }
}

/**
 * Одно подтверждение для полного сброса (кнопка в /start и текст «новая игра»).
 * @param {number | string} chatId
 */
async function telegramSendFullGameResetConfirmation(chatId) {
  await telegramSendMessage(
    chatId,
    "Вы уверены?\n\nЭто полностью удалит текущую игру: команды, карту, очки и прогресс раунда. Балансы квантов у аккаунтов Telegram сохраняются. Подключённые игроки потеряют привязку к командам.\n\nДействие необратимо для игрового состояния.",
    {
      reply_markup: {
        inline_keyboard: [
          [
            { text: "Да, выполнить полный сброс", callback_data: "adm_full_y" },
            { text: "Отмена", callback_data: "adm_full_n" },
          ],
        ],
      },
    }
  );
}

/** @param {{ id: string; from?: { id?: number }; message?: { chat?: { id?: number } }; data?: string }} cq */
async function handleTelegramAdminCallbackQuery(cq) {
  const uid = cq.from?.id;
  const chatId = cq.message?.chat?.id;
  const data = String(cq.data || "");
  if (uid == null || !TELEGRAM_ADMIN_IDS.has(uid)) {
    await telegramAnswerCallbackQuery(cq.id, { text: "Недоступно", show_alert: true });
    return;
  }

  /* Полный сброс: одна кнопка подтверждения + выполнение */
  if (data === "adm_full_a" || data === "adm_ng_a") {
    await telegramAnswerCallbackQuery(cq.id);
    if (chatId != null) await telegramSendFullGameResetConfirmation(chatId);
    return;
  }
  if (data === "adm_full_n" || data === "adm_ng_n") {
    await telegramAnswerCallbackQuery(cq.id, { text: "Отменено" });
    return;
  }
  if (data === "adm_full_y" || data === "adm_ng_y") {
    if (!isClusterLeader()) {
      await telegramAnswerCallbackQuery(cq.id, {
        text: "Только инстанс с CLUSTER_LEADER=true может выполнить полный сброс.",
        show_alert: true,
      });
      return;
    }
    await telegramAnswerCallbackQuery(cq.id, { text: "Выполняю полный сброс…" });
    const r = await applyAdminFullNewGameReset(uid);
    if (chatId != null) {
      await telegramSendMessage(
        chatId,
        r.ok
          ? "Готово: полный сброс выполнен — команды и карта с нуля (раунд 0). Кванты на аккаунтах сохранены. Игрокам нужно заново зайти в игру."
          : r.reason === "not_leader"
            ? "Сброс только на лидере кластера (CLUSTER_LEADER=true)."
            : r.reason === "wallet_reset_failed"
              ? "Состояние игры сброшено, но ошибка кошельков — см. лог сервера."
              : "Сброс не выполнен."
      );
    }
    return;
  }

  /* Устаревшие кнопки «сброс тренировки» (двухшаговый поток): частичный сброс из бота снят — отправьте /start. */
  if (data === "adm_rst_a") {
    await telegramAnswerCallbackQuery(cq.id);
    if (chatId != null) {
      await telegramSendMessage(
        chatId,
        "Раньше здесь был отдельный «сброс карты без удаления команд». Сейчас используется один вариант — полный сброс игры. Откройте подтверждение ниже.",
      );
      await telegramSendFullGameResetConfirmation(chatId);
    }
    return;
  }
  if (data === "adm_rst_n") {
    await telegramAnswerCallbackQuery(cq.id, { text: "Отменено" });
    return;
  }
  if (data === "adm_rst_y") {
    await telegramAnswerCallbackQuery(cq.id, {
      text: "Эта кнопка устарела. Отправьте /start и используйте «Полный сброс игры».",
      show_alert: true,
    });
    return;
  }

  await telegramAnswerCallbackQuery(cq.id);
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
        const cq = u.callback_query;
        if (cq && cq.id) {
          const cuid = cq.from?.id;
          if (cuid != null && TELEGRAM_ADMIN_IDS.has(cuid)) {
            await handleTelegramAdminCallbackQuery(cq);
          } else {
            await telegramAnswerCallbackQuery(cq.id, { text: "Недоступно", show_alert: true });
          }
          continue;
        }
        const msg = u.message || u.edited_message;
        if (!msg || typeof msg.text !== "string") continue;
        const uid = msg.from?.id;
        if (uid == null) continue;
        const chatId = msg.chat.id;
        let t = String(msg.text).trim();

        if (isStartCommand(t)) {
          rememberTelegramSubscriberChat(chatId);
          const launchUrl = buildMiniAppOpenUrl(parseStartPayload(t));
          const startBtn =
            TELEGRAM_START_GAME_BUTTON_ENABLED && launchUrl
              ? buildTelegramStartInlineButton(launchUrl)
              : null;
          if (startBtn || TELEGRAM_ADMIN_IDS.has(uid)) {
            /** @type {{ text: string; url?: string; web_app?: { url: string }; callback_data?: string }[][]} */
            const rows = [];
            if (startBtn) rows.push([startBtn]);
            if (TELEGRAM_ADMIN_IDS.has(uid)) {
              rows.push([{ text: "⚠️ Полный сброс игры", callback_data: "adm_full_a" }]);
            }
            await telegramSendMessage(chatId, TELEGRAM_START_MESSAGE, {
              reply_markup: { inline_keyboard: rows },
            });
          } else if (!TELEGRAM_START_GAME_BUTTON_ENABLED) {
            await telegramSendMessage(
              chatId,
              `${TELEGRAM_START_MESSAGE}\n\n(Кнопка Mini App отключена: TELEGRAM_START_GAME_BUTTON_ENABLED на сервере.)`
            );
          } else if (!launchUrl) {
            await telegramSendMessage(
              chatId,
              `${TELEGRAM_START_MESSAGE}\n\n(Админу: задайте TELEGRAM_MINIAPP_LINK или TELEGRAM_BOT_USERNAME + TELEGRAM_MINIAPP_SHORT_NAME — тогда здесь появится кнопка запуска.)`
            );
          } else {
            await telegramSendMessage(
              chatId,
              `${TELEGRAM_START_MESSAGE}\n\n(Админу: ссылка на игру должна быть HTTPS, например https://pifagor.games/ — см. TELEGRAM_MINIAPP_LINK в Render.)`
            );
          }
          continue;
        }

        if (!TELEGRAM_ADMIN_IDS.has(uid)) {
          if (telegramMessageLooksLikePrivilegedCommand(t)) {
            await telegramSendMessage(
              chatId,
              "Сервер не считает вас администратором: в TELEGRAM_ADMIN_IDS на сервере должен быть ваш числовой user id (узнать: @userinfobot). Без этого go, say, speed, evt и др. игнорируются."
            );
          }
          continue;
        }
        const restartNorm = t
          .toLowerCase()
          .replace(/^\/+/, "")
          .replace(/\s+/g, " ");

        const pendingSayUntil = telegramAdminSayPromptUntil.get(uid);
        if (pendingSayUntil != null) {
          if (pendingSayUntil <= Date.now()) {
            telegramAdminSayPromptUntil.delete(uid);
          } else {
            if (restartNorm === "cancel" || restartNorm === "отмена") {
              telegramAdminSayPromptUntil.delete(uid);
              await telegramSendMessage(chatId, "Режим say отменён.");
              continue;
            }
            if (shouldInterruptPendingSayPrompt(t, restartNorm)) {
              telegramAdminSayPromptUntil.delete(uid);
              await telegramSendMessage(chatId, "Ожидание текста для say сброшено — выполняю как команду.");
            } else {
              const text = sanitizeServerAnnouncementText(t);
              if (!text) {
                await telegramSendMessage(chatId, "Пустой текст. Пришлите другой текст или cancel.");
                continue;
              }
              broadcast({ type: "serverAnnouncement", text, durationMs: SERVER_ANNOUNCEMENT_DURATION_MS });
              telegramAdminSayPromptUntil.delete(uid);
              await telegramSendMessage(
                chatId,
                `Плашка в игре для всех ~${SERVER_ANNOUNCEMENT_DURATION_MS / 1000} с (${text.length} симв.).`
              );
              continue;
            }
          }
        }

        const sayParsed = parseSayTelegramCommand(t);
        if (sayParsed) {
          if (sayParsed.body.length > 0) {
            const text = sanitizeServerAnnouncementText(sayParsed.body);
            if (!text) {
              await telegramSendMessage(chatId, "Текст пустой после очистки.");
              continue;
            }
            broadcast({ type: "serverAnnouncement", text, durationMs: SERVER_ANNOUNCEMENT_DURATION_MS });
            telegramAdminSayPromptUntil.delete(uid);
            await telegramSendMessage(
              chatId,
              `Плашка в игре для всех ~${SERVER_ANNOUNCEMENT_DURATION_MS / 1000} с (${text.length} симв.).`
            );
            continue;
          }
          telegramAdminSayPromptUntil.set(uid, Date.now() + SAY_PROMPT_TTL_MS);
          await telegramSendMessage(
            chatId,
            "Следующим сообщением пришлите текст плашки для всех игроков (до 240 символов, ~5 с на экране). Отмена: cancel"
          );
          continue;
        }

        const speedCmd = restartNorm.replace(/^\/speed\b/, "speed").trim();
        if (speedCmd === "speed" || speedCmd.startsWith("speed ")) {
          if (!isClusterLeader()) {
            await telegramSendMessage(
              chatId,
              "Команду speed выполняет только лидер кластера (CLUSTER_LEADER=true на одном инстансе)."
            );
            continue;
          }
          const parts = speedCmd.split(/\s+/).filter(Boolean);
          const sub = (parts[1] || "").toLowerCase();
          if (sub === "off" || sub === "0") {
            mstimAltSeasonBurstUntilMs = 0;
            saveRoundState();
            broadcast({ type: "mstimAltSeasonSync", untilMs: 0 });
            broadcast({ type: "roundEvent", phase: "end", roundIndex });
            scheduleStatsBroadcast();
            await broadcastWalletPayloadToAllClients();
            await telegramSendMessage(chatId, "«Мстим за Альт Сезон» выключено (интервал пикселя — обычный).");
            continue;
          }
          mstimAltSeasonBurstUntilMs = Date.now() + MSTIM_ALT_SEASON_DURATION_MS;
          saveRoundState();
          if (DEBUG_MSTIM_COOLDOWN) {
            console.log(`[mstim] speed ON until=${mstimAltSeasonBurstUntilMs} (effective cd 1000 ms for all players)`);
          }
          broadcast({ type: "mstimAltSeasonSync", untilMs: mstimAltSeasonBurstUntilMs });
          broadcast({
            type: "roundEvent",
            phase: "start",
            eventId: `alt_season_revenge_${mstimAltSeasonBurstUntilMs}`,
            eventType: "alt_season_revenge",
            title: "Мстим за Альт Сезон",
            subtitle: "Пиксель раз в 1 с для всех игроков — 5 минут",
            untilMs: mstimAltSeasonBurstUntilMs,
            roundIndex,
          });
          scheduleStatsBroadcast();
          await broadcastWalletPayloadToAllClients();
          await telegramSendMessage(
            chatId,
            `«Мстим за Альт Сезон» на 5 мин: у всех игроков пиксель раз в 1 с. Конец: ${new Date(mstimAltSeasonBurstUntilMs).toISOString()}. Выключить: speed off`
          );
          continue;
        }

        {
          const bw = (restartNorm.split(/\s+/)[0] || "").replace(/@\w+$/i, "");
          if (bw === "broadcast" || bw === "рассылка") {
            let custom = "";
            if (bw === "broadcast" && restartNorm.startsWith("broadcast ")) {
              custom = restartNorm.slice("broadcast ".length).trim();
            } else if (bw === "рассылка" && restartNorm.startsWith("рассылка ")) {
              custom = restartNorm.slice("рассылка ".length).trim();
            }
            const textOut = custom || TELEGRAM_START_MESSAGE;
            const launchUrl = buildMiniAppOpenUrl("");
            const startBtn = launchUrl ? buildTelegramStartInlineButton(launchUrl) : null;
            const ids = [...telegramSubscriberChatIds];
            let ok = 0;
            let fail = 0;
            for (const cid of ids) {
              const sent = await telegramSendMessage(
                cid,
                textOut,
                startBtn ? { reply_markup: { inline_keyboard: [[startBtn]] } } : {}
              );
              if (sent) ok++;
              else fail++;
              await new Promise((r) => setTimeout(r, 55));
            }
            await telegramSendMessage(
              chatId,
              `Рассылка: доставлено ${ok}, ошибок ${fail}, в списке ${ids.length} чат(ов). Учитываются только те, кто писал /start боту после этого обновления сервера. На Render без постоянного диска список сбрасывается при деплое.`
            );
            continue;
          }
        }

        {
          const paintWord = (restartNorm.split(/\s+/)[0] || "").replace(/@\w+$/i, "");
          if (paintWord === "paint" && restartNorm.split(/\s+/).length === 1) {
            await handleTelegramPaintCommand(chatId, uid);
            continue;
          }
        }

        {
          const qCmd = restartNorm.replace(/^\/quant\b/i, "quant").trim();
          if (qCmd === "quant" || qCmd.startsWith("quant ")) {
            if (!isClusterLeader()) {
              await telegramSendMessage(
                chatId,
                "quant: only CLUSTER_LEADER=true instance runs this (avoids duplicate grants with multiple workers)."
              );
              continue;
            }
            const parsed = parseTelegramAdminQuantCommand(qCmd);
            if (!parsed.ok) {
              await telegramSendMessage(
                chatId,
                "Invalid format. Use numeric Telegram user ID only: quant <id> +<amount> (also -<amount>, =<amount>). Not @username or team name."
              );
              continue;
            }
            await applyAdminQuantTelegramCommand(chatId, uid, parsed);
            continue;
          }
        }

        {
          const qlCmd = restartNorm.replace(/^\/quantlist\b/i, "quantlist").trim();
          if (qlCmd === "quantlist" || qlCmd.startsWith("quantlist ")) {
            const parsedQl = parseTelegramAdminQuantlistCommand(qlCmd);
            if (!parsedQl.ok) {
              const errMsg =
                parsedQl.reason === "usage"
                  ? "Invalid command format. Use: quantlist <telegramId> (optional: more numeric IDs separated by spaces)."
                  : parsedQl.reason === "too_many"
                    ? `Too many IDs at once (max ${ADMIN_QUANTLIST_MAX_IDS}).`
                    : "Invalid command format. Use: quantlist <telegramId>";
              await telegramSendMessage(chatId, errMsg);
              continue;
            }
            await applyAdminQuantlistTelegramCommand(chatId, uid, parsedQl);
            continue;
          }
        }

        {
          let tn = restartNorm.trim().toLowerCase();
          if (tn.startsWith("/test")) tn = tn.slice(1).trim();
          if (tn === "test" || tn.startsWith("test ")) {
            if (!isClusterLeader()) {
              await telegramSendMessage(
                chatId,
                "Этот процесс не лидер кластера — команда test только на инстансе с CLUSTER_LEADER=true."
              );
              continue;
            }
            const arg = tn.slice(4).trim();
            if (arg === "off" || arg === "0" || arg === "выкл") {
              tournamentQuickTestMode = false;
              roundDurationMs = battleDurationForRound(roundIndex);
              if (roundIndex === 0) round0WarmupMs = ROUND_ZERO_POST_GO_WARMUP_MS;
              saveRoundState();
              broadcastTournamentTimeScaleToClients();
              if (wss) {
                await Promise.all(
                  [...wss.clients]
                    .filter((c) => c.readyState === 1)
                    .map((c) => sendConnectionMeta(c))
                );
              }
              await telegramSendMessage(
                chatId,
                "Тестовый режим выключен. Длительность раундов — как в конфиге турнира (tournament-flow). Часы снова задаёт команда go."
              );
              continue;
            }
            tournamentQuickTestMode = true;
            applyQuickTestRoundTimingToState();
            saveRoundState();
            broadcastTournamentTimeScaleToClients();
            if (wss) {
              await Promise.all(
                [...wss.clients]
                  .filter((c) => c.readyState === 1)
                  .map((c) => sendConnectionMeta(c))
              );
            }
            await telegramSendMessage(
              chatId,
              `Тестовый режим вкл: бой в каждом раунде ${QUICK_TEST_ROUND_BATTLE_MS / 1000} с, разминка перед боем ${QUICK_TEST_WARMUP_MS / 1000} с (все этапы). Полный цикл турнира и объявление победителя — как обычно. Выключить: test off`
            );
            continue;
          }
        }

        {
          let cn = restartNorm.replace(/^\/teams\b/i, "teams").trim();
          if (cn === "teams" || cn.startsWith("teams ")) {
            if (!isClusterLeader()) {
              await telegramSendMessage(
                chatId,
                "Команды teams / pause / unpause выполняет только лидер кластера (CLUSTER_LEADER=true)."
              );
              continue;
            }
            const arg = cn.slice(5).trim();
            if (!arg) {
              const st = buildStatsPayload();
              const rowBy = new Map(st.rows.map((r) => [r.teamId, r]));
              const lines = [];
              let n = 0;
              for (const t of dynamicTeams) {
                if (t.solo || t.eliminated) continue;
                n += 1;
                const r = rowBy.get(t.id);
                const score =
                  r && typeof r.score === "number" ? r.score : Math.round((teamManualScoreBonus.get(t.id) | 0) * 1000) / 1000;
                const players = r && typeof r.players === "number" ? r.players : teamPlayerCounts.get(t.id) || 0;
                lines.push(`${n}. ${t.name} — id ${t.id} — ${score} очк. — ${players} игроков`);
              }
              const hint = "\n\nДобавить очки команде: teams Имя +N (пример: teams Alpha +500 или teams \"Team Alpha\" +500).";
              const text = lines.length
                ? `Текущие команды:\n${lines.join("\n")}${hint}`
                : `Команд нет (или все выбыли).${hint}`;
              logAdminAction({ command: "teams_list", byTelegramId: uid, teamCount: lines.length });
              await telegramSendMessage(chatId, text);
              continue;
            }
            const parsed = parseTeamsTelegramAddPoints(arg);
            if (!parsed.ok) {
              await telegramSendMessage(chatId, parsed.error);
              continue;
            }
            const resTeam = resolveTeamForAdminBonus(parsed.teamName);
            if (resTeam.kind === "none") {
              await telegramSendMessage(chatId, `Команда не найдена: «${parsed.teamName}».`);
              continue;
            }
            if (resTeam.kind === "many") {
              await telegramSendMessage(
                chatId,
                `Несколько совпадений для «${parsed.teamName}»: ${resTeam.names.join(", ")}. Уточните имя или используйте кавычки.`
              );
              continue;
            }
            const tid = resTeam.team.id;
            const prevB = teamManualScoreBonus.get(tid) | 0;
            teamManualScoreBonus.set(tid, prevB + parsed.points);
            saveRoundState();
            broadcastTeamManualScoreBonusSync();
            scheduleStatsBroadcast();
            const st2 = buildStatsPayload();
            const row = st2.rows.find((x) => x.teamId === tid);
            const newScore = row && typeof row.score === "number" ? row.score : prevB + parsed.points;
            logAdminAction({
              command: "teams_add",
              byTelegramId: uid,
              teamId: tid,
              teamName: resTeam.team.name,
              pointsAdded: parsed.points,
              manualBonusTotal: teamManualScoreBonus.get(tid) | 0,
            });
            await telegramSendMessage(
              chatId,
              `Добавлено ${parsed.points} очков команде «${resTeam.team.name}». Новый счёт: ${newScore}`
            );
            continue;
          }
        }

        {
          const p0 = (restartNorm.split(/\s+/)[0] || "").replace(/@\w+$/i, "");
          if (p0 === "pause") {
            if (!isClusterLeader()) {
              await telegramSendMessage(chatId, "Паузу выставляет только лидер кластера (CLUSTER_LEADER=true).");
              continue;
            }
            const pr = applyAdminPause(uid);
            if (!pr.ok) {
              const replyPause =
                pr.reason === "already"
                  ? "Game is already paused."
                  : pr.reason === "game_finished"
                    ? "Game finished — pause not applied."
                    : "Game paused not applied.";
              await telegramSendMessage(chatId, replyPause);
              continue;
            }
            await telegramSendMessage(chatId, "Game paused.");
            continue;
          }
          if (p0 === "unpause" || p0 === "resume") {
            if (!isClusterLeader()) {
              await telegramSendMessage(chatId, "Unpause only on cluster leader (CLUSTER_LEADER=true).");
              continue;
            }
            const ur = applyAdminUnpause(uid);
            if (!ur.ok) {
              await telegramSendMessage(chatId, ur.reason === "not_paused" ? "Game is not paused." : "Unpause failed.");
              continue;
            }
            await telegramSendMessage(chatId, "Game resumed.");
            broadcast({ type: "serverAnnouncement", text: "GAME RESUMED", durationMs: 4000 });
            continue;
          }
        }

        let manualBattleLine = null;
        const manualEvtPrefix = /^(evt|event|события|событие)\s+/iu;
        if (manualEvtPrefix.test(restartNorm)) {
          manualBattleLine = restartNorm.replace(manualEvtPrefix, "").trim();
        } else {
          const fw = restartNorm.split(/\s+/)[0] || "";
          if (fw !== "off" && MANUAL_TELEGRAM_CMD_FIRST_WORDS.has(fw)) manualBattleLine = restartNorm;
        }
        if (manualBattleLine != null) {
          await handleTelegramManualBattleCommand(chatId, manualBattleLine);
          continue;
        }

        if (
          restartNorm === "новая игра" ||
          restartNorm === "newgame" ||
          restartNorm === "wipe" ||
          restartNorm === "с нуля"
        ) {
          await telegramSendMessage(
            chatId,
            "Полный сброс игры:\n\n" +
              "• все команды и названия удаляются с сервера;\n" +
              "• раунд 0, чистая карта и клады;\n" +
              "• кванты на аккаунтах Telegram сохраняются (сбрасываются только игровые кулдауны экономики).\n\n" +
              "Закрытие мини-приложения этого не делает.\n\n" +
              "Подтвердите:",
            {
              reply_markup: {
                inline_keyboard: [
                  [
                    { text: "Да, выполнить полный сброс", callback_data: "adm_full_y" },
                    { text: "Отмена", callback_data: "adm_full_n" },
                  ],
                ],
              },
            }
          );
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
              "Неизвестная команда. Админ: /start (полный сброс игры), go [часы], quant / quantlist <числовой Telegram id>, teams, teams Имя +N, pause, unpause, test / test off, say, speed, paint, новая игра, restart, evt help, gold…"
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
          if (tournamentQuickTestMode) {
            const warmMs = result.warmupMs ?? QUICK_TEST_WARMUP_MS;
            const battleMs = result.durationMs ?? QUICK_TEST_ROUND_BATTLE_MS;
            const warmRealSec = Math.max(1, Math.round(warmMs / 1000));
            const battleSec = Math.max(1, Math.round(battleMs / 1000));
            reply = `Раунд 1 (тест): карта очищена, ${warmRealSec} с до боя, затем ${battleSec} с боя. Пиксели с ${new Date(getPlayStartMs()).toISOString()}`;
          } else {
            const h = (result.durationMs ?? roundDurationMs) / 3600000;
            const warmMs = result.warmupMs ?? ROUND_ZERO_POST_GO_WARMUP_MS;
            const warmRealSec = Math.max(1, Math.round(warmMs / 1000));
            reply = `Раунд 1: карта очищена, ${warmRealSec} с до старта боя, затем бой ${h.toFixed(h < 1 ? 2 : 1)} ч. Обычные пиксели с ${new Date(getPlayStartMs()).toISOString()}`;
          }
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

function shutdownPersistSync() {
  try {
    flushPixelBroadcastNow();
    writePixelsSnapshotSyncForShutdown();
  } catch (e) {
    console.warn("[shutdown] persist:", e?.message || e);
  }
}
process.on("SIGTERM", () => {
  shutdownPersistSync();
  process.exit(0);
});
process.on("SIGINT", () => {
  shutdownPersistSync();
  process.exit(0);
});

server.listen(PORT, () => {
  console.log(`Pixel Battle: http://localhost:${PORT}  (WS ${WS_PATH})`);
  schedulePlayStartBroadcast();
  setInterval(() => {
    void tickQuantumFarmIncome();
  }, QUANTUM_FARM_TICK_MS);
  setInterval(() => {
    void writePixelsSnapshotFileAsync();
  }, PIXELS_SNAPSHOT_INTERVAL_MS);
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
              if (msg && msg.type === "walletRefreshPlayer" && typeof msg.playerKey === "string") {
                void pushWalletToPlayerKey(msg.playerKey);
                return;
              }
              applyClusterGameReplication(msg);
              /* Лидер уже отправил этот кадр локальным клиентам в publishGameRaw; иначе — двойная доставка. */
              if (!isClusterLeader()) {
                broadcastToWebSocketClients(raw);
              }
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
        const pollStarted = () => {
          console.log("[Telegram] long poll запущен (getUpdates).");
          console.log(
            "[Telegram] Рассылка: админ пишет в бот «broadcast» или «рассылка» (опционально текст после пробела) — всем, кто нажимал /start; список: data/telegram-bot-subscribers.json"
          );
          telegramPollLoop().catch((e) => console.warn("Telegram poll:", e));
        };
        if (REDIS_URL) {
          const lockKey = `${REDIS_GAME_CHANNEL}:telegram-poll`;
          const instanceId =
            String(process.env.RENDER_INSTANCE_ID || "").trim() ||
            `local-${process.pid}-${crypto.randomBytes(6).toString("hex")}`;
          void startTelegramPollWhenRedisLockHeld({
            redisUrl: REDIS_URL,
            lockKey,
            instanceId,
            onLockHeld: pollStarted,
          });
          console.log(
            `[Telegram] ожидание Redis-lock «${lockKey}» (один поллер на кластер; устраняет 409 при деплое Render).`
          );
        } else {
          pollStarted();
        }
      } else {
        console.log("[cluster] Telegram long poll отключён (CLUSTER_LEADER=false на этом инстансе).");
      }
    })();
    if (!TELEGRAM_START_GAME_BUTTON_ENABLED) {
      console.log(
        "[Telegram] /start: кнопка игры выключена (TELEGRAM_START_GAME_BUTTON_ENABLED=false) — ответ пользователю не отправляется."
      );
    } else if (getTelegramMiniAppLaunchUrl()) {
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
        'Первый раунд: «go» + часы; «test» / «test off» — турнир: бой в каждом раунде 1 мин (разминка 5 с); «speed» — Альт Сезон; рестарт — TELEGRAM_ENABLE_PROCESS_RESTART=true.'
      );
    } else if (TELEGRAM_ADMIN_IDS.size === 0) {
      console.warn(
        "[Pixel Battle] Пуст TELEGRAM_ADMIN_IDS — команды «go» / «рестарт» недоступны (только /start и локальная игра)."
      );
    }
  }
  if (TELEGRAM_BOT_TOKEN && TELEGRAM_ADMIN_IDS.size > 0) {
    console.log(
      "Админам (TELEGRAM_ADMIN_IDS): уведомления после массового раунда, полуфинала (десятка), финала команд (дуэлянты) и после дуэли — username и Telegram ID проходящих / победителей."
    );
  }
});
