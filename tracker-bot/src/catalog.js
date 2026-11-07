// Каталог скинов: цены всех площадок (в рублях) в SQLite + индекс в памяти для поиска.
import { tx } from './db.js';
import { BEST, CS2 } from './markets.js';

// Русские и сокращённые названия → то, как пишется в market_hash_name.
const ALIASES = {
  калаш: 'ak-47', калашников: 'ak-47', ак: 'ak-47', ak: 'ak-47', акм: 'ak-47',
  авп: 'awp', авик: 'awp',
  эмка: 'm4a', м4: 'm4a', м4а1: 'm4a1-s', м4а1с: 'm4a1-s', m4a1: 'm4a1-s', м4а4: 'm4a4',
  дигл: 'desert eagle', deagle: 'desert eagle',
  юсп: 'usp-s', usp: 'usp-s', глок: 'glock-18', glock: 'glock-18',
  керамбит: 'karambit', бабочка: 'butterfly', байонет: 'bayonet', штык: 'bayonet',
  перчатки: 'gloves', кейс: 'case', наклейка: 'sticker', стикер: 'sticker', капсула: 'capsule', брелок: 'charm',
  редлайн: 'redline', азимов: 'asiimov', вулкан: 'vulcan', допплер: 'doppler', фейд: 'fade', градиент: 'fade',
  драгонлор: 'dragon lore', гипербист: 'hyper beast', хайпербист: 'hyper beast', неонуар: 'neo-noir',
  fn: 'factory new', mw: 'minimal wear', ft: 'field-tested', ww: 'well-worn', bs: 'battle-scarred',
  st: 'stattrak', статтрек: 'stattrak', сувенир: 'souvenir',
};

const normName = (s) => s.toLowerCase().replace(/[™★|()]/g, ' ').replace(/\s+/g, ' ').trim();
const today = () => new Date().toISOString().slice(0, 10);

export function createCatalog(db, { bulkSources = ['c', 'l', 's'] } = {}) {
  const q = {
    byId: db.prepare('SELECT * FROM skins WHERE id = ?'),
    byName: db.prepare('SELECT * FROM skins WHERE app = ? AND name = ?'),
    prices: db.prepare('SELECT src, price, volume, median, updated_at FROM skin_prices WHERE skin_id = ?'),
    stats: db.prepare('SELECT * FROM skin_stats WHERE skin_id = ?'),
    index: db.prepare('SELECT s.id, s.app, s.name, COALESCE(SUM(p.volume), 0) AS vol FROM skins s LEFT JOIN skin_prices p ON p.skin_id = s.id GROUP BY s.id'),
    ensure: db.prepare('INSERT OR IGNORE INTO skins (app, name) VALUES (?, ?)'),
    clearSrc: db.prepare('DELETE FROM skin_prices WHERE src = ? AND skin_id IN (SELECT id FROM skins WHERE app = ?)'),
    setPrice: db.prepare(`INSERT INTO skin_prices (skin_id, src, price, volume, median, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(skin_id, src) DO UPDATE SET price = excluded.price, volume = excluded.volume, median = excluded.median, updated_at = excluded.updated_at`),
    delPrice: db.prepare('DELETE FROM skin_prices WHERE skin_id = ? AND src = ?'),
    setStats: db.prepare(`INSERT OR REPLACE INTO skin_stats (skin_id, med7, avg7, vol7, med30, avg30, vol30, med90, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`),
    bestAll: db.prepare(`SELECT skin_id, MIN(price) AS price FROM skin_prices WHERE price > 0 AND src IN (${[...bulkSources, 'x'].map(() => '?').join(',')}) GROUP BY skin_id`),
    setHist: db.prepare('INSERT OR REPLACE INTO skin_history (skin_id, day, price) VALUES (?, ?, ?)'),
    history: db.prepare('SELECT day, price FROM skin_history WHERE skin_id = ? AND day >= ? ORDER BY day'),
    pruneHist: db.prepare('DELETE FROM skin_history WHERE day < ?'),
  };

  let index = [];
  const rebuild = () => {
    index = q.index.all().map((r) => ({ id: r.id, app: r.app, name: r.name, n: normName(r.name), vol: r.vol }));
  };
  rebuild();
  const idByName = (name, app = CS2) => {
    q.ensure.run(app, name);
    return q.byName.get(app, name).id;
  };
  const store = (k, app, map, t) => {
    q.clearSrc.run(k, app);
    for (const [name, v] of map) if (v.price > 0) q.setPrice.run(idByName(name, app), k, v.price, v.volume || 0, null, t);
  };

  function get(id) {
    const s = q.byId.get(id);
    if (!s) return null;
    s.prices = {};
    for (const p of q.prices.all(id)) s.prices[p.src] = p;
    s.stats = q.stats.get(id) || null;
    return s;
  }

  return {
    get,
    getByName: (name, app = CS2) => {
      const s = q.byName.get(app, name);
      return s ? get(s.id) : null;
    },
    ensure(name, app = CS2) {
      const id = idByName(name, app);
      if (!index.some((i) => i.id === id)) index.push({ id, app, name, n: normName(name), vol: 0 });
      return get(id);
    },
    size: () => index.length,
    bulkSources,

    /** Загрузить прайсы всех оптовых площадок. Ошибка одной площадки не ломает остальные. */
    async refresh(markets) {
      const results = await Promise.allSettled(bulkSources.map((k) => markets.fetchBulk(k)));
      const t = Date.now();
      const report = {};
      tx(db, () => {
        bulkSources.forEach((k, i) => {
          const r = results[i];
          if (r.status !== 'fulfilled') {
            report[k] = r.reason?.code === 'skip' ? 'прошлые цены' : `ошибка: ${r.reason?.message}`;
            return;
          }
          store(k, CS2, r.value, t);
          report[k] = r.value.size;
        });
      });
      rebuild();
      return report;
    },

    /** Другая игра (Rust, TF2): Skinport и своя выгрузка. Цены CS2 не трогает. */
    async refreshGame(markets, app) {
      const r = await markets.fetchGame(app);
      const t = Date.now();
      const report = { ...r.errors };
      tx(db, () => {
        for (const k of ['s', 'x']) {
          if (!r[k]?.size) continue;
          store(k, app, r[k], t);
          report[k] = r[k].size;
        }
      });
      rebuild();
      return report;
    },

    async refreshStats(markets, app = CS2) {
      const map = await markets.skinportHistory(app);
      const t = Date.now();
      tx(db, () => {
        for (const [name, v] of map) {
          const s = q.byName.get(app, name);
          if (s) q.setStats.run(s.id, v.med7, v.avg7, v.vol7, v.med30, v.avg30, v.vol30, v.med90, t);
        }
      });
      return map.size;
    },

    /** Записать лучшую цену дня по всем предметам (вызывается раз в час). */
    snapshotDay() {
      const day = today();
      const rows = q.bestAll.all(...bulkSources);
      tx(db, () => {
        for (const r of rows) q.setHist.run(r.skin_id, day, r.price);
        q.pruneHist.run(new Date(Date.now() - 400 * 86400_000).toISOString().slice(0, 10));
      });
      return rows.length;
    },
    history: (id, days) => q.history.all(id, new Date(Date.now() - days * 86400_000).toISOString().slice(0, 10)),

    setSteam(id, p) {
      if (p) q.setPrice.run(id, 't', p.price, p.volume ?? 0, p.median ?? null, Date.now());
      else q.setPrice.run(id, 't', 0, 0, null, Date.now()); // «нет в продаже» тоже кэшируем
    },

    /** apps — в каких играх искать (по умолчанию только CS2). */
    search(query, limit = 8, apps = [CS2]) {
      const raw = normName(query).replace(/ё/g, 'е');
      if (!raw) return [];
      const tokens = raw.split(' ').map((t) => ALIASES[t] || t);
      const wantsSt = tokens.includes('stattrak');
      const wantsSouv = tokens.includes('souvenir');
      const hits = [];
      for (const it of index) {
        if (!apps.includes(it.app) || !tokens.every((t) => it.n.includes(t))) continue;
        let score = Math.log10(1 + it.vol);
        if (it.n === raw) score += 100;
        if (it.n.startsWith(tokens[0])) score += 1;
        if (!wantsSt && it.n.includes('stattrak')) score -= 1.5;
        if (!wantsSouv && it.n.includes('souvenir')) score -= 1.5;
        score -= it.name.length / 200;
        hits.push({ it, score });
      }
      hits.sort((a, b) => b.score - a.score);
      return hits.slice(0, limit).map((h) => get(h.it.id));
    },
  };
}

/** Цена скина на площадке m; m = 'b' — минимальная среди оптовых площадок. */
export function priceOn(skin, m, bulkSources = ['c', 'l', 'a', 's']) {
  if (!skin?.prices) return null;
  if (m === BEST) {
    const vals = bulkSources.map((k) => skin.prices[k]?.price).filter((v) => v > 0);
    return vals.length ? Math.min(...vals) : null;
  }
  const p = skin.prices[m]?.price;
  return p > 0 ? p : null;
}

/** Площадка с минимальной ценой среди оптовых. */
export function bestSource(skin, bulkSources = ['c', 'l', 'a', 's']) {
  let best = null;
  for (const k of bulkSources) {
    const p = skin?.prices?.[k]?.price;
    if (p > 0 && (!best || p < best.price)) best = { src: k, price: p };
  }
  return best;
}
