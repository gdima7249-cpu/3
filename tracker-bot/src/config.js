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

// Некоторые сервисы (CheapShark) отклоняют запросы без понятного User-Agent.
export const USER_AGENT = env.HTTP_USER_AGENT || 'SkinWatchBot/1.0 (Telegram bot; price tracker)';
const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => String(v || '').split(',').map((x) => x.trim()).filter(Boolean);

export function loadConfig(overrides = {}) {
  return {
    botToken: env.BOT_TOKEN || '',
    adminChatIds: (env.ADMIN_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean),
    dbPath: env.DB_PATH || join(ROOT, 'data', 'bot.db'),

    // Все функции без ограничений и без упоминаний премиума/оплаты (FREE_FOR_ALL=0 — включить платный режим)
    freeForAll: !env.FREE_FOR_ALL ? true : ['1', 'true', 'yes', 'on'].includes(env.FREE_FOR_ALL.toLowerCase()),

    // ---------- Тарифы: Бесплатный / ПРО / УЛЬТРА (0 в лимите — без ограничения) ----------
    // Старые PREMIUM_* из .env по-прежнему работают и означают ПРО.
    premiumDays: num(env.PREMIUM_DAYS, 30),
    proPriceRub: num(env.PRO_PRICE_RUB ?? env.PREMIUM_PRICE_RUB, 99),
    proStars: num(env.PRO_STARS ?? env.PREMIUM_STARS, 50), // 0 — не принимать Stars за ПРО
    ultraPriceRub: num(env.ULTRA_PRICE_RUB, 999),
    ultraStars: num(env.ULTRA_STARS, 500),
    // Подписка Stars с автопродлением каждые 30 дней (0 — разовая оплата на PREMIUM_DAYS)
    starsSubscription: !['0', 'false', 'no'].includes(String(env.STARS_SUBSCRIPTION ?? '1').toLowerCase()),
    yoomoneyWallet: env.YOOMONEY_WALLET || '',
    yoomoneyToken: env.YOOMONEY_TOKEN || '',

    // Сколько скинов в уведомлениях
    freeAlerts: num(env.FREE_ALERTS, 10),
    proAlerts: num(env.PRO_ALERTS ?? env.PREMIUM_ALERTS, 50),
    ultraAlerts: num(env.ULTRA_ALERTS, 0),
    // Как часто проверять уведомления о скинах, минут (УЛЬТРА — каждый цикл цен, PRICE_REFRESH_MIN)
    freeAlertIntervalMin: num(env.FREE_ALERT_INTERVAL_MIN, 30),
    proAlertIntervalMin: num(env.PRO_ALERT_INTERVAL_MIN, 5),
    // Сколько игр в вишлисте
    freeWishlistLimit: num(env.FREE_WISHLIST_LIMIT, 10),
    proWishlistLimit: num(env.PRO_WISHLIST_LIMIT ?? env.PREMIUM_WISHLIST_LIMIT, 50),
    ultraWishlistLimit: num(env.ULTRA_WISHLIST_LIMIT, 0),
    // Скидки на игры: бесплатным — не чаще раза в N минут (платным — каждую проверку, CHECK_INTERVAL_MIN)
    freeGamesIntervalMin: num(env.FREE_GAMES_INTERVAL_MIN, 60),
    // Как часто можно обновлять состав инвентаря, часов
    freeInvTtlH: num(env.FREE_INV_REFRESH_H, 6),
    proInvTtlH: num(env.PRO_INV_REFRESH_H ?? env.PREMIUM_INV_REFRESH_H, 1),
    ultraInvTtlH: num(env.ULTRA_INV_REFRESH_H, 0.25),
    // Закрытый чат УЛЬТРА: id группы (бот — админ с правами «Приглашать» и «Блокировать»). Пусто — чата нет.
    ultraChatId: env.ULTRA_CHAT_ID || '',

    // ---------- УЛЬТРА ----------
    // Скины других игр (только УЛЬТРА): rust, tf2. Цены — Steam, Skinport и своя выгрузка (*_PRICES_URL).
    extraGames: list(env.EXTRA_GAMES ?? 'rust,tf2').map((g) => ({ rust: 252490, tf2: 440 })[g.toLowerCase()]).filter(Boolean),
    extraExports: {
      252490: { url: env.RUST_PRICES_URL || '', currency: env.RUST_PRICES_CURRENCY || 'RUB' },
      440: { url: env.TF2_PRICES_URL || '', currency: env.TF2_PRICES_CURRENCY || 'RUB' },
    },
    gamesRefreshMin: num(env.GAMES_REFRESH_MIN, 60),
    // Комиссия Skinport с продавца, % — для «Где продать». Пусто — показываем цену до комиссии.
    skinportSellFee: env.SKINPORT_SELL_FEE_PCT ? Number(env.SKINPORT_SELL_FEE_PCT) / 100 : null,
    // Пополнение Steam через скины: диапазон цен, минимум продаж в Steam за сутки, сколько предметов проверять в Steam за час
    topupMinPrice: num(env.TOPUP_MIN_PRICE, 30),
    topupMaxPrice: num(env.TOPUP_MAX_PRICE, 5000),
    topupMinVolume: num(env.TOPUP_MIN_STEAM_VOLUME, 50),
    topupSteamBatch: num(env.TOPUP_STEAM_BATCH, 40),
    // Сигналы: «купить» — лучшая цена ниже цены продаж на N%; «продать» — продажи недели выше месяца на N%
    signalBuyPct: num(env.SIGNAL_BUY_PCT, 10),
    signalSellPct: num(env.SIGNAL_SELL_PCT, 15),
    // Ежедневный отчёт по инвентарю: час по часовому поясу TIMEZONE
    reportHour: num(env.REPORT_HOUR, 10),
    timezone: env.TIMEZONE || 'Europe/Moscow',

    // Уведомления по инвентарю: не сообщать о предметах дешевле N ₽ (вся позиция с учётом количества)
    invAlertMinRub: num(env.INV_ALERT_MIN_RUB, 50),

    // Расписание
    priceRefreshMin: num(env.PRICE_REFRESH_MIN, 3), // это же — частота уведомлений УЛЬТРА
    checkIntervalMin: num(env.CHECK_INTERVAL_MIN, 30), // скидки на игры
    steamTtlMin: num(env.STEAM_PRICE_TTL_MIN, 30),
    steamBatch: num(env.STEAM_BATCH, 60),

    // Площадки скинов: c — Маркет CS, l — Lis-Skins, s — Skinport, a — Avan.Market (нужен AVAN_PRICES_URL)
    sources: env.SKIN_SOURCES || 'c,l,s,a',
    skinportRefreshMin: num(env.SKINPORT_REFRESH_MIN, 15),
    lisUrl: env.LISSKINS_PRICES_URL || 'https://lis-skins.com/market_export_json/csgo.json',
    lisCurrency: env.LISSKINS_CURRENCY || 'USD',
    avanUrl: env.AVAN_PRICES_URL || '',
    avanCurrency: env.AVAN_CURRENCY || 'RUB',
    // Оценка рынка и «Что купить» — только с ПРО
    analysisPremium: !['0', 'false', 'no'].includes(String(env.ANALYSIS_PREMIUM_ONLY ?? '1').toLowerCase()),
    // Подборка для инвестиций: минимум продаж за неделю (ликвидность) и минимальная цена предмета
    investMinVolume: num(env.INVEST_MIN_VOLUME, 15),
    investMinPrice: num(env.INVEST_MIN_PRICE, 30),

    // История цен игр: ключ IsThereAnyDeal (бесплатно: https://isthereanydeal.com/apps/my/) — точная история скидок именно в Steam.
    // Без ключа используется CheapShark (минимальная цена во всех магазинах).
    itadKey: env.ITAD_API_KEY || '',
    itadCountry: (env.ITAD_COUNTRY || 'US').toUpperCase(),

    // Регион
    steamCc: (env.STEAM_CC || 'ru').toLowerCase(),
    steamCurrency: num(env.STEAM_CURRENCY, 5), // 5 = RUB на торговой площадке Steam
    skinportCurrency: env.SKINPORT_CURRENCY || 'RUB',
    steamApiKey: env.STEAM_API_KEY || '',
    ...overrides,
  };
}
