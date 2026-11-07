// Оценки: «стоит ли покупать/продавать скин по такой цене» и «стоит ли брать игру сейчас».
// Это эвристики по истории цен, а не финансовый совет — так и пишем пользователю.
import { SOURCES, STEAM_FEE } from './markets.js';
import { priceOn, bestSource } from './catalog.js';

const rub = (n) => (n == null ? '—' : `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 2 })} ₽`);
const median = (arr) => {
  const a = [...arr].sort((x, y) => x - y);
  return a.length ? (a.length % 2 ? a[(a.length - 1) / 2] : (a[a.length / 2 - 1] + a[a.length / 2]) / 2) : null;
};
const diffPct = (a, b) => ((a - b) / b) * 100;
const fmtPct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;

/**
 * Оценка рынка скина.
 * Опорная цена (что считать «нормальной» ценой), по приоритету:
 *  1) наша история лучшей цены за 30 дней (если накоплено ≥ 7 дней);
 *  2) медиана продаж Skinport за 30 дней — сравниваем с текущей ценой Skinport;
 *  3) медиана недавних продаж в Steam — сравниваем с самым дешёвым лотом Steam.
 */
export function analyzeSkin(skin, history, bulkSources) {
  const lines = [];
  let ref = null;
  let cur = null;
  let basis = '';
  let trend = null;

  const best = bestSource(skin, bulkSources);
  if (history.length >= 7 && best) {
    ref = median(history.map((h) => h.price));
    cur = best.price;
    basis = `медиана лучшей цены за ${history.length} дн. (по данным бота)`;
    const last7 = history.slice(-7).map((h) => h.price);
    trend = diffPct(median(last7), ref);
  } else if (skin.stats?.med30 && skin.prices.s?.price) {
    ref = skin.stats.med30;
    cur = skin.prices.s.price;
    basis = 'медиана продаж на Skinport за 30 дней';
    if (skin.stats.med7) trend = diffPct(skin.stats.med7, skin.stats.med30);
  } else if (skin.prices.t?.median && skin.prices.t?.price) {
    ref = skin.prices.t.median;
    cur = skin.prices.t.price;
    basis = 'медиана недавних продаж в Steam';
  }

  if (ref == null) {
    return {
      text: '📊 <b>Оценка рынка</b>\n\nПока мало данных по этому предмету: нет истории продаж. Бот накапливает историю цен — загляните через несколько дней.',
      verdict: null,
    };
  }

  const d = diffPct(cur, ref);
  let verdict;
  if (d <= -7) verdict = { icon: '🟢', buy: `Выгодно покупать: цена на ${fmtPct(-d).replace('+', '')} ниже обычной`, code: 'buy' };
  else if (d >= 7) verdict = { icon: '🔴', buy: `Дорого: цена на ${fmtPct(d).replace('+', '')} выше обычной — с покупкой лучше подождать`, code: 'wait' };
  else verdict = { icon: '🟡', buy: 'Обычная цена — без явной выгоды', code: 'fair' };

  lines.push('📊 <b>Оценка рынка</b>', '', `${verdict.icon} <b>${verdict.buy}</b>`);
  lines.push(`Сейчас: ${rub(cur)} · обычно: ${rub(ref)} (${basis})`);
  if (trend != null) {
    const t = Math.abs(trend) < 3 ? '➡️ Цена стабильна' : trend > 0 ? `📈 Цена растёт: за неделю ${fmtPct(trend)} к месяцу` : `📉 Цена падает: за неделю ${fmtPct(trend)} к месяцу`;
    lines.push(t);
  }

  // Где купить и где продать.
  if (best) lines.push('', `🛒 Купить дешевле всего: <b>${SOURCES[best.src].title}</b> — ${rub(best.price)}`);
  const sells = [];
  for (const k of bulkSources) if (skin.prices[k]?.price) sells.push({ k, gross: skin.prices[k].price, net: null });
  if (skin.prices.t?.price) sells.push({ k: 't', gross: skin.prices.t.price, net: skin.prices.t.price * (1 - STEAM_FEE) });
  const topSell = sells.sort((a, b) => b.gross - a.gross)[0];
  if (topSell && sells.length > 1) {
    lines.push(`💰 Самая высокая цена: <b>${SOURCES[topSell.k].title}</b> — ${rub(topSell.gross)}${topSell.net ? ` (на руки ~${rub(topSell.net)}, деньги в кошельке Steam)` : ''}`);
  }
  if (verdict.code === 'wait' || (trend != null && trend >= 5)) lines.push('💡 Если продаёте — сейчас удачный момент.');
  else if (verdict.code === 'buy') lines.push('💡 Если продаёте — цена сейчас ниже обычной, можно подождать.');

  const vol = skin.stats?.vol7 ?? skin.prices.t?.volume;
  if (vol != null) lines.push('', `Ликвидность: ${vol < 5 ? '🐢 низкая — продать будет непросто' : vol < 50 ? 'средняя' : 'высокая'} (${vol} продаж за неделю)`);
  lines.push('', '<i>Это автоматическая оценка по истории цен, а не финансовый совет.</i>');
  return { text: lines.join('\n'), verdict: verdict.code, ref, cur };
}

/** Порог для «просто следить»: чем дороже предмет, тем меньший процент считаем значимым. */
export function autoThreshold(price) {
  if (price == null) return 10;
  if (price < 100) return 15;
  if (price < 1000) return 10;
  if (price < 10000) return 7;
  return 5;
}

// ---------- игры ----------
const REVIEW_RU = {
  'overwhelmingly positive': 'Крайне положительные',
  'very positive': 'Очень положительные',
  positive: 'Положительные',
  'mostly positive': 'В основном положительные',
  mixed: 'Смешанные',
  'mostly negative': 'В основном отрицательные',
  negative: 'Отрицательные',
  'very negative': 'Очень отрицательные',
  'overwhelmingly negative': 'Крайне отрицательные',
};
export const reviewRu = (desc) => REVIEW_RU[String(desc || '').toLowerCase()] || desc || '';

export function ratingLine(g) {
  const parts = [];
  if (g?.rating_pct != null && g.rating_total) {
    const icon = g.rating_pct >= 80 ? '👍' : g.rating_pct >= 60 ? '👌' : '👎';
    const total = g.rating_total >= 1000 ? `${Math.round(g.rating_total / 1000)} тыс.` : g.rating_total;
    parts.push(`${icon} ${g.rating_pct}% положительных (${reviewRu(g.rating_desc)}, ${total} отзывов)`);
  }
  if (g?.metacritic) parts.push(`Metacritic: ${g.metacritic}`);
  return parts.join(' · ');
}

/** Максимальная скидка из прошлого: внешняя история + распродажи, которые закончились при боте. Текущая не считается. */
export const maxKnownDiscount = (g) => Math.max(g?.hist_max_discount || 0, g?.past_max_discount || 0) || null;

/** «Стоит ли брать» по текущей скидке относительно лучших прошлых. */
export function gameVerdict(g, p) {
  if (!p || p.final == null || !p.available) return null;
  const maxD = maxKnownDiscount(g);
  const cur = p.discount || 0;
  if (!maxD || maxD < 10) {
    return cur > 0 ? { icon: '🟡', text: `Скидка −${cur}%. Истории прошлых распродаж пока нет — сравнить не с чем` } : null;
  }
  if (cur > maxD) return { icon: '🟢', text: `Рекорд: скидка −${cur}% больше, чем когда-либо раньше (до −${maxD}%). Можно брать` };
  if (cur >= maxD - 5) return { icon: '🟢', text: `Хорошая цена — скидка на уровне лучших (рекорд −${maxD}%). Можно брать` };
  if (cur > 0) return { icon: '🟡', text: `Лучше подождать: раньше скидка доходила до −${maxD}%, сейчас только −${cur}%` };
  return { icon: '🔴', text: `Сейчас без скидки. Бывало до −${maxD}% — лучше дождаться распродажи` };
}

// ---------- подборка для инвестиций ----------
export const BUDGETS = {
  a: { title: 'Любой бюджет', min: 0, max: Infinity },
  b1: { title: 'до 1 000 ₽', min: 0, max: 1000 },
  b2: { title: '1–10 тыс. ₽', min: 1000, max: 10000 },
  b3: { title: '10–50 тыс. ₽', min: 10000, max: 50000 },
  b4: { title: 'от 50 тыс. ₽', min: 50000, max: Infinity },
};

/**
 * Кандидаты: {id, name, sp (текущая цена Skinport), best, bestSrc, med7, med30, vol7}.
 * Сигнал считаем «яблоки к яблокам»: текущая цена Skinport против медианы продаж Skinport.
 *  • «Ниже обычной цены»: дешевле медианы месяца на 5–40% (больше — скорее ошибка данных), неделя не обвалилась.
 *  • «В росте»: медиана недели выше медианы месяца на 8%+, но купить можно не дороже недельной медианы.
 * Везде нужна ликвидность — чтобы предмет потом можно было продать.
 */
export function investPicks(cands, { budget = 'a', minVolume = 15, minPrice = 30 } = {}) {
  const b = BUDGETS[budget] || BUDGETS.a;
  const cheap = [];
  const rising = [];
  for (const c of cands) {
    if (!(c.best >= minPrice) || c.best < b.min || c.best >= b.max) continue;
    if (!(c.vol7 >= minVolume) || !(c.med30 > 0) || !(c.sp > 0)) continue;
    const disc = ((c.med30 - c.sp) / c.med30) * 100;
    const trend = c.med7 ? ((c.med7 - c.med30) / c.med30) * 100 : 0;
    const liq = Math.log10(1 + c.vol7);
    if (disc >= 5 && disc <= 40 && trend >= -5) cheap.push({ ...c, disc, trend, score: disc + Math.max(trend, 0) * 0.5 + liq * 3 });
    else if (trend >= 8 && trend <= 60 && c.sp <= c.med7 * 1.03) rising.push({ ...c, disc, trend, score: trend + liq * 3 });
  }
  cheap.sort((x, y) => y.score - x.score);
  rising.sort((x, y) => y.score - x.score);
  return { cheap: cheap.slice(0, 7), rising: rising.slice(0, 3) };
}

// ---------- цена по рынку: средняя, «покупают за», ликвидность, рекомендуемая цена ----------
// Оверпрайс: предложение дороже медианы площадок больше чем на 50% не учитываем.
const OVERPRICE = 1.5;
// Ликвидность — продаж в день: от 20 высокая, от 3 средняя, меньше — низкая.
export const LIQUIDITY = [
  { min: 20, code: 'high', title: 'ВЫСОКАЯ' },
  { min: 3, code: 'mid', title: 'СРЕДНЯЯ' },
  { min: 0, code: 'low', title: 'НИЗКАЯ' },
];
const roundPrice = (p) => (p < 10 ? Math.round(p * 100) / 100 : p < 1000 ? Math.round(p) : Math.round(p / 10) * 10);

/**
 * Сводка для карточки скина.
 *  avg     — «средняя цена на площадках»: медиана самых дешёвых предложений каждой площадки без оверпрайса;
 *  sold    — «покупают в среднем за»: медиана реальных продаж (Skinport за 7/30 дней, иначе Steam);
 *  perDay  — продаж в день (Steam за сутки, иначе Skinport за неделю / 7) → ликвидность;
 *  rec     — рекомендуемая цена продажи: между «покупают за» и средней ценой (ближе к продажам, если ликвидность низкая),
 *            но не дороже самого дешёвого конкурента и не дешевле «покупают за».
 * Если продажи известны только по Steam, рекомендация считается для Steam (scope = 'steam').
 */
export function skinInsight(skin, bulkSources) {
  const offers = bulkSources.filter((k) => skin.prices[k]?.price > 0).map((k) => ({ src: k, price: skin.prices[k].price }));
  const med = median(offers.map((o) => o.price));
  const fair = offers.filter((o) => o.price <= med * OVERPRICE);
  const st = skin.stats;
  const steam = skin.prices.t;

  let sold = null;
  let soldSrc = null;
  let scope = 'platforms';
  if (st?.med7 && st.vol7 >= 3) [sold, soldSrc] = [st.med7, 'продажи Skinport за 7 дней'];
  else if (st?.med30 && st.vol30 >= 3) [sold, soldSrc] = [st.med30, 'продажи Skinport за 30 дней'];
  else if (steam?.median) [sold, soldSrc, scope] = [steam.median, 'продажи в Steam', 'steam'];

  let perDay = null;
  let perDaySrc = null;
  if (steam?.volume) [perDay, perDaySrc] = [steam.volume, 'Steam'];
  else if (st?.vol7 != null) [perDay, perDaySrc] = [Math.round((st.vol7 / 7) * 10) / 10, 'Skinport'];
  const liq = perDay == null ? null : LIQUIDITY.find((l) => perDay >= l.min);

  const avg = fair.length ? median(fair.map((o) => o.price)) : null;
  const ref = scope === 'steam' ? steam?.price : avg; // с чем сравниваем «покупают за»
  const cheapest = scope === 'steam' ? steam?.price : fair.length ? Math.min(...fair.map((o) => o.price)) : null;
  let rec = null;
  if (sold && ref) {
    const k = liq?.code === 'low' ? 0.3 : 0.5;
    rec = ref > sold ? Math.max(sold, Math.min(sold + (ref - sold) * k, cheapest)) : ref;
    rec = roundPrice(rec);
  }
  if (avg == null && sold == null && perDay == null) return null;
  return { avg, platforms: fair.length, overpriced: offers.length - fair.length, cheapest, sold, soldSrc, perDay, perDaySrc, liq, rec, scope };
}

/** Строки для карточки. full = false — только средняя цена (бесплатный тариф). */
export function insightLines(i, { full }) {
  if (!i) return [];
  const lines = [];
  if (i.avg != null) lines.push(`📊 Средняя цена на площадках: <b>${rub(i.avg)}</b>${i.overpriced ? ' (без оверпрайса)' : ''}`);
  if (!full) return lines;
  if (i.sold != null) lines.push(`🛒 Покупают в среднем за: <b>${rub(i.sold)}</b> (${i.soldSrc})`);
  if (i.liq) lines.push(`💧 Ликвидность: <b>${i.liq.title}</b> (≈${i.perDay.toLocaleString('ru-RU')} продаж в день, ${i.perDaySrc})`);
  if (i.rec != null) lines.push(`💡 Рекомендуем выставить за: <b>${rub(i.rec)}</b>${i.scope === 'steam' ? ' в Steam' : ''}`);
  return lines;
}

// ---------- УЛЬТРА: где продать, пополнение Steam, сигналы ----------
// Везде «реальная» цена продажи — не цена чужих лотов, а за сколько покупают:
// не дороже самого дешёвого лота (иначе купят у конкурента) и не дороже медианы продаж.
const realSell = (ask, sold) => (ask > 0 && sold > 0 ? Math.min(ask, sold) : sold > 0 ? sold : null);

/**
 * Где выгоднее продать. skinportFee — комиссия Skinport с продавца, доля (0.08), null — неизвестна.
 * Steam: на кошелёк Steam после комиссии 13%; вывести эти деньги нельзя.
 */
export function sellOptions(skin, { skinportFee = null } = {}) {
  const out = [];
  const st = skin.stats;
  const sp = skin.prices.s;
  const spSold = st?.vol7 >= 3 ? st.med7 : st?.vol30 >= 3 ? st.med30 : null;
  const spReal = realSell(sp?.price, spSold);
  if (spReal) out.push({ src: 's', gross: spReal, net: skinportFee != null ? spReal * (1 - skinportFee) : null, wallet: false });
  const t = skin.prices.t;
  const tReal = t?.price > 0 ? realSell(t.price, t.median) : null;
  if (tReal) out.push({ src: 't', gross: tReal, net: tReal * (1 - STEAM_FEE), wallet: true });
  return out;
}

export function sellLines(skin, opts) {
  const o = sellOptions(skin, opts);
  if (!o.length) return [];
  const lines = ['💰 <b>Продать</b> (по реальным продажам):'];
  for (const x of o) {
    if (x.wallet) lines.push(`  Steam: ~${rub(x.gross)} → <b>~${rub(x.net)}</b> на кошелёк Steam (вывести нельзя)`);
    else if (x.net != null) lines.push(`  Skinport: ~${rub(x.gross)} → <b>~${rub(x.net)}</b> на руки после комиссии`);
    else lines.push(`  Skinport: ~${rub(x.gross)} до комиссии площадки`);
  }
  const cash = o.find((x) => !x.wallet);
  const steam = o.find((x) => x.wallet);
  if (cash && steam && cash.net != null) {
    lines.push(cash.net >= steam.net ? '  👉 На Skinport выйдет не меньше, и это настоящие деньги' : `  👉 В Steam больше на ${Math.round((steam.net / cash.net - 1) * 100)}%, но только на кошелёк Steam`);
  }
  return lines;
}

/**
 * Пополнение Steam через скин: купить дешевле всего на площадке, продать в Steam.
 * rate — сколько рублей платите за 1 ₽ на кошельке Steam (меньше 1 — выгоднее, чем пополнять напрямую без комиссии).
 */
export function topupRate(skin, bulkSources, { minVolume = 50 } = {}) {
  const buy = bestSource(skin, bulkSources);
  const t = skin.prices.t;
  if (!buy || !(t?.price > 0) || !(t.volume >= minVolume)) return null;
  const sell = realSell(t.price, t.median);
  const wallet = sell * (1 - STEAM_FEE);
  return { buy: buy.price, buySrc: buy.src, sell, wallet, rate: buy.price / wallet, volume: t.volume };
}

/**
 * Сигналы по скину. buyPct — насколько лучшая цена должна быть ниже цены продаж, чтобы советовать купить;
 * sellPct — насколько продажи за неделю выше месяца, чтобы советовать продать. Только при высокой или средней ликвидности.
 */
export function skinSignals(skin, bulkSources, { buyPct = 10, sellPct = 15 } = {}) {
  const i = skinInsight(skin, bulkSources);
  if (!i?.liq || i.liq.code === 'low') return {};
  const out = {};
  const best = bestSource(skin, bulkSources);
  if (best && i.sold && i.scope === 'platforms' && best.price <= i.sold * (1 - buyPct / 100)) {
    out.buy = { price: best.price, src: best.src, sold: i.sold, off: (1 - best.price / i.sold) * 100, liq: i.liq };
  }
  const st = skin.stats;
  if (st?.med7 && st.med30 && st.vol7 >= 3 && st.med7 >= st.med30 * (1 + sellPct / 100)) {
    out.sell = { med7: st.med7, med30: st.med30, up: (st.med7 / st.med30 - 1) * 100, liq: i.liq };
  }
  return out;
}
