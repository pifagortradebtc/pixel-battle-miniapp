/** Размер базы 6×6 — совпадает с TEAM_SPAWN_SIZE на сервере. */
export const FLAG_SPAWN_SIZE = 6;

/** Успешных «ударов» по клетке флага для захвата. */
export const FLAG_CAPTURE_HITS_REQUIRED = 20;

/** Без валидных ударов столько мс — начинается затухание прогресса. */
export const FLAG_CAPTURE_IDLE_MS = 60_000;

/** Шаг затухания: −1 прогресс каждые N мс. */
export const FLAG_CAPTURE_DECAY_STEP_MS = 3_000;

/**
 * После старта боя (после разминки) должна пройти эта доля длительности раунда,
 * чтобы захват флагов был включён (середина/конец фазы).
 */
export const FLAG_CAPTURE_ENABLE_AFTER_BATTLE_FRACTION = 0.15;

/** Максимум событий захвата в секунду на одну атакующую команду (анти-спам). */
export const FLAG_CAPTURE_MAX_HITS_PER_TEAM_PER_SEC = 8;

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
