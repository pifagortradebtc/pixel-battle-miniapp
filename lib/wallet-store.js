/**
 * Персистентное хранилище баланса и транзакций (JSON).
 */

import fs from "fs";
import path from "path";

/**
 * @typedef {{
 *   balanceUSDT: number,
 *   lastActionAt: number,
 *   lastLineCaptureAt: number,
 *   lastZoneCaptureAt: number,
 *   lastMassCaptureAt: number,
 *   recoveryBoostUntil: number,
 *   invitedByPlayerKey: string,
 * }} EconomyUser
 */

/**
 * @returns {EconomyUser}
 */
export function defaultUser() {
  return {
    balanceUSDT: 0,
    lastActionAt: 0,
    lastLineCaptureAt: 0,
    lastZoneCaptureAt: 0,
    lastMassCaptureAt: 0,
    recoveryBoostUntil: 0,
    invitedByPlayerKey: "",
  };
}

/**
 * @param {EconomyUser} u
 */
function migrateEconomyUser(u) {
  if (typeof u.recoveryBoostUntil !== "number" || !Number.isFinite(u.recoveryBoostUntil)) {
    const legacy =
      typeof u.speedBoostUntil === "number" && Number.isFinite(u.speedBoostUntil)
        ? u.speedBoostUntil
        : 0;
    u.recoveryBoostUntil = legacy;
  }
  if (typeof u.invitedByPlayerKey !== "string") {
    u.invitedByPlayerKey = "";
  }
  if (typeof u.lastZoneCaptureAt !== "number" || !Number.isFinite(u.lastZoneCaptureAt)) {
    u.lastZoneCaptureAt = 0;
  }
  if (typeof u.lastMassCaptureAt !== "number" || !Number.isFinite(u.lastMassCaptureAt)) {
    u.lastMassCaptureAt = 0;
  }
  delete u.speedBoostUntil;
  delete u.cooldownUpgradeLevel;
  delete u.energy;
  delete u.energyMax;
  delete u.lastEnergyMs;
}

export class WalletStore {
  /**
   * @param {{ dataDir: string }} opts
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.usersPath = path.join(this.dataDir, "economy-users.json");
    this.txsPath = path.join(this.dataDir, "economy-transactions.json");
    /** @type {Record<string, EconomyUser>} */
    this.users = {};
    /** @type {Array<{ id: string, userId: string, type: string, amount: number, currency: string, status: string, txHash?: string, nowPaymentId?: string, createdAt: number }>} */
    this.transactions = [];
    /** @type {Set<string>} */
    this.confirmedPaymentIds = new Set();
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.usersPath)) {
        const j = JSON.parse(fs.readFileSync(this.usersPath, "utf8"));
        this.users = typeof j.users === "object" && j.users ? j.users : {};
      }
    } catch (e) {
      console.warn("economy-users load:", e.message);
      this.users = {};
    }
    try {
      if (fs.existsSync(this.txsPath)) {
        const j = JSON.parse(fs.readFileSync(this.txsPath, "utf8"));
        this.transactions = Array.isArray(j.transactions) ? j.transactions : [];
        this.confirmedPaymentIds = new Set(
          Array.isArray(j.confirmedNowPaymentIds) ? j.confirmedNowPaymentIds : []
        );
      }
    } catch (e) {
      console.warn("economy-transactions load:", e.message);
      this.transactions = [];
      this.confirmedPaymentIds = new Set();
    }
  }

  save() {
    try {
      fs.mkdirSync(this.dataDir, { recursive: true });
      fs.writeFileSync(this.usersPath, JSON.stringify({ users: this.users }), "utf8");
      fs.writeFileSync(
        this.txsPath,
        JSON.stringify({
          transactions: this.transactions.slice(-5000),
          confirmedNowPaymentIds: [...this.confirmedPaymentIds].slice(-8000),
        }),
        "utf8"
      );
    } catch (e) {
      console.warn("economy save:", e.message);
    }
  }

  /**
   * @param {string} playerKey
   * @returns {EconomyUser}
   */
  getOrCreateUser(playerKey) {
    const k = String(playerKey || "").slice(0, 128);
    if (!k) return defaultUser();
    if (!this.users[k]) {
      this.users[k] = defaultUser();
    } else {
      migrateEconomyUser(this.users[k]);
    }
    return this.users[k];
  }

  /**
   * @param {number} amount
   * @param {{ devUnlimited?: boolean }} [opts] — не списывать баланс (тестовый режим на сервере)
   */
  trySpend(playerKey, amount, opts = {}) {
    const u = this.getOrCreateUser(playerKey);
    if (opts.devUnlimited) {
      return { ok: true, user: u };
    }
    if (u.balanceUSDT + 1e-9 < amount) return { ok: false, reason: "not enough balance" };
    u.balanceUSDT = Math.round((u.balanceUSDT - amount) * 1e6) / 1e6;
    this.save();
    return { ok: true, user: u };
  }

  credit(playerKey, amount, meta = {}) {
    const u = this.getOrCreateUser(playerKey);
    u.balanceUSDT = Math.round((u.balanceUSDT + amount) * 1e6) / 1e6;
    this.transactions.push({
      id: meta.id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId: playerKey,
      type: "deposit",
      amount,
      currency: "USDT",
      status: "confirmed",
      txHash: meta.txHash || "",
      nowPaymentId: meta.nowPaymentId || "",
      createdAt: Date.now(),
    });
    this.save();
  }

  recordSpend(playerKey, amount, note) {
    this.transactions.push({
      id: `tx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId: playerKey,
      type: "spend",
      amount,
      currency: "USDT",
      status: "confirmed",
      meta: note || "",
      createdAt: Date.now(),
    });
    this.save();
  }

  isPaymentProcessed(npId) {
    return this.confirmedPaymentIds.has(String(npId));
  }

  markPaymentProcessed(npId) {
    this.confirmedPaymentIds.add(String(npId));
    this.save();
  }
}
