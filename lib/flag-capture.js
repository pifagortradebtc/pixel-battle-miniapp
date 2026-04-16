/** Размер главной стартовой базы 6×6 — совпадает с TEAM_SPAWN_SIZE на сервере. */
export const FLAG_SPAWN_SIZE = 6;

/** Передовая база (плацдарм из магазина): квадрат 2×2, якорь — левый верх. */
export const MILITARY_OUTPOST_SIZE = 2;

/** HP главной базы 6×6 (стартовая). */
export const FLAG_MAIN_BASE_MAX_HP = 50;

/** HP передовой базы / плацдарма из магазина (общий пул на весь 2×2). */
export const FLAG_BASE_MAX_HP = 20;

/** Для текстов «сколько попаданий до захвата» главной базы (полное снятие HP + добивание). */
export const FLAG_CAPTURE_HITS_REQUIRED = FLAG_MAIN_BASE_MAX_HP;

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
export const FLAG_VISUAL_CELLS_ABOVE = 5;

/** Пороги предупреждений защитнику — плацдарм 20 HP. */
export const FLAG_WARN_THRESHOLDS = [15, 10, 5, 1];

/** Пороги предупреждений — главная база 50 HP. */
export const FLAG_WARN_THRESHOLDS_MAIN = [40, 30, 20, 10, 5, 1];

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
 * @param {number} [maxHp] по умолчанию {@link FLAG_BASE_MAX_HP} (плацдарм); главная база — {@link FLAG_MAIN_BASE_MAX_HP}
 */
export function computeEffectiveBaseHp(state, now, maxHp = FLAG_BASE_MAX_HP) {
  const cap = Math.max(1, maxHp | 0);
  if (!state) return cap;
  const h0 = Math.min(cap, Math.max(0, state.hp | 0));
  if (h0 >= cap) return cap;
  const tHit = toEpochMsSafe(state.lastHitAt);
  if (!Number.isFinite(tHit) || tHit < FLAG_CAPTURE_MIN_VALID_LAST_HIT_MS) return h0;
  const idleEnd = tHit + FLAG_REGEN_IDLE_MS;
  if (now < idleEnd) return h0;
  const regenElapsed = now - idleEnd;
  if (regenElapsed >= FLAG_REGEN_DURATION_MS) return cap;
  const u = regenElapsed / FLAG_REGEN_DURATION_MS;
  return h0 + (cap - h0) * u;
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

/**
 * Клетка якоря UI / снимка HP плацдарма 2×2: левый верх (совпадает с кликом размещения).
 * Удар по любой из 4 клеток блока идёт в тот же пул HP (см. resolveFlagBaseAtCell на сервере).
 */
export function flagCellFromMilitaryOutpost(outpostX0, outpostY0) {
  return { x: outpostX0 | 0, y: outpostY0 | 0 };
}
