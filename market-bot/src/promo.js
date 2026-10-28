// Промокоды на странице товара: «−5% по промокоду», «Промокод SALE5: скидка 5% до 500 ₽», «950 ₽ с промокодом».
//
// Как именно Маркет показывает промокоды в данных страницы, проверить не на чем (живая страница недоступна),
// поэтому ищем двумя способами и помечаем, откуда взялось:
//  - data — объект в JSON страницы, где есть слово «промокод» или поле promoCode/promocode;
//    related = в нём упоминается выбранное предложение или товар;
//  - text — фрагмент видимого текста рядом со словом «промокод».
// Всё найденное попадает в /debug, чтобы по живой странице можно было уточнить поиск.

import { ruNumber } from './stats.js';

const PROMO_WORD = /промо-?код/i;
const PROMO_KEY = /promo_?code|promocode/i;
const MONTHS = 'января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря';
const NUM = '(\\d[\\d\\s\\u00a0\\u202f]{0,8}\\d|\\d)';
const RE = {
  percent: /(\d{1,2}(?:[.,]\d)?)\s?%/,
  cap: new RegExp(`до\\s+${NUM}\\s?(?:₽|руб)`, 'i'),
  until: new RegExp(`до\\s+(\\d{1,2}\\s+(?:${MONTHS})|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?)`, 'i'),
  code: /[Пп]ромо-?код[а-яё]*\s*[:«"„“']?\s*([A-ZА-ЯЁ0-9][A-ZА-ЯЁ0-9_-]{3,19})(?![a-zа-яё])/,
  priceBefore: new RegExp(`${NUM}\\s?₽\\s*(?:с|по)\\s+промо-?код`, 'i'),
  priceAfter: new RegExp(`(?:с|по)\\s+промо-?код[а-яё]*\\s*[:—–-]?\\s*${NUM}\\s?₽`, 'i'),
};

const toNum = (s) => (s === undefined || s === null ? null : Number(String(s).replace(/[\s  ]/g, '').replace(',', '.')) || null);

/** Процент, потолок скидки, срок, код и цену с промокодом из одной строки. */
export function promoFromText(s) {
  const percent = toNum(s.match(RE.percent)?.[1]);
  return {
    percent: percent > 0 && percent < 100 ? percent : null,
    maxDiscount: toNum(s.match(RE.cap)?.[1]),
    until: s.match(RE.until)?.[1] || null,
    code: s.match(RE.code)?.[1] || null,
    priceWithPromo: toNum((s.match(RE.priceBefore) || s.match(RE.priceAfter))?.[1]),
  };
}

function fromObject(obj, offerKeys) {
  const prims = Object.entries(obj).filter(([, v]) => typeof v === 'string' || typeof v === 'number');
  const words = prims.filter(([, v]) => typeof v === 'string' && PROMO_WORD.test(v)).map(([, v]) => v);
  const keyHit = Object.keys(obj).some((k) => PROMO_KEY.test(k)) || prims.some(([, v]) => typeof v === 'string' && /^promo-?code$/i.test(v));
  if (!keyHit && !words.length) return null;
  const c = promoFromText(words.join(' · '));
  for (const [k, v] of prims) {
    const n = typeof v === 'number' ? v : /^\d+(?:[.,]\d+)?$/.test(v) ? toNum(v) : null;
    if (n !== null) {
      if (c.percent === null && /percent|discount/i.test(k) && n > 0 && n < 100) c.percent = n;
      else if (c.maxDiscount === null && /max|limit|cap|upto/i.test(k) && n > 0) c.maxDiscount = n;
    } else if (c.code === null && PROMO_KEY.test(k) && /^[A-ZА-ЯЁ0-9_-]{4,20}$/i.test(v)) {
      c.code = v;
    }
  }
  const strings = prims.map(([, v]) => String(v));
  return { ...c, source: 'data', related: offerKeys.some((key) => strings.includes(key)), snippet: (words[0] || JSON.stringify(Object.fromEntries(prims.slice(0, 8)))).slice(0, 200) };
}

/**
 * Все упоминания промокодов. text — видимый текст страницы; roots — разобранные JSON-блоки;
 * offerKeys — id выбранного предложения и товара.
 */
export function findPromos({ text = '', roots = [], offerKeys = [] }) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 10) return;
    if (!Array.isArray(node)) {
      const c = fromObject(node, offerKeys);
      if (c) out.push(c);
    }
    for (const v of Object.values(node)) if (v && typeof v === 'object') walk(v, depth + 1);
  };
  roots.forEach((r) => walk(r, 0));

  for (const m of text.matchAll(/промо-?код/gi)) {
    const snippet = text.slice(Math.max(0, m.index - 60), m.index + 100).trim();
    out.push({ ...promoFromText(snippet), source: 'text', related: false, snippet });
  }

  // Без процента и без цены с промокодом это просто ссылка «Промокоды» в меню — не считаем.
  const seen = new Set();
  return out.filter((c) => {
    if (c.percent === null && c.priceWithPromo === null) return false;
    const key = [c.percent, c.maxDiscount, c.code, c.priceWithPromo, c.source].join('|');
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Нужный промокод среди найденных. want.percent — какой процент ищем (0 — любой), price — цена товара.
 * Цена «с промокодом» без процента подходит, если скидка по ней не больше нужного процента.
 */
export function pickPromo(candidates = [], { percent = 0, price = null } = {}) {
  const rank = (c) => (c.related ? 0 : c.source === 'data' ? 1 : 2);
  const sorted = [...candidates].sort((a, b) => rank(a) - rank(b));
  const fits = (c) => {
    if (!percent) return true;
    if (c.percent !== null) return c.percent === percent;
    return price !== null && c.priceWithPromo < price && (1 - c.priceWithPromo / price) * 100 <= percent + 0.5;
  };
  const promo = sorted.find(fits) || null;
  return { promo, others: sorted.filter((c) => c !== promo && c.percent !== promo?.percent) };
}

/** Цена к оплате с промокодом: со страницы, если она там есть, иначе расчёт (процент, потолок «до N ₽»). */
export function promoPrice(price, promo, { percent = 0, maxDiscount = null } = {}) {
  if (!promo || price === null) return null;
  if (promo.priceWithPromo && promo.priceWithPromo < price) return { value: promo.priceWithPromo, exact: true };
  const p = promo.percent ?? percent;
  if (!p) return null;
  let discount = (price * p) / 100;
  const cap = promo.maxDiscount ?? maxDiscount;
  if (cap) discount = Math.min(discount, cap);
  return { value: Math.round((price - discount) * 100) / 100, exact: false };
}

export const promoLabel = (c, fallbackCap = null) => {
  if (!c) return '';
  const cap = c.maxDiscount ?? fallbackCap;
  return `${c.percent ? `−${String(c.percent).replace('.', ',')}%` : 'со скидкой'}${cap ? ` (до ${ruNumber(Math.round(cap))} ₽)` : ''}`;
};
