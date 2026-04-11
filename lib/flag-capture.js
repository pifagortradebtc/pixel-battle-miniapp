/** Размер базы 6×6 — совпадает с TEAM_SPAWN_SIZE на сервере. */
export const FLAG_SPAWN_SIZE = 6;

/** Максимум HP базы (и число ударов до состояния «0 HP», затем нужен финальный удар). */
export const FLAG_BASE_MAX_HP = 20;

/** Совместимость со старыми импортами: «20 попаданий» = полное снятие HP + добивание. */
export const FLAG_CAPTURE_HITS_REQUIRED = FLAG_BASE_MAX_HP;

/** После последнего удара столько мс база не регенерирует, затем начинается восстановление. */
export const FLAG_REGEN_IDLE_MS = 30_000;

/** За это время HP плавно возвращается от текущего до максимума. */
export const FLAG_REGEN_DURATION_MS = 30_000;

/**
 * После старта боя (после разминки) должна пройти эта доля длительности раунда,
 * чтобы захват баз был включён.
 */
export const FLAG_CAPTURE_ENABLE_AFTER_BATTLE_FRACTION = 0.15;

/** Максимум событий захвата в секунду на одну атакующую команду (анти-спам). */
export const FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC = 8;

/**
 * Сколько клеток вверх от якоря захвата рисуется полотнище флага (клиент).
 * Игровая логика — только клетка якоря {@link flagCellFromSpawn}.
 */
export const FLAG_VISUAL_CELLS_ABOVE = 3;

/** Пороги предупреждений защитнику (остаток HP после удара). */
export const FLAG_WARN_THRESHOLDS = [15, 10, 5, 1];

/**
 * Текущее эффективное HP (может быть дробным во время регенерации).
 * @param {{ hp: number, lastHitAt: number } | null | undefined} state
 * @param {number} now
 */
export function computeEffectiveBaseHp(state, now) {
  if (!state) return FLAG_BASE_MAX_HP;
  const h0 = Math.min(FLAG_BASE_MAX_HP, Math.max(0, state.hp | 0));
  const tHit = state.lastHitAt | 0;
  const idleEnd = tHit + FLAG_REGEN_IDLE_MS;
  if (now < idleEnd) return h0;
  const regenElapsed = now - idleEnd;
  if (regenElapsed >= FLAG_REGEN_DURATION_MS) return FLAG_BASE_MAX_HP;
  const u = regenElapsed / FLAG_REGEN_DURATION_MS;
  return h0 + (FLAG_BASE_MAX_HP - h0) * u;
}

/**
 * Координаты клетки флага (центр базы 6×6), те же что destroyGx на сервере.
 * @param {number} spawnX0
 * @param {number} spawnY0
 */
export function flagCellFromSpawn(spawnX0, spawnY0) {
  const ox = spawnX0 | 0;
  const oy = spawnY0 | 0;
  return {
    x: ox + Math.floor(FLAG_SPAWN_SIZE / 2),
    y: oy + Math.floor(FLAG_SPAWN_SIZE / 2),
  };
}
