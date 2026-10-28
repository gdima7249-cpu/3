// Разбор страницы товара Яндекс Маркета.
//
// Страница отрисовывается на сервере, и в HTML лежат два набора данных:
//  - <script type="application/ld+json"> — schema.org Product: название, цена основного предложения, наличие;
//  - <noframes data-apiary="patch"> — JSON для гидрации. В collections.offerAnalytics у каждого
//    предложения есть price и oldPrice (зачёркнутая цена).
// Устройство страницы взято из открытого проекта price_watcher (github.com/Dushe4ka/price_watcher);
// на живой странице из этого репозитория оно не проверялось — если Маркет его поменяет,
// /debug в боте и `npm run probe` покажут, что именно пришло.
import { findPromos } from './promo.js';

const LD_RE = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
const PATCH_RE = /<noframes[^>]*data-apiary=["']patch["'][^>]*>([\s\S]*?)<\/noframes>/gi;
const PRODUCT_ID_RE = /\/(?:card\/[^/?#]+|product(?:--[^/?#]+)?)\/(\d+)/;
const CAPTCHA_URL_RE = /\/(?:showcaptcha|checkcaptcha|captcha)\b/i;
const CAPTCHA_HTML_RE = /SmartCaptcha|CheckboxCaptcha|AdvancedCaptcha|captcha__image|Вы не робот|Подтвердите, что запросы отправляли вы|not a robot/i;
const OUT_OF_STOCK_RE = /OutOfStock|SoldOut|Discontinued/i;

const ENTITIES = { quot: '"', amp: '&', lt: '<', gt: '>', apos: "'", nbsp: ' ' };
export const decodeEntities = (s) =>
  String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') return String.fromCodePoint(e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1)));
    return ENTITIES[e.toLowerCase()] ?? m;
  });

function parseJson(raw) {
  const s = raw.trim();
  if (!s) return undefined;
  try {
    return JSON.parse(s);
  } catch {
    try {
      return JSON.parse(decodeEntities(s));
    } catch {
      return undefined;
    }
  }
}

/** Цена из числа, строки («1 087,50 ₽») или объекта { value }. */
export function toPrice(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) && v > 0 ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[^\d.,]/g, '').replace(',', '.'));
    return Number.isFinite(n) && n > 0 ? n : null;
  }
  if (typeof v === 'object') return toPrice(v.value ?? v.amount ?? v.price ?? null);
  return null;
}

export const productIdFromUrl = (url) => String(url || '').match(PRODUCT_ID_RE)?.[1] || null;

/** Подсказки из адреса, какое именно предложение (продавца) открыто: do-waremd5, offerid и т. п. */
export function offerHintsFromUrl(url) {
  const hints = new Set();
  let sku = null;
  try {
    const u = new URL(url);
    for (const [k, v] of u.searchParams) {
      if (!v) continue;
      if (/waremd5|offer/i.test(k)) hints.add(v);
      else if (/^[A-Za-z0-9_-]{22}$/.test(v)) hints.add(v);
      if (k === 'sku' && /^\d+$/.test(v)) sku = v;
    }
  } catch {}
  return { offerHints: [...hints], sku };
}

export function ldJsonBlocks(html) {
  const out = [];
  for (const m of html.matchAll(LD_RE)) {
    const data = parseJson(m[1]);
    if (data !== undefined) out.push(...(Array.isArray(data) ? data : [data]));
  }
  return out;
}

function walkProducts(node, out = [], depth = 0) {
  if (depth > 5 || !node || typeof node !== 'object') return out;
  if (Array.isArray(node)) {
    for (const x of node) walkProducts(x, out, depth + 1);
    return out;
  }
  const type = [].concat(node['@type'] || []);
  if (type.includes('Product') || type.includes('IndividualProduct')) out.push(node);
  for (const v of Object.values(node)) if (v && typeof v === 'object') walkProducts(v, out, depth + 1);
  return out;
}

/** Предложения из Product.offers: Offer, AggregateOffer или массив. */
function ldOffers(product) {
  const out = [];
  const visit = (o, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 3) return;
    if (Array.isArray(o)) return o.forEach((x) => visit(x, depth + 1));
    const price = toPrice(o.price ?? o.lowPrice);
    out.push({
      price,
      currency: o.priceCurrency || null,
      availability: typeof o.availability === 'string' ? o.availability : null,
      seller: typeof o.seller === 'object' ? o.seller?.name || null : typeof o.seller === 'string' ? o.seller : null,
    });
    if (o.offers) visit(o.offers, depth + 1);
  };
  visit(product.offers);
  return out;
}

function ldProductId(p) {
  for (const key of ['url', '@id']) {
    const id = typeof p[key] === 'string' ? productIdFromUrl(p[key]) : null;
    if (id) return id;
  }
  return null;
}

export const patchBlocks = (html) => [...html.matchAll(PATCH_RE)].map((m) => parseJson(m[1])).filter((d) => d !== undefined);

/** Текст страницы без разметки, скриптов и служебных блоков. */
export const visibleText = (html) =>
  decodeEntities(html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>|<noframes[\s\S]*?<\/noframes>/gi, ' ').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ');

/** Все записи collections.offerAnalytics (и одноимённых коллекций глубже) из patch-блоков. */
export function offerEntries(html, blocks = patchBlocks(html)) {
  const entries = [];
  const find = (node, depth) => {
    if (!node || typeof node !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(node)) {
      if (k === 'offerAnalytics' && v && typeof v === 'object') {
        for (const [key, entry] of Object.entries(v)) if (entry && typeof entry === 'object') entries.push({ key, entry });
      } else if (v && typeof v === 'object') find(v, depth + 1);
    }
  };
  for (const data of blocks) find(data, 0);
  return { entries, blocks: blocks.length };
}

const shallowStrings = (entry) =>
  Object.values(entry).filter((v) => typeof v === 'string' || typeof v === 'number').map(String);

function entrySeller(entry) {
  for (const [k, v] of Object.entries(entry)) {
    if (typeof v === 'string' && v.trim() && /(shop|seller|supplier|business|vendor)_?name/i.test(k)) return v.trim();
  }
  return null;
}

function pageTitle(html) {
  const og = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["']/i)?.[1];
  const t = og || html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  if (!t) return null;
  return decodeEntities(t).replace(/\s+[—–-]\s+(купить|Яндекс).*$/i, '').trim() || null;
}

export const canonicalUrl = (html) =>
  html.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)?.[1] ||
  html.match(/<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i)?.[1] ||
  null;

/** Переход, который страница делает скриптом или meta refresh (например, короткая ссылка /cc/…). */
export function clientRedirect(html, baseUrl) {
  const patterns = [
    /<meta[^>]+http-equiv=["']refresh["'][^>]+content=["'][^"']*url=([^"'>]+)["']/i,
    /(?:window\.)?location(?:\.href)?\s*=\s*["']([^"']+)["']/i,
    /location\.(?:replace|assign)\(\s*["']([^"']+)["']\s*\)/i,
  ];
  for (const re of patterns) {
    const m = html.match(re);
    if (!m) continue;
    try {
      const u = new URL(decodeEntities(m[1].replace(/\\\//g, '/')), baseUrl);
      if (u.hostname === new URL(baseUrl).hostname || /(^|\.)(yandex\.[a-z]+|ya\.cc)$/i.test(u.hostname)) return u.href;
    } catch {}
  }
  return null;
}

export const looksLikeCaptcha = (html, url) => CAPTCHA_URL_RE.test(url || '') || CAPTCHA_HTML_RE.test(String(html).slice(0, 300_000));

/**
 * Главное: цена нужного предложения.
 * Порядок выбора: предложение из ссылки (do-waremd5/offerid) → предложение этого товара в offerAnalytics →
 * цена из JSON-LD → единственное предложение на странице → первое предложение (ненадёжно, matchedBy = 'first').
 */
export function parseMarketPage(html, url) {
  html = String(html || '');
  const productId = productIdFromUrl(url) || productIdFromUrl(canonicalUrl(html));
  const { offerHints, sku } = offerHintsFromUrl(url);
  const ld = ldJsonBlocks(html);
  const patches = patchBlocks(html);
  const products = walkProducts(ld);
  const { entries, blocks } = offerEntries(html, patches);

  const ldProduct = products.find((p) => productId && ldProductId(p) === productId) || products.find((p) => ldOffers(p).some((o) => o.price)) || products[0] || null;
  const ldOffer = ldProduct ? ldOffers(ldProduct).find((o) => o.price) || ldOffers(ldProduct)[0] || null : null;

  let chosen = null;
  let matchedBy = null;
  if (offerHints.length) {
    chosen = entries.find(({ key, entry }) => offerHints.includes(key) || shallowStrings(entry).some((s) => offerHints.includes(s)));
    if (chosen) matchedBy = 'offer';
  }
  if (!chosen && (productId || sku)) {
    const ids = [productId, sku].filter(Boolean);
    chosen = entries.find(({ entry }) => ['oskuId', 'marketSku', 'skuId', 'sku', 'productId', 'modelId'].some((k) => entry[k] != null && ids.includes(String(entry[k]))));
    if (chosen) matchedBy = 'product';
  }

  let price = null;
  let oldPrice = null;
  let seller = ldOffer?.seller || null;
  if (chosen && toPrice(chosen.entry.price)) {
    price = toPrice(chosen.entry.price);
    oldPrice = toPrice(chosen.entry.oldPrice);
    seller = entrySeller(chosen.entry) || seller;
  } else if (ldOffer?.price) {
    price = ldOffer.price;
    matchedBy = 'ld';
  } else {
    const priced = entries.filter(({ entry }) => toPrice(entry.price));
    if (priced.length) {
      chosen = priced[0];
      matchedBy = priced.length === 1 ? 'single' : 'first';
      price = toPrice(chosen.entry.price);
      oldPrice = toPrice(chosen.entry.oldPrice);
      seller = entrySeller(chosen.entry) || seller;
    }
  }
  if (oldPrice !== null && price !== null && oldPrice <= price) oldPrice = null;

  const availability = ldOffer?.availability || null;
  const inStock = availability ? !OUT_OF_STOCK_RE.test(availability) : price !== null ? true : null;
  const hasProduct = Boolean(products.length || entries.length);
  const captcha = !hasProduct && looksLikeCaptcha(html, url);

  const promos = findPromos({ text: visibleText(html), roots: [...patches, ...ld], offerKeys: [chosen?.key, productId, sku, ...offerHints].filter(Boolean) });

  return {
    ok: price !== null || (hasProduct && inStock === false),
    captcha,
    hasProduct,
    title: (typeof ldProduct?.name === 'string' && ldProduct.name.trim()) || pageTitle(html),
    price,
    oldPrice,
    currency: ldOffer?.currency || 'RUR',
    inStock,
    seller,
    productId,
    offerHints,
    matchedBy,
    promos,
    counts: { ldProducts: products.length, patchBlocks: blocks, offers: entries.length },
  };
}

/** Короткая сводка о странице для /debug: что нашлось и откуда взялась цена. */
export function summarizePage(html, url) {
  html = String(html || '');
  const trim = (v) => (typeof v === 'string' && v.length > 160 ? v.slice(0, 160) + '…' : v);
  const shallow = (obj) =>
    Object.fromEntries(
      Object.entries(obj)
        .filter(([, v]) => v === null || ['string', 'number', 'boolean'].includes(typeof v) || (v && typeof v === 'object' && 'value' in v))
        .slice(0, 40)
        .map(([k, v]) => [k, trim(v)]),
    );
  const priceTexts = [...visibleText(html).matchAll(/\d[\d\s\u00a0\u2009\u202f]{0,9}\s?₽/g)].slice(0, 25).map((m) => m[0].trim());
  return {
    url,
    htmlLength: html.length,
    title: pageTitle(html),
    canonical: canonicalUrl(html),
    captchaMarkers: looksLikeCaptcha(html, url),
    result: parseMarketPage(html, url),
    ldProducts: walkProducts(ldJsonBlocks(html)).slice(0, 10).map((p) => ({ name: trim(p.name), sku: p.sku, url: p.url || p['@id'], offers: ldOffers(p).slice(0, 10) })),
    offerAnalytics: offerEntries(html).entries.slice(0, 30).map(({ key, entry }) => ({ key, ...shallow(entry) })),
    priceTexts,
  };
}
