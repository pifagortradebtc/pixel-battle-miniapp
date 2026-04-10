/**
 * Простой скользящий лимит событий по ключу (защита от флуда и ботов).
 */

export class SlidingWindowRateLimiter {
  constructor() {
    /** @type {Map<string, number[]>} */
    this.buckets = new Map();
  }

  /**
   * @param {string} key
   * @param {number} max максимум событий за окно
   * @param {number} windowMs длина окна в мс
   * @returns {boolean} true если событие разрешено
   */
  allow(key, max, windowMs) {
    const now = Date.now();
    let arr = this.buckets.get(key);
    if (!arr) {
      arr = [];
      this.buckets.set(key, arr);
    }
    const cutoff = now - windowMs;
    while (arr.length && arr[0] < cutoff) arr.shift();
    if (arr.length >= max) return false;
    arr.push(now);
    return true;
  }

  /** Удалить пустые корзины (периодический вызов). */
  prune(maxKeys = 50000) {
    if (this.buckets.size <= maxKeys) return;
    for (const [k, arr] of this.buckets) {
      if (!arr.length) this.buckets.delete(k);
    }
  }
}
