// Ядро бота: пользователи, меню, разбор сообщений и кнопок, админ-команды.
import { esc } from './telegram.js';
import { parseSteamInput } from './steam.js';
import { createWishlist, WISHLIST_HOWTO } from './features/wishlist.js';
import { createSkins, rub } from './features/skins.js';
import { createPremium } from './features/premium.js';
import { REGIONS } from './features/wishlist.js';
import { SOURCES } from './markets.js';
import { createExport } from './features/export.js';
import { createUltraChat } from './features/ultrachat.js';
import { createUltra } from './features/ultra.js';
import { tierOf, limitsOf, TIER_TITLE, TIER_ICON, PAID, priceRub, priceStars } from './tiers.js';

const kb = (rows) => ({ reply_markup: { inline_keyboard: rows } });
const now = () => Date.now();
const MARKET_LINK = /steamcommunity\.com\/market\/listings\/(730|252490|440)\/([^?#\s]+)/i;

export function createBot({ tg, steam, markets, catalog, ym, rates, db, config }) {
  const isAdmin = (id) => config.adminChatIds.includes(String(id));
  const q = {
    user: db.prepare('SELECT * FROM users WHERE id = ?'),
    upsertUser: db.prepare(`INSERT INTO users (id, username, first_name, created_at, last_seen) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET username = excluded.username, first_name = excluded.first_name, last_seen = excluded.last_seen, blocked = 0`),
    setSource: db.prepare('UPDATE users SET source = ? WHERE id = ? AND source IS NULL'),
    setMinDiscount: db.prepare('UPDATE users SET min_discount = ? WHERE id = ?'),
    setBlocked: db.prepare('UPDATE users SET blocked = 1 WHERE id = ?'),
    setCc: db.prepare('UPDATE users SET cc = ? WHERE id = ?'),
    setInvAlerts: db.prepare('UPDATE users SET inv_alerts = ? WHERE id = ?'),
    insSupport: db.prepare('INSERT OR REPLACE INTO support_msgs (admin_chat, message_id, user_id) VALUES (?, ?, ?)'),
    supportUser: db.prepare('SELECT user_id FROM support_msgs WHERE admin_chat = ? AND message_id = ?'),
  };

  // Что бот ждёт от пользователя следующим сообщением (в памяти: после рестарта — обычный режим).
  const modes = new Map();
  const background = new Set();

  const paid = !config.freeForAll; // платный режим: видны премиум и оплата
  const MENU = kb([
    [{ text: '🔍 Найти скин', callback_data: 'find' }, { text: '🔔 Уведомления', callback_data: 'al:0' }],
    [{ text: '💼 Инвентарь CS2', callback_data: 'inv' }, { text: '🎮 Вишлист игр', callback_data: 'wl:0' }],
    [{ text: `📈 Что купить${paid ? ' ⭐' : ''}`, callback_data: 'pick' }, { text: `💳 Пополнить Steam${paid ? ' 💎' : ''}`, callback_data: 'topup' }],
    [...(paid ? [{ text: '⭐ Тарифы', callback_data: 'premium' }] : []), { text: '⚙️ Настройки', callback_data: 'set' }, { text: '💬 Поддержка', callback_data: 'sup' }],
  ]);

  const ctx = {
    tg,
    db,
    config,
    steam,
    markets,
    catalog,
    ym,
    rates,
    kb,
    now,
    menuKb: () => MENU,
    getUser: (id) => q.user.get(id),
    // Тариф: free | pro | ultra. В режиме FREE_FOR_ALL у всех лимиты УЛЬТРА.
    tier: (u) => tierOf(u, config, now()),
    limits: (u) => limitsOf(tierOf(u, config, now()), config),
    isPremium: (u) => tierOf(u, config, now()) !== 'free',
    markBlocked: (id) => q.setBlocked.run(id),
    setMode: (id, mode) => modes.set(id, mode),
    notifyAdmins: (text) => Promise.all(config.adminChatIds.map((id) => tg.send(id, text))),
    upsellUltra: (chatId, feature) => upsellUltra(chatId, feature),
    runBg: (p) => {
      const t = p.catch((e) => console.error('[bg]', e)).finally(() => background.delete(t));
      background.add(t);
    },
  };
  const wishlist = createWishlist(ctx);
  const skins = createSkins(ctx);
  const premium = createPremium(ctx);
  const exporter = createExport(ctx, { skins, wishlist });
  const ultra = createUltraChat(ctx);
  const ultraFx = createUltra(ctx, { skins });
  const freeTier = (u) => paid && ctx.tier(u) === 'free';
  const notUltra = (u) => paid && ctx.tier(u) !== 'ultra';

  function welcome(u) {
    return (
      `Привет, ${esc(u.first_name || 'игрок')}! 👋\n\nЯ слежу за ценами на скины CS2 и игры в Steam.\n\n` +
      '🔍 <b>Напишите название скина</b> — покажу цены на разных площадках и в Steam, где дешевле и стоит ли покупать.\n' +
      '🔔 <b>Поставьте уведомление</b> — напишу, когда цена изменится.\n' +
      '💼 <b>Пришлите ссылку на профиль Steam</b> — посчитаю стоимость инвентаря.\n' +
      '🎮 <b>Вишлист игр</b> — напишу о скидках и подскажу, брать сейчас или подождать.'
    );
  }

  function settingsView(u) {
    const opts = [1, 25, 50, 75];
    return {
      text:
        `⚙️ <b>Настройки</b>\n\nСкидки на игры из вишлиста — уведомлять от: <b>${u.min_discount === 1 ? 'любой' : u.min_discount + '%'}</b>` +
        (paid ? `\nТариф: ${TIER_ICON[ctx.tier(u)]} ${TIER_TITLE[ctx.tier(u)]}${ctx.tier(u) !== 'free' ? ` до ${new Date(u.premium_until).toLocaleDateString('ru-RU')}` : ''}` : ''),
      extra: kb([
        opts.map((n) => ({ text: `${n === u.min_discount ? '✅ ' : ''}${n === 1 ? 'любой' : n + '%'}`, callback_data: `md:${n}` })),
        [{ text: `🌍 Регион магазина: ${REGIONS[u.cc || config.steamCc] || (u.cc || config.steamCc).toUpperCase()}`, callback_data: 'rg' }],
        [{ text: `💼 Изменения цен в инвентаре: ${u.inv_alerts ? '🔔 вкл' : '🔕 выкл'}`, callback_data: `invn:${u.inv_alerts ? 0 : 1}` }],
        ...(ctx.tier(u) === 'ultra'
          ? [
              [{ text: `🟢 Сигналы купить/продать: ${u.signals_on ? '🔔 вкл' : '🔕 выкл'}`, callback_data: `sig:${u.signals_on ? 0 : 1}` }],
              [{ text: `📋 Отчёт по инвентарю в ${config.reportHour}:00: ${u.report_on ? '🔔 вкл' : '🔕 выкл'}`, callback_data: `rep:${u.report_on ? 0 : 1}` }],
            ]
          : []),
        [{ text: '« Меню', callback_data: 'menu' }],
      ]),
    };
  }

  // ---------- админ ----------
  function stats() {
    const one = (sql, ...a) => db.prepare(sql).get(...a);
    const users = one('SELECT COUNT(*) n, SUM(blocked) b, SUM(created_at > ?) d, SUM(last_seen > ?) a FROM users', now() - 86400_000, now() - 86400_000);
    const src = db.prepare("SELECT COALESCE(source, '—') s, COUNT(*) n, SUM(premium_until > ?) p FROM users GROUP BY 1 ORDER BY 2 DESC LIMIT 15").all(now());
    const wl = wishlist.stats();
    const sk = skins.stats();
    const pr = premium.stats();
    const lr = skins.lastRefresh();
    return [
      '<b>📊 Статистика</b>',
      `Пользователей: ${users.n} (новых за сутки: ${users.d ?? 0}, активных: ${users.a ?? 0}, заблокировали: ${users.b ?? 0})`,
      `Уведомления о скинах: ${sk.alerts.n} у ${sk.alerts.u} чел.`,
      `Привязано инвентарей: ${sk.inventories}`,
      `Вишлист: ${wl.n} игр у ${wl.u} чел.`,
      `Платные тарифы: ⭐ ПРО — <b>${pr.pro}</b>, 💎 УЛЬТРА — <b>${pr.ultra}</b>`,
      `Оплаты ЮMoney: ${pr.ym.n} на ${rub(pr.ym.s)} · Stars: ${pr.stars.n} на ${pr.stars.s} ⭐`,
      `Каталог скинов: ${catalog.size()}${lr ? ` · обновлён ${new Date(lr.at).toLocaleTimeString('ru-RU')} (${Object.entries(lr).filter(([k]) => SOURCES[k]).map(([k, v]) => `${SOURCES[k].title}: ${esc(String(v))}`).join(', ')})` : ' · ещё не загружался'}`,
      '',
      '<b>Источники</b> (пришли / платят):',
      ...src.map((r) => `${esc(r.s)}: ${r.n} / ${r.p ?? 0}`),
    ].join('\n');
  }

  async function broadcast(chatId, args) {
    const t = now();
    const audiences = {
      all: 'SELECT id FROM users WHERE blocked = 0',
      paid: `SELECT id FROM users WHERE blocked = 0 AND premium_until > ${t}`,
      pro: `SELECT id FROM users WHERE blocked = 0 AND premium_until > ${t} AND COALESCE(tier, 'pro') = 'pro'`,
      ultra: `SELECT id FROM users WHERE blocked = 0 AND premium_until > ${t} AND tier = 'ultra'`,
      free: `SELECT id FROM users WHERE blocked = 0 AND (premium_until IS NULL OR premium_until <= ${t})`,
    };
    audiences.premium = audiences.paid; // старое название
    let aud = 'all';
    if (audiences[args[0]]) aud = args.shift();
    const text = args.join(' ').trim();
    if (!text) return tg.send(chatId, 'Формат: /broadcast [all|paid|pro|ultra|free] текст');
    const ids = db.prepare(audiences[aud]).all().map((r) => r.id);
    await tg.send(chatId, `Отправляю ${ids.length} пользователям…`);
    let ok = 0;
    for (const id of ids) {
      const r = await tg.send(id, text);
      if (r) ok++;
      else if (r === false) q.setBlocked.run(id);
      await new Promise((res) => setTimeout(res, 50));
    }
    return tg.send(chatId, `Готово: доставлено ${ok} из ${ids.length}.`);
  }

  // ---------- сообщения ----------
  function touch(from) {
    q.upsertUser.run(from.id, from.username ?? null, from.first_name ?? null, now(), now());
    return q.user.get(from.id);
  }

  async function resolveProfile(chatId, input) {
    if (input.type === 'profile') return input.steamid;
    const id = await steam.resolveVanity(input.name).catch(() => null);
    if (!id) {
      await tg.send(
        chatId,
        'Не могу открыть профиль по короткой ссылке. Пришлите ссылку вида <code>steamcommunity.com/profiles/7656…</code>\n' +
          'Её можно найти на steamid.io: вставьте туда свою ссылку и скопируйте «steamID64».',
      );
    }
    return id;
  }

  // ---------- продажа тарифа УЛЬТРА ----------
  function upsellUltra(chatId, feature) {
    const what = {
      games: '🪓 <b>Скины Rust и 🎩 TF2</b> — поиск, цены в Steam и на Skinport, уведомления, цена по рынку.',
      topup: '💳 <b>Где выгодно пополнить Steam</b> — курс через скины (купить на площадке, продать в Steam) и сравнение сервисов пополнения.',
      chart: '📈 <b>График цены скина</b> за 30 дней.',
    }[feature];
    const stars = priceStars('ultra', config);
    const rows = [];
    if (stars > 0) rows.push([{ text: `💎 УЛЬТРА — ${stars} ⭐/мес`, callback_data: 'buy:ultra' }]);
    rows.push([{ text: 'Все тарифы', callback_data: 'premium' }]);
    return tg.send(chatId, `${what}\n\nЭто функция тарифа 💎 УЛЬТРА — ${rub(priceRub('ultra', config))} в месяц${stars ? ` (${stars} ⭐)` : ''}. В УЛЬТРА также сигналы «выгодно купить / пора продавать», ежедневный отчёт по инвентарю и «где выгоднее продать».`, kb(rows));
  }

  // ---------- продажа тарифа ПРО ----------
  function upsell(chatId, feature) {
    const what = {
      analysis: '📊 <b>Оценка рынка</b> — выгодна ли сейчас цена скина, куда движется рынок, где купить и где продать.',
      invest: '📈 <b>Что купить</b> — подборка скинов, которые сейчас дешевле обычного и хорошо продаются, под ваш бюджет.',
      export: '📄 <b>Экспорт в таблицу</b> — уведомления, инвентарь и вишлист в CSV для Excel, с ликвидностью и рекомендуемой ценой.',
    }[feature];
    const stars = priceStars('pro', config);
    const rows = [];
    if (stars > 0) rows.push([{ text: `⭐ ПРО — ${stars} ⭐/мес`, callback_data: 'buy:pro' }]);
    rows.push([{ text: 'Все тарифы', callback_data: 'premium' }]);
    return tg.send(
      chatId,
      `${what}\n\nЭто функция тарифа ⭐ ПРО — ${rub(priceRub('pro', config))} в месяц${stars ? ` (${stars} ⭐)` : ''}. В ПРО также ликвидность и рекомендуемая цена в карточке скина и уведомления каждые ${config.proAlertIntervalMin} мин.`,
      kb(rows),
    );
  }

  // ---------- поддержка ----------
  const SUPPORT_PROMPT = '💬 Напишите ваш вопрос одним сообщением — я передам его администратору. Ответ придёт сюда.';
  async function forwardToSupport(chatId, u, text) {
    if (!config.adminChatIds.length) return tg.send(chatId, 'Поддержка пока не подключена. Попробуйте позже.');
    let delivered = 0;
    for (const admin of config.adminChatIds) {
      const r = await tg.send(admin, `💬 <b>Обращение</b> от ${esc(u.username ? '@' + u.username : u.first_name || 'пользователя')} (id <code>${u.id}</code>):\n\n${esc(text)}\n\n<i>Ответьте на это сообщение (свайп → «Ответить»), и ответ уйдёт пользователю. Или: /reply ${u.id} текст</i>`);
      if (r?.message_id) q.insSupport.run(Number(admin), r.message_id, u.id);
      if (r) delivered++;
    }
    return tg.send(chatId, delivered ? '✅ Сообщение передано администратору. Ответ придёт сюда.' : 'Не получилось передать сообщение. Попробуйте позже.', MENU);
  }
  async function replyToUser(adminChat, userId, text) {
    const r = await tg.send(userId, `💬 <b>Ответ поддержки:</b>\n\n${esc(text)}`);
    return tg.send(adminChat, r ? '✅ Ответ отправлен.' : '⚠️ Не удалось отправить: пользователь заблокировал бота или не запускал его.');
  }

  async function onText(chatId, u, text) {
    const mode = modes.get(u.id);
    const input = parseSteamInput(text);

    if (mode?.type === 'support') {
      modes.delete(u.id);
      return forwardToSupport(chatId, u, text);
    }

    if (mode?.type === 'alert_price') {
      const v = Number(text.replace(/\s/g, '').replace(',', '.').replace(/[^\d.]/g, ''));
      if (!(v > 0)) return tg.send(chatId, 'Пришлите цену числом в рублях, например <code>1500</code>. Или нажмите /menu, чтобы отменить.');
      modes.delete(u.id);
      return skins.createAlert(chatId, u, mode.skinId, mode.market, mode.kind, v);
    }

    // Ссылки распознаём в любом режиме.
    const ml = text.match(MARKET_LINK);
    if (ml) {
      const app = Number(ml[1]);
      const name = decodeURIComponent(ml[2]);
      if (app !== 730 && (notUltra(u) || !config.extraGames.includes(app))) return config.extraGames.includes(app) ? upsellUltra(chatId, 'games') : tg.send(chatId, 'Пока поддерживаются скины CS2, Rust и TF2.');
      const s = catalog.getByName(name, app) || catalog.ensure(name, app);
      return skins.card(chatId, s.id);
    }
    if (input.type === 'app') return wishlist.add(chatId, u, input.appid);
    if (input.type === 'profile' || input.type === 'vanity') {
      const steamid = await resolveProfile(chatId, input);
      if (!steamid) return;
      if (mode?.type === 'inv_link') {
        modes.delete(u.id);
        return skins.linkProfile(chatId, u, steamid);
      }
      if (mode?.type === 'game') return wishlist.importWishlist(chatId, u, steamid);
      return tg.send(chatId, 'Что сделать с этим профилем?', kb([[{ text: '💼 Посчитать инвентарь CS2', callback_data: `pi:${steamid}` }], [{ text: '🎮 Импортировать вишлист игр', callback_data: `pw:${steamid}` }]]));
    }

    if (mode?.type === 'game') return wishlist.search(chatId, u, input.term);
    if (mode?.type === 'inv_link') modes.delete(u.id);

    if (input.term.length < 2) return tg.send(chatId, 'Напишите название чуть подробнее.');
    const found = skins.searchSkins(input.term, u);
    if (found.length) return skins.sendResults(chatId, found);
    if (notUltra(u) && skins.searchOther(input.term).length) return upsellUltra(chatId, 'games');
    if (!catalog.size()) return tg.send(chatId, '⏳ Загружаю цены площадок, это займёт минуту. Попробуйте ещё раз чуть позже.');
    // Скина нет — возможно, это игра.
    return wishlist.search(chatId, u, input.term);
  }

  async function onMessage(m) {
    if (m.chat.type !== 'private') return;
    const chatId = m.chat.id;
    const u = touch(m.from);

    if (m.successful_payment) return premium.onStarsPaid(u, m.successful_payment);

    const text = (m.text || '').trim();
    if (!text) return;
    // Админ отвечает на обращение через «Ответить».
    if (isAdmin(chatId) && m.reply_to_message && !text.startsWith('/')) {
      const row = q.supportUser.get(chatId, m.reply_to_message.message_id);
      if (row) return replyToUser(chatId, row.user_id, text);
    }
    if (!text.startsWith('/')) return onText(chatId, u, text);

    const [cmdRaw, ...args] = text.split(/\s+/);
    const cmd = cmdRaw.split('@')[0].toLowerCase();
    modes.delete(u.id);
    switch (cmd) {
      case '/start': {
        const src = (args[0] || '').replace(/[^\w-]/g, '').slice(0, 64);
        if (src) q.setSource.run(src, u.id);
        return tg.send(chatId, welcome(u), MENU);
      }
      case '/menu':
      case '/help':
        return tg.send(chatId, welcome(u), MENU);
      case '/alerts':
        return skins.listAlerts(chatId, u);
      case '/invest':
        if (config.analysisPremium && freeTier(u)) return upsell(chatId, 'invest');
        return skins.showInvest(chatId, u, args[0] || 'a');
      case '/inventory':
        return skins.showInventory(chatId, u);
      case '/wishlist':
        return wishlist.show(chatId, u, 0);
      case '/export':
        if (freeTier(u)) return upsell(chatId, 'export');
        return exporter.send(chatId, u, args[0]);
      case '/topup':
        if (notUltra(u)) return upsellUltra(chatId, 'topup');
        return ultraFx.showTopup(chatId);
      case '/report':
        if (notUltra(u)) return upsellUltra(chatId, 'topup');
        return ultraFx.sendReport(chatId, u);
      case '/chat':
      case '/ultra':
        if (!paid) return tg.send(chatId, welcome(u), MENU);
        return ultra.offer(chatId, u);
      case '/premium':
      case '/plans':
      case '/tariffs': {
        if (!paid) return tg.send(chatId, welcome(u), MENU);
        const v = premium.view(u);
        return tg.send(chatId, v.text, v.extra);
      }
      case '/settings': {
        const v = settingsView(u);
        return tg.send(chatId, v.text, v.extra);
      }
      case '/id':
        return tg.send(chatId, `Ваш chat id: <code>${chatId}</code>`);
      case '/support':
      case '/paysupport':
        if (args.length) return forwardToSupport(chatId, u, args.join(' '));
        modes.set(u.id, { type: 'support' });
        return tg.send(chatId, SUPPORT_PROMPT);
      case '/terms':
        if (!paid) return tg.send(chatId, 'Цены берутся с публичных данных площадок и могут отличаться от фактических на момент покупки. Вопросы: /paysupport.');
        return tg.send(
          chatId,
          `Основные функции бесплатны. Платные тарифы: ПРО — ${rub(priceRub('pro', config))}, УЛЬТРА — ${rub(priceRub('ultra', config))} за ${config.premiumDays} дней. ` +
            (config.starsSubscription ? 'Оплата звёздами — подписка, которую можно отменить в любой момент; ЮMoney — разово, без автосписаний. ' : 'Оплата разовая, без автосписаний. ') +
            'Цены берутся с публичных данных площадок и могут отличаться от фактических на момент покупки. Вопросы по оплате: /paysupport.',
        );
    }
    if (!isAdmin(chatId)) return tg.send(chatId, 'Не знаю такой команды. Меню — /start');
    switch (cmd) {
      case '/stats':
        return tg.send(chatId, stats());
      case '/broadcast':
        return broadcast(chatId, args);
      case '/refund':
        return Number(args[0]) ? premium.refundStars(chatId, Number(args[0])) : tg.send(chatId, 'Формат: /refund user_id');
      case '/reply': {
        const uid = Number(args[0]);
        const t = args.slice(1).join(' ');
        if (!uid || !t) return tg.send(chatId, 'Формат: /reply user_id текст');
        return replyToUser(chatId, uid, t);
      }
      case '/topup_add': {
        const id = ultraFx.services.add(args.join(' '));
        return tg.send(chatId, id ? `✅ Добавлен сервис #${id}. Список: /topup_list` : 'Формат: /topup_add Название | комиссия % | ссылка\nНапример: /topup_add SteamPay | 8 | https://example.com');
      }
      case '/topup_del':
        return tg.send(chatId, ultraFx.services.del(Number(args[0])) ? '✅ Удалено.' : 'Формат: /topup_del id (id — в /topup_list)');
      case '/topup_list': {
        const list = ultraFx.services.list();
        return tg.send(chatId, list.length ? list.map((x) => `#${x.id} ${esc(x.name)} — ${x.fee}%${x.url ? ` · ${esc(x.url)}` : ''} (обновлено ${new Date(x.updated_at).toLocaleDateString('ru-RU')})`).join('\n') : 'Список сервисов пополнения пуст. Добавить: /topup_add Название | комиссия % | ссылка');
      }
      case '/give': {
        const [uid, days] = args.slice(0, 2).map(Number);
        const tier = PAID.includes(args[2]) ? args[2] : 'pro';
        if (!uid || !days || !q.user.get(uid)) return tg.send(chatId, 'Формат: /give user_id дней [pro|ultra] (пользователь должен был запустить бота)');
        const r = premium.grant(uid, days, tier);
        const date = new Date(r.until).toLocaleDateString('ru-RU');
        await tg.send(uid, `🎁 Вам подарен тариф ${TIER_ICON[r.tier]} <b>${TIER_TITLE[r.tier]}</b> до <b>${date}</b>!`);
        return tg.send(chatId, `Готово: ${TIER_TITLE[r.tier]} у ${uid} до ${date}.`);
      }
      case '/history': {
        // Диагностика истории цен игры: /history 12210 или ссылка на игру.
        const m = (args[0] || '').match(/(\d+)/);
        if (!m) return tg.send(chatId, 'Формат: /history appid или ссылка на игру в Steam');
        const log = [];
        const r = await steam.priceHistory(Number(m[1]), { itadKey: config.itadKey, itadCountry: config.itadCountry, log }).catch((e) => (log.push(`ошибка: ${e.message}`), null));
        return tg.send(chatId, `<b>История цен ${m[1]}</b>\n${log.map((l) => '• ' + esc(l)).join('\n')}\n\nИтог: ${r ? `−${r.maxDiscount}% (${r.src})` : 'нет данных'}`);
      }
      case '/check': {
        await tg.send(chatId, 'Обновляю цены и проверяю уведомления…');
        const r = await skins.priceCycle().catch((e) => ({ error: e.message }));
        const w = await wishlist.check().catch((e) => ({ error: e.message }));
        const p = await premium.pollYoomoney().catch((e) => e.message);
        return tg.send(chatId, `Скины: ${esc(JSON.stringify(r))}\nИгры: ${esc(JSON.stringify(w))}\nЮMoney, новых оплат: ${esc(String(p))}`);
      }
    }
    return tg.send(chatId, 'Админ: /stats, /broadcast [all|paid|pro|ultra|free] текст, /reply user_id текст, /give user_id дней [pro|ultra], /refund user_id, /check, /history appid, /topup_add | /topup_del | /topup_list');
  }

  // ---------- кнопки ----------
  async function onCallback(cq) {
    const chatId = cq.message?.chat?.id;
    const msgId = cq.message?.message_id;
    const u = touch(cq.from);
    const [action, a, b, c] = String(cq.data || '').split(':');
    const answer = (text) => tg.call('answerCallbackQuery', { callback_query_id: cq.id, ...(text ? { text } : {}) }).catch(() => {});
    if (!chatId) return answer();
    if (!['ac'].includes(action)) modes.delete(u.id);

    switch (action) {
      case 'menu':
        await answer();
        return tg.edit(chatId, msgId, welcome(u), MENU);
      case 'find':
        await answer();
        return tg.send(chatId, '🔍 Напишите название скина, например:\n<code>AK-47 Redline FT</code>\n<code>калаш редлайн</code>\n<code>керамбит допплер</code>\n\nИли пришлите ссылку на предмет с торговой площадки Steam.');

      // скины
      case 'sk':
        await answer();
        return skins.card(chatId, Number(a));
      case 'ls':
        skins.setListed(u, Number(a), b === '-' ? '-' : '+');
        await answer(b === '-' ? 'Убрал' : 'Отметил');
        return skins.card(chatId, Number(a), msgId);
      case 'aa':
        await answer();
        return skins.autoAlert(chatId, u, Number(a));
      case 'an':
        await answer('Считаю…');
        if (config.analysisPremium && freeTier(u)) return upsell(chatId, 'analysis');
        return skins.analyze(chatId, u, Number(a));
      case 'pick':
      case 'pk':
        await answer();
        if (config.analysisPremium && freeTier(u)) return upsell(chatId, 'invest');
        return skins.showInvest(chatId, u, a || 'a', action === 'pk' ? msgId : undefined);
      case 'gi':
        await answer();
        return wishlist.info(chatId, u, Number(a));
      case 'gno':
        await answer();
        return wishlist.otherResults(chatId, u);
      case 'sup':
        await answer();
        modes.set(u.id, { type: 'support' });
        return tg.send(chatId, SUPPORT_PROMPT);
      case 'rg': {
        await answer();
        const cur = u.cc || config.steamCc;
        const rows = Object.entries(REGIONS).map(([cc, name]) => ({ text: `${cc === cur ? '✅ ' : ''}${name}`, callback_data: `rgs:${cc}` }));
        const grid = [];
        for (let i = 0; i < rows.length; i += 3) grid.push(rows.slice(i, i + 3));
        grid.push([{ text: '« Настройки', callback_data: 'set' }]);
        return tg.edit(chatId, msgId, '🌍 <b>Регион магазина Steam</b>\n\nЦены на игры будут в валюте региона, рядом — примерная сумма в рублях. Если игра в регионе недоступна, я об этом напишу.', kb(grid));
      }
      case 'rgs': {
        if (!REGIONS[a]) return answer();
        q.setCc.run(a, u.id);
        await answer(`Регион: ${REGIONS[a]}`);
        const v = settingsView(q.user.get(u.id));
        return tg.edit(chatId, msgId, v.text, v.extra);
      }
      case 'skr':
        await answer('Обновляю…');
        return skins.refreshCard(chatId, Number(a), msgId);
      case 'ak':
        await answer();
        return skins.chooseMarket(chatId, u, Number(a));
      case 'am':
        await answer();
        return skins.chooseCondition(chatId, Number(a), b, msgId);
      case 'ac': {
        await answer();
        if (c === 'lt' || c === 'gt') {
          modes.set(u.id, { type: 'alert_price', skinId: Number(a), market: b, kind: c });
          return tg.send(chatId, `Пришлите цену в рублях — напишу, когда цена будет ${c === 'lt' ? 'ниже' : 'выше'} неё. Например: <code>1500</code>`);
        }
        const p = Number(String(c).replace('p', ''));
        return skins.createAlert(chatId, u, Number(a), b, 'pct', [5, 10, 20].includes(p) ? p : 10);
      }
      case 'al':
        await answer();
        return skins.listAlerts(chatId, u, Number(a) || 0, msgId);
      case 'ad':
        skins.deleteAlert(u, Number(a));
        await answer('Уведомление удалено');
        return skins.listAlerts(chatId, u, Number(b) || 0, msgId);

      // инвентарь
      case 'inv':
        await answer();
        return skins.showInventory(chatId, u);
      case 'invr':
        await answer();
        return skins.refreshInventory(chatId, u);
      case 'invu':
        await answer();
        skins.unlink(u);
        return skins.showInventory(chatId, q.user.get(u.id));
      case 'pi':
        await answer();
        return skins.linkProfile(chatId, u, a);
      case 'pw':
        await answer();
        return wishlist.importWishlist(chatId, u, a);

      // вишлист игр
      case 'wl':
        await answer();
        return wishlist.show(chatId, u, Number(a) || 0, msgId);
      case 'gadd':
        if (a) {
          await answer('Добавляю…');
          return wishlist.add(chatId, u, Number(a));
        }
        await answer();
        modes.set(u.id, { type: 'game' });
        return tg.send(chatId, WISHLIST_HOWTO);
      case 'gdel':
        wishlist.remove(u, Number(a));
        await answer('Убрал из вишлиста');
        return b === 'n' ? null : wishlist.show(chatId, u, Number(b) || 0, msgId);

      // премиум
      case 'premium': {
        await answer();
        if (!paid) return tg.send(chatId, welcome(u), MENU);
        const v = premium.view(u);
        return tg.send(chatId, v.text, v.extra);
      }
      case 'ym':
        await answer();
        if (!paid) return null;
        return premium.startYoomoney(chatId, u, a || 'pro');
      case 'ymc':
        await answer('Проверяю…');
        return premium.checkNow(chatId, u, Number(a));
      case 'buy':
        await answer();
        if (!paid) return null;
        return premium.sendStarsInvoice(chatId, u, a || 'pro');
      case 'uchat':
        await answer();
        if (!paid) return null;
        return ultra.offer(chatId, u);

      // УЛЬТРА
      case 'topup':
        await answer();
        if (notUltra(u)) return upsellUltra(chatId, 'topup');
        return ultraFx.showTopup(chatId);
      case 'chart':
        await answer();
        if (notUltra(u)) return upsellUltra(chatId, 'chart');
        return ultraFx.sendChart(chatId, Number(a));
      case 'sig':
      case 'rep': {
        db.prepare(`UPDATE users SET ${action === 'sig' ? 'signals_on' : 'report_on'} = ? WHERE id = ?`).run(a === '1' ? 1 : 0, u.id);
        const what = action === 'sig' ? 'Сигналы купить/продать' : 'Ежедневный отчёт';
        await answer(`${what}: ${a === '1' ? 'включено' : 'выключено'}`);
        if (cq.message?.text?.startsWith('⚙️')) {
          const v = settingsView(q.user.get(u.id));
          return tg.edit(chatId, msgId, v.text, v.extra);
        }
        return a === '1' ? null : tg.send(chatId, `🔕 ${what} выключен${action === 'sig' ? 'ы' : ''}. Включить снова — ⚙️ Настройки.`);
      }

      // экспорт
      case 'exp':
        await answer();
        if (freeTier(u)) return upsell(chatId, 'export');
        return exporter.send(chatId, u, a);

      // настройки
      case 'set': {
        await answer();
        const v = settingsView(u);
        return tg.edit(chatId, msgId, v.text, v.extra);
      }
      case 'invn': {
        q.setInvAlerts.run(a === '1' ? 1 : 0, u.id);
        await answer(a === '1' ? 'Уведомления по инвентарю включены' : 'Уведомления по инвентарю выключены');
        if (a === '0' && msgId && !cq.message?.text?.startsWith('⚙️')) {
          return tg.send(chatId, '🔕 Больше не буду присылать изменения цен в инвентаре. Включить снова — ⚙️ Настройки.');
        }
        const v = settingsView(q.user.get(u.id));
        return tg.edit(chatId, msgId, v.text, v.extra);
      }
      case 'md': {
        const n = [1, 25, 50, 75].includes(Number(a)) ? Number(a) : 1;
        q.setMinDiscount.run(n, u.id);
        await answer('Сохранено');
        const v = settingsView(q.user.get(u.id));
        return tg.edit(chatId, msgId, v.text, v.extra);
      }
      default:
        return answer();
    }
  }

  async function onPreCheckout(pcq) {
    const error = config.freeForAll ? 'Оплата сейчас недоступна' : premium.checkStarsInvoice(pcq);
    await tg.call('answerPreCheckoutQuery', error ? { pre_checkout_query_id: pcq.id, ok: false, error_message: error } : { pre_checkout_query_id: pcq.id, ok: true });
  }

  return {
    async handle(update) {
      if (update.chat_join_request) return ultra.onJoinRequest(update.chat_join_request);
      if (update.pre_checkout_query) return onPreCheckout(update.pre_checkout_query);
      if (update.callback_query) return onCallback(update.callback_query);
      if (update.message) return onMessage(update.message);
    },
    priceCycle: () => skins.priceCycle(),
    wishlistCheck: () => wishlist.check(),
    pollPayments: () => premium.pollYoomoney(),
    ultraSweep: () => ultra.sweep(),
    topupSteam: () => ultraFx.refreshTopupSteam(),
    signals: () => ultraFx.checkSignals(),
    reports: () => ultraFx.dailyReports(),
    idle: () => Promise.all([...background]),
  };
}
