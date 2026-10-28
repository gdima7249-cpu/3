import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
export const ENV_FILE = join(ROOT, '.env');

// Минимальный парсер .env. Переменные окружения важнее файла.
if (existsSync(ENV_FILE)) {
  for (const line of readFileSync(ENV_FILE, 'utf8').replace(/^﻿/, '').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    const quoted = m[2].match(/^(['"])(.*)\1$/);
    const v = quoted ? quoted[2] : m[2].replace(/\s+#.*$/, '');
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

const env = process.env;
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);

// Обычный Chrome под Windows. Маркет отдаёт страницу браузерам, поэтому представляемся браузером.
export const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/153.0.0.0 Safari/537.36';

export function loadConfig(overrides = {}) {
  const dataDir = env.DATA_DIR || join(ROOT, 'data');
  const checkTimes = list(env.CHECK_TIMES || '12:00')
    .map((t) => t.match(/^(\d{1,2}):(\d{2})$/))
    .filter(Boolean)
    .map((m) => `${m[1].padStart(2, '0')}:${m[2]}`)
    .sort();
  return {
    botToken: env.BOT_TOKEN || '',
    // Кому бот отвечает и шлёт уведомления. Пусто — владельцем станет первый, кто напишет /start.
    allowedChatIds: list(env.ALLOWED_CHAT_IDS).map(Number).filter(Boolean),
    dataDir,
    dbPath: env.DB_PATH || join(dataDir, 'bot.db'),

    // Ссылки, которые бот добавит сам при запуске (через запятую)
    itemUrls: list(env.ITEM_URLS),

    // Расписание: время проверок по часовому поясу TIMEZONE
    timezone: env.TIMEZONE || 'Europe/Moscow',
    checkTimes: checkTimes.length ? checkTimes : ['12:00'],
    // Сколько раз в сутки бот может открыть страницу товара (вместе с повторами и ручными проверками)
    maxChecksPerDay: Math.max(1, num(env.MAX_CHECKS_PER_DAY, 2)),
    // Через сколько минут повторить неудачную проверку (капча, сбой сети)
    retryAfterMin: num(env.RETRY_AFTER_MIN, 120),
    // always — присылать цену после каждой проверки; change — только если что-то изменилось
    notifyMode: env.NOTIFY_MODE === 'change' ? 'change' : 'always',

    // Промокод: следить ли, какой процент искать (0 — любой) и потолок скидки «до N ₽» (если на странице его нет).
    // Меняется и в боте: /promo
    promoWatch: !['0', 'false', 'no', 'off'].includes(String(env.PROMO_WATCH ?? '1').toLowerCase()),
    promoPercent: num(env.PROMO_PERCENT, 5),
    promoMaxDiscount: num(env.PROMO_MAX_DISCOUNT, null),

    // Загрузка страницы
    userAgent: env.HTTP_USER_AGENT || DEFAULT_USER_AGENT,
    // auto — браузер (Playwright), только если обычный запрос упёрся в капчу; always — сразу браузер; off — без браузера
    browserMode: ['always', 'off'].includes(env.BROWSER) ? env.BROWSER : 'auto',
    // Прокси для браузера, например http://user:pass@1.2.3.4:8080 (с ним бот всегда ходит браузером)
    proxyUrl: env.PROXY_URL || '',
    ...overrides,
  };
}
