/**
 * Хаотичная область «ядерной бомбы»: охват порядка 12×12 клеток, край неровный.
 * Детерминированно от (cx, cy, roundIndex) — одинаково на сервере и клиенте.
 *
 * @param {number} cx
 * @param {number} cy
 * @param {number} roundIndex
 * @param {number} gridW
 * @param {number} gridH
 * @param {(x: number, y: number) => boolean} isPlayable
 * @param {(x: number, y: number) => boolean} isProtectedSpawn
 * @returns {[number, number][]}
 */
export function computeNukeBombBlastCells(cx, cy, roundIndex, gridW, gridH, isPlayable, isProtectedSpawn) {
  let seed =
    ((((cx | 0) ^ 0x13579bdf) * 2246822519) ^ (((cy | 0) ^ 0x2468ace0) * 3266489917) ^ ((roundIndex | 0) * 668265263)) >>>
    0;
  if (seed === 0) seed = 0xf1ea5eed;
  function rng() {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 4294967296;
  }
  /** @type {[number, number][]} */
  const out = [];
  const seen = new Set();
  const bound = 8;
  const baseR2 = 34;
  for (let dy = -bound; dy <= bound; dy++) {
    for (let dx = -bound; dx <= bound; dx++) {
      const x = (cx | 0) + dx;
      const y = (cy | 0) + dy;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
      if (!isPlayable(x, y)) continue;
      if (isProtectedSpawn(x, y)) continue;
      const d2 = dx * dx + dy * dy;
      const jagged = (rng() - 0.5) * 24;
      if (d2 > baseR2 + 12 + jagged) continue;
      if (d2 > baseR2 - 8 + jagged && rng() > 0.42) continue;
      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([x, y]);
    }
  }
  return out;
}
