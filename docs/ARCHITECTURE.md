# Архитектура Pixel Battle (целевая production-модель)

## Текущее состояние (после рефакторинга)

```
[Telegram Mini App] ──initData──► [Node server.js]
                                        │
                    ┌───────────────────┼───────────────────┐
                    ▼                   ▼                   ▼
              [HTTP /api/*]      [WebSocket /ws]      [Статика]
                    │                   │
                    ▼                   ▼
         [NOWPayments IPN]        [Игровой цикл]
                    │                   │
                    ▼                   ▼
            [lib/wallet-db.js]   [Память: карта, команды]
            SQLite (sql.js)        + round-state.json
            economy.sqlite
```

### Кошелёк и деньги

- **По умолчанию** `WALLET_BACKEND` не задан → **`lib/wallet-db.js`**: SQLite с таблицами `users`, `balances`, `economy_state`, `ledger_entries`, `payments`.
- Депозиты: **идемпотентность** по `payment_id` (NOWPayments) + запись в `ledger_entries`.
- Покупки: списание + ledger в рамках одной логики сохранения (`deferSave` + `save()`), как и раньше.
- **`WALLET_BACKEND=json`**: прежний `lib/wallet-store.js` (файлы JSON) — только для локальной отладки.

### Миграция

- При первом запуске SQLite пустой и есть `data/economy-users.json` → автоматическая миграция, файлы переименовываются в `*.migrated`.

## Целевая разделённая архитектура (следующие этапы)

```
┌─────────────┐     ┌─────────────────────────────────────────────┐
│  Mini App   │────►│ API Gateway / WS (Node.js)                  │
└─────────────┘     │  • auth (Telegram initData)                  │
                    │  • game commands (pixel, purchase, team)      │
                    │  • payments webhook                          │
                    └───────┬───────────────────┬──────────────────┘
                            │                   │
                            ▼                   ▼
                    ┌───────────────┐   ┌───────────────┐
                    │ PostgreSQL    │   │ Redis (опц.)  │
                    │ users, ledger │   │ pub/sub, rate │
                    │ payments, map │   │ session cache │
                    └───────────────┘   └───────────────┘
```

### Слои (рекомендуемая раскладка)

| Слой | Ответственность |
|------|-----------------|
| `routes/` | HTTP + WS маршрутизация, парсинг, rate limit |
| `services/` | Бизнес-логика: баланс, покупки, турнир |
| `repositories/` | SQL-запросы, транзакции |
| `realtime/` | Подписки, батч-события карты |
| `auth/` | Проверка `initData`, привязка `telegram_user_id` → `user_id` |

### Принципы

1. Идентичность — только из проверенного `initData` на сервере.
2. Баланс — только через транзакции + immutable ledger.
3. Игровые таймеры — поля `expires_at` / `last_action_at` в БД.
4. Карта — один процесс-писатель в одном инстансе; при горизонтальном масштабе — шардирование или CRDT/операционный лог.

---

## Переменные окружения

| Переменная | Назначение |
|------------|------------|
| `WALLET_BACKEND` | `sqlite` (по умолчанию) или `json` |
| `TELEGRAM_BOT_TOKEN` | Обязательно в проде для привязки Telegram |
| `ALLOW_CLIENT_PLAYER_KEY` | Только dev: доверять `playerKey` с клиента |
