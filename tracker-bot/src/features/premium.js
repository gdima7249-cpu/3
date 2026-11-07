// Платные тарифы ПРО и УЛЬТРА: оплата через ЮMoney (карта или кошелёк) и Telegram Stars.
import { randomBytes } from 'node:crypto';
import { esc } from '../telegram.js';
import { rub } from './skins.js';
import { PAID, TIER_TITLE, TIER_ICON, rank, limitsOf, priceRub, priceStars, every, count } from '../tiers.js';
import { GAMES } from '../markets.js';

const DAY = 86400_000;
const PENDING_TTL = DAY;
// Старые счета и подписки «premium» — это ПРО.
const payloadTier = (payload) => (payload === 'ultra' ? 'ultra' : payload === 'pro' || payload === 'premium' ? 'pro' : null);

export function createPremium(ctx) {
  const { tg, db, config, ym, kb, now } = ctx;
  const q = {
    setPlan: db.prepare('UPDATE users SET premium_until = ?, tier = ? WHERE id = ?'),
    insYm: db.prepare('INSERT INTO ym_payments (user_id, label, amount, created_at, tier) VALUES (?, ?, ?, ?, ?)'),
    ymById: db.prepare('SELECT * FROM ym_payments WHERE id = ?'),
    ymRecent: db.prepare("SELECT * FROM ym_payments WHERE user_id = ? AND status = 'pending' AND amount = ? AND tier = ? AND created_at > ? ORDER BY id DESC LIMIT 1"),
    ymPending: db.prepare("SELECT * FROM ym_payments WHERE status = 'pending' AND created_at > ? ORDER BY id LIMIT 30"),
    ymExpire: db.prepare("UPDATE ym_payments SET status = 'expired' WHERE status = 'pending' AND created_at <= ?"),
    ymDone: db.prepare("UPDATE ym_payments SET status = ?, operation_id = ?, received = ?, paid_at = ? WHERE id = ? AND status = 'pending'"),
    insStars: db.prepare('INSERT OR IGNORE INTO payments (user_id, stars, charge_id, created_at, tier) VALUES (?, ?, ?, ?, ?)'),
    lastStars: db.prepare('SELECT * FROM payments WHERE user_id = ? AND refunded_at IS NULL ORDER BY id DESC LIMIT 1'),
    lastStarsOfTier: db.prepare('SELECT * FROM payments WHERE user_id = ? AND tier = ? AND refunded_at IS NULL ORDER BY id DESC LIMIT 1'),
    refundStars: db.prepare('UPDATE payments SET refunded_at = ? WHERE id = ?'),
  };
  const fmtDate = (t) => new Date(t).toLocaleDateString('ru-RU');
  const who = (u) => esc(u.username ? '@' + u.username : `${u.first_name || 'без имени'} (id ${u.id})`);

  /**
   * Включить или продлить тариф. days — разовая оплата; expiresAt — конец оплаченного периода подписки Stars.
   * Переход ПРО → УЛЬТРА: остаток ПРО пересчитывается в дни УЛЬТРА по цене. Оплата ПРО при активной УЛЬТРА
   * (например, старая подписка продлилась) так же пересчитывается и продлевает УЛЬТРА.
   */
  function activate(userId, tier, { days = config.premiumDays, expiresAt = null } = {}) {
    const u = ctx.getUser(userId);
    const t = now();
    const cur = ctx.tier(u);
    const left = cur === 'free' ? 0 : Math.max(0, (u.premium_until || 0) - t);
    let until;
    let plan = tier;
    if (cur === 'free' || cur === tier) {
      until = expiresAt ? Math.max(u.premium_until || 0, expiresAt) : Math.max(t, u.premium_until || 0) + days * DAY;
    } else if (rank(tier) > rank(cur)) {
      until = (expiresAt ?? t + days * DAY) + (left * priceRub(cur, config)) / priceRub(tier, config);
    } else {
      plan = cur;
      until = u.premium_until + ((expiresAt ? Math.max(0, expiresAt - t) : days * DAY) * priceRub(tier, config)) / priceRub(cur, config);
    }
    q.setPlan.run(Math.round(until), plan, userId);
    return { until: Math.round(until), tier: plan, upgraded: plan !== cur && cur !== 'free' };
  }

  function features(tier) {
    const l = limitsOf(tier, config);
    const skinsEvery = tier === 'ultra' ? `каждые ${config.priceRefreshMin} мин` : every(l.alertIntervalMin);
    const lines = [
      `🔔 Скины: ${count(l.alerts)}, проверка ${skinsEvery}`,
      `🎮 Игры: ${count(l.wishlist)}, проверка скидок ${every(l.gamesIntervalMin || config.checkIntervalMin)}`,
    ];
    if (tier === 'free') lines.push('💰 Средняя цена скина на всех площадках');
    else {
      lines.push(
        '💧 Ликвидность, «покупают за» и рекомендуемая цена продажи',
        '📊 Оценка рынка и 📈 «Что купить»',
        '📄 Экспорт в таблицу (CSV для Excel)',
        `💼 Обновление инвентаря ${every(l.invTtlH * 60)}`,
      );
    }
    if (tier === 'ultra') {
      if (config.extraGames.length) lines.push(`${config.extraGames.map((a) => `${GAMES[a].icon} ${GAMES[a].title}`).join(' и ')}: скины этих игр — поиск, цены, уведомления`);
      lines.push(
        '💳 Где выгодно пополнить Steam: через скины и сервисы',
        '💰 Где выгоднее продать — сколько придёт на руки',
        '🟢 Сигналы «выгодно купить / пора продавать»',
        '📋 Ежедневный отчёт по инвентарю',
        '📈 График цены скина',
      );
      if (config.ultraChatId) lines.push('💬 Закрытый чат УЛЬТРА');
      lines.push('🚀 Ранний доступ к новым функциям');
    }
    return lines;
  }

  function view(u) {
    const cur = ctx.tier(u);
    const sub = config.starsSubscription;
    const block = (tier) => {
      const head = tier === 'free' ? `${TIER_ICON.free} <b>${TIER_TITLE.free}</b>` : `${TIER_ICON[tier]} <b>${TIER_TITLE[tier]}</b> — ${rub(priceRub(tier, config))} в месяц${priceStars(tier, config) ? ` (${priceStars(tier, config)} ⭐)` : ''}`;
      return [head + (tier === cur ? ' · <i>ваш тариф</i>' : ''), ...features(tier).map((f) => '  ' + f)].join('\n');
    };
    const text = [
      '⭐ <b>Тарифы SkinWatch</b>',
      '',
      block('free'),
      '',
      block('pro'),
      '',
      block('ultra'),
      '',
      cur === 'free'
        ? sub
          ? 'Оплата Stars — подписка с продлением каждый месяц, отменить можно в любой момент (Telegram → Настройки → Мои звёзды → Подписки). ЮMoney — разово на месяц.'
          : 'Оплата разовая, на месяц, без автосписаний.'
        : `✅ У вас <b>${TIER_TITLE[cur]}</b> до <b>${fmtDate(u.premium_until)}</b>.` +
          (cur === 'pro' ? ' При переходе на УЛЬТРА оставшиеся дни ПРО пересчитаются в дни УЛЬТРА по цене.' : ''),
    ].join('\n');
    const rows = [];
    for (const tier of PAID) {
      if (rank(tier) < rank(cur)) continue; // понижать тариф при активном нельзя — дождитесь окончания
      const title = `${TIER_ICON[tier]} ${TIER_TITLE[tier]}`;
      const row = [];
      if (priceStars(tier, config) > 0 && !(tier === cur && sub)) row.push({ text: `${title} — ${priceStars(tier, config)} ⭐`, callback_data: `buy:${tier}` });
      if (ym.enabled) row.push({ text: `${title} — ${rub(priceRub(tier, config))}`, callback_data: `ym:${tier}` });
      if (row.length) rows.push(row);
    }
    if (cur === 'ultra' && config.ultraChatId) rows.push([{ text: '💬 Чат УЛЬТРА', callback_data: 'uchat' }]);
    if (!rows.length && cur === 'free') rows.push([{ text: 'Оплата скоро появится', callback_data: 'noop' }]);
    rows.push([{ text: '« Меню', callback_data: 'menu' }]);
    return { text, extra: kb(rows) };
  }

  async function afterActivation(userId, { until, tier, upgraded }, renewal) {
    const lines = [
      renewal ? `${TIER_ICON[tier]} Подписка продлена: <b>${TIER_TITLE[tier]}</b> до <b>${fmtDate(until)}</b>. Спасибо!` : `${TIER_ICON[tier]} Спасибо! <b>${TIER_TITLE[tier]}</b> активен до <b>${fmtDate(until)}</b>.`,
    ];
    if (upgraded) lines.push('Оставшиеся дни прошлого тарифа пересчитаны и добавлены.');
    if (!renewal) lines.push('', 'Что теперь доступно:', ...features(tier));
    const rows = [];
    if (tier === 'ultra' && config.ultraChatId && !renewal) rows.push([{ text: '💬 Вступить в чат УЛЬТРА', callback_data: 'uchat' }]);
    rows.push([{ text: '« Меню', callback_data: 'menu' }]);
    await tg.send(userId, lines.join('\n'), kb(rows));
  }

  // ---------- ЮMoney ----------
  async function startYoomoney(chatId, u, tier) {
    if (!ym.enabled) return tg.send(chatId, 'Оплата через ЮMoney пока не настроена.');
    if (!PAID.includes(tier)) tier = 'pro';
    const amount = priceRub(tier, config);
    let p = q.ymRecent.get(u.id, amount, tier, now() - 3600_000);
    if (!p) {
      const label = `sw-${u.id}-${randomBytes(5).toString('hex')}`;
      const id = Number(q.insYm.run(u.id, label, amount, now(), tier).lastInsertRowid);
      p = q.ymById.get(id);
    }
    const comment = `SkinWatch ${TIER_TITLE[tier]} на ${config.premiumDays} дней`;
    return tg.send(
      chatId,
      `💳 <b>Оплата ${TIER_TITLE[tier]} — ${rub(p.amount)}</b>\n\n1. Нажмите «Оплатить картой» или «Кошелёк ЮMoney».\n2. После оплаты вернитесь сюда — тариф включится автоматически в течение пары минут. Можно нажать «Я оплатил», чтобы проверить сразу.\n\n<i>Не меняйте сумму на странице оплаты — иначе платёж не засчитается автоматически.</i>`,
      kb([
        [{ text: '💳 Оплатить картой', url: ym.payUrl({ amount: p.amount, label: p.label, comment, paymentType: 'AC' }) }],
        [{ text: '👛 Кошелёк ЮMoney', url: ym.payUrl({ amount: p.amount, label: p.label, comment, paymentType: 'PC' }) }],
        [{ text: '✅ Я оплатил', callback_data: `ymc:${p.id}` }],
      ]),
    );
  }

  /** Проверить один платёж. Возвращает 'paid' | 'underpaid' | 'pending' | 'error'. */
  async function checkOne(p) {
    let op;
    try {
      op = await ym.findPayment(p.label);
    } catch (e) {
      console.warn('[yoomoney]', e.message);
      return 'error';
    }
    if (!op) return 'pending';
    const received = Number(op.amount) || 0;
    // С карты ЮMoney удерживает ~3% с получателя, поэтому допускаем до 10% разницы.
    const ok = received >= p.amount * 0.9;
    if (!q.ymDone.run(ok ? 'paid' : 'underpaid', String(op.operation_id), received, now(), p.id).changes) return 'pending';
    const u = ctx.getUser(p.user_id);
    const tier = payloadTier(p.tier) || 'pro';
    if (ok) {
      const res = activate(p.user_id, tier);
      await afterActivation(p.user_id, res, false);
      await ctx.notifyAdmins(`💰 ЮMoney: ${who(u)} оплатил ${TIER_TITLE[tier]} — ${rub(p.amount)} (пришло ${rub(received)}). Источник: ${esc(u.source || '—')}\n🧾 Не забудьте пробить чек в «Мой налог».`);
      return 'paid';
    }
    await tg.send(p.user_id, `Платёж на ${rub(received)} получен, но это меньше стоимости тарифа. Напишите /paysupport — разберёмся.`);
    await ctx.notifyAdmins(`⚠️ ЮMoney: ${who(u)} заплатил ${rub(received)} вместо ${rub(p.amount)} (${TIER_TITLE[tier]}, метка ${esc(p.label)}). Тариф не выдан.`);
    return 'underpaid';
  }

  async function checkNow(chatId, u, paymentId) {
    const p = q.ymById.get(paymentId);
    if (!p || p.user_id !== u.id) return tg.send(chatId, 'Платёж не найден.');
    if (p.status === 'paid') return tg.send(chatId, `✅ Этот платёж уже засчитан. ${TIER_TITLE[ctx.tier(ctx.getUser(u.id))]} активен до ${fmtDate(ctx.getUser(u.id).premium_until)}.`);
    const r = await checkOne(p);
    if (r === 'pending') return tg.send(chatId, 'Платёж пока не найден. Обычно он появляется в течение 1–2 минут после оплаты — я проверю сам и напишу.');
    if (r === 'error') return tg.send(chatId, 'Не получилось проверить платёж, попробуйте через минуту. Если деньги списались — тариф всё равно включится автоматически.');
  }

  let polling = false;
  async function pollYoomoney() {
    if (!ym.enabled || polling) return 0;
    polling = true;
    try {
      q.ymExpire.run(now() - PENDING_TTL);
      let paid = 0;
      for (const p of q.ymPending.all(now() - PENDING_TTL)) {
        if ((await checkOne(p)) === 'paid') paid++;
        await new Promise((r) => setTimeout(r, 300));
      }
      return paid;
    } finally {
      polling = false;
    }
  }

  // ---------- Telegram Stars ----------
  async function sendStarsInvoice(chatId, u, tier) {
    if (!PAID.includes(tier)) tier = 'pro';
    const cur = ctx.tier(u);
    if (rank(tier) < rank(cur)) return tg.send(chatId, `У вас уже ${TIER_TITLE[cur]} — он включает всё из ${TIER_TITLE[tier]}.`);
    const stars = priceStars(tier, config);
    if (!(stars > 0)) return tg.send(chatId, 'Оплата звёздами для этого тарифа выключена.');
    const description = tier === 'ultra' ? 'Скины Rust и TF2, где выгодно пополнить Steam, сигналы, отчёт по инвентарю, график цены, всё без ограничений.' : 'Ликвидность и рекомендуемая цена, оценка рынка, «Что купить», экспорт в таблицу, частые уведомления.';
    if (config.starsSubscription) {
      // Подписка Stars: Telegram сам списывает звёзды каждые 30 дней, бот получает successful_payment.
      const link = await tg.call('createInvoiceLink', {
        title: `SkinWatch ${TIER_TITLE[tier]}`,
        description: `${description} Продление каждые 30 дней.`,
        payload: tier,
        currency: 'XTR',
        prices: [{ label: `${TIER_TITLE[tier]} на месяц`, amount: stars }],
        subscription_period: 2592000,
      });
      const note = cur === 'pro' && tier === 'ultra' ? '\nОставшиеся дни ПРО пересчитаются в УЛЬТРА, а подписка на ПРО отменится сама.' : '';
      return tg.send(chatId, `${TIER_ICON[tier]} Подписка <b>${TIER_TITLE[tier]}</b> — <b>${stars} ⭐ в месяц</b>.\nНажмите кнопку, чтобы оформить. Отменить можно в любой момент.${note}`, kb([[{ text: `⭐ Оформить за ${stars} ⭐`, url: link }]]));
    }
    return tg.call('sendInvoice', {
      chat_id: chatId,
      title: `${TIER_TITLE[tier]} на ${config.premiumDays} дней`,
      description,
      payload: tier,
      provider_token: '',
      currency: 'XTR',
      prices: [{ label: `${TIER_TITLE[tier]} ${config.premiumDays} дней`, amount: stars }],
    });
  }

  function checkStarsInvoice(pcq) {
    const tier = payloadTier(pcq.invoice_payload);
    if (pcq.currency !== 'XTR' || !tier) return 'Неизвестный счёт';
    if (pcq.total_amount !== priceStars(tier, config)) return 'Цена изменилась, откройте /premium снова';
    return null;
  }

  async function onStarsPaid(u, sp) {
    const tier = payloadTier(sp.invoice_payload) || 'pro';
    const inserted = q.insStars.run(u.id, sp.total_amount, sp.telegram_payment_charge_id, now(), tier).changes;
    if (!inserted) return; // повтор апдейта
    const before = ctx.tier(ctx.getUser(u.id));
    // Подписка: тариф до конца оплаченного периода (+1 час запаса на продление).
    const res = activate(u.id, tier, sp.subscription_expiration_date ? { expiresAt: sp.subscription_expiration_date * 1000 + 3600_000 } : {});
    // Перешёл с ПРО на УЛЬТРА звёздами — отменяем подписку на ПРО, чтобы не платить дважды.
    if (tier === 'ultra' && before === 'pro') {
      const old = q.lastStarsOfTier.get(u.id, 'pro');
      if (old) await tg.call('editUserStarSubscription', { user_id: u.id, telegram_payment_charge_id: old.charge_id, is_canceled: true }).catch(() => {});
    }
    const renewal = Boolean(sp.is_recurring && !sp.is_first_recurring);
    await afterActivation(u.id, res, renewal);
    await ctx.notifyAdmins(`💰 Stars: ${who(u)} ${renewal ? 'продлил' : 'оплатил'} ${TIER_TITLE[tier]} — ${sp.total_amount} ⭐. Источник: ${esc(u.source || '—')}`);
  }

  async function refundStars(chatId, userId) {
    const p = q.lastStars.get(userId);
    if (!p) return tg.send(chatId, 'У этого пользователя нет оплат звёздами для возврата. Возврат по ЮMoney делается вручную из кошелька.');
    try {
      await tg.call('refundStarPayment', { user_id: userId, telegram_payment_charge_id: p.charge_id });
      // Если это подписка — отменяем автопродление (для разовой оплаты Telegram вернёт ошибку, это не страшно).
      await tg.call('editUserStarSubscription', { user_id: userId, telegram_payment_charge_id: p.charge_id, is_canceled: true }).catch(() => {});
    } catch (e) {
      return tg.send(chatId, `Не удалось вернуть: ${esc(e.message)}`);
    }
    q.refundStars.run(now(), p.id);
    const u = ctx.getUser(userId);
    q.setPlan.run(Math.max(0, (u.premium_until || 0) - config.premiumDays * DAY), u.tier, userId);
    await tg.send(userId, `Вернули ${p.stars} ⭐.`);
    return tg.send(chatId, `✅ Возвращено ${p.stars} ⭐ пользователю ${userId}, тариф сокращён на ${config.premiumDays} дней.`);
  }

  return {
    view,
    features,
    startYoomoney,
    checkNow,
    pollYoomoney,
    sendStarsInvoice,
    checkStarsInvoice,
    onStarsPaid,
    refundStars,
    grant: (userId, days, tier = 'pro') => activate(userId, tier, { days }),
    stats: () => {
      const t = now();
      const n = (sql, ...a) => db.prepare(sql).get(...a).n;
      return {
        pro: n("SELECT COUNT(*) n FROM users WHERE premium_until > ? AND COALESCE(tier, 'pro') = 'pro'", t),
        ultra: n("SELECT COUNT(*) n FROM users WHERE premium_until > ? AND tier = 'ultra'", t),
        ym: db.prepare("SELECT COUNT(*) n, COALESCE(SUM(received), 0) s FROM ym_payments WHERE status = 'paid'").get(),
        stars: db.prepare('SELECT COUNT(*) n, COALESCE(SUM(stars), 0) s FROM payments WHERE refunded_at IS NULL').get(),
      };
    },
  };
}
