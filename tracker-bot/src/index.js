import { loadConfig } from './config.js';
import { openDb } from './db.js';
import { TelegramApi } from './telegram.js';
import { SteamClient } from './steam.js';
import { MarketsClient } from './markets.js';
import { createCatalog } from './catalog.js';
import { YooMoney } from './yoomoney.js';
import { Rates } from './rates.js';
import { createBot } from './bot.js';

import { readFileSync } from 'node:fs';
const config = loadConfig();
console.log(`SkinWatch ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version}`);
if (!config.botToken) {
  console.error('❌ BOT_TOKEN не задан. Скопируйте .env.example в .env и впишите токен от @BotFather.');
  process.exit(1);
}
if (!config.adminChatIds.length) console.warn('⚠️  ADMIN_CHAT_IDS не задан — /stats и уведомления об оплатах недоступны. Узнать свой id: напишите боту /id');

const db = openDb(config.dbPath);
const tg = new TelegramApi(config.botToken);
const steam = new SteamClient({ cc: config.steamCc, apiKey: config.steamApiKey });
const rates = new Rates();
await rates.refresh();
const markets = new MarketsClient({
  extraExports: config.extraExports,
  rates,
  steamCurrency: config.steamCurrency,
  skinportCurrency: config.skinportCurrency,
  sources: config.sources,
  lisUrl: config.lisUrl,
  lisCurrency: config.lisCurrency,
  avanUrl: config.avanUrl,
  avanCurrency: config.avanCurrency,
  skinportRefreshMin: config.skinportRefreshMin,
});
const catalog = createCatalog(db, { bulkSources: markets.bulk });
console.log(`🛒 Площадки скинов: ${markets.bulk.join(', ')}${config.sources.includes('a') && !config.avanUrl ? ' (Avan.Market выключен: не задан AVAN_PRICES_URL)' : ''}`);
console.log(config.itadKey ? '📈 История цен игр: IsThereAnyDeal (ключ найден)' : '📈 История цен игр: CheapShark (ITAD_API_KEY не задан)');
const ym = new YooMoney({ wallet: config.yoomoneyWallet, token: config.yoomoneyToken });
const bot = createBot({ tg, steam, markets, catalog, ym, rates, db, config });

if (config.freeForAll) {
  console.log('🆓 Режим FREE_FOR_ALL: все функции без ограничений, премиум и оплата скрыты.');
} else if (ym.enabled) {
  ym.accountInfo()
    .then((a) => console.log(`💳 ЮMoney подключён: кошелёк ${a.account}${a.account !== config.yoomoneyWallet ? ` (⚠️ в .env указан ${config.yoomoneyWallet})` : ''}`))
    .catch((e) => console.error('❌ ЮMoney:', e.message));
} else if (!config.freeForAll) {
  console.warn('⚠️  ЮMoney не настроен (YOOMONEY_WALLET / YOOMONEY_TOKEN) — оплата только звёздами. Настройка: npm run yoomoney');
}

if (!config.freeForAll) {
  console.log(`⭐ Тарифы: ПРО ${config.proPriceRub} ₽ / ${config.proStars} ⭐, УЛЬТРА ${config.ultraPriceRub} ₽ / ${config.ultraStars} ⭐. Чат УЛЬТРА: ${config.ultraChatId || 'не задан (ULTRA_CHAT_ID)'}`);
  if (config.priceRefreshMin > config.proAlertIntervalMin) console.warn(`⚠️  PRICE_REFRESH_MIN=${config.priceRefreshMin} больше, чем интервал ПРО (${config.proAlertIntervalMin} мин) — цены обновляются реже, чем обещано.`);
}

const me = await tg.call('getMe');
console.log(`🤖 @${me.username} запущен. Ссылка с меткой источника: https://t.me/${me.username}?start=vk1 (видно в /stats)`);

await tg
  .call('setMyCommands', {
    commands: [
      { command: 'start', description: 'Меню' },
      { command: 'alerts', description: 'Уведомления о ценах скинов' },
      { command: 'inventory', description: 'Стоимость инвентаря CS2' },
      { command: 'wishlist', description: 'Вишлист игр' },
      { command: 'invest', description: 'Что купить для инвестиций' },
      { command: 'export', description: 'Выгрузить в таблицу (CSV)' },
      { command: 'topup', description: 'Где выгодно пополнить Steam' },
      ...(config.freeForAll ? [] : [{ command: 'premium', description: 'Тарифы: ПРО и УЛЬТРА' }]),
      { command: 'settings', description: 'Настройки' },
      { command: 'support', description: 'Написать в поддержку' },
    ],
  })
  .catch((e) => console.warn('setMyCommands:', e.message));

// Описание бота: «Что умеет этот бот?» (до 512 символов) и короткое — в профиле и при пересылке (до 120).
const DESCRIPTION = [
  '🎯 SkinWatch следит за ценами за вас.',
  '',
  '🔫 Скины CS2: цены Маркета CS, Lis-Skins, Skinport и Steam в одном месте — где дешевле и стоит ли покупать.',
  '🔔 Уведомления, когда скин дешевеет или дорожает.',
  '💼 Стоимость инвентаря и сообщения об изменении цен в нём.',
  '🎮 Вишлист игр Steam: скидки в вашем регионе, рейтинг и совет «брать или подождать».',
  ...(config.freeForAll ? [] : ['⭐ ПРО и 💎 УЛЬТРА: ликвидность и рекомендуемая цена, частые уведомления, оценка рынка, экспорт в таблицу.']),
  '',
  'Нажмите «Старт» и напишите название скина или игры.',
].join('\n');
const SHORT_DESCRIPTION = 'Цены на скины CS2 на разных площадках, уведомления, стоимость инвентаря и скидки на игры Steam.';
await tg.call('setMyDescription', { description: process.env.BOT_DESCRIPTION || DESCRIPTION }).catch((e) => console.warn('setMyDescription:', e.message));
await tg.call('setMyShortDescription', { short_description: process.env.BOT_SHORT_DESCRIPTION || SHORT_DESCRIPTION }).catch((e) => console.warn('setMyShortDescription:', e.message));

// Расписание. Задачи не накладываются друг на друга: следующая стартует после окончания предыдущей.
function every(minutes, name, fn, firstDelayMs = 0) {
  const loop = async () => {
    try {
      const r = await fn();
      if (r && (typeof r !== 'number' || r > 0)) console.log(`[${name}]`, JSON.stringify(r));
    } catch (e) {
      console.error(`[${name}]`, e.message);
    }
    setTimeout(loop, minutes * 60_000);
  };
  setTimeout(loop, firstDelayMs);
}
every(config.priceRefreshMin, 'цены скинов', () => bot.priceCycle(), 1000);
every(config.checkIntervalMin, 'скидки на игры', () => bot.wishlistCheck(), 60_000);
if (ym.enabled && !config.freeForAll) every(0.5, 'ЮMoney', () => bot.pollPayments(), 15_000);
if (config.ultraChatId && !config.freeForAll) every(10, 'чат УЛЬТРА', () => bot.ultraSweep(), 120_000);
// УЛЬТРА: цены Steam для подборки «пополнить Steam» (понемногу, лимит Steam), сигналы, ежедневный отчёт.
every(60, 'пополнение Steam', () => bot.topupSteam(), 5 * 60_000);
every(15, 'сигналы УЛЬТРА', () => bot.signals(), 3 * 60_000);
every(10, 'отчёт по инвентарю', () => bot.reports(), 4 * 60_000);

await tg.poll((u) => bot.handle(u));
