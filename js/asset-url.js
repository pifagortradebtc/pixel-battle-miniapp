/**
 * Абсолютные URL для sfx/ и др. статики.
 *
 * Раньше база бралась из window.location — в мини-приложениях (Telegram и др.)
 * pathname часто не совпадает с реальным каталогом статики, и fetch уходит на
 * неверный путь → 404 → остаются только процедурные звуки.
 *
 * Основной способ: путь относительно этого ES-модуля (лежит в js/), т.е. на
 * уровень выше — корень приложения рядом с index.html.
 */

/**
 * Кодирует относительный путь для URL (пробелы в именах mp3 и т.д.).
 * @param {string} rel
 */
function encodeRelPathSegments(rel) {
  return String(rel || "")
    .replace(/^\/+/, "")
    .split("/")
    .map((s) => encodeURIComponent(s))
    .join("/");
}

/**
 * @param {string} relPath путь вида "sfx/samples.json" или "/sfx/samples.json"
 * @returns {string} абсолютный URL
 */
export function resolvePublicAssetUrl(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  if (!clean) return clean;

  if (typeof window !== "undefined" && window.__PIXEL_STATIC_ASSET_BASE__) {
    try {
      const base = String(window.__PIXEL_STATIC_ASSET_BASE__).replace(/\/+$/, "");
      const pathEnc = encodeRelPathSegments(clean);
      return new URL(pathEnc, `${base}/`).href;
    } catch {
      /* fallback ниже */
    }
  }

  try {
    return new URL(`../${clean}`, import.meta.url).href;
  } catch {
    /* ниже — запасной вариант */
  }

  if (typeof document !== "undefined") {
    const scripts = document.querySelectorAll('script[type="module"][src]');
    for (const s of scripts) {
      const srcAttr = s.getAttribute("src");
      if (!srcAttr) continue;
      try {
        const abs = new URL(srcAttr, window.location.href).href;
        if (/\/js\/[^/]+\.js(\?|#|$)/i.test(abs)) {
          const base = abs.replace(/\/js\/[^/]+\.js(\?.*|#.*)?$/i, "/");
          return new URL(clean, base).href;
        }
      } catch {
        /* next */
      }
    }
  }

  let pathname = "/";
  try {
    pathname = new URL(window.location.href).pathname || "/";
  } catch {
    /* keep default */
  }
  let basePath = pathname;
  if (!basePath.endsWith("/")) {
    if (/\.[a-z0-9]{1,10}$/i.test(basePath)) {
      basePath = basePath.replace(/\/[^/]+$/, "/");
    } else {
      basePath += "/";
    }
  }
  const origin =
    typeof window !== "undefined" && window.location && window.location.origin
      ? window.location.origin
      : "";
  try {
    return new URL(clean, `${origin}${basePath}`).href;
  } catch {
    return clean;
  }
}
