// Загрузка страницы с локального сервера, который ведёт себя как Маркет:
// короткая ссылка → 302 → карточка, cookie, капча с кнопкой «Я не робот», переход скриптом.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MarketClient, CookieJar, loadPlaywright } from '../src/market.js';
import { productHtml, captchaHtml, WARE } from './fixtures.js';

let server;
let base;
const seen = [];

before(async () => {
  server = createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    seen.push({ path: u.pathname, cookie: req.headers.cookie || '', ua: req.headers['user-agent'] });
    const html = (body, status = 200, headers = {}) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headers });
      res.end(body);
    };
    switch (u.pathname) {
      case '/cc/short':
        return html('', 302, { location: `/card/karta-steam/123?do-waremd5=${WARE}`, 'set-cookie': ['yandexuid=42; Path=/; Max-Age=3600'] });
      case '/card/karta-steam/123':
        return html(productHtml());
      case '/cc/js':
        return html(`<html><script>window.location.replace("${base}/card/karta-steam/123")</script></html>`);
      case '/cc/blocked':
        return html('', 302, { location: '/showcaptcha?retpath=abc' });
      case '/showcaptcha':
        return html(captchaHtml);
      case '/pass':
        return html('', 302, { location: '/card/karta-steam/123', 'set-cookie': 'spravka=ok; Path=/' });
      case '/gone':
        return html('<html>Нет такой страницы</html>', 404);
      default:
        return html('<html></html>', 404);
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server.close());

const dir = () => mkdtempSync(join(tmpdir(), 'market-bot-'));
const client = (opts = {}) => new MarketClient({ userAgent: 'TestUA Chrome/150.0.0.0', browserMode: 'off', cookieFile: join(dir(), 'c.json'), log: {}, ...opts });

test('короткая ссылка → карточка товара, cookie сохраняются', async () => {
  const m = client();
  const r = await m.check(`${base}/cc/short`);
  assert.equal(r.ok, true);
  assert.equal(r.via, 'http');
  assert.equal(r.page.price, 1087);
  assert.equal(r.page.matchedBy, 'offer');
  assert.equal(r.finalUrl, `${base}/card/karta-steam/123?do-waremd5=${WARE}`);
  assert.equal(seen.at(-1).cookie, 'yandexuid=42');
  assert.equal(seen.at(-1).ua, 'TestUA Chrome/150.0.0.0');
});

test('переход скриптом', async () => {
  const r = await client().check(`${base}/cc/js`);
  assert.equal(r.ok, true);
  assert.equal(r.page.price, 1087);
});

test('капча и 404 без браузера', async () => {
  const c = await client().check(`${base}/cc/blocked`);
  assert.equal(c.ok, false);
  assert.equal(c.error, 'captcha');
  const g = await client().check(`${base}/gone`);
  assert.equal(g.error, 'not_found');
  const n = await client().check('http://127.0.0.1:1/');
  assert.equal(n.error, 'network');
});

test('cookie: домен, срок, перезапись', () => {
  const jar = new CookieJar(null);
  jar.store('https://market.yandex.ru/x', ['a=1; Domain=.yandex.ru; Path=/', 'b=2; Path=/', 'c=3; Max-Age=0', 'd=4; Domain=evil.com']);
  assert.equal(jar.header('https://market.yandex.ru/'), 'a=1; b=2; d=4');
  assert.equal(jar.header('https://yandex.ru/'), 'a=1');
  jar.store('https://market.yandex.ru/', ['a=5; Domain=yandex.ru']);
  assert.equal(jar.header('https://passport.yandex.ru/'), 'a=5');
});

const pw = loadPlaywright();
test('браузер: страница товара и нажатие «Я не робот»', { skip: !pw && 'Playwright не установлен' }, async () => {
  const d = dir();
  const m = client({ browserMode: 'auto', browserStateFile: join(d, 'state.json') });
  // Обычный запрос упирается в капчу → бот открывает браузер, жмёт кнопку и попадает на карточку
  const r = await m.check(`${base}/cc/blocked`);
  assert.equal(r.via, 'browser');
  assert.equal(r.ok, true, r.errorText);
  assert.equal(r.page.price, 1087);
  assert.ok(r.screenshot?.length > 1000);
  assert.ok(seen.some((s) => s.path === '/pass'));
  // Cookie браузера сохраняются между запусками
  await client({ browserMode: 'always', browserStateFile: join(d, 'state.json') }).check(`${base}/card/karta-steam/123`);
  assert.match(seen.at(-1).cookie, /spravka=ok/);
  assert.doesNotMatch(seen.at(-1).ua, /Headless/);
});
