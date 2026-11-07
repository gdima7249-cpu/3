// Скины CS2: карточка с ценами площадок, оценка рынка, уведомления, инвентарь, лоты.
import { esc } from '../telegram.js';
import { SOURCES, BEST, STEAM_FEE, sourceTitle, CS2, gameOf } from '../markets.js';
import { priceOn, bestSource } from '../catalog.js';
import { analyzeSkin, autoThreshold, investPicks, BUDGETS, skinInsight, insightLines, sellLines } from '../analysis.js';
import { tierOf, limitsOf, TIER_TITLE } from '../tiers.js';

export const rub = (n) =>
  n == null ? '—' : `${Number(n).toLocaleString('ru-RU', { maximumFractionDigits: n >= 100 ? 0 : 2 })} ₽`;
const pct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toLocaleString('ru-RU', { maximumFractionDigits: 1 })}%`;
const PAGE = 8;
const DAY = 86400_000;

export function createSkins(ctx) {
  const { tg, db, config, markets, catalog, kb, now } = ctx;
  const bulk = catalog.bulkSources;
  const q = {
    alertsCount: db.prepare('SELECT COUNT(*) n FROM alerts WHERE user_id = ?'),
    insAlert: db.prepare('INSERT INTO alerts (user_id, skin_id, market, type, value, base_price, triggered, checked_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'),
    delAlert: db.prepare('DELETE FROM alerts WHERE id = ? AND user_id = ?'),
    alertsPage: db.prepare('SELECT a.*, s.name FROM alerts a JOIN skins s ON s.id = a.skin_id WHERE a.user_id = ? ORDER BY a.id DESC LIMIT ? OFFSET ?'),
    allAlerts: db.prepare('SELECT a.*, u.premium_until, u.tier FROM alerts a JOIN users u ON u.id = a.user_id WHERE u.blocked = 0'),
    steamWatched: db.prepare(`SELECT DISTINCT a.skin_id AS id FROM alerts a LEFT JOIN skin_prices p ON p.skin_id = a.skin_id AND p.src = 't'
      WHERE a.market = 't' AND (p.updated_at IS NULL OR p.updated_at < ?) LIMIT ?`),
    updAlertPct: db.prepare('UPDATE alerts SET base_price = ?, checked_at = ? WHERE id = ?'),
    updAlertTrig: db.prepare('UPDATE alerts SET triggered = ?, checked_at = ? WHERE id = ?'),
    setSteamid: db.prepare('UPDATE users SET steamid = ?, inv_at = NULL, inv_total = NULL WHERE id = ?'),
    setInv: db.prepare('UPDATE users SET inv_at = ?, inv_total = ? WHERE id = ?'),
    clearInv: db.prepare('DELETE FROM inv_items WHERE user_id = ?'),
    insInv: db.prepare('INSERT INTO inv_items (user_id, name, count) VALUES (?, ?, ?)'),
    invItems: db.prepare(`SELECT i.name, i.count, s.id FROM inv_items i LEFT JOIN skins s ON s.name = i.name AND s.app = ${CS2} WHERE i.user_id = ?`),
    invUsers: db.prepare('SELECT DISTINCT user_id FROM inv_items'),
    lastSnap: db.prepare('SELECT * FROM inv_snapshots WHERE user_id = ? ORDER BY taken_at DESC LIMIT 1'),
    daySnap: db.prepare('SELECT * FROM inv_snapshots WHERE user_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1'),
    firstSnap: db.prepare('SELECT * FROM inv_snapshots WHERE user_id = ? ORDER BY taken_at LIMIT 1'),
    insSnap: db.prepare('INSERT INTO inv_snapshots (user_id, taken_at, value) VALUES (?, ?, ?)'),
    clearSnaps: db.prepare('DELETE FROM inv_snapshots WHERE user_id = ?'),
    invBases: db.prepare('SELECT name, base_price FROM inv_items WHERE user_id = ?'),
    insInvBase: db.prepare('INSERT INTO inv_items (user_id, name, count, base_price) VALUES (?, ?, ?, ?)'),
    setBase: db.prepare('UPDATE inv_items SET base_price = ? WHERE user_id = ? AND name = ?'),
    invWatchers: db.prepare('SELECT * FROM users WHERE inv_alerts = 1 AND blocked = 0 AND EXISTS (SELECT 1 FROM inv_items i WHERE i.user_id = users.id)'),
    invRows: db.prepare(`SELECT i.name, i.count, i.base_price, s.id FROM inv_items i JOIN skins s ON s.name = i.name AND s.app = ${CS2} WHERE i.user_id = ?`),
    setInvAlertAt: db.prepare('UPDATE users SET inv_alert_at = ? WHERE id = ?'),
    listed: db.prepare('SELECT count FROM listings WHERE user_id = ? AND skin_id = ?'),
    listAdd: db.prepare('INSERT INTO listings (user_id, skin_id, count) VALUES (?, ?, 1) ON CONFLICT(user_id, skin_id) DO UPDATE SET count = count + 1'),
    listDec: db.prepare('UPDATE listings SET count = count - 1 WHERE user_id = ? AND skin_id = ?'),
    listClean: db.prepare('DELETE FROM listings WHERE count <= 0'),
    listAll: db.prepare('SELECT skin_id, count FROM listings WHERE user_id = ?'),
  };
  const alertLimit = (u) => ctx.limits(u).alerts;
  const invTtlH = (u) => ctx.limits(u).invTtlH;
  const paid = !config.freeForAll;
  const hours = (h) => (h < 1 ? `${Math.round(h * 60)} мин` : `${h} ч`);
  // Площадки предмета: у CS2 — все оптовые; у Rust и TF2 — Skinport и своя выгрузка (если задана).
  const sourcesFor = (s) => (!s || s.app === CS2 ? bulk : ['s', ...(markets.extraExports?.[s.app]?.url ? ['x'] : [])]);
  const best = (s) => priceOn(s, BEST, sourcesFor(s));
  const isUltra = (u) => ctx.tier(u) === 'ultra';
  const otherGame = (s) => s && s.app !== CS2;
  const urlOn = (k, s) => (SOURCES[k]?.url ? SOURCES[k].url(s.name, s.app) : SOURCES.t.url(s.name, s.app));
  let lastRefresh = null;
  let lastStatsAt = 0;
  let lastHistAt = 0;
  let lastGamesAt = 0;
  let lastGameStatsAt = 0;

  // ---------- Steam: поштучно и с кэшем ----------
  async function ensureSteam(skin, { wait = true } = {}) {
    const t = skin.prices.t;
    if (t && now() - t.updated_at < config.steamTtlMin * 60_000) return skin;
    if (!wait && markets.steamQueue.length > 2) return skin;
    try {
      catalog.setSteam(skin.id, await markets.steamPrice(skin.name, skin.app));
    } catch (e) {
      console.warn('[steam price]', skin.name, e.message);
      return skin;
    }
    return catalog.get(skin.id);
  }

  // ---------- поиск и карточка ----------
  // Скины Rust и TF2 ищем только для УЛЬТРА; searchOther — чтобы подсказать остальным, что такие есть.
  const searchSkins = (query, u) => catalog.search(query, 8, u && isUltra(u) ? [CS2, ...config.extraGames] : [CS2]);
  const searchOther = (query) => catalog.search(query, 3, config.extraGames);

  async function sendResults(chatId, found) {
    if (found.length === 1) return card(chatId, found[0].id);
    const rows = found.map((s) => [{ text: `${otherGame(s) ? gameOf(s.app).icon + ' ' : ''}${s.name.slice(0, 46)} · ${rub(best(s))}`, callback_data: `sk:${s.id}` }]);
    return tg.send(chatId, '🔍 Выберите предмет:', kb(rows));
  }

  async function card(chatId, skinId, messageId) {
    let s = catalog.get(skinId);
    if (!s) return tg.send(chatId, 'Предмет не найден.');
    const u = ctx.getUser(chatId); // в личке chatId = id пользователя
    if (otherGame(s) && !isUltra(u)) return ctx.upsellUltra(chatId, 'games');
    s = await ensureSteam(s, { wait: false });
    const src = sourcesFor(s);
    const lines = [`${gameOf(s.app).icon} <b>${esc(s.name)}</b>${otherGame(s) ? ` · ${gameOf(s.app).title}` : ''}`, ''];
    const bs = bestSource(s, src);
    for (const k of src) {
      const p = s.prices[k];
      const mark = bs?.src === k ? ' 👈 дешевле всего' : '';
      lines.push(`${SOURCES[k].title} — ${p?.price ? `<b>${rub(p.price)}</b>${p.volume ? ` · ${p.volume} шт.` : ''}${mark}` : 'нет в продаже'}`);
    }
    const st = s.prices.t;
    if (!st) lines.push('Steam — загружаю, нажмите «Обновить» через минуту');
    else if (!st.price) lines.push('Steam — нет в продаже');
    else lines.push(`Steam — <b>${rub(st.price)}</b>${st.volume ? ` · ${st.volume} прод./сутки` : ''}\n   <i>продавцу после комиссии ~${rub(st.price * (1 - STEAM_FEE))}</i>`);
    if (bs && st?.price && st.price > bs.price) lines.push('', `💡 На ${SOURCES[bs.src].title} на ${Math.round((1 - bs.price / st.price) * 100)}% дешевле, чем в Steam`);
    const full = ctx.tier(u) !== 'free';
    const ins = insightLines(skinInsight(s, src), { full });
    if (ins.length) lines.push('', ...ins);
    if (ins.length && !full && paid) lines.push('🔒 Ликвидность, «покупают за» и рекомендуемая цена — в тарифе ПРО (/premium)');
    if (isUltra(u)) {
      const sell = sellLines(s, { skinportFee: config.skinportSellFee });
      if (sell.length) lines.push('', ...sell);
    }

    const listed = q.listed.get(chatId, s.id)?.count || 0; // в личке chatId = id пользователя
    if (listed) lines.push('', `📦 Вы продаёте в Steam: <b>${listed} шт.</b>`);
    const buttons = [
      [{ text: '🔔 Следить', callback_data: `aa:${s.id}` }, { text: '⚙️ Своё условие', callback_data: `ak:${s.id}` }],
      [{ text: `📊 Оценка рынка${config.analysisPremium && !full ? ' ⭐' : ''}`, callback_data: `an:${s.id}` }, { text: '🔄 Обновить', callback_data: `skr:${s.id}` }],
      ...(isUltra(u) ? [[{ text: '📈 График цены', callback_data: `chart:${s.id}` }]] : []),
      listed
        ? [{ text: '📦 ＋1 на продаже', callback_data: `ls:${s.id}:+` }, { text: '➖ Снял / продал', callback_data: `ls:${s.id}:-` }]
        : [{ text: '📦 Я продаю это в Steam', callback_data: `ls:${s.id}:+` }],
      [...src.filter((k) => SOURCES[k].url).map((k) => ({ text: `${SOURCES[k].title} ↗`, url: urlOn(k, s) })), { text: 'Steam ↗', url: urlOn('t', s) }].slice(0, 4),
    ];
    const text = lines.join('\n');
    return messageId ? tg.edit(chatId, messageId, text, kb(buttons)) : tg.send(chatId, text, kb(buttons));
  }

  async function refreshCard(chatId, skinId, messageId) {
    const s = catalog.get(skinId);
    if (s) await ensureSteam(s, { wait: true });
    return card(chatId, skinId, messageId);
  }

  async function analyze(chatId, u, skinId) {
    let s = catalog.get(skinId);
    if (!s) return tg.send(chatId, 'Предмет не найден.');
    s = await ensureSteam(s, { wait: true });
    const r = analyzeSkin(s, catalog.history(s.id, 30), sourcesFor(s));
    return tg.send(chatId, `🔫 <b>${esc(s.name)}</b>\n\n${r.text}`, kb([[{ text: '🔔 Следить за ценой', callback_data: `aa:${s.id}` }, { text: '« Карточка', callback_data: `sk:${s.id}` }]]));
  }

  // ---------- уведомления ----------
  function alertLine(a) {
    const cond =
      a.type === 'pct' ? `изменение ±${a.value}%${a.auto ? ' (авто)' : ''}` : a.type === 'lt' ? `цена ниже ${rub(a.value)}` : `цена выше ${rub(a.value)}`;
    return `${esc(a.name)}\n   ${sourceTitle(a.market)} · ${cond}`;
  }

  function limitReached(chatId, u) {
    return tg.send(
      chatId,
      `У вас уже ${alertLimit(u)} уведомлений — это лимит тарифа ${TIER_TITLE[ctx.tier(u)]}. Удалите лишние в «🔔 Уведомления»${ctx.tier(u) === 'ultra' ? '' : ' или перейдите на тариф выше'}.`,
      ctx.tier(u) === 'ultra' || !paid ? {} : kb([[{ text: '⭐ Тарифы', callback_data: 'premium' }]]),
    );
  }

  async function chooseMarket(chatId, u, skinId) {
    if (q.alertsCount.get(u.id).n >= alertLimit(u)) return limitReached(chatId, u);
    const s = catalog.get(skinId);
    const src = sourcesFor(s);
    const rows = [BEST, ...src, 't'].map((m) => [{ text: `${sourceTitle(m)}${m !== 't' && priceOn(s, m, src) ? ' · ' + rub(priceOn(s, m, src)) : ''}`, callback_data: `am:${skinId}:${m}` }]);
    return tg.send(chatId, `🔔 <b>${esc(s.name)}</b>\nЗа ценой на какой площадке следить?`, kb(rows));
  }

  async function chooseCondition(chatId, skinId, m, messageId) {
    const s = catalog.get(skinId);
    const text = `🔔 <b>${esc(s.name)}</b> · ${sourceTitle(m)}\nКогда написать?`;
    const rows = [
      [5, 10, 20].map((p) => ({ text: `±${p}%`, callback_data: `ac:${skinId}:${m}:p${p}` })),
      [{ text: '📉 Цена ниже…', callback_data: `ac:${skinId}:${m}:lt` }, { text: '📈 Цена выше…', callback_data: `ac:${skinId}:${m}:gt` }],
    ];
    return messageId ? tg.edit(chatId, messageId, text, kb(rows)) : tg.send(chatId, text, kb(rows));
  }

  async function createAlert(chatId, u, skinId, m, type, value, { auto = false } = {}) {
    if (q.alertsCount.get(u.id).n >= alertLimit(u)) return limitReached(chatId, u);
    let s = catalog.get(skinId);
    if (!s || !(m === BEST || SOURCES[m])) return tg.send(chatId, 'Предмет не найден.');
    if (m === 't') s = await ensureSteam(s);
    const cur = priceOn(s, m, sourcesFor(s));
    if (cur == null) return tg.send(chatId, `На площадке ${sourceTitle(m)} сейчас нет цены на этот предмет. Выберите другую.`, kb([[{ text: '« Выбрать площадку', callback_data: `ak:${skinId}` }]]));
    if (auto) value = autoThreshold(cur);
    const already = (type === 'lt' && cur <= value) || (type === 'gt' && cur >= value);
    q.insAlert.run(u.id, skinId, m, type, value, cur, already ? 1 : 0, now(), now());
    const cond = type === 'pct' ? `цена изменится на ${value}% в любую сторону` : type === 'lt' ? `цена опустится ниже ${rub(value)}` : `цена поднимется выше ${rub(value)}`;
    let text = `✅ Слежу за <b>${esc(s.name)}</b> (${sourceTitle(m)}).\nСейчас: ${rub(cur)}. Напишу, когда ${cond}.`;
    if (auto) text += `\n<i>Порог ${value}% подобран под цену предмета — так приходят только заметные изменения.</i>`;
    if (already) text += `\n\nℹ️ Цена уже ${type === 'lt' ? 'ниже' : 'выше'} заданной — сообщу, когда она уйдёт за порог и снова его пересечёт.`;
    if (ctx.tier(u) === 'free' && paid) text += `\n\nНа бесплатном тарифе проверяю раз в ${config.freeAlertIntervalMin} мин, на ПРО — каждые ${config.proAlertIntervalMin} мин.`;
    return tg.send(chatId, text, kb([[{ text: '🔔 Мои уведомления', callback_data: 'al:0' }]]));
  }

  async function listAlerts(chatId, u, page = 0, messageId) {
    const total = q.alertsCount.get(u.id).n;
    const back = [{ text: '« Меню', callback_data: 'menu' }];
    if (!total) {
      const text = '🔔 Уведомлений пока нет.\n\nНапишите название скина (например, <code>AK-47 Redline FT</code>), откройте карточку и нажмите «🔔 Следить».';
      return messageId ? tg.edit(chatId, messageId, text, kb([back])) : tg.send(chatId, text, kb([back]));
    }
    const pages = Math.ceil(total / PAGE);
    page = Math.min(Math.max(0, page), pages - 1);
    const rows = q.alertsPage.all(u.id, PAGE, page * PAGE);
    const text = `🔔 <b>Уведомления</b> · ${total}${alertLimit(u) === Infinity ? '' : ` из ${alertLimit(u)}`}\n\n` + rows.map((a, i) => `${page * PAGE + i + 1}. ${alertLine(a)}`).join('\n');
    const buttons = rows.map((a, i) => [{ text: `❌ ${page * PAGE + i + 1}. ${a.name.slice(0, 40)}`, callback_data: `ad:${a.id}:${page}` }]);
    const nav = [];
    if (page > 0) nav.push({ text: '◀', callback_data: `al:${page - 1}` });
    if (pages > 1) nav.push({ text: `${page + 1}/${pages}`, callback_data: 'noop' });
    if (page < pages - 1) nav.push({ text: '▶', callback_data: `al:${page + 1}` });
    if (nav.length) buttons.push(nav);
    buttons.push([{ text: `📄 Таблица (CSV)${paid && ctx.tier(u) === 'free' ? ' ⭐' : ''}`, callback_data: 'exp:al' }, ...back]);
    return messageId ? tg.edit(chatId, messageId, text, kb(buttons)) : tg.send(chatId, text, kb(buttons));
  }

  async function checkAlerts() {
    let sent = 0;
    const t = now();
    for (const a of q.allAlerts.all()) {
      const every = limitsOf(tierOf(a, config, t), config).alertIntervalMin;
      if (every && a.checked_at && t - a.checked_at < every * 60_000 - 5000) continue;
      const s = catalog.get(a.skin_id);
      const cur = priceOn(s, a.market, sourcesFor(s));
      if (cur == null) continue;
      let msg = null;
      if (a.type === 'pct') {
        if (!a.base_price) {
          q.updAlertPct.run(cur, t, a.id);
          continue;
        }
        const ch = ((cur - a.base_price) / a.base_price) * 100;
        if (Math.abs(ch) >= a.value) {
          msg = `${ch < 0 ? '📉' : '📈'} <b>${esc(s.name)}</b> ${ch < 0 ? 'подешевел' : 'подорожал'} на ${pct(Math.abs(ch)).replace('+', '')}\n${sourceTitle(a.market)}: <b>${rub(cur)}</b> (было ${rub(a.base_price)})`;
          q.updAlertPct.run(cur, t, a.id);
        } else q.updAlertPct.run(a.base_price, t, a.id);
      } else {
        const hit = a.type === 'lt' ? cur <= a.value : cur >= a.value;
        if (hit && !a.triggered) msg = `${a.type === 'lt' ? '📉' : '📈'} <b>${esc(s.name)}</b> — цена ${a.type === 'lt' ? 'ниже' : 'выше'} ${rub(a.value)}\n${sourceTitle(a.market)}: <b>${rub(cur)}</b>`;
        q.updAlertTrig.run(hit ? 1 : 0, t, a.id);
      }
      if (!msg) continue;
      const m = a.market === BEST ? bestSource(s, sourcesFor(s))?.src || 't' : a.market;
      const r = await tg.send(
        a.user_id,
        msg,
        kb([[{ text: `Открыть на ${SOURCES[m].url ? SOURCES[m].title : 'Steam'} ↗`, url: urlOn(m, s) }], [{ text: '📊 Оценка рынка', callback_data: `an:${s.id}` }, { text: `${gameOf(s.app).icon} Карточка`, callback_data: `sk:${s.id}` }]]),
      );
      if (r === false) ctx.markBlocked(a.user_id);
      else if (r) sent++;
      await new Promise((res) => setTimeout(res, 40));
    }
    return sent;
  }

  // ---------- инвентарь ----------
  function invValue(userId) {
    const items = q.invItems.all(userId);
    const totals = Object.fromEntries(bulk.map((k) => [k, 0]));
    let bestTotal = 0;
    let noPrice = 0;
    const priced = [];
    for (const it of items) {
      const s = it.id ? catalog.get(it.id) : null;
      for (const k of bulk) if (s?.prices[k]?.price) totals[k] += s.prices[k].price * it.count;
      const p = s ? best(s) : null;
      if (p) {
        bestTotal += p * it.count;
        priced.push({ ...it, unit: p, total: p * it.count });
      } else noPrice += it.count;
    }
    priced.sort((a, b) => b.total - a.total);
    return { items, totals, best: bestTotal, noPrice, top: priced.slice(0, 10), count: items.reduce((s, i) => s + i.count, 0) };
  }

  function snapshotIfDue(userId) {
    const last = q.lastSnap.get(userId);
    if (last && now() - last.taken_at < DAY - 3600_000) return;
    const v = invValue(userId);
    if (v.best > 0) q.insSnap.run(userId, now(), v.best);
  }

  async function loadInventory(chatId, u) {
    try {
      const { counts, total, held } = await markets.inventory(u.steamid);
      // Непродаваемое без цены на площадках (медали, значки, монеты) не показываем.
      for (const name of held) {
        const s = catalog.getByName(name);
        if (!s || !best(s)) counts.delete(name);
      }
      // Сохраняем «точку отсчёта» цены для предметов, которые уже были в инвентаре.
      const bases = new Map(q.invBases.all(u.id).map((r) => [r.name, r.base_price]));
      db.exec('BEGIN');
      try {
        q.clearInv.run(u.id);
        for (const [name, count] of counts) {
          const s = catalog.getByName(name) || catalog.ensure(name);
          q.insInvBase.run(u.id, name, count, bases.get(name) ?? best(s));
        }
        q.setInv.run(now(), total, u.id);
        db.exec('COMMIT');
      } catch (e) {
        db.exec('ROLLBACK');
        throw e;
      }
      snapshotIfDue(u.id);
      return true;
    } catch (e) {
      if (e.code === 'private') {
        await tg.send(chatId, '🔒 Инвентарь скрыт. Откройте его: Steam → Профиль → Редактировать профиль → Приватность → «Инвентарь: Открытый», затем нажмите «Обновить».', kb([[{ text: '🔄 Обновить', callback_data: 'invr' }]]));
      } else if (e.code === 'rate') {
        await tg.send(chatId, 'Steam временно ограничил запросы. Попробуйте через пару минут.');
      } else {
        console.warn('[inventory]', e.message);
        await tg.send(chatId, `Не удалось загрузить инвентарь: ${esc(e.message)}`);
      }
      return false;
    }
  }

  async function showInventory(chatId, u, messageId) {
    if (!u.steamid) {
      ctx.setMode(u.id, { type: 'inv_link' });
      return tg.send(
        chatId,
        '💼 <b>Стоимость инвентаря CS2</b>\n\nПришлите ссылку на свой профиль Steam, например:\n<code>https://steamcommunity.com/profiles/7656…</code>\n\nИнвентарь должен быть открыт (Steam → Профиль → Приватность → «Инвентарь: Открытый»). Ссылку нужно прислать один раз — я её запомню.',
      );
    }
    if (!u.inv_at) {
      await tg.send(chatId, '⏳ Загружаю инвентарь из Steam…');
      if (!(await loadInventory(chatId, u))) return;
      u = ctx.getUser(u.id);
    }
    const v = invValue(u.id);
    const lines = [`💼 <b>Инвентарь CS2</b> · ${v.count} предметов${u.inv_total > v.count ? ` (всего ${u.inv_total})` : ''}`, ''];
    if (!v.count) lines.push('Предметов с ценой нет.');
    else {
      lines.push(`По лучшим ценам: <b>${rub(v.best)}</b>`);
      for (const k of bulk) if (v.totals[k]) lines.push(`${SOURCES[k].title}: ${rub(v.totals[k])}`);
      const ref = q.daySnap.get(u.id, now() - DAY + 3600_000) || q.firstSnap.get(u.id);
      if (ref && v.best > 0 && now() - ref.taken_at > 3600_000) {
        const diff = v.best - ref.value;
        const since = now() - ref.taken_at < DAY * 1.5 ? 'за сутки' : `с ${new Date(ref.taken_at).toLocaleDateString('ru-RU')}`;
        lines.push(`${diff >= 0 ? '📈' : '📉'} ${since}: ${diff >= 0 ? '+' : '−'}${rub(Math.abs(diff))} (${pct((diff / ref.value) * 100)})`);
      }
      lines.push('', '<b>Самые дорогие:</b>');
      v.top.forEach((it, i) => lines.push(`${i + 1}. ${esc(it.name)}${it.count > 1 ? ` ×${it.count}` : ''} — ${rub(it.total)}`));
      if (v.noPrice) lines.push('', `Без цены на площадках: ${v.noPrice} шт.`);
    }
    const lots = q.listAll.all(u.id);
    if (lots.length) {
      let sum = 0;
      lines.push('', '📦 <b>Выставлено на продажу в Steam:</b>');
      for (const l of lots) {
        const s = catalog.get(l.skin_id);
        const p = s?.prices.t?.price || (s ? best(s) : null);
        if (p) sum += p * l.count;
        lines.push(`• ${esc(s?.name)}${l.count > 1 ? ` ×${l.count}` : ''} — ${rub(p ? p * l.count : null)}`);
      }
      lines.push(`Итого с лотами: <b>${rub(v.best + sum)}</b>`);
    }
    if (u.inv_alerts) lines.push('', '🔔 Сообщу, если цена предметов заметно изменится. Выключить — в ⚙️ Настройках.');
    lines.push('', `<i>Состав инвентаря обновлён ${new Date(u.inv_at).toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}. Цены — актуальные.</i>`);
    const buttons = [
      ...v.top.slice(0, 3).map((it) => [{ text: `🔫 ${it.name.slice(0, 45)}`, callback_data: `sk:${it.id}` }]),
      [{ text: '🔄 Обновить состав', callback_data: 'invr' }, { text: '🔗 Другой профиль', callback_data: 'invu' }],
      [{ text: `📄 Таблица (CSV)${paid && ctx.tier(u) === 'free' ? ' ⭐' : ''}`, callback_data: 'exp:inv' }, { text: '« Меню', callback_data: 'menu' }],
    ];
    return messageId ? tg.edit(chatId, messageId, lines.join('\n'), kb(buttons)) : tg.send(chatId, lines.join('\n'), kb(buttons));
  }

  async function refreshInventory(chatId, u) {
    if (!u.steamid) return showInventory(chatId, u);
    const wait = u.inv_at ? u.inv_at + invTtlH(u) * 3600_000 - now() : 0;
    if (wait > 0) {
      const mins = Math.ceil(wait / 60000);
      const when = mins >= 60 ? `${Math.floor(mins / 60)} ч ${mins % 60} мин` : `${mins} мин`;
      return tg.send(
        chatId,
        `Состав инвентаря можно обновлять раз в ${hours(invTtlH(u))} (так Steam не блокирует запросы). Следующее обновление — через ${when}.\nЦены при этом всегда актуальные.`,
        ctx.tier(u) !== 'free' || !paid ? {} : kb([[{ text: `⭐ ПРО — раз в ${hours(config.proInvTtlH)}`, callback_data: 'premium' }]]),
      );
    }
    await tg.send(chatId, '⏳ Обновляю инвентарь…');
    if (await loadInventory(chatId, u)) return showInventory(chatId, ctx.getUser(u.id));
  }

  async function linkProfile(chatId, u, steamid) {
    if (u.steamid !== steamid) {
      q.setSteamid.run(steamid, u.id);
      q.clearInv.run(u.id);
      q.clearSnaps.run(u.id);
    }
    return showInventory(chatId, ctx.getUser(u.id));
  }

  // ---------- подборка для инвестиций ----------
  const pickCache = new Map(); // budget → {at, res}
  function investCandidates() {
    const prices = db.prepare(`SELECT skin_id, src, price FROM skin_prices WHERE price > 0 AND src IN (${bulk.map(() => '?').join(',')})`).all(...bulk);
    const byId = new Map();
    for (const p of prices) {
      const e = byId.get(p.skin_id) || byId.set(p.skin_id, { sp: null, best: null, bestSrc: null }).get(p.skin_id);
      if (p.src === 's') e.sp = p.price;
      if (e.best == null || p.price < e.best) {
        e.best = p.price;
        e.bestSrc = p.src;
      }
    }
    return db
      .prepare('SELECT s.id, s.name, st.med7, st.med30, st.vol7 FROM skins s JOIN skin_stats st ON st.skin_id = s.id WHERE st.med30 > 0 AND st.vol7 >= ?')
      .all(config.investMinVolume)
      .map((r) => ({ ...r, ...(byId.get(r.id) || {}) }))
      .filter((r) => r.best);
  }

  async function showInvest(chatId, u, budget = 'a', messageId) {
    if (!BUDGETS[budget]) budget = 'a';
    let c = pickCache.get(budget);
    if (!c || now() - c.at > 30 * 60_000) {
      c = { at: now(), res: investPicks(investCandidates(), { budget, minVolume: config.investMinVolume, minPrice: config.investMinPrice }) };
      pickCache.set(budget, c);
    }
    const { cheap, rising } = c.res;
    const line = (x, i) =>
      `${i + 1}. <b>${esc(x.name)}</b>\n   ${rub(x.best)} на ${SOURCES[x.bestSrc]?.title || x.bestSrc} · ${x.disc >= 0 ? `↓${Math.round(x.disc)}% к медиане месяца` : `↑${Math.round(-x.disc)}% к медиане месяца`} · неделя ${pct(x.trend)} · ${x.vol7} прод./нед.`;
    const lines = [`📈 <b>Что купить</b> · ${BUDGETS[budget].title}`, ''];
    if (!cheap.length && !rising.length) {
      lines.push('Сейчас подходящих предметов нет — рынок без явных просадок, или ещё не загрузилась история продаж (обновляется раз в час). Загляните позже.');
    } else {
      if (cheap.length) lines.push('🟢 <b>Ниже обычной цены</b> — сейчас дешевле, чем обычно продаются:', ...cheap.map(line), '');
      if (rising.length) lines.push('🚀 <b>В росте</b> — цена растёт неделю, купить можно по текущей:', ...rising.map(line), '');
    }
    lines.push('<i>Подборка строится автоматически по ценам площадок и истории продаж Skinport за 7 и 30 дней. Это не финансовый совет: скины могут дешеветь, учитывайте комиссии площадок и холд на вывод.</i>');
    const top = [...cheap, ...rising].slice(0, 5);
    const budgetsRow1 = ['b1', 'b2'].map((k) => ({ text: `${k === budget ? '✅ ' : ''}${BUDGETS[k].title}`, callback_data: `pk:${k}` }));
    const budgetsRow2 = ['b3', 'b4', 'a'].map((k) => ({ text: `${k === budget ? '✅ ' : ''}${BUDGETS[k].title}`, callback_data: `pk:${k}` }));
    const buttons = [...top.map((x) => [{ text: `📊 ${x.name.slice(0, 45)}`, callback_data: `an:${x.id}` }]), budgetsRow1, budgetsRow2, [{ text: '« Меню', callback_data: 'menu' }]];
    return messageId ? tg.edit(chatId, messageId, lines.join('\n'), kb(buttons)) : tg.send(chatId, lines.join('\n'), kb(buttons));
  }

  // ---------- изменения цен в инвентаре (по умолчанию для всех) ----------
  async function checkInventoryPrices() {
    let sent = 0;
    const t = now();
    for (const u of q.invWatchers.all()) {
      const every = ctx.limits(u).alertIntervalMin;
      if (every && u.inv_alert_at && t - u.inv_alert_at < every * 60_000 - 5000) continue;
      q.setInvAlertAt.run(t, u.id);
      const changes = [];
      for (const it of q.invRows.all(u.id)) {
        const s = catalog.get(it.id);
        const cur = s ? best(s) : null;
        if (!cur) continue;
        if (!it.base_price) {
          q.setBase.run(cur, u.id, it.name);
          continue;
        }
        const ch = ((cur - it.base_price) / it.base_price) * 100;
        if (Math.abs(ch) < autoThreshold(cur)) continue;
        q.setBase.run(cur, u.id, it.name); // следующее изменение считаем от новой цены
        if (cur * it.count < config.invAlertMinRub && it.base_price * it.count < config.invAlertMinRub) continue; // мелочь не шлём
        changes.push({ ...it, cur, ch, diff: (cur - it.base_price) * it.count });
      }
      if (!changes.length) continue;
      changes.sort((a, b) => Math.abs(b.diff) - Math.abs(a.diff));
      const total = changes.reduce((s, c) => s + c.diff, 0);
      const lines = [
        `💼 <b>Цены в вашем инвентаре изменились</b>`,
        '',
        ...changes.slice(0, 15).map((c) => `${c.ch < 0 ? '📉' : '📈'} ${esc(c.name)}${c.count > 1 ? ` ×${c.count}` : ''}: ${rub(c.cur)} (${pct(c.ch)})`),
      ];
      if (changes.length > 15) lines.push(`…и ещё ${changes.length - 15}`);
      lines.push('', `Итого: ${total >= 0 ? '+' : '−'}${rub(Math.abs(total))}`);
      const r = await tg.send(
        u.id,
        lines.join('\n'),
        kb([
          ...changes.slice(0, 3).map((c) => [{ text: `📊 ${c.name.slice(0, 40)}`, callback_data: `an:${c.id}` }]),
          [{ text: '💼 Инвентарь', callback_data: 'inv' }, { text: '🔕 Не присылать', callback_data: 'invn:0' }],
        ]),
      );
      if (r === false) ctx.markBlocked(u.id);
      else if (r) sent++;
      await new Promise((res) => setTimeout(res, 40));
    }
    return sent;
  }

  // ---------- регулярный цикл цен ----------
  async function priceCycle() {
    await ctx.rates.refresh();
    const r = await catalog.refresh(markets);
    lastRefresh = { at: now(), ...r };
    // История продаж Skinport — раз в час (у Skinport жёсткий лимит запросов).
    if (bulk.includes('s') && now() - lastStatsAt > 3600_000) {
      lastStatsAt = now();
      r.stats = await catalog.refreshStats(markets).catch((e) => `ошибка: ${e.message}`);
      pickCache.clear();
    }
    // Rust и TF2 (для УЛЬТРА): прайсы — раз в GAMES_REFRESH_MIN, история продаж Skinport — раз в 6 часов.
    if (config.extraGames.length && now() - lastGamesAt >= config.gamesRefreshMin * 60_000) {
      lastGamesAt = now();
      r.games = {};
      for (const app of config.extraGames) r.games[gameOf(app).key] = await catalog.refreshGame(markets, app).catch((e) => `ошибка: ${e.message}`);
    }
    if (config.extraGames.length && now() - lastGameStatsAt > 6 * 3600_000) {
      lastGameStatsAt = now();
      for (const app of config.extraGames) await catalog.refreshStats(markets, app).catch((e) => console.warn('[история продаж]', gameOf(app).title, e.message));
    }
    if (now() - lastHistAt > 3600_000) {
      lastHistAt = now();
      catalog.snapshotDay();
    }
    const stale = q.steamWatched.all(now() - config.steamTtlMin * 60_000, config.steamBatch);
    for (const { id } of stale) await ensureSteam(catalog.get(id));
    const sent = await checkAlerts();
    const invSent = await checkInventoryPrices();
    for (const { user_id } of q.invUsers.all()) snapshotIfDue(user_id);
    return { ...r, steam: stale.length, alertsSent: sent, inventorySent: invSent };
  }

  return {
    searchSkins,
    searchOther,
    sourcesFor,
    ensureSteam,
    sendResults,
    card,
    refreshCard,
    analyze,
    chooseMarket,
    chooseCondition,
    createAlert,
    autoAlert: (chatId, u, skinId) => createAlert(chatId, u, skinId, BEST, 'pct', 0, { auto: true }),
    listAlerts,
    deleteAlert: (u, id) => q.delAlert.run(id, u.id),
    setListed(u, skinId, dir) {
      if (dir === '+') q.listAdd.run(u.id, skinId);
      else q.listDec.run(u.id, skinId);
      q.listClean.run();
    },
    showInventory,
    refreshInventory,
    linkProfile,
    unlink: (u) => {
      q.setSteamid.run(null, u.id);
      q.clearInv.run(u.id);
      q.clearSnaps.run(u.id);
    },
    priceCycle,
    invValue,
    checkInventoryPrices,
    showInvest,
    resetPicks: () => pickCache.clear(),
    checkAlerts,
    lastRefresh: () => lastRefresh,
    stats: () => ({
      alerts: db.prepare('SELECT COUNT(*) n, COUNT(DISTINCT user_id) u FROM alerts').get(),
      inventories: db.prepare('SELECT COUNT(*) n FROM users WHERE steamid IS NOT NULL').get().n,
    }),
  };
}
