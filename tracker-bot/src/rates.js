// Курсы валют ЦБ РФ (через зеркало cbr-xml-daily.ru) для пересчёта цен в рубли.
// Если курсы не загрузились — используются примерные запасные значения.

const FALLBACK = { RUB: 1, USD: 82, EUR: 95, KZT: 0.16, UAH: 2, BYN: 25, TRY: 2.1, PLN: 22, CNY: 11.3, GBP: 110, BRL: 15, INR: 0.95, ARS: 0.08 };

export class Rates {
  constructor({ fetchImpl = fetch, url = 'https://www.cbr-xml-daily.ru/daily_json.js' } = {}) {
    this.fetch = fetchImpl;
    this.url = url;
    this.map = { ...FALLBACK };
    this.loadedAt = 0;
    this.live = false;
  }

  async refresh() {
    if (this.live && Date.now() - this.loadedAt < 6 * 3600_000) return;
    try {
      const res = await this.fetch(this.url, { signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      for (const [code, v] of Object.entries(data.Valute || {})) {
        if (v.Value && v.Nominal) this.map[code] = v.Value / v.Nominal;
      }
      this.map.RUB = 1;
      this.loadedAt = Date.now();
      this.live = true;
    } catch (e) {
      console.warn('[курсы] не загрузились, использую примерные:', e.message);
    }
  }

  /** Сумма в валюте → рубли (null, если курс неизвестен). */
  toRub(amount, currency) {
    if (amount == null) return null;
    const r = this.map[String(currency || 'RUB').toUpperCase()];
    return r ? amount * r : null;
  }
}
