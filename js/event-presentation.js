/**
 * Премиальная презентация live-событий: кинематические баннеры, док HUD, классы атмосферы.
 * Не смешивать с игровой логикой — только отображение и лёгкие audio-sting.
 */

import { playPresentationSting } from "./game-audio.js";

/** @type {HTMLElement | null} */
let cinematicRoot = null;
/** @type {HTMLElement | null} */
let cinematicPanel = null;
/** @type {HTMLElement | null} */
let cinematicTitleEl = null;
/** @type {HTMLElement | null} */
let cinematicSubEl = null;
/** @type {HTMLElement | null} */
let cinematicIconEl = null;
/** @type {HTMLElement | null} */
let cinematicKickerEl = null;
/** @type {HTMLElement | null} */
let hudDock = null;
/** @type {HTMLElement | null} */
let finalPressureEl = null;

/** @type {ReturnType<typeof setInterval> | null} */
let hudTickTimer = null;

/** @type {number | null} */
let lastStripRoundEndMs = null;

/** @type {string} */
let lastHudSignature = "";

let lastSeismicPreviewKey = "";
let lastRoundEventStartKey = "";
/** Последний roundEvent start (для HUD, если globalEvent с layers пришёл позже или пустой). */
let lastRoundEventStartMsg = null;

/** @type {{ title: string; subtitle: string; theme: string; holdMs?: number; sound?: string; kicker?: string }[]} */
const cinematicQueue = [];
let cinematicPlaying = false;

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function formatHudTime(untilMs) {
  if (typeof untilMs !== "number" || !Number.isFinite(untilMs)) return "—";
  const left = untilMs - Date.now();
  if (left <= 0) return "0:00";
  const s = Math.max(0, Math.ceil(left / 1000));
  const m = Math.floor(s / 60);
  const sec = s % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}

/**
 * @param {{ kind?: string; style?: string; title?: string; subtitle?: string }} L
 */
function hudThemeForLayerKind(L) {
  const k = String(L.kind || "");
  const tit = `${String(L.title || "")} ${String(L.subtitle || "")}`;
  const style = String(L.style || "");
  if (k === "gold_zone" || k === "target_zone" || k === "duel_zone") return "gold";
  if (k === "map_compression") {
    if (/бонус центра|CENTER BONUS/i.test(tit)) return "center";
    if (/финальн|FINAL\s*PHASE|перифери|outer territory/i.test(tit)) return "final-phase";
    if (/CENTER/i.test(tit) && !/MAP|СЖАТИЕ|compression/i.test(String(L.title || ""))) return "center";
    return "compression";
  }
  if (k === "trade_boom" || k === "resource_surge") return "boom";
  if (k === "recession") return "recession";
  if (k === "economic_shift" || k === "economic_rotation" || style === "economic_dual") return "economic-dual";
  if (k === "team_synergy") return "synergy";
  if (k === "dramatic_pressure") return "dramatic";
  return "neutral";
}

/** Иконка/глиф для HUD (Unicode, без внешних ассетов). */
function glyphForHudTheme(theme) {
  switch (theme) {
    case "gold":
      return "✦";
    case "boom":
      return "▲";
    case "economic":
    case "economic-dual":
      return "⇅";
    case "compression":
    case "center":
    case "final-phase":
      return "◎";
    case "boom":
      return "▲";
    case "recession":
      return "▼";
    case "economic-dual":
      return "⇅";
    case "synergy":
      return "⚡";
    case "dramatic":
      return "☆";
    case "seismic":
      return "⌁";
    case "alt-revenge":
      return "⚔";
    case "neutral":
      return "◆";
    default:
      return "◆";
  }
}

function shortStatusForLayer(L) {
  const k = L.kind;
  if (k === "gold_zone") return "2× очки в зоне";
  if (k === "target_zone") return "Бонус за захват зоны";
  if (k === "duel_zone") return "Дуэль: двойные очки";
  if (k === "map_compression") {
    const c = L.compression;
    if (c?.outerRingMult != null && c.outerRingMult < 0.5) return "Край почти мёртв";
    return "Центр сильнее, края слабее";
  }
  if (k === "trade_boom" || k === "resource_surge") return "Регион дороже";
  if (k === "recession") return "Регион дешевле";
  if (k === "economic_shift" || k === "economic_rotation") return "Разные множители";
  if (k === "team_synergy") return "Синергия онлайн";
  if (k === "dramatic_pressure") {
    const st = String(L.style || "");
    if (st === "final_ten") return "Последние минуты боя";
    if (st === "final_hour") return "Решающий отрезок";
    return "Особый режим очков";
  }
  return "";
}

const LAYER_HUD_ORDER = [
  "gold_zone",
  "target_zone",
  "duel_zone",
  "economic_shift",
  "economic_rotation",
  "resource_surge",
  "trade_boom",
  "recession",
  "team_synergy",
  "dramatic_pressure",
  "map_compression",
];

function sortLayersForHud(layers) {
  const arr = (layers || []).filter((L) => L && typeof L.untilMs === "number" && L.untilMs > Date.now());
  return arr.sort((a, b) => {
    const ia = LAYER_HUD_ORDER.indexOf(a.kind);
    const ib = LAYER_HUD_ORDER.indexOf(b.kind);
    const sa = ia === -1 ? 99 : ia;
    const sb = ib === -1 ? 99 : ib;
    if (sa !== sb) return sa - sb;
    return b.untilMs - a.untilMs;
  });
}

/**
 * Есть ли в payload сервера слой, соответствующий последнему roundEvent (чтобы не дублировать чип).
 * @param {unknown} layers
 * @param {{ eventType?: string; untilMs?: number } | null} re
 */
function battleLayersCoverRoundEvent(layers, re) {
  if (!re || typeof re.untilMs !== "number" || !Number.isFinite(re.untilMs)) return false;
  if (!Array.isArray(layers)) return false;
  const um = re.untilMs;
  const k = String(re.eventType || "");
  const now = Date.now();
  for (let i = 0; i < layers.length; i++) {
    const L = layers[i];
    if (!L || typeof L.untilMs !== "number" || !Number.isFinite(L.untilMs) || L.untilMs <= now) continue;
    if (k && L.kind === k && Math.abs(L.untilMs - um) < 20000) return true;
    if (Math.abs(L.untilMs - um) < 5000) return true;
  }
  return false;
}

/**
 * @param {object[]} chips
 * @param {object | null | undefined} ge
 */
function appendRoundEventHudFallback(chips, ge) {
  if (chips.length >= 6) return;
  const re = lastRoundEventStartMsg;
  if (!re || typeof re.untilMs !== "number" || re.untilMs <= Date.now()) return;
  const rawLayers = ge?.battleEvents?.layers;
  if (battleLayersCoverRoundEvent(rawLayers, re)) return;
  const kind = String(re.eventType || "battle_event");
  const fakeL = { kind, title: re.title, subtitle: re.subtitle, style: "" };
  const theme = hudThemeForLayerKind(fakeL);
  const st = shortStatusForLayer(fakeL);
  chips.push({
    kind,
    title: String(re.title || "Событие"),
    status: st || String(re.subtitle || "").slice(0, 120),
    untilMs: re.untilMs,
    theme,
  });
}

/** @param {import("./audio-spatial.js").SpatialSpec | null | undefined} [spatial] */
function playSting(kind, spatial) {
  playPresentationSting(String(kind || "default"), spatial);
}

function kickerFromThemeAndTitle(theme, title) {
  const tit = String(title || "").toUpperCase();
  if (theme === "base-captured") return "ПЕРЕЛОМ";
  if (theme === "final-ten") return "РЕШАЮЩИЙ МОМЕНТ";
  if (theme === "seismic-incoming" || /INCOMING|ВХОДЯЩ/.test(tit)) return "ВНИМАНИЕ";
  if (theme === "seismic") return "УДАР";
  if (theme === "gold") return "ЦЕЛЬ";
  if (theme === "center") return "СИЛОВАЯ ЗОНА";
  if (theme === "final-phase") return "ФИНАЛ";
  if (theme === "compression") return "СДВИГ ЗОН";
  if (theme === "dramatic") return "КУЛЬМИНАЦИЯ";
  if (theme === "economic" || theme === "boom" || theme === "recession") return "ЭКОНОМИКА";
  if (theme === "synergy") return "КОМАНДНЫЙ БАФФ";
  if (theme === "alt-revenge") return "АЛЬТ СЕЗОН";
  return "СОБЫТИЕ";
}

function triggerCinematicHaptic(theme) {
  try {
    const h = window.Telegram?.WebApp?.HapticFeedback;
    if (!h?.impactOccurred) return;
    if (theme === "base-captured" || theme === "final-ten") h.impactOccurred("heavy");
    else if (
      theme === "seismic-incoming" ||
      theme === "dramatic" ||
      theme === "final-phase" ||
      theme === "compression" ||
      theme === "alt-revenge"
    )
      h.impactOccurred("medium");
    else h.impactOccurred("light");
  } catch {
    /* ignore */
  }
}

function runCinematic(spec, done) {
  if (!cinematicRoot || !cinematicPanel || !cinematicTitleEl || !cinematicSubEl) {
    if (spec.sound) playSting(spec.sound, spec.spatial);
    done();
    return;
  }
  const theme = spec.theme || "default";
  const holdMs = typeof spec.holdMs === "number" ? spec.holdMs : 2100;
  const epicTier =
    theme === "base-captured" || theme === "final-ten" || theme === "seismic-incoming";
  const outPadMs = epicTier ? 640 : 520;

  cinematicPanel.className = `cinematic-event__panel cinematic-event__panel--${theme}`;
  cinematicTitleEl.textContent = spec.title || "";
  cinematicSubEl.textContent = spec.subtitle || "";
  const glyphKey =
    theme === "default"
      ? "neutral"
      : theme === "final-phase"
        ? "compression"
        : theme === "seismic-incoming"
          ? "seismic"
          : theme;
  if (cinematicIconEl) {
    cinematicIconEl.textContent = glyphForHudTheme(glyphKey);
  }
  if (cinematicKickerEl) {
    cinematicKickerEl.textContent = spec.kicker || kickerFromThemeAndTitle(theme, spec.title);
  }

  if (theme === "base-captured" || theme === "final-ten") cinematicRoot.dataset.tier = "epic";
  else if (
    theme === "seismic-incoming" ||
    theme === "dramatic" ||
    theme === "final-phase" ||
    theme === "alt-revenge"
  )
    cinematicRoot.dataset.tier = "high";
  else cinematicRoot.dataset.tier = "standard";

  cinematicRoot.hidden = false;
  cinematicRoot.classList.remove("cinematic-event--visible", "cinematic-event--out");
  void cinematicRoot.offsetWidth;

  requestAnimationFrame(() => {
    cinematicRoot.classList.add("cinematic-event--visible");
    triggerCinematicHaptic(theme);
  });

  if (spec.sound) playSting(spec.sound, spec.spatial);

  setTimeout(() => {
    cinematicRoot.classList.remove("cinematic-event--visible");
    requestAnimationFrame(() => {
      cinematicRoot.classList.add("cinematic-event--out");
    });
  }, holdMs);

  setTimeout(() => {
    cinematicRoot.classList.remove("cinematic-event--visible", "cinematic-event--out");
    cinematicRoot.removeAttribute("data-tier");
    cinematicRoot.hidden = true;
    done();
  }, holdMs + outPadMs);
}

function pumpCinematicQueue() {
  if (cinematicPlaying || cinematicQueue.length === 0) return;
  cinematicPlaying = true;
  const spec = cinematicQueue.shift();
  runCinematic(spec, () => {
    cinematicPlaying = false;
    pumpCinematicQueue();
  });
}

/**
 * @param {{ title: string; subtitle?: string; theme?: string; holdMs?: number; sound?: string; kicker?: string; spatial?: import("./audio-spatial.js").SpatialSpec; skipPresentationSting?: boolean }} spec
 */
export function enqueueBattleCinematic(spec) {
  const skipSound = spec.skipPresentationSting === true;
  /** @type {string | null} */
  let sound = null;
  if (!skipSound) {
    if (spec.sound != null && String(spec.sound).trim() !== "") sound = String(spec.sound);
    else if (spec.theme != null && String(spec.theme).trim() !== "") sound = String(spec.theme);
    else sound = "default";
  }
  cinematicQueue.push({
    title: spec.title,
    subtitle: spec.subtitle || "",
    theme: spec.theme || "default",
    holdMs: spec.holdMs,
    sound,
    kicker: spec.kicker,
    spatial: spec.spatial,
  });
  pumpCinematicQueue();
}

export function initEventPresentation() {
  cinematicRoot = document.getElementById("cinematic-event-overlay");
  cinematicPanel = cinematicRoot?.querySelector(".cinematic-event__panel") ?? null;
  cinematicTitleEl = cinematicRoot?.querySelector(".cinematic-event__title") ?? null;
  cinematicSubEl = cinematicRoot?.querySelector(".cinematic-event__subtitle") ?? null;
  cinematicIconEl = cinematicRoot?.querySelector(".cinematic-event__icon") ?? null;
  cinematicKickerEl = cinematicRoot?.querySelector(".cinematic-event__kicker") ?? null;
  hudDock = document.getElementById("event-hud-dock");
  finalPressureEl = document.getElementById("final-pressure-strip");
}

export function resetEventPresentationForRound() {
  lastSeismicPreviewKey = "";
  lastRoundEventStartKey = "";
  lastRoundEventStartMsg = null;
  lastHudSignature = "";
  cinematicQueue.length = 0;
  if (cinematicRoot) {
    cinematicRoot.hidden = true;
    cinematicRoot.classList.remove("cinematic-event--visible", "cinematic-event--out");
  }
  stopHudTick();
  if (hudDock) {
    hudDock.hidden = true;
    hudDock.innerHTML = "";
  }
  syncBodyAtmosphere(null, null);
  if (finalPressureEl) {
    finalPressureEl.hidden = true;
    finalPressureEl.textContent = "";
  }
}

function stopHudTick() {
  if (hudTickTimer != null) {
    clearInterval(hudTickTimer);
    hudTickTimer = null;
  }
}

function startHudTick(updateFn) {
  if (hudTickTimer != null) return;
  hudTickTimer = setInterval(updateFn, 500);
}

/**
 * @param {string} eventType
 * @param {string} title
 * @param {string} subtitle
 * @returns {{ title: string; subtitle: string; theme: string; sound: string; holdMs: number }}
 */
function roundEventToCinematicSpec(eventType, title, subtitle) {
  const tit = `${title} ${subtitle}`;
  const base = {
    title: title || "Событие боя",
    subtitle: subtitle || "",
    theme: "default",
    sound: "default",
    holdMs: 2400,
  };

  switch (eventType) {
    case "gold_zone":
      return { ...base, theme: "gold", sound: "gold", holdMs: 2400 };
    case "seismic":
      return { ...base, theme: "seismic", sound: "seismic", holdMs: 2800 };
    case "economic_mixed":
      return { ...base, theme: "economic", sound: "economic", holdMs: 2600 };
    case "economic_boom_only":
      return { ...base, theme: "boom", sound: "boom", holdMs: 2400 };
    case "map_compression":
      return { ...base, theme: "compression", sound: "compression", holdMs: 2600 };
    case "final_edge_compression":
      return { ...base, theme: "final-phase", sound: "final-phase", holdMs: 2800 };
    case "team_synergy":
      return { ...base, theme: "synergy", sound: "default", holdMs: 2200 };
    case "center_bonus":
      return { ...base, theme: "center", sound: "center", holdMs: 2600 };
    case "dramatic_pressure": {
      if (/финальн(ые)?\s*10|10\s*минут|FINAL\s*10|10\s*MINUTES/i.test(tit)) {
        return { ...base, theme: "final-ten", sound: "final-ten", holdMs: 3200 };
      }
      return { ...base, theme: "dramatic", sound: "dramatic", holdMs: 2800 };
    }
    case "alt_season_revenge":
      return { ...base, theme: "alt-revenge", sound: "gold", holdMs: 2600, kicker: "АЛЬТ СЕЗОН" };
    default:
      return base;
  }
}

/**
 * WebSocket: roundEvent phase start.
 * @param {{ phase?: string; eventId?: string; eventType?: string; title?: string; subtitle?: string }} msg
 */
export function notifyRoundEventFromServer(msg) {
  if (!msg) return;
  if (msg.phase === "end") {
    lastRoundEventStartMsg = null;
    return;
  }
  if (msg.phase !== "start" || !msg.eventId) return;
  const key = String(msg.eventId);
  if (lastRoundEventStartKey === key) return;
  lastRoundEventStartKey = key;
  lastRoundEventStartMsg = msg;
  const spec = roundEventToCinematicSpec(
    String(msg.eventType || ""),
    String(msg.title || ""),
    String(msg.subtitle || "")
  );
  enqueueBattleCinematic(spec);
}

/**
 * Однократное «incoming» перед сейсмикой.
 * @param {{ eventId?: string; impactAtMs?: number }} preview
 */
export function notifySeismicPreview(preview) {
  if (!preview || typeof preview.impactAtMs !== "number" || preview.impactAtMs <= Date.now()) return;
  const key = `${preview.eventId || "se"}_${preview.impactAtMs | 0}`;
  if (lastSeismicPreviewKey === key) return;
  lastSeismicPreviewKey = key;
  enqueueBattleCinematic({
    title: "Сейсмика: готовьтесь",
    subtitle: "Территория обрушится — удар по карте",
    theme: "seismic-incoming",
    sound: "seismic-incoming",
    holdMs: 2400,
  });
}

/**
 * Захват базы (полноэкранно + баннеры в main).
 * @param {string} attackerLabel
 * @param {string} defenderLabel
 */
export function enqueueBaseCapturedPresentation(attackerLabel, defenderLabel) {
  enqueueBattleCinematic({
    title: "База захвачена",
    subtitle: `${String(defenderLabel)} → ${String(attackerLabel)}`,
    theme: "base-captured",
    sound: "base_captured",
    holdMs: 3200,
  });
}

/**
 * Магазинный захват зоны на карте (broadcast purchaseVfx).
 * @param {"zoneCapture"|"massCapture"|"zone12Capture"|"militaryBase"} kind
 * @param {string} teamName
 * @param {number} size сторона квадрата
 * @param {import("./audio-spatial.js").SpatialSpec | null | undefined} [spatial] позиционирование стинга зоны
 */
export function enqueueTerritoryCapturePresentation(kind, teamName, size, spatial) {
  const name = String(teamName || "Команда").trim() || "Команда";
  const s = size | 0;
  let title = "Захват территории";
  let subtitle = `Команда «${name}»`;
  let holdMs = 2100;
  if (kind === "zoneCapture") {
    title = `Захват зоны ${s}×${s}`;
    subtitle = `«${name}» закрепляет блок ${s}×${s}`;
  } else if (kind === "massCapture") {
    title = `Массовый захват ${s}×${s}`;
    subtitle = `«${name}» — удар по ${s}×${s}`;
  } else if (kind === "zone12Capture") {
    title = `Штурм ${s}×${s}`;
    subtitle = `«${name}» забирает крупный сектор`;
  } else if (kind === "militaryBase") {
    title = "ПЕРЕДОВАЯ БАЗА";
    subtitle = `«${name}» — стратегический плацдарм 6×6. Новый фронт на карте.`;
    holdMs = 2800;
  }
  const spatialFinal =
    spatial ?? (kind === "militaryBase" ? { scope: /** @type {const} */ ("global"), weight: 1 } : undefined);
  /* Звук плацдарма — только playMilitaryBaseDeploySound в main (один раз на purchaseVfx). Кинематограф без стинга:
   * иначе при сбое очереди/повторах military_base.mp3 может «ехать» на каждый пиксель. */
  if (kind === "militaryBase") {
    enqueueBattleCinematic({
      title,
      subtitle,
      theme: "gold",
      holdMs,
      spatial: spatialFinal,
      skipPresentationSting: true,
    });
    return;
  }
  const sound =
    kind === "zoneCapture"
      ? "territory_4"
      : kind === "massCapture"
        ? "territory_6"
        : "territory_12";
  enqueueBattleCinematic({
    title,
    subtitle,
    theme: "gold",
    sound,
    holdMs,
    spatial: spatialFinal,
  });
}

/**
 * @param {HTMLElement} el
 * @param {string} titleHtml escaped
 * @param {string} subHtml escaped
 * @param {'flag-warn'|'flag-danger'|'flag-crit'|'territory-warn'|'territory-crit'|'seismic-warn'} variant
 * @param {string} [extraClasses] доп. классы (например `event-banner event-banner--swipe-dismiss`)
 */
export function fillPremiumAlertPanel(el, titleHtml, subHtml, variant, extraClasses = "") {
  if (!el) return;
  const x = extraClasses && String(extraClasses).trim() ? ` ${String(extraClasses).trim()}` : "";
  el.className = `premium-alert premium-alert--${variant}${x}`;
  el.innerHTML = `<div class="premium-alert__frame"></div>
    <div class="premium-alert__icon" aria-hidden="true">⚠</div>
    <div class="premium-alert__body">
      <div class="premium-alert__title">${titleHtml}</div>
      ${subHtml ? `<div class="premium-alert__sub">${subHtml}</div>` : ""}
    </div>`;
}

function syncBodyAtmosphere(ge, seismicPreviewActive) {
  const doc = document.body;
  if (!doc) return;
  doc.classList.toggle("pb-seismic-tremor", !!seismicPreviewActive);

  const layers = ge?.battleEvents?.layers;
  const dramaticL = Array.isArray(layers) ? layers.find((l) => l && l.kind === "dramatic_pressure") : null;
  const dst = dramaticL ? String(dramaticL.style || "") : "";
  const tit = dramaticL ? `${String(dramaticL.title || "")} ${String(dramaticL.subtitle || "")}` : "";
  const finalTen =
    dst === "final_ten" || /финальн(ые)?\s*10|10\s*минут/i.test(tit) || /FINAL\s*10|10\s*MINUTES/i.test(tit);
  const finalHour =
    dst === "final_hour" ||
    (/финальн(ый)?\s*час/i.test(tit) && !finalTen) ||
    (/FINAL\s*HOUR/i.test(tit) && !finalTen);

  doc.classList.toggle("pb-final-ten", finalTen);
  doc.classList.toggle("pb-final-hour", finalHour && !finalTen);
  doc.classList.toggle("pb-map-contrast-boost", finalTen || finalHour);
}

function updateHudTimersFromDom() {
  if (!hudDock || hudDock.hidden) return;
  const times = hudDock.querySelectorAll("[data-until]");
  for (let i = 0; i < times.length; i++) {
    const el = times[i];
    const raw = el.getAttribute("data-until");
    const u = raw != null && raw !== "" ? Number(raw) : NaN;
    if (!Number.isFinite(u)) continue;
    el.textContent = formatHudTime(u);
  }
  if (finalPressureEl && !finalPressureEl.hidden && lastStripRoundEndMs != null) {
    const te = finalPressureEl.querySelector(".final-pressure-strip__timer");
    if (te) te.textContent = formatHudTime(lastStripRoundEndMs);
  }
}

/**
 * Синхронизация дока HUD и атмосферы. Таймер активных слоёв боя — в боковом доке (#event-hud-dock), не в #event-banner.
 * @param {{
 *   ge: object | null | undefined;
 *   seismicPreview: { impactAtMs?: number; eventId?: string } | null;
 *   online: boolean;
 *   spectator: boolean;
 *   gameFinished: boolean;
 *   roundEndsAtMs?: number | null;
 *   leaderboardHint?: string;
 * }} opts
 * @returns {boolean} hideLegacyBattleBanner (всегда false)
 */
export function syncPremiumBattlePresentation(opts) {
  const { ge, seismicPreview, online, spectator, gameFinished, roundEndsAtMs, leaderboardHint } = opts;
  lastStripRoundEndMs = typeof roundEndsAtMs === "number" ? roundEndsAtMs : null;
  if (!hudDock) initEventPresentation();

  syncBodyAtmosphere(ge || null, !!(seismicPreview && seismicPreview.impactAtMs > Date.now()));

  if (!online || spectator || gameFinished) {
    stopHudTick();
    lastRoundEventStartMsg = null;
    if (hudDock) {
      hudDock.hidden = true;
      hudDock.innerHTML = "";
    }
    lastHudSignature = "";
    if (finalPressureEl) {
      finalPressureEl.hidden = true;
      finalPressureEl.textContent = "";
    }
    syncBodyAtmosphere(null, false);
    return false;
  }

  if (lastRoundEventStartMsg && typeof lastRoundEventStartMsg.untilMs === "number") {
    if (lastRoundEventStartMsg.untilMs <= Date.now()) lastRoundEventStartMsg = null;
  }

  /** @type {object[]} */
  const chips = [];

  const arUntil =
    ge && typeof ge.altSeasonRevengeUntilMs === "number" && ge.altSeasonRevengeUntilMs > Date.now()
      ? ge.altSeasonRevengeUntilMs
      : 0;
  if (arUntil > 0) {
    chips.push({
      kind: "alt_season_revenge",
      title: "МСТИМ ЗА АЛЬТ СЕЗОН",
      status: "Пиксель раз в 1 с — все игроки",
      untilMs: arUntil,
      theme: "alt-revenge",
    });
  }

  if (seismicPreview && typeof seismicPreview.impactAtMs === "number" && seismicPreview.impactAtMs > Date.now()) {
    chips.push({
      kind: "seismic_preview",
      title: "СЕЙСМИКА",
      status: "Скоро удар по карте",
      untilMs: seismicPreview.impactAtMs,
      theme: "seismic",
    });
  }

  const layers = ge?.battleEvents?.layers;
  const sorted = sortLayersForHud(Array.isArray(layers) ? layers : []);
  for (let i = 0; i < sorted.length && chips.length < 6; i++) {
    const L = sorted[i];
    const theme = hudThemeForLayerKind(L);
    chips.push({
      kind: L.kind,
      title: L.title || L.kind,
      status: shortStatusForLayer(L),
      untilMs: Number(L.untilMs),
      theme,
    });
  }

  appendRoundEventHudFallback(chips, ge);

  const sig = JSON.stringify(
    chips.map((c) => [c.kind, c.title, c.untilMs, c.theme])
  );

  if (sig !== lastHudSignature) {
    lastHudSignature = sig;
    if (chips.length === 0) {
      hudDock.hidden = true;
      hudDock.innerHTML = "";
      stopHudTick();
    } else {
      hudDock.hidden = false;
      const parts = [];
      for (let i = 0; i < chips.length; i++) {
        const c = chips[i];
        const g = glyphForHudTheme(c.theme);
        const until = Number(c.untilMs);
        const untilAttr = Number.isFinite(until) ? String(Math.round(until)) : "";
        parts.push(`<div class="event-hud-chip event-hud-chip--${escapeHtml(c.theme)}" role="status">
          <span class="event-hud-chip__glyph" aria-hidden="true">${g}</span>
          <div class="event-hud-chip__main">
            <span class="event-hud-chip__title">${escapeHtml(String(c.title))}</span>
            <span class="event-hud-chip__status">${escapeHtml(String(c.status || ""))}</span>
          </div>
          <span class="event-hud-chip__time" data-until="${escapeHtml(untilAttr)}">${escapeHtml(formatHudTime(until))}</span>
        </div>`);
      }
      hudDock.innerHTML = parts.join("");
      startHudTick(updateHudTimersFromDom);
    }
  } else if (chips.length > 0) {
    updateHudTimersFromDom();
  }

  /* Полоска «финал» под тулбаром — по слою dramatic_pressure, даже если primary = золото. */
  const layersForFinal = ge?.battleEvents?.layers;
  const dramaticLayer = Array.isArray(layersForFinal)
    ? layersForFinal.find((l) => l && l.kind === "dramatic_pressure")
    : null;
  const finalTitle = dramaticLayer?.title ? String(dramaticLayer.title) : ge && ge.title ? String(ge.title) : "";
  const dStyle = dramaticLayer ? String(dramaticLayer.style || "") : "";
  const showFinalStrip = ge && ge.active && dramaticLayer && dramaticLayer.kind === "dramatic_pressure";

  if (finalPressureEl) {
    if (showFinalStrip) {
      finalPressureEl.hidden = false;
      finalPressureEl.classList.toggle(
        "final-pressure-strip--ten",
        dStyle === "final_ten" || /финальн(ые)?\s*10|10\s*минут/i.test(finalTitle) || /FINAL\s*10/i.test(finalTitle)
      );
      const leftBattle = roundEndsAtMs != null ? formatHudTime(roundEndsAtMs) : "—";
      const gap =
        typeof leaderboardHint === "string" && leaderboardHint.trim()
          ? `<span class="final-pressure-strip__gap">${escapeHtml(leaderboardHint.trim())}</span>`
          : "";
      finalPressureEl.innerHTML = `<span class="final-pressure-strip__label">${escapeHtml(finalTitle || "Финальная фаза")}</span>
        <span class="final-pressure-strip__timer">${escapeHtml(leftBattle)}</span>${gap}`;
    } else {
      finalPressureEl.hidden = true;
      finalPressureEl.textContent = "";
    }
  }

  return false;
}

/** Низкий удар тактической бомбы (Web Audio, если доступен в браузере / WebView). */
export function playNukeBombImpactSound() {
  playSting("nuke-bomb");
}
