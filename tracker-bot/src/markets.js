import { USER_AGENT } from './config.js';
// Источники цен на скины CS2.
//  Оптовые (весь прайс одним запросом, раз в несколько минут):
//   c — Маркет CS (market.csgo.com), рубли, без ключа
//   l — Lis-Skins (публичная выгрузка цен), обычно доллары
//   a — Avan.Market (адрес выгрузки задаётся в .env — AVAN_PRICES_URL)
//   s — Skinport (+ история продаж за 7/30/90 дней — нужна для оценки рынка)
//  Поштучные:
//   t — Steam Community Market (~20 запросов/мин), запрашиваем только нужные предметы
// Все цены приводятся к рублям по курсу ЦБ.

const enc = encodeURIComponent;
// Игры. CS2 — все площадки; Rust и TF2 — Steam, Skinport и (если задана) своя выгрузка цен — источник x.
export const CS2 = 730;
export const GAMES = {
  730: { key: 'cs2', title: 'CS2', icon: '🔫', skinport: '' },
  252490: { key: 'rust', title: 'Rust', icon: '🪓', skinport: 'rust/' },
  440: { key: 'tf2', title: 'TF2', icon: '🎩', skinport: 'tf2/' },
};
export const gameOf = (app) => GAMES[app] || GAMES[CS2];
export const SOURCES = {
  c: { title: 'Маркет CS', url: (n) => `https://market.csgo.com/ru/?search=${enc(n)}` },
  l: { title: 'Lis-Skins', url: (n) => `https://lis-skins.com/ru/market/csgo/?query=${enc(n)}` },
  a: { title: 'Avan.Market', url: (n) => `https://avan.market/ru/market/cs?name=${enc(n)}` },
  s: { title: 'Skinport', url: (n, app = CS2) => `https://skinport.com/${gameOf(app).skinport}market?search=${enc(n)}&sort=price&order=asc` },
  x: { title: 'Доп. площадка', url: null },
  t: { title: 'Steam', url: (n, app = CS2) => `https://steamcommunity.com/market/listings/${app}/${enc(n)}`, fee: 0.13 },
};
export const BEST = 'b';
export const sourceTitle = (m) => (m === BEST ? 'Лучшая цена' : SOURCES[m]?.title || m);
export const STEAM_FEE = SOURCES.t.fee;

/** «1 234,56 pуб.», «$1,234.56», «12.5», «1.234,5 €» → число. */
export function parsePrice(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (v == null) return null;
  let s = String(v).replace(/[^\d.,]/g, '').replace(/^[.,]+|[.,]+$/g, '');
  if (!s) return null;
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    s = lastComma > lastDot ? s.replace(/\./g, '').replace(',', '.') : s.replace(/,/g, '');
  } else if (lastComma >= 0) {
    s = /^\d{1,3}(,\d{3})+$/.test(s) ? s.replace(/,/g, '') : s.replace(',', '.');
  }
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}
export const parseCount = (v) => Number(String(v ?? '').replace(/\D/g, '')) || 0;

/**
 * Разбор выгрузки цен в любом из распространённых форматов:
 * массив объектов, {items: [...]}, {data: [...]} или объект «название → данные».
 */
export function parseExport(data) {
  let list = Array.isArray(data) ? data : data?.items || data?.data || data?.results || null;
  if (!list && data && typeof data === 'object') list = Object.entries(data).map(([name, v]) => (typeof v === 'object' ? { name, ...v } : { name, price: v }));
  const out = new Map();
  for (const it of list || []) {
    const name = it.market_hash_name || it.hash_name || it.full_name || it.name;
    const price = parsePrice(it.price ?? it.min_price ?? it.price_min ?? it.lowest_price ?? it.min);
    const volume = parseCount(it.count ?? it.quantity ?? it.volume ?? it.amount ?? it.items_count);
    if (!name || !(price > 0)) continue;
    const prev = out.get(name);
    if (!prev || price < prev.price) out.set(name, { price, volume: (prev?.volume || 0) + volume });
    else prev.volume += volume;
  }
  return out;
}

class Queue {
  constructor(gapMs) {
    this.gapMs = gapMs;
    this.chain = Promise.resolve();
    this.last = 0;
    this.length = 0;
  }
  run(fn) {
    this.length++;
    const job = async () => {
      const wait = this.last + this.gapMs - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this.last = Date.now();
      try {
        return await fn();
      } finally {
        this.length--;
      }
    };
    const p = this.chain.then(job, job);
    this.chain = p.catch(() => {});
    return p;
  }
}

export class MarketsClient {
  constructor({ fetchImpl = fetch, rates, steamGapMs = 3500, steamCurrency = 5, sources = 'c,l,s,a', lisUrl, lisCurrency = 'USD', avanUrl = '', avanCurrency = 'RUB', skinportCurrency = 'RUB', skinportRefreshMin = 15, extraExports = {} } = {}) {
    // Skinport жёстко ограничивает запросы (несколько за 5 минут на IP), поэтому опрашиваем его реже
    // и после ответа 429 делаем паузу. Пока пауза — бот использует прошлые цены Skinport.
    this.skinportGapMs = skinportRefreshMin * 60_000;
    this.skinportNext = 0;
    this.skinportBlockedUntil = 0;
    this.fetch = fetchImpl;
    this.rates = rates;
    this.steamQueue = new Queue(steamGapMs);
    this.steamCurrency = steamCurrency;
    this.lisUrl = lisUrl || 'https://lis-skins.com/market_export_json/csgo.json';
    this.lisCurrency = lisCurrency;
    this.avanUrl = avanUrl;
    this.avanCurrency = avanCurrency;
    this.skinportCurrency = skinportCurrency;
    this.extraExports = extraExports; // { [app]: { url, currency } } — выгрузки цен Rust/TF2 с других площадок
    const want = String(sources).split(',').map((s) => s.trim());
    // Avan включается только если задан адрес выгрузки.
    this.bulk = want.filter((k) => ['c', 'l', 's', 'a'].includes(k) && (k !== 'a' || this.avanUrl));
  }

  async json(url, init = {}) {
    const res = await this.fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init.headers || {}) }, signal: AbortSignal.timeout(40_000) });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} ${url.split('?')[0]}`);
      err.status = res.status;
      throw err;
    }
    return res.json();
  }

  toRub(map, currency) {
    if (String(currency).toUpperCase() === 'RUB') return map;
    for (const v of map.values()) v.price = this.rates ? this.rates.toRub(v.price, currency) : v.price;
    return map;
  }

  /** Весь прайс площадки k: Map<name, {price ₽, volume}>. */
  async fetchBulk(k) {
    if (k === 's' && Date.now() < this.skinportNext) throw Object.assign(new Error('пропуск: лимит Skinport, использую прошлые цены'), { code: 'skip' });
    if (k === 's') this.skinportNext = Date.now() + this.skinportGapMs;
    try {
      return await this.fetchBulkRaw(k);
    } catch (e) {
      if (k === 's' && e.status === 429) this.skinportNext = this.skinportBlockedUntil = Date.now() + 30 * 60_000;
      throw e;
    }
  }

  async fetchBulkRaw(k) {
    let map;
    if (k === 'c') map = this.toRub(parseExport(await this.json('https://market.csgo.com/api/v2/prices/RUB.json')), 'RUB');
    else if (k === 'l') map = this.toRub(parseExport(await this.json(this.lisUrl)), this.lisCurrency);
    else if (k === 'a') map = this.toRub(parseExport(await this.json(this.avanUrl)), this.avanCurrency);
    else if (k === 's') map = await this.skinportItems(CS2);
    else throw new Error(`неизвестный источник ${k}`);
    if (!map.size) throw new Error('пустой прайс');
    return map;
  }

  async skinportItems(app) {
    const data = await this.json(`https://api.skinport.com/v1/items?app_id=${app}&currency=${this.skinportCurrency}&tradable=0`, { headers: { 'accept-encoding': 'br' } });
    return this.toRub(parseExport((Array.isArray(data) ? data : []).map((i) => ({ name: i.market_hash_name, price: i.min_price, count: i.quantity }))), this.skinportCurrency);
  }

  /**
   * Прайсы другой игры (Rust, TF2): Skinport и своя выгрузка. Возвращает { s?: Map, x?: Map, errors }.
   * Skinport общий лимит на все игры — после 429 пауза, как и для CS2.
   */
  async fetchGame(app) {
    const out = { errors: {} };
    const ex = this.extraExports[app];
    if (ex?.url) {
      try {
        out.x = this.toRub(parseExport(await this.json(ex.url)), ex.currency || 'RUB');
      } catch (e) {
        out.errors.x = e.message;
      }
    }
    if (Date.now() < this.skinportBlockedUntil) out.errors.s = 'пропуск: лимит Skinport';
    else {
      try {
        out.s = await this.skinportItems(app);
      } catch (e) {
        if (e.status === 429) this.skinportBlockedUntil = Date.now() + 30 * 60_000;
        out.errors.s = e.message;
      }
    }
    return out;
  }

  /** История продаж Skinport: Map<name, {med7, avg7, vol7, med30, avg30, vol30, med90}> в рублях. */
  async skinportHistory(app = CS2) {
    if (Date.now() < this.skinportBlockedUntil) throw new Error('пропуск: лимит Skinport');
    const data = await this.json(`https://api.skinport.com/v1/sales/history?app_id=${app}&currency=${this.skinportCurrency}`, { headers: { 'accept-encoding': 'br' } });
    const r = (v) => (v == null ? null : this.rates ? this.rates.toRub(v, this.skinportCurrency) : v);
    const out = new Map();
    for (const it of Array.isArray(data) ? data : []) {
      if (!it.market_hash_name) continue;
      out.set(it.market_hash_name, {
        med7: r(it.last_7_days?.median),
        avg7: r(it.last_7_days?.avg),
        vol7: it.last_7_days?.volume ?? 0,
        med30: r(it.last_30_days?.median),
        avg30: r(it.last_30_days?.avg),
        vol30: it.last_30_days?.volume ?? 0,
        med90: r(it.last_90_days?.median),
      });
    }
    return out;
  }

  /** Steam: {price, volume, median} по одному предмету. */
  steamPrice(name, app = CS2) {
    return this.steamQueue.run(async () => {
      const data = await this.json(`https://steamcommunity.com/market/priceoverview/?appid=${app}&currency=${this.steamCurrency}&market_hash_name=${enc(name)}`);
      if (!data?.success) return null;
      const lowest = parsePrice(data.lowest_price);
      const median = parsePrice(data.median_price);
      const price = lowest ?? median;
      return price ? { price, volume: parseCount(data.volume), median } : null;
    });
  }

  /** Инвентарь CS2: Map<name, count>, общее число и предметы на удержании (marketable = 0). */
  inventory(steamid) {
    return this.steamQueue.run(async () => {
      const counts = new Map();
      const held = new Set();
      let total = 0;
      let start = null;
      for (let page = 0; page < 10; page++) {
        const url = `https://steamcommunity.com/inventory/${steamid}/730/2?l=english&count=1000${start ? `&start_assetid=${start}` : ''}`;
        let data;
        try {
          data = await this.json(url);
        } catch (e) {
          if (e.status === 403 || e.status === 401) throw Object.assign(new Error('private'), { code: 'private' });
          if (e.status === 429) throw Object.assign(new Error('rate'), { code: 'rate' });
          throw e;
        }
        if (!data || data.success === false) throw Object.assign(new Error('private'), { code: 'private' });
        const desc = new Map((data.descriptions || []).map((d) => [`${d.classid}_${d.instanceid}`, d]));
        for (const a of data.assets || []) {
          total += Number(a.amount) || 1;
          const d = desc.get(`${a.classid}_${a.instanceid}`);
          if (!d?.market_hash_name) continue;
          if (!d.marketable) held.add(d.market_hash_name);
          counts.set(d.market_hash_name, (counts.get(d.market_hash_name) || 0) + (Number(a.amount) || 1));
        }
        if (!data.more_items || !data.last_assetid) break;
        start = data.last_assetid;
        await new Promise((r) => setTimeout(r, this.steamQueue.gapMs));
      }
      return { counts, total, held };
    });
  }
}
