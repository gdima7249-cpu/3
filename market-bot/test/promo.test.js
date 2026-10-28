import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promoFromText, findPromos, pickPromo, promoPrice, promoLabel } from '../src/promo.js';
import { parseMarketPage } from '../src/parse.js';
import { openDb } from '../src/db.js';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productHtml, WARE } from './fixtures.js';

const CARD = `https://market.yandex.ru/card/karta-steam/123?do-waremd5=${WARE}`;

test('разбор текста промокода', () => {
  assert.deepEqual(promoFromText('Промокод STEAM5: скидка 5% до 500 ₽'), { percent: 5, maxDiscount: 500, until: null, code: 'STEAM5', priceWithPromo: null });
  assert.deepEqual(promoFromText('−5% по промокоду до 31 октября'), { percent: 5, maxDiscount: null, until: '31 октября', code: null, priceWithPromo: null });
  assert.equal(promoFromText('1 033 ₽ с промокодом').priceWithPromo, 1033);
  assert.equal(promoFromText('С промокодом — 1 033 ₽').priceWithPromo, 1033);
  assert.equal(promoFromText('скидка 5% до 1 000 ₽ по промокоду').maxDiscount, 1000);
  assert.equal(promoFromText('промокод на скидку').code, null);
});

test('поиск: текст страницы и данные, ссылка «Промокоды» в меню не считается', () => {
  const found = findPromos({ text: 'Главная Промокоды Корзина · Карта Steam 1087 ₽ −5% по промокоду · Отзывы', roots: [] });
  assert.equal(found.length, 1);
  assert.equal(found[0].percent, 5);
  assert.equal(found[0].source, 'text');

  const data = findPromos({ roots: [{ list: [{ offerId: WARE, promoCode: 'SALE5', discountPercent: 5, maxDiscount: 300 }] }], offerKeys: [WARE] });
  assert.deepEqual([data[0].percent, data[0].maxDiscount, data[0].code, data[0].related, data[0].source], [5, 300, 'SALE5', true, 'data']);
  // Обычная скидка (не промокод) — не считается
  assert.equal(findPromos({ roots: [{ promo: { type: 'direct-discount', discountPercent: 10 } }] }).length, 0);
});

test('выбор нужного процента и цена с промокодом', () => {
  const c = [
    { percent: 10, maxDiscount: null, priceWithPromo: null, source: 'text', related: false },
    { percent: 5, maxDiscount: 30, priceWithPromo: null, source: 'text', related: false },
  ];
  assert.equal(pickPromo(c, { percent: 5 }).promo.percent, 5);
  assert.equal(pickPromo(c, { percent: 5 }).others[0].percent, 10);
  assert.equal(pickPromo(c, { percent: 0 }).promo.percent, 10);
  assert.equal(pickPromo(c, { percent: 7 }).promo, null);
  // Цена «с промокодом» без процента: скидка 5% — подходит для «5%», 20% — нет
  assert.ok(pickPromo([{ percent: null, priceWithPromo: 950, source: 'text' }], { percent: 5, price: 1000 }).promo);
  assert.equal(pickPromo([{ percent: null, priceWithPromo: 800, source: 'text' }], { percent: 5, price: 1000 }).promo, null);

  assert.deepEqual(promoPrice(1087, { percent: 5, maxDiscount: null }), { value: 1032.65, exact: false });
  assert.deepEqual(promoPrice(1087, { percent: 5, maxDiscount: 30 }), { value: 1057, exact: false });
  assert.deepEqual(promoPrice(1087, { percent: 5, maxDiscount: null }, { maxDiscount: 50 }), { value: 1037, exact: false });
  assert.deepEqual(promoPrice(1087, { percent: 5, priceWithPromo: 1033 }), { value: 1033, exact: true });
  assert.equal(promoLabel({ percent: 5, maxDiscount: 500 }), '−5% (до 500 ₽)');
});

test('промокод на странице товара', () => {
  const r = parseMarketPage(productHtml({ promoText: 'Ещё −5% по промокоду до 500 ₽' }), CARD);
  assert.equal(r.price, 1087);
  assert.equal(r.promos[0].percent, 5);
  assert.equal(r.promos[0].maxDiscount, 500);
  assert.equal(parseMarketPage(productHtml(), CARD).promos.length, 0);
  const d = parseMarketPage(productHtml({ promoData: { [WARE]: { promoCode: 'PLUS5', description: 'Скидка 5% по промокоду' } } }), CARD);
  assert.equal(d.promos[0].code, 'PLUS5');
  assert.equal(d.promos[0].related, false);
});

test('старая база получает колонки промокода', () => {
  const path = join(mkdtempSync(join(tmpdir(), 'market-bot-')), 'old.db');
  const old = new DatabaseSync(path);
  old.exec('CREATE TABLE checks (id INTEGER PRIMARY KEY, item_id INTEGER, ts INTEGER, day TEXT, ok INTEGER, price REAL, old_price REAL, in_stock INTEGER, seller TEXT, via TEXT, error TEXT, manual INTEGER NOT NULL DEFAULT 0)');
  old.close();
  const db = openDb(path);
  const cols = db.prepare('PRAGMA table_info(checks)').all().map((c) => c.name);
  assert.ok(['promo', 'promo_price', 'promo_info'].every((c) => cols.includes(c)));
});
