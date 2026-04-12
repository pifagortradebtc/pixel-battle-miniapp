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
 * Минимальный правдоподобный `lastHitAt` (мс с epoch). Ниже — битое значение (0 из снапшота, мусор):
 * иначе `idleEnd` оказывается ~1970 и «реген завершён» → eff=MAX → каждый удар снова 20→19.
 */
export const FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS = 1_000_000_000_000;

/**
 * Целые мс epoch для `lastHitAt` и дедлайнов. Не использовать `x | 0` — в JS это int32 и ломает 2025+.
 * @param {unknown} v
 * @returns {number}
 */
export function toEpochMsSafe(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : NaN;
}

/**
 * Текущее эффективное HP (может быть дробным во время регенерации).
 * `state.hp` — целое после последнего удара (нижний якорь); при регене не подменяйте его на floor(eff),
 * иначе интерполяция по `lastHitAt` сломается (сервер/мета шлют именно якорь).
 *
 * @param {{ hp: number, lastHitAt: number } | null | undefined} state
 * @param {number} now
 */
export function computeEffectiveBaseHp(state, now) {
  if (!state) return FLAG_BASE_MAX_HP;
  const h0 = Math.min(FLAG_BASE_MAX_HP, Math.max(0, state.hp | 0));
  if (h0 >= FLAG_BASE_MAX_HP) return FLAG_BASE_MAX_HP;
  const tHit = toEpochMsSafe(state.lastHitAt);
  if (!Number.isFinite(tHit) || tHit < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) return h0;
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
