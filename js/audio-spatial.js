/**
 * Позиционный микс: громкость от расстояния до центра камеры (клетки карты).
 * Цель — «поле боя»: не слышно весь мир, только окрестность камеры + редкие глобальные события.
 * Оценка только в момент триггера звука.
 */

/** Слышимость чужих событий: узкий радиус ≈ локальный бой */
export const SPATIAL_MAX_RADIUS_CELLS = 18;

/** Минимальный множитель, ниже — не воспроизводим */
export const SPATIAL_MIN_AUDIBLE = 0.024;

/** Крутизна спада за пределами «ближней зоны» (больше = тише на средней дистанции) */
const FALLOFF_STEEPNESS = 1.55;

/** @typedef {{ scope: "personal" | "global" | "local"; gx?: number; gy?: number; weight?: number }} SpatialSpec */

/** @type {() => { gx: number; gy: number }} */
let listenerProvider = () => ({ gx: 0, gy: 0 });

/** Якорь для «мировых» стингов без координаты (центр карты) — далеко от центра слышно слабее */
/** @type {() => { gx: number; gy: number }} */
let ambientAnchorProvider = () => ({ gx: 0, gy: 0 });

/**
 * Центр видимой области (камера).
 * @param {() => { gx: number; gy: number }} fn
 */
export function registerSpatialAudioListener(fn) {
  listenerProvider = fn;
}

/**
 * Центр карты для второстепенных киностингов (экономика, золото и т.д.) — не «слышно везде».
 * @param {() => { gx: number; gy: number }} fn
 */
export function registerSpatialAmbientAnchor(fn) {
  ambientAnchorProvider = fn;
}

/**
 * @param {SpatialSpec | null | undefined} spec
 * @returns {number} множитель для peak; 0 = не играть
 */
export function resolveSpatialMul(spec) {
  if (spec == null) return 1;
  const w =
    spec.weight != null && Number.isFinite(spec.weight)
      ? Math.max(0.06, Math.min(1.35, spec.weight))
      : 1;
  if (spec.scope === "personal" || spec.scope === "global") {
    return Math.min(1.15, w);
  }
  if (spec.scope !== "local") return Math.min(1.15, w);

  const gx = spec.gx;
  const gy = spec.gy;
  if (!Number.isFinite(gx) || !Number.isFinite(gy)) return 0;

  let L;
  try {
    L = listenerProvider();
  } catch {
    L = { gx: 0, gy: 0 };
  }
  if (!L || !Number.isFinite(L.gx) || !Number.isFinite(L.gy)) return Math.min(1.05, w * 0.85);

  const d = Math.hypot(L.gx - gx, L.gy - gy);
  if (d >= SPATIAL_MAX_RADIUS_CELLS) return 0;

  const t = d / SPATIAL_MAX_RADIUS_CELLS;
  const quad = 1 - t * t;
  const falloff = Math.pow(Math.max(0, quad), FALLOFF_STEEPNESS);
  return Math.min(1.15, Math.max(0, falloff * w));
}

/**
 * Только крупные события — одинаково слышны всем (бомба, захват базы, финал, предупреждение о сейсмике, плацдарм).
 * Не включать сюда «фоновые» киностинги раунда — они идут через ambient + local.
 */
export function presentationKindIsGlobal(kind) {
  const k = String(kind || "");
  return (
    k === "nuke-bomb" ||
    k === "base_captured" ||
    k === "final-ten" ||
    k === "seismic-incoming" ||
    k === "military_base"
  );
}

export function presentationKindIsTerritoryZone(kind) {
  const k = String(kind || "");
  return k === "territory_4" || k === "territory_6" || k === "territory_12";
}

function minorPresentationWeight(kind) {
  const k = String(kind || "");
  /** @type {Record<string, number>} */
  const m = {
    default: 0.36,
    gold: 0.42,
    center: 0.42,
    compression: 0.46,
    "final-phase": 0.52,
    economic: 0.38,
    "economic-dual": 0.38,
    boom: 0.4,
    recession: 0.38,
    dramatic: 0.46,
    synergy: 0.36,
    seismic: 0.4,
    "alt-revenge": 0.42,
  };
  return m[k] ?? 0.4;
}

/**
 * @param {string} kind
 * @param {SpatialSpec | null | undefined} explicit
 * @returns {SpatialSpec | null}
 */
export function resolvePresentationSpatial(kind, explicit) {
  if (explicit && typeof explicit === "object" && explicit.scope) return explicit;
  const k = String(kind || "");

  if (presentationKindIsGlobal(k)) {
    return { scope: "global", weight: 1 };
  }

  let anchor;
  try {
    anchor = ambientAnchorProvider();
  } catch {
    anchor = { gx: 0, gy: 0 };
  }
  if (!anchor || !Number.isFinite(anchor.gx) || !Number.isFinite(anchor.gy)) {
    return { scope: "local", gx: 0, gy: 0, weight: 0.32 };
  }

  if (presentationKindIsTerritoryZone(k)) {
    return { scope: "local", gx: anchor.gx, gy: anchor.gy, weight: 0.4 };
  }

  return {
    scope: "local",
    gx: anchor.gx,
    gy: anchor.gy,
    weight: minorPresentationWeight(k),
  };
}
