// Приём оплаты на кошелёк ЮMoney без сервера и вебхуков:
//  1. бот даёт ссылку на форму оплаты (Quickpay) с уникальной меткой label;
//  2. бот сам проверяет историю операций кошелька (API operation-history) и находит платёж по метке.
// Нужны: номер кошелька и OAuth-токен с правом operation-history (получить: npm run yoomoney).

export class YooMoney {
  constructor({ wallet, token, fetchImpl = fetch }) {
    this.wallet = wallet;
    this.token = token;
    this.fetch = fetchImpl;
  }

  get enabled() {
    return Boolean(this.wallet && this.token);
  }

  /**
   * Ссылка на оплату. paymentType: AC — банковская карта, PC — кошелёк ЮMoney.
   * Комиссию платёжной системы (~3% за карту) платит получатель.
   */
  payUrl({ amount, label, comment, paymentType = 'AC' }) {
    const p = new URLSearchParams({
      receiver: this.wallet,
      'quickpay-form': 'button',
      targets: comment,
      paymentType,
      sum: String(amount),
      label,
      successURL: 'https://t.me/',
    });
    return `https://yoomoney.ru/quickpay/confirm.xml?${p}`;
  }

  async api(method, params) {
    const res = await this.fetch(`https://yoomoney.ru/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${this.token}`, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 401) throw new Error('ЮMoney: токен недействителен — получите новый (npm run yoomoney)');
    if (!res.ok) throw new Error(`ЮMoney HTTP ${res.status}`);
    const data = await res.json();
    if (data.error) throw new Error(`ЮMoney: ${data.error}`);
    return data;
  }

  /** Успешное входящее зачисление с меткой label или null. */
  async findPayment(label) {
    const data = await this.api('operation-history', { type: 'deposition', label, records: '10' });
    return (data.operations || []).find((o) => o.label === label && o.status === 'success' && o.direction !== 'out') || null;
  }

  accountInfo() {
    return this.api('account-info', {});
  }
}
