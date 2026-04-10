/**
 * Единая точка выбора кошелька: JSON-файлы, SQLite (economy.sqlite) или PostgreSQL (DATABASE_URL).
 *
 * Postgres: задайте DATABASE_URL; локально оставьте переменную пустой или WALLET_BACKEND=sqlite.
 * Явно: WALLET_BACKEND=json | sqlite | postgres
 */

import path from "path";
import { fileURLToPath } from "url";
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
