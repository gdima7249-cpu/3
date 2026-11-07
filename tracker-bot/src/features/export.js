// Экспорт в таблицу: CSV с разделителем «;» и BOM — Excel открывает его по двойному клику, с кириллицей.
import { sourceTitle } from '../markets.js';
import { priceOn } from '../catalog.js';
import { skinInsight } from '../analysis.js';

const cell = (v) => {
  if (v == null || v === '') return '';
  if (typeof v === 'number') return Number.isFinite(v) ? String(Math.round(v * 100) / 100).replace('.', ',') : '';
  const s = String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
export const toCsv = (header, rows) => '\ufeff' + [header, ...rows].map((r) => r.map(cell).join(';')).join('\r\n');

const INSIGHT_HEAD = ['Средняя на площадках, ₽', 'Покупают за, ₽', 'Ликвидность', 'Продаж в день', 'Рекомендуемая цена, ₽'];

export function createExport(ctx, { skins, wishlist }) {
  const { tg, db, catalog } = ctx;
  const bulk = catalog.bulkSources;
  const insight = (s) => {
    const i = s ? skinInsight(s, skins.sourcesFor(s)) : null;
    return [i?.avg, i?.sold, i?.liq?.title, i?.perDay, i?.rec];
  };
  const q = {
    alerts: db.prepare('SELECT a.*, s.name FROM alerts a JOIN skins s ON s.id = a.skin_id WHERE a.user_id = ? ORDER BY a.id'),
  };

  function alerts(u) {
    const rows = q.alerts.all(u.id).map((a) => {
      const s = catalog.get(a.skin_id);
      const cond = a.type === 'pct' ? `±${a.value}%` : a.type === 'lt' ? `ниже ${a.value} ₽` : `выше ${a.value} ₽`;
      return [a.name, sourceTitle(a.market), cond, s ? priceOn(s, a.market, skins.sourcesFor(s)) : null, s?.prices.t?.price, ...insight(s)];
    });
    return { rows: rows.length, csv: toCsv(['Предмет', 'Площадка', 'Условие', 'Цена сейчас, ₽', 'Steam, ₽', ...INSIGHT_HEAD], rows), name: 'skinwatch-alerts.csv', title: 'Уведомления о скинах' };
  }

  function inventory(u) {
    const v = skins.invValue(u.id);
    const rows = v.items.map((it) => {
      const s = it.id ? catalog.get(it.id) : null;
      const unit = s ? priceOn(s, 'b', bulk) : null;
      return [it.name, it.count, unit, unit != null ? unit * it.count : null, s?.prices.t?.price, ...insight(s)];
    });
    rows.sort((a, b) => (b[3] || 0) - (a[3] || 0));
    return { rows: rows.length, csv: toCsv(['Предмет', 'Количество', 'Лучшая цена за шт., ₽', 'Сумма, ₽', 'Steam, ₽', ...INSIGHT_HEAD], rows), name: 'skinwatch-inventory.csv', title: 'Инвентарь CS2' };
  }

  function games(u) {
    const rows = wishlist.rows(u).map((g) => [
      g.name || `App ${g.appid}`,
      g.final != null ? g.final / 100 : null,
      g.currency,
      g.discount || 0,
      g.initial != null ? g.initial / 100 : null,
      g.rating_pct,
      g.available === 0 ? `недоступна (${g.cc.toUpperCase()})` : '',
      g.url,
    ]);
    return { rows: rows.length, csv: toCsv(['Игра', 'Цена', 'Валюта', 'Скидка, %', 'Без скидки', 'Отзывы, % положительных', 'Примечание', 'Ссылка'], rows), name: 'skinwatch-wishlist.csv', title: 'Вишлист игр' };
  }

  const KINDS = { al: alerts, inv: inventory, wl: games };

  async function send(chatId, u, kind) {
    const make = KINDS[kind];
    if (!make) return tg.send(chatId, 'Что выгрузить?', ctx.kb([[{ text: '🔔 Уведомления о скинах', callback_data: 'exp:al' }], [{ text: '💼 Инвентарь CS2', callback_data: 'exp:inv' }], [{ text: '🎮 Вишлист игр', callback_data: 'exp:wl' }]]));
    const r = make(u);
    if (!r.rows) return tg.send(chatId, `${r.title}: выгружать пока нечего.`);
    return tg.sendFile(chatId, 'document', Buffer.from(r.csv), r.name, { mime: 'text/csv', caption: `📄 ${r.title} — ${r.rows} строк. Откройте в Excel или Google Таблицах.` });
  }

  return { send, alerts, inventory, games };
}
