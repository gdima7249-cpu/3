import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateSync } from 'node:zlib';
import { zoned, shouldCheck, nextSlotText } from '../src/schedule.js';
import { analyze, sparkline, formatRub, formatPct, ruNumber, historyText } from '../src/stats.js';
import { renderChart, niceTicks } from '../src/chart.js';

const TZ = 'Europe/Moscow';
const msk = (iso) => Date.parse(iso + '+03:00');
const DAY = 86_400_000;

test('время по Москве', () => {
  const z = zoned(Date.parse('2026-10-26T21:30:00Z'), TZ); // 00:30 по Москве следующего дня
  assert.equal(z.day, '2026-10-27');
  assert.equal(z.hm, '00:30');
  assert.equal(z.weekday, 1); // вторник
});

test('расписание: сразу для нового товара, потом в плановое время, повтор после ошибки, жёсткий лимит', () => {
  const base = { tz: TZ, times: ['12:00'], maxPerDay: 2, retryAfterMin: 120 };
  const none = { attempts: 0, successes: 0, last_ts: null };
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T09:00'), today: none, everAttempted: false }), true);
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T11:59'), today: none, everAttempted: true }), false);
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T12:00'), today: none, everAttempted: true }), true);
  // Утром уже была удачная проверка — в 12:00 второй раз не открываем
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T12:00'), today: { attempts: 1, successes: 1, last_ts: msk('2026-10-26T09:00') }, everAttempted: true }), false);
  // Ошибка в 12:00 — повтор не раньше 14:00
  const failed = { attempts: 1, successes: 0, last_ts: msk('2026-10-26T12:00') };
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T13:59'), today: failed, everAttempted: true }), false);
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T14:00'), today: failed, everAttempted: true }), true);
  // Две неудачи — больше сегодня не пробуем
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T20:00'), today: { attempts: 2, successes: 0, last_ts: msk('2026-10-26T14:00') }, everAttempted: true }), false);
  // Даже новый товар не открывается сверх лимита
  assert.equal(shouldCheck({ ...base, now: msk('2026-10-26T20:00'), today: { attempts: 2, successes: 2, last_ts: 1 }, everAttempted: false }), false);
  assert.equal(nextSlotText(msk('2026-10-26T13:00'), TZ, ['12:00']), 'завтра в 12:00');
  assert.equal(nextSlotText(msk('2026-10-26T13:00'), TZ, ['10:00', '22:00']), 'сегодня в 22:00');
  // Утром уже проверили вручную — слот 12:00 пропустится, следующая проверка завтра
  assert.equal(nextSlotText(msk('2026-10-26T09:00'), TZ, ['12:00'], { attempts: 1, successes: 1 }, 2), 'завтра в 12:00');
  assert.equal(nextSlotText(msk('2026-10-26T09:00'), TZ, ['12:00', '22:00'], { attempts: 1, successes: 1 }, 2), 'сегодня в 22:00');
  assert.equal(nextSlotText(msk('2026-10-26T09:00'), TZ, ['12:00', '22:00'], { attempts: 2, successes: 1 }, 2), 'завтра в 12:00');
});

test('динамика: минимум, новый минимум, день недели', () => {
  // 3 недели, по вторникам дешевле
  const start = msk('2026-10-05T12:00'); // понедельник
  const history = Array.from({ length: 21 }, (_, i) => ({ ts: start + i * DAY, price: i % 7 === 1 ? 1000 : 1100 }));
  history.push({ ts: start + 21 * DAY + 1000, price: 990 });
  const a = analyze(history, { tz: TZ });
  assert.equal(a.min.price, 990);
  assert.equal(a.isNewMin, true);
  assert.equal(a.days, 22);
  assert.equal(a.weekdayTip.best.wd, 1);
  assert.match(historyText(a, { tz: TZ, title: 'Карта' }), /Дешевле всего обычно во вторник/);

  const short = analyze(history.slice(0, 5), { tz: TZ });
  assert.equal(short.weekdayTip, null);
  assert.match(historyText(short, { tz: TZ, title: 'Карта' }), /после 2 недель/);
  assert.equal(analyze([], { tz: TZ }), null);
});

test('форматирование и спарклайн', () => {
  assert.equal(formatRub(1087), '1 087 ₽');
  assert.equal(formatRub(-23, { sign: true }), '−23 ₽');
  assert.equal(formatRub(1087.5), '1 087,50 ₽');
  // Без toLocaleString: на сервере без языковых данных Node.js было бы «1,087»
  assert.equal(ruNumber(1234567.891, 2), '1\u00a0234\u00a0567,89');
  assert.equal(ruNumber(999), '999');
  assert.equal(formatPct(-2.14), '−2,1%');
  assert.equal(formatPct(5), '+5%');
  assert.equal(sparkline([1, 2, 3]), '▁▅█');
  assert.equal(sparkline([5, 5]), '▄▄');
  assert.equal(sparkline([5]), '');
});

test('график — корректный PNG', () => {
  const pts = [1120, 1110, 1095, 1130, 1087].map((price, i) => ({ ts: msk('2026-10-01T12:00') + i * DAY, price }));
  const png = renderChart(pts, { dateLabel: (ts) => zoned(ts, TZ).dm, target: 1100 });
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.equal(png.readUInt32BE(16), 1000);
  assert.equal(png.readUInt32BE(20), 500);
  const idatLen = png.readUInt32BE(33);
  assert.equal(png.subarray(37, 41).toString(), 'IDAT');
  assert.equal(inflateSync(png.subarray(41, 41 + idatLen)).length, (1000 * 3 + 1) * 500);
  assert.deepEqual(niceTicks(1087, 1087), [1000, 1050, 1100, 1150]);
  assert.deepEqual(niceTicks(1000, 1200), [950, 1000, 1050, 1100, 1150, 1200, 1250]);
});
