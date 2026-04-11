/**
 * Лёгкие VFX для карты (canvas) и DOM-подсказок.
 * Без внешних библиотек.
 */

/**
 * @param {HTMLCanvasElement} canvas
 */
export function createBoardVfx(canvas) {
  const ctx = canvas.getContext("2d", { alpha: true, desynchronized: true });
  /** @type {{ t0: number, x: number, y: number, r: number, color: string, w: number }[]} */
  let ripples = [];
  /** @type {{ x: number, y: number, vx: number, vy: number, life: number, max: number, color: string, size: number }[]} */
  let particles = [];
  /** @type {{ t0: number, x1: number, y1: number, x2: number, y2: number, color: string }[]} */
  let beams = [];
  /** @type {{ t0: number, x: number, y: number, maxR: number; color: string }[]} */
  let shockwaves = [];
  /** @type {{ t0: number, segments: { x1: number; y1: number; x2: number; y2: number }[] }} */
  let bolts = [];
  /** @type {{ t0: number, x: number; y: number; r: number; color: string }[]} */
  let shields = [];
  /** @type {{ t0: number; x: number; y: number; cell: number; color: string }[]} */
  let zoneFlashes = [];

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 200, g: 200, b: 220 };
  }

  function ripple(gx, gy, color, transform) {
    const { x, y, cell } = gridToScreen(gx, gy, transform);
    ripples.push({ t0: performance.now(), x, y, r: cell * 0.45, color, w: cell });
  }

  function burst(gx, gy, color, transform, n = 14) {
    const { x, y, cell } = gridToScreen(gx, gy, transform);
    const { r, g, b } = hexToRgb(color);
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + Math.random() * 0.5;
      const sp = (0.4 + Math.random() * 0.9) * cell * 0.14;
      particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp,
        life: 1,
        max: 380 + Math.random() * 180,
        color: `rgba(${r},${g},${b},0.9)`,
        size: Math.max(1.5, cell * 0.12),
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
    const c = transform.BASE_CELL * transform.scale;
    const x0 = transform.offsetX + gx * c + c * 0.5;
    const y0 = transform.offsetY + gy * c + c * 0.5;
    const x1 = transform.offsetX + (gx + d[0] * (cells - 1)) * c + c * 0.5;
    const y1 = transform.offsetY + (gy + d[1] * (cells - 1)) * c + c * 0.5;
    beams.push({
      t0: performance.now(),
      x1: x0,
      y1: y0,
      x2: x1,
      y2: y1,
      color: `rgba(${r},${g},${b},0.95)`,
    });
    for (let i = 0; i < cells; i++) {
      const px = gx + d[0] * i;
      const py = gy + d[1] * i;
      ripple(px, py, color, transform);
    }
  }

  function shockwaveScreen(cx, cy, color) {
    const { r, g, b } = hexToRgb(color);
    shockwaves.push({
      t0: performance.now(),
      x: cx,
      y: cy,
      maxR: Math.min(canvas.clientWidth, canvas.clientHeight) * 0.35,
      color,
    });
  }

  function lightningBurst(w, h) {
    const segs = [];
    const n = 4 + ((Math.random() * 3) | 0);
    for (let i = 0; i < n; i++) {
      const x1 = Math.random() * w;
      const y1 = Math.random() * h * 0.35;
      const x2 = x1 + (Math.random() - 0.5) * w * 0.4;
      const y2 = y1 + 40 + Math.random() * (h * 0.4);
      segs.push({ x1, y1, x2, y2 });
    }
    bolts.push({ t0: performance.now(), segments: segs });
  }

  function shieldBurst(gx, gy, color, transform) {
    const { x, y, cell } = gridToScreen(gx, gy, transform);
    const { r, g, b } = hexToRgb(color);
    shields.push({
      t0: performance.now(),
      x,
      y,
      r: cell * 0.65,
      color: `rgba(${r},${g},${b},0.55)`,
    });
    burst(gx, gy, color, transform, 8);
  }

  /**
   * @param {number} [sizeCells] — сторона квадрата в клетках (4 = зона 4×4, 5 = масс-захват 5×5)
   */
  function zoneFlash(gx, gy, color, transform, sizeCells = 4) {
    const n = Math.max(2, Math.min(16, sizeCells | 0));
    const c = transform.BASE_CELL * transform.scale;
    const x = transform.offsetX + gx * c;
    const y = transform.offsetY + gy * c;
    const { r, g, b } = hexToRgb(color);
    const side = c * n;
    zoneFlashes.push({
      t0: performance.now(),
      x,
      y,
      cell: side,
      color: `rgba(${r},${g},${b},${n >= 5 ? 0.28 : 0.35})`,
    });
    shockwaveScreen(x + side * 0.5, y + side * 0.5, color);
  }

  function gridToScreen(gx, gy, t) {
    const cell = t.BASE_CELL * t.scale;
    return {
      x: t.offsetX + gx * cell + cell * 0.5,
      y: t.offsetY + gy * cell + cell * 0.5,
      cell,
    };
  }

  function render(now, transform) {
    /* Полное стирание в координатах bitmap: при scale(dpr) clearRect(clientW, clientH)
       иногда не покрывает все пиксели буфера — полупрозрачные VFX «залипают». */
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.restore();
    ctx.shadowBlur = 0;
    ctx.shadowColor = "transparent";

    ripples = ripples.filter((rp) => {
      const age = now - rp.t0;
      if (age > 700) return false;
      const t = age / 700;
      const rad = rp.w * (0.4 + t * 3.2);
      const { r: R, g: G, b: B } = hexToRgb(rp.color.startsWith("#") ? rp.color : "#aabbcc");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.55 * (1 - t)})`;
      ctx.lineWidth = Math.max(1, rp.w * 0.08 * (1 - t));
      ctx.beginPath();
      ctx.arc(rp.x, rp.y, rad, 0, Math.PI * 2);
      ctx.stroke();
      return true;
    });

    particles = particles.filter((p) => {
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.04;
      p.life -= 16 / p.max;
      if (p.life <= 0) return false;
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(p.color);
      ctx.fillStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${p.life})` : p.color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.size * p.life, 0, Math.PI * 2);
      ctx.fill();
      return true;
    });

    beams = beams.filter((b) => {
      const age = now - b.t0;
      if (age > 420) return false;
      const t = age / 420;
      ctx.strokeStyle = b.color;
      ctx.lineWidth = (1 - t) * 5 + 1;
      ctx.shadowColor = b.color;
      ctx.shadowBlur = 12 * (1 - t);
      ctx.beginPath();
      ctx.moveTo(b.x1, b.y1);
      ctx.lineTo(b.x2, b.y2);
      ctx.stroke();
      ctx.shadowBlur = 0;
      return true;
    });

    shockwaves = shockwaves.filter((sw) => {
      const age = now - sw.t0;
      if (age > 900) return false;
      const t = age / 900;
      const rad = sw.maxR * t;
      const { r: R, g: G, b: B } = hexToRgb(sw.color.startsWith("#") ? sw.color : "#ff8866");
      ctx.strokeStyle = `rgba(${R},${G},${B},${0.45 * (1 - t)})`;
      ctx.lineWidth = 4 * (1 - t);
      ctx.beginPath();
      ctx.arc(sw.x, sw.y, rad, 0, Math.PI * 2);
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
        ctx.beginPath();
        ctx.moveTo(s.x1, s.y1);
        ctx.lineTo(s.x2, s.y2);
        ctx.stroke();
      }
      ctx.shadowBlur = 0;
      return true;
    });

    shields = shields.filter((s) => {
      const age = now - s.t0;
      if (age > 900) return false;
      const t = age / 900;
      const rr = s.r * (1 + t * 0.5);
      const m = /rgba\((\d+),(\d+),(\d+),/.exec(s.color);
      ctx.strokeStyle = m ? `rgba(${m[1]},${m[2]},${m[3]},${0.5 * (1 - t)})` : s.color;
      ctx.lineWidth = 3;
      ctx.beginPath();
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + t * 0.8;
        const x = s.x + Math.cos(a) * rr;
        const y = s.y + Math.sin(a) * rr;
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
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
      const zm = /rgba\((\d+),(\d+),(\d+),/.exec(z.color);
      ctx.fillStyle = zm ? `rgba(${zm[1]},${zm[2]},${zm[3]},${0.4 * (1 - t)})` : z.color;
      ctx.fillRect(z.x, z.y, z.cell, z.cell);
      ctx.strokeStyle = `rgba(255,255,255,${0.5 * (1 - t)})`;
      ctx.lineWidth = 2;
      ctx.strokeRect(z.x, z.y, z.cell, z.cell);
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
    shockwaveScreen,
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
