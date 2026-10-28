// Динамика цены: минимум/максимум, средние, «в какой день недели дешевле».
import { zoned, WEEKDAY_SHORT, WEEKDAY_ACC } from './schedule.js';

const DAY = 86_400_000;
const avg = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

/**
 * Число по-русски: 1 087 и 1 087,50. Без toLocaleString — в сборках Node.js без языковых данных
 * (например, nodejs из AlmaLinux без nodejs-full-i18n) там получилось бы «1,087».
 * digits — знаков после запятой; trim — убрать нулевую дробную часть («5,0» → «5»).
 */
export function ruNumber(n, digits = 0, { trim = false, sep = '\u00a0' } = {}) {
  let [int, frac = ''] = Math.abs(n).toFixed(digits).split('.');
  if (trim) frac = frac.replace(/0+$/, '');
  int = int.replace(/\B(?=(\d{3})+(?!\d))/g, sep);
  return `${n < 0 && Number(Math.abs(n).toFixed(digits)) !== 0 ? '-' : ''}${int}${frac ? `,${frac}` : ''}`;
}

export function formatRub(n, { sign = false } = {}) {
  if (n === null || n === undefined) return '—';
  const abs = Math.abs(n);
  const s = ruNumber(abs, Math.round(abs * 100) % 100 === 0 ? 0 : 2);
  return `${n < 0 ? '−' : sign && n > 0 ? '+' : ''}${s}\u00a0₽`;
}

export const formatPct = (x) => `${x > 0 ? '+' : x < 0 ? '−' : ''}${ruNumber(Math.abs(x), 1, { trim: true })}%`;

/** Одна цена на день — минимальная за день (если проверок было две). */
export function dailySeries(history, tz) {
  const byDay = new Map();
  for (const h of history) {
    if (h.price === null || h.price === undefined) continue;
    const day = zoned(h.ts, tz).day;
    const cur = byDay.get(day);
    if (!cur || h.price < cur.price) byDay.set(day, { day, ts: h.ts, price: h.price });
  }
  return [...byDay.values()].sort((a, b) => a.ts - b.ts);
}

/**
 * history — удачные проверки по времени: [{ ts, price, promo, promo_price, … }].
 * Все цены считаются «к оплате»: с промокодом, если он был на странице.
 */
export function analyze(history, { tz }) {
  const pts = history.filter((h) => h.price !== null && h.price !== undefined).map((h) => ({ ...h, base: h.price, price: h.promo_price ?? h.price }));
  if (!pts.length) return null;
  const cur = pts.at(-1);
  const prev = pts.length > 1 ? pts.at(-2) : null;
  const earlier = pts.slice(0, -1);
  const pick = (better) => pts.reduce((best, p) => (better(p.price, best.price) ? p : best));
  const min = pick((a, b) => a < b);
  const max = pick((a, b) => a > b);
  const prevMin = earlier.length ? Math.min(...earlier.map((p) => p.price)) : null;
  const days = dailySeries(pts, tz);

  // Сколько дней цена держится на текущем уровне
  let since = cur.ts;
  for (let i = pts.length - 2; i >= 0 && pts[i].price === cur.price; i--) since = pts[i].ts;

  // По дням недели: нужно хотя бы 2 недели наблюдений, иначе это шум
  const byWeekday = Array.from({ length: 7 }, () => []);
  for (const d of days) byWeekday[zoned(d.ts, tz).weekday].push(d.price);
  const weekdays = byWeekday.map((xs, wd) => ({ wd, n: xs.length, avg: avg(xs) })).filter((w) => w.n);
  let weekdayTip = null;
  if (days.length >= 14 && weekdays.length === 7 && weekdays.every((w) => w.n >= 2)) {
    const best = weekdays.reduce((a, b) => (b.avg < a.avg ? b : a));
    const worst = weekdays.reduce((a, b) => (b.avg > a.avg ? b : a));
    const spread = ((worst.avg - best.avg) / worst.avg) * 100;
    weekdayTip = spread < 0.5 ? { flat: true } : { best, worst, spread };
  }

  // По времени суток — только если проверок больше одной в день (CHECK_TIMES с двумя значениями)
  const byHour = new Map();
  for (const p of pts) {
    const h = zoned(p.ts, tz).hour;
    if (!byHour.has(h)) byHour.set(h, []);
    byHour.get(h).push(p.price);
  }
  const hours = [...byHour.entries()].filter(([, xs]) => xs.length >= 5).map(([hour, xs]) => ({ hour, n: xs.length, avg: avg(xs) }));

  // Промокод: как часто был на странице и в какие дни недели
  const known = history.filter((h) => h.promo === 0 || h.promo === 1);
  let promo = null;
  if (known.length) {
    const promoDays = new Map(); // день → был ли промокод хоть в одной проверке
    for (const h of known) {
      const z = zoned(h.ts, tz);
      promoDays.set(z.day, { weekday: z.weekday, found: promoDays.get(z.day)?.found || h.promo === 1 });
    }
    const byWd = Array.from({ length: 7 }, (_, wd) => [...promoDays.values()].filter((d) => d.weekday === wd));
    let weekdayTip = null;
    if (promoDays.size >= 14 && byWd.every((ds) => ds.length >= 2)) {
      const shares = byWd.map((ds, wd) => ({ wd, n: ds.length, found: ds.filter((d) => d.found).length, share: ds.filter((d) => d.found).length / ds.length }));
      const best = shares.reduce((a, b) => (b.share > a.share ? b : a));
      const worst = shares.reduce((a, b) => (b.share < a.share ? b : a));
      if (best.share > 0 && best.share - worst.share >= 0.25) weekdayTip = best;
    }
    const found = known.filter((h) => h.promo === 1);
    promo = { checks: known.length, found: found.length, last: found.at(-1)?.ts ?? null, weekdayTip };
  }

  return {
    count: pts.length,
    days: days.length,
    first: pts[0],
    current: cur,
    prev,
    change: prev ? cur.price - prev.price : null,
    min,
    max,
    isNewMin: prevMin !== null && cur.price < prevMin,
    isAtMin: cur.price <= min.price,
    avg7: avg(pts.filter((p) => p.ts > cur.ts - 7 * DAY).map((p) => p.price)),
    avg30: avg(pts.filter((p) => p.ts > cur.ts - 30 * DAY).map((p) => p.price)),
    stableDays: Math.floor((cur.ts - since) / DAY),
    weekdays,
    weekdayTip,
    hours: hours.length >= 2 ? hours.sort((a, b) => a.hour - b.hour) : null,
    series: days,
    promo,
    withPromoPrices: pts.some((p) => p.price !== p.base),
  };
}

const BARS = '▁▂▃▄▅▆▇█';
export function sparkline(values, width = 21) {
  const xs = values.slice(-width);
  if (xs.length < 2) return '';
  const lo = Math.min(...xs);
  const hi = Math.max(...xs);
  if (hi === lo) return BARS[3].repeat(xs.length);
  return xs.map((v) => BARS[Math.round(((v - lo) / (hi - lo)) * (BARS.length - 1))]).join('');
}

/** Текст «Динамика»: подробная сводка под графиком. promoName — «−5% (до 500 ₽)». */
export function historyText(a, { tz, title, promoName = '' }) {
  const d = (ts) => zoned(ts, tz).dm;
  const lines = [`📈 <b>${title}</b>`, ''];
  if (a.withPromoPrices) lines.push('Цены — к оплате: с промокодом, когда он был на странице.');
  lines.push(`Сейчас: <b>${formatRub(a.current.price)}</b> (${d(a.current.ts)} ${zoned(a.current.ts, tz).hm})`);
  lines.push(`Минимум: ${formatRub(a.min.price)} (${d(a.min.ts)}) · максимум: ${formatRub(a.max.price)} (${d(a.max.ts)})`);
  if (a.days > 1) {
    lines.push(`Средняя за 7 дней: ${formatRub(Math.round(a.avg7))}${a.days > 7 ? ` · за 30 дней: ${formatRub(Math.round(a.avg30))}` : ''}`);
    if (a.stableDays >= 1) lines.push(`Цена не менялась ${a.stableDays} дн.`);
  }
  lines.push(`Наблюдений: ${a.count} за ${a.days} дн. (с ${d(a.first.ts)})`);

  if (a.weekdayTip?.flat) {
    lines.push('', '📅 От дня недели цена не зависит.');
  } else if (a.weekdayTip) {
    const { best, worst, spread } = a.weekdayTip;
    lines.push('', `📅 По дням недели (средняя): ${a.weekdays.map((w) => `${WEEKDAY_SHORT[w.wd]} ${formatRub(Math.round(w.avg))}`).join(' · ')}`);
    lines.push(`💡 Дешевле всего обычно ${WEEKDAY_ACC[best.wd]}, дороже — ${WEEKDAY_ACC[worst.wd]} (разница ${ruNumber(spread, 1, { trim: true })}%).`);
  } else {
    lines.push('', `📅 Какой день недели выгоднее, станет видно после 2 недель наблюдений (сейчас ${a.days} дн.).`);
  }
  if (a.promo) {
    const { checks, found, last, weekdayTip } = a.promo;
    lines.push('', `🎟 Промокод ${promoName} был на странице в ${found} из ${checks} проверок${last ? ` (последний раз ${d(last)})` : ''}.`.replace('  ', ' '));
    if (weekdayTip) lines.push(`💡 Чаще всего он бывает ${WEEKDAY_ACC[weekdayTip.wd]} (${weekdayTip.found} из ${weekdayTip.n}).`);
  }
  if (a.hours) {
    lines.push(`🕐 По времени: ${a.hours.map((h) => `${String(h.hour).padStart(2, '0')}:00 — ${formatRub(Math.round(h.avg))}`).join(' · ')}`);
  }
  return lines.join('\n');
}
