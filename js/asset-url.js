/**
 * База для статики (sfx/, music/), когда приложение открыто не с корня домена
 * (например /miniapp или /repo-name без завершающего слэша).
 * new URL("sfx/x", "https://host/path") даёт https://host/sfx/x — неверно;
 * нужно https://host/path/sfx/x или https://host/path/…
 */

/**
 * @param {string} relPath путь вида "sfx/samples.json" или "/sfx/samples.json"
 * @returns {string} абсолютный URL
 */
export function resolvePublicAssetUrl(relPath) {
  const clean = String(relPath || "").replace(/^\/+/, "");
  let pathname = "";
  try {
    pathname = new URL(window.location.href).pathname || "/";
  } catch {
    pathname = "/";
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
