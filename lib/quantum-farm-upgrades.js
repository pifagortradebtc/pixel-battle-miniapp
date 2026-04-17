/** Уровни квантовых ферм: доход = level квант. / 5 с при контроле и связи. */

export const QUANTUM_FARM_MAX_LEVEL = 4;

/**
 * @param {unknown} raw
 * @returns {number} 1..QUANTUM_FARM_MAX_LEVEL
 */
export function normalizeQuantumFarmLevel(raw) {
  const n = Number(raw) | 0;
  if (n >= 1 && n <= QUANTUM_FARM_MAX_LEVEL) return n;
  return 1;
}

/**
 * Стратегические роли уровней (копирайт UI).
 * @type {Record<number, { name: string; blurb: string }>}
 */
export const QUANTUM_FARM_TIER_META = {
  1: {
    name: "Базовая",
    blurb: "Стартовая точка дохода: +1 квант / 5 с при контроле и связи.",
  },
  2: {
    name: "Ценная",
    blurb: "Сильный экономический актив: +2 кв. / 5 с — за неё стоит бороться.",
  },
  3: {
    name: "Ключевая цель",
    blurb: "+3 кв. / 5 с. Центр экономики; можно улучшить до финального уровня.",
  },
  4: {
    name: "Вершина",
    blurb: "Максимальный доход (+4 кв. / 5 с). Решает темп квантов в матче.",
  },
};

/**
 * @param {unknown} level
 * @returns {{ name: string; blurb: string }}
 */
export function quantumFarmTierMeta(level) {
  const n = normalizeQuantumFarmLevel(level);
  return QUANTUM_FARM_TIER_META[n] ?? QUANTUM_FARM_TIER_META[1];
}

/**
 * Квантов / 5 с с одной фермы при валидном контроле.
 * @param {number} level
 */
export function incomePer5SecFromFarmLevel(level) {
  return normalizeQuantumFarmLevel(level);
}
