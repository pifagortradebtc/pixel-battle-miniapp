/**
 * Органическая область тактической бомбы: охват порядка 12×12, неровный «кратер»,
 * форма меняется от точки удара. Детерминированно от (cx, cy, roundIndex).
 */

/**
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
  const bound = 9;
  const cxf = cx | 0;
  const cyf = cy | 0;
  const phaseA = rng() * Math.PI * 2;
  const phaseB = rng() * Math.PI * 2;
  const phaseC = rng() * Math.PI * 2;
  const baseR = 5.25 + rng() * 1.05;

  for (let dy = -bound; dy <= bound; dy++) {
    for (let dx = -bound; dx <= bound; dx++) {
      const x = cxf + dx;
      const y = cyf + dy;
      if (x < 0 || x >= gridW || y < 0 || y >= gridH) continue;
      if (!isPlayable(x, y)) continue;
      if (isProtectedSpawn(x, y)) continue;

      const d2 = dx * dx + dy * dy;
      const ang = Math.atan2(dy, dx);
      const wobble =
        1 +
        0.16 * Math.sin(ang * 3 + phaseA) +
        0.12 * Math.cos(ang * 5 + phaseB) +
        0.09 * Math.sin(ang * 7 + phaseC) +
        (rng() - 0.5) * 0.14;
      const maxR = baseR * Math.max(0.75, wobble);
      const maxR2 = maxR * maxR;
      if (d2 > maxR2) continue;
      const edge01 = d2 / maxR2;
      if (edge01 > 0.62 && rng() > 0.32 + (1 - edge01) * 2.8) continue;

      const k = `${x},${y}`;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push([x, y]);
    }
  }
  return out;
}
