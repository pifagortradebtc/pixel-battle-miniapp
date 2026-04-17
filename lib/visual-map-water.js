/**
 * «Вода» по цвету плаката карты (RGB из regions-*.json), визуально совпадает с океаном на скриншоте.
 * Та же логика, что classifyWater в scripts/_oneoff-water-overlay.mjs.
 *
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {boolean}
 */
export function isPosterOceanWaterRgb(r, g, b) {
  if (r > 210 && g > 210 && b > 210) return false;
  if (g > r + 35 && g > b + 25 && r < 140) return false;
  if (r > g + 40 && r > b + 15 && g < 200) return false;
  if (r > 100 && g > 60 && g < 160 && b < 110 && r > b) return false;
  if (b > 75 && b >= r - 5 && b > g + 5) {
    if (r > 140 && g > 100 && b > 140 && r + g + b > 400) return false;
    return true;
  }
  return false;
}
