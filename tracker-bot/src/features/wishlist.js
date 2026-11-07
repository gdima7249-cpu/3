// Вишлист игр Steam: регион магазина, поиск с исправлением опечаток, рейтинг,
// «стоит ли брать сейчас», уведомления о скидках.
import { esc } from '../telegram.js';
import { formatPrice, queryVariants } from '../steam.js';
import { ratingLine, gameVerdict } from '../analysis.js';
import { rub } from './skins.js';
import { tierOf, TIER_TITLE } from '../tiers.js';

const PAGE = 8;
const INFO_TTL = 7 * 86400_000; // рейтинг и историю цен обновляем раз в неделю
const storeUrl = (appid) => `https://store.steampowered.com/app/${appid}/`;

export const REGIONS = { ru: 'Россия', kz: 'Казахстан', ua: 'Украина', by: 'Беларусь', tr: 'Турция', ar: 'Аргентина', us: 'США', pl: 'Польша', de: 'Германия' };

export const WISHLIST_HOWTO =
  '<b>Как добавить игру</b>\n\n' +
  '• Напишите название: <code>Hades</code> или даже <code>гта 5</code>\n' +
  '• Или пришлите ссылку из магазина: <code>store.steampowered.com/app/1145360</code>\n' +
  '• Или импортируйте весь вишлист — пришлите ссылку на профиль Steam и выберите «Импорт вишлиста».\n\n' +
  'Для импорта вишлист должен быть открыт: Steam → Профиль → Редактировать → Приватность → «Сведения об играх: Открытые».';

export function createWishlist(ctx) {
  const { tg, db, steam, config, rates, kb, now } = ctx;
  const q = {
    game: db.prepare('SELECT * FROM games WHERE appid = ?'),
    ensureGame: db.prepare('INSERT OR IGNORE INTO games (appid) VALUES (?)'),
    setName: db.prepare('UPDATE games SET name = ?, is_free = ? WHERE appid = ?'),
    setMeta: db.prepare('UPDATE games SET metacritic = COALESCE(?, metacritic) WHERE appid = ?'),
    setInfo: db.prepare(`UPDATE games SET rating_pct = ?, rating_desc = ?, rating_total = ?, hist_low_usd = ?, hist_retail_usd = ?, hist_max_discount = ?, hist_src = ?, info_at = ? WHERE appid = ?`),
    setPast: db.prepare('UPDATE games SET past_max_discount = MAX(COALESCE(past_max_discount, 0), ?) WHERE appid = ?'),
    seenDiscount: db.prepare('UPDATE games SET max_discount_seen = MAX(COALESCE(max_discount_seen, 0), ?) WHERE appid = ?'),
    price: db.prepare('SELECT * FROM game_prices WHERE appid = ? AND cc = ?'),
    setPrice: db.prepare(`INSERT INTO game_prices (appid, cc, available, is_free, currency, initial, final, discount, checked_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(appid, cc) DO UPDATE SET available = excluded.available, is_free = excluded.is_free, currency = excluded.currency,
        initial = excluded.initial, final = excluded.final, discount = excluded.discount, checked_at = excluded.checked_at`),
    count: db.prepare('SELECT COUNT(*) AS n FROM wishlist WHERE user_id = ?'),
    has: db.prepare('SELECT 1 FROM wishlist WHERE user_id = ? AND appid = ?'),
    add: db.prepare('INSERT OR IGNORE INTO wishlist (user_id, appid, added_at, notified_final) VALUES (?, ?, ?, ?)'),
    del: db.prepare('DELETE FROM wishlist WHERE user_id = ? AND appid = ?'),
    page: db.prepare(`SELECT w.appid, g.name, g.rating_pct, g.rating_desc, g.rating_total, g.metacritic, g.hist_max_discount, g.max_discount_seen, g.past_max_discount, g.hist_src,
        p.available, p.currency, p.initial, p.final, p.discount, p.is_free AS free, p.checked_at AS pchk
      FROM wishlist w LEFT JOIN games g ON g.appid = w.appid LEFT JOIN game_prices p ON p.appid = w.appid AND p.cc = ?
      WHERE w.user_id = ? ORDER BY COALESCE(p.discount, 0) DESC, w.added_at DESC LIMIT ? OFFSET ?`),
    pairs: db.prepare(`SELECT DISTINCT w.appid, COALESCE(u.cc, ?) AS cc FROM wishlist w JOIN users u ON u.id = w.user_id`),
    watchers: db.prepare(`SELECT w.user_id, w.notified_final, u.min_discount, u.premium_until, u.tier FROM wishlist w JOIN users u ON u.id = w.user_id
      WHERE w.appid = ? AND COALESCE(u.cc, ?) = ? AND u.blocked = 0`),
    setNotified: db.prepare('UPDATE wishlist SET notified_final = ? WHERE user_id = ? AND appid = ?'),
    resetNotified: db.prepare(`UPDATE wishlist SET notified_final = NULL WHERE appid = ? AND user_id IN (SELECT id FROM users WHERE COALESCE(cc, ?) = ?)`),
    missingPrices: db.prepare(`SELECT w.appid FROM wishlist w LEFT JOIN game_prices p ON p.appid = w.appid AND p.cc = ?
      WHERE w.user_id = ? AND p.appid IS NULL LIMIT 200`),
    unnamed: db.prepare('SELECT g.appid FROM games g WHERE g.name IS NULL AND EXISTS (SELECT 1 FROM wishlist w WHERE w.appid = g.appid) LIMIT ?'),
    staleInfo: db.prepare('SELECT g.appid FROM games g WHERE (g.info_at IS NULL OR g.info_at < ?) AND EXISTS (SELECT 1 FROM wishlist w WHERE w.appid = g.appid) LIMIT ?'),
  };
  const importing = new Set();
  const lastSearch = new Map(); // userId → результаты поиска для кнопки «Нет»
  const ccOf = (u) => u.cc || config.steamCc;
  const limitFor = (u) => ctx.limits(u).wishlist;
  const paid = !config.freeForAll;
  let lastFreeAt = 0; // когда последний раз присылали скидки бесплатному тарифу

  /** «7 000 ₸ (≈1 500 ₽)» — для не-рублёвых валют добавляем примерную цену в рублях. */
  function money(amount, currency) {
    const s = formatPrice(amount, currency);
    if (!currency || currency === 'RUB' || amount == null) return s;
    const r = rates.toRub(amount / 100, currency);
    return r ? `${s} (≈${rub(Math.round(r))})` : s;
  }

  function priceLine(p, cc) {
    if (!p) return 'нет цены';
    if (!p.available) return `❌ недоступна в регионе ${cc.toUpperCase()}`;
    if (p.final == null) return p.is_free ? 'бесплатно' : 'цены пока нет (скорее всего, игра ещё не вышла)';
    return p.discount > 0 ? `<b>${money(p.final, p.currency)}</b> <s>${formatPrice(p.initial, p.currency)}</s> −${p.discount}%` : money(p.final, p.currency);
  }

  function savePrice(appid, cc, d) {
    const p = d.price;
    // Распродажа закончилась или скидка сменилась — запоминаем её как «прошлую». Текущая скидка в историю не идёт,
    // иначе бот сравнивал бы скидку саму с собой.
    const prev = q.price.get(appid, cc);
    if (prev?.discount > 0 && (p?.discount ?? 0) !== prev.discount) q.setPast.run(prev.discount, appid);
    q.setPrice.run(appid, cc, d.available ? 1 : 0, d.isFree ? 1 : 0, p?.currency ?? null, p?.initial ?? null, p?.final ?? null, p?.discount ?? 0, now());
    if (p?.discount > 0) q.seenDiscount.run(p.discount, appid);
  }

  /** Рейтинг Steam и история цен CheapShark — раз в неделю на игру. */
  async function ensureInfo(appid, force = false) {
    const g = q.game.get(appid);
    // Появился ключ IsThereAnyDeal, а история ещё из CheapShark или пустая — обновляем, не дожидаясь недели.
    const wantItad = config.itadKey && !String(g?.hist_src || '').startsWith('itad') && (!g?.info_at || now() - g.info_at > 30 * 60_000);
    if (!force && !wantItad && g?.info_at && now() - g.info_at < INFO_TTL) return g;
    let failed = false;
    const [rv, hist] = await Promise.all([
      steam.reviews(appid).catch(() => ((failed = true), null)),
      steam.priceHistory(appid, { itadKey: config.itadKey, itadCountry: config.itadCountry }).catch((e) => {
        console.warn('[история цен]', appid, e.message);
        failed = true;
        return undefined;
      }),
    ]);
    const h = hist === undefined ? { low: g?.hist_low_usd, regular: g?.hist_retail_usd, maxDiscount: g?.hist_max_discount, src: g?.hist_src } : hist;
    // При сетевой ошибке пробуем снова через 6 часов, а не через неделю.
    const at = failed ? now() - INFO_TTL + 6 * 3600_000 : now();
    q.setInfo.run(rv?.pct ?? g?.rating_pct ?? null, rv?.desc ?? g?.rating_desc ?? null, rv?.total ?? g?.rating_total ?? null, h?.low ?? null, h?.regular ?? null, h?.maxDiscount ?? null, h?.src ?? null, at, appid);
    return q.game.get(appid);
  }

  function gameCard(g, p, cc) {
    const lines = [`🎮 <b>${esc(g.name || `App ${g.appid}`)}</b>`, `Цена (${cc.toUpperCase()}): ${priceLine(p, cc)}`];
    const r = ratingLine(g);
    if (r) lines.push(r);
    const v = gameVerdict(g, p);
    if (v) lines.push(`${v.icon} ${v.text}`);
    if (g.hist_low_usd != null && g.hist_retail_usd) {
      const src = { itad: 'IsThereAnyDeal, Steam', 'itad-all': 'IsThereAnyDeal, все магазины' }[g.hist_src] || 'CheapShark, все магазины';
      lines.push(`<i>Исторический минимум: $${g.hist_low_usd} при полной цене $${g.hist_retail_usd}, −${g.hist_max_discount}% (${src})</i>`);
    }
    return lines.join('\n');
  }

  const limitReached = (chatId, u) =>
    tg.send(chatId, `В вишлисте уже ${limitFor(u)} игр — это лимит тарифа ${TIER_TITLE[ctx.tier(u)]}.`, ctx.tier(u) === 'ultra' || !paid ? {} : kb([[{ text: '⭐ Тарифы', callback_data: 'premium' }]]));

  /** Название игры: сначала в регионе пользователя, потом в других (игра может быть недоступна в регионе). */
  async function fetchName(appid, cc) {
    for (const c of [...new Set([cc, 'us', 'ru'])]) {
      const d = await steam.details(appid, c).catch(() => null);
      if (d?.name) {
        q.setName.run(d.name, d.isFree ? 1 : 0, appid);
        q.setMeta.run(d.metacritic ?? null, appid);
        return d.name;
      }
    }
    return null;
  }

  /** Догрузить то, чего не хватает для показа: цены в регионе пользователя и названия на странице. */
  async function syncUser(u, pageAppids = []) {
    const cc = ccOf(u);
    const missing = q.missingPrices.all(cc, u.id).map((r) => r.appid);
    if (missing.length) {
      for (const [id, r] of await steam.prices(missing, cc)) savePrice(id, cc, { available: r.available, price: r.price, isFree: false });
    }
    let named = 0;
    for (const id of pageAppids) {
      if (named >= 8) break;
      if (q.game.get(id)?.name) continue;
      await fetchName(id, cc);
      named++;
    }
  }

  async function show(chatId, u, page, messageId) {
    const cc = ccOf(u);
    const total = q.count.get(u.id).n;
    const back = [{ text: '➕ Добавить игру', callback_data: 'gadd' }, { text: '« Меню', callback_data: 'menu' }];
    if (u.steamid) back.unshift({ text: '📥 Импорт из Steam', callback_data: `pw:${u.steamid}` });
    if (!total) {
      const text = '🎮 <b>Вишлист игр</b> пуст.\n\n' + WISHLIST_HOWTO;
      return messageId ? tg.edit(chatId, messageId, text, kb([back])) : tg.send(chatId, text, kb([back]));
    }
    const pages = Math.ceil(total / PAGE);
    page = Math.min(Math.max(0, page), pages - 1);
    let rows = q.page.all(cc, u.id, PAGE, page * PAGE);
    if (rows.some((r) => r.pchk == null || !r.name)) {
      // Например, после смены региона цен ещё нет — загружаем сразу, а не ждём плановую проверку.
      await syncUser(u, rows.map((r) => r.appid)).catch((e) => console.warn('[wishlist sync]', e.message));
      rows = q.page.all(cc, u.id, PAGE, page * PAGE);
    }
    const lines = rows.map((g, i) => {
      const p = g.pchk != null ? { available: g.available ?? 1, is_free: g.free, currency: g.currency, initial: g.initial, final: g.final, discount: g.discount } : null;
      const v = gameVerdict(g, p);
      return `${page * PAGE + i + 1}. <a href="${storeUrl(g.appid)}">${esc(g.name || `App ${g.appid}`)}</a> — ${priceLine(p, cc)}${g.rating_pct != null ? ` · 👍${g.rating_pct}%` : ''}${v ? ` ${v.icon}` : ''}`;
    });
    const text = `🎮 <b>Вишлист игр</b> · ${total}${limitFor(u) === Infinity ? '' : ` из ${limitFor(u)}`} · регион ${REGIONS[cc] || cc.toUpperCase()}\nУведомляю о скидках от ${u.min_discount}%.\n🟢 — хорошая цена, 🟡 — лучше подождать, 🔴 — без скидки.\n\n${lines.join('\n')}`;
    const buttons = rows.map((g, i) => [
      { text: `📊 ${page * PAGE + i + 1}. ${(g.name || `App ${g.appid}`).slice(0, 30)}`, callback_data: `gi:${g.appid}` },
      { text: '❌', callback_data: `gdel:${g.appid}:${page}` },
    ]);
    const nav = [];
    if (page > 0) nav.push({ text: '◀', callback_data: `wl:${page - 1}` });
    if (pages > 1) nav.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' });
    if (page < pages - 1) nav.push({ text: '▶', callback_data: `wl:${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: `📄 Таблица (CSV)${paid && ctx.tier(u) === 'free' ? ' ⭐' : ''}`, callback_data: 'exp:wl' }]);
    buttons.push(back);
    return messageId ? tg.edit(chatId, messageId, text, kb(buttons)) : tg.send(chatId, text, kb(buttons));
  }

  async function info(chatId, u, appid) {
    const cc = ccOf(u);
    const d = await steam.details(appid, cc).catch(() => null);
    if (d) {
      q.ensureGame.run(appid);
      if (d.name) q.setName.run(d.name ?? null, d.isFree ? 1 : 0, appid);
      q.setMeta.run(d.metacritic ?? null, appid);
      savePrice(appid, cc, d);
    }
    const g = await ensureInfo(appid);
    const p = q.price.get(appid, cc);
    const btns = [[{ text: 'Открыть в Steam', url: storeUrl(appid) }]];
    if (!q.has.get(u.id, appid)) btns.push([{ text: '➕ В вишлист', callback_data: `gadd:${appid}` }]);
    return tg.send(chatId, gameCard(g, p, cc), kb(btns));
  }

  async function add(chatId, u, appid) {
    const cc = ccOf(u);
    if (q.has.get(u.id, appid)) return info(chatId, u, appid);
    if (q.count.get(u.id).n >= limitFor(u)) return limitReached(chatId, u);
    let d;
    try {
      d = await steam.details(appid, cc);
    } catch (e) {
      return tg.send(chatId, `Steam не отвечает, попробуйте через минуту. (${esc(e.message)})`);
    }
    if (!d.available && !d.name) {
      // В регионе пользователя игры нет — название берём из основного региона.
      const base = await steam.details(appid, 'us').catch(() => null);
      if (!base?.available) return tg.send(chatId, 'Не нашёл такую игру в магазине Steam.');
      d.name = base.name;
    }
    q.ensureGame.run(appid);
    q.setName.run(d.name ?? null, d.isFree ? 1 : 0, appid);
    q.setMeta.run(d.metacritic ?? null, appid);
    savePrice(appid, cc, d);
    const onSale = d.price?.discount > 0;
    q.add.run(u.id, appid, now(), onSale ? d.price.final : null);
    const g = await ensureInfo(appid);
    const p = q.price.get(appid, cc);
    let text = `✅ Добавил в вишлист.\n\n${gameCard(g, p, cc)}`;
    if (!d.available) text += `\n\nИгра недоступна в регионе ${REGIONS[cc] || cc.toUpperCase()} — напишу, если появится. Регион можно сменить в ⚙️ Настройках.`;
    else if (d.isFree) text += '\n\nИгра бесплатная — скидок не будет.';
    else if (!onSale) text += '\n\nНапишу, когда появится скидка.';
    return tg.send(chatId, text, kb([[{ text: 'Открыть в Steam', url: storeUrl(appid) }], [{ text: '🎮 Вишлист игр', callback_data: 'wl:0' }]]));
  }

  function resultsKeyboard(found) {
    return kb(found.map((g) => [{ text: `➕ ${g.name.slice(0, 45)}${g.price ? ' · ' + formatPrice(g.price.final, g.price.currency) : ''}`, callback_data: `gadd:${g.appid}` }]));
  }

  async function search(chatId, u, term) {
    if (term.length < 2) return tg.send(chatId, 'Напишите название игры чуть подробнее.');
    const cc = ccOf(u);
    try {
      const direct = await steam.search(term, cc);
      const cyr = /[а-яё]/i.test(term);
      if (direct.length && !cyr) return tg.send(chatId, '🎮 Какую игру добавить в вишлист?', resultsKeyboard(direct));
      // Пробуем исправить запрос: «гта 5» → «grand theft auto V».
      for (const v of queryVariants(term).slice(0, 4)) {
        const found = await steam.search(v, cc);
        if (!found.length) continue;
        const all = [...found, ...direct.filter((d) => !found.some((f) => f.appid === d.appid))].slice(0, 6);
        lastSearch.set(u.id, all);
        return tg.send(chatId, `🤔 Возможно, вы имели в виду <b>${esc(found[0].name)}</b>?`, kb([[{ text: '✅ Да', callback_data: `gadd:${found[0].appid}` }, { text: '❌ Нет', callback_data: 'gno' }]]));
      }
      if (direct.length) return tg.send(chatId, '🎮 Какую игру добавить в вишлист?', resultsKeyboard(direct));
    } catch (e) {
      return tg.send(chatId, `Steam не отвечает, попробуйте через минуту. (${esc(e.message)})`);
    }
    return tg.send(chatId, `Ничего не нашёл по «${esc(term)}» ни среди скинов, ни среди игр. Попробуйте написать по-английски.`);
  }

  async function otherResults(chatId, u) {
    const list = (lastSearch.get(u.id) || []).slice(1);
    if (!list.length) return tg.send(chatId, 'Других вариантов нет. Попробуйте написать название по-английски или пришлите ссылку на игру в Steam.');
    return tg.send(chatId, 'Может быть, одна из этих?', resultsKeyboard(list));
  }

  async function importWishlist(chatId, u, steamid) {
    if (importing.has(u.id)) return tg.send(chatId, 'Импорт уже идёт, подождите немного.');
    const cc = ccOf(u);
    let appids;
    try {
      appids = await steam.wishlist(steamid);
    } catch (e) {
      return tg.send(chatId, `Steam не отдал вишлист (${esc(e.message)}). Попробуйте позже.`);
    }
    if (!appids.length) {
      return tg.send(chatId, 'Вишлист пуст или скрыт.\nОткройте его: Steam → Профиль → Редактировать → Приватность → «Сведения об играх: Открытые», и пришлите ссылку снова.');
    }
    const free = limitFor(u) - q.count.get(u.id).n;
    const fresh = appids.filter((id) => !q.has.get(u.id, id));
    const take = fresh.slice(0, Math.max(0, free));
    if (!take.length) {
      if (fresh.length) return limitReached(chatId, u);
      return tg.send(chatId, 'Все игры из этого вишлиста уже у меня 👌');
    }
    importing.add(u.id);
    const minutes = Math.max(1, Math.ceil((take.length * steam.minGapMs) / 60000));
    await tg.send(chatId, `Нашёл ${appids.length} игр, добавляю ${take.length}${fresh.length > take.length ? ` (лимит ${limitFor(u)})` : ''}. Это займёт ~${minutes} мин — пришлю итог.`);

    ctx.runBg(
      (async () => {
        try {
          const t = now();
          for (const id of take) {
            q.ensureGame.run(id);
            q.add.run(u.id, id, t, null);
          }
          for (const [id, r] of await steam.prices(take, cc)) savePrice(id, cc, { available: r.available, price: r.price, isFree: false });
          for (const id of take) {
            if (q.game.get(id)?.name) continue;
            await fetchName(id, cc);
          }
          const sale = take.map((id) => ({ g: q.game.get(id), p: q.price.get(id, cc) })).filter((x) => x.p?.discount > 0);
          for (const { p } of sale) q.setNotified.run(p.final, u.id, p.appid);
          let text = `✅ Импорт готов: ${take.length} игр в вишлисте.`;
          if (sale.length) {
            text +=
              `\n\n🔥 <b>Уже со скидкой (${sale.length}):</b>\n` +
              sale
                .sort((a, b) => b.p.discount - a.p.discount)
                .slice(0, 15)
                .map(({ g, p }) => `• <a href="${storeUrl(p.appid)}">${esc(g?.name || `App ${p.appid}`)}</a> — ${priceLine(p, cc)}`)
                .join('\n');
          } else text += '\nСейчас скидок нет — напишу, как только появятся.';
          await tg.send(chatId, text, kb([[{ text: '🎮 Вишлист игр', callback_data: 'wl:0' }]]));
        } finally {
          importing.delete(u.id);
        }
      })(),
    );
  }

  let checking = false;
  async function check() {
    if (checking) return { skipped: true };
    checking = true;
    let sent = 0;
    // Бесплатному тарифу скидки приходят не чаще раза в FREE_GAMES_INTERVAL_MIN, платным — каждую проверку.
    const freeDue = now() - lastFreeAt >= config.freeGamesIntervalMin * 60_000 - 5000;
    if (freeDue) lastFreeAt = now();
    try {
      await rates.refresh();
      const pairs = q.pairs.all(config.steamCc);
      const byCc = new Map();
      for (const { appid, cc } of pairs) (byCc.get(cc) || byCc.set(cc, []).get(cc)).push(appid);
      for (const [cc, appids] of byCc) {
        const prices = await steam.prices(appids, cc);
        for (const [appid, r] of prices) {
          const prev = q.price.get(appid, cc);
          savePrice(appid, cc, { available: r.available, price: r.price, isFree: r.available && !r.price && prev?.is_free });
          const g = q.game.get(appid);
          const p = q.price.get(appid, cc);
          // Игра появилась в регионе.
          if (prev && !prev.available && r.available) {
            for (const w of q.watchers.all(appid, config.steamCc, cc)) {
              await tg.send(w.user_id, `🎉 <b>${esc(g?.name || `App ${appid}`)}</b> теперь доступна в вашем регионе: ${priceLine(p, cc)}`, kb([[{ text: 'Открыть в Steam', url: storeUrl(appid) }]]));
            }
          }
          if (!r.price || !(r.price.discount > 0)) {
            q.resetNotified.run(appid, config.steamCc, cc);
            continue;
          }
          const info = await ensureInfo(appid).catch(() => g);
          const v = gameVerdict(info, p);
          for (const w of q.watchers.all(appid, config.steamCc, cc)) {
            if (r.price.discount < w.min_discount) continue;
            if (!freeDue && tierOf(w, config, now()) === 'free') continue;
            if (w.notified_final != null && r.price.final >= w.notified_final) continue;
            const text = [`🔥 <b>${esc(info?.name || `App ${appid}`)}</b> — скидка −${r.price.discount}%`, priceLine(p, cc), ratingLine(info), v ? `${v.icon} ${v.text}` : ''].filter(Boolean).join('\n');
            const res = await tg.send(w.user_id, text, kb([[{ text: 'Открыть в Steam', url: storeUrl(appid) }], [{ text: '❌ Убрать из вишлиста', callback_data: `gdel:${appid}:n` }]]));
            if (res === false) ctx.markBlocked(w.user_id);
            else if (res) {
              q.setNotified.run(r.price.final, w.user_id, appid);
              sent++;
            }
            await new Promise((res2) => setTimeout(res2, 40));
          }
        }
      }
      for (const { appid } of q.unnamed.all(10)) {
        await fetchName(appid, config.steamCc);
      }
      for (const { appid } of q.staleInfo.all(now() - INFO_TTL, 20)) await ensureInfo(appid, true).catch(() => null);
      return { pairs: pairs.length, sent };
    } finally {
      checking = false;
    }
  }

  return {
    show,
    info,
    add,
    search,
    otherResults,
    importWishlist,
    check,
    remove: (u, appid) => q.del.run(u.id, appid),
    rows: (u) => q.page.all(ccOf(u), u.id, 100000, 0).map((r) => ({ ...r, cc: ccOf(u), url: storeUrl(r.appid) })),
    stats: () => db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) u, COUNT(DISTINCT appid) g FROM wishlist').get(),
  };
}
