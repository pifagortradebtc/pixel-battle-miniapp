/**
 * Абсолютные URL для sfx/, music/.
 *
 * Раньше база бралась из window.location — в мини-приложениях (Telegram и др.)
 * pathname часто не совпадает с реальным каталогом статики, и fetch уходит на
 * неверный путь → 404 → остаются только процедурные звуки.
 *
 * Основной способ: путь относительно этого ES-модуля (лежит в js/), т.е. на
 * уровень выше — корень приложения рядом с index.html.
 */

/**
 * @param {string} relPath путь вида "sfx/samples.json" или "/sfx/samples.json"
 * @returns {string} абсолютный URL
 */
export function resolvePublicAssetUrl(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  if (!clean) return clean;

  try {
    return new URL(`../${clean}`, import.meta.url).href;
  } catch {
    /* ниже — запасной вариант */
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
