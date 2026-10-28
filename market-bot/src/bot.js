import { writeFileSync, readFileSync, existsSync, mkdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { esc } from './telegram.js';
import { zoned, shouldCheck, nextSlotText } from './schedule.js';
import { analyze, formatRub, formatPct, sparkline, historyText } from './stats.js';
import { renderChart } from './chart.js';
import { summarizePage } from './parse.js';
import { errorText } from './market.js';
import { pickPromo, promoPrice, promoLabel } from './promo.js';

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

export function isMarketUrl(s) {
  try {
    const host = new URL(s).hostname.toLowerCase();
    return /(^|\.)market\.yandex\.[a-z]+$/.test(host) || host === 'ya.cc';
  } catch {
    return false;
  }
}

export const extractLinks = (text) =>
  [...String(text || '').matchAll(URL_RE)].map((m) => m[0].replace(/[).,!?»]+$/, '')).filter(isMarketUrl);

export function createBot({ tg, store, market, config, now = () => Date.now(), pause = (ms) => new Promise((r) => setTimeout(r, ms)), log = console }) {
  const tz = config.timezone;
  const tzName = tz === 'Europe/Moscow' ? 'по Москве' : `(${tz})`;
  const debugDir = join(config.dataDir, 'debug');
  const pending = new Map(); // chatId → { kind: 'target', itemId } | { kind: 'promo' } — ждём ответ

  // Страница Маркета открывается строго по одной: ручные и плановые проверки не накладываются.
  let chain = Promise.resolve();
  const exclusive = (fn) => {
    const p = chain.then(fn);
    chain = p.catch(() => {});
    return p;
  };

  const owners = () => [...new Set([...config.allowedChatIds, ...JSON.parse(store.getSetting('owners', '[]'))])];
  const notifyMode = () => store.getSetting('notify_mode', config.notifyMode);
  /** Какой промокод ищем: { watch, percent (0 — любой), maxDiscount }. Задаётся в .env или командой /promo. */
  const promoSettings = () => {
    const saved = JSON.parse(store.getSetting('promo', 'null'));
    return saved || { watch: config.promoWatch, percent: config.promoPercent || 0, maxDiscount: config.promoMaxDiscount || null };
  };
  const wantedPromo = () => {
    const ps = promoSettings();
    return ps.percent ? promoLabel({ percent: ps.percent }, ps.maxDiscount) : '';
  };
  const pay = (row) => row?.promo_price ?? row?.price ?? null;
  const when = (ts) => `${zoned(ts, tz).dm} ${zoned(ts, tz).hm}`;
  const title = (item) => esc(item.title || item.url.replace(/^https?:\/\//, ''));
  const link = (item) => `<a href="${esc(item.resolved_url || item.url)}">Открыть на Маркете</a>`;

  function itemKeyboard(item) {
    return {
      inline_keyboard: [
        [{ text: '🔄 Проверить', callback_data: `chk:${item.id}` }, { text: '📈 Динамика', callback_data: `hist:${item.id}` }],
        [{ text: item.target_price ? `🎯 Цель: ${formatRub(item.target_price)}` : '🎯 Цель', callback_data: `tgt:${item.id}` }, { text: '🗑 Удалить', callback_data: `del:${item.id}` }],
      ],
    };
  }

  function saveDebug(itemId, r) {
    try {
      mkdirSync(debugDir, { recursive: true });
      const base = join(debugDir, `item-${itemId}`);
      const meta = { at: new Date(now()).toISOString(), via: r.via, status: r.status ?? null, finalUrl: r.finalUrl ?? null, error: r.error, errorText: r.errorText };
      if (r.html) writeFileSync(`${base}.html`, r.html);
      if (r.screenshot) writeFileSync(`${base}.jpg`, r.screenshot);
      writeFileSync(`${base}.json`, JSON.stringify({ ...meta, ...(r.html ? summarizePage(r.html, r.finalUrl) : {}) }, null, 2));
    } catch (e) {
      log.warn?.('[debug] не удалось сохранить страницу:', e.message);
    }
  }

  /** Открыть страницу товара (с учётом лимита в сутки) и записать результат. */
  async function performCheck(item, { manual = false } = {}) {
    const ts = now();
    const day = zoned(ts, tz).day;
    const today = store.dayStats(item.id, day);
    if (today.attempts >= config.maxChecksPerDay) return { limited: true, item };
    const prevOk = store.lastOk(item.id) || null;
    let r = await market.check(item.url);
    // Короткая ссылка могла перестать работать — тогда идём по адресу, куда она вела раньше.
    if (r.error === 'not_found' && item.resolved_url && item.resolved_url !== item.url) {
      const second = await market.check(item.resolved_url);
      if (second.ok) r = second;
    }
    saveDebug(item.id, r);
    const p = r.page || {};
    const promo = checkPromo(r);
    store.addCheck({
      itemId: item.id, ts, day, ok: r.ok, price: p.price, oldPrice: p.oldPrice, inStock: p.inStock, seller: p.seller, via: r.via, error: r.error, manual,
      promo: promo?.found, promoPrice: promo?.price, promoInfo: promo?.info,
    });
    if (r.ok) store.updateMeta(item.id, { resolvedUrl: r.finalUrl, title: p.title, seller: p.seller });
    log.log?.(`[check] #${item.id} ${r.ok ? (p.price !== null ? `${p.price} ₽ (${p.matchedBy})` : 'нет в наличии') : r.error} via ${r.via}${manual ? ' (вручную)' : ''}`);
    return { r, prevOk, ts, manual, promo, item: store.item(item.id), attemptsLeft: config.maxChecksPerDay - today.attempts - 1 };
  }

  /** Есть ли на странице нужный промокод и сколько с ним платить. null — не следим или цены нет. */
  function checkPromo(r) {
    const ps = promoSettings();
    const price = r.page?.price ?? null;
    if (!r.ok || !ps.watch || price === null) return null;
    const { promo, others } = pickPromo(r.page.promos || [], { percent: ps.percent, price });
    const calc = promo ? promoPrice(price, promo, ps) : null;
    const brief = (c) => ({ percent: c.percent, maxDiscount: c.maxDiscount, code: c.code, until: c.until, source: c.source, snippet: c.snippet });
    return {
      found: Boolean(promo),
      price: calc?.value ?? null,
      exact: calc?.exact ?? false,
      promo,
      others,
      info: promo ? { ...brief(promo), exact: calc?.exact ?? false } : others.length ? { others: others.slice(0, 3).map(brief) } : null,
    };
  }

  function events(res) {
    const { r, prevOk, item } = res;
    const p = r.page;
    const a = analyze(store.history(item.id), { tz });
    const target = item.target_price;
    const nowPay = res.promo?.price ?? p.price;
    const reached = target && nowPay !== null && nowPay <= target;
    const promoNow = res.promo ? res.promo.found : null;
    return {
      a,
      first: !prevOk,
      priceChanged: prevOk && prevOk.price !== p.price,
      newMin: a?.isNewMin,
      reached,
      targetCrossed: reached && !(pay(prevOk) !== null && pay(prevOk) <= target),
      promoAppeared: promoNow === true && prevOk?.promo === 0,
      promoGone: promoNow === false && prevOk?.promo === 1,
      backInStock: prevOk && prevOk.in_stock === 0 && p.inStock === true,
      sellerChanged: Boolean(prevOk?.seller && p.seller && prevOk.seller !== p.seller),
    };
  }

  function successText(res) {
    const { r, prevOk, item } = res;
    const p = r.page;
    const ev = events(res);
    const lines = [`🏷 <b>${title(item)}</b>`];
    if (p.price === null) {
      lines.push('❌ <b>Нет в наличии</b>');
    } else {
      let s = `💰 <b>${formatRub(p.price)}</b>`;
      if (prevOk?.price != null && prevOk.price !== p.price) {
        const d = p.price - prevOk.price;
        s += `  ${d < 0 ? '📉' : '📈'} ${formatRub(d, { sign: true })} (${formatPct((d / prevOk.price) * 100)})`;
      } else if (prevOk?.price != null) s += ' · без изменений';
      lines.push(s);
      if (p.oldPrice) lines.push(`Зачёркнутая цена: ${formatRub(p.oldPrice)} (скидка ${Math.round((1 - p.price / p.oldPrice) * 100)}%)`);
      lines.push(...promoLines(res));
    }
    if (ev.first) lines.push('🆕 Первая проверка — с этого момента собираю историю цены.');
    if (ev.newMin) lines.push('🔥 <b>Самая низкая цена за всё время наблюдений!</b>');
    if (ev.promoAppeared) lines.push('🎉 <b>Появился промокод!</b>');
    if (ev.promoGone) lines.push('Промокод пропал со страницы.');
    if (ev.reached) lines.push(`🎯 <b>${res.promo?.price ? 'С промокодом цена' : 'Цена'} не выше вашей цели ${formatRub(item.target_price)}!</b>`);
    if (ev.backInStock) lines.push('✅ Снова в наличии');
    if (ev.sellerChanged) lines.push(`⚠️ Продавец сменился: ${esc(prevOk.seller)} → ${esc(p.seller)}`);
    if (p.seller) lines.push(`Продавец: ${esc(p.seller)}`);
    if (p.matchedBy === 'first') lines.push('⚠️ На странице несколько предложений, и бот не уверен, что это цена нужного продавца. Сверьте с сайтом; подробности — /debug.');
    if (ev.a && ev.a.count > 1) {
      lines.push('', `📊 Мин ${formatRub(ev.a.min.price)} (${zoned(ev.a.min.ts, tz).dm}) · макс ${formatRub(ev.a.max.price)} (${zoned(ev.a.max.ts, tz).dm}) · ${ev.a.days} дн.`);
      const spark = sparkline(ev.a.series.map((d) => d.price));
      if (spark) lines.push(spark);
    }
    const today = store.dayStats(item.id, zoned(now(), tz).day);
    lines.push('', `${link(item)} · следующая проверка ${nextSlotText(now(), tz, config.checkTimes, today, config.maxChecksPerDay)}`);
    return lines.join('\n');
  }

  function promoLines({ promo }) {
    if (!promo) return [];
    if (!promo.found) {
      const others = promo.others.filter((c) => c.percent).map((c) => promoLabel(c)).slice(0, 3);
      return [`🎟 Промокода ${wantedPromo()} на странице нет${others.length ? ` (есть другие: ${others.join(', ')})` : ''}.`.replace('  ', ' ')];
    }
    const c = promo.promo;
    const parts = [`🎟 Есть промокод ${promoLabel(c, promoSettings().maxDiscount)}`];
    if (c.code) parts.push(`код <code>${esc(c.code)}</code>`);
    if (c.until) parts.push(`до ${esc(c.until)}`);
    const lines = [parts.join(', ')];
    if (promo.price !== null) lines.push(`💳 С промокодом: <b>${promo.exact ? '' : '≈\u00a0'}${formatRub(promo.price)}</b>`);
    return lines;
  }

  function failureText({ r, item, attemptsLeft, manual, ts }) {
    const lines = [`🏷 <b>${title(item)}</b>`, `⚠️ Не удалось узнать цену: ${esc(r.errorText)}.`];
    if (r.error === 'captcha' && !market.browserAvailable) {
      lines.push('Помочь может браузер для бота: он нажимает «Я не робот» сам. Как поставить — README, раздел «Если Маркет показывает капчу».');
    }
    if (r.error === 'no_price') lines.push('Что пришло со страницы — /debug.');
    if (attemptsLeft <= 0) lines.push(`Попыток на сегодня больше нет (лимит ${config.maxChecksPerDay} в сутки). Следующая проверка — завтра в ${config.checkTimes[0]}.`);
    else if (manual) lines.push(`Сегодня можно попробовать ещё ${attemptsLeft} раз(а).`);
    else lines.push(`Попробую ещё раз около ${zoned(ts + config.retryAfterMin * 60_000, tz).hm}.`);
    lines.push(link(item));
    return lines.join('\n');
  }

  function limitText(item) {
    const last = store.lastOk(item.id);
    return [
      `🏷 <b>${title(item)}</b>`,
      `Сегодня страница уже открывалась ${config.maxChecksPerDay} раз(а) — это лимит в сутки (MAX_CHECKS_PER_DAY).`,
      last ? `Последняя цена: <b>${formatRub(last.price)}</b> (${when(last.ts)}).` : '',
      `Следующая проверка — завтра в ${config.checkTimes[0]}.`,
    ].filter(Boolean).join('\n');
  }

  async function sendResult(chatId, res, editId = null) {
    if (res.limited) return tg.send(chatId, limitText(res.item), { reply_markup: itemKeyboard(res.item) });
    if (res.r.ok) {
      const text = successText(res);
      if (editId) return tg.edit(chatId, editId, text, { reply_markup: itemKeyboard(res.item) });
      return tg.send(chatId, text, { reply_markup: itemKeyboard(res.item) });
    }
    const text = failureText(res);
    if (res.r.screenshot && text.length <= 1024) return tg.sendFile(chatId, 'photo', res.r.screenshot, 'page.jpg', { caption: text, mime: 'image/jpeg' });
    return tg.send(chatId, text);
  }

  async function manualCheck(chatId, itemId, editId = null) {
    const item = store.item(itemId);
    if (!item) return tg.send(chatId, 'Такого товара уже нет.');
    const res = await exclusive(() => performCheck(store.item(itemId), { manual: true }));
    return sendResult(chatId, res, editId);
  }

  /** Плановые проверки. Вызывается раз в минуту. */
  async function tick() {
    let ran = 0;
    for (const { id } of store.items()) {
      const due = () => {
        const item = store.item(id);
        if (!item) return null;
        const ts = now();
        const today = store.dayStats(id, zoned(ts, tz).day);
        const ok = shouldCheck({ now: ts, tz, times: config.checkTimes, maxPerDay: config.maxChecksPerDay, retryAfterMin: config.retryAfterMin, today, everAttempted: Boolean(store.lastAttempt(id)) });
        return ok ? item : null;
      };
      if (!due()) continue;
      if (ran) await pause(20_000 + Math.random() * 40_000); // между товарами — пауза, а не очередь запросов подряд
      const res = await exclusive(async () => {
        const item = due(); // за время паузы могла пройти ручная проверка
        return item ? performCheck(item) : null;
      });
      if (!res) continue;
      ran++;
      if (res.r.ok) {
        const ev = events(res);
        const interesting = ev.first || ev.priceChanged || ev.newMin || ev.targetCrossed || ev.backInStock || ev.sellerChanged || ev.promoAppeared || ev.promoGone;
        if (notifyMode() === 'always' || interesting) for (const chatId of owners()) await sendResult(chatId, res);
      } else if (res.attemptsLeft <= 0) {
        // О неудаче сообщаем, когда попыток на сегодня не осталось: удачный повтор сам пришлёт цену.
        for (const chatId of owners()) await sendResult(chatId, res);
      }
    }
    return ran;
  }

  function cardText(item) {
    const last = store.lastOk(item.id);
    const attempt = store.lastAttempt(item.id);
    const a = analyze(store.history(item.id), { tz });
    const lines = [`🏷 <b>${title(item)}</b>`];
    if (last) {
      lines.push(last.price !== null ? `💰 <b>${formatRub(last.price)}</b> (${when(last.ts)})` : `❌ Нет в наличии (${when(last.ts)})`);
      if (last.promo === 1) lines.push(`🎟 Был промокод${last.promo_price ? ` → ${formatRub(last.promo_price)}` : ''}`);
      else if (last.promo === 0) lines.push('🎟 Промокода не было');
      if (a && a.count > 1) lines.push(`Мин ${formatRub(a.min.price)} · макс ${formatRub(a.max.price)} · ${a.days} дн.`);
      if (last.seller) lines.push(`Продавец: ${esc(last.seller)}`);
    } else if (!attempt) lines.push('Ещё не проверялась.');
    if (attempt && !attempt.ok) lines.push(`⚠️ Последняя попытка (${when(attempt.ts)}): ${esc(errorText(attempt.error))}`);
    if (item.target_price) lines.push(`🎯 Цель: ${formatRub(item.target_price)}`);
    lines.push(link(item));
    return lines.join('\n');
  }

  async function sendList(chatId) {
    const items = store.items();
    if (!items.length) return tg.send(chatId, 'Список пуст. Пришлите ссылку на товар с Яндекс Маркета.');
    for (const item of items) await tg.send(chatId, cardText(item), { reply_markup: itemKeyboard(item) });
  }

  async function sendHistory(chatId, item) {
    const hist = store.history(item.id);
    const a = analyze(hist, { tz });
    if (!a) return tg.send(chatId, `🏷 <b>${title(item)}</b>\nПока нет ни одной удачной проверки — истории ещё нет.`);
    const caption = historyText(a, { tz, title: title(item), promoName: wantedPromo() });
    const keyboard = { inline_keyboard: [[{ text: '📄 Скачать таблицу (CSV)', callback_data: `csv:${item.id}` }]] };
    if (a.count < 2) return tg.send(chatId, `${caption}\n\nГрафик появится после второй проверки.`);
    const points = hist.filter((h) => h.price !== null).map((h) => ({ ts: h.ts, price: h.price, promoPrice: h.promo_price }));
    const png = renderChart(points, { dateLabel: (ts) => zoned(ts, tz).dm, target: item.target_price || null });
    if (caption.length <= 1024) return tg.sendFile(chatId, 'photo', png, 'chart.png', { caption, mime: 'image/png', reply_markup: keyboard });
    await tg.sendFile(chatId, 'photo', png, 'chart.png', { mime: 'image/png' });
    return tg.send(chatId, caption, { reply_markup: keyboard });
  }

  async function sendCsv(chatId, item) {
    const rows = store.history(item.id).map((h) => {
      const z = zoned(h.ts, tz);
      const yesNo = (v) => (v === null || v === undefined ? '' : v ? 'да' : 'нет');
      return [z.day, z.hm, h.price ?? '', h.old_price ?? '', yesNo(h.in_stock), yesNo(h.promo), h.promo_price ?? '', (h.seller || '').replace(/[;\n]/g, ' ')].join(';');
    });
    const csv = '\ufeff' + ['дата;время;цена;зачёркнутая цена;в наличии;промокод;цена с промокодом;продавец', ...rows].join('\r\n');
    return tg.sendFile(chatId, 'document', Buffer.from(csv), `prices-${item.id}.csv`, { mime: 'text/csv' });
  }

  async function sendDebug(chatId, item) {
    const base = join(debugDir, `item-${item.id}`);
    if (!existsSync(`${base}.json`)) return tg.send(chatId, 'Проверок ещё не было — показать нечего.');
    const d = JSON.parse(readFileSync(`${base}.json`, 'utf8'));
    const res = d.result || {};
    const text = [
      `🔧 <b>${title(item)}</b> — последняя загрузка ${esc(d.at)}`,
      `Способ: ${esc(d.via)} · HTTP ${esc(d.status)}${d.error ? ` · ошибка: ${esc(d.errorText)}` : ''}`,
      `Адрес: ${esc(d.finalUrl || '—')}`,
      d.result
        ? `Цена: ${res.price ?? '—'} · зачёркнутая: ${res.oldPrice ?? '—'} · источник: ${esc(res.matchedBy || '—')} · в наличии: ${res.inStock ?? '—'}`
        : 'Страница не получена.',
      d.result ? `Найдено: JSON-LD товаров ${res.counts?.ldProducts ?? 0}, patch-блоков ${res.counts?.patchBlocks ?? 0}, предложений ${res.counts?.offers ?? 0}` : '',
      d.priceTexts?.length ? `Цены в тексте страницы: ${esc(d.priceTexts.slice(0, 8).join(', '))}` : '',
      d.result ? `Промокоды на странице: ${res.promos?.length ? esc(res.promos.slice(0, 3).map((c) => `${promoLabel(c)} [${c.source}${c.related ? ', это предложение' : ''}] «${c.snippet.slice(0, 70)}»`).join('; ')) : 'не найдены'}` : '',
      '',
      'Файлы ниже: сводка (.json) и сама страница (.html). Если цена неверная — перешлите их тому, кто настраивает бота.',
    ].filter((s) => s !== '').join('\n');
    await tg.send(chatId, text);
    await tg.sendFile(chatId, 'document', readFileSync(`${base}.json`), `debug-${item.id}.json`, { mime: 'application/json' });
    if (existsSync(`${base}.html`) && statSync(`${base}.html`).size < 45e6) await tg.sendFile(chatId, 'document', readFileSync(`${base}.html`), `page-${item.id}.html`, { mime: 'text/html' });
    if (existsSync(`${base}.jpg`)) await tg.sendFile(chatId, 'photo', readFileSync(`${base}.jpg`), 'page.jpg', { mime: 'image/jpeg', caption: 'Так страница выглядела в браузере бота' });
  }

  /** Если товаров несколько — спросить, какой; если один — сразу действие. */
  async function forItem(chatId, prefix, verb, fn) {
    const items = store.items();
    if (!items.length) return tg.send(chatId, 'Список пуст. Пришлите ссылку на товар с Яндекс Маркета.');
    if (items.length === 1) return fn(items[0]);
    return tg.send(chatId, `${verb}:`, { reply_markup: { inline_keyboard: items.map((i) => [{ text: (i.title || i.url).slice(0, 60), callback_data: `${prefix}:${i.id}` }]) } });
  }

  function helpText() {
    const times = config.checkTimes.join(' и ');
    return [
      '👋 Я слежу за ценами на Яндекс Маркете и присылаю их сюда.',
      '',
      `🕐 Проверяю каждый день в ${times} ${tzName}. Больше ${config.maxChecksPerDay} раз в сутки страницу не открываю — вместе с повторами после ошибок и ручными проверками.`,
      `🔔 Уведомления: ${notifyMode() === 'always' ? 'после каждой проверки' : 'только когда что-то изменилось'} (/mode).`,
      `🎟 Промокод: ${promoStatusText()} (/promo).`,
      '',
      'Пришлите ссылку на товар (можно короткую «Поделиться») — добавлю его.',
      '',
      '/list — товары и последние цены',
      '/check — проверить сейчас',
      '/history — динамика цены и в какой день дешевле',
      '/mode — когда присылать уведомления',
      '/promo — какой промокод искать',
      '/debug — что бот увидел на странице',
    ].join('\n');
  }

  function promoStatusText() {
    const ps = promoSettings();
    if (!ps.watch) return 'не слежу';
    return ps.percent ? `слежу за промокодом ${wantedPromo()}` : 'слежу за любым промокодом';
  }

  /** «5% до 500 ₽» → { percent: 5, maxDiscount: 500 }; «любой»; «нет» — не следить. */
  function parsePromoSetting(text) {
    if (/^(нет|выкл\w*|off|не\s+следить)$/i.test(text)) return { watch: false, percent: 0, maxDiscount: null };
    if (/^(любой|any)$/i.test(text)) return { watch: true, percent: 0, maxDiscount: null };
    const nums = [...text.replace(/(\d)[\s\u00a0](?=\d{3}\b)/g, '$1').matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => Number(m[0].replace(',', '.')));
    if (!nums.length || !(nums[0] > 0 && nums[0] < 100)) return null;
    return { watch: true, percent: nums[0], maxDiscount: nums[1] > 0 ? nums[1] : null };
  }

  async function handleMessage(msg) {
    const chatId = msg.chat.id;
    const text = (msg.text || '').trim();
    if (msg.chat.type !== 'private') return;
    if (/^\/id\b/.test(text)) return tg.send(chatId, `Ваш chat id: <code>${chatId}</code>`);

    let list = owners();
    if (!list.includes(chatId)) {
      if (!list.length && /^\/start\b/.test(text)) {
        store.setSetting('owners', JSON.stringify([chatId]));
        log.log?.(`[bot] владелец: ${chatId} (@${msg.from?.username || '—'})`);
        list = [chatId];
      } else {
        return tg.send(chatId, `Это личный бот. Ваш chat id: <code>${chatId}</code> — если это вы, впишите его в ALLOWED_CHAT_IDS в .env.`);
      }
    }

    const links = extractLinks(text);
    if (links.length) {
      pending.delete(chatId);
      for (const url of links) {
        const { item, created } = store.addItem(url, now());
        if (!created) {
          await tg.send(chatId, `Эта ссылка уже отслеживается.\n\n${cardText(item)}`, { reply_markup: itemKeyboard(item) });
          continue;
        }
        const msgSent = await tg.send(chatId, '✅ Добавил. Открываю страницу товара…');
        await manualCheck(chatId, item.id, msgSent?.message_id);
      }
      return;
    }

    if (pending.get(chatId)?.kind === 'promo' && !text.startsWith('/')) {
      pending.delete(chatId);
      const ps = parsePromoSetting(text);
      if (!ps) return tg.send(chatId, 'Не понял. Пришлите, например, «5% до 500 ₽», «любой» или «нет» — команда /promo.');
      store.setSetting('promo', JSON.stringify(ps));
      return tg.send(chatId, `🎟 Готово: ${promoStatusText()}. Учту со следующей проверки.`);
    }
    if (pending.get(chatId)?.kind === 'target' && !text.startsWith('/')) {
      const { itemId } = pending.get(chatId);
      pending.delete(chatId);
      const item = store.item(itemId);
      if (!item) return tg.send(chatId, 'Такого товара уже нет.');
      if (/^(0|нет|убрать|-)$/i.test(text)) {
        store.setTarget(itemId, null);
        return tg.send(chatId, 'Цель убрана.', { reply_markup: itemKeyboard(store.item(itemId)) });
      }
      const value = parseFloat(text.replace(/руб\.?|р\.|₽|[\s ]/gi, '').replace(',', '.'));
      if (!(value > 0)) return tg.send(chatId, 'Не понял число. Нажмите «🎯 Цель» ещё раз и пришлите, например, 1100.');
      store.setTarget(itemId, value);
      return tg.send(chatId, `🎯 Сообщу, когда цена будет не выше ${formatRub(value)}.`, { reply_markup: itemKeyboard(store.item(itemId)) });
    }
    pending.delete(chatId);

    const cmd = text.split(/\s+/)[0].replace(/@\w+$/, '').toLowerCase();
    switch (cmd) {
      case '/start':
      case '/help':
        await tg.send(chatId, helpText());
        if (store.items().length) await sendList(chatId);
        return;
      case '/list':
        return sendList(chatId);
      case '/check':
        if (!store.items().length) return tg.send(chatId, 'Список пуст. Пришлите ссылку на товар с Яндекс Маркета.');
        for (const item of store.items()) await manualCheck(chatId, item.id);
        return;
      case '/history':
        return forItem(chatId, 'hist', 'Динамика какого товара', (item) => sendHistory(chatId, item));
      case '/debug':
        return forItem(chatId, 'dbg', 'Какой товар показать', (item) => sendDebug(chatId, item));
      case '/mode':
        return tg.send(chatId, 'Когда присылать цену после плановой проверки?', { reply_markup: modeKeyboard() });
      case '/promo':
        pending.set(chatId, { kind: 'promo' });
        return tg.send(
          chatId,
          [
            `🎟 Сейчас: ${promoStatusText()}.`,
            '',
            'Бот ищет промокод на странице товара. Если он есть — показывает цену с ним, а минимум, цель и «в какой день дешевле» считает по цене к оплате.',
            '',
            'Пришлите, какой промокод нужен:',
            '• <code>5% до 500 ₽</code> — скидка 5%, но не больше 500 ₽ (если потолок написан на странице, бот возьмёт его оттуда)',
            '• <code>5</code> — скидка 5% без потолка',
            '• <code>любой</code> — любой промокод',
            '• <code>нет</code> — не следить',
          ].join('\n'),
        );
      default:
        return tg.send(chatId, 'Пришлите ссылку на товар с Яндекс Маркета или выберите команду: /list, /check, /history, /promo, /mode.');
    }
  }

  function modeKeyboard() {
    const mode = notifyMode();
    return {
      inline_keyboard: [
        [{ text: `${mode === 'always' ? '✅ ' : ''}Каждый раз`, callback_data: 'mode:always' }],
        [{ text: `${mode === 'change' ? '✅ ' : ''}Только при изменениях`, callback_data: 'mode:change' }],
      ],
    };
  }

  async function handleCallback(cq) {
    const chatId = cq.message?.chat.id;
    await tg.call('answerCallbackQuery', { callback_query_id: cq.id }).catch(() => {});
    if (!chatId || !owners().includes(chatId)) return;
    const [action, arg] = String(cq.data || '').split(':');
    const item = arg && /^\d+$/.test(arg) ? store.item(Number(arg)) : null;
    if (['chk', 'hist', 'tgt', 'del', 'delok', 'csv', 'dbg'].includes(action) && !item) return tg.send(chatId, 'Такого товара уже нет.');
    switch (action) {
      case 'chk':
        return manualCheck(chatId, item.id);
      case 'hist':
        return sendHistory(chatId, item);
      case 'csv':
        return sendCsv(chatId, item);
      case 'dbg':
        return sendDebug(chatId, item);
      case 'tgt':
        pending.set(chatId, { kind: 'target', itemId: item.id });
        return tg.send(chatId, `🎯 Пришлите цену в рублях: сообщу, когда товар будет стоить столько или дешевле.${item.target_price ? `\nСейчас цель: ${formatRub(item.target_price)}. Чтобы убрать — пришлите 0.` : ''}`);
      case 'del':
        return tg.send(chatId, `Удалить «${title(item)}» и всю историю его цен?`, {
          reply_markup: { inline_keyboard: [[{ text: '🗑 Да, удалить', callback_data: `delok:${item.id}` }, { text: 'Отмена', callback_data: 'cancel' }]] },
        });
      case 'delok':
        store.deleteItem(item.id);
        return tg.edit(chatId, cq.message.message_id, `Удалено: ${title(item)}`);
      case 'cancel':
        return tg.edit(chatId, cq.message.message_id, 'Отменено.');
      case 'mode':
        if (arg === 'always' || arg === 'change') store.setSetting('notify_mode', arg);
        return tg.edit(chatId, cq.message.message_id, arg === 'change' ? '🔔 Буду писать, только когда цена, наличие, продавец или промокод изменились, цена стала минимальной или дошла до цели.' : '🔔 Буду присылать цену после каждой проверки.', { reply_markup: modeKeyboard() });
    }
  }

  async function handle(update) {
    if (update.message) return handleMessage(update.message);
    if (update.callback_query) return handleCallback(update.callback_query);
  }

  return { handle, tick, performCheck, owners, promoStatusText };
}
