// УЛЬТРА: пополнение Steam (через скины и сервисы), сигналы «выгодно купить / пора продавать»,
// ежедневный отчёт по инвентарю, график цены скина.
import { esc } from '../telegram.js';
import { SOURCES, CS2, gameOf } from '../markets.js';
import { bestSource } from '../catalog.js';
import { topupRate, skinSignals, sellLines } from '../analysis.js';
import { renderChart } from '../chart.js';
import { rub } from './skins.js';

const DAY = 86400_000;
const rate = (x) => x.toFixed(2).replace('.', ',');
const pct = (n) => `${n > 0 ? '+' : n < 0 ? '−' : ''}${Math.abs(n).toFixed(1).replace('.', ',').replace(/,0$/, '')}%`;

export function createUltra(ctx, { skins }) {
  const { tg, db, config, catalog, kb, now } = ctx;
  const bulk = catalog.bulkSources;
  const inList = bulk.map(() => '?').join(',');
  const q = {
    services: db.prepare('SELECT * FROM topup_services ORDER BY fee, id'),
    addService: db.prepare('INSERT INTO topup_services (name, fee, url, updated_at) VALUES (?, ?, ?, ?)'),
    delService: db.prepare('DELETE FROM topup_services WHERE id = ?'),
    // Кандидаты для пополнения: ходовые скины CS2 в нужном диапазоне цен, у которых цена Steam устарела.
    topupStale: db.prepare(`SELECT s.id FROM skins s JOIN skin_stats st ON st.skin_id = s.id
      LEFT JOIN skin_prices t ON t.skin_id = s.id AND t.src = 't'
      WHERE s.app = ${CS2} AND st.vol7 >= 20 AND (t.updated_at IS NULL OR t.updated_at < ?)
        AND EXISTS (SELECT 1 FROM skin_prices b WHERE b.skin_id = s.id AND b.src IN (${inList}) AND b.price BETWEEN ? AND ?)
      ORDER BY st.vol7 DESC LIMIT ?`),
    topupFresh: db.prepare(`SELECT s.id FROM skins s JOIN skin_prices t ON t.skin_id = s.id AND t.src = 't'
      WHERE s.app = ${CS2} AND t.price > 0 AND t.volume >= ? AND t.updated_at > ?`),
    ultraUsers: db.prepare(
      config.freeForAll
        ? 'SELECT * FROM users WHERE blocked = 0'
        : "SELECT * FROM users WHERE blocked = 0 AND premium_until > ? AND tier = 'ultra'",
    ),
    userSkins: db.prepare(`SELECT DISTINCT skin_id AS id, 'alert' AS why FROM alerts WHERE user_id = ?
      UNION SELECT s.id, 'inv' FROM inv_items i JOIN skins s ON s.name = i.name AND s.app = ${CS2} WHERE i.user_id = ?`),
    lastSignal: db.prepare('SELECT sent_at FROM signals WHERE user_id = ? AND skin_id = ? AND kind = ?'),
    setSignal: db.prepare('INSERT INTO signals (user_id, skin_id, kind, sent_at) VALUES (?, ?, ?, ?) ON CONFLICT(user_id, skin_id, kind) DO UPDATE SET sent_at = excluded.sent_at'),
    setReportDay: db.prepare('UPDATE users SET report_day = ? WHERE id = ?'),
    snapAt: db.prepare('SELECT value FROM inv_snapshots WHERE user_id = ? AND taken_at <= ? ORDER BY taken_at DESC LIMIT 1'),
    invRows: db.prepare(`SELECT i.name, i.count, s.id FROM inv_items i JOIN skins s ON s.name = i.name AND s.app = ${CS2} WHERE i.user_id = ?`),
  };
  const ultraUsers = () => (config.freeForAll ? q.ultraUsers.all() : q.ultraUsers.all(now()));
  const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: config.timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23' });
  const local = (ts) => {
    const p = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
    return { day: `${p.year}-${p.month}-${p.day}`, dm: `${p.day}.${p.month}`, hour: Number(p.hour) % 24 };
  };
  const cardBtn = (s) => ({ text: `${gameOf(s.app).icon} Карточка`, callback_data: `sk:${s.id}` });
  const openBtn = (s, src) => (SOURCES[src]?.url ? { text: `${SOURCES[src].title} ↗`, url: SOURCES[src].url(s.name, s.app) } : null);

  // ---------- пополнение Steam ----------
  /** Раз в час: освежить цены Steam у кандидатов (Steam отвечает ~20 раз в минуту, поэтому понемногу). */
  async function refreshTopupSteam() {
    const ids = q.topupStale.all(now() - 3 * 3600_000, ...bulk, config.topupMinPrice, config.topupMaxPrice, config.topupSteamBatch);
    for (const { id } of ids) await skins.ensureSteam(catalog.get(id));
    return ids.length;
  }

  function topupPicks(limit = 7) {
    return q.topupFresh
      .all(config.topupMinVolume, now() - 6 * 3600_000)
      .map(({ id }) => catalog.get(id))
      .map((s) => ({ s, r: topupRate(s, bulk, { minVolume: config.topupMinVolume }) }))
      .filter((x) => x.r && x.r.buy >= config.topupMinPrice && x.r.buy <= config.topupMaxPrice)
      .sort((a, b) => a.r.rate - b.r.rate)
      .slice(0, limit);
  }

  async function showTopup(chatId) {
    const picks = topupPicks();
    const services = q.services.all();
    const lines = ['💳 <b>Где выгодно пополнить Steam</b>', '', '<b>Через скины</b> — купить на площадке и продать в Steam, деньги придут на кошелёк Steam:'];
    if (!picks.length) lines.push('Подборка ещё собирается: Steam отвечает медленно, бот проверяет его цены постепенно. Первые варианты появятся в течение часа.');
    picks.forEach(({ s, r }, i) =>
      lines.push(
        `${i + 1}. <b>${esc(s.name)}</b>`,
        `   Купить: ${SOURCES[r.buySrc].title} — ${rub(r.buy)} → в Steam продаётся за ~${rub(r.sell)} → на кошелёк ~${rub(r.wallet)}`,
        `   Курс: <b>${rate(r.rate)} ₽</b> за 1 ₽ в Steam · продаж в Steam: ${r.volume} в сутки`,
      ),
    );
    if (services.length) {
      const upd = new Date(Math.max(...services.map((x) => x.updated_at))).toLocaleDateString('ru-RU');
      lines.push('', `<b>Сервисы пополнения</b> (комиссии по данным администратора на ${upd}):`);
      for (const x of services) lines.push(`• ${x.url ? `<a href="${esc(x.url)}">${esc(x.name)}</a>` : esc(x.name)} — комиссия ${String(x.fee).replace('.', ',')}% → <b>${rate(1 + x.fee / 100)} ₽</b> за 1 ₽`);
    }
    const best = [picks[0] && { what: 'через скины', r: picks[0].r.rate }, services[0] && { what: services[0].name, r: 1 + services[0].fee / 100 }].filter(Boolean).sort((a, b) => a.r - b.r)[0];
    if (best) lines.push('', `💡 Сейчас выгоднее всего: <b>${esc(best.what)}</b> — ${rate(best.r)} ₽ за 1 ₽ на кошельке.`);
    lines.push(
      '',
      '<i>Цена продажи в Steam — по реальным продажам, комиссия Steam 13% уже вычтена. Купленный скин обычно приходит с блокировкой обмена: ' +
        'продать его в Steam можно не сразу, и цена за это время может измениться. Деньги на кошельке Steam вывести нельзя.</i>',
    );
    const rows = picks.slice(0, 3).map(({ s, r }) => [openBtn(s, r.buySrc), cardBtn(s)].filter(Boolean));
    rows.push([{ text: '🔄 Обновить', callback_data: 'topup' }, { text: '« Меню', callback_data: 'menu' }]);
    return tg.send(chatId, lines.join('\n'), kb(rows));
  }

  // ---------- сигналы ----------
  async function checkSignals() {
    let sent = 0;
    const t = now();
    for (const u of ultraUsers()) {
      if (!u.signals_on) continue;
      let perUser = 0;
      for (const row of q.userSkins.all(u.id, u.id)) {
        if (perUser >= 5) break;
        const s = catalog.get(row.id);
        if (!s) continue;
        const sig = skinSignals(s, skins.sourcesFor(s), { buyPct: config.signalBuyPct, sellPct: config.signalSellPct });
        const kind = row.why === 'alert' && sig.buy ? 'buy' : row.why === 'inv' && sig.sell ? 'sell' : null;
        if (!kind) continue;
        const last = q.lastSignal.get(u.id, s.id, kind)?.sent_at;
        if (last && t - last < DAY) continue;
        let text;
        let open = null;
        if (kind === 'buy') {
          const b = sig.buy;
          text = `🟢 <b>Выгодно купить:</b> ${esc(s.name)}\nСейчас <b>${rub(b.price)}</b> на ${SOURCES[b.src].title}, а обычно покупают за ${rub(b.sold)} (${pct(-b.off)}) · ликвидность ${b.liq.title}`;
          open = openBtn(s, b.src);
        } else {
          const x = sig.sell;
          text = [`🔴 <b>Пора продавать?</b> ${esc(s.name)} (есть в инвентаре)`, `За неделю продают в среднем за ${rub(x.med7)} — на ${pct(x.up).replace('+', '')} дороже, чем за месяц (${rub(x.med30)}) · ликвидность ${x.liq.title}`, ...sellLines(s, { skinportFee: config.skinportSellFee })].join('\n');
        }
        text += '\n<i>Сигнал по ценам площадок, не финансовый совет. Не чаще раза в сутки по одному предмету.</i>';
        const r = await tg.send(u.id, text, kb([[open, cardBtn(s)].filter(Boolean), [{ text: '🔕 Выключить сигналы', callback_data: 'sig:0' }]]));
        if (r === false) {
          ctx.markBlocked(u.id);
          break;
        }
        q.setSignal.run(u.id, s.id, kind, t);
        perUser++;
        sent++;
      }
    }
    return sent;
  }

  // ---------- ежедневный отчёт по инвентарю ----------
  function reportText(u) {
    const v = skins.invValue(u.id);
    if (!v.count) return null;
    const t = now();
    const lines = [`📋 <b>Отчёт по инвентарю</b> · ${local(t).dm}`, '', `Стоимость: <b>${rub(v.best)}</b>`];
    for (const [label, ago] of [['за сутки', DAY], ['за неделю', 7 * DAY]]) {
      const ref = q.snapAt.get(u.id, t - ago + 3600_000)?.value;
      if (ref) lines.push(`${v.best >= ref ? '📈' : '📉'} ${label}: ${v.best >= ref ? '+' : '−'}${rub(Math.abs(v.best - ref))} (${pct(((v.best - ref) / ref) * 100)})`);
    }
    // Изменение по предметам: сегодняшняя лучшая цена против вчерашней записи истории
    const today = new Date(t).toISOString().slice(0, 10);
    const moves = [];
    const sells = [];
    for (const it of q.invRows.all(u.id)) {
      const s = catalog.get(it.id);
      const cur = s ? bestSource(s, bulk)?.price : null;
      if (!cur) continue;
      const prev = catalog.history(it.id, 3).filter((h) => h.day < today).at(-1)?.price;
      if (prev) moves.push({ s, count: it.count, cur, ch: ((cur - prev) / prev) * 100, diff: (cur - prev) * it.count });
      const sig = skinSignals(s, bulk, { buyPct: config.signalBuyPct, sellPct: config.signalSellPct });
      if (sig.sell) sells.push({ s, up: sig.sell.up });
    }
    const up = moves.filter((m) => m.diff > 0 && Math.abs(m.ch) >= 1).sort((a, b) => b.diff - a.diff).slice(0, 3);
    const down = moves.filter((m) => m.diff < 0 && Math.abs(m.ch) >= 1).sort((a, b) => a.diff - b.diff).slice(0, 3);
    const line = (m) => `• ${esc(m.s.name)}${m.count > 1 ? ` ×${m.count}` : ''}: ${rub(m.cur)} (${pct(m.ch)})`;
    if (up.length) lines.push('', '<b>Подорожали:</b>', ...up.map(line));
    if (down.length) lines.push('', '<b>Подешевели:</b>', ...down.map(line));
    if (sells.length) {
      lines.push('', '💰 <b>Выгодно продать сейчас</b> (продажи недели выше месяца):');
      for (const x of sells.sort((a, b) => b.up - a.up).slice(0, 5)) lines.push(`• ${esc(x.s.name)} — ${pct(x.up)}`);
    }
    if (!up.length && !down.length && !sells.length) lines.push('', 'За сутки заметных изменений нет.');
    return { text: lines.join('\n'), sells };
  }

  async function sendReport(chatId, u) {
    const r = reportText(u);
    if (!r) return tg.send(chatId, '📋 Отчёт строится по инвентарю CS2. Привяжите профиль Steam в «💼 Инвентарь».', kb([[{ text: '💼 Инвентарь', callback_data: 'inv' }]]));
    const rows = [...r.sells.slice(0, 2).map((x) => [{ text: `💰 ${x.s.name.slice(0, 40)}`, callback_data: `sk:${x.s.id}` }]), [{ text: '💼 Инвентарь', callback_data: 'inv' }, { text: '🔕 Не присылать отчёт', callback_data: 'rep:0' }]];
    return tg.send(chatId, r.text, kb(rows));
  }

  async function dailyReports() {
    const t = now();
    const { day, hour } = local(t);
    if (hour < config.reportHour) return 0;
    let sent = 0;
    for (const u of ultraUsers()) {
      if (!u.report_on || u.report_day === day) continue;
      q.setReportDay.run(day, u.id);
      if (!reportText(u)) continue;
      const r = await sendReport(u.id, u);
      if (r === false) ctx.markBlocked(u.id);
      else if (r) sent++;
    }
    return sent;
  }

  // ---------- график ----------
  async function sendChart(chatId, skinId) {
    const s = catalog.get(skinId);
    if (!s) return tg.send(chatId, 'Предмет не найден.');
    const hist = catalog.history(s.id, 30);
    if (hist.length < 2) return tg.send(chatId, `📈 <b>${esc(s.name)}</b>\nИстория цены копится: бот записывает лучшую цену на площадках раз в день. График появится через пару дней.`, kb([[cardBtn(s)]]));
    const points = hist.map((h) => ({ ts: Date.parse(`${h.day}T12:00:00Z`), price: h.price }));
    const png = renderChart(points, { dateLabel: (ts) => new Date(ts).toISOString().slice(5, 10).split('-').reverse().join('.') });
    const prices = points.map((p) => p.price);
    const caption = `📈 <b>${esc(s.name)}</b> — лучшая цена на площадках за ${hist.length} дн.\nМин ${rub(Math.min(...prices))} · макс ${rub(Math.max(...prices))} · сейчас ${rub(prices.at(-1))}`;
    return tg.sendFile(chatId, 'photo', png, 'chart.png', { caption, mime: 'image/png', reply_markup: { inline_keyboard: [[cardBtn(s)]] } });
  }

  // ---------- список сервисов пополнения (администратор) ----------
  const services = {
    add(text) {
      const [name, fee, url] = text.split('|').map((x) => x.trim());
      const f = Number(String(fee || '').replace(',', '.').replace('%', ''));
      if (!name || !Number.isFinite(f) || f < 0 || f > 100) return null;
      return Number(q.addService.run(name, f, url || null, now()).lastInsertRowid);
    },
    del: (id) => q.delService.run(id).changes,
    list: () => q.services.all(),
  };

  return { showTopup, refreshTopupSteam, topupPicks, checkSignals, dailyReports, sendReport, sendChart, services };
}
