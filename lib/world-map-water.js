/**
 * Классификация пикселя исходной карты: вода vs суша (для regions-*.json).
 * Океан — выраженный синий перевес; лёд/кристаллы/фиолетово-розовые биомы — суша.
 */

const DEFAULT_ALPHA_CUTOFF = 24;

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @param {number} a
 * @param {number} [alphaCutoff]
 * @returns {boolean} true = вода (клетка неигровая)
 */
export function isWorldMapWaterPixel(r, g, b, a, alphaCutoff = DEFAULT_ALPHA_CUTOFF) {
  if (a < alphaCutoff) return true;
  const maxc = Math.max(r, g, b);
  const mr = Math.max(r, g);
  const minc = Math.min(r, g, b);

  /* Фиолет / лаванда / магента: и R, и B высокие — не открытый океан */
  if (r > 78 && b > 85 && r > g + 4 && b > g + 6 && Math.abs(r - b) < 100) {
    return false;
  }
  /* Розовый лёд: сильный R, B не доминирует над R */
  if (r > 95 && r >= b - 40 && g < Math.min(r, b) - 8) {
    return false;
  }

  /* Почти чёрное / очень тёмное: вода только при явном синем перевесе */
  if (maxc < 56) {
    if (b >= r && b >= g && b - mr >= 2) return true;
    return false;
  }

  /* Светлые пастели и «кристаллы»: нужен сильный перевес B над R и G (типичный океан — тёмнее) */
  if (minc >= 68) {
    return b > r + 56 && b > g + 50;
  }

  /* Средняя яркость: синий океан, но не сиренево-розовые смеси */
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  if (lum > 115) {
    if (r > 88 && b < r + 42) return false;
    return b > r + 42 && b > g + 36;
  }

  if (b > 135 && b > r + 14 && b > g + 10) return true;
  if (b > 100 && b > r + 28 && b > g + 20) return true;
  if (b === maxc && b > 88 && b > r + 6 && b > g + 4 && r + g < b + 75) return true;
  return false;
}
