/**
 * Единая точка выбора кошелька: JSON-файлы, SQLite (economy.sqlite) или PostgreSQL (DATABASE_URL).
 *
 * Postgres: задайте DATABASE_URL; локально оставьте переменную пустой или WALLET_BACKEND=sqlite.
 * Явно: WALLET_BACKEND=json | sqlite | postgres
 */

import path from "path";
import { fileURLToPath } from "url";
import { REFERRAL_JOIN_INVITER_QUANT } from "./tournament-economy.js";
import { WalletStore } from "./wallet-store.js";
import { createWalletDb } from "./wallet-db.js";
import { createWalletPg } from "./wallet-pg.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, "..");
const DEFAULT_DATA_DIR = path.join(ROOT, "data");

/**
 * Обёртка: те же async-методы, что у WalletPg, для SQLite/JSON (синхронные внутри).
 */
export class SyncWalletAdapter {
  /**
   * @param {import("./wallet-db.js").WalletDb | import("./wallet-store.js").WalletStore} inner
   */
  constructor(inner) {
    this.inner = inner;
  }

  async getOrCreateUser(pk) {
    return this.inner.getOrCreateUser(pk);
  }

  /**
   * Сбросить кэш игрока и перечитать из БД/файла (офлайн quantlist — сохранённое состояние).
   * @param {string} pk
   */
  async refreshEconomyUserFromPersistence(pk) {
    const inner = this.inner;
    if (typeof inner.refreshEconomyUserFromPersistence === "function") {
      return await Promise.resolve(inner.refreshEconomyUserFromPersistence(pk));
    }
    return this.getOrCreateUser(pk);
  }

  async save() {
    this.inner.save();
  }

  async trySpendQuant(pk, q, o) {
    return this.inner.trySpendQuant(pk, q, o);
  }

  async recordSpend(pk, a, n, o) {
    this.inner.recordSpend(pk, a, n, o);
  }

  async finalizeDeposit(npId, pk, amt, meta) {
    return this.inner.finalizeDeposit(npId, pk, amt, meta);
  }

  async hasPaymentId(id) {
    return this.inner.hasPaymentId(id);
  }

  async credit(pk, amt, meta) {
    return this.inner.credit(pk, amt, meta);
  }

  /** @param {string} playerKey */
  async hasEconomyUserRecord(playerKey) {
    const k = String(playerKey || "").trim().slice(0, 128);
    if (!k) return false;
    const inner = this.inner;
    if (typeof inner.hasEconomyUserRecord === "function") {
      return await Promise.resolve(inner.hasEconomyUserRecord(k));
    }
    if (inner && inner.users && typeof inner.users === "object") {
      return Object.prototype.hasOwnProperty.call(inner.users, k);
    }
    return false;
  }

  /** @param {string[]} keys */
  async flushUsersEconomy(keys) {
    if (typeof this.inner.flushUsersEconomy === "function") {
      return this.inner.flushUsersEconomy(keys);
    }
    this.inner.save();
  }

  /** @param {string[]} keys */
  async persistPurchaseWrites(keys) {
    if (typeof this.inner.persistPurchaseWrites === "function") {
      return this.inner.persistPurchaseWrites(keys);
    }
    return this.save();
  }

  /** Админ: сброс тренировочной экономики (см. WalletStore / WalletDb). */
  async adminResetAllTrainingEconomy() {
    if (typeof this.inner.adminResetAllTrainingEconomy === "function") {
      return await Promise.resolve(this.inner.adminResetAllTrainingEconomy());
    }
  }

  /** Админ: сброс полей экономики без обнуления баланса квантов. */
  async adminResetTrainingEconomyKeepBalances() {
    if (typeof this.inner.adminResetTrainingEconomyKeepBalances === "function") {
      return await Promise.resolve(this.inner.adminResetTrainingEconomyKeepBalances());
    }
  }

  /** Админ: только баланс → 0 у всех записей. */
  async adminZeroAllQuantBalancesOnly() {
    if (typeof this.inner.adminZeroAllQuantBalancesOnly === "function") {
      return await Promise.resolve(this.inner.adminZeroAllQuantBalancesOnly());
    }
    return { affected: 0 };
  }

  /** Админ: +кванты каждой записи. */
  async adminAddQuantsToAllUsers(quantDelta) {
    if (typeof this.inner.adminAddQuantsToAllUsers === "function") {
      return await Promise.resolve(this.inner.adminAddQuantsToAllUsers(quantDelta));
    }
    return { affected: 0 };
  }

  /** Админ: сброс только реферальной системы. */
  async adminResetReferralSystemOnly() {
    if (typeof this.inner.adminResetReferralSystemOnly === "function") {
      return await Promise.resolve(this.inner.adminResetReferralSystemOnly());
    }
    return {
      clearedLinks: 0,
      clearedReferralLedgerRefs: 0,
      clearedReferralPayments: 0,
      rewardQuantPerReferral: REFERRAL_JOIN_INVITER_QUANT,
    };
  }

  /** Админ: все player_key + balance из хранилища. */
  async adminListAllEconomySnapshotsFromPersistence() {
    if (typeof this.inner.adminListAllEconomySnapshotsFromPersistence === "function") {
      return await Promise.resolve(this.inner.adminListAllEconomySnapshotsFromPersistence());
    }
    return [];
  }
}

/**
 * @param {string} [dataDir]
 * @returns {Promise<import("./wallet-pg.js").WalletPg | SyncWalletAdapter>}
 */
export async function createWalletBackend(dataDir = DEFAULT_DATA_DIR) {
  const wb = String(process.env.WALLET_BACKEND || "").trim().toLowerCase();
  if (wb === "json") {
    console.warn("[wallet] backend=json");
    return new SyncWalletAdapter(new WalletStore({ dataDir }));
  }
  if (wb === "postgres" || wb === "pg") {
    const url = (process.env.DATABASE_URL || "").trim();
    if (!url) {
      throw new Error("WALLET_BACKEND=postgres требует DATABASE_URL");
    }
    return await createWalletPg(url);
  }
  const dbUrl = (process.env.DATABASE_URL || "").trim();
  if (dbUrl && wb !== "sqlite") {
    return await createWalletPg(dbUrl);
  }
  console.warn("[wallet] backend=sqlite (data/economy.sqlite)");
  return new SyncWalletAdapter(await createWalletDb(dataDir));
}
