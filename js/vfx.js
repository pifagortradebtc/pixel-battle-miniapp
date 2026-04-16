/**
 * Лёгкие VFX для карты (canvas) и DOM-подсказок.
 * Координаты эффектов хранятся в пространстве сетки (как карта), каждый кадр
 * проецируются через текущий transform — пан/зум не оставляют «залипших» следов.
 */

const VFX_DEBUG =
  typeof window !== "undefined" &&
  (() => {
    try {
      if (new URLSearchParams(window.location.search).get("vfxdebug") === "1") return true;
      if (typeof localStorage !== "undefined" && localStorage.getItem("pixel-battle-vfxdebug") === "1")
        return true;
    } catch {
      /* ignore */
    }
    return false;
  })();

let vfxDebugFrame = 0;

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createBoardVfx(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: false });

  /** @type {{ t0: number, gx: number, gy: number, color: string }[]} */
  let ripples = [];
  /** @type {{ fx: number, fy: number, vx: number, vy: number, life: number, max: number, color: string, sizeCells: number }[]} */
  let particles = [];
  /** @type {{ t0: number, gx1: number, gy1: number, gx2: number, gy2: number, color: string }[]} */
  let beams = [];
  /** @type {{ t0: number, gcx: number, gcy: number, radiusCells: number, color: string }[]} */
  let shockwaves = [];
  /** @type {{ t0: number, segments: { gx1: number; gy1: number; gx2: number; gy2: number }[] }} */
  let bolts = [];
  /** @type {{ t0: number, gx: number, gy: number, color: string }[]} */
  let shields = [];
  /** @type {{ t0: number, gx: number, gy: number, n: number, color: string }[]} */
  let zoneFlashes = [];
  /** @type {{ t0: number, segments: { gx1: number; gy1: number; gx2: number; gy2: number }[] }[]} */
  let crackBursts = [];

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 200, g: 200, b: 220 };
  }

  function gridToScreen(gx, gy, t) {
    const cell = t.BASE_CELL * t.scale;
    return {
      x: t.offsetX + gx * cell + cell * 0.5,
      y: t.offsetY + gy * cell + cell * 0.5,
      cell,
    };
  }

  function ripple(gx, gy, color, _transform) {
    ripples.push({ t0: performance.now(), gx: gx | 0, gy: gy | 0, color });
  }

  function burst(gx, gy, color, transform, n = 14) {
    const cell = transform.BASE_CELL * transform.scale;
    const { r, g, b } = hexToRgb(color);
    const fx0 = (gx | 0) + 0.5;
    const fy0 = (gy | 0) + 0.5;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = (0.4 + Math.random() * 0.9) * cell * 0.14;
      particles.push({
        fx: fx0,
        fy: fy0,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        max: 380 + Math.random() * 180,
        color: `rgba(${r},${g},${b},0.9)`,
        sizeCells: Math.max(0.06, 0.11 * (0.75 + Math.random() * 0.5)),
      });
    }
  }

  function popPixel(gx, gy, color, transform) {
    ripple(gx, gy, color, transform);
    burst(gx, gy, color, transform, 10);
  }

  const DIR8 = [
    [1, 0],
    [1, -1],
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
  ];

  function lineBeam(gx, gy, dir, color, transform, cells = 5) {
    const { r, g, b } = hexToRgb(color);
    let d;
    if (typeof dir === "number" && dir >= 0 && dir <= 7) {
      d = DIR8[dir | 0];
    } else {
      d =
        dir === "up"
          ? [0, -1]
          : dir === "down"
            ? [0, 1]
            : dir === "left"
              ? [-1, 0]
              : [1, 0];
    }
    const gxi = gx | 0;
    const gyi = gy | 0;
    const gx1 = gxi + 0.5;
    const gy1 = gyi + 0.5;
    const gx2 = gxi + d[0] * (cells - 1) + 0.5;
    const gy2 = gyi + d[1] * (cells - 1) + 0.5;
    beams.push({
      t0: performance.now(),
      gx1,
      gy1,
      gx2,
      gy2,
      color: `rgba(${r},${g},${b},0.95)`,
    });
    for (let i = 0; i < cells; i++) {
      const px = gxi + d[0] * i;
      const py = gyi + d[1] * i;
      ripple(px, py, color, transform);
    }
  }

  /**
   * Молнии в координатах сетки (по всей карте), двигаются вместе с картой.
   * @param {{ offsetX: number, offsetY: number, scale: number, gridW: number, gridH: number, BASE_CELL: number, dpr?: number }} transform
   */
  function lightningBurst(transform) {
    const w = Math.max(1, transform.gridW | 0);
    const h = Math.max(1, transform.gridH | 0);
    const segs = [];
    const n = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const gx1 = Math.random() * w;
      const gy1 = Math.random() * h * 0.35;
      const gx2 = gx1 + (Math.random() - 0.5) * w * 0.4;
      const gy2 = gy1 + h * 0.06 + Math.random() * (h * 0.48);
      segs.push({
        gx1: clamp(gx1, 0, w),
        gy1: clamp(gy1, 0, h),
        gx2: clamp(gx2, 0, w),
        gy2: clamp(gy2, 0, h),
      });
    }
    bolts.push({ t0: performance.now(), segments: segs });
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  function shieldBurst(gx, gy, color, transform) {
    const { r, g, b } = hexToRgb(color);
    shields.push({
      t0: performance.now(),
      gx: gx | 0,
      gy: gy | 0,
      color: `rgba(${r},${g},${b},0.55)`,
    });
    burst(gx, gy, color, transform, 8);
  }

  /**
   * @param {number} [sizeCells] — сторона квадрата в клетках (4 = зона 4×4, 5 = масс-захват 5×5)
   */
  function zoneFlash(gx, gy, color, _transform, sizeCells = 4) {
    const n = Math.max(2, Math.min(16, sizeCells | 0));
    const gxi = gx | 0;
    const gyi = gy | 0;
    const { r, g, b } = hexToRgb(color);
    zoneFlashes.push({
      t0: performance.now(),
      gx: gxi,
      gy: gyi,
      n,
      color: `rgba(${r},${g},${b},${n >= 5 ? 0.28 : 0.35})`,
    });
    shockwaves.push({
      t0: performance.now(),
      gcx: gxi + n * 0.5,
      gcy: gyi + n * 0.5,
      radiusCells: Math.max(1.8, n * 0.58),
      color,
    });
  }

  /** Взрыв + волны при захвате вражеского флага (все клетки команды переходят атакующему). */
  /** Удар по базе: короткий импакт (каждый успешный хит по HP). */
  function flagBaseHitImpact(gx, gy, color, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    ripple(gxi, gyi, color, transform);
    burst(gxi, gyi, color, transform, 11);
  }

  function flagCaptureExplosion(gx, gy, attackerColor, defenderColor, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const ac = typeof attackerColor === "string" && attackerColor.startsWith("#") ? attackerColor : "#66ff99";
    const dc = typeof defenderColor === "string" && defenderColor.startsWith("#") ? defenderColor : "#ff6655";
    /* Меньше частиц — тяжёлый взрыв ломал отрисовку в Telegram WebView (артефакты / «зависание»). */
    burst(gxi, gyi, ac, transform, 22);
    burst(gxi, gyi, dc, transform, 16);
    burst(gxi, gyi, "#ffffff", transform, 12);
    shockwaves.push({
      t0: performance.now(),
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 14,
      color: ac,
    });
    shockwaves.push({
      t0: performance.now() + 70,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 32,
      color: "rgba(255,220,120,0.45)",
    });
    shockwaves.push({
      t0: performance.now() + 160,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 48,
      color: "rgba(255,255,255,0.2)",
    });
    lightningBurst(transform);
  }

  /** Крупный взрыв при уничтожении команды (эпицентр в координатах сетки). */
  function defeatExplosion(gx, gy, color, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const col = typeof color === "string" && color.startsWith("#") ? color : "#ff3344";
    burst(gxi, gyi, col, transform, 62);
    burst(gxi, gyi, "#ffffff", transform, 22);
    burst(gxi, gyi, "#ffee88", transform, 14);
    shockwaves.push({
      t0: performance.now(),
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 7,
      color: col,
    });
    shockwaves.push({
      t0: performance.now() + 50,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 12,
      color: "#ffaa66",
    });
    shockwaves.push({
      t0: performance.now() + 140,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 18,
      color: "rgba(255,80,40,0.45)",
    });
    lightningBurst(transform);
  }

  /**
   * Трещины сейсмики по затронутым клеткам (лёгкие сегменты, без спама).
   * @param {[number, number][]} cells
   */
  function seismicCrackBurst(cells) {
    if (!cells || cells.length === 0) return;
    const now = performance.now();
    const nCells = cells.length;
    const maxSeg = Math.min(56, 10 + (nCells >> 1));
    const segs = [];
    for (let i = 0; i < maxSeg; i++) {
      const c = cells[(Math.random() * nCells) | 0];
      if (!Array.isArray(c) || c.length < 2) continue;
      const gx = (c[0] | 0) + 0.5;
      const gy = (c[1] | 0) + 0.5;
      const ang = Math.random() * Math.PI * 2;
      const len = 0.22 + Math.random() * 1.05;
      segs.push({
        gx1: gx - Math.cos(ang) * len * 0.5,
        gy1: gy - Math.sin(ang) * len * 0.5,
        gx2: gx + Math.cos(ang) * len * 0.5,
        gy2: gy + Math.sin(ang) * len * 0.5,
      });
    }
    if (segs.length) crackBursts.push({ t0: now, segments: segs });
  }

  /**
   * «Ядерный» взрыв: ударная волна, жар, частицы по периметру очистки.
   * @param {number} gcx
   * @param {number} gcy
   * @param {*} transform
   * @param {[number, number][]} cells
   */
  /**
   * Премиум-развёртывание передовой базы 2×2: удар с «орбиты», волны, периметр, трещины по клеткам.
   * @param {number} gx0 левый верх блока (как клик размещения)
   * @param {number} gy0
   * @param {string} teamHex цвет команды #rrggbb
   * @param {*} transform
   */
  function militaryBaseDeploy(gx0, gy0, teamHex, transform) {
    const x0 = gx0 | 0;
    const y0 = gy0 | 0;
    const S = 2;
    const col = typeof teamHex === "string" && teamHex.startsWith("#") ? teamHex : "#a5b4fc";
    const t0 = performance.now();
    const gcx = x0 + S * 0.5;
    const gcy = y0 + S * 0.5;
    shockwaves.push({
      t0,
      gcx,
      gcy,
      radiusCells: 0.95,
      color: "#fffbeb",
    });
    shockwaves.push({
      t0: t0 + 55,
      gcx,
      gcy,
      radiusCells: 1.55,
      color: "#fde68a",
    });
    shockwaves.push({
      t0: t0 + 115,
      gcx,
      gcy,
      radiusCells: 2.35,
      color: col,
    });
    shockwaves.push({
      t0: t0 + 190,
      gcx,
      gcy,
      radiusCells: 3.2,
      color: "rgba(255,255,255,0.42)",
    });
    shockwaves.push({
      t0: t0 + 280,
      gcx,
      gcy,
      radiusCells: 4.2,
      color: "rgba(129, 140, 248, 0.22)",
    });
    zoneFlash(x0, y0, col, transform, S);
    burst(x0 + 1, y0 + 1, "#ffffff", transform, 14);
    burst(x0 + 1, y0 + 1, "#fde68a", transform, 16);
    burst(x0 + 1, y0 + 1, col, transform, 20);
    const corners = [
      [x0, y0],
      [x0 + S - 1, y0],
      [x0, y0 + S - 1],
      [x0 + S - 1, y0 + S - 1],
    ];
    for (let i = 0; i < corners.length; i++) {
      burst(corners[i][0], corners[i][1], "#fff7d6", transform, 8);
      burst(corners[i][0], corners[i][1], col, transform, 9);
    }
    lineBeam(x0 + 1, y0 + 1, "up", "#fde68a", transform, 4);
    for (let d = 1; d < 8; d += 2) {
      lineBeam(x0 + 1, y0 + 1, d, col, transform, 3);
    }
    /** @type {[number, number][]} */
    const cellsBlock = [];
    for (let yy = y0; yy < y0 + S; yy++) {
      for (let xx = x0; xx < x0 + S; xx++) {
        cellsBlock.push([xx, yy]);
      }
    }
    seismicCrackBurst(cellsBlock);
    for (let i = 0; i < cellsBlock.length; i++) {
      const c = cellsBlock[i];
      ripple(c[0], c[1], col, transform);
    }
  }

  /** Постройка Великой стены на одной клетке: камень + цвет команды. */
  function greatWallBuilt(gx, gy, teamHex, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const col = typeof teamHex === "string" && teamHex.startsWith("#") ? teamHex : "#a5b4fc";
    const t0 = performance.now();
    const stone = "#c9b8a0";
    ripple(gxi, gyi, col, transform);
    ripple(gxi, gyi, stone, transform);
    burst(gxi, gyi, "#f5f0e6", transform, 9);
    burst(gxi, gyi, col, transform, 11);
    shockwaves.push({
      t0,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 1.35,
      color: "rgba(255,250,235,0.75)",
    });
    shockwaves.push({
      t0: t0 + 60,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 2.1,
      color: col,
    });
    zoneFlash(gxi, gyi, col, transform, 1);
    seismicCrackBurst([[gxi, gyi]]);
  }

  /** Удар по стене (HP −1): осколки и трещины. */
  function greatWallHit(gx, gy, defenderColor, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const col = typeof defenderColor === "string" && defenderColor.startsWith("#") ? defenderColor : "#888888";
    flagBaseHitImpact(gxi, gyi, col, transform);
    burst(gxi, gyi, "#8b7355", transform, 10);
    burst(gxi, gyi, "#d4c4a8", transform, 7);
    burst(gxi, gyi, "#2a2218", transform, 4);
    seismicCrackBurst([[gxi, gyi]]);
  }

  /** Стена разрушена — клетка сразу у атакующего. */
  function greatWallBreak(gx, gy, attackerColor, defenderColor, transform) {
    const gxi = gx | 0;
    const gyi = gy | 0;
    const ac = typeof attackerColor === "string" && attackerColor.startsWith("#") ? attackerColor : "#66ff99";
    const dc = typeof defenderColor === "string" && defenderColor.startsWith("#") ? defenderColor : "#ff6655";
    const t0 = performance.now();
    burst(gxi, gyi, "#ffffff", transform, 14);
    burst(gxi, gyi, ac, transform, 18);
    burst(gxi, gyi, dc, transform, 12);
    burst(gxi, gyi, "#4a3728", transform, 8);
    shockwaves.push({
      t0,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 3.2,
      color: "rgba(40,32,24,0.55)",
    });
    shockwaves.push({
      t0: t0 + 85,
      gcx: gxi + 0.5,
      gcy: gyi + 0.5,
      radiusCells: 5.5,
      color: ac,
    });
    seismicCrackBurst([[gxi, gyi]]);
    ripple(gxi, gyi, ac, transform);
  }

  function nukeExplosion(gcx, gcy, transform, cells) {
    const gxi = gcx | 0;
    const gyi = gcy | 0;
    const t0 = performance.now();
    const cx = gxi + 0.5;
    const cy = gyi + 0.5;
    const nCells = Array.isArray(cells) ? cells.length : 0;
    const waveSpecs = [
      [0, 2.4, "rgba(255,255,255,0.96)", 0, 0, 1],
      [32, 5.2, "#ff1a00", 0.35, -0.22, 1.04],
      [78, 9.5, "rgba(255,75,25,0.9)", -0.28, 0.31, 0.97],
      [142, 13.5, "rgba(255,145,45,0.68)", 0.42, 0.18, 1.08],
      [215, 17.8, "rgba(255,205,95,0.45)", -0.2, -0.38, 0.94],
      [295, 22.5, "rgba(255,230,180,0.3)", 0.31, 0.27, 1.02],
      [385, 28, "rgba(200,200,220,0.15)", -0.45, 0.12, 1.06],
    ];
    for (let w = 0; w < waveSpecs.length; w++) {
      const [dt, baseR, col, jx, jy, rs] = waveSpecs[w];
      shockwaves.push({
        t0: t0 + dt,
        gcx: cx + jx + (Math.random() - 0.5) * 0.55,
        gcy: cy + jy + (Math.random() - 0.5) * 0.55,
        radiusCells: baseR * rs * (0.94 + Math.random() * 0.1),
        color: col,
      });
    }
    ripple(gxi, gyi, "#ffffff", transform);
    ripple(gxi, gyi, "#ffaa44", transform);
    burst(gxi, gyi, "#ffffff", transform, 18);
    burst(gxi, gyi, "#ffcc22", transform, 26);
    burst(gxi, gyi, "#ff4418", transform, 34);
    const cell = transform.BASE_CELL * transform.scale;
    const seenRipple = new Set();
    const organicFlashes = Math.min(48, Math.max(16, 12 + (nCells >> 1)));
    for (let i = 0; i < organicFlashes; i++) {
      const c = nCells > 0 ? cells[(Math.random() * nCells) | 0] : [gxi, gyi];
      if (!Array.isArray(c) || c.length < 2) continue;
      const bx = c[0] | 0;
      const by = c[1] | 0;
      const k = `${bx},${by}`;
      if (seenRipple.has(k)) continue;
      seenRipple.add(k);
      const hue = i % 4;
      const rc =
        hue === 0 ? "#ff5500" : hue === 1 ? "#ffcc44" : hue === 2 ? "#ff2200" : "#fff4cc";
      ripple(bx, by, rc, transform);
      if (i % 5 === 0) burst(bx, by, "#ffffff", transform, 5);
    }
    const smokeN = Math.min(52, Math.max(18, 12 + (nCells >> 2)));
    for (let i = 0; i < smokeN; i++) {
      const c = nCells > 0 ? cells[(Math.random() * nCells) | 0] : [gxi, gyi];
      if (!Array.isArray(c) || c.length < 2) continue;
      const fx0 = (c[0] | 0) + 0.5 + (Math.random() - 0.5) * 0.65;
      const fy0 = (c[1] | 0) + 0.5 + (Math.random() - 0.5) * 0.65;
      const a = Math.random() * Math.PI * 2;
      const sp = (0.28 + Math.random() * 0.62) * cell * 0.12;
      particles.push({
        fx: fx0,
        fy: fy0,
        vx: Math.cos(a) * sp * 0.92,
        vy: Math.sin(a) * sp * 0.78 - cell * 0.07,
        life: 1,
        max: 480 + Math.random() * 460,
        color: `rgba(${85 + (Math.random() * 75) | 0},${65 + (Math.random() * 55) | 0},${55 + (Math.random() * 45) | 0},0.78)`,
        sizeCells: Math.max(0.09, 0.17 * (0.65 + Math.random() * 0.7)),
      });
    }
    const cap = Math.min(72, Math.max(22, (nCells >> 2) + 20));
    for (let i = 0; i < cap; i++) {
      const c = nCells > 0 ? cells[(Math.random() * nCells) | 0] : [gxi, gyi];
      if (!Array.isArray(c) || c.length < 2) continue;
      const col = i % 3 === 0 ? "#ff2200" : i % 3 === 1 ? "#ffaa33" : "#ffee99";
      burst(c[0] | 0, c[1] | 0, col, transform, 7);
    }
    seismicCrackBurst(cells && cells.length ? cells : [[gxi, gyi]]);
    lightningBurst(transform);
  }

  /**
   * Обвал отрезанной территории: короткие всплески по случайным клеткам + трещины.
   * @param {[number, number][]} cells
   * @param {*} transform
   */
  function territoryIsolationCollapseBurst(cells, transform) {
    if (!cells || cells.length === 0) return;
    const col = "#ff5522";
    const nCells = cells.length;
    const nBurst = Math.min(52, Math.max(10, (nCells >> 2) + 6));
    for (let i = 0; i < nBurst; i++) {
      const c = cells[(Math.random() * nCells) | 0];
      if (!Array.isArray(c) || c.length < 2) continue;
      burst(c[0] | 0, c[1] | 0, col, transform, 9);
    }
    seismicCrackBurst(cells);
  }

  function countActiveVfx() {
    return (
      ripples.length +
      particles.length +
      beams.length +
      shockwaves.length +
      bolts.length +
      shields.length +
      zoneFlashes.length +
      crackBursts.length
    );
  }

  /**
   * Полная очистка bitmap по HTML: присвоение width/height сбрасывает пиксели в прозрачный чёрный
   * и состояние контекста. Надёжнее clearRect+reset() в части WebView/Telegram.
   */
  function resetCanvasBitmapToSize(canvasEl, bw, bh) {
    canvasEl.width = bw;
    canvasEl.height = bh;
  }

  /** Лимиты очередей: при лавине broadcast/оптимистичных VFX не копим сотни слоёв (артефакты в WebView). */
  function enforceVfxCaps() {
    const RIPPLES = 100;
    const PARTICLES = 260;
    const BEAMS = 24;
    const SHOCKS = 26;
    const BOLTS = 3;
    const SHIELDS = 8;
    const ZONES = 8;
    const CRACKS = 4;
    while (ripples.length > RIPPLES) ripples.shift();
    while (particles.length > PARTICLES) particles.shift();
    while (beams.length > BEAMS) beams.shift();
    while (shockwaves.length > SHOCKS) shockwaves.shift();
    while (bolts.length > BOLTS) bolts.shift();
    while (shields.length > SHIELDS) shields.shift();
    while (zoneFlashes.length > ZONES) zoneFlashes.shift();
    while (crackBursts.length > CRACKS) crackBursts.shift();
  }

  function pruneExpiredAndIntegrate(now, cellPx) {
    ripples = ripples.filter((rp) => now - rp.t0 <= 700);

    particles = particles.filter((p) => {
      p.fx += p.vx / cellPx;
      p.fy += p.vy / cellPx;
      p.vy += 0.04;
      p.life -= 16 / p.max;
      return p.life > 0;
    });

    beams = beams.filter((b) => now - b.t0 <= 420);
    shockwaves = shockwaves.filter((sw) => now - sw.t0 <= 900);
    bolts = bolts.filter((b) => now - b.t0 <= 500);
    shields = shields.filter((s) => now - s.t0 <= 900);
    zoneFlashes = zoneFlashes.filter((z) => now - z.t0 <= 500);
    crackBursts = crackBursts.filter((c) => now - c.t0 <= 720);
    enforceVfxCaps();
  }

  function paintActiveEffects(now, transform, cellPx) {
    for (let i = 0; i < ripples.length; i++) {
      const rp = ripples[i];
      const age = now - rp.t0;
      const t = age / 700;
      const { x, y, cell } = gridToScreen(rp.gx, rp.gy, transform);
      const rad = cell * (0.4 + t * 3.2);
      const { r: R, g: G, b: B } = hexToRgb(rp.color.startsWith("#") ? rp.color : "#aabbcc");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.55 * (1 - t)})`;
      ctx.lineWidth = Math.max(1, cell * 0.08 * (1 - t));
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i];
      const sx = transform.offsetX + p.fx * cellPx;
      const sy = transform.offsetY + p.fy * cellPx;
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(p.color);
      ctx.fillStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${p.life})` : p.color;
      const radius = Math.max(0.8, p.sizeCells * cellPx * p.life);
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
    }

    for (let i = 0; i < beams.length; i++) {
      const b = beams[i];
      const age = now - b.t0;
      const t = age / 420;
      const sx1 = transform.offsetX + b.gx1 * cellPx;
      const sy1 = transform.offsetY + b.gy1 * cellPx;
      const sx2 = transform.offsetX + b.gx2 * cellPx;
      const sy2 = transform.offsetY + b.gy2 * cellPx;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = (1 - t) * 5 + 1;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      ctx.shadowBlur = 0;
    }

    for (let i = 0; i < shockwaves.length; i++) {
      const sw = shockwaves[i];
      const age = now - sw.t0;
      const t = age / 900;
      const sx = transform.offsetX + sw.gcx * cellPx;
      const sy = transform.offsetY + sw.gcy * cellPx;
      const maxR = sw.radiusCells * cellPx;
      const rad = maxR * t;
      const { r: R, g: G, b: B } = hexToRgb(sw.color.startsWith("#") ? sw.color : "#ff8866");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.45 * (1 - t)})`;
      ctx.lineWidth = 4 * (1 - t);
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.stroke();
    }

    for (let i = 0; i < bolts.length; i++) {
      const b = bolts[i];
      const age = now - b.t0;
      const fade = 1 - age / 500;
      ctx.strokeStyle = `rgba(200, 230, 255, ${0.85 * fade})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = "#a5d8ff";
      ctx.shadowBlur = 14 * fade;
      for (let j = 0; j < b.segments.length; j++) {
        const s = b.segments[j];
        const sx1 = transform.offsetX + s.gx1 * cellPx;
        const sy1 = transform.offsetY + s.gy1 * cellPx;
        const sx2 = transform.offsetX + s.gx2 * cellPx;
        const sy2 = transform.offsetY + s.gy2 * cellPx;
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
    }

    for (let i = 0; i < shields.length; i++) {
      const s = shields[i];
      const age = now - s.t0;
      const t = age / 900;
      const { x, y, cell } = gridToScreen(s.gx, s.gy, transform);
      const rr = cell * 0.65 * (1 + t * 0.5);
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(s.color);
      ctx.strokeStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${0.5 * (1 - t)})` : s.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let k = 0; k < 6; k++) {
        const a = (k / 6) * Math.PI * 2 + t * 0.8;
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (k === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${0.12 * (1 - t)})` : s.color;
      ctx.fill();
    }

    for (let i = 0; i < zoneFlashes.length; i++) {
      const z = zoneFlashes[i];
      const age = now - z.t0;
      const t = age / 500;
      const x = transform.offsetX + z.gx * cellPx;
      const y = transform.offsetY + z.gy * cellPx;
      const side = cellPx * z.n;
      const zm = /rgba\((\d+),(\d+),(\d+),/.exec(z.color);
      ctx.fillStyle = zm ? `rgba(${zm[1]},${zm[2]},${zm[3]},${0.4 * (1 - t)})` : z.color;
      ctx.fillRect(x, y, side, side);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, side, side);
    }

    for (let i = 0; i < crackBursts.length; i++) {
      const cb = crackBursts[i];
      const age = now - cb.t0;
      const t = age / 720;
      const fade = 1 - t;
      const flash = age < 90 ? 1.15 : 1;
      ctx.lineCap = "round";
      for (let j = 0; j < cb.segments.length; j++) {
        const s = cb.segments[j];
        const sx1 = transform.offsetX + s.gx1 * cellPx;
        const sy1 = transform.offsetY + s.gy1 * cellPx;
        const sx2 = transform.offsetX + s.gx2 * cellPx;
        const sy2 = transform.offsetY + s.gy2 * cellPx;
        ctx.strokeStyle = `rgba(45,32,22,${0.55 * fade * flash})`;
        ctx.lineWidth = Math.max(1, cellPx * 0.07 * fade);
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
        ctx.strokeStyle = `rgba(200,150,100,${0.35 * fade})`;
        ctx.lineWidth = Math.max(0.8, cellPx * 0.04 * fade);
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
      }
    }
  }

  function render(now, transform) {
    const bw = canvas.width | 0;
    const bh = canvas.height | 0;
    const dprGuess = bw / Math.max(1, canvas.clientWidth || bw);
    const dpr =
      typeof transform.dpr === "number" && transform.dpr > 0 ? transform.dpr : dprGuess;

    const cellPx = Math.max(1e-6, (Number(transform.BASE_CELL) || 1) * (Number(transform.scale) || 1));

    const beforePrune = countActiveVfx();
    pruneExpiredAndIntegrate(now, cellPx);
    const afterPrune = countActiveVfx();

    if (bw < 1 || bh < 1) {
      if (VFX_DEBUG) {
        console.log("[vfxdebug] zero bitmap — prune only", { bw, bh, beforePrune, afterPrune });
      }
      return;
    }

    /*
     * Порядок (корректность):
     * 1) prune — истёкшее выкинуто из массивов, частицы сдвинуты в world.
     * 2) canvas.width/height — ПОЛНЫЙ сброс bitmap + состояния ctx (внутренние пиксели, не CSS).
     * 3) setTransform(dpr) — как у #board.
     * 4) отрисовка только оставшихся активных эффектов (world → screen этим кадром).
     */
    resetCanvasBitmapToSize(canvas, bw, bh);

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.filter = "none";
    ctx.imageSmoothingEnabled = false;

    paintActiveEffects(now, transform, cellPx);

    if (VFX_DEBUG) {
      vfxDebugFrame++;
      const logEvery = 30;
      if (vfxDebugFrame % logEvery === 0 || afterPrune > 0) {
        console.log("[vfxdebug] frame", {
          frame: vfxDebugFrame,
          bitmapInternal: `${bw}x${bh}`,
          cssSize: `${canvas.clientWidth}x${canvas.clientHeight}`,
          clear: "reset via canvas.width/height",
          activeBeforePrune: beforePrune,
          activeAfterPrune: afterPrune,
          dpr,
          cam: { ox: transform.offsetX, oy: transform.offsetY, sc: transform.scale },
        });
      }
    }
  }

  function hasWork() {
    return countActiveVfx() > 0;
  }

  return {
    ripple,
    burst,
    popPixel,
    lineBeam,
    lightningBurst,
    shieldBurst,
    zoneFlash,
    defeatExplosion,
    flagBaseHitImpact,
    flagCaptureExplosion,
    seismicCrackBurst,
    nukeExplosion,
    militaryBaseDeploy,
    greatWallBuilt,
    greatWallHit,
    greatWallBreak,
    territoryIsolationCollapseBurst,
    render,
    hasWork,
  };
}

/**
 * @param {HTMLElement} host
 * @param {string} text
 * @param {{ x: number; y: number }} pos — client coords
 * @param {string} [kind]
 */
export function spawnFloatingText(host, text, pos, kind = "") {
  if (!host) return;
  const el = document.createElement("div");
  el.className = `float-fx__pop ${kind}`;
  el.textContent = text;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  host.appendChild(el);
  requestAnimationFrame(() => el.classList.add("float-fx__pop--show"));
  setTimeout(() => {
    el.classList.add("float-fx__pop--out");
    setTimeout(() => el.remove(), 400);
  }, 900);
}

/**
 * Тик дохода квантофермы: компактный +N, подъём и затухание (премиальный «energy» стиль).
 * @param {HTMLElement} host
 * @param {{ x: number; y: number }} pos — client coords (центр фермы на экране)
 * @param {number} amount
 */
export function spawnQuantumFarmIncomeFloat(host, pos, amount) {
  if (!host) return;
  const n = amount | 0;
  if (n < 1) return;
  const el = document.createElement("div");
  el.className = "float-fx__pop float-fx__pop--quant-farm";
  el.textContent = `+${n}`;
  el.style.left = `${pos.x}px`;
  el.style.top = `${pos.y}px`;
  host.appendChild(el);
  requestAnimationFrame(() => {
    requestAnimationFrame(() => el.classList.add("float-fx__pop--show"));
  });
  setTimeout(() => {
    el.classList.add("float-fx__pop--out");
    setTimeout(() => el.remove(), 420);
  }, 880);
}

/**
 * @param {HTMLElement} el
 * @param {number} target
 * @param {number} durationMs
 * @param {(n: number) => string} format
 */
export function animateNumberTo(el, target, durationMs, format) {
  if (!el) return;
  const start = performance.now();
  const from = Number(el.dataset.vfxN || target) || 0;
  el.dataset.vfxN = String(target);
  function frame(now) {
    const t = Math.min(1, (now - start) / durationMs);
    const ease = 1 - (1 - t) * (1 - t);
    const v = Math.round(from + (target - from) * ease);
    el.textContent = format(v);
    if (t < 1) requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
