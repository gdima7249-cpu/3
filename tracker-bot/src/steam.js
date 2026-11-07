// Публичные API магазина Steam + CheapShark (история цен игр).
import { USER_AGENT } from './config.js';
// Все запросы к Steam идут через одну очередь с паузой: лимит ~200 запросов за 5 минут с IP.

export function parseSteamInput(text) {
  const t = String(text || '').trim();
  let m = t.match(/store\.steampowered\.com\/(?:app|agecheck\/app)\/(\d+)/i);
  if (m) return { type: 'app', appid: Number(m[1]) };
  m = t.match(/steamcommunity\.com\/profiles\/(\d{17})/i) || t.match(/store\.steampowered\.com\/wishlist\/profiles\/(\d{17})/i);
  if (m) return { type: 'profile', steamid: m[1] };
  m = t.match(/steamcommunity\.com\/id\/([\w-]+)/i) || t.match(/store\.steampowered\.com\/wishlist\/id\/([\w-]+)/i);
  if (m) return { type: 'vanity', name: m[1] };
  if (/^\d{17}$/.test(t)) return { type: 'profile', steamid: t };
  return { type: 'search', term: t.slice(0, 100) };
}

const SYMBOLS = { RUB: '₽', KZT: '₸', UAH: '₴', TRY: '₺', USD: '$', EUR: '€', PLN: 'zł', BYN: 'Br', GBP: '£', CNY: '¥', BRL: 'R$', INR: '₹' };

/** Сумма в минимальных единицах Steam (копейки/центы/тиыны) → «7 000 ₸». */
export function formatPrice(amount, currency) {
  if (amount == null) return '—';
  const v = amount / 100;
  const n = v.toLocaleString('ru-RU', { maximumFractionDigits: Number.isInteger(v) ? 0 : 2 });
  return `${n} ${SYMBOLS[currency] || currency || ''}`.trim();
}

export class SteamClient {
  constructor({ cc = 'ru', apiKey = '', minGapMs = 1500, fetchImpl = fetch } = {}) {
    this.cc = cc;
    this.apiKey = apiKey;
    this.minGapMs = minGapMs;
    this.fetch = fetchImpl;
    this.queue = Promise.resolve();
    this.last = 0;
  }

  get(url) {
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = this.last + this.minGapMs - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        this.last = Date.now();
        const res = await this.fetch(url, { headers: { 'accept-language': 'ru', 'user-agent': USER_AGENT }, signal: AbortSignal.timeout(20_000) });
        if (res.status === 429 || res.status >= 500) {
          await new Promise((r) => setTimeout(r, this.minGapMs * 20 * (attempt + 1)));
          continue;
        }
        if (!res.ok) throw new Error(`Steam HTTP ${res.status}: ${url.split('?')[0]}`);
        return res.json();
      }
      throw new Error('Steam временно ограничил запросы, попробуйте позже');
    };
    const p = this.queue.then(run, run);
    this.queue = p.catch(() => {});
    return p;
  }

  async search(term, cc = this.cc) {
    const data = await this.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(term)}&l=russian&cc=${cc}`);
    return (data?.items || [])
      .filter((i) => i.type === 'app')
      .slice(0, 6)
      .map((i) => ({ appid: i.id, name: i.name, price: i.price ? { initial: i.price.initial, final: i.price.final, currency: i.price.currency } : null }));
  }

  /** Название, цена в регионе, Metacritic. available=false — игра не продаётся в этом регионе. */
  async details(appid, cc = this.cc) {
    const data = await this.get(`https://store.steampowered.com/api/appdetails?appids=${appid}&cc=${cc}&l=russian`);
    const d = data?.[appid];
    if (!d?.success || !d.data) return { appid, available: false };
    const po = d.data.price_overview;
    return {
      appid,
      available: true,
      name: d.data.name,
      isFree: Boolean(d.data.is_free),
      metacritic: d.data.metacritic?.score ?? null,
      price: po ? { initial: po.initial, final: po.final, discount: po.discount_percent, currency: po.currency } : null,
    };
  }

  /**
   * Цены многих игр в регионе (Steam разрешает пакетный запрос только с filters=price_overview).
   * @returns {Map<number, {available, price|null}>}
   */
  async prices(appids, cc = this.cc) {
    const out = new Map();
    for (let i = 0; i < appids.length; i += 50) {
      const chunk = appids.slice(i, i + 50);
      const data = await this.get(`https://store.steampowered.com/api/appdetails?appids=${chunk.join(',')}&cc=${cc}&filters=price_overview`);
      for (const id of chunk) {
        const d = data?.[id];
        if (!d) continue;
        if (!d.success) {
          out.set(id, { available: false, price: null });
          continue;
        }
        const po = Array.isArray(d.data) ? null : d.data?.price_overview;
        out.set(id, { available: true, price: po ? { initial: po.initial, final: po.final, discount: po.discount_percent, currency: po.currency } : null });
      }
    }
    return out;
  }

  /** Отзывы Steam: {pct, desc, total}. */
  async reviews(appid) {
    const data = await this.get(`https://store.steampowered.com/appreviews/${appid}?json=1&language=all&purchase_type=all&num_per_page=0`);
    const s = data?.query_summary;
    if (!s?.total_reviews) return null;
    return { pct: Math.round((s.total_positive / s.total_reviews) * 100), desc: s.review_score_desc, total: s.total_reviews };
  }

  async wishlist(steamid) {
    const data = await this.get(`https://api.steampowered.com/IWishlistService/GetWishlist/v1/?steamid=${steamid}`);
    return (data?.response?.items || []).sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0)).map((i) => i.appid);
  }

  async resolveVanity(name) {
    if (!this.apiKey) return null;
    const data = await this.get(`https://api.steampowered.com/ISteamUser/ResolveVanityURL/v1/?key=${this.apiKey}&vanityurl=${encodeURIComponent(name)}`);
    return data?.response?.success === 1 ? data.response.steamid : null;
  }

  /**
   * История цен игры. Сначала IsThereAnyDeal (если задан ключ) — минимальная цена именно в Steam,
   * иначе CheapShark — минимальная цена во всех магазинах.
   * @returns {{low, regular, currency, maxDiscount, src} | null} null — нет данных; бросает при сетевой ошибке
   */
  async priceHistory(appid, { itadKey = '', itadCountry = 'US', log = null } = {}) {
    const note = (m) => log?.push(m);
    const j = async (url, init) => {
      const res = await this.fetch(url, { ...init, headers: { 'user-agent': USER_AGENT, ...(init?.headers || {}) }, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${url.split('?')[0]} ${body.slice(0, 150)}`);
      }
      return res.json();
    };
    if (itadKey) {
      try {
        const look = await j(`https://api.isthereanydeal.com/games/lookup/v1?key=${itadKey}&appid=${appid}`);
        note(`ITAD lookup: ${look?.found ? `найдена (${look.game?.title || look.game?.id})` : 'не найдена'}`);
        if (look?.found && look.game?.id) {
          const body = JSON.stringify([look.game.id]);
          const init = { method: 'POST', headers: { 'content-type': 'application/json' }, body };
          // Минимум именно в Steam (shop 61)…
          const lows = await j(`https://api.isthereanydeal.com/games/storelow/v2?key=${itadKey}&country=${itadCountry}&shops=61`, init);
          const low = (lows?.[0]?.lows || []).find((l) => l.shop?.id === 61);
          note(`ITAD storelow (Steam): ${low ? `−${low.cut}%` : 'нет данных'}`);
          if (low && low.cut != null) {
            return { low: low.price?.amount ?? null, regular: low.regular?.amount ?? null, currency: low.price?.currency || 'USD', maxDiscount: Math.round(low.cut), src: 'itad' };
          }
          // …иначе исторический минимум во всех магазинах.
          const hl = await j(`https://api.isthereanydeal.com/games/historylow/v1?key=${itadKey}&country=${itadCountry}`, init);
          const h = hl?.[0]?.low;
          note(`ITAD historylow: ${h ? `−${h.cut}% (${h.shop?.name})` : 'нет данных'}`);
          if (h && h.cut != null) {
            return { low: h.price?.amount ?? null, regular: h.regular?.amount ?? null, currency: h.price?.currency || 'USD', maxDiscount: Math.round(h.cut), src: 'itad-all' };
          }
        }
      } catch (e) {
        note(`ITAD ошибка: ${e.message}`);
        console.warn('[IsThereAnyDeal]', appid, e.message, '— пробую CheapShark');
      }
    } else note('ITAD: ключ не задан (ITAD_API_KEY)');
    const list = await j(`https://www.cheapshark.com/api/1.0/games?steamAppID=${appid}&limit=1`);
    const id = Array.isArray(list) && list[0]?.gameID;
    note(`CheapShark: ${id ? `найдена (id ${id})` : 'не найдена'}`);
    if (!id) return null;
    const g = await j(`https://www.cheapshark.com/api/1.0/games?id=${id}`);
    const low = Number(g?.cheapestPriceEver?.price);
    const regular = Math.max(0, ...(g?.deals || []).map((d) => Number(d.retailPrice) || 0));
    if (!(low >= 0) || !(regular > 0)) return null;
    return { low, regular, currency: 'USD', maxDiscount: Math.max(0, Math.round((1 - low / regular) * 100)), src: 'cheapshark' };
  }
}

// ---------- «Возможно, вы имели в виду» ----------
const GAME_ALIASES = {
  гта: 'grand theft auto', gta: 'grand theft auto', ведьмак: 'the witcher', киберпанк: 'cyberpunk 2077', кс: 'counter-strike', ксго: 'counter-strike',
  кс2: 'counter-strike 2', дота: 'dota 2', майнкрафт: 'minecraft', сталкер: 'stalker', скайрим: 'skyrim', фоллаут: 'fallout',
  рдр: 'red dead redemption', rdr: 'red dead redemption', хогвартс: 'hogwarts legacy', элден: 'elden ring', балдур: "baldur's gate", балдурс: "baldur's gate",
  балдурсгейт: "baldur's gate", бг3: "baldur's gate 3", bg3: "baldur's gate 3", террария: 'terraria', раст: 'rust', дейз: 'dayz', пабг: 'pubg', пубг: 'pubg', апекс: 'apex legends',
  форза: 'forza horizon', нфс: 'need for speed', nfs: 'need for speed', ассасин: "assassin's creed", ac: "assassin's creed", фаркрай: 'far cry',
  метро: 'metro', хадес: 'hades', халфлайф: 'half-life', портал: 'portal', сабнатика: 'subnautica', валхейм: 'valheim', резидент: 'resident evil',
  ре: 'resident evil', фифа: 'ea sports fc', мортал: 'mortal kombat', мк: 'mortal kombat', хитман: 'hitman', симс: 'the sims', цивилизация: "sid meier's civilization",
  цива: "sid meier's civilization", стардью: 'stardew valley', холлоу: 'hollow knight', факторио: 'factorio', дарксоулс: 'dark souls', ds: 'dark souls',
  сайлент: 'silent hill', годофвар: 'god of war', гов: 'god of war', детройт: 'detroit become human', ластофас: 'the last of us', тлоу: 'the last of us',
};
const TRANSLIT = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya' };
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X'];

const translit = (s) => s.replace(/[а-яё]/g, (c) => TRANSLIT[c] ?? c);
const romanize = (s) => s.replace(/\b([1-9]|10)\b/g, (n) => ROMAN[Number(n)]);
const deromanize = (s) => s.replace(/\b(ii|iii|iv|v|vi|vii|viii|ix|x)\b/gi, (r) => String(ROMAN.indexOf(r.toUpperCase())));
function dictReplace(s) {
  // склеиваем пары слов («дарк соулс» → «дарксоулс»), если такая пара есть в словаре
  const words = s.split(' ');
  const out = [];
  for (let i = 0; i < words.length; i++) {
    const pair = words[i] + (words[i + 1] || '');
    if (words[i + 1] && GAME_ALIASES[pair]) {
      out.push(GAME_ALIASES[pair]);
      i++;
    } else out.push(GAME_ALIASES[words[i]] || words[i]);
  }
  return out.join(' ');
}

/** Варианты написания запроса, от самого вероятного. Исходный запрос не включается. */
export function queryVariants(term) {
  const t = term.toLowerCase().replace(/[^\p{L}\p{N}' -]/gu, ' ').replace(/\s+/g, ' ').trim();
  const d = dictReplace(t);
  const v = [romanize(d), d, translit(romanize(d)), translit(d), romanize(t), deromanize(t)];
  return [...new Set(v.map((x) => x.trim()))].filter((x) => x && x !== t && x !== term.toLowerCase().trim());
}
