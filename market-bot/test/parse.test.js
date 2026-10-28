import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarketPage, toPrice, clientRedirect, offerHintsFromUrl, summarizePage } from '../src/parse.js';
import { productHtml, captchaHtml, WARE } from './fixtures.js';

const CARD = 'https://market.yandex.ru/card/karta-steam/123';

test('цена выбранного продавца: предложение из ссылки (do-waremd5)', () => {
  const other = { ZzZzZzZzZzZzZzZzZzZzZz: { oskuId: '123', price: 999, shopName: 'Другой магазин' } };
  const r = parseMarketPage(productHtml({ extraOffers: other }), `${CARD}?do-waremd5=${WARE}&sku=123`);
  assert.equal(r.ok, true);
  assert.equal(r.price, 1087);
  assert.equal(r.oldPrice, 1300);
  assert.equal(r.matchedBy, 'offer');
  assert.equal(r.seller, 'Цифра Плюс');
  assert.equal(r.title, 'Карта оплаты Steam 1000 руб');
  assert.equal(r.inStock, true);
});

test('без подсказки в ссылке — предложение этого товара, затем JSON-LD', () => {
  assert.equal(parseMarketPage(productHtml(), CARD).matchedBy, 'product');
  const noPatch = productHtml().replace(/<noframes[\s\S]*<\/noframes>/, '');
  const r = parseMarketPage(noPatch, CARD);
  assert.equal(r.price, 1099);
  assert.equal(r.matchedBy, 'ld');
  assert.equal(r.oldPrice, null);
});

test('экранированный patch-блок и цена строкой', () => {
  const r = parseMarketPage(productHtml({ escapePatch: true, price: '1 087,50 ₽' }), CARD);
  assert.equal(r.price, 1087.5);
  assert.equal(toPrice({ value: '2 499' }), 2499);
  assert.equal(toPrice('—'), null);
});

test('нет в наличии — удачная проверка без цены', () => {
  const html = productHtml({ availability: 'https://schema.org/OutOfStock' }).replace(/<noframes[\s\S]*<\/noframes>/, '').replace(/"price":"1099",/, '');
  const r = parseMarketPage(html, CARD);
  assert.equal(r.ok, true);
  assert.equal(r.price, null);
  assert.equal(r.inStock, false);
});

test('капча и страница без цены', () => {
  const c = parseMarketPage(captchaHtml, 'https://market.yandex.ru/showcaptcha?retpath=x');
  assert.equal(c.ok, false);
  assert.equal(c.captcha, true);
  // Слово «captcha» в скриптах обычной страницы не делает её капчей
  const r = parseMarketPage(productHtml() + '<script>SmartCaptcha.init()</script>', CARD);
  assert.equal(r.ok, true);
  assert.equal(r.captcha, false);
});

test('несколько чужих предложений без совпадений — помечено как ненадёжное', () => {
  const html = '<html><noframes data-apiary="patch">' + JSON.stringify({ collections: { offerAnalytics: { a: { oskuId: '1', price: 10 }, b: { oskuId: '2', price: 20 } } } }) + '</noframes></html>';
  const r = parseMarketPage(html, 'https://market.yandex.ru/card/x/999');
  assert.equal(r.price, 10);
  assert.equal(r.matchedBy, 'first');
});

test('переход скриптом и подсказки из адреса', () => {
  assert.equal(clientRedirect('<script>window.location.replace("https://market.yandex.ru/card/x/1?do-waremd5=abc")</script>', 'https://market.yandex.ru/cc/Q'), 'https://market.yandex.ru/card/x/1?do-waremd5=abc');
  assert.equal(clientRedirect('<meta http-equiv="refresh" content="0;url=/card/x/2">', 'https://market.yandex.ru/cc/Q'), 'https://market.yandex.ru/card/x/2');
  assert.equal(clientRedirect('<script>location.href="https://evil.example/"</script>', 'https://market.yandex.ru/cc/Q'), null);
  assert.deepEqual(offerHintsFromUrl(`${CARD}?do-waremd5=${WARE}&sku=55&lr=213`), { offerHints: [WARE], sku: '55' });
});

test('сводка для /debug', () => {
  const s = summarizePage(productHtml(), CARD);
  assert.equal(s.result.price, 1087);
  assert.equal(s.offerAnalytics[0].key, WARE);
  assert.equal(s.ldProducts[0].offers[0].seller, 'Цифра Плюс');
  assert.ok(s.priceTexts.includes('1087 ₽'));
});
