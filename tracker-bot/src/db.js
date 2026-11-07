import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS users (
      id           INTEGER PRIMARY KEY,         -- Telegram user id
      username     TEXT,
      first_name   TEXT,
      source       TEXT,                        -- откуда пришёл: t.me/bot?start=<source>
      created_at   INTEGER NOT NULL,
      last_seen    INTEGER NOT NULL,
      min_discount INTEGER NOT NULL DEFAULT 1,  -- уведомлять о скидке на игры от N%
      blocked      INTEGER NOT NULL DEFAULT 0   -- пользователь заблокировал бота
    );

    -- ---------- вишлист игр ----------
    CREATE TABLE IF NOT EXISTS games (
      appid        INTEGER PRIMARY KEY,
      name         TEXT,
      is_free      INTEGER NOT NULL DEFAULT 0,
      currency     TEXT,
      initial      INTEGER,                     -- в минимальных единицах (копейки/центы)
      final        INTEGER,
      discount     INTEGER,
      checked_at   INTEGER
    );
    CREATE TABLE IF NOT EXISTS game_prices (       -- цена игры в регионе магазина
      appid      INTEGER NOT NULL,
      cc         TEXT NOT NULL,
      available  INTEGER NOT NULL DEFAULT 1,
      is_free    INTEGER NOT NULL DEFAULT 0,
      currency   TEXT,
      initial    INTEGER,
      final      INTEGER,
      discount   INTEGER,
      checked_at INTEGER NOT NULL,
      PRIMARY KEY (appid, cc)
    );
    CREATE TABLE IF NOT EXISTS support_msgs (      -- сообщение у админа → кому отвечать
      admin_chat INTEGER NOT NULL,
      message_id INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      PRIMARY KEY (admin_chat, message_id)
    );
    CREATE TABLE IF NOT EXISTS wishlist (
      user_id      INTEGER NOT NULL,
      appid        INTEGER NOT NULL,
      added_at     INTEGER NOT NULL,
      notified_final INTEGER,                   -- цена, о которой уже сообщили
      PRIMARY KEY (user_id, appid)
    );
    CREATE INDEX IF NOT EXISTS wishlist_app ON wishlist(appid);

    -- ---------- скины ----------
    CREATE TABLE IF NOT EXISTS skins (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      app            INTEGER NOT NULL DEFAULT 730, -- игра Steam: 730 CS2, 252490 Rust, 440 TF2
      name           TEXT NOT NULL,                -- market_hash_name
      market_price   REAL, market_volume INTEGER,
      skinport_price REAL, skinport_volume INTEGER,
      steam_price    REAL, steam_volume INTEGER, steam_at INTEGER,
      updated_at     INTEGER,
      UNIQUE (app, name)
    );
    CREATE TABLE IF NOT EXISTS skin_prices (       -- текущие цены по площадкам, ₽
      skin_id    INTEGER NOT NULL,
      src        TEXT NOT NULL,                    -- c | l | a | s | t
      price      REAL NOT NULL,
      volume     INTEGER,
      median     REAL,                             -- Steam: медиана недавних продаж
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (skin_id, src)
    );
    CREATE TABLE IF NOT EXISTS skin_history (      -- лучшая цена за день (для оценки рынка)
      skin_id INTEGER NOT NULL,
      day     TEXT NOT NULL,                       -- YYYY-MM-DD
      price   REAL NOT NULL,
      PRIMARY KEY (skin_id, day)
    );
    CREATE TABLE IF NOT EXISTS skin_stats (        -- история продаж Skinport, ₽
      skin_id INTEGER PRIMARY KEY,
      med7 REAL, avg7 REAL, vol7 INTEGER,
      med30 REAL, avg30 REAL, vol30 INTEGER,
      med90 REAL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS alerts (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id     INTEGER NOT NULL,
      skin_id     INTEGER NOT NULL,
      market      TEXT NOT NULL,                -- c | s | t | b (см. MARKETS)
      type        TEXT NOT NULL,                -- pct | lt | gt
      value       REAL NOT NULL,                -- % или цена
      base_price  REAL,                         -- для pct: цена, от которой считаем изменение
      triggered   INTEGER NOT NULL DEFAULT 0,   -- для lt/gt: уже сработало, ждём возврата
      checked_at  INTEGER,
      created_at  INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS alerts_user ON alerts(user_id);
    CREATE TABLE IF NOT EXISTS inv_items (
      user_id INTEGER NOT NULL,
      name    TEXT NOT NULL,
      count   INTEGER NOT NULL,
      PRIMARY KEY (user_id, name)
    );
    CREATE TABLE IF NOT EXISTS listings (          -- выставлено на продажу в Steam (отмечает сам пользователь)
      user_id INTEGER NOT NULL,
      skin_id INTEGER NOT NULL,
      count   INTEGER NOT NULL,
      PRIMARY KEY (user_id, skin_id)
    );
    CREATE TABLE IF NOT EXISTS inv_snapshots (
      user_id    INTEGER NOT NULL,
      taken_at   INTEGER NOT NULL,
      value      REAL NOT NULL                  -- стоимость по Маркету CS, ₽
    );
    CREATE INDEX IF NOT EXISTS inv_snap_user ON inv_snapshots(user_id, taken_at);

    -- ---------- оплата ----------
    CREATE TABLE IF NOT EXISTS payments (           -- Telegram Stars
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      stars        INTEGER NOT NULL,
      charge_id    TEXT UNIQUE NOT NULL,
      created_at   INTEGER NOT NULL,
      refunded_at  INTEGER
    );
    CREATE TABLE IF NOT EXISTS ym_payments (        -- ЮMoney
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id      INTEGER NOT NULL,
      label        TEXT UNIQUE NOT NULL,
      amount       REAL NOT NULL,                   -- сколько просим, ₽
      status       TEXT NOT NULL DEFAULT 'pending', -- pending | paid | expired
      operation_id TEXT,
      received     REAL,                            -- сколько пришло после комиссии
      created_at   INTEGER NOT NULL,
      paid_at      INTEGER
    );
  `);

  // Миграции для баз, созданных прошлой версией бота.
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  const add = (name, def) => !cols.has(name) && db.exec(`ALTER TABLE users ADD COLUMN ${name} ${def}`);
  add('steamid', 'TEXT');
  add('inv_at', 'INTEGER'); // когда последний раз загружали инвентарь
  add('inv_total', 'INTEGER');
  add('premium_until', 'INTEGER');
  add('cc', 'TEXT'); // регион магазина Steam для игр
  add('inv_alerts', 'INTEGER NOT NULL DEFAULT 1'); // уведомления об изменении цен предметов инвентаря
  add('inv_alert_at', 'INTEGER');
  add('tier', 'TEXT'); // pro | ultra — какой тариф оплачен до premium_until
  add('ultra_chat', 'INTEGER NOT NULL DEFAULT 0'); // впущен в чат УЛЬТРА
  for (const t of ['payments', 'ym_payments']) {
    if (!db.prepare(`PRAGMA table_info(${t})`).all().some((c) => c.name === 'tier')) db.exec(`ALTER TABLE ${t} ADD COLUMN tier TEXT NOT NULL DEFAULT 'pro'`);
  }
  db.exec('CREATE TABLE IF NOT EXISTS kv (key TEXT PRIMARY KEY, value TEXT)');
  add('report_on', 'INTEGER NOT NULL DEFAULT 1'); // УЛЬТРА: ежедневный отчёт по инвентарю
  add('report_day', 'TEXT'); // за какой день отчёт уже отправлен
  add('signals_on', 'INTEGER NOT NULL DEFAULT 1'); // УЛЬТРА: сигналы «выгодно купить / пора продавать»
  db.exec(`
    CREATE TABLE IF NOT EXISTS signals (            -- УЛЬТРА: какие сигналы уже отправлены (не чаще раза в сутки)
      user_id INTEGER NOT NULL,
      skin_id INTEGER NOT NULL,
      kind    TEXT NOT NULL,                        -- buy | sell
      sent_at INTEGER NOT NULL,
      PRIMARY KEY (user_id, skin_id, kind)
    );
    CREATE TABLE IF NOT EXISTS topup_services (     -- сервисы пополнения Steam, список ведёт администратор
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      name       TEXT NOT NULL,
      fee        REAL NOT NULL,                     -- комиссия, %: за 100 ₽ на кошельке платите 100 + fee
      url        TEXT,
      updated_at INTEGER NOT NULL
    );
  `);

  // Скины разных игр: в базах до версии 1.7 название было уникальным без учёта игры.
  if (!db.prepare('PRAGMA table_info(skins)').all().some((c) => c.name === 'app')) {
    const old = db.prepare('PRAGMA table_info(skins)').all().map((c) => c.name).join(', ');
    tx(db, () => {
      db.exec(`CREATE TABLE skins_v2 (
        id INTEGER PRIMARY KEY AUTOINCREMENT, app INTEGER NOT NULL DEFAULT 730, name TEXT NOT NULL,
        market_price REAL, market_volume INTEGER, skinport_price REAL, skinport_volume INTEGER,
        steam_price REAL, steam_volume INTEGER, steam_at INTEGER, updated_at INTEGER, UNIQUE (app, name))`);
      db.exec(`INSERT INTO skins_v2 (${old}) SELECT ${old} FROM skins`);
      db.exec('DROP TABLE skins');
      db.exec('ALTER TABLE skins_v2 RENAME TO skins');
    });
  }
  const icols = new Set(db.prepare('PRAGMA table_info(inv_items)').all().map((c) => c.name));
  if (!icols.has('base_price')) db.exec('ALTER TABLE inv_items ADD COLUMN base_price REAL'); // цена, от которой считаем изменение

  const gcols = new Set(db.prepare('PRAGMA table_info(games)').all().map((c) => c.name));
  for (const [name, def] of [
    ['rating_pct', 'INTEGER'], ['rating_desc', 'TEXT'], ['rating_total', 'INTEGER'], ['metacritic', 'INTEGER'],
    ['hist_low_usd', 'REAL'], ['hist_retail_usd', 'REAL'], ['hist_max_discount', 'INTEGER'],
    ['max_discount_seen', 'INTEGER'], ['info_at', 'INTEGER'], ['hist_src', 'TEXT'], ['past_max_discount', 'INTEGER'],
  ]) if (!gcols.has(name)) db.exec(`ALTER TABLE games ADD COLUMN ${name} ${def}`);
  if (cols.has('premium_at')) {
    db.exec('UPDATE users SET premium_until = 4102444800000 WHERE premium_at IS NOT NULL AND premium_until IS NULL');
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
