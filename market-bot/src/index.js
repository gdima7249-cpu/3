import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from './config.js';
import { openDb, createStore } from './db.js';
import { TelegramApi } from './telegram.js';
import { MarketClient } from './market.js';
import { createBot, isMarketUrl } from './bot.js';
import { zoned } from './schedule.js';

const config = loadConfig();
console.log(`Маркет-цены ${JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version}`);
if (!config.botToken) {
  console.error('❌ BOT_TOKEN не задан. Скопируйте .env.example в .env и впишите токен от @BotFather.');
  process.exit(1);
}

try {
  zoned(Date.now(), config.timezone);
} catch {
  console.error(`❌ Неизвестный часовой пояс TIMEZONE=${config.timezone}. Пример: Europe/Moscow`);
  process.exit(1);
}

const store = createStore(openDb(config.dbPath));
const tg = new TelegramApi(config.botToken);
const market = new MarketClient({
  userAgent: config.userAgent,
  browserMode: config.browserMode,
  proxyUrl: config.proxyUrl,
  timezone: config.timezone,
  cookieFile: join(config.dataDir, 'cookies.json'),
  browserStateFile: join(config.dataDir, 'browser-state.json'),
});
const bot = createBot({ tg, store, market, config });

for (const url of config.itemUrls) {
  if (!isMarketUrl(url)) console.warn(`⚠️  ITEM_URLS: не ссылка на Яндекс Маркет — ${url}`);
  else if (store.addItem(url).created) console.log(`➕ Добавлен товар из ITEM_URLS: ${url}`);
}

console.log(`🕐 Проверки: ${config.checkTimes.join(', ')} (${config.timezone}), не больше ${config.maxChecksPerDay} в сутки на товар; повтор после ошибки через ${config.retryAfterMin} мин.`);
console.log(
  market.browserAvailable
    ? `🌐 Браузер (Playwright) найден: ${config.proxyUrl || config.browserMode === 'always' ? 'страницы открываются им' : 'включится, если Маркет покажет капчу'}.`
    : '🌐 Браузер (Playwright) не установлен — только обычные запросы. Если Маркет начнёт показывать капчу, см. README.',
);
if (config.proxyUrl && !market.browserAvailable) console.warn('⚠️  PROXY_URL задан, но браузер (Playwright) не установлен — прокси работает только через браузер, запросы идут напрямую.');
console.log(`🎟 Промокод: ${bot.promoStatusText()} (меняется в боте: /promo).`);
if (!bot.owners().length) console.log('👤 Владелец ещё не задан: им станет первый, кто напишет боту /start.');

const me = await tg.call('getMe');
console.log(`🤖 @${me.username} запущен. Товаров: ${store.items().length}`);

await tg
  .call('setMyCommands', {
    commands: [
      { command: 'list', description: 'Товары и последние цены' },
      { command: 'check', description: 'Проверить цену сейчас' },
      { command: 'history', description: 'Динамика цены' },
      { command: 'mode', description: 'Когда присылать уведомления' },
      { command: 'promo', description: 'Какой промокод искать' },
      { command: 'debug', description: 'Что бот увидел на странице' },
      { command: 'start', description: 'Справка' },
    ],
  })
  .catch((e) => console.warn('setMyCommands:', e.message));

// Раз в минуту смотрим, не пора ли проверить товары. Следующий круг — только после окончания предыдущего.
const loop = async () => {
  try {
    await bot.tick();
  } catch (e) {
    console.error('[tick]', e);
  }
  setTimeout(loop, 60_000);
};
setTimeout(loop, 5_000);

await tg.poll((u) => bot.handle(u));
