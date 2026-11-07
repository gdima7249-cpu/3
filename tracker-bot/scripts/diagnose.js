// Самопроверка: npm run check
// Показывает, какие настройки бот видит, и проверяет доступ к внешним сервисам с этого компьютера.
import { existsSync, readFileSync } from 'node:fs';
import { loadConfig, ENV_FILE, USER_AGENT } from '../src/config.js';
import { SteamClient } from '../src/steam.js';
import { MarketsClient, GAMES } from '../src/markets.js';
import { Rates } from '../src/rates.js';

const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url))).version;
const mask = (s) => (s ? `${s.slice(0, 4)}…${s.slice(-3)} (${s.length} симв.)` : '— не задан');
const ok = (m) => console.log('  ✅', m);
const bad = (m) => console.log('  ❌', m);

console.log(`\n=== SkinWatch ${VERSION}: самопроверка ===\n`);
console.log('Файл настроек:', existsSync(ENV_FILE) ? ENV_FILE : '❌ .env не найден — скопируйте .env.example в .env');
if (existsSync(ENV_FILE)) {
  const keys = readFileSync(ENV_FILE, 'utf8').split(/\r?\n/).map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=/)?.[1]).filter(Boolean);
  console.log('Строки в .env:', keys.join(', ') || '(пусто)');
}
const c = loadConfig();
console.log('\nНастройки:');
console.log('  BOT_TOKEN      ', mask(c.botToken));
console.log('  ADMIN_CHAT_IDS ', c.adminChatIds.join(', ') || '— не задан');
console.log('  ITAD_API_KEY   ', mask(c.itadKey));
console.log('  Регион         ', c.steamCc);
console.log('  User-Agent     ', USER_AGENT);

console.log('\nИстория цен игр (GTA San Andreas — The Definitive Edition, appid 1547000):');
const steam = new SteamClient({ cc: c.steamCc });
const log = [];
try {
  const r = await steam.priceHistory(1547000, { itadKey: c.itadKey, itadCountry: c.itadCountry, log });
  log.forEach((l) => console.log('  •', l));
  r ? ok(`итог: −${r.maxDiscount}% (${r.src})`) : bad('данных нет');
} catch (e) {
  log.forEach((l) => console.log('  •', l));
  bad(e.message);
}

console.log('\nДоступ к сервисам:');
const rates = new Rates();
await rates.refresh();
rates.live ? ok(`курсы ЦБ (USD = ${rates.map.USD.toFixed(2)} ₽)`) : bad('курсы ЦБ недоступны — используются примерные');
const markets = new MarketsClient({ rates, sources: c.sources, lisUrl: c.lisUrl, lisCurrency: c.lisCurrency, avanUrl: c.avanUrl, avanCurrency: c.avanCurrency, extraExports: c.extraExports });
for (const k of markets.bulk) {
  try {
    const m = await markets.fetchBulk(k);
    ok(`${k}: ${m.size} предметов`);
  } catch (e) {
    bad(`${k}: ${e.message}${/429/.test(e.message) ? ' — площадка временно ограничила запросы (часто бывает, если бот запущен одновременно с проверкой); бот возьмёт прошлые цены' : ''}`);
  }
}
// Rust и TF2 (УЛЬТРА): Skinport отдаёт их по app_id — проверяем, что приходит; плюс своя выгрузка, если задана.
for (const app of c.extraGames) {
  const g = GAMES[app];
  const r = await markets.fetchGame(app);
  r.s?.size ? ok(`${g.title} — Skinport: ${r.s.size} предметов`) : bad(`${g.title} — Skinport: ${r.errors.s || 'пусто'}`);
  if (c.extraExports[app]?.url) r.x?.size ? ok(`${g.title} — своя выгрузка: ${r.x.size} предметов`) : bad(`${g.title} — своя выгрузка: ${r.errors.x || 'пусто'}`);
  await new Promise((res) => setTimeout(res, 2000));
}
try {
  const d = await steam.details(620); // Portal 2
  d?.name ? ok(`магазин Steam: ${d.name}`) : bad('магазин Steam: нет данных');
} catch (e) {
  bad(`магазин Steam: ${e.message}`);
}
console.log('\nСкопируйте этот текст целиком и пришлите (ключи здесь скрыты).\n');
