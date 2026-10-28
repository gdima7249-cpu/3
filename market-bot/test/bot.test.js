import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openDb, createStore } from '../src/db.js';
import { loadConfig } from '../src/config.js';
import { createBot, extractLinks } from '../src/bot.js';
import { parseMarketPage } from '../src/parse.js';
import { productHtml } from './fixtures.js';

const OWNER = 111;
const URL1 = 'https://market.yandex.ru/cc/BPiBbv';
const msk = (iso) => Date.parse(iso + '+03:00');

function fakeTg() {
  const sent = [];
  let id = 1;
  return {
    sent,
    async send(chatId, text, extra = {}) {
      sent.push({ type: 'text', chatId, text, extra });
      return { message_id: id++ };
    },
    async edit(chatId, messageId, text, extra = {}) {
      sent.push({ type: 'edit', chatId, messageId, text, extra });
    },
    async sendFile(chatId, kind, buffer, filename, opts = {}) {
      sent.push({ type: kind, chatId, filename, caption: opts.caption, size: buffer.length });
      return { message_id: id++ };
    },
    async call() {
      return true;
    },
    texts: () => sent.map((s) => s.text || s.caption || '').join('\n---\n'),
  };
}

/** Маркет-заглушка: отдаёт цены из очереди; 'captcha' — капча. */
function fakeMarket(queue) {
  const calls = [];
  return {
    calls,
    browserAvailable: false,
    async check(url) {
      calls.push(url);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next === 'captcha') return { ok: false, via: 'http', error: 'captcha', errorText: 'Маркет показал капчу', finalUrl: 'https://market.yandex.ru/showcaptcha', html: '<html>captcha</html>', page: parseMarketPage('', '') };
      const finalUrl = 'https://market.yandex.ru/card/karta-steam/123?do-waremd5=AbCdEfGhIjKlMnOpQrStUv';
      const { price, promoText = '' } = typeof next === 'object' ? next : { price: next };
      const html = productHtml({ price, oldPrice: 1300, promoText });
      return { ok: true, via: 'http', status: 200, finalUrl, html, page: parseMarketPage(html, finalUrl) };
    },
  };
}

function setup(queue, env = {}) {
  const clock = { t: msk('2026-10-26T09:00') };
  const config = loadConfig({ dataDir: mkdtempSync(join(tmpdir(), 'market-bot-')), allowedChatIds: [], checkTimes: ['12:00'], maxChecksPerDay: 2, retryAfterMin: 120, notifyMode: 'always', timezone: 'Europe/Moscow', ...env });
  const store = createStore(openDb(':memory:'));
  const tg = fakeTg();
  const market = fakeMarket(queue);
  const bot = createBot({ tg, store, market, config, now: () => clock.t, pause: async () => {}, log: {} });
  const say = (text, chatId = OWNER) => bot.handle({ message: { chat: { id: chatId, type: 'private' }, from: { id: chatId }, text } });
  const press = (data, chatId = OWNER) => bot.handle({ callback_query: { id: 'q', data, message: { chat: { id: chatId }, message_id: 1 } } });
  return { clock, config, store, tg, market, bot, say, press };
}

test('ссылки из текста', () => {
  assert.deepEqual(extractLinks(`вот: ${URL1}. и https://google.com/x`), [URL1]);
  assert.deepEqual(extractLinks('https://ya.cc/m/4TvN7Jr'), ['https://ya.cc/m/4TvN7Jr']);
});

test('первый /start — владелец; чужим бот не отвечает по делу', async () => {
  const { say, tg, bot } = setup([1087]);
  await say('/start');
  assert.deepEqual(bot.owners(), [OWNER]);
  await say('/list', 222);
  assert.match(tg.sent.at(-1).text, /личный бот/);
});

test('добавление ссылки → сразу цена; плановая проверка в 12:00 не дублирует утреннюю', async () => {
  const { say, tg, bot, market, clock } = setup([1087, 1050]);
  await say('/start');
  await say(URL1);
  assert.equal(market.calls.length, 1);
  const added = tg.sent.find((s) => s.type === 'edit');
  assert.match(added.text, /1 087 ₽/);
  assert.match(added.text, /Первая проверка/);
  assert.match(added.text, /Цифра Плюс/);

  clock.t = msk('2026-10-26T12:00');
  assert.equal(await bot.tick(), 0);
  // Следующий день: в 11:59 рано, в 12:00 — проверка и уведомление с изменением цены
  clock.t = msk('2026-10-27T11:59');
  assert.equal(await bot.tick(), 0);
  clock.t = msk('2026-10-27T12:00');
  assert.equal(await bot.tick(), 1);
  const msg = tg.sent.at(-1).text;
  assert.match(msg, /1 050 ₽/);
  assert.match(msg, /📉 −37 ₽/);
  assert.match(msg, /Самая низкая цена/);
  assert.match(msg, /▁|█/);
});

test('лимит в сутки: ручные проверки тоже считаются', async () => {
  const { say, tg, market } = setup([1087]);
  await say('/start');
  await say(URL1);
  await say('/check');
  await say('/check');
  assert.equal(market.calls.length, 2);
  assert.match(tg.sent.at(-1).text, /лимит в сутки/);
});

test('капча: молчим до последней попытки, удачный повтор присылает цену', async () => {
  const { say, tg, bot, market, clock, store } = setup([1087, 'captcha', 1090, 'captcha']);
  await say('/start');
  await say(URL1);
  const before = tg.sent.length;
  clock.t = msk('2026-10-27T12:00');
  await bot.tick(); // капча — пользователю пока не пишем
  assert.equal(tg.sent.length, before);
  clock.t = msk('2026-10-27T13:00');
  assert.equal(await bot.tick(), 0); // повтор не раньше чем через 2 часа
  clock.t = msk('2026-10-27T14:00');
  await bot.tick();
  assert.match(tg.sent.at(-1).text, /1 090/);
  // Следующий день: две капчи подряд → одно сообщение об ошибке
  clock.t = msk('2026-10-28T12:00');
  await bot.tick();
  clock.t = msk('2026-10-28T14:00');
  await bot.tick();
  assert.match(tg.sent.at(-1).text, /капчу/);
  assert.match(tg.sent.at(-1).text, /Попыток на сегодня больше нет/);
  assert.equal(market.calls.length, 5);
  assert.equal(store.dayStats(1, '2026-10-28').attempts, 2);
});

test('режим «только изменения» и цель', async () => {
  const { say, press, tg, bot, clock, store } = setup([1100, 1100, 1080]);
  await say('/start');
  await say(URL1);
  await press('mode:change');
  await press('tgt:1');
  await say('1 090');
  assert.equal(store.item(1).target_price, 1090);

  const before = tg.sent.length;
  clock.t = msk('2026-10-27T12:00');
  await bot.tick(); // 1100 → 1100: молчим
  assert.equal(tg.sent.length, before);
  clock.t = msk('2026-10-28T12:00');
  await bot.tick(); // 1080 ≤ 1090
  assert.match(tg.sent.at(-1).text, /не выше вашей цели/);
});

test('динамика: график, таблица, удаление', async () => {
  const { say, press, tg, bot, clock, store } = setup([1087, 1050, 1070]);
  await say('/start');
  await say(URL1);
  await say('/history');
  assert.match(tg.sent.at(-1).text, /График появится после второй проверки/);
  for (const day of ['27', '28']) {
    clock.t = msk(`2026-10-${day}T12:00`);
    await bot.tick();
  }
  await say('/history');
  const photo = tg.sent.at(-1);
  assert.equal(photo.type, 'photo');
  assert.match(photo.caption, /Минимум: 1 050/);
  assert.match(photo.caption, /после 2 недель/);
  await press('csv:1');
  assert.equal(tg.sent.at(-1).type, 'document');
  await say('/debug');
  assert.match(tg.texts(), /источник: offer/);
  await press('del:1');
  await press('delok:1');
  assert.equal(store.items().length, 0);
});

test('промокод: цена с ним, появление и пропажа, цель по цене к оплате', async () => {
  const promo = (price) => ({ price, promoText: '−5% по промокоду' });
  const { say, press, tg, bot, clock, store } = setup([1000, promo(1000), promo(1000), 1000]);
  await say('/start');
  await say(URL1);
  assert.match(tg.sent.find((s) => s.type === 'edit').text, /Промокода −5% на странице нет/);
  await press('mode:change');
  await press('tgt:1');
  await say('960');

  clock.t = msk('2026-10-27T12:00');
  await bot.tick();
  let msg = tg.sent.at(-1).text;
  assert.match(msg, /Есть промокод −5%/);
  assert.match(msg, /С промокодом: <b>≈\u00a0950\u00a0₽/);
  assert.match(msg, /Появился промокод/);
  assert.match(msg, /С промокодом цена не выше вашей цели/);
  assert.match(msg, /Самая низкая цена/);
  assert.equal(store.lastOk(1).promo_price, 950);

  const before = tg.sent.length;
  clock.t = msk('2026-10-28T12:00');
  await bot.tick(); // всё как вчера — в режиме «только изменения» молчим
  assert.equal(tg.sent.length, before);
  clock.t = msk('2026-10-29T12:00');
  await bot.tick();
  assert.match(tg.sent.at(-1).text, /Промокод пропал/);

  await say('/history');
  const photo = tg.sent.at(-1);
  assert.equal(photo.type, 'photo');
  assert.match(photo.caption, /Промокод −5% был на странице в 2 из 4 проверок/);
  assert.match(photo.caption, /Минимум: 950/);
});

test('/promo: потолок скидки и «не следить»', async () => {
  const { say, tg, bot, clock, store } = setup([{ price: 1087, promoText: 'Промокод: −5%' }]);
  await say('/start');
  await say('/promo');
  assert.match(tg.sent.at(-1).text, /слежу за промокодом −5%/);
  await say('5% до 30 ₽');
  assert.deepEqual(JSON.parse(store.getSetting('promo')), { watch: true, percent: 5, maxDiscount: 30 });
  await say(URL1);
  assert.match(tg.sent.at(-1).text, /−5% \(до 30\u00a0₽\)/);
  assert.match(tg.sent.at(-1).text, /≈\u00a01\u00a0057\u00a0₽/);

  await say('/promo');
  await say('нет');
  clock.t = msk('2026-10-27T12:00');
  await bot.tick();
  assert.doesNotMatch(tg.sent.at(-1).text, /промокод/i);
  assert.equal(store.lastOk(1).promo, null);
  await say('/promo');
  await say('абв');
  assert.match(tg.sent.at(-1).text, /Не понял/);
});
