import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDb(path) {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 5000;

    CREATE TABLE IF NOT EXISTS items (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      url          TEXT NOT NULL UNIQUE,         -- ссылка, как её прислали
      resolved_url TEXT,                         -- куда она ведёт (карточка товара с выбранным продавцом)
      title        TEXT,
      seller       TEXT,
      target_price REAL,                         -- «сообщить, когда цена ≤ N ₽»
      created_at   INTEGER NOT NULL
    );

    -- Каждая попытка открыть страницу. Удачные (ok = 1) — это и есть история цен.
    CREATE TABLE IF NOT EXISTS checks (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id    INTEGER NOT NULL,
      ts         INTEGER NOT NULL,
      day        TEXT NOT NULL,                  -- дата по TIMEZONE, YYYY-MM-DD
      ok         INTEGER NOT NULL,
      price      REAL,
      old_price  REAL,                           -- зачёркнутая цена «до скидки»
      in_stock   INTEGER,
      seller     TEXT,
      via        TEXT,                           -- http | browser
      error      TEXT,                           -- captcha | no_price | network | …
      manual     INTEGER NOT NULL DEFAULT 0,
      promo       INTEGER,                       -- нужный промокод: 1 есть, 0 нет, NULL — не проверяли
      promo_price REAL,                          -- цена к оплате с промокодом
      promo_info  TEXT                           -- JSON: процент, потолок, код, срок, фрагмент страницы
    );
    CREATE INDEX IF NOT EXISTS checks_item_ts ON checks(item_id, ts);

    CREATE TABLE IF NOT EXISTS settings (
      key   TEXT PRIMARY KEY,
      value TEXT
    );
  `);
  // Базы версии 1.0 — без колонок промокода
  const cols = db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name);
  for (const [name, type] of [['promo', 'INTEGER'], ['promo_price', 'REAL'], ['promo_info', 'TEXT']]) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE checks ADD COLUMN ${name} ${type}`);
  }
  return db;
}

export function createStore(db) {
  const q = {
    items: db.prepare('SELECT * FROM items ORDER BY id'),
    item: db.prepare('SELECT * FROM items WHERE id = ?'),
    itemByUrl: db.prepare('SELECT * FROM items WHERE url = ?'),
    addItem: db.prepare('INSERT INTO items (url, created_at) VALUES (?, ?)'),
    delItem: db.prepare('DELETE FROM items WHERE id = ?'),
    delChecks: db.prepare('DELETE FROM checks WHERE item_id = ?'),
    setTarget: db.prepare('UPDATE items SET target_price = ? WHERE id = ?'),
    updateMeta: db.prepare(
      'UPDATE items SET resolved_url = COALESCE(?, resolved_url), title = COALESCE(?, title), seller = COALESCE(?, seller) WHERE id = ?',
    ),
    addCheck: db.prepare(
      `INSERT INTO checks (item_id, ts, day, ok, price, old_price, in_stock, seller, via, error, manual, promo, promo_price, promo_info)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
    dayStats: db.prepare('SELECT COUNT(*) AS attempts, COALESCE(SUM(ok), 0) AS successes, MAX(ts) AS last_ts FROM checks WHERE item_id = ? AND day = ?'),
    lastAttempt: db.prepare('SELECT * FROM checks WHERE item_id = ? ORDER BY ts DESC, id DESC LIMIT 1'),
    lastOk: db.prepare('SELECT * FROM checks WHERE item_id = ? AND ok = 1 ORDER BY ts DESC, id DESC LIMIT 1'),
    history: db.prepare('SELECT ts, day, price, old_price, in_stock, seller, promo, promo_price, promo_info FROM checks WHERE item_id = ? AND ok = 1 ORDER BY ts, id'),
    getSetting: db.prepare('SELECT value FROM settings WHERE key = ?'),
    setSetting: db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  };

  return {
    items: () => q.items.all(),
    item: (id) => q.item.get(id),
    addItem(url, now = Date.now()) {
      const existing = q.itemByUrl.get(url);
      if (existing) return { item: existing, created: false };
      const { lastInsertRowid } = q.addItem.run(url, now);
      return { item: q.item.get(Number(lastInsertRowid)), created: true };
    },
    deleteItem(id) {
      q.delChecks.run(id);
      q.delItem.run(id);
    },
    setTarget: (id, price) => q.setTarget.run(price ?? null, id),
    updateMeta: (id, { resolvedUrl, title, seller }) => q.updateMeta.run(resolvedUrl ?? null, title ?? null, seller ?? null, id),
    addCheck(c) {
      q.addCheck.run(
        c.itemId, c.ts, c.day, c.ok ? 1 : 0, c.price ?? null, c.oldPrice ?? null,
        c.inStock === undefined || c.inStock === null ? null : c.inStock ? 1 : 0,
        c.seller ?? null, c.via ?? null, c.error ?? null, c.manual ? 1 : 0,
        c.promo === undefined || c.promo === null ? null : c.promo ? 1 : 0, c.promoPrice ?? null, c.promoInfo ? JSON.stringify(c.promoInfo) : null,
      );
    },
    dayStats: (itemId, day) => q.dayStats.get(itemId, day),
    lastAttempt: (itemId) => q.lastAttempt.get(itemId),
    lastOk: (itemId) => q.lastOk.get(itemId),
    history: (itemId) => q.history.all(itemId),
    getSetting(key, fallback = null) {
      const row = q.getSetting.get(key);
      return row ? row.value : fallback;
    },
    setSetting: (key, value) => q.setSetting.run(key, String(value)),
  };
}
