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
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const chroma = maxc - minc;

  /* Фиолет / лаванда / магента: и R, и B высокие — не открытый океан */
  if (r > 78 && b > 85 && r > g + 4 && b > g + 6 && Math.abs(r - b) < 100) {
    return false;
  }
  /* Розовый лёд: сильный R, B не доминирует над R */
  if (r > 95 && r >= b - 40 && g < Math.min(r, b) - 8) {
    return false;
  }

  /*
   * Светлый пастельный циан между горами на стилизованном плакате — не открытый океан
   * (иначе суша выглядит как вода; игроки не должны «тонуть» визуально в суше).
   */
  if (lum > 105 && lum < 248 && minc > 55 && chroma < 125 && b > 115 && b > r + 32 && b > g + 26) {
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
  if (lum > 115) {
    if (r > 88 && b < r + 42) return false;
    return b > r + 42 && b > g + 36;
  }

  if (b > 135 && b > r + 14 && b > g + 10) return true;
  if (b > 100 && b > r + 28 && b > g + 20) return true;
  if (b === maxc && b > 88 && b > r + 6 && b > g + 4 && r + g < b + 75) return true;
  return false;
}

/** 8-соседство — как у территории на доске. */
const ENCLOSED_FILL_DELTAS8 = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, 1],
  [1, -1],
  [-1, 1],
  [-1, -1],
];

/**
 * После пороговой классификации «вода» часть клеток 0 может оказаться **внутри** суши
 * (закрытый залив / шум на низком разрешении) и не соединена с океаном с края карты.
 * Тогда игроки видят «остров» территории в «море», хотя на плакате там полуостров / суша.
 *
 * Помечаем как океан всю воду, достижимую с границы сетки через цепочку клеток `cells[i]===0`
 * (8-соседи). Оставшиеся нули — «запертая вода» — переводим в сушу (`2`).
 *
 * @param {Uint8Array} cells in-place, значения как в regions: 0 = вода, иначе суша/регион
 * @param {number} w
 * @param {number} h
 * @returns {number} сколько клеток перевели из воды в сушу
 */
export function fillEnclosedWaterAsLand(cells, w, h) {
  const n = w * h;
  if (n <= 0 || cells.length < n) return 0;
  const ocean = new Uint8Array(n);
  const q = [];

  const pushBorderWater = (i) => {
    if (i < 0 || i >= n || cells[i] !== 0 || ocean[i]) return;
    ocean[i] = 1;
    q.push(i);
  };

  for (let x = 0; x < w; x++) {
    pushBorderWater(x);
    pushBorderWater((h - 1) * w + x);
  }
  for (let y = 1; y < h - 1; y++) {
    pushBorderWater(y * w);
    pushBorderWater(y * w + (w - 1));
  }

  for (let qi = 0; qi < q.length; qi++) {
    const i = q[qi];
    const x = i % w;
    const y = Math.floor(i / w);
    for (let k = 0; k < ENCLOSED_FILL_DELTAS8.length; k++) {
      const nx = x + ENCLOSED_FILL_DELTAS8[k][0];
      const ny = y + ENCLOSED_FILL_DELTAS8[k][1];
      if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
      const ni = ny * w + nx;
      if (cells[ni] !== 0 || ocean[ni]) continue;
      ocean[ni] = 1;
      q.push(ni);
    }
  }

  let filled = 0;
  for (let i = 0; i < n; i++) {
    if (cells[i] === 0 && !ocean[i]) {
      cells[i] = 2;
      filled++;
    }
  }
  return filled;
}

/**
 * Клетка уже суша по маске, но RGB даёт «воду» / мелководье между горами.
 * Очень тёмные (lum ниже ~68) не трогаем — типичный силуэт гор на плакате.
 */
function shouldSoftenLandSeaLikeRgb(r, g, b) {
  const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  const maxc = Math.max(r, g, b);
  const minc = Math.min(r, g, b);
  const chroma = maxc - minc;
  if (b !== maxc) return false;

  /* Светлый пастельный циан */
  if (lum >= 90 && lum <= 252 && b >= 100 && b >= r + 20 && b >= g + 14 && chroma >= 28) {
    return true;
  }

  /* Средняя яркость: «шельф» / насыщенный голубой на суше (не чёрные вершины) */
  if (lum >= 68 && lum <= 210 && b >= 92 && b >= r + 10 && b >= g + 6 && chroma >= 22 && chroma <= 168) {
    return true;
  }

  return false;
}

/**
 * Клетки уже суша (`cells[i] !== 0`), но RGB плаката — бледный океанский циан; визуально «вода между горами».
 * Подтягиваем цвет к среднему по соседям-сухопутьям (не-пастель) или к приглушённой земле.
 *
 * @param {Uint8Array} cells
 * @param {Uint8Array} rgb in/out RGB888
 * @param {number} w
 * @param {number} h
 * @param {number} [passes]
 * @returns {number} сколько раз записали клетку (сумма по проходам)
 */
export function softenPastelOceanLandRgb(cells, rgb, w, h, passes = 3) {
  const n = w * h;
  const deltas = ENCLOSED_FILL_DELTAS8;
  let updates = 0;
  for (let pass = 0; pass < passes; pass++) {
    const src = Uint8Array.from(rgb);
    const need = new Uint8Array(n);
    for (let i = 0; i < n; i++) {
      if (cells[i] === 0) continue;
      const o = i * 3;
      if (shouldSoftenLandSeaLikeRgb(src[o], src[o + 1], src[o + 2])) need[i] = 1;
    }
    for (let i = 0; i < n; i++) {
      if (!need[i]) continue;
      const x = i % w;
      const y = Math.floor(i / w);
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let c = 0;
      for (let k = 0; k < deltas.length; k++) {
        const nx = x + deltas[k][0];
        const ny = y + deltas[k][1];
        if (nx < 0 || nx >= w || ny < 0 || ny >= h) continue;
        const ni = ny * w + nx;
        if (cells[ni] === 0) continue;
        const no = ni * 3;
        if (shouldSoftenLandSeaLikeRgb(src[no], src[no + 1], src[no + 2])) continue;
        sr += src[no];
        sg += src[no + 1];
        sb += src[no + 2];
        c++;
      }
      const o = i * 3;
      if (c >= 2) {
        rgb[o] = Math.min(255, Math.round(sr / c));
        rgb[o + 1] = Math.min(255, Math.round(sg / c));
        rgb[o + 2] = Math.min(255, Math.round(sb / c));
        updates++;
      } else if (c === 1) {
        rgb[o] = Math.min(255, sr | 0);
        rgb[o + 1] = Math.min(255, sg | 0);
        rgb[o + 2] = Math.min(255, sb | 0);
        updates++;
      } else {
        const r0 = src[o];
        const g0 = src[o + 1];
        const b0 = src[o + 2];
        const anchor = (r0 + g0) * 0.5;
        rgb[o] = Math.min(255, Math.round(r0 * 0.75 + anchor * 0.15 + 18));
        rgb[o + 1] = Math.min(255, Math.round(g0 * 0.78 + anchor * 0.12 + 15));
        rgb[o + 2] = Math.max(0, Math.min(255, Math.round(b0 * 0.55 + anchor * 0.35)));
        updates++;
      }
    }
  }
  return updates;
}
