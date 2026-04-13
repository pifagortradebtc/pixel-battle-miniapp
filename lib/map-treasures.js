/**
 * Случайная раскладка «кладов» по играбельным клеткам карты (кванты 1..50 на клетку).
 */

/**
 * @param {Uint8Array} playableGrid
 * @param {number} gridW
 * @param {number} gridH
 * @param {number} targetCount
 * @returns {Map<string, number>} ключ "x,y" → кванты
 */
export function buildRandomTreasureMap(playableGrid, gridW, gridH, targetCount) {
  const map = new Map();
  if (!playableGrid || playableGrid.length !== gridW * gridH || targetCount <= 0) return map;

  const indices = [];
  for (let i = 0; i < playableGrid.length; i++) {
    if (playableGrid[i]) indices.push(i);
  }
  const nPlay = indices.length;
  if (nPlay === 0) return map;

  for (let i = nPlay - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = indices[i];
    indices[i] = indices[j];
    indices[j] = t;
  }

  const pick = Math.min(Math.max(1, targetCount | 0), nPlay);
  for (let k = 0; k < pick; k++) {
    const idx = indices[k];
    const x = idx % gridW;
    const y = (idx / gridW) | 0;
    const q = (Math.floor(Math.random() * 50) + 1) | 0;
    map.set(`${x},${y}`, q);
  }
  return map;
}
