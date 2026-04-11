/**
 * Лёгкие VFX для карты (canvas) и DOM-подсказок.
 * Координаты эффектов хранятся в пространстве сетки (как карта), каждый кадр
 * проецируются через текущий transform — пан/зум не оставляют «залипших» следов.
 */

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
   * @param {{ offsetX: number, offsetY: number, scale: number, gridW: number, gridH: number, BASE_CELL: number }} transform
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

  function render(now, transform) {
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();

    ctx.globalCompositeOperation = "source-over";
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    const c = transform.BASE_CELL * transform.scale;

    ripples = ripples.filter((rp) => {
      const age = now - rp.t0;
      if (age > 700) return false;
      const t = age / 700;
      const { x, y, cell } = gridToScreen(rp.gx, rp.gy, transform);
      const rad = cell * (0.4 + t * 3.2);
      const { r: R, g: G, b: B } = hexToRgb(rp.color.startsWith("#") ? rp.color : "#aabbcc");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.55 * (1 - t)})`;
      ctx.lineWidth = Math.max(1, cell * 0.08 * (1 - t));
      ctx.beginPath();
      ctx.arc(x, y, rad, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });

    particles = particles.filter((p) => {
      p.fx += p.vx / c;
      p.fy += p.vy / c;
      p.vy += 0.04;
      p.life -= 16 / p.max;
      if (p.life <= 0) return false;
      const sx = transform.offsetX + p.fx * c;
      const sy = transform.offsetY + p.fy * c;
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(p.color);
      ctx.fillStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${p.life})` : p.color;
      const radius = Math.max(0.8, p.sizeCells * c * p.life);
      ctx.beginPath();
      ctx.arc(sx, sy, radius, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });

    beams = beams.filter((b) => {
      const age = now - b.t0;
      if (age > 420) return false;
      const t = age / 420;
      const sx1 = transform.offsetX + b.gx1 * c;
      const sy1 = transform.offsetY + b.gy1 * c;
      const sx2 = transform.offsetX + b.gx2 * c;
      const sy2 = transform.offsetY + b.gy2 * c;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = (1 - t) * 5 + 1;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(sx1, sy1);
      ctx.lineTo(sx2, sy2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      return true;
    });

    shockwaves = shockwaves.filter((sw) => {
      const age = now - sw.t0;
      if (age > 900) return false;
      const t = age / 900;
      const sx = transform.offsetX + sw.gcx * c;
      const sy = transform.offsetY + sw.gcy * c;
      const maxR = sw.radiusCells * c;
      const rad = maxR * t;
      const { r: R, g: G, b: B } = hexToRgb(sw.color.startsWith("#") ? sw.color : "#ff8866");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.45 * (1 - t)})`;
      ctx.lineWidth = 4 * (1 - t);
      ctx.beginPath();
      ctx.arc(sx, sy, rad, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });

    bolts = bolts.filter((b) => {
      const age = now - b.t0;
      if (age > 500) return false;
      const fade = 1 - age / 500;
      ctx.strokeStyle = `rgba(200, 230, 255, ${0.85 * fade})`;
      ctx.lineWidth = 2;
      ctx.shadowColor = "#a5d8ff";
      ctx.shadowBlur = 14 * fade;
      for (const s of b.segments) {
        const sx1 = transform.offsetX + s.gx1 * c;
        const sy1 = transform.offsetY + s.gy1 * c;
        const sx2 = transform.offsetX + s.gx2 * c;
        const sy2 = transform.offsetY + s.gy2 * c;
        ctx.beginPath();
        ctx.moveTo(sx1, sy1);
        ctx.lineTo(sx2, sy2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      return true;
    });

    shields = shields.filter((s) => {
      const age = now - s.t0;
      if (age > 900) return false;
      const t = age / 900;
      const { x, y, cell } = gridToScreen(s.gx, s.gy, transform);
      const rr = cell * 0.65 * (1 + t * 0.5);
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(s.color);
      ctx.strokeStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${0.5 * (1 - t)})` : s.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 0.8;
        const px = x + Math.cos(a) * rr;
        const py = y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.fillStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${0.12 * (1 - t)})` : s.color;
      ctx.fill();
      return true;
    });

    zoneFlashes = zoneFlashes.filter((z) => {
      const age = now - z.t0;
      if (age > 500) return false;
      const t = age / 500;
      const x = transform.offsetX + z.gx * c;
      const y = transform.offsetY + z.gy * c;
      const side = c * z.n;
      const zm = /rgba\((\d+),(\d+),(\d+),/.exec(z.color);
      ctx.fillStyle = zm ? `rgba(${zm[1]},${zm[2]},${zm[3]},${0.4 * (1 - t)})` : z.color;
      ctx.fillRect(x, y, side, side);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(x, y, side, side);
      return true;
    });
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
