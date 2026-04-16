/** Great Wall — укреплённая клетка: 3 HP, без регенерации, сносится за 3 удара врага. */

export const GREAT_WALL_MAX_HP = 3;

/**
 * @param {unknown} raw
 * @returns {number} 0 или 1..GREAT_WALL_MAX_HP
 */
export function normalizeWallHp(raw) {
  const n = Number(raw) | 0;
  if (n >= 1 && n <= GREAT_WALL_MAX_HP) return n;
  return 0;
}
