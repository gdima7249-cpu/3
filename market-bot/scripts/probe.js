// Самопроверка: открыть ссылку так же, как это делает бот, и показать, что удалось достать.
// Каждый запуск — одно открытие страницы Маркета (лимит MAX_CHECKS_PER_DAY здесь не учитывается).
//   npm run probe -- https://market.yandex.ru/cc/XXXX            обычный режим (как у бота)
//   npm run probe -- https://market.yandex.ru/cc/XXXX --browser  сразу браузером
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadConfig } from '../src/config.js';
import { MarketClient, loadPlaywright } from '../src/market.js';
import { summarizePage } from '../src/parse.js';
import { promoLabel } from '../src/promo.js';

const config = loadConfig();
const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--')) || config.itemUrls[0];
if (!url) {
  console.log('Укажите ссылку: npm run probe -- https://market.yandex.ru/...');
  process.exit(2);
}

const market = new MarketClient({
  userAgent: config.userAgent,
  browserMode: args.includes('--browser') ? 'always' : config.browserMode,
  proxyUrl: config.proxyUrl,
  timezone: config.timezone,
  cookieFile: join(config.dataDir, 'cookies.json'),
  browserStateFile: join(config.dataDir, 'browser-state.json'),
});

console.log(`Playwright: ${loadPlaywright() ? 'установлен' : 'не установлен'} · режим браузера: ${market.browserMode}${config.proxyUrl ? ' · через прокси' : ''}`);
console.log(`Открываю ${url} …`);
const started = Date.now();
const r = await market.check(url);
const p = r.page || {};

const dir = join(config.dataDir, 'debug');
mkdirSync(dir, { recursive: true });
if (r.html) writeFileSync(join(dir, 'probe.html'), r.html);
if (r.screenshot) writeFileSync(join(dir, 'probe.jpg'), r.screenshot);
writeFileSync(join(dir, 'probe.json'), JSON.stringify({ via: r.via, status: r.status, finalUrl: r.finalUrl, error: r.error, ...(r.html ? summarizePage(r.html, r.finalUrl) : {}) }, null, 2));

console.log('');
console.log(`Способ:        ${r.via} · HTTP ${r.status ?? '—'} · ${((Date.now() - started) / 1000).toFixed(1)} с`);
console.log(`Итоговый адрес: ${r.finalUrl || '—'}`);
if (r.ok) {
  console.log(`✅ Товар:      ${p.title || '—'}`);
  console.log(`   Цена:       ${p.price ?? 'нет в наличии'}${p.oldPrice ? ` (зачёркнутая ${p.oldPrice})` : ''}`);
  console.log(`   Продавец:   ${p.seller || 'не найден'}`);
  console.log(`   Источник цены: ${p.matchedBy}${p.matchedBy === 'first' ? ' ⚠️ не уверен, что это нужный продавец' : ''}`);
} else {
  console.log(`❌ ${r.errorText}`);
}
if (r.page) console.log(`   Найдено: JSON-LD товаров ${p.counts.ldProducts}, patch-блоков ${p.counts.patchBlocks}, предложений ${p.counts.offers}`);
if (r.page) {
  const promos = p.promos.slice(0, 3).map((c) => `${promoLabel(c)}${c.code ? ` ${c.code}` : ''} [${c.source}] «${c.snippet.slice(0, 60)}»`);
  console.log(`   Промокоды: ${promos.length ? promos.join('; ') : 'на странице не найдены'}`);
}
console.log(`\nСтраница и сводка сохранены: ${join(dir, 'probe.html')}, ${join(dir, 'probe.json')}${r.screenshot ? `, ${join(dir, 'probe.jpg')}` : ''}`);
process.exit(r.ok ? 0 : 1);
