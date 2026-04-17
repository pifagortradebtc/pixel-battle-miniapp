/**
 * Персистентное хранилище баланса и транзакций (JSON).
 */

import fs from "fs";
import path from "path";
import {
  quantToUsdt,
  REFERRAL_JOIN_INVITER_QUANT,
  REFERRAL_JOIN_PAYMENT_ID_PREFIX,
} from "./tournament-economy.js";

/**
 * @typedef {{
 *   balanceUSDT: number,
 *   lastActionAt: number,
 *   lastZoneCaptureAt: number,
 *   lastMassCaptureAt: number,
 *   lastZone12CaptureAt: number,
 *   personalRecoveryUntil: number,
 *   personalRecoverySec: number,
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
    lastZoneCaptureAt: 0,
    lastMassCaptureAt: 0,
    lastZone12CaptureAt: 0,
    personalRecoveryUntil: 0,
    personalRecoverySec: 20,
    invitedByPlayerKey: "",
  };
}

/**
 * @param {EconomyUser} u
 */
export function migrateEconomyUser(u) {
  if (typeof u.invitedByPlayerKey !== "string") {
    u.invitedByPlayerKey = "";
  }
  if (typeof u.lastZoneCaptureAt !== "number" || !Number.isFinite(u.lastZoneCaptureAt)) {
    u.lastZoneCaptureAt = 0;
  }
  if (typeof u.lastMassCaptureAt !== "number" || !Number.isFinite(u.lastMassCaptureAt)) {
    u.lastMassCaptureAt = 0;
  }
  if (typeof u.lastZone12CaptureAt !== "number" || !Number.isFinite(u.lastZone12CaptureAt)) {
    u.lastZone12CaptureAt = 0;
  }
  if (typeof u.personalRecoveryUntil !== "number" || !Number.isFinite(u.personalRecoveryUntil)) {
    u.personalRecoveryUntil = 0;
  }
  if (typeof u.personalRecoverySec !== "number" || !Number.isFinite(u.personalRecoverySec)) {
    u.personalRecoverySec = 20;
  }
  delete u.recoveryBoostUntil;
  delete u.lastLineCaptureAt;
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
   * JSON-бэкенд не умеет частичную запись — полный save (всё равно дешевле, чем на каждый пиксель).
   * @param {string[]} [_playerKeys]
   */
  flushUsersEconomy(_playerKeys) {
    this.save();
  }

  /**
   * Админ: обнулить балансы и игровую экономику у всех известных игроков (реферальная связь сохраняется).
   * Только для сброса тренировки; история транзакций в JSON не трогается.
   */
  adminResetAllTrainingEconomy() {
    for (const k of Object.keys(this.users)) {
      const ref = typeof this.users[k].invitedByPlayerKey === "string" ? this.users[k].invitedByPlayerKey : "";
      this.users[k] = { ...defaultUser(), invitedByPlayerKey: ref };
      migrateEconomyUser(this.users[k]);
    }
    this.save();
  }

  /**
   * Админ: сброс игровых полей экономики (кулдауны и т.д.), баланс квантов и реферальная связь сохраняются.
   */
  adminResetTrainingEconomyKeepBalances() {
    for (const k of Object.keys(this.users)) {
      const prev = this.users[k];
      const bal =
        typeof prev.balanceUSDT === "number" && Number.isFinite(prev.balanceUSDT) ? prev.balanceUSDT : 0;
      const ref = typeof prev.invitedByPlayerKey === "string" ? prev.invitedByPlayerKey : "";
      this.users[k] = { ...defaultUser(), balanceUSDT: bal, invitedByPlayerKey: ref };
      migrateEconomyUser(this.users[k]);
    }
    this.save();
  }

  /**
   * Админ: обнулить только баланс квантов (USDT), без сброса кулдаунов и без трогания карты/команд.
   * @returns {{ affected: number }}
   */
  adminZeroAllQuantBalancesOnly() {
    const keys = Object.keys(this.users);
    for (const k of keys) {
      const u = this.users[k];
      u.balanceUSDT = 0;
      migrateEconomyUser(u);
    }
    this.save();
    return { affected: keys.length };
  }

  /**
   * Админ: сбросить только реферальную систему (связь приглашённого, idempotent referral_join_*).
   * Балансы не уменьшаются.
   * @returns {{ clearedLinks: number, clearedReferralLedgerRefs: number, clearedReferralPayments: number, rewardQuantPerReferral: number }}
   */
  adminResetReferralSystemOnly() {
    const p = REFERRAL_JOIN_PAYMENT_ID_PREFIX;
    const rewardQuantPerReferral = REFERRAL_JOIN_INVITER_QUANT;
    /** Все ключи из RAM и с диска — чтобы не осталось «тихих» invitedBy только в JSON. */
    /** @type {Set<string>} */
    const allKeys = new Set(Object.keys(this.users));
    try {
      if (fs.existsSync(this.usersPath)) {
        const j = JSON.parse(fs.readFileSync(this.usersPath, "utf8"));
        const disk = typeof j.users === "object" && j.users ? j.users : {};
        for (const k of Object.keys(disk)) {
          const pk = String(k || "").slice(0, 128);
          if (pk) allKeys.add(pk);
        }
      }
    } catch {
      /* ignore */
    }
    let clearedLinks = 0;
    for (const k of allKeys) {
      const u = this.getOrCreateUser(k);
      if (typeof u.invitedByPlayerKey === "string" && u.invitedByPlayerKey.trim()) {
        clearedLinks++;
        u.invitedByPlayerKey = "";
        migrateEconomyUser(u);
      }
    }
    const newConfirmed = new Set();
    let clearedReferralPaymentIds = 0;
    for (const id of this.confirmedPaymentIds) {
      const s = String(id);
      if (s.startsWith(p)) clearedReferralPaymentIds++;
      else newConfirmed.add(s);
    }
    this.confirmedPaymentIds = newConfirmed;
    let clearedReferralLedgerRefs = 0;
    const newTx = [];
    for (const t of this.transactions) {
      const np = t.nowPaymentId != null ? String(t.nowPaymentId) : "";
      if (np.startsWith(p)) clearedReferralLedgerRefs++;
      else newTx.push(t);
    }
    this.transactions = newTx;
    this.save();
    return {
      clearedLinks,
      clearedReferralLedgerRefs,
      clearedReferralPayments: clearedReferralPaymentIds,
      rewardQuantPerReferral,
    };
  }

  /**
   * Админ: начислить кванты всем известным учётным записям в economy-users.json.
   * @param {number} quantDelta
   * @returns {{ affected: number }}
   */
  adminAddQuantsToAllUsers(quantDelta) {
    const q = quantDelta | 0;
    if (q < 1) return { affected: 0 };
    const add = quantToUsdt(q);
    const keys = Object.keys(this.users);
    for (const k of keys) {
      const u = this.users[k];
      const prev = typeof u.balanceUSDT === "number" && Number.isFinite(u.balanceUSDT) ? u.balanceUSDT : 0;
      u.balanceUSDT = Math.round(Math.max(0, prev + add) * 1e6) / 1e6;
      migrateEconomyUser(u);
    }
    this.save();
    return { affected: keys.length };
  }

  /**
   * Снимок всех балансов: сначала с диска, затем актуальные значения из RAM (несохранённые изменения).
   * @returns {Array<{ playerKey: string, balanceUSDT: number }>}
   */
  adminListAllEconomySnapshotsFromPersistence() {
    /** @type {Map<string, number>} */
    const m = new Map();
    try {
      if (fs.existsSync(this.usersPath)) {
        const j = JSON.parse(fs.readFileSync(this.usersPath, "utf8"));
        const disk = typeof j.users === "object" && j.users ? j.users : {};
        for (const k of Object.keys(disk)) {
          const pk = String(k || "").slice(0, 128);
          if (!pk) continue;
          const bal =
            typeof disk[k]?.balanceUSDT === "number" && Number.isFinite(disk[k].balanceUSDT)
              ? disk[k].balanceUSDT
              : 0;
          m.set(pk, bal);
        }
      }
    } catch (e) {
      console.warn("[wallet-store] adminListAllEconomySnapshotsFromPersistence disk:", e.message);
    }
    for (const k of Object.keys(this.users)) {
      const pk = String(k || "").slice(0, 128);
      if (!pk) continue;
      const u = this.users[k];
      const bal = typeof u.balanceUSDT === "number" && Number.isFinite(u.balanceUSDT) ? u.balanceUSDT : 0;
      m.set(pk, bal);
    }
    return [...m.entries()].map(([playerKey, balanceUSDT]) => ({ playerKey, balanceUSDT }));
  }

  /**
   * @param {string} playerKey
   * @returns {EconomyUser}
   */
  /**
   * Есть ли уже запись экономики для ключа (на диске / в памяти после load).
   * Не вызывает getOrCreateUser — чтобы админ-команды не создавали «пустых» игроков.
   */
  hasEconomyUserRecord(playerKey) {
    const k = String(playerKey || "").slice(0, 128);
    if (!k) return false;
    return Object.prototype.hasOwnProperty.call(this.users, k);
  }

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
   * Перечитать пользователя с диска (офлайн quantlist — без устаревшего RAM после flush на диск).
   * @param {string} playerKey
   * @returns {EconomyUser}
   */
  refreshEconomyUserFromPersistence(playerKey) {
    const k = String(playerKey || "").slice(0, 128);
    if (!k) return defaultUser();
    try {
      if (fs.existsSync(this.usersPath)) {
        const j = JSON.parse(fs.readFileSync(this.usersPath, "utf8"));
        const disk = typeof j.users === "object" && j.users ? j.users : {};
        if (Object.prototype.hasOwnProperty.call(disk, k)) {
          const ref =
            typeof disk[k].invitedByPlayerKey === "string" ? disk[k].invitedByPlayerKey : "";
          this.users[k] = { ...defaultUser(), ...disk[k], invitedByPlayerKey: ref };
          migrateEconomyUser(this.users[k]);
          return this.users[k];
        }
      }
    } catch (e) {
      console.warn("refreshEconomyUserFromPersistence(json):", e.message);
    }
    return this.getOrCreateUser(playerKey);
  }

  /**
   * @param {number} amount
   * @param {{ devUnlimited?: boolean }} [opts] — не списывать баланс (тестовый режим на сервере)
   */
  /**
   * @param {{ devUnlimited?: boolean, deferSave?: boolean }} opts — deferSave: не писать на диск до финального save (атомарность с recordSpend)
   */
  trySpend(playerKey, amount, opts = {}) {
    const u = this.getOrCreateUser(playerKey);
    if (opts.devUnlimited) {
      return { ok: true, user: u };
    }
    if (u.balanceUSDT + 1e-9 < amount) return { ok: false, reason: "not enough balance" };
    u.balanceUSDT = Math.round((u.balanceUSDT - amount) * 1e6) / 1e6;
    if (!opts.deferSave) this.save();
    return { ok: true, user: u };
  }

  /**
   * Списание в квантах (внутри хранится USDT: кванты / 7).
   * @param {string} playerKey
   * @param {number} quantAmount
   * @param {{ devUnlimited?: boolean }} [opts]
   */
  trySpendQuant(playerKey, quantAmount, opts = {}) {
    const usdt = quantToUsdt(quantAmount);
    return this.trySpend(playerKey, usdt, opts);
  }

  /** @deprecated используйте trySpendQuant */
  trySpendTugri(playerKey, amount, opts = {}) {
    return this.trySpendQuant(playerKey, amount, opts);
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

  /**
   * @param {{ deferSave?: boolean }} [opts]
   */
  recordSpend(playerKey, amount, note, opts = {}) {
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
    if (!opts.deferSave) this.save();
  }

  isPaymentProcessed(npId) {
    return this.hasPaymentId(npId);
  }

  /** Проверка по Set и по журналу (устойчивость к сбою между кредитом и mark). */
  hasPaymentId(npId) {
    const id = String(npId || "");
    if (!id) return false;
    if (this.confirmedPaymentIds.has(id)) return true;
    return this.transactions.some((t) => t.nowPaymentId === id);
  }

  markPaymentProcessed(npId) {
    this.confirmedPaymentIds.add(String(npId));
    this.save();
  }

  /**
   * Идемпотентное зачисление депозита: одна операция — проверка, баланс, запись tx, confirmed id.
   * @returns {{ ok: true } | { ok: false, duplicate: true }}
   */
  finalizeDeposit(npId, playerKey, amountUsdt, meta = {}) {
    const id = String(npId || "");
    if (!id || !Number.isFinite(amountUsdt) || amountUsdt <= 0) {
      return { ok: false, duplicate: true };
    }
    if (this.hasPaymentId(id)) {
      return { ok: false, duplicate: true };
    }
    const pk = String(playerKey || "").slice(0, 128);
    if (!pk) return { ok: false, duplicate: true };
    const u = this.getOrCreateUser(pk);
    u.balanceUSDT = Math.round((u.balanceUSDT + amountUsdt) * 1e6) / 1e6;
    this.transactions.push({
      id: meta.id || `tx_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      userId: pk,
      type: "deposit",
      amount: amountUsdt,
      currency: "USDT",
      status: "confirmed",
      txHash: meta.txHash || "",
      nowPaymentId: id,
      createdAt: Date.now(),
    });
    this.confirmedPaymentIds.add(id);
    this.save();
    return { ok: true };
  }
}
