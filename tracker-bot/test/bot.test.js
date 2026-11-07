import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createBot } from '../src/bot.js';
import { SteamClient, parseSteamInput, formatPrice, queryVariants } from '../src/steam.js';
import { MarketsClient, parsePrice, parseExport } from '../src/markets.js';
import { createCatalog } from '../src/catalog.js';
import { YooMoney } from '../src/yoomoney.js';
import { Rates } from '../src/rates.js';
import { loadConfig } from '../src/config.js';

const RED = 'AK-47 | Redline (Field-Tested)';
const RED_ST = 'StatTrak™ AK-47 | Redline (Field-Tested)';
const AWP = 'AWP | Asiimov (Field-Tested)';
const KARA = '★ Karambit | Doppler (Factory New)';
const GTA = 271590;

// ---------- поддельный интернет ----------
function fakeNet(state) {
  const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, headers: new Headers() });
  const gamePrice = (g, cc) => {
    if (g.unavailable?.includes(cc)) return null;
    if (g.final == null) return undefined; // бесплатная
    const k = cc === 'kz' ? 5 : 1;
    return { currency: cc === 'kz' ? 'KZT' : 'RUB', initial: g.initial * k, final: g.final * k, discount_percent: g.discount };
  };
  return async (url, init = {}) => {
    const u = new URL(url);
    state.calls.push(u.host + u.pathname + (u.searchParams.get('term') ? `?${u.searchParams.get('term')}` : ''));
    if (u.host === 'www.cbr-xml-daily.ru') return json({ Valute: { USD: { Nominal: 1, Value: 80 }, KZT: { Nominal: 100, Value: 20 } } });
    if (u.host === 'market.csgo.com') return json({ success: true, items: Object.entries(state.market).map(([n, p]) => ({ market_hash_name: n, price: String(p), volume: '10' })) });
    if (u.host === 'lis-skins.com') return json(Object.entries(state.lis).map(([n, p]) => ({ name: n, price: p, count: 2 })));
    if (u.host === 'api.skinport.com' && u.pathname === '/v1/items') {
      assert.equal(init.headers?.['accept-encoding'], 'br');
      const app = u.searchParams.get('app_id');
      const items = app === '730' ? state.skinport : state.skinportApps?.[app] || {};
      return json(Object.entries(items).map(([n, p]) => ({ market_hash_name: n, min_price: p, quantity: 3 })));
    }
    if (u.host === 'api.skinport.com' && u.pathname === '/v1/sales/history') {
      const app = u.searchParams.get('app_id');
      const hist = app === '730' ? state.spHistory : state.spHistoryApps?.[app] || {};
      return json(Object.entries(hist).map(([n, h]) => ({ market_hash_name: n, last_7_days: { median: h.med7, avg: h.med7, volume: h.vol7 ?? 40 }, last_30_days: { median: h.med30, avg: h.med30, volume: 150 }, last_90_days: { median: h.med30 } })));
    }
    if (u.host === 'steamcommunity.com' && u.pathname === '/market/priceoverview/') {
      state.steamApps = [...(state.steamApps || []), u.searchParams.get('appid')];
      const p = state.steamMarket[u.searchParams.get('market_hash_name')];
      return json(p ? { success: true, lowest_price: `${p.toLocaleString('ru-RU')},00 pуб.`, median_price: `${p},00 pуб.`, volume: '1,234' } : { success: false });
    }
    if (u.host === 'steamcommunity.com' && u.pathname.startsWith('/inventory/')) {
      if (state.inventoryPrivate) return json(null, 403);
      return json({
        success: 1,
        assets: [1, 1, 2, 3, 4].map((c) => ({ classid: String(c), instanceid: '0', amount: '1' })),
        descriptions: [
          { classid: '1', instanceid: '0', market_hash_name: RED, marketable: 1 },
          { classid: '2', instanceid: '0', market_hash_name: AWP, marketable: 1 },
          { classid: '3', instanceid: '0', market_hash_name: 'Graffiti | Hi', marketable: 0 },
          { classid: '4', instanceid: '0', market_hash_name: KARA, marketable: 0 },
        ],
      });
    }
    if (u.host === 'store.steampowered.com' && u.pathname === '/api/storesearch/') {
      const term = u.searchParams.get('term').toLowerCase();
      const hits = Object.entries(state.games).filter(([, g]) => g.name.toLowerCase().includes(term));
      return json({ items: hits.map(([id, g]) => ({ type: 'app', id: Number(id), name: g.name, price: g.final != null ? { currency: 'RUB', initial: g.initial, final: g.final } : undefined })) });
    }
    if (u.host === 'store.steampowered.com' && u.pathname === '/api/appdetails') {
      const cc = u.searchParams.get('cc');
      const out = {};
      for (const id of u.searchParams.get('appids').split(',').map(Number)) {
        const g = state.games[id];
        const po = g && gamePrice(g, cc);
        if (!g || po === null) { out[id] = { success: false }; continue; }
        out[id] = u.searchParams.get('filters') === 'price_overview' ? { success: true, data: po ? { price_overview: po } : [] } : { success: true, data: { name: g.name, is_free: g.final == null, metacritic: g.meta ? { score: g.meta } : undefined, ...(po ? { price_overview: po } : {}) } };
      }
      return json(out);
    }
    if (u.host === 'store.steampowered.com' && u.pathname.startsWith('/appreviews/')) {
      return json({ query_summary: { review_score_desc: 'Very Positive', total_positive: 920, total_negative: 80, total_reviews: 1000 } });
    }
    if (u.host === 'api.isthereanydeal.com' && u.pathname === '/games/lookup/v1') return json({ found: true, game: { id: 'itad-1' } });
    if (u.host === 'api.isthereanydeal.com' && u.pathname === '/games/storelow/v2') {
      assert.deepEqual(JSON.parse(init.body), ['itad-1']);
      return json([{ id: 'itad-1', lows: [{ shop: { id: 61, name: 'Steam' }, price: { amount: 7.99, currency: 'USD' }, regular: { amount: 19.99 }, cut: 60 }] }]);
    }
    if (u.host === 'www.cheapshark.com') {
      if (!/SkinWatch/.test(init.headers?.['user-agent'] || '')) return json({ error: 'Missing or generic User-Agent header detected' }, 400);
      if (state.noHistory) return json([]);
      if (u.searchParams.get('steamAppID')) return json([{ gameID: '77' }]);
      return json({ cheapestPriceEver: { price: '12.00' }, deals: [{ storeID: '1', retailPrice: '30.00' }] }); // −60%
    }
    if (u.host === 'api.steampowered.com' && u.pathname === '/IWishlistService/GetWishlist/v1/') {
      return json({ response: { items: state.wishlist.map((appid, i) => ({ appid, priority: i })) } });
    }
    if (u.host === 'yoomoney.ru' && u.pathname === '/api/operation-history') {
      const label = new URLSearchParams(init.body).get('label');
      return json({ operations: state.ops.filter((o) => o.label === label) });
    }
    return json({}, 404);
  };
}

function fakeTg() {
  let mid = 0;
  const tg = {
    sent: [],
    calls: [],
    blocked: new Set(),
    async send(chat, text, extra) {
      if (tg.blocked.has(chat)) return false;
      tg.sent.push({ chat, text, extra });
      return { message_id: ++mid };
    },
    async edit(chat, id, text, extra) {
      tg.sent.push({ chat, text, extra, edit: true });
    },
    async call(method, params) {
      tg.calls.push({ method, params });
      if (method === 'createChatInviteLink') return { invite_link: 'https://t.me/+ultra' };
      if (method === 'createInvoiceLink') return 'https://t.me/$invoice';
      return true;
    },
    async sendFile(chat, kind, buffer, filename, opts = {}) {
      tg.sent.push({ chat, kind, filename, text: opts.caption || '', file: buffer.toString('utf8'), extra: {} });
      return { message_id: ++mid };
    },
  };
  return tg;
}

async function setup(over = {}, cfg = {}) {
  const state = {
    calls: [],
    ops: [],
    wishlist: [620, 1145360, 570],
    market: { [RED]: 1200, [RED_ST]: 3000, [AWP]: 9000, [KARA]: 90000 },
    lis: { [RED]: 14, [RED_ST]: 40 }, // доллары: 14 × 80 = 1120 ₽
    skinport: { [RED]: 1150, [RED_ST]: 3100, [AWP]: 9500 },
    spHistory: { [RED]: { med7: 1300, med30: 1400 } },
    steamMarket: { [RED]: 1450, [AWP]: 11000 },
    games: {
      1145360: { name: 'Hades', initial: 57500, final: 57500, discount: 0, meta: 93 },
      620: { name: 'Portal 2', initial: 38000, final: 3800, discount: 90 },
      570: { name: 'Dota 2', final: null },
      [GTA]: { name: 'Grand Theft Auto V', initial: 150000, final: 150000, discount: 0, unavailable: ['kz'] },
    },
    ...over,
  };
  const fetchImpl = fakeNet(state);
  const tg = fakeTg();
  const db = openDb(':memory:');
  const config = loadConfig({
    adminChatIds: ['900'], proPriceRub: 199, premiumDays: 30, freeAlerts: 3, freeAlertIntervalMin: 30, freeWishlistLimit: 50, freeGamesIntervalMin: 0, proStars: 100, ultraPriceRub: 999, ultraStars: 500, starsSubscription: true,
    yoomoneyWallet: '4100', yoomoneyToken: 'TOKEN', freeForAll: false, steamCc: 'ru', analysisPremium: false, ...cfg,
  });
  const rates = new Rates({ fetchImpl });
  const steam = new SteamClient({ cc: 'ru', minGapMs: 0, fetchImpl });
  const markets = new MarketsClient({ fetchImpl, rates, steamGapMs: 0, sources: 'c,l,s,a', skinportRefreshMin: 0 });
  const catalog = createCatalog(db, { bulkSources: markets.bulk });
  const ym = new YooMoney({ wallet: '4100', token: 'TOKEN', fetchImpl });
  const bot = createBot({ tg, steam, markets, catalog, ym, rates, db, config });
  await bot.priceCycle();
  let upd = 0;
  const mk = (id, name) => ({
    msg: (text, extra = {}) => bot.handle({ update_id: ++upd, message: { chat: { id, type: 'private' }, from: { id, username: name, first_name: name }, text, ...extra } }),
    click: (data) => bot.handle({ update_id: ++upd, callback_query: { id: 'cq' + upd, from: { id, username: name, first_name: name }, data, message: { chat: { id }, message_id: 1 } } }),
  });
  const user = mk(7, 'gamer');
  const admin = mk(900, 'admin');
  await user.msg('/start');
  const skinId = (name) => catalog.getByName(name).id;
  const ageAlerts = (ms) => db.prepare('UPDATE alerts SET checked_at = checked_at - ?').run(ms);
  return { state, tg, db, bot, msg: user.msg, click: user.click, admin: admin.msg, mk, config, catalog, skinId, ageAlerts, markets };
}

const last = (tg, chat = 7) => [...tg.sent].reverse().find((s) => s.chat === chat);
const buttons = (m) => m.extra.reply_markup.inline_keyboard.flat();

test('разбор ввода, цен, выгрузок и вариантов названий', () => {
  assert.deepEqual(parseSteamInput('https://store.steampowered.com/app/1145360/Hades/'), { type: 'app', appid: 1145360 });
  assert.deepEqual(parseSteamInput('steamcommunity.com/id/nick_name'), { type: 'vanity', name: 'nick_name' });
  assert.equal(parsePrice('1 234,56 pуб.'), 1234.56);
  assert.equal(parsePrice('$1,234.56'), 1234.56);
  assert.equal(parsePrice('1.234,5 €'), 1234.5);
  assert.equal(parsePrice('1,234'), 1234);
  assert.equal(parsePrice('99,90'), 99.9);
  assert.match(formatPrice(700000, 'KZT'), /^7\s000 ₸$/);
  assert.deepEqual([...parseExport({ items: [{ market_hash_name: 'A', price: '1.5' }, { market_hash_name: 'A', price: 1 }] })], [['A', { price: 1, volume: 0 }]]);
  assert.deepEqual([...parseExport({ B: { price: 2, count: 3 } })], [['B', { price: 2, volume: 3 }]]);
  assert.equal(queryVariants('гта 5')[0], 'grand theft auto V');
  assert.ok(queryVariants('ведьмак 3').includes('the witcher III'));
});

test('площадки: Lis-Skins в долларах переводится в рубли, Avan без адреса выключен', async () => {
  const { markets, catalog, skinId } = await setup();
  assert.deepEqual(markets.bulk, ['c', 'l', 's']);
  assert.equal(catalog.get(skinId(RED)).prices.l.price, 1120);
});

test('каталог: поиск с русскими сокращениями', async () => {
  const { catalog } = await setup();
  assert.equal(catalog.search('калаш редлайн ft')[0].name, RED);
  assert.equal(catalog.search('st калаш редлайн')[0].name, RED_ST);
  assert.equal(catalog.search('керамбит допплер')[0].name, KARA);
});

test('карточка скина: все площадки, лучшая цена, Steam', async () => {
  const { msg, click, tg } = await setup();
  await msg('калаш редлайн ft');
  assert.equal(buttons(last(tg))[0].text.startsWith('AK-47 | Redline'), true);
  await click(buttons(last(tg))[0].callback_data);
  const t = last(tg).text;
  assert.match(t, /Маркет CS — <b>1\s200 ₽/);
  assert.match(t, /Lis-Skins — <b>1\s120 ₽.*👈 дешевле всего/);
  assert.match(t, /Skinport — <b>1\s150 ₽/);
  assert.match(t, /Steam — <b>1\s450 ₽/);
  assert.match(t, /На Lis-Skins на 23% дешевле, чем в Steam/);
});

test('«Следить» без условий: бот сам выбирает порог', async () => {
  const { click, tg, bot, state, skinId, ageAlerts, db } = await setup();
  await click(`aa:${skinId(RED)}`);
  assert.match(last(tg).text, /Слежу за <b>AK-47 \| Redline.*Лучшая цена/s);
  assert.match(last(tg).text, /Порог 7%/); // 1 120 ₽ → 7%
  const a = db.prepare('SELECT * FROM alerts').get();
  assert.equal(a.market, 'b');
  assert.equal(a.value, 7);
  state.lis[RED] = 13; // 1 040 ₽: −7,1%
  ageAlerts(3600_000);
  assert.equal((await bot.priceCycle()).alertsSent, 1);
  assert.match(last(tg).text, /подешевел на 7,1%/);
});

test('уведомление ±10% по площадке и частота для бесплатных/премиум', async () => {
  const { click, tg, bot, state, skinId, ageAlerts, admin } = await setup();
  const id = skinId(RED);
  await click(`am:${id}:c`);
  await click(`ac:${id}:c:p10`);
  state.market[RED] = 1070;
  ageAlerts(3600_000);
  assert.equal((await bot.priceCycle()).alertsSent, 1);
  assert.match(last(tg).text, /подешевел на 10,8%/);
  state.market[RED] = 900;
  assert.equal((await bot.priceCycle()).alertsSent, 0, 'бесплатный — не чаще раза в 30 мин');
  await admin('/give 7 30');
  assert.equal((await bot.priceCycle()).alertsSent, 0, 'ПРО — не чаще раза в 5 мин');
  ageAlerts(5 * 60_000);
  assert.equal((await bot.priceCycle()).alertsSent, 1);
  state.market[RED] = 700;
  await admin('/give 7 30 ultra');
  assert.equal((await bot.priceCycle()).alertsSent, 1, 'УЛЬТРА — каждый цикл цен');
});

test('уведомление «ниже цены» со своей ценой', async () => {
  const { click, msg, tg, bot, state, skinId, ageAlerts } = await setup();
  const id = skinId(AWP);
  await click(`ac:${id}:s:lt`);
  await msg('9 000');
  assert.match(last(tg).text, /опустится ниже 9\s000 ₽/);
  const cycle = async () => (ageAlerts(3600_000), (await bot.priceCycle()).alertsSent);
  state.skinport[AWP] = 8800;
  assert.equal(await cycle(), 1);
  assert.equal(await cycle(), 0);
  state.skinport[AWP] = 9300;
  await cycle();
  state.skinport[AWP] = 8500;
  assert.equal(await cycle(), 1);
});

test('оценка рынка: по истории Skinport, по своей истории, мало данных', async () => {
  const { click, tg, db, skinId } = await setup();
  await click(`an:${skinId(RED)}`);
  let t = last(tg).text;
  assert.match(t, /🟢 <b>Выгодно покупать: цена на 17,9% ниже обычной/); // 1150 к медиане 1400
  assert.match(t, /📉 Цена падает/);
  assert.match(t, /Купить дешевле всего: <b>Lis-Skins<\/b>/);
  assert.match(t, /не финансовый совет/);

  // своя история за 10 дней по 900 ₽ → сейчас 1120 ₽ дорого
  const id = skinId(RED);
  for (let i = 1; i <= 10; i++) db.prepare('INSERT INTO skin_history (skin_id, day, price) VALUES (?, ?, ?)').run(id, new Date(Date.now() - i * 86400_000).toISOString().slice(0, 10), 900);
  await click(`an:${id}`);
  t = last(tg).text;
  assert.match(t, /🔴 <b>Дорого/);
  assert.match(t, /удачный момент/);

  await click(`an:${skinId(KARA)}`);
  assert.match(last(tg).text, /мало данных/);
});

test('лимит бесплатных уведомлений', async () => {
  const { click, tg, skinId } = await setup();
  for (const n of [RED, RED_ST, AWP]) await click(`ac:${skinId(n)}:c:p5`);
  await click(`ak:${skinId(KARA)}`);
  assert.match(last(tg).text, /лимит тарифа Бесплатный/);
});

test('инвентарь и лоты', async () => {
  const { msg, click, tg, state, skinId } = await setup();
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  let t = last(tg).text;
  assert.match(t, /4 предметов \(всего 5\)/);
  assert.match(t, /По лучшим ценам: <b>101\s240 ₽/); // 2×1120 + 9000 + 90000
  await click(`ls:${skinId(AWP)}:+`);
  await click('inv');
  assert.match(last(tg).text, /Выставлено на продажу[\s\S]*AWP \| Asiimov \(Field-Tested\) — 11\s000 ₽/);
  await click('invr');
  assert.match(last(tg).text, /раз в 6 ч/);
  state.inventoryPrivate = true;
  await click('invu');
  await msg('https://steamcommunity.com/profiles/76561198000000002');
  assert.match(last(tg).text, /Инвентарь скрыт/);
});

test('игры: рейтинг, «стоит ли брать», уведомление с советом', async () => {
  const { msg, tg, bot, state } = await setup();
  await msg('https://store.steampowered.com/app/1145360/');
  let t = last(tg).text;
  assert.match(t, /👍 92% положительных \(Очень положительные, 1 тыс\. отзывов\)/);
  assert.match(t, /Metacritic: 93/);
  assert.match(t, /🔴 Сейчас без скидки\. Бывало до −60%/);

  state.games[1145360] = { ...state.games[1145360], final: 43125, discount: 25 };
  assert.equal((await bot.wishlistCheck()).sent, 1);
  t = last(tg).text;
  assert.match(t, /Hades.*−25%/);
  assert.match(t, /🟡 Лучше подождать: раньше скидка доходила до −60%, сейчас только −25%/);

  state.games[1145360] = { ...state.games[1145360], final: 23000, discount: 60 };
  await bot.wishlistCheck();
  assert.match(last(tg).text, /🟢 Хорошая цена/);
});

test('регион магазина: Казахстан, цена в тенге с рублями, недоступная игра', async () => {
  const { click, msg, tg, db } = await setup();
  await click('rg');
  await click('rgs:kz');
  assert.equal(db.prepare('SELECT cc FROM users WHERE id = 7').get().cc, 'kz');
  await msg('https://store.steampowered.com/app/1145360/');
  assert.match(last(tg).text, /Цена \(KZ\): 2\s875 ₸ \(≈575 ₽\)/);
  await msg(`https://store.steampowered.com/app/${GTA}/`);
  assert.match(last(tg).text, /недоступна в регионе KZ/);
  assert.match(last(tg).text, /Grand Theft Auto V/);
});

test('«Возможно, вы имели в виду»: гта 5 → Grand Theft Auto V', async () => {
  const { msg, click, tg, db } = await setup();
  await msg('гта 5');
  const m = last(tg);
  assert.match(m.text, /Возможно, вы имели в виду <b>Grand Theft Auto V<\/b>/);
  assert.deepEqual(buttons(m).map((b) => b.callback_data), [`gadd:${GTA}`, 'gno']);
  await click('gno');
  assert.match(last(tg).text, /Других вариантов нет|Может быть/);
  await click(`gadd:${GTA}`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM wishlist WHERE appid = ?').get(GTA).n, 1);
});

test('поддержка: с любого аккаунта, ответ админа через «Ответить» и /reply', async () => {
  const { mk, tg, admin } = await setup();
  const other = mk(8, 'second');
  await other.msg('/start');
  await other.click('sup');
  await other.msg('Не работает инвентарь');
  assert.match(last(tg, 8).text, /передано администратору/);
  const toAdmin = last(tg, '900');
  assert.match(toAdmin.text, /Обращение.*@second.*Не работает инвентарь/s);
  const adminMsgId = tg.sent.indexOf(toAdmin) + 1; // fakeTg нумерует сообщения по порядку
  await admin('Откройте инвентарь в Steam', { reply_to_message: { message_id: adminMsgId } });
  assert.match(last(tg, 8).text, /Ответ поддержки:.*Откройте инвентарь/s);
  await admin('/reply 8 Ещё вопрос?');
  assert.match(last(tg, 8).text, /Ещё вопрос\?/);
  await other.msg('/support Сразу текстом');
  assert.match(last(tg, '900').text, /Сразу текстом/);
});

test('ЮMoney: ссылка с меткой, автопроверка, недоплата', async () => {
  const { click, tg, bot, state, db } = await setup();
  await click('ym');
  const url = new URL(buttons(last(tg))[0].url);
  assert.equal(url.searchParams.get('sum'), '199');
  const label = url.searchParams.get('label');
  state.ops.push({ operation_id: 'op1', label, status: 'success', direction: 'in', amount: 193.03 });
  assert.equal(await bot.pollPayments(), 1);
  assert.ok(db.prepare('SELECT premium_until FROM users WHERE id = 7').get().premium_until > Date.now() + 29 * 86400_000);
  assert.ok(tg.sent.some((s) => s.chat === '900' && /Мой налог/.test(s.text)));
  await click('ym');
  const label2 = new URL(buttons(last(tg))[0].url).searchParams.get('label');
  state.ops.push({ operation_id: 'op2', label: label2, status: 'success', direction: 'in', amount: 1 });
  await bot.pollPayments();
  assert.ok(tg.sent.some((s) => s.chat === '900' && /вместо 199 ₽/.test(s.text)));
});

test('Stars: подписка 100 ⭐/мес, продление, дубль, возврат с отменой подписки', async () => {
  const { click, tg, bot, db, admin } = await setup();
  await click('buy');
  const link = tg.calls.find((c) => c.method === 'createInvoiceLink');
  assert.equal(link.params.currency, 'XTR');
  assert.equal(link.params.prices[0].amount, 100);
  assert.equal(link.params.subscription_period, 2592000);
  assert.match(last(tg).text, /100 ⭐ в месяц/);

  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const pay = (id, extra) => ({ message: { chat: { id: 7, type: 'private' }, from: { id: 7, username: 'gamer' }, successful_payment: { currency: 'XTR', total_amount: 100, invoice_payload: 'premium', telegram_payment_charge_id: id, subscription_expiration_date: exp, is_recurring: true, ...extra } } });
  await bot.handle(pay('ch_1', { is_first_recurring: true }));
  await bot.handle(pay('ch_1', { is_first_recurring: true })); // дубль апдейта
  assert.equal(db.prepare('SELECT COUNT(*) n FROM payments').get().n, 1);
  assert.match(last(tg).text, /ПРО<\/b> активен до/);
  const until1 = db.prepare('SELECT premium_until FROM users WHERE id = 7').get().premium_until;
  assert.ok(Math.abs(until1 - (exp * 1000 + 3600_000)) < 5000);

  // автопродление через месяц
  const exp2 = exp + 30 * 86400;
  await bot.handle({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, successful_payment: { currency: 'XTR', total_amount: 100, invoice_payload: 'premium', telegram_payment_charge_id: 'ch_2', subscription_expiration_date: exp2, is_recurring: true } } });
  assert.match(last(tg).text, /Подписка продлена/);

  await admin('/refund 7');
  assert.ok(tg.calls.some((c) => c.method === 'refundStarPayment' && c.params.telegram_payment_charge_id === 'ch_2'));
  assert.ok(tg.calls.some((c) => c.method === 'editUserStarSubscription' && c.params.is_canceled === true));
});

test('Stars: разовая оплата, если подписка выключена', async () => {
  const { click, tg } = await setup({}, { starsSubscription: false });
  await click('buy');
  const inv = tg.calls.find((c) => c.method === 'sendInvoice');
  assert.equal(inv.params.prices[0].amount, 100);
  assert.equal(inv.params.subscription_period, undefined);
});

test('платные функции: оценка рынка и «Что купить» — только с премиумом', async () => {
  const { click, tg, skinId, admin } = await setup({
    spHistory: { [RED]: { med7: 1300, med30: 1400 }, [AWP]: { med7: 9900, med30: 10000 } },
  }, { analysisPremium: true });
  await click(`an:${skinId(RED)}`);
  assert.match(last(tg).text, /функция тарифа ⭐ ПРО — 199 ₽ в месяц \(100 ⭐\)/);
  await click('pick');
  assert.match(last(tg).text, /Что купить<\/b> — подборка/);
  assert.equal(buttons(last(tg))[0].callback_data, 'buy:pro');

  await admin('/give 7 30');
  await click('pick');
  let t = last(tg).text;
  assert.match(t, /📈 <b>Что купить<\/b> · Любой бюджет/);
  assert.match(t, /AWP \| Asiimov \(Field-Tested\)<\/b>\n   9\s000 ₽ на Маркет CS · ↓5% к медиане месяца/);
  assert.doesNotMatch(t, /AK-47 \| Redline/, 'падающий предмет не советуем');
  assert.match(t, /не финансовый совет/);
  await click('pk:b1');
  assert.match(last(tg).text, /до 1 000 ₽[\s\S]*подходящих предметов нет/);
  await click(`an:${skinId(RED)}`);
  assert.match(last(tg).text, /Оценка рынка/);
});

test('режим FREE_FOR_ALL: всё открыто, о премиуме и оплате ни слова', async () => {
  const { msg, click, tg, bot, state, skinId, db } = await setup({}, { freeForAll: true });
  for (const n of [RED, RED_ST, AWP, KARA]) await click(`ac:${skinId(n)}:c:p5`);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM alerts').get().n, 4);
  state.market[RED] = 1000;
  assert.equal((await bot.priceCycle()).alertsSent, 1);
  await msg('/premium');
  await msg('/settings');
  await msg('/terms');
  await click('premium');
  await click('buy');
  await click(`an:${skinId(RED)}`);
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  await click('invr');
  assert.ok(!tg.calls.some((c) => c.method === 'sendInvoice'));
  for (const s of tg.sent.filter((x) => x.chat === 7)) {
    assert.doesNotMatch(s.text, /премиум|оплат|бесплатн|реклам|Stars|ЮMoney/i, s.text);
    for (const b of s.extra?.reply_markup?.inline_keyboard?.flat() || []) assert.doesNotMatch(b.text, /Премиум|Оплат/);
  }
});

test('рассылка помечает заблокировавших бота', async () => {
  const { tg, admin, db } = await setup();
  tg.blocked.add(7);
  await admin('/broadcast all Привет!');
  assert.match(last(tg, 900).text, /доставлено 1 из 2/);
  assert.equal(db.prepare('SELECT blocked FROM users WHERE id = 7').get().blocked, 1);
});

test('смена региона: цены и названия догружаются сразу, а не «нет цены»', async () => {
  const { click, msg, tg, db, state } = await setup();
  state.games[999] = { name: 'Only In US', initial: 1000, final: 1000, discount: 0, unavailable: ['ru', 'kz'] };
  await msg('https://store.steampowered.com/app/1145360/');
  // игра без названия (как после импорта) и без цены в KZ
  db.prepare('INSERT INTO games (appid) VALUES (999)').run();
  db.prepare('INSERT INTO wishlist (user_id, appid, added_at) VALUES (7, 999, 0)').run();
  await click('rgs:kz');
  await click('wl:0');
  const t = last(tg).text;
  assert.match(t, /Hades<\/a> — 2\s875 ₸ \(≈575 ₽\)/);
  assert.match(t, /Only In US<\/a> — ❌ недоступна в регионе KZ/);
  assert.doesNotMatch(t, /App 999|нет цены/);
});

test('инвентарь: по умолчанию сообщает о заметном изменении цен, можно выключить', async () => {
  const { msg, click, tg, bot, state, db } = await setup();
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  assert.match(last(tg).text, /Сообщу, если цена предметов заметно изменится/);

  state.market[AWP] = 8200; // −8,9% при пороге 7% для дорогих
  state.market[KARA] = 89000; // −1,1% — мало
  let r = await bot.priceCycle();
  assert.equal(r.inventorySent, 1);
  const t = last(tg).text;
  assert.match(t, /Цены в вашем инвентаре изменились/);
  assert.match(t, /📉 AWP \| Asiimov \(Field-Tested\): 8\s200 ₽ \(−8,9%\)/);
  assert.doesNotMatch(t, /Karambit/);
  assert.match(t, /Итого: −800 ₽/);

  // повтор той же цены — тишина (и бесплатный не чаще раза в 30 мин)
  db.prepare('UPDATE users SET inv_alert_at = 0').run();
  r = await bot.priceCycle();
  assert.equal(r.inventorySent, 0);

  await click('invn:0');
  assert.equal(db.prepare('SELECT inv_alerts FROM users WHERE id = 7').get().inv_alerts, 0);
  state.market[AWP] = 6000;
  db.prepare('UPDATE users SET inv_alert_at = 0').run();
  assert.equal((await bot.priceCycle()).inventorySent, 0);
});

test('«стоит ли брать» не сравнивает скидку саму с собой (нет истории — честно говорим)', async () => {
  const { msg, tg, bot, state } = await setup({ noHistory: true });
  state.games[3527290] = { name: 'PEAK', initial: 44000, final: 27280, discount: 38 };
  await msg('https://store.steampowered.com/app/3527290/');
  let t = last(tg).text;
  assert.match(t, /🟡 Скидка −38%\. Истории прошлых распродаж пока нет/);
  assert.doesNotMatch(t, /на уровне лучших/);

  // распродажа закончилась → −38% стало «прошлой» скидкой; новая −20% — лучше подождать
  state.games[3527290] = { name: 'PEAK', initial: 44000, final: 44000, discount: 0 };
  await bot.wishlistCheck();
  state.games[3527290] = { name: 'PEAK', initial: 44000, final: 35200, discount: 20 };
  await bot.wishlistCheck();
  t = last(tg).text;
  assert.match(t, /🟡 Лучше подождать: раньше скидка доходила до −38%, сейчас только −20%/);
});

test('история цен из IsThereAnyDeal (Steam), если задан ключ', async () => {
  const { msg, tg } = await setup({}, { itadKey: 'KEY' });
  await msg('https://store.steampowered.com/app/1145360/');
  const t = last(tg).text;
  assert.match(t, /Бывало до −60%/);
  assert.match(t, /\$7\.99 при полной цене \$19\.99, −60% \(IsThereAnyDeal, Steam\)/);
});

test('ключ ITAD добавили позже — история обновляется сразу, /history показывает шаги', async () => {
  const { msg, tg, db, admin, config } = await setup({ noHistory: true });
  await msg('https://store.steampowered.com/app/1145360/');
  assert.doesNotMatch(last(tg).text, /IsThereAnyDeal|Бывало/);
  config.itadKey = 'KEY';
  db.prepare('UPDATE games SET info_at = info_at - 3600000').run();
  await msg('https://store.steampowered.com/app/1145360/');
  assert.match(last(tg).text, /IsThereAnyDeal, Steam/);
  await admin('/history 1145360');
  const t = last(tg, 900).text;
  assert.match(t, /ITAD lookup: найдена/);
  assert.match(t, /Итог: −60% \(itad\)/);
});

test('Skinport: реже остальных и пауза после 429 — прошлые цены сохраняются', async () => {
  const state = { calls: [] };
  let status = 200;
  const fetchImpl = async (url) => {
    state.calls.push(url);
    return { ok: status < 400, status, json: async () => [{ market_hash_name: 'X', min_price: 10, quantity: 1 }], headers: new Headers() };
  };
  const m = new MarketsClient({ fetchImpl, sources: 's', skinportRefreshMin: 15 });
  assert.equal((await m.fetchBulk('s')).size, 1);
  await assert.rejects(m.fetchBulk('s'), (e) => e.code === 'skip');
  m.skinportNext = 0;
  status = 429;
  await assert.rejects(m.fetchBulk('s'), (e) => e.status === 429);
  m.skinportNext = 0; // даже если интервал прошёл — пауза после 429 держится
  m.skinportNext = m.skinportBlockedUntil;
  await assert.rejects(m.fetchBulk('s'), (e) => e.code === 'skip');
  assert.equal(state.calls.length, 2);
});

// ---------- тарифы ----------
import { skinInsight } from '../src/analysis.js';

test('цена по рынку: средняя без оверпрайса, «покупают за», ликвидность, рекомендуемая цена', () => {
  // Пример из ТЗ: средняя 50, покупают за 40 → выставить за 45. Предложение за 90 — оверпрайс.
  const s = { prices: { c: { price: 52 }, l: { price: 48 }, s: { price: 50 }, a: { price: 90 }, t: { price: 70, median: 66, volume: 35 } }, stats: { med7: 40, vol7: 200 } };
  const i = skinInsight(s, ['c', 'l', 's', 'a']);
  assert.deepEqual([i.avg, i.sold, i.liq.title, i.rec, i.overpriced], [50, 40, 'ВЫСОКАЯ', 45, 1]);
  // Низкая ликвидность — ближе к цене продаж; не дороже самого дешёвого конкурента
  const low = skinInsight({ prices: { c: { price: 100 }, l: { price: 120 } }, stats: { med7: 80, vol7: 7 } }, ['c', 'l']);
  assert.equal(low.liq.code, 'low');
  assert.equal(low.rec, 89); // 80 + (110 − 80) × 0,3
  assert.equal(skinInsight({ prices: { c: { price: 100 }, l: { price: 300 } }, stats: { med7: 60, vol7: 300 } }, ['c', 'l']).rec, 100, 'середина 130, но конкурент продаёт за 100');
  // Продажи известны только в Steam — рекомендация для Steam
  const st = skinInsight({ prices: { t: { price: 120, median: 100, volume: 5 } }, stats: null }, ['c']);
  assert.deepEqual([st.scope, st.rec, st.liq.code], ['steam', 110, 'mid']);
});

test('карточка скина: бесплатно — средняя цена, с ПРО — ликвидность и рекомендация', async () => {
  const { click, tg, skinId, admin } = await setup();
  await click(`sk:${skinId(RED)}`);
  let t = last(tg).text;
  assert.match(t, /Средняя цена на площадках: <b>1\s150 ₽/);
  assert.match(t, /🔒 Ликвидность, «покупают за» и рекомендуемая цена — в тарифе ПРО/);
  assert.doesNotMatch(t, /Покупают в среднем/);
  await admin('/give 7 30');
  await click(`sk:${skinId(RED)}`);
  t = last(tg).text;
  assert.match(t, /Покупают в среднем за: <b>1\s300 ₽<\/b> \(продажи Skinport за 7 дней\)/);
  assert.match(t, /Ликвидность: <b>ВЫСОКАЯ<\/b> \(≈1\s234 продаж в день, Steam\)/);
  assert.match(t, /Рекомендуем выставить за: <b>1\s150 ₽/);
  assert.doesNotMatch(t, /🔒/);
});

test('тарифы: экран сравнения, счета ПРО и УЛЬТРА, проверка суммы', async () => {
  const { msg, click, tg, bot } = await setup();
  await msg('/premium');
  const v = last(tg);
  assert.match(v.text, /🆓 <b>Бесплатный<\/b> · <i>ваш тариф<\/i>/);
  assert.match(v.text, /⭐ <b>ПРО<\/b> — 199 ₽ в месяц \(100 ⭐\)/);
  assert.match(v.text, /💎 <b>УЛЬТРА<\/b> — 999 ₽ в месяц \(500 ⭐\)/);
  assert.match(v.text, /Скины: до 3, проверка каждые 30 мин/);
  assert.deepEqual(buttons(v).map((b) => b.callback_data).slice(0, 4), ['buy:pro', 'ym:pro', 'buy:ultra', 'ym:ultra']);
  await click('buy:ultra');
  const link = tg.calls.filter((c) => c.method === 'createInvoiceLink').at(-1);
  assert.deepEqual([link.params.payload, link.params.prices[0].amount], ['ultra', 500]);
  const pcq = (payload, amount) => bot.handle({ pre_checkout_query: { id: 'p', currency: 'XTR', invoice_payload: payload, total_amount: amount } });
  await pcq('ultra', 500);
  await pcq('ultra', 100);
  await pcq('premium', 100); // старые счета — это ПРО
  const answers = tg.calls.filter((c) => c.method === 'answerPreCheckoutQuery').map((c) => c.params.ok);
  assert.deepEqual(answers, [true, false, true]);
});

test('переход ПРО → УЛЬТРА: остаток пересчитывается, подписка ПРО отменяется', async () => {
  const { tg, bot, db, click } = await setup();
  const exp = Math.floor(Date.now() / 1000) + 30 * 86400;
  const pay = (payload, stars, id) => bot.handle({ message: { chat: { id: 7, type: 'private' }, from: { id: 7 }, successful_payment: { currency: 'XTR', total_amount: stars, invoice_payload: payload, telegram_payment_charge_id: id, subscription_expiration_date: exp, is_recurring: true, is_first_recurring: true } } });
  await pay('pro', 100, 'pro_1');
  await pay('ultra', 500, 'ultra_1');
  const u = db.prepare('SELECT tier, premium_until FROM users WHERE id = 7').get();
  assert.equal(u.tier, 'ultra');
  // 30 дней ПРО по 199 ₽ ≈ 6 дней УЛЬТРА по 999 ₽ сверх оплаченного месяца
  const extra = (u.premium_until - (exp * 1000 + 3600_000)) / 86400_000;
  assert.ok(extra > 5.5 && extra < 6.5, `добавлено ${extra} дн.`);
  assert.ok(tg.calls.some((c) => c.method === 'editUserStarSubscription' && c.params.telegram_payment_charge_id === 'pro_1' && c.params.is_canceled));
  assert.match(last(tg).text, /УЛЬТРА<\/b> активен[\s\S]*пересчитаны/);
  // ПРО при активной УЛЬТРА купить нельзя
  await click('buy:pro');
  assert.match(last(tg).text, /У вас уже УЛЬТРА/);
});

test('ЮMoney: оплата УЛЬТРА', async () => {
  const { click, tg, bot, state, db } = await setup();
  await click('ym:ultra');
  const url = new URL(buttons(last(tg))[0].url);
  assert.equal(url.searchParams.get('sum'), '999');
  state.ops.push({ operation_id: 'op9', label: url.searchParams.get('label'), status: 'success', direction: 'in', amount: 969 });
  assert.equal(await bot.pollPayments(), 1);
  assert.equal(db.prepare('SELECT tier FROM users WHERE id = 7').get().tier, 'ultra');
  assert.ok(tg.sent.some((s) => s.chat === '900' && /оплатил УЛЬТРА/.test(s.text)));
});

test('экспорт в CSV: только с ПРО; уведомления, инвентарь, вишлист', async () => {
  const { click, msg, tg, skinId, admin } = await setup();
  await click(`ac:${skinId(RED)}:c:p10`);
  await click('exp:al');
  assert.match(last(tg).text, /Экспорт в таблицу<\/b>[\s\S]*функция тарифа ⭐ ПРО/);
  await admin('/give 7 30');
  await click('exp:al');
  const f = last(tg);
  assert.equal(f.filename, 'skinwatch-alerts.csv');
  assert.ok(f.file.startsWith('﻿Предмет;Площадка;Условие;Цена сейчас, ₽;Steam, ₽;Средняя на площадках, ₽;Покупают за, ₽;Ликвидность;Продаж в день;Рекомендуемая цена, ₽'));
  // Steam ещё не загружался — ликвидность по Skinport: 40 продаж за неделю ≈ 5,7 в день
  assert.match(f.file, /AK-47 \| Redline \(Field-Tested\);Маркет CS;±10%;1200;;1150;1300;СРЕДНЯЯ;5,7;1150/);
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  await click('exp:inv');
  assert.match(last(tg).file, /AK-47 \| Redline \(Field-Tested\);2;1120;2240/);
  await msg('https://store.steampowered.com/app/620/');
  await click('exp:wl');
  assert.match(last(tg).file, /Portal 2;38;RUB;90;380;92;;https:\/\/store\.steampowered\.com\/app\/620\//);
  await msg('/export');
  assert.match(last(tg).text, /Что выгрузить/);
});

test('чат УЛЬТРА: ссылка, одобрение заявок только УЛЬТРА, удаление после окончания', async () => {
  const { click, tg, bot, db, admin, mk } = await setup({}, { ultraChatId: '-100500' });
  const join = (id) => bot.handle({ chat_join_request: { chat: { id: -100500 }, from: { id }, user_chat_id: id } });
  await click('uchat');
  assert.match(last(tg).text, /только для тарифа 💎 УЛЬТРА|для тарифа 💎 УЛЬТРА/);
  await admin('/give 7 30 ultra');
  await click('uchat');
  assert.equal(buttons(last(tg))[0].url, 'https://t.me/+ultra');
  assert.ok(tg.calls.some((c) => c.method === 'createChatInviteLink' && c.params.creates_join_request));
  await join(7);
  await mk(8, 'stranger').msg('/start');
  await join(8);
  assert.ok(tg.calls.some((c) => c.method === 'approveChatJoinRequest' && c.params.user_id === 7));
  assert.ok(tg.calls.some((c) => c.method === 'declineChatJoinRequest' && c.params.user_id === 8));
  assert.equal(await bot.ultraSweep(), 0);
  db.prepare('UPDATE users SET premium_until = ? WHERE id = 7').run(Date.now() - 1000);
  assert.equal(await bot.ultraSweep(), 1);
  assert.ok(tg.calls.some((c) => c.method === 'banChatMember' && c.params.user_id === 7));
  assert.ok(tg.calls.some((c) => c.method === 'unbanChatMember' && c.params.only_if_banned));
  assert.match(last(tg).text, /УЛЬТРА закончилась/);
  assert.equal(await bot.ultraSweep(), 0);
});

test('игры: бесплатному тарифу скидки не чаще раза в час, ПРО — каждую проверку', async () => {
  const { msg, tg, bot, state, mk, admin } = await setup({}, { freeGamesIntervalMin: 60 });
  const pro = mk(8, 'pro');
  await pro.msg('/start');
  await admin('/give 8 30');
  await bot.wishlistCheck(); // бесплатный «слот» использован
  await msg('https://store.steampowered.com/app/1145360/');
  await pro.msg('https://store.steampowered.com/app/1145360/');
  state.games[1145360] = { ...state.games[1145360], final: 43125, discount: 25 };
  const before = tg.sent.length;
  await bot.wishlistCheck();
  const got = tg.sent.slice(before).filter((s) => /Hades.*−25%/.test(s.text)).map((s) => s.chat);
  assert.deepEqual(got, [8]);
});

// ---------- УЛЬТРА: Rust и TF2, пополнение Steam, сигналы, отчёт, график ----------
const RUST = 'Tempered AK47';

test('Rust: поиск и карточка только для УЛЬТРА, цены Skinport и Steam своей игры', async () => {
  const { msg, click, tg, admin, catalog, state, db } = await setup({ skinportApps: { 252490: { [RUST]: 900 } }, steamMarket: { [RED]: 1450, [AWP]: 11000, [RUST]: 1100 } });
  const rust = catalog.getByName(RUST, 252490);
  assert.ok(rust, 'прайс Rust загружен');
  assert.equal(catalog.getByName(RED, 252490), null, 'скины CS2 не попадают в Rust');
  assert.equal(db.prepare("SELECT COUNT(*) n FROM skin_prices p JOIN skins s ON s.id = p.skin_id WHERE s.app = 730 AND p.src = 's'").get().n, 3, 'Rust не стирает цены Skinport CS2');
  await msg('tempered ak47');
  assert.match(last(tg).text, /Скины Rust и 🎩 TF2<\/b>[\s\S]*тарифа 💎 УЛЬТРА/);
  await admin('/give 7 30 ultra');
  await msg('tempered ak47');
  const t = last(tg).text;
  assert.match(t, /🪓 <b>Tempered AK47<\/b> · Rust/);
  assert.match(t, /Skinport — <b>900 ₽/);
  assert.doesNotMatch(t, /Маркет CS/);
  assert.ok(state.steamApps.includes('252490'));
  assert.ok(buttons(last(tg)).some((b) => b.url === 'https://steamcommunity.com/market/listings/252490/Tempered%20AK47'));
  await msg('https://steamcommunity.com/market/listings/252490/Tempered%20AK47');
  assert.match(last(tg).text, /🪓 <b>Tempered AK47/);
  await click(`ak:${rust.id}`);
  assert.deepEqual(buttons(last(tg)).map((b) => b.callback_data), [`am:${rust.id}:b`, `am:${rust.id}:s`, `am:${rust.id}:t`]);
});

test('УЛЬТРА в карточке: где выгоднее продать и график цены', async () => {
  const { click, tg, admin, skinId, db, bot } = await setup({}, { skinportSellFee: 0.08 });
  await admin('/give 7 30 ultra');
  await click(`skr:${skinId(RED)}`); // со Steam
  const t = last(tg).text;
  // Skinport: min(1150 лот, 1300 продажи) = 1150 → −8% = 1058; Steam: 1450 → −13% = 1262
  assert.match(t, /Skinport: ~1\s150 ₽ → <b>~1\s058 ₽<\/b> на руки после комиссии/);
  assert.match(t, /Steam: ~1\s450 ₽ → <b>~1\s262 ₽<\/b> на кошелёк Steam \(вывести нельзя\)/);
  assert.match(t, /В Steam больше на 19%, но только на кошелёк Steam/);
  await click(`chart:${skinId(RED)}`);
  assert.match(last(tg).text, /История цены копится/);
  db.prepare("INSERT OR REPLACE INTO skin_history (skin_id, day, price) VALUES (?, date('now', '-2 day'), 1200), (?, date('now', '-1 day'), 1150)").run(skinId(RED), skinId(RED));
  await click(`chart:${skinId(RED)}`);
  assert.equal(last(tg).kind, 'photo');
  assert.match(last(tg).text, /лучшая цена на площадках за \d+ дн\./);
});

test('пополнение Steam: курс через скины и сервисы, только УЛЬТРА', async () => {
  const { click, tg, admin, bot, msg } = await setup();
  await click('topup');
  assert.match(last(tg).text, /Где выгодно пополнить Steam<\/b> — курс через скины/);
  await admin('/give 7 30 ultra');
  assert.equal(await bot.topupSteam(), 1); // Steam-цена у ходового Redline
  await admin('/topup_add ПополниСтим | 8 | https://example.com');
  await admin('/topup_add Дорогой | 15');
  await click('topup');
  const t = last(tg).text;
  // Купить на Lis-Skins 1120, в Steam продаётся за 1450 → на кошелёк 1261,5 → 0,89 ₽ за 1 ₽
  assert.match(t, /AK-47 \| Redline \(Field-Tested\)<\/b>\n   Купить: Lis-Skins — 1\s120 ₽ → в Steam продаётся за ~1\s450 ₽ → на кошелёк ~1\s262 ₽/);
  assert.match(t, /Курс: <b>0,89 ₽<\/b> за 1 ₽ в Steam/);
  assert.match(t, /ПополниСтим<\/a> — комиссия 8% → <b>1,08 ₽<\/b>/);
  assert.ok(t.indexOf('ПополниСтим') < t.indexOf('Дорогой'));
  assert.match(t, /выгоднее всего: <b>через скины<\/b> — 0,89 ₽/);
  assert.match(t, /блокировкой обмена/);
  await admin('/topup_list');
  assert.match(last(tg, 900).text, /#1 ПополниСтим — 8%/);
  await admin('/topup_del 1');
  await msg('/topup');
  assert.doesNotMatch(last(tg).text, /ПополниСтим/);
});

test('сигналы УЛЬТРА: купить — по скину из уведомлений, продать — из инвентаря, не чаще раза в сутки', async () => {
  const { click, msg, tg, admin, bot, skinId, db } = await setup({ spHistory: { [RED]: { med7: 1300, med30: 1400 }, [AWP]: { med7: 11500, med30: 9500 } } });
  await click(`ac:${skinId(RED)}:c:p10`);
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  assert.equal(await bot.signals(), 0, 'не УЛЬТРА — сигналов нет');
  await admin('/give 7 30 ultra');
  assert.equal(await bot.signals(), 2);
  const texts = tg.sent.filter((s) => s.chat === 7).map((s) => s.text);
  assert.ok(texts.some((x) => /🟢 <b>Выгодно купить:<\/b> AK-47 \| Redline[\s\S]*1\s120 ₽<\/b> на Lis-Skins, а обычно покупают за 1\s300 ₽ \(−13,8%\)/.test(x)));
  assert.ok(texts.some((x) => /🔴 <b>Пора продавать\?<\/b> AWP \| Asiimov[\s\S]*на 21,1% дороже/.test(x)));
  assert.equal(await bot.signals(), 0, 'повтор — только через сутки');
  db.prepare('UPDATE signals SET sent_at = sent_at - 86400000').run();
  await click('sig:0');
  assert.equal(await bot.signals(), 0, 'сигналы выключены');
});

test('ежедневный отчёт по инвентарю для УЛЬТРА — раз в день', async () => {
  const { click, msg, tg, admin, bot, skinId, db } = await setup({ spHistory: { [RED]: { med7: 1300, med30: 1400 }, [AWP]: { med7: 11500, med30: 9500 } } }, { reportHour: 0 });
  await msg('https://steamcommunity.com/profiles/76561198000000001');
  await click('pi:76561198000000001');
  db.prepare("INSERT OR REPLACE INTO skin_history (skin_id, day, price) VALUES (?, date('now', '-1 day'), 1000)").run(skinId(RED));
  db.prepare('INSERT INTO inv_snapshots (user_id, taken_at, value) VALUES (7, ?, 100000)').run(Date.now() - 86400_000);
  assert.equal(await bot.reports(), 0, 'не УЛЬТРА');
  await admin('/give 7 30 ultra');
  assert.equal(await bot.reports(), 1);
  const t = last(tg).text;
  assert.match(t, /📋 <b>Отчёт по инвентарю<\/b>/);
  assert.match(t, /Стоимость: <b>101\s240 ₽<\/b>/); // 2 × 1120 + 9000 + керамбит 90 000
  assert.match(t, /📈 за сутки: \+1\s240 ₽ \(\+1,2%\)/);
  assert.match(t, /Подорожали:<\/b>\n• AK-47 \| Redline \(Field-Tested\) ×2: 1\s120 ₽ \(\+12%\)/);
  assert.match(t, /Выгодно продать сейчас[\s\S]*AWP \| Asiimov \(Field-Tested\) — \+21,1%/);
  assert.equal(await bot.reports(), 0, 'второй раз за день не шлём');
});
