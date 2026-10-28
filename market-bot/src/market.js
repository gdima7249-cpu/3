// Загрузка страницы товара: обычный HTTP-запрос, а если Маркет показал капчу — настоящий браузер (Playwright, если установлен).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { createRequire } from 'node:module';
import { parseMarketPage, looksLikeCaptcha, clientRedirect } from './parse.js';

let playwright;
/** Playwright — необязательная зависимость: `npm i playwright && npx playwright install --with-deps chromium`. */
export function loadPlaywright() {
  if (playwright === undefined) {
    try {
      playwright = createRequire(import.meta.url)('playwright');
    } catch {
      playwright = null;
    }
  }
  return playwright;
}

/** Простое хранилище cookie для обычных запросов: Маркет охотнее отдаёт страницу «вернувшемуся» посетителю. */
export class CookieJar {
  constructor(file) {
    this.file = file;
    this.cookies = [];
    try {
      if (file && existsSync(file)) this.cookies = JSON.parse(readFileSync(file, 'utf8'));
    } catch {}
  }

  header(url, now = Date.now()) {
    const host = new URL(url).hostname;
    return this.cookies
      .filter((c) => (!c.expires || c.expires > now) && (host === c.domain || (!c.hostOnly && host.endsWith('.' + c.domain))))
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  store(url, setCookies, now = Date.now()) {
    const host = new URL(url).hostname;
    for (const line of setCookies) {
      const [pair, ...attrs] = line.split(';');
      const eq = pair.indexOf('=');
      if (eq < 1) continue;
      const c = { name: pair.slice(0, eq).trim(), value: pair.slice(eq + 1).trim(), domain: host, hostOnly: true, expires: null };
      for (const a of attrs) {
        const [k, ...rest] = a.split('=');
        const key = k.trim().toLowerCase();
        const val = rest.join('=').trim();
        if (key === 'domain' && val) {
          const d = val.replace(/^\./, '').toLowerCase();
          if (host === d || host.endsWith('.' + d)) Object.assign(c, { domain: d, hostOnly: false });
        } else if (key === 'max-age') c.expires = now + Number(val) * 1000;
        else if (key === 'expires' && c.expires === null) c.expires = Date.parse(val) || null;
      }
      this.cookies = this.cookies.filter((x) => !(x.name === c.name && x.domain === c.domain));
      if (!c.expires || c.expires > now) this.cookies.push(c);
    }
  }

  save() {
    if (!this.file) return;
    mkdirSync(dirname(this.file), { recursive: true });
    writeFileSync(this.file, JSON.stringify(this.cookies));
  }
}

function chromeHints(ua) {
  const major = ua.match(/Chrome\/(\d+)/)?.[1];
  if (!major) return {};
  const platform = /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : 'Linux';
  return {
    'sec-ch-ua': `"Chromium";v="${major}", "Google Chrome";v="${major}", "Not.A/Brand";v="99"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': `"${platform}"`,
  };
}

const ERROR_TEXT = {
  captcha: 'Маркет показал капчу («Я не робот») вместо страницы',
  no_price: 'страница открылась, но цену на ней найти не удалось',
  not_found: 'товар не найден (страница не похожа на карточку товара)',
  network: 'не удалось подключиться к Маркету',
  browser: 'не удалось запустить браузер',
};
export const errorText = (code, detail) => (ERROR_TEXT[code] || (code?.startsWith('http_') ? `Маркет ответил ошибкой ${code.slice(5)}` : code || 'ошибка')) + (detail ? ` (${detail})` : '');

export class MarketClient {
  constructor({ userAgent, browserMode = 'auto', proxyUrl = '', timezone = 'Europe/Moscow', cookieFile, browserStateFile, fetchImpl = fetch, log = console } = {}) {
    Object.assign(this, { userAgent, browserMode, proxyUrl, timezone, browserStateFile, fetchImpl, log });
    this.jar = new CookieJar(cookieFile);
  }

  get browserAvailable() {
    return this.browserMode !== 'off' && Boolean(loadPlaywright());
  }

  /**
   * Открыть ссылку и достать цену. Возвращает
   * { ok, error, errorText, via, status, finalUrl, html, screenshot, page }, где page — результат parseMarketPage.
   */
  async check(url) {
    const browserFirst = this.browserMode === 'always' || Boolean(this.proxyUrl);
    let httpRes = null;
    if (!browserFirst || !this.browserAvailable) {
      httpRes = await this.viaHttp(url);
      // Браузер помогает от капчи, блокировки (403/429) и переходов скриптом. Если страница товара
      // пришла, но без цены, или сервер недоступен, второй загрузкой ничего не исправить.
      const hopeless = ['no_price', 'network'].includes(httpRes.error) || httpRes.status === 404;
      if (httpRes.ok || !this.browserAvailable || hopeless) return httpRes;
      this.log.warn?.(`[market] обычный запрос: ${httpRes.errorText}. Пробую браузером…`);
    }
    const b = await this.viaBrowser(url);
    // Браузер не запустился — честнее показать, что ответил обычный запрос.
    if (b.error === 'browser' && httpRes) return { ...httpRes, errorText: `${httpRes.errorText}; ${b.errorText}` };
    return b;
  }

  headers(url, referer) {
    const cookie = this.jar.header(url);
    return {
      'user-agent': this.userAgent,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'accept-language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'upgrade-insecure-requests': '1',
      'sec-fetch-dest': 'document',
      'sec-fetch-mode': 'navigate',
      'sec-fetch-site': referer ? 'same-origin' : 'none',
      'sec-fetch-user': '?1',
      ...chromeHints(this.userAgent),
      ...(referer ? { referer } : {}),
      ...(cookie ? { cookie } : {}),
    };
  }

  async fetchFollow(url) {
    let current = url;
    let referer = null;
    let res;
    for (let hop = 0; hop < 10; hop++) {
      res = await this.fetchImpl(current, { redirect: 'manual', headers: this.headers(current, referer), signal: AbortSignal.timeout(30_000) });
      this.jar.store(current, res.headers.getSetCookie?.() || []);
      const loc = res.headers.get('location');
      if (res.status >= 300 && res.status < 400 && loc) {
        await res.body?.cancel().catch(() => {});
        referer = current;
        current = new URL(loc, current).href;
        continue;
      }
      break;
    }
    const html = await res.text();
    this.jar.save();
    return { status: res.status, finalUrl: current, html };
  }

  async viaHttp(url) {
    try {
      let r = await this.fetchFollow(url);
      let page = parseMarketPage(r.html, r.finalUrl);
      // Короткая ссылка может переадресовывать скриптом, а не заголовком Location.
      const next = !page.hasProduct && !page.captcha && clientRedirect(r.html, r.finalUrl);
      if (next) {
        r = await this.fetchFollow(next);
        page = parseMarketPage(r.html, r.finalUrl);
      }
      return this.result('http', r, page);
    } catch (e) {
      return { ok: false, via: 'http', error: 'network', errorText: errorText('network', e.cause?.code || e.message), page: null };
    }
  }

  result(via, { status, finalUrl, html, screenshot = null }, page) {
    let error = null;
    if (!page.ok) {
      if (page.captcha || (!page.hasProduct && looksLikeCaptcha(html, finalUrl))) error = 'captcha';
      else if (page.hasProduct) error = 'no_price';
      else if (status === 404) error = 'not_found';
      else if (status >= 400) error = `http_${status}`;
      else error = 'not_found';
    }
    return { ok: page.ok, via, status, finalUrl, html, screenshot, page, error, errorText: error ? errorText(error) : null };
  }

  proxy() {
    if (!this.proxyUrl) return undefined;
    const u = new URL(this.proxyUrl);
    return { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username) || undefined, password: decodeURIComponent(u.password) || undefined };
  }

  async viaBrowser(url) {
    const pw = loadPlaywright();
    if (!pw) return { ok: false, via: 'browser', error: 'browser', errorText: errorText('browser', 'Playwright не установлен'), page: null };
    let browser;
    try {
      browser = await pw.chromium.launch({ headless: true, proxy: this.proxy(), args: ['--disable-blink-features=AutomationControlled'] });
    } catch (e) {
      return { ok: false, via: 'browser', error: 'browser', errorText: errorText('browser', e.message.split('\n')[0]), page: null };
    }
    try {
      // Без «HeadlessChrome» в User-Agent: с ним капчу показывают чаще.
      const major = browser.version().split('.')[0];
      const context = await browser.newContext({
        userAgent: `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`,
        locale: 'ru-RU',
        timezoneId: this.timezone,
        viewport: { width: 1366, height: 768 },
        storageState: this.browserStateFile && existsSync(this.browserStateFile) ? this.browserStateFile : undefined,
      });
      await context.addInitScript(() => Object.defineProperty(Navigator.prototype, 'webdriver', { get: () => undefined }));
      const page = await context.newPage();
      let resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
      await page.waitForTimeout(2500 + Math.random() * 1500);
      if (looksLikeCaptcha(await page.content(), page.url()) && (await this.pressNotRobot(page))) {
        await page.waitForURL((u) => !/captcha/i.test(u.href), { timeout: 20_000 }).catch(() => {});
        await page.waitForLoadState('domcontentloaded').catch(() => {});
        await page.waitForTimeout(2500);
        resp = null;
      }
      const finalUrl = page.url();
      const raw = resp ? await resp.text().catch(() => '') : '';
      const dom = await page.content();
      const screenshot = await page.screenshot({ type: 'jpeg', quality: 70 }).catch(() => null);
      if (this.browserStateFile) {
        mkdirSync(dirname(this.browserStateFile), { recursive: true });
        await context.storageState({ path: this.browserStateFile }).catch(() => {});
      }
      // Исходный HTML надёжнее: после загрузки скрипты страницы могут убрать служебные блоки из DOM.
      const fromRaw = raw ? parseMarketPage(raw, finalUrl) : null;
      const useRaw = fromRaw && (fromRaw.ok || !parseMarketPage(dom, finalUrl).ok);
      const html = useRaw ? raw : dom;
      return this.result('browser', { status: resp?.status() ?? 200, finalUrl, html, screenshot }, useRaw ? fromRaw : parseMarketPage(dom, finalUrl));
    } catch (e) {
      return { ok: false, via: 'browser', error: 'network', errorText: errorText('network', e.message.split('\n')[0]), page: null };
    } finally {
      await browser.close().catch(() => {});
    }
  }

  /** Пробует нажать галочку «Я не робот». Сложное задание (картинки) бот не решает. */
  async pressNotRobot(page) {
    const candidates = [
      page.locator('#js-button'),
      page.locator('.CheckboxCaptcha-Button'),
      page.getByRole('checkbox', { name: /робот/i }),
      page.getByRole('button', { name: /не робот/i }),
      page.getByText(/я не робот/i),
    ];
    for (const loc of candidates) {
      const el = loc.first();
      if (!(await el.isVisible().catch(() => false))) continue;
      const box = await el.boundingBox().catch(() => null);
      if (!box) {
        await el.click().catch(() => {});
        return true;
      }
      const x = box.x + box.width * (0.3 + Math.random() * 0.4);
      const y = box.y + box.height * (0.3 + Math.random() * 0.4);
      await page.mouse.move(x - 120 - Math.random() * 80, y + 60 + Math.random() * 40);
      await page.mouse.move(x, y, { steps: 18 });
      await page.waitForTimeout(250 + Math.random() * 400);
      await page.mouse.click(x, y);
      this.log.log?.('[market] нажал «Я не робот»');
      return true;
    }
    return false;
  }
}
