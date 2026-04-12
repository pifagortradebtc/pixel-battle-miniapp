/**
 * Премиальная презентация live-событий: кинематические баннеры, док HUD, классы атмосферы.
 * Не смешивать с игровой логикой — только отображение и лёгкие audio-sting.
 */

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

/** @type {{ title: string; subtitle: string; theme: string; holdMs?: number; sound?: string; kicker?: string }[]} */
const cinematicQueue = [];
let cinematicPlaying = false;

/** @type {AudioContext | null} */
let audioCtx = null;

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
 * @param {"sine"|"triangle"|"square"|"sawtooth"} type
 * @param {number} f0
 * @param {number} f1
 * @param {number} peakGain
 * @param {number} durSec
 * @param {GainNode} master
 * @param {number} now
 */
function playOscThrough(type, f0, f1, peakGain, durSec, master, now) {
  if (!audioCtx) return;
  const osc = audioCtx.createOscillator();
  osc.type = type;
  const g = audioCtx.createGain();
  g.gain.setValueAtTime(0.0001, now);
  g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peakGain), now + 0.018);
  g.gain.exponentialRampToValueAtTime(0.0001, now + durSec);
  osc.frequency.setValueAtTime(f0, now);
  if (f1 !== f0) {
    if (type === "triangle" || type === "sine")
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), now + durSec * 0.92);
    else osc.frequency.linearRampToValueAtTime(f1, now + durSec * 0.85);
  }
  osc.connect(g);
  g.connect(master);
  osc.start(now);
  osc.stop(now + durSec + 0.04);
}

function playSting(kind) {
  try {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) return;
    if (!audioCtx) audioCtx = new Ctx();
    if (audioCtx.state === "suspended") void audioCtx.resume();

    const now = audioCtx.currentTime;
    const master = audioCtx.createGain();
    const epic = kind === "base_captured" || kind === "final-ten";
    const tail = epic ? 0.58 : 0.44;
    master.gain.setValueAtTime(0.0001, now);
    master.gain.exponentialRampToValueAtTime(epic ? 0.28 : 0.22, now + 0.024);
    master.gain.exponentialRampToValueAtTime(0.0001, now + tail);
    master.connect(audioCtx.destination);

    if (kind === "base_captured") {
      playOscThrough("triangle", 95, 42, 0.14, 0.52, master, now);
      playOscThrough("sine", 190, 95, 0.07, 0.38, master, now + 0.04);
      playOscThrough("square", 380, 190, 0.04, 0.12, master, now + 0.12);
      return;
    }
    if (kind === "final-ten") {
      playOscThrough("sine", 196, 392, 0.11, 0.42, master, now);
      playOscThrough("sine", 293.66, 440, 0.06, 0.36, master, now + 0.05);
      return;
    }

    if (kind === "gold" || kind === "center") {
      playOscThrough("sine", 880, 1320, 0.12, 0.32, master, now);
    } else if (kind === "seismic" || kind === "seismic-incoming") {
      playOscThrough("triangle", 58, 26, 0.14, 0.4, master, now);
    } else if (kind === "compression" || kind === "final-phase") {
      playOscThrough("sawtooth", 110, 168, 0.1, 0.34, master, now);
    } else if (kind === "economic" || kind === "boom" || kind === "recession") {
      playOscThrough("square", 330, 440, 0.1, 0.28, master, now);
    } else if (kind === "dramatic") {
      playOscThrough("sine", 220, 660, 0.1, 0.36, master, now);
    } else {
      playOscThrough("sine", 523, 784, 0.1, 0.3, master, now);
    }
  } catch {
    /* ignore */
  }
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
      theme === "compression"
    )
      h.impactOccurred("medium");
    else h.impactOccurred("light");
  } catch {
    /* ignore */
  }
}

function runCinematic(spec, done) {
  if (!cinematicRoot || !cinematicPanel || !cinematicTitleEl || !cinematicSubEl) {
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
  else if (theme === "seismic-incoming" || theme === "dramatic" || theme === "final-phase")
    cinematicRoot.dataset.tier = "high";
  else cinematicRoot.dataset.tier = "standard";

  cinematicRoot.hidden = false;
  cinematicRoot.classList.remove("cinematic-event--visible", "cinematic-event--out");
  void cinematicRoot.offsetWidth;

  requestAnimationFrame(() => {
    cinematicRoot.classList.add("cinematic-event--visible");
    triggerCinematicHaptic(theme);
  });

  if (spec.sound) playSting(spec.sound);

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
 * @param {{ title: string; subtitle?: string; theme?: string; holdMs?: number; sound?: string; kicker?: string }} spec
 */
export function enqueueBattleCinematic(spec) {
  cinematicQueue.push({
    title: spec.title,
    subtitle: spec.subtitle || "",
    theme: spec.theme || "default",
    holdMs: spec.holdMs,
    sound: spec.sound || spec.theme || "default",
    kicker: spec.kicker,
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
 * WebSocket: roundEvent phase start.
 * @param {{ phase?: string; eventId?: string; eventType?: string; title?: string; subtitle?: string }} msg
 */
export function notifyRoundEventFromServer(msg) {
  if (!msg || msg.phase !== "start" || !msg.eventId) return;
  /* Полноэкранная заставка отключена: таймер в верхней плашке и боковом HUD; зоны на карте. */
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
  /* Без полноэкранки — верхний баннер, боковой HUD и подсветка зон задаются в main.js. */
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
 * Синхронизация дока HUD и атмосферы. Всегда оставляет верхний #event-banner видимым для таймера основного события.
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

  /** @type {object[]} */
  const chips = [];

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
  for (let i = 0; i < sorted.length && chips.length < 4; i++) {
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

  /* Верхний event-banner не скрываем: там остаётся таймер основного события; боковой HUD дублирует список активных слоёв. */
  return false;
}
