// Время по часовому поясу пользователя и решение «пора ли проверять товар».

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
export const WEEKDAY_SHORT = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];
export const WEEKDAY_ACC = ['в понедельник', 'во вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье'];

const formatters = new Map();
function formatter(tz) {
  if (!formatters.has(tz)) {
    formatters.set(
      tz,
      new Intl.DateTimeFormat('en-GB', {
        timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23',
      }),
    );
  }
  return formatters.get(tz);
}

/** Дата и время момента ts в поясе tz. weekday: 0 — понедельник … 6 — воскресенье. */
export function zoned(ts, tz) {
  const p = Object.fromEntries(formatter(tz).formatToParts(new Date(ts)).map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  const minute = Number(p.minute);
  return {
    day: `${p.year}-${p.month}-${p.day}`,
    hour,
    minute,
    minutes: hour * 60 + minute,
    weekday: WEEKDAYS.indexOf(p.weekday),
    dm: `${p.day}.${p.month}`,
    hm: `${String(hour).padStart(2, '0')}:${p.minute}`,
  };
}

export const toMinutes = (hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

/** Сколько плановых проверок уже должно было пройти сегодня к этому моменту. */
export const slotsPassed = (times, minutes) => times.filter((t) => toMinutes(t) <= minutes).length;

/**
 * Пора ли открыть страницу товара.
 * today — { attempts, successes, last_ts } за сегодняшний день; everAttempted — были ли попытки вообще.
 * Новый товар проверяется сразу. Дальше — в плановое время; после неудачи — повтор через retryAfterMin.
 * Больше maxChecksPerDay попыток в сутки не бывает никогда.
 */
export function shouldCheck({ now, tz, times, maxPerDay, retryAfterMin, today, everAttempted }) {
  if (today.attempts >= maxPerDay) return false;
  if (!everAttempted) return true;
  if (today.successes >= slotsPassed(times, zoned(now, tz).minutes)) return false;
  if (today.last_ts && now - today.last_ts < retryAfterMin * 60_000) return false;
  return true;
}

/**
 * «сегодня в 22:00» / «завтра в 12:00» — когда следующая плановая проверка.
 * С today учитывается, что слот пропускается, если сегодня уже хватает удачных проверок или исчерпан лимит.
 */
export function nextSlotText(now, tz, times, today = null, maxPerDay = Infinity) {
  const { minutes } = zoned(now, tz);
  const later = times.findIndex((t, i) => toMinutes(t) > minutes && (!today || (today.successes < i + 1 && today.attempts < maxPerDay)));
  return later >= 0 ? `сегодня в ${times[later]}` : `завтра в ${times[0]}`;
}
