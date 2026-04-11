/**
 * Лёгкие VFX для карты (canvas) и DOM-подсказок.
 * Координаты эффектов хранятся в пространстве сетки (как карта), каждый кадр
 * проецируются через текущий transform — пан/зум не оставляют «залипших» следов.
 */

const VFX_DEBUG =
  typeof window !== "undefined" &&
  (() => {
    try {
      return new URLSearchParams(window.location.search).get("vfxdebug") === "1";
    } catch {
      return false;
    }
  })();

/**
 * Сброс состояния 2D-контекста: clip/shadow/composite не должны урезать clearRect.
 */
function hardResetCanvas2DState(c) {
  if (typeof c.reset === "function") {
    c.reset();
    return;
  }
  c.setTransform(1, 0, 0, 1, 0, 0);
  c.globalAlpha = 1;
  c.globalCompositeOperation = "source-over";
  c.shadowBlur = 0;
  c.shadowColor = "transparent";
  c.filter = "none";
  c.strokeStyle = "#000";
  c.fillStyle = "#000";
  c.lineWidth = 1;
  c.setLineDash([]);
  c.beginPath();
}

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

  /**
   * Кадр board-vfx — строгая последовательность (никаких «старых» пикселей между кадрами):
   * 1) Сброс матрицы/состояния контекста.
   * 2) Полная очистка bitmap через clearRect (без composite «copy» — в WebView даёт тёмную пелену на карте).
   * 3) Обновление мира: интеграция частиц + удаление истёкших из массивов (без отрисовки).
   * 4) Матрица DPR для координат в CSS px, как у #board.
   * 5) Отрисовка только текущих активных эффектов: world/grid → screen через камеру transform.
   */
  function wipeBitmapIdentity(ctx2, bw, bh) {
    hardResetCanvas2DState(ctx2);
    ctx2.setTransform(1, 0, 0, 1, 0, 0);
    ctx2.globalCompositeOperation = "source-over";
    ctx2.globalAlpha = 1;
    ctx2.clearRect(0, 0, bw, bh);
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
  }

  function render(now, transform) {
    const bw = canvas.width | 0;
    const bh = canvas.height | 0;
    const dprGuess = bw / Math.max(1, canvas.clientWidth || bw);
    const dpr =
      typeof transform.dpr === "number" && transform.dpr > 0 ? transform.dpr : dprGuess;

    const cellPx = transform.BASE_CELL * transform.scale;

    /* 1–2: identity + полная зачистка bitmap */
    wipeBitmapIdentity(ctx, bw, bh);

    /* 3 + 5: сначала убрать мёртвое и сдвинуть частицы в world; списки — только активные */
    pruneExpiredAndIntegrate(now, cellPx);

    /* 4: матрица отрисовки (логические px карты) */
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.globalCompositeOperation = "source-over";
    ctx.globalAlpha = 1;
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";
    ctx.filter = "none";
    ctx.imageSmoothingEnabled = false;

    /* 5 (продолжение): только активные, world → screen этим кадром */
    paintActiveEffects(now, transform, cellPx);

    if (VFX_DEBUG) {
      const n =
        ripples.length +
        particles.length +
        beams.length +
        shockwaves.length +
        bolts.length +
        shields.length +
        zoneFlashes.length;
      if (n > 0) {
        console.log("[vfxdebug]", {
          active: n,
          bitmap: `${bw}x${bh}`,
          dpr,
          cam: { ox: transform.offsetX, oy: transform.offsetY, sc: transform.scale },
        });
      }
    }
  }

  function hasWork() {
    return (
      ripples.length +
        particles.length +
        beams.length +
        shockwaves.length +
        bolts.length +
        shields.length +
        zoneFlashes.length >
      0
    );
  }

  return {
    ripple,
    burst,
    popPixel,
    lineBeam,
    lightningBurst,
    shieldBurst,
    zoneFlash,
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
